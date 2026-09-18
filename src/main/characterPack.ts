import { readFileSync, existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { performances, type CharacterDefinition, type Clip } from '../shared/character.ts'
import { safeFilePath } from './pathSafety.ts'

/** Validate an external pack once. Invalid branches are pruned; a valid idle remains usable. */
export function loadCharacter(root: string, urlPrefix: string): CharacterDefinition {
  const result: CharacterDefinition = { root: '', nodes: Object.create(null), edges: Object.create(null), clips: Object.create(null), mouths: Object.create(null), entries: Object.create(null), exits: Object.create(null), closedEyeEligible: [], diagnostics: [] }
  const asset = (relative: unknown): string => {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) throw new Error('Invalid character asset path')
    const file = safeFilePath(root, relative)
    if (!file || !existsSync(file)) throw new Error(`Missing character asset: ${relative}`)
    const real = path.relative(realpathSync(root), realpathSync(file))
    if (real.startsWith('..') || path.isAbsolute(real)) throw new Error('Character asset escapes its pack')
    return file
  }
  const read = (relative: unknown) => JSON.parse(readFileSync(asset(relative), 'utf8'))
  const urls = (frames: unknown): string[] => {
    if (!Array.isArray(frames) || !frames.length) throw new Error('Empty character frame set')
    return frames.map(frame => {
      asset(frame)
      if (path.extname(frame) !== '.ktx2') throw new Error('Character frames must use KTX2')
      return urlPrefix + frame.split('/').map(encodeURIComponent).join('/')
    })
  }
  try {
    const manifest = read('runtime_manifest.json')
    if (manifest.format !== 'amadeus.spriteforge.character-pack.v1' || manifest.textureFormat !== 'ktx2') throw new Error('Unsupported character pack format')
    const graph = read(manifest.graph)
    const mouth = read(manifest.mouthConfig)
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Invalid character graph')
    for (const [label, raw] of Object.entries(manifest.clips || {})) {
      try {
        const clip = raw as Clip
        if (!Number.isFinite(clip.frameIntervalMs) || clip.frameIntervalMs <= 0 || !['loop', 'once_then_hold'].includes(clip.loopMode)) throw new Error(`Invalid clip timing: ${label}`)
        result.clips[label] = { frames: urls(clip.frames), frameIntervalMs: clip.frameIntervalMs, loopMode: clip.loopMode }
      } catch (error) { result.diagnostics.push(String(error)) }
    }
    const roots = graph.nodes.filter((node: any) => node.isRoot === true)
    if (roots.length !== 1) throw new Error('Character graph needs exactly one root')
    for (const node of graph.nodes) {
      if (typeof node.id !== 'string' || !node.id || result.nodes[node.id] || typeof node.label !== 'string') throw new Error('Invalid or duplicate character node')
      if (!result.clips[node.label]) { result.diagnostics.push(`Graph clip unavailable: ${node.label}`); continue }
      result.nodes[node.id] = { label: node.label, kind: 'ambient' }
    }
    result.root = roots[0].id
    if (!result.nodes[result.root]) throw new Error('Character idle clip unavailable')
    for (const edge of graph.edges) {
      if (!Number.isFinite(edge.prob) || edge.prob < 0) throw new Error('Invalid graph edge probability')
      if (!result.nodes[edge.from] || !result.nodes[edge.to]) { result.diagnostics.push(`Unavailable graph edge: ${edge.from} → ${edge.to}`); continue }
      ;(result.edges[edge.from] ||= []).push({ to: edge.to, weight: edge.prob })
    }
    for (const [behavior, spec] of Object.entries(performances)) {
      for (const node of Object.values(result.nodes)) {
        if (spec.entry.includes(node.label)) { node.kind = 'entry'; node.behavior = behavior }
        if (spec.speech.includes(node.label)) { node.kind = 'speech'; node.behavior = behavior }
      }
      result.entries[behavior] = spec.entry.slice(0, 1).flatMap(label => Object.keys(result.nodes).filter(id => result.nodes[id].label === label))
      if (!result.entries[behavior].length) result.diagnostics.push(`Behavior unavailable: ${behavior}`)
      if (spec.post && result.clips[spec.post]) {
        const id = `post:${spec.post}`
        result.nodes[id] = { label: spec.post, kind: 'post', behavior }
        result.exits[behavior] = id
      }
    }
    result.closedEyeEligible = Object.keys(result.nodes).filter(id => ['idle', 'idle1', 'idle2', 'idle_mic_wind', 'idle_str_wind', 'idle_closed_eye', ...performances.neutral.speech].includes(result.nodes[id].label))
    for (const [label, raw] of Object.entries(mouth.profiles || {})) {
      if (!Object.values(result.nodes).some(node => node.label === label && node.kind === 'speech')) continue
      try {
        const profile = raw as Record<string, any>
        const base = mouth.expressions?.[profile.mouth_set || 'neutral']
        if (!base) throw new Error(`Missing mouth set: ${label}`)
        const frameUrls = urls(manifest.mouthOverlays?.[label])
        const anchor = profile.runtime_overlay_anchor || profile
        const overrides = label === 'key_point_speaking'
          ? { overlayAlign: 'canvas', preferOwnClosedFrame: true, silenceMaskAmplitude: 0.8, maskHeightMul: 0.9 }
          : label === 'thinking_speaking2' ? { silenceMaskAmplitude: 1, maskWidthMul: 1.04, maskHeightMul: 1.25, maskCyOffset: -4 } : {}
        result.mouths[label] = {
          ...base, cx: profile.cx ?? base.cx, cy: profile.cy ?? base.cy, width: profile.width ?? base.width, height: profile.height ?? base.height,
          mode: 'silence_close', silenceThreshold: 0.08, closedFrameIdx: 0, profile: label,
          frameUrls, openness: frameUrls.map(() => 0), opennessByFrame: profile.openness || [],
          sourceAnchors: [anchor], sourceCx: anchor.cx, sourceCy: anchor.cy, anchorTrack: profile.anchor_track || [], ...overrides,
        }
      } catch (error) { result.diagnostics.push(String(error)) }
    }
  } catch (error) {
    result.diagnostics.push(String(error))
    const idle = result.clips.idle
    result.root = 'fallback'
    result.nodes = idle ? { fallback: { label: 'idle', kind: 'ambient' } } : {}
    result.edges = {}
    result.entries = {}
  }
  return result
}
