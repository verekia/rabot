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

export const kWeight = (channels: Float32Array[], sampleRate: number) => {
  const [shelf, hp] = kWeightingFilters(sampleRate)
  return channels.map(ch => filterInPlace(filterInPlace(ch, shelf), hp))
}

// BS.1770 gating over 400 ms block powers (K-weighted mean square, summed over channels).
export const gatedLoudness = (blocks: ArrayLike<number>) => {
  let absSum = 0
  let absCount = 0
  for (let i = 0; i < blocks.length; i++) {
    if (powerToLufs(blocks[i]!) > -70) {
      absSum += blocks[i]!
      absCount++
    }
  }
  if (absCount === 0) return -Infinity
  const relThreshold = powerToLufs(absSum / absCount) - 10
  let relSum = 0
  let relCount = 0
  for (let i = 0; i < blocks.length; i++) {
    if (powerToLufs(blocks[i]!) > -70 && powerToLufs(blocks[i]!) > relThreshold) {
      relSum += blocks[i]!
      relCount++
    }
  }
  return powerToLufs(relSum / relCount)
}

// Integrated loudness in LUFS for a set of channels (L/R, weight 1 each).
export const integratedLoudness = (channels: Float32Array[], sampleRate: number): number =>
  integratedLoudnessWeighted(kWeight(channels, sampleRate), sampleRate)

export const integratedLoudnessWeighted = (weighted: Float32Array[], sampleRate: number): number => {
  const blockSize = Math.round(0.4 * sampleRate)
  const hop = Math.round(0.1 * sampleRate)
  const length = weighted[0]?.length ?? 0
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
  return gatedLoudness(blocks)
}

// 10 ms segments: 400 ms blocks are exactly 40 segments and the 100 ms hop exactly 10, so loudness
// computed from segment powers matches BS.1770 (at 44.1 kHz).
export const SEGMENT_SECONDS = 0.01
export const SEGMENTS_PER_BLOCK = 40
export const SEGMENTS_PER_HOP = 10

// Per segment: K-weighted mean square summed over channels, and the sample peak over channels.
export const segmentLevels = (channels: Float32Array[], weighted: Float32Array[], sampleRate: number) => {
  const size = Math.round(SEGMENT_SECONDS * sampleRate)
  const count = Math.floor((channels[0]?.length ?? 0) / size)
  const power = new Float32Array(count)
  const peak = new Float32Array(count)
  for (let s = 0; s < count; s++) {
    let p = 0
    let m = 0
    for (let c = 0; c < channels.length; c++) {
      const w = weighted[c]!
      const x = channels[c]!
      let sq = 0
      for (let i = s * size; i < (s + 1) * size; i++) {
        sq += w[i]! * w[i]!
        const a = x[i]! < 0 ? -x[i]! : x[i]!
        if (a > m) m = a
      }
      p += sq / size
    }
    power[s] = p
    peak[s] = m
  }
  return { power, peak }
}

// Integrated loudness from segment powers (same gating as `integratedLoudness`).
export const loudnessFromSegments = (power: ArrayLike<number>) => {
  const prefix = new Float64Array(power.length + 1)
  for (let i = 0; i < power.length; i++) prefix[i + 1] = prefix[i]! + power[i]!
  const blocks: number[] = []
  for (let start = 0; start + SEGMENTS_PER_BLOCK <= power.length; start += SEGMENTS_PER_HOP) {
    blocks.push((prefix[start + SEGMENTS_PER_BLOCK]! - prefix[start]!) / SEGMENTS_PER_BLOCK)
  }
  if (blocks.length === 0) {
    const mean = power.length ? prefix[power.length]! / power.length : 0
    return powerToLufs(mean)
  }
  return gatedLoudness(blocks)
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
