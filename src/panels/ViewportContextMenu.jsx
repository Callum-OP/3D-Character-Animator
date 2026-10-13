import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// The right-click menu drawn over the viewport. Purely presentational: the
// caller supplies the items (see three/contextMenu.js) and handles the action.
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
    function onPointerDown(e) {
      if (ref.current && ref.current.contains(e.target)) return
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('wheel', onClose, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('wheel', onClose, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={'sep' + i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={item.id}
            role="menuitem"
            className={'ctx-item' + (item.danger ? ' danger' : '')}
            disabled={item.disabled}
            onClick={() => {
              onAction(item.id)
              onClose()
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  )
}
