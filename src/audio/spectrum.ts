// Long-term spectrum of a track, measured on the output of the dynamics stage. One pass gives both:
// - the spectral balance in the bands the tone-match EQ corrects, and
// - a K-weighted, loudness-gated power spectrum, from which the loudness change of any EQ setting is
//   computed exactly (EQ is linear), so changing the tone EQ never needs a re-render.

import { kWeightingFilters, type Biquad } from './loudness'

// Band edges in Hz. Levels are reported relative to the MID band (vocals / most instruments),
// which is the anchor the EQ never touches.
export const BANDS = [
  { name: 'Bass', lo: 20, hi: 150 },
  { name: 'Low mid', lo: 150, hi: 500 },
  { name: 'Mid', lo: 500, hi: 2000 },
  { name: 'Presence', lo: 2000, hi: 6000 },
  { name: 'Air', lo: 6000, hi: 16000 },
] as const
export const MID_BAND = 2

// 8192 points (5.4 Hz bins at 44.1 kHz): fine enough in the bass that evaluating an EQ at each bin's
// frequency predicts its loudness change to within ~0.01 dB.
const FFT_SIZE = 8192
export const SPECTRUM_BINS = FFT_SIZE / 2
export const spectrumBinHz = (k: number, sampleRate: number) => (k * sampleRate) / FFT_SIZE
// FFT frames are grouped into ~370 ms blocks for BS.1770-style gating.
const FRAMES_PER_BLOCK = 2

const fftInPlace = (re: Float64Array, im: Float64Array) => {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b]! * cr - im[b]! * ci
        const ti = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

// Power response of a biquad at `hz` (linear).
export const biquadPower = (f: Biquad, hz: number, sampleRate: number) => {
  const w = (2 * Math.PI * hz) / sampleRate
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const numRe = f.b0 + f.b1 * c1 + f.b2 * c2
  const numIm = -(f.b1 * s1 + f.b2 * s2)
  const denRe = 1 + f.a1 * c1 + f.a2 * c2
  const denIm = -(f.a1 * s1 + f.a2 * s2)
  return (numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm)
}

export type SpectrumAnalysis = {
  // Band levels in dB relative to the mid band.
  bands: number[]
  // K-weighted, gated power per FFT bin (relative units).
  spectrum: Float32Array
}

export const analyzeSpectrum = (channels: Float32Array[], sampleRate: number): SpectrumAnalysis => {
  const length = channels[0]?.length ?? 0
  const half = FFT_SIZE / 2
  const window = new Float64Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE)

  // Per FFT bin: which band it feeds, and its K-weighting power.
  const [shelf, hp] = kWeightingFilters(sampleRate)
  const bandOf = new Int8Array(half).fill(-1)
  const kWeight = new Float64Array(half)
  for (let k = 1; k < half; k++) {
    const hz = spectrumBinHz(k, sampleRate)
    bandOf[k] = BANDS.findIndex(b => hz >= b.lo && hz < b.hi)
    kWeight[k] = biquadPower(shelf, hz, sampleRate) * biquadPower(hp, hz, sampleRate)
  }

  // Accumulate each block's band power, K-weighted per-bin power and K-weighted total.
  type Block = { bands: Float64Array; bins: Float64Array; loudness: number }
  const blocks: Block[] = []
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  let block: Block | null = null
  let framesInBlock = 0
  for (let start = 0; start + FFT_SIZE <= length; start += FFT_SIZE) {
    // Left in the real part, right in the imaginary part: one complex FFT gives both channels' spectra.
    // Loudness sums the channels' powers (it doesn't mono-sum them), so the spectrum must too.
    const left = channels[0]!
    const right = channels[1] ?? null
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = left[start + i]! * window[i]!
      im[i] = right ? right[start + i]! * window[i]! : 0
    }
    fftInPlace(re, im)
    block ??= { bands: new Float64Array(BANDS.length), bins: new Float64Array(half), loudness: 0 }
    for (let k = 1; k < half; k++) {
      // |L_k|² + |R_k|² = (|X_k|² + |X_(N-k)|²) / 2
      const m = FFT_SIZE - k
      const p = (re[k]! * re[k]! + im[k]! * im[k]! + re[m]! * re[m]! + im[m]! * im[m]!) / 2
      const b = bandOf[k]!
      if (b >= 0) block.bands[b] = block.bands[b]! + p
      const weighted = p * kWeight[k]!
      block.loudness += weighted
      block.bins[k] = block.bins[k]! + weighted
    }
    if (++framesInBlock === FRAMES_PER_BLOCK) {
      blocks.push(block)
      block = null
      framesInBlock = 0
    }
  }
  if (block) blocks.push(block)
  if (blocks.length === 0) return { bands: BANDS.map(() => 0), spectrum: new Float32Array(half) }

  // Relative gate like BS.1770: drop blocks more than 10 dB below the mean (silence, fades, intros).
  const mean = blocks.reduce((a, b) => a + b.loudness, 0) / blocks.length
  const gated = blocks.filter(b => b.loudness > mean * 0.1)
  const bandSums = new Float64Array(BANDS.length)
  const spectrum = new Float32Array(half)
  for (const b of gated) {
    for (let i = 0; i < BANDS.length; i++) bandSums[i] = bandSums[i]! + b.bands[i]!
    for (let i = 0; i < half; i++) spectrum[i] = spectrum[i]! + b.bins[i]!
  }
  const mid = Math.max(bandSums[MID_BAND]!, 1e-20)
  const bands = Array.from(bandSums, s => 10 * Math.log10(Math.max(s, 1e-20) / mid))
  return { bands, spectrum }
}
