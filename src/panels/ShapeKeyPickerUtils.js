// Every shape key on the character, by unique name: { name, targets: [{ mesh, idx }] }.
export function collectShapeKeys(meshes) {
  const byName = new Map()
  for (const mesh of meshes || []) {
    const dict = mesh.morphTargetDictionary
    if (!dict || !mesh.morphTargetInfluences) continue
    for (const [name, idx] of Object.entries(dict)) {
      if (!byName.has(name)) byName.set(name, { name, targets: [] })
      byName.get(name).targets.push({ mesh, idx })
    }
  }
  return [...byName.values()]
}

export const readShapeKey = (key) => key.targets[0].mesh.morphTargetInfluences[key.targets[0].idx] ?? 0

export function writeShapeKey(key, value) {
  const v = Math.min(1, Math.max(0, value))
  for (const { mesh, idx } of key.targets) mesh.morphTargetInfluences[idx] = v
  return v
}
