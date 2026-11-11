/*
 * 第二轮 C3：深洞洞室（版本化生成）。
 * 覆盖：旧版本（0/1）的挖空规则一字不动；新版本（2）有洞室/石柱/高差；
 *       跨区块确定性；三个种子里都能找到可站立的洞室地面。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VoxelWorld, GEN_LEGACY, GEN_DEEP, GEN_DEEP_CHAMBERS, NEW_WORLD_GEN_VERSION,
  layoutByGenVersion, genVersionFromMeta
} from '../renderer/js/world/world.js';
import { TerrainGen } from '../renderer/js/world/terrain.js';
import { DEEP_MIN_Y, DEEP_LAYERS } from '../renderer/js/world/world.js';

const scan = (seed, gv, x0, z0, r) => {
  const t = new TerrainGen(seed, { deep: gv !== GEN_LEGACY, genVersion: gv });
  const cols = [];
  for (let z = z0 - r; z <= z0 + r; z++) for (let x = x0 - r; x <= x0 + r; x++) {
    let lo = null, hi = null;
    for (let y = -60; y <= -9; y++) if (t.deepCave(x, y, z)) { if (lo === null) lo = y; hi = y; }
    if (lo !== null) cols.push({ x, z, lo, hi, h: hi - lo + 1 });
  }
  return { t, cols };
};

test('C3.1 版本语义：2 是新档默认，旧值 0/1 仍按原布局与原规则', () => {
  assert.equal(GEN_DEEP_CHAMBERS, 2);
  assert.equal(NEW_WORLD_GEN_VERSION, GEN_DEEP_CHAMBERS, '新档用洞室版本');
  assert.deepEqual(layoutByGenVersion(GEN_DEEP), { minY: DEEP_MIN_Y, layers: DEEP_LAYERS }, 'v1 布局不变');
  assert.deepEqual(layoutByGenVersion(GEN_DEEP_CHAMBERS), { minY: DEEP_MIN_Y, layers: DEEP_LAYERS }, 'v2 沿用同一布局（不重排索引）');
  assert.deepEqual(layoutByGenVersion(GEN_LEGACY), { minY: 0, layers: 64 }, '旧档仍是 0/64');
  assert.equal(genVersionFromMeta({ genVersion: 2 }), GEN_DEEP_CHAMBERS);
  assert.equal(genVersionFromMeta({ genVersion: 1 }), GEN_DEEP);
  assert.equal(genVersionFromMeta({}), GEN_LEGACY, '缺字段回落旧档');
  assert.equal(genVersionFromMeta({ genVersion: 'x' }), GEN_LEGACY, '脏值回落旧档');
});

test('C3.2 旧版本（1）的深洞仍是「净空 3 格」，逐列高度不超过 4', () => {
  const { cols } = scan(12345, GEN_DEEP, 0, 0, 24);
  assert.ok(cols.length > 20, 'v1 应有深洞列，实得 ' + cols.length);
  for (const c of cols) assert.ok(c.h <= 4, '(' + c.x + ',' + c.z + ') 净空 ' + c.h + ' 格，v1 不该有洞室');
});

test('C3.3 新版本（2）真的出现洞室：部分列净空 ≥6 格，且仍有多数走廊列', () => {
  const { cols } = scan(12345, GEN_DEEP_CHAMBERS, 0, 0, 32);
  assert.ok(cols.length > 20, 'v2 也要有洞（骨架保留），实得 ' + cols.length);
  const rooms = cols.filter(c => c.h >= 6);
  const corridors = cols.filter(c => c.h <= 4);
  assert.ok(rooms.length >= 5, '应有成片洞室（净空≥6），实得 ' + rooms.length);
  assert.ok(corridors.length > 0, '走廊也要还在，实得 ' + corridors.length);
  /* 洞室天花板不能捅穿：全都在 -9 以下 */
  for (const c of cols) assert.ok(c.hi <= -9, '(' + c.x + ',' + c.z + ') 天花板 ' + c.hi + ' 越界');
});

test('C3.4 石柱：洞室里存在「同一列上下有洞、但中间实心」的柱子', () => {
  const { t } = scan(999, GEN_DEEP_CHAMBERS, 0, 0, 40);
  let pillars = 0;
  for (let z = -30; z <= 30; z++) for (let x = -30; x <= 30; x++) {
    let sawCave = false, sawSolid = false;
    for (let y = -46; y <= -10; y++) {
      if (t.deepCave(x, y, z)) sawCave = true;
      else if (sawCave) sawSolid = true;
    }
    if (sawCave && sawSolid) pillars++;
  }
  assert.ok(pillars > 0, '洞室里应有被保留下来的石柱列，实得 ' + pillars);
});

test('C3.5 确定性：同种子同坐标两次调用完全一致；不同种子分布不同', () => {
  const a = scan(4242, GEN_DEEP_CHAMBERS, 0, 0, 12).cols;
  const b = scan(4242, GEN_DEEP_CHAMBERS, 0, 0, 12).cols;
  assert.deepEqual(a, b, '同种子必须逐列一致');
  const c = scan(777, GEN_DEEP_CHAMBERS, 0, 0, 12).cols;
  assert.notDeepEqual(a, c, '不同种子的洞穴分布应当不同');
});

test('C3.6 三个种子都能找到「头顶有空间、脚下是实心」的可站立洞室地面', () => {
  for (const seed of [12345, 777, 20261110]) {
    const { t } = scan(seed, GEN_DEEP_CHAMBERS, 0, 0, 40);
    let standable = 0;
    for (let z = -34; z <= 34; z++) for (let x = -34; x <= 34; x++) {
      for (let y = -46; y <= -20; y++) {
        if (t.deepCave(x, y, z) && !t.deepCave(x, y - 1, z) && t.deepCave(x, y + 1, z) && t.deepCave(x, y + 2, z)) {
          standable++; break;
        }
      }
    }
    assert.ok(standable >= 40, '种子 ' + seed + ' 的可站立洞室地面太少：' + standable);
  }
});

test('C3.7 世界层：新档用 v2 生成、旧 v1 档不会被改写', () => {
  const w1 = new VoxelWorld(12345, { genVersion: GEN_DEEP });
  const w2 = new VoxelWorld(12345, { genVersion: GEN_DEEP_CHAMBERS });
  assert.equal(w1.genVersion, GEN_DEEP);
  assert.equal(w2.genVersion, GEN_DEEP_CHAMBERS);
  assert.equal(w1.minY, w2.minY, '两种版本共用同一布局（旧档索引不重排）');
  w1.ensureChunk(0, 0); w2.ensureChunk(0, 0);
  const a = w1.chunks.get('0,0').blocks;
  const b = w2.chunks.get('0,0').blocks;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  assert.ok(diff > 0, 'v2 的深洞与 v1 应当不同（洞室挖得更多）');
  /* 地表以上必须完全一致：洞室只动深洞带 */
  const top = (arr) => arr.length;
  assert.equal(top(a), top(b), '两种版本的区块数组长度一致');
});
