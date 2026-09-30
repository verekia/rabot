// 24-bit PCM WAV encoder. 24-bit keeps the processed float signal without audible requantization,
// so no dither is needed.

export const encodeWav24 = (channels: Float32Array[], sampleRate: number): Uint8Array => {
  const numChannels = channels.length
  const length = channels[0]?.length ?? 0
  const bytesPerSample = 3
  const blockAlign = numChannels * bytesPerSample
  const dataSize = length * blockAlign
  const out = new Uint8Array(44 + dataSize)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)

  const max = 0x7fffff
  let offset = 44
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!))
      const v = Math.round(s * max)
      out[offset] = v & 0xff
      out[offset + 1] = (v >> 8) & 0xff
      out[offset + 2] = (v >> 16) & 0xff
      offset += 3
    }
  }
  return out
}
