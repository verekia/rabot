import type { AnalysisRequest, AnalysisResponse, ExportOptions } from './analysis.worker'
import type { Signature } from './model'

// Several tracks are analyzed (and exported) at once, one worker each.
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

const run = (
  kind: AnalysisRequest['kind'],
  channels: Float32Array[],
  sampleRate: number,
  exportOptions?: ExportOptions,
) => {
  // Copies, so callers can pass views into buffers they keep using.
  const copies = channels.map(c => c.slice())
  const id = nextId++
  const slot = leastBusy()
  slot.busy++
  return new Promise<AnalysisResponse>(resolve => {
    pending.set(id, { resolve, slot })
    const request: AnalysisRequest = { id, kind, channels: copies, sampleRate, export: exportOptions }
    slot.worker.postMessage(
      request,
      copies.map(c => c.buffer),
    )
  })
}

// A track's signature (loudness, spectrum, 10 ms level profile), computed off the main thread.
export const analyzeSignature = async (channels: Float32Array[], sampleRate: number): Promise<Signature> => {
  const r = await run('signature', channels, sampleRate)
  if (r.kind !== 'signature') throw new Error('Unexpected analysis response')
  return r.signature
}

// Loudness + true peak of rendered audio.
export const measure = async (channels: Float32Array[], sampleRate: number) => {
  const r = await run('verify', channels, sampleRate)
  if (r.kind !== 'verify') throw new Error('Unexpected analysis response')
  return { lufs: r.lufs, truePeak: r.truePeak }
}

// Full export of one track in a worker: render, verify/correct loudness, encode. Returns the WAV bytes.
export const renderExport = async (channels: Float32Array[], options: Omit<ExportOptions, 'workletUrl'>) => {
  const workletUrl = new URL('/audio-worklets.js', location.origin).href
  const r = await run('export', channels, 44100, { ...options, workletUrl })
  if (r.kind !== 'export') throw new Error('Unexpected analysis response')
  return { wav: r.wav, lufs: r.lufs, truePeak: r.truePeak }
}

export const bufferChannels = (buffer: AudioBuffer) =>
  Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
