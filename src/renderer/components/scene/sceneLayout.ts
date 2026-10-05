/**
 * 场景外壳几何计算纯函数模块。
 *
 * 保证 CRT 监视器主体与角色立绘在任意窗口尺寸及侧边栏展开时始终完整呈现、绝不被遮挡或裁切，
 * 同时脱离 Electron 依赖便于纯环境单元测试。
 */

// 背景图原始设计基准分辨率。
const SCENE_DESIGN = { width: 1672, height: 941 } as const

/**
 * CRT 监视器外壳包围盒基准坐标。
 * 避让与排版计算必须基于外壳整体而非仅 CRT 玻璃，确保立体边框与机身不被浮层截断。
 */
const SCENE_CABINET = { x: 470, y: 100, width: 780, height: 645 } as const

// 侧边栏与底部输入框尺寸边界，保证在极小窗口下依然具备可用交互空间。
const MIN_PANEL_WIDTH = 320
const MIN_DOCK_HEIGHT = 128
const MAX_DOCK_HEIGHT = 184
// 顶部保留区高度，避免窗口控制按钮和状态通知侵入 CRT 监视器构图。
const CHROME_BAND_HEIGHT = 112
const MIN_CHROME_BAND_HEIGHT = 112
// 超矮窗口下的极端保底高度，确保多行控件收折后不遮挡角色头顶。
const COMPACT_CHROME_BAND_HEIGHT = 52
const TOOLBAR_RESERVED_WIDTH = 236
const STATUS_TRAY_MAX_WIDTH = 420
const PANEL_MARGIN = 12
/** Keep at least this share of the window for the scene when the sidebar is open. */
export type ScenePanelKind = 'transcript' | 'more'

export type SceneRegion = { x: number; y: number; width: number; height: number }

type SceneFit = { scale: number; offsetX: number; offsetY: number }

export type SceneOverlay = {
  /** `chrome` is the reserved window-control band; it has no DOM element. */
  kind: ScenePanelKind | 'dock' | 'chrome' | 'status'
  placement: 'right' | 'left' | 'bottom' | 'top'
  region: SceneRegion
}

