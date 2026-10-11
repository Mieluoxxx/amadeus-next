/**
 * 设置页「长期记忆」：开关与召回模式、核心记忆、待确认提议、ongoing 到期复核。
 * 数据全部来自 memory.*（long-term-memory §8.1），记忆服务没就绪时只显示提示，不影响设置页其余部分。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n, type MessageKey } from '../i18n'
import ConfirmDialog from './ui/ConfirmDialog'
import { Card, ComboSelect, Row } from './settings/parts'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void
type Payload = Record<string, unknown>

const MEMORY_TYPES = ['profile', 'preference', 'relationship', 'feedback', 'ongoing'] as const
type MemoryType = typeof MEMORY_TYPES[number]
const RECALL_MODES = ['off', 'log', 'on'] as const
const BODY_LIMIT = 120
const REVIEW_EXTENSION_DAYS = 30

type MemoryItem = {
  id: string
  type: MemoryType
  status: 'reviewed' | 'unreviewed' | 'archived'
  body: string
  confidence: string
  source: string
  sourceQuote: string
  updatedAt: string
  reviewAfter: string
  expired: boolean
  injected: boolean
  proposal: { kind: 'replace' | 'remove'; targetBody: string } | null
}

type MemoryStats = { snapshotBytes: number; snapshotLimit: number; truncated: boolean; archived: number }
type InvalidFile = { file: string; error: string }

const asObject = (value: unknown): Payload => (value && typeof value === 'object' ? value as Payload : {})

function normalizeItem(raw: unknown): MemoryItem | null {
  const value = asObject(raw)
  const id = String(value.id ?? '')
  if (!id) return null
  const type = MEMORY_TYPES.find(item => item === value.type) ?? 'preference'
  const status = value.status === 'unreviewed' || value.status === 'archived' ? value.status : 'reviewed'
  const proposal = asObject(value.proposal)
  return {
    id,
    type,
    status,
    body: String(value.body ?? ''),
    confidence: String(value.confidence ?? ''),
    source: String(value.source ?? ''),
    sourceQuote: String(value.sourceQuote ?? ''),
    updatedAt: String(value.updatedAt ?? ''),
    reviewAfter: String(value.reviewAfter ?? ''),
    expired: value.expired === true,
    // 缺省按"已注入"处理：旧版本的返回里没有这个字段时，不该给每条记忆都贴上"未使用"。
    injected: value.injected !== false,
    proposal: proposal.kind === 'replace' || proposal.kind === 'remove'
      ? { kind: proposal.kind, targetBody: String(proposal.targetBody ?? '') }
      : null,
  }
}

function normalizeStats(raw: unknown): MemoryStats {
  const value = asObject(raw)
  const number = (key: string, fallback: number) => Number.isFinite(Number(value[key])) ? Number(value[key]) : fallback
  return {
    snapshotBytes: number('snapshotBytes', 0),
    snapshotLimit: number('snapshotLimit', 3072),
    truncated: value.truncated === true,
    archived: number('archived', 0),
  }
}

const codePoints = (value: string) => [...value.replace(/\s+/g, ' ').trim()].length

/** 本地日期，不是 UTC：reviewAfter 按主人所在时区的"今天"判断到期。 */
function dateAfter(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const errorText = (result: Payload) => String(result.error || result.code || '')

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="memory-switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span aria-hidden="true" />
    </button>
  )
}

