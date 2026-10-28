import { useEffect, useRef, useState } from 'preact/hooks'
import { useSignalEffect } from '@preact/signals'
import { Player, resolveProps, valueAt, compile } from '../player'
import {
  aspect, beginGesture, clearSelection, elMap, endGesture, gesture, playing, project, projectName, select, selEls, selTweens, time, tweenMap,
} from '../state'
import { importVisual, setLayout } from '../ops'
import type { El, Project } from '../types'

type Box = { id: string; l: number; t: number; w: number; h: number }
type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'rot'

export function Stage() {
  const area = useRef<HTMLDivElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const player = useRef<Player | null>(null)
  const [scale, setScale] = useState(0.4)
  const [boxes, setBoxes] = useState<Box[]>([])
  const [hover, setHover] = useState<Box | null>(null)
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })
  const [size, setSize] = useState<[number, number]>([1920, 1080])
  const [dropping, setDropping] = useState(false)
  const scaleRef = useRef(scale)
  scaleRef.current = scale

  useEffect(() => {
    player.current = new Player(host.current!, `/projects/${projectName.value}/`)
    return () => {
      player.current?.root.remove()
      player.current = null
    }
  }, [])

  // Measure selection boxes after the player has painted.
  const measure = () => {
    const pl = player.current
    const w = wrap.current
    if (!pl || !w) return
    const base = w.getBoundingClientRect()
    const out: Box[] = []
    for (const id of selEls.value) {
      const n = pl.nodeOf(id)
      if (!n || n.style.display === 'none') continue
      const r = n.getBoundingClientRect()
      out.push({ id, l: r.left - base.left, t: r.top - base.top, w: r.width, h: r.height })
    }
    setBoxes(out)
  }

  useSignalEffect(() => {
    const p = project.value
    const a = aspect.value
    if (!p || !player.current) return
    player.current.set(p, a)
    setSize(player.current.size)
    requestAnimationFrame(measure)
  })
  useSignalEffect(() => {
    const t = time.value
    player.current?.seek(t)
    requestAnimationFrame(measure)
  })
  useSignalEffect(() => {
    selEls.value
    requestAnimationFrame(measure)
  })
  useSignalEffect(() => {
    player.current?.setPlaying(playing.value)
  })

  // Fit the stage into the area.
  useEffect(() => {
    const el = area.current!
    const fit = () => {
      const [W, H] = size
      const s = Math.min((el.clientWidth - 48) / W, (el.clientHeight - 48) / H)
      setScale(Math.max(0.05, s))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [size])
  useEffect(() => {
    requestAnimationFrame(measure)
  }, [scale])

  const hitTest = (target: EventTarget | null): El | null => {
    const node = (target as Element | null)?.closest?.('[data-id]') as HTMLElement | null
    if (!node || !player.current?.root.contains(node)) return null
    let el = elMap.value.get(node.dataset.id!) ?? null
    // Skip locked elements, falling through to their nearest unlocked group.
    while (el?.locked) el = el.parent ? (elMap.value.get(el.parent) ?? null) : null
    return el
  }

  const ancestors = (el: El) => {
    const out: string[] = []
    let cur = el.parent ? elMap.value.get(el.parent) : undefined
    while (cur) {
      out.push(cur.id)
      cur = cur.parent ? elMap.value.get(cur.parent) : undefined
    }
    return out
  }

  const parentScale = (el: El) => {
    let s = 1
    for (const id of ancestors(el)) s *= resolveProps(elMap.value.get(id)!, aspect.value).scale ?? 1
    return s
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const hit = hitTest(e.target)
    if (!hit) {
      if (!e.shiftKey) clearSelection()
      return
    }
    // Clicking inside a selected group drags the group.
    const selectedAncestor = ancestors(hit).find((id) => selEls.value.includes(id))
    const id = selectedAncestor ?? hit.id
    if (e.shiftKey) select('el', id, true)
    else if (!selEls.value.includes(id)) select('el', id)
    startMove(e)
  }

  const startMove = (e: PointerEvent) => {
    const p0 = project.value!
    const a = aspect.value
    const s = scaleRef.current
    const ids = selEls.value.filter((id) => {
      const el = elMap.value.get(id)
      return el && !el.locked && !ancestors(el).some((x) => selEls.value.includes(x))
    })
    if (!ids.length) return
    const tw = selTweens.value.length === 1 ? tweenMap.value.get(selTweens.value[0]) : undefined
    const tweenMode = !!tw && ids.length === 1 && tw.target === ids[0]
    const starts = ids.map((id) => {
      const el = elMap.value.get(id)!
      const r = resolveProps(el, a)
      return { id, x: r.x, y: r.y, ps: parentScale(el), root: !el.parent, w: r.w, h: r.h }
    })
    let tweenBase = { x: 0, y: 0 }
    if (tweenMode && tw) {
      // Edit where the tween ends: its `to` offsets (or the offset at its end, if it doesn't move yet).
      const chans = compile(p0, a).get(tw.target)
      const el = elMap.value.get(tw.target)!
      const rest = resolveProps(el, a)
      tweenBase = {
        x: tw.props.x ? Number(tw.props.x[1]) : Number(valueAt(chans, 'x', tw.start + tw.dur, rest)),
        y: tw.props.y ? Number(tw.props.y[1]) : Number(valueAt(chans, 'y', tw.start + tw.dur, rest)),
      }
    }
    const x0 = e.clientX, y0 = e.clientY
    let moved = false
    const [W, H] = player.current!.size
    const move = (m: PointerEvent) => {
      const sdx = (m.clientX - x0) / s, sdy = (m.clientY - y0) / s
      if (!moved && Math.hypot(m.clientX - x0, m.clientY - y0) < 3) return
      if (!moved) {
        moved = true
        beginGesture()
      }
      let dx = sdx, dy = sdy
      if (m.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0)
      if (tweenMode && tw) {
        const ps = starts[0].ps
        gesture((p: Project) => {
          const t = p.tweens.find((x) => x.id === tw.id)!
          t.props.x = [t.props.x?.[0] ?? null, Math.round(tweenBase.x + dx / ps)]
          t.props.y = [t.props.y?.[0] ?? null, Math.round(tweenBase.y + dy / ps)]
        })
        return
      }
      // Snap a single root element's center to the stage center lines.
      let snapV = false, snapH = false
      if (starts.length === 1 && starts[0].root && !m.altKey) {
        const st = starts[0]
        const tol = 8 / s
        if (Math.abs(st.x + dx - W / 2) < tol) (dx = W / 2 - st.x), (snapV = true)
        if (Math.abs(st.y + dy - H / 2) < tol) (dy = H / 2 - st.y), (snapH = true)
      }
      setGuides({ v: snapV, h: snapH })
      gesture((p: Project) => {
        for (const st of starts) {
          const el = p.elements.find((x) => x.id === st.id)!
          setLayout(el, 'x', Math.round(st.x + dx / st.ps), a)
          setLayout(el, 'y', Math.round(st.y + dy / st.ps), a)
        }
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setGuides({ v: false, h: false })
      if (moved) endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startHandle = (e: PointerEvent, box: Box, handle: Handle) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const el = elMap.value.get(box.id)
    if (!el || el.locked) return
    const a = aspect.value
    const s = scaleRef.current
    const r = resolveProps(el, a)
    const ps = parentScale(el) * (r.scale ?? 1)
    const rot = ((r.rotation ?? 0) * Math.PI) / 180
    const base = wrap.current!.getBoundingClientRect()
    const cx = base.left + box.l + box.w / 2, cy = base.top + box.t + box.h / 2
    const x0 = e.clientX, y0 = e.clientY
    const a0 = Math.atan2(y0 - cy, x0 - cx)
    beginGesture()
    const move = (m: PointerEvent) => {
      if (handle === 'rot') {
        let deg = (r.rotation ?? 0) + ((Math.atan2(m.clientY - cy, m.clientX - cx) - a0) * 180) / Math.PI
        if (m.shiftKey) deg = Math.round(deg / 15) * 15
        gesture((p) => setLayout(p.elements.find((x) => x.id === el.id)!, 'rotation', Math.round(deg * 10) / 10, a))
        return
      }
      // Pointer delta in the element's own (unrotated, unscaled) axes.
      const gx = (m.clientX - x0) / s / ps, gy = (m.clientY - y0) / s / ps
      const lx = gx * Math.cos(-rot) - gy * Math.sin(-rot)
      const ly = gx * Math.sin(-rot) + gy * Math.cos(-rot)
      const sx = handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0
      const sy = handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0
      let w = Math.max(4, r.w + sx * lx)
      let h = Math.max(4, r.h + sy * ly)
      if (m.shiftKey && sx && sy) {
        const k = Math.max(w / r.w, h / r.h)
        w = r.w * k
        h = r.h * k
      }
      // Keep the opposite edge still: shift the center by half the growth.
      const ox = (sx * (w - r.w)) / 2, oy = (sy * (h - r.h)) / 2
      const px = (ox * Math.cos(rot) - oy * Math.sin(rot)) * (r.scale ?? 1)
      const py = (ox * Math.sin(rot) + oy * Math.cos(rot)) * (r.scale ?? 1)
      gesture((p) => {
        const t = p.elements.find((x) => x.id === el.id)!
        setLayout(t, 'w', Math.round(w), a)
        setLayout(t, 'h', Math.round(h), a)
        setLayout(t, 'x', Math.round(r.x + px), a)
        setLayout(t, 'y', Math.round(r.y + py), a)
      })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      endGesture()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onHover = (e: PointerEvent) => {
    if (e.buttons) return
    const hit = hitTest(e.target)
    if (!hit || selEls.value.includes(hit.id)) return setHover(null)
    const n = player.current?.nodeOf(hit.id)
    const base = wrap.current!.getBoundingClientRect()
    if (!n) return setHover(null)
    const r = n.getBoundingClientRect()
    setHover({ id: hit.id, l: r.left - base.left, t: r.top - base.top, w: r.width, h: r.height })
  }

  const onDblClick = (e: MouseEvent) => {
    const hit = hitTest(e.target)
    if (hit?.type === 'text') setTimeout(() => (document.getElementById('insp-text') as HTMLTextAreaElement | null)?.focus(), 30)
  }

  const [W, H] = size
  const tweenMode = selTweens.value.length === 1 && selEls.value.length === 1
  return (
    <div
      class={`stage-area ${dropping ? 'dropping' : ''}`}
      ref={area}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={async (e) => {
        e.preventDefault()
        setDropping(false)
        for (const f of [...(e.dataTransfer?.files ?? [])]) await importVisual(f)
      }}
    >
      {dropping && <div class="drop-hint">Drop images or videos to add them at the playhead</div>}
      <div
        class="stage-wrap"
        ref={wrap}
        style={{ width: W * scale, height: H * scale }}
        onPointerDown={onPointerDown}
        onPointerMove={onHover}
        onPointerLeave={() => setHover(null)}
        onDblClick={onDblClick}
      >
        <div class="stage-host" ref={host} style={{ transform: `scale(${scale})` }} />
        <div class="overlay">
          {guides.v && <div class="guide v" style={{ left: (W / 2) * scale }} />}
          {guides.h && <div class="guide h" style={{ top: (H / 2) * scale }} />}
          {hover && <div class="hover-box" style={{ left: hover.l, top: hover.t, width: hover.w, height: hover.h }} />}
          {boxes.map((b) => (
            <div class={`sel-box ${tweenMode ? 'tween-mode' : ''}`} style={{ left: b.l, top: b.t, width: b.w, height: b.h }}>
              {boxes.length === 1 &&
                (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'rot'] as Handle[]).map((h) => (
                  <div class={`handle h-${h}`} onPointerDown={(e) => startHandle(e as PointerEvent, b, h)} />
                ))}
            </div>
          ))}
        </div>
      </div>
      <div class="stage-hint">
        {tweenMode
          ? 'Tween selected: dragging sets where this tween moves the element to'
          : aspect.value === 'tall'
            ? '9:16 layout: moves here only change the 9:16 version'
            : 'Drag to move · handles resize · shift locks axis · alt skips snapping'}
      </div>
    </div>
  )
}
