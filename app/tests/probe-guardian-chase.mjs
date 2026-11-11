/*
 * 守卫追击的帧率一致性探针（Node，无 DOM）。
 *
 * 复现的缺陷：guardianAI 把 speed*dt 当成目标速度，physics 再按 vel*dt 积分，
 * 于是「真实追击速度 = speed*dt」——帧率越高追得越慢。审计记录 30/60/120 FPS
 * 下目标速度 0.0633/0.0317/0.0158（正好是 1.9*dt）。
 *
 * 本探针走真实链路：MobManager.ai()（含 stepGuardian 状态机）+ MobManager.physics()
 * （含碰撞与分步移动），只把 dt 换成 1/30、1/60、1/120，比较**相同真实秒数**内的位移。
 *
 *   node tests/probe-guardian-chase.mjs [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { VoxelWorld } from '../renderer/js/world/world.js';
import { AIR, B } from '../renderer/js/core/blocks.js';
import * as MOBSMOD from '../renderer/js/world/mobs.js';
import { GUARDIAN_PHASE, defaultGuardianState, GUARDIAN_WARDS } from '../renderer/js/core/guardian.js';

/* 修复前没有这两个常量（版本对照时探针要能在旧代码上跑出失败读数） */
const MobManager = MOBSMOD.MobManager;
const GUARDIAN_CHASE_RATE = MOBSMOD.GUARDIAN_CHASE_RATE || -1;
const GUARDIAN_STOP_RATE = MOBSMOD.GUARDIAN_STOP_RATE || -1;
const guardianChaseSpeed = MOBSMOD.guardianChaseSpeed || ((b) => Number(b) || 1.9);

const CX = 8, CZ = 8, FY = 40;

function buildWorld() {
  const w = new VoxelWorld(777);
  for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) w.ensureChunk(cx, cz);
  for (let dz = -14; dz <= 14; dz++) for (let dx = -14; dx <= 14; dx++) {
    w.setBlock(CX + dx, FY, CZ + dz, B.STONE, 0);
    for (let h = 1; h <= 6; h++) w.setBlock(CX + dx, FY + h, CZ + dz, AIR, 0);
  }
  return w;
}

/* 跑 seconds 秒的真实追击，返回位移与末速度。playerDist 决定它处在 IDLE 追击带里。 */
function runCase(fps, seconds, opts = {}) {
  const w = buildWorld();
  const controller = {
    pos: { x: CX + 0.5, y: FY + 1, z: CZ + 0.5 },
    get eyeY() { return this.pos.y + 1.62; },
    health: 20, creative: false,
    lookDir: () => ({ x: 0, y: 0, z: -1 }), hurt() { }
  };
  const ctx = {
    world: w, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } },
    controller, inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
  };
  const mm = new MobManager(ctx);
  const gu = opts.dormant ? null : mm.spawnGuardianAt({ id: 'probe', x: CX, z: CZ },
    CX + (opts.offset || 8) + 0.5, FY + 1, CZ + 0.5,
    Object.assign(defaultGuardianState('g:probe'), { phase: GUARDIAN_PHASE.DORMANT }));
  if (opts.dormant) {
    /* 只测纯速度换算：手工建一个守卫实体并强制进 IDLE */
    const m = mm.spawn('guardian', CX + (opts.offset || 8) + 0.5, FY + 1, CZ + 0.5);
    mm.guardianState = Object.assign(defaultGuardianState('g:probe'), { phase: GUARDIAN_PHASE.IDLE, t: -1e9 });
    mm._guardianArmed = true; mm._guardianWards = GUARDIAN_WARDS;
    var mob = m;
  } else {
    var mob = gu;
    mm._guardianArmed = true; mm._guardianWards = GUARDIAN_WARDS;
  }
  if (!mob) return { fps, error: 'spawn failed' };

  const dt = 1 / fps;
  const frames = Math.round(seconds * fps);
  const x0 = mob.pos.x, z0 = mob.pos.z;
  let peakSpeed = 0;
  for (let i = 0; i < frames; i++) {
    const dx = controller.pos.x - mob.pos.x, dz = controller.pos.z - mob.pos.z;
    const d2 = dx * dx + dz * dz;
    mm.ai(mob, dt, d2, 1);
    mm.physics(mob, dt);
    const sp = Math.hypot(mob.vel.x, mob.vel.z);
    if (sp > peakSpeed) peakSpeed = sp;
  }
  const moved = Math.hypot(mob.pos.x - x0, mob.pos.z - z0);
  return {
    fps, dt: +dt.toFixed(6), frames, seconds,
    moved: +moved.toFixed(4),
    peakSpeed: +peakSpeed.toFixed(4),
    endSpeed: +Math.hypot(mob.vel.x, mob.vel.z).toFixed(4),
    phase: mm.guardianState.phase,
    pos: [+mob.pos.x.toFixed(3), +mob.pos.z.toFixed(3)],
    speedParam: guardianChaseSpeed(mob.def.speed)
  };
}

