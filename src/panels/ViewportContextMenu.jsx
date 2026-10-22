import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// The right-click menu drawn over the viewport and over the list rows (objects,
// lights, cameras, parts). Purely presentational: the caller supplies the items
// (see three/contextMenu.js and panels/rowMenus.js) and handles the action.
//
// Item shapes:
//   { id, label, shortcut?, disabled?, danger?, checked? }   a normal entry; `checked`
//                                                            (true/false) adds a tick column
//   { header: 'Title' }                                      a small non-clickable heading
//   { separator: true }
//   { label, children: [items…], disabled? }                 opens a flyout on hover/click
//
// Closes on Escape, on any click outside it, on scroll/zoom, and on window blur.
export default function ViewportContextMenu({ menu, onAction, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  // Keep the menu fully on screen: flip it back inside if it would overflow.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)),
    })
  }, [menu.x, menu.y, menu.items.length])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'Escape') return
      e.stopPropagation() // closing the menu shouldn't also deselect
      onClose()
    }
    // Events aimed at the window itself (not an element) are never "inside" the menu.
    const inside = (e) => e.target instanceof Node && ref.current && ref.current.contains(e.target)
    function onPointerDown(e) {
      if (inside(e)) return
      onClose()
    }
    // Scrolling inside the menu itself (a long flyout) must not close it.
    function onWheel(e) {
      if (inside(e)) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('wheel', onWheel, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const run = (id) => {
    onAction(id)
    onClose()
  }

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems items={menu.items} onRun={run} />
    </div>
  )
}

function MenuItems({ items, onRun }) {
  const [openKey, setOpenKey] = useState(null)
  return items.map((item, i) => {
    if (item.separator) return <div key={'sep' + i} className="ctx-sep" role="separator" />
    if (item.header) {
      return (
        <div key={'head' + i} className="ctx-header" role="presentation" title={item.header}>
          {item.header}
        </div>
      )
    }
    if (item.children) {
      return (
        <SubMenu
          key={'sub' + i}
          item={item}
          open={openKey === i}
          onOpen={() => setOpenKey(i)}
          onRun={onRun}
        />
      )
    }
    return (
      <button
        key={item.id}
        role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
        aria-checked={item.checked === undefined ? undefined : !!item.checked}
        className={'ctx-item' + (item.danger ? ' danger' : '')}
        disabled={item.disabled}
        title={item.hint}
        onMouseEnter={() => setOpenKey(null)}
        onClick={() => onRun(item.id)}
      >
        <span>
          {item.checked !== undefined && <span className="ctx-tick">{item.checked ? '✓' : ''}</span>}
          {item.label}
        </span>
        {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
      </button>
    )
  })
}

// An entry that opens a flyout to its right (or its left when there isn't room).
// Opens on hover and on click, so it works with a touchscreen too.
function SubMenu({ item, open, onOpen, onRun }) {
  const flyRef = useRef(null)
  const [side, setSide] = useState({ flip: false, shift: 0 })

  useLayoutEffect(() => {
    if (!open || !flyRef.current) return
    const r = flyRef.current.getBoundingClientRect()
    setSide({
      flip: r.right > window.innerWidth - 4,
      shift: r.bottom > window.innerHeight - 4 ? window.innerHeight - 4 - r.bottom : 0,
    })
  }, [open])

  return (
    <div className="ctx-sub" onMouseEnter={() => !item.disabled && onOpen()}>
      <button
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className="ctx-item"
        disabled={item.disabled}
        title={item.hint}
        onClick={onOpen}
      >
        <span>{item.label}</span>
        <span className="ctx-shortcut">{item.value ? item.value + ' ' : ''}▸</span>
      </button>
      {open && (
        <div
          ref={flyRef}
          className={'ctx-menu ctx-flyout' + (side.flip ? ' flip' : '')}
          role="menu"
          style={{ top: side.shift }}
        >
          <MenuItems items={item.children} onRun={onRun} />
        </div>
      )}
    </div>
  )
}
