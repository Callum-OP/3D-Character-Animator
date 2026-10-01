const histories = new Map()
let sequence = 0
let historyLimit = 100

export function registerUndoHistory(domain, getStacks) {
  histories.set(domain, getStacks)
}

export function pushUndoBatch(domain, batch) {
  const stacks = histories.get(domain)?.()
  if (!stacks) return
  batch.historyOrder = ++sequence
  stacks.undo.push(batch)
  for (const getHistory of histories.values()) getHistory().redo.length = 0
  trimStack(stacks.undo)
}

export function markHistoryAction(batch) {
  if (batch) batch.historyOrder = ++sequence
}

export function setUndoHistoryLimit(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return historyLimit
  historyLimit = Math.max(1, Math.min(1000, Math.floor(parsed)))
  for (const getStacks of histories.values()) {
    const stacks = getStacks()
    trimStack(stacks.undo)
    trimStack(stacks.redo)
  }
  return historyLimit
}

export function resolveUndoHistoryTarget(state, direction = 'undo') {
  let selected = null
  let latestOrder = -1
  for (const [domain, getStacks] of histories) {
    const stack = getStacks()[direction]
    const order = stack.length ? stack[stack.length - 1].historyOrder || 0 : -1
    if (order > latestOrder) {
      latestOrder = order
      selected = domain
    }
  }
  return selected || fallbackTarget(state)
}

function trimStack(stack) {
  if (stack.length > historyLimit) stack.splice(0, stack.length - historyLimit)
}

function fallbackTarget(state) {
  if (state.selectedObjectId != null) return 'object'
  if (state.mode === 'mesh') return 'mesh'
  return 'bone'
}