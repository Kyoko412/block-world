export function stereoWave(channels, sampleRate = 44100) {
  const length = channels[0].length;
  const bytes = new Uint8Array(44 + length * 4), view = new DataView(bytes.buffer);
  const tag = (at, text) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, length * 4, true);
  for (let i = 0; i < length; i++) for (let ch = 0; ch < 2; ch++) {
    view.setInt16(44 + (i * 2 + ch) * 2, Math.round(Math.max(-1, Math.min(1, channels[ch][i])) * 32767), true);
  }
  return bytes;
}
