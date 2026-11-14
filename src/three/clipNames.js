export function uniqueClipName(name, used) {
  const base = name || 'Clip'
  let result = base
  for (let n = 2; used.has(result); n++) result = `${base} ${n}`
  return result
}

export function makeClipNamesUnique(clips, existing = []) {
  const used = new Set(existing.map((clip) => clip.name))
  // Keep later clips' original names available before assigning suffixes.
  const reserved = new Set([...used, ...clips.map((clip) => clip.name || 'Clip')])
  for (const clip of clips) {
    const base = clip.name || 'Clip'
    if (used.has(base)) {
      clip.name = uniqueClipName(base, reserved)
    } else {
      clip.name = base
    }
    used.add(clip.name)
    reserved.add(clip.name)
  }
}
