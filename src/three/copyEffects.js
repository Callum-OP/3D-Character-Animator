import { useStore } from '../store.js'
import { getCharacterModelById, getCurrentModel, refreshSoftCloth } from './scene.js'
import { runAsOneSceneStep } from './sceneHistory.js'
import { recordOverrideEdit } from './materialHistory.js'
import { regionVertexCount, toRanges, fromRanges } from './regions.js'
import { applyPartRig, getPartRigEntries, uniqueRigLabel } from './partRig.js'
import { addDangleChainUndoable, collectDescendantBoneNames, getDangleChainsForRig } from './dangle.js'
import { newZoneId } from './softcloth.js'

// Copy "Add bones" rigs and Mesh Physics (soft cloth / swing zones) from one character, or one mesh, to another.
//
// Parts are matched by NAME (the n-th mesh called "Hair" on one character is the n-th "Hair" on the other) and
// bones by name. Where both meshes have the same number of faces, face numbers carry straight over, so the
// proportions of the two characters hardly matter: the bones are rebuilt from the target's own geometry. Where
// the face counts differ the area is carried over by POSITION (each mesh scaled to its own bounding box), which
// is approximate and works best when the two characters are built to similar proportions.
//
// Everything a copy does is ONE undo step.

const NEAR_LIMIT = 0.12 // least reach (in bounding-box units) for a target face to take the place of a source face; a coarse source gets more

// --- matching ------------------------------------------------------------------------------------------

// Blender numbers duplicated meshes (Hoodie.001, Hoodie.002) and the loader drops the dot, so the same part can be
// called Hoodie001 on one character and Hoodie002 on another (Hoodie001_1 / Hoodie002_1 for its extra materials).
// For matching, that number is ignored.
export function baseMeshName(name) {
  return (name || '').replace(/([A-Za-z])\.?\d{3,}(?=(_\d+)?$)/, '$1')
}

// Pair meshes up by name: the n-th mesh called X on one character is the n-th mesh called X on the other.
function pairByName(sources, targets, nameOf) {
  const pool = new Map()
  for (const mesh of targets) {
    const name = nameOf(mesh.name)
    if (!name) continue
    if (!pool.has(name)) pool.set(name, [])
    pool.get(name).push(mesh)
  }
  const seen = new Map()
  const pairs = []
  const left = []
  for (const src of sources) {
    const name = nameOf(src.name)
    if (!name) continue
    const n = seen.get(name) || 0
    seen.set(name, n + 1)
    const tgt = pool.get(name)?.[n]
    if (tgt) pairs.push({ src, tgt })
    else left.push(src)
  }
  return { pairs, left }
}

// Same-named meshes of two characters. Exact names first; whatever is left is matched again ignoring the
// duplicate numbers above. `missing` lists the source parts that found no partner.
export function matchMeshes(sourceModel, targetModel) {
  const sources = (sourceModel?.meshes || []).filter((m) => m.name)
  const targets = targetModel?.meshes || []
  const exact = pairByName(sources, targets, (name) => name)
  const taken = new Set(exact.pairs.map((p) => p.tgt))
  const loose = pairByName(exact.left, targets.filter((m) => !taken.has(m)), baseMeshName)
  return {
    pairs: [...exact.pairs, ...loose.pairs],
    missing: loose.left.map((m) => m.name),
  }
}

// --- carrying faces over -------------------------------------------------------------------------------

function faceCentroids(mesh) {
  const geo = mesh.geometry
  const pos = geo.attributes.position
  const index = geo.index
  const n = Math.floor((index ? index.count : pos.count) / 3)
  const out = new Float32Array(n * 3)
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(t * 3 + k) : t * 3 + k
      out[t * 3] += pos.getX(v) / 3
      out[t * 3 + 1] += pos.getY(v) / 3
      out[t * 3 + 2] += pos.getZ(v) / 3
    }
  }
  return out
}

// Scale each axis to 0..1 over the mesh's own extent, so a bigger or taller character lines up with a smaller one.
function normalise(c) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < c.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (c[i + a] < min[a]) min[a] = c[i + a]
      if (c[i + a] > max[a]) max[a] = c[i + a]
    }
  }
  const out = new Float32Array(c.length)
  for (let i = 0; i < c.length; i += 3) {
    for (let a = 0; a < 3; a++) out[i + a] = (c[i + a] - min[a]) / (max[a] - min[a] || 1)
  }
  return out
}

