/**
 * 会话切换器：当前会话 + 可展开的会话列表，带重命名、删除、旧会话分组与徽标。
 * 原生 <select> 放不下行内操作和徽标，所以换成面板内的列表。
 */

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Pencil, Trash2, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import ConfirmDialog from '../ui/ConfirmDialog'
import type { SceneSession } from './useSceneSession'

export default function SessionPicker({
  sessions,
  currentId,
  onSelect,
  onOpen,
  onRename,
  onDelete,
}: {
  sessions: SceneSession[]
  currentId: string
  onSelect: (id: string) => void
  /** 展开时让上层顺手刷新列表，徽标才是新的。 */
  onOpen: () => void
  onRename: (id: string, title: string) => Promise<boolean>
  onDelete: (id: string) => Promise<boolean>
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [deleting, setDeleting] = useState<SceneSession | null>(null)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const current = sessions.find(item => item.id === currentId)
  const others = sessions.filter(item => item.id !== currentId)
  const elsewhere = others.reduce((sum, item) => sum + item.pendingReports + item.pendingApprovals, 0)
  const elsewhereApprovals = others.reduce((sum, item) => sum + item.pendingApprovals, 0)
  const titleOf = (session: SceneSession) => session.title || t('scene.session_untitled')

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape' && !deleting) setOpen(false)
        return
      }
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open, deleting])

  const toggle = () => {
    if (!open) onOpen()
    setOpen(value => !value)
    setRenaming(null)
  }

  const commitRename = async () => {
    if (!renaming) return
    const title = renaming.title.trim()
    const original = sessions.find(item => item.id === renaming.id)?.title
    if (!title || title === original) { setRenaming(null); return }
    setBusy(true)
    const ok = await onRename(renaming.id, title)
    setBusy(false)
    if (ok) setRenaming(null)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setBusy(true)
    await onDelete(deleting.id)
    setBusy(false)
    setDeleting(null)
  }

  const renderGroup = (label: string, items: SceneSession[], testId: string) => items.length === 0 ? null : (
    <li role="presentation" key={testId}>
      <div className="session-group-label">{label}</div>
      <ul role="group" aria-label={label} className="session-group" data-testid={testId}>
        {items.map(item => {
          const edit = renaming?.id === item.id ? renaming : null
          const active = item.id === currentId
          return (
            <li key={item.id} role="option" aria-selected={active} className="session-row" data-active={active} data-session-id={item.id}>
              {edit ? (
                <form className="session-rename" onSubmit={event => { event.preventDefault(); void commitRename() }}>
                  <input
                    autoFocus
                    value={edit.title}
                    maxLength={80}
                    aria-label={t('scene.session_rename')}
                    data-testid="session-rename-input"
                    disabled={busy}
                    onChange={event => setRenaming({ id: item.id, title: event.target.value })}
                    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null) } }}
                  />
                  <button type="submit" className="session-icon" title={t('scene.session_rename_save')} aria-label={t('scene.session_rename_save')} disabled={busy || !edit.title.trim()}><Check /></button>
                  <button type="button" className="session-icon" title={t('common.cancel')} aria-label={t('common.cancel')} disabled={busy} onClick={() => setRenaming(null)}><X /></button>
                </form>
              ) : (
                <>
                  <button type="button" className="session-pick" onClick={() => { setOpen(false); if (!active) onSelect(item.id) }}>
                    <span className="session-title">{titleOf(item)}</span>
                    {!active && item.pendingReports > 0 ? (
                      <span className="session-badge" data-kind="report" title={t('scene.session_reports', undefined, { count: item.pendingReports })} aria-label={t('scene.session_reports', undefined, { count: item.pendingReports })}>{item.pendingReports}</span>
                    ) : null}
                    {!active && item.pendingApprovals > 0 ? (
                      <span className="session-badge" data-kind="approval" title={t('scene.session_approvals', undefined, { count: item.pendingApprovals })} aria-label={t('scene.session_approvals', undefined, { count: item.pendingApprovals })}>{item.pendingApprovals}</span>
                    ) : null}
                  </button>
                  <span className="session-actions">
                    <button type="button" className="session-icon" title={t('scene.session_rename')} aria-label={`${t('scene.session_rename')} ${titleOf(item)}`} data-testid="session-rename" onClick={() => setRenaming({ id: item.id, title: item.title })}><Pencil /></button>
                    <button type="button" className="session-icon" data-danger="true" title={t('scene.session_delete')} aria-label={`${t('scene.session_delete')} ${titleOf(item)}`} data-testid="session-delete" onClick={() => setDeleting(item)}><Trash2 /></button>
                  </span>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </li>
  )

  return (
    <>
      <div className="session-picker" ref={rootRef}>
        <button
          type="button"
          className="scene-transcript-session session-trigger"
          data-testid="scene-session-select"
          aria-label={t('scene.current_task')}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
        >
          <span className="session-title">{current ? titleOf(current) : currentId || t('scene.current_task')}</span>
          {elsewhere > 0 ? <span className="session-dot" data-attention={elsewhereApprovals > 0 || undefined} aria-label={String(elsewhere)} /> : null}
          <ChevronDown className="session-chevron" aria-hidden="true" />
        </button>
        {open ? (
          <ul className="session-list" role="listbox" aria-label={t('scene.sessions')} data-testid="session-list">
            {renderGroup(t('scene.session_group_current'), sessions, 'session-group-current')}
          </ul>
        ) : null}
      </div>
      {deleting ? (
        <ConfirmDialog
          title={t('scene.session_delete_title')}
          body={t('scene.session_delete_body', undefined, { title: titleOf(deleting) })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          busy={busy}
          onConfirm={() => { void confirmDelete() }}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </>
  )
}
