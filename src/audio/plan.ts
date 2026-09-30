// Turns the dials + per-track analysis into concrete processing parameters. Pure and deterministic:
// the preview graph and the export render are both built from the same Plan.

import { BANDS, MID_BAND } from './spectrum'

export const SAMPLE_RATE = 44100
// Every track is first normalized to this loudness so the dynamics stage sees comparable levels:
// its threshold then sits a fixed distance above each track's own loudness, which makes it act only on
// tracks whose transients stick out (percussive, dynamic mixes) and leave dense ones alone.
export const REFERENCE_LUFS = -18
export const CEILING_DBTP = -1
export const HIGHPASS_HZ = 25

export type GlobalSettings = { target: number; dynamics: number; toneMatch: number }

export const DEFAULT_GLOBAL: GlobalSettings = { target: -11, dynamics: 0.5, toneMatch: 0.5 }

export type RawAnalysis = { lufs: number; truePeak: number; bands: number[] }
// Loudness after dynamics + EQ (before the post gain). `makeup` compensates the loudness the limiter
// removes when it has real work to do, measured on a full render at post gain `makeupBase`.
export type StageAnalysis = { key: string; lufs: number; truePeak: number; makeup: number; makeupBase: number | null }

export type FilterType = 'lowshelf' | 'highshelf' | 'peaking'
export type ToneFilter = { type: FilterType; frequency: number; Q: number; band: number }

// One filter per corrected band (the mid band is the anchor).
export const TONE_FILTERS: ToneFilter[] = [
  { type: 'lowshelf', frequency: 120, Q: 0.7071, band: 0 },
  { type: 'peaking', frequency: 300, Q: 1, band: 1 },
  { type: 'peaking', frequency: 3500, Q: 0.9, band: 3 },
  { type: 'highshelf', frequency: 7000, Q: 0.7071, band: 4 },
]
const MAX_CORRECTION_DB = 6
const MAX_FILTER_DB = 9

export type CompressorParams = { threshold: number; ratio: number; knee: number; attack: number; release: number }

export type Plan = {
  preGain: number
  eq: number[]
  comp: CompressorParams
  // Identity of everything before the post gain; a stage analysis is valid only for a matching key.
  key: string
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number, step = 0.01) => Number((Math.round(v / step) * step).toFixed(4))

// --- Biquad magnitude (Web Audio spec / RBJ cookbook formulas) -------------------------------------

export const biquadMagnitudeDb = (f: ToneFilter, gainDb: number, hz: number, sampleRate = SAMPLE_RATE) => {
  const A = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * f.frequency) / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  if (f.type === 'peaking') {
    const alpha = sin / (2 * f.Q)
    b0 = 1 + alpha * A
    b1 = -2 * cos
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cos
    a2 = 1 - alpha / A
  } else {
    const alpha = (sin / 2) * Math.SQRT2
    const s = 2 * alpha * Math.sqrt(A)
    if (f.type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cos + s)
      b1 = 2 * A * (A - 1 - (A + 1) * cos)
      b2 = A * (A + 1 - (A - 1) * cos - s)
      a0 = A + 1 + (A - 1) * cos + s
      a1 = -2 * (A - 1 + (A + 1) * cos)
      a2 = A + 1 + (A - 1) * cos - s
    } else {
      b0 = A * (A + 1 + (A - 1) * cos + s)
      b1 = -2 * A * (A - 1 + (A + 1) * cos)
      b2 = A * (A + 1 + (A - 1) * cos - s)
      a0 = A + 1 - (A - 1) * cos + s
      a1 = 2 * (A - 1 - (A + 1) * cos)
      a2 = A + 1 - (A - 1) * cos - s
    }
  }
  const w = (2 * Math.PI * hz) / sampleRate
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const numRe = b0 + b1 * c1 + b2 * c2
  const numIm = -(b1 * s1 + b2 * s2)
  const denRe = a0 + a1 * c1 + a2 * c2
  const denIm = -(a1 * s1 + a2 * s2)
  return 10 * Math.log10((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm))
}

const BAND_POINTS = BANDS.map(b => {
  const n = 24
  return Array.from({ length: n }, (_, i) => b.lo * (b.hi / b.lo) ** ((i + 0.5) / n))
})