function nearestFinder(norm) {
  const G = 24
  const cells = new Map()
  const cellOf = (v) => Math.min(G - 1, Math.max(0, Math.floor(v * G)))
  const key = (x, y, z) => (x * G + y) * G + z
  for (let t = 0; t < norm.length / 3; t++) {
    const k = key(cellOf(norm[t * 3]), cellOf(norm[t * 3 + 1]), cellOf(norm[t * 3 + 2]))
    if (!cells.has(k)) cells.set(k, [])
    cells.get(k).push(t)
  }
  return (x, y, z) => {
    const cx = cellOf(x), cy = cellOf(y), cz = cellOf(z)
    let best = -1
    let bestD = Infinity
    for (let r = 0; r <= G; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
            const gx = cx + dx, gy = cy + dy, gz = cz + dz
            if (gx < 0 || gy < 0 || gz < 0 || gx >= G || gy >= G || gz >= G) continue
            const list = cells.get(key(gx, gy, gz))
            if (!list) continue
            for (const t of list) {
              const d = (norm[t * 3] - x) ** 2 + (norm[t * 3 + 1] - y) ** 2 + (norm[t * 3 + 2] - z) ** 2
              if (d < bestD) { bestD = d; best = t }
            }
          }
        }
      }
      if (best >= 0 && bestD <= (r / G) ** 2) break
    }
    return { index: best, dist: Math.sqrt(bestD) }
  }
}

// The faces of `tgt` that stand where `srcTris` stand on `src`. approx is true when positions had to be used.
export function mapTris(src, tgt, srcTris) {
  if (!srcTris.length) return { tris: [], approx: false }
  if (regionVertexCount(src.geometry) === regionVertexCount(tgt.geometry)) return { tris: [...srcTris], approx: false }
  const srcNorm = normalise(faceCentroids(src))
  const tgtNorm = normalise(faceCentroids(tgt))
  const selected = new Set(srcTris)
  const nearest = nearestFinder(srcNorm)
  // a coarse source mesh has big faces, so its nearest face can be a long way off; allow for that
  const limit = Math.max(NEAR_LIMIT, 1.5 / Math.sqrt(srcNorm.length / 3))
  const tris = []
  for (let t = 0; t < tgtNorm.length / 3; t++) {
    const hit = nearest(tgtNorm[t * 3], tgtNorm[t * 3 + 1], tgtNorm[t * 3 + 2])
    if (hit.index >= 0 && hit.dist <= limit && selected.has(hit.index)) tris.push(t)
  }
  return { tris, approx: true }
}

// --- the other character's data -----------------------------------------------------------------------

// Dangle chains and per-mesh settings of any loaded character (the active one lives at the top of the store).
function characterData(id) {
  const s = useStore.getState()
  if (id === s.activeCharacterId) return { dangleChains: s.dangleChains || [], meshOverrides: s.meshOverrides || {} }
  const saved = s.characters?.[id]
  return { dangleChains: saved?.dangleChains || [], meshOverrides: saved?.meshOverrides || {} }
}

export function characterNameOf(id) {
  return useStore.getState().sceneObjects.find((o) => o.isCharacter && o.id === id)?.name || id
}

// Loaded characters other than the active one, with how much each has to copy.
export function listCopySources() {
  const s = useStore.getState()
  return s.characterOrder
    .filter((id) => id !== s.activeCharacterId)
    .map((id) => {
      const model = getCharacterModelById(id)
      if (!model) return null
      const overrides = characterData(id).meshOverrides
      const rigs = getPartRigEntries(model).filter((e) => e.result).length
      const physicsParts = (model.meshes || []).filter((m) => (overrides[m.uuid]?.softZones || []).length).length
      return { id, name: characterNameOf(id), rigs, physicsParts }
    })
    .filter(Boolean)
}

// Meshes (of every loaded character, the active one included) that have something to copy to `targetMesh`.
export function listMeshCopySources(kind, targetMesh) {
  const s = useStore.getState()
  const out = []
  for (const id of s.characterOrder) {
    const model = getCharacterModelById(id)
    if (!model) continue
    const overrides = characterData(id).meshOverrides
    const rigMeshes = new Set(getPartRigEntries(model).filter((e) => e.result).flatMap((e) => (e.result.meshes || [e.result]).map((r) => r.mesh)))
    for (const mesh of model.meshes || []) {
      if (mesh === targetMesh) continue
      const has = kind === 'bones' ? rigMeshes.has(mesh) : (overrides[mesh.uuid]?.softZones || []).length > 0
      if (has) out.push({ characterId: id, characterName: characterNameOf(id), mesh })
    }
  }
  return out
}

// --- copying added bones ------------------------------------------------------------------------------

