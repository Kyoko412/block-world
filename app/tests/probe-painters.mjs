/*
 * 画笔执行探针（Node，无需浏览器）：把每一种画笔真的跑一遍，读回像素。
 *
 * 为什么不能只断言「名字存在」：本轮南瓜缺失材质的根因是 pumpkin_front / lamp_top /
 * lamp_front 内部调用了不存在的自由变量（pumpkin_side / pumpkin_top / lamp_side），
 * dispatch() 的 try/catch 把它吃掉并画成品红 missing —— 名字一直在，图一直是错的。
 * 所以这里用最小 2D 上下文（painters.js 只用到 fillStyle / fillRect / clearRect）
 * 真执行每个画笔，逐像素读回，检查：
 *   ① dispatch 返回 true（不抛异常）；
 *   ② 像素不是 missingTexture 的品红/紫黑图案；
 *   ③ 不是整张空透明；
 *   ④ 关键面（南瓜正面、南瓜灯顶/正面）有该有的语义像素。
 *
 *   node tests/probe-painters.mjs [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKS, tileForFace } from '../renderer/js/core/blocks.js';
import { ITEMS } from '../renderer/js/core/items.js';
import { paintBlock, paintItem, paintMobTex, missingTexture, blockPainters, itemPainters, mobPainters } from '../renderer/js/gfx/painters.js';
import { mulberry32, hashStringToSeed } from '../renderer/js/core/rng.js';
import { encodeTileSheet } from './lib/png.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TILE = 16;

/* 最小 2D 上下文：只实现 painters.js 实际用到的三个入口，写成整数像素缓冲 */
class MockCtx {
  constructor(size = TILE) {
    this.size = size;
    this.fillStyle = '#000';
    this.stack = [];
    this.buf = new Uint8ClampedArray(size * size * 4);   // rgba，0 = 全透明
    this.style = 'rgb(0,0,0)';
    this.calls = 0;
  }
  save() { this.stack.push(this.fillStyle); }
  restore() { if (this.stack.length) this.fillStyle = this.stack.pop(); }
  clearRect(x, y, w, h) {
    const b = this.buf;
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
      if (i < 0 || j < 0 || i >= this.size || j >= this.size) continue;
      const o = (j * this.size + i) * 4; b[o] = b[o + 1] = b[o + 2] = b[o + 3] = 0;
    }
  }
  fillRect(x, y, w, h) {
    this.calls++;
    const c = parseColor(this.fillStyle);
    const b = this.buf;
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) {
      if (i < 0 || j < 0 || i >= this.size || j >= this.size) continue;
      const o = (j * this.size + i) * 4;
      if (c.a >= 0.999) { b[o] = c.r; b[o + 1] = c.g; b[o + 2] = c.b; b[o + 3] = 255; }
      else {   // 简易 alpha 混合（只在半透明叠加时用到）
        const a = c.a, ia = 1 - a, ba = b[o + 3] / 255;
        b[o] = (c.r * a + b[o] * ia * ba) / (a + ia * ba || 1);
        b[o + 1] = (c.g * a + b[o + 1] * ia * ba) / (a + ia * ba || 1);
        b[o + 2] = (c.b * a + b[o + 2] * ia * ba) / (a + ia * ba || 1);
        b[o + 3] = Math.max(b[o + 3], Math.round(a * 255));
      }
    }
  }
}

function parseColor(s) {
  if (typeof s !== 'string') return { r: 0, g: 0, b: 0, a: 1 };
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(',').map(v => parseFloat(v));
    return { r: p[0] | 0, g: p[1] | 0, b: p[2] | 0, a: p[3] === undefined ? 1 : p[3] };
  }
  const h = s.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return { r: parseInt(n.slice(0, 2), 16) || 0, g: parseInt(n.slice(2, 4), 16) || 0, b: parseInt(n.slice(4, 6), 16) || 0, a: 1 };
}

/* missingTexture 的参考指纹 */
const missRef = new MockCtx(TILE);
missingTexture(missRef, TILE);
const MISS = Buffer.from(missRef.buf);
/* missing 的四个确切颜色：只有「逐像素等于这四个色」才算 missing 图案。
   用色相/亮度区间判会误伤黑曜石（#241844 / #2c2150 也是暗紫）。 */
const MISS_COLORS = ['#ff2bff', '#d400d4', '#2b0030', '#4a0052'].map(hex => {
  const c = parseColor(hex); return c.r + ',' + c.g + ',' + c.b;
});

