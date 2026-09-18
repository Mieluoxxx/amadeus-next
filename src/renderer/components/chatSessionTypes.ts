/**
 * Session and Project shapes shared by the chat surface and the scene shell.
 *
 * These describe what the backend returns, so they belong to the data rather
 * than to any one component. They used to live beside the chat session rail,
 * which the sidebar and the global window chrome replaced.
 */

export interface ChatSessionContext {
  bindingKind: 'project' | 'work_item'
  projectId: string
  projectName: string
  defaultProjectId?: string
  defaultProjectName?: string
  workItemId?: string
  workItemTitle?: string
  canPromoteToProject?: boolean
}

export interface ChatSessionSummary {
  id: string
  title: string
  timestamp?: number
  message_count?: number
  context?: ChatSessionContext | null
}

export interface ChatProjectSummary {
  projectId: string
  name: string
  latestTaskTitle?: string
  counts?: {
    current?: number
    needsYou?: number
    running?: number
    history?: number
  }
}
