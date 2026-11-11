/*
 * 进食的两个合成层（确定性数学，最终导出为 WAV）。
 *   bite：几粒很短的碎裂噪声（面包/饼干那种干裂）
 *   gulp：低频下滑的「咕」，带一点点口水的湿边
 * 多汁的湿层复用战斗包的 squelch，保证同一套「湿」的语言。
 */
function rand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 碎裂：若干粒极短带通噪声，间隔不均，整体很快收干净。 */
export function crunch(seed, { seconds = 0.16, grains = 5, lo = 900, hi = 4200, sampleRate = 44100 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rnd = rand(seed);
  for (let g = 0; g < grains; g++) {
    const at = Math.floor((g / grains) * seconds * 0.7 * sampleRate + rnd() * 0.012 * sampleRate);
    const len = Math.floor((0.012 + rnd() * 0.02) * sampleRate);
    const centre = lo + (hi - lo) * (0.3 + rnd() * 0.7);
    const f = 2 * Math.sin(Math.PI * Math.min(0.45, centre / sampleRate));
    const damp = 0.55;
    let low = 0, band = 0;
    for (let i = 0; i < len && at + i < n; i++) {
      const input = rnd() * 2 - 1;
      low += f * band;
      const high = input - low - damp * band;
      band += f * high;
      const env = Math.exp(-i / (len * 0.32)) * Math.min(1, i / 40);
      out[at + i] += band * env;
    }
  }
  return out;
}

/** 吞咽：低频下滑 + 一点点湿边，0.24 秒内收住。 */
export function gulp(seed, { seconds = 0.24, sampleRate = 44100 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rnd = rand(seed);
  let phase = 0;
  let low = 0, band = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const u = Math.min(1, t / seconds);
    const freq = 190 * Math.pow(0.42, u);
    phase += (2 * Math.PI * freq) / sampleRate;
    const env = Math.sin(Math.PI * Math.pow(u, 0.6)) * Math.exp(-t / (seconds * 0.55));
    const input = rnd() * 2 - 1;
    const f = 2 * Math.sin(Math.PI * Math.min(0.45, 700 / sampleRate));
    low += f * band;
    const high = input - low - 0.8 * band;
    band += f * high;
    out[i] = (Math.sin(phase) * 0.8 + band * 0.16) * env;
  }
  return out;
}