function stripIdentity(chain) {
  // eslint-disable-next-line no-unused-vars
  const { id, name, boneNames, groupId, groupName, ...settings } = chain
  return settings
}

// Rebuild `source`'s Add bones rigs on `target` (the ACTIVE character) for the given part pairs.
function copyRigs(source, sourceId, target, pairs, { missingParts = [] } = {}) {
  const result = { copied: [], skipped: [], notes: [], approx: false, matched: pairs.length, unmatched: missingParts }
  const sourceEntries = getPartRigEntries(source).filter((e) => e.result)
  const sourceChains = characterData(sourceId).dangleChains
  const boneMap = new Map() // a copied rig's source bone name -> the new bone name (for rigs hanging off other rigs)
  const missing = new Set(missingParts)
  const alreadyThere = new Set(getPartRigEntries(target)) // rigs the target had before this copy started

  for (const entry of sourceEntries) {
    const srcMeshes = (entry.result.meshes || [entry.result]).map((r) => r.mesh)
    const ranges = entry.trisByMesh || [entry.tris || []]
    const usable = []
    srcMeshes.forEach((src, i) => {
      const pair = pairs.find((p) => p.src === src)
      if (pair) usable.push({ pair, srcTris: fromRanges(ranges[i] || []) })
    })
    if (!usable.length) {
      if (srcMeshes.some((m) => missing.has(m.name))) result.skipped.push({ label: entry.label, reason: 'its part is not on this character' })
      continue
    }
    const selections = []
    let approx = false
    for (const { pair, srcTris } of usable) {
      const mapped = mapTris(pair.src, pair.tgt, srcTris)
      approx = approx || mapped.approx
      if (mapped.tris.length) selections.push({ mesh: pair.tgt, tris: mapped.tris })
    }
    if (!selections.length) {
      result.skipped.push({ label: entry.label, reason: 'no matching area found on this character' })
      continue
    }
    const meshes = selections.map((s) => s.mesh)
    if ([...alreadyThere].some((e) => e.label === entry.label && (e.meshNames || [e.meshName]).join('|') === meshes.map((m) => m.name || '').join('|'))) {
      result.skipped.push({ label: entry.label, reason: 'this character already has a rig with that name on that part' })
      continue
    }

    const options = { ...(entry.options || {}) }
    if (options.parentBoneName) {
      const mapped = boneMap.get(options.parentBoneName)
      if (mapped) {
        options.parentBoneName = mapped
        options.allowAddedBoneAttachment = true
      } else if (!(target.bones || []).some((b) => b.name === options.parentBoneName)) {
        result.notes.push(`${entry.label}: bone “${options.parentBoneName}” not found, attached automatically`)
        options.parentBoneName = null
      }
    }
    const label = uniqueRigLabel(target, entry.label)
    const res = applyPartRig(target, meshes, selections, options, { label })
    if (!res.ok) {
      result.skipped.push({ label: entry.label, reason: res.reason })
      continue
    }
    if (entry.boneNames.length === res.entry.boneNames.length) entry.boneNames.forEach((name, i) => boneMap.set(name, res.entry.boneNames[i]))

    // swing physics: start each new chain from the matching chain of the source rig
    const chains = getDangleChainsForRig(sourceChains, entry, sourceEntries)
    if (chains.length) {
      res.entry.rootBoneNames.forEach((root, i) => {
        const settings = stripIdentity(chains[i] || chains[0])
        addDangleChainUndoable(
          res.entry.rootBoneNames.length > 1 ? `${res.entry.label} ${i + 1}` : res.entry.label,
          collectDescendantBoneNames(target, root, 64),
          settings.type === 'cloth' ? 'cloth' : 'dangle',
          { id: res.entry.id, name: res.entry.label },
          settings,
        )
      })
    }
    result.copied.push({ label: res.entry.label, bones: res.entry.boneNames.length, physics: chains.length > 0 })
    result.approx = result.approx || approx
  }
  return result
}

export function copyAddedBonesFromCharacter(sourceId) {
  const target = getCurrentModel()
  const source = getCharacterModelById(sourceId)
  if (!target || !source) return null
  const { pairs, missing } = matchMeshes(source, target)
  return runAsOneSceneStep(() => copyRigs(source, sourceId, target, pairs, { missingParts: missing }))
}

// Rigs that touch `sourceMesh`, rebuilt on `targetMesh` only (the part of each rig that lies on that mesh).
export function copyAddedBonesFromMesh(sourceCharacterId, sourceMesh, targetMesh) {
  const target = getCurrentModel()
  const source = getCharacterModelById(sourceCharacterId)
  if (!target || !source) return null
  return runAsOneSceneStep(() => copyRigs(source, sourceCharacterId, target, [{ src: sourceMesh, tgt: targetMesh }]))
}

