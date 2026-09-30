// Orchestration: analyzing added files once, and exporting. The dials never trigger processing: the
// preview is real-time and its gains are predicted from each track's signature (see audio/model.ts).
// UI components only call into here and read the store.

import { Zip, ZipPassThrough } from 'fflate'

import { analyzeSignature, bufferChannels, CONCURRENCY, measure, renderExport } from './audio/analyzer'
import { renderChain } from './audio/chain'
import { renderOffline } from './audio/offline'
import { SAMPLE_RATE } from './audio/plan'
import { dropBuffer, getBuffer } from './buffers'
import { player } from './player'
import { planTrack, profileFromTracks, sameNames, updateTrack, useStore, type Track } from './store'

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
    signature: null,
    output: null,
  }))
  useStore.setState(s => ({ tracks: [...s.tracks, ...tracks], selectedId: s.selectedId ?? tracks[0]!.id }))
  schedule()
}

// Swap the source file of a track, keeping its position.
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
    signature: null,
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

// --- Analysis --------------------------------------------------------------------------------------
// Each added (or replaced) track is decoded and analyzed once into its signature. Up to CONCURRENCY
// tracks are analyzed in parallel: decoding and analysis each use their own threads.

const fileOf = (id: string) => useStore.getState().tracks.find(t => t.id === id)?.file

const analyzeTrack = async (id: string) => {
  const file = fileOf(id)
  if (!file) return
  try {
    const buffer = await getBuffer(id, file)
    if (fileOf(id) !== file) return
    const peaks = computePeaks(buffer)
    const signature = await analyzeSignature(bufferChannels(buffer), SAMPLE_RATE)
    if (fileOf(id) !== file) return
    if (!Number.isFinite(signature.lufs)) throw new Error('This file is silent')
    updateTrack(id, { status: 'ready', duration: buffer.duration, peaks, signature })
    syncProfile()
  } catch (e) {
    if (fileOf(id) === file) {
      updateTrack(id, { status: 'error', error: e instanceof Error ? e.message : 'Could not read this file' })
    }
  }
}

// Until the first export the tone reference follows the tracks; once locked it only changes on request.
const syncProfile = () => {
  const { tracks, profile } = useStore.getState()
  if (profile?.locked) return
  const next = profileFromTracks(tracks, false)
  if (!profile && !next) return
  if (profile && next && sameNames(profile.names, next.names)) return
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

const running = new Set<string>()

const pump = () => {
  syncProfile()
  const { tracks, playingId, selectedId } = useStore.getState()
  const waiting = tracks.filter(t => t.status === 'loading' && !running.has(t.id))
  const priority = (t: Track) => (t.id === playingId ? 0 : t.id === selectedId ? 1 : 2)
  waiting.sort((a, b) => priority(a) - priority(b))
  for (const t of waiting) {
    if (running.size >= CONCURRENCY) break
    running.add(t.id)
    void analyzeTrack(t.id).finally(() => {
      running.delete(t.id)
      schedule()
    })
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
const schedule = () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(pump, 50)
}

let lastTracks: Track[] | null = null
useStore.subscribe(state => {
  if (state.tracks === lastTracks) return
  lastTracks = state.tracks
  schedule()
})

// --- Export ----------------------------------------------------------------------------------------
// Only here is the full audio processed, in the worker pool (see audio/offline.ts): each track is
// rendered through the chain, measured, corrected to the loudness target and encoded there.

const renderWav = async (id: string) => {
  const state = useStore.getState()
  const track = state.tracks.find(t => t.id === id)!
  const tp = planTrack(state, track)!
  const buffer = await getBuffer(track.id, track.file)
  const result = await renderExport(bufferChannels(buffer), {
    plan: tp.plan,
    postGain: tp.postGain,
    target: state.global.target,
  })
  updateTrack(id, { output: { key: tp.key, lufs: result.lufs, truePeak: result.truePeak } })
  return result.wav
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
  lockProfile()
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
  lockProfile()
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
    // Render several tracks at once, but add them to the zip in order, holding at most CONCURRENCY
    // finished files in memory.
    const renders: Array<Promise<Uint8Array> | null> = tracks.map(() => null)
    const start = (i: number) => {
      if (i < tracks.length && !renders[i]) renders[i] = renderWav(tracks[i]!.id)
    }
    for (let i = 0; i < CONCURRENCY; i++) start(i)
    const used = new Set<string>()
    for (const [i, track] of tracks.entries()) {
      const wav = await renders[i]!
      renders[i] = null
      start(i + CONCURRENCY)
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
  Object.assign(window, {
    __rabot: { useStore, planTrack, renderChain, renderOffline, measure, getBuffer, exportAll, exportTrack, player },
  })
}
