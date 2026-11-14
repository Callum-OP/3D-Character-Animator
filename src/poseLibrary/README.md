# Pose Library presets

Drop `.bvh` files into these folders and rebuild (or restart `npm run dev`) — they show up in the
**Pose Library** menu in the title bar. There is no list to edit.

| Folder        | What each file is                                   | How it is used                          |
| ------------- | --------------------------------------------------- | --------------------------------------- |
| `body/`       | A full-body pose — frame 0 of the file is the pose  | Retargeted onto the character (same bone auto-matching as Import Animation) |
| `hand/`       | A hand pose — frame 0, with finger bones            | Works on any rig, left or right hand    |
| `animation/`  | A whole animation                                   | Added as a clip, like Import Animation  |

* Sub-folders become filter chips (`body/sitting/cross-legged.bvh` → category **Sitting**).
* The file name becomes the pose name (`arms_crossed.bvh` → **Arms Crossed**).
* Hand files may hold one hand or both. A right-hand pose can be put on a left hand and vice versa.
* Body poses leave the fingers alone unless "Keep current hand poses" is switched off.
* Keep pose files single-frame; long animations belong in `animation/`.