// --- copying mesh physics -----------------------------------------------------------------------------

function copyZones(sourceOverrides, pairs, unmatched = []) {
  const result = { copied: 0, parts: 0, skipped: [], notes: [], approx: false, matched: pairs.length, unmatched }
  const current = useStore.getState().meshOverrides
  const updates = {}
  for (const { src, tgt } of pairs) {
    const zones = sourceOverrides[src.uuid]?.softZones || []
    if (!zones.length) continue
    const existing = current[tgt.uuid]?.softZones || []
    const added = []
    for (const zone of zones) {
      let area = zone.area || { kind: 'all' }
      if (area.kind === 'tris') {
        const mapped = mapTris(src, tgt, fromRanges(area.tris || []))
        result.approx = result.approx || mapped.approx
        if (!mapped.tris.length) {
          result.skipped.push({ label: zone.name || 'Zone', reason: `no matching area on ${tgt.name || 'the part'}` })
          continue
        }
        area = { ...area, tris: toRanges(mapped.tris), vertexCount: regionVertexCount(tgt.geometry) }
      }
      const duplicate = [...existing, ...added].some((z) => z.mode === zone.mode && z.name === zone.name && JSON.stringify(z.area) === JSON.stringify(area))
      if (duplicate) {
        result.skipped.push({ label: zone.name || 'Zone', reason: 'already there' })
        continue
      }
      added.push({ ...JSON.parse(JSON.stringify(zone)), id: newZoneId(), area })
    }
    if (added.length) {
      updates[tgt.uuid] = [...existing, ...added]
      result.copied += added.length
      result.parts++
    }
  }
  const uuids = Object.keys(updates)
  if (uuids.length) {
    runAsOneSceneStep(() => {
      recordOverrideEdit(uuids, () => uuids.forEach((uuid) => useStore.getState().setMeshSoftZones(uuid, updates[uuid])), null, { discrete: true })
    })
    refreshSoftCloth()
  }
  return result
}

export function copyMeshPhysicsFromCharacter(sourceId) {
  const target = getCurrentModel()
  const source = getCharacterModelById(sourceId)
  if (!target || !source) return null
  const { pairs, missing } = matchMeshes(source, target)
  return copyZones(characterData(sourceId).meshOverrides, pairs, missing)
}

export function copyMeshPhysicsFromMesh(sourceCharacterId, sourceMesh, targetMesh) {
  if (!getCurrentModel()) return null
  return copyZones(characterData(sourceCharacterId).meshOverrides, [{ src: sourceMesh, tgt: targetMesh }])
}

// --- wording for the panel ----------------------------------------------------------------------------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

export function describeBonesCopy(r) {
  if (!r) return 'Nothing to copy from.'
  const parts = []
  if (r.matched === 0) return 'No parts with matching names were found on this character, so nothing was copied.'
  if (r.copied.length) parts.push(`Copied ${plural(r.copied.length, 'rig')} (${r.copied.map((c) => c.label).join(', ')}).`)
  else parts.push('Nothing was copied.')
  if (r.unmatched?.length) parts.push(`No matching part for: ${r.unmatched.join(', ')}.`)
  if (r.skipped.length) parts.push(`Skipped: ${r.skipped.map((s) => `${s.label} (${s.reason})`).join('; ')}.`)
  if (r.notes.length) parts.push(`${r.notes.join('; ')}.`)
  if (r.approx) parts.push('The meshes differ, so the areas were matched by position. Check the result.')
  if (r.copied.length) parts.push('Ctrl+Z undoes it.')
  return parts.join(' ')
}

export function describePhysicsCopy(r) {
  if (!r) return 'Nothing to copy from.'
  const parts = []
  if (r.matched === 0) return 'No parts with matching names were found on this character, so nothing was copied.'
  if (r.copied) parts.push(`Copied ${plural(r.copied, 'effect')} onto ${plural(r.parts, 'part')}.`)
  else parts.push('Nothing was copied.')
  if (r.unmatched?.length) parts.push(`No matching part for: ${r.unmatched.join(', ')}.`)
  if (r.skipped.length) parts.push(`Skipped: ${r.skipped.map((s) => `${s.label} (${s.reason})`).join('; ')}.`)
  if (r.approx) parts.push('The meshes differ, so the areas were matched by position. Check the result.')
  if (r.copied) parts.push('Ctrl+Z undoes it.')
  return parts.join(' ')
}
