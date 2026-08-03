import { useState } from 'react'

// A collapsible section header, Blender-"properties tab" style. Wraps any
// panel(s) so the sidebar reads as a short list of categories instead of a
// long wall of always-open panels. Open/closed state persists per-section
// for the session (not saved), defaultOpen controls the first render.
export default function Accordion({ id, icon, title, subtitle, defaultOpen = false, children, badge }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={'acc' + (open ? ' open' : '')}>
      <button
        className="acc-head"
        onClick={() => setOpen((o) => !o)}
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