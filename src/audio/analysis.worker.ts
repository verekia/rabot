/// <reference lib="webworker" />
import { integratedLoudness, integratedLoudnessWeighted, kWeight, segmentLevels, toDb, truePeak } from './loudness'
import type { Signature } from './model'
import { analyzeSpectrum } from './spectrum'

// 'signature': everything the model needs, measured once per track on add.
// 'verify': loudness + true peak of a rendered export.
export type AnalysisRequest = { id: number; kind: 'signature' | 'verify'; channels: Float32Array[]; sampleRate: number }
export type AnalysisResponse =
  | { id: number; kind: 'signature'; signature: Signature }
  | { id: number; kind: 'verify'; lufs: number; truePeak: number }

const scope = self as unknown as DedicatedWorkerGlobalScope

const signatureOf = (channels: Float32Array[], sampleRate: number): Signature => {
  const weighted = kWeight(channels, sampleRate)
  const { power, peak } = segmentLevels(channels, weighted, sampleRate)
  const { bands, spectrum } = analyzeSpectrum(channels, sampleRate)
  let samplePeak = 0
  for (let i = 0; i < peak.length; i++) if (peak[i]! > samplePeak) samplePeak = peak[i]!
  return {
    lufs: integratedLoudnessWeighted(weighted, sampleRate),
    truePeak: toDb(truePeak(channels)),
    samplePeak,
    bands,
    spectrum,
    power,
    peak,
  }
}

scope.addEventListener('message', (e: MessageEvent<AnalysisRequest>) => {
  const { id, kind, channels, sampleRate } = e.data
  const response: AnalysisResponse =
    kind === 'signature'
      ? { id, kind, signature: signatureOf(channels, sampleRate) }
      : { id, kind, lufs: integratedLoudness(channels, sampleRate), truePeak: toDb(truePeak(channels)) }
  // Worker scope postMessage takes no target origin (the rule assumes window.postMessage).
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  scope.postMessage(response)
})
