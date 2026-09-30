// Export rendering in a worker. The dynamics and limiter run the very same processor code as the live
// preview: `public/audio-worklets.js` is loaded with small stand-ins for the AudioWorklet globals and fed
// 128-frame blocks, exactly like the audio thread does. Gains and biquads are applied with the Web Audio
// spec formulas. Unlike OfflineAudioContext (Chrome renders all offline worklets on one shared thread),
// this runs in parallel across workers.

import { fromDb, integratedLoudness, toDb, truePeak, type Biquad } from './loudness'
import { CEILING_DBTP, highpassBiquad, SAMPLE_RATE, TONE_FILTERS, toneBiquad, type Plan } from './plan'
import { encodeWav24 } from './wav'

type Parameters = Record<string, Float32Array>
type Processor = {
  process: (inputs: Float32Array[][], outputs: Float32Array[][], parameters: Parameters) => boolean
  // Lookahead delay in frames.
  delay: number
}
type ProcessorClass = new (options: { processorOptions?: Record<string, unknown> }) => Processor

const BLOCK = 128

let processors: Promise<Record<string, ProcessorClass>> | null = null
const loadProcessors = (workletUrl: string) => {
  processors ??= (async () => {
    const source = await (await fetch(workletUrl)).text()
    class AudioWorkletProcessor {
      port = { postMessage: () => {}, close: () => {}, onmessage: null as unknown }
    }
    const registry: Record<string, ProcessorClass> = {}
    const registerProcessor = (name: string, processor: ProcessorClass) => (registry[name] = processor)
    // oxlint-disable-next-line no-new-func -- evaluates our own worklet file with worker-side stand-ins
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(
      AudioWorkletProcessor,
      registerProcessor,
      SAMPLE_RATE,
    )
    return registry
  })()
  return processors
}

// Transposed direct form II, double-precision state.
const biquadInPlace = (x: Float32Array, f: Biquad) => {
  let z1 = 0
  let z2 = 0
  for (let i = 0; i < x.length; i++) {
    const input = x[i]!
    const y = f.b0 * input + z1
    z1 = f.b1 * input - f.a1 * y + z2
    z2 = f.b2 * input - f.a2 * y
    x[i] = y
  }
}

const gainInPlace = (x: Float32Array, gain: number) => {
  for (let i = 0; i < x.length; i++) x[i] = x[i]! * gain
}

// The processors read each input sample before writing that output sample, so they can run in place.
const runBlocks = (processor: Processor, channels: Float32Array[], parameters: Parameters) => {
  const length = channels[0]!.length
  for (let start = 0; start < length; start += BLOCK) {
    const block = channels.map(ch => ch.subarray(start, Math.min(length, start + BLOCK)))
    processor.process([block], [block], parameters)
  }
}

// Renders the full chain; the result is sample-aligned with the input (lookahead delay removed).
export const renderOffline = async (
  input: Float32Array[],
  plan: Plan,
  postGainDb: number,
  workletUrl: string,
): Promise<Float32Array[]> => {
  const registry = await loadProcessors(workletUrl)
  const dynamics = new registry.dynamics!({ processorOptions: { report: false } })
  const limiter = new registry['true-peak-limiter']!({
    processorOptions: { ceiling: fromDb(CEILING_DBTP), report: false },
  })
  const latency = dynamics.delay + limiter.delay
  // Padded so the delayed tail is rendered too.
  const channels = input.map(ch => {
    const padded = new Float32Array(ch.length + latency)
    padded.set(ch)
    return padded
  })

  const highpass = highpassBiquad()
  for (const ch of channels) {
    gainInPlace(ch, fromDb(plan.preGain))
    biquadInPlace(ch, highpass)
  }
  const { threshold, ratio, knee, attack, release } = plan.comp
  runBlocks(dynamics, channels, {
    threshold: Float32Array.of(threshold),
    ratio: Float32Array.of(ratio),
    knee: Float32Array.of(knee),
    attack: Float32Array.of(attack),
    release: Float32Array.of(release),
  })
  const tone = TONE_FILTERS.map((f, i) => toneBiquad(f, plan.eq[i]!))
  for (const ch of channels) {
    for (const f of tone) biquadInPlace(ch, f)
    gainInPlace(ch, fromDb(postGainDb))
  }
  runBlocks(limiter, channels, {})
  return channels.map(ch => ch.subarray(latency))
}

const TOLERANCE_DB = 0.05

// Renders, measures, and corrects the gain if the prediction missed the target: by scaling the audio
// when that can't push peaks into the limiter (the common case), otherwise by re-rendering (secant steps,
// since the limiter makes each dB of gain worth less than a dB). Returns the encoded WAV.
export const renderExport = async (
  input: Float32Array[],
  plan: Plan,
  postGainDb: number,
  target: number,
  workletUrl: string,
) => {
  const measure = (channels: Float32Array[]) => ({
    lufs: integratedLoudness(channels, SAMPLE_RATE),
    truePeak: toDb(truePeak(channels)),
  })
  let gain = postGainDb
  let channels = await renderOffline(input, plan, gain, workletUrl)
  let result = measure(channels)
  let previous: { gain: number; lufs: number } | null = null
  for (let i = 0; i < 3; i++) {
    const error = target - result.lufs
    if (Math.abs(error) <= TOLERANCE_DB) break
    if (error < 0 || result.truePeak + error <= CEILING_DBTP) {
      // Linear correction: turning down is always clean, and turning up is clean while the true peak
      // stays under the ceiling.
      for (const ch of channels) gainInPlace(ch, fromDb(error))
      result = { lufs: result.lufs + error, truePeak: result.truePeak + error }
      break
    }
    const slope =
      previous && gain !== previous.gain
        ? Math.min(1, Math.max(0.2, (result.lufs - previous.lufs) / (gain - previous.gain)))
        : 1
    previous = { gain, lufs: result.lufs }
    gain += error / slope
    channels = await renderOffline(input, plan, gain, workletUrl)
    result = measure(channels)
  }
  return { wav: encodeWav24(channels, SAMPLE_RATE), ...result }
}
