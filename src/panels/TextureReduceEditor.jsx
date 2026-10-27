import { useStore } from '../store.js'
import { applyModelMaterials } from '../three/scene.js'
import { recordOverrideEdit } from '../three/materialHistory.js'
import { getOriginalMaterials } from '../three/surfaceMaterials.js'
import { TEXTURE_SIZES, textureStats } from '../three/textureReduce.js'

// Reduce texture size for the selected part(s): caps how big their textures can be (for example
// 4096 -> 512 px), so a high-resolution model uses far less graphics memory and the exported file
// shrinks. Non-destructive — "Original" brings every texture back (see three/textureReduce.js).

const STEPS = [null, ...TEXTURE_SIZES] // null = as loaded
const megabytes = (bytes) => {
  const mb = bytes / (1024 * 1024)
  return mb >= 10 ? `${Math.round(mb)} MB` : mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(0.01, mb).toFixed(2)} MB`
}

export default function TextureReduceEditor({ selectedMeshUuids, primaryUuid, resolveMesh }) {
  const meshOverrides = useStore((s) => s.meshOverrides)
  const setMeshesTextureMax = useStore((s) => s.setMeshesTextureMax)

  const primary = resolveMesh(primaryUuid)
  if (!primary) return null

  const materials = []
  for (const uuid of selectedMeshUuids) {
    const loaded = getOriginalMaterials(resolveMesh(uuid))
    for (const m of Array.isArray(loaded) ? loaded : loaded ? [loaded] : []) if (m) materials.push(m)
  }
  const current = (meshOverrides[primaryUuid] && meshOverrides[primaryUuid].textureMax) || null
  const none = textureStats(materials, null)
  if (!none.count) return null // no textures that can be resized

  const stats = textureStats(materials, current)
  const step = Math.max(0, STEPS.indexOf(current))
  const parts = selectedMeshUuids.length

  function commit(max) {
    recordOverrideEdit(selectedMeshUuids, () => setMeshesTextureMax(selectedMeshUuids, max))
    applyModelMaterials()
  }

  return (
    <details className="joint-controls" style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer' }}>
        <span className="joint-name">Reduce texture size</span>{' '}
        <span className="joint-parent">{current ? `${current} px or smaller` : 'smaller textures, smaller files'}</span>
      </summary>
      <div style={{ marginTop: 8 }}>
        <label className="slider-row" title="The biggest a texture of this part may be, in pixels on its longest side. Textures that are already smaller are left alone.">
          <span className="slider-label">Largest texture</span>
          <input
            type="range"
            aria-label="Largest texture"
            min={0}
            max={STEPS.length - 1}
            step={1}
            value={step}
            onChange={(e) => commit(STEPS[Number(e.target.value)])}
          />
          <span style={{ minWidth: 62, textAlign: 'right' }}>{current ? `${current} px` : 'Original'}</span>
        </label>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0' }}>
          <button type="button" className={`btn ${current ? 'secondary' : ''}`} onClick={() => commit(null)}>
            Original
          </button>
          {[2048, 1024, 512, 256, 128].map((size) => (
            <button key={size} type="button" className={`btn ${current === size ? '' : 'secondary'}`} onClick={() => commit(size)}>
              {size}
            </button>
          ))}
        </div>

        <div className="joint-parent" style={{ marginTop: 6 }}>
          {`${parts > 1 ? `${parts} parts · ` : ''}${none.count} texture${none.count === 1 ? '' : 's'}, largest ${none.largest} px`}
          {stats.reducedCount > 0
            ? ` · ${stats.reducedCount} made smaller · about ${megabytes(stats.bytesBefore)} → ${megabytes(stats.bytesAfter)} of graphics memory`
            : ` · about ${megabytes(stats.bytesBefore)} of graphics memory`}
        </div>
        <div className="joint-parent" style={{ marginTop: 4, opacity: 0.8 }}>
          The saved / exported model uses the smaller textures. Compressed textures can't be resized and are left as they are.
        </div>
      </div>
    </details>
  )
}
