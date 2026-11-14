// ---------------------------------------------------------------------------
// Small helpers for reading a BVH as TEXT, so the Pose Library can show a thumbnail or apply one pose from a
// long mocap file without parsing every frame.
// ---------------------------------------------------------------------------

// { frames, frameTime, duration } read from the MOTION header, or null when there isn't one.
export function bvhInfo(text) {
  const m = /^\s*Frames:\s*(\d+)/im.exec(text)
  const t = /^\s*Frame Time:\s*([0-9eE+\-.]+)/im.exec(text)
  if (!m) return null
  const frames = Number(m[1])
  const frameTime = t ? Number(t[1]) : 1 / 30
  return { frames, frameTime, duration: frames * frameTime }
}

// The same BVH cut down to ONE frame (`index`, clamped into range): everything before the frame lines is kept and
// the Frames: count is rewritten. Returns the new text.
export function bvhSingleFrame(text, index = 0) {
  const lines = text.split(/\r?\n/)
  const motion = lines.findIndex((l) => /^\s*MOTION\s*$/i.test(l))
  if (motion < 0) return text
  const framesAt = lines.findIndex((l, i) => i > motion && /^\s*Frames:/i.test(l))
  const timeAt = lines.findIndex((l, i) => i > motion && /^\s*Frame Time:/i.test(l))
  if (framesAt < 0 || timeAt < 0) return text
  const data = lines.slice(timeAt + 1).filter((l) => l.trim().length)
  if (!data.length) return text
  const pick = data[Math.max(0, Math.min(index, data.length - 1))]
  const head = lines.slice(0, framesAt)
  return [...head, 'Frames: 1', lines[timeAt], pick, ''].join('\n')
}
