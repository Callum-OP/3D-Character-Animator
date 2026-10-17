# Opening `.blend` files

The desktop app opens `.blend` files by running **the user's own copy of Blender**, in the
background, to convert the file to glTF — which the app then loads like any other model.
The browser build can't do this (there's no Blender to run), so it explains how to export
a glTF from Blender instead.

```
renderer (blendImport.js) ──IPC──► main process (blender.cjs) ──► blender --background … --python export.py
        ▲                                   │  temp copy of the .blend + its textures
        └───────────── .glb ◄───────────────┘
```

* `electron/blender.cjs` — finds Blender, runs the conversion, wires the IPC handlers.
* `src/three/blendImport.js` — the renderer side; converts each `File` once (cached).
* `src/three/loadModel.js` (`loadBlend`) — loads the resulting `.glb`; a saved project keeps
  **that**, not the `.blend`, so reopening a project never needs Blender.
* Settings ▸ View panel — shows where Blender was found; "Choose Blender…" to point at it.

## How Blender is found

In order: the path chosen in Settings → `BLENDER_PATH` → `PATH` → the usual install
folders (Program Files `Blender Foundation\Blender x.y` newest first, Steam, `/Applications`,
`/usr/bin`, `/snap/bin`, `/opt`). Blender 2.80 or newer (when the glTF exporter arrived).

## Making old and Cycles-style files come out right

Blender's glTF exporter only understands the Principled BSDF, and only finds textures where the
file says they are. Real-world files break both rules, so the conversion script (in `blender.cjs`)
fixes them up in memory before exporting (your file is never modified):

* **Missing textures are relinked by name.** A `.blend` remembers where its textures were on the
  *artist's* machine (`//../../Unity/Assets/Textures/wall.png`, `C:\Users\me\wall.png`), which
  never exists elsewhere. Each missing image is searched for by file name (ignoring case, and
  `_`/`+`/space differences, and the image extension) anywhere in the folder that was imported,
  and Blender is pointed at the match. Ones that truly aren't there are reported.
* **Old-style shaders become Principled.** Diffuse / Glossy / Emission / Translucent / Mix
  shader networks — everything in older files and a lot of Cycles scenes — export as plain
  default white. Each such material gets an equivalent Principled BSDF fed by the same colour or
  texture, so colours and textures survive.
* Harmless colour-management notices an old file triggers in a newer Blender are hidden.

## What converts, and what doesn't

Blender's own glTF exporter does the work, so the result is as good as File ▸ Export ▸ glTF 2.0:

* **Carried over:** meshes, modifiers (applied — except on meshes with shape keys, which keep
  their morphs instead), armatures + skinning, actions/animation, shape keys, basic
  (Principled BSDF) materials and their image textures (embedded in the `.glb`).
* **Not carried over:** shader node setups beyond the basics, procedural textures, particles,
  hair, Grease Pencil, cameras and lights (the app has its own), hidden objects.
* Textures that are *linked* by relative path (`//textures/a.png`) are found when the model is
  imported as a folder or zip, because the folder layout is rebuilt for Blender.
  Any it can't find are reported after the import.

## Safety

A `.blend` can contain Python scripts that run automatically when the file is opened, and the
file may come from anyone. So Blender is always started with:

* `--disable-autoexec` — never run scripts embedded in the file,
* `--factory-startup` — ignore the user's add-ons and startup files,
* no shell — arguments are passed as an array, so a file name can't become a command,

in a throw-away temp folder that is deleted afterwards. Paths sent from the renderer are
validated (relative only, nothing that climbs out of the folder). There is a 5-minute timeout.

## Licensing notes (not legal advice)

* Blender is GPL software. This app **does not include, link to or copy any of Blender's
  code**: it starts the user's installed Blender as a separate program and reads the file it
  writes. That is the usual "separate programs communicating" arrangement and doesn't make this
  app GPL.
* **Don't bundle Blender** with the app unless you're prepared to follow Blender's GPL terms
  for it (source offer, license text, etc.). Asking users to install it themselves avoids that.
* Don't copy Blender's source (for example its glTF exporter add-on) into this project — that
  code is GPL. The small Python script in `blender.cjs` only *calls* the exporter.
* Files people make in Blender belong to them (Blender's own license FAQ says so), and the
  `.blend` format only describes data. Whether you may *use* a downloaded model is set by its
  creator's license, as with any file format.
* Say "opens .blend files" in store listings; don't use Blender's logo or imply endorsement.
