// Edits that know about the project's structure: layout per aspect, element
// creation, grouping, layer moves, and tween presets.
import { signal } from '@preact/signals'
import type { AnimProp, Aspect, El, ElType, Folder, Project, Props, Tween, VideoClip } from './types'
import { SIZES } from './types'
import { resolveProps } from './player'
import { aspect, childrenOf, collapsed, commit, descendants, flash, project, projectName, select, selEls, time, uid } from './state'

// Write a layout prop for the current aspect. 16:9 edits the base props (and
// so also 9:16, unless 9:16 overrides that prop); 9:16 edits write overrides.
export function setLayout(el: El, key: keyof Props, value: unknown, a: Aspect = aspect.value) {
  if (a === 'tall') {
    el.tall = { ...(el.tall ?? {}), [key]: value }
  } else {
    ;(el.props as unknown as Record<string, unknown>)[key] = value
  }
}

export function clearOverride(el: El, key: keyof Props) {
  if (!el.tall) return
  delete el.tall[key]
  if (!Object.keys(el.tall).length) delete el.tall
}

export const LAYOUT_KEYS: (keyof Props)[] = ['x', 'y', 'w', 'h', 'rotation', 'scale', 'opacity', 'size', 'align']

const DEFAULTS: Record<Exclude<ElType, 'group'>, (w: number, h: number) => Partial<Props>> = {
  text: () => ({ w: 900, h: 140, text: 'New text', font: 'Inter', size: 72, weight: 800, color: '#e6e1f2', align: 'center' }),
  rect: () => ({ w: 400, h: 240, fill: '#b07cf5', radius: 24 }),
  ellipse: () => ({ w: 240, h: 240, fill: '#5ef1ff' }),
  path: () => ({ w: 600, h: 200, d: 'M20 180 C 200 0, 400 0, 580 180', stroke: '#ff5ef1', strokeWidth: 10, fill: 'rgba(0,0,0,0)' }),
  image: () => ({ w: 600, h: 400, fit: 'contain' }),
  video: () => ({ w: 960, h: 540, fit: 'cover' }),
}

const NAMES: Record<ElType, string> = { text: 'Text', rect: 'Rectangle', ellipse: 'Ellipse', path: 'Path', image: 'Image', video: 'Video', group: 'Group' }

