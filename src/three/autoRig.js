// Renderer side of the Auto Rigger: the bridge to the desktop backend and the report summary.

// The Electron preload exposes window.animare.autoRig. Absent on web / itch.io (no Blender to run).
export function autoRigBridge() {
  const b = typeof window !== 'undefined' ? window.animare?.autoRig : null
  return b && typeof b.run === 'function' ? b : null
}

export function autoRigAvailable() {
  return !!autoRigBridge()
}

// A short, honest summary of what the pipeline measured. No "looks good" — numbers.
export function summariseRigReport(report) {
  if (!report || !report.weights) return 'Rigged.'
  const w = report.weights
  const lines = []
  lines.push(`Rigged: ${report.bones} bones, ${report.components?.length ?? '?'} parts (${report.rigid_bindings?.length ?? 0} bound rigidly).`)
  lines.push(`Weights: ${w.unweighted_vertices} unweighted vertices, at most ${w.max_influences} influences per vertex.`)
  if (report.symmetry) lines.push(`Symmetry: ${report.symmetry.applied ? 'applied' : 'not applied'} (${Math.round(report.symmetry.coverage * 100)}% of the mesh matched its mirror).`)
  if (report.pose_check) {
    const poses = Object.entries(report.pose_check)
    const worstVol = poses.reduce((a, b) => (b[1].min_volume_ratio < a[1].min_volume_ratio ? b : a))
    const worstStretch = poses.reduce((a, b) => (b[1].max_edge_stretch > a[1].max_edge_stretch ? b : a))
    lines.push(`Extreme-pose check: worst volume ${Math.round(worstVol[1].min_volume_ratio * 100)}% of rest (${worstVol[0].replace(/_/g, ' ')}), worst stretch ×${worstStretch[1].max_edge_stretch} (${worstStretch[0].replace(/_/g, ' ')}).`)
    const spikes = poses.reduce((n, [, m]) => n + m.stretched_edges, 0)
    if (spikes) lines.push(`Warning: ${spikes} edges stretched more than 2.5× in a test pose. Check the markers near the joints.`)
  }
  for (const w of report.warnings || []) lines.push(`Warning: ${w}`)
  if (report.proxy?.solver_unweighted && report.proxy?.method === 'heat') lines.push(`Note: the weight solver missed ${report.proxy.solver_unweighted} proxy vertices; they were filled from the nearest weighted ones.`)
  return lines.join('\n')
}

// ---- time estimates ----------------------------------------------------------------------------
// Before a run: a rough range from the vertex count (scaled by how long this computer took last time).
// During a run: extrapolated from real progress, which already reflects this machine and this model.
const CAL_KEY = 'animare.autorig.speed'

export function loadSpeedFactor() {
  try {
    const v = parseFloat(localStorage.getItem(CAL_KEY))
    return Number.isFinite(v) && v > 0.2 && v < 10 ? v : 1
  } catch {
    return 1
  }
}

export function saveSpeedFactor(verts, actualSeconds) {
  try {
    const mid = estimateRigSeconds(verts, 1)
    const expected = (mid.low + mid.high) / 2
    if (expected > 0 && actualSeconds > 0) localStorage.setItem(CAL_KEY, String(Math.min(10, Math.max(0.2, actualSeconds / expected))))
  } catch {
    /* storage unavailable */
  }
}

export function estimateRigSeconds(verts, speedFactor = 1) {
  const base = (6 + (verts || 0) / 2500) * speedFactor
  return { low: Math.max(3, Math.round(base * 0.6)), high: Math.max(6, Math.round(base * 1.8)) }
}

// null until there is enough progress to say anything honest.
export function etaSeconds(frac, elapsedSeconds) {
  if (!(frac >= 0.15) || elapsedSeconds < 3) return null
  return Math.max(0, (elapsedSeconds * (1 - frac)) / frac)
}

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return ''
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export function countVertices(root) {
  let n = 0
  root.traverse((o) => {
    const p = o.geometry?.getAttribute?.('position')
    if (p) n += p.count
  })
  return n
}
