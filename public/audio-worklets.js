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
    for (let i = 0; i < frames; i++) {
      const xl = l ? l[i] : 0
      const xr = r ? r[i] : 0
      const al = xl < 0 ? -xl : xl
      const ar = xr < 0 ? -xr : xr
      const peak = al > ar ? al : ar
      const over = 20 * Math.log10(peak + 1e-12) - T
      let target = 0
      if (R > 1) {
        if (2 * over > W) target = slope * over
        else if (W > 0 && 2 * over > -W) target = (slope * (over + W / 2) ** 2) / (2 * W)
      }
      const ring = this.holdRing
      ring[this.pos] = target
      if (target <= this.holdMin) {
        this.holdMin = target
        this.holdAge = 0
      } else if (++this.holdAge >= size) {
        let min = 0
        let age = 0
        for (let k = 0; k < size; k++) {
          const v = ring[(this.pos - k + size) % size]
          if (v < min) {
            min = v
            age = k
          }
        }
        this.holdMin = min
        this.holdAge = age
      }
      const held = this.holdMin
      this.gainDb = held < this.gainDb ? att * this.gainDb + (1 - att) * held : rel * this.gainDb + (1 - rel) * held
      if (-this.gainDb > this.maxReduction) this.maxReduction = -this.gainDb
      const g = Math.exp(this.gainDb * 0.11512925464970229)

      this.lines[0][this.pos] = xl
      this.lines[1][this.pos] = xr
      const read = (this.pos + 1) % size
      output[0][i] = this.lines[0][read] * g
      if (output.length > 1) output[1][i] = this.lines[1][read] * g
      this.pos = read
    }
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
    this.channels = 2
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
    const phases = this.phases
    for (let i = 0; i < frames; i++) {
      // Detector: newest sample into history, estimate the peak around sample n - HALF.
      let peak = 0
      const pos = this.histPos
      for (let c = 0; c < this.channels; c++) {
        const src = input && input.length > 0 ? input[Math.min(c, input.length - 1)] : null
        const x = src ? src[i] : 0
        const h = this.history[c]
        h[pos] = x
        h[pos + TAPS] = x
        const newest = pos + TAPS
        // Phase 0 is exactly the sample HALF frames ago; phases 1-3 are the inter-sample points after it.
        const s0 = h[newest - HALF]
        let a = s0 < 0 ? -s0 : s0
        if (a > peak) peak = a
        for (let p = 1; p < OVERSAMPLE; p++) {
          const taps = phases[p]
          let acc = 0
          for (let k = 0; k < TAPS; k++) acc += taps[k] * h[newest - k]
          a = acc < 0 ? -acc : acc
          if (a > peak) peak = a
        }
      }
      this.histPos = (pos + 1) % TAPS

      const required = peak > this.ceiling ? this.ceiling / peak : 1

      // Min-hold over the lookahead window (rescan only when the current minimum ages out).
      this.holdRing[this.ringPos] = required
      if (required <= this.holdMin) {
        this.holdMin = required
        this.holdAge = 0
      } else if (++this.holdAge >= this.window) {
        let min = 1
        let age = 0
        for (let k = 0; k < this.window; k++) {
          const idx = (this.ringPos - k + this.window) % this.window
          if (this.holdRing[idx] < min) {
            min = this.holdRing[idx]
            age = k
          }
        }
        this.holdMin = min
        this.holdAge = age
      }
      const hold = this.holdMin

      // Exponential release, never above the hold.
      const release = 1 - (1 - this.released) * this.releaseMul
      this.released = hold < release ? hold : release

      // Box smoothing over the same window.
      this.boxSum += this.released - this.boxRing[this.ringPos]
      this.boxRing[this.ringPos] = this.released
      this.ringPos = (this.ringPos + 1) % this.window
      const gain = Math.min(1, this.boxSum / this.window)
      if (gain < this.minGain) this.minGain = gain

      // Audio path: delay then apply gain.
      const readPos = (this.delayPos + 1) % (this.delay + 1)
      for (let c = 0; c < output.length; c++) {
        const line = this.delayLines[Math.min(c, 1)]
        const src = input && input.length > 0 ? input[Math.min(c, input.length - 1)] : null
        if (c < 2) line[this.delayPos] = src ? src[i] : 0
        output[c][i] = line[readPos] * gain
      }
      this.delayPos = readPos
    }

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
