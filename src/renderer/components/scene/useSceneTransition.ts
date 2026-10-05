import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { resolveSceneLayout, sceneFrameStyle, type SceneLayout, type SceneOverlay, type ScenePanelKind, type SceneRegion } from './sceneLayout'

const DURATION = 260
const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

type Surface = SceneRegion & { opacity: number }
type View = { layout: SceneLayout; panel: SceneOverlay | null; dock: SceneOverlay | null; animating: boolean }

function surface(node: HTMLElement | null): Surface | null {
  if (!node) return null
  const { x, y, width, height } = node.getBoundingClientRect()
  return { x, y, width, height, opacity: Number(getComputedStyle(node).opacity) }
}

function surfaceKeyframe(box: Surface): Keyframe {
  return { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`, opacity: box.opacity }
}

/** 动效完成前保持浮层 DOM 挂载，防止动画未播放完毕即被提前卸载。 */
export function useSceneTransition(
  width: number,
  height: number,
  requestedPanel: ScenePanelKind | null,
  frameRef: RefObject<HTMLIFrameElement | null>,
  frameLoadId: number,
) {
  const [view, setView] = useState<View>(() => {
    const layout = resolveSceneLayout(width, height, requestedPanel)
    return { layout, panel: layout.panel, dock: layout.dock, animating: false }
  })
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const panelRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const previousViewport = useRef({ width, height, frameLoadId })
  const animations = useRef<Animation[]>([])
  const generation = useRef(0)
  const pending = useRef<{
    generation: number
    frame: string | null
    panel: Surface | null
    dock: Surface | null
    kind: SceneOverlay['kind'] | undefined
    animate: boolean
  } | null>(null)

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    const old = previousViewport.current
    // 窗口缩放或重载时跳过补间动效，立即对齐布局以避免画面拉伸变形。
    const animate = !reducedMotion && old.width === width && old.height === height && old.frameLoadId === frameLoadId
      && ((view.layout.panel?.kind || null) !== requestedPanel || view.animating)
    const layout = resolveSceneLayout(width, height, requestedPanel)
    pending.current = {
      generation: ++generation.current,
      frame: frameRef.current ? getComputedStyle(frameRef.current).transform : null,
      panel: surface(panelRef.current),
      dock: surface(dockRef.current),
      kind: view.panel?.kind,
      animate,
    }
    previousViewport.current = { width, height, frameLoadId }
    if ((!layout.panel && panelRef.current?.contains(document.activeElement)) || (!layout.dock && dockRef.current?.contains(document.activeElement))) {
      document.querySelector<HTMLButtonElement>(`[data-testid="scene-open-${requestedPanel || view.panel?.kind}"]`)?.focus({ preventScroll: true })
    }
    for (const animation of animations.current) animation.cancel()
    animations.current = []
    setView({
      layout,
      panel: layout.panel || (pending.current.animate ? view.panel : null),
      dock: layout.dock || (pending.current.animate ? view.dock : null),
      animating: pending.current.animate,
    })
  }, [width, height, requestedPanel, frameLoadId, reducedMotion])

  useLayoutEffect(() => {
    const step = pending.current
    pending.current = null
    if (!step?.animate) return
    const running: Animation[] = []
    const animate = (node: Element, keyframes: Keyframe[], duration = DURATION) => {
      running.push(node.animate(keyframes, { duration, easing: EASING, fill: 'both' }))
    }
    const { layout } = view
    if (frameRef.current && step.frame) {
      animate(frameRef.current, [{ transform: step.frame }, { transform: sceneFrameStyle(layout.fit).transform }])
    }
    if (panelRef.current && view.panel) {
      const end: Surface = { ...view.panel.region, opacity: layout.panel ? 1 : 0 }
      const from: Surface = step.panel || {
        ...end, x: view.panel.placement === 'right' ? width : -end.width, opacity: 0,
      }
      if (!layout.panel) {
        Object.assign(end, from, { x: view.panel.placement === 'right' ? width : -from.width, opacity: 0 })
      }
      // 仅对面板外框补间位移与尺寸，避免文本在缩放过渡中发生字体模糊。
      animate(panelRef.current, [surfaceKeyframe(from), surfaceKeyframe(end)])
      if (step.kind && layout.panel && step.kind !== layout.panel.kind) {
        const body = panelRef.current.querySelector('.scene-transcript-scroll, .scene-settings-body')
        if (body) animate(body, [{ opacity: 0 }, { opacity: 1 }], 160)
      }
    }
    if (dockRef.current && view.dock) {
      const from = step.dock || { ...view.dock.region, y: height, opacity: 0 }
      const end = { ...view.dock.region, y: layout.dock ? view.dock.region.y : height, opacity: layout.dock ? 1 : 0 }
      animate(dockRef.current, [
        surfaceKeyframe(from),
        surfaceKeyframe(end),
      ])
    }
    const startTime = document.timeline.currentTime
    for (const animation of running) animation.startTime = startTime
    animations.current = running
    const finish = () => {
      if (step.generation !== generation.current) return
      setView(current => ({ ...current, panel: current.layout.panel, dock: current.layout.dock, animating: false }))
    }
    void Promise.all(running.map(animation => animation.finished)).then(finish, error => {
      if (error?.name === 'AbortError') return
      console.error('Scene transition failed', error)
      finish()
    })
  }, [view])

  useLayoutEffect(() => () => {
    generation.current += 1
    for (const animation of animations.current) animation.cancel()
  }, [])

  return { ...view, panelRef, dockRef }
}
