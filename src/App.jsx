import Viewport from './three/Viewport.jsx'
import ModelPanel from './panels/ModelPanel.jsx'
import MaterialPanel from './panels/MaterialPanel.jsx'
import BonePanel from './panels/BonePanel.jsx'
import AnimationPanel from './panels/AnimationPanel.jsx'
import ViewPanel from './panels/ViewPanel.jsx'

// Top-level layout: 3D viewport on the left, control sidebar on the right.
export default function App() {
  return (
    <div className="app">
      <Viewport />
      <aside className="sidebar">
        <h1 className="app-title">
          3D Character Poser
          <small>Phase 4 — animation</small>
        </h1>
        <ModelPanel />
        <BonePanel />
        <AnimationPanel />
        <MaterialPanel />
        <ViewPanel />
      </aside>
    </div>
  )
}
