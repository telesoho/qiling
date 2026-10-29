import React from 'react'
import ReactDOM from 'react-dom/client'
import BubbleApp from './pet/BubbleApp'
import PetApp from './pet/PetApp'
import './index.css'

type Shell = 'pet' | 'bubble'

async function shell(): Promise<Shell> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    if (getCurrentWindow().label === 'bubble') return 'bubble'
  }
  if (window.location.hash === '#bubble') return 'bubble'
  return 'pet'
}

async function boot() {
  const kind = await shell()
  document.documentElement.classList.add('pet-window')
  document.title = '器灵'
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      {kind === 'bubble' ? <BubbleApp /> : <PetApp />}
    </React.StrictMode>
  )
}

void boot()
