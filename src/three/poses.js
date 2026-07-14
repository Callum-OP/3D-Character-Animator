// ---------------------------------------------------------------------------
// Pose serialization
//
// A pose is just each bone's LOCAL rotation quaternion, keyed by bone name:
//   { format: "pose-v1", bones: { [boneName]: [x, y, z, w] } }
//
// Storing only rotations (not positions/scales) keeps FK poses portable: a pose
// roughly transfers between characters whose rigs share bone names. Bones missing
// from the target rig are skipped with a console warning.
// ---------------------------------------------------------------------------

export const POSE_FORMAT = 'pose-v1'

// Serialize the current local rotation of each bone.
export function poseToJSON(bones) {
  const out = {}
  for (const b of bones) {
    const q = b.quaternion
    out[b.name] = [q.x, q.y, q.z, q.w]
  }
  return { format: POSE_FORMAT, bones: out }
}

// Validate the shape of a parsed pose file, throwing a legible error otherwise.
export function validatePose(json) {
  if (!json || json.format !== POSE_FORMAT || typeof json.bones !== 'object') {
    throw new Error(`Not a valid pose file (expected format "${POSE_FORMAT}").`)
  }
}

// Trigger a browser download of a pose JSON. No server round-trip.
export function downloadPose(json, baseName) {
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${baseName || 'pose'}.pose.json`
  a.click()
  URL.revokeObjectURL(url)
}

// Read + parse a pose File (from a file input).
export async function readPoseFile(file) {
  const text = await file.text()
  return JSON.parse(text)
}
