# 3D Character Poser & Animator

Animare 3D Animator is a low memory 3D character and scene animation tool for setting up and recording 3D animations. It is designed to import rigged characters or objects created from other 3D tools, move or pose them, animate them, set up cameras and shots, add attachable props to characters as well as physics (dangle, ragdoll or cloth physics), and export the final video all locally in the browser or as a desktop app.

The app keeps the original material look, supports character animation and
mocap retargeting, allows mesh-level edits for accessories and clothing, and adds sveral scene staging workflows such as cameras, lighting, art styles, scene props, root motion, cloth, and ragdoll-style motion. Allowing you to animate not just characters performing actions but also objects moving, cameras moving or camera cuts and changes to lighting. Everything runs client-side so no account required, no cloud or backend, and no file leaves your machine unless you explicitly export it.

## Features

- **Character import and viewing** — load rigged `.glb`, `.gltf`, and `.fbx`
  characters, inspect the rig, mesh count, bone count, and animation clips, and
  unload models to free GPU memory when switching assets.
- **Shading and lighting** — choose **Unlit**, **Toon**, or **Standard** shading,
  tune key-light direction/intensity/height, apply a screen-space outline,
  soften toon shading, and override materials per mesh. Lighting presets include
  Front, Side, Rim, and Top, with optional ground shadowing, different preset styles include flat, anime, cel shaded, realistic and noir.
- **Pose workflow** — select bones from the viewport or the bone tree, rotate or
  manipulate them with gizmos, save/load/reset poses as JSON, switch gizmo space,
  filter deform bones, and undo edits with a consistent pose history.
- **Mesh editing** — work in Mesh mode to move, rotate, and scale individual
  parts such as eyes, hair, clothing, accessories, and facial features. Each mesh
  part has its own transform controls, reset tools, pivot behaviour, and trackable
  undo history.
- **Animation** — play baked animation clips or build in-app keyframe
  animation for bones, parts, cameras, lights, and root motion. Set duration,
  FPS, scrub the timeline, preview playback, and save/load clips locally.
- **Cameras and shots** — place multiple cameras from the current view, look
  through any camera, adjust FOV, keyframe camera motion, and add cuts to switch
  camera views at specific times. Rendering and video export follow the active
  camera and cut timing.
- **Mocap import and retargeting** — import BVH motion capture, auto-map bones by
  body part and side, manually correct any mapping in the mapping editor, and
  retarget motion onto the loaded rig. Converted clips can be applied as a pose or
  baked into editable keyframes.
- **Scene props and layout** — add backgrounds and props from `.glb`, `.gltf`, or
  `.fbx`, arrange them in the scene, move/rotate/scale them, select multiple
  objects together, and save/load scene layouts. Props can follow a character
  bone, with attach/detach changes keyed to the All animation playhead. The app
  also supports root motion capture for characters that walk through the scene
  instead of staying fixed in place.
- **Cloth and secondary motion** — enable cloth simulation on selected meshes to
  drape clothing or accessories against the character body, with live simulation
  controls and a reset/restore workflow. Dangle-bone physics adds lightweight
  jiggle and secondary motion for hair, accessories, and loose parts.
- **Ragdoll and physics-based motion** — bake a ragdoll-style animation from a
  posed character or motion clip, then reuse it as a generated clip with the same
  timeline and export flow as other animation data.
- **Light and camera keyframing** — animate lights as part of the same timeline,
  giving you more control over cinematic presentation and interactive shot setups.
- **Export pipeline** — export transparent stills at 1×/2×/4× viewport sizes,
  record WebM video from the current camera view, export animation clips as BVH,
  and use fullscreen capture for screen recordings and presentation work. Play
  All and video export can optionally stop when the shortest active character
  clip ends.
- **Extra usability tools** — one-click presets, help overlays, per-part hide/
  show controls, FPS/memory readouts, a reference grid, and a practical UI tuned
  for quick iteration.

### Supported file formats

