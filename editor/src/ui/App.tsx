import { useEffect, useState } from 'preact/hooks'
import { useSignalEffect } from '@preact/signals'
import {
  aspect, clearSelection, commit, deleteSelection, duplicateSelection, elMap, FPS, loop, newProject, openProject, playing, project, projectName,
  redo, saveState, seek, selEls, setAspect, time, toast, togglePlay, undo,
} from '../state'
import { groupSelection, setLayout, ungroup } from '../ops'
import { resolveProps } from '../player'
import { recording, stopRecording } from '../recorder'
import { Stage } from './Stage'
import { Icon } from './icons'
import { Timeline, fmt } from './Timeline'
import { Inspector } from './Inspector'
import { Layers } from './Layers'
import { ExportPanel, exportOpen } from './ExportPanel'

function ProjectPicker() {
  const [list, setList] = useState<{ name: string; duration: number }[]>([])
  const [open, setOpen] = useState(false)
  const refresh = () => fetch('/api/projects').then((r) => r.json()).then(setList)
  useEffect(() => {
    if (open) refresh()
  }, [open])
  const create = () => {
    const name = prompt('New project name (lowercase, dashes):')?.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    if (name) newProject(name)
    setOpen(false)
  }
  return (
    <div class="menu-wrap">
      <button class="btn project-btn" onClick={() => setOpen(!open)}>
        {projectName.value || 'Open project'} ▾
      </button>
      {open && (
        <div class="menu" onPointerLeave={() => setOpen(false)}>
          {list.map((p) => (
            <button
              class={p.name === projectName.value ? 'on' : ''}
              onClick={() => {
                setOpen(false)
                openProject(p.name)
              }}
            >
              {p.name} <span class="muted-text">{fmt(p.duration)}</span>
            </button>
          ))}
          <button onClick={create}>+ New project…</button>
        </div>
      )}
    </div>
  )
}

function TopBar() {
  const p = project.value
  return (
    <header class="topbar">
      <span class="logo">motion<b>lab</b></span>
      <ProjectPicker />
      <div class="seg aspect">
        <button class={`btn sm ${aspect.value === 'wide' ? 'on' : ''}`} onClick={() => setAspect('wide')} title="16:9 (tab)">16:9</button>
        <button class={`btn sm ${aspect.value === 'tall' ? 'on' : ''}`} onClick={() => setAspect('tall')} title="9:16 (tab)">9:16</button>
      </div>
      <div class="transport">
        <button class="btn sm" title="Start (home)" onClick={() => seek(0)}><Icon name="start" /></button>
        <button class="btn sm" title="Back one frame (,)" onClick={() => seek(time.value - 1 / FPS)}>◂</button>
        <button class="btn play" title="Play / pause (space)" onClick={togglePlay}>{playing.value ? '❚❚' : '▶'}</button>
        <button class="btn sm" title="Forward one frame (.)" onClick={() => seek(time.value + 1 / FPS)}>▸</button>
        <button class="btn sm" title="End (end)" onClick={() => p && seek(p.duration)}><Icon name="end" /></button>
        <button class={`btn sm ${loop.value ? 'on' : ''}`} title="Loop" onClick={() => (loop.value = !loop.value)}><Icon name="loop" /></button>
        <span class="timecode">
          {fmt(time.value)} <span class="muted-text">/ {fmt(p?.duration ?? 0)}</span>
        </span>
      </div>
      <div class="spacer" />
      <span class={`save ${saveState.value}`}>{{ saved: 'saved', saving: 'saving…', dirty: 'editing', error: 'save failed' }[saveState.value]}</span>
      <button class="btn sm" title="Undo (ctrl+z)" onClick={undo}><Icon name="undo" /></button>
      <button class="btn sm" title="Redo (ctrl+shift+z)" onClick={redo}><Icon name="redo" /></button>
      <button class="btn primary" onClick={() => (exportOpen.value = true)} disabled={!p}>Export</button>
    </header>
  )
}

function nudge(dx: number, dy: number) {
  const a = aspect.value
  const ids = selEls.value
  if (!ids.length) return
  commit((p) => {
    for (const e of p.elements.filter((x) => ids.includes(x.id) && !x.locked)) {
      const r = resolveProps(e, a)
      setLayout(e, 'x', r.x + dx, a)
      setLayout(e, 'y', r.y + dy, a)
    }
  }, `nudge:${ids.join()}`)
}

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t.closest('input, textarea, select, [contenteditable]')) return
  const mod = e.ctrlKey || e.metaKey
  const p = project.value
  if (!p) return
  const k = e.key
  if (k === ' ') {
    e.preventDefault()
    recording.value ? stopRecording() : togglePlay()
  } else if (mod && k.toLowerCase() === 'z') {
    e.preventDefault()
    e.shiftKey ? redo() : undo()
  } else if (mod && k.toLowerCase() === 'y') {
    e.preventDefault()
    redo()
  } else if (mod && k.toLowerCase() === 'd') {
    e.preventDefault()
    duplicateSelection()
  } else if (mod && k.toLowerCase() === 'g') {
    e.preventDefault()
    if (e.shiftKey) {
      const g = selEls.value.map((id) => elMap.value.get(id)).find((x) => x?.type === 'group')
      if (g) ungroup(g.id)
    } else if (selEls.value.length > 1) groupSelection(selEls.value)
  } else if (k === 'Delete' || k === 'Backspace') {
    e.preventDefault()
    deleteSelection()
  } else if (k === 'Escape') {
    clearSelection()
    exportOpen.value = false
  } else if (k === ',' || k === '<') {
    seek(time.value - (e.shiftKey ? 1 : 1 / FPS))
  } else if (k === '.' || k === '>') {
    seek(time.value + (e.shiftKey ? 1 : 1 / FPS))
  } else if (k === 'Home') {
    seek(0)
  } else if (k === 'End') {
    seek(p.duration)
  } else if (k === 'Tab') {
    e.preventDefault()
    setAspect(aspect.value === 'wide' ? 'tall' : 'wide')
  } else if (k.startsWith('Arrow') && selEls.value.length) {
    e.preventDefault()
    const n = e.shiftKey ? 10 : 1
    nudge(k === 'ArrowLeft' ? -n : k === 'ArrowRight' ? n : 0, k === 'ArrowUp' ? -n : k === 'ArrowDown' ? n : 0)
  }
}

export function App() {
  useEffect(() => {
    const fromHash = decodeURIComponent(location.hash.slice(1))
    const last = localStorage.getItem('ml.last')
    if (fromHash) openProject(fromHash)
    else
      fetch('/api/projects')
        .then((r) => r.json())
        .then((list: { name: string }[]) => {
          const pick = list.find((x) => x.name === last) ?? list[0]
          if (pick) openProject(pick.name)
        })
    const onHash = () => {
      const n = decodeURIComponent(location.hash.slice(1))
      if (n && n !== projectName.value) openProject(n)
    }
    window.addEventListener('hashchange', onHash)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  // Recording stops by itself when playback reaches the end.
  useSignalEffect(() => {
    if (!playing.value && recording.value) stopRecording()
  })

  const p = project.value
  return (
    <div class="app">
      <TopBar />
      {p ? (
        <div class="main">
          <Layers />
          <Stage key={projectName.value} />
          <Inspector />
          <Timeline />
        </div>
      ) : (
        <div class="empty-state">
          <h1>motion-lab</h1>
          <p>No project open. Pick one from the menu above or make a new one.</p>
        </div>
      )}
      {exportOpen.value && <ExportPanel />}
      {toast.value && <div class={`toast ${toast.value.kind ?? ''}`}>{toast.value.text}</div>}
    </div>
  )
}
