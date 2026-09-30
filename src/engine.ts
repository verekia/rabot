// Orchestration: loading files, keeping every track's loudness measurement in sync with the dials,
// and exporting. UI components only call into here and read the store.

import { Zip, ZipPassThrough } from 'fflate'

import { analyze, bufferChannels, CONCURRENCY } from './audio/analyzer'
import { renderChain } from './audio/chain'
import { MAX_MAKEUP_DB, postGainFor, SAMPLE_RATE } from './audio/plan'
import { encodeWav24 } from './audio/wav'
import { dropBuffer, getBuffer } from './buffers'
import { player } from './player'
import { isStale, planTrack, profileFromTracks, sameNames, updateTrack, useStore, type Track } from './store'

const PEAK_BUCKETS = 800

const computePeaks = (buffer: AudioBuffer) => {
  const l = buffer.getChannelData(0)
  const r = buffer.getChannelData(1)
  const peaks = new Float32Array(PEAK_BUCKETS)
  const size = Math.max(1, Math.floor(buffer.length / PEAK_BUCKETS))
  for (let b = 0; b < PEAK_BUCKETS; b++) {
    let max = 0
    const end = Math.min(buffer.length, (b + 1) * size)
    for (let i = b * size; i < end; i++) max = Math.max(max, Math.abs(l[i]!), Math.abs(r[i]!))
    peaks[b] = max
  }
  return peaks
}

const isAudio = (f: File) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i.test(f.name)

// --- Tracks ----------------------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export const addFiles = (files: File[]) => {
  const audio = files.filter(isAudio).toSorted((a, b) => collator.compare(a.name, b.name))
  if (audio.length === 0) return
  const tracks: Track[] = audio.map(file => ({
    id: crypto.randomUUID(),
    name: file.name,
    file,
    status: 'loading',
    error: null,
    duration: null,
    peaks: null,
    raw: null,
    stage: null,
    output: null,
  }))
  useStore.setState(s => ({ tracks: [...s.tracks, ...tracks], selectedId: s.selectedId ?? tracks[0]!.id }))
  schedule()
}

// Swap the source file of a track, keeping its position and per-track dials.
export const replaceFile = (id: string, file: File) => {
  if (!isAudio(file)) return
  if (useStore.getState().playingId === id) player.stop()
  updateTrack(id, {
    file,
    name: file.name,
    status: 'loading',
    error: null,
    duration: null,
    peaks: null,
    raw: null,
    stage: null,
    output: null,
  })
  dropBuffer(id)
  schedule()
}

export const removeTrack = (id: string) => {
  if (useStore.getState().playingId === id) player.stop()
  dropBuffer(id)
  useStore.setState(s => {
    const index = s.tracks.findIndex(t => t.id === id)
    const tracks = s.tracks.filter(t => t.id !== id)
    const selectedId = s.selectedId === id ? (tracks[Math.min(index, tracks.length - 1)]?.id ?? null) : s.selectedId
    return { tracks, selectedId }
  })
}

// --- Processing ------------------------------------------------------------------------------------
// Each track gets one job at a time that does whatever it's missing, decoding the file once:
//  1. input analysis (loudness, true peak): the track becomes playable;
//  2. stage render (pre gain, high-pass, dynamics) + analysis (loudness, true peak, spectrum). The tone
//     EQ's loudness change is computed from that spectrum, so tone changes never need a re-render;
//  3. makeup, only when the limiter has real work to do: it also shaves some loudness, so the full chain
//     is rendered and the gain corrected until the output lands on target.
// Up to CONCURRENCY jobs run in parallel: decoding, offline rendering and analysis each use their own
// threads.

const fileOf = (id: string) => useStore.getState().tracks.find(t => t.id === id)?.file
const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Could not process this file')