export type SceneLayout = {
  /** The scene always occupies the entire window. */
  scene: SceneRegion
  /** Overlay rects; all of them must avoid `cabinet`. */
  overlays: SceneOverlay[]
  panel: SceneOverlay | null
  dock: SceneOverlay | null
  /** Reserved band for the toolbar and the (bounded) notice stack. */
  chrome: SceneOverlay
  /** Bounded status tray inside the chrome band, opposite the toolbar. */
  status: SceneOverlay
  fit: SceneFit
  /** CRT cabinet rect in window coordinates, derived from `fit`. */
  cabinet: SceneRegion
  // 标记场景视口是否需底层静态壁纸补齐，记录几何状态供调试，保障优先保全 CRT 构图而非强制拉伸变形。
  seam: boolean
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

function insetRegion(region: SceneRegion, margin: number): SceneRegion {
  const horizontal = Math.min(margin, Math.max(0, Math.floor((region.width - 1) / 2)))
  const vertical = Math.min(margin, Math.max(0, Math.floor((region.height - 1) / 2)))
  return {
    x: region.x + horizontal,
    y: region.y + vertical,
    width: Math.max(1, region.width - horizontal * 2),
    height: Math.max(1, region.height - vertical * 2),
  }
}

function overlaps(left: SceneRegion, right: SceneRegion): boolean {
  const epsilon = 1e-6
  return left.x < right.x + right.width - epsilon
    && left.x + left.width > right.x + epsilon
    && left.y < right.y + right.height - epsilon
    && left.y + left.height > right.y + epsilon
}

function sceneCabinetRect(fit: SceneFit): SceneRegion {
  return {
    x: SCENE_CABINET.x * fit.scale + fit.offsetX,
    y: SCENE_CABINET.y * fit.scale + fit.offsetY,
    width: SCENE_CABINET.width * fit.scale,
    height: SCENE_CABINET.height * fit.scale,
  }
}

// 优先全屏铺满背景消除接缝；当浮层挤压空间时等比缩小以优先保全监视器主体，由外层同图壁纸兜底边缘。
function sceneFit(scene: SceneRegion, free: SceneRegion = scene): SceneFit {
  const windowWidth = Math.max(1, scene.width)
  const windowHeight = Math.max(1, scene.height)
  const freeWidth = Math.max(1, free.width)
  const freeHeight = Math.max(1, free.height)
  const coverScale = Math.max(windowWidth / SCENE_DESIGN.width, windowHeight / SCENE_DESIGN.height)
  const cabinetScale = Math.min(
    freeWidth / SCENE_CABINET.width,
    freeHeight / SCENE_CABINET.height,
  )
  const scale = Math.max(0.05, Math.min(coverScale, cabinetScale))
  const idealX = free.x + freeWidth / 2 - (SCENE_CABINET.x + SCENE_CABINET.width / 2) * scale
  const idealY = free.y + freeHeight / 2 - (SCENE_CABINET.y + SCENE_CABINET.height / 2) * scale
  return { scale, offsetX: idealX, offsetY: idealY }
}

function frameRect(fit: SceneFit): SceneRegion {
  return {
    x: fit.offsetX,
    y: fit.offsetY,
    width: SCENE_DESIGN.width * fit.scale,
    height: SCENE_DESIGN.height * fit.scale,
  }
}

function containsRect(outer: SceneRegion, inner: SceneRegion): boolean {
  return inner.x >= outer.x - 1e-6
    && inner.y >= outer.y - 1e-6
    && inner.x + inner.width <= outer.x + outer.width + 1e-6
    && inner.y + inner.height <= outer.y + outer.height + 1e-6
}

/**
 * True when every part of the window is either drawn by the scene frame or
 * hidden behind an overlay, so a frame that is not full-bleed leaves no seam.
 * Overlays are edge-anchored strips, so checking the four exposed strips is
 * exact rather than a sampling approximation.
 */
function coveredByFrameAndOverlays(
  scene: SceneRegion,
  fit: SceneFit,
  overlays: SceneOverlay[],
): boolean {
  const frame = frameRect(fit)
  const strips: SceneRegion[] = []
  if (frame.x > scene.x + 1e-6) {
    strips.push({ x: scene.x, y: scene.y, width: frame.x - scene.x, height: scene.height })
  }
  const frameRight = frame.x + frame.width
  if (frameRight < scene.x + scene.width - 1e-6) {
    strips.push({
      x: frameRight,
      y: scene.y,
      width: scene.x + scene.width - frameRight,
      height: scene.height,
    })
  }
  if (frame.y > scene.y + 1e-6) {
    strips.push({ x: scene.x, y: scene.y, width: scene.width, height: frame.y - scene.y })
  }
  const frameBottom = frame.y + frame.height
  if (frameBottom < scene.y + scene.height - 1e-6) {
    strips.push({
      x: scene.x,
      y: frameBottom,
      width: scene.width,
      height: scene.y + scene.height - frameBottom,
    })
  }
  return strips.every(strip => overlays.some(overlay => containsRect(overlay.region, strip)))
}

// 对话历史与设置面板互斥展示，避免有限横向空间被多层面板挤压。
export function toggleScenePanel(
  current: ScenePanelKind | null,
  next: ScenePanelKind,
): ScenePanelKind | null {
  return current === next ? null : next
}

function remaining(scene: SceneRegion, overlays: SceneOverlay[]): SceneRegion {
  let region = { ...scene }
  for (const overlay of overlays) {
    const box = overlay.region
    if (overlay.placement === 'right') {
      // 侧边栏独占垂直带时，剩余可用视口为面板左侧宽度，防止监视器落入侧边栏覆盖区。
      region = { ...region, width: Math.max(1, box.x - region.x) }
    } else if (overlay.placement === 'left') {
      const right = region.x + region.width
      region = {
        x: box.x + box.width,
        y: region.y,
        width: Math.max(1, right - (box.x + box.width)),
        height: region.height,
      }
    } else if (overlay.placement === 'top') {
      const bottom = region.y + region.height
      const top = box.y + box.height
      region = {
        x: region.x,
        y: top,
        width: region.width,
        height: Math.max(1, bottom - top),
      }
    } else {
      region = { ...region, height: Math.max(1, box.y - region.y) }
    }
  }
  return region
}

// 布局判定准则：监视器完整与无遮挡为第一优先级，全屏铺满为次优先级；极端长宽比下宁可露底也不裁切角色。
function evaluateCandidate(
  scene: SceneRegion,
  overlays: SceneOverlay[],
  requireCoverage = true,
): { fit: SceneFit; cabinet: SceneRegion } | null {
  const free = remaining(scene, overlays)
  const fit = sceneFit(scene, free)
  const cabinet = sceneCabinetRect(fit)
  if (!containsRect(free, cabinet)) return null
  if (overlays.some(overlay => overlaps(cabinet, overlay.region))) return null
  if (requireCoverage && !coveredByFrameAndOverlays(scene, fit, overlays)) return null
  return { fit, cabinet }
}

// 当无法严格全屏铺满时回退至宽松排列，交由底图补全外露区域。
function fallbackArrangement(
  scene: SceneRegion,
  overlays: SceneOverlay[],
): { fit: SceneFit; cabinet: SceneRegion; covered: boolean } {
  const strict = evaluateCandidate(scene, overlays)
  if (strict) {
    return { ...strict, covered: true }
  }
  const relaxed = evaluateCandidate(scene, overlays, false)
  if (relaxed) {
    return { ...relaxed, covered: false }
  }
  // 极端挤压无安全空间时保底缩小监视器，防止立绘被截断。
  const free = remaining(scene, overlays)
  const fit = sceneFit(scene, free)
  return { fit, cabinet: sceneCabinetRect(fit), covered: false }
}

// 动态计算侧边栏、输入框与场景画幅，保证侧边栏展开时场景主动避让，使角色居于剩余视口中央。
export function resolveSceneLayout(
  width: number,
  height: number,
  panel: ScenePanelKind | null,
  options: { dock?: boolean } = {},
): SceneLayout {
  const scene: SceneRegion = {
    x: 0,
    y: 0,
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  }
  const showDock = options.dock !== false

  const dockFloor = scene.height < 360 ? 64 : scene.height <= 500 ? MIN_DOCK_HEIGHT : MAX_DOCK_HEIGHT
  const dockWidth = Math.min(scene.width, 1080)
  const dockHeight = Math.max(1, Math.min(dockFloor, Math.max(1, scene.height - 1)))
  const dock: SceneOverlay | null = showDock ? {
    kind: 'dock',
    placement: 'bottom',
    region: insetRegion(
      { x: (scene.width - dockWidth) / 2, y: scene.height - dockHeight, width: dockWidth, height: dockHeight },
      PANEL_MARGIN,
    ),
  } : null

  // 顶部保留区随窗口高度弹性缩放，并由保底尺寸确保控件可用且不侵占角色空间。
  const chromeFloor = scene.height < 360 ? COMPACT_CHROME_BAND_HEIGHT : MIN_CHROME_BAND_HEIGHT
  const chromeHeight = Math.max(
    1,
    Math.min(
      clamp(Math.round(scene.height * 0.1), chromeFloor, CHROME_BAND_HEIGHT),
      Math.max(1, scene.height - 1),
    ),
  )
  const chrome: SceneOverlay = {
    kind: 'chrome',
    placement: 'top',
    region: { x: 0, y: 0, width: scene.width, height: chromeHeight },
  }
  const status: SceneOverlay = {
    kind: 'status',
    placement: 'top',
    region: {
      x: PANEL_MARGIN,
      y: 4,
      width: Math.max(
        1,
        Math.min(
          STATUS_TRAY_MAX_WIDTH,
          scene.width - TOOLBAR_RESERVED_WIDTH - PANEL_MARGIN * 3,
        ),
      ),
      height: Math.max(1, chromeHeight - 4),
    },
  }

  const panelCandidates: SceneOverlay[] = []
  if (panel) {
    const sidebarWidth = Math.min(
      scene.width,
      clamp(Math.floor(scene.width * 0.32), MIN_PANEL_WIDTH, 420),
    )
    panelCandidates.push({
      kind: panel,
      placement: 'right',
      region: { x: scene.width - sidebarWidth, y: 0, width: sidebarWidth, height: scene.height },
    })
  } else if (dock) {
    panelCandidates.push(dock)
  }

  // 优选保全无缝铺满且监视器画幅最大的候选布局，避免角色被过度缩放或遮挡。
  type Ranked = { overlays: SceneOverlay[]; arranged: { fit: SceneFit; cabinet: SceneRegion }; covered: boolean }
  const ranked: Ranked[] = []
  for (const candidate of panelCandidates) {
    const candidateOverlays = [chrome, candidate]
    if (panel && dock) candidateOverlays.push(dock)
    const strict = evaluateCandidate(scene, candidateOverlays)
    const relaxed = strict || evaluateCandidate(scene, candidateOverlays, false)
    if (!relaxed) continue
    ranked.push({ overlays: candidateOverlays, arranged: relaxed, covered: Boolean(strict) })
  }
  ranked.sort((left, right) => {
      if (left.covered !== right.covered) return left.covered ? -1 : 1
      const leftArea = left.arranged.cabinet.width * left.arranged.cabinet.height
      const rightArea = right.arranged.cabinet.width * right.arranged.cabinet.height
      return rightArea - leftArea
    })

  const overlays: SceneOverlay[] = ranked.length > 0
    ? [chrome, status, ...ranked[0].overlays.filter(overlay => overlay.kind !== 'chrome')]
    : [chrome, status]
  const arrangement = ranked.length > 0
    ? { ...ranked[0].arranged, covered: ranked[0].covered }
    : fallbackArrangement(scene, overlays)

  const { fit, cabinet } = arrangement
  const panelOverlay = overlays.find(overlay => overlay.kind === panel) || null
  const dockOverlay = overlays.find(overlay => overlay.kind === 'dock') || null
  if (panelOverlay && dockOverlay) {
    // 侧边栏开启时将输入框居中于剩余可用列，保持视觉轴线对齐。
    const column = remaining(scene, [panelOverlay])
    const width = Math.min(dockOverlay.region.width, Math.max(1, column.width - PANEL_MARGIN * 2))
    dockOverlay.region = { ...dockOverlay.region, x: column.x + (column.width - width) / 2, width }
  }
  return {
    scene,
    overlays,
    panel: panelOverlay,
    dock: dockOverlay,
    chrome,
    status,
    fit,
    cabinet,
    seam: !coveredByFrameAndOverlays(scene, fit, overlays),
  }
}

// 保持 iframe 设计基准尺寸，通过 CSS 变换实现亚像素级缩放与平移，防止重排与采样模糊。
export function sceneFrameStyle(fit: SceneFit): {
  width: number
  height: number
  transform: string
  transformOrigin: string
} {
  return {
    width: SCENE_DESIGN.width,
    height: SCENE_DESIGN.height,
    transform: `translate(${fit.offsetX}px, ${fit.offsetY}px) scale(${fit.scale})`,
    transformOrigin: '0 0',
  }
}
