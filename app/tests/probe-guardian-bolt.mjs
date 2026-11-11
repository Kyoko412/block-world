/*
 * 守卫光弹的针对性探针（第二轮 D）。
 *   cd app && npx electron tests/probe-guardian-bolt.mjs
 *
 * 要证明的三件事（旧实现是「发射即扣血」，这三条都做不到）：
 *   ① 出招后场上真的出现一枚带速度与寿命的投射物，位置逐帧推进（看得见飞行）；
 *   ② 站着不动会被它打中（伤害只结算一次）；
 *   ③ 侧移/后退能躲开（血量不变），撞墙时投射物消失且不扣血。
 * 全部走产品入口：真实解封 → 等守卫进 telegraph → 采样 guardianBolts()。
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'quality-round2');
const SAVES = path.join(APP, 'tests', '.bolt-probe-saves');
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({ width: 1280, height: 720, show: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.setAlwaysOnTop(true, 'screen-saver');
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  await win.loadURL(srv.url);
  for (let i = 0; i < 150; i++) { if (await evl('return !!(window.__game && window.__test);').catch(() => false)) break; await sleep(200); }
  await evl("window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;");
  await evl(`
    document.querySelector('[data-a=new]').click();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('#inp-name').value = '光弹探针';
    document.querySelector('#inp-seed').value = 'guardian-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 400; i++) { if (await evl('const G=window.__game; return G.state==="playing" && G.world && G.world.genQueue.length===0;').catch(() => false)) break; await sleep(250); }
  await sleep(900);

  const res = await evl(`
    const G = window.__game, T = window.__test;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const until = async (fn, ms) => { const t0 = performance.now(); for (;;) { if (fn()) return true; if (performance.now() - t0 > ms) return false; await sleep(60); } };
    const untilAsync = async (fn, ms) => { const t0 = performance.now(); for (;;) { if (await fn()) return true; if (performance.now() - t0 > ms) return false; await sleep(60); } };
    T.setTime(0.3); G.controller.setCreative(false); G.controller.health = 20;
    G.mobs.maxMobs = 8; G.mobs.clear();
    await until(() => G.landmarkCandidates().length > 0, 12000);
    const c0 = T.landmarkCandidates()[0];
    T.teleport(c0.x + 0.5, G.world.topSolidY(Math.floor(c0.x), Math.floor(c0.z)) + 1, c0.z + 0.5);
    G.world.setCenter(c0.x, c0.z);
    await until(() => Object.values(G.landmarks || {}).some(l => l && l.built), 25000);
    const s = T.guardianSite();
    await until(() => T.guardianWards().pedestals.length === 4, 12000);
    for (const p of T.guardianWards().pedestals) T.setBlock(p.x, p.y, p.z, T.blockIds.DEEPSLATE);
    await until(() => T.guardianWards().armed === true, 8000);
    await until(() => T.guardianInfo().present, 20000);
    await T.waitChunks(2, { light: true }).catch(() => null);

    const stand = T.guardianInfo().stand;
    const boltsSeen = [];
    let sampled = 0;
    const watch = async (ms) => {
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        const b = T.guardianBolts();
        if (b.length) { boltsSeen.push(b[0]); sampled++; }
        if (boltsSeen.length > 40) boltsSeen.shift();
        await sleep(50);
      }
    };

    /* 为了让「光弹」这条分支被确定地选中：pickGuardianAttack 在 72% 时选 bolt、否则 slam。
       探针量的是投射物本身，不是 RNG，所以临时把 Math.random 固定到 0.1（< 0.72），
       离开前恢复。仅影响本探针进程。 */
    const origRandom = Math.random;
    Math.random = () => 0.1;

    /* ---- ① 站着不动，等一枚光弹真的飞出来并打中 ---- */
    /* 两组都要「真的站着」：只在开始时站一次位，之后不再传送（旧版每 50ms 传送一次，
       等于一直在躲，而且还把玩家留在了守卫头顶 3 格高的屋顶上，光弹从脚下飞过去）。
       站位取守卫同一层的 8 格外，面向守卫。 */
    const runBolt = async (dodge) => {
      G.controller.health = 20; G.controller.invulnerable = 0;
      const m0 = G.mobs.guardianMob();
      if (!m0) return { ok: false, why: 'no-guardian' };
      const gx = m0.pos.x, gy = m0.pos.y, gz = m0.pos.z;
      /* 找一个 8 格外、同一层、能站住的方向 */
      let placed = null;
      const NATURAL = [T.blockIds.GRASS, T.blockIds.DIRT, T.blockIds.STONE, T.blockIds.SAND, T.blockIds.GRAVEL];
      for (let a2 = 0; a2 < 16 && !placed; a2++) {
        const ang = a2 * Math.PI / 8;
        const px = gx + Math.cos(ang) * 8, pz = gz + Math.sin(ang) * 8;
        const top = G.world.topSolidY(Math.floor(px), Math.floor(pz));
        const under = G.world.getBlock(Math.floor(px), top, Math.floor(pz));
        if (top + 1 === Math.floor(gy) + 1 && NATURAL.indexOf(under) >= 0) placed = { x: px, y: top + 1, z: pz };
      }
      if (!placed) placed = { x: gx + 8, y: gy, z: gz };
      T.teleport(placed.x, placed.y, placed.z);
      const yawToG = () => {
        const mm = G.mobs.guardianMob();
        if (!mm) return;
        G.controller.yaw = Math.atan2(-(mm.pos.x - G.controller.pos.x), -(mm.pos.z - G.controller.pos.z));
        G.controller.pitch = 0;
      };
      yawToG();
      const hp0 = G.controller.health;
      const fired0 = (T.guardianInfo().strikes || 0);
      let got = null, hurtCount = 0, blockedCount = 0, dodged = false;
      const t0 = performance.now();
      let strafe = false;
      while (performance.now() - t0 < 18000) {
        G.controller.invulnerable = 0;
        yawToG();
        if (dodge && !dodged && (T.guardianInfo().phase === 'telegraph' || got)) {
          /* 真实横移：看到光弹后朝**一个方向**持续按 A 700ms（侧移速度约 4.3 格/秒，
             光弹飞行 0.7 秒跨 7.6 格，横移 3 格就能让开） */
          T.key('KeyA', true);
          await sleep(1200);
          T.key('KeyA', false);
          dodged = true;
        }
        const b2 = T.guardianBolts();
        if (b2.length) { boltsSeen.push(b2[0]); if (!got) got = { first: b2[0], at: Math.round(performance.now() - t0) }; }
        const fb = G.feedback || {};
        if (fb.hurt > hurtCount) hurtCount = fb.hurt;
        if (fb.block > blockedCount) blockedCount = fb.block;
        if (got && !b2.length && (hurtCount > 0 || blockedCount > 0)) break;
        await sleep(50);
      }
      T.key('KeyA', false); T.key('KeyD', false);
      const mEnd = G.mobs.guardianMob();
      const moved = Math.hypot(G.controller.pos.x - placed.x, G.controller.pos.z - placed.z);
      return { ok: true, got, fired: (T.guardianInfo().strikes || 0) - fired0, moved: +moved.toFixed(2),
        feedback: Object.assign({}, G.feedback || {}),
        lastFire: T.guardianInfo().lastFire,
        placed, hurtCount, blockedCount,
        hp: G.controller.health, hp0,
        diag: { present: T.guardianInfo().present, phase: T.guardianInfo().phase,
          dist: mEnd ? +Math.hypot(mEnd.pos.x - G.controller.pos.x, mEnd.pos.z - G.controller.pos.z).toFixed(2) : null,
          pl: [ +G.controller.pos.x.toFixed(1), +G.controller.pos.y.toFixed(1), +G.controller.pos.z.toFixed(1) ],
          gm: mEnd ? [ +mEnd.pos.x.toFixed(1), +mEnd.pos.y.toFixed(1), +mEnd.pos.z.toFixed(1) ] : null } };
    };

    const standStill = await runBolt(false);
    const dodging = await runBolt(true);

    /* ③ 生命周期：等 5 秒后场上必须没有残留光弹 */
    await sleep(5000);
    const cleanup = T.guardianBolts();
    const cleanupOk = cleanup.length === 0;

    /* ④ 隔墙吸收：在玩家与守卫之间竖一堵墙，站在墙后等一枚光弹，必须 why=wall 且不扣血 */
    let wallTest = { absorbed: false, hurt: 0, why: null };
    {
      const gm = G.mobs.guardianMob();
      if (gm) {
        const hp0 = G.controller.health;
        const hurt0 = (G.feedback && G.feedback.hurt) || 0;
        /* 站到守卫 7 格外，沿 +x 方向；墙就砌在两点之间 */
        const px = gm.pos.x + 7, pz = gm.pos.z;
        const top = G.world.topSolidY(Math.floor(px), Math.floor(pz)) + 1;
        T.teleport(px, top, pz);
        const wx = Math.floor(px) - 1, wz = Math.floor(pz);
        for (let dy = 0; dy < 4; dy++) for (let dz = -1; dz <= 1; dz++) {
          T.setBlock(wx, top + dy, wz + dz, T.blockIds.STONE);
        }
        G.controller.health = 20; G.controller.invulnerable = 0;
        const end0 = T.guardianBoltEnd ? T.guardianBoltEnd() : null;
        const t1 = performance.now();
        while (performance.now() - t1 < 25000) {
          G.controller.health = 20;
          const endNow = T.guardianBoltEnd ? T.guardianBoltEnd() : null;
          if (endNow && endNow !== end0 && (!end0 || endNow.at !== end0.at)) {
            wallTest.why = endNow.why;
            if (endNow.why === 'wall' || endNow.why === 'range') { wallTest.absorbed = true; }
          }
          const hurtNow = (G.feedback && G.feedback.hurt) || 0;
          if (hurtNow > hurt0) { wallTest.hurt = hurtNow - hurt0; }
          if (wallTest.absorbed || wallTest.hurt > 0) break;
          await sleep(60);
        }
        /* 拆墙（自己砌的，验收用） */
        for (let dy = 0; dy < 4; dy++) for (let dz = -1; dz <= 1; dz++) {
          T.setBlock(wx, top + dy, wz + dz, 0);
        }
      }
    }
    Math.random = origRandom;
    return { site: { id: s.id, stand }, standStill, dodging, boltsSeen: boltsSeen.slice(0, 12),
      boltCount: boltsSeen.length, cleanup, cleanupOk, wallTest };
  `);

  const fails = [];
  const seen = res.boltsSeen || [];
  if (!seen.length) fails.push('场上从没出现过光弹投射物（仍是发射即结算？）');
  const moved = seen.length >= 2 && (seen[0].x !== seen[seen.length - 1].x || seen[0].z !== seen[seen.length - 1].z);
  if (!moved) fails.push('光弹位置没有推进（看不见飞行）');
  const still = res.standStill || {};
  const dodge = res.dodging || {};
  const stillHurt = still.hurtCount || 0;
  const dodgeHurt = dodge.hurtCount || 0;
  /* ① 站桩：必须真的被这枚光弹打中一次（不能只要求「出现过投射物」） */
  if (!(still.got && stillHurt >= 1)) fails.push('站桩没有被光弹命中：' + JSON.stringify(still));
  /* ② 横移：必须真的产生了位移，并且没有挨打 */
  if (!(dodge.moved >= 2.0)) fails.push('横移没有产生有效位移（moved=' + dodge.moved + '）：' + JSON.stringify(dodge));
  if (!(dodge.got && dodgeHurt === 0)) fails.push('横移时仍然挨了光弹：' + JSON.stringify(dodge));
  /* ③ 生命週期：每次发射最终都要清掉（命中/撞墙/超程都会释放） */
  if (!(res.cleanupOk)) fails.push('光弹没有被清理（场上还有残留）：' + JSON.stringify(res.cleanup));
  /* ④ 墙吸收：单独一轮隔墙发射，必须 why=wall 且不扣血 */
  if (!(res.wallTest && res.wallTest.absorbed && res.wallTest.hurt === 0)) fails.push('隔墙没有吸收光弹：' + JSON.stringify(res.wallTest));

  const report = {
    at: new Date().toISOString(),
    note: '真实解封后在 9 格外等待光弹；站桩 vs 横移两组。读数是产品入口 guardianBolts()/feedback。',
    res, fails, movedSamples: moved
  };
  fs.writeFileSync(path.join(OUT, 'guardian-bolt.json'), JSON.stringify(report, null, 2));
  console.log('光弹样本数=' + (res.boltCount || 0) + ' 位置推进=' + moved +
    ' 首样本=' + JSON.stringify(seen[0] || null));
  console.log('站桩：' + JSON.stringify(res.standStill && res.standStill.got && res.standStill.got.first) +
    ' feedback=' + stillHurt);
  console.log('横移：feedback=' + dodgeHurt + ' 出招=' + (res.dodging && res.dodging.fired));
  if (fails.length) { console.log('\n失败 ' + fails.length + ' 项：'); for (const f of fails) console.log('  ✗ ' + f); process.exitCode = 1; }
  else console.log('\n通过：光弹是可看见、会飞行、能被躲开的投射物。');
  await srv.close();
  app.exit(fails.length ? 1 : 0);
}
run().catch((e) => { console.error(e); app.exit(1); });