// Power-averaged response of the whole EQ chain within each band, relative to the mid band.
export const bandResponse = (gains: number[]): number[] => {
  const abs = BAND_POINTS.map(points => {
    let power = 0
    for (const hz of points) {
      let db = 0
      TONE_FILTERS.forEach((f, i) => (db += biquadMagnitudeDb(f, gains[i]!, hz)))
      power += 10 ** (db / 10)
    }
    return 10 * Math.log10(power / points.length)
  })
  return abs.map(v => v - abs[MID_BAND]!)
}

// Find filter gains whose combined band response matches the desired per-band change.
export const solveEq = (desired: number[]): number[] => {
  const gains = TONE_FILTERS.map(f => desired[f.band]!)
  for (let iter = 0; iter < 16; iter++) {
    const achieved = bandResponse(gains)
    TONE_FILTERS.forEach((f, i) => {
      gains[i] = clamp(gains[i]! + 0.8 * (desired[f.band]! - achieved[f.band]!), -MAX_FILTER_DB, MAX_FILTER_DB)
    })
  }
  return gains
}

const median = (values: number[]) => {
  const s = values.toSorted((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

// The playlist's typical spectral balance (per-band median), or null when there is nothing to match.
export const referenceBands = (analyses: RawAnalysis[]): number[] | null =>
  analyses.length < 2 ? null : BANDS.map((_, b) => median(analyses.map(a => a.bands[b]!)))

// --- Dynamics --------------------------------------------------------------------------------------

export const compressorFor = (amount: number): CompressorParams => ({
  // Distance between the track's loudness and where compression starts: 14 dB → 6 dB. A typical
  // mastered track (peaks ~10 dB above its loudness) is barely touched at 50%; a dynamic, drum-heavy mix
  // is pulled in toward it.
  threshold: REFERENCE_LUFS + 14 - 8 * amount,
  ratio: 1 + 3 * amount,
  knee: 6,
  // With 3 ms of lookahead, fast enough to shave drum attacks while keeping bass waveforms intact.
  attack: 0.0015,
  release: 0.12,
})

// --- Plan ------------------------------------------------------------------------------------------

export const makePlan = (global: GlobalSettings, raw: RawAnalysis, reference: number[] | null): Plan => {
  const preGain = REFERENCE_LUFS - raw.lufs
  const desired = BANDS.map((_, b) =>
    reference && b !== MID_BAND
      ? clamp((reference[b]! - raw.bands[b]!) * global.toneMatch, -MAX_CORRECTION_DB, MAX_CORRECTION_DB)
      : 0,
  )
  const eq = solveEq(desired)
  const comp = compressorFor(global.dynamics)
  const rounded = { preGain: round(preGain), eq: eq.map(g => round(g, 0.05)), comp }
  return { ...rounded, key: JSON.stringify(rounded) }
}

// Limiting below this doesn't measurably lower the loudness, so no makeup render is needed.
export const MAKEUP_THRESHOLD_DB = 0.5
export const MAX_MAKEUP_DB = 6

export const baseGainFor = (global: GlobalSettings, stage?: StageAnalysis) =>
  global.target - (stage?.lufs ?? REFERENCE_LUFS)

// Gain after the dynamics + EQ stage. Exact once measured for this plan and gain; until then the previous
// measurement (or the reference level) is a close estimate, so the preview never jumps much.
export const postGainFor = (global: GlobalSettings, plan: Plan, stage?: StageAnalysis) => {
  const base = baseGainFor(global, stage)
  const makeupValid = stage
    ? stage.makeupBase !== null
      ? Math.abs(stage.makeupBase - base) < 0.005
      : peakLimiting(base, stage) <= MAKEUP_THRESHOLD_DB
    : false
  return { gain: base + (stage?.makeup ?? 0), exact: stage?.key === plan.key && makeupValid }
}

// How much the final limiter will pull the loudest peak down, in dB (0 = untouched).
export const peakLimiting = (postGain: number, stage: StageAnalysis) =>
  Math.max(0, stage.truePeak + postGain - CEILING_DBTP)
