// ---------------------------------------------------------------------------
// Finger bones, recognised by name and by sitting under a hand.
//
// bvh.js's classifyBone deliberately skips fingers (the mocap retargeter has no finger slots), so the
// pieces that DO care about fingers - the limb limits and the "Hide helper bones" filter - share this.
//
// A bone is a finger bone when its name carries a finger word (thumb, index, middle, ring, pinky /
// pinkie / little, or the numbered "Finger0..4" scheme) AND one of its ancestors is a hand. The hand
// requirement is what keeps "drawstring", "earring" and "index_card" props from being mistaken for
// fingers. Bones are numbered along their own finger: the one next to the hand is 1, its child 2, ...
// ---------------------------------------------------------------------------

const FINGER_WORDS = /^(thumb|index|middle|ring|pinky|pinkie|little)\d*$/
const NUMBERED = /^finger(\d)\d?(nub|end|tip)?$/
const NUMBERED_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky']
// Words that mark a bone as a finger TIP marker rather than a joint that bends.
const TIP_WORDS = new Set(['end', 'nub', 'tip', 'leaf', 'top'])

function tokens(name) {
  const base = String(name || '')
  const local = base.includes(':') ? base.slice(base.lastIndexOf(':') + 1) : base
  return local
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

// Which finger a bone NAME belongs to ('thumb' | 'index' | 'middle' | 'ring' | 'pinky'), or null.
export function fingerNameOf(name) {
  const parts = tokens(name)
  for (const part of parts) {
    const m = FINGER_WORDS.exec(part)
    if (m) return part.replace(/\d+$/, '').replace('pinkie', 'pinky').replace('little', 'pinky')
  }
  // "Finger0" ... "Finger4": the number picks the finger (Bip rigs)
  for (let i = 0; i < parts.length; i++) {
    const joined = parts[i] === 'finger' && /^\d+$/.test(parts[i + 1] || '') ? `finger${parts[i + 1]}` : parts[i]
    const m = NUMBERED.exec(joined)
    if (m && NUMBERED_NAMES[Number(m[1])]) return NUMBERED_NAMES[Number(m[1])]
  }
  // all-lowercase run-together names ("lefthandindex1") have no word breaks to split on
  const flat = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const tail = /(thumb|index|middle|ring|pinky|pinkie|little)\d*(end|nub|tip)?$/.exec(flat)
  if (tail) return tail[1].replace('pinkie', 'pinky').replace('little', 'pinky')
  return null
}

function hasTipWord(name) {
  const parts = tokens(name)
  while (parts.length && /^\d+$/.test(parts[parts.length - 1])) parts.pop() // "pinky_tip_01"
  return parts.length > 0 && TIP_WORDS.has(parts[parts.length - 1]) && fingerNameOf(name) !== null
}

function boneChildren(bone) {
  return (bone.children || []).filter((c) => c.isBone)
}

// { finger, segment, tip } for a finger bone, else null.
//   segment: 1 for the bone next to the hand, 2 for its child, ...
//   tip:     true for a marker at the end of a finger (named _end / Nub / tip, or a 4th bone past the three
//            that bend) - it carries no skin weight worth posing by hand.
// `isHand(bone)` says whether a bone is a hand (the caller knows its own classifier).
export function fingerInfo(bone, isHand) {
  if (!bone || !bone.isBone) return null
  const finger = fingerNameOf(bone.name)
  if (!finger) return null
  let segment = 1
  let underHand = false
  let child = bone
  for (let p = bone.parent; p && p.isBone; p = p.parent) {
    if (isHand(p)) {
      underHand = true
      break
    }
    if (p.name !== child.name && fingerNameOf(p.name) === finger) segment++
    child = p
  }
  if (!underHand) return null
  const leaf = boneChildren(bone).length === 0
  const tip = hasTipWord(bone.name) || (leaf && segment >= 4)
  return { finger, segment, tip }
}

// A name-only hand test for callers with no classifier of their own (loose: sided or not).
export function looksLikeHand(bone) {
  const name = bone && bone.name ? bone.name : ''
  return /hand|wrist/i.test(name) && fingerNameOf(name) === null
}