const computeMakeup = async (buffer: AudioBuffer, id: string, file: File) => {
  const state = useStore.getState()
  const track = state.tracks.find(t => t.id === id)
  const tp = track && planTrack(state, track)
  if (!track?.stage || !tp || tp.exact || track.stage.key !== tp.plan.key) return
  const reset = { ...track.stage, makeup: 0, makeupFor: null }
  const atBase = postGainFor(state.global, tp.plan, reset)
  if (atBase.exact) {
    // Limiting became negligible: no makeup needed anymore.
    updateTrack(id, { stage: reset })
    return
  }
  // Secant iterations: under heavy limiting each dB of gain adds less than a dB of loudness.
  const goal = state.global.target
  let makeup = 0
  let slope = 1
  let previous: { makeup: number; lufs: number } | null = null
  for (let i = 0; i < 6; i++) {
    const rendered = await renderChain(buffer, tp.plan, atBase.base + makeup, 'full')
    const r = await analyze(rendered, SAMPLE_RATE, false)
    const error = goal - r.lufs
    if (Math.abs(error) < 0.05) break
    if (previous && makeup !== previous.makeup) {
      slope = Math.min(1, Math.max(0.2, (r.lufs - previous.lufs) / (makeup - previous.makeup)))
    }
    previous = { makeup, lufs: r.lufs }
    makeup = Math.min(MAX_MAKEUP_DB, makeup + error / slope)
  }
  if (fileOf(id) === file) updateTrack(id, { stage: { ...track.stage, makeup, makeupFor: atBase.makeupKey } })
}

const processTrack = async (id: string, { makeup = true } = {}) => {
  const initial = useStore.getState().tracks.find(t => t.id === id)
  if (!initial) return
  const file = initial.file
  try {
    const buffer = await getBuffer(id, file)
    if (fileOf(id) !== file) return

    if (!initial.raw) {
      const peaks = computePeaks(buffer)
      const r = await analyze(bufferChannels(buffer), SAMPLE_RATE, false)
      if (fileOf(id) !== file) return
      if (!Number.isFinite(r.lufs)) throw new Error('This file is silent')
      updateTrack(id, {
        status: 'ready',
        duration: buffer.duration,
        peaks,
        raw: { lufs: r.lufs, truePeak: r.truePeak },
      })
    }

    const state = useStore.getState()
    const track = state.tracks.find(t => t.id === id)
    const tp = track && planTrack(state, track)
    if (!track || !tp) return
    if (track.stage?.key !== tp.plan.key) {
      const rendered = await renderChain(buffer, tp.plan, 0, 'stage')
      const r = await analyze(rendered, SAMPLE_RATE, true)
      if (fileOf(id) !== file) return
      updateTrack(id, {
        stage: {
          key: tp.plan.key,
          lufs: r.lufs,
          truePeak: r.truePeak,
          bands: r.bands!,
          spectrum: r.spectrum!,
          makeup: track.stage?.makeup ?? 0,
          makeupFor: null,
        },
      })
      syncProfile()
    }

    if (makeup) await computeMakeup(buffer, id, file)
  } catch (e) {
    if (fileOf(id) === file) updateTrack(id, { status: 'error', error: errorMessage(e) })
  }
}

// Until the first export the tone reference follows the tracks; once locked it only changes on request.
const sameBands = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) < 1e-6)

const syncProfile = () => {
  const { tracks, profile } = useStore.getState()
  if (profile?.locked) return
  const next = profileFromTracks(tracks, false)
  if (!profile && !next) return
  if (profile && next && sameNames(profile.names, next.names) && sameBands(profile.bands, next.bands)) return
  useStore.setState({ profile: next })
}

export const updateProfile = () => {
  const { tracks, profile } = useStore.getState()
  const next = profileFromTracks(tracks, profile?.locked ?? false)
  if (next) useStore.setState({ profile: next })
}

const lockProfile = () => {
  const { profile } = useStore.getState()
  if (profile && !profile.locked) useStore.setState({ profile: { ...profile, locked: true } })
}

const running = new Map<string, Promise<void>>()

const startJob = (id: string, options?: { makeup?: boolean }) => {
  const existing = running.get(id)
  if (existing) return existing
  const job = processTrack(id, options).finally(() => {
    running.delete(id)
    schedule()
  })
  running.set(id, job)
  return job
}

