import { s } from '@strudel/core';
import { samples, superdough, setAudioContext, setSuperdoughAudioController, initAudio } from 'superdough';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';
import { SOURCES, JOBS, LOOP_CROSSFADE } from './patterns.mjs';
import { stereoWave } from './wave.mjs';
const SR = 44100, SLOT = 38;
const base64 = channels => {
  const bytes = stereoWave(channels); let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const decoder = new OfflineAudioContext(2, SR, SR), decoded = {}, banks = {};
for (const key of Object.keys(SOURCES)) {
  const response = await fetch('/raw/' + key);
  if (!response.ok) throw new Error('Missing field recording: ' + key);
  decoded[key] = await decoder.decodeAudioData(await response.arrayBuffer());
}
for (let j = 0; j < JOBS.length; j++) for (let n = 0; n < JOBS[j].layers.length; n++) {
  const cut = JOBS[j].layers[n], buffer = decoded[cut.source];
  const begin = Math.round(cut.begin * SR), end = Math.round(cut.end * SR);
  if (end > buffer.length) throw new Error('Recording cut exceeds source: ' + cut.source);
  const channels = [0, 1].map(ch => buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1)).slice(begin, end));
  let energy = 0, peak = 0;
  for (const channel of channels) {
    const mean = channel.reduce((sum, value) => sum + value, 0) / channel.length;
    for (let i = 0; i < channel.length; i++) { channel[i] -= mean; energy += channel[i] ** 2; peak = Math.max(peak, Math.abs(channel[i])); }
  }
  const gain = Math.min(cut.rms / Math.sqrt(energy / (channels[0].length * 2)), 0.5 / peak);
  for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] *= gain;
  banks[`field${j}take${n}`] = ['data:audio/wav;base64,' + base64(channels)];
}
await samples(banks);
let rendering;
async function renderAll() {
  const context = new OfflineAudioContext(2, Math.round(SR * (JOBS.length * SLOT + 1)), SR);
  setAudioContext(context); setSuperdoughAudioController(new SuperdoughAudioController(context));
  await initAudio({ disableWorklets: true, maxPolyphony: 64 });
  for (let j = 0; j < JOBS.length; j++) {
    const job = JOBS[j], duration = job.seconds + LOOP_CROSSFADE;
    for (let n = 0; n < job.layers.length; n++) {
      const layer = job.layers[n];
      const pattern = s(`field${j}take${n}`).slow(duration).late(layer.at)
        .hpf(job.tone.hpf).lpf(job.tone.lpf).gain(1).attack(0.01).release(0.04);
      for (const hap of pattern.queryArc(0, duration, { _cps: 1 })) {
        if (hap.hasOnset()) await superdough(hap.value, j * SLOT + 0.02 + Number(hap.whole.begin), Number(hap.duration), 1, 0);
      }
    }
  }
  return context.startRendering();
}
window.renderAmbient = async id => {
  const index = JOBS.findIndex(job => job.id === id), job = JOBS[index];
  rendering ||= renderAll(); const rendered = await rendering;
  const offset = Math.round(SR * (index * SLOT + 0.02));
  const length = Math.round(job.seconds * SR), overlap = Math.round(LOOP_CROSSFADE * SR);
  const channels = [0, 1].map(ch => {
    const signal = rendered.getChannelData(ch).slice(offset, offset + length + overlap);
    const loop = signal.slice(overlap);
    for (let i = 0; i < overlap; i++) {
      const angle = i / (overlap - 1) * Math.PI / 2;
      loop[length - overlap + i] = signal[length + i] * Math.cos(angle) + signal[i] * Math.sin(angle);
    }
    return loop;
  });
  let energy = 0, peak = 0;
  for (const channel of channels) for (const value of channel) { energy += value ** 2; peak = Math.max(peak, Math.abs(value)); }
  if (peak < 1e-6) throw new Error('Rendered silence: ' + id);
  const gain = Math.min(job.rms / Math.sqrt(energy / (length * 2)), 0.38 / peak);
  energy = 0; peak = 0;
  for (const channel of channels) for (let i = 0; i < channel.length; i++) {
    channel[i] *= gain; energy += channel[i] ** 2; peak = Math.max(peak, Math.abs(channel[i]));
  }
  return { id, base64: base64(channels), seconds: job.seconds, rms: Math.sqrt(energy / (length * 2)), peak,
    seamDelta: Math.max(...channels.map(ch => Math.abs(ch[0] - ch[ch.length - 1]))) };
};
window.authorReady = true;
