import Viewport from './three/Viewport.jsx'
import MaterialPanel from './panels/MaterialPanel.jsx'
import BonePanel from './panels/BonePanel.jsx'
import MeshPanel from './panels/MeshPanel.jsx'
import AnimationPanel from './panels/AnimationPanel.jsx'
import ObjectsPanel from './panels/ObjectsPanel.jsx'
import CamerasPanel from './panels/CamerasPanel.jsx'
import LightsPanel from './panels/LightsPanel.jsx'
import ProjectPanel from './panels/ProjectPanel.jsx'
import ExportPanel from './panels/ExportPanel.jsx'
import ViewPanel from './panels/ViewPanel.jsx'
import HelpOverlay from './panels/HelpOverlay.jsx'
import Accordion from './panels/Accordion.jsx'
import TabGroup from './panels/TabGroup.jsx'
import { useStore } from './store.js'

// Top-level layout: 3D viewport on the left, control sidebar on the right.
//
// The sidebar is organised as a short list of Blender-style collapsible
// categories rather than one long stack of always-open panels — the goal is
// that a newcomer sees "Character", "Pose", "Animate", "Scene", "Look",
// "Export" and can ignore everything except the one they're in. Only
// "Character" and the contextual pose/mesh panel are open by default; the
// rest expand on demand and remember their open/closed state for the
// session.
export default function App() {
  const toggleHelp = useStore((s) => s.toggleHelp)
  const mode = useStore((s) => s.mode)
  const sceneObjects = useStore((s) => s.sceneObjects)
  const sceneCameras = useStore((s) => s.sceneCameras)
  const sceneLights = useStore((s) => s.sceneLights)

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

        <Accordion id="character" icon="🧍" title="Character" subtitle="Load or save a project" defaultOpen>
          <ProjectPanel />
        </Accordion>

        {mode === 'bone' && (
          <Accordion id="pose" icon="🦴" title="Pose" subtitle="Move bones, save poses" defaultOpen>
            <BonePanel />
          </Accordion>
        )}
        {mode === 'mesh' && (
          <Accordion id="mesh" icon="🔺" title="Mesh" subtitle="Edit vertices & parts" defaultOpen>
            <MeshPanel />
          </Accordion>
        )}

        <Accordion id="animate" icon="🎬" title="Animate" subtitle="Keyframes & playback">
          <AnimationPanel />
        </Accordion>

        <Accordion
          id="scene"
          icon="🗂️"
          title="Scene"
          subtitle="Props, cameras & lights"
          badge={(sceneObjects.length + sceneCameras.length + sceneLights.length) || null}
        >
          <TabGroup
            defaultTab="objects"
            tabs={[
              { key: 'objects', label: 'Objects', icon: '📦', render: () => <ObjectsPanel /> },
              { key: 'cameras', label: 'Cameras', icon: '🎥', render: () => <CamerasPanel /> },
              { key: 'lights', label: 'Lights', icon: '💡', render: () => <LightsPanel /> },
            ]}
          />
        </Accordion>

        <Accordion id="look" icon="🎨" title="Look" subtitle="Shading & viewport">
          <TabGroup
            defaultTab="material"
            tabs={[
              { key: 'material', label: 'Material', icon: '🎨', render: () => <MaterialPanel /> },
              { key: 'view', label: 'View', icon: '🖥️', render: () => <ViewPanel /> },
            ]}
          />
        </Accordion>

        <Accordion id="export" icon="⬇️" title="Export" subtitle="Save images & clips">
          <ExportPanel />
        </Accordion>
      </aside>
      <HelpOverlay />
    </div>
  )
}