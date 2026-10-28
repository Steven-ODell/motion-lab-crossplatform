// Headless export page: render.html?project=<name>&aspect=wide|tall
// export.py waits for window.__motion, then seeks and screenshots each frame.
import './fonts'
import { loadProjectFonts } from './fonts'
import { Player } from './player'
import type { Aspect, Project } from './types'

declare global {
  interface Window {
    __motion?: { duration: number; size: [number, number]; seek(t: number): Promise<void> }
  }
}

async function boot() {
  const q = new URLSearchParams(location.search)
  const name = q.get('project')!
  const aspect = (q.get('aspect') as Aspect) || 'wide'
  const project: Project = await (await fetch(`/api/projects/${encodeURIComponent(name)}`)).json()
  const player = new Player(document.getElementById('stage')!, `/projects/${encodeURIComponent(name)}/`)
  await loadProjectFonts(project)
  player.set(project, aspect)
  await Promise.all(
    [...document.images].map((img) =>
      img.complete
        ? null
        : new Promise((r) => {
            img.addEventListener('load', r)
            img.addEventListener('error', r)
          }),
    ),
  )
  await Promise.all(
    player.videos().map((v) =>
      v.readyState >= 2
        ? null
        : new Promise((r) => {
            v.addEventListener('loadeddata', r, { once: true })
            v.addEventListener('error', r, { once: true })
          }),
    ),
  )
  await document.fonts.ready
  window.__motion = {
    duration: project.duration,
    size: player.size,
    // Resolves (to nothing) once video frames are decoded, so the screenshot that follows is exact.
    async seek(t: number) {
      await player.seekFrame(t)
    },
  }
}

boot()
