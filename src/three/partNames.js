// Part (mesh) names a person can change. The model file keeps its own names (the mesh's `name`, which saved
// projects and recipes still match against); a rename is stored with the part's other per-part settings
// (store.meshOverrides[uuid].name), so it is undoable, saves with the project, is kept when a character is
// copied, and works for props the same as for characters.
export const MAX_PART_NAME = 80

// A name worth keeping: trimmed, single-spaced, not absurdly long. '' means "go back to the model's own name".
export function cleanPartName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_PART_NAME)
}

// What to show for a part: its renamed name when it has one, else the name it was loaded with.
export function partDisplayName(override, loadedName) {
  const own = override && typeof override.name === 'string' ? override.name.trim() : ''
  return own || loadedName || 'Part'
}
