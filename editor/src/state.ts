// Editor state: the open project, selection, playhead, undo history, autosave,
// and the live link to project.json on disk.
import { batch, computed, signal } from '@preact/signals'
import type { Aspect, Clip, El, Project, Tween } from './types'
import { audio } from './audio'

export const project = signal<Project | null>(null)
export const projectName = signal('')
export const aspect = signal<Aspect>((localStorage.getItem('ml.aspect') as Aspect) || 'wide')
export const time = signal(0)
export const playing = signal(false)
export const loop = signal(false)
export const selEls = signal<string[]>([])
export const selTweens = signal<string[]>([])
export const selClips = signal<string[]>([])
export const collapsed = signal<Set<string>>(new Set())
export const saveState = signal<'saved' | 'saving' | 'dirty' | 'error'>('saved')
export const toast = signal<{ text: string; kind?: 'error' | 'info' } | null>(null)
export const zoom = signal(Number(localStorage.getItem('ml.zoom')) || 80) // timeline px per second

export const FPS = 30

export const elMap = computed(() => new Map((project.value?.elements ?? []).map((e) => [e.id, e])))
export const tweenMap = computed(() => new Map((project.value?.tweens ?? []).map((t) => [t.id, t])))
export const clipMap = computed(() => new Map((project.value?.audio ?? []).map((c) => [c.id, c])))

export function flash(text: string, kind: 'error' | 'info' = 'info') {
  toast.value = { text, kind }
  const mine = toast.value
  setTimeout(() => toast.value === mine && (toast.value = null), kind === 'error' ? 6000 : 2500)
}

export function uid(prefix: string) {
  const taken = new Set([...elMap.value.keys(), ...tweenMap.value.keys(), ...clipMap.value.keys()])
  for (;;) {
    const id = prefix + Math.random().toString(36).slice(2, 7)
    if (!taken.has(id)) return id
  }
}

// ---------------------------------------------------------------- history ---

const past: Project[] = []
const future: Project[] = []
let lastMerge = ''
let lastMergeAt = 0
let gestureBase: Project | null = null

// One undoable change. Edits that share a merge key within 1.5 s (typing in a
// field, scrubbing a number) collapse into one undo step.
export function commit(fn: (p: Project) => void, merge = '') {
  const before = project.value
  if (!before) return
  const next = structuredClone(before)
  fn(next)
  const now = performance.now()
  if (!(merge && merge === lastMerge && now - lastMergeAt < 1500)) {
    past.push(before)
    if (past.length > 300) past.shift()
  }
  future.length = 0
  lastMerge = merge
  lastMergeAt = now
  project.value = next
  scheduleSave()
}

// Drags: every move re-applies the change to the state at pointer-down, and
// the whole drag is one undo step.
export function beginGesture() {
  gestureBase = project.value
  lastMerge = ''
}
export function gesture(fn: (p: Project) => void) {
  if (!gestureBase) return
  const next = structuredClone(gestureBase)
  fn(next)
  project.value = next
  scheduleSave()
}
export function endGesture() {
  if (gestureBase && project.value !== gestureBase) {
    past.push(gestureBase)
    future.length = 0
  }
  gestureBase = null
}

export function undo() {
  const prev = past.pop()
  if (!prev || !project.value) return
  future.push(project.value)
  project.value = prev
  lastMerge = ''
  pruneSelection()
  scheduleSave()
}
export function redo() {
  const next = future.pop()
  if (!next || !project.value) return
  past.push(project.value)
  project.value = next
  lastMerge = ''
  pruneSelection()
  scheduleSave()
}

function pruneSelection() {
  selEls.value = selEls.value.filter((id) => elMap.value.has(id))
  selTweens.value = selTweens.value.filter((id) => tweenMap.value.has(id))
  selClips.value = selClips.value.filter((id) => clipMap.value.has(id))
}

// -------------------------------------------------------------- selection ---

