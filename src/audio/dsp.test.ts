import { describe, expect, test } from 'bun:test'

import { fromDb, integratedLoudness, kWeightingFilters, toDb, truePeak, type Biquad } from './loudness'
import {
  bandResponse,
  DEFAULT_GLOBAL,
  eqLoudnessDelta,
  makePlan,
  referenceBands,
  solveEq,
  TONE_FILTERS,
  toneBiquad,
  type StageAnalysis,
} from './plan'
import { analyzeSpectrum, SPECTRUM_BINS } from './spectrum'
import { encodeWav24 } from './wav'

const sine = (hz: number, amplitude: number, seconds: number, sampleRate: number, phase = 0) =>
  Float32Array.from(
    { length: Math.round(seconds * sampleRate) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase),
  )

// Direct-form biquad, same coefficients the Web Audio BiquadFilterNode uses.
const filter = (x: Float32Array, f: Biquad) => {
  const y = new Float32Array(x.length)
  let x1 = 0,
    x2 = 0,
    y1 = 0,
    y2 = 0
  for (let i = 0; i < x.length; i++) {
    const y0 = f.b0 * x[i]! + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    y[i] = y0
    x2 = x1
    x1 = x[i]!
    y2 = y1
    y1 = y0
  }
  return y
}

describe('loudness', () => {
  test('K-weighting matches the BS.1770 coefficients at 48 kHz', () => {
    const [shelf, hp] = kWeightingFilters(48000)
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 8)
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 8)
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 8)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 8)
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 8)
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 8)
    expect(hp.a2).toBeCloseTo(0.99007225036621, 8)
  })

  test('EBU Tech 3341: 1 kHz stereo sine at -23 dBFS reads -23 LUFS', () => {
    const s = sine(1000, fromDb(-23), 10, 44100)
    expect(integratedLoudness([s, s], 44100)).toBeCloseTo(-23, 1)
  })

  test('relative gate ignores a quiet section', () => {
    const loud = sine(1000, fromDb(-20), 5, 44100)
    const quiet = sine(1000, fromDb(-50), 20, 44100)
    const s = new Float32Array(loud.length + quiet.length)
    s.set(loud)
    s.set(quiet, loud.length)
    expect(integratedLoudness([s, s], 44100)).toBeCloseTo(-20, 0)
  })

  test('true peak catches inter-sample overs', () => {
    // fs/4 at 45° phase: every sample lands at ±0.707, the waveform peaks at 1.
    const s = sine(11025, 1, 1, 44100, Math.PI / 4)
    const samplePeak = Math.max(...s.map(Math.abs))
    expect(toDb(samplePeak)).toBeCloseTo(-3, 0)
    expect(toDb(truePeak([s]))).toBeCloseTo(0, 0)
  })
})

describe('tone match', () => {
  test('band levels see a bass-heavy signal as bass-heavy', () => {
    const bass = sine(80, 0.5, 3, 44100)
    const mid = sine(1000, 0.05, 3, 44100)
    const mix = bass.map((v, i) => v + mid[i]!)
    const levels = analyzeSpectrum([mix, mix], 44100).bands
    expect(levels[0]!).toBeGreaterThan(15)
    expect(levels[2]!).toBe(0)
  })

  test('EQ solver reaches the requested band changes', () => {
    const desired = [3, -2, 0, 2, -3]
    const achieved = bandResponse(solveEq(desired))
    for (const b of [0, 1, 3, 4]) expect(achieved[b]!).toBeCloseTo(desired[b]!, 0)
  })

  test('tracks move toward the playlist median', () => {
    const bandsList = [
      [6, 0, 0, -6, -12],
      [0, 0, 0, -6, -12],
      [0, 0, 0, -6, -12],
    ]
    const ref = referenceBands(bandsList)!
    const stage: StageAnalysis = {
      key: '',
      lufs: -18,
      truePeak: -8,
      bands: bandsList[0]!,
      spectrum: new Float32Array(SPECTRUM_BINS),
      makeup: 0,
      makeupFor: null,
    }
    const plan = makePlan({ ...DEFAULT_GLOBAL, toneMatch: 1 }, { lufs: -14, truePeak: -1 }, stage, ref)
    expect(bandResponse(plan.eq)[0]!).toBeCloseTo(-6, 0)
    expect(plan.preGain).toBeCloseTo(-4)
  })

  test('EQ loudness change from the spectrum matches filtering and re-measuring', () => {
    // Realistic stereo: independent pink-ish noise per channel (wide content) plus a shared bass sine
    // (centered, like a kick or bass guitar). Loudness sums channel powers, so a mono-sum spectrum would
    // over-weight the bass here.
    const n = 44100 * 10
    let seed = 1
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
    const channel = () => {
      const x = new Float32Array(n)
      let lp = 0
      for (let i = 0; i < n; i++) {
        lp = 0.97 * lp + 0.03 * random()
        x[i] = 0.3 * lp + 0.05 * random() + 0.15 * Math.sin((2 * Math.PI * 70 * i) / 44100)
      }
      return x
    }
    const stereo = [channel(), channel()]
    const { spectrum } = analyzeSpectrum(stereo, 44100)
    for (const gains of [
      [4, -2, 3, -4],
      [-6, 2, -3, 5],
    ]) {
      const eqd = stereo.map(ch => {
        let y = ch
        TONE_FILTERS.forEach((f, i) => (y = filter(y, toneBiquad(f, gains[i]!))))
        return y
      })
      const actual = integratedLoudness(eqd, 44100) - integratedLoudness(stereo, 44100)
      expect(Math.abs(eqLoudnessDelta(gains, spectrum) - actual)).toBeLessThan(0.05)
    }
  })
})

describe('wav', () => {
  test('writes a valid 24-bit stereo header and samples', () => {
    const out = encodeWav24([new Float32Array([0, 1]), new Float32Array([-1, 0.5])], 44100)
    const view = new DataView(out.buffer)
    expect(String.fromCharCode(...out.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint16(34, true)).toBe(24)
    expect(view.getUint32(40, true)).toBe(12)
    const s = (o: number) => ((out[o]! | (out[o + 1]! << 8) | (out[o + 2]! << 16)) << 8) >> 8
    expect(s(44 + 3)).toBe(-0x7fffff)
    expect(s(44 + 6)).toBe(0x7fffff)
  })
})
