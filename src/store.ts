import { create } from 'zustand'

import { simulateDynamics, solveGain, type DynamicsResult, type Signature } from './audio/model'
import {
  referenceBands,
  DEFAULT_GLOBAL,
  eqLoudnessDelta,
  highpassLoudnessDelta,
  makePlan,
  type GlobalSettings,
  type Plan,
} from './audio/plan'

export type Track = {
  id: string
  name: string
  file: File
  status: 'loading' | 'ready' | 'error'
  error: string | null
  duration: number | null
  peaks: Float32Array | null
  // Measured once when the track is added; everything the dials do is predicted from it.
  signature: Signature | null
  // Measured on the actual exported render, for the dials it was rendered with.
  output: { key: string; lufs: number; truePeak: number } | null
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

// v2: new defaults (Dynamics 0%, tone match off); older saved settings are ignored.
const STORAGE_KEY = 'rabot:settings:v2'
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
  // Predicted post gain that lands the track on the loudness target, and the peak limiting it takes.
  postGain: number
  limiting: number
  // Identity of plan + target, to tell whether an export matches the current dials.
  key: string
}

type PlanState = Pick<Store, 'global' | 'profile'>

// The dynamics simulation only depends on the pre gain and the compressor, so it's cached per signature
// and reused while Loudness and Tone match move.
const dynamicsCache = new WeakMap<Signature, { key: string; result: DynamicsResult }>()
const dynamicsFor = (sig: Signature, plan: Plan) => {
  const key = JSON.stringify([plan.preGain, plan.comp])
  const cached = dynamicsCache.get(sig)
  if (cached?.key === key) return cached.result
  const result = simulateDynamics(sig, plan.preGain, plan.comp)
  dynamicsCache.set(sig, { key, result })
  return result
}

// Plans are recomputed for every row on every store change, so cache them per track object (tracks are
// immutable: an update creates a new object) for the current dials and profile.
const planCache = new WeakMap<Track, { global: GlobalSettings; profile: SetProfile | null; result: TrackPlan }>()

export const planTrack = (state: PlanState, track: Track): TrackPlan | null => {
  const sig = track.signature
  if (!sig) return null
  const cached = planCache.get(track)
  if (cached && cached.global === state.global && cached.profile === state.profile) return cached.result
  const plan = makePlan(state.global, sig, state.profile?.bands ?? null)
  // Linear filters (high-pass + tone EQ) change loudness predictably, computed from the spectrum.
  const eqDelta = eqLoudnessDelta(plan.eq, sig.spectrum) + highpassLoudnessDelta(sig.spectrum)
  const { gain, limiting } = solveGain(dynamicsFor(sig, plan), sig, eqDelta, state.global.target)
  const result = { plan, postGain: gain, limiting, key: `${plan.key}|${state.global.target}` }
  planCache.set(track, { global: state.global, profile: state.profile, result })
  return result
}

// Profile built from the analyzed tracks, or null when there aren't enough to compare.
export const profileFromTracks = (tracks: Track[], locked: boolean): SetProfile | null => {
  const measured = tracks.filter(t => t.signature)
  const bands = referenceBands(measured.map(t => t.signature!.bands))
  return bands ? { bands, names: measured.map(t => t.name), locked } : null
}

export const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((n, i) => n === b[i])
