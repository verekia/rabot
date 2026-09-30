import { describe, expect, test } from 'bun:test'

import { fromDb, integratedLoudness, kWeightingFilters, toDb, truePeak } from './loudness'
import { bandResponse, makePlan, referenceBands, solveEq, DEFAULT_GLOBAL } from './plan'
import { bandLevels } from './spectrum'
import { encodeWav24 } from './wav'

const sine = (hz: number, amplitude: number, seconds: number, sampleRate: number, phase = 0) =>
  Float32Array.from(
    { length: Math.round(seconds * sampleRate) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate + phase),
  )

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
    const levels = bandLevels([mix, mix], 44100)
    expect(levels[0]!).toBeGreaterThan(15)
    expect(levels[2]!).toBe(0)
  })

  test('EQ solver reaches the requested band changes', () => {
    const desired = [3, -2, 0, 2, -3]
    const achieved = bandResponse(solveEq(desired))
    for (const b of [0, 1, 3, 4]) expect(achieved[b]!).toBeCloseTo(desired[b]!, 0)
  })

  test('tracks move toward the playlist median', () => {
    const analyses = [
      { lufs: -14, truePeak: -1, bands: [6, 0, 0, -6, -12] },
      { lufs: -14, truePeak: -1, bands: [0, 0, 0, -6, -12] },
      { lufs: -14, truePeak: -1, bands: [0, 0, 0, -6, -12] },
    ]
    const ref = referenceBands(analyses)!
    const plan = makePlan({ ...DEFAULT_GLOBAL, toneMatch: 1 }, analyses[0]!, ref)
    expect(bandResponse(plan.eq)[0]!).toBeCloseTo(-6, 0)
    expect(plan.preGain).toBeCloseTo(-4)
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
