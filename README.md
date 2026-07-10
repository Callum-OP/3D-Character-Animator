# 3D Character Poser & Animator

A lightweight, browser-based tool for posing, animating, and rasterizing 3D
characters exported from Blender — built to be **dramatically lighter on memory
than Blender**, which is the whole point of the app.

Load a rigged character, choose how it's shaded (keeping the flat/anime colours
picked in Blender), pose the bones or play baked animation clips, then export the
current frame as a transparent PNG that drops straight into a 2D art pipeline
(e.g. Clip Studio Paint).

Everything runs client-side. There is no backend, no upload, no account — files
never leave your machine (they're parsed via `URL.createObjectURL` over the local
blob).

## Status

The project is being built in phases (see [`references/Plan.md`](references/Plan.md)).

- **Phase 1 — Scaffold & model loading — ✅ done.** Load a model, orbit around it,
  see its stats, toggle grid/background, dispose cleanly on unload.
- **Phase 2 — Material modes — ✅ done.** Switch between **Unlit** (raw Blender
  colours, the default), **Toon** (stepped anime shading with a selectable band
  count), and **Standard** (original PBR). A key-light control (intensity /
  direction / height) drives the Toon and Standard modes. An optional
  **inverted-hull outline** (toggle + width) can be layered on any mode — its
  thickness is screen-space, so it looks consistent across model scales. A global
  **Soften** control lifts toon shadows and thins the outline everywhere, and
  **per-mesh overrides** let you drop the outline and flatten shading on specific
  parts (e.g. the face).
- **Phase 3+ — not yet built:** bone posing, animation playback & keyframing, and
  PNG / image-sequence export.

### Supported file formats

| Format        | Extensions     | Notes                                                        |
| ------------- | -------------- | ----------------------------------------------------------- |
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

> **Note (this machine):** HTTPS is intercepted by a corporate/system CA, so npm
> may hang on install. Prefix commands with the system-CA flag:
> `NODE_OPTIONS=--use-system-ca npm install`.

### Other scripts

```bash
npm run build      # production build into dist/
npm run preview    # serve the production build locally
```

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
6. The **View** panel toggles the reference grid and switches between a
   transparent background (the default, for compositing) and a solid colour.

## Tech stack

- **[Vite](https://vitejs.dev/) + [React](https://react.dev/)** (JavaScript, not TypeScript)
- **[Three.js](https://threejs.org/)** — `GLTFLoader`, `FBXLoader`, `OrbitControls`
- **[Zustand](https://github.com/pmndrs/zustand)** for app state

## Project structure

```
src/
  App.jsx               # top-level layout: viewport + sidebar
  store.js              # Zustand store (UI + model info)
  three/
    scene.js            # scene manager singleton (on-demand rendering, disposal)
    loadModel.js        # format dispatch: GLTFLoader / FBXLoader + deep dispose
    materials.js        # unlit/toon/standard material modes (non-destructive)
    outline.js          # inverted-hull outline via three's OutlineEffect
    Viewport.jsx        # canvas host + drag-and-drop
  panels/
    ModelPanel.jsx      # load button / drop zone, model stats
    MaterialPanel.jsx   # material mode + key-light controls
    ViewPanel.jsx       # grid & background toggles
```

## Design principles (low overhead is the point)

- **Render on demand** — no idle `requestAnimationFrame` loop; a frame is drawn
  only when the camera moves, a model loads, or a toggle flips.
- **Dispose everything** — geometries, materials, and textures are released when a
  model is unloaded or replaced.
- **One model at a time**, device pixel ratio capped at 2, transparent background
  by default.

## License

Private / unpublished.
