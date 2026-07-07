import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// NOTE: StrictMode is intentionally omitted. In dev it double-invokes effects,
// which would create/tear down the WebGL context twice and risk leaking GL
// contexts (browsers cap how many exist at once). A single stable canvas is
// safer for a Three.js app.
ReactDOM.createRoot(document.getElementById('root')).render(<App />)
