// Predicts what the processing chain does to a track from its signature, without rendering it.
//
// A track's signature is measured once when it's added: its loudness, spectrum, and a 10 ms level
// profile (K-weighted power + sample peak per segment). The dynamics stage and the limiter are then
// simulated on that profile with the same gain curves and time constants as the audio worklets: about
// 20k segments instead of ~10M samples per channel, so every dial change is instant. Export still
// renders the real audio, measures it, and corrects the gain, so exported files are exact.

import { loudnessFromSegments, SEGMENT_SECONDS, toDb } from './loudness'
import { CEILING_DBTP, type CompressorParams } from './plan'

export type Signature = {
  lufs: number
  truePeak: number
  samplePeak: number
  // Spectral balance per band (relative to mids) and K-weighted spectrum, for tone match.
  bands: number[]
  spectrum: Float32Array
  // Per 10 ms segment: K-weighted power (mean square, summed over channels) and sample peak.
  power: Float32Array
  peak: Float32Array
}

const LIMITER_RELEASE = 0.1
const MAX_MAKEUP_DB = 6

export type DynamicsResult = {
  // Per segment after pre gain + dynamics: power (linear) and peak (dBFS).
  power: Float32Array
  peakDb: Float32Array
  lufs: number
  maxPeakDb: number
}

// Pre gain, then the dynamics processor's static curve with instant (lookahead) attack and exponential
// release, evaluated per segment on its peak.
export const simulateDynamics = (sig: Signature, preGain: number, comp: CompressorParams): DynamicsResult => {
  const n = sig.power.length
  const power = new Float32Array(n)
  const peakDb = new Float32Array(n)
  const { threshold: T, ratio: R, knee: W } = comp
  const slope = 1 / R - 1
  const release = Math.exp(-SEGMENT_SECONDS / comp.release)
  const preLin = 10 ** (preGain / 10)
  let gain = 0
  let maxPeakDb = -Infinity
  for (let i = 0; i < n; i++) {
    const level = toDb(Math.max(sig.peak[i]!, 1e-9)) + preGain
    let target = 0
    if (R > 1) {
      const over = level - T
      if (2 * over > W) target = slope * over
      else if (W > 0 && 2 * over > -W) target = (slope * (over + W / 2) ** 2) / (2 * W)
    }
    const released = gain * release
    gain = target < released ? target : released
    power[i] = sig.power[i]! * preLin * 10 ** (gain / 10)
    peakDb[i] = level + gain
    if (peakDb[i]! > maxPeakDb) maxPeakDb = peakDb[i]!
  }
  return { power, peakDb, lufs: loudnessFromSegments(power), maxPeakDb }
}

// Output loudness and peak limiting after a gain offset (EQ loudness change + post gain) and the limiter.
const predictOutput = (d: DynamicsResult, offset: number, truePeakMargin: number) => {
  if (d.maxPeakDb + offset + truePeakMargin <= CEILING_DBTP) return { lufs: d.lufs + offset, limiting: 0 }
  const out = new Float32Array(d.power.length)
  const release = Math.exp(-SEGMENT_SECONDS / LIMITER_RELEASE)
  let reduction = 0
  let limiting = 0
  for (let i = 0; i < out.length; i++) {
    const required = Math.max(0, d.peakDb[i]! + offset + truePeakMargin - CEILING_DBTP)
    if (required > limiting) limiting = required
    reduction = Math.max(required, reduction * release)
    out[i] = d.power[i]! * 10 ** ((offset - reduction) / 10)
  }
  return { lufs: loudnessFromSegments(out), limiting }
}

// Post gain that lands the output on `target` LUFS, and the peak limiting it takes. Without limiting the
// loudness is linear in the gain; with it, a few secant steps (each dB of gain adds less than a dB).
export const solveGain = (d: DynamicsResult, sig: Signature, eqDelta: number, target: number) => {
  // Inter-sample peaks sit above the sample peaks by roughly the track's own true-peak margin.
  const margin = Math.max(0, sig.truePeak - toDb(sig.samplePeak))
  let gain = target - d.lufs - eqDelta
  let result = predictOutput(d, eqDelta + gain, margin)
  if (result.limiting === 0) return { gain, limiting: 0 }
  const base = gain
  let previous: { gain: number; lufs: number } | null = null
  for (let i = 0; i < 6; i++) {
    const error = target - result.lufs
    if (Math.abs(error) < 0.02) break
    const slope =
      previous && gain !== previous.gain
        ? Math.min(1, Math.max(0.2, (result.lufs - previous.lufs) / (gain - previous.gain)))
        : 1
    previous = { gain, lufs: result.lufs }
    gain = Math.min(base + MAX_MAKEUP_DB, gain + error / slope)
    result = predictOutput(d, eqDelta + gain, margin)
  }
  return { gain, limiting: result.limiting }
}
