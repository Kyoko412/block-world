/* 一次性取证脚本（不进验收门禁）：量「地下敌怪候选点」在真实地形里的命中率。
   目的：判断 findUndergroundSpawnPoint 现在这种「一根柱子只撞一次随机 y」的写法
   在自然洞穴 / 手工洞穴里到底能不能刷出怪 —— 刷不出就是产品问题，不是测试问题。 */
import { VoxelWorld, GEN_DEEP } from '../renderer/js/world/world.js';
import { MobManager, UNDERGROUND_TRIES, UNDERGROUND_MIN_COVER, UNDERGROUND_MAX_DEPTH,
  SPAWN_UNDERGROUND_MIN_DIST, SPAWN_UNDERGROUND_RANGE, SPAWN_DARK_LIMIT } from '../renderer/js/world/mobs.js';
import { B } from '../renderer/js/core/blocks.js';

const SEED = 20261107;
const world = new VoxelWorld(SEED, { genVersion: GEN_DEEP });
const R = 5;                                   // 生成 11×11 区块 = 176×176 格
const cx0 = 0, cz0 = 0;
for (let cz = cz0 - R; cz <= cz0 + R; cz++) for (let cx = cx0 - R; cx <= cx0 + R; cx++) world.ensureChunk(cx, cz);

const ctrl = { pos: { x: 8.5, y: 70, z: 8.5 }, hurt() { } };
const ctx = {
  world, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } },
  controller: ctrl, inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
};
const mm = new MobManager(ctx);

/* 产品现版本：一根柱子只随机取一个 y */
function prodProbe(n) {
  let hits = 0, ms = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) if (mm.findUndergroundSpawnPoint(1)) hits++;
  return { hits, n, ms: Math.round(performance.now() - t0) };
}

/* 候选改法：把整根埋深带扫完，收集所有「有顶盖 + 站得住 + 够暗」的格子，再随机取一个 */
function scanProbe(n) {
  const w = world, c = ctrl;
  let hits = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    let found = null;
    for (let tries = 0; tries < UNDERGROUND_TRIES; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = SPAWN_UNDERGROUND_MIN_DIST + Math.random() * SPAWN_UNDERGROUND_RANGE;
      const x = c.pos.x + Math.cos(ang) * dist, z = c.pos.z + Math.sin(ang) * dist;
      const fx = Math.floor(x), fz = Math.floor(z);
      const surf = w.surfaceHeight(fx, fz);
      const yTop = surf - UNDERGROUND_MIN_COVER;
      const yBot = Math.max(w.minY + 2, surf - UNDERGROUND_MAX_DEPTH);
      if (yTop <= yBot) continue;
      if (mm.exposedToSky(x, yTop, z)) continue;
      const cells = [];
      for (let y = yBot; y <= yTop; y++) {
        const site = mm.spawnSiteOk(true, x, y, z, 1);
        if (site.ok) cells.push({ x, y, z, light: site.light, underground: true });
      }
      if (cells.length) { found = cells[(Math.random() * cells.length) | 0]; break; }
    }
    if (found) hits++;
  }
  return { hits, n, ms: Math.round(performance.now() - t0) };
}

/* 找一个自然洞穴的立足点：头顶有盖、能站、且附近水平开阔（连续空气长度） */
function findNaturalCave() {
  let best = null;
  for (let z = -80; z <= 80; z += 2) {
    for (let x = -80; x <= 80; x += 2) {
      const surf = world.surfaceHeight(x, z);
      for (let y = surf - 6; y > Math.max(world.minY + 2, surf - 26); y--) {
        if (!mm.canStandAt(x + 0.5, y, z + 0.5)) continue;
        if (mm.exposedToSky(x + 0.5, y, z + 0.5)) continue;
        if (world.brightnessAt(x, y, z, 1) > SPAWN_DARK_LIMIT) continue;
        let open = 0;
        for (let d = 1; d <= 24; d++) {
          if (mm.spawnSiteOk(true, x + d, y, z, 1).ok) open++;
          if (mm.spawnSiteOk(true, x - d, y, z, 1).ok) open++;
          if (mm.spawnSiteOk(true, x, y, z + d, 1).ok) open++;
          if (mm.spawnSiteOk(true, x, y, z - d, 1).ok) open++;
        }
        if (!best || open > best.open) best = { x: x + 0.5, y, z: z + 0.5, open, surf };
        break;
      }
    }
  }
  return best;
}

/* 手工洞穴：以某点为中心挖 box（模拟 e2e 夹具），返回写入次数 */
function carve(px, pz, half, yBase, airH) {
  let n = 0;
  const x0 = Math.floor(px) - half, x1 = Math.floor(px) + half;
  const z0 = Math.floor(pz) - half, z1 = Math.floor(pz) + half;
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    for (let h = 0; h < airH; h++) { world.setBlock(x, yBase + h, z, B.AIR, 0); n++; }
    world.setBlock(x, yBase - 1, z, B.STONE, 0); n++;
    for (let h = airH; h < airH + 3; h++) { world.setBlock(x, yBase + h, z, B.STONE, 0); n++; }
  }
  return n;
}

const surfSpawn = world.surfaceHeight(Math.floor(ctrl.pos.x), Math.floor(ctrl.pos.z));
console.log('minY', world.minY, 'topY', world.topY, 'seaLevel', world.seaLevel, 'spawnSurface', surfSpawn);
ctrl.pos.y = surfSpawn + 1;
console.log('① 站在草地上（正午）  产品现版本', JSON.stringify(prodProbe(200)), ' 柱子扫描版', JSON.stringify(scanProbe(200)));

const cave = findNaturalCave();
console.log('② 自然洞穴立足点', JSON.stringify(cave));
if (cave) {
  ctrl.pos = { x: cave.x, y: cave.y, z: cave.z };
  console.log('   自然洞穴里  产品现版本', JSON.stringify(prodProbe(200)), ' 柱子扫描版', JSON.stringify(scanProbe(200)));
}

/* ③ e2e 夹具候选：小房间 / 大洞穴，看挖多大才撑得起「自然刷得出怪」 */
for (const half of [3, 8, 13, 18]) {
  const y = Math.max(world.minY + 8, surfSpawn - 10);
  const t0 = performance.now();
  const writes = carve(8.5, 8.5, half, y, 4);
  const carveMs = Math.round(performance.now() - t0);
  ctrl.pos = { x: 8.5, y, z: 8.5 };
  const p = prodProbe(200), s = scanProbe(200);
  console.log(`③ 手工洞穴 half=${half}(${(half * 2 + 1)}格见方) 写入=${writes} carveMs=${carveMs} ` +
    `产品现版本=${JSON.stringify(p)} 柱子扫描版=${JSON.stringify(s)}`);
}
