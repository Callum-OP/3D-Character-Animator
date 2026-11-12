# Pose Finder (video → mocap)

Desktop-only. Runs Meta's **SAM 3D Body** locally via `onnxruntime-node` (ONNX conversion by gok11, ViT-H body decoder,
SAM License). No Python, no CUDA: CPU everywhere, DirectML (GPU) on Windows including ARM64.

Flow: titlebar **Pose Finder** → accept licence + download model once (~1.4 GB into `userData/pose-engine`) → pick video →
draw a box round the person → **Find poses** → **Add to active character** (goes through the normal BVH import/retarget) or
**Download BVH**.

Files: `electron/poseEngine.cjs` (download, session, inference, IPC) · `src/three/poseFinder/*` (crop maths, MHR rest
data, motion solver, BVH writer, pipeline) · `src/panels/PoseFinderPanel.jsx`.
`mhrRest.js` is generated: `node scripts/gen-mhr-rest.mjs <MHR assets>/lod6.fbx` (Meta's MHR, Apache-2.0).

## First real run checklist (the model could not be run where this was written)
1. Status shows "Model ready" after the download (SHA-256 is verified).
2. Run a 3–5 s clip, CPU first, then DirectML. Note seconds per frame.
3. On the result, `info.convention` should report score > 0.95. If the app shows the "conventions look inconsistent"
   warning, the ONNX output frames differ from what `detectConvention` expects — send the first frame's raw output.
4. Check: limbs bend the right way (not mirrored), the character faces forward, feet do not slide when planted.
