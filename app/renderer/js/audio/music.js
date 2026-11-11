'use strict';
/*
 * music.js —— 程序化音乐兜底与环境声场景选择（本文件不读音频文件）。
 *
 * 阶段 4 之后它的身份变了但仍然重要：它是**兜底编排**。
 * 三首主曲默认改由随包外部曲目出声（`core/musicfiles.js` 的 FILE_TRACKS，
 * 由 `sfx.js` 按场景选择：文件解码就绪就用文件，没就绪/失败/被关掉就用这里），
 * 环境床改用 core/ambientfiles.js 的真实录音，本文件末尾只保留场景与遮蔽选择。
 *
 * 三首主曲（8 小节，每首都有明确动机并至少重复/变化重复一次）：
 *   day   78 BPM，C 大调五声音阶，拨弦 + 柔和 pad + 轻低音；
 *   night 62 BPM，音乐盒/钟琴 + 低音 pad，大量留白；
 *   cave  无固定节拍，低频 drone + 偶发滴水，32 秒一轮。
 *
 * 同一份 scheduleTrack() 同时给实时 AudioContext 与 OfflineAudioContext 使用，
 * 所以 artifacts/audio/*.wav 是用真实编曲代码离线渲染出来的，不是另写一套。
 */

const PENTA = {
  C3: 130.81, D3: 146.83, E3: 164.81, G3: 196.0, A3: 220.0,
  C4: 261.63, D4: 293.66, E4: 329.63, G4: 392.0, A4: 440.0,
  C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.0,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, A6: 1760.0,
  C2: 65.41, A2: 110.0, G2: 98.0, E2: 82.41
};

/* 一天的动机：C-E-G-A 上行，第 3 小节变成 A-G-E-D，第 5 小节原样回来 */
const DAY_MOTIF = [
  { b: 0.0, n: 'C5', d: 0.5, v: 0.9 }, { b: 0.5, n: 'E5', d: 0.5, v: 0.8 },
  { b: 1.0, n: 'G5', d: 0.5, v: 0.85 }, { b: 1.5, n: 'A5', d: 1.0, v: 0.95 },
  { b: 2.5, n: 'G5', d: 0.5, v: 0.7 }, { b: 3.0, n: 'E5', d: 1.0, v: 0.8 }
];
const dayEvents = [];
const dayBars = [
  // 第 1~2 小节：陈述
  DAY_MOTIF,
  DAY_MOTIF.map(e => Object.assign({}, e, { b: e.b + 4 })),
  // 第 3~4 小节：变化（下行答句）
  [{ b: 8, n: 'A5', d: 0.5, v: 0.9 }, { b: 8.5, n: 'G5', d: 0.5, v: 0.8 },
    { b: 9, n: 'E5', d: 0.5, v: 0.8 }, { b: 9.5, n: 'D5', d: 1, v: 0.85 },
    { b: 11, n: 'C5', d: 1.2, v: 0.9 }],
  [{ b: 12, n: 'E5', d: 0.5, v: 0.7 }, { b: 13, n: 'G5', d: 0.5, v: 0.75 },
    { b: 14, n: 'A5', d: 1.4, v: 0.9 }],
  // 第 5~6 小节：动机原样回来（重复）
  DAY_MOTIF.map(e => Object.assign({}, e, { b: e.b + 16 })),
  DAY_MOTIF.map(e => Object.assign({}, e, { b: e.b + 20 })),
  // 第 7~8 小节：变化重复 + 收束
  [{ b: 24, n: 'G5', d: 0.5, v: 0.85 }, { b: 24.5, n: 'A5', d: 0.5, v: 0.85 },
    { b: 25, n: 'C6', d: 1, v: 0.95 }, { b: 26.5, n: 'A5', d: 0.5, v: 0.7 },
    { b: 27, n: 'G5', d: 1, v: 0.75 }],
  [{ b: 28, n: 'E5', d: 0.5, v: 0.75 }, { b: 28.5, n: 'G5', d: 0.5, v: 0.8 },
    { b: 29, n: 'C5', d: 2.4, v: 0.9 }]
];
for (const bar of dayBars) dayEvents.push(...bar);

