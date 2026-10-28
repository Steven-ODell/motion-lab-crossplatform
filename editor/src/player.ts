// Turns a project into DOM and paints any moment of it.
//
// There is no live GSAP timeline here. Every frame is computed from scratch from
// the tween list (GSAP supplies the eases and color blending), so seeking is
// exact in any order, the editor can change a tween and repaint instantly, and
// the exporter, which seeks frame by frame in headless Chromium, gets the same
// picture the editor shows.

import { gsap } from 'gsap'
import { type AnimProp, type AnimValue, type Aspect, type El, type Project, type Props, SIZES, COLOR_PROPS } from './types'

type Ease = (p: number) => number

interface CTween {
  id: string
  start: number
  dur: number
  ease: Ease
  from: AnimValue
  to: AnimValue
  mix: ((p: number) => AnimValue) | null // colors
}

type Channels = Map<AnimProp, CTween[]>

const easeCache = new Map<string, Ease>()
export function easeFn(name: string): Ease {
  let fn = easeCache.get(name)
  if (!fn) {
    try {
      fn = (gsap.parseEase(name) as Ease | undefined) ?? ((p: number) => p)
      fn(0.5)
    } catch {
      fn = (p: number) => p
    }
    easeCache.set(name, fn)
  }
  return fn
}

export function resolveProps(el: El, aspect: Aspect): Props {
  return aspect === 'tall' && el.tall ? { ...el.props, ...el.tall } : el.props
}

export function restValue(prop: AnimProp, p: Props): AnimValue {
  switch (prop) {
    case 'x': case 'y': case 'rotation': case 'blur': return 0
    case 'scale': case 'opacity': case 'draw': case 'reveal': return 1
    case 'w': return p.w
    case 'h': return p.h
    case 'fill': return p.fill ?? 'rgba(0,0,0,0)'
    case 'color': return p.color ?? '#e6e1f2'
    case 'stroke': return p.stroke ?? 'rgba(0,0,0,0)'
    case 'glow': return p.glow ?? 0
  }
}

function sample(tw: CTween, t: number): AnimValue {
  const p = tw.dur > 0 ? Math.min(1, Math.max(0, (t - tw.start) / tw.dur)) : 1
  const e = tw.ease(p)
  if (tw.mix) return tw.mix(e)
  return (tw.from as number) + ((tw.to as number) - (tw.from as number)) * e
}

// Before the first tween starts, a channel holds that tween's `from` (so an
// element that fades in at 2 s is invisible until then). After that, the most
// recently started tween owns the value.
function evalChannel(list: CTween[], t: number, rest: AnimValue, upto = list.length): AnimValue {
  let v = upto > 0 ? list[0].from : rest
  for (let i = 0; i < upto; i++) {
    if (list[i].start > t) break
    v = sample(list[i], t)
  }
  return v
}

export function compile(project: Project, aspect: Aspect): Map<string, Channels> {
  const byEl = new Map<string, Channels>()
  const els = new Map(project.elements.map((e) => [e.id, e]))
  const order = project.tweens.map((tw, i) => ({ tw, i })).sort((a, b) => a.tw.start - b.tw.start || a.i - b.i)
  for (const { tw } of order) {
    const el = els.get(tw.target)
    if (!el) continue
    const rest = resolveProps(el, aspect)
    let chans = byEl.get(el.id)
    if (!chans) byEl.set(el.id, (chans = new Map()))
    for (const [prop, pair] of Object.entries(tw.props) as [AnimProp, [AnimValue | null, AnimValue]][]) {
      if (!pair) continue
      let list = chans.get(prop)
      if (!list) chans.set(prop, (list = []))
      const restV = restValue(prop, rest)
      const from = pair[0] ?? evalChannel(list, tw.start, restV)
      const to = pair[1] ?? restV
      const color = COLOR_PROPS.includes(prop)
      list.push({
        id: tw.id,
        start: tw.start,
        dur: Math.max(0, tw.dur),
        ease: easeFn(tw.ease || 'none'),
        from: color ? String(from) : Number(from),
        to: color ? String(to) : Number(to),
        mix: color ? (gsap.utils.interpolate(String(from), String(to)) as (p: number) => string) : null,
      })
    }
  }
  return byEl
}

// Value of one property of one element at time t (used by the inspector too).
export function valueAt(chans: Channels | undefined, prop: AnimProp, t: number, rest: Props): AnimValue {
  const list = chans?.get(prop)
  return list ? evalChannel(list, t, restValue(prop, rest)) : restValue(prop, rest)
}

