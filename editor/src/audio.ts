// Preview playback of the audio tracks through WebAudio, plus waveform peaks.
// Gains and fades are linear, the same curves ffmpeg's afade uses on export.
import { signal } from '@preact/signals'
import type { Clip, Project } from './types'

const PEAKS_PER_SEC = 200

class AudioEngine {
  ctx: AudioContext | null = null
  buffers = new Map<string, AudioBuffer>()
  peaks = new Map<string, Float32Array>()
  private loading = new Map<string, Promise<AudioBuffer | null>>()
  private live: AudioBufferSourceNode[] = []
  loaded = signal(0) // bumps when a buffer finishes decoding, so waveforms redraw

  private context() {
    if (!this.ctx) this.ctx = new AudioContext({ sampleRate: 48000 })
    return this.ctx
  }

  url(project: string, src: string) {
    return `/projects/${project}/${src}`
  }

  load(url: string): Promise<AudioBuffer | null> {
    const have = this.buffers.get(url)
    if (have) return Promise.resolve(have)
    let p = this.loading.get(url)
    if (!p) {
      p = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
        .then((b) => this.context().decodeAudioData(b))
        .then((buf) => {
          this.buffers.set(url, buf)
          this.peaks.set(url, computePeaks(buf))
          this.loaded.value++
          return buf
        })
        .catch(() => null)
      this.loading.set(url, p)
    }
    return p
  }

  preload(project: Project, name: string) {
    for (const c of allClips(project)) if (c.src) this.load(this.url(name, c.src))
  }

  // Start every clip that overlaps [t0, end) and return a clock for the playhead.
  play(project: Project, name: string, t0: number): () => number {
    const ctx = this.context()
    ctx.resume()
    this.stop()
    const lead = 0.06
    const begin = ctx.currentTime + lead
    const muted = new Set(project.muted ?? [])
    for (const c of allClips(project)) {
      if (!c.src || muted.has(c.track) || c.start + c.dur <= t0) continue
      const buf = this.buffers.get(this.url(name, c.src))
      if (!buf) {
        this.load(this.url(name, c.src))
        continue
      }
      this.schedule(ctx, buf, c, t0, begin)
    }
    return () => t0 + Math.max(0, ctx.currentTime - begin)
  }

  private schedule(ctx: AudioContext, buf: AudioBuffer, c: Clip, t0: number, begin: number) {
    const into = Math.max(0, t0 - c.start) // seconds already past in this clip
    const when = begin + Math.max(0, c.start - t0)
    const length = c.dur - into
    if (length <= 0) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    const g = ctx.createGain()
    const level = (x: number) => gainAt(c, x)
    g.gain.setValueAtTime(level(into), when)
    for (const pt of fadePoints(c)) if (pt > into) g.gain.linearRampToValueAtTime(level(pt), when + (pt - into))
    src.connect(g).connect(ctx.destination)
    src.start(when, c.offset + into, length)
    this.live.push(src)
  }

  stop() {
    for (const s of this.live) {
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
    }
    this.live = []
  }

  // One-shot preview of a single clip (inspector "listen" button).
  async audition(name: string, c: Clip) {
    const buf = await this.load(this.url(name, c.src))
    if (!buf) return
    const ctx = this.context()
    ctx.resume()
    this.stop()
    this.schedule(ctx, buf, { ...c, start: 0 }, 0, ctx.currentTime + 0.03)
  }
}

// Audio clips plus the sound of every visible, unmuted video element.
export function allClips(p: Project): Clip[] {
  const out = [...p.audio]
  for (const e of p.elements) {
    const v = e.clip
    if (e.type !== 'video' || !v?.audio || v.muted || e.hidden) continue
    out.push({ id: e.id, track: 'video' as Clip['track'], src: v.audio, start: v.start, offset: v.offset, dur: v.dur, srcDur: v.srcDur, volume: v.volume, fadeIn: 0, fadeOut: 0 })
  }
  return out
}

function fadePoints(c: Clip) {
  const fi = Math.min(c.fadeIn, c.dur)
  const fo = Math.min(c.fadeOut, c.dur)
  return [fi, c.dur - fo, c.dur].sort((a, b) => a - b)
}

// Clip-local gain at x seconds into the clip.
export function gainAt(c: Clip, x: number) {
  let g = c.volume
  if (c.fadeIn > 0 && x < c.fadeIn) g *= x / c.fadeIn
  if (c.fadeOut > 0 && x > c.dur - c.fadeOut) g *= Math.max(0, (c.dur - x) / c.fadeOut)
  return g
}

function computePeaks(buf: AudioBuffer) {
  const n = Math.ceil(buf.duration * PEAKS_PER_SEC)
  const out = new Float32Array(n)
  const step = buf.sampleRate / PEAKS_PER_SEC
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch)
    for (let i = 0; i < n; i++) {
      let m = out[i]
      const end = Math.min(data.length, Math.floor((i + 1) * step))
      for (let j = Math.floor(i * step); j < end; j += 4) {
        const v = Math.abs(data[j])
        if (v > m) m = v
      }
      out[i] = m
    }
  }
  return out
}

export { PEAKS_PER_SEC }
export const audio = new AudioEngine()
