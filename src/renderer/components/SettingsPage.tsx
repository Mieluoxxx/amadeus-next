import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import FluentIcon, { type FluentIconName } from './FluentIcon'
import { translateDynamic, translateSetting, useI18n, type MessageKey } from '../i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { createRestartScheduler, providerCredentialDecision } from './settingsStartupApply'

interface Props {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  subscribe: (method: string, fn: (p: Record<string, unknown>) => void) => () => void
}

type SettingsSection = 'general' | 'models' | 'asr' | 'tts'

const SECTION_BG: Record<SettingsSection, string> = {
  general: 'bg-[#0071e3]',
  models: 'bg-[#af52de]',
  asr: 'bg-[#ff2d55]',
  tts: 'bg-[#34c759]',
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
  value?: string | boolean
  configured?: boolean
  options?: StartupOption[]
  min?: number
  max?: number
  step?: number
  editable: boolean
  restart_required: boolean
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

// Provider ids whose credential is a single desktop-store secret. Ids name wire
// protocols now (plus the DeepSeek preset), and the retired vendor ids openai
// and gemini normalize onto one of these on read. This is what separates "the
// process started before the key was written" (a restart brings it in) from
// "nobody entered a key yet" (a restart would accomplish nothing).
const PROVIDER_SECRET_KEYS: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  'openai-responses': 'OPENAI_API_KEY',
  'openai-completions': 'OPENAI_API_KEY',
  'anthropic-messages': 'ANTHROPIC_API_KEY',
  'google-gemini': 'GEMINI_API_KEY',
}

// A store written by an earlier version may hold a window scope. Show the full
// screen it resolves to instead of rendering a select with no matching option.
// A connection card saves field by field. Wait for that burst to finish so one
// restart covers every field: the backend reads the store when it spawns.
const AUTO_RESTART_DEBOUNCE_MS = 1000

function asConfigurationGroups(value: unknown): ConfigurationGroup[] {
  return Array.isArray(value) ? value as ConfigurationGroup[] : []
}

