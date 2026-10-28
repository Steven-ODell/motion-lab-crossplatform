// The project file format. A project is plain JSON (projects/<name>/project.json):
// Claude writes it, the editor tweaks it, and the player turns it into frames.

export type Aspect = 'wide' | 'tall'
export const SIZES: Record<Aspect, [number, number]> = { wide: [1920, 1080], tall: [1080, 1920] }

export type ElType = 'text' | 'rect' | 'ellipse' | 'path' | 'image' | 'video' | 'group'

// An element's resting state. x/y is its CENTER, relative to its parent group's
// top-left corner (or the stage's). Everything else is optional.
export interface Props {
  x: number
  y: number
  w: number
  h: number
  rotation?: number // degrees
  scale?: number
  opacity?: number
  fill?: string // rect/ellipse/path background, text has no fill
  stroke?: string
  strokeWidth?: number
  radius?: number // rect corner radius
  glow?: number // px of glow in the element's own color
  // text
  text?: string // \n for new lines, [[#hex|words]] for colored words
  font?: string
  size?: number
  weight?: number
  color?: string
  align?: 'left' | 'center' | 'right'
  lineHeight?: number
  letterSpacing?: number // em
  reveal?: 'type' | 'rise' | 'fade' | 'blur' // how the `reveal` tween shows characters
  // path
  d?: string
  viewBox?: string // defaults to "0 0 w h"
  // image / video
  src?: string // relative to the project folder, e.g. assets/logo.png
  fit?: 'contain' | 'cover'
}

export interface El {
  id: string
  type: ElType
  name: string
  parent?: string | null // id of a group
  folder?: string // id of a folder (root-level elements only; children follow their group)
  hidden?: boolean
  locked?: boolean
  props: Props
  tall?: Partial<Props> // overrides used in the 9:16 layout
  clip?: VideoClip // video elements: when and which part of the file plays
}

// A video element is only on screen from `start` to `start + dur`, showing the
// file from `offset` on. Its sound (`audio`, extracted on import) is mixed with
// the audio tracks.
export interface VideoClip {
  start: number
  offset: number
  dur: number
  srcDur: number
  volume: number
  muted?: boolean
  audio?: string // assets/....wav, absent when the file has no sound
  thumbs?: string // assets/....jpg, a strip of frames across the whole file
}

// Tweenable properties and what their values mean.
//   x, y      offset in px from the resting position (0 = where the layout puts it)
//   scale     multiplies the resting scale; rotation adds degrees; opacity multiplies
//   blur      px; draw 0..1 of a path's stroke; reveal 0..1 of a text's characters
//   w, h      absolute size in px; fill/color/stroke absolute colors; glow absolute px
export const ANIM_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity', 'blur', 'w', 'h', 'fill', 'color', 'stroke', 'glow', 'draw', 'reveal'] as const
export type AnimProp = (typeof ANIM_PROPS)[number]
export type AnimValue = number | string
export const COLOR_PROPS: AnimProp[] = ['fill', 'color', 'stroke']

export interface Tween {
  id: string
  target: string // element id
  start: number // seconds
  dur: number
  ease: string // any GSAP ease string: "power3.out", "back.out(1.7)", "none"
  // [from, to]. A null `from` means "whatever it is when this tween starts".
  props: Partial<Record<AnimProp, [AnimValue | null, AnimValue]>>
}

export type TrackKind = 'narration' | 'voice' | 'music' | 'sfx'
export const TRACKS: TrackKind[] = ['narration', 'voice', 'music', 'sfx']

export interface Clip {
  id: string
  track: TrackKind
  src: string // relative to the project folder; '' until a narration clip is voiced
  start: number // where it sits on the timeline
  offset: number // seconds trimmed off the front of the file
  dur: number // seconds played
  srcDur: number // full length of the file
  volume: number // linear gain, 1 = as recorded
  fadeIn: number
  fadeOut: number
  name?: string
  // narration (Kokoro) clips
  text?: string
  voice?: string
  speed?: number
  voiced?: string // the text `src` was generated from; differs from `text` after an edit
}

// Folders only organize the layers panel and timeline. They never affect
// rendering (groups do that).
export interface Folder {
  id: string
  name: string
}

export interface Project {
  version: 1
  name: string
  duration: number
  background: string // any CSS background
  elements: El[] // paint order: later elements draw on top
  tweens: Tween[]
  audio: Clip[]
  muted?: TrackKind[]
  folders?: Folder[] // top of the layers panel first
}

export function blankProject(name: string): Project {
  return { version: 1, name, duration: 10, background: '#0d0b14', elements: [], tweens: [], audio: [] }
}
