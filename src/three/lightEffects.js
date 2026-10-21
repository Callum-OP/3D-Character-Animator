// ---------------------------------------------------------------------------
// Light effects: built-in looping animations for a placed light.
//
//   flickerSoft  gentle wavering - a candle, a campfire, a tired bulb
//   flickerHard  sharp on / off stutter - a faulty tube light, a dying neon sign
//   lighthouse   the beam sweeps all the way round, slowly, with a soft glow around the lamp
//
// Everything here is a PURE function of (effect settings, time in seconds): no state, no
// THREE, no randomness that is not seeded. That is deliberate. The same numbers can be
// evaluated at any time (scrubbing, recording a video, a test) and can be SAMPLED into plain
// keyframes - e.g. a light's intensity every 1/30 s for an export to Blender or a game engine,
// or a lighthouse's rotation as an ordinary node rotation animation. lights.js applies them to
// the live light each frame without ever changing the light's own saved settings.
// ---------------------------------------------------------------------------

export const LIGHT_EFFECT_TYPES = [
  { id: 'flickerSoft', label: 'Flicker (soft)', hint: 'Gentle wavering, like a candle, a campfire or a tired bulb' },
  { id: 'flickerHard', label: 'Flicker (hard)', hint: 'Sharp on / off stutter, like a faulty tube light or a dying neon sign' },
  { id: 'lighthouse', label: 'Lighthouse', hint: 'A beam that sweeps all the way round, with a soft glow around the lamp' },
]

export const FLICKER_TYPES = ['flickerSoft', 'flickerHard']

export const MIN_EFFECT_RATE = 0.1
export const MAX_EFFECT_RATE = 5
export const MIN_EFFECT_PERIOD = 1 // seconds per full turn
export const MAX_EFFECT_PERIOD = 120
export const DEFAULT_EFFECT_PERIOD = 10

// How dim a "hard" flicker gets when it is off (not quite black: a dying tube still glows).
export const HARD_FLICKER_LOW = 0.04
// How dim a "soft" flicker gets at its dimmest.
export const SOFT_FLICKER_LOW = 0.4

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : fallback)

export function isLightEffectType(type) {
  return LIGHT_EFFECT_TYPES.some((t) => t.id === type)
}

// Clean up an effect description from anywhere (saved project, UI patch, preset): returns a
// fresh { type, consistent, rate, period, seed } or null when there is no (valid) effect.
//   consistent  false = random and irregular (faulty light, crackling fire); true = a steady,
//               repeating rhythm
//   rate        flicker speed multiplier (1 = normal)
//   period      lighthouse: seconds for one full turn
//   seed        makes two lights flicker differently from each other
export function normalizeLightEffect(effect) {
  if (!effect || !isLightEffectType(effect.type)) return null
  return {
    type: effect.type,
    consistent: !!effect.consistent,
    rate: clamp(num(effect.rate, 1), MIN_EFFECT_RATE, MAX_EFFECT_RATE),
    period: clamp(num(effect.period, DEFAULT_EFFECT_PERIOD), MIN_EFFECT_PERIOD, MAX_EFFECT_PERIOD),
    seed: Math.floor(Math.abs(num(effect.seed, 0))) % 1000,
  }
}

// --- seeded noise ---------------------------------------------------------------------

// Deterministic pseudo-random number in [0, 1) for any input.
function hash01(n) {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return s - Math.floor(s)
}

// Smooth value noise in [0, 1]: random values at whole numbers, eased in between.
function smoothNoise(x) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return hash01(i) * (1 - u) + hash01(i + 1) * u
}

const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

// --- the effects ----------------------------------------------------------------------

// Brightness multiplier (0..1, applied to the light's own intensity) of a flicker effect at
// time t seconds. 1 = the light's normal brightness, so the saved intensity is the MAX. Any
// other effect type (or none) gives 1.
export function flickerLevel(effect, t) {
  const fx = normalizeLightEffect(effect)
  if (!fx || !FLICKER_TYPES.includes(fx.type)) return 1
  const x = Math.max(0, t) * fx.rate
  const s = fx.seed

  if (fx.type === 'flickerSoft') {
    if (fx.consistent) {
      // Two gentle waves that line up again every 1 / (1.5 * rate) seconds: a steady shimmer.
      const p = x * 1.5
      return clamp(0.7 + 0.2 * Math.sin(2 * Math.PI * p) + 0.1 * Math.sin(2 * Math.PI * 3 * p + 1.3), SOFT_FLICKER_LOW, 1)
    }
    // Three layers of smooth noise at different speeds: slow drift + quick crackle.
    const n = 0.55 * smoothNoise(x * 6 + s * 17.1) + 0.3 * smoothNoise(x * 15 + s * 3.7 + 11) + 0.15 * smoothNoise(x * 31 + s * 5.3 + 5)
    return SOFT_FLICKER_LOW + (1 - SOFT_FLICKER_LOW) * smoothstep(0.15, 0.85, n)
  }

  // flickerHard
  if (fx.consistent) {
    // A regular blink: on for 60 % of every cycle, 2.5 cycles a second at rate 1.
    const ph = x * 2.5 - Math.floor(x * 2.5)
    return ph < 0.6 ? 1 : HARD_FLICKER_LOW
  }
  // A faulty tube: mostly steady, with sudden bursts of stutter now and then.
  const stuttering = hash01(Math.floor(x * 0.8) + s * 13.7) < 0.45
  if (!stuttering) return 1
  return hash01(Math.floor(x * 14) * 1.37 + s * 5.1 + 91) < 0.5 ? HARD_FLICKER_LOW : 1
}

// How far (radians, 0..2PI) a lighthouse beam has turned at time t. Clockwise seen from above.
export function lighthouseAngle(effect, t) {
  const fx = normalizeLightEffect(effect)
  if (!fx || fx.type !== 'lighthouse') return 0
  const turns = Math.max(0, t) / fx.period
  return (turns - Math.floor(turns)) * Math.PI * 2
}

// Sample an effect into plain keyframes - the bridge to other programs. Returns
// [{ time, value }]: `value` is the brightness multiplier for a flicker, or the turn angle
// in radians for a lighthouse. `fps` samples per second, from 0 to `duration` seconds.
export function sampleLightEffect(effect, duration, fps = 30) {
  const fx = normalizeLightEffect(effect)
  if (!fx) return []
  const count = Math.max(1, Math.round(duration * fps))
  const out = []
  for (let i = 0; i <= count; i++) {
    const time = i / fps
    out.push({ time, value: fx.type === 'lighthouse' ? lighthouseAngle(fx, time) : flickerLevel(fx, time) })
  }
  return out
}
