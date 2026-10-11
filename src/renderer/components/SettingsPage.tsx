import { useState, useEffect, useCallback, type KeyboardEvent, type ReactNode } from 'react'
import { translateDynamic, translateSetting, useI18n, type MessageKey } from '../i18n'
import { Card, ComboSelect, IconAction, Row, type ComboOption } from './settings/parts'
import MemorySettings from './MemorySettings'

interface Props {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  subscribe: (method: string, fn: (p: Record<string, unknown>) => void) => () => void
}

// Which settings card holds each remote recognizer. They differ in protocol — the
// OpenAI-compatible slot posts multipart to /audio/transcriptions, while MiMo posts
// input_audio to /chat/completions — so one shared card cannot describe both.
const ASR_SETTINGS_GROUP: Record<string, string> = {
  openai_compatible: 'asr_remote',
  mimo: 'asr_mimo',
}

const WEB_SEARCH_GROUP_IDS = ['web_search']
const WEB_SEARCH_LABELS: Record<string, string> = { brave: 'Brave Search', tavily: 'Tavily' }

const DELEGATION_MODEL_KEY = 'delegation_model'

const SECTIONS = ['general', 'models', 'asr', 'tts', 'memory'] as const
type SectionId = typeof SECTIONS[number]
// 面板每次打开都会重新挂载；记住上次的标签，避免主人每次都被送回“通用”。
let lastSection: SectionId = 'general'

type StartupOption = string | { value: string; label: string }

interface StartupField {
  key: string
  label: string
  type: 'text' | 'url' | 'path' | 'number' | 'select' | 'boolean' | 'secret'
  description?: string
  value?: string | boolean | number
  configured?: boolean
  options?: StartupOption[]
  min?: number
  max?: number
  step?: number
  editable: boolean
}

interface ConfigurationGroup {
  id: string
  label: string
  description?: string
  active?: boolean
  configured?: boolean
  status?: string
  status_ok?: boolean
  status_detail?: string
  fields: StartupField[]
  advanced_fields?: StartupField[]
}

interface DesktopSettingsSnapshot {
  values: Record<string, string>
  sources: Record<string, 'environment' | 'user' | 'dotenv' | 'default'>
  locked: Record<string, boolean>
  secrets: Record<string, { configured: boolean; source: string; locked: boolean }>
  encryptionAvailable: boolean
}

type UiMessage = { key: MessageKey; fallback?: string; values?: Record<string, unknown> }
type SaveField = (field: StartupField, value: string | boolean | null, secret: boolean) => Promise<void>

function asConfigurationGroups(value: unknown): ConfigurationGroup[] {
  return Array.isArray(value) ? value as ConfigurationGroup[] : []
}

const groupOk = (group: ConfigurationGroup) => group.status_ok ?? Boolean(group.configured)

