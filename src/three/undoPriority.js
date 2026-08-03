// Decides which of the app's several independent undo/redo systems should
// react to Ctrl/Cmd+Z (or the redo equivalent). There's more than one because
// mesh-part editing, bone posing, and scene objects (props/images/cameras/
// lights) each keep their own history.
//
// A selected scene object always wins: moving/resizing a prop is independent
// of whatever character-editing mode happens to be active (mode defaults to
// 'bone' and most people never touch it while placing props), so checking
// mode first — as a previous version of this file did — meant an object's
// own move/resize silently never undid; Ctrl+Z undid bone posing instead
// (see src/__tests__/undoPriority.test.js).
export function resolveUndoTarget(state) {
  if (state.selectedObjectId != null) return 'object'
  if (state.mode === 'mesh') return 'mesh'
  if (state.mode === 'bone') return 'bone'
  return 'bone'
}