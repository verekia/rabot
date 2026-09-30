// Decoded audio is big (~85 MB per 4-minute stereo track), so only the original files stay in memory
// and a few recently used tracks are kept decoded.

import { decodeFile } from './audio/chain'

const CACHE_SIZE = 3
const cache = new Map<string, { file: File; buffer: Promise<AudioBuffer> }>()

export const getBuffer = (id: string, file: File): Promise<AudioBuffer> => {
  const hit = cache.get(id)
  cache.delete(id)
  const entry = hit?.file === file ? hit : { file, buffer: decodeFile(file) }
  cache.set(id, entry)
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  // Don't keep failed decodes around.
  entry.buffer.catch(() => cache.get(id) === entry && cache.delete(id))
  return entry.buffer
}

export const dropBuffer = (id: string) => cache.delete(id)