const pump = () => {
  syncProfile()
  const state = useStore.getState()
  const anyLoading = state.tracks.some(t => t.status === 'loading')
  const needsWork = (t: Track) => {
    if (running.has(t.id)) return false
    if (t.status === 'loading') return true
    if (t.status !== 'ready' || !isStale(state, t)) return false
    const tp = planTrack(state, t)
    // Stage renders run right away; makeup waits until the set (and so the tone reference) is complete.
    return t.stage?.key !== tp?.plan.key || !anyLoading
  }
  const candidates = state.tracks.filter(needsWork)
  const priority = (t: Track) => (t.id === state.playingId ? 0 : t.id === state.selectedId ? 1 : 2)
  candidates.sort((a, b) => priority(a) - priority(b))
  for (const t of candidates) {
    if (running.size >= CONCURRENCY) break
    void startJob(t.id, { makeup: !anyLoading })
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
const schedule = () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(pump, 100)
}

let lastTracks: Track[] | null = null
let lastGlobal: unknown = null
let lastProfile: unknown = null
useStore.subscribe(state => {
  if (state.tracks === lastTracks && state.global === lastGlobal && state.profile === lastProfile) return
  lastTracks = state.tracks
  lastGlobal = state.global
  lastProfile = state.profile
  schedule()
})

// --- Export ----------------------------------------------------------------------------------------

const ensureMeasured = async (id: string) => {
  for (let i = 0; i < 4; i++) {
    const state = useStore.getState()
    const track = state.tracks.find(t => t.id === id)
    if (!track || !isStale(state, track)) return
    await (running.get(id) ?? startJob(id, { makeup: true }))
  }
}

const renderWav = async (id: string) => {
  lockProfile()
  await ensureMeasured(id)
  const state = useStore.getState()
  const track = state.tracks.find(t => t.id === id)!
  const tp = planTrack(state, track)!
  const buffer = await getBuffer(track.id, track.file)
  // Render, verify what we're shipping, and correct the gain if it missed the target.
  let gain = tp.postGain
  let channels = await renderChain(buffer, tp.plan, gain, 'full')
  let r = await analyze(channels, SAMPLE_RATE, false)
  for (let i = 0; i < 2 && Math.abs(state.global.target - r.lufs) > 0.05; i++) {
    gain += state.global.target - r.lufs
    channels = await renderChain(buffer, tp.plan, gain, 'full')
    r = await analyze(channels, SAMPLE_RATE, false)
  }
  updateTrack(id, { output: { key: tp.plan.key, postGain: tp.postGain, lufs: r.lufs, truePeak: r.truePeak } })
  return encodeWav24(channels, SAMPLE_RATE)
}

const wavName = (name: string) => `${name.replace(/\.[^.]+$/, '')}.wav`

const download = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const exportable = () => useStore.getState().tracks.filter(t => t.status === 'ready')

export const exportTrack = async (id: string) => {
  if (useStore.getState().exporting) return
  const track = useStore.getState().tracks.find(t => t.id === id)
  if (!track || track.status !== 'ready') return
  useStore.setState({ exporting: { done: 0, total: 1 } })
  try {
    const wav = await renderWav(id)
    download(new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), wavName(track.name))
  } finally {
    useStore.setState({ exporting: null })
  }
}

export const exportAll = async () => {
  const tracks = exportable()
  if (tracks.length === 0 || useStore.getState().exporting) return
  useStore.setState({ exporting: { done: 0, total: tracks.length } })
  try {
    const parts: Blob[] = []
    let finished!: () => void
    const done = new Promise<void>(resolve => (finished = resolve))
    const zip = new Zip((err, chunk, final) => {
      if (err) throw err
      parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]))
      if (final) finished()
    })
    const used = new Set<string>()
    for (const [i, track] of tracks.entries()) {
      const wav = await renderWav(track.id)
      let name = wavName(track.name)
      for (let n = 2; used.has(name); n++) name = wavName(`${track.name.replace(/\.[^.]+$/, '')} (${n})`)
      used.add(name)
      // WAV barely compresses; store it as-is so zipping is instant.
      const entry = new ZipPassThrough(name)
      zip.add(entry)
      entry.push(wav, true)
      useStore.setState({ exporting: { done: i + 1, total: tracks.length } })
    }
    zip.end()
    await done
    download(new Blob(parts, { type: 'application/zip' }), 'backing-tracks.zip')
  } finally {
    useStore.setState({ exporting: null })
  }
}

// Dev-only handle for poking at the pipeline from the console.
if (process.env.NODE_ENV === 'development') {
  Object.assign(window, { __rabot: { useStore, planTrack, renderChain, analyze, exportAll, exportTrack, player } })
}
