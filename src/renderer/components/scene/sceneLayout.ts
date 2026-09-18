/**
 * Geometry for the Amadeus scene shell.
 *
 * The scene always fills the whole main window — background, desk and CRT stay
 * one continuous picture. The full transcript, settings and the reply/input
 * dock are overlays placed in the scene's free space; the scene framing is then
 * shifted so the CRT cabinet sits in whatever space is left. Nothing may cover
 * the cabinet, and the character inside it is never cropped or shrunk into a
 * corner preview.
 *
 * These functions are pure so the contract is testable without Electron.
 */

/** Authored size of `assets/images/amadeus_desktop_wallpaper.png`. */
export const SCENE_DESIGN = { width: 1672, height: 941 } as const

/**
 * CRT glass polygon bounds in design coordinates. This mirrors
 * `wallpaper/crt_config.json`, which is the authored source for the screen
 * mask (see `wallpaper/scene_assets.py`).
 */
export const SCENE_GLASS = { x: 550, y: 195, width: 586, height: 443 } as const

/**
 * CRT cabinet envelope in design coordinates — the beige monitor body with its
 * bezel, "AMADEUS" label and power LED, measured from the artwork. The
 * character and the machine she lives in must stay inside this box, so framing
 * and overlay placement both use the cabinet, not the glass alone.
 *
 * Re-derive this from the artwork if the scene image changes; the unit test
 * `the cabinet envelope contains the authored glass polygon` guards the
 * relationship, not the literal pixels.
 */
export const SCENE_CABINET = { x: 470, y: 100, width: 780, height: 645 } as const

/** Preferred overlay sizes. */
export const MIN_PANEL_WIDTH = 320
/** Raw band size; PANEL_MARGIN is inset on both sides, leaving room for context and attachments. */
export const MIN_DOCK_HEIGHT = 128
export const MAX_DOCK_HEIGHT = 184
/**
 * Height of the top chrome band (toolbar plus a compact event tray). The band is
 * reserved as an overlay so the cabinet can never end up underneath window
 * controls or status notices.
 */
export const CHROME_BAND_HEIGHT = 112
/** Floor for the chrome band on very short windows. */
export const MIN_CHROME_BAND_HEIGHT = 112
/** Compact fallback for ultra-short windows where a multi-row tray cannot fit. */
export const COMPACT_CHROME_BAND_HEIGHT = 52
/** The toolbar occupies the top-right part of the shared chrome band. */
export const TOOLBAR_RESERVED_WIDTH = 236
/** Maximum width of the shared status tray. */
export const STATUS_TRAY_MAX_WIDTH = 420
/**
 * Margin between a panel and the window edges. The panel is a floating surface
 * over the scene, not a layout column, so it never touches the frame.
 */
export const PANEL_MARGIN = 12

/** Keep at least this share of the window for the scene when an overlay is open. */
const MIN_FREE_RATIO = 0.4

export type ScenePanelKind = 'transcript' | 'more'

export type SceneRegion = { x: number; y: number; width: number; height: number }

export type SceneFit = { scale: number; offsetX: number; offsetY: number }

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
  /**
   * True when the scene frame alone does not paint the whole window, so the
   * window background (the same artwork) fills the remainder. With floating
   * panels this is normal: a panel is inset from the edges by design, so the
   * slivers behind its margins are not covered by it.
   *
   * This is reported as data, not as a user-facing warning: the meaningful
   * guarantee is that the cabinet stays whole, uncovered and recognisable,
   * which is asserted directly (see `the cabinet stays recognisable` and the
   * minimum-window check).
   */
  seam: boolean
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

/** Shrinks a region on every side, clamping to a still-usable rectangle. */
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

/** Cabinet rect for a given fit. */
export function sceneCabinetRect(fit: SceneFit): SceneRegion {
  return {
    x: SCENE_CABINET.x * fit.scale + fit.offsetX,
    y: SCENE_CABINET.y * fit.scale + fit.offsetY,
    width: SCENE_CABINET.width * fit.scale,
    height: SCENE_CABINET.height * fit.scale,
  }
}

/** @deprecated kept for callers that only need the glass rect. */
export function sceneCrtRect(fit: SceneFit): SceneRegion {
  return sceneCabinetRect(fit)
}

/**
 * Fit that keeps the cabinet inside `free`, and covers `scene` when it can.
 *
 * The scale prefers a full cover of the window so the artwork has no seam; when
 * the cabinet could not then stay clear of the overlays, the scale drops just
 * enough to fit. Because the frame may then be smaller than the window, the
 * caller must confirm the window is still covered by the frame plus overlays
 * (`coveredByFrameAndOverlays`).
 */
