// Mic voiceover: records while the timeline plays, then drops the take on the
// Voice track where recording started.
import { signal } from '@preact/signals'
import { commit, flash, pause, play, playing, projectName, select, time, uid } from './state'

export const recording = signal<{ start: number; since: number } | null>(null)

let rec: MediaRecorder | null = null
let stream: MediaStream | null = null

export async function startRecording() {
  if (recording.value) return
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } })
  } catch (e) {
    flash(`No microphone: ${e}`, 'error')
    return
  }
  const chunks: Blob[] = []
  rec = new MediaRecorder(stream)
  rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data)
  const start = time.value
  rec.onstop = async () => {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    const blob = new Blob(chunks, { type: rec?.mimeType || 'audio/webm' })
    rec = null
    recording.value = null
    if (blob.size < 2000) return flash('Recording was empty', 'error')
    flash('Saving take…')
    const ext = blob.type.includes('ogg') ? 'ogg' : 'webm'
    const fd = new FormData()
    fd.append('file', blob, `take.${ext}`)
    fd.append('kind', 'voice')
    const r = await fetch(`/api/projects/${projectName.value}/assets`, { method: 'POST', body: fd })
    if (!r.ok) return flash(`Upload failed: ${await r.text()}`, 'error')
    const info = await r.json()
    const id = uid('a')
    commit((p) => {
      const n = p.audio.filter((c) => c.track === 'voice').length + 1
      p.audio.push({ id, track: 'voice', src: info.src, start, offset: 0, dur: info.dur, srcDur: info.dur, volume: 1, fadeIn: 0, fadeOut: 0.05, name: `Take ${n}` })
    })
    select('clip', id)
  }
  rec.start(250)
  recording.value = { start, since: performance.now() }
  if (!playing.value) play()
}

export function stopRecording() {
  if (!rec) return
  rec.stop()
  pause()
}
