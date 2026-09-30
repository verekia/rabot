// Long-term spectral balance, measured in the same bands the tone-match EQ corrects.

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

const FFT_SIZE = 4096

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

// Returns each band's level in dB relative to the mid band.
export const bandLevels = (channels: Float32Array[], sampleRate: number): number[] => {
  const length = channels[0]?.length ?? 0
  const window = new Float64Array(FFT_SIZE)
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE)
  const binHz = sampleRate / FFT_SIZE
  const bandOfBin = new Int8Array(FFT_SIZE / 2).fill(-1)
  for (let k = 1; k < FFT_SIZE / 2; k++) {
    const f = k * binHz
    const band = BANDS.findIndex(b => f >= b.lo && f < b.hi)
    bandOfBin[k] = band
  }

  const frames: { total: number; bands: Float64Array }[] = []
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)
  for (let start = 0; start + FFT_SIZE <= length; start += FFT_SIZE) {
    for (let i = 0; i < FFT_SIZE; i++) {
      let s = 0
      for (const ch of channels) s += ch[start + i]!
      re[i] = (s / channels.length) * window[i]!
      im[i] = 0
    }
    fftInPlace(re, im)
    const bands = new Float64Array(BANDS.length)
    let total = 0
    for (let k = 1; k < FFT_SIZE / 2; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!
      total += p
      const b = bandOfBin[k]!
      if (b >= 0) bands[b] = bands[b]! + p
    }
    frames.push({ total, bands })
  }
  if (frames.length === 0) return BANDS.map(() => 0)

  // Gate out silence, intros and fade tails: keep frames within 30 dB of the mean frame power.
  const mean = frames.reduce((a, f) => a + f.total, 0) / frames.length
  const sums = new Float64Array(BANDS.length)
  for (const f of frames) {
    if (f.total < mean * 1e-3) continue
    for (let b = 0; b < BANDS.length; b++) sums[b] = sums[b]! + f.bands[b]!
  }
  const mid = Math.max(sums[MID_BAND]!, 1e-20)
  return Array.from(sums, s => 10 * Math.log10(Math.max(s, 1e-20) / mid))
}