function MemoryEditor({ initialBody, initialDate, withDate, saveLabel, busy, onSave, onCancel }: {
  initialBody: string
  initialDate: string
  withDate: boolean
  saveLabel: string
  busy: boolean
  onSave: (body: string, reviewAfter: string) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const [body, setBody] = useState(initialBody)
  const [date, setDate] = useState(initialDate)
  const length = codePoints(body)
  const valid = length > 0 && length <= BODY_LIMIT && (!withDate || Boolean(date))
  return (
    <form className="memory-editor" onSubmit={event => { event.preventDefault(); if (valid && !busy) onSave(body.trim(), date) }}>
      <textarea
        className="memory-textarea"
        value={body}
        rows={2}
        autoFocus
        aria-label={t('memory.add_placeholder')}
        placeholder={t('memory.add_placeholder')}
        disabled={busy}
        onChange={event => setBody(event.target.value)}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } }}
      />
      <div className="memory-editor-foot">
        <span className="memory-counter" data-over={length > BODY_LIMIT || undefined}>{length}/{BODY_LIMIT}</span>
        {withDate ? (
          <label className="memory-date">
            <span>{t('memory.review_after')}</span>
            <input className="settings-input" type="date" value={date} disabled={busy} onChange={event => setDate(event.target.value)} />
          </label>
        ) : null}
        <span className="memory-spacer" />
        <button type="button" className="crt-button" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
        <button type="submit" className="crt-button" data-variant="primary" disabled={!valid || busy}>{saveLabel}</button>
      </div>
    </form>
  )
}