function uniqueName(p: Project, base: string) {
  const names = new Set(p.elements.map((e) => e.name))
  if (!names.has(base)) return base
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`
}

export function addElement(type: Exclude<ElType, 'group'>, extra: Partial<Props> = {}, name?: string, clip?: VideoClip) {
  const [W, H] = SIZES[aspect.value]
  const id = uid('e')
  commit((p) => {
    const base = DEFAULTS[type](W, H)
    const el: El = { id, type, name: uniqueName(p, name ?? NAMES[type]), props: { x: W / 2, y: H / 2, w: 300, h: 300, ...base, ...extra } as Props }
    const f = currentFolder(p)
    if (f) el.folder = f
    if (clip) {
      el.clip = clip
      // Make room for the whole clip.
      if (clip.start + clip.dur > p.duration) p.duration = Math.round((clip.start + clip.dur) * 100) / 100
    }
    p.elements.push(el)
  })
  select('el', id)
  return id
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mts)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i
export const isVideo = (f: File) => f.type.startsWith('video/') || VIDEO_EXT.test(f.name)
export const isImage = (f: File) => f.type.startsWith('image/') || IMAGE_EXT.test(f.name)

async function upload(f: File, kind = '') {
  const fd = new FormData()
  fd.append('file', f)
  if (kind) fd.append('kind', kind)
  const r = await fetch(`/api/projects/${projectName.value}/assets`, { method: 'POST', body: fd })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? r.statusText)
  return r.json()
}

const baseName = (f: File) => f.name.replace(/\.[^.]+$/, '')

// Size a w x h picture to fit inside the stage (never upscaled past it).
function fitStage(w = 1920, h = 1080, frac = 1) {
  const [W, H] = SIZES[aspect.value]
  const k = Math.min((W * frac) / w, (H * frac) / h)
  return { w: Math.round(w * k), h: Math.round(h * k) }
}

// Images and videos dropped on the canvas or picked from + Add.
export async function importVisual(f: File, at = time.value) {
  try {
    if (isVideo(f)) {
      flash(`Importing ${f.name}… (making an editing copy, can take a bit for long clips)`)
      const info = await upload(f, 'video')
      const clip: VideoClip = { start: Math.round(at * 1000) / 1000, offset: 0, dur: info.dur, srcDur: info.dur, volume: 1, audio: info.audio, thumbs: info.thumbs }
      addElement('video', { src: info.src, ...fitStage(info.w, info.h), fit: 'cover' }, baseName(f), clip)
      flash(`Added ${f.name} (${info.dur.toFixed(1)} s${info.audio ? ', with sound' : ''})`)
    } else if (isImage(f)) {
      const info = await upload(f)
      addElement('image', { src: info.src, ...fitStage(info.w, info.h, 0.6) }, baseName(f))
    } else {
      flash(`${f.name}: drop audio on a timeline track instead`, 'error')
    }
  } catch (e) {
    flash(`Import failed: ${e}`, 'error')
  }
}

export function pickVisual(accept: string) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.multiple = true
  input.onchange = async () => {
    for (const f of [...(input.files ?? [])]) await importVisual(f)
  }
  input.click()
}

// Center-based box of an element in its parent's space, for one aspect.
function box(el: El, a: Aspect) {
  const p = resolveProps(el, a)
  return { l: p.x - p.w / 2, t: p.y - p.h / 2, r: p.x + p.w / 2, b: p.y + p.h / 2 }
}

// Wrap elements (same parent) in a group sized to fit them, in both layouts.
export function groupSelection(ids: string[]) {
  const p0 = project.value
  if (!p0 || !ids.length) return
  const els = p0.elements.filter((e) => ids.includes(e.id))
  const parent = els[0].parent ?? null
  if (els.some((e) => (e.parent ?? null) !== parent)) return
  const gid = uid('g')
  commit((p) => {
    const members = p.elements.filter((e) => ids.includes(e.id))
    const g: El = { id: gid, type: 'group', name: uniqueName(p, 'Group'), parent, props: { x: 0, y: 0, w: 0, h: 0 } }
    if (!parent && members[0].folder) g.folder = members[0].folder
    for (const a of ['wide', 'tall'] as const) {
      const bs = members.map((e) => box(e, a))
      const l = Math.min(...bs.map((b) => b.l)), t = Math.min(...bs.map((b) => b.t))
      const r = Math.max(...bs.map((b) => b.r)), b = Math.max(...bs.map((b) => b.b))
      const rect = { x: (l + r) / 2, y: (t + b) / 2, w: r - l, h: b - t }
      if (a === 'wide') Object.assign(g.props, rect)
      else if (rect.x !== g.props.x || rect.y !== g.props.y || rect.w !== g.props.w || rect.h !== g.props.h) g.tall = rect
      for (const e of members) {
        const ep = resolveProps(e, a)
        setLayout(e, 'x', ep.x - l, a)
        setLayout(e, 'y', ep.y - t, a)
      }
    }
    for (const e of members) {
      e.parent = gid
      delete e.folder
      if (e.tall && e.tall.x === e.props.x && e.tall.y === e.props.y) {
        delete e.tall.x
        delete e.tall.y
        if (!Object.keys(e.tall).length) delete e.tall
      }
    }
    // The group takes the place of its lowest member; members (with their own
    // children) follow it in their existing order.
    const inside = new Set(members.flatMap((m) => [m.id, ...descendants(m.id, p)]))
    const subs = p.elements.filter((e) => inside.has(e.id))
    const at = p.elements.findIndex((e) => inside.has(e.id))
    p.elements = p.elements.filter((e) => !inside.has(e.id))
    p.elements.splice(at, 0, g, ...subs)
  })
  select('el', gid)
}

export function ungroup(gid: string) {
  const p0 = project.value
  const g = p0?.elements.find((e) => e.id === gid)
  if (!p0 || !g || g.type !== 'group') return
  const kids = childrenOf(gid).map((e) => e.id)
  commit((p) => {
    const grp = p.elements.find((e) => e.id === gid)!
    for (const e of p.elements.filter((e) => kids.includes(e.id))) {
      for (const a of ['wide', 'tall'] as const) {
        const gp = resolveProps(grp, a)
        const ep = resolveProps(e, a)
        setLayout(e, 'x', ep.x + gp.x - gp.w / 2, a)
        setLayout(e, 'y', ep.y + gp.y - gp.h / 2, a)
      }
      e.parent = grp.parent ?? null
      if (!e.parent && grp.folder) e.folder = grp.folder
    }
    p.elements = p.elements.filter((e) => e.id !== gid)
    p.tweens = p.tweens.filter((t) => t.target !== gid)
  })
  select('el', kids[0] ?? null)
}

// Move element `id` (and its subtree) next to `ref` in paint order: `above`
// draws it on top of ref. `into` makes it the top child of group `ref`.
export function moveLayer(id: string, ref: string, where: 'above' | 'below' | 'into') {
  const p0 = project.value
  if (!p0 || id === ref || descendants(id).includes(ref)) return
  commit((p) => {
    const sub = [id, ...descendants(id, p)]
    const moving = p.elements.filter((e) => sub.includes(e.id))
    p.elements = p.elements.filter((e) => !sub.includes(e.id))
    const el = moving[0]
    const refEl = p.elements.find((e) => e.id === ref)!
    const newParent = where === 'into' ? ref : (refEl.parent ?? null)
    if ((el.parent ?? null) !== newParent) {
      // Keep it where it is on screen: convert between the two parents' spaces.
      for (const a of ['wide', 'tall'] as const) {
        const [ox, oy] = origin(p, el.parent ?? null, a)
        const [nx, ny] = origin(p, newParent, a)
        const ep = resolveProps(el, a)
        setLayout(el, 'x', ep.x + ox - nx, a)
        setLayout(el, 'y', ep.y + oy - ny, a)
      }
      el.parent = newParent
    }
    // Dropped next to something: it joins that thing's folder (or none).
    if (newParent == null && refEl.folder) el.folder = refEl.folder
    else delete el.folder
    let at: number
    if (where === 'into') {
      const kids = [ref, ...descendants(ref, p)]
      at = Math.max(...kids.map((k) => p.elements.findIndex((e) => e.id === k))) + 1
    } else if (where === 'above') {
      const refSub = [ref, ...descendants(ref, p)]
      at = Math.max(...refSub.map((k) => p.elements.findIndex((e) => e.id === k))) + 1
    } else at = p.elements.findIndex((e) => e.id === ref)
    p.elements.splice(at, 0, ...moving)
  })
}

// Top-left corner of a group's content box in stage space (groups unscaled).
function origin(p: Project, gid: string | null, a: Aspect): [number, number] {
  let x = 0, y = 0
  let cur = gid ? p.elements.find((e) => e.id === gid) : undefined
  while (cur) {
    const gp = resolveProps(cur, a)
    x += gp.x - gp.w / 2
    y += gp.y - gp.h / 2
    cur = cur.parent ? p.elements.find((e) => e.id === cur!.parent) : undefined
  }
  return [x, y]
}

// ------------------------------------------------------------- presets ---

type Preset = { name: string; only?: ElType[]; make: (el: El, t: number) => Omit<Tween, 'id' | 'target'>[] }

export const PRESETS: Preset[] = [
  { name: 'Fade in', make: (_, t) => [{ start: t, dur: 0.5, ease: 'power2.out', props: { opacity: [0, 1] } }] },
  { name: 'Fade out', make: (_, t) => [{ start: t, dur: 0.5, ease: 'power2.in', props: { opacity: [null, 0] } }] },
  { name: 'Slide up in', make: (_, t) => [{ start: t, dur: 0.7, ease: 'power3.out', props: { y: [60, 0], opacity: [0, 1] } }] },
  { name: 'Slide in from left', make: (_, t) => [{ start: t, dur: 0.7, ease: 'power3.out', props: { x: [-240, 0], opacity: [0, 1] } }] },
  { name: 'Pop in', make: (_, t) => [{ start: t, dur: 0.6, ease: 'back.out(1.7)', props: { scale: [0, 1] } }] },
  { name: 'Pop out', make: (_, t) => [{ start: t, dur: 0.4, ease: 'back.in(1.7)', props: { scale: [null, 0] } }] },
  { name: 'Blur in', make: (_, t) => [{ start: t, dur: 0.8, ease: 'power2.out', props: { blur: [24, 0], opacity: [0, 1] } }] },
  { name: 'Move', make: (_, t) => [{ start: t, dur: 0.8, ease: 'power2.inOut', props: { x: [null, 200], y: [null, 0] } }] },
  {
    name: 'Pulse',
    make: (_, t) => [
      { start: t, dur: 0.18, ease: 'power2.out', props: { scale: [null, 1.15] } },
      { start: t + 0.18, dur: 0.32, ease: 'power2.inOut', props: { scale: [null, 1] } },
    ],
  },
  { name: 'Spin', make: (_, t) => [{ start: t, dur: 1, ease: 'power2.inOut', props: { rotation: [null, 360] } }] },
  {
    name: 'Change color',
    make: (el, t) => [{ start: t, dur: 0.4, ease: 'power1.inOut', props: { [el.type === 'text' ? 'color' : el.type === 'path' ? 'stroke' : 'fill']: [null, '#ff5ea0'] } }],
  },
  {
    name: 'Reveal text',
    only: ['text'],
    make: (el, t) => [{ start: t, dur: Math.min(2.5, 0.4 + (el.props.text?.length ?? 10) * 0.03), ease: 'none', props: { reveal: [0, 1] } }],
  },
  { name: 'Draw on', only: ['path'], make: (_, t) => [{ start: t, dur: 1.2, ease: 'power1.inOut', props: { draw: [0, 1] } }] },
  { name: 'Grow width', only: ['rect', 'ellipse'], make: (el, t) => [{ start: t, dur: 0.8, ease: 'power3.out', props: { w: [0, el.props.w] } }] },
]

export function applyPreset(elId: string, preset: Preset, t = time.value) {
  const el = project.value?.elements.find((e) => e.id === elId)
  if (!el) return
  const ids: string[] = []
  commit((p) => {
    for (const tw of preset.make(el, t)) {
      const id = uid('t')
      ids.push(id)
      p.tweens.push({ id, target: elId, ...tw, start: Math.round(tw.start * 1000) / 1000 })
    }
  })
  select('tween', ids[0])
}

export const EASES = [
  'none',
  'power1.out', 'power1.in', 'power1.inOut',
  'power2.out', 'power2.in', 'power2.inOut',
  'power3.out', 'power3.in', 'power3.inOut',
  'power4.out', 'power4.in', 'power4.inOut',
  'back.out(1.7)', 'back.in(1.7)', 'back.inOut(1.7)',
  'elastic.out(1,0.4)', 'elastic.in(1,0.4)',
  'bounce.out', 'bounce.in',
  'expo.out', 'expo.in', 'expo.inOut',
  'circ.out', 'circ.inOut',
  'sine.out', 'sine.inOut',
  'steps(6)',
]

export const PROP_LABEL: Record<AnimProp, string> = {
  x: 'Move X', y: 'Move Y', scale: 'Scale ×', rotation: 'Rotate +', opacity: 'Opacity ×', blur: 'Blur', w: 'Width', h: 'Height',
  fill: 'Fill', color: 'Text color', stroke: 'Stroke', glow: 'Glow', draw: 'Draw', reveal: 'Reveal',
}

export const PROP_COLOR: Record<AnimProp, string> = {
  x: '#5ef1ff', y: '#5ef1ff', scale: '#b07cf5', rotation: '#b07cf5', opacity: '#8d84a3', blur: '#8d84a3',
  w: '#5ea1ff', h: '#5ea1ff', fill: '#ff5ea0', color: '#ff5ea0', stroke: '#ff5ea0', glow: '#ff5ef1', draw: '#5eff6c', reveal: '#5eff6c',
}


// ------------------------------------------------------------- folders ---

export const UNFILED = '~unfiled'
// The folder new elements go into: the one last clicked, or the selected element's.
export const activeFolder = signal<string | null>(null)

export function rootOf(el: El, p: Project): El {
  let cur = el
  while (cur.parent) {
    const up = p.elements.find((e) => e.id === cur.parent)
    if (!up) break
    cur = up
  }
  return cur
}

export function folderIdOf(el: El, p: Project): string | null {
  const f = rootOf(el, p).folder
  return f && (p.folders ?? []).some((x) => x.id === f) ? f : null
}

function currentFolder(p: Project): string | null {
  const sel = selEls.value[0] && p.elements.find((e) => e.id === selEls.value[0])
  if (sel) return folderIdOf(sel, p)
  const a = activeFolder.value
  return a && (p.folders ?? []).some((f) => f.id === a) ? a : null
}

// Root elements in a folder (null = unfiled), paint order.
export function folderMembers(p: Project, fid: string | null): El[] {
  const valid = new Set((p.folders ?? []).map((f) => f.id))
  return p.elements.filter((e) => !e.parent && (fid ? e.folder === fid : !e.folder || !valid.has(e.folder)))
}

// Every element (with group descendants) in a folder.
export function folderAll(p: Project, fid: string | null): string[] {
  return folderMembers(p, fid).flatMap((e) => [e.id, ...descendants(e.id, p)])
}

export type Row =
  | { kind: 'folder'; folder: Folder | null; key: string; count: number }
  | { kind: 'el'; el: El; depth: number }

// What the layers panel and the timeline list, top of the stack first.
export function layerRows(p: Project): Row[] {
  const out: Row[] = []
  const open = (id: string) => !collapsed.value.has(id)
  const walk = (parent: string | null, depth: number, roots?: El[]) => {
    const kids = roots ?? p.elements.filter((e) => (e.parent ?? null) === parent)
    for (let i = kids.length - 1; i >= 0; i--) {
      out.push({ kind: 'el', el: kids[i], depth })
      if (kids[i].type === 'group' && open(kids[i].id)) walk(kids[i].id, depth + 1)
    }
  }
  const folders = p.folders ?? []
  if (!folders.length) {
    walk(null, 0)
    return out
  }
  for (const f of folders) {
    const members = folderMembers(p, f.id)
    out.push({ kind: 'folder', folder: f, key: f.id, count: members.length })
    if (open(f.id)) walk(null, 1, members)
  }
  const loose = folderMembers(p, null)
  if (loose.length) {
    out.push({ kind: 'folder', folder: null, key: UNFILED, count: loose.length })
    if (open(UNFILED)) walk(null, 1, loose)
  }
  return out
}

export function addFolder() {
  const p0 = project.value
  if (!p0) return
  const fid = uid('f')
  const names = new Set((p0.folders ?? []).map((f) => f.name))
  let name = 'Scene 1'
  for (let i = 1; names.has(name); i++) name = `Scene ${i}`
  // Selected elements move into the new folder (their top-level group, if nested).
  const roots = new Set(selEls.value.map((id) => p0.elements.find((e) => e.id === id)).filter(Boolean).map((e) => rootOf(e!, p0).id))
  commit((p) => {
    p.folders = [{ id: fid, name }, ...(p.folders ?? [])]
    for (const e of p.elements) if (roots.has(e.id)) e.folder = fid
  })
  activeFolder.value = fid
  return fid
}

export function renameFolder(fid: string, name: string) {
  commit((p) => {
    const f = p.folders?.find((x) => x.id === fid)
    if (f) f.name = name
  })
}

export function deleteFolder(fid: string) {
  commit((p) => {
    p.folders = (p.folders ?? []).filter((f) => f.id !== fid)
    for (const e of p.elements) if (e.folder === fid) delete e.folder
    if (!p.folders.length) delete p.folders
  })
}

export function putInFolder(ids: string[], fid: string | null) {
  const p0 = project.value
  if (!p0) return
  const nested = ids.map((id) => p0.elements.find((e) => e.id === id)).filter((e) => e?.parent)
  if (nested.length) flash('Items inside a group follow their group: move the group instead', 'error')
  commit((p) => {
    for (const e of p.elements)
      if (ids.includes(e.id) && !e.parent) {
        if (fid) e.folder = fid
        else delete e.folder
      }
  })
}

export function moveFolder(fid: string, ref: string, where: 'above' | 'below') {
  if (fid === ref) return
  commit((p) => {
    const list = p.folders ?? []
    const f = list.find((x) => x.id === fid)
    if (!f) return
    const rest = list.filter((x) => x.id !== fid)
    const i = rest.findIndex((x) => x.id === ref)
    if (i < 0) return
    rest.splice(where === 'above' ? i : i + 1, 0, f)
    p.folders = rest
  })
}

export function toggleFolderHidden(fid: string | null) {
  const p0 = project.value
  if (!p0) return
  const members = folderMembers(p0, fid).map((e) => e.id)
  const allHidden = members.every((id) => p0.elements.find((e) => e.id === id)?.hidden)
  commit((p) => {
    for (const e of p.elements) if (members.includes(e.id)) e.hidden = allHidden ? undefined : true
  })
}