/* 夜晚动机：C6-G5-E6-A6，稀疏；第 5 小节换低八度变化重复 */
const NIGHT_MOTIF = [
  { b: 0, n: 'C6', d: 1.2, v: 0.8 }, { b: 1.5, n: 'G5', d: 1.4, v: 0.7 },
  { b: 3, n: 'E6', d: 1.0, v: 0.75 }, { b: 4.5, n: 'A6', d: 1.6, v: 0.8 },
  { b: 6, n: 'G6', d: 1.0, v: 0.65 }, { b: 7.5, n: 'E6', d: 1.8, v: 0.7 }
];
const nightEvents = [
  ...NIGHT_MOTIF,
  ...NIGHT_MOTIF.map(e => Object.assign({}, e, { b: e.b + 8, v: e.v * 0.8 })),
  { b: 16, n: 'C6', d: 1.4, v: 0.75 }, { b: 17.5, n: 'A5', d: 1.2, v: 0.6 },
  { b: 19, n: 'G5', d: 1.6, v: 0.65 }, { b: 21, n: 'E6', d: 2.2, v: 0.7 },
  ...NIGHT_MOTIF.map(e => Object.assign({}, e, { b: e.b + 24, v: e.v * 0.85 })),
  { b: 30, n: 'C6', d: 1.8, v: 0.7 }
];

const DAY = {
  id: 'day', section: 'day', bpm: 78, bars: 8, beatsPerBar: 4,
  loopSeconds: 8 * 4 * 60 / 78,
  motif: DAY_MOTIF.map(e => e.n),
  events: dayEvents,
  chords: [
    { b: 0, notes: ['C3', 'G3', 'E4'], d: 7.5, v: 0.5 },
    { b: 8, notes: ['A2', 'E3', 'C4'], d: 7.5, v: 0.45 },
    { b: 16, notes: ['C3', 'G3', 'E4'], d: 7.5, v: 0.5 },
    { b: 24, notes: ['G2', 'D3', 'G3'], d: 7.5, v: 0.45 }
  ],
  bass: [
    { b: 0, n: 'C2', d: 2, v: 0.5 }, { b: 4, n: 'G2', d: 2, v: 0.45 },
    { b: 8, n: 'A2', d: 2, v: 0.45 }, { b: 12, n: 'E2', d: 2, v: 0.4 },
    { b: 16, n: 'C2', d: 2, v: 0.5 }, { b: 20, n: 'G2', d: 2, v: 0.45 },
    { b: 24, n: 'G2', d: 2, v: 0.45 }, { b: 28, n: 'C2', d: 2.5, v: 0.5 }
  ]
};

const NIGHT = {
  id: 'night', section: 'night', bpm: 62, bars: 8, beatsPerBar: 4,
  loopSeconds: 8 * 4 * 60 / 62,
  motif: NIGHT_MOTIF.map(e => e.n),
  events: nightEvents,
  chords: [
    { b: 0, notes: ['C3', 'G3'], d: 15, v: 0.4 },
    { b: 16, notes: ['A2', 'E3'], d: 15, v: 0.38 }
  ],
  bass: [
    { b: 0, n: 'C2', d: 6, v: 0.34 }, { b: 16, n: 'A2', d: 6, v: 0.32 }
  ]
};

/* 洞穴：无固定节拍，drone 分 4 段，每段有一个主题音高组合；滴水是确定的时刻，不是随机 */
const CAVE = {
  id: 'cave', section: 'cave', bpm: null, bars: 8, beatsPerBar: 4,
  loopSeconds: 32,
  motif: ['drone-C', 'drone-G', 'shimmer', 'drip'],
  events: [],
  drones: [
    { t: 0, dur: 9.5, notes: [55, 82.5], v: 0.14 },
    { t: 8, dur: 9.5, notes: [65.41, 98], v: 0.12 },
    { t: 16, dur: 9.5, notes: [55, 82.5], v: 0.13 },
    { t: 24, dur: 8, notes: [49, 73.5], v: 0.10 }
  ],
  drips: [
    { t: 3.1, v: 0.8 }, { t: 7.7, v: 0.6 }, { t: 12.9, v: 0.75 },
    { t: 18.4, v: 0.55 }, { t: 23.2, v: 0.7 }, { t: 27.5, v: 0.5 }
  ],
  shimmers: [{ t: 10.5, v: 0.35 }, { t: 20.8, v: 0.3 }]
};

export const TRACKS = { day: DAY, night: NIGHT, cave: CAVE };
export const TRACK_IDS = ['day', 'night', 'cave'];

export function trackInfo(id) {
  const t = TRACKS[id];
  if (!t) return null;
  return { id: t.id, section: t.section, bpm: t.bpm, bars: t.bars, loopSeconds: +t.loopSeconds.toFixed(3), motif: t.motif.slice() };
}

