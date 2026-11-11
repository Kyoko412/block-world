import { s } from '@strudel/core';
import { samples, superdough, setAudioContext, setSuperdoughAudioController, initAudio } from 'superdough';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';
import { MATERIALS, movementPattern } from './patterns.mjs';
import { monoWave } from './wave.mjs';

const SR = 44100;
function wav(samples, sr = SR) {
  const bytes = monoWave(samples, sr);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

async function sandCuts() {
  const decoder = new OfflineAudioContext(1, 1, SR);
  const buffer = await decoder.decodeAudioData(await (await fetch('/sand.mp3')).arrayBuffer());
  const signal = buffer.getChannelData(0);
  const frame = Math.round(SR * 0.01), levels = [];
  for (let at = 0; at + frame < signal.length; at += frame) {
    let power = 0;
    for (let i = at; i < at + frame; i++) power += signal[i] ** 2;
    levels.push(Math.sqrt(power / frame));
  }
  const threshold = Math.max(...levels) * 0.3;
  const peaks = [];
  for (let i = 6; i < levels.length - 35; i++) {
    if (levels[i] > threshold && levels[i] >= levels[i - 1] && levels[i] >= levels[i + 1] &&
        (peaks.length === 0 || i - peaks[peaks.length - 1] > 65)) peaks.push(i);
  }
  if (peaks.length < 4) throw new Error('Sand recording has fewer than four separate usable contacts');
  const regions = peaks.slice(0, 4).map(i => ({ begin: Math.max(0, (i - 5) * 0.01), seconds: 0.43 }));
  const urls = regions.map(r => {
    const at = Math.round(r.begin * SR);
    return 'data:audio/wav;base64,' + wav(signal.slice(at, at + Math.round(r.seconds * SR)));
  });
  return { regions, urls };
}

const sand = await sandCuts();
const banks = { sand: sand.urls };
for (const [bank, source] of Object.entries({ grass: 'grass', stone: 'concrete', wood: 'wood', snow: 'snow' })) {
  banks[bank] = Array.from({ length: 4 }, (_, n) => location.origin + `/raw/footstep_${source}_00${n}.ogg`);
}
banks.body = [location.origin + '/raw/footstep_carpet_000.ogg'];
await samples(banks);

const jobs = [];
for (const material of Object.keys(MATERIALS)) {
  for (const action of material === 'body' ? ['jump'] : ['step', 'land']) {
    for (let variant = 0; variant < (material === 'body' ? 1 : 4); variant++) jobs.push({ material, variant, action });
  }
}
let renderPromise;
async function renderAll() {
  const context = new OfflineAudioContext(2, Math.round(SR * (jobs.length * 1.7 + 1)), SR);
  setAudioContext(context);
  setSuperdoughAudioController(new SuperdoughAudioController(context));
  await initAudio({ disableWorklets: true, maxPolyphony: 128 });
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const pattern = movementPattern(s, job.material, job.variant, job.action);
    for (const hap of pattern.queryArc(0, 1, { _cps: 1 })) {
      if (hap.hasOnset()) await superdough(hap.value, i * 1.7 + 0.02 + Number(hap.whole.begin), Number(hap.duration), 1, 0);
    }
  }
  return context.startRendering();
}

window.renderMovement = async (material, variant, action) => {
  renderPromise ||= renderAll();
  const rendered = await renderPromise;
  const jobIndex = jobs.findIndex(job => job.material === material && job.variant === variant && job.action === action);
  const pattern = movementPattern(s, material, variant, action);
  const haps = pattern.queryArc(0, 1, { _cps: 1 });
  const signal = new Float32Array(Math.round(SR * 1.7));
  const offset = Math.round(jobIndex * SR * 1.7);
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    const channel = rendered.getChannelData(ch);
    for (let i = 0; i < signal.length; i++) signal[i] += channel[offset + i] / rendered.numberOfChannels;
  }
  let peak = 0;
  for (const value of signal) peak = Math.max(peak, Math.abs(value));
  if (peak < 1e-5) throw new Error('Strudel rendered silence: ' + material + '/' + action);
  let begin = signal.findIndex(v => Math.abs(v) > peak * 0.012);
  let end = signal.length - 1;
  while (end > begin && Math.abs(signal[end]) < peak * 0.006) end--;
  begin = Math.max(0, begin - 100);
  end = Math.min(end + 700, begin + Math.round(SR * MATERIALS[material].max * (action === 'land' ? 1.35 : 1)));
  const clip = signal.slice(begin, end);
  let energy = 0; peak = 0;
  for (const value of clip) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
  const rms = Math.sqrt(energy / clip.length);
  const gain = Math.min((material === 'body' ? 0.075 : 0.12) / rms, 0.76 / peak) * (0.97 + variant * 0.015);
  const fade = Math.min(Math.round(SR * 0.018), Math.floor(clip.length / 4));
  for (let i = 0; i < clip.length; i++) clip[i] *= gain * Math.min(1, i / 100, (clip.length - 1 - i) / fade);
  energy = 0; peak = 0;
  for (const value of clip) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
  return {
    base64: wav(clip), seconds: clip.length / SR,
    rms: Math.sqrt(energy / clip.length), peak,
    parameters: haps[0].value,
    region: material === 'sand' ? sand.regions[variant] : null
  };
};
window.authorReady = true;
