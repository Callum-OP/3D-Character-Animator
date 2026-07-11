import { useEffect, useRef, useState } from 'react'

// A numeric readout that turns into a text field when clicked, so you can type
// an exact value instead of nudging the slider. Enter or blur commits (clamped
// to min/max); Escape cancels.
//
// `format(value)` builds the display string (may include units like ° or %).
// Some sliders show a scaled number (e.g. width shows value*1000), so `toInput`
// maps the raw value to the number shown while editing and `fromInput` maps the
// typed number back to a raw value. Both default to identity.
export default function EditableValue({
  value,
  min,
  max,
  onChange,
  format,
  toInput = (v) => v,
  fromInput = (v) => v,
  disabled,
  className = 'slider-value',
  label,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  function begin() {
    if (disabled) return
    setDraft(String(toInput(value)))
    setEditing(true)
  }

  function commit() {
    const typed = Number(draft)
    if (Number.isFinite(typed)) {
      let v = fromInput(typed)
      if (min != null) v = Math.max(min, v)
      if (max != null) v = Math.min(max, v)
      onChange(v)
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        className={`${className} editable-value-input`}
        min={min != null ? toInput(min) : undefined}
        max={max != null ? toInput(max) : undefined}
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <span
      className={`${className} editable-value${disabled ? ' disabled' : ''}`}
      onClick={begin}
      role="button"
      tabIndex={disabled ? -1 : 0}
      title={disabled ? undefined : 'Click to type an exact value'}
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          begin()
        }
      }}
    >
      {format(value)}
    </span>
  )
}