function GroupTitle({ children }: { children: string }) {
  return <h3 className="text-[14px] font-[700]" style={{ color: 'var(--text)', lineHeight: '20px', letterSpacing: '-0.012em' }}>{children}</h3>
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

function ComboCard({ icon, title, value, onChange, options, disabled }: {
  icon: FluentIconName; title: string; value: string
  onChange: (v: string) => void; options: ComboOption[]; disabled?: boolean
}) {
  const { locale } = useI18n()
  return (
    <CardShell>
      <CardIcon name={icon} />
      <div className="flex-1 min-w-0 pr-4">
        <div className="text-[13px] font-semibold text-[#1d1d1f] leading-snug">{title}</div>
      </div>
      <select
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={disabled}
        className="text-xs font-semibold bg-white/80 border border-black/[0.08] rounded-xl px-3 py-1.5 text-[#1d1d1f] outline-none hover:border-black/[0.15] focus:ring-2 focus:ring-[#0071e3]/40 disabled:opacity-40 shrink-0 cursor-pointer"
        style={{ minWidth: 145, height: 34 }}
      >
        {options.map(option => {
          const optionValue = typeof option === 'string' ? option : option.value
          const label = typeof option === 'string' ? option : option.label
          return <option key={optionValue} value={optionValue}>{translateDynamic(locale, 'settings.option', optionValue, label)}</option>
        })}
      </select>
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

function InfoCard({ icon, title, content, value }: {
  icon: FluentIconName; title: string; content?: string; value: string
}) {
  return (
    <CardShell>
      <CardIcon name={icon} />
      <div className="flex-1 min-w-0" style={{ paddingRight: 16 }}>
        <div className="text-[13px] font-[600]" style={{ color: 'var(--text)', lineHeight: '19px' }}>{title}</div>
        {content ? <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--muted)', lineHeight: '17px' }}>{content}</div> : null}
      </div>
      <span className="shrink-0 text-[12px] font-[550] text-right" style={{ color: 'var(--text)', maxWidth: 300 }}>{value}</span>
    </CardShell>
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
  const [draft, setDraft] = useState<string | boolean>(initial)
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

function OverviewCard({ icon, label, value, detail, ok = true, onClick }: {
  icon: FluentIconName
  label: string
  value: string
  detail?: string
  ok?: boolean
  onClick?: () => void
}) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="w-7 h-7 rounded-lg bg-black/[0.04] flex items-center justify-center text-[#86868b]">
          <FluentIcon name={icon} size={15} />
        </div>
        <span
          className={cn(
            'w-2 h-2 rounded-full shrink-0 shadow-xs',
            ok ? 'bg-emerald-500 shadow-emerald-500/50' : 'bg-amber-400 shadow-amber-400/50'
          )}
        />
      </div>
      <div className="text-[10px] uppercase tracking-wider mt-3 text-[#86868b] font-bold">{label}</div>
      <div className="text-sm font-bold mt-1 truncate text-[#1d1d1f]">{value}</div>
      {/* Only real backend status text earns a line here; a generic filler
          sentence under every card was the noise this card set is meant to drop. */}
      {detail ? <div className="text-[10.5px] mt-1 text-[#86868b] leading-tight line-clamp-1">{detail}</div> : null}
    </>
  )
  return onClick ? (
    <button
      type="button"
      className="rounded-2xl border border-black/[0.06] bg-white/75 backdrop-blur-xl p-3.5 text-left transition-all duration-200 shadow-[0_2px_10px_rgba(0,0,0,0.03),inset_0_1px_1px_rgba(255,255,255,0.85)] hover:bg-white hover:shadow-[0_6px_20px_rgba(0,0,0,0.06)] active:scale-[0.98] min-w-0"
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div className="rounded-2xl border border-black/[0.06] bg-white/75 backdrop-blur-xl p-3.5 text-left shadow-[0_2px_10px_rgba(0,0,0,0.03),inset_0_1px_1px_rgba(255,255,255,0.85)] min-w-0">
      {content}
    </div>
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

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <GroupTitle>{title}</GroupTitle>
      <div className="flex flex-col" style={{ gap: 8, marginTop: 14 }}>{children}</div>
    </section>
  )
}

export default function SettingsPage({ send, subscribe }: Props) {
  const { locale, setLocale, t, formatNumber } = useI18n()
  const [section, setSection] = useState<SettingsSection>('general')
  const [config, setConfig] = useState<Record<string, unknown>>({})
  const [desktop, setDesktop] = useState<DesktopSettingsSnapshot | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [restartPending, setRestartPending] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState<UiMessage | null>(null)
  // The restart callback is defined below, so the scheduler reaches the current
  // one through a ref when its timer fires.
  const restartBackendRef = useRef<() => void>(() => {})

  // One scheduler for the life of the page: it owns the pending timer, so a
  // burst of saves cannot leave a second restart queued behind the first.
  const restartScheduler = useMemo(
    () => createRestartScheduler(() => restartBackendRef.current(), AUTO_RESTART_DEBOUNCE_MS),
    [],
  )

  useEffect(() => () => restartScheduler.cancel(), [restartScheduler])

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

  const restartBackend = useCallback(async () => {
    if (!window.amadeus) return
    setRestarting(true)
    setError(null)
    try {
      const result = await window.amadeus.restartBackend()
      if (result?.restarted) {
        setRestartPending(false)
        // The restarted backend has new live config, and this page's own
        // decisions read it (which provider credentials the process holds).
        // Nothing refreshes on its own: the config subscription only fires when
        // the backend emits, and a restart does not.
        try {
          const response = await send('system.get_config', {})
          setConfig((response.values as Record<string, unknown>) ?? response)
          void refreshDesktop()
        } catch {
          // The socket may still be reconnecting. Leave the values as they are
          // rather than reporting a failed refresh as a failed restart.
        }
        return
      }
      // The running backend was not started by this app, so this process has
      // nothing to restart. Keep the banner and say why, instead of clearing it
      // and leaving the saved values silently unapplied.
      setError({
        key: result?.reason === 'not_owned' ? 'settings.restart_unowned' : 'settings.restart_error',
      })
    } catch (reason) {
      setError(reason instanceof Error ? { key: 'settings.restart_error', fallback: reason.message } : { key: 'settings.restart_error' })
    } finally {
      setRestarting(false)
    }
  }, [t, send, refreshDesktop])

  useEffect(() => {
    restartBackendRef.current = () => void restartBackend()
  }, [restartBackend])

  // A saved startup value only reaches the backend when it spawns, which is why
  // the reported bug read as "the key was ignored". Restart for the user, but
  // coalesce a burst of saves (a connection card saves field by field) into one
  // attempt and let the store settle first.
  const scheduleAutoRestart = useCallback(() => {
    setRestartPending(true)
    restartScheduler.schedule()
  }, [restartScheduler])

  const handleChange = useCallback(async (key: string, value: unknown) => {
    setSaving(key)
    setError(null)
    try {
      const response = await send('system.set_config', { values: { [key]: value } })
      setConfig((response.values as Record<string, unknown>) ?? response)
      if (key === 'llm_provider') {
        const persisted = await window.amadeus?.updateDesktopSettings({ values: { LLM_PROVIDER: String(value) } })
        if (persisted && !persisted.ok) throw new Error(persisted.error || t('settings.save_error', undefined, { key }))
        if (persisted?.settings) setDesktop(persisted.settings as unknown as DesktopSettingsSnapshot)
        // The provider switch itself is already live: system.set_config calls
        // set_provider. Only a credential this process is missing can need a
        // restart, so probe the running config first -- switching to a provider
        // nobody configured must not restart the backend for nothing.
        const provider = String(value)
        const secretKey = PROVIDER_SECRET_KEYS[provider]
        const decision = providerCredentialDecision({
          secretKey,
          configuredInProcess: asConfigurationGroups(config.model_connections)
            .some(group => group.id === provider && group.configured),
          storedSecret: Boolean(secretKey && desktop?.secrets?.[secretKey]?.configured),
        })
        if (decision === 'restart') {
          // Stored, but this process started before it was written.
          scheduleAutoRestart()
        } else if (decision === 'needs_key') {
          setError({ key: 'settings.provider_needs_key', values: { provider } })
        }
      }
      // The runtime backend switch is process-local, so the recognition mode
      // persists its startup equivalent to survive a restart.
      if (key === 'asr_backend') {
        const persisted = await window.amadeus?.updateDesktopSettings({ values: { ASR_BACKEND: String(value) } })
        if (persisted && !persisted.ok) throw new Error(persisted.error || t('settings.save_error', undefined, { key }))
        if (persisted?.settings) setDesktop(persisted.settings as unknown as DesktopSettingsSnapshot)
      }
      if (key === 'presentation_locale') {
        setLocale(value)
        const persisted = await window.amadeus?.updateDesktopSettings({ values: { AMADEUS_PRESENTATION_LOCALE: String(value) } })
        if (persisted && !persisted.ok) throw new Error(persisted.error || t('settings.save_error', undefined, { key }))
        if (persisted?.settings) setDesktop(persisted.settings as unknown as DesktopSettingsSnapshot)
      }
    } catch (reason) {
      setError(reason instanceof Error ? { key: 'settings.update_error', fallback: reason.message, values: { key } } : { key: 'settings.update_error', values: { key } })
    } finally {
      setSaving(null)
    }
  }, [send, setLocale, t, config, desktop, scheduleAutoRestart])

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
      scheduleAutoRestart()
    } catch (reason) {
      setError(reason instanceof Error ? { key: 'settings.save_error', fallback: reason.message, values: { key: field.key } } : { key: 'settings.save_error', values: { key: field.key } })
      throw reason
    } finally {
      setSaving(null)
    }
  }, [t, scheduleAutoRestart])

  const val = (key: string, fallback: string) => String(config[key] ?? fallback)
  const visualPack = asRecord(config.visual_asset_pack)
  const visualPackInstalled = Boolean(visualPack.installed)
  const visualPackState = String(visualPack.state ?? 'not_installed')
  const visualPackValue = visualPackInstalled
    ? t('settings.asset.installed')
    : visualPackState === 'incomplete' ? t('settings.asset.incomplete') : visualPackState === 'invalid' ? t('settings.asset.invalid') : t('settings.asset.not_installed')
  const visualPackContent = visualPackInstalled
    ? t('settings.asset.visual_content')
    : visualPackState === 'incomplete' || visualPackState === 'invalid'
      ? t('settings.asset.visual_attention', undefined, { detail: String(visualPack.message || (visualPack.missing as unknown[] || []).join(', ') || visualPackState) })
      : t('settings.asset.visual_optional')
  const characterPack = asRecord(config.character_pack)
  const characterPackInstalled = Boolean(characterPack.installed)
  const characterPackState = String(characterPack.state ?? 'not_installed')
  const characterPackValue = characterPackInstalled
    ? `${t('settings.asset.installed')} · ${formatNumber(Number(characterPack.clip_count ?? 0))} ${t('settings.asset.clips', 'clips')}`
    : characterPackState === 'invalid' ? t('settings.asset.invalid') : t('settings.asset.not_installed')
  const characterPackContent = characterPackInstalled
    ? t('settings.asset.character_content', undefined, { frames: formatNumber(Number(characterPack.frame_count ?? 0)), path: String(characterPack.relative_path ?? '') })
    : characterPackState === 'invalid'
      ? t('settings.asset.character_attention', undefined, { detail: String(characterPack.message ?? t('settings.validation_failed', 'validation failed')) })
      : t('settings.asset.character_optional')

  const modelConnections = asConfigurationGroups(config.model_connections)
  const modelRoles = asConfigurationGroups(config.model_roles)
  const voiceConfiguration = asConfigurationGroups(config.voice_configuration)


  const activeModelConnections = modelConnections.filter(group => group.active)
  const currentModelStatus = activeModelConnections.find(group => group.active)
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
  const asrStatus = voiceConfiguration.find(group => group.id === asrGroupId)
  const synthesisStatus = voiceConfiguration.find(group => group.id === 'speech_synthesis')
  const otherModelConnections = modelConnections.filter(group => !group.active)
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
  const sectionDefinitions: Array<{
    id: SettingsSection
    label: string
    icon: FluentIconName
  }> = [
    { id: 'general', label: t('settings.section.general'), icon: 'Setting' },
    { id: 'models', label: t('settings.section.models'), icon: 'Robot' },
    { id: 'asr', label: t('settings.section.asr'), icon: 'Microphone' },
    { id: 'tts', label: t('settings.section.tts'), icon: 'Play' },
  ]

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

        {restartPending ? (
          <div className="settings-restart-banner" role="status">
            <div className="flex items-center gap-3 min-w-0">
              <div className="settings-restart-icon"><FluentIcon name="Sync" size={16} /></div>
              <div className="min-w-0">
                <div className="text-[12px] font-[700]" style={{ color: 'var(--text)' }}>{t('settings.restart_pending')}</div>
                <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--muted)' }}>{t('settings.restart_pending_detail')}</div>
              </div>
            </div>
            <button onClick={() => void restartBackend()} disabled={restarting} className="settings-primary-button disabled:opacity-50">
              {restarting ? t('settings.restarting') : t('settings.restart')}
            </button>
          </div>
        ) : null}

        <div className="settings-layout flex gap-6 items-start" style={{ width: '100%' }}>
          <nav className="settings-section-nav shrink-0 flex flex-col sticky" aria-label={t('settings.aria_sections')}>
            {sectionDefinitions.map(item => {
              const active = section === item.id
              const colorBg = SECTION_BG[item.id]
              return (
                <button
                  key={item.id}
                  onClick={() => setSection(item.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 w-full p-2.5 rounded-xl text-left transition-all duration-150',
                    active
                      ? 'bg-white shadow-[0_2px_8px_rgba(0,0,0,0.06),0_1px_1px_rgba(0,0,0,0.04)] border border-black/[0.04]'
                      : 'hover:bg-black/[0.03] text-[#48484a]'
                  )}
                >
                  <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center text-white shrink-0 shadow-xs', colorBg)}>
                    <FluentIcon name={item.icon} size={15} color="#ffffff" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block text-xs font-bold leading-tight', active ? 'text-[#1d1d1f]' : 'text-[#48484a]')}>
                      {item.label}
                    </span>
                  </span>
                </button>
              )
            })}
          </nav>

          <main className="settings-main flex-1 min-w-0">
            {section === 'general' ? (
              <div className="flex flex-col settings-section-content">
                <section>
                  <GroupTitle>{t('settings.overview.title')}</GroupTitle>
                  {/* The three runtime roles. Each card shows its health dot and
                      whatever status text the backend actually reports; the generic
                      "Current runtime selection" filler line stays out. */}
                  <div className="settings-overview-grid">
                    <OverviewCard icon="Robot" label={t('settings.overview.model')} value={val('llm_provider', 'deepseek')} detail={currentModelStatus?.status_detail} ok={currentModelStatus?.status_ok ?? true} onClick={() => setSection('models')} />
                    <OverviewCard icon="Microphone" label={t('settings.overview.listening')} value={asrBackendId} detail={asrStatus?.status_detail} ok={asrStatus?.status_ok ?? false} onClick={() => setSection('asr')} />
                    <OverviewCard icon="Play" label={t('settings.overview.speaking')} value={val('tts_backend', 'gpt_sovits')} detail={synthesisStatus?.status_detail} ok={synthesisStatus?.status_ok ?? false} onClick={() => setSection('tts')} />
                  </div>
                </section>

                <SettingsGroup title={t('settings.group.chat_voice')}>
                  {/* The panel remounts whenever it is reopened, so `config` is empty until the fetch lands. The interface language the renderer is already using is the only true value available then; an English literal would misreport the active choice. */}
                  <ComboCard icon="Language" title={t('settings.label.interface_language')} value={val('presentation_locale', locale)} onChange={value => void handleChange('presentation_locale', value)} options={[{ value: 'en-US', label: t('settings.option.english') }, { value: 'zh-CN', label: t('settings.option.chinese') }, { value: 'ja-JP', label: t('settings.option.japanese') }]} />
                </SettingsGroup>

                <SettingsGroup title={t('settings.group.chat_appearance')}>
                  <InfoCard icon="Photo" title={t('settings.label.visual_pack')} content={visualPackInstalled ? undefined : visualPackContent} value={visualPackValue} />
                  <InfoCard icon="People" title={t('settings.label.character_pack')} content={!characterPackInstalled && characterPackState === 'invalid' ? characterPackContent : undefined} value={characterPackValue} />
                </SettingsGroup>
              </div>
            ) : null}

            {section === 'models' ? (
              <div className="flex flex-col settings-section-content">
                <SettingsGroup title={t('settings.group.main_model')}>
                  <InfoCard icon="Robot" title={t('settings.label.current_model')} value={val('llm_provider', 'pi')} />
                </SettingsGroup>

                <SettingsGroup title={t('settings.group.active_connections')}>
                  <ConfigurationCollection groups={activeModelConnections} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_active_connection')} />
                </SettingsGroup>


                <details className="settings-secondary-disclosure">
                  <summary>{t('settings.other_connections')}</summary>
                  <div className="flex flex-col gap-2 mt-3">
                    <ConfigurationCollection groups={otherModelConnections} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                  </div>
                </details>

                <details className="settings-secondary-disclosure">
                  <summary>{t('settings.advanced_roles')}</summary>
                  <div className="flex flex-col gap-2 mt-3">
                    <ConfigurationCollection groups={modelRoles} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                  </div>
                </details>
              </div>
            ) : null}

            {section === 'asr' ? (
              <div className="flex flex-col settings-section-content">

                {/* 1. Which configuration is in force, remote or embedded. */}
                <SettingsGroup title={t('settings.group.asr_current')}>
                  <ComboCard icon="Microphone" title={t('settings.label.asr_mode')} value={asrBackendId} onChange={value => void handleChange('asr_backend', value)} options={asrBackendOptions} />
                </SettingsGroup>

                {/* 2. Everything that belongs to the selected recognizer, including the
                       language and vocabulary it consumes. */}
                <SettingsGroup title={t('settings.group.asr_configuration')}>
                  <ConfigurationCollection groups={activeAsrGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                </SettingsGroup>

                {/* 3. Microphone capture and endpointing, which stay local in every
                       mode; only the transcription step can be remote. */}
                <SettingsGroup title={t('settings.group.asr_capture')}>
                  <ConfigurationCollection groups={captureGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                </SettingsGroup>

                {/* 4. The wake and acoustic subsystems, which run alongside recognition. */}
                <SettingsGroup title={t('settings.group.asr_remaining')}>
                  <ConfigurationCollection groups={wakeGroups} desktop={desktop} onSave={handleStartupSave} empty={t('settings.note.no_user_settings')} />
                </SettingsGroup>
              </div>
            ) : null}

            {section === 'tts' ? (
              <div className="flex flex-col settings-section-content">


                <SettingsGroup title={t('settings.group.voice_output')}>
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
              </div>
            ) : null}


            {saving ? <div className="settings-feedback text-[11px] animate-pulse" style={{ color: 'var(--accent)' }}>{t('settings.saving', undefined, { key: saving })}</div> : null}
            {error ? <div className="settings-feedback text-[11px] rounded-md p-3" style={{ color: '#b42318', background: '#FEF3F2' }}>{error.fallback ?? t(error.key, undefined, error.values)}</div> : null}
          </main>
        </div>
      </div>
    </div>
  )
}
