/* 制作端页面脚本：在同一个 OfflineAudioContext 里渲染全部进食任务。 */
import { s } from '@strudel/core';
import { samples, superdough, setAudioContext, setSuperdoughAudioController, initAudio } from 'superdough';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';
import { BANKS, SOURCES, JOBS, layersFor } from './patterns.mjs';
import { monoWave } from '../movement-audio/wave.mjs';

const SR = 44100;
const SLOT = 0.8;
const wav = (samples, sr = SR) => {
  const bytes = monoWave(samples, sr);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const pcmUrl = signal => 'data:audio/wav;base64,' + wav(signal);

const decode = new OfflineAudioContext(1, SR, SR);
const decoded = {};
for (const [key, source] of Object.entries(SOURCES)) {
  const response = await fetch('/raw/' + encodeURIComponent(source.file));
  if (!response.ok) throw new Error('Missing recording: ' + source.file);
  decoded[key] = await decode.decodeAudioData(await response.arrayBuffer());
}
const bankUrls = {};
for (const [key, cuts] of Object.entries(BANKS)) {
  bankUrls[key] = cuts.map(cut => {
    const buffer = decoded[cut.source];
    const begin = Math.round(cut.begin * SR), end = Math.round(cut.end * SR);
    if (end > buffer.length) throw new Error('Recording cut exceeds source: ' + key);
    const mono = new Float32Array(end - begin);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const channel = buffer.getChannelData(ch);
      for (let i = 0; i < mono.length; i++) mono[i] += channel[begin + i] / buffer.numberOfChannels;
    }
    const mean = mono.reduce((sum, value) => sum + value, 0) / mono.length;
    const fade = Math.round(SR * 0.006);
    for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] - mean) * Math.min(1, i / fade, (mono.length - 1 - i) / fade);
    return pcmUrl(mono);
  });
}
await samples(bankUrls);

let renderPromise;
async function renderAll() {
  const context = new OfflineAudioContext(2, Math.round(SR * (JOBS.length * SLOT + 1)), SR);
  setAudioContext(context);
  setSuperdoughAudioController(new SuperdoughAudioController(context));
  await initAudio({ disableWorklets: true, maxPolyphony: 128 });
  for (let i = 0; i < JOBS.length; i++) {
    for (const layer of layersFor(JOBS[i])) {
      let pattern = s(layer.bank).n(layer.take)
        .hpf(layer.hpf).lpf(layer.lpf)
        .speed(layer.speed).gain(layer.gain)
        .attack(0.001).release(0.02);
      if (layer.at > 0) pattern = pattern.late(layer.at);
      for (const hap of pattern.queryArc(0, 1, { _cps: 1 })) {
        if (hap.hasOnset()) await superdough(hap.value, i * SLOT + 0.02 + Number(hap.whole.begin), Number(hap.duration), 1, 0);
      }
    }
  }
  return context.startRendering();
}

window.renderEat = async id => {
  const index = JOBS.findIndex(job => job.id === id);
  if (index < 0) throw new Error('unknown job ' + id);
  const job = JOBS[index];
  renderPromise ||= renderAll();
  const rendered = await renderPromise;
  const slot = new Float32Array(Math.round(SR * SLOT));
  const offset = Math.round(index * SR * SLOT);
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    const channel = rendered.getChannelData(ch);
    for (let i = 0; i < slot.length; i++) slot[i] += channel[offset + i] / rendered.numberOfChannels;
  }
  let peak = 0;
  for (const value of slot) peak = Math.max(peak, Math.abs(value));
  if (peak < 1e-5) throw new Error('Strudel rendered silence: ' + id);

  let begin = slot.findIndex(value => Math.abs(value) > peak * 0.012);
  begin = Math.max(0, begin - 40);
  const cap = Math.min(slot.length, begin + Math.round(SR * job.seconds));
  let end = cap - 1;
  while (end > begin && Math.abs(slot[end]) < peak * 0.005) end--;
  end = Math.min(cap, end + Math.round(SR * 0.02));
  const clip = slot.slice(begin, end);

  const fadeIn = Math.min(Math.round(SR * 0.008), Math.floor(clip.length / 4));
  const fadeOut = Math.min(Math.round(SR * 0.025), Math.floor(clip.length / 4));
  let beforeEnergy = 0, top = 0;
  for (let i = 0; i < clip.length; i++) {
    clip[i] *= Math.min(1, i / fadeIn, (clip.length - 1 - i) / fadeOut);
    beforeEnergy += clip[i] * clip[i]; top = Math.max(top, Math.abs(clip[i]));
  }
  const rms = Math.sqrt(beforeEnergy / clip.length);
  if (!(rms > 0)) throw new Error('empty clip: ' + id);
  const gain = Math.min(job.rms / rms, 0.45 / top);
  for (let i = 0; i < clip.length; i++) clip[i] *= gain;
  let energy = 0;
  peak = 0;
  for (const value of clip) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
  return {
    id, base64: wav(clip), seconds: clip.length / SR, rms: Math.sqrt(energy / clip.length), peak,
    layers: job.layers.map(item => ({ bank: item.bank, take: item.take, at: item.at, speed: +item.speed.toFixed(4), gain: item.gain })),
    tone: job.tone
  };
};
window.authorReady = true;
