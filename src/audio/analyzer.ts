import type { AnalysisRequest, AnalysisResponse } from './analysis.worker'

let worker: Worker | null = null
let nextId = 0
const pending = new Map<number, (r: AnalysisResponse) => void>()

const getWorker = () => {
  if (!worker) {
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent<AnalysisResponse>) => {
      pending.get(e.data.id)?.(e.data)
      pending.delete(e.data.id)
    })
  }
  return worker
}

// Measures loudness + true peak (and optionally spectral balance) off the main thread.
export const analyze = (buffer: AudioBuffer, spectrum: boolean): Promise<AnalysisResponse> => {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice())
  const id = nextId++
  return new Promise(resolve => {
    pending.set(id, resolve)
    const request: AnalysisRequest = { id, channels, sampleRate: buffer.sampleRate, spectrum }
    getWorker().postMessage(
      request,
      channels.map(c => c.buffer),
    )
  })
}
