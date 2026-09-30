import { create } from 'zustand'

import {
  referenceBands,
  DEFAULT_GLOBAL,
  makePlan,
  postGainFor,
  type GlobalSettings,
  type Plan,
  type RawAnalysis,
  type StageAnalysis,
} from './audio/plan'

export type Track = {
  id: string
  name: string
  file: File
  status: 'loading' | 'ready' | 'error'
  error: string | null
  duration: number | null
  peaks: Float32Array | null
  raw: RawAnalysis | null
  stage: StageAnalysis | null
  // Measured on the actual exported render, for the plan key it was rendered with.
  output: { key: string; postGain: number; lufs: number; truePeak: number } | null
}

// The set's typical spectral balance that tone match pulls every track toward. It follows the tracks
// until the first export, then stays locked (and saved) so later exports — even of a single replaced
// song in another session — match what was already exported.
export type SetProfile = { bands: number[]; names: string[]; locked: boolean }

export type Store = {
  tracks: Track[]
  profile: SetProfile | null
  global: GlobalSettings
  selectedId: string | null
  exporting: { done: number; total: number } | null
  playingId: string | null
  playing: boolean
  bypass: boolean
}

const STORAGE_KEY = 'rabot:settings'
type Persisted = { global: GlobalSettings; profile: SetProfile | null }

const loadPersisted = (): Persisted => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>
      return { global: { ...DEFAULT_GLOBAL, ...p.global }, profile: p.profile ?? null }
    }
  } catch {
    // Storage unavailable: fall back to defaults.
  }
  return { global: DEFAULT_GLOBAL, profile: null }
}

const persisted: Persisted = typeof window === 'undefined' ? { global: DEFAULT_GLOBAL, profile: null } : loadPersisted()

export const useStore = create<Store>(() => ({
  tracks: [],
  profile: persisted.profile?.locked ? persisted.profile : null,
  global: persisted.global,
  selectedId: null,
  exporting: null,
  playingId: null,
  playing: false,
  bypass: false,
}))

useStore.subscribe(state => {
  persisted.global = state.global
  persisted.profile = state.profile?.locked ? state.profile : null
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    // Ignore quota / privacy mode errors.
  }
})

export const updateTrack = (id: string, patch: Partial<Track>) =>
  useStore.setState(s => ({ tracks: s.tracks.map(t => (t.id === id ? { ...t, ...patch } : t)) }))

export const setGlobal = (patch: Partial<GlobalSettings>) =>
  useStore.setState(s => ({ global: { ...s.global, ...patch } }))

// --- Derived ---------------------------------------------------------------------------------------

export type TrackPlan = {
  plan: Plan
  postGain: number
  // Peak limiting in dB (null until measured).
  limiting: number | null
  makeupKey: string
  exact: boolean
}

type PlanState = Pick<Store, 'global' | 'profile'>

// Plans are recomputed for every row on every store change, so cache them per track object (tracks are
// immutable: an update creates a new object) for the current dials and profile.
const planCache = new WeakMap<Track, { global: GlobalSettings; profile: SetProfile | null; result: TrackPlan }>()

export const planTrack = (state: PlanState, track: Track): TrackPlan | null => {
  if (!track.raw) return null
  const cached = planCache.get(track)
  if (cached && cached.global === state.global && cached.profile === state.profile) return cached.result
  const plan = makePlan(state.global, track.raw, track.stage, state.profile?.bands ?? null)
  const g = postGainFor(state.global, plan, track.stage)
  const result = { plan, postGain: g.gain, limiting: g.limiting, makeupKey: g.makeupKey, exact: g.exact }
  planCache.set(track, { global: state.global, profile: state.profile, result })
  return result
}

export const isStale = (state: PlanState, track: Track) => {
  const p = planTrack(state, track)
  return p !== null && !p.exact
}

// Profile built from the measured tracks, or null when there aren't enough to compare.
export const profileFromTracks = (tracks: Track[], locked: boolean): SetProfile | null => {
  const measured = tracks.filter(t => t.stage)
  const bands = referenceBands(measured.map(t => t.stage!.bands))
  return bands ? { bands, names: measured.map(t => t.name), locked } : null
}

export const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((n, i) => n === b[i])
