import { useStore } from '../store.js'
import { PRIVACY_POLICY_URL } from '../links.js'

// Full-screen help & shortcuts overlay. Explains, in plain language, what the app
// is for and how to drive it — for people who've never touched animation software.
// Toggled by the "?" key, the header button, or Help in the menu bar.
// Keep this in step with the real UI: panel names (Character / Pose / Mesh /
// Animate / Scene / Look / Export), button labels and the key handlers in
// Viewport.jsx and AnimationPanel.jsx.
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
        <h2>Welcome to Animare</h2>
        <p className="help-intro">
          Load a 3D character, pose it, animate it and choose how it looks. It
          renders on a transparent background by default, ready to drop straight
          into your 2D artwork.
        </p>

        <div className="help-cols">
          <div>
            <h3>Getting started</h3>
            <ol className="help-steps">
              <li>
                <b>Load a character.</b> Drag a <code>.glb</code>, <code>.gltf</code>{' '}
                or <code>.fbx</code> file onto the view, or use{' '}
                <b>Load object or character</b> in the Character panel. Files with
                bones come in as a character; anything else as an object.
              </li>
              <li>
                <b>Pose it.</b> In <b>Pose</b> mode, click a dot on the character
                (or a name in the Pose list), then drag the coloured ring — or the
                X/Y/Z sliders — to bend that joint. <b>Mirror</b> swaps the
                left and right sides of a pose.
              </li>
              <li>
                <b>Adjust its parts (optional).</b> In <b>Mesh</b> mode, click a
                part — eyes, hair, clothing — to move, rotate or resize just that
                piece, or set its shape keys (face expressions).
              </li>
              <li>
                <b>Animate it.</b> In <b>Animate</b>, play a built-in clip, import
                motion capture (<code>.bvh</code>), or make your own: set the
                Duration, move the playhead and press <b>Key position</b> to save
                where the character stands, its pose and its shape keys at that
                moment. Pick a shape key from the <b>Shape key…</b> drop-down to
                set it with a slider.
              </li>
              <li>
                <b>Build the scene (optional).</b> In <b>Scene</b>, the Objects tab
                adds props and backgrounds, Cameras captures the current view (look
                through it with 📷 and keyframe it to move during the animation),
                and Lights places lights. If a model uses transparent textures it
                gets a <b>Transparency</b> checkbox — untick it if inner parts
                (like teeth) show through the skin.
              </li>
              <li>
                <b>Style it.</b> In <b>Look</b>, pick Flat colour, Cartoon, Soft
                Anime or Realistic (or a ready-made style), add an outline, tweak
                the light, and hide parts you don't want.
              </li>
              <li>
                <b>Export it.</b> In <b>Export</b>, save an image (PNG), preview or
                record a video (MP4 or WebM), or export the animation (
                <code>.bvh</code>) or the whole scene (<code>.glb</code> /{' '}
                <code>.gltf</code>).
              </li>
              <li>
                <b>Save your work.</b> Use File ▸ <b>Save</b> (or the Character
                panel) to keep everything as a project file you can reopen later
                with <b>Open Project…</b>.
              </li>
            </ol>
          </div>

          <div>
            <h3>Mouse</h3>
            <ul className="help-keys">
              <li>
                <b>Left-drag</b> — orbit around the scene
              </li>
              <li>
                <b>Right-drag</b> — slide the view
              </li>
              <li>
                <b>Scroll</b> — zoom in / out
              </li>
              <li>
                <b>Click a dot</b> — select a joint to pose (Pose mode)
              </li>
              <li>
                <b>Shift / Ctrl-drag a box</b> — select several joints (Pose mode)
              </li>
              <li>
                <b>Click a part</b> — select it to move / resize (Mesh mode)
              </li>
              <li>
                <b>Click a prop, camera or light</b> — select it to move / rotate /
                resize (Object mode). Shift / Ctrl-click to select more than one.
              </li>
            </ul>
            <h3>Keyboard</h3>
            <ul className="help-keys">
              <li>
                <b>?</b> — open / close this help
              </li>
              <li>
                <b>1 / 2 / 3 / 4</b> — View, Object, Pose or Mesh mode
              </li>
              <li>
                <b>W / E / R</b> — move, rotate or resize (Object &amp; Mesh mode)
              </li>
              <li>
                <b>H</b> — hide / show the selected object, character or mesh part
              </li>
              <li>
                <b>Ctrl / Cmd + C</b> — copy the selected pose, object, character or mesh transform
              </li>
              <li>
                <b>Ctrl / Cmd + X</b> — cut it
              </li>
              <li>
                <b>Ctrl / Cmd + P or V</b> — paste into the current mode
              </li>
              <li>
                <b>0</b> — look through a camera / back to the free view
              </li>
              <li>
                <b>Esc</b> — leave the camera view, deselect or close
              </li>
              <li>
                <b>Ctrl / Cmd + Z</b> — undo the latest edit across modes
              </li>
              <li>
                <b>Ctrl / Cmd + Shift + Z</b> (or <b>Ctrl / Cmd + Y</b>) — redo
              </li>
              <li>
                <b>Shift</b> (while rotating a joint) — snap to 15° steps
              </li>
              <li>
                <b>Space</b> — play / pause the animation
              </li>
              <li>
                <b>← / →</b> — step one frame back / forward
              </li>
            </ul>
          </div>
        </div>

        <div className="help-tip">
          New to this? Just load a character and drag the rings — nothing you do
          here changes your original file. Display and performance options are
          under ⚙ at the top.{' '}
          <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </a>
        </div>
      </div>
    </div>
  )
}