// [[#ff5ea0|words]] colors words; everything else is literal.
export function parseRich(text: string): { s: string; color?: string }[] {
  const out: { s: string; color?: string }[] = []
  const re = /\[\[([^|\]]+)\|(.*?)\]\]/gs
  let last = 0
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push({ s: text.slice(last, m.index) })
    out.push({ s: m[2], color: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ s: text.slice(last) })
  return out
}

export function plainText(text: string) {
  return parseRich(text).map((r) => r.s).join('')
}

interface Node {
  el: HTMLDivElement
  type: El['type']
  key: string // static build key; rebuilt when it changes
  chars: HTMLSpanElement[]
  lastReveal: number
  path?: SVGPathElement
  svg?: SVGSVGElement
  img?: HTMLImageElement
  video?: HTMLVideoElement
  textBox?: HTMLDivElement
}

const SVGNS = 'http://www.w3.org/2000/svg'

export class Player {
  root: HTMLDivElement
  aspect: Aspect = 'wide'
  project: Project | null = null
  time = 0
  private nodes = new Map<string, Node>()
  private chans = new Map<string, Channels>()
  private orderKey = ''
  // While the editor plays, videos run on their own clock and are only nudged
  // when they drift; while scrubbing or exporting they are seeked exactly.
  playing = false

  constructor(host: HTMLElement, private assetBase: string) {
    this.root = document.createElement('div')
    this.root.className = 'ml-stage'
    Object.assign(this.root.style, { position: 'relative', overflow: 'hidden', transformOrigin: '0 0' })
    host.appendChild(this.root)
  }

  get size() {
    return SIZES[this.aspect]
  }

  nodeOf(id: string): HTMLDivElement | undefined {
    return this.nodes.get(id)?.el
  }

  set(project: Project, aspect: Aspect) {
    const resized = aspect !== this.aspect || !this.project
    this.project = project
    this.aspect = aspect
    const [w, h] = SIZES[aspect]
    if (resized) Object.assign(this.root.style, { width: `${w}px`, height: `${h}px` })
    this.root.style.background = project.background

    const seen = new Set<string>()
    for (const el of project.elements) {
      seen.add(el.id)
      let n = this.nodes.get(el.id)
      if (!n || n.type !== el.type) {
        n?.el.remove()
        n = this.create(el)
        this.nodes.set(el.id, n)
      }
      this.applyStatic(n, el)
    }
    for (const [id, n] of this.nodes) {
      if (!seen.has(id)) {
        n.el.remove()
        this.nodes.delete(id)
      }
    }
    const orderKey = project.elements.map((e) => `${e.id}<${e.parent ?? ''}`).join(',')
    if (orderKey !== this.orderKey) {
      this.orderKey = orderKey
      for (const el of project.elements) {
        const parent = (el.parent && this.nodes.get(el.parent)?.el) || this.root
        parent.appendChild(this.nodes.get(el.id)!.el)
      }
    }
    this.chans = compile(project, aspect)
    for (const n of this.nodes.values()) n.lastReveal = -1
    this.seek(this.time)
  }

  private create(el: El): Node {
    const div = document.createElement('div')
    div.dataset.id = el.id
    div.style.position = 'absolute'
    div.style.boxSizing = 'border-box'
    const n: Node = { el: div, type: el.type, key: '', chars: [], lastReveal: -1 }
    if (el.type === 'path') {
      n.svg = document.createElementNS(SVGNS, 'svg')
      n.svg.style.cssText = 'width:100%;height:100%;overflow:visible;display:block'
      n.path = document.createElementNS(SVGNS, 'path')
      n.path.setAttribute('pathLength', '1')
      n.path.setAttribute('stroke-linecap', 'round')
      n.path.setAttribute('stroke-linejoin', 'round')
      n.svg.appendChild(n.path)
      div.appendChild(n.svg)
    } else if (el.type === 'video') {
      const v = document.createElement('video')
      v.muted = true // its sound plays through the audio mix instead
      v.playsInline = true
      v.preload = 'auto'
      v.disablePictureInPicture = true
      v.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none'
      n.video = v
      div.appendChild(v)
    } else if (el.type === 'image') {
      n.img = document.createElement('img')
      n.img.draggable = false
      n.img.style.cssText = 'width:100%;height:100%;display:block'
      div.appendChild(n.img)
    } else if (el.type === 'text') {
      n.textBox = document.createElement('div')
      n.textBox.style.cssText = 'width:100%;white-space:pre-wrap;overflow-wrap:break-word'
      div.style.display = 'flex'
      div.style.alignItems = 'center'
      div.appendChild(n.textBox)
    }
    return n
  }

