/* 一次性取证脚本 3（不进验收门禁）：按改好的产品实现量 LG 夹具（柱子扫描 + 公平额度）。
   要回答：① 挖多大的洞穴、铺多密的火把，房间地板过判据的数量才从「全通过」变「全被亮度挡掉」；
   ② 暗跑 900 帧室内是否真有敌怪、亮跑 900 帧室内是否为 0（远处自然洞穴仍然会刷，那是诚实的）；
   ③ 这套夹具与 900 帧节拍各花多少时间，好排 600 秒看门狗的预算。 */
import { VoxelWorld, GEN_DEEP } from '../renderer/js/world/world.js';
import { MobManager, SPAWN_DARK_LIMIT, SPAWN_CAVE_CAP, BIRD_MAX_ALIVE } from '../renderer/js/world/mobs.js';
import { lightChunk } from '../renderer/js/world/lighting.js';
import { B } from '../renderer/js/core/blocks.js';
import { coordKey } from '../renderer/js/world/chunk.js';

const world = new VoxelWorld(20261107, { genVersion: GEN_DEEP });
const R = 4;
for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) world.ensureChunk(cx, cz);

const ctrl = { pos: { x: 8.5, y: 40, z: 8.5 }, hurt() { } };
const ctx = {
  world, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } },
  controller: ctrl, inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
};
const mm = new MobManager(ctx);
const relight = () => {
  for (let cz = -3; cz <= 3; cz++) for (let cx = -3; cx <= 3; cx++) {
    const c = world.chunks.get(coordKey(cx, cz));
    if (c && c.state >= 1) lightChunk(c, world);
  }
};
const HALF = 13, GAP = 6;
const surf = world.surfaceHeight(8, 8);
const yBase = surf - 10;

function probe(n) {
  let hits = 0, inRoom = 0;
  for (let i = 0; i < n; i++) {
    const p = mm.findUndergroundSpawnPoint(1);
    if (!p) continue;
    hits++;
    if (Math.abs(Math.floor(p.x) - 8) <= HALF && Math.abs(Math.floor(p.z) - 8) <= HALF && p.y >= yBase && p.y <= yBase + 3) inRoom++;
  }
  return { hits, n, inRoom };
}
function sweep(y) {
  let pass = 0; const why = {};
  for (let dz = -HALF; dz <= HALF; dz++) for (let dx = -HALF; dx <= HALF; dx++) {
    const r = mm.spawnSiteOk(true, 8 + dx + 0.5, y, 8 + dz + 0.5, 1);
    if (r.ok) pass++; else why[r.why] = (why[r.why] || 0) + 1;
  }
  return { cells: (HALF * 2 + 1) ** 2, pass, why };
}
function run(frames, day) {
  mm.clear(); mm.maxMobs = 26;
  const t = performance.now();
  for (let i = 0; i < frames; i++) mm.update(1 / 60, day);
  const ms = Math.round(performance.now() - t);
  const inRoom = (m) => Math.abs(Math.floor(m.pos.x) - 8) <= HALF && Math.abs(Math.floor(m.pos.z) - 8) <= HALF &&
    m.pos.y >= yBase - 0.5 && m.pos.y <= yBase + 3.5;
  const list = mm.list;
  const cave = list.filter(m => m.def.hostile && m.undergroundSpawn);
  return {
    ms, total: list.length, landCap: mm.landSpawnCap(),
    hostile: list.filter(m => m.def.hostile).length, cave: cave.length,
    caveInRoom: cave.filter(inRoom).length, roomHostile: list.filter(m => m.def.hostile && inRoom(m)).length,
    flying: list.filter(m => m.def.flying).length, aquatic: list.filter(m => m.def.aquatic).length,
    animals: list.filter(m => !m.def.hostile && !m.def.flying && !m.def.aquatic).length,
    caveDist: cave.map(m => +Math.hypot(m.pos.x - ctrl.pos.x, m.pos.z - ctrl.pos.z).toFixed(1)).slice(0, 8)
  };
}

let t0 = performance.now();
for (let dz = -HALF; dz <= HALF; dz++) for (let dx = -HALF; dx <= HALF; dx++) {
  for (let h = 0; h < 4; h++) world.setBlock(8 + dx, yBase + h, 8 + dz, B.AIR, 0);
  world.setBlock(8 + dx, yBase - 1, 8 + dz, B.STONE, 0);
  for (let h = 4; h < 7; h++) world.setBlock(8 + dx, yBase + h, 8 + dz, B.STONE, 0);
}
relight();
const carveMs = Math.round(performance.now() - t0);
ctrl.pos = { x: 8.5, y: yBase, z: 8.5 };
console.log(`洞穴 ${(HALF * 2 + 1)} 格见方 y=${yBase}（地表 ${surf}）carveMs=${carveMs} 中心亮度=${world.brightnessAt(8, yBase, 8).toFixed(3)} ` +
  `站得住=${mm.canStandAt(8.5, yBase, 8.5)} 见天=${mm.exposedToSky(8.5, yBase, 8.5)}`);
console.log('暗  probe', JSON.stringify(probe(400)), 'sweep', JSON.stringify(sweep(yBase)), 'run900', JSON.stringify(run(900, 1.0)));

t0 = performance.now();
let torches = 0;
for (let dz = -HALF; dz <= HALF; dz += GAP) for (let dx = -HALF; dx <= HALF; dx += GAP) {
  world.setBlock(8 + dx, yBase, 8 + dz, B.TORCH, 0); torches++;
}
relight();
console.log(`火把 gap=${GAP} 数量=${torches} litMs=${Math.round(performance.now() - t0)} 中心亮度=${world.brightnessAt(8, yBase, 8).toFixed(3)} ` +
  `最暗角=${world.brightnessAt(8 - HALF, yBase, 8 - HALF).toFixed(3)}`);
console.log('亮  probe', JSON.stringify(probe(400)), 'sweep', JSON.stringify(sweep(yBase)), 'run900', JSON.stringify(run(900, 1.0)));
console.log('界  SPAWN_CAVE_CAP', SPAWN_CAVE_CAP, 'BIRD_MAX_ALIVE', BIRD_MAX_ALIVE, 'SPAWN_DARK_LIMIT', SPAWN_DARK_LIMIT);