| Format        | Extensions     | Notes                                                        |
| ------------- | -------------- | ----------------------------------------------------- |
| glTF (binary) | `.glb`         | Recommended. Rig + baked animations carry over.             |
| glTF (JSON)   | `.gltf`        | Self-contained files; external `.bin`/textures aren't fetched. |
| Autodesk FBX  | `.fbx`         | Loaded on demand (the FBX parser is code-split).            |

> **Draco compression is not supported yet.** If a Blender glTF export uses it,
> re-export with *Compression* unchecked — the app surfaces a clear message if it
> hits a Draco file.

## Getting started

Requires [Node.js](https://nodejs.org/) 18+.

```bash
npm install
npm run dev        # start the Vite dev server (prints a local URL)
```

Then open the printed URL, and either click **Load .glb / .gltf / .fbx** or drag
a model file onto the viewport.

### Other scripts

```bash
npm run build         # production build into dist/
npm run preview       # serve the production build locally
npm run test          # run all vitest unit tests
npm run test:watch    # run tests in watch mode
npm run package:itch  # build and create 3d-character-animator-itch.zip (Windows)
```

### itch.io upload

For a zip file to use in sites like itch.io run:

```bash
npm install
npm run package:itch
```

### Run as a desktop app (Electron)

```bash
npm run electron:dev    # Vite dev server (HMR) + Electron window
npm run electron:start  # production build of the frontend, opened in Electron
```

Windows installers (NSIS, x64 + arm64) are produced in `release/` with:

```bash
npm run electron:build
```

The desktop shell lives in [`electron/main.cjs`](electron/main.cjs): hardware
acceleration stays on, page/pinch zoom is locked (the app zooms the 3D camera
itself), and the renderer is sandboxed. WebGL context loss (GPU reset) is
handled in `src/three/scene.js`.

### Build for the Microsoft Store (MSIX)

Build and package the desktop app for the Microsoft Store (both arm64 and x64)
in one command:

```bash
npm run build-store
```

This outputs `release/Animare3DAnimator_<version>.msixbundle` — a single
multi-architecture bundle to upload to Partner Center. The per-architecture
`.appx` files electron-builder creates are alongside it in `release/`.
The MSIX package targets Windows 10 version 1809 (build 17763) or later.
The package identity (`appx` block in `package.json`) must match the identity
Partner Center gives the listing; the Store tile images are in `build/appx/`.
> The command runs: clean `release`, build the frontend, package x64 and arm64
> with electron-builder, then combine them into one `.msixbundle`. Needs the
> Windows SDK (for `makeappx`).

## Deployment (GitHub Pages)

The app is a pure static site, so it deploys to GitHub Pages with no backend. A
workflow at [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) builds
and publishes `dist/` on every push to `main`.

One-time setup: in the repo, go to **Settings → Pages → Build and deployment →
Source** and select **GitHub Actions**. After the next push to `main`, the site
goes live at:

```
https://callum-op.github.io/3D-Character-Animator/
```

Because this is a *project* Pages site (served from a `/<repo>/` subpath), the
Vite build sets `base: '/3D-Character-Animator/'` (see `vite.config.js`). Local
`dev`/`preview` still run at `/`. If the repo is renamed, update that `base`.

## Usage

1. **Export** your character from Blender as `.glb` (glTF binary, with rig and any
   baked animations), or use an `.fbx`.
2. **Load** it via the button or by dragging the file onto the viewport.
3. **Orbit** with the mouse (left-drag rotate, right-drag pan, scroll to zoom).
   The camera automatically frames the model on load.
4. The **Model** panel shows the name, format, mesh count, bone count, and any
   animation clips. **Unload model** frees its GPU memory.
5. The **Material** panel picks the shading mode (Unlit / Toon / Standard), the
   toon shadow-band count, the key-light intensity/direction/height (ignored in
   Unlit mode), an optional black outline with a width slider, a global **Soften**
   control, and **per-mesh** overrides (outline on/off + Full/Soft/Flat shading —
   set the face mesh to *Flat* with its outline off to keep it clean).
6. The **Pose** panel lists the rig's bones. Click a bone dot in the viewport or
   a name in the tree to select it, then drag the rotate gizmo. Save/Load/Reset
   poses (JSON), Undo edits, toggle the bone overlay, filter names, hide
   non-deform bones, and switch the gizmo between local/world space.
7. The **Animation** panel plays baked clips (pick one, then Play/scrub/loop/speed)
   or authors an in-app keyframe animation: pose a bone, set the insert time, and
   **Key bone** / **Key all posed** to add keyframes, then Play to preview and
   Save/Load the animation as JSON. (Stop returns to the rest pose so you can keep
   editing.) Under **Clip / mocap** you can also **Import mocap (.bvh)** to
   retarget a motion onto the rig (a mapping editor appears — accept the
   auto-guess or correct any bone slot, then **Retarget**), and turn any clip into
   a single pose (**Frame → pose**) or editable keyframes (**Bake → keys**).
8. Switch to **Mesh** mode (toolbar or key `3`) to adjust individual parts: click
   a part in the viewport or the **Parts** list, drag the gizmo (`W` move /
   `E` rotate / `R` resize) or type exact values, and **Key part** to animate it
   on the timeline.
9. The **Cameras** panel places cameras: orbit until the shot looks right, then
   **+ Add camera (from this view)**. Click 📷 (or press `0`) to look through
   it — PNG export and **Record video** capture that view. **Key camera** at two
   times makes it glide between placements; **Cut here** switches the view to
   that camera at the insert time, so several cameras can cover one animation
   like film shots (the view cuts automatically during playback and recording).
10. The **View** panel toggles the reference grid and switches between a
    transparent background (the default, for compositing) and a solid colour.

## Tech stack

- **[Vite](https://vitejs.dev/) + [React](https://react.dev/)** (JavaScript, not TypeScript)
- **[Three.js](https://threejs.org/)** — `GLTFLoader`, `FBXLoader`, `OrbitControls`
- **[Zustand](https://github.com/pmndrs/zustand)** for app state
- **[Electron](https://www.electronjs.org/)** for the packaged Windows desktop build (MS Store)

## Project structure

```
src/
  App.jsx               # top-level layout: viewport + sidebar
  index.css             # global styles
  main.jsx              # React entry point
  store.js              # Zustand store (UI + model info)
  three/
    scene.js            # scene manager singleton (on-demand rendering, disposal)
    loadModel.js        # format dispatch: GLTFLoader / FBXLoader + deep dispose
    materials.js        # unlit/toon/standard material modes (non-destructive)
    outline.js          # inverted-hull outline via three's OutlineEffect
    posing.js           # bone gizmo, pickable bone dots, undo, rest pose
    poses.js            # pose JSON format + file save/load
    animation.js        # AnimationMixer: baked clips + in-app keyframe clips
    bvh.js              # BVH mocap import + retarget onto the loaded rig
    objects.js          # scene props/backgrounds + move/rotate/scale gizmo
    meshedit.js         # Mesh mode: pick parts, pivot-centred gizmo, keyframes
    cameras.js          # placeable cameras: rigs, view-through, cuts, keyframes
    materials.js        # material layer management
    clipLibrary.js      # animation clip management
    clothmod.js         # cloth simulation
    lights.js           # scene lighting
    limits.js           # bone rotation/position limits
    localdb.js          # local storage via IndexedDB
    ragdoll.js          # ragdoll physics
    undoPriority.js     # undo system state priority
    Viewport.jsx        # canvas host + drag-and-drop + mode/keyboard shortcuts
  panels/
    Accordion.jsx       # collapsible panel component
    EditableValue.jsx   # editable input field component
    TabGroup.jsx        # tab switcher component
    RadialScale.jsx     # radial scaling tool UI
electron/                # Electron desktop shell
  main.cjs               # main process: window, app:// protocol, GPU/zoom settings
build/                   # packaging resources (app icon, Store tile images)
scripts/                 # itch.io packaging, Electron dev runner, Store bundling
```
