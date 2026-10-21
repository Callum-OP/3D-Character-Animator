// Smallest uniform scale the resize dials / exact-size box will go to. It used to be 0.01,
// which stopped small things (a status LED, a screw, a tiny light source) from being shrunk
// far enough. Kept above zero so a scale never collapses to nothing (a zero scale can't be
// recovered with the dial, and breaks matrix inverses).
export const MIN_UNIFORM_SCALE = 0.0001

export function clampUniformScale(value) {
  return Math.max(MIN_UNIFORM_SCALE, value)
}

// Readout for a scale factor: two decimals normally, more as it gets small so a tiny
// size doesn't just read "0.00×".
export function formatScale(value) {
  if (!Number.isFinite(value)) return '1.00'
  const abs = Math.abs(value)
  if (abs >= 0.1) return value.toFixed(2)
  if (abs >= 0.01) return value.toFixed(3)
  return value.toFixed(4)
}
