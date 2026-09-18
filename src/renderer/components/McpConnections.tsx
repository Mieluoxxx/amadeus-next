import { useMemo, useState } from 'react'
import { Terminal, Shield, RefreshCw, Plus, X, Wrench, CheckCircle2 } from 'lucide-react'
import { useI18n, type MessageKey } from '../i18n'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

export interface McpConnectionSummary {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  providerIds: string[]
  command: string
  arguments: string[]
  cwd: string
  url: string
  bearerTokenEnvVar: string
  environmentKeys: string[]
  mainChatAccess: false
}

interface CompatibleProvider {
  provider_id: string
  display_name: string
  capabilities?: { capability_projections?: string[] }
}

interface Props {
  connections: McpConnectionSummary[]
  locked: boolean
  providers: CompatibleProvider[]
  restartPending: boolean
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  onSettingsChanged: (settings: Record<string, unknown>) => void
  onRestartRequired: () => void
}

interface Draft {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  providerIds: string[]
  command: string
  argumentsText: string
  cwd: string
  url: string
  bearerTokenEnvVar: string
  environmentText: string
  environmentKeys: string[]
}

interface UiMessage {
  key: MessageKey
  fallback?: string
  values?: Record<string, unknown>
}

const EMPTY_DRAFT: Draft = {
  id: '',
  name: '',
  enabled: false,
  transport: 'stdio',
  providerIds: [],
  command: '',
  argumentsText: '',
  cwd: '',
  url: '',
  bearerTokenEnvVar: '',
  environmentText: '',
  environmentKeys: [],
}

function draftFrom(connection: McpConnectionSummary): Draft {
  return {
    id: connection.id,
    name: connection.name,
    enabled: connection.enabled,
    transport: connection.transport,
    providerIds: [...connection.providerIds],
    command: connection.command,
    argumentsText: connection.arguments.join('\n'),
    cwd: connection.cwd,
    url: connection.url,
    bearerTokenEnvVar: connection.bearerTokenEnvVar,
    environmentText: '',
    environmentKeys: [...connection.environmentKeys],
  }
}

function parseEnvironment(
  text: string,
  t: (key: MessageKey, fallback?: string, values?: Record<string, unknown>) => string
): Record<string, string | null> {
  const result: Record<string, string | null> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const separator = line.indexOf('=')
    if (separator <= 0) throw new Error(t('mcp.invalid_env_entry', undefined, { line }))
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
      throw new Error(t('mcp.invalid_env_key', undefined, { key }))
    }
    const value = line.slice(separator + 1)
    result[key] = value || null
  }
  return result
}

function endpointLabel(connection: McpConnectionSummary): string {
  if (connection.transport === 'http') return connection.url
  return [connection.command, ...connection.arguments].filter(Boolean).join(' ')
}

function FieldLabel({ children }: { children: string }) {
  return (
    <label className="text-xs font-semibold text-[#1d1d1f] tracking-tight">
      {children}
    </label>
  )
}