  private applyStatic(n: Node, el: El) {
    const p = resolveProps(el, this.aspect)
    const s = n.el.style
    s.left = `${p.x}px`
    s.top = `${p.y}px`
    s.width = `${p.w}px`
    s.height = `${p.h}px`
    s.display = el.hidden ? 'none' : el.type === 'text' ? 'flex' : 'block'
    const hasStroke = p.stroke && (p.strokeWidth ?? 0) > 0
    if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'group') {
      s.borderRadius = el.type === 'ellipse' ? '50%' : `${p.radius ?? 0}px`
      s.borderStyle = hasStroke ? 'solid' : 'none'
      s.borderWidth = `${p.strokeWidth ?? 0}px`
    }
    if (el.type === 'path' && n.path && n.svg) {
      n.svg.setAttribute('viewBox', p.viewBox || `0 0 ${p.w} ${p.h}`)
      n.svg.setAttribute('preserveAspectRatio', 'none')
      n.path.setAttribute('d', p.d ?? '')
      n.path.setAttribute('stroke-width', String(p.strokeWidth ?? 0))
    }
    if (el.type === 'video' && n.video) {
      const src = p.src ? this.assetBase + p.src : ''
      if (n.video.getAttribute('src') !== src) n.video.setAttribute('src', src)
      n.video.style.objectFit = p.fit ?? 'cover'
    }
    if (el.type === 'image' && n.img) {
      const src = p.src ? this.assetBase + p.src : ''
      if (n.img.getAttribute('src') !== src) n.img.setAttribute('src', src)
      n.img.style.objectFit = p.fit ?? 'contain'
    }
    if (el.type === 'text' && n.textBox) {
      const tb = n.textBox.style
      tb.fontFamily = `'${p.font ?? 'Inter'}', sans-serif`
      tb.fontSize = `${p.size ?? 64}px`
      tb.fontWeight = String(p.weight ?? 600)
      tb.textAlign = p.align ?? 'center'
      tb.lineHeight = String(p.lineHeight ?? 1.2)
      tb.letterSpacing = `${p.letterSpacing ?? 0}em`
      const animated = this.hasChannel(el.id, 'reveal')
      const key = `${p.text}|${animated}`
      if (key !== n.key) {
        n.key = key
        this.buildText(n, p.text ?? '', animated)
      }
    }
  }

  private hasChannel(id: string, prop: AnimProp) {
    return !!this.project?.tweens.some((t) => t.target === id && t.props[prop])
  }

  // Characters become spans only when a reveal tween needs them. Words are
  // nowrap boxes so lines still break between words.
  private buildText(n: Node, text: string, perChar: boolean) {
    const box = n.textBox!
    box.textContent = ''
    n.chars = []
    for (const run of parseRich(text)) {
      const host = document.createElement('span')
      if (run.color) host.style.color = run.color
      if (!perChar) {
        host.textContent = run.s
        box.appendChild(host)
        continue
      }
      for (const part of run.s.split(/(\s+)/)) {
        if (!part) continue
        if (/^\s+$/.test(part)) {
          host.appendChild(document.createTextNode(part))
          continue
        }
        const word = document.createElement('span')
        word.style.cssText = 'display:inline-block;white-space:nowrap'
        for (const ch of part) {
          const c = document.createElement('span')
          c.style.display = 'inline-block'
          c.textContent = ch
          word.appendChild(c)
          n.chars.push(c)
        }
        host.appendChild(word)
      }
      box.appendChild(host)
    }
  }

  seek(t: number) {
    this.time = t
    const project = this.project
    if (!project) return
    for (const el of project.elements) {
      const n = this.nodes.get(el.id)
      if (!n || el.hidden) continue
      const p = resolveProps(el, this.aspect)
      const ch = this.chans.get(el.id)
      const v = (prop: AnimProp) => valueAt(ch, prop, t, p)
      const s = n.el.style
      if (n.video) {
        const on = this.syncVideo(n.video, el, t)
        s.visibility = on ? 'visible' : 'hidden'
      }
      const x = v('x') as number, y = v('y') as number
      const rot = (p.rotation ?? 0) + (v('rotation') as number)
      const sc = (p.scale ?? 1) * (v('scale') as number)
      s.transform = `translate(-50%,-50%) translate(${x}px,${y}px) rotate(${rot}deg) scale(${sc})`
      s.opacity = String(Math.max(0, Math.min(1, (p.opacity ?? 1) * (v('opacity') as number))))
      if (ch?.has('w')) s.width = `${v('w')}px`
      if (ch?.has('h')) s.height = `${v('h')}px`
      const blur = v('blur') as number
      const glow = v('glow') as number
      if (el.type === 'text') {
        const color = v('color') as string
        n.textBox!.style.color = color
        n.textBox!.style.textShadow = glow > 0 ? `0 0 ${glow}px ${color}` : ''
        s.filter = blur > 0 ? `blur(${blur}px)` : ''
        if (n.chars.length) this.paintReveal(n, v('reveal') as number, p.reveal ?? 'rise')
      } else if (el.type === 'path') {
        const stroke = v('stroke') as string
        const fill = v('fill') as string
        const draw = v('draw') as number
        n.path!.setAttribute('stroke', stroke)
        n.path!.setAttribute('fill', fill)
        if (draw < 1) {
          n.path!.style.strokeDasharray = '1 1'
          n.path!.style.strokeDashoffset = String(1 - Math.max(0, draw))
          n.path!.style.visibility = draw <= 0.001 && fill === 'rgba(0,0,0,0)' ? 'hidden' : 'visible'
        } else {
          n.path!.style.strokeDasharray = ''
          n.path!.style.strokeDashoffset = ''
          n.path!.style.visibility = 'visible'
        }
        const f = [blur > 0 ? `blur(${blur}px)` : '', glow > 0 ? `drop-shadow(0 0 ${glow / 2}px ${stroke !== 'rgba(0,0,0,0)' ? stroke : fill})` : '']
        s.filter = f.join(' ').trim()
      } else {
        const fill = v('fill') as string
        s.background = fill
        s.borderColor = v('stroke') as string
        s.boxShadow = glow > 0 ? `0 0 ${glow}px ${fill}` : ''
        s.filter = blur > 0 ? `blur(${blur}px)` : ''
      }
    }
  }

  // Keep a video element showing the right moment of its file. Returns
  // whether the clip is on screen at t.
  private syncVideo(v: HTMLVideoElement, el: El, t: number): boolean {
    const c = el.clip
    const on = !!c && t >= c.start && t < c.start + c.dur
    if (!c || !on) {
      if (!v.paused) v.pause()
      return false
    }
    const want = c.offset + (t - c.start)
    if (this.playing) {
      if (v.paused) {
        v.currentTime = want
        v.play().catch(() => {})
      } else if (Math.abs(v.currentTime - want) > 0.2) v.currentTime = want
    } else {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - want) > 0.01) v.currentTime = want + 0.001
    }
    return true
  }

  setPlaying(on: boolean) {
    this.playing = on
    if (!on) for (const n of this.nodes.values()) n.video?.pause()
    this.seek(this.time)
  }

  // Seek and wait until every visible video has decoded its frame (export).
  async seekFrame(t: number) {
    this.seek(t)
    const waits: Promise<void>[] = []
    for (const n of this.nodes.values()) {
      const v = n.video
      if (!v || n.el.style.visibility === 'hidden') continue
      if (v.seeking || v.readyState < 2)
        waits.push(
          new Promise<void>((r) => {
            const done = () => r()
            v.addEventListener('seeked', done, { once: true })
            v.addEventListener('loadeddata', done, { once: true })
            setTimeout(done, 3000)
          }),
        )
    }
    if (!waits.length) return
    await Promise.all(waits)
    // One more painted frame so the decoded picture is on screen for the screenshot.
    await new Promise<void>((r) => {
      requestAnimationFrame(() => r())
      setTimeout(r, 50)
    })
  }

  videos(): HTMLVideoElement[] {
    return [...this.nodes.values()].flatMap((n) => (n.video ? [n.video] : []))
  }

  private paintReveal(n: Node, reveal: number, style: NonNullable<Props['reveal']>) {
    if (reveal === n.lastReveal) return
    n.lastReveal = reveal
    const total = n.chars.length
    const spread = style === 'type' ? 1 : Math.min(8, Math.max(1, total))
    const ease = easeFn('power2.out')
    n.chars.forEach((c, i) => {
      const q = Math.min(1, Math.max(0, (reveal * (total + spread) - i) / spread))
      const s = c.style
      if (style === 'type') {
        s.opacity = q > 0 ? '1' : '0'
        return
      }
      const e = ease(q)
      s.opacity = String(e)
      s.transform = style === 'rise' ? `translateY(${(1 - e) * 0.55}em)` : ''
      s.filter = style === 'blur' && e < 1 ? `blur(${(1 - e) * 14}px)` : ''
    })
  }
}