const results = {
  at: new Date().toISOString(),
  note: '真实链路：MobManager.ai（含 stepGuardian）+ physics（含碰撞分步）。0.5 秒窗口落在 IDLE 追击段内（GUARDIAN_IDLE_SECONDS=0.55）。',
  constants: { chaseRate: GUARDIAN_CHASE_RATE, stopRate: GUARDIAN_STOP_RATE },
  window: (process.argv.includes('--window') ? Number(process.argv[process.argv.indexOf('--window') + 1]) : 0.5),
  cases: []
};
for (const fps of [30, 60, 120, 144]) results.cases.push(runCase(fps, results.window));

const base = results.cases.find(c => c.fps === 60);
const failures = [];
for (const c of results.cases) {
  if (c.error) { failures.push('fps=' + c.fps + ' ' + c.error); continue; }
  const rel = Math.abs(c.moved - base.moved) / Math.max(1e-6, base.moved);
  c.relTo60 = +rel.toFixed(4);
  /* 同一真实秒数内位移差异 > 8% 即判定帧率相关（修复前 30 vs 120 差 4 倍） */
  if (rel > 0.08) failures.push('fps=' + c.fps + ' 的 ' + c.seconds + ' 秒位移 ' + c.moved + ' 与 60FPS 的 ' + base.moved + ' 相差 ' + (rel * 100).toFixed(1) + '%');
  if (c.peakSpeed > base.speedParam * 1.35) failures.push('fps=' + c.fps + ' 峰值速度 ' + c.peakSpeed + ' 超过参数 ' + base.speedParam + ' 的 1.35 倍');
  if (c.peakSpeed < 0.5) failures.push('fps=' + c.fps + ' 峰值速度只有 ' + c.peakSpeed + '，几乎没动');
}
/* 期望量级：0.5 秒 × 1.9 格/秒 减去指数收敛的滞后，应在 0.75~0.95 之间 */
if (!(base.moved > 0.6 && base.moved < 1.05)) failures.push('60FPS 下 0.5 秒位移 ' + base.moved + ' 不在预期 0.6~1.05 之间（几乎没动或超速）');

const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx > 0) fs.writeFileSync(path.resolve(process.argv[jsonIdx + 1]), JSON.stringify(Object.assign({ failures }, results), null, 2));

console.log('守卫追击帧率一致性（' + results.window + ' 秒窗口，速度参数 ' + (base.speedParam) + ' 格/秒）');
for (const c of results.cases) {
  console.log('  ' + String(c.fps).padStart(3) + ' FPS  帧数 ' + String(c.frames).padStart(3) +
    '  位移 ' + String(c.moved).padStart(6) + '  峰值速度 ' + String(c.peakSpeed).padStart(5) +
    '  末速度 ' + String(c.endSpeed).padStart(5) + '  相对60FPS ' + (c.relTo60 !== undefined ? (c.relTo60 * 100).toFixed(1) + '%' : '-'));
}
if (failures.length) {
  console.log('\n失败 ' + failures.length + ' 项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('\n四种帧率在相同真实秒数内追击位移一致（差异 ≤ 8%）。');
}
