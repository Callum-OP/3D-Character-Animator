import Viewport from './three/Viewport.jsx'
import ModelPanel from './panels/ModelPanel.jsx'
import MaterialPanel from './panels/MaterialPanel.jsx'
import BonePanel from './panels/BonePanel.jsx'
import MeshPanel from './panels/MeshPanel.jsx'
import AnimationPanel from './panels/AnimationPanel.jsx'
import ObjectsPanel from './panels/ObjectsPanel.jsx'
import CamerasPanel from './panels/CamerasPanel.jsx'
import ProjectPanel from './panels/ProjectPanel.jsx'
import ExportPanel from './panels/ExportPanel.jsx'
import ViewPanel from './panels/ViewPanel.jsx'
import HelpOverlay from './panels/HelpOverlay.jsx'
import { useStore } from './store.js'

// Top-level layout: 3D viewport on the left, control sidebar on the right.
// The Pose/Mesh panels are contextual — only the active mode's panel shows,
// like tool-specific panels in full animation apps. Everything else is fixed.
export default function App() {
  const toggleHelp = useStore((s) => s.toggleHelp)
  const mode = useStore((s) => s.mode)
  return (
    <div className="app">
      <Viewport />
      <aside className="sidebar">
        <div className="app-header">
          <div>
            <h1 className="app-title">3D Character Poser</h1>
            <div className="app-tagline">Pose &amp; animate characters for 2D art</div>
          </div>
          <button className="help-btn" title="Help & shortcuts (?)" onClick={toggleHelp}>
            ?
          </button>
        </div>
        <ModelPanel />
        <ProjectPanel />
        {mode === 'bone' && <BonePanel />}
        {mode === 'mesh' && <MeshPanel />}
        <AnimationPanel />
        <ObjectsPanel />
        <CamerasPanel />
        <MaterialPanel />
        <ViewPanel />
        <ExportPanel />
      </aside>
      <HelpOverlay />
    </div>
  )
}
