import { useEffect, useRef } from 'react'

/**
 * 面板内的确认对话框。盖住最近的定位祖先（侧边栏面板），不另起 portal，
 * 这样才继承面板自己的深色主题变量，也不会被面板的裁剪藏到外面去。
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string
  body: string
  confirmLabel: string
  cancelLabel: string
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  // 破坏性操作默认把焦点放在"取消"上，回车不会误删。
  useEffect(() => { cancelRef.current?.focus() }, [])
  return (
    <div
      className="confirm-scrim"
      data-testid="confirm-dialog"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onCancel() }}
      onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onCancel() } }}
    >
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-body">
        <div className="confirm-dialog-title" id="confirm-dialog-title">{title}</div>
        <div className="confirm-dialog-body" id="confirm-dialog-body">{body}</div>
        <div className="confirm-dialog-actions">
          <button ref={cancelRef} type="button" className="crt-button" data-testid="confirm-cancel" disabled={busy} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" className="crt-button" data-variant="danger" data-testid="confirm-accept" disabled={busy} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