export function sceneFit(scene: SceneRegion, free: SceneRegion = scene): SceneFit {
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
export function coveredByFrameAndOverlays(
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

/**
 * Transcript and settings are mutually exclusive: opening
 * one closes the current one, and toggling the open one closes it.
 */
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
      // A side panel may start below the top band, so the free area is the
      // remaining width to its left (never the strip it already occupies).
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

/**
 * A candidate is usable when the cabinet is whole, clear of every overlay, and
 * — unless `requireCoverage` is false — the frame plus overlays paint the whole
 * window.
 *
 * Coverage is a preference, not a hard rule. At extreme aspect ratios (an
 * ultra-wide or very short window) no arrangement can both keep the cabinet
 * whole and cover every pixel; there we accept the uncovered strip, which the
 * wrapper fills with the same artwork. Dropping coverage is the honest failure
 * mode: covering the character is never an option.
 */
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

/** Places the cabinet in the space an overlay leaves, with no coverage demand. */
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
  // Nothing fits beside the overlay: keep the cabinet whole by shrinking it.
  const free = remaining(scene, overlays)
  const fit = sceneFit(scene, free)
  return { fit, cabinet: sceneCabinetRect(fit), covered: false }
}

/**
 * Places the open panel and the reply/input dock so the CRT cabinet stays whole
 * and uncovered, the window stays fully painted, and the overlays are never a
 * separate layout column — they float over one continuous scene.
 *
 * Panels only use the right or left column; sizes step down toward their
 * minimums. Preference is given to arrangements that both keep the
 * cabinet whole and leave no seam, then to the largest cabinet; when no
 * arrangement can do both, the largest cabinet still wins and `seam` is set.
 */
export function resolveSceneLayout(
  width: number,
  height: number,
  panel: ScenePanelKind | null,
  options: { dock?: boolean; preferredSide?: 'left' | 'right' } = {},
): SceneLayout {
  const scene: SceneRegion = {
    x: 0,
    y: 0,
    width: Math.max(1, Math.floor(width)),
    height: Math.max(1, Math.floor(height)),
  }
  const showDock = options.dock !== false

  const sideSizes = [
    clamp(Math.floor(scene.width * 0.38), MIN_PANEL_WIDTH, 560),
    MIN_PANEL_WIDTH,
  ].filter((value, index, list) => list.indexOf(value) === index)
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

  // Both bands scale with the window so a short window keeps room for the
  // character; the floors are the smallest still-usable controls.
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
    // Side panels start below the window chrome band. The toolbar lives only in
    // that band, so this is what keeps its buttons (and the panel header's own
    // controls) clickable instead of buried under a floating surface.
    const panelTop = Math.min(chromeHeight, Math.max(0, scene.height - 1))
    const panelBody = Math.max(1, (dock?.region.y ?? scene.height) - panelTop)
    for (const side of sideSizes) {
      panelCandidates.push({
        kind: panel,
        placement: 'right',
        region: insetRegion(
          { x: scene.width - side, y: panelTop, width: side, height: panelBody },
          PANEL_MARGIN,
        ),
      })
      panelCandidates.push({
        kind: panel,
        placement: 'left',
        region: insetRegion(
          { x: 0, y: panelTop, width: side, height: panelBody },
          PANEL_MARGIN,
        ),
      })
    }
  } else if (dock) {
    panelCandidates.push(dock)
  }

  /**
   * Ranking: keep the preferred side among safe candidates, then prefer a
   * fully covered window and the largest cabinet. Size matters because covering the
   * character with chrome is never acceptable — shrinking it into a thumbnail
   * is the failure mode this ordering exists to prevent.
   */
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
      if (options.preferredSide) {
        const onPreferredSide = (entry: Ranked) => entry.overlays.some(overlay => overlay.kind === panel && overlay.placement === options.preferredSide)
        const sidePreference = Number(onPreferredSide(right)) - Number(onPreferredSide(left))
        if (sidePreference) return sidePreference
      }
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

  const { fit, cabinet, covered } = arrangement
  const panelOverlay = overlays.find(overlay => overlay.kind === panel) || null
  const dockOverlay = overlays.find(overlay => overlay.kind === 'dock') || null
  if (panelOverlay && dockOverlay) {
    // Keep the chosen scene framing and centre the composer in the same free column.
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

/**
 * Inline transform for the scene frame: the iframe keeps the authored size and
 * is scaled/positioned by the fit.
 */
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
