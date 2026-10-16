import { useState, useEffect, useCallback, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import { translateDynamic, translateSetting, useI18n, type MessageKey } from '../i18n'
import { Card, ComboSelect, IconAction, Row, type ComboOption } from './settings/parts'
import MemorySettings from './MemorySettings'
import { RemoteTargetsCard, normalizeTargets, type RemoteTarget } from './settings/RemoteTargets'

interface Props {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  subscribe: (method: string, fn: (p: Record<string, unknown>) => void) => () => void
}

const DELEGATION_MODEL_KEY = 'delegation_model'
const TRANSLATION_MODEL_KEY = 'translation_model'
// 子代理相关的字段在界面上归到模型配置页，按此顺序展示。
const SUBAGENT_KEYS = [DELEGATION_MODEL_KEY, 'report_proactive', 'skills_mode', 'mcp_mode']
const CAPABILITY_MODE_KEYS = ['skills_mode', 'mcp_mode']

const SECTIONS = ['general', 'models', 'voice', 'memory'] as const
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
  const [emoteBusy, setEmoteBusy] = useState(false)
  const [emoteNote, setEmoteNote] = useState<UiMessage | null>(null)
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

  const saveTargets = useCallback(async (targets: RemoteTarget[]): Promise<RemoteTarget[]> => {
    setSaving('remote_targets')
    setError(null)
    try {
      const response = await send('system.set_config', { values: { remote_targets: targets } })
      if (!response.ok) throw new Error(String(response.error || t('settings.update_error', undefined, { key: 'remote_targets' })))
      const values = (response.values as Record<string, unknown>) ?? response
      setConfig(values)
      return normalizeTargets(values.remote_targets)
    } catch (reason) {
      setError({ key: 'settings.update_error', fallback: reason instanceof Error ? reason.message : String(reason), values: { key: 'remote_targets' } })
      throw reason
    } finally {
      setSaving(null)
    }
  }, [send, t])

  // 解压、校验与烘焙都在主进程做，这里只管按钮状态与结果提示。
  const installEmote = useCallback(async () => {
    setEmoteBusy(true)
    setEmoteNote(null)
    try {
      const result = await send('emote.install', {})
      if (result.cancelled) return
      if (!result.ok) throw new Error(String(result.error || ''))
      setEmoteNote({ key: 'settings.character.installed' })
    } catch (reason) {
      setEmoteNote({ key: 'settings.character.failed', values: { error: reason instanceof Error ? reason.message : String(reason) } })
    } finally {
      setEmoteBusy(false)
    }
  }, [send])

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
  const remoteTargets = useMemo(() => normalizeTargets(config.remote_targets), [config.remote_targets])

  const voiceConfiguration = asConfigurationGroups(config.voice_configuration)
  const generalConfiguration = asConfigurationGroups(config.general_configuration)
  const memoryGroups = generalConfiguration.filter(group => group.id === 'memory')
  // 委托模型和翻译模型的候选就是对话用的那份模型列表；主进程只知道当前值，所以下拉在这里补全。
  const modelOptions = (current: string): ComboOption[] => {
    const options: ComboOption[] = [{ value: '', label: t('settings.delegation_model.same') }, ...piModels]
    // 已保存的模型不在列表里（凭据被移除、列表还没回来）时保留它，否则下拉框会悄悄显示成"与对话模型相同"。
    if (current && !piModels.some(option => (typeof option === 'string' ? option : option.value) === current)) options.push({ value: current, label: current })
    return options
  }
  // 主进程把子代理设置放在通用分组里下发；界面上归到模型配置页的子代理卡片。
  const generalFields = generalConfiguration.flatMap(group => group.fields)
  const subagentFields = SUBAGENT_KEYS.flatMap(key => {
    const field = generalFields.find(item => item.key === key)
    if (!field) return []
    if (key === DELEGATION_MODEL_KEY) return [{ ...field, type: 'select' as const, options: modelOptions(String(field.value ?? '')) }]
    // 主进程只下发取值；选项文案按界面语言在这里补。
    if (CAPABILITY_MODE_KEYS.includes(key)) return [{ ...field, options: (['isolated', 'shared'] as const).map(value => ({ value, label: t(`settings.capability_mode.${value}`) })) }]
    return [field]
  })
  // 翻译模型和对话模型是一类选择，归到模型配置页。
  const translationField = generalFields.find(field => field.key === TRANSLATION_MODEL_KEY)
  const generalGroups = generalConfiguration
    .filter(group => group.id !== 'memory')
    .map(group => ({ ...group, fields: group.fields.filter(field => !SUBAGENT_KEYS.includes(field.key) && field.key !== TRANSLATION_MODEL_KEY) }))
  const asrGroups = voiceConfiguration.filter(group => group.id === 'asr_local')
  const outputGroups = voiceConfiguration.filter(group => group.id === 'speech_synthesis')
  const needsSetup: Record<SectionId, boolean> = {
    general: generalGroups.some(group => !groupOk(group)),
    models: false,
    voice: [...asrGroups, ...outputGroups].some(group => !groupOk(group)),
    // Jev 缺省时记忆判定静默跳过，属于可选增强，不在标签上提示需要设置。
    memory: false,
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
          <RemoteTargetsCard targets={remoteTargets} onSave={saveTargets} send={send} reloading={reloading} />
          <Card title={t('settings.character.title')}>
            <button type="button" className="crt-button" data-variant="primary" disabled={emoteBusy} onClick={() => void installEmote()}>
              {emoteBusy ? t('settings.character.installing') : t('settings.character.choose')}
            </button>
            {emoteNote ? <p className="settings-card-note" role="status">{t(emoteNote.key, emoteNote.fallback, emoteNote.values)}</p> : null}
          </Card>
          </>
        ))}

        {section('models', (
          <>
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
          {translationField ? (
            <Card title={t('settings.translation.title')}>
              <StartupFieldRow field={{ ...translationField, type: 'select', options: modelOptions(String(translationField.value ?? '')) }} desktop={desktop} onSave={handleStartupSave} />
            </Card>
          ) : null}
          {subagentFields.length ? (
            <Card title={t('settings.subagent.title')}>
              {subagentFields.map(field => <StartupFieldRow key={field.key} field={field} desktop={desktop} onSave={handleStartupSave} />)}
            </Card>
          ) : null}
          </>
        ))}

        {section('voice', (
          <>
          <div className="settings-subsection" data-subsection="asr">
            <h3 className="settings-subheading">{t('settings.section.asr')}</h3>
            <GroupCards groups={asrGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
          </div>
          <div className="settings-subsection" data-subsection="tts">
            <h3 className="settings-subheading">{t('settings.section.tts')}</h3>
            <GroupCards groups={outputGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_active_connection')} />
          </div>
          </>
        ))}

        {section('memory', (
          <>
            <MemorySettings
              send={send}
              subscribe={subscribe}
              optional={memoryGroups.length ? (
                <details className="settings-advanced settings-card">
                  <summary>{t('memory.optional')}</summary>
                  <GroupCards groups={memoryGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                </details>
              ) : null}
            />
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
