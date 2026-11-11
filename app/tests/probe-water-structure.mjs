/*
 * 阶段 6 取证（无头）：水面网格的结构读数。
 *   cd app && node tests/probe-water-structure.mjs
 *
 * 要回答的问题：「水平条带 / 大片侧面纹理 / 重复亮点」到底来自哪一类面。
 * 做法：造一小片确定性的水（水池 + 岸边 + 水下坡），跑真实 mesher，再按
 * 法线方向、顶点高度、是否双面统计四边形；同时统计同一平面上的重叠层数
 * （重叠 + depthWrite:false 就是「重复亮点」的典型来源）。
 */
import { VoxelWorld } from '../renderer/js/world/world.js';
import { buildChunkGeometry } from '../renderer/js/world/mesher.js';
import { B } from '../renderer/js/core/blocks.js';

const world = new VoxelWorld(12345, { genVersion: 1 });
const X0 = 0, Z0 = 0, W = 2, D = 2;
for (let cx = X0; cx < X0 + W; cx++) for (let cz = Z0; cz < Z0 + D; cz++) world.ensureChunk(cx, cz);

/* 造地形：一块 24×24 的平整沙底 + 池水（中心 8 格深水，外圈浅水），四周留干地 */
const BX = 8, BZ = 8;               // 绝对坐标起点
const ground = 40;
for (let x = BX; x < BX + 24; x++) {
  for (let z = BZ; z < BZ + 24; z++) {
    for (let y = ground - 12; y <= ground + 6; y++) world.setBlock(x, y, z, 0);
    world.setBlock(x, ground - 1, z, B.STONE);
    world.setBlock(x, ground - 2, z, B.STONE);
  }
}
/* 池子：内圈 8×8 深 4，外圈一圈浅 1 */
for (let x = BX + 4; x < BX + 20; x++) {
  for (let z = BZ + 4; z < BZ + 20; z++) {
    const inner = x >= BX + 8 && x < BX + 16 && z >= BZ + 8 && z < BZ + 16;
    const depth = inner ? 4 : 1;
    for (let y = ground - 1; y > ground - 1 - depth; y--) world.setBlock(x, y, z, B.WATER);
    for (let y = ground - 1 - depth; y > ground - 6; y--) world.setBlock(x, y, z, B.SAND);
  }
}
world.setCenter(BX + 12, BZ + 12);
for (let i = 0; i < 8; i++) world.update(0.05);

const tally = { top: 0, bottom: 0, side: 0, other: 0 };
const byHeight = new Map();          // 「水面高度 + 法线」→ 四边形数
const planeKey = (q) => q.normal[1] !== 0
  ? 'y' + (Math.max(...q.ys).toFixed(3))
  : 'x' + q.normal[0] + 'z' + q.normal[2];
const planes = new Map();
let total = 0, waterQuads = 0;

for (const [, c] of world.chunks) {
  if (c.state < 1) continue;
  const geo = buildChunkGeometry(c, world);
  if (!geo.water) continue;
  const pos = geo.water.position, nor = geo.water.normal;
  const n = pos.length / 3;
  total += n;
  for (let i = 0; i < n; i += 4) {
    const ys = [pos[i * 3 + 1], pos[i * 3 + 4], pos[i * 3 + 7], pos[i * 3 + 10]];
    const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
    waterQuads++;
    if (ny > 0.5) tally.top++;
    else if (ny < -0.5) tally.bottom++;
    else tally.side++;
    const k = planeKey({ normal: [nx, ny, nz], ys });
    planes.set(k, (planes.get(k) || 0) + 1);
    const hk = ny > 0.5 ? 'top@' + Math.max(...ys.sorted ? ys : ys).toFixed(3) : 'other';
    byHeight.set(hk, (byHeight.get(hk) || 0) + 1);
  }
}

const dup = [...planes.entries()].filter(([, v]) => v > 1).sort((a, b) => b[1] - a[1]);
console.log('水四边形=' + waterQuads + ' 顶点=' + total);
console.log('按法线=' + JSON.stringify(tally));
console.log('按高度=' + JSON.stringify([...byHeight.entries()]));
console.log('同平面重叠的前 8 组（key=平面, count=该平面上的四边形数）:');
for (const [k, v] of dup.slice(0, 8)) console.log('  ' + k + ' × ' + v);
console.log('重叠平面组数=' + dup.length + '，其中 >2 的=' + dup.filter(([, v]) => v > 2).length);