/* ---------- 小工具：所有包络首尾都回到 0，避免爆音 ---------- */
function env(param, t, dur, peak, atk = 0.02, hold = 0.12) {
  const p = Math.max(0.0003, peak);
  const a = Math.max(0.004, atk);
  const h = Math.max(t + a, t + dur * hold);
  try {
    param.setValueAtTime(0.0001, t);
    param.linearRampToValueAtTime(p, t + a);
    param.setValueAtTime(p, Math.min(h, t + dur * 0.8));
    param.exponentialRampToValueAtTime(0.0001, t + dur);
    param.setValueAtTime(0, t + dur + 0.01);
  } catch (e) { try { param.value = p * 0.5; } catch (e2) { /* ignore */ } }
}

function osc(ctx, dest, type, freq, t, dur, peak, opts = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  try { o.type = type; } catch (e) { /* ignore */ }
  o.frequency.setValueAtTime(freq, t);
  if (opts.to) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t + dur);
  if (opts.detune) o.detune.value = opts.detune;
  o.connect(g);
  let tail = g;
  if (opts.lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = opts.lp;
    g.connect(f);
    tail = f;
  }
  // 没有滤波时 tail 就是 g：不能再 g.connect(g)（自环会把声音变成 NaN/静音）
  tail.connect(dest);
  env(g.gain, t, dur, peak, opts.atk === undefined ? 0.02 : opts.atk, opts.hold === undefined ? 0.14 : opts.hold);
  try { o.start(t); o.stop(t + dur + 0.03); } catch (e) { /* ignore */ }
  return { o, g, tail };
}

function pluck(ctx, dest, freq, t, dur, gain, pan = 0) {
  let out = dest;
  if (pan && ctx.createStereoPanner) {
    try { const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(dest); out = p; } catch (e) { /* ignore */ }
  }
  const a = osc(ctx, out, 'triangle', freq, t, dur, gain * 0.7, { atk: 0.008, hold: 0.05, lp: 4200 });
  const b = osc(ctx, out, 'sine', freq * 2, t, dur * 0.7, gain * 0.22, { atk: 0.006, hold: 0.04 });
  return [a, b];
}

function musicBox(ctx, dest, freq, t, dur, gain, pan = 0) {
  let out = dest;
  if (pan && ctx.createStereoPanner) {
    try { const p = ctx.createStereoPanner(); p.pan.value = pan; p.connect(dest); out = p; } catch (e) { /* ignore */ }
  }
  return [
    osc(ctx, out, 'sine', freq, t, dur, gain, { atk: 0.006, hold: 0.06 }),
    osc(ctx, out, 'sine', freq * 3, t, dur * 0.55, gain * 0.22, { atk: 0.004, hold: 0.05 }),
    osc(ctx, out, 'sine', freq * 5.04, t, dur * 0.32, gain * 0.08, { atk: 0.004, hold: 0.04 })
  ];
}

function pad(ctx, dest, freqs, t, dur, gain) {
  for (let i = 0; i < freqs.length; i++) {
    osc(ctx, dest, i === 0 ? 'triangle' : 'sine', freqs[i], t, dur, gain / (1 + i * 0.6),
      { atk: Math.min(4, dur * 0.2), hold: 0.5, detune: (i - 1) * 4, lp: 1400 });
  }
}

function bass(ctx, dest, freq, t, dur, gain) {
  osc(ctx, dest, 'sine', freq, t, dur, gain, { atk: 0.01, hold: 0.2, lp: 500 });
}

function drone(ctx, dest, freqs, t, dur, gain) {
  for (let i = 0; i < freqs.length; i++) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    o.type = i === 0 ? 'sine' : 'triangle';
    o.frequency.value = freqs[i];
    if (o.detune) o.detune.value = i * 3;
    lfo.type = 'sine'; lfo.frequency.value = 0.08 + i * 0.03;
    lg.gain.value = freqs[i] * 0.006;
    lfo.connect(lg); lg.connect(o.frequency);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain / (1 + i * 0.8), t + 2.2);
    g.gain.setValueAtTime(gain / (1 + i * 0.8), t + Math.max(2.3, dur - 2.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    try { lfo.start(t); lfo.stop(t + dur + 0.05); } catch (e) { /* ignore */ }
    try { o.start(t); o.stop(t + dur + 0.05); } catch (e) { /* ignore */ }
  }
}

