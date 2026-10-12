import { useState } from 'react'
import { useI18n } from '../../i18n'
import { Card, IconAction } from './parts'

export type RemoteTarget = { name: string; ssh: string; workspace: string; node: string }

type Check = { state: 'checking' } | { state: 'ok'; text: string } | { state: 'failed'; text: string }
/** 同一时刻只展开一个编辑器：`index` 为 undefined 表示正在添加。 */
type Editing = { index?: number; draft: RemoteTarget }

const EMPTY: RemoteTarget = { name: '', ssh: '', workspace: '', node: '' }
const PLACEHOLDERS: Record<keyof RemoteTarget, string> = { name: 'mini', ssh: 'ssh -p 22 me@example.com', workspace: '~', node: 'node' }
/** 保存会重载 worker，主进程在重载期间把 remote.check 挡回来；等它就绪再测。 */
const TEST_AFTER_SAVE_MS = 1500

export function normalizeTargets(value: unknown): RemoteTarget[] {
  if (!Array.isArray(value)) return []
  return value.map(entry => {
    const item = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
    const text = (key: string) => (typeof item[key] === 'string' ? item[key] as string : '')
    return { name: text('name'), ssh: text('ssh'), workspace: text('workspace'), node: text('node') }
  })
}

const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([each]) => each !== key))

/**
 * 已保存的机器折叠成一行摘要；添加或编辑时只展开一个表单，保存后立即测试连接。
 * 主进程按整份列表校验（有错整体拒绝），所以每次保存都提交整份列表；测试连接只认已保存的目标。
 */
export function RemoteTargetsCard({ targets, onSave, send, reloading }: {
  targets: readonly RemoteTarget[]
  /** 返回主进程规整后的列表（去空白、补缺省值）。 */
  onSave: (targets: RemoteTarget[]) => Promise<RemoteTarget[]>
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  reloading: boolean
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState<Editing>()
  const [busy, setBusy] = useState(false)
  const [checks, setChecks] = useState<Record<string, Check>>({})

  const test = async (name: string) => {
    setChecks(current => ({ ...current, [name]: { state: 'checking' } }))
    let check: Check
    try {
      const result = await send('remote.check', { target: name })
      check = result.ok
        ? { state: 'ok', text: t('settings.remote.ok', undefined, { path: String(result.path ?? ''), os: String(result.os ?? '?'), arch: String(result.arch ?? '?'), node: String(result.node ?? '?') }) }
        : { state: 'failed', text: t('settings.remote.failed', undefined, { error: String(result.error ?? '') }) }
    } catch (reason) {
      check = { state: 'failed', text: t('settings.remote.failed', undefined, { error: reason instanceof Error ? reason.message : String(reason) }) }
    }
    setChecks(current => ({ ...current, [name]: check }))
  }

  const commit = async (next: RemoteTarget[]): Promise<RemoteTarget[] | undefined> => {
    setBusy(true)
    try {
      return await onSave(next)
    } catch {
      // 错误由设置页统一展示；表单留着让主人改。
      return undefined
    } finally {
      setBusy(false)
    }
  }

  const saveEditing = async () => {
    if (!editing) return
    const next = editing.index === undefined
      ? [...targets, editing.draft]
      : targets.map((target, at) => (at === editing.index ? editing.draft : target))
    const saved = await commit(next)
    if (!saved) return
    const name = editing.draft.name.trim()
    const previous = editing.index === undefined ? undefined : targets[editing.index]?.name
    setEditing(undefined)
    setChecks(current => without(previous ? without(current, previous) : current, name))
    if (saved.some(each => each.name === name)) setTimeout(() => void test(name), TEST_AFTER_SAVE_MS)
  }

  const remove = async (index: number) => {
    const removed = targets[index]
    if (!(await commit(targets.filter((_, at) => at !== index)))) return
    setChecks(current => without(current, removed.name))
  }

  const field = (key: keyof RemoteTarget) => (
    <label className="settings-remote-field">
      <span>{t(`settings.remote.${key}`)}</span>
      <input
        className="settings-input"
        aria-label={t(`settings.remote.${key}`)}
        value={editing?.draft[key] ?? ''}
        placeholder={PLACEHOLDERS[key]}
        spellCheck={false}
        autoCapitalize="off"
        disabled={busy}
        onChange={event => {
          const value = event.target.value
          setEditing(current => current && { ...current, draft: { ...current.draft, [key]: value } })
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') void saveEditing()
          if (event.key === 'Escape') setEditing(undefined)
        }}
      />
    </label>
  )

  const editor = editing ? (
    <div className="settings-remote-editor" data-testid="remote-editor">
      <div className="settings-remote-editor-title">{editing.index === undefined ? t('settings.remote.new') : targets[editing.index]?.name}</div>
      <div className="settings-remote-fields" data-columns="1">
        {field('name')}
        {field('ssh')}
      </div>
      <details className="settings-advanced" open={editing.index !== undefined && Boolean(editing.draft.workspace !== '~' || editing.draft.node !== 'node')}>
        <summary>{t('settings.remote.advanced')}</summary>
        <div className="settings-remote-fields">
          {field('workspace')}
          {field('node')}
        </div>
      </details>
      <div className="settings-remote-actions" data-align="end">
        <button type="button" className="crt-button" disabled={busy} onClick={() => setEditing(undefined)}>{t('settings.remote.cancel')}</button>
        <button
          type="button"
          className="crt-button"
          data-variant="primary"
          disabled={busy || !editing.draft.name.trim() || !editing.draft.ssh.trim()}
          onClick={() => void saveEditing()}
        >
          {t('settings.remote.save_test')}
        </button>
      </div>
    </div>
  ) : null

  return (
    <Card title={t('settings.remote.title')}>
      {targets.map((target, index) => {
        if (editing?.index === index) return <div key={`edit-${index}`}>{editor}</div>
        const check = checks[target.name]
        const tone = check?.state === 'ok' || check?.state === 'failed' ? check.state : check?.state === 'checking' ? 'checking' : 'unknown'
        return (
          <div key={target.name} className="settings-remote-target" data-testid="remote-target">
            <div className="settings-remote-summary">
              <span className="settings-remote-dot" data-tone={tone} aria-hidden="true" />
              <span className="settings-remote-name">{target.name}</span>
              <span className="settings-remote-where" title={`${target.ssh} · ${target.workspace}`}>{target.ssh} · {target.workspace}</span>
              <span className="settings-remote-buttons">
                <button type="button" className="crt-button" disabled={busy || reloading || check?.state === 'checking'} onClick={() => void test(target.name)}>
                  {check?.state === 'checking' ? t('settings.remote.testing') : t('settings.remote.test')}
                </button>
                <button type="button" className="crt-button" disabled={busy || Boolean(editing)} onClick={() => setEditing({ index, draft: { ...target } })}>
                  {t('settings.remote.edit')}
                </button>
                <IconAction label={t('settings.remote.remove', undefined, { name: target.name })} glyph="×" danger disabled={busy || Boolean(editing)} onClick={() => void remove(index)} />
              </span>
            </div>
            {check && check.state !== 'checking' ? <p className="settings-card-note" data-tone={check.state} role="status">{check.text}</p> : null}
          </div>
        )
      })}
      {editing && editing.index === undefined ? editor : null}
      {editing ? null : (
        <div className="settings-remote-footer">
          <button type="button" className="crt-button" disabled={busy} onClick={() => setEditing({ draft: { ...EMPTY } })}>+ {t('settings.remote.add')}</button>
        </div>
      )}
    </Card>
  )
}
