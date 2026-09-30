/// <reference lib="webworker" />
import { integratedLoudness, integratedLoudnessWeighted, kWeight, segmentLevels, toDb, truePeak } from './loudness'
import type { Signature } from './model'
import { renderExport } from './offline'
import type { Plan } from './plan'
import { analyzeSpectrum } from './spectrum'

// 'signature': everything the model needs, measured once per track on add.
// 'verify': loudness + true peak of rendered audio.
// 'export': render the full chain, verify/correct loudness and encode the WAV.
export type ExportOptions = { plan: Plan; postGain: number; target: number; workletUrl: string }
export type AnalysisRequest = {
  id: number
  kind: 'signature' | 'verify' | 'export'
  channels: Float32Array[]
  sampleRate: number
  export?: ExportOptions
}
export type AnalysisResponse =
  | { id: number; kind: 'signature'; signature: Signature }
  | { id: number; kind: 'verify'; lufs: number; truePeak: number }
  | { id: number; kind: 'export'; wav: Uint8Array; lufs: number; truePeak: number }

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

const respond = (response: AnalysisResponse, transfer: Transferable[] = []) =>
  // Worker scope postMessage takes no target origin (the rule assumes window.postMessage).
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  scope.postMessage(response, transfer)

scope.addEventListener('message', async (e: MessageEvent<AnalysisRequest>) => {
  const { id, kind, channels, sampleRate } = e.data
  if (kind === 'export') {
    const o = e.data.export!
    const result = await renderExport(channels, o.plan, o.postGain, o.target, o.workletUrl)
    respond({ id, kind, ...result }, [result.wav.buffer])
  } else if (kind === 'signature') {
    respond({ id, kind, signature: signatureOf(channels, sampleRate) })
  } else {
    respond({ id, kind, lufs: integratedLoudness(channels, sampleRate), truePeak: toDb(truePeak(channels)) })
  }
})