function drip(ctx, dest, t, gain) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(1250, t);
  o.frequency.exponentialRampToValueAtTime(280, t + 0.12);
  env(g.gain, t, 0.22, gain * 0.35, 0.004, 0.1);
  o.connect(g); g.connect(dest);
  try { o.start(t); o.stop(t + 0.24); } catch (e) { /* ignore */ }
  // 一点洞壁回声，仍由代码合成
  const o2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  o2.type = 'sine';
  o2.frequency.setValueAtTime(980, t + 0.16);
  o2.frequency.exponentialRampToValueAtTime(240, t + 0.30);
  env(g2.gain, t + 0.16, 0.24, gain * 0.12, 0.006, 0.1);
  o2.connect(g2); g2.connect(dest);
  try { o2.start(t + 0.16); o2.stop(t + 0.42); } catch (e) { /* ignore */ }
}

/**
 * 安排一整首（可指定循环次数）到 dest。
 * @returns {number} 结束时间（秒，AudioContext 时间轴）
 */
export function scheduleTrack(ctx, dest, opts = {}) {
  const track = TRACKS[opts.id] || opts.track || DAY;
  const start = opts.start === undefined ? 0 : opts.start;
  const loops = Math.max(1, opts.loops || 1);
  const gain = opts.gain === undefined ? 1 : opts.gain;
  const beat = track.bpm ? 60 / track.bpm : 0;
  for (let k = 0; k < loops; k++) {
    const base = start + k * track.loopSeconds;
    if (track.id === 'cave') {
      for (const d of track.drones) drone(ctx, dest, d.notes, base + d.t, d.dur, d.v * gain);
      for (const d of track.drips) drip(ctx, dest, base + d.t, d.v * gain);
      for (const s of track.shimmers) {
        pluck(ctx, dest, 1760, base + s.t, 2.4, s.v * gain, -0.35);
        pluck(ctx, dest, 2637, base + s.t + 0.35, 1.8, s.v * gain * 0.6, 0.4);
      }
      continue;
    }
    for (const e of track.events) {
      const t = base + e.b * beat;
      const dur = Math.max(0.12, e.d * beat);
      const f = PENTA[e.n] || 440;
      if (track.id === 'day') pluck(ctx, dest, f, t, dur * 1.35, e.v * 0.13 * gain, (e.n.endsWith('5') ? 0.35 : -0.25));
      else musicBox(ctx, dest, f, t, Math.max(1.2, dur * 2.2), e.v * 0.11 * gain, (e.n.endsWith('6') ? 0.3 : -0.3));
    }
    for (const c of track.chords || []) {
      const t = base + c.b * beat;
      pad(ctx, dest, c.notes.map(n => PENTA[n] || 220), t, Math.max(2, c.d * beat), c.v * 0.055 * gain);
    }
    for (const b of track.bass || []) {
      const t = base + b.b * beat;
      bass(ctx, dest, PENTA[b.n] || 65, t, Math.max(0.4, b.d * beat), b.v * 0.11 * gain);
    }
  }
  return start + loops * track.loopSeconds;
}

/* ---------- 环境床选择（纯函数，可单测） ---------- */
export const AMBIENT_IDS = ['wind', 'insects', 'cave', 'rain', 'underwater'];

export function selectAmbient(state = {}) {
  const intensity = state.intensity === undefined ? 1 : state.intensity;
  if (state.underwater) return 'underwater';
  if (state.underground) return 'cave';
  if (state.weather === 'rain' && intensity > 0.05) return 'rain';
  if (state.weather === 'snow') return 'wind';
  if (state.night) return 'insects';
  return 'wind';
}

/** 同一场景里的遮蔽只调混音，进屋不会突然把雨换成晴天。 */
export function ambientMix(state = {}) {
  const id = selectAmbient(state);
  if (id === 'underwater') return { gain: 1, lowpass: 1200 };
  if (id === 'cave') return { gain: 1, lowpass: 8000 };
  if (id === 'rain') {
    const intensity = Math.max(0, Math.min(1, Number.isFinite(state.intensity) ? state.intensity : 1));
    return { gain: (0.25 + intensity * 0.75) * (state.sheltered ? 0.35 : 1), lowpass: state.sheltered ? 1100 : 8000 };
  }
  if (state.weather === 'snow') return { gain: state.sheltered ? 0.3 : 0.6, lowpass: 1700 };
  return { gain: state.sheltered ? 0.55 : 1, lowpass: state.sheltered ? 2400 : 12000 };
}
