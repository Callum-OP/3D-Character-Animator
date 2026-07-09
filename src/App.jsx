import Viewport from './three/Viewport.jsx'
import ModelPanel from './panels/ModelPanel.jsx'
import MaterialPanel from './panels/MaterialPanel.jsx'
import ViewPanel from './panels/ViewPanel.jsx'

// Top-level layout: 3D viewport on the left, control sidebar on the right.
export default function App() {
  return (
    <div className="app">
      <Viewport />
      <aside className="sidebar">
        <h1 className="app-title">
          3D Character Poser
          <small>Phase 2 — materials</small>
        </h1>
        <ModelPanel />
        <MaterialPanel />
        <ViewPanel />
      </aside>
    </div>
  )
}
