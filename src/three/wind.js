let enabled = false
let direction = [1, 0, 0]
let strength = 5
let fluctuation = 1
let elapsed = 0

export function setWindConfig(isEnabled, vector, force, variation = 1) {
  const values = Array.from({ length: 3 }, (_, i) => {
    const value = Number(vector?.[i])
    return Number.isFinite(value) ? value : 0
  })
  const length = Math.hypot(...values)
  direction = length > 1e-8 ? values.map((value) => value / length) : [0, 0, 0]
  enabled = isEnabled === true
  if (!enabled) elapsed = 0
  const value = Number(force)
  strength = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0
  const amount = Number(variation)
  fluctuation = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0
}

export function advanceWind(dt) {
  if (enabled && Number.isFinite(dt) && dt > 0) elapsed += Math.min(dt, 0.1)
}

export function applyWind(target, scale = 1) {
  if (!enabled || strength === 0) return target.set(0, 0, 0)
  const gust = 1 + fluctuation * (0.24 * Math.sin(elapsed * 0.8) + 0.12 * Math.sin(elapsed * 1.9))
  const sway = fluctuation * 0.4 * Math.sin(elapsed * 1.15)
  let lateralX = -direction[2]
  let lateralZ = direction[0]
  const lateralLength = Math.hypot(lateralX, lateralZ)
  if (lateralLength < 1e-8) {
    lateralX = 1
    lateralZ = 0
  } else {
    lateralX /= lateralLength
    lateralZ /= lateralLength
  }
  const x = direction[0] + lateralX * sway
  const y = direction[1]
  const z = direction[2] + lateralZ * sway
  const length = Math.hypot(x, y, z) || 1
  const magnitude = strength * gust * scale
  return target.set(
    (x / length) * magnitude,
    (y / length) * magnitude,
    (z / length) * magnitude,
  )
}
