import React from 'react'
import { createRoot } from 'react-dom/client'
// Static on purpose: the call-engine window must be subscribed to `call:command` before
// `did-finish-load` fires (the host emits `start` right after the window reports loaded).
import { bootCallEngine, isCallEngineView } from './call-engine/boot'
import './styles.css'

if (isCallEngineView()) {
  // Phase 10.1: hidden call-engine window — no UI, no stage, no app store; only the call boot.
  bootCallEngine()
} else {
  // The app (and its stores) is loaded only for the hub/overlay views.
  void import('./App').then(({ App }) => {
    const container = document.getElementById('root')
    if (container) {
      const root = createRoot(container)
      root.render(
        <React.StrictMode>
          <App />
        </React.StrictMode>,
      )
    }
  })
}
