/// <reference lib="webworker" />
import { integratedLoudness, toDb, truePeak } from './loudness'
import { bandLevels } from './spectrum'

export type AnalysisRequest = { id: number; channels: Float32Array[]; sampleRate: number; spectrum: boolean }
export type AnalysisResponse = { id: number; lufs: number; truePeak: number; bands: number[] | null }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.addEventListener('message', (e: MessageEvent<AnalysisRequest>) => {
  const { id, channels, sampleRate, spectrum } = e.data
  const response: AnalysisResponse = {
    id,
    lufs: integratedLoudness(channels, sampleRate),
    truePeak: toDb(truePeak(channels)),
    bands: spectrum ? bandLevels(channels, sampleRate) : null,
  }
  // Worker scope postMessage takes no target origin (the rule assumes window.postMessage).
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  scope.postMessage(response)
})
