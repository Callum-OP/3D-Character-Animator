// A single reusable "drag a rectangle to box-select" overlay. Bone-picking
// (posing.js) and object-picking (Viewport.jsx) both use this instead of
// each owning their own DOM element, since only one marquee can ever be
// active at a time anyway (you're in one mode or the other).
let el = null

// Show/update the rectangle between two viewport-relative points. `container`
// is the positioned element the marquee is drawn inside of (must already be
// position: relative/absolute — see .viewport-canvas-host).
export function showMarquee(container, x0, y0, x1, y1) {
  if (!el) {
    el = document.createElement('div')
    el.className = 'marquee-select-box'
    container.appendChild(el)
  } else if (el.parentElement !== container) {
    container.appendChild(el)
  }
  el.style.left = `${Math.min(x0, x1)}px`
  el.style.top = `${Math.min(y0, y1)}px`
  el.style.width = `${Math.abs(x1 - x0)}px`
  el.style.height = `${Math.abs(y1 - y0)}px`
}

export function hideMarquee() {
  if (el) {
    el.remove()
    el = null
  }
}

// Screen-space rectangle test shared by both pickers: does the projected
// point (sx, sy) fall within the drag rectangle defined by (x0,y0)-(x1,y1)?
export function pointInRect(sx, sy, x0, y0, x1, y1) {
  const minX = Math.min(x0, x1)
  const maxX = Math.max(x0, x1)
  const minY = Math.min(y0, y1)
  const maxY = Math.max(y0, y1)
  return sx >= minX && sx <= maxX && sy >= minY && sy <= maxY
}