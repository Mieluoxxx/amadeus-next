import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { ImagePlus, Mic, MicOff, Send, Square, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import type { VisualAttachment } from './visualAttachment'

/** The floating scene composer. Draft ownership stays in the session so
 * opening and closing panels cannot lose an edit. */
export default function SceneDock({
  connected, draft, onDraftChange, onSubmit, onToggleMic, asrListening, streaming,
  replying, stopping, onStop, readonly,
  sessionTitle, model, models, onSelectModel,
  attachment, onClearAttachment, onPickAttachment, canAttach,
}: {
  connected: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onToggleMic: () => void
  asrListening: boolean
  streaming: boolean
  /** A turn is in flight (from send or report start until it completes); drives the stop button. */
  replying: boolean
  stopping: boolean
  onStop: () => void
  /** An earlier (legacy) conversation: the composer is disabled. */
  readonly: boolean
  sessionTitle: string
  /** `provider/id` of the model in use; empty until it is known. */
  model: string
  models: { value: string; label: string }[]
  onSelectModel: (value: string) => void
  attachment: VisualAttachment | null
  onClearAttachment: () => void
  onPickAttachment: (file: File) => void
  canAttach: boolean
}) {
  const { t } = useI18n()
  const imageInputRef = useRef<HTMLInputElement>(null)
  // The dock frame clips its overflow, so the menu is portalled to the body and positioned from the button.
  const [menu, setMenu] = useState<{ left: number; bottom: number; room: number } | null>(null)
  const modelButtonRef = useRef<HTMLButtonElement>(null)
  const modelMenuRef = useRef<HTMLUListElement>(null)
  const openMenu = () => {
    const box = modelButtonRef.current?.getBoundingClientRect()
    if (!box) return
    setMenu({ left: Math.max(8, box.left), bottom: window.innerHeight - box.top + 6, room: box.top - 12 })
  }
  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent | KeyboardEvent | Event) => {
      if (event instanceof KeyboardEvent) { if (event.key === 'Escape') setMenu(null); return }
      const target = event.target as Node | null
      if (event.type === 'mousedown' && (modelButtonRef.current?.contains(target) || modelMenuRef.current?.contains(target))) return
      setMenu(null)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    window.addEventListener('resize', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); window.removeEventListener('resize', close) }
  }, [menu])
  // A reply in flight owns the model; the runtime refuses a switch until it ends.
  const canSwitchModel = connected && !streaming && !replying && models.length > 1
  const canSend = connected && !readonly && Boolean(draft.trim() || attachment)
  const micLabel = asrListening ? t('scene.mic_stop') : t('scene.mic_start')
  const placeholder = readonly
    ? t('scene.readonly_placeholder')
    : connected ? t('scene.placeholder') : t('scene.placeholder_offline')
  const attachmentLabel = canAttach ? t('scene.attach_image') : t('scene.attach_needs_visual_provider')

  return (
    <div className="scene-conversation" data-state={!connected ? 'offline' : readonly ? 'readonly' : asrListening ? 'listening' : streaming ? 'streaming' : 'ready'}>
      <form className="scene-composer" onSubmit={event => {
        event.preventDefault()
        if (canSend) onSubmit()
      }}>
        {attachment && (
          <div className="scene-composer-context">
            <div className="scene-context-chip" data-testid="scene-attachment-chip">
              <img src={attachment.dataUrl} alt="" />
              <span title={attachment.name}>{attachment.name}</span>
              <button type="button" onClick={onClearAttachment} aria-label={t('chat.remove_image')} title={t('chat.remove_image')}><X /></button>
            </div>
          </div>
        )}
        <textarea
          rows={2}
          value={draft}
          onChange={event => onDraftChange(event.target.value)}
          onKeyDown={event => {
            // Keep native multiline editing and IME confirmation. Every actual
            // submission uses the form's connected/empty guard, including Enter.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault()
              if (!event.repeat) event.currentTarget.form?.requestSubmit()
            }
          }}
          aria-label={t('scene.placeholder')}
          placeholder={placeholder}
          disabled={readonly}
          className="scene-composer-input"
          data-testid="scene-input"
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          hidden
          data-testid="scene-attachment-input"
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) onPickAttachment(file)
          }}
        />
        <div className="scene-composer-toolbar">
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            disabled={!connected || readonly || !canAttach}
            data-testid="scene-attach-image"
            aria-label={attachmentLabel}
            title={attachmentLabel}
            className="scene-composer-icon"
          >
            <ImagePlus />
          </button>
          {model && (
            <div className="scene-provider-control">
              <button
                ref={modelButtonRef}
                type="button"
                data-testid="scene-provider"
                title={model}
                aria-haspopup="listbox"
                aria-expanded={menu !== null}
                disabled={!canSwitchModel}
                onClick={() => (menu ? setMenu(null) : openMenu())}
              >
                <i className="scene-provider-name">{model.slice(model.indexOf('/') + 1)}</i>
              </button>
              {menu && createPortal(
                <ul
                  ref={modelMenuRef}
                  className="scene-model-menu"
                  role="listbox"
                  data-testid="scene-model-menu"
                  style={{ left: menu.left, bottom: menu.bottom, '--menu-room': `${menu.room}px` } as CSSProperties}
                >
                  {models.map(item => (
                    <li key={item.value} role="option" aria-selected={item.value === model}>
                      <button type="button" data-model={item.value} onClick={() => { setMenu(null); if (item.value !== model) onSelectModel(item.value) }}>{item.label}</button>
                    </li>
                  ))}
                </ul>,
                document.body,
              )}
            </div>
          )}
          {readonly && <span className="scene-readonly-chip" data-testid="scene-readonly">{t('scene.readonly_badge')}</span>}
          {sessionTitle && <span className="scene-session-title" title={sessionTitle}>{sessionTitle}</span>}
          <span className="scene-composer-spacer" />
          <span className="scene-listening-label" role="status">{asrListening ? t('scene.listening') : ''}</span>
          {replying && (
            <button
              type="button"
              onClick={onStop}
              disabled={stopping}
              data-testid="scene-stop"
              aria-label={t('scene.stop')}
              title={t('scene.stop')}
              className="scene-composer-icon scene-composer-stop"
            >
              <Square />
            </button>
          )}
          <button
            type="button"
            onClick={onToggleMic}
            disabled={!connected || readonly}
            aria-pressed={asrListening}
            aria-label={micLabel}
            title={micLabel}
            className="scene-composer-icon scene-composer-mic"
          >
            {asrListening ? <MicOff /> : <Mic />}
          </button>
          <button type="submit" disabled={!canSend} data-testid="scene-send" title={t('scene.send')} className="scene-composer-send">
            <span>{t('scene.send')}</span><Send />
          </button>
        </div>
      </form>
    </div>
  )
}
