import { useRef } from 'react'
import { useStore } from '../store.js'
import { loadModelFile, disposeCurrentModel } from '../three/scene.js'

// Side-panel section: load a model (button or drop), and show its stats.
export default function ModelPanel() {
  const fileInputRef = useRef(null)
  const modelInfo = useStore((s) => s.modelInfo)
  const loading = useStore((s) => s.loading)
  const loadError = useStore((s) => s.loadError)

  function onPick(e) {
    const file = e.target.files && e.target.files[0]
    if (file) loadModelFile(file).catch(() => {})
    e.target.value = '' // allow re-loading the same file
  }

  return (
    <div className="panel">
      <h2>Model</h2>

      <button className="btn" onClick={() => fileInputRef.current?.click()} disabled={loading}>
        {loading ? 'Loading…' : 'Load .glb / .gltf'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
        style={{ display: 'none' }}
        onChange={onPick}
      />

      {!modelInfo && !loadError && (
        <div className="dropzone">…or drag a file onto the viewport</div>
      )}

      {loadError && <div className="error">{loadError}</div>}

      {modelInfo && (
        <>
          <div style={{ marginTop: 12 }}>
            <div className="info-row">
              <span className="label">Name</span>
              <span className="value">{modelInfo.name}</span>
            </div>
            <div className="info-row">
              <span className="label">Meshes</span>
              <span className="value">{modelInfo.meshCount}</span>
            </div>
            <div className="info-row">
              <span className="label">Bones</span>
              <span className="value">{modelInfo.boneCount}</span>
            </div>
            <div className="info-row">
              <span className="label">Clips</span>
              <span className="value">{modelInfo.clipNames.length}</span>
            </div>
          </div>

          {modelInfo.clipNames.length > 0 && (
            <ul className="clip-list">
              {modelInfo.clipNames.map((name, i) => (
                <li key={i}>{name || '(unnamed clip)'}</li>
              ))}
            </ul>
          )}

          <button
            className="btn secondary"
            style={{ marginTop: 12 }}
            onClick={() => disposeCurrentModel()}
          >
            Unload model
          </button>
        </>
      )}
    </div>
  )
}
