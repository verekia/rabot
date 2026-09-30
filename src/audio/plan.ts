// Turns the dials + per-track analysis into concrete processing parameters. Pure and deterministic:
// the preview graph and the export render are both built from the same Plan.

import type { Biquad } from './loudness'
import type { Signature } from './model'
import { BANDS, biquadPower, MID_BAND, SPECTRUM_BINS, spectrumBinHz } from './spectrum'

export const SAMPLE_RATE = 44100
// Every track is first normalized to this loudness so the dynamics stage sees comparable levels:
// its threshold then sits a fixed distance above each track's own loudness, which makes it act only on
// tracks whose transients stick out (percussive, dynamic mixes) and leave dense ones alone.
export const REFERENCE_LUFS = -18
export const CEILING_DBTP = -1
export const HIGHPASS_HZ = 25
// Web Audio reads a high-pass Q in dB: −3.01 dB is a flat Butterworth response (Q 0.707). A linear 0.707
// here would mean Q ≈ 1.08, a resonant bump right above the cutoff.
export const HIGHPASS_Q_DB = 20 * Math.log10(Math.SQRT1_2)

export type GlobalSettings = { target: number; dynamics: number; toneMatch: number }

export const DEFAULT_GLOBAL: GlobalSettings = { target: -11, dynamics: 0, toneMatch: 0 }

// Tone match is disabled for now (likely to be dropped): the EQ stays flat whatever `toneMatch` says, and
// its dial is hidden. The code is kept so it can be turned back on by flipping this flag.
export const TONE_MATCH_ENABLED = false

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
  // Identity of the processing (used to tell whether an export matches the current dials).
  key: string
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const round = (v: number, step = 0.01) => Number((Math.round(v / step) * step).toFixed(4))

// --- Biquad magnitude (Web Audio spec / RBJ cookbook formulas) -------------------------------------

export const toneBiquad = (f: ToneFilter, gainDb: number, sampleRate = SAMPLE_RATE): Biquad => {
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
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

// Power response of the whole tone EQ at `hz` (linear).
const eqPower = (filters: Biquad[], hz: number) => {
  let p = 1
  for (const f of filters) p *= biquadPower(f, hz, SAMPLE_RATE)
  return p
}

const BAND_POINTS = BANDS.map(b => {
  const n = 24
  return Array.from({ length: n }, (_, i) => b.lo * (b.hi / b.lo) ** ((i + 0.5) / n))
})

// Power-averaged response of the whole EQ chain within each band, relative to the mid band.
export const bandResponse = (gains: number[]): number[] => {
  const filters = TONE_FILTERS.map((f, i) => toneBiquad(f, gains[i]!))
  const abs = BAND_POINTS.map(points => {
    let power = 0
    for (const hz of points) power += eqPower(filters, hz)
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
export const referenceBands = (bandsList: number[][]): number[] | null =>
  bandsList.length < 2 ? null : BANDS.map((_, b) => median(bandsList.map(bands => bands[b]!)))

// Loudness change (dB) of the tone EQ on a track, from its measured K-weighted spectrum. EQ is linear,
// so this matches rendering the EQ and re-measuring (to within a few hundredths of a dB).
// Each filter's power response per spectrum bin, cached by filter and (rounded) gain: tracks share them,
// so a dial change costs one response per distinct gain rather than one per track.
const responseCache = new Map<string, Float32Array>()
const filterResponse = (index: number, gainDb: number) => {
  const key = `${index}:${gainDb}`
  let response = responseCache.get(key)
  if (!response) {
    const biquad = toneBiquad(TONE_FILTERS[index]!, gainDb)
    response = new Float32Array(SPECTRUM_BINS)
    for (let k = 0; k < SPECTRUM_BINS; k++)
      response[k] = biquadPower(biquad, spectrumBinHz(k, SAMPLE_RATE), SAMPLE_RATE)
    if (responseCache.size > 256) responseCache.clear()
    responseCache.set(key, response)
  }
  return response
}

// The high-pass at the start of the chain, per the Web Audio formula (Q in dB).
export const highpassBiquad = (): Biquad => {
  const w0 = (2 * Math.PI * HIGHPASS_HZ) / SAMPLE_RATE
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * 10 ** (HIGHPASS_Q_DB / 20))
  const a0 = 1 + alpha
  return {
    b0: (1 + cos) / 2 / a0,
    b1: -(1 + cos) / a0,
    b2: (1 + cos) / 2 / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  }
}

// Loudness change (dB) of the fixed high-pass on a track, from its spectrum. Small (it cuts below the
// K-weighting's own low-frequency roll-off) but not zero on bass-heavy material.
const highpassCache = new WeakMap<Float32Array, number>()
export const highpassLoudnessDelta = (spectrum: Float32Array) => {
  const cached = highpassCache.get(spectrum)
  if (cached !== undefined) return cached
  const hp = highpassBiquad()
  let num = 0
  let den = 0
  for (let k = 0; k < spectrum.length; k++) {
    const s = spectrum[k]!
    if (s <= 0) continue
    den += s
    num += s * biquadPower(hp, spectrumBinHz(k, SAMPLE_RATE), SAMPLE_RATE)
  }
  const delta = den > 0 ? 10 * Math.log10(num / den) : 0
  highpassCache.set(spectrum, delta)
  return delta
}

export const eqLoudnessDelta = (gains: number[], spectrum: Float32Array) => {
  const responses = gains.map((g, i) => filterResponse(i, g))
  let num = 0
  let den = 0
  for (let k = 0; k < spectrum.length; k++) {
    const s = spectrum[k]!
    if (s <= 0) continue
    let p = s
    for (const r of responses) p *= r[k]!
    den += s
    num += p
  }
  return den > 0 ? 10 * Math.log10(num / den) : 0
}

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

export const makePlan = (global: GlobalSettings, sig: Signature, reference: number[] | null): Plan => {
  const preGain = round(REFERENCE_LUFS - sig.lufs)
  const comp = compressorFor(global.dynamics)
  const desired = BANDS.map((_, b) =>
    TONE_MATCH_ENABLED && reference && b !== MID_BAND
      ? clamp((reference[b]! - sig.bands[b]!) * global.toneMatch, -MAX_CORRECTION_DB, MAX_CORRECTION_DB)
      : 0,
  )
  const eq = solveEq(desired).map(g => round(g, 0.05))
  return { preGain, eq, comp, key: JSON.stringify({ preGain, eq, comp }) }
}
