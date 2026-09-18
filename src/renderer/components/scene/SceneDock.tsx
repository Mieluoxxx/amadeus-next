import { useRef } from 'react'
import { ChevronDown, ImagePlus, Mic, MicOff, Send, X } from 'lucide-react'
import { useI18n } from '../../i18n'
import { CHAT_PROVIDER_OPTIONS } from '../../lib/chatProviders'
import type { VisualAttachment } from './visualAttachment'

/** The floating scene composer. Draft ownership stays in the session so
 * opening and closing panels cannot lose an edit. */
export default function SceneDock({
  connected, draft, onDraftChange, onSubmit, onToggleMic, asrListening, streaming,
  sessionTitle, provider, onProviderChange,
  translationEnabled,
  attachment, onClearAttachment, onPickAttachment, canAttach,
}: {
  connected: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSubmit: () => void
  onToggleMic: () => void
  asrListening: boolean
  streaming: boolean
  sessionTitle: string
  provider: string
  onProviderChange: (value: string) => void
  translationEnabled: boolean
  attachment: VisualAttachment | null
  onClearAttachment: () => void
  onPickAttachment: (file: File) => void
  canAttach: boolean
}) {
  const { t } = useI18n()
  const imageInputRef = useRef<HTMLInputElement>(null)
  const canSend = connected && Boolean(draft.trim() || attachment)
  const micLabel = asrListening ? t('scene.mic_stop') : t('scene.mic_start')
  const attachmentLabel = canAttach ? t('scene.attach_image') : t('scene.attach_needs_visual_provider')

  return (
    <div className="scene-conversation" data-state={!connected ? 'offline' : asrListening ? 'listening' : streaming ? 'streaming' : 'ready'}>
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
          placeholder={connected ? t('scene.placeholder') : t('scene.placeholder_offline')}
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
            disabled={!connected || !canAttach}
            data-testid="scene-attach-image"
            aria-label={attachmentLabel}
            title={attachmentLabel}
            className="scene-composer-icon"
          >
            <ImagePlus />
          </button>
          <div className="scene-provider-control">
            <select
              value={provider}
              onChange={event => { void onProviderChange(event.target.value) }}
              disabled={!connected}
              aria-label={t('chat.provider')}
              data-testid="scene-provider"
            >
              {CHAT_PROVIDER_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <ChevronDown aria-hidden="true" />
          </div>
          {translationEnabled && <span className="scene-translation-indicator" title={t('settings.label.chat_translation')} aria-label={t('settings.label.chat_translation')}>译</span>}
          {sessionTitle && <span className="scene-session-title" title={sessionTitle}>{sessionTitle}</span>}
          <span className="scene-composer-spacer" />
          <span className="scene-listening-label" role="status">{asrListening ? t('scene.listening') : ''}</span>
          <button
            type="button"
            onClick={onToggleMic}
            disabled={!connected}
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
