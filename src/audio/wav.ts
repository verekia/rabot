// 16-bit PCM WAV encoder with TPDF dither.
//
// Truncating the processed float signal to 16 bits would correlate the rounding error with the music
// (audible as grainy distortion on quiet passages and fades). Triangular dither of ±1 LSB turns it into
// a constant, inaudible noise floor (~-96 dBFS). The dither generator is seeded, so exporting the same
// audio twice gives byte-identical files.

export const encodeWav16 = (channels: Float32Array[], sampleRate: number): Uint8Array => {
  const numChannels = channels.length
  const length = channels[0]?.length ?? 0
  const bytesPerSample = 2
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

  // xorshift32, uniform in [0, 1).
  let seed = 0x9e3779b9
  const random = () => {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    return (seed >>> 0) / 4294967296
  }

  const scale = 32767
  let offset = 44
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) {
      // Sum of two uniform variables: triangular distribution over ±1 LSB.
      const dither = random() - random()
      const v = Math.max(-32768, Math.min(32767, Math.round(channels[c]![i]! * scale + dither)))
      view.setInt16(offset, v, true)
      offset += 2
    }
  }
  return out
}
