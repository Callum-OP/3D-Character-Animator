import { MAX_REGIONS, regionVertexCount, isRegionCapable } from './regions.js'

// "Turn a part into a light" should make the PART itself look lit, not only cast light. The glow
// is a region that covers every face of the part (one range, so it costs nothing), put FIRST so
// any regions the part already has still win where they overlap. Regions glow in every style.
export const GLOW_REGION_NAME = 'Glow'
export const DEFAULT_GLOW = 1.6

// The part's new region list with a whole-part glow in `colour`, or null when it cannot have
// one (rigged part, or already at the region limit).
export function withGlowRegion(mesh, regions, colour, glow = DEFAULT_GLOW) {
  if (!isRegionCapable(mesh)) return null
  const count = regionVertexCount(mesh.geometry)
  const nTris = Math.floor(count / 3)
  if (nTris < 1) return null
  const existing = regions.findIndex(
    (r) => r.name === GLOW_REGION_NAME && r.tris.length === 1 && r.tris[0][0] === 0 && r.tris[0][1] === nTris - 1,
  )
  const look = { glow, glowColor: colour }
  if (existing >= 0) return regions.map((r, i) => (i === existing ? { ...r, look: { ...r.look, ...look } } : r))
  if (regions.length >= MAX_REGIONS) return null
  return [{ id: 'glow' + Date.now().toString(36), name: GLOW_REGION_NAME, tris: [[0, nTris - 1]], vertexCount: count, look }, ...regions]
}
