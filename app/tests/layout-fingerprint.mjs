'use strict';
/*
 * 布局指纹（阶段 1 · 索引参数化 / 深地布局的验收工具）
 *
 * 用途：把「同一组种子的世界内容」压成一个哈希，用来证明两件事
 *   1) 第 2 刀（索引参数化）行为中性：当前工作树的哈希必须与改造前的提交逐位相同。
 *   2) 第 3 刀（负 Y 深地）只影响新档：genVersion=0 的哈希必须仍等于改造前的常数，
 *      只有 genVersion=1 才允许变成新值。
 *   单测里钉死了 genVersion=0 的常数（`阶段1 索引参数化`），所以第 3 刀一旦顺手改坏了
 *   旧档地形/光照，单测门禁当场就红。
 *
 * 覆盖的数据：每个区块的 blocks/meta/light/heightMap/biome 全数组、
 * makeSampler 在整块 + 四条接缝 ±1 格、y 在布局上下各多探 2 格时的 getBlock/getLight 返回值、
 * 挖掘/放置后的 serializeEdits()、以及布局外越界写入必须被拒绝。
 *
 * 用法（Git Bash）：
 *   cd app && env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS node tests/layout-fingerprint.mjs
 *   ... node tests/layout-fingerprint.mjs --root E:/mc-wt-49f194e/app   # 指纹另一棵工作树
 *   ... node tests/layout-fingerprint.mjs --gen deep                    # 新档深地布局
 *   两棵树/两个版本各跑一遍，对比输出的 hash 字段。
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');                 // app/ 目录
const SEEDS = [12345, 7, 20261107, 424242, 1, 999983];

/**
 * @param root  被指纹的 app/ 目录（默认本工作树）
 * @param gen   'legacy' | 'deep'，对应 VoxelWorld 的 genVersion
 * @returns {Promise<{root:string, gen:string, layout:object, hash:string, perSeed:string[], warnings:string[]}>}
 */
export async function runFingerprint(root = APP_DIR, gen = 'legacy') {
  const ROOT = pathToFileURL(root).href;
  const { VoxelWorld, GEN_LEGACY, GEN_DEEP } = await import(ROOT + '/renderer/js/world/world.js');
  const { lightChunk } = await import(ROOT + '/renderer/js/world/lighting.js');
  const { makeSampler } = await import(ROOT + '/renderer/js/world/mesher.js');

  /* FNV-1a 32 位：只做「逐位相同」判定，不做加密。 */
  let h = 0x811c9dc5 >>> 0;
  const mix = (n) => { h ^= (n | 0) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; };
  const mixArr = (a) => { for (let i = 0; i < a.length; i++) mix(a[i]); };
  const warnings = [];

  const opts = { genVersion: gen === 'deep' ? GEN_DEEP : GEN_LEGACY };
  const perSeed = [];
  let layout = null;

  for (const seed of SEEDS) {
    const w = new VoxelWorld(seed, opts);
    if (!layout) layout = { genVersion: w.genVersion, minY: w.minY, topY: w.topY, layers: w.layers };
    /* 布局来自世界自己：第 2 刀之后不能再假设 y 从 0 开始。
       上下各多探 2 格，专门盯住「越界返回值」这条最容易串味的地方。 */
    const yLo = (Number.isFinite(w.minY) ? w.minY : 0) - 2;
    const yHi = (Number.isFinite(w.topY) ? w.topY : 64) + 2;

    const CS = [];
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) CS.push([cx, cz]);
    for (const [cx, cz] of CS) w.ensureChunk(cx, cz);                       // 全部先生成
    for (const [cx, cz] of CS) lightChunk(w.chunks.get(cx + ',' + cz), w);  // 再统一补光（含接缝近似）

    for (const [cx, cz] of CS) {
      const c = w.chunks.get(cx + ',' + cz);
      mixArr(c.blocks); mixArr(c.meta); mixArr(c.light); mixArr(c.heightMap); mixArr(c.biome);
      const s = makeSampler(c, w);
      const x0 = cx * 16, z0 = cz * 16;
      for (let y = yLo; y <= yHi; y++)
        for (let lz = -1; lz <= 16; lz++)
          for (let lx = -1; lx <= 16; lx++) {
            mix(s.getBlock(x0 + lx, y, z0 + lz));
            mix(s.getLight(x0 + lx, y, z0 + lz));
          }
    }

    // 挖掘 / 放置往返，含布局外的越界写入（必须一律被拒绝且不改数据）
    w.setBlock(3, 20, 5, 0);
    w.setBlock(3, 21, 5, 4);
    w.setBlock(17, 12, -33, 1);
    w.setBlock(-1, 0, -1, 16);
    if (w.setBlock(0, yHi + 5, 0, 1)) warnings.push('上界外写入竟然成功');
    if (w.setBlock(0, yLo - 5, 0, 1)) warnings.push('下界外写入竟然成功');
    const ser = JSON.stringify(w.serializeEdits());
    mix(ser.length);
    mix(ser.split('').reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7));
    for (const [cx, cz] of CS) { const c = w.chunks.get(cx + ',' + cz); mixArr(c.blocks); mixArr(c.light); }
    perSeed.push(seed + ':' + (h >>> 0).toString(16));
  }

  return { root: ROOT, gen, layout, hash: (h >>> 0).toString(16), perSeed, warnings };
}

const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
  };
  const r = await runFingerprint(opt('root', APP_DIR), opt('gen', 'legacy'));
  if (r.warnings.length) console.error('警告：' + r.warnings.join(' / '));
  console.log(JSON.stringify(r));
}
