import { useEffect, useState } from 'react'
import { getStats } from '../three/scene.js'

// Small corner readout proving the low-overhead claim: triangles, draw calls,
// GPU resource counts, JS heap, and FPS while an animation plays. Polls twice a
// second (cheap) rather than every frame.
export default function StatsOverlay() {
  const [stats, setStats] = useState(null)

  useEffect(() => {
    const tick = () => setStats(getStats())
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [])

  if (!stats) return null
  return (
    <div className="stats-overlay">
      {stats.fps != null && (
        <div>
          <span>FPS</span>
          <b>{stats.fps}</b>
        </div>
      )}
      <div>
        <span>Tris</span>
        <b>{stats.triangles.toLocaleString()}</b>
      </div>
      <div>
        <span>Draws</span>
        <b>{stats.calls}</b>
      </div>
      <div>
        <span>Geom</span>
        <b>{stats.geometries}</b>
      </div>
      <div>
        <span>Tex</span>
        <b>{stats.textures}</b>
      </div>
      {stats.heapMB != null && (
        <div>
          <span>Heap</span>
          <b>{stats.heapMB} MB</b>
        </div>
      )}
    </div>
  )
}
