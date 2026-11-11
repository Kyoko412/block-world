'use strict';
/* 确定性随机与噪声：所有世界生成都只用整数哈希，
   保证同一颗子在任何机器、任何时刻生成完全相同的地形。 */

export function hashStringToSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function normalizeSeed(input) {
  if (input === null || input === undefined || input === '') return hashStringToSeed('default');
  if (typeof input === 'number' && Number.isFinite(input)) return input >>> 0;
  const s = String(input).trim();
  if (/^-?\d+$/.test(s)) return (parseInt(s, 10) >>> 0);
  return hashStringToSeed(s);
}

export function ihash3(x, y, z, seed) {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h ^ (z | 0), 0x27d4eb2d) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

export function ihash2(x, y, seed) {
  return ihash3(x, y, 37, seed);
}

/* [0,1) 浮点 */
export function hashFloat(x, y, z, seed) {
  return ihash3(x, y, z, seed) / 4294967296;
}
export function hashFloat2(x, y, seed) {
  return ihash2(x, y, seed) / 4294967296;
}

export function mulberry32(a) {
  let t = a >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

export class ValueNoise2D {
  constructor(seed) { this.seed = seed >>> 0; }

  value(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const s = this.seed;
    const v00 = hashFloat2(xi, yi, s);
    const v10 = hashFloat2(xi + 1, yi, s);
    const v01 = hashFloat2(xi, yi + 1, s);
    const v11 = hashFloat2(xi + 1, yi + 1, s);
    const u = fade(xf), v = fade(yf);
    return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
  }

  /* 返回 [-1,1] */
  signed(x, y) { return this.value(x, y) * 2 - 1; }

  fbm(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.value(x * freq, y * freq);
      norm += amp;
      amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }
}

export class ValueNoise3D {
  constructor(seed) { this.seed = seed >>> 0; }

  value(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const s = this.seed;
    const u = fade(xf), v = fade(yf), w = fade(zf);
    const c000 = hashFloat(xi, yi, zi, s);
    const c100 = hashFloat(xi + 1, yi, zi, s);
    const c010 = hashFloat(xi, yi + 1, zi, s);
    const c110 = hashFloat(xi + 1, yi + 1, zi, s);
    const c001 = hashFloat(xi, yi, zi + 1, s);
    const c101 = hashFloat(xi + 1, yi, zi + 1, s);
    const c011 = hashFloat(xi, yi + 1, zi + 1, s);
    const c111 = hashFloat(xi + 1, yi + 1, zi + 1, s);
    const x00 = lerp(c000, c100, u), x10 = lerp(c010, c110, u);
    const x01 = lerp(c001, c101, u), x11 = lerp(c011, c111, u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
  }

  fbm(x, y, z, octaves = 3, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.value(x * freq, y * freq, z * freq);
      norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  }
}

/* 轻量 2D simplex 风格噪声（用两个 value 噪声叠加旋转得到更自然的纹理），
   用于生物群系与地形起伏的柔和过渡。 */
export class RidgedNoise2D {
  constructor(seed) { this.n = new ValueNoise2D(seed); }
  value(x, y) {
    const a = this.n.value(x, y);
    const b = this.n.value(x * 2.1 + 13.7, y * 2.1 - 9.3);
    return (a + b) * 0.5;
  }
}