function analyze(ctx) {
  const b = ctx.buf;
  let opaque = 0, magenta = 0, purple = 0, colors = new Set(), sum = [0, 0, 0];
  for (let i = 0; i < b.length; i += 4) {
    const r = b[i], g = b[i + 1], bl = b[i + 2], a = b[i + 3];
    if (a < 40) continue;
    opaque++;
    colors.add((r >> 4) + ',' + (g >> 4) + ',' + (bl >> 4));
    sum[0] += r; sum[1] += g; sum[2] += bl;
    if (r > 190 && g < 90 && bl > 140) magenta++;                 // 品红本体
    if (MISS_COLORS.indexOf(r + ',' + g + ',' + bl) >= 0) purple++; // missing 的确切紫黑
  }
  return {
    opaque, magenta, purple, colorBuckets: colors.size,
    mean: opaque ? sum.map(v => Math.round(v / opaque)) : [0, 0, 0],
    identicalToMissing: Buffer.compare(Buffer.from(b), MISS) === 0,
    drawCalls: ctx.calls
  };
}

function runBlock(name) {
  const ctx = new MockCtx(TILE);
  const rand = mulberry32(hashStringToSeed('probe:' + name));
  const ok = paintBlock(name, ctx, rand, TILE);
  return Object.assign({ name, ok }, analyze(ctx));
}

function runItem(name) {
  const ctx = new MockCtx(TILE);
  const rand = mulberry32(hashStringToSeed('probe:item:' + name));
  const ok = paintItem(name, ctx, rand, TILE);
  return Object.assign({ name, ok }, analyze(ctx));
}

function runMob(name) {
  const ctx = new MockCtx(TILE);
  const rand = mulberry32(hashStringToSeed('probe:mob:' + name));
  const ok = paintMobTex(name, ctx, rand, TILE);
  return Object.assign({ name, ok }, analyze(ctx));
}

/* ---------- 收集真正会被图集/图标用到的所有名字 ---------- */
const faces = ['top', 'bottom', 'posx', 'negx', 'posz', 'negz'];
const tileNames = new Set();
for (let id = 1; id < BLOCKS.length; id++) {
  if (!BLOCKS[id]) continue;
  for (let meta = 0; meta <= 7; meta++) for (const f of faces) {
    const t = tileForFace(id, meta, f);
    if (typeof t === 'string' && t !== 'air') tileNames.add(t);
  }
}
const iconNames = new Set();
for (const key of Object.keys(ITEMS)) {
  const it = ITEMS[key];
  if (it.blockId !== undefined && it.blockId !== null) continue;
  iconNames.add(it.icon || key);
}

const results = { block: [], item: [], mob: [] };
for (const n of [...tileNames].sort()) results.block.push(runBlock(n));
for (const n of [...iconNames].sort()) results.item.push(runItem(n));
for (const n of Object.keys(mobPainters).sort()) results.mob.push(runMob(n));

/* 没注册画笔但被引用的名字（应走 missing），以及注册了但从没被引用的（记为 dead） */
const dead = {
  block: [...tileNames].filter(n => !results.block.find(r => r.name === n)),
  unregistered: [...tileNames].filter(n => typeof blockPainters[n] !== 'function'),
  itemUnregistered: [...iconNames].filter(n => typeof itemPainters[n] !== 'function')
};

const failures = [];
for (const group of ['block', 'item', 'mob']) {
  for (const r of results[group]) {
    if (!r.ok) failures.push(`${group}:${r.name} 画笔执行失败（dispatch=false，会露品红）`);
    else if (r.identicalToMissing) failures.push(`${group}:${r.name} 画出来与 missingTexture 完全相同`);
    else if (r.magenta > 0 || r.purple > 0) failures.push(`${group}:${r.name} 出现品红/紫黑像素 mag=${r.magenta} pur=${r.purple}`);
    else if (r.opaque === 0) failures.push(`${group}:${r.name} 画完是空的（全透明）`);
  }
}

