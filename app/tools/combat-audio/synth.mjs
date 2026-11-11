/*
 * 制作端的两个合成层（不出现在游戏运行期，最终仍导出成 WAV）。
 *
 * 为什么要合成：
 *   · 真实 CC0 撞击录音能给出「撞」的力度，但缺一层湿的、被挤压的组织感；
 *   · 盾牌要是钢的，需要一段真正的金属共振尾巴，单靠一条短撞击录音撑不出来。
 *
 * 这两个层都只用确定性数学（无第三方素材、无采样拼接），参数写进登记表，可复现。
 */

/* 确定性伪随机：同一 seed 每次都得到同一段声音，重导出不会漂。 */
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

/* 简易状态变量带通：噪声过一遍，中心频率随时间扫动，得到「湿」的挤压感。 */
export function squelch(seed, { seconds = 0.16, from = 1050, to = 320, q = 3.2, wobble = 42, sampleRate = 44100 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rnd = rand(seed);
  let low = 0, band = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const u = t / seconds;
    const centre = from * Math.pow(to / from, Math.min(1, u));
    const f = 2 * Math.sin(Math.PI * Math.min(0.45, centre / sampleRate));
    const damp = 1 / Math.max(0.7, q);
    const input = rnd() * 2 - 1;
    low += f * band;
    const high = input - low - damp * band;
    band += f * high;
    /* 包络：2ms 起音 + 指数衰减 + 一点挤压抖动 */
    const attack = Math.min(1, t / 0.002);
    const decay = Math.exp(-t / (seconds * 0.34));
    const wet = 1 + 0.25 * Math.sin(2 * Math.PI * wobble * t);
    out[i] = band * attack * decay * wet * 0.9;
  }
  return out;
}

/* 金属共振：几条不成谐波关系的分音 + 极短的撞击噪声。 */
export function metalRing(seed, { seconds = 0.5, base = 720, sampleRate = 44100 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rnd = rand(seed);
  const ratios = [1, 2.76, 5.4, 8.93, 13.3];
  const gains = [1, 0.62, 0.4, 0.24, 0.12];
  const detune = 1 + (seed % 7) * 0.0016;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let value = 0;
    for (let k = 0; k < ratios.length; k++) {
      const freq = base * ratios[k] * detune;
      if (freq > sampleRate * 0.45) continue;
      const decay = Math.exp(-t / (seconds * (0.55 - k * 0.07)));
      value += Math.sin(2 * Math.PI * freq * t) * gains[k] * decay;
    }
    const click = t < 0.006 ? (rnd() * 2 - 1) * (1 - t / 0.006) * 0.5 : 0;
    out[i] = (value * 0.42 + click) * Math.min(1, t / 0.0015);
  }
  return out;
}

/* 挥击：噪声经扫频带通（600→3000Hz），干声、无混响、带一点 lo-fi 粗糙。 */
export function whoosh(seed, { seconds = 0.22, from = 600, to = 3000, q = 1.6, sampleRate = 44100 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rnd = rand(seed);
  let low = 0, band = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const u = Math.min(1, t / seconds);
    const centre = from * Math.pow(to / from, u);
    const f = 2 * Math.sin(Math.PI * Math.min(0.45, centre / sampleRate));
    const damp = 1 / Math.max(0.7, q);
    const input = rnd() * 2 - 1;
    low += f * band;
    const high = input - low - damp * band;
    band += f * high;
    /* 中间最响、两头收干净：像一件东西抡过去，而不是一团持续的风 */
    const shape = Math.sin(Math.PI * Math.pow(u, 0.75));
    out[i] = band * shape * 0.9;
  }
  return out;
}

/* 80Hz 身体闷击：只有很短的一下，没有尾巴。 */
export function bodyThump(seed, { seconds = 0.14, freq = 80, sampleRate = 44100 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.032) * Math.min(1, t / 0.002);
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.9;
  }
  return out;
}

/* 极短的 2kHz 金属尖：一个 tick，不共振、不拖尾。 */
export function metalTick(seed, { seconds = 0.03, freq = 2000, sampleRate = 44100 } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rnd = rand(seed);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.0055);
    const tone = Math.sin(2 * Math.PI * freq * t) * 0.75 + Math.sin(2 * Math.PI * freq * 1.9 * t) * 0.15;
    const click = t < 0.002 ? (rnd() * 2 - 1) * 0.3 : 0;
    out[i] = (tone + click) * env * Math.min(1, t / 0.0006);
  }
  return out;
}
