// AudioWorklet processors for the chain: a lookahead peak compressor (transient taming) and a
// lookahead true-peak limiter.

// --- Dynamics --------------------------------------------------------------------------------------
// Feed-forward, stereo-linked peak compressor with a soft knee and 3 ms of lookahead. The threshold is
// set relative to the track's loudness, so it only reduces transients that stick out above the body of
// the mix — the drums of a percussive mix — and leaves already-dense tracks alone. No makeup gain: the
// loudness stage after it handles level.

class Dynamics extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: 0, minValue: -100, maxValue: 20, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 1, minValue: 1, maxValue: 20, automationRate: 'k-rate' },
      { name: 'knee', defaultValue: 6, minValue: 0, maxValue: 24, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.002, minValue: 0.0001, maxValue: 1, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0.001, maxValue: 2, automationRate: 'k-rate' },
    ]
  }

  constructor(options) {
    super()
    const opts = options.processorOptions ?? {}
    this.report = Boolean(opts.report)
    // Returning false from process() lets a discarded node be garbage collected; otherwise it keeps
    // running on silence forever.
    this.alive = true
    this.port.onmessage = e => {
      if (e.data?.stop) this.alive = false
    }
    this.delay = Math.max(1, Math.round((opts.lookahead ?? 0.003) * sampleRate))
    this.lines = [new Float32Array(this.delay + 1), new Float32Array(this.delay + 1)]
    this.pos = 0
    // Target gain is held at its minimum over the lookahead window, so even a single-sample spike gets
    // the full attack time to be caught before it reaches the output.
    this.holdRing = new Float64Array(this.delay + 1)
    this.holdMin = 0
    this.holdAge = 0
    this.gainDb = 0
    this.maxReduction = 0
    this.reportCounter = 0
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    const output = outputs[0]
    if (!this.alive) return false
    if (!output || output.length === 0) return true
    const frames = output[0].length
    const T = parameters.threshold[0]
    const R = parameters.ratio[0]
    const W = parameters.knee[0]
    const slope = 1 / R - 1
    const att = Math.exp(-1 / (parameters.attack[0] * sampleRate))
    const rel = Math.exp(-1 / (parameters.release[0] * sampleRate))
    const l = input && input.length > 0 ? input[0] : null
    const r = input && input.length > 1 ? input[1] : l
    const size = this.delay + 1
    // Below the start of the knee the gain computer is 0, so most samples skip the log entirely.
    const kneeStart = R > 1 ? 10 ** ((T - W / 2) / 20) : Infinity
    // State lives in locals during the loop (much faster than property access per sample).
    const ring = this.holdRing
    const lineL = this.lines[0]
    const lineR = this.lines[1]
    const outL = output[0]
    const outR = output.length > 1 ? output[1] : null
    let pos = this.pos
    let holdMin = this.holdMin
    let holdAge = this.holdAge
    let gainDb = this.gainDb
    let maxReduction = this.maxReduction
    for (let i = 0; i < frames; i++) {
      const xl = l ? l[i] : 0
      const xr = r ? r[i] : 0
      const al = xl < 0 ? -xl : xl
      const ar = xr < 0 ? -xr : xr
      const peak = al > ar ? al : ar
      let target = 0
      if (peak > kneeStart) {
        const over = 20 * Math.log10(peak) - T
        target = 2 * over > W ? slope * over : (slope * (over + W / 2) ** 2) / (2 * W)
      }
      ring[pos] = target
      if (target <= holdMin) {
        holdMin = target
        holdAge = 0
      } else if (++holdAge >= size) {
        let min = 0
        let age = 0
        for (let k = 0; k < size; k++) {
          const idx = pos - k < 0 ? pos - k + size : pos - k
          if (ring[idx] < min) {
            min = ring[idx]
            age = k
          }
        }
        holdMin = min
        holdAge = age
      }
      let g = 1
      if (holdMin < 0 || gainDb < 0) {
        gainDb = holdMin < gainDb ? att * gainDb + (1 - att) * holdMin : rel * gainDb + (1 - rel) * holdMin
        // Snap the tail of the release back to unity so idle stretches skip the exp.
        if (holdMin === 0 && gainDb > -1e-5) gainDb = 0
        if (-gainDb > maxReduction) maxReduction = -gainDb
        g = Math.exp(gainDb * 0.11512925464970229)
      }

      lineL[pos] = xl
      lineR[pos] = xr
      const read = pos + 1 === size ? 0 : pos + 1
      outL[i] = lineL[read] * g
      if (outR) outR[i] = lineR[read] * g
      pos = read
    }
    this.pos = pos
    this.holdMin = holdMin
    this.holdAge = holdAge
    this.gainDb = gainDb
    this.maxReduction = maxReduction
    if (this.report) {
      this.reportCounter += frames
      if (this.reportCounter >= 2048) {
        this.port.postMessage({ gainReduction: this.maxReduction })
        this.reportCounter = 0
        this.maxReduction = 0
      }
    }
    return this.alive
  }
}