export default function McpConnections({
  connections,
  locked,
  providers,
  restartPending,
  send,
  onSettingsChanged,
  onRestartRequired,
}: Props) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<UiMessage | null>(null)
  const [removeCandidate, setRemoveCandidate] = useState('')
  const [testState, setTestState] = useState<Record<string, UiMessage>>({})

  const compatibleProviders = useMemo(
    () =>
      providers.filter((provider) =>
        (provider.capabilities?.capability_projections || []).includes('mcp_connection')
      ),
    [providers]
  )

  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current))
  }

  const save = async () => {
    if (!draft || !window.amadeus) return
    setSaving(true)
    setError(null)
    try {
      const environment = parseEnvironment(draft.environmentText, t)
      const result = await window.amadeus.upsertMcpConnection({
        connection: {
          id: draft.id || undefined,
          name: draft.name,
          enabled: draft.enabled,
          transport: draft.transport,
          providerIds: draft.providerIds,
          command: draft.command,
          arguments: draft.argumentsText
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
          cwd: draft.cwd,
          url: draft.url,
          bearerTokenEnvVar: draft.bearerTokenEnvVar,
        },
        environment,
      })
      if (!result.ok) throw new Error(result.error || t('mcp.save_error', 'Could not save MCP connection'))
      if (result.settings) onSettingsChanged(result.settings)
      onRestartRequired()
      setDraft(null)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? { key: 'mcp.save_error', fallback: reason.message }
          : { key: 'mcp.save_error' }
      )
    } finally {
      setSaving(false)
    }
  }

  const remove = async (connectionId: string) => {
    if (!window.amadeus) return
    setSaving(true)
    setError(null)
    try {
      const result = await window.amadeus.removeMcpConnection(connectionId)
      if (!result.ok) throw new Error(result.error || t('mcp.remove_error', 'Could not remove MCP connection'))
      if (result.settings) onSettingsChanged(result.settings)
      onRestartRequired()
      setRemoveCandidate('')
      if (draft?.id === connectionId) setDraft(null)
    } catch (reason) {
      setError(
        reason instanceof Error
          ? { key: 'mcp.remove_error', fallback: reason.message }
          : { key: 'mcp.remove_error' }
      )
    } finally {
      setSaving(false)
    }
  }

  const test = async (connectionId: string) => {
    setTestState((current) => ({ ...current, [connectionId]: { key: 'mcp.testing' } }))
    try {
      const result = await send('mcp.connection.test', { connection_id: connectionId })
      const detail: UiMessage =
        result.status === 'connected'
          ? { key: 'mcp.connected_tools', values: { count: Number(result.tool_count || 0) } }
          : { key: 'mcp.connection_failed', fallback: String(result.detail || result.code || '') }
      setTestState((current) => ({ ...current, [connectionId]: detail }))
    } catch (reason) {
      setTestState((current) => ({
        ...current,
        [connectionId]: {
          key: 'mcp.connection_failed',
          fallback: reason instanceof Error ? reason.message : undefined,
        },
      }))
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Apple style boundary info card */}
      <div className="rounded-2xl border border-[#0071e3]/15 bg-[#0071e3]/5 p-3.5 backdrop-blur-md">
        <div className="flex items-center gap-1.5 text-xs font-bold text-[#0071e3]">
          <Shield className="w-3.5 h-3.5" />
          <span>{t('mcp.boundary.title')}</span>
        </div>
        <div className="text-[11.5px] mt-1 text-[#86868b] leading-relaxed">
          {t('mcp.boundary.body')}
        </div>
      </div>

      {/* Connection List */}
      {connections.map((connection) => (
        <Card key={connection.id} className="p-4 space-y-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-xl bg-black/[0.04] flex items-center justify-center text-[#86868b] shrink-0">
              <Terminal className="w-4 h-4" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold text-[#1d1d1f]">
                  {connection.name}
                </span>
                <Badge variant="secondary" className="text-[9px] uppercase tracking-wider py-0 px-1.5">
                  {connection.transport}
                </Badge>
              </div>
              <div className="text-[11px] mt-0.5 truncate text-[#86868b] font-mono">
                {endpointLabel(connection)}
              </div>
            </div>

            <Badge
              variant={connection.enabled ? 'success' : 'secondary'}
              className="px-2.5 py-0.5 text-[10px]"
            >
              {connection.enabled ? t('mcp.enabled') : t('mcp.disabled')}
            </Badge>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2.5 border-t border-black/[0.05] text-[11px] text-[#86868b]">
            <div>
              <span className="font-semibold text-[#1d1d1f]">{t('mcp.providers')}:</span>{' '}
              {connection.providerIds.length ? connection.providerIds.join(', ') : t('mcp.not_bound')}
            </div>
            <div>
              <span className="font-semibold text-[#1d1d1f]">{t('mcp.main_chat')}:</span>{' '}
              {t('mcp.no_access')}
            </div>
            <div className="col-span-full">
              <span className="font-semibold text-[#1d1d1f]">{t('mcp.encrypted_environment')}:</span>{' '}
              {connection.environmentKeys.length ? connection.environmentKeys.join(', ') : t('mcp.none')}
            </div>
          </div>

          {testState[connection.id] && (
            <div
              className={cn(
                'text-[11px] font-medium pt-1',
                testState[connection.id].key === 'mcp.connected_tools' ? 'text-emerald-600' : 'text-amber-600'
              )}
            >
              {testState[connection.id].fallback ??
                t(testState[connection.id].key, undefined, testState[connection.id].values)}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1 border-t border-black/[0.04]">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void test(connection.id)}
              disabled={restartPending || saving}
              className="text-xs"
              title={restartPending ? t('mcp.restart_test_title') : t('mcp.test_title')}
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              <span>{t('mcp.test')}</span>
            </Button>

            <Button
              variant="glass"
              size="sm"
              onClick={() => {
                setDraft(draftFrom(connection))
                setError(null)
              }}
              disabled={locked || saving}
              className="text-xs font-semibold"
            >
              <span>{t('mcp.edit')}</span>
            </Button>

            <Button
              variant={removeCandidate === connection.id ? 'destructive' : 'ghost'}
              size="sm"
              onClick={() =>
                removeCandidate === connection.id ? void remove(connection.id) : setRemoveCandidate(connection.id)
              }
              disabled={locked || saving}
              className="text-xs"
            >
              <span>
                {removeCandidate === connection.id ? t('mcp.confirm_remove') : t('mcp.remove')}
              </span>
            </Button>
          </div>
        </Card>
      ))}

      {/* Editor Card */}
      {draft ? (
        <Card className="p-5 border-[#0071e3]/30 bg-white/85 shadow-lg space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-bold text-[#1d1d1f]">
                {draft.id ? t('mcp.edit_title') : t('mcp.add_title')}
              </h3>
              <p className="text-[11.5px] text-[#86868b] mt-0.5">
                {t('mcp.editor_detail')}
              </p>
            </div>
            <button
              onClick={() => setDraft(null)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[#86868b] hover:text-[#1d1d1f] hover:bg-black/[0.04]"
              aria-label={t('mcp.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <FieldLabel>{t('mcp.name')}</FieldLabel>
              <Input
                value={draft.name}
                onChange={(event) => updateDraft('name', event.target.value)}
                placeholder="GitHub"
              />
            </div>

            <div className="space-y-1.5">
              <FieldLabel>{t('mcp.transport')}</FieldLabel>
              <select
                value={draft.transport}
                onChange={(event) => updateDraft('transport', event.target.value as 'stdio' | 'http')}
                className="w-full h-8 rounded-xl border border-black/[0.08] bg-white/70 px-3 py-1 text-xs text-[#1d1d1f] outline-none focus:ring-2 focus:ring-[#0071e3]/40 cursor-pointer"
              >
                <option value="stdio">{t('mcp.stdio_command')}</option>
                <option value="http">{t('mcp.streamable_http')}</option>
              </select>
            </div>

            {draft.transport === 'stdio' ? (
              <>
                <div className="col-span-full space-y-1.5">
                  <FieldLabel>{t('mcp.command')}</FieldLabel>
                  <Input
                    value={draft.command}
                    onChange={(event) => updateDraft('command', event.target.value)}
                    placeholder="npx"
                  />
                </div>
                <div className="col-span-full space-y-1.5">
                  <FieldLabel>{t('mcp.arguments')}</FieldLabel>
                  <Textarea
                    value={draft.argumentsText}
                    onChange={(event) => updateDraft('argumentsText', event.target.value)}
                    placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                    className="min-h-[80px]"
                  />
                </div>
                <div className="col-span-full space-y-1.5">
                  <FieldLabel>{t('mcp.working_directory')}</FieldLabel>
                  <Input
                    value={draft.cwd}
                    onChange={(event) => updateDraft('cwd', event.target.value)}
                    placeholder={t('mcp.optional', 'Optional')}
                  />
                </div>
              </>
            ) : (
              <>
                <div className="col-span-full space-y-1.5">
                  <FieldLabel>{t('mcp.server_url')}</FieldLabel>
                  <Input
                    type="url"
                    value={draft.url}
                    onChange={(event) => updateDraft('url', event.target.value)}
                    placeholder="https://example.com/mcp"
                  />
                </div>
                <div className="col-span-full space-y-1.5">
                  <FieldLabel>{t('mcp.bearer_env')}</FieldLabel>
                  <Input
                    value={draft.bearerTokenEnvVar}
                    onChange={(event) => updateDraft('bearerTokenEnvVar', event.target.value)}
                    placeholder={t('mcp.bearer_optional', 'Optional · for example MCP_TOKEN')}
                  />
                </div>
              </>
            )}

            <div className="col-span-full space-y-1.5">
              <FieldLabel>{t('mcp.encrypted_values')}</FieldLabel>
              <Textarea
                value={draft.environmentText}
                onChange={(event) => updateDraft('environmentText', event.target.value)}
                placeholder={
                  draft.environmentKeys.length
                    ? t('mcp.keep_environment')
                    : t('mcp.environment_optional')
                }
                className="min-h-[70px]"
              />
              {draft.environmentKeys.length ? (
                <div className="text-[10px] text-[#86868b]">
                  {t('mcp.stored')} {draft.environmentKeys.join(', ')}
                </div>
              ) : null}
            </div>

            <div className="col-span-full space-y-2">
              <FieldLabel>{t('mcp.compatible_providers')}</FieldLabel>
              {compatibleProviders.length ? (
                <div className="flex flex-wrap gap-2">
                  {compatibleProviders.map((provider) => {
                    const checked = draft.providerIds.includes(provider.provider_id)
                    return (
                      <button
                        key={provider.provider_id}
                        type="button"
                        onClick={() =>
                          updateDraft(
                            'providerIds',
                            checked
                              ? draft.providerIds.filter((value) => value !== provider.provider_id)
                              : [...draft.providerIds, provider.provider_id]
                          )
                        }
                        className={cn(
                          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all',
                          checked
                            ? 'bg-[#0071e3]/10 border-[#0071e3]/30 text-[#0071e3]'
                            : 'bg-black/[0.03] border-black/[0.06] text-[#86868b] hover:text-[#1d1d1f]'
                        )}
                      >
                        {checked && <CheckCircle2 className="w-3.5 h-3.5" />}
                        <span>{provider.display_name || provider.provider_id}</span>
                      </button>
                    )
                  })}
                </div>
              ) : (
                <div className="text-[11px] text-amber-700">{t('mcp.no_compatible_provider')}</div>
              )}
            </div>

            <div className="col-span-full flex items-center justify-between p-3 rounded-xl border border-black/[0.06] bg-black/[0.02]">
              <div>
                <span className="text-xs font-bold text-[#1d1d1f]">{t('mcp.enable_selected')}</span>
                <span className="block text-[10.5px] text-[#86868b] mt-0.5">
                  {t('mcp.no_main_chat_grant')}
                </span>
              </div>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(checked) => updateDraft('enabled', checked)}
              />
            </div>
          </div>

          {error && (
            <div className="text-xs text-rose-600 font-medium">
              {error.fallback ?? t(error.key, undefined, error.values)}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-black/[0.05]">
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t('mcp.cancel')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void save()}
              disabled={saving}
              className="font-semibold"
            >
              {saving ? t('settings.saving_label') : t('mcp.save')}
            </Button>
          </div>
        </Card>
      ) : (
        <Button
          variant="glass"
          size="sm"
          onClick={() => {
            setDraft({ ...EMPTY_DRAFT })
            setError(null)
          }}
          disabled={locked}
          className="self-start gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{t('mcp.add')}</span>
        </Button>
      )}

      {locked ? <div className="text-xs text-[#86868b]">{t('mcp.locked')}</div> : null}
      {!connections.length && !draft ? (
        <div className="text-xs text-[#86868b] italic">{t('mcp.empty')}</div>
      ) : null}
      {error && !draft ? (
        <div className="text-xs text-rose-600 font-medium">
          {error.fallback ?? t(error.key, undefined, error.values)}
        </div>
      ) : null}
    </div>
  )
}
