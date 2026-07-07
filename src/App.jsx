import Viewport from './three/Viewport.jsx'
import ModelPanel from './panels/ModelPanel.jsx'
import ViewPanel from './panels/ViewPanel.jsx'

// Top-level layout: 3D viewport on the left, control sidebar on the right.
export default function App() {
  return (
    <div className="app">
      <Viewport />
      <aside className="sidebar">
        <h1 className="app-title">
          3D Character Poser
          <small>Phase 1 — load &amp; orbit</small>
        </h1>
        <ModelPanel />
        <ViewPanel />
      </aside>
    </div>
  )
}