function StartupFieldRow({ field, desktop, onSave }: { field: StartupField; desktop: DesktopSettingsSnapshot | null; onSave: SaveField }) {
  const { locale, t } = useI18n()
  const source = field.key ? desktop?.sources?.[field.key] || 'default' : 'default'
  const storedValue = field.key && source === 'user' ? desktop?.values?.[field.key] : undefined
  const initial = storedValue !== undefined ? storedValue : field.value ?? ''
  const [draft, setDraft] = useState<string | boolean | number>(initial)
  const [busy, setBusy] = useState(false)
  const [secretDraft, setSecretDraft] = useState('')
  const locked = field.key ? Boolean(desktop?.locked?.[field.key]) : true
  const secretConfigured = field.type === 'secret'
    ? Boolean(desktop?.secrets?.[field.key]?.configured ?? field.configured)
    : false
  const label = translateSetting(locale, 'field', field.key, field.label)

  useEffect(() => {
    setDraft(storedValue !== undefined ? storedValue : field.value ?? '')
  }, [storedValue, field.value])

  const save = async (value: string | boolean | null, secret: boolean) => {
    setBusy(true)
    try {
      await onSave(field, value, secret)
      if (secret) setSecretDraft('')
    } catch {
      if (!secret) setDraft(initial)
    } finally {
      setBusy(false)
    }
  }

  let control: ReactNode
  if (!field.editable || !field.key) {
    control = <span className="settings-readonly">{String(field.value ?? '')}</span>
  } else if (field.type === 'secret') {
    control = (
      <div className="settings-secret">
        <input
          className="settings-input"
          type="password"
          aria-label={label}
          value={secretDraft}
          onChange={event => setSecretDraft(event.target.value)}
          disabled={locked || busy}
          placeholder={secretConfigured ? t('settings.placeholder.secret_replace') : t('settings.placeholder.secret_empty')}
          autoComplete="new-password"
          onKeyDown={event => { if (event.key === 'Enter' && secretDraft && !locked && !busy) void save(secretDraft, true) }}
        />
        {secretDraft ? <IconAction label={`${t('settings.action.save')} ${label}`} glyph="✓" busy={busy} disabled={locked || busy} onClick={() => void save(secretDraft, true)} /> : null}
        {secretConfigured ? <IconAction label={`${t('settings.action.clear')} ${label}`} glyph="×" danger disabled={locked || busy} onClick={() => void save(null, true)} /> : null}
      </div>
    )
  } else if (field.type === 'select' || field.type === 'boolean') {
    const options: ComboOption[] = field.type === 'boolean'
      ? [{ value: 'true', label: t('settings.action.on') }, { value: 'false', label: t('settings.action.off') }]
      : field.options || []
    control = (
      <ComboSelect
        label={label}
        value={String(draft)}
        options={options}
        disabled={locked || busy}
        onChange={raw => {
          const value = field.type === 'boolean' ? raw === 'true' : raw
          setDraft(value)
          if (String(value) !== String(initial)) void save(value, false)
        }}
      />
    )
  } else {
    control = (
      <input
        className="settings-input"
        type={field.type === 'url' ? 'url' : field.type === 'number' ? 'number' : 'text'}
        aria-label={label}
        min={field.min}
        max={field.max}
        step={field.step}
        value={String(draft)}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => { if (!locked && !busy && String(draft) !== String(initial)) void save(String(draft), false) }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
        disabled={locked || busy}
      />
    )
  }

  return (
    <Row label={<>{label}{busy && field.type !== 'secret' ? <span className="settings-field-busy">{t('settings.saving_label')}</span> : null}</>}>
      {control}
    </Row>
  )
}

function GroupStatus({ group }: { group: ConfigurationGroup }) {
  const { locale, t } = useI18n()
  const ok = groupOk(group)
  const text = group.status
    ? translateDynamic(locale, 'settings.status', group.status, group.status.replaceAll('_', ' ').replace(/^./, value => value.toUpperCase()))
    : ok ? t('settings.status.configured') : t('settings.status.needs_setup')
  // 正常状态只保留指示点，文字仅在需要处理时出现，避免每张卡片都堆满“已配置”。
  return (
    <span className="settings-status" data-ok={ok} title={text}>
      <span className="settings-status-dot" aria-hidden="true" />
      {ok ? <span className="sr-only">{text}</span> : text}
    </span>
  )
}

function GroupFields({ group, desktop, onSave }: { group: ConfigurationGroup; desktop: DesktopSettingsSnapshot | null; onSave: SaveField }) {
  const { t } = useI18n()
  return (
    <>
      {group.fields.map(field => <StartupFieldRow key={`${group.id}-${field.key || field.label}`} field={field} desktop={desktop} onSave={onSave} />)}
      {group.advanced_fields?.length ? (
        <details className="settings-advanced">
          <summary>{t('settings.advanced')}</summary>
          {group.advanced_fields.map(field => <StartupFieldRow key={`${group.id}-${field.key || field.label}`} field={field} desktop={desktop} onSave={onSave} />)}
        </details>
      ) : null}
    </>
  )
}

