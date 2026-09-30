// ITU-R BS.1770-4 integrated loudness + 4x oversampled true peak.
// Pure functions on Float32Arrays so they run in a worker and in `bun test`.

export type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number }

// K-weighting stage 1 (head shelf) and stage 2 (RLB high-pass), derived for any sample rate from the
// analog parameters behind the 48 kHz coefficients printed in the standard.
export const kWeightingFilters = (sampleRate: number): [Biquad, Biquad] => {
  // Bilinear-transform form used by libebur128.
  const Vh = 10 ** (3.999843853973347 / 20)
  const Vb = Vh ** 0.4996667741545416
  const Q = 0.7071752369554196
  const K = Math.tan((Math.PI * 1681.974450955533) / sampleRate)
  const a0 = 1 + K / Q + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }

  const Qh = 0.5003270373238773
  const Kh = Math.tan((Math.PI * 38.13547087602444) / sampleRate)
  const a0h = 1 + Kh / Qh + Kh * Kh
  // The standard uses an unnormalized [1, -2, 1] numerator.
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (Kh * Kh - 1)) / a0h, a2: (1 - Kh / Qh + Kh * Kh) / a0h }

  return [shelf, highpass]
}

const filterInPlace = (x: Float32Array, f: Biquad): Float32Array => {
  const y = new Float32Array(x.length)
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2
    y[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return y
}

const powerToLufs = (p: number) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity)

// Integrated loudness in LUFS for a set of channels (L/R, weight 1 each).
export const integratedLoudness = (channels: Float32Array[], sampleRate: number): number => {
  const [shelf, hp] = kWeightingFilters(sampleRate)
  const weighted = channels.map(ch => filterInPlace(filterInPlace(ch, shelf), hp))
  const blockSize = Math.round(0.4 * sampleRate)
  const hop = Math.round(0.1 * sampleRate)
  const length = channels[0]?.length ?? 0
  if (length < blockSize) {
    // Too short to gate properly: plain mean square.
    let sum = 0
    for (const ch of weighted) {
      let s = 0
      for (let i = 0; i < ch.length; i++) s += ch[i]! * ch[i]!
      sum += s / Math.max(1, ch.length)
    }
    return powerToLufs(sum)
  }

  // Prefix sums of squares per channel make each 400 ms block O(1).
  const prefix = weighted.map(ch => {
    const p = new Float64Array(ch.length + 1)
    for (let i = 0; i < ch.length; i++) p[i + 1] = p[i]! + ch[i]! * ch[i]!
    return p
  })
  const blocks: number[] = []
  for (let start = 0; start + blockSize <= length; start += hop) {
    let z = 0
    for (const p of prefix) z += (p[start + blockSize]! - p[start]!) / blockSize
    blocks.push(z)
  }

  const absGated = blocks.filter(z => powerToLufs(z) > -70)
  if (absGated.length === 0) return -Infinity
  const absMean = absGated.reduce((a, b) => a + b, 0) / absGated.length
  const relThreshold = powerToLufs(absMean) - 10
  const relGated = absGated.filter(z => powerToLufs(z) > relThreshold)
  const relMean = relGated.reduce((a, b) => a + b, 0) / relGated.length
  return powerToLufs(relMean)
}

// 4x oversampling interpolator: windowed-sinc polyphase FIR, 12 taps per phase.
export const OVERSAMPLE = 4
export const TAPS_PER_PHASE = 12
export const interpolatorPhases = (): Float64Array[] => {
  const total = OVERSAMPLE * TAPS_PER_PHASE
  const center = total / 2
  const phases: Float64Array[] = []
  for (let phase = 0; phase < OVERSAMPLE; phase++) {
    const taps = new Float64Array(TAPS_PER_PHASE)
    for (let k = 0; k < TAPS_PER_PHASE; k++) {
      const n = k * OVERSAMPLE + phase
      const t = (n - center) / OVERSAMPLE
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / total) // Hann, centered on the sinc
      taps[k] = sinc * window
    }
    // Normalize each phase to unity DC gain.
    const sum = taps.reduce((a, b) => a + b, 0)
    for (let k = 0; k < TAPS_PER_PHASE; k++) taps[k] = taps[k]! / sum
    phases.push(taps)
  }
  return phases
}

// Max absolute value, including inter-sample peaks. Oversampling only runs around samples that
// could plausibly hold the maximum, which keeps this fast on full tracks.
export const truePeak = (channels: Float32Array[]): number => {
  const phases = interpolatorPhases()
  let samplePeak = 0
  for (const ch of channels) for (let i = 0; i < ch.length; i++) samplePeak = Math.max(samplePeak, Math.abs(ch[i]!))
  let peak = samplePeak
  // Inter-sample overs rarely exceed the sample peak by more than ~3 dB.
  const candidate = samplePeak * 0.7
  for (const ch of channels) {
    for (let i = TAPS_PER_PHASE; i < ch.length - TAPS_PER_PHASE; i++) {
      if (Math.abs(ch[i]!) < candidate && Math.abs(ch[i + 1]!) < candidate) continue
      for (let phase = 1; phase < OVERSAMPLE; phase++) {
        const taps = phases[phase]!
        let acc = 0
        // Tap k multiplies sample (i + 1 - k + TAPS_PER_PHASE / 2 - 1) so the phase lands between i and i+1.
        const base = i + TAPS_PER_PHASE / 2
        for (let k = 0; k < TAPS_PER_PHASE; k++) acc += taps[k]! * ch[base - k]!
        peak = Math.max(peak, Math.abs(acc))
      }
    }
  }
  return peak
}

export const toDb = (linear: number) => (linear > 0 ? 20 * Math.log10(linear) : -Infinity)
export const fromDb = (db: number) => 10 ** (db / 20)
