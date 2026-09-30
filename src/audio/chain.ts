// The Web Audio processing graph. The exact same graph runs in the realtime preview and in the
// OfflineAudioContext export, so what you hear is what you download.
//
//   source → pre gain → high-pass → dynamics →  tone EQ ×4 → post gain → true-peak limiter
//
// Dynamics comes right after the loudness normalization so its threshold is relative to each track's
// own loudness, unaffected by the tone-match EQ.

import { fromDb } from './loudness'
import { CEILING_DBTP, HIGHPASS_HZ, SAMPLE_RATE, TONE_FILTERS, type Plan } from './plan'

const worklets = new WeakMap<BaseAudioContext, Promise<void>>()
export const loadWorklet = (ctx: BaseAudioContext) => {
  let p = worklets.get(ctx)
  if (!p) {
    p = ctx.audioWorklet.addModule('/audio-worklets.js')
    worklets.set(ctx, p)
  }
  return p
}

export type Chain = {
  input: AudioNode
  // Everything before the post gain, used for loudness measurement renders.
  stageOutput: AudioNode
  output: AudioNode
  dynamics: AudioWorkletNode
  limiter: AudioWorkletNode | null
  update: (plan: Plan, postGainDb: number) => void
  disconnect: () => void
}

export const buildChain = (
  ctx: BaseAudioContext,
  plan: Plan,
  postGainDb: number,
  { limiter = true, report = false } = {},
): Chain => {
  const pre = ctx.createGain()
  const highpass = ctx.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = HIGHPASS_HZ
  highpass.Q.value = Math.SQRT1_2
  const eq = TONE_FILTERS.map(f => {
    const node = ctx.createBiquadFilter()
    node.type = f.type
    node.frequency.value = f.frequency
    node.Q.value = f.Q
    return node
  })
  const dynamics = new AudioWorkletNode(ctx, 'dynamics', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: { report },
  })
  const dyn = (name: string) => dynamics.parameters.get(name)!
  const post = ctx.createGain()
  const limiterNode = limiter
    ? new AudioWorkletNode(ctx, 'true-peak-limiter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        processorOptions: { ceiling: fromDb(CEILING_DBTP), report },
      })
    : null

  const nodes: AudioNode[] = [pre, highpass, dynamics, ...eq, post, ...(limiterNode ? [limiterNode] : [])]
  for (let i = 0; i < nodes.length - 1; i++) nodes[i]!.connect(nodes[i + 1]!)

  const realtime = ctx instanceof AudioContext
  const set = (param: AudioParam, value: number) => {
    if (realtime) param.setTargetAtTime(value, ctx.currentTime, 0.03)
    else param.value = value
  }

  const update = (p: Plan, postDb: number) => {
    set(pre.gain, fromDb(p.preGain))
    eq.forEach((node, i) => set(node.gain, p.eq[i]!))
    set(dyn('threshold'), p.comp.threshold)
    set(dyn('ratio'), p.comp.ratio)
    set(dyn('knee'), p.comp.knee)
    set(dyn('attack'), p.comp.attack)
    set(dyn('release'), p.comp.release)
    set(post.gain, fromDb(postDb))
  }
  // Start from exact values (no ramp from defaults), then smooth later changes.
  pre.gain.value = fromDb(plan.preGain)
  eq.forEach((node, i) => (node.gain.value = plan.eq[i]!))
  dyn('threshold').value = plan.comp.threshold
  dyn('ratio').value = plan.comp.ratio
  dyn('knee').value = plan.comp.knee
  dyn('attack').value = plan.comp.attack
  dyn('release').value = plan.comp.release
  post.gain.value = fromDb(postGainDb)

  return {
    input: pre,
    stageOutput: eq[eq.length - 1]!,
    output: limiterNode ?? post,
    dynamics,
    limiter: limiterNode,
    update,
    disconnect: () => {
      nodes.forEach(n => n.disconnect())
      // Stop the worklet processors so they don't keep running (and reporting) after the chain is gone.
      for (const node of [dynamics, limiterNode]) {
        if (!node) continue
        // MessagePort.postMessage has no target origin (the rule assumes window.postMessage).
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        node.port.postMessage({ stop: true })
        node.port.close()
      }
    },
  }
}

// Total delay of the graph in frames (dynamics + limiter lookahead), measured once with an
// impulse so it's exact for whichever browser runs it. Exports are shifted back by this amount so the
// output stays sample-aligned with the source.
let latencyPromise: Promise<{ stage: number; full: number }> | null = null
export const chainLatency = () => {
  latencyPromise ??= (async () => {
    const measure = async (full: boolean) => {
      const ctx = new OfflineAudioContext(2, 8192, SAMPLE_RATE)
      await loadWorklet(ctx)
      const impulse = ctx.createBuffer(2, 8192, SAMPLE_RATE)
      impulse.getChannelData(0)[1000] = 0.1
      impulse.getChannelData(1)[1000] = 0.1
      const src = ctx.createBufferSource()
      src.buffer = impulse
      const neutral: Plan = {
        preGain: 0,
        eq: TONE_FILTERS.map(() => 0),
        comp: { threshold: 0, ratio: 1, knee: 0, attack: 0.002, release: 0.1 },
        key: '',
      }
      const chain = buildChain(ctx, neutral, 0, { limiter: full })
      src.connect(chain.input)
      ;(full ? chain.output : chain.stageOutput).connect(ctx.destination)
      src.start()
      const out = (await ctx.startRendering()).getChannelData(0)
      let best = 0
      for (let i = 1; i < out.length; i++) if (Math.abs(out[i]!) > Math.abs(out[best]!)) best = i
      return best - 1000
    }
    return { stage: await measure(false), full: await measure(true) }
  })()
  return latencyPromise
}

// Offline render of a track through the chain, trimmed to be sample-aligned with the source.
export const renderChain = async (
  buffer: AudioBuffer,
  plan: Plan,
  postGainDb: number,
  mode: 'stage' | 'full',
): Promise<AudioBuffer> => {
  const latency = (await chainLatency())[mode]
  const ctx = new OfflineAudioContext(2, buffer.length + latency, SAMPLE_RATE)
  await loadWorklet(ctx)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  const chain = buildChain(ctx, plan, postGainDb, { limiter: mode === 'full' })
  src.connect(chain.input)
  ;(mode === 'full' ? chain.output : chain.stageOutput).connect(ctx.destination)
  src.start()
  const rendered = await ctx.startRendering()
  const out = new AudioBuffer({ numberOfChannels: 2, length: buffer.length, sampleRate: SAMPLE_RATE })
  for (let c = 0; c < 2; c++) out.copyToChannel(rendered.getChannelData(c).subarray(latency), c)
  return out
}

// Decode any browser-supported audio file to a stereo 44.1 kHz buffer.
export const decodeFile = async (file: File): Promise<AudioBuffer> => {
  const ctx = new OfflineAudioContext(2, 1, SAMPLE_RATE)
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
  if (decoded.numberOfChannels === 2) return decoded
  const stereo = new AudioBuffer({ numberOfChannels: 2, length: decoded.length, sampleRate: SAMPLE_RATE })
  stereo.copyToChannel(decoded.getChannelData(0), 0)
  stereo.copyToChannel(decoded.getChannelData(Math.min(1, decoded.numberOfChannels - 1)), 1)
  return stereo
}
