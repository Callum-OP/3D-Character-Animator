import { useStore } from '../store.js'

// Full-screen help & shortcuts overlay. Explains, in plain language, what the app
// is for and how to drive it — for people who've never touched animation software.
// Toggled by the "?" key or the header button.
export default function HelpOverlay() {
  const show = useStore((s) => s.showHelp)
  const setShow = useStore((s) => s.setShowHelp)
  if (!show) return null

  return (
    <div className="help-backdrop" onClick={() => setShow(false)}>
      <div className="help-modal" onClick={(e) => e.stopPropagation()}>
        <button className="help-close" title="Close (Esc)" onClick={() => setShow(false)}>
          ×
        </button>
        <h2>Welcome to 3D Character Poser</h2>
        <p className="help-intro">
          Load a 3D character, pose or animate it, and choose how it looks. It
          renders on a transparent background, ready to drop straight into your 2D
          artwork.
        </p>

        <div className="help-cols">
          <div>
            <h3>Getting started</h3>
            <ol className="help-steps">
              <li>
                <b>Load a character.</b> Drag a <code>.glb</code>, <code>.gltf</code>{' '}
                or <code>.fbx</code> file onto the view, or use the <b>Load</b>{' '}
                button.
              </li>
              <li>
                <b>Pose it.</b> Click a dot on the character (or a name in the Pose
                list), then drag the coloured ring to rotate that joint.
              </li>
              <li>
                <b>Animate it.</b> Play a built-in clip, import motion capture
                (<code>.bvh</code>), or make your own with keyframes.
              </li>
              <li>
                <b>Style it.</b> Pick a look (Unlit / Toon / Standard), add an
                outline, tweak the light, and hide parts you don't want.
              </li>
            </ol>
          </div>

          <div>
            <h3>Mouse</h3>
            <ul className="help-keys">
              <li>
                <b>Left-drag</b> — orbit around the character
              </li>
              <li>
                <b>Right-drag</b> — slide the view
              </li>
              <li>
                <b>Scroll</b> — zoom in / out
              </li>
              <li>
                <b>Click a dot</b> — select a joint to pose
              </li>
            </ul>
            <h3>Keyboard</h3>
            <ul className="help-keys">
              <li>
                <b>?</b> — open / close this help
              </li>
              <li>
                <b>Esc</b> — deselect / close
              </li>
              <li>
                <b>Ctrl / Cmd + Z</b> — undo a pose change
              </li>
            </ul>
          </div>
        </div>

        <div className="help-tip">
          New to this? Just load a character and drag the rings — nothing you do
          here changes your original file.
        </div>
      </div>
    </div>
  )
}
