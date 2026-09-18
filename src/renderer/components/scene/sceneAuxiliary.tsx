import WorkPage from '../WorkPage'
import { SCENE_WORK_SURFACE } from './useSceneApproval'

type SendFn = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
type SubscribeFn = (method: string, fn: (params: Record<string, unknown>) => void) => () => void

export function SceneWorkView({ send, subscribe, connected }: { send: SendFn; subscribe: SubscribeFn; connected: boolean }) {
  return (
    <div className="h-full min-h-[420px]" data-testid="scene-work-surface">
      <WorkPage send={send} subscribe={subscribe} connected={connected} embedded surface={SCENE_WORK_SURFACE} />
    </div>
  )
}
