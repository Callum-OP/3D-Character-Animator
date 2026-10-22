import { useCallback, useEffect, useRef, useState } from 'react'
import ViewportContextMenu from './ViewportContextMenu.jsx'

// Shared plumbing for the lists in the side panels (objects, lights, cameras, parts,
// paint regions). Every row gets the same two ways in to its menu: right-click the row,
// or press the ⋯ button that shows when the row is hovered or selected.
//
//   const rowMenu = useRowMenu()
//   <div onContextMenu={(e) => rowMenu.openAt(e, items, run)}>
//     <RowMenuButton onOpen={(e) => rowMenu.openFromButton(e, items, run)} />
//   </div>
//   {rowMenu.element}
//
// `items` use the shapes documented in ViewportContextMenu.jsx; `run(id)` receives the id
// of whichever entry was clicked.
export function useRowMenu() {
  const [menu, setMenu] = useState(null)
  const close = useCallback(() => setMenu(null), [])

  const openAt = useCallback((e, items, run) => {
    e.preventDefault()
    e.stopPropagation()
    if (!items || !items.length) return
    setMenu({ x: e.clientX, y: e.clientY, items, run })
  }, [])

  const openFromButton = useCallback((e, items, run) => {
    e.stopPropagation()
    if (!items || !items.length) return
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({ x: r.left, y: r.bottom + 2, items, run })
  }, [])

  const element = menu ? (
    <ViewportContextMenu menu={menu} onAction={(id) => menu.run(id)} onClose={close} />
  ) : null

  return { openAt, openFromButton, close, isOpen: !!menu, element }
}

// The small "⋯" at the end of a row.
export function RowMenuButton({ onOpen, label = 'More options' }) {
  return (
    <button
      type="button"
      className="obj-more"
      title={`${label} (or right-click)`}
      aria-label={label}
      aria-haspopup="menu"
      onClick={onOpen}
      onContextMenu={(e) => e.stopPropagation()}
    >
      ⋯
    </button>
  )
}

// A row's name that turns into a text box while renaming. Enter or clicking away saves,
// Escape cancels. `children` is what shows when not renaming.
export function RowName({ editing, value, onCommit, onCancel, className = 'obj-name', style, children, ...rest }) {
  const [text, setText] = useState(value)
  const doneRef = useRef(false)

  useEffect(() => {
    if (editing) {
      setText(value)
      doneRef.current = false
    }
  }, [editing, value])

  if (!editing) {
    return (
      <span className={className} style={style} {...rest}>
        {children}
      </span>
    )
  }

  const finish = (save) => {
    if (doneRef.current) return
    doneRef.current = true
    if (save) onCommit(text)
    else onCancel()
  }

  return (
    <input
      className="obj-rename"
      aria-label="Name"
      autoFocus
      value={text}
      onFocus={(e) => e.target.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation() // typing a name must not trigger the single-key shortcuts (H, W, E, R…)
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
    />
  )
}
