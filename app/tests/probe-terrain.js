/* 地形分布探针：统计生物群系占比、高度分位、水域比例、树木密度 */
import { VoxelWorld } from '../renderer/js/world/world.js';
import { TerrainGen, BIOME, BIOME_NAMES } from '../renderer/js/world/terrain.js';
import { CHUNK_SX, CHUNK_SZ, WORLD_H, idx, coordKey, SEA_LEVEL } from '../renderer/js/world/chunk.js';
import { B } from '../renderer/js/core/blocks.js';

const R = parseInt(process.env.R || '6', 10);
const SEED = parseInt(process.env.SEED || '999', 10);
const w = new VoxelWorld(SEED);
const heights = [];
const bio = {};
let trees = 0;
for (let cz = -R; cz <= R; cz++) {
  for (let cx = -R; cx <= R; cx++) {
    const c = w.ensureChunk(cx, cz);
    const x0 = c.cx * CHUNK_SX, z0 = c.cz * CHUNK_SZ;
    for (let lz = 0; lz < CHUNK_SZ; lz++) for (let lx = 0; lx < CHUNK_SX; lx++) {
      heights.push(c.heightMap[lx + lz * CHUNK_SX]);
      const bi = c.biome[lx + lz * CHUNK_SX];
      bio[bi] = (bio[bi] || 0) + 1;
    }
    for (let lz = -3; lz < CHUNK_SZ + 3; lz++) for (let lx = -3; lx < CHUNK_SX + 3; lx++) {
      if (w.terrain.treeAt(x0 + lx, z0 + lz)) trees++;
    }
  }
}
heights.sort((a, b) => a - b);
const pct = (p) => heights[Math.floor((heights.length - 1) * p)];
const total = heights.length;
const waterCols = heights.filter(h => h < SEA_LEVEL).length;
console.log(`种子 ${SEED}  区块 ${(2 * R + 1) ** 2}  列 ${total}`);
console.log(`高度: 最小 ${heights[0]}  P5 ${pct(0.05)}  P25 ${pct(0.25)}  中位 ${pct(0.5)}  P75 ${pct(0.75)}  P95 ${pct(0.95)}  最大 ${heights[heights.length - 1]}  海平面 ${SEA_LEVEL}`);
console.log(`海面以下列占比 ${(waterCols / total * 100).toFixed(1)}%   树木数 ${trees}（每千列 ${(trees / total * 1000).toFixed(1)}）`);
for (const k of Object.keys(bio).sort((a, b) => bio[b] - bio[a])) {
  console.log('  ' + BIOME_NAMES[k].padEnd(6) + (bio[k] / total * 100).toFixed(1) + '%');
}
// 方块统计
const tally = {};
for (const [, c] of w.chunks) for (let i = 0; i < c.blocks.length; i++) tally[c.blocks[i]] = (tally[c.blocks[i]] || 0) + 1;
const names = Object.fromEntries(Object.entries(B).map(([k, v]) => [v, k]));
console.log('方块: ' + Object.keys(tally).sort((a, b) => tally[b] - tally[a]).slice(0, 14)
  .map(k => (names[k] || k) + '=' + tally[k]).join('  '));
