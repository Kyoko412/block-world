/* 一次性取证脚本 2（不进验收门禁）：在**算过光照**的真实世界上量 LG 夹具。
   要回答三件事：
     ① 挖多大的洞穴、铺多密的火把，才能让产品自己的地下候选点搜索从「有」变成「没有」；
     ② 点灯之后残余命中是不是来自远处自然洞穴（如果是，「点灯后一只都不刷」就不该写成断言）；
     ③ 这套夹具在浏览器里要花多少时间（setBlock 写入 + lightChunk 重算）。 */
import { VoxelWorld, GEN_DEEP } from '../renderer/js/world/world.js';
import { MobManager, SPAWN_DARK_LIMIT, SPAWN_CAVE_CAP } from '../renderer/js/world/mobs.js';
import { lightChunk } from '../renderer/js/world/lighting.js';
import { B } from '../renderer/js/core/blocks.js';
import { coordKey } from '../renderer/js/world/chunk.js';

const SEED = 20261107;
const world = new VoxelWorld(SEED, { genVersion: GEN_DEEP });
const R = 4;
for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) world.ensureChunk(cx, cz);

const ctrl = { pos: { x: 8.5, y: 40, z: 8.5 }, hurt() { } };
const ctx = {
  world, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } },
  controller: ctrl, inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
};
const mm = new MobManager(ctx);

const relight = () => {
  for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) {
    const c = world.chunks.get(coordKey(cx, cz));
    if (c && c.state >= 1) lightChunk(c, world);
  }
};

function probe(n) {
  let hits = 0, lights = [];
  for (let i = 0; i < n; i++) {
    const p = mm.findUndergroundSpawnPoint(1);
    if (p) { hits++; if (lights.length < 3) lights.push(+Number(p.light).toFixed(3)); }
  }
  return { hits, n, lights };
}

function sweep(half, yBase, label) {
  let pass = 0, cells = 0; const why = {};
  for (let dz = -half; dz <= half; dz++) for (let dx = -half; dx <= half; dx++) {
    cells++;
    const r = mm.spawnSiteOk(true, Math.floor(ctrl.pos.x) + dx + 0.5, yBase, Math.floor(ctrl.pos.z) + dz + 0.5, 1);
    if (r.ok) pass++; else why[r.why] = (why[r.why] || 0) + 1;
  }
  return { label, cells, pass, why };
}

const surf = world.surfaceHeight(8, 8);
const yBase = surf - 10;
let writes = 0;
let t0 = performance.now();
for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
  for (let h = 0; h < 4; h++) { world.setBlock(8 + dx, yBase + h, 8 + dz, B.AIR, 0); writes++; }
  world.setBlock(8 + dx, yBase - 1, 8 + dz, B.STONE, 0); writes++;
  for (let h = 4; h < 7; h++) { world.setBlock(8 + dx, yBase + h, 8 + dz, B.STONE, 0); writes++; }
}
relight();
const carveMs = Math.round(performance.now() - t0);
ctrl.pos = { x: 8.5, y: yBase, z: 8.5 };
console.log(`洞穴 17×17 挖通 y=${yBase}（地表 ${surf}）写入=${writes} carveMs=${carveMs} ` +
  `站得住=${mm.canStandAt(8.5, yBase, 8.5)} 见天=${mm.exposedToSky(8.5, yBase, 8.5)} ` +
  `亮度=${world.brightnessAt(8, yBase, 8).toFixed(3)}`);
console.log('  暗处 probe', JSON.stringify(probe(400)), 'sweep', JSON.stringify(sweep(8, yBase, 'floor')));

/* 先跑一次「暗」的 900 帧真实节拍，作为 LG.1 的时间预算参考 */
function runF(frames, day) {
  mm.clear(); mm.maxMobs = 26;
  const t = performance.now();
  for (let i = 0; i < frames; i++) mm.update(1 / 60, day);
  const list = mm.list;
  return {
    ms: Math.round(performance.now() - t),
    total: list.length, hostile: list.filter(m => m.def.hostile).length,
    cave: list.filter(m => m.def.hostile && m.undergroundSpawn).length,
    flying: list.filter(m => m.def.flying).length,
    cavePos: list.filter(m => m.def.hostile && m.undergroundSpawn).map(m =>
      [+m.pos.x.toFixed(1), +m.pos.y.toFixed(1), +m.pos.z.toFixed(1),
       +Math.hypot(m.pos.x - ctrl.pos.x, m.pos.z - ctrl.pos.z).toFixed(1)]).slice(0, 8)
  };
}
console.log('  900 帧（暗）', JSON.stringify(runF(900, 1.0)));

/* 火把：按不同间距铺在洞穴地板上，看残余命中 */
for (const gap of [6, 4, 3]) {
  /* 先复原上一轮的火把 */
  for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
    if (world.getBlock(8 + dx, yBase, 8 + dz) === B.TORCH) world.setBlock(8 + dx, yBase, 8 + dz, B.AIR, 0);
  }
  t0 = performance.now();
  let torches = 0;
  for (let dz = -8; dz <= 8; dz += gap) for (let dx = -8; dx <= 8; dx += gap) {
    world.setBlock(8 + dx, yBase, 8 + dz, B.TORCH, 0); torches++;
  }
  relight();
  const litMs = Math.round(performance.now() - t0);
  console.log(`  火把 gap=${gap} 数量=${torches} litMs=${litMs} 中心亮度=${world.brightnessAt(8, yBase, 8).toFixed(3)} ` +
    `probe=${JSON.stringify(probe(400))} sweep=${JSON.stringify(sweep(8, yBase, 'floor'))}`);
}

/* 远处残余：把火把铺满之后仍然命中的点，到底在哪里 */for (let i = 0; i < 400; i++) {
  const p = mm.findUndergroundSpawnPoint(1);
  if (p) {
    console.log('  残余命中点', JSON.stringify({ x: +p.x.toFixed(1), y: p.y, z: +p.z.toFixed(1),
      d: +Math.hypot(p.x - ctrl.pos.x, p.z - ctrl.pos.z).toFixed(1),
      light: +Number(p.light).toFixed(3), surf: world.surfaceHeight(Math.floor(p.x), Math.floor(p.z)) }));
    break;
  }
}

/* 900 帧真实节拍：暗 / 亮 各跑一遍，数场上真的刷出几只 */
function run(frames, day) {
  mm.clear(); mm.maxMobs = 26;
  for (let i = 0; i < frames; i++) mm.update(1 / 60, day);
  const list = mm.list;
  return {
    total: list.length, hostile: list.filter(m => m.def.hostile).length,
    cave: list.filter(m => m.def.hostile && m.undergroundSpawn).length,
    flying: list.filter(m => m.def.flying).length,
    caveLight: list.filter(m => m.def.hostile && m.undergroundSpawn).map(m =>
      +world.brightnessAt(Math.floor(m.pos.x), Math.floor(m.pos.y), Math.floor(m.pos.z), day).toFixed(3)).slice(0, 6)
  };
}
console.log('  900 帧（洞穴被火把点亮之后）', JSON.stringify(runF(900, 1.0)), '上限', SPAWN_CAVE_CAP);
