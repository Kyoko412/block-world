/* 一次性取证脚本 5（不进验收门禁）：在验收种子的真实地形上预演 BD.*
   —— 站点/林冠找不找得到、自然刷群要多少帧、相位/避让/惊飞/上界是否如断言所写。
   目的：把「跑一遍 8 分钟的 e2e 才知道红不红」压成一次 30 秒的离线取证。 */
import { VoxelWorld, GEN_DEEP, NEW_WORLD_GEN_VERSION } from '../renderer/js/world/world.js';
import { MobManager, birdFlockOf, flightRules, BIRD_SITE_STEP } from '../renderer/js/world/mobs.js';
import { normalizeSeed } from '../renderer/js/core/rng.js';

const seed = normalizeSeed('acceptance-2026');
const world = new VoxelWorld(seed, { genVersion: NEW_WORLD_GEN_VERSION });
const spawn = world.terrain.findSpawn();
console.log('seed', seed >>> 0, 'spawn', JSON.stringify(spawn), 'genVersion', NEW_WORLD_GEN_VERSION, 'seaLevel', world.seaLevel);
world.setCenter(spawn.x, spawn.z);
const scx = Math.floor(spawn.x) >> 4, scz = Math.floor(spawn.z) >> 4;
for (let cz = scz - 4; cz <= scz + 4; cz++) for (let cx = scx - 4; cx <= scx + 4; cx++) world.ensureChunk(cx, cz);

const lim = flightRules();
const ctrl = { pos: { x: spawn.x, y: spawn.y, z: spawn.z }, hurt() { }, creative: true };
const mm = new MobManager({
  world, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } },
  controller: ctrl, inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
});
mm.maxMobs = 26;

/* ---- BD.0：由内向外找「有站点 + 停得住」的列 ---- */
const c0 = { x: Math.floor(ctrl.pos.x / BIRD_SITE_STEP), z: Math.floor(ctrl.pos.z / BIRD_SITE_STEP) };
let site = null;
for (let ring = 0; ring <= 6 && !site; ring++) {
  for (let dz = -ring; dz <= ring && !site; dz++) for (let dx = -ring; dx <= ring && !site; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
    const s = birdFlockOf(seed, c0.x + dx, c0.z + dz);
    if (!s) continue;
    const perch = mm.findPerchAt(s.x, s.z, lim.perchReach);
    if (perch) site = { s, perch, ring, dx, dz };
  }
}
console.log('BD.0 站点', JSON.stringify(site && { key: site.s.key, x: site.s.x, z: site.s.z, count: site.s.count, ring: site.ring, perch: site.perch }));
if (!site) { console.log('找不到站点+林冠，BD 段前提不成立'); process.exit(1); }

/* ---- BD.1：站到站点列上，只让站点扫描干活 ---- */
const surfSite = world.surfaceHeight(Math.floor(site.s.x), Math.floor(site.s.z));
ctrl.pos = { x: site.s.x, y: surfSite + 1, z: site.s.z };
let frames = 0;
while (frames < 1200 && mm.list.filter(m => m.def.flying).length < lim.flockMin) { mm.update(1 / 60, 1.0); frames++; }
const birds = mm.list.filter(m => m.def.flying);
console.log(`BD.1 第 ${frames} 帧（${(frames / 60).toFixed(1)}s）刷出 ${birds.length} 只，键=`,
  JSON.stringify([...new Set(birds.map(b => b.birdSite))]),
  '距出生点', Math.hypot(site.s.x - spawn.x, site.s.z - spawn.z).toFixed(1));

