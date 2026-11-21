import { useEffect, useState } from 'react'

// A collapsible section header. Wraps any
// panel(s) so the sidebar reads as a short list of categories instead of a
// long wall of always-open panels. Open/closed state persists per-section
// for the session (not saved), defaultOpen controls the first render.
//
// Sections that sit inside a panel which itself unmounts when closed (e.g. the sub-sections of
// Export) pass `remember`, so their open/closed choice survives the panel closing and reopening.
const remembered = new Map()
// Mounted sections, so other parts of the app (the title bar) can open one.
const openers = new Map()

// Open a sidebar section from outside and bring it into view. Sections that are not on screen
// yet (a sub-section of Export, whose panel is closed) start open the next time they appear.
export function openAccordion(id, { scroll = true } = {}) {
  remembered.set(id, true)
  openers.get(id)?.()
  if (scroll && typeof document !== 'undefined') {
    setTimeout(() => document.getElementById(`acc-body-${id}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }), 60)
  }
}

// For tests: start every remembered section from its default again.
export function forgetAccordionStates() {
  remembered.clear()
}

export default function Accordion({ id, icon, title, subtitle, defaultOpen = false, children, badge, remember = false }) {
  const [open, setOpen] = useState(() => (remember && remembered.has(id) ? remembered.get(id) : defaultOpen))
  useEffect(() => {
    openers.set(id, () => setOpen(true))
    return () => openers.delete(id)
  }, [id])
  function toggle() {
    const next = !open
    setOpen(next)
    if (remember) remembered.set(id, next)
  }
  return (
    <section className={'acc' + (open ? ' open' : '')}>
      <button
        className="acc-head"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={`acc-body-${id}`}
      >
        <span className="acc-chevron">▸</span>
        {icon && <span className="acc-icon">{icon}</span>}
        <span className="acc-titles">
          <span className="acc-title">{title}</span>
          {subtitle && <span className="acc-subtitle">{subtitle}</span>}
        </span>
        {badge != null && badge !== '' && <span className="acc-badge">{badge}</span>}
      </button>
      {open && (
        <div className="acc-body" id={`acc-body-${id}`}>
          {children}
        </div>
      )}
    </section>
  )
}