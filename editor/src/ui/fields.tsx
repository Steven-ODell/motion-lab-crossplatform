import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { gsap } from 'gsap'

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d

// A number box whose label scrubs: drag the label left/right to change it
// (shift = ×10, alt = ÷10), or type a value and press Enter.
export function NumField(props: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  min?: number
  max?: number
  digits?: number
  unit?: string
  mark?: boolean // overridden in 9:16
  onReset?: () => void
  title?: string
}) {
  const { label, value, onChange, step = 1, min = -Infinity, max = Infinity, digits = 2, unit, mark, onReset } = props
  const [text, setText] = useState<string | null>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))

  const scrub = (e: PointerEvent) => {
    if (e.button !== 0) return
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const v0 = value
    const move = (m: PointerEvent) => {
      const mult = m.shiftKey ? 10 : m.altKey ? 0.1 : 1
      onChange(round(clamp(v0 + (m.clientX - x0) * step * mult), digits))
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const done = () => {
    if (text == null) return
    const v = Number(text)
    if (text.trim() !== '' && Number.isFinite(v)) onChange(clamp(v))
    setText(null)
  }

  return (
    <label class="field num" title={props.title}>
      <span class="lbl scrub" onPointerDown={scrub}>
        {label}
        {mark && <i class="mark" title="Set for 9:16 only. Click to use the 16:9 value." onClick={(e) => (e.preventDefault(), onReset?.())} />}
      </span>
      <input
        value={text ?? String(round(value, digits))}
        onFocus={(e) => (e.currentTarget as HTMLInputElement).select()}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(null)
            ;(e.currentTarget as HTMLInputElement).blur()
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            onChange(round(clamp(value + d), digits))
            setText(null)
          }
        }}
      />
      {unit && <span class="unit">{unit}</span>}
    </label>
  )
}

export function toHex(c: string): string {
  try {
    const [r, g, b] = gsap.utils.splitColor(c) as number[]
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  } catch {
    return '#000000'
  }
}

export function ColorField(props: { label: string; value: string; onChange: (v: string) => void; mark?: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const done = () => {
    if (text != null && text.trim()) props.onChange(text.trim())
    setText(null)
  }
  return (
    <label class="field color">
      <span class="lbl">{props.label}{props.mark && <i class="mark" />}</span>
      <input type="color" value={toHex(props.value)} onInput={(e) => props.onChange((e.currentTarget as HTMLInputElement).value)} />
      <input
        class="hex"
        value={text ?? props.value}
        onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
        onBlur={done}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
    </label>
  )
}

export function TextField(props: { label: string; value: string; onChange: (v: string) => void; multiline?: boolean; id?: string; placeholder?: string; rows?: number }) {
  const [text, setText] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  useEffect(() => setText(null), [props.value])
  const done = () => {
    if (text != null && text !== props.value) props.onChange(text)
    setText(null)
  }
  const common = {
    id: props.id,
    ref,
    value: text ?? props.value,
    placeholder: props.placeholder,
    onInput: (e: Event) => setText((e.currentTarget as HTMLInputElement).value),
    onBlur: done,
  }
  return (
    <label class={`field text ${props.multiline ? 'multi' : ''}`}>
      <span class="lbl">{props.label}</span>
      {props.multiline ? (
        <textarea
          {...common}
          rows={props.rows ?? 3}
          onKeyDown={(e) => (e.key === 'Enter' && (e.ctrlKey || e.metaKey) ? (e.currentTarget as HTMLTextAreaElement).blur() : undefined)}
        />
      ) : (
        <input {...common} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} />
      )}
    </label>
  )
}

export function Select<T extends string | number>(props: { label: string; value: T; options: (T | [T, string])[]; onChange: (v: T) => void }) {
  return (
    <label class="field select">
      <span class="lbl">{props.label}</span>
      <select
        value={String(props.value)}
        onChange={(e) => {
          const raw = (e.currentTarget as HTMLSelectElement).value
          const opt = props.options.map((o) => (Array.isArray(o) ? o[0] : o)).find((o) => String(o) === raw)
          if (opt !== undefined) props.onChange(opt)
        }}
      >
        {props.options.map((o) => {
          const [v, l] = Array.isArray(o) ? o : [o, String(o)]
          return <option value={String(v)}>{l}</option>
        })}
      </select>
    </label>
  )
}

export function Section(props: { title: string; children: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <section class="section">
      <header>
        <h3>{props.title}</h3>
        {props.actions}
      </header>
      <div class="body">{props.children}</div>
    </section>
  )
}

// Small popover menu anchored under a button.
export function Menu(props: { label: ComponentChildren; items: [string, () => void][]; class?: string; title?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])
  return (
    <div class="menu-wrap" ref={ref}>
      <button class={props.class ?? 'btn'} title={props.title} onClick={() => setOpen(!open)}>
        {props.label}
      </button>
      {open && (
        <div class="menu">
          {props.items.map(([name, fn]) => (
            <button
              onClick={() => {
                setOpen(false)
                fn()
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