export default function MemorySettings({ send, subscribe }: { send: SendFn; subscribe: SubscribeFn }) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [items, setItems] = useState<MemoryItem[]>([])
  const [invalid, setInvalid] = useState<InvalidFile[]>([])
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [recall, setRecall] = useState('log')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState<{ type: MemoryType } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const readyRef = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const [listed, status] = await Promise.all([
        send('memory.list', {}),
        send('memory.status', {}).catch(() => ({ ok: false }) as Payload),
      ])
      if (listed.ok === false) throw new Error(errorText(listed) || 'memory.list rejected')
      setItems((Array.isArray(listed.items) ? listed.items : []).flatMap(raw => normalizeItem(raw) ?? []))
      setInvalid((Array.isArray(listed.invalid) ? listed.invalid : []).map(raw => ({ file: String(asObject(raw).file ?? ''), error: String(asObject(raw).error ?? '') })))
      setStats(normalizeStats(listed.stats))
      if (status.ok !== false) {
        if (typeof status.enabled === 'boolean') setEnabled(status.enabled)
        if (typeof status.recall === 'string') setRecall(status.recall)
      }
      readyRef.current = true
      setPhase('ready')
      setError('')
    } catch (reason) {
      // 已经加载过的数据保留着，只提示这一次刷新失败；从没加载成功才整体标为不可用。
      if (readyRef.current) setError(t('memory.save_error', undefined, { error: reason instanceof Error ? reason.message : String(reason) }))
      else setPhase('unavailable')
    }
  }, [send, t])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = subscribe('memory.changed', () => {
      clearTimeout(timer)
      timer = setTimeout(() => { void refresh() }, 250)
    })
    return () => { clearTimeout(timer); unsubscribe() }
  }, [subscribe, refresh])

  const run = useCallback(async (key: string, method: string, params: Payload): Promise<Payload | null> => {
    setBusy(key)
    setError('')
    try {
      const result = await send(method, params)
      if (result.ok === false) {
        setError(t('memory.save_error', undefined, { error: errorText(result) || method }))
        return null
      }
      return result
    } catch (reason) {
      setError(t('memory.save_error', undefined, { error: reason instanceof Error ? reason.message : String(reason) }))
      return null
    } finally {
      setBusy(null)
    }
  }, [send, t])

  const mutate = useCallback(async (key: string, method: string, params: Payload) => {
    const result = await run(key, method, params)
    if (result) {
      setEditing(null)
      await refresh()
    }
    return result
  }, [run, refresh])

  const configure = async (patch: { enabled?: boolean; recall?: string }) => {
    const previous = { enabled, recall }
    if (patch.enabled !== undefined) setEnabled(patch.enabled)
    if (patch.recall !== undefined) setRecall(patch.recall)
    const result = await run('config', 'memory.configure', patch)
    if (!result) {
      setEnabled(previous.enabled)
      setRecall(previous.recall)
    }
  }

  const groups = useMemo(() => {
    const byUpdated = (a: MemoryItem, b: MemoryItem) => b.updatedAt.localeCompare(a.updatedAt)
    const reviewed = items.filter(item => item.status === 'reviewed').sort(byUpdated)
    const due = reviewed.filter(item => item.type === 'ongoing' && item.expired)
    return {
      due,
      core: MEMORY_TYPES.map(type => ({ type, items: reviewed.filter(item => item.type === type && !due.includes(item)) })).filter(group => group.items.length > 0),
      coreCount: reviewed.length,
      pending: items.filter(item => item.status === 'unreviewed').sort(byUpdated),
      archived: items.filter(item => item.status === 'archived').sort(byUpdated),
    }
  }, [items])

  const sourceLabel = (source: string) => source === 'manual' || source === 'explicit' || source === 'extracted'
    ? t(`memory.source.${source}` as MessageKey)
    : ''

  const renderItem = (item: MemoryItem) => {
    const isEditing = editing === item.id
    return (
      <div className="memory-item" key={item.id} data-testid="memory-item" data-memory-id={item.id} data-injected={item.injected}>
        {isEditing ? (
          <MemoryEditor
            initialBody={item.body}
            initialDate={item.reviewAfter || dateAfter(REVIEW_EXTENSION_DAYS)}
            withDate={item.type === 'ongoing'}
            saveLabel={t('common.save')}
            busy={busy === item.id}
            onCancel={() => setEditing(null)}
            onSave={(body, reviewAfter) => { void mutate(item.id, 'memory.write', { id: item.id, body, ...(item.type === 'ongoing' ? { reviewAfter } : {}) }) }}
          />
        ) : (
          <div className="memory-body">{item.body}</div>
        )}
        <div className="memory-meta">
          {!item.injected && !item.expired ? <span className="memory-badge" data-kind="muted">{t('memory.badge.not_injected')}</span> : null}
          {item.type === 'ongoing' && item.reviewAfter
            ? <span className="memory-badge" data-kind={item.expired ? 'warn' : 'muted'}>{item.expired ? t('memory.badge.due') : t('memory.review_by', undefined, { date: item.reviewAfter })}</span>
            : null}
          {sourceLabel(item.source) ? <span className="memory-source">{sourceLabel(item.source)}</span> : null}
          <span className="memory-spacer" />
          {isEditing ? null : (
            <>
              <button type="button" className="crt-button" data-testid="memory-edit" disabled={busy === item.id} onClick={() => setEditing(item.id)}>{t('common.edit')}</button>
              <button type="button" className="crt-button" data-variant="danger" data-testid="memory-delete" disabled={busy === item.id} onClick={() => { void mutate(item.id, 'memory.delete', { id: item.id }) }}>{t('common.delete')}</button>
            </>
          )}
        </div>
      </div>
    )
  }

  const renderDue = (item: MemoryItem) => (
    <div className="memory-item" key={item.id} data-testid="memory-due" data-memory-id={item.id}>
      <div className="memory-body">{item.body}</div>
      <div className="memory-meta">
        <span className="memory-badge" data-kind="warn">{t('memory.badge.due')}</span>
        <span className="memory-source">{t('memory.review_by', undefined, { date: item.reviewAfter })}</span>
      </div>
      <p className="memory-hint">{t('memory.due_hint')}</p>
      <div className="memory-meta">
        <button type="button" className="crt-button" data-variant="primary" data-testid="memory-still-true" disabled={busy === item.id} onClick={() => { void mutate(item.id, 'memory.write', { id: item.id, reviewAfter: dateAfter(REVIEW_EXTENSION_DAYS) }) }}>{t('memory.still_true')}</button>
        <button type="button" className="crt-button" data-testid="memory-ended" disabled={busy === item.id} onClick={() => { void mutate(item.id, 'memory.delete', { id: item.id }) }}>{t('memory.ended')}</button>
      </div>
    </div>
  )

  const renderPending = (item: MemoryItem) => {
    const isEditing = editing === item.id
    return (
      <div className="memory-item" key={item.id} data-testid="memory-pending" data-memory-id={item.id}>
        {item.proposal ? (
          <div className="memory-proposal" data-kind={item.proposal.kind}>
            <span>{t(item.proposal.kind === 'replace' ? 'memory.proposal.replace' : 'memory.proposal.remove')}</span>
            <span className="memory-proposal-target">{item.proposal.targetBody}</span>
          </div>
        ) : null}
        {isEditing ? (
          <MemoryEditor
            initialBody={item.body}
            initialDate={item.reviewAfter || dateAfter(REVIEW_EXTENSION_DAYS)}
            withDate={item.type === 'ongoing'}
            saveLabel={t('memory.accept')}
            busy={busy === item.id}
            onCancel={() => setEditing(null)}
            onSave={(body, reviewAfter) => { void mutate(item.id, 'memory.accept', { id: item.id, edit: { body, ...(item.type === 'ongoing' ? { reviewAfter } : {}) } }) }}
          />
        ) : item.proposal?.kind === 'remove' && !item.body ? null : (
          <div className="memory-body">{item.body}</div>
        )}
        {item.sourceQuote ? <div className="memory-quote">{t('memory.quote', undefined, { quote: item.sourceQuote })}</div> : null}
        <div className="memory-meta">
          <span className="memory-badge" data-kind={item.confidence === 'high' ? 'ok' : 'muted'}>
            {t('memory.confidence', undefined, { level: t(`memory.confidence.${item.confidence}` as MessageKey, item.confidence) })}
          </span>
          <span className="memory-source">{t(`memory.type.${item.type}` as MessageKey)}</span>
          <span className="memory-spacer" />
          {isEditing ? null : (
            <>
              {item.proposal?.kind === 'remove' ? null : (
                <button type="button" className="crt-button" data-testid="memory-pending-edit" disabled={busy === item.id} onClick={() => setEditing(item.id)}>{t('common.edit')}</button>
              )}
              <button type="button" className="crt-button" data-testid="memory-reject" disabled={busy === item.id} onClick={() => { void mutate(item.id, 'memory.reject', { id: item.id }) }}>{t('memory.reject')}</button>
              <button type="button" className="crt-button" data-variant="primary" data-testid="memory-accept" disabled={busy === item.id} onClick={() => { void mutate(item.id, 'memory.accept', { id: item.id }) }}>{t('memory.accept')}</button>
            </>
          )}
        </div>
      </div>
    )
  }

  if (phase !== 'ready') {
    return (
      <Card title={t('memory.title')}>
        <p className="settings-card-note" data-testid="memory-unavailable">
          {phase === 'loading' ? t('memory.loading') : t('memory.unavailable')}
        </p>
        {phase === 'unavailable' ? (
          <div className="memory-toolbar">
            <button type="button" className="crt-button" onClick={() => { setPhase('loading'); void refresh() }}>{t('common.refresh')}</button>
          </div>
        ) : null}
      </Card>
    )
  }

  const usedPercent = stats && stats.snapshotLimit > 0 ? Math.min(100, Math.round((stats.snapshotBytes / stats.snapshotLimit) * 100)) : 0
  const kb = (bytes: number) => (bytes / 1024).toFixed(1)

  return (
    <>
      <Card title={t('memory.title')}>
        <Row label={t('memory.enabled')}>
          <Switch checked={enabled} label={t('memory.enabled')} disabled={busy === 'config'} onChange={next => { void configure({ enabled: next }) }} />
        </Row>
        <Row label={t('memory.recall')}>
          <ComboSelect
            label={t('memory.recall')}
            value={recall}
            disabled={busy === 'config'}
            options={RECALL_MODES.map(mode => ({ value: mode, label: t(`memory.recall.${mode}` as MessageKey) }))}
            onChange={value => { void configure({ recall: value }) }}
          />
        </Row>
        {stats ? (
          <Row label={t('memory.snapshot')}>
            <div className="memory-meter-wrap">
              <div className="memory-meter" role="meter" aria-valuemin={0} aria-valuemax={stats.snapshotLimit} aria-valuenow={stats.snapshotBytes} data-full={usedPercent >= 100 || undefined}>
                <i style={{ width: `${usedPercent}%` }} />
              </div>
              <span className="memory-source">{kb(stats.snapshotBytes)} / {kb(stats.snapshotLimit)} KB</span>
            </div>
          </Row>
        ) : null}
        {stats?.truncated ? <p className="settings-card-note">{t('memory.snapshot_truncated')}</p> : null}
        <div className="memory-toolbar">
          <button type="button" className="crt-button" data-testid="memory-open-folder" onClick={() => { void run('folder', 'memory.open-folder', {}) }}>{t('memory.open_folder')}</button>
          <button type="button" className="crt-button" data-variant="danger" data-testid="memory-clear" disabled={groups.coreCount + groups.pending.length === 0} onClick={() => setConfirmClear(true)}>{t('memory.clear')}</button>
        </div>
      </Card>

      {groups.due.length > 0 ? (
        <Card title={t('memory.badge.due')}>
          {groups.due.map(renderDue)}
        </Card>
      ) : null}

      <Card title={t('memory.core')}>
        {groups.core.length === 0 && groups.due.length === 0 ? <p className="settings-card-note">{t('memory.core_empty')}</p> : null}
        {groups.core.map(group => (
          <section className="memory-group" key={group.type} data-memory-type={group.type}>
            <h4 className="memory-group-title">{t(`memory.type.${group.type}` as MessageKey)}</h4>
            {group.items.map(renderItem)}
          </section>
        ))}
        {adding ? (
          <div className="memory-item" data-testid="memory-add-form">
            <select className="settings-select" aria-label={t('memory.add')} value={adding.type} onChange={event => setAdding({ type: event.target.value as MemoryType })}>
              {MEMORY_TYPES.map(type => <option key={type} value={type}>{t(`memory.type.${type}` as MessageKey)}</option>)}
            </select>
            <MemoryEditor
              initialBody=""
              initialDate={dateAfter(REVIEW_EXTENSION_DAYS)}
              withDate={adding.type === 'ongoing'}
              saveLabel={t('memory.add')}
              busy={busy === 'add'}
              onCancel={() => setAdding(null)}
              onSave={(body, reviewAfter) => {
                void run('add', 'memory.write', { type: adding.type, body, ...(adding.type === 'ongoing' ? { reviewAfter } : {}) }).then(async result => {
                  if (!result) return
                  setAdding(null)
                  await refresh()
                })
              }}
            />
          </div>
        ) : (
          <div className="memory-toolbar">
            <button type="button" className="crt-button" data-testid="memory-add" onClick={() => setAdding({ type: 'preference' })}>{t('memory.add')}</button>
          </div>
        )}
      </Card>

      <Card title={t('memory.pending')}>
        {groups.pending.length === 0 ? <p className="settings-card-note">{t('memory.pending_empty')}</p> : groups.pending.map(renderPending)}
      </Card>

      {groups.archived.length > 0 ? (
        <details className="settings-advanced settings-card">
          <summary>{t('memory.archived', undefined, { count: groups.archived.length })}</summary>
          {groups.archived.map(item => (
            <div className="memory-item" key={item.id} data-memory-id={item.id}>
              <div className="memory-body">{item.body}</div>
              <div className="memory-meta">
                <span className="memory-spacer" />
                <button type="button" className="crt-button" data-variant="danger" disabled={busy === item.id} onClick={() => { void mutate(item.id, 'memory.delete', { id: item.id }) }}>{t('common.delete')}</button>
              </div>
            </div>
          ))}
        </details>
      ) : null}

      {invalid.length > 0 ? (
        <details className="settings-advanced settings-card" data-testid="memory-invalid">
          <summary>{t('memory.invalid', undefined, { count: invalid.length })}</summary>
          {invalid.map(file => (
            <div className="memory-item" key={file.file}>
              <div className="memory-body memory-file">{file.file}</div>
              <div className="memory-quote">{file.error}</div>
            </div>
          ))}
        </details>
      ) : null}

      {error ? <div className="settings-feedback" data-tone="error" role="alert">{error}</div> : null}

      {confirmClear ? (
        <ConfirmDialog
          title={t('memory.clear_title')}
          body={t('memory.clear_body')}
          confirmLabel={t('memory.clear')}
          cancelLabel={t('common.cancel')}
          busy={busy === 'clear'}
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            void run('clear', 'memory.clear', {}).then(async result => {
              setConfirmClear(false)
              if (result) await refresh()
            })
          }}
        />
      ) : null}
    </>
  )
}
