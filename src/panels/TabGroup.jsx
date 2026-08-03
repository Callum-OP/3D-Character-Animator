import { useState } from 'react'

// Simple in-panel tab switcher. Used to combine several related panels
// (Objects / Cameras / Lights) under one "Scene" category so they don't
// each take up their own always-visible block in the sidebar.
export default function TabGroup({ tabs, defaultTab }) {
  const [active, setActive] = useState(defaultTab || tabs[0].key)
  const current = tabs.find((t) => t.key === active) || tabs[0]
  return (
    <div className="tabgroup">
      <div className="tabgroup-bar">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={'tabgroup-btn' + (t.key === active ? ' active' : '')}
            onClick={() => setActive(t.key)}
            title={t.title || t.label}
          >
            {t.icon && <span className="tabgroup-icon">{t.icon}</span>}
            {t.label}
          </button>
        ))}
      </div>
      <div className="tabgroup-body">{current.render()}</div>
    </div>
  )
}