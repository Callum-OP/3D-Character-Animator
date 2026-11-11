import { createPortal } from 'react-dom'

export default function SaveErrorDialog({ error, onClose }) {
  if (!error) return null
  return createPortal(
    <div className="help-backdrop save-error-backdrop">
      <div
        className="help-modal save-error-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="save-error-title"
        aria-describedby="save-error-message"
        onKeyDown={(e) => {
          if (e.key === 'Tab' || e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
          }
        }}
      >
        <h2 id="save-error-title">Save failed</h2>
        <div className="save-error-details" id="save-error-message">
          <strong>Your project could not be saved.</strong>
          <p>{error.message || String(error)}</p>
        </div>
        <p className="help-intro">Your changes are still in the app. Try saving again or use Save As to choose another location.</p>
        <div className="close-guard-actions">
          <button className="btn" onClick={onClose} autoFocus>OK</button>
        </div>
      </div>
    </div>,
    document.body
  )
}
