/**
 * 向主进程上报"主人正在写草稿"，供话筒仲裁推迟主动汇报（architecture §4.2、D1）。
 * 语义是草稿非空且 30 秒内有键入：超时由这里自己置回，免得忘在框里的草稿让汇报永远发不出。
 */

import { useCallback, useEffect, useRef } from 'react'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

export const COMPOSING_IDLE_MS = 30_000

export function useComposingReport({
  send,
  connected,
  draft,
  sessionId,
}: {
  send: SendFn
  connected: boolean
  draft: string
  sessionId: string
}) {
  /** 主进程眼里的当前取值；只在变化时发请求。 */
  const reported = useRef(false)

  const report = useCallback((active: boolean) => {
    if (reported.current === active) return
    reported.current = active
    // 主进程没实现或暂时不可用时不打扰界面；闸门只是推迟汇报，丢一次上报不致命。
    void send('chat.composing', { active }).catch(() => {})
  }, [send])

  // 必须排在草稿 effect 之前：主进程切会话时自己清零，镜像先归零，下一次键入才会重新上报。
  useEffect(() => { reported.current = false }, [sessionId, connected])

  useEffect(() => {
    if (!connected) return
    if (!draft.trim()) {
      report(false)
      return
    }
    report(true)
    const timer = setTimeout(() => report(false), COMPOSING_IDLE_MS)
    return () => clearTimeout(timer)
  }, [connected, draft, report])

  useEffect(() => () => {
    if (reported.current) void send('chat.composing', { active: false }).catch(() => {})
  }, [send])
}