function GroupCard({ group, desktop, onSave }: { group: ConfigurationGroup; desktop: DesktopSettingsSnapshot | null; onSave: SaveField }) {
  const { locale, t } = useI18n()
  return (
    <Card title={translateSetting(locale, 'group', group.id, group.label)} status={<GroupStatus group={group} />}>
      {group.description ? <p className="settings-card-note">{translateSetting(locale, 'groupDescription', group.id, group.description)}</p> : null}
      {group.status_detail ? <p className="settings-card-note">{group.status_detail}</p> : null}
      {group.fields.length || group.advanced_fields?.length
        ? <GroupFields group={group} desktop={desktop} onSave={onSave} />
        : <p className="settings-card-note">{t('settings.note.no_user_settings')}</p>}
    </Card>
  )
}

function GroupCards({ groups, desktop, onSave, empty }: { groups: ConfigurationGroup[]; desktop: DesktopSettingsSnapshot | null; onSave: SaveField; empty: string }) {
  if (!groups.length) return <p className="settings-empty">{empty}</p>
  return <>{groups.map(group => <GroupCard key={group.id} group={group} desktop={desktop} onSave={onSave} />)}</>
}

export default function SettingsPage({ send, subscribe }: Props) {
  const { locale, setLocale, t } = useI18n()
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [desktop, setDesktop] = useState<DesktopSettingsSnapshot | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<UiMessage | null>(null)
  const [reloadStatus, setReloadStatus] = useState('ready')
  const [piModels, setPiModels] = useState<ComboOption[]>([])
  const [piModel, setPiModel] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState('off')
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([])
  const [activeSection, setActiveSection] = useState<SectionId>(lastSection)
  const reloading = reloadStatus === 'queued' || reloadStatus === 'applying'

  const refreshDesktop = useCallback(async () => {
    const snapshot = await window.amadeus?.getDesktopSettings()
    if (snapshot) setDesktop(snapshot as unknown as DesktopSettingsSnapshot)
  }, [])

  useEffect(() => {
    const unsubscribe = subscribe('system.config', payload => {
      setConfig((payload.values as Record<string, unknown>) ?? payload)
    })
    Promise.all([
      send('system.get_config', {}).then(response => setConfig((response.values as Record<string, unknown>) ?? response)),
      refreshDesktop(),
    ]).catch(reason => setError(reason instanceof Error ? { key: 'settings.loading_error', fallback: reason.message } : { key: 'settings.loading_error' }))
    return unsubscribe
  }, [subscribe, send, refreshDesktop])

  useEffect(() => {
    const apply = (payload: Record<string, unknown>) => {
      setReloadStatus(String(payload.status || 'ready'))
      if (payload.error) setError({ key: 'settings.reload_error', fallback: String(payload.error) })
    }
    const unsubscribe = subscribe('runtime.reload', apply)
    void send('runtime.status').then(apply).catch(reason => setError({ key: 'settings.reload_error', fallback: String(reason) }))
    return unsubscribe
  }, [send, subscribe])

  useEffect(() => {
    if (reloading) return
    // 设置页常驻挂载，模型也可能在输入框里被切换；每次变更后重新拉取，只采用最新一次请求的结果。
    let latest = 0
    const load = () => {
      const request = ++latest
      void send('pi.models').then(result => {
        if (request !== latest) return
        if (!result.ok) throw new Error(String(result.error))
        setPiModels(result.models as ComboOption[])
        setPiModel(String(result.current || ''))
        setThinkingLevel(String(result.thinkingLevel || 'off'))
        setThinkingLevels(result.thinkingLevels as string[])
      }).catch(reason => { if (request === latest) setError({ key: 'settings.loading_error', fallback: String(reason) }) })
    }
    load()
    const unsubscribe = subscribe('pi.model', load)
    return () => { latest = -1; unsubscribe() }
  }, [reloading, send, subscribe])

  const changeModel = async (model: string, thinkingLevel?: string) => {
    setSaving('pi_model')
    setError(null)
    try {
      const result = await send('pi.model.set', { model, thinkingLevel })
      if (!result.ok) throw new Error(String(result.error))
      setPiModel(String(result.current))
      setThinkingLevel(String(result.thinkingLevel))
      setThinkingLevels(result.thinkingLevels as string[])
    } catch (reason) { setError({ key: 'settings.update_error', fallback: String(reason) }) }
    finally { setSaving(null) }
  }

  const handleChange = useCallback(async (key: string, value: unknown) => {
    setSaving(key)
    setError(null)
    try {
      const response = await send('system.set_config', { values: { [key]: value } })
      if (!response.ok) throw new Error(String(response.error || t('settings.update_error', undefined, { key })))
      setConfig((response.values as Record<string, unknown>) ?? response)
      if (key === 'presentation_locale') setLocale(value)
    } catch (reason) {
      setError(reason instanceof Error ? { key: 'settings.update_error', fallback: reason.message, values: { key } } : { key: 'settings.update_error', values: { key } })
    } finally {
      setSaving(null)
    }
  }, [send, setLocale, t])

  const handleStartupSave = useCallback<SaveField>(async (field, value, secret) => {
    if (!window.amadeus || !field.key) return
    setSaving(field.key)
    setError(null)
    try {
      const result = await window.amadeus.updateDesktopSettings(
        secret ? { secrets: { [field.key]: value as string | null } } : { values: { [field.key]: value } },
      )
      if (!result.ok) throw new Error(result.error || t('settings.save_error', undefined, { key: field.key }))
      if (result.settings) setDesktop(result.settings as unknown as DesktopSettingsSnapshot)
      // The runtime applies and persists the change, then broadcasts system.config.
    } catch (reason) {
      setError(reason instanceof Error ? { key: 'settings.save_error', fallback: reason.message, values: { key: field.key } } : { key: 'settings.save_error', values: { key: field.key } })
      throw reason
    } finally {
      setSaving(null)
    }
  }, [t])

  const val = (key: string, fallback: string) => String(config[key] ?? fallback)

  const voiceConfiguration = asConfigurationGroups(config.voice_configuration)
  const generalConfiguration = asConfigurationGroups(config.general_configuration)
  const memoryGroups = generalConfiguration.filter(group => group.id === 'memory')
  // 主进程把网页搜索作为配置分组下发（id 为 web_search）；服务商名只是小写 id，这里换成可读的标签。
  const webSearchGroup = generalConfiguration.find(group => WEB_SEARCH_GROUP_IDS.includes(group.id))
  // 委托模型的候选就是对话用的那份模型列表；主进程只知道当前值，所以下拉在这里补全。
  const delegationOptions = (current: string): ComboOption[] => {
    const options: ComboOption[] = [{ value: '', label: t('settings.delegation_model.same') }, ...piModels]
    // 已保存的模型不在列表里（凭据被移除、列表还没回来）时保留它，否则下拉框会悄悄显示成"与对话模型相同"。
    if (current && !piModels.some(option => (typeof option === 'string' ? option : option.value) === current)) options.push({ value: current, label: current })
    return options
  }
  const generalGroups = generalConfiguration
    .filter(group => group.id !== 'memory' && !WEB_SEARCH_GROUP_IDS.includes(group.id))
    .map(group => ({
      ...group,
      fields: group.fields.map(field => field.key === DELEGATION_MODEL_KEY
        ? { ...field, type: 'select' as const, options: delegationOptions(String(field.value ?? '')) }
        : field),
    }))
  const webSearchLabel = (value: string) => value === '' ? t('settings.web_search.none') : WEB_SEARCH_LABELS[value] ?? value
  const webSearchView: ConfigurationGroup | undefined = webSearchGroup && {
    ...webSearchGroup,
    fields: webSearchGroup.fields.map(field => {
      if (!/provider$/i.test(field.key)) return field
      const current = String(field.value ?? '')
      const values = field.options?.length
        ? field.options.map(option => typeof option === 'string' ? option : option.value)
        : ['', ...Object.keys(WEB_SEARCH_LABELS)]
      // 已保存的服务商不在选项里时保留它，否则下拉框会悄悄显示成"未配置"。
      if (!values.includes('')) values.unshift('')
      if (current && !values.includes(current)) values.push(current)
      return { ...field, type: 'select', options: values.map(value => ({ value, label: webSearchLabel(value) })) }
    }),
  }

  const asrBackendId = val('asr_backend', 'qwen3_asr')
  const asrBackends = Array.isArray(config.asr_backends)
    ? config.asr_backends as Array<{ id: string; label: string; deployment?: string }>
    : []
  // Remote backends each own a card; anything else falls back on the registry's
  // own deployment field, so an unrecognised remote plugin still lands somewhere.
  // The embedded fallback covers the first render, before `asr_backends` arrives.
  const asrGroupId = ASR_SETTINGS_GROUP[asrBackendId]
    ?? (asrBackends.find(backend => backend.id === asrBackendId)?.deployment === 'remote'
      ? 'asr_remote'
      : 'asr_local')
  // Labels come from a dedicated prefix: the shared `settings.option.*` namespace
  // is also read by the TTS backend select, which reuses two of these ids.
  const asrBackendOptions: ComboOption[] = (asrBackends.length
    ? asrBackends.map(backend => backend.id)
    : ['qwen3_asr', 'sense_voice', 'openai_compatible', 'mimo']
  ).map(id => ({ value: id, label: translateDynamic(locale, 'settings.asrBackend', id, id) }))
  // Runs on this machine for every backend, the remote API included, so it never
  // follows the selected recognizer.
  const captureGroups = voiceConfiguration.filter(group => group.id === 'conversation_asr')
  const activeAsrGroups = voiceConfiguration.filter(group => group.id === asrGroupId)
  const wakeGroups = voiceConfiguration.filter(group => ['wake_asr', 'acoustic_pipeline'].includes(group.id))
  const activeOutputGroups = voiceConfiguration.filter(group => (
    group.id === 'speech_synthesis'
    || (['tts_embedded_v3', 'tts_remote', 'tts_mimo', 'voice_reference_profile'].includes(group.id) && group.active)
  ))
  const otherOutputGroups = voiceConfiguration.filter(group => (
    ['tts_embedded_v3', 'tts_remote', 'tts_mimo', 'voice_reference_profile'].includes(group.id)
    && !group.active
  ))
  const needsSetup: Record<SectionId, boolean> = {
    general: generalGroups.some(group => !groupOk(group)),
    models: false,
    asr: [...activeAsrGroups, ...captureGroups, ...wakeGroups].some(group => !groupOk(group)),
    tts: activeOutputGroups.some(group => !groupOk(group)),
    memory: memoryGroups.some(group => !groupOk(group)),
  }

  const select = (id: SectionId) => { lastSection = id; setActiveSection(id) }
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = SECTIONS[(SECTIONS.indexOf(activeSection) + step + SECTIONS.length) % SECTIONS.length]
    select(next)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus()
  }

  // 未激活的标签页用 hidden 保留在 DOM 中：草稿输入不丢失，切换也不触发重新拉取。
  const section = (id: SectionId, children: ReactNode) => (
    <section data-section={id} id={`settings-panel-${id}`} role="tabpanel" aria-labelledby={`settings-tab-${id}`} className="settings-section" hidden={activeSection !== id}>
      {children}
    </section>
  )

  return (
    <div className="settings-page-shell">
      <div className="settings-nav" role="tablist" aria-label={t('settings.title')}>
        {SECTIONS.map(id => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`settings-tab-${id}`}
            data-tab={id}
            aria-selected={activeSection === id}
            aria-controls={`settings-panel-${id}`}
            tabIndex={activeSection === id ? 0 : -1}
            className="settings-nav-item"
            onClick={() => select(id)}
            onKeyDown={onTabKey}
          >
            {t(`settings.section.${id}` as MessageKey)}
            {needsSetup[id] ? <span className="settings-nav-alert" title={t('settings.status.needs_setup')} /> : null}
          </button>
        ))}
      </div>

      <main className="settings-main settings-scroll-area">
        {section('general', (
          <>
          <Card>
            {/* The panel remounts whenever it is reopened, so `config` is empty until the fetch lands. The interface language the renderer is already using is the only true value available then; an English literal would misreport the active choice. */}
            <Row label={t('settings.label.interface_language')}>
              <ComboSelect label={t('settings.label.interface_language')} value={val('presentation_locale', locale)} onChange={value => void handleChange('presentation_locale', value)} options={[{ value: 'en-US', label: t('settings.option.english') }, { value: 'zh-CN', label: t('settings.option.chinese') }, { value: 'ja-JP', label: t('settings.option.japanese') }]} />
            </Row>
            {generalGroups.map(group => <GroupFields key={group.id} group={group} desktop={desktop} onSave={handleStartupSave} />)}
          </Card>
          {webSearchView ? (
            <Card title={t('settings.web_search.title')} status={<GroupStatus group={webSearchView} />}>
              <p className="settings-card-note">{t('settings.web_search.note')}</p>
              <GroupFields group={webSearchView} desktop={desktop} onSave={handleStartupSave} />
            </Card>
          ) : null}
          </>
        ))}

        {section('models', (
          <Card>
            <Row label={t('settings.label.current_model')}>
              {piModels.length
                ? <ComboSelect label={t('settings.label.current_model')} value={piModel} onChange={value => void changeModel(value)} options={piModels} disabled={Boolean(saving) || reloading} />
                : <span className="settings-readonly">{piModel || 'Pi'}</span>}
            </Row>
            {thinkingLevels.length > 1 ? (
              <Row label={t('settings.thinking_level')}>
                <ComboSelect label={t('settings.thinking_level')} value={thinkingLevel} onChange={value => void changeModel(piModel, value)} options={thinkingLevels} disabled={Boolean(saving) || reloading} />
              </Row>
            ) : null}
          </Card>
        ))}

        {section('asr', (
          <>
            {/* A one-entry backend list is not a choice; the active recognizer's card already names it. */}
            {asrBackendOptions.length > 1 ? (
              <Card>
                <Row label={t('settings.label.asr_mode')}>
                  <ComboSelect label={t('settings.label.asr_mode')} value={asrBackendId} onChange={value => void handleChange('asr_backend', value)} options={asrBackendOptions} />
                </Row>
              </Card>
            ) : null}
            <GroupCards groups={[...activeAsrGroups, ...captureGroups, ...wakeGroups]} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
          </>
        ))}

        {section('tts', (
          <>
            <GroupCards groups={activeOutputGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_active_connection')} />
            {otherOutputGroups.length ? (
              <details className="settings-advanced settings-card">
                <summary>{t('settings.other_voice_backends')}</summary>
                <GroupCards groups={otherOutputGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
              </details>
            ) : null}
          </>
        ))}

        {section('memory', (
          <>
            <MemorySettings send={send} subscribe={subscribe} />
            <GroupCards groups={memoryGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
          </>
        ))}

        {saving ? <div className="settings-feedback" data-tone="busy">{t('settings.saving', undefined, { key: saving })}</div> : null}
        {error ? <div className="settings-feedback" data-tone="error" role="alert">{error.fallback ?? t(error.key, undefined, error.values)}</div> : null}

        <footer className="settings-footer">
          <span className="settings-status-dot" data-ok={Boolean(desktop?.encryptionAvailable)} aria-hidden="true" />
          {desktop?.encryptionAvailable ? t('settings.security.available') : t('settings.security.unavailable')}
        </footer>
      </main>
    </div>
  )
}
