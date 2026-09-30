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

export type TrackPlan = { plan: Plan; postGain: number; exact: boolean }

type PlanState = Pick<Store, 'global' | 'profile'>

export const planTrack = (state: PlanState, track: Track): TrackPlan | null => {
  if (!track.raw) return null
  const plan = makePlan(state.global, track.raw, state.profile?.bands ?? null)
  const { gain, exact } = postGainFor(state.global, plan, track.stage ?? undefined)
  return { plan, postGain: gain, exact }
}

export const isStale = (state: PlanState, track: Track) => {
  const p = planTrack(state, track)
  return p !== null && !p.exact
}

// Profile built from the current tracks, or null when there aren't enough to compare.
export const profileFromTracks = (tracks: Track[], locked: boolean): SetProfile | null => {
  const ready = tracks.filter(t => t.raw)
  const bands = referenceBands(ready.map(t => t.raw!))
  return bands ? { bands, names: ready.map(t => t.name), locked } : null
}

export const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((n, i) => n === b[i])
