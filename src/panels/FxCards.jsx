import React from 'react'

// The building blocks of the card layout first made for Soft cloth: an intro card, numbered step cards,
// collapsible item cards with pills, button footers. Every effect-style section (soft cloth, bone physics,
// IK pins, flattener, add bones, regions...) uses these so they all read the same way. The styles live in
// index.css under `.fx-*`.

// Wrap a whole section: `<FxEditor>` is the grid that spaces the cards.
export function FxEditor({ children, className = '', ...rest }) {
  return (
    <div className={('fx-editor ' + className).trim()} {...rest}>
      {children}
    </div>
  )
}

// The tinted card at the top: what this section is for, in a line or two.
export function FxIntro({ eyebrow, title, children, note }) {
  return (
    <header className="fx-intro">
      <div className="fx-eyebrow">{eyebrow}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {note && <div className="fx-intro-note">{note}</div>}
    </header>
  )
}

export function FxAlert({ children }) {
  return <div className="fx-alert">{children}</div>
}

// A step card: "STEP 1  Title" with an optional count badge on the right. `tone="list"` is the card for things
// already made, `tone="form"` the one with the controls for making more (they look the same; the name is for the reader).
export function FxSection({ step, title, count, countLabel, label, children, actions }) {
  return (
    <section className="fx-effects" aria-label={label}>
      <div className="fx-section-heading">
        <div>
          {step && <div className="fx-step">{step}</div>}
          <h4>{title}</h4>
        </div>
        {actions}
        {count != null && (
          <span className="fx-count" aria-label={countLabel || `${count}`}>
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

// One made thing (a chain, a pin, a flattener): collapsed it is a title pill plus small pills; open it shows its controls.
// pills: [{ text, tone? }] — tone 'swing' tints it blue like the Swing zones.
export function FxItem({ title, tone, pills = [], disabled = false, children, onSummaryClick, defaultOpen }) {
  return (
    <details className={`fx-zone${disabled ? ' is-disabled' : ''}`} open={defaultOpen || undefined}>
      <summary className="fx-zone-summary" onClick={onSummaryClick}>
        <span className={`fx-zone-title${tone === 'swing' ? ' is-swing' : ''}`}>{title}</span>
        {pills.map((p, i) => (
          <span key={i} className="fx-zone-area">
            {typeof p === 'string' ? p : p.text}
          </span>
        ))}
      </summary>
      {children}
    </details>
  )
}

// The row at the top of an open item: the On switch on the left, its buttons on the right.
export function FxItemActions({ left, children }) {
  return (
    <div className="fx-zone-actions">
      {left || <span />}
      <span>{children}</span>
    </div>
  )
}

export function FxFooter({ children }) {
  return <div className="fx-footer">{children}</div>
}

// A group of buttons that sits under a form. By default they are small pills that wrap.
//   wide     one even row of equal-width buttons; a button with className "fx-btn-main" gets twice the room
//            (use it for the main action next to its partner, e.g. Pick faces + Clear)
//   columns  an even grid with that many columns (use it for a set of choices, e.g. presets)
// Two `wide` rows in a row sit close together, so a pair of rows reads as one tool.
export function FxButtons({ children, wide = false, columns }) {
  const cls = `fx-buttons${wide ? ' is-wide' : ''}${columns ? ' is-grid' : ''}`
  return (
    <div className={cls} style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {children}
    </div>
  )
}

export function FxCheck({ checked, onChange, children, title, disabled, ariaLabel }) {
  return (
    <label className="fx-check" title={title}>
      <input type="checkbox" checked={checked} disabled={disabled} aria-label={ariaLabel} onChange={(e) => onChange(e.target.checked, e)} />
      <span>{children}</span>
    </label>
  )
}

// Label above a control, like the dropdowns in Soft cloth.
export function FxField({ label, children, title }) {
  return (
    <label className="field" title={title}>
      <span>{label}</span>
      {children}
    </label>
  )
}

export function FxHelp({ children }) {
  return <div className="fx-help">{children}</div>
}

// The cyan box used while you click on the model to pick something.
export function FxPicking({ children }) {
  return <div className="fx-picking">{children}</div>
}

export function FxEmpty({ children }) {
  return <div className="fx-empty">{children}</div>
}

// A collapsible card for a whole tool inside a long panel (Add bones, Paint regions...).
export function FxCollapse({ title, hint, children, defaultOpen, onToggle, summaryExtra }) {
  return (
    <details className="fx-card" open={defaultOpen || undefined} onToggle={onToggle}>
      <summary className="fx-card-summary">
        <span className="fx-card-title">{title}</span>
        {hint && <span className="fx-card-hint">{hint}</span>}
        {summaryExtra}
      </summary>
      <div className="fx-card-body">{children}</div>
    </details>
  )
}
