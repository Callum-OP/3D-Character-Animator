import { useState } from 'react'

// A collapsible section header. Wraps any
// panel(s) so the sidebar reads as a short list of categories instead of a
// long wall of always-open panels. Open/closed state persists per-section
// for the session (not saved), defaultOpen controls the first render.
//
// Sections that sit inside a panel which itself unmounts when closed (e.g. the sub-sections of
// Export) pass `remember`, so their open/closed choice survives the panel closing and reopening.
const remembered = new Map()

// For tests: start every remembered section from its default again.
export function forgetAccordionStates() {
  remembered.clear()
}

export default function Accordion({ id, icon, title, subtitle, defaultOpen = false, children, badge, remember = false }) {
  const [open, setOpen] = useState(() => (remember && remembered.has(id) ? remembered.get(id) : defaultOpen))
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