/* 取证脚本 4：LG 夹具的稳定性 —— 暗/亮各跑 12 次 1800 帧，看「室内敌怪数」的分布，
   顺带统计洞穴壁是否与天然洞穴相通（相通就意味着点亮之后仍可能有怪走进来）。 */
import { VoxelWorld, GEN_DEEP } from '../renderer/js/world/world.js';
import { MobManager } from '../renderer/js/world/mobs.js';
import { lightChunk } from '../renderer/js/world/lighting.js';
import { B } from '../renderer/js/core/blocks.js';
import { coordKey } from '../renderer/js/world/chunk.js';
const world = new VoxelWorld(20261107, { genVersion: GEN_DEEP });
for (let cz = -4; cz <= 4; cz++) for (let cx = -4; cx <= 4; cx++) world.ensureChunk(cx, cz);
const ctrl = { pos: { x: 8.5, y: 46, z: 8.5 }, hurt() { } };
const mm = new MobManager({ world, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } }, controller: ctrl, inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } } });
const relight = () => { for (let cz = -3; cz <= 3; cz++) for (let cx = -3; cx <= 3; cx++) { const c = world.chunks.get(coordKey(cx, cz)); if (c && c.state >= 1) lightChunk(c, world); } };
const HALF = 13, GAP = 6, surf = world.surfaceHeight(8, 8), yBase = surf - 10;
for (let dz = -HALF; dz <= HALF; dz++) for (let dx = -HALF; dx <= HALF; dx++) {
  for (let h = 0; h < 4; h++) world.setBlock(8 + dx, yBase + h, 8 + dz, B.AIR, 0);
  world.setBlock(8 + dx, yBase - 1, 8 + dz, B.STONE, 0);
  for (let h = 4; h < 7; h++) world.setBlock(8 + dx, yBase + h, 8 + dz, B.STONE, 0);
}
relight();
/* 洞穴壁开口统计：房间边界外侧一格是空气就算通向天然洞穴 */
let open = 0, tot = 0;
for (let h = 0; h < 4; h++) for (let dz = -HALF; dz <= HALF; dz++) for (let dx = -HALF; dx <= HALF; dx++) {
  const edge = Math.abs(dx) === HALF || Math.abs(dz) === HALF;
  if (!edge) continue;
  tot++;
  const ox = dx === -HALF ? -1 : dx === HALF ? 1 : 0, oz = dz === -HALF ? -1 : dz === HALF ? 1 : 0;
  if (!world.isSolidAt(8 + dx + ox, yBase + h, 8 + dz + oz)) open++;
}
console.log('洞穴壁开口', open, '/', tot, ' yBase=', yBase, 'surf=', surf);
const inRoom = (m) => Math.abs(Math.floor(m.pos.x) - 8) <= HALF && Math.abs(Math.floor(m.pos.z) - 8) <= HALF && m.pos.y >= yBase - 0.5 && m.pos.y <= yBase + 3.5;
function run(frames) { mm.clear(); mm.maxMobs = 26; ctrl.pos = { x: 8.5, y: yBase, z: 8.5 }; for (let i = 0; i < frames; i++) mm.update(1 / 60, 1.0); const cave = mm.list.filter(m => m.def.hostile && m.undergroundSpawn); return { room: mm.list.filter(m => m.def.hostile && inRoom(m)).length, cave: cave.length, roomSpawn: cave.filter(inRoom).length, total: mm.list.length }; }
console.log('暗  1800 帧 ×10（2400 帧）：', JSON.stringify(Array.from({ length: 10 }, () => run(2400).room)));
for (let dz = -HALF; dz <= HALF; dz += GAP) for (let dx = -HALF; dx <= HALF; dx += GAP) world.setBlock(8 + dx, yBase, 8 + dz, B.TORCH, 0);
relight();
console.log('亮  1800 帧 ×10（2400 帧）：', JSON.stringify(Array.from({ length: 10 }, () => run(2400).room)));
console.log('亮  详细：', JSON.stringify(Array.from({ length: 4 }, () => run(2400))));
