// Realtime preview. Runs the same chain as the export on a 44.1 kHz AudioContext, plus a
// loudness-matched "original" path for A/B comparison.

import { buildChain, loadWorklet, type Chain } from './audio/chain'
import { fromDb } from './audio/loudness'
import { SAMPLE_RATE } from './audio/plan'
import { getBuffer } from './buffers'
import { planTrack, useStore, type Track } from './store'

type Voice = {
  trackId: string
  source: AudioBufferSourceNode
  chain: Chain
  processed: GainNode
  original: GainNode
  startedAt: number
  offset: number
}

let ctx: AudioContext | null = null
let voice: Voice | null = null
let limiterReduction = 0
let dynamicsReduction = 0
let pausedAt = 0

const getContext = async () => {
  ctx ??= new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' })
  await loadWorklet(ctx)
  if (ctx.state === 'suspended') await ctx.resume()
  return ctx
}

// Original, gain-matched to the target so A/B compares tone and dynamics, not level. Capped so its
// peaks stay below 0 dBFS and don't clip the output.
const originalGainDb = (track: Track) => {
  const { global } = useStore.getState()
  if (!track.signature) return 0
  return Math.min(global.target - track.signature.lufs, -track.signature.truePeak)
}

const applyMix = (v: Voice, c: AudioContext) => {
  const { bypass, tracks } = useStore.getState()
  const track = tracks.find(t => t.id === v.trackId)
  v.processed.gain.setTargetAtTime(bypass ? 0 : 1, c.currentTime, 0.01)
  v.original.gain.setTargetAtTime(bypass && track ? fromDb(originalGainDb(track)) : 0, c.currentTime, 0.01)
}

const stopVoice = () => {
  if (!voice) return
  const v = voice
  voice = null
  try {
    v.source.stop()
  } catch {
    // Already stopped.
  }
  v.chain.disconnect()
  v.processed.disconnect()
  v.original.disconnect()
}

const position = () => {
  if (!voice || !ctx) return pausedAt
  return Math.min(voice.offset + ctx.currentTime - voice.startedAt, voice.source.buffer?.duration ?? 0)
}

// Bumped by every play/pause/stop so a play that is still decoding knows it has been superseded.
let playToken = 0

const play = async (trackId: string, offset = 0) => {
  const token = ++playToken
  const track = useStore.getState().tracks.find(t => t.id === trackId)
  if (track?.status !== 'ready') return
  // Show the new state right away; decoding a track takes a moment.
  useStore.setState({ playingId: trackId, playing: true })
  const [c, buffer] = await Promise.all([getContext(), getBuffer(track.id, track.file)])
  const state = useStore.getState()
  const tp = planTrack(state, track)
  if (token !== playToken || !tp) return
  stopVoice()

  const source = c.createBufferSource()
  source.buffer = buffer
  const chain = buildChain(c, tp.plan, tp.postGain, { report: true })
  chain.limiter!.port.addEventListener('message', e => (limiterReduction = e.data.gainReduction))
  chain.limiter!.port.start()
  chain.dynamics.port.addEventListener('message', e => (dynamicsReduction = e.data.gainReduction))
  chain.dynamics.port.start()
  const processed = c.createGain()
  const original = c.createGain()
  source.connect(chain.input)
  chain.output.connect(processed).connect(c.destination)
  source.connect(original).connect(c.destination)

  const start = Math.max(0, Math.min(offset, buffer.duration - 0.05))
  voice = { trackId, source, chain, processed, original, startedAt: c.currentTime, offset: start }
  processed.gain.value = 0
  original.gain.value = 0
  applyMix(voice, c)
  source.start(0, start)
  source.addEventListener('ended', () => {
    // Ignore sources we stopped ourselves (pause, seek, track switch).
    if (voice?.source !== source) return
    stopVoice()
    // Continuous playback: move on to the next track, like the live playlist would.
    const { tracks } = useStore.getState()
    const next = tracks[tracks.findIndex(t => t.id === trackId) + 1]
    if (next?.status === 'ready') {
      useStore.setState({ playingId: next.id, selectedId: next.id })
      void play(next.id, 0)
    } else {
      pausedAt = 0
      useStore.setState({ playing: false })
    }
  })
  pausedAt = start
}

// Keep the playing voice in sync with dials, measurements and the A/B switch.
useStore.subscribe(() => {
  if (!voice || !ctx) return
  const state = useStore.getState()
  const track = state.tracks.find(t => t.id === voice!.trackId)
  const tp = track && planTrack(state, track)
  if (!tp) return
  voice.chain.update(tp.plan, tp.postGain)
  applyMix(voice, ctx)
})

export const player = {
  play: (trackId: string, offset = 0) => void play(trackId, offset),
  toggle: () => {
    const { playing, playingId, selectedId } = useStore.getState()
    if (playing) player.pause()
    else if (selectedId) void play(selectedId, selectedId === playingId ? pausedAt : 0)
  },
  pause: () => {
    playToken++
    pausedAt = position()
    stopVoice()
    useStore.setState({ playing: false })
  },
  stop: () => {
    playToken++
    stopVoice()
    pausedAt = 0
    useStore.setState({ playing: false, playingId: null })
  },
  seek: (seconds: number) => {
    const { playing, playingId, selectedId } = useStore.getState()
    const id = playing ? playingId : selectedId
    if (!id) return
    if (playing) void play(id, seconds)
    else {
      pausedAt = seconds
      useStore.setState({ playingId: id })
    }
  },
  position,
  meters: () => ({
    dynamics: voice ? dynamicsReduction : 0,
    limiter: voice ? limiterReduction : 0,
  }),
}
