# Pose Finder (video → mocap)

Desktop-only. Runs Meta's **SAM 3D Body** locally via `onnxruntime-node` (ONNX conversion by gok11, ViT-H body decoder,
SAM License). No Python, no CUDA: CPU everywhere, DirectML (GPU) on Windows including ARM64.

Flow: titlebar **Pose Finder** → accept licence + download model once (~1.4 GB into `userData/pose-engine`) → pick video →
draw a box round the person → **Find poses** → **Add to active character** (goes through the normal BVH import/retarget) or
**Download BVH**.

Choose a motion preset before finding poses:
- **Standing** uses the existing upright cleanup and ground correction.
- **Lying down** preserves horizontal poses and uses the lowest tracked body point as the height reference.
- **Flips** samples more frames, preserves airborne motion and steadies detected foot contacts before and after a jump.
- **Adaptable** builds on Flips for clips mixing standing, falling, rolling and lying down. It analyses at 30 fps,
  releases foot contacts when the hips or torso tilt, and uses shorter root-motion filters to retain quick falls and bounces.

The ground toggle grounds the lowest foot and enables planted-foot cleanup. During detected contacts, the solver
levels and holds each foot in place on the output skeleton, releasing it for steps; this reduces sliding even when
the tracked leg rotations are noisy. When adding a result to a character, retargeting preserves the character's
own foot and toe rest angles rather than forcing them to match the output skeleton. Downloaded BVH files use their
own skeleton and other BVH imports retain their usual retargeting. Switch the toggle off for airborne or non-standing movement (this also turns
off the optional fixed-foot pin). Advanced settings can override cleanup.
Advanced settings expose sampling, smoothing and cleanup controls. The optional fixed-foot pin is for motion on
the spot, not walking: it is baked into the BVH, but feet can move if the hips travel beyond leg reach. Choosing
a preset resets these settings. Results are generated from the settings at the time **Find poses** is pressed;
run it again after changing settings. Both download and character import use that generated BVH. A neutral
reference frame is included at the start for the app's retargeter. All presets use a lower shoulder and upper-arm
reference pose by default, while preserving the tracked motion relative to that pose. Adjust or disable
**Lower shoulders and arms** in advanced settings if it changes the intended result.

The model estimates 3D motion from one video, so occluded limbs, floor height, camera movement, and fast rotations
are approximate. The body-height reference uses tracked points rather than detecting a real floor or bed, and
interpolation cannot recover a full rotation between samples. Use a clear view and a higher analysis rate for
fast flips or steps; review the result and adjust the advanced settings if necessary. Contact detection is
approximate, and feet may move when a target is beyond the leg's reach or the model cannot see them clearly.
The Flips preset uses projected foot motion to detect contacts and releases both feet when they and the hips rise.
It retains accumulated horizontal tracking corrections when a foot lifts, rather than snapping back to the
uncorrected path. Camera motion, occlusion, or movement towards the camera can still be mistaken for contact or release.
Adaptable uses the same contact detection, with an additional torso check; its shorter filtering can also retain more
tracking noise. Neither preset detects actual floor contact.
Turn off Foot lock in advanced settings if it alters the motion.

Files: `electron/poseEngine.cjs` (download, session, inference, IPC) · `src/three/poseFinder/*` (crop maths, MHR rest
data, motion solver, BVH writer, pipeline) · `src/panels/PoseFinderPanel.jsx`.
`mhrRest.js` is generated: `node scripts/gen-mhr-rest.mjs <MHR assets>/lod6.fbx` (Meta's MHR, Apache-2.0).

## First real run checklist (the model could not be run where this was written)
1. Status shows "Model ready" after the download (SHA-256 is verified).
2. Run a 3–5 s clip, CPU first, then DirectML. Note seconds per frame.
3. On the result, `info.convention` should report score > 0.95. If the app shows the "conventions look inconsistent"
   warning, the ONNX output frames differ from what `detectConvention` expects — send the first frame's raw output.
4. Check: limbs bend the right way (not mirrored), the character faces forward, feet do not slide when planted.
