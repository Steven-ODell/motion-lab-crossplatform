import { useEffect, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import { flash, project, projectName } from '../state'
import type { Aspect } from '../types'

interface Job {
  id: string
  project: string
  aspect: Aspect
  format: string
  stage: string
  frame?: number
  of?: number
  url?: string
  error?: string
  bytes?: number
  seconds?: number
}

export const exportOpen = signal(false)
const jobs = signal<Job[]>([])
let polling = 0

async function poll() {
  const r = await fetch('/api/jobs')
  if (r.ok) jobs.value = await r.json()
  const active = jobs.value.some((j) => !['done', 'error', 'cancelled'].includes(j.stage))
  clearTimeout(polling)
  if (active) polling = window.setTimeout(poll, 600)
}

export function ExportPanel() {
  const [format, setFormat] = useState<'mp4' | 'webm' | 'gif'>('mp4')
  const [aspects, setAspects] = useState<Aspect[]>(['wide'])
  const [fps, setFps] = useState(30)
  useEffect(() => {
    poll()
  }, [])
  const p = project.value
  if (!p) return null
  const fpsOptions = format === 'gif' ? [10, 15, 20] : [24, 30, 60]
  const f = fpsOptions.includes(fps) ? fps : fpsOptions[1]
  const unvoiced = p.audio.some((c) => c.track === 'narration' && c.text?.trim() && !c.src)

  const start = async () => {
    for (const a of aspects) {
      const r = await fetch(`/api/projects/${projectName.value}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aspect: a, format, fps: f }),
      })
      if (!r.ok) flash(`Export failed to start: ${await r.text()}`, 'error')
    }
    poll()
  }

  const toggle = (a: Aspect) => setAspects(aspects.includes(a) ? aspects.filter((x) => x !== a) : [...aspects, a])
  const mine = jobs.value.filter((j) => j.project === projectName.value).reverse()

  return (
    <div class="modal-back" onPointerDown={(e) => e.target === e.currentTarget && (exportOpen.value = false)}>
      <div class="modal">
        <header>
          <h2>Export</h2>
          <button class="btn xs ghost" onClick={() => (exportOpen.value = false)}>✕</button>
        </header>
        <div class="export-grid">
          <span class="lbl">Format</span>
          <div class="seg">
            {(['mp4', 'webm', 'gif'] as const).map((x) => (
              <button class={`btn sm ${format === x ? 'on' : ''}`} onClick={() => setFormat(x)}>{x.toUpperCase()}</button>
            ))}
          </div>
          <span class="lbl">Aspect</span>
          <div class="seg">
            <button class={`btn sm ${aspects.includes('wide') ? 'on' : ''}`} onClick={() => toggle('wide')}>16:9 · 1920×1080</button>
            <button class={`btn sm ${aspects.includes('tall') ? 'on' : ''}`} onClick={() => toggle('tall')}>9:16 · 1080×1920</button>
          </div>
          <span class="lbl">Frame rate</span>
          <div class="seg">
            {fpsOptions.map((x) => (
              <button class={`btn sm ${f === x ? 'on' : ''}`} onClick={() => setFps(x)}>{x} fps</button>
            ))}
          </div>
        </div>
        <div class="hint">
          {format === 'gif' ? 'GIF is half size and silent.' : 'Audio tracks are mixed in (muted tracks are left out).'}{' '}
          {unvoiced && <b class="warn">Some narration lines aren't voiced yet and will be silent.</b>}
        </div>
        <button class="btn primary big" disabled={!aspects.length} onClick={start}>
          Export {aspects.length > 1 ? 'both' : ''}
        </button>
        {mine.length > 0 && (
          <div class="jobs">
            {mine.map((j) => {
              const pct = j.stage === 'done' ? 100 : j.of ? Math.round(((j.frame ?? 0) / j.of) * 100) : 0
              return (
                <div class={`job ${j.stage}`}>
                  <div class="job-line">
                    <span>{j.format.toUpperCase()} {j.aspect === 'wide' ? '16:9' : '9:16'}</span>
                    <span class="job-stage">
                      {j.stage === 'frames' ? `frame ${j.frame}/${j.of}` : j.stage === 'done' ? `${((j.bytes ?? 0) / 1e6).toFixed(1)} MB in ${j.seconds}s` : j.stage}
                    </span>
                    {j.stage === 'done' && j.url && (
                      <>
                        <a class="btn xs" href={j.url} target="_blank">Open</a>
                        <a class="btn xs" href={j.url} download>Download</a>
                      </>
                    )}
                    {!['done', 'error', 'cancelled'].includes(j.stage) && (
                      <button class="btn xs" onClick={() => fetch(`/api/jobs/${j.id}/cancel`, { method: 'POST' }).then(poll)}>Cancel</button>
                    )}
                  </div>
                  <div class="progress"><i style={{ width: `${pct}%` }} /></div>
                  {j.error && <pre class="job-error">{j.error}</pre>}
                </div>
              )
            })}
            <button class="btn xs ghost" onClick={() => fetch(`/api/projects/${projectName.value}/reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })}>
              Show exports folder
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
