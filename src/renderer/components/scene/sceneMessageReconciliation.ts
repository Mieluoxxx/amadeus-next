export type SceneMessage = {
  id: string
  identity?: 'authoritative' | 'derived'
  role: 'user' | 'assistant' | 'system'
  text: string
  sessionId?: string
  turnId?: string
  streaming?: boolean
  delivery?: 'pending' | 'accepted' | 'unknown' | 'rejected'
  local?: boolean
}

function messageKey(message: SceneMessage): string {
  if (message.turnId) return `turn:${message.sessionId || ''}:${message.role}:${message.turnId}`
  if (message.identity === 'authoritative' && message.id) return `id:${message.id}`
  return `derived:${message.sessionId || ''}:${message.role}:${message.id}`
}

function sameMessage(left: SceneMessage, right: SceneMessage): boolean {
  return (left.identity === 'authoritative'
      && right.identity === 'authoritative'
      && left.id === right.id)
    || Boolean(left.turnId && right.turnId && left.turnId === right.turnId
      && left.role === right.role
      && (!left.sessionId || !right.sessionId || left.sessionId === right.sessionId))
}

type MessageReconciliation = {
  messages: SceneMessage[]
  acknowledged: ReadonlySet<string>
}

// 将本地乐观更新消息与服务端权威历史快照合并。
// 服务端确认前保留本地未提交完成的回合，流式传输中优先保留本地最新状态，并通过回合 ID 精确关联防止重复折叠。
export function reconcileLoadedMessages(
  previous: SceneMessage[],
  loaded: SceneMessage[],
  sessionId: string,
  previouslyAcknowledged: ReadonlySet<string> = new Set(),
  liveTurnIds: ReadonlySet<string> = new Set(),
): MessageReconciliation {
  const acknowledged = new Set(previouslyAcknowledged)
  for (const message of loaded) {
    if (!message.turnId || !liveTurnIds.has(message.turnId)) acknowledged.add(messageKey(message))
  }

  const merged = [...loaded]
  for (const message of previous) {
    if (!message.local || message.sessionId !== sessionId || !message.turnId) continue
    const existingIndex = merged.findIndex(candidate => sameMessage(candidate, message))
    if (existingIndex >= 0) {
      if (message.streaming) merged[existingIndex] = message
      continue
    }
    if (message.delivery === 'rejected' || acknowledged.has(messageKey(message))) continue
    merged.push({ ...message, sessionId: message.sessionId || sessionId })
  }
  return { messages: merged, acknowledged }
}