registerProcessor('dynamics', Dynamics)

// --- True-peak limiter -----------------------------------------------------------------------------
// The gain is computed from a 4x oversampled detector, held at its minimum over the lookahead window,
// released exponentially, then box-smoothed over the same window. Delaying the audio by the window
// length guarantees the gain is already down when a peak arrives: no overshoot, no clipping, and the
// gain moves smoothly enough not to add audible distortion.

const OVERSAMPLE = 4
const TAPS = 12
const HALF = TAPS / 2

const makePhases = () => {
  const total = OVERSAMPLE * TAPS
  const center = total / 2
  const phases = []
  for (let phase = 0; phase < OVERSAMPLE; phase++) {
    const taps = new Float64Array(TAPS)
    let sum = 0
    for (let k = 0; k < TAPS; k++) {
      const n = k * OVERSAMPLE + phase
      const t = (n - center) / OVERSAMPLE
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
      taps[k] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / total))
      sum += taps[k]
    }
    for (let k = 0; k < TAPS; k++) taps[k] /= sum
    phases.push(taps)
  }
  return phases
}

class TruePeakLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = options.processorOptions ?? {}
    this.ceiling = opts.ceiling ?? 10 ** (-1 / 20)
    this.report = Boolean(opts.report)
    this.window = Math.max(8, Math.round((opts.lookahead ?? 0.0015) * sampleRate))
    this.releaseMul = Math.exp(-1 / ((opts.release ?? 0.1) * sampleRate))
    this.phases = makePhases()
    // Largest possible gain of the interpolator: if every sample in the window is below ceiling / bound,
    // no inter-sample peak can reach the ceiling and the oversampling can be skipped.
    this.bound = Math.max(...this.phases.map(t => t.reduce((a, v) => a + Math.abs(v), 0)))
    // Each history is stored twice so the FIR reads a contiguous run without wrapping.
    this.history = [new Float64Array(2 * TAPS), new Float64Array(2 * TAPS)]
    this.histPos = 0
    this.delay = this.window - 1 + HALF
    this.delayLines = [new Float32Array(this.delay + 1), new Float32Array(this.delay + 1)]
    this.delayPos = 0
    this.holdRing = new Float64Array(this.window).fill(1)
    this.boxRing = new Float64Array(this.window).fill(1)
    this.ringPos = 0
    this.boxSum = this.window
    this.holdMin = 1
    this.holdAge = 0
    this.released = 1
    this.minGain = 1
    this.reportCounter = 0
    this.alive = true
    this.port.onmessage = e => {
      if (typeof e.data?.ceiling === 'number') this.ceiling = e.data.ceiling
      if (e.data?.stop) this.alive = false
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!this.alive) return false
    if (!output || output.length === 0) return true
    const frames = output[0].length
    const inL = input && input.length > 0 ? input[0] : null
    const inR = input && input.length > 1 ? input[1] : inL
    const outL = output[0]
    const outR = output.length > 1 ? output[1] : null
    // State lives in locals during the loop (much faster than property access per sample).
    const [, p1, p2, p3] = this.phases
    const hL = this.history[0]
    const hR = this.history[1]
    const lineL = this.delayLines[0]
    const lineR = this.delayLines[1]
    const holdRing = this.holdRing
    const boxRing = this.boxRing
    const window = this.window
    const ceiling = this.ceiling
    const skipBelow = ceiling / this.bound
    const releaseMul = this.releaseMul
    const delaySize = this.delay + 1
    let histPos = this.histPos
    let ringPos = this.ringPos
    let delayPos = this.delayPos
    let holdMin = this.holdMin
    let holdAge = this.holdAge
    let released = this.released
    let boxSum = this.boxSum
    let minGain = this.minGain

    // Estimated true peak around sample n - HALF of one channel's history: the sample itself, plus the
    // three inter-sample points after it unless the whole window is too quiet to reach the ceiling.
    const channelPeak = (h, newest) => {
      const s0 = h[newest - HALF]
      let peak = s0 < 0 ? -s0 : s0
      let windowMax = 0
      for (let k = 0; k < TAPS; k++) {
        const v = h[newest - k]
        const av = v < 0 ? -v : v
        if (av > windowMax) windowMax = av
      }
      if (windowMax <= skipBelow) return peak
      let a1 = 0
      let a2 = 0
      let a3 = 0
      for (let k = 0; k < TAPS; k++) {
        const v = h[newest - k]
        a1 += p1[k] * v
        a2 += p2[k] * v
        a3 += p3[k] * v
      }
      if (a1 < 0) a1 = -a1
      if (a2 < 0) a2 = -a2
      if (a3 < 0) a3 = -a3
      if (a1 > peak) peak = a1
      if (a2 > peak) peak = a2
      if (a3 > peak) peak = a3
      return peak
    }

    for (let i = 0; i < frames; i++) {
      const xl = inL ? inL[i] : 0
      const xr = inR ? inR[i] : 0
      hL[histPos] = xl
      hL[histPos + TAPS] = xl
      hR[histPos] = xr
      hR[histPos + TAPS] = xr
      const newest = histPos + TAPS
      const pl = channelPeak(hL, newest)
      const pr = channelPeak(hR, newest)
      const peak = pl > pr ? pl : pr
      histPos = histPos + 1 === TAPS ? 0 : histPos + 1

      const required = peak > ceiling ? ceiling / peak : 1

      // Min-hold over the lookahead window (rescan only when the current minimum ages out).
      holdRing[ringPos] = required
      if (required <= holdMin) {
        holdMin = required
        holdAge = 0
      } else if (++holdAge >= window) {
        let min = 1
        let age = 0
        for (let k = 0; k < window; k++) {
          const idx = ringPos - k < 0 ? ringPos - k + window : ringPos - k
          if (holdRing[idx] < min) {
            min = holdRing[idx]
            age = k
          }
        }
        holdMin = min
        holdAge = age
      }

      // Exponential release, never above the hold.
      const release = 1 - (1 - released) * releaseMul
      released = holdMin < release ? holdMin : release

      // Box smoothing over the same window.
      boxSum += released - boxRing[ringPos]
      boxRing[ringPos] = released
      ringPos = ringPos + 1 === window ? 0 : ringPos + 1
      const gain = boxSum / window < 1 ? boxSum / window : 1
      if (gain < minGain) minGain = gain

      // Audio path: delay then apply gain.
      const readPos = delayPos + 1 === delaySize ? 0 : delayPos + 1
      lineL[delayPos] = xl
      lineR[delayPos] = xr
      outL[i] = lineL[readPos] * gain
      if (outR) outR[i] = lineR[readPos] * gain
      delayPos = readPos
    }

    this.histPos = histPos
    this.ringPos = ringPos
    this.delayPos = delayPos
    this.holdMin = holdMin
    this.holdAge = holdAge
    this.released = released
    this.boxSum = boxSum
    this.minGain = minGain

    if (this.report) {
      this.reportCounter += frames
      if (this.reportCounter >= 2048) {
        this.port.postMessage({ gainReduction: -20 * Math.log10(this.minGain) })
        this.reportCounter = 0
        this.minGain = 1
      }
    }
    return this.alive
  }
}

registerProcessor('true-peak-limiter', TruePeakLimiter)
