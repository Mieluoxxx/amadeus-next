/**
 * 会话流状态纯函数辅助模块。
 * 沉淀中断流过滤、唤醒词即时上屏与会话版本校验等核心规则，解耦纯逻辑以保证单测确定性。
 */

type SceneDraftOutcome = {
  draft: string | null
  alreadySubmitted: boolean
}

// 区分语音识别来源：唤醒词识别已由后台自动提交为消息，避免草稿残留重复内容；手动录音则填入草稿供用户复核。
export function asrDraftOutcome(
  source: string,
  text: string,
  currentDraft: string,
): SceneDraftOutcome {
  const speech = text.trim()
  if (!speech) return { draft: null, alreadySubmitted: false }
  if (source === 'vn_player') return { draft: null, alreadySubmitted: false }
  if (source === 'wake') return { draft: currentDraft, alreadySubmitted: true }
  return {
    draft: currentDraft ? `${currentDraft} ${speech}` : speech,
    alreadySubmitted: false,
  }
}

// 判定事件是否属于已被用户打断的旧回合，防止迟到的流式 Token 污染新内容。
export function isStaleTurn(turnId: string, interrupted: ReadonlySet<string>): boolean {
  return Boolean(turnId) && interrupted.has(turnId)
}

// 记录需丢弃的中断回合集合。
export function interruptedTurns(
  eventTurnId: string,
  activeTurnId: string,
  previous: ReadonlySet<string>,
): Set<string> {
  const next = new Set(previous)
  // 指定回合 ID 具有权威性；缺省时才回退至活跃回合，防止旧中断信号连带误杀新回合。
  const target = eventTurnId || activeTurnId
  if (target) next.add(target)
  return next
}

// 校验会话载入响应的归属，防止迟到的历史会话加载覆盖当前最新选中的会话上下文。
export function mayApplySession(
  requestedId: string,
  activeId: string,
  failed: boolean,
): boolean {
  if (failed) return false
  if (!requestedId) return true
  return requestedId === activeId
}
