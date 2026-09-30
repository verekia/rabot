// Orchestration: loading files, keeping every track's loudness measurement in sync with the dials,
// and exporting. UI components only call into here and read the store.

import { Zip, ZipPassThrough } from 'fflate'

import { analyze } from './audio/analyzer'
import { renderChain } from './audio/chain'
import {
  baseGainFor,
  MAKEUP_THRESHOLD_DB,
  MAX_MAKEUP_DB,
  peakLimiting,
  SAMPLE_RATE,
  type StageAnalysis,
} from './audio/plan'
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

// --- Loading ---------------------------------------------------------------------------------------

let loadQueue = Promise.resolve()

const load = (id: string, file: File) => {
  loadQueue = loadQueue.then(async () => {
    try {
      const buffer = await getBuffer(id, file)
      // Bail if the track was removed or its file swapped while we were decoding.
      if (useStore.getState().tracks.find(t => t.id === id)?.file !== file) return
      updateTrack(id, { duration: buffer.duration, peaks: computePeaks(buffer) })
      const r = await analyze(buffer, true)
      if (useStore.getState().tracks.find(t => t.id === id)?.file !== file) return
      if (!Number.isFinite(r.lufs)) throw new Error('This file is silent')
      updateTrack(id, { status: 'ready', raw: { lufs: r.lufs, truePeak: r.truePeak, bands: r.bands! } })
    } catch (e) {
      updateTrack(id, { status: 'error', error: e instanceof Error ? e.message : 'Could not decode this file' })
    }
  })
}

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
  for (const t of tracks) load(t.id, t.file)
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
  load(id, file)
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

// --- Measurement -----------------------------------------------------------------------------------
// The loudness after dynamics + EQ can't be predicted, so each track is rendered offline up to the
// post gain and measured. That sets the exact post gain for the loudness target. When the limiter then
// has real work to do it also shaves some loudness, so the full chain is rendered and the gain corrected
// until the output lands on target: every track ends up at the same loudness, whatever it took.

const measureTrack = async (id: string) => {
  const state = useStore.getState()
  const track = state.tracks.find(t => t.id === id)
  const tp = track && planTrack(state, track)
  if (!track || !tp) return
  const buffer = await getBuffer(track.id, track.file)
  let stage: StageAnalysis | null = track.stage?.key === tp.plan.key ? track.stage : null
  if (!stage) {
    const r = await analyze(await renderChain(buffer, tp.plan, 0, 'stage'), false)
    stage = { key: tp.plan.key, lufs: r.lufs, truePeak: r.truePeak, makeup: 0, makeupBase: null }
  }
  const base = baseGainFor(state.global, stage)
  if (peakLimiting(base, stage) > MAKEUP_THRESHOLD_DB) {
    const goal = state.global.target
    // Secant iterations: under heavy limiting each dB of gain adds less than a dB of loudness.
    let makeup = 0
    let slope = 1
    let previous: { makeup: number; lufs: number } | null = null
    for (let i = 0; i < 6; i++) {
      const r = await analyze(await renderChain(buffer, tp.plan, base + makeup, 'full'), false)
      const error = goal - r.lufs
      if (Math.abs(error) < 0.05) break
      if (previous && makeup !== previous.makeup) {
        slope = Math.min(1, Math.max(0.2, (r.lufs - previous.lufs) / (makeup - previous.makeup)))
      }
      previous = { makeup, lufs: r.lufs }
      makeup = Math.min(MAX_MAKEUP_DB, makeup + error / slope)
    }
    stage = { ...stage, makeup, makeupBase: base }
  } else {
    stage = { ...stage, makeup: 0, makeupBase: null }
  }
  if (useStore.getState().tracks.find(t => t.id === id)?.file === track.file) updateTrack(id, { stage })
}

// Until the first export the tone reference follows the tracks; once locked it only changes on request.
const syncProfile = () => {
  const { tracks, profile } = useStore.getState()
  if (profile?.locked) return false
  const next = profileFromTracks(tracks, false)
  if (profile && next && sameNames(profile.names, next.names)) return false
  if (!profile && !next) return false
  useStore.setState({ profile: next })
  return true
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

let measuring = false
let timer: ReturnType<typeof setTimeout> | null = null

const measureLoop = async () => {
  if (measuring) return
  measuring = true
  try {
    for (;;) {
      const state = useStore.getState()
      // Wait until everything is loaded: the tone-match reference depends on every track.
      if (state.tracks.some(t => t.status === 'loading')) break
      if (syncProfile()) continue
      const stale = state.tracks.filter(t => t.status === 'ready' && isStale(state, t))
      const next = stale.find(t => t.id === state.playingId) ?? stale.find(t => t.id === state.selectedId) ?? stale[0]
      if (!next) break
      await measureTrack(next.id)
    }
  } finally {
    measuring = false
  }
}

const scheduleMeasure = () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void measureLoop(), 250)
}

let lastTracks: Track[] | null = null
let lastGlobal: unknown = null
let lastProfile: unknown = null
useStore.subscribe(state => {
  if (state.tracks === lastTracks && state.global === lastGlobal && state.profile === lastProfile) return
  lastTracks = state.tracks
  lastGlobal = state.global
  lastProfile = state.profile
  scheduleMeasure()
})

// --- Export ----------------------------------------------------------------------------------------

const renderWav = async (id: string) => {
  lockProfile()
  let state = useStore.getState()
  let track = state.tracks.find(t => t.id === id)!
  if (isStale(state, track)) {
    await measureTrack(id)
    state = useStore.getState()
    track = state.tracks.find(t => t.id === id)!
  }
  const tp = planTrack(state, track)!
  const rendered = await renderChain(await getBuffer(track.id, track.file), tp.plan, tp.postGain, 'full')
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)]
  const wav = encodeWav24(channels, SAMPLE_RATE)
  // Verify what we're shipping.
  const r = await analyze(rendered, false)
  updateTrack(id, { output: { key: tp.plan.key, postGain: tp.postGain, lufs: r.lufs, truePeak: r.truePeak } })
  return wav
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
