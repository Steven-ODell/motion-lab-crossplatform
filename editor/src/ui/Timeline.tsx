import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { batch } from '@preact/signals'
import { audio, PEAKS_PER_SEC } from '../audio'
import { recording, startRecording, stopRecording } from '../recorder'
import {
  aspect, beginGesture, collapsed, commit, endGesture, flash, gesture, playing, project, projectName, seek, select, selClips, selEls, selTweens,
  setZoom, time, uid, zoom, FPS,
} from '../state'
import { PRESETS, PROP_COLOR, activeFolder, applyPreset, folderAll, layerRows } from '../ops'
import { compile, easeFn, plainText } from '../player'
import type { AnimProp, Clip, El, Project, TrackKind, Tween } from '../types'
import { TRACKS } from '../types'

const LABEL = 210
const LANE = 26
const AUDIO_H = 56

export function fmt(t: number) {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

// Ease curves drawn inside tween bars, in a 100x20 box stretched to the bar.
const curveCache = new Map<string, { line: string; area: string; y: (v: number) => number }>()
function curveFor(ease: string, down: boolean) {
  const key = `${ease}|${down}`
  let c = curveCache.get(key)
  if (!c) {
    const f = easeFn(ease)
    const N = 48
    const ys = Array.from({ length: N + 1 }, (_, i) => (down ? 1 - f(i / N) : f(i / N)))
    const lo = Math.min(0, ...ys), hi = Math.max(1, ...ys)
    const y = (v: number) => 3 + (1 - (v - lo) / (hi - lo || 1)) * 15
    const line = ys.map((v, i) => `${i ? 'L' : 'M'}${((i / N) * 100).toFixed(2)} ${y(v).toFixed(2)}`).join('')
    c = { line, area: `${line}L100 20L0 20Z`, y }
    curveCache.set(key, c)
  }
  return c
}

function lanesFor(tweens: Tween[]) {
  const sorted = [...tweens].sort((a, b) => a.start - b.start)
  const ends: number[] = []
  const lane = new Map<string, number>()
  for (const t of sorted) {
    let i = ends.findIndex((e) => e <= t.start + 1e-6)
    if (i < 0) i = ends.push(0) - 1
    ends[i] = t.start + t.dur
    lane.set(t.id, i)
  }
  return { lane, count: Math.max(1, ends.length) }
}

const TRACK_NAME: Record<TrackKind, string> = { narration: 'Narration', voice: 'Voice', music: 'Music', sfx: 'SFX' }
const TRACK_COLOR: Record<TrackKind, string> = { narration: '#b07cf5', voice: '#5ef1ff', music: '#ff5ea0', sfx: '#5eff6c' }

export function Timeline() {
  const scroller = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; el: El; t: number } | null>(null)
  const [snapAt, setSnapAt] = useState<number | null>(null)
  const [viewW, setViewW] = useState(1200)
  const tFromX = (clientX: number) => {
    const r = scroller.current!.getBoundingClientRect()
    return Math.max(0, (clientX - r.left - LABEL + scroller.current!.scrollLeft) / zoom.value)
  }

  // Keep the playhead in view while playing.
  useEffect(() => {
    const sc = scroller.current
    if (!sc || !playing.value) return
    const x = time.value * zoom.value
    const view = sc.clientWidth - LABEL
    if (x < sc.scrollLeft || x > sc.scrollLeft + view - 40) sc.scrollLeft = Math.max(0, x - view * 0.2)
  }, [time.value])

  // Ctrl+wheel zooms around the pointer.
  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const t = tFromX(e.clientX)
      const before = t * zoom.value - sc.scrollLeft
      setZoom(zoom.value * Math.exp(-e.deltaY * 0.0015))
      sc.scrollLeft = t * zoom.value - before
    }
    sc.addEventListener('wheel', onWheel, { passive: false })
    const ro = new ResizeObserver(() => setViewW(sc.clientWidth))
    ro.observe(sc)
    return () => {
      sc.removeEventListener('wheel', onWheel)
      ro.disconnect()
    }
  }, [])

  const p = project.value
  const z = zoom.value
  if (!p) return null
  const span = Math.max(p.duration + 4, (viewW - LABEL) / z)
  const width = span * z
  const rows = layerRows(p)
  const down = directions(p, aspect.value)

  // ---- snapping --------------------------------------------------------
  const snapTargets = (skipTweens: Set<string>, skipClips: Set<string>) => {
    const out = [0, p.duration, time.value]
    for (const t of p.tweens) if (!skipTweens.has(t.id)) out.push(t.start, t.start + t.dur)
    for (const c of p.audio) if (!skipClips.has(c.id)) out.push(c.start, c.start + c.dur)
    for (const e of p.elements) if (e.clip && !skipClips.has(e.id)) out.push(e.clip.start, e.clip.start + e.clip.dur)
    return out
  }
  const snap = (v: number, targets: number[], off: boolean) => {
    if (off) return { v, hit: null as number | null }
    const tol = 7 / z
    let best: number | null = null
    for (const t of targets) if (Math.abs(t - v) < tol && (best == null || Math.abs(t - v) < Math.abs(best - v))) best = t
    return best == null ? { v, hit: null } : { v: best, hit: best }
  }

  // ---- ruler / playhead --------------------------------------------------
  const scrub = (e: PointerEvent) => {
    if (e.button !== 0) return
    const go = (x: number) => seek(Math.round(tFromX(x) * FPS) / FPS)
    go(e.clientX)
    const move = (m: PointerEvent) => go(m.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dragEnd = (e: PointerEvent) => {
    e.stopPropagation()
    beginGesture()
    const move = (m: PointerEvent) => {
      const d = Math.max(0.5, Math.round(tFromX(m.clientX) * 10) / 10)
      gesture((q) => (q.duration = d))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- tween bars --------------------------------------------------------
  const dragTween = (e: PointerEvent, tw: Tween, edge: 'body' | 'l' | 'r') => {
    e.stopPropagation()
    if (e.button !== 0) return
    if (e.shiftKey) {
      select('tween', tw.id, true)
      return
    }
    if (!selTweens.value.includes(tw.id)) select('tween', tw.id)
    const ids = edge === 'body' ? selTweens.value : [tw.id]
    const base = new Map(p.tweens.filter((t) => ids.includes(t.id)).map((t) => [t.id, { start: t.start, dur: t.dur }]))
    const targets = snapTargets(new Set(ids), new Set())
    const x0 = e.clientX
    let moved = false
    const move = (m: PointerEvent) => {
      if (!moved && Math.abs(m.clientX - x0) < 3) return
      if (!moved) {
        moved = true
        beginGesture()
      }
      const d = (m.clientX - x0) / z
      const b = base.get(tw.id)!
      let delta = d
      if (edge === 'body') {
        const s1 = snap(b.start + d, targets, m.shiftKey)
        const s2 = snap(b.start + b.dur + d, targets, m.shiftKey)
        const pick = s1.hit != null && (s2.hit == null || Math.abs(s1.v - b.start - d) <= Math.abs(s2.v - b.start - b.dur - d)) ? s1 : s2
        if (pick.hit != null) delta = pick === s1 ? s1.v - b.start : s2.v - b.start - b.dur
        setSnapAt(pick.hit)
        const minStart = Math.min(...[...base.values()].map((x) => x.start))
        delta = Math.max(-minStart, delta)
        gesture((q) => {
          for (const t of q.tweens) {
            const bb = base.get(t.id)
            if (bb) t.start = round3(bb.start + delta)
          }
        })
      } else if (edge === 'l') {
        const s = snap(b.start + d, targets, m.shiftKey)
        setSnapAt(s.hit)
        const ns = Math.max(0, Math.min(b.start + b.dur, s.v))
        gesture((q) => {
          const t = q.tweens.find((x) => x.id === tw.id)!
          t.start = round3(ns)
          t.dur = round3(b.start + b.dur - ns)
        })
      } else {
        const s = snap(b.start + b.dur + d, targets, m.shiftKey)
        setSnapAt(s.hit)
        const end = Math.max(b.start, s.v)
        gesture((q) => {
          q.tweens.find((x) => x.id === tw.id)!.dur = round3(end - b.start)
        })
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapAt(null)
      if (moved) endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- video clips -------------------------------------------------------
  // Body moves when the video plays; edges trim which part of the file shows.
  const dragVideo = (e: PointerEvent, el: El, edge: 'body' | 'l' | 'r') => {
    e.stopPropagation()
    if (e.button !== 0 || !el.clip) return
    select('el', el.id, e.shiftKey)
    if (el.locked) return
    const b = { ...el.clip }
    const targets = snapTargets(new Set(), new Set([el.id]))
    const x0 = e.clientX
    let moved = false
    const move = (m: PointerEvent) => {
      if (!moved && Math.abs(m.clientX - x0) < 3) return
      if (!moved) {
        moved = true
        beginGesture()
      }
      const d = (m.clientX - x0) / z
      let next = { ...b }
      if (edge === 'body') {
        const s1 = snap(b.start + d, targets, m.shiftKey)
        const s2 = snap(b.start + b.dur + d, targets, m.shiftKey)
        const delta = s1.hit != null ? s1.v - b.start : s2.hit != null ? s2.v - b.start - b.dur : d
        setSnapAt(s1.hit ?? s2.hit)
        next.start = Math.max(0, b.start + delta)
      } else if (edge === 'l') {
        const s = snap(b.start + d, targets, m.shiftKey)
        setSnapAt(s.hit)
        let delta = Math.max(-b.offset, Math.min(b.dur - 0.1, s.v - b.start))
        if (b.start + delta < 0) delta = -b.start
        next = { ...b, start: b.start + delta, offset: b.offset + delta, dur: b.dur - delta }
      } else {
        const s = snap(b.start + b.dur + d, targets, m.shiftKey)
        setSnapAt(s.hit)
        next.dur = Math.max(0.1, Math.min(b.srcDur - b.offset, s.v - b.start))
      }
      gesture((q) => {
        const t = q.elements.find((x) => x.id === el.id)!
        t.clip = { ...t.clip!, start: round3(next.start), offset: round3(next.offset), dur: round3(next.dur) }
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapAt(null)
      if (moved) endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- scenes (folders) -------------------------------------------------
  // Dragging a folder's span moves every tween of everything in it.
  const dragScene = (e: PointerEvent, fid: string | null) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const ids = new Set(folderAll(p, fid))
    const tws = p.tweens.filter((t) => ids.has(t.target))
    const vids = p.elements.filter((x) => ids.has(x.id) && x.clip)
    if (!tws.length && !vids.length) return
    const base = new Map(tws.map((t) => [t.id, t.start]))
    const vbase = new Map(vids.map((x) => [x.id, x.clip!.start]))
    const spans = [...tws.map((t) => [t.start, t.start + t.dur]), ...vids.map((x) => [x.clip!.start, x.clip!.start + x.clip!.dur])]
    const s0 = Math.min(...spans.map((x) => x[0]))
    const e0 = Math.max(...spans.map((x) => x[1]))
    const targets = snapTargets(new Set(base.keys()), new Set(vbase.keys()))
    const x0 = e.clientX
    let moved = false
    const move = (m: PointerEvent) => {
      if (!moved && Math.abs(m.clientX - x0) < 3) return
      if (!moved) {
        moved = true
        beginGesture()
      }
      const d = (m.clientX - x0) / z
      const a = snap(s0 + d, targets, m.shiftKey)
      const b = snap(e0 + d, targets, m.shiftKey)
      let delta = a.hit != null ? a.v - s0 : b.hit != null ? b.v - e0 : d
      setSnapAt(a.hit ?? b.hit)
      delta = Math.max(-s0, delta)
      gesture((q) => {
        for (const t of q.tweens) {
          const b0 = base.get(t.id)
          if (b0 != null) t.start = round3(b0 + delta)
        }
        for (const x of q.elements) {
          const b0 = vbase.get(x.id)
          if (b0 != null) x.clip!.start = round3(b0 + delta)
        }
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapAt(null)
      if (moved) endGesture()
      else
        batch(() => {
          select('tween', null)
          selTweens.value = [...base.keys()]
          selEls.value = [...new Set(tws.map((t) => t.target))]
        })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- audio clips -------------------------------------------------------
  const dragClip = (e: PointerEvent, c: Clip, edge: 'body' | 'l' | 'r') => {
    e.stopPropagation()
    if (e.button !== 0) return
    if (e.shiftKey) {
      select('clip', c.id, true)
      return
    }
    if (!selClips.value.includes(c.id)) select('clip', c.id)
    const ids = edge === 'body' ? selClips.value : [c.id]
    const base = new Map(p.audio.filter((x) => ids.includes(x.id)).map((x) => [x.id, { ...x }]))
    const targets = snapTargets(new Set(), new Set(ids))
    const x0 = e.clientX
    let moved = false
    const move = (m: PointerEvent) => {
      if (!moved && Math.abs(m.clientX - x0) < 3) return
      if (!moved) {
        moved = true
        beginGesture()
      }
      const d = (m.clientX - x0) / z
      const b = base.get(c.id)!
      const limit = b.src ? b.srcDur : Infinity
      if (edge === 'body') {
        const s1 = snap(b.start + d, targets, m.shiftKey)
        const s2 = snap(b.start + b.dur + d, targets, m.shiftKey)
        let delta = d
        if (s1.hit != null) delta = s1.v - b.start
        else if (s2.hit != null) delta = s2.v - b.start - b.dur
        setSnapAt(s1.hit ?? s2.hit)
        const minStart = Math.min(...[...base.values()].map((x) => x.start))
        delta = Math.max(-minStart, delta)
        gesture((q) => {
          for (const x of q.audio) {
            const bb = base.get(x.id)
            if (bb) x.start = round3(bb.start + delta)
          }
        })
      } else if (edge === 'l') {
        const s = snap(b.start + d, targets, m.shiftKey)
        setSnapAt(s.hit)
        let delta = s.v - b.start
        delta = Math.max(-b.offset, Math.min(b.dur - 0.05, delta))
        if (b.start + delta < 0) delta = -b.start
        gesture((q) => {
          const x = q.audio.find((y) => y.id === c.id)!
          x.start = round3(b.start + delta)
          x.offset = round3(b.offset + delta)
          x.dur = round3(b.dur - delta)
        })
      } else {
        const s = snap(b.start + b.dur + d, targets, m.shiftKey)
        setSnapAt(s.hit)
        const dur = Math.max(0.05, Math.min(limit - b.offset, s.v - b.start))
        gesture((q) => {
          q.audio.find((y) => y.id === c.id)!.dur = round3(dur)
        })
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setSnapAt(null)
      if (moved) endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const addNarration = () => {
    const id = uid('a')
    const last = [...p.audio].filter((c) => c.track === 'narration').sort((a, b) => a.start - b.start).pop()
    commit((q) => {
      q.audio.push({
        id, track: 'narration', src: '', start: round3(time.value), offset: 0, dur: 2, srcDur: 0, volume: 1, fadeIn: 0, fadeOut: 0,
        text: '', voice: last?.voice ?? 'bm_george', speed: last?.speed ?? 1.1,
      })
    })
    select('clip', id)
    setTimeout(() => (document.getElementById('clip-text') as HTMLTextAreaElement | null)?.focus(), 40)
  }

  const importAudio = async (files: FileList | File[], track: TrackKind, at: number) => {
    let t = at
    for (const f of [...files]) {
      if (!f.type.startsWith('audio') && !/\.(wav|mp3|ogg|flac|m4a|opus|webm)$/i.test(f.name)) {
        flash(`${f.name} is not audio`, 'error')
        continue
      }
      const fd = new FormData()
      fd.append('file', f)
      const r = await fetch(`/api/projects/${projectName.value}/assets`, { method: 'POST', body: fd })
      if (!r.ok) {
        flash(`Upload failed: ${f.name}`, 'error')
        continue
      }
      const info = await r.json()
      const id = uid('a')
      const start = round3(t)
      commit((q) => {
        q.audio.push({
          id, track, src: info.src, start, offset: 0, dur: info.dur, srcDur: info.dur, fadeIn: 0, fadeOut: track === 'music' ? 1.5 : 0,
          volume: track === 'music' ? 0.3 : track === 'sfx' ? 0.8 : 1, name: f.name.replace(/\.[^.]+$/, ''),
        })
      })
      audio.load(audio.url(projectName.value, info.src))
      select('clip', id)
      t += info.dur
    }
  }

  const pickFile = (track: TrackKind) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'audio/*'
    input.multiple = true
    input.onchange = () => input.files && importAudio(input.files, track, time.value)
    input.click()
  }

  const toggleMute = (track: TrackKind) =>
    commit((q) => {
      const m = new Set(q.muted ?? [])
      m.has(track) ? m.delete(track) : m.add(track)
      q.muted = [...m]
    })

  // ---- ticks -------------------------------------------------------------
  const step = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * z >= 70) ?? 60
  const ticks: number[] = []
  for (let t = 0; t <= span; t += step) ticks.push(Math.round(t * 1000) / 1000)
  const minor = (step / 5) * z
  const grid = { backgroundImage: `repeating-linear-gradient(90deg, var(--grid) 0 1px, transparent 1px ${step * z}px)`, backgroundSize: `${step * z}px 100%` }

  const rowH = (el: El) => (lanesFor(p.tweens.filter((t) => t.target === el.id)).count + (el.clip ? 1 : 0)) * LANE + 4
  const selE = new Set(selEls.value)
  const selT = new Set(selTweens.value)
  const selC = new Set(selClips.value)
  const muted = new Set(p.muted ?? [])

  return (
    <div class="timeline">
      <div class="tl-bar">
        <span class="tl-title">Timeline</span>
        <button class="btn sm" title="Zoom out (ctrl+wheel)" onClick={() => setZoom(z / 1.4)}>−</button>
        <button class="btn sm" title="Zoom in (ctrl+wheel)" onClick={() => setZoom(z * 1.4)}>+</button>
        <button class="btn sm" title="Fit the whole video" onClick={() => setZoom((scroller.current!.clientWidth - LABEL - 40) / p.duration)}>Fit</button>
        <span class="tl-help">drag bars to retime · edges to stretch · shift-drag skips snapping · right-click a row to add a tween</span>
      </div>
      <div class="tl-scroll" ref={scroller}>
        <div class="tl-content" style={{ width: LABEL + width }}>
          <div class="tl-row ruler">
            <div class="tl-label corner">{fmt(time.value)}</div>
            <div class="tl-lane ruler-lane" style={{ width, backgroundImage: `repeating-linear-gradient(90deg, var(--tick) 0 1px, transparent 1px ${minor}px)` }} onPointerDown={scrub}>
              {ticks.map((t) => (
                <span class="tick" style={{ left: t * z }}>{fmt(t).replace(/\.00$/, '')}</span>
              ))}
              <div class="end-mark" style={{ left: p.duration * z }} onPointerDown={dragEnd} title={`End: ${fmt(p.duration)} (drag to change)`} />
            </div>
          </div>

          {rows.map((r) => {
            if (r.kind === 'folder') {
              const fid = r.folder?.id ?? null
              const ids = new Set(folderAll(p, fid))
              const tws = p.tweens.filter((t) => ids.has(t.target))
              const spans = [
                ...tws.map((t) => [t.start, t.start + t.dur]),
                ...p.elements.filter((x) => ids.has(x.id) && x.clip).map((x) => [x.clip!.start, x.clip!.start + x.clip!.dur]),
              ]
              const s0 = spans.length ? Math.min(...spans.map((x) => x[0])) : 0
              const e0 = spans.length ? Math.max(...spans.map((x) => x[1])) : 0
              const toggle = () => {
                const c = new Set(collapsed.value)
                c.has(r.key) ? c.delete(r.key) : c.add(r.key)
                collapsed.value = c
              }
              return (
                <div class="tl-row folder-row">
                  <div
                    class="tl-label"
                    onPointerDown={() =>
                      batch(() => {
                        select('el', null)
                        selEls.value = [...ids].filter((id) => !p.elements.find((e) => e.id === id)?.parent)
                        activeFolder.value = fid
                      })
                    }
                  >
                    <button class="caret" onPointerDown={(e) => e.stopPropagation()} onClick={toggle}>
                      {collapsed.value.has(r.key) ? '▸' : '▾'}
                    </button>
                    <span class="name">{r.folder?.name ?? 'Unfiled'}</span>
                    <span class="count">{r.count}</span>
                  </div>
                  <div class="tl-lane" style={{ width, ...grid }}>
                    {spans.length > 0 && (
                      <div
                        class="scene-span"
                        style={{ left: s0 * z, width: Math.max(6, (e0 - s0) * z) }}
                        title={`${r.folder?.name ?? 'Unfiled'}: ${fmt(s0)} → ${fmt(e0)}. Drag to move the whole scene in time, click to select its tweens.`}
                        onPointerDown={(e) => dragScene(e as PointerEvent, fid)}
                      >
                        <span>{r.folder?.name ?? 'Unfiled'}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            }
            const { el, depth } = r
            const tws = p.tweens.filter((t) => t.target === el.id)
            const { lane } = lanesFor(tws)
            const first = el.clip ? 1 : 0 // video rows keep lane 0 for the clip
            return (
              <div class={`tl-row el-row ${selE.has(el.id) ? 'sel' : ''} ${el.hidden ? 'dim' : ''}`} style={{ height: rowH(el) }}>
                <div class="tl-label" style={{ paddingLeft: 8 + depth * 14 }} onPointerDown={(e) => select('el', el.id, e.shiftKey)}>
                  {el.type === 'group' ? (
                    <button
                      class="caret"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        const s = new Set(collapsed.value)
                        s.has(el.id) ? s.delete(el.id) : s.add(el.id)
                        collapsed.value = s
                      }}
                    >
                      {collapsed.value.has(el.id) ? '▸' : '▾'}
                    </button>
                  ) : (
                    <span class={`type-dot t-${el.type}`} />
                  )}
                  <span class="name">{el.name}</span>
                </div>
                <div
                  class="tl-lane"
                  style={{ width, ...grid }}
                  onPointerDown={(e) => e.button === 0 && select('el', el.id, e.shiftKey)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, el, t: Math.round(tFromX(e.clientX) * FPS) / FPS })
                  }}
                >
                  {el.clip && (
                    <div
                      class={`vclip ${selE.has(el.id) ? 'sel' : ''}`}
                      style={{
                        left: el.clip.start * z,
                        width: Math.max(6, el.clip.dur * z),
                        backgroundImage: el.clip.thumbs ? `url(/projects/${projectName.value}/${el.clip.thumbs})` : undefined,
                        backgroundSize: `${el.clip.srcDur * z}px 100%`,
                        backgroundPosition: `${-el.clip.offset * z}px 0`,
                      }}
                      title={`${el.name}: ${fmt(el.clip.start)} → ${fmt(el.clip.start + el.clip.dur)} (file ${fmt(el.clip.offset)} → ${fmt(el.clip.offset + el.clip.dur)})`}
                      onPointerDown={(e) => dragVideo(e as PointerEvent, el, 'body')}
                    >
                      <span class="edge l" onPointerDown={(e) => dragVideo(e as PointerEvent, el, 'l')} />
                      <span class="vclip-label">▶ {el.name}{el.clip.muted || !el.clip.audio ? '' : ' ♪'}</span>
                      <span class="edge r" onPointerDown={(e) => dragVideo(e as PointerEvent, el, 'r')} />
                    </div>
                  )}
                  {tws.map((tw) => {
                    const keys = Object.keys(tw.props) as AnimProp[]
                    const w = Math.max(4, tw.dur * z)
                    const c = curveFor(tw.ease || 'none', down.get(tw.id) ?? false)
                    const inside = tw.dur > 0 && time.value >= tw.start && time.value <= tw.start + tw.dur
                    const prog = inside ? (time.value - tw.start) / tw.dur : 0
                    const f = inside ? easeFn(tw.ease || 'none')(prog) : 0
                    return (
                      <div
                        class={`bar ${selT.has(tw.id) ? 'sel' : ''} ${inside ? 'live' : ''}`}
                        style={{ left: tw.start * z, width: w, top: 2 + ((lane.get(tw.id) ?? 0) + first) * LANE, '--c': PROP_COLOR[keys[0]] ?? '#b07cf5' } as any}
                        title={`${keys.join(', ')}  ${fmt(tw.start)} → ${fmt(tw.start + tw.dur)}  ${tw.ease}`}
                        onPointerDown={(e) => dragTween(e as PointerEvent, tw, 'body')}
                        onDblClick={() => seek(tw.start)}
                      >
                        {w >= 14 && (
                          <svg class="curve" viewBox="0 0 100 20" preserveAspectRatio="none">
                            <path class="area" d={c.area} />
                            <path class="line" d={c.line} vector-effect="non-scaling-stroke" />
                          </svg>
                        )}
                        {inside && w >= 14 && <i class="curve-dot" style={{ left: `${prog * 100}%`, top: `${(c.y(down.get(tw.id) ? 1 - f : f) / 20) * 100}%` }} />}
                        <span class="edge l" onPointerDown={(e) => dragTween(e as PointerEvent, tw, 'l')} />
                        <span class="bar-label">{keys.join(' ')}</span>
                        <span class="edge r" onPointerDown={(e) => dragTween(e as PointerEvent, tw, 'r')} />
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {!rows.length && (
            <div class="tl-row empty">
              <div class="tl-label" />
              <div class="tl-lane" style={{ width }}>No elements yet. Add one from the Layers panel.</div>
            </div>
          )}

          <div class="tl-sep" style={{ width: LABEL + width }} />

          {TRACKS.map((track) => (
            <div class={`tl-row audio-row ${muted.has(track) ? 'muted' : ''}`} style={{ height: AUDIO_H }}>
              <div class="tl-label audio-label">
                <span class="track-name" style={{ color: TRACK_COLOR[track] }}>{TRACK_NAME[track]}</span>
                <span class="track-btns">
                  <button class={`btn xs ${muted.has(track) ? 'on' : ''}`} title="Mute track" onClick={() => toggleMute(track)}>M</button>
                  {track === 'narration' && <button class="btn xs" title="Add a narration line at the playhead" onClick={addNarration}>+ Line</button>}
                  {track === 'voice' &&
                    (recording.value ? (
                      <button class="btn xs rec on" onClick={stopRecording}>■ Stop</button>
                    ) : (
                      <button class="btn xs rec" title="Record from the mic, starting at the playhead" onClick={startRecording}>● Rec</button>
                    ))}
                  {(track === 'music' || track === 'sfx') && <button class="btn xs" title="Add audio files at the playhead" onClick={() => pickFile(track)}>+ File</button>}
                </span>
              </div>
              <div
                class="tl-lane"
                style={{ width, ...grid }}
                onPointerDown={(e) => e.button === 0 && !e.shiftKey && select('clip', null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  if (e.dataTransfer?.files.length) importAudio(e.dataTransfer.files, track === 'narration' ? 'voice' : track, tFromX(e.clientX))
                }}
              >
                {p.audio
                  .filter((c) => c.track === track)
                  .map((c) => (
                    <ClipView c={c} z={z} sel={selC.has(c.id)} color={TRACK_COLOR[track]} onDrag={dragClip} />
                  ))}
                {recording.value && track === 'voice' && (
                  <div class="clip recording" style={{ left: recording.value.start * z, width: Math.max(2, (time.value - recording.value.start) * z) }}>
                    <span class="clip-label">● recording</span>
                  </div>
                )}
              </div>
            </div>
          ))}

          <div class="playhead" style={{ left: LABEL + time.value * z }} />
          {snapAt != null && <div class="snapline" style={{ left: LABEL + snapAt * z }} />}
          <div class="past-end" style={{ left: LABEL + p.duration * z, width: Math.max(0, width - p.duration * z) }} />
        </div>
      </div>
      {menu && (
        <PresetMenu
          {...menu}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function PresetMenu(props: { x: number; y: number; el: El; t: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && props.onClose()
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [])
  const items = PRESETS.filter((pr) => !pr.only || pr.only.includes(props.el.type))
  return (
    <div class="menu floating" ref={ref} style={{ left: props.x, top: Math.min(props.y, window.innerHeight - items.length * 28 - 40) }}>
      <div class="menu-head">Add to {props.el.name} at {fmt(props.t)}</div>
      {items.map((pr) => (
        <button
          onClick={() => {
            applyPreset(props.el.id, pr, props.t)
            props.onClose()
          }}
        >
          {pr.name}
        </button>
      ))}
    </div>
  )
}

function ClipView(props: { c: Clip; z: number; sel: boolean; color: string; onDrag: (e: PointerEvent, c: Clip, edge: 'body' | 'l' | 'r') => void }) {
  const { c, z } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const w = Math.max(4, c.dur * z)
  const loaded = audio.loaded.value
  const url = c.src ? audio.url(projectName.value, c.src) : ''
  useEffect(() => {
    if (url) audio.load(url)
  }, [url])
  useLayoutEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const peaks = url ? audio.peaks.get(url) : undefined
    const cw = Math.min(8000, Math.ceil(w))
    const ch = AUDIO_H - 8
    cv.width = cw
    cv.height = ch
    const g = cv.getContext('2d')!
    g.clearRect(0, 0, cw, ch)
    if (!peaks) return
    g.fillStyle = props.color
    g.globalAlpha = 0.55
    const mid = ch / 2
    for (let x = 0; x < cw; x++) {
      const t0 = c.offset + (x / cw) * c.dur
      const t1 = c.offset + ((x + 1) / cw) * c.dur
      let m = 0
      for (let i = Math.floor(t0 * PEAKS_PER_SEC); i <= Math.floor(t1 * PEAKS_PER_SEC) && i < peaks.length; i++) m = Math.max(m, peaks[i])
      const local = (x / cw) * c.dur
      const gain = Math.min(1.5, c.volume) * fadeGain(c, local)
      const hgt = Math.max(1, m * gain * (ch - 4))
      g.fillRect(x, mid - hgt / 2, 1, hgt)
    }
  }, [url, loaded, w, c.offset, c.dur, c.volume, c.fadeIn, c.fadeOut, props.color])

  const label = c.track === 'narration' ? plainText(c.text ?? '') || '(empty line)' : (c.name ?? c.src.split('/').pop())
  return (
    <div
      class={`clip ${props.sel ? 'sel' : ''} ${c.src ? '' : 'unvoiced'}`}
      style={{ left: c.start * z, width: w, '--c': props.color } as any}
      title={`${label}\n${fmt(c.start)} → ${fmt(c.start + c.dur)}`}
      onPointerDown={(e) => props.onDrag(e as PointerEvent, c, 'body')}
    >
      <canvas ref={canvas} />
      <span class="clip-label">{c.src ? '' : '⚠ not voiced · '}{label}</span>
      <span class="edge l" onPointerDown={(e) => props.onDrag(e as PointerEvent, c, 'l')} />
      <span class="edge r" onPointerDown={(e) => props.onDrag(e as PointerEvent, c, 'r')} />
    </div>
  )
}

function fadeGain(c: Clip, x: number) {
  let g = 1
  if (c.fadeIn > 0 && x < c.fadeIn) g *= x / c.fadeIn
  if (c.fadeOut > 0 && x > c.dur - c.fadeOut) g *= Math.max(0, (c.dur - x) / c.fadeOut)
  return g
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

// Whether each tween's first number goes down (fade out, shrink), so its curve
// is drawn falling. Recomputed only when the project object changes.
let dirKey: [Project | null, string] = [null, '']
let dirVal = new Map<string, boolean>()
function directions(p: Project, a: string) {
  if (dirKey[0] === p && dirKey[1] === a) return dirVal
  const m = new Map<string, boolean>()
  for (const chans of compile(p, a as 'wide' | 'tall').values())
    for (const list of chans.values()) for (const c of list) if (!c.mix && !m.has(c.id)) m.set(c.id, (c.to as number) < (c.from as number))
  dirKey = [p, a]
  dirVal = m
  return m
}