/* ---------- 语义检查：三个曾经坏掉的面 ---------- */
const byName = (n) => results.block.find(r => r.name === n);
const semantics = {};
function facePixels(name, pred) {
  const ctx = new MockCtx(TILE);
  paintBlock(name, ctx, mulberry32(hashStringToSeed('probe:' + name)), TILE);
  let n = 0;
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const o = (y * TILE + x) * 4;
    if (ctx.buf[o + 3] < 40) continue;
    if (pred(ctx.buf[o], ctx.buf[o + 1], ctx.buf[o + 2], x, y)) n++;
  }
  return n;
}
/* 南瓜正面：carveFace 用 #3a2408 雕出深色眼/嘴（lum 很低且偏暖） */
semantics.pumpkin_front_face = facePixels('pumpkin_front', (r, g, b) => r < 90 && g < 70 && b < 40);
/* 南瓜灯顶部：核心 #f0b428 / #fff0a8，应有一块明亮的橙黄 */
semantics.lamp_top_core = facePixels('lamp_top', (r, g, b) => r > 200 && g > 150 && b < 140);
/* 南瓜灯正面：嘴线 #5b3a10（比灯身暗得多的暖棕横条） */
semantics.lamp_front_mouth = facePixels('lamp_front', (r, g, b) => r > 60 && r < 120 && g > 40 && g < 80 && b < 40);
semantics.pumpkin_side_rows = facePixels('pumpkin_side', (r, g, b) => r > 150 && g > 110 && b < 90);

for (const [k, v] of Object.entries(semantics)) {
  if (!(v > 0)) failures.push(`语义像素缺失：${k}（=0）`);
}

/* 用到的每个方块贴图都要能画出至少 2 档颜色（排除「能跑但整张一个色」的退化画笔） */
const flat = results.block.filter(r => r.ok && r.colorBuckets < 2).map(r => r.name);
for (const n of flat) failures.push('block:' + n + ' 只有 1 档颜色，铺满会像纯色贴图');

const summary = {
  at: new Date().toISOString(),
  tiles: results.block.length,
  icons: results.item.length,
  mobs: results.mob.length,
  failures,
  dead,
  semantics,
  pumpkin: {
    pumpkin_side: byName('pumpkin_side'),
    pumpkin_front: byName('pumpkin_front'),
    pumpkin_top: byName('pumpkin_top'),
    lamp_side: byName('lamp_side'),
    lamp_front: byName('lamp_front'),
    lamp_top: byName('lamp_top')
  },
  results
};

/* 出图：南瓜/南瓜灯的六个面 + 一小片林缘主材，肉眼可核对的「实际图像」 */
const sheetNames = ['pumpkin_top', 'pumpkin_side', 'pumpkin_front', 'lamp_top', 'lamp_side', 'lamp_front',
  'grass_top', 'grass_side', 'dirt', 'stone', 'cobblestone', 'planks', 'oak_log_side', 'oak_leaves', 'sand', 'water'];
const sheetDir = process.argv.includes('--png') ? process.argv[process.argv.indexOf('--png') + 1] : null;
if (sheetDir) {
  const tiles = sheetNames.map(n => {
    const ctx = new MockCtx(TILE);
    const ok = paintBlock(n, ctx, mulberry32(hashStringToSeed(n + '#' + 0)), TILE);
    return { name: n, ok, rgba: ctx.buf };
  });
  const sheet = encodeTileSheet(tiles, { scale: 8, cols: 8 });
  fs.writeFileSync(path.resolve(sheetDir), sheet.buffer);
  console.log('贴图对照表 → ' + path.resolve(sheetDir) + ' (' + sheet.width + '×' + sheet.height + ')');
}

const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx > 0 && process.argv[jsonIdx + 1]) {
  fs.writeFileSync(path.resolve(process.argv[jsonIdx + 1]), JSON.stringify(summary, null, 2));
}

console.log('画笔执行探针：方块贴图 ' + results.block.length + ' / 物品图标 ' + results.item.length + ' / 生物贴图 ' + results.mob.length);
for (const [k, v] of Object.entries(summary.pumpkin)) {
  console.log('  ' + k.padEnd(14) + ' ok=' + v.ok + ' 不透明=' + v.opaque + ' 色档=' + v.colorBuckets + ' 均值=' + v.mean.join(',') + (v.identicalToMissing ? '  ← 仍是 missing' : ''));
}
console.log('  语义像素：' + Object.entries(semantics).map(([k, v]) => k + '=' + v).join(' '));
if (failures.length) {
  console.log('\n失败 ' + failures.length + ' 项：');
  for (const f of failures.slice(0, 40)) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('\n全部画笔执行成功，无 missing 图案。');
}
