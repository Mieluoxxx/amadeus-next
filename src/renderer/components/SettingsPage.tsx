import { useState, useEffect, useCallback, type ReactNode } from 'react'
import FluentIcon, { type FluentIconName } from './FluentIcon'
import { translateDynamic, translateSetting, useI18n, type MessageKey } from '../i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asConfigurationGroups(value: unknown): ConfigurationGroup[] {
  return Array.isArray(value) ? value as ConfigurationGroup[] : []
}

function CardShell({ children, vertical = false }: { children: ReactNode; vertical?: boolean }) {
  return (
    <div
      className={cn(
        'setting-card flex rounded-2xl border border-black/[0.06] bg-white/75 backdrop-blur-xl transition-all duration-200 shadow-[0_2px_12px_rgba(0,0,0,0.03),inset_0_1px_1px_rgba(255,255,255,0.85)] hover:bg-white/85',
        vertical ? 'flex-col items-stretch p-4 gap-2' : 'items-center min-h-[58px] px-4 py-3'
      )}
    >
      {children}
    </div>
  )
}

type ComboOption = string | { value: string; label: string }

function ComboSelect({ value, onChange, options, disabled, fullWidth }: {
  value: string; onChange: (v: string) => void; options: ComboOption[]; disabled?: boolean; fullWidth?: boolean
}) {
  const { locale } = useI18n()
  return (
    <select
      value={value}
      onChange={event => onChange(event.target.value)}
      disabled={disabled}
      className={cn('text-xs font-semibold bg-white/80 border border-black/[0.08] rounded-xl px-3 py-1.5 text-[#1d1d1f] outline-none hover:border-black/[0.15] focus:ring-2 focus:ring-[#0071e3]/40 disabled:opacity-40 cursor-pointer', fullWidth ? 'w-full min-w-0' : 'shrink-0')}
      style={fullWidth ? { height: 34 } : { minWidth: 145, height: 34 }}
    >
      {options.map(option => {
        const optionValue = typeof option === 'string' ? option : option.value
        const label = typeof option === 'string' ? option : option.label
        return <option key={optionValue} value={optionValue}>{translateDynamic(locale, 'settings.option', optionValue, label)}</option>
      })}
    </select>
  )
}

function ComboCard({ icon, title, value, onChange, options, disabled }: {
  icon: FluentIconName; title: string; value: string
  onChange: (v: string) => void; options: ComboOption[]; disabled?: boolean
}) {
  return (
    <CardShell>
      <CardIcon name={icon} />
      <div className="flex-1 min-w-0 pr-4">
        <div className="text-[13px] font-semibold text-[#1d1d1f] leading-snug">{title}</div>
      </div>
      <ComboSelect value={value} onChange={onChange} options={options} disabled={disabled} />
    </CardShell>
  )
}

function ModelCard({ model, modelOptions, thinking, thinkingOptions, disabled, onModelChange, onThinkingChange }: {
  model: string; modelOptions: ComboOption[]
  thinking: string; thinkingOptions: string[]
  disabled?: boolean
  onModelChange: (v: string) => void; onThinkingChange: (v: string) => void
}) {
  const { t } = useI18n()
  const row = (title: string, control: ReactNode, divided = false) => (
    <div className={cn('flex flex-col gap-2', divided && 'border-t border-black/[0.06] pt-3')}>
      <div className="flex items-center">
        <CardIcon name="Robot" />
        <div className="min-w-0 text-[13px] font-semibold text-[#1d1d1f] leading-snug">{title}</div>
      </div>
      {control}
    </div>
  )
  return (
    <CardShell vertical>
      {row(t('settings.label.current_model'), modelOptions.length
        ? <ComboSelect fullWidth value={model} onChange={onModelChange} options={modelOptions} disabled={disabled} />
        : <span className="text-[12px] font-[550]" style={{ color: 'var(--text)' }}>{model || 'Pi'}</span>)}
      {thinkingOptions.length > 1 ? row(
        t('settings.thinking_level'),
        <ComboSelect fullWidth value={thinking} onChange={onThinkingChange} options={thinkingOptions} disabled={disabled} />,
        true,
      ) : null}
    </CardShell>
  )
}

function CardIcon({ name }: { name: FluentIconName }) {
  return (
    <>
      <div className="shrink-0 flex items-center justify-center w-6 h-6 rounded-lg bg-black/[0.04] text-[#86868b]">
        <FluentIcon name={name} size={15} />
      </div>
      <div style={{ width: 12, flexShrink: 0 }} />
    </>
  )
}

function StatusPill({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <Badge
      variant={ok ? 'success' : 'warning'}
      className="text-[10px] font-semibold px-2.5 py-0.5"
    >
      {children}
    </Badge>
  )
}