export function select(kind: 'el' | 'tween' | 'clip', id: string | null, add = false) {
  batch(() => {
    const toggle = (list: string[]) => (id == null ? [] : list.includes(id) ? list.filter((x) => x !== id) : [...list, id])
    if (kind === 'el') {
      selEls.value = add ? toggle(selEls.value) : id ? [id] : []
      selTweens.value = []
      selClips.value = []
    } else if (kind === 'tween') {
      selTweens.value = add ? toggle(selTweens.value) : id ? [id] : []
      const targets = selTweens.value.map((t) => tweenMap.value.get(t)?.target).filter(Boolean) as string[]
      selEls.value = [...new Set(targets)]
      selClips.value = []
    } else {
      selClips.value = add ? toggle(selClips.value) : id ? [id] : []
      selEls.value = []
      selTweens.value = []
    }
  })
}

export function clearSelection() {
  batch(() => {
    selEls.value = []
    selTweens.value = []
    selClips.value = []
  })
}

// ----------------------------------------------------------- persistence ---

let saveTimer = 0
let lastSavedMtime = 0
let saving: Promise<void> | null = null

function scheduleSave() {
  saveState.value = 'dirty'
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(save, 400)
}

async function save() {
  const p = project.value
  const name = projectName.value
  if (!p || !name) return
  saveState.value = 'saving'
  saving = (async () => {
    try {
      const r = await fetch(`/api/projects/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
      if (!r.ok) throw new Error(await r.text())
      lastSavedMtime = (await r.json()).mtime
      if (project.value === p) saveState.value = 'saved'
    } catch (e) {
      saveState.value = 'error'
      flash(`Save failed: ${e}`, 'error')
    }
  })()
  await saving
  saving = null
}

let events: EventSource | null = null

export async function openProject(name: string) {
  if (saveState.value === 'dirty') {
    clearTimeout(saveTimer)
    await save()
  }
  const r = await fetch(`/api/projects/${name}`, { cache: 'no-store' })
  if (!r.ok) {
    flash(`No project "${name}"`, 'error')
    return
  }
  const p: Project = await r.json()
  lastSavedMtime = Number(r.headers.get('X-Mtime')) || 0
  audio.stop()
  batch(() => {
    past.length = 0
    future.length = 0
    projectName.value = name
    project.value = p
    playing.value = false
    time.value = 0
    saveState.value = 'saved'
    clearSelection()
  })
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`)
  localStorage.setItem('ml.last', name)
  document.title = `${name} · motion-lab`
  audio.preload(p, name)

  // Pick up edits made to project.json outside the editor (by Claude).
  events?.close()
  events = new EventSource(`/api/projects/${name}/events`)
  events.onmessage = async (ev) => {
    const { mtime } = JSON.parse(ev.data)
    if (Math.abs(mtime - lastSavedMtime) < 1e-6 || saving || saveState.value === 'dirty' || gestureBase) return
    const res = await fetch(`/api/projects/${name}`, { cache: 'no-store' })
    if (!res.ok || projectName.value !== name) return
    const fresh: Project = await res.json()
    lastSavedMtime = Number(res.headers.get('X-Mtime')) || mtime
    if (project.value) past.push(project.value)
    project.value = fresh
    pruneSelection()
    audio.preload(fresh, name)
    flash('Reloaded: project.json changed on disk')
  }
}

export async function newProject(name: string) {
  const r = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  if (!r.ok) {
    flash((await r.json()).detail ?? 'Could not create project', 'error')
    return
  }
  await openProject(name)
}

export const assetUrl = (src: string) => `/projects/${projectName.value}/${src}`

// ---------------------------------------------------------------- playback ---

let raf = 0
export function play() {
  const p = project.value
  if (!p || playing.value) return
  if (time.value >= p.duration - 1 / FPS) time.value = 0
  playing.value = true
  const clock = audio.play(p, projectName.value, time.value)
  const tick = () => {
    if (!playing.value) return
    let t = clock()
    if (t >= p.duration) {
      if (loop.value) {
        audio.stop()
        time.value = 0
        playing.value = false
        play()
        return
      }
      t = p.duration
      pause()
    }
    time.value = t
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

export function pause() {
  playing.value = false
  cancelAnimationFrame(raf)
  audio.stop()
}

export function togglePlay() {
  playing.value ? pause() : play()
}

export function seek(t: number) {
  const p = project.value
  if (!p) return
  const was = playing.value
  if (was) pause()
  time.value = Math.max(0, Math.min(p.duration, t))
  if (was) play()
}

// --------------------------------------------------------------- helpers ---

export function tweensOf(id: string, p = project.value): Tween[] {
  return (p?.tweens ?? []).filter((t) => t.target === id).sort((a, b) => a.start - b.start)
}

export function childrenOf(id: string | null, p = project.value): El[] {
  return (p?.elements ?? []).filter((e) => (e.parent ?? null) === id)
}

export function descendants(id: string, p = project.value): string[] {
  const out: string[] = []
  const walk = (pid: string) => {
    for (const c of childrenOf(pid, p)) {
      out.push(c.id)
      walk(c.id)
    }
  }
  walk(id)
  return out
}

export function deleteSelection() {
  const els = selEls.value
  const tws = selTweens.value
  const clips = selClips.value
  if (tws.length) {
    commit((p) => {
      p.tweens = p.tweens.filter((t) => !tws.includes(t.id))
    })
    selTweens.value = []
    return
  }
  if (clips.length) {
    commit((p) => {
      p.audio = p.audio.filter((c) => !clips.includes(c.id))
    })
    selClips.value = []
    return
  }
  if (els.length) {
    const gone = new Set(els.flatMap((id) => [id, ...descendants(id)]))
    commit((p) => {
      p.elements = p.elements.filter((e) => !gone.has(e.id))
      p.tweens = p.tweens.filter((t) => !gone.has(t.target))
    })
    clearSelection()
  }
}

export function duplicateSelection() {
  const p0 = project.value
  if (!p0) return
  if (selTweens.value.length) {
    const ids: string[] = []
    commit((p) => {
      for (const id of selTweens.value) {
        const t = p.tweens.find((x) => x.id === id)
        if (!t) continue
        const copy = { ...structuredClone(t), id: uid('t'), start: t.start + t.dur }
        ids.push(copy.id)
        p.tweens.push(copy)
      }
    })
    selTweens.value = ids
    return
  }
  if (selClips.value.length) {
    const ids: string[] = []
    commit((p) => {
      for (const id of selClips.value) {
        const c = p.audio.find((x) => x.id === id)
        if (!c) continue
        const copy: Clip = { ...structuredClone(c), id: uid('a'), start: c.start + c.dur }
        ids.push(copy.id)
        p.audio.push(copy)
      }
    })
    selClips.value = ids
    return
  }
  if (selEls.value.length) {
    const ids: string[] = []
    commit((p) => {
      for (const root of selEls.value) {
        const subtree = [root, ...descendants(root, p)]
        const idMap = new Map(subtree.map((id) => [id, uid('e')]))
        const copies = p.elements
          .filter((e) => idMap.has(e.id))
          .map((e) => {
            const c: El = structuredClone(e)
            c.id = idMap.get(e.id)!
            if (e.id === root) {
              c.name = `${e.name} copy`
              c.props.x += 30
              c.props.y += 30
              if (c.tall?.x != null) c.tall.x += 30
              if (c.tall?.y != null) c.tall.y += 30
            } else c.parent = idMap.get(e.parent!)!
            return c
          })
        const last = Math.max(...subtree.map((id) => p.elements.findIndex((e) => e.id === id)))
        p.elements.splice(last + 1, 0, ...copies)
        for (const t of p.tweens.filter((t) => idMap.has(t.target)))
          p.tweens.push({ ...structuredClone(t), id: uid('t'), target: idMap.get(t.target)! })
        ids.push(idMap.get(root)!)
      }
    })
    selEls.value = ids
  }
}

export function setAspect(a: Aspect) {
  aspect.value = a
  localStorage.setItem('ml.aspect', a)
}

export function setZoom(z: number) {
  zoom.value = Math.max(8, Math.min(1200, z))
  localStorage.setItem('ml.zoom', String(zoom.value))
}
