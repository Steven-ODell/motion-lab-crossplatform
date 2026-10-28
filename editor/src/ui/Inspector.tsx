import { useEffect, useRef, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { easeFn, resolveProps } from '../player'
import { FONTS, snapWeight } from '../fonts'
import { audio } from '../audio'
import {
  aspect, clipMap, commit, deleteSelection, duplicateSelection, elMap, flash, project, projectName, seek, select, selClips, selEls, selTweens,
  time, tweenMap, tweensOf,
} from '../state'
import { EASES, LAYOUT_KEYS, PRESETS, PROP_COLOR, PROP_LABEL, addFolder, applyPreset, clearOverride, groupSelection, putInFolder, setLayout, ungroup } from '../ops'
import { ColorField, Menu, NumField, Section, Select, TextField, toHex as toHexFromAny } from './fields'
import { fmt } from './Timeline'
import { Icon } from './icons'
import type { AnimProp, AnimValue, Clip, El, Props, Tween } from '../types'
import { ANIM_PROPS, COLOR_PROPS } from '../types'

export function Inspector() {
  const p = project.value
  if (!p) return null
  const clips = selClips.value.map((id) => clipMap.value.get(id)).filter(Boolean) as Clip[]
  const els = selEls.value.map((id) => elMap.value.get(id)).filter(Boolean) as El[]
  return (
    <aside class="inspector">
      {clips.length === 1 ? (
        <ClipInspector c={clips[0]} />
      ) : clips.length > 1 ? (
        <Section title={`${clips.length} clips`}>
          <div class="row-btns">
            <button class="btn" onClick={duplicateSelection}>Duplicate</button>
            <button class="btn danger" onClick={deleteSelection}>Delete</button>
          </div>
        </Section>
      ) : els.length === 1 ? (
        <ElementInspector el={els[0]} />
      ) : els.length > 1 ? (
        <MultiInspector els={els} />
      ) : (
        <ProjectInspector />
      )}
    </aside>
  )
}

// ------------------------------------------------------------ element ---

function ElementInspector({ el }: { el: El }) {
  const a = aspect.value
  const r = resolveProps(el, a)
  const tall = a === 'tall'
  const key = (k: string) => `${el.id}:${k}:${a}`
  const setL = (k: keyof Props, v: unknown) => commit((p) => setLayout(p.elements.find((e) => e.id === el.id)!, k, v), key(k))
  const setS = (k: keyof Props, v: unknown) =>
    commit((p) => {
      const e = p.elements.find((x) => x.id === el.id)!
      ;(e.props as unknown as Record<string, unknown>)[k] = v
    }, key(k))
  const set = (k: keyof Props, v: unknown) => (LAYOUT_KEYS.includes(k) ? setL(k, v) : setS(k, v))
  const mark = (k: keyof Props) => tall && el.tall?.[k] !== undefined
  const reset = (k: keyof Props) => () => commit((p) => clearOverride(p.elements.find((e) => e.id === el.id)!, k))
  const num = (label: string, k: keyof Props, opts: Partial<Parameters<typeof NumField>[0]> = {}, dflt = 0) => (
    <NumField label={label} value={Number(r[k] ?? dflt)} onChange={(v) => set(k, v)} mark={mark(k)} onReset={reset(k)} {...opts} />
  )
  const color = (label: string, k: keyof Props, dflt: string) => <ColorField label={label} value={String(r[k] ?? dflt)} onChange={(v) => set(k, v)} />

  const tws = tweensOf(el.id)
  const sel = selTweens.value.length === 1 ? tweenMap.value.get(selTweens.value[0]) : undefined
  const presets = PRESETS.filter((pr) => !pr.only || pr.only.includes(el.type))

  return (
    <>
      <Section
        title={el.type === 'group' ? 'Group' : el.type[0].toUpperCase() + el.type.slice(1)}
        actions={
          <span class="row-btns">
            <button class="btn xs" title="Duplicate (ctrl+d)" onClick={duplicateSelection}><Icon name="dup" size={11} /></button>
            <button class="btn xs danger" title="Delete (del)" onClick={deleteSelection}>✕</button>
          </span>
        }
      >
        <TextField label="Name" value={el.name} onChange={(v) => commit((p) => (p.elements.find((e) => e.id === el.id)!.name = v))} />
        {!el.parent && (project.value?.folders?.length ?? 0) > 0 && (
          <Select
            label="Folder"
            value={el.folder && project.value!.folders!.some((f) => f.id === el.folder) ? el.folder : ''}
            options={[['', 'Unfiled'] as [string, string], ...project.value!.folders!.map((f) => [f.id, f.name] as [string, string])]}
            onChange={(v) => putInFolder([el.id], v || null)}
          />
        )}
        {tall && <div class="note">Editing the 9:16 layout. Position, size, scale, opacity and text size changes apply to 9:16 only (marked •).</div>}
      </Section>

      {el.type === 'text' && (
        <Section title="Text">
          <TextField id="insp-text" label="Text" multiline rows={3} value={el.props.text ?? ''} onChange={(v) => setS('text', v)} />
          <div class="hint">[[#ff5ea0|words]] colors words. Ctrl+Enter applies.</div>
          <div class="grid2">
            <Select label="Font" value={r.font ?? 'Inter'} options={Object.keys(FONTS)} onChange={(v) => commit((p) => {
              const e = p.elements.find((x) => x.id === el.id)!
              e.props.font = v
              e.props.weight = snapWeight(v, e.props.weight ?? 600)
            })} />
            <Select label="Weight" value={snapWeight(r.font ?? 'Inter', r.weight ?? 600)} options={FONTS[r.font ?? 'Inter'] ?? [400]} onChange={(v) => setS('weight', v)} />
            {num('Size', 'size', { min: 4, step: 1, digits: 0 }, 64)}
            {num('Line height', 'lineHeight', { min: 0.5, step: 0.01 }, 1.2)}
            {num('Spacing', 'letterSpacing', { step: 0.005, digits: 3, unit: 'em' }, 0)}
            {num('Glow', 'glow', { min: 0, step: 0.5 }, 0)}
          </div>
          {color('Color', 'color', '#e6e1f2')}
          <div class="seg">
            {(['left', 'center', 'right'] as const).map((al) => (
              <button class={`btn sm ${(r.align ?? 'center') === al ? 'on' : ''}`} onClick={() => setL('align', al)}>{al}</button>
            ))}
          </div>
          <Select label="Reveal style" value={r.reveal ?? 'rise'} options={['rise', 'fade', 'type', 'blur']} onChange={(v) => setS('reveal', v)} />
        </Section>
      )}

      {(el.type === 'rect' || el.type === 'ellipse' || el.type === 'group') && (
        <Section title="Style">
          {color('Fill', 'fill', 'rgba(0,0,0,0)')}
          {color('Stroke', 'stroke', 'rgba(0,0,0,0)')}
          <div class="grid2">
            {num('Stroke width', 'strokeWidth', { min: 0, step: 0.5 })}
            {el.type !== 'ellipse' && num('Radius', 'radius', { min: 0, step: 1 })}
            {num('Glow', 'glow', { min: 0, step: 0.5 })}
          </div>
          {el.type === 'group' && (
            <div class="row-btns">
              <button class="btn" onClick={() => ungroup(el.id)}>Ungroup</button>
            </div>
          )}
        </Section>
      )}

      {el.type === 'path' && (
        <Section title="Path">
          <TextField label="d" multiline rows={3} value={el.props.d ?? ''} onChange={(v) => setS('d', v)} />
          <TextField label="viewBox" value={el.props.viewBox ?? ''} placeholder={`0 0 ${r.w} ${r.h}`} onChange={(v) => setS('viewBox', v || undefined)} />
          {color('Stroke', 'stroke', 'rgba(0,0,0,0)')}
          {color('Fill', 'fill', 'rgba(0,0,0,0)')}
          <div class="grid2">
            {num('Stroke width', 'strokeWidth', { min: 0, step: 0.5 })}
            {num('Glow', 'glow', { min: 0, step: 0.5 })}
          </div>
        </Section>
      )}

      {el.type === 'image' && (
        <Section title="Image">
          <div class="row-btns">
            <button class="btn" onClick={() => pickImage((src) => setS('src', src))}>{el.props.src ? 'Replace…' : 'Choose…'}</button>
            <span class="muted-text">{el.props.src?.split('/').pop()}</span>
          </div>
          <Select label="Fit" value={r.fit ?? 'contain'} options={['contain', 'cover']} onChange={(v) => setS('fit', v)} />
        </Section>
      )}

      {el.type === 'video' && el.clip && <VideoSection el={el} />}

      <Section title="Layout">
        <div class="grid2">
          {num('X', 'x', { digits: 0 })}
          {num('Y', 'y', { digits: 0 })}
          {num('W', 'w', { min: 1, digits: 0 })}
          {num('H', 'h', { min: 1, digits: 0 })}
          {num('Rotate', 'rotation', { step: 0.5, digits: 1, unit: '°' })}
          {num('Scale', 'scale', { step: 0.01, min: 0 }, 1)}
          {num('Opacity', 'opacity', { step: 0.01, min: 0, max: 1 }, 1)}
        </div>
        <div class="row-btns">
          <button class={`btn sm ${el.hidden ? 'on' : ''}`} onClick={() => commit((p) => (p.elements.find((e) => e.id === el.id)!.hidden = !el.hidden || undefined))}>
            {el.hidden ? 'Hidden' : 'Hide'}
          </button>
          <button class={`btn sm ${el.locked ? 'on' : ''}`} onClick={() => commit((p) => (p.elements.find((e) => e.id === el.id)!.locked = !el.locked || undefined))}>
            {el.locked ? 'Locked' : 'Lock'}
          </button>
        </div>
      </Section>

      <Section
        title={`Tweens (${tws.length})`}
        actions={<Menu class="btn xs" label="+ Add" items={presets.map((pr) => [pr.name, () => applyPreset(el.id, pr)])} title="Add a tween at the playhead" />}
      >
        {!tws.length && <div class="muted-text">Nothing moves yet. Add a tween, or right-click this element's timeline row.</div>}
        <div class="tween-list">
          {tws.map((t) => (
            <button class={`tween-item ${sel?.id === t.id ? 'sel' : ''}`} onClick={(e) => select('tween', t.id, e.shiftKey)} onDblClick={() => seek(t.start)}>
              <span class="when">{fmt(t.start)}</span>
              <span class="what">
                {(Object.keys(t.props) as AnimProp[]).map((k) => (
                  <i style={{ color: PROP_COLOR[k] }}>{k}</i>
                ))}
              </span>
              <span class="dur">{t.dur.toFixed(2)}s</span>
            </button>
          ))}
        </div>
      </Section>

      {sel && sel.target === el.id && <TweenEditor tw={sel} el={el} />}
    </>
  )
}

function VideoSection({ el }: { el: El }) {
  const c = el.clip!
  const a = aspect.value
  const upd = (fn: (x: NonNullable<El['clip']>) => void, k: string) => commit((p) => fn(p.elements.find((e) => e.id === el.id)!.clip!), `${el.id}:clip:${k}`)
  const r = resolveProps(el, a)
  const db = c.volume > 0 ? (20 * Math.log10(c.volume)).toFixed(1) : '-∞'
  const fill = () => {
    const [W, H] = a === 'tall' ? [1080, 1920] : [1920, 1080]
    commit((p) => {
      const e = p.elements.find((x) => x.id === el.id)!
      for (const [k, v] of [['x', W / 2], ['y', H / 2], ['w', W], ['h', H]] as const) setLayout(e, k, v, a)
      e.props.fit = 'cover'
    })
  }
  return (
    <Section title="Clip">
      <div class="row-btns">
        <span class="muted-text">{el.props.src?.split('/').pop()} · {c.srcDur.toFixed(2)} s</span>
      </div>
      <div class="row-btns wrap">
        <button class="btn sm" title="Cover the whole frame (this aspect)" onClick={fill}>Fill stage</button>
        <button class="btn sm" title="Put the playhead where the clip starts" onClick={() => seek(c.start)}>Go to start</button>
      </div>
      <Select label="Fit" value={r.fit ?? 'cover'} options={['cover', 'contain']} onChange={(v) => commit((p) => (p.elements.find((x) => x.id === el.id)!.props.fit = v))} />
      <div class="grid2">
        <NumField label="Start" value={c.start} step={0.01} digits={3} min={0} unit="s" onChange={(v) => upd((x) => (x.start = v), 'start')} />
        <NumField label="Length" value={c.dur} step={0.01} digits={3} min={0.1} max={c.srcDur - c.offset} unit="s" onChange={(v) => upd((x) => (x.dur = v), 'dur')} />
        <NumField
          label="Trim start"
          value={c.offset}
          step={0.01}
          digits={3}
          min={0}
          max={Math.max(0, c.srcDur - 0.1)}
          unit="s"
          onChange={(v) =>
            upd((x) => {
              const d = v - x.offset
              x.offset = v
              x.dur = Math.max(0.1, Math.min(x.srcDur - v, x.dur - d))
            }, 'offset')
          }
        />
      </div>
      {c.audio ? (
        <>
          <label class="field slider">
            <span class="lbl">Volume</span>
            <input type="range" min={0} max={2} step={0.01} value={c.volume} disabled={c.muted} onInput={(e) => upd((x) => (x.volume = Number((e.currentTarget as HTMLInputElement).value)), 'volume')} />
            <span class="unit">{db} dB</span>
          </label>
          <button class={`btn sm ${c.muted ? 'on' : ''}`} onClick={() => upd((x) => (x.muted = !x.muted || undefined), 'mute')}>
            {c.muted ? 'Sound off' : 'Mute sound'}
          </button>
        </>
      ) : (
        <div class="hint">This file has no sound.</div>
      )}
      <div class="hint">Drag the strip on its timeline row to move it; drag its edges to trim. Tweens (fade, scale, blur…) work on it like anything else.</div>
    </Section>
  )
}

function pickImage(done: (src: string, info: { w?: number; h?: number }) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.onchange = async () => {
    const f = input.files?.[0]
    if (!f) return
    const fd = new FormData()
    fd.append('file', f)
    const r = await fetch(`/api/projects/${projectName.value}/assets`, { method: 'POST', body: fd })
    if (!r.ok) return flash('Upload failed', 'error')
    const info = await r.json()
    done(info.src, info)
  }
  input.click()
}
export { pickImage }

// -------------------------------------------------------------- tween ---

function allowed(el: El): AnimProp[] {
  return ANIM_PROPS.filter((k) => {
    if (k === 'reveal' || k === 'color') return el.type === 'text'
    if (k === 'draw') return el.type === 'path'
    if (k === 'fill') return !['text', 'image', 'video'].includes(el.type)
    if (k === 'stroke') return !['text', 'image', 'video'].includes(el.type)
    return true
  })
}

function TweenEditor({ tw, el }: { tw: Tween; el: El }) {
  const key = (k: string) => `${tw.id}:${k}`
  const upd = (fn: (t: Tween) => void, k: string) => commit((p) => fn(p.tweens.find((x) => x.id === tw.id)!), key(k))
  const r = resolveProps(el, aspect.value)
  const props = Object.entries(tw.props) as [AnimProp, [AnimValue | null, AnimValue]][]
  const free = allowed(el).filter((k) => !(k in tw.props))
  const restOf = (k: AnimProp): AnimValue => {
    switch (k) {
      case 'w': return r.w
      case 'h': return r.h
      case 'fill': return r.fill ?? '#b07cf5'
      case 'color': return r.color ?? '#e6e1f2'
      case 'stroke': return r.stroke ?? '#ff5ef1'
      case 'glow': return r.glow ?? 0
      case 'scale': case 'opacity': case 'draw': case 'reveal': return 1
      default: return 0
    }
  }
  const STEP: Partial<Record<AnimProp, number>> = { scale: 0.01, opacity: 0.01, draw: 0.01, reveal: 0.01, blur: 0.2, glow: 0.5, rotation: 0.5 }

  return (
    <Section
      title="Selected tween"
      actions={
        <span class="row-btns">
          <button class="btn xs" title="Jump to its start" onClick={() => seek(tw.start)}><Icon name="start" size={11} /></button>
          <button class="btn xs" title="Jump to its end" onClick={() => seek(tw.start + tw.dur)}><Icon name="end" size={11} /></button>
          <button class="btn xs" title="Duplicate after itself" onClick={duplicateSelection}><Icon name="dup" size={11} /></button>
          <button class="btn xs danger" title="Delete tween" onClick={deleteSelection}>✕</button>
        </span>
      }
    >
      <div class="grid2">
        <NumField label="Start" value={tw.start} step={0.01} digits={3} min={0} unit="s" onChange={(v) => upd((t) => (t.start = v), 'start')} />
        <NumField label="Length" value={tw.dur} step={0.01} digits={3} min={0} unit="s" onChange={(v) => upd((t) => (t.dur = v), 'dur')} />
      </div>
      <EaseField value={tw.ease} onChange={(v) => upd((t) => (t.ease = v), 'ease')} />
      <div class="prop-table">
        <div class="prop-head">
          <span />
          <span>from</span>
          <span>to</span>
          <span />
        </div>
        {props.map(([k, [from, to]]) => {
          const isColor = COLOR_PROPS.includes(k)
          const setFrom = (v: AnimValue | null) => upd((t) => (t.props[k] = [v, t.props[k]![1]]), `${k}.from`)
          const setTo = (v: AnimValue) => upd((t) => (t.props[k] = [t.props[k]![0], v]), `${k}.to`)
          return (
            <div class="prop-row">
              <span class="pname" style={{ color: PROP_COLOR[k] }} title={k}>{PROP_LABEL[k]}</span>
              <span class="pval">
                {from === null ? (
                  <button class="btn xs ghost" title="Starts from whatever the value is at this point. Click to set a fixed start value." onClick={() => setFrom(restOf(k))}>
                    current
                  </button>
                ) : (
                  <span class="with-x">
                    {isColor ? (
                      <input type="color" class="mini-color" value={toHexSafe(String(from))} onInput={(e) => setFrom((e.currentTarget as HTMLInputElement).value)} />
                    ) : (
                      <NumField label="" value={Number(from)} step={STEP[k] ?? 1} digits={3} onChange={setFrom} />
                    )}
                    <button class="btn xs ghost" title="Start from the current value instead" onClick={() => setFrom(null)}>↺</button>
                  </span>
                )}
              </span>
              <span class="pval">
                {isColor ? (
                  <input type="color" class="mini-color" value={toHexSafe(String(to))} onInput={(e) => setTo((e.currentTarget as HTMLInputElement).value)} />
                ) : (
                  <NumField label="" value={Number(to)} step={STEP[k] ?? 1} digits={3} onChange={setTo} />
                )}
              </span>
              <button
                class="btn xs ghost"
                title="Remove property"
                onClick={() =>
                  commit((p) => {
                    const t = p.tweens.find((x) => x.id === tw.id)!
                    delete t.props[k]
                    if (!Object.keys(t.props).length) p.tweens = p.tweens.filter((x) => x.id !== tw.id)
                  })
                }
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
      {free.length > 0 && (
        <Menu
          class="btn sm"
          label="+ Property"
          items={free.map((k) => [PROP_LABEL[k], () => commit((p) => (p.tweens.find((x) => x.id === tw.id)!.props[k] = [null, restOf(k)]))])}
        />
      )}
      <div class="hint">Move X/Y are offsets from the layout position. Drag the element on the canvas to set where this tween moves it.</div>
    </Section>
  )
}

function toHexSafe(c: string) {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : toHexFromAny(c)
}

function EaseField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const cv = useRef<HTMLCanvasElement>(null)
  const [custom, setCustom] = useState<string | null>(null)
  useEffect(() => {
    const c = cv.current!
    const g = c.getContext('2d')!
    const W = c.width, H = c.height, pad = 14
    g.clearRect(0, 0, W, H)
    g.strokeStyle = '#2a2438'
    g.lineWidth = 1
    g.strokeRect(pad, pad, W - pad * 2, H - pad * 2)
    const f = easeFn(value)
    g.strokeStyle = '#b07cf5'
    g.lineWidth = 2
    g.beginPath()
    for (let i = 0; i <= 100; i++) {
      const x = pad + (i / 100) * (W - pad * 2)
      const y = H - pad - f(i / 100) * (H - pad * 2)
      i ? g.lineTo(x, y) : g.moveTo(x, y)
    }
    g.stroke()
  }, [value])
  const opts = EASES.includes(value) ? EASES : [value, ...EASES]
  return (
    <div class="ease-field">
      <Select label="Ease" value={value} options={opts} onChange={onChange} />
      <canvas ref={cv} width={220} height={90} class="ease-curve" />
      <input
        class="ease-custom"
        placeholder="custom, e.g. back.out(3)"
        value={custom ?? ''}
        onInput={(e) => setCustom((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && custom?.trim()) {
            onChange(custom.trim())
            setCustom(null)
          }
        }}
      />
    </div>
  )
}

// -------------------------------------------------------------- multi ---

function MultiInspector({ els }: { els: El[] }) {
  const a = aspect.value
  const sameParent = els.every((e) => (e.parent ?? null) === (els[0].parent ?? null))
  const align = (mode: 'x' | 'y') => {
    const vals = els.map((e) => resolveProps(e, a)[mode])
    const mid = (Math.min(...vals) + Math.max(...vals)) / 2
    commit((p) => {
      for (const e of p.elements.filter((x) => els.some((s) => s.id === x.id))) setLayout(e, mode, Math.round(mid), a)
    })
  }
  const distribute = (mode: 'x' | 'y') => {
    const sorted = [...els].sort((p, q) => resolveProps(p, a)[mode] - resolveProps(q, a)[mode])
    const first = resolveProps(sorted[0], a)[mode]
    const last = resolveProps(sorted[sorted.length - 1], a)[mode]
    commit((p) => {
      sorted.forEach((s, i) => setLayout(p.elements.find((x) => x.id === s.id)!, mode, Math.round(first + ((last - first) * i) / (sorted.length - 1)), a))
    })
  }
  const presets = PRESETS.filter((pr) => !pr.only || els.every((e) => pr.only!.includes(e.type)))
  return (
    <Section title={`${els.length} elements`}>
      <div class="row-btns wrap">
        <button class="btn sm" onClick={() => align('x')}>Align centers ↔</button>
        <button class="btn sm" onClick={() => align('y')}>Align centers ↕</button>
        {els.length > 2 && <button class="btn sm" onClick={() => distribute('x')}>Distribute ↔</button>}
        {els.length > 2 && <button class="btn sm" onClick={() => distribute('y')}>Distribute ↕</button>}
      </div>
      <div class="row-btns wrap">
        {sameParent && <button class="btn" onClick={() => groupSelection(els.map((e) => e.id))}>Group (ctrl+g)</button>}
        <button class="btn" title="Folders only organize the panels; nothing moves" onClick={addFolder}>New folder from these</button>
        <button class="btn" onClick={duplicateSelection}>Duplicate</button>
        <button class="btn danger" onClick={deleteSelection}>Delete</button>
      </div>
      <Menu
        class="btn"
        label="+ Tween on each, staggered"
        items={presets.map((pr) => [
          pr.name,
          () => {
            const t0 = time.value
            els.forEach((e, i) => applyPreset(e.id, pr, t0 + i * 0.08))
            selEls.value = els.map((e) => e.id)
          },
        ])}
      />
    </Section>
  )
}

// --------------------------------------------------------------- clip ---

const voices = signal<string[]>([])
let voicesLoaded = false
const voicing = signal<Set<string>>(new Set())

export async function voiceClips(ids: string[]) {
  const p = project.value
  if (!p) return
  const clips = p.audio.filter((c) => ids.includes(c.id) && c.track === 'narration' && c.text?.trim())
  if (!clips.length) return
  voicing.value = new Set([...voicing.value, ...clips.map((c) => c.id)])
  flash(`Voicing ${clips.length} line${clips.length > 1 ? 's' : ''} with Kokoro…`)
  try {
    const r = await fetch(`/api/projects/${projectName.value}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: clips.map((c) => ({ text: c.text, voice: c.voice, speed: c.speed })) }),
    })
    if (!r.ok) throw new Error((await r.json()).detail ?? r.statusText)
    const res: { src: string; dur: number }[] = await r.json()
    commit((q) => {
      clips.forEach((c, i) => {
        const x = q.audio.find((y) => y.id === c.id)
        if (!x) return
        Object.assign(x, { src: res[i].src, srcDur: res[i].dur, dur: res[i].dur, offset: 0, voiced: c.text })
      })
    })
    for (const x of res) audio.load(audio.url(projectName.value, x.src))
    flash('Voiced')
  } catch (e) {
    flash(`Voicing failed: ${e}`, 'error')
  } finally {
    const s = new Set(voicing.value)
    clips.forEach((c) => s.delete(c.id))
    voicing.value = s
  }
}

function ClipInspector({ c }: { c: Clip }) {
  useEffect(() => {
    if (voicesLoaded) return
    voicesLoaded = true
    fetch('/api/voices').then((r) => r.json()).then((v) => (voices.value = v))
  }, [])
  const key = (k: string) => `${c.id}:${k}`
  const upd = (fn: (x: Clip) => void, k: string) => commit((p) => fn(p.audio.find((x) => x.id === c.id)!), key(k))
  const stale = c.track === 'narration' && (!c.src || (c.voiced ?? c.text) !== c.text)
  const busy = voicing.value.has(c.id)
  const db = c.volume > 0 ? (20 * Math.log10(c.volume)).toFixed(1) : '-∞'
  return (
    <>
      <Section
        title={{ narration: 'Narration line', voice: 'Voice take', music: 'Music', sfx: 'Sound effect' }[c.track]}
        actions={
          <span class="row-btns">
            {c.src && <button class="btn xs" title="Listen to this clip alone" onClick={() => audio.audition(projectName.value, c)}>▶</button>}
            <button class="btn xs" title="Duplicate" onClick={duplicateSelection}><Icon name="dup" size={11} /></button>
            <button class="btn xs danger" title="Delete" onClick={deleteSelection}>✕</button>
          </span>
        }
      >
        {c.track === 'narration' ? (
          <>
            <TextField id="clip-text" label="Says" multiline rows={4} value={c.text ?? ''} onChange={(v) => upd((x) => (x.text = v), 'text')} />
            <div class="grid2">
              <Select label="Voice" value={c.voice ?? 'bm_george'} options={voices.value.length ? voices.value : [c.voice ?? 'bm_george']} onChange={(v) => upd((x) => (x.voice = v), 'voice')} />
              <NumField label="Speed" value={c.speed ?? 1} step={0.01} min={0.5} max={2} onChange={(v) => upd((x) => (x.speed = v), 'speed')} />
            </div>
            <button class={`btn ${stale ? 'primary' : ''}`} disabled={busy || !c.text?.trim()} onClick={() => voiceClips([c.id])}>
              {busy ? 'Voicing…' : c.src ? (stale ? 'Re-voice (text changed)' : 'Re-voice') : 'Voice it'}
            </button>
            <div class="hint">Kokoro runs only while voicing, then exits. Unchanged lines are cached.</div>
          </>
        ) : (
          <TextField label="Name" value={c.name ?? ''} onChange={(v) => upd((x) => (x.name = v), 'name')} />
        )}
      </Section>
      <Section title="Timing">
        <div class="grid2">
          <NumField label="Start" value={c.start} step={0.01} digits={3} min={0} unit="s" onChange={(v) => upd((x) => (x.start = v), 'start')} />
          <NumField label="Length" value={c.dur} step={0.01} digits={3} min={0.05} max={c.src ? c.srcDur - c.offset : Infinity} unit="s" onChange={(v) => upd((x) => (x.dur = v), 'dur')} />
          <NumField label="Trim start" value={c.offset} step={0.01} digits={3} min={0} max={Math.max(0, c.srcDur - 0.05)} unit="s" onChange={(v) => upd((x) => {
            const d = v - x.offset
            x.offset = v
            x.dur = Math.max(0.05, Math.min(x.srcDur - v, x.dur - d))
          }, 'offset')} />
          <span class="muted-text">file {c.srcDur.toFixed(2)}s</span>
        </div>
      </Section>
      <Section title="Level">
        <label class="field slider">
          <span class="lbl">Volume</span>
          <input type="range" min={0} max={2} step={0.01} value={c.volume} onInput={(e) => upd((x) => (x.volume = Number((e.currentTarget as HTMLInputElement).value)), 'volume')} />
          <span class="unit">{db} dB</span>
        </label>
        <div class="grid2">
          <NumField label="Fade in" value={c.fadeIn} step={0.01} min={0} max={c.dur} unit="s" onChange={(v) => upd((x) => (x.fadeIn = v), 'fadeIn')} />
          <NumField label="Fade out" value={c.fadeOut} step={0.01} min={0} max={c.dur} unit="s" onChange={(v) => upd((x) => (x.fadeOut = v), 'fadeOut')} />
        </div>
      </Section>
    </>
  )
}

// ------------------------------------------------------------ project ---

const KEYS: [string, string][] = [
  ['Space', 'play / pause'],
  [', .', 'back / forward a frame (shift: 1 s)'],
  ['Home End', 'start / end'],
  ['Ctrl Z', 'undo (shift: redo)'],
  ['Ctrl D', 'duplicate'],
  ['Del', 'delete'],
  ['Ctrl G', 'group (shift: ungroup)'],
  ['Arrows', 'nudge 1 px (shift: 10)'],
  ['Tab', 'switch 16:9 / 9:16'],
  ['Esc', 'deselect'],
  ['Right-click row', 'add a tween there'],
  ['Drag label', 'scrub a number'],
]

function ProjectInspector() {
  const p = project.value!
  const unvoiced = p.audio.filter((c) => c.track === 'narration' && c.text?.trim() && (!c.src || (c.voiced ?? c.text) !== c.text))
  return (
    <>
      <Section title="Project">
        <div class="grid2">
          <NumField label="Length" value={p.duration} step={0.1} min={0.5} digits={2} unit="s" onChange={(v) => commit((q) => (q.duration = v), 'duration')} />
        </div>
        <ColorField label="Background" value={p.background} onChange={(v) => commit((q) => (q.background = v), 'bg')} />
        <TextField label="CSS" value={p.background} onChange={(v) => commit((q) => (q.background = v))} />
        <div class="hint">Background takes any CSS, e.g. radial-gradient(circle at 50% 40%, #2a2438, #0d0b14).</div>
        <div class="stats">
          {p.elements.length} elements · {p.tweens.length} tweens · {p.audio.length} clips
        </div>
        {unvoiced.length > 0 && (
          <button class="btn primary" onClick={() => voiceClips(unvoiced.map((c) => c.id))}>
            Voice {unvoiced.length} narration line{unvoiced.length > 1 ? 's' : ''}
          </button>
        )}
      </Section>
      <Section title="Keys">
        <div class="keys">
          {KEYS.map(([k, what]) => (
            <>
              <kbd>{k}</kbd>
              <span>{what}</span>
            </>
          ))}
        </div>
      </Section>
    </>
  )
}