function InlineFieldAction({ label, glyph, busy = false, tone = 'normal', disabled, onClick }: {
  label: string
  glyph: string
  busy?: boolean
  tone?: 'normal' | 'danger'
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant={tone === 'danger' ? 'destructive' : 'ghost'}
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'w-6 h-6 rounded-md p-0',
        tone === 'danger' ? 'text-rose-600 hover:bg-rose-50' : 'text-[#86868b] hover:text-[#1d1d1f]'
      )}
    >
      {busy ? (
        <FluentIcon name="Sync" size={12} className="animate-spin" />
      ) : (
        <span aria-hidden="true" className={glyph === '×' ? 'text-base leading-none' : 'text-xs font-bold leading-none'}>
          {glyph}
        </span>
      )}
    </Button>
  )
}

function StartupFieldRow({ field, desktop, onSave }: {
  field: StartupField
  desktop: DesktopSettingsSnapshot | null
  onSave: (field: StartupField, value: string | boolean | null, secret: boolean) => Promise<void>
}) {
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

  return (
    <div className="settings-field-row flex items-start gap-5" style={{ padding: '10px 0', borderTop: '1px solid rgba(17,24,39,0.075)' }}>
      <div className="flex-1 min-w-0">
          <div className="text-[13px] font-[600]" style={{ color: 'var(--text)', lineHeight: '18px', letterSpacing: '-0.006em' }}>{translateSetting(locale, 'field', field.key, field.label)}</div>
        </div>
      <div className="settings-field-control flex items-center gap-1.5 shrink-0" style={{ width: 320, maxWidth: '43%' }}>
        {!field.editable || !field.key ? (
          <span className="text-[13px] truncate ml-auto" style={{ color: 'var(--text)' }}>{String(field.value ?? '')}</span>
        ) : field.type === 'secret' ? (
          <div className="relative min-w-0 flex-1">
            <Input
              type="password"
              value={secretDraft}
              onChange={event => setSecretDraft(event.target.value)}
              disabled={locked || busy}
              placeholder={secretConfigured ? t('settings.placeholder.secret_replace') : t('settings.placeholder.secret_empty')}
              autoComplete="new-password"
              onKeyDown={event => {
                if (event.key === 'Enter' && secretDraft && !locked && !busy) {
                  void save(secretDraft, true)
                }
              }}
              className={cn(
                'h-8',
                secretDraft && secretConfigured ? 'pr-16' : secretDraft || secretConfigured ? 'pr-12' : 'pr-3'
              )}
            />
            {(secretDraft || secretConfigured) ? (
              <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                {secretDraft ? (
                  <InlineFieldAction
                    label={`${t('settings.action.save')} ${translateSetting(locale, 'field', field.key, field.label)}`}
                    glyph="✓"
                    busy={busy}
                    disabled={locked || busy}
                    onClick={() => void save(secretDraft, true)}
                  />
                ) : null}
                {secretConfigured ? (
                  <InlineFieldAction
                    label={`${t('settings.action.clear')} ${translateSetting(locale, 'field', field.key, field.label)}`}
                    glyph="×"
                    tone="danger"
                    disabled={locked || busy}
                    onClick={() => void save(null, true)}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : field.type === 'select' ? (
          <select
            value={String(draft)}
            onChange={event => {
              const value = event.target.value
              setDraft(value)
              if (value !== String(initial)) void save(value, false)
            }}
            disabled={locked || busy}
            className="min-w-0 flex-1 h-8 text-xs font-semibold bg-white/80 border border-black/[0.08] rounded-xl px-2.5 outline-none focus:ring-2 focus:ring-[#0071e3]/40 disabled:opacity-50 cursor-pointer"
          >
            {(field.options || []).map(option => {
              const optionValue = typeof option === 'string' ? option : option.value
              const optionLabel = typeof option === 'string' ? option || 'default' : option.label
              return <option key={optionValue} value={optionValue}>{translateDynamic(locale, 'settings.option', optionValue, optionLabel)}</option>
            })}
          </select>
        ) : field.type === 'boolean' ? (
          <select
            value={String(draft)}
            onChange={event => {
              const value = event.target.value === 'true'
              setDraft(value)
              if (String(value) !== String(initial)) void save(value, false)
            }}
            disabled={locked || busy}
            className="min-w-0 flex-1 h-8 text-xs font-semibold bg-white/80 border border-black/[0.08] rounded-xl px-2.5 outline-none focus:ring-2 focus:ring-[#0071e3]/40 disabled:opacity-50 cursor-pointer"
          >
            <option value="true">{t('settings.action.on')}</option>
            <option value="false">{t('settings.action.off')}</option>
          </select>
        ) : (
          <Input
            type={field.type === 'url' ? 'url' : field.type === 'number' ? 'number' : 'text'}
            min={field.min}
            max={field.max}
            step={field.step}
            value={String(draft)}
            onChange={event => setDraft(event.target.value)}
            onBlur={() => {
              if (!locked && !busy && String(draft) !== String(initial)) void save(String(draft), false)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
            disabled={locked || busy}
            className="min-w-0 flex-1 h-8"
          />
        )}
        {busy && field.type !== 'secret' ? <span className="text-[10px] shrink-0" style={{ color: 'var(--muted)' }}>{t('settings.saving_label')}</span> : null}
      </div>
    </div>
  )
}

function ConfigurationCard({ group, desktop, onSave, defaultOpen }: {
  group: ConfigurationGroup
  desktop: DesktopSettingsSnapshot | null
  onSave: (field: StartupField, value: string | boolean | null, secret: boolean) => Promise<void>
  defaultOpen?: boolean
}) {
  const { locale, t } = useI18n()
  const statusOk = group.status_ok ?? Boolean(group.configured)
  const statusText = group.status
    ? translateDynamic(locale, 'settings.status', group.status, group.status.replaceAll('_', ' ').replace(/^./, value => value.toUpperCase()))
    : group.configured ? t('settings.status.configured') : t('settings.status.needs_setup')
  const groupLabel = translateSetting(locale, 'group', group.id, group.label)
  const [expanded, setExpanded] = useState(defaultOpen ?? Boolean(group.active || !statusOk))
  const header = (
    <div className="flex items-start gap-2.5 flex-1 min-w-0">
      <div className="flex items-center justify-center mt-0.5" style={{ width: 24, color: group.active ? 'var(--accent)' : 'var(--muted)' }}>
        <FluentIcon name="Robot" size={17} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <div className="text-[14px] font-[700]" style={{ color: 'var(--text)', lineHeight: '19px' }}>{groupLabel}</div>
          {group.active ? <span className="text-[9px] font-[700]" style={{ color: 'var(--accent)' }}>{t('settings.status.active', 'ACTIVE')}</span> : null}
        </div>
        {group.description ? <div className="text-[11px] mt-0.5" style={{ color: 'var(--muted)', lineHeight: '16px' }}>{translateSetting(locale, 'groupDescription', group.id, group.description)}</div> : null}
        {group.status_detail ? <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--faint)', lineHeight: '15px' }}>{group.status_detail}</div> : null}
      </div>
      <StatusPill ok={statusOk}>{statusText}</StatusPill>
    </div>
  )
  return (
    <CardShell vertical>
      {group.fields.length ? (
        <details className="settings-config-disclosure" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
          <summary className="settings-config-summary flex items-start gap-2 pb-1 cursor-pointer list-none">
            {header}
            <span className="settings-disclosure-chevron" aria-hidden="true">›</span>
          </summary>
          <div className="settings-config-body">
            {group.fields.map(field => <StartupFieldRow key={`${group.id}-${field.key || field.label}`} field={field} desktop={desktop} onSave={onSave} />)}
            {group.advanced_fields?.length ? (
              <details className="settings-advanced-disclosure">
                <summary>{t('settings.advanced')}</summary>
                {group.advanced_fields.map(field => <StartupFieldRow key={`${group.id}-${field.key || field.label}`} field={field} desktop={desktop} onSave={onSave} />)}
              </details>
            ) : null}
          </div>
        </details>
      ) : (
        <>
          <div className="pb-2">{header}</div>
          <div className="text-[11px] pt-2" style={{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>{t('settings.note.no_user_settings')}</div>
        </>
      )}
    </CardShell>
  )
}

function ConfigurationCollection({ groups, desktop, onSave, empty }: {
  groups: ConfigurationGroup[]
  desktop: DesktopSettingsSnapshot | null
  onSave: (field: StartupField, value: string | boolean | null, secret: boolean) => Promise<void>
  empty: string
}) {
  if (!groups.length) return <div className="text-[11px]" style={{ color: 'var(--muted)' }}>{empty}</div>
  return (
    <>
      {groups.map(group => (
        <ConfigurationCard
          key={group.id}
          group={group}
          desktop={desktop}
          onSave={onSave}
        />
      ))}
    </>
  )
}

function SettingsGroup({ children }: { children: ReactNode }) {
  return <section className="flex flex-col" style={{ gap: 8 }}>{children}</section>
}

function SettingsSection({ id, children }: { id: 'general' | 'models' | 'asr' | 'tts'; children: ReactNode }) {
  return <section data-section={id} className="flex flex-col settings-section-content">{children}</section>
}

export default function SettingsPage({ send, subscribe }: Props) {
  const { locale, setLocale, t, formatNumber } = useI18n()
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [desktop, setDesktop] = useState<DesktopSettingsSnapshot | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<UiMessage | null>(null)
  const [reloadStatus, setReloadStatus] = useState('ready')
  const [piModels, setPiModels] = useState<ComboOption[]>([])
  const [piModel, setPiModel] = useState('')
  const [thinkingLevel, setThinkingLevel] = useState('off')
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([])
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
    let cancelled = false
    void send('pi.models').then(result => {
      if (cancelled) return
      if (!result.ok) throw new Error(String(result.error))
      setPiModels(result.models as ComboOption[])
      setPiModel(String(result.current || ''))
      setThinkingLevel(String(result.thinkingLevel || 'off'))
      setThinkingLevels(result.thinkingLevels as string[])
    }).catch(reason => { if (!cancelled) setError({ key: 'settings.loading_error', fallback: String(reason) }) })
    return () => { cancelled = true }
  }, [reloading, send])

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

  const handleStartupSave = useCallback(async (
    field: StartupField,
    value: string | boolean | null,
    secret: boolean,
  ) => {
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
  const generalGroups = asConfigurationGroups(config.general_configuration)

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

  return (
    <div className="settings-scroll-area flex-1 overflow-y-auto" tabIndex={0}>
      <div className="settings-page-shell">
        <div className="flex items-center justify-between gap-4 settings-page-titlebar">
          <div>
            <h1 className="font-[700]" style={{ color: 'var(--text)', fontSize: 21, lineHeight: '28px', letterSpacing: '-0.025em' }}>{t('settings.title')}</h1>
          </div>
          <div className="settings-encryption-state">
            <span className="settings-health-dot" data-ok={desktop?.encryptionAvailable ? 'true' : 'false'} />
            {desktop?.encryptionAvailable ? t('settings.security.available') : t('settings.security.unavailable')}
          </div>
        </div>

        <main className="settings-main">
          <div className="flex flex-col settings-page-sections">
            <SettingsSection id="general">
              <SettingsGroup>
                {/* The panel remounts whenever it is reopened, so `config` is empty until the fetch lands. The interface language the renderer is already using is the only true value available then; an English literal would misreport the active choice. */}
                <ComboCard icon="Language" title={t('settings.label.interface_language')} value={val('presentation_locale', locale)} onChange={value => void handleChange('presentation_locale', value)} options={[{ value: 'en-US', label: t('settings.option.english') }, { value: 'zh-CN', label: t('settings.option.chinese') }, { value: 'ja-JP', label: t('settings.option.japanese') }]} />
              </SettingsGroup>

              {generalGroups.length ? (
                <SettingsGroup>
                  <ConfigurationCollection groups={generalGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                </SettingsGroup>
              ) : null}
            </SettingsSection>
            <SettingsSection id="models">
              <SettingsGroup>
                <ModelCard
                model={piModel}
                modelOptions={piModels}
                thinking={thinkingLevel}
                thinkingOptions={thinkingLevels}
                disabled={Boolean(saving) || reloading}
                onModelChange={value => void changeModel(value)}
                onThinkingChange={value => void changeModel(piModel, value)}
              />
              </SettingsGroup>
            </SettingsSection>
            <SettingsSection id="asr">
              {/* 1. Which configuration is in force, remote or embedded. */}
              <SettingsGroup>
                <ComboCard icon="Microphone" title={t('settings.label.asr_mode')} value={asrBackendId} onChange={value => void handleChange('asr_backend', value)} options={asrBackendOptions} />
              </SettingsGroup>

              {/* 2. Everything that belongs to the selected recognizer, including the
                     language and vocabulary it consumes. */}
              <SettingsGroup>
                <ConfigurationCollection groups={activeAsrGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
              </SettingsGroup>

              {captureGroups.length ? (
                <SettingsGroup>
                  <ConfigurationCollection groups={captureGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                </SettingsGroup>
              ) : null}

              {wakeGroups.length ? (
                <SettingsGroup>
                  <ConfigurationCollection groups={wakeGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                </SettingsGroup>
              ) : null}
            </SettingsSection>
            <SettingsSection id="tts">
              <SettingsGroup>
                <ConfigurationCollection groups={activeOutputGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_active_connection')} />
              </SettingsGroup>

              {otherOutputGroups.length ? (
                <details className="settings-secondary-disclosure">
                  <summary>{t('settings.other_voice_backends')}</summary>
                  <div className="flex flex-col gap-2 mt-3">
                    <ConfigurationCollection groups={otherOutputGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                  </div>
                </details>
              ) : null}
            </SettingsSection>
          </div>

          {saving ? <div className="settings-feedback text-[11px] animate-pulse" style={{ color: 'var(--accent)' }}>{t('settings.saving', undefined, { key: saving })}</div> : null}
          {error ? <div className="settings-feedback text-[11px] rounded-md p-3" style={{ color: '#b42318', background: '#FEF3F2' }}>{error.fallback ?? t(error.key, undefined, error.values)}</div> : null}
        </main>
      </div>
    </div>
  )
}
