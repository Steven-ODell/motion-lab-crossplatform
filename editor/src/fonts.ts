// Fonts are bundled (no Google Fonts at render time), so export works offline
// and every frame uses exactly these files.
import '@fontsource/unbounded/600.css'
import '@fontsource/unbounded/800.css'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/800.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/800.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/700.css'
import type { Project } from './types'
import { resolveProps } from './player'

export const FONTS: Record<string, number[]> = {
  Unbounded: [600, 800],
  'IBM Plex Sans': [400, 600],
  'JetBrains Mono': [400, 600, 800],
  Inter: [400, 600, 800],
  'Space Grotesk': [500, 700],
}

// Nearest bundled weight, so the inspector never asks for a face that isn't there.
export function snapWeight(font: string, weight: number) {
  const ws = FONTS[font] ?? [400]
  return ws.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a))
}

// Load every face the project uses before the first frame is painted.
export async function loadProjectFonts(project: Project) {
  const want = new Set<string>()
  for (const el of project.elements) {
    if (el.type !== 'text') continue
    for (const aspect of ['wide', 'tall'] as const) {
      const p = resolveProps(el, aspect)
      const font = p.font ?? 'Inter'
      want.add(`${snapWeight(font, p.weight ?? 600)} 64px '${font}'`)
    }
  }
  await Promise.all([...want].map((f) => document.fonts.load(f).catch(() => [])))
  await document.fonts.ready
}
