import type { AnalysisRequest, AnalysisResponse } from './analysis.worker'

// Several tracks are analyzed at once, one worker each.
export const CONCURRENCY = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2)))

type PoolWorker = { worker: Worker; busy: number }
const pool: PoolWorker[] = []
let nextId = 0
const pending = new Map<number, { resolve: (r: AnalysisResponse) => void; slot: PoolWorker }>()

const leastBusy = () => {
  if (pool.length < CONCURRENCY) {
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
    const slot = { worker, busy: 0 }
    worker.addEventListener('message', (e: MessageEvent<AnalysisResponse>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      p.slot.busy--
      p.resolve(e.data)
    })
    pool.push(slot)
    return slot
  }
  return pool.reduce((a, b) => (b.busy < a.busy ? b : a))
}

// Measures loudness + true peak (and optionally the spectrum) off the main thread. The channels are
// copied, so callers can pass views into buffers they keep using.
export const analyze = (channels: Float32Array[], sampleRate: number, spectrum: boolean): Promise<AnalysisResponse> => {
  const copies = channels.map(c => c.slice())
  const id = nextId++
  const slot = leastBusy()
  slot.busy++
  return new Promise(resolve => {
    pending.set(id, { resolve, slot })
    const request: AnalysisRequest = { id, channels: copies, sampleRate, spectrum }
    slot.worker.postMessage(
      request,
      copies.map(c => c.buffer),
    )
  })
}

export const bufferChannels = (buffer: AudioBuffer) =>
  Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
