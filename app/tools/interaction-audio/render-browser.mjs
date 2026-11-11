/* 制作端页面脚本：在同一个 OfflineAudioContext 里渲染全部挖掘/放置任务。 */
import { s } from '@strudel/core';
import { samples, superdough, setAudioContext, setSuperdoughAudioController, initAudio } from 'superdough';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';
import { BANKS, SAND_BANK, layersFor, jobs, ACTIONS } from './patterns.mjs';
import { monoWave } from '../movement-audio/wave.mjs';

const SR = 44100;
const SLOT = 1.4;
function wav(samples, sr = SR) {
  const bytes = monoWave(samples, sr);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

/* Peludo 沙地录音切成 4 段独立的摩擦颗粒：沙/砾/叶的「沙沙」都来自这四段，不是合成噪声。 */
async function sandGrains() {
  const decode = new OfflineAudioContext(1, 1, SR);
  const buffer = await decode.decodeAudioData(await (await fetch('/sand.mp3')).arrayBuffer());
  const signal = buffer.getChannelData(0);
  const frame = Math.round(SR * 0.01), levels = [];
  for (let at = 0; at + frame < signal.length; at += frame) {
    let power = 0;
    for (let i = at; i < at + frame; i++) power += signal[i] ** 2;
    levels.push(Math.sqrt(power / frame));
  }
  const threshold = Math.max(...levels) * 0.28;
  const peaks = [];
  for (let i = 6; i < levels.length - 30; i++) {
    if (levels[i] > threshold && levels[i] >= levels[i - 1] && levels[i] >= levels[i + 1] &&
        (peaks.length === 0 || i - peaks[peaks.length - 1] > 55)) peaks.push(i);
  }
  if (peaks.length < 5) throw new Error('沙地录音里可用的独立颗粒不足：' + peaks.length);
  return peaks.slice(0, 5).map(i => {
    const at = Math.max(0, Math.round((i - 4) * 0.01 * SR));
    return 'data:audio/wav;base64,' + wav(signal.slice(at, at + Math.round(SR * 0.2)));
  });
}

const all = ACTIONS.flatMap(action => jobs(action));
const grains = await sandGrains();
const bankUrls = { [SAND_BANK]: grains };
for (const [key, packName] of Object.entries(BANKS)) {
  bankUrls[key] = Array.from({ length: 5 }, (_, n) => `${location.origin}/raw/${packName}_00${n}.ogg`);
}
await samples(bankUrls);

let renderPromise;
async function renderAll() {
  const context = new OfflineAudioContext(2, Math.round(SR * (all.length * SLOT + 1)), SR);
  setAudioContext(context);
  setSuperdoughAudioController(new SuperdoughAudioController(context));
  await initAudio({ disableWorklets: true, maxPolyphony: 256 });
  for (let i = 0; i < all.length; i++) {
    for (const layer of layersFor(all[i])) {
      let pattern = s(layer.bank).n(layer.take)
        .hpf(layer.hpf).lpf(layer.lpf)
        .speed(layer.speed).gain(layer.gain)
        .attack(0.0015).release(0.03);
      if (layer.at > 0) pattern = pattern.late(layer.at);
      for (const hap of pattern.queryArc(0, 1, { _cps: 1 })) {
        if (hap.hasOnset()) await superdough(hap.value, i * SLOT + 0.02 + Number(hap.whole.begin), Number(hap.duration), 1, 0);
      }
    }
  }
  return context.startRendering();
}

window.renderInteraction = async id => {
  const index = all.findIndex(job => job.id === id);
  if (index < 0) throw new Error('unknown job ' + id);
  const job = all[index];
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
  begin = Math.max(0, begin - 60);
  const cap = Math.min(slot.length, begin + Math.round(SR * job.seconds));
  let end = cap - 1;
  while (end > begin && Math.abs(slot[end]) < peak * 0.005) end--;
  end = Math.min(cap, end + Math.round(SR * 0.02));
  const clip = slot.slice(begin, end);

  /* 响度按短窗 RMS 定：敲击是瞬态，用整段 RMS 会被尾巴稀释，
     结果是「越长的样本越响」，同一材质四条变体的力度就散了。 */
  const window = Math.min(clip.length, Math.round(SR * 0.08));
  let shortEnergy = 0, peak2 = 0;
  for (let i = 0; i < clip.length; i++) peak2 = Math.max(peak2, Math.abs(clip[i]));
  for (let i = 0; i < window; i++) shortEnergy += clip[i] * clip[i];
  const shortRms = Math.sqrt(shortEnergy / window);
  if (!(shortRms > 0)) throw new Error('empty clip: ' + id);
  const gain = Math.min(job.rms / shortRms, 0.8 / peak2);
  const fadeIn = Math.min(Math.round(SR * 0.012), Math.floor(clip.length / 4));
  const fadeOut = Math.min(Math.round(SR * 0.025), Math.floor(clip.length / 4));
  for (let i = 0; i < clip.length; i++) {
    clip[i] *= gain * Math.min(1, i / fadeIn, (clip.length - 1 - i) / fadeOut);
  }
  let energy = 0;
  peak = 0;
  for (const value of clip) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
  return {
    id, base64: wav(clip), seconds: clip.length / SR, rms: Math.sqrt(energy / clip.length), shortRms: shortRms * gain, peak,
    layers: job.layers.map(layer => ({ bank: layer.bank, take: layer.take, at: layer.at, speed: +layer.speed.toFixed(4), gain: layer.gain })),
    tone: job.tone
  };
};
window.authorReady = true;
