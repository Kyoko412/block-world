/*
 * 洞穴常驻低频的 A/B（本轮 D1）。
 *   cd app && npx electron tests/probe-cave-bed.mjs
 *
 * 背景：审计测到「洞穴录音 99.86% 能量在 120Hz 以下，最强约 49.8Hz」，代码里对应的就是
 * 48Hz 正弦（gain 0.6）+ 72Hz 三角（0.22）这条**常驻**低频床。
 *
 * 这个脚本做的是一件明确的事：在同一台机器、同一套 WebAudio 里，用**旧参数**与**新参数**
 * 各合成 8 秒床声，量它们的频段能量并落盘 WAV，作为参数改动的 A/B。
 * 它不冒充游戏录音 —— 真实游戏里的洞穴段落由 tests/render-audio-r1.mjs 交付。
 *
 * 旧：48Hz sine @0.6 + 72Hz triangle @0.22（LFO 0.06/0.08）
 * 新：52Hz sine @0.085 + 空气层（噪声→低通 700Hz）@0.022 + 滴水（1.6~3.4s，带回声）
 *     —— 与新代码 sfx.js 的 _buildAmbient('cave') 一致。
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'audio', 'round1', 'cave-ab');
fs.mkdirSync(OUT, { recursive: true });

function writeWav(file, f32, sr) {
  const n = f32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return buf.length;
}

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 480, height: 320, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html,<html><body>cave-ab</body></html>');
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');

  const res = await evl(`
    const SR = 48000, DUR = 8;
    const makeNoise = (ctx) => {
      const noise = ctx.createBuffer(1, SR * 2, SR);
      const nd = noise.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
      return noise;
    };

    /* 每种设计各渲染一条独立轨道（上一版把两种混在同一个 8 秒上下文里，第二段读到越界 → NaN） */
    const renderBed = async (which) => {
      const ctx = new OfflineAudioContext(1, SR * DUR, SR);
      const noise = makeNoise(ctx);
      const out = ctx.createGain(); out.gain.value = 1; out.connect(ctx.destination);
      if (which === 'old') {
        for (let i = 0; i < 2; i++) {
          const o = ctx.createOscillator(); const g = ctx.createGain();
          const lfo = ctx.createOscillator(); const lg = ctx.createGain();
          o.type = i === 0 ? 'sine' : 'triangle';
          o.frequency.value = i === 0 ? 48 : 72;
          lfo.frequency.value = 0.06 + i * 0.02;
          lg.gain.value = 1.5 + i;
          lfo.connect(lg); lg.connect(o.frequency);
          g.gain.value = (i === 0 ? 0.6 : 0.22);
          o.connect(g); g.connect(out); o.start(0); lfo.start(0);
        }
      } else {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        const lfo = ctx.createOscillator(); const lg = ctx.createGain();
        o.type = 'sine'; o.frequency.value = 52; lfo.frequency.value = 0.05; lg.gain.value = 1.2;
        lfo.connect(lg); lg.connect(o.frequency);
        g.gain.value = 0.085; o.connect(g); g.connect(out); o.start(0); lfo.start(0);
        const air = ctx.createBufferSource(); air.buffer = noise; air.loop = true;
        const af = ctx.createBiquadFilter(); af.type = 'lowpass'; af.frequency.value = 700; af.Q.value = 0.6;
        const ag = ctx.createGain(); ag.gain.value = 0.075;
        air.connect(af); af.connect(ag); ag.connect(out); air.start(0);
        const det = ctx.createBufferSource(); det.buffer = noise; det.loop = true;
        const df = ctx.createBiquadFilter(); df.type = 'bandpass'; df.frequency.value = 1200; df.Q.value = 0.9;
        const dg = ctx.createGain(); dg.gain.value = 0.018;
        det.connect(df); df.connect(dg); dg.connect(out); det.start(0);
        for (const at of [0.6, 2.4, 4.9, 6.7]) {
          const d = ctx.createOscillator(); const dg = ctx.createGain();
          d.type = 'sine';
          d.frequency.setValueAtTime(1000, at);
          d.frequency.exponentialRampToValueAtTime(240, at + 0.16);
          dg.gain.setValueAtTime(0.0001, at);
          dg.gain.linearRampToValueAtTime(0.05, at + 0.006);
          dg.gain.exponentialRampToValueAtTime(0.0001, at + 0.28);
          d.connect(dg); dg.connect(out); d.start(at); d.stop(at + 0.3);
          const e = ctx.createOscillator(); const eg = ctx.createGain();
          e.type = 'sine';
          e.frequency.setValueAtTime(820, at + 0.07);
          e.frequency.exponentialRampToValueAtTime(200, at + 0.26);
          eg.gain.setValueAtTime(0.0001, at + 0.07);
          eg.gain.linearRampToValueAtTime(0.018, at + 0.076);
          eg.gain.exponentialRampToValueAtTime(0.0001, at + 0.34);
          e.connect(eg); eg.connect(out); e.start(at + 0.07); e.stop(at + 0.36);
        }
      }
      const buf = await ctx.startRendering();
      return buf.getChannelData(0);
    };

    const doBand = async (seg, type, freq, q) => {
      const n = seg.length;
      const off = new OfflineAudioContext(1, n, SR);
      const b = off.createBuffer(1, n, SR); b.copyToChannel(seg, 0);
      const src = off.createBufferSource(); src.buffer = b;
      const f = off.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q === undefined ? 0.707 : q;
      src.connect(f); f.connect(off.destination); src.start();
      const o = await off.startRendering(); const d = o.getChannelData(0);
      let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i];
      return Math.sqrt(s / d.length);
    };

    const measure = async (which) => {
      const seg = await renderBed(which);
      const n = seg.length;
      let sum = 0; for (let i = 0; i < n; i++) sum += seg[i] * seg[i];
      const rms = Math.sqrt(sum / n);
      const low = await doBand(seg, 'lowpass', 120);
      const air = await doBand(seg, 'bandpass', 400, 0.8);
      const hi = await doBand(seg, 'highpass', 2000);
      const det = await doBand(seg, 'bandpass', 1200, 0.9);
      const pack = new Float32Array(n);
      pack.set(seg);
      const bytes = new Uint8Array(pack.buffer);
      let s4 = ''; const CH = 8192;
      for (let i = 0; i < bytes.length; i += CH) s4 += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return { rms: +rms.toFixed(6), low120: +low.toFixed(6), air400: +air.toFixed(6), detail1200: +det.toFixed(6), high: +hi.toFixed(6),
        b64: btoa(s4), samples: n };
    };
    const oldM = await measure('old');
    const newM = await measure('new');
    return { sr: SR, old: oldM, new: newM };
  `);

  for (const k of ['old', 'new']) {
    const f32 = new Float32Array(Buffer.from(res[k].b64, 'base64').buffer.slice(0));
    writeWav(path.join(OUT, 'cave-bed-' + k + '.wav'), f32, res.sr);
    delete res[k].b64;
  }
  const out = {
    at: new Date().toISOString(),
    note: '旧/新洞穴常驻低频床的离线合成 A/B（参数来自 sfx.js 的 _buildAmbient）。不是游戏录音。',
    sampleRate: res.sr,
    old: res.old, new: res.new,
    /* 频段之间的绝对电平比较（dB），不用「占比」：低通/带通在 Biquad 里带一点通带增益，
       RMS 比值可能略大于 1，写成占比会误导。A/B 关心的是同一个频段有没有变、变了多少 dB。 */
    delta: {
      lowDb: +(20 * Math.log10(res.new.low120 / res.old.low120)).toFixed(2),
      airDb: +(20 * Math.log10(res.new.air400 / res.old.air400)).toFixed(2),
      detailDb: +(20 * Math.log10(res.new.detail1200 / Math.max(1e-9, res.old.detail1200))).toFixed(2),
      totalDb: +(20 * Math.log10(res.new.rms / res.old.rms)).toFixed(2)
    }
  };
  fs.writeFileSync(path.join(OUT, 'cave-bed-ab.json'), JSON.stringify(out, null, 2));
  console.log('洞穴常驻低频 A/B：');
  console.log('  旧  rms=' + res.old.rms + '  ≤120Hz=' + res.old.low120 + '  空气400Hz=' + res.old.air400 + '  细节1.2k=' + res.old.detail1200);
  console.log('  新  rms=' + res.new.rms + '  ≤120Hz=' + res.new.low120 + '  空气400Hz=' + res.new.air400 + '  细节1.2k=' + res.new.detail1200);
  console.log('  变化：低频 ' + out.delta.lowDb + ' dB / 空气 ' + out.delta.airDb + ' dB / 细节 ' + out.delta.detailDb + ' dB / 总 ' + out.delta.totalDb + ' dB');
  console.log('→ ' + path.join(OUT, 'cave-bed-ab.json'));
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
