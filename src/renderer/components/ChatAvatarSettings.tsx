import { useEffect, useState } from 'react'
import { useI18n, type MessageKey } from '../i18n'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type ChatAvatarRole = 'user' | 'assistant'
type ChatAvatars = { user: string; assistant: string }
type UiMessage = { key: MessageKey; fallback?: string }

function AvatarPreview({ src, fallback }: { src: string; fallback: string }) {
  return (
    <div
      className="shrink-0 flex items-center justify-center overflow-hidden select-none w-10 h-10 rounded-full border border-[var(--border-strong)] bg-[var(--surface-alt)] text-[var(--accent)] font-bold text-xs"
    >
      {src ? <img src={src} alt="" className="w-full h-full object-cover" /> : fallback}
    </div>
  )
}

export default function ChatAvatarSettings() {
  const { t } = useI18n()
  const [avatars, setAvatars] = useState<ChatAvatars>({ user: '', assistant: '' })
  const [busy, setBusy] = useState<ChatAvatarRole | ''>('')
  const [error, setError] = useState<UiMessage | null>(null)

  useEffect(() => {
    void window.amadeus?.getChatAvatars().then(value => {
      if (value) setAvatars(value)
    }).catch(reason => setError(reason instanceof Error ? { key: 'settings.avatar.load_error', fallback: reason.message } : { key: 'settings.avatar.load_error' }))
  }, [t])

  const choose = async (role: ChatAvatarRole) => {
    if (!window.amadeus) return
    setBusy(role)
    setError(null)
    try {
      const result = await window.amadeus.selectChatAvatar(role)
      if (!result.ok) throw new Error(result.error || t('settings.avatar.save_error'))
      if (result.avatars) setAvatars(result.avatars)
    } catch (reason) {
      setError(reason instanceof Error ? { key: 'settings.avatar.save_error', fallback: reason.message } : { key: 'settings.avatar.save_error' })
    } finally {
      setBusy('')
    }
  }

  const clear = async (role: ChatAvatarRole) => {
    if (!window.amadeus) return
    setBusy(role)
    setError(null)
    try {
      const result = await window.amadeus.clearChatAvatar(role)
      if (!result.ok) throw new Error(result.error || t('settings.avatar.restore_error'))
      if (result.avatars) setAvatars(result.avatars)
    } catch (reason) {
      setError(reason instanceof Error ? { key: 'settings.avatar.restore_error', fallback: reason.message } : { key: 'settings.avatar.restore_error' })
    } finally {
      setBusy('')
    }
  }

  const rows: Array<{ role: ChatAvatarRole; title: string; detail: string; fallback: string }> = [
    { role: 'user', title: t('settings.avatar.user'), detail: t('settings.avatar.user_detail'), fallback: 'U' },
    { role: 'assistant', title: t('settings.avatar.assistant'), detail: t('settings.avatar.assistant_detail'), fallback: 'K' },
  ]

  return (
    <div className="setting-card settings-avatar-card rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      {rows.map((item, index) => {
        const src = avatars[item.role]
        return (
          <div
            key={item.role}
            className={cn(
              'flex flex-wrap items-center gap-3 py-2.5',
              index > 0 && 'border-t border-[var(--border)]'
            )}
          >
            <AvatarPreview src={src} fallback={item.fallback} />
            <div className="flex-1 min-w-[100px]">
              <div className="text-[13px] font-semibold text-[var(--text)] leading-snug">{item.title}</div>
              <div className="text-[11.5px] mt-0.5 text-[var(--muted)] leading-relaxed">{item.detail}</div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="glass"
                size="sm"
                onClick={() => void choose(item.role)}
                disabled={Boolean(busy)}
                className="text-xs font-semibold"
              >
                {busy === item.role ? t('settings.avatar.opening') : src ? t('settings.avatar.replace') : t('settings.avatar.choose')}
              </Button>
              {src && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void clear(item.role)}
                  disabled={Boolean(busy)}
                  title={t('settings.avatar.restore', undefined, { name: item.title })}
                  aria-label={t('settings.avatar.restore', undefined, { name: item.title })}
                  className="w-8 h-8 p-0 text-[var(--muted)]"
                >
                  ✕
                </Button>
              )}
            </div>
          </div>
        )
      })}
      <div className="text-[10.5px] pt-1 text-[var(--muted)] leading-relaxed">{t('settings.avatar.note')}</div>
      {error && <div className="text-xs text-rose-600 font-medium">{error.fallback ?? t(error.key)}</div>}
    </div>
  )
}