/* ---- BD.2/BD.3：跑 3000 帧采样相位、高度、越界、避让 ---- */
const st = { phases: {}, yMin: 999, yMax: -999, dHomeMax: 0, badCell: 0, inWater: 0, belowGround: 0, yaw: [], tail: 0, perchSeen: 0 };
const B = { WATER: 4 };
for (let i = 0; i < 3000; i++) {
  mm.update(1 / 60, 1.0);
  for (const m of mm.list.filter(x => x.def.flying)) {
    st.phases[m.phase] = (st.phases[m.phase] || 0) + 1;
    st.yMin = Math.min(st.yMin, m.pos.y); st.yMax = Math.max(st.yMax, m.pos.y);
    st.dHomeMax = Math.max(st.dHomeMax, Math.hypot(m.pos.x - m.homeX, m.pos.z - m.homeZ));
    if (!mm.canFlyAt(m.pos.x, m.pos.y, m.pos.z)) st.badCell++;
    const gx = Math.floor(m.pos.x), gz = Math.floor(m.pos.z);
    if (world.getBlock(gx, Math.floor(m.pos.y), gz) === B.WATER) st.inWater++;
    if (m.pos.y < world.surfaceHeight(gx, gz)) st.belowGround++;
    st.yaw.push(m.yaw);
  }
}
/* 圆周展开：把相邻样本的角差累计成「朝向变化范围」 */
let yawSpan = 0;
for (let i = 1; i < st.yaw.length; i++) { let d = st.yaw[i] - st.yaw[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; yawSpan += Math.abs(d); }
console.log('BD.2/3 采样', JSON.stringify({...st, yaw: st.yaw.length}), 'yaw 累计变化', yawSpan.toFixed(1), '林冠顶', site.perch.y, '地表', surfSite);

/* ---- BD.4：贴脸惊飞 ---- */
const one = mm.list.find(m => m.def.flying);
if (one) {
  ctrl.pos = { x: one.pos.x, y: one.pos.y - 1.2, z: one.pos.z };
  let f2 = 0;
  while (f2 < 600 && !mm.list.some(m => m.def.flying && m.phase !== 'perched')) { mm.update(1 / 60, 1.0); f2++; }
  const fly = mm.list.filter(m => m.def.flying && m.phase !== 'perched');
  console.log('BD.4 贴脸后', f2, '帧（', (f2 / 60).toFixed(1), 's）起飞，飞着的只数=', fly.length,
    '速度=', fly.map(m => +Math.hypot(m.vel.x, m.vel.y, m.vel.z).toFixed(2)).join(','));
}

/* ---- BD.5：总量闸与上界 ---- */
mm.maxMobs = 0; mm.clear();
for (let i = 0; i < 40; i++) mm.spawnBirdFlocks();
console.log('BD.5 maxMobs=0 →', mm.list.filter(m => m.def.flying).length, '只');
mm.maxMobs = 26;
let f3 = 0;
while (f3 < 1200 && mm.list.filter(m => m.def.flying).length < lim.flockMin) { mm.update(1 / 60, 1.0); f3++; }
for (let i = 0; i < 200; i++) mm.spawnBirdFlocks();
console.log('BD.5 恢复额度', f3, '帧成群；反复扫描 200 次 →', mm.list.filter(m => m.def.flying).length, '只（界', lim.maxAlive, '）总生物', mm.list.length);
for (const m of mm.list.filter(x => x.type === 'parrot')) m.hp = 0;
for (let i = 0; i < 4; i++) mm.update(1 / 60, 1.0);
for (let i = 0; i < 200; i++) mm.spawnBirdFlocks();
console.log('BD.5 击杀后再扫 200 次 →', mm.list.filter(m => m.def.flying).length, '只');

/* ---- BD.6：序列化字段（读档往返用同一份 serialize/applySaved） ---- */
const payload = mm.list.filter(m => m.def.flying).map(m => m.serialize());
console.log('BD.6 存档载荷', JSON.stringify(payload.slice(0, 2)).slice(0, 320));
mm.clear();
for (const p of payload) mm.applySaved(p);
const re = mm.list.filter(m => m.def.flying);
console.log('BD.6 读回', re.length, '只，相位=', JSON.stringify([...new Set(re.map(m => m.phase))]),
  '站点键=', JSON.stringify([...new Set(re.map(m => m.birdSite))]), '栖点=', JSON.stringify(re.map(m => m.perch && [+m.perch.x.toFixed(1), m.perch.y, +m.perch.z.toFixed(1)]).slice(0, 2)));
for (let i = 0; i < 200; i++) mm.spawnBirdFlocks();
const after = mm.list.filter(m => m.def.flying);
console.log('BD.6 读档后再扫 200 次 →', after.length, '只，同站点键数=', new Set(after.map(m => m.birdSite)).size);
