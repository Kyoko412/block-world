/*
 * 守卫近战诊断（本轮 A3 的现场排查）：在真实站点上打 10 刀，逐刀打印
 * 「玩家到守卫的距离 / 视线射线撞到的方块距离 / attackMelee 是否命中 / 守卫相位」。
 *   cd app && npx electron tests/probe-guardian-melee.mjs
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
const OUT = path.join(APP, '..', 'artifacts', 'quality-round1');
const SAVES = path.join(APP, 'tests', '.melee-probe-saves');
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
    document.querySelector('#inp-name').value = '近战诊断';
    document.querySelector('#inp-seed').value = 'guardian-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 400; i++) { if (await evl('const G=window.__game; return G.state==="playing" && G.world.genQueue.length===0;').catch(() => false)) break; await sleep(250); }
  await sleep(900);

  const diag = await evl(`
    const G = window.__game, T = window.__test;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const until = async (fn, ms) => { const t0 = performance.now(); for (;;) { if (fn()) return true; if (performance.now() - t0 > ms) return false; await sleep(150); } };
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
    const info0 = T.guardianInfo();
    const stand = info0.stand;
    /* 站位周围一圈方块（判断开阔度） */
    const ring = [];
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1]]) {
      const bx = stand.x + dx, bz = stand.z + dz;
      ring.push({ dx, dz,
        feet: G.world.getBlock(bx, stand.y, bz),
        chest: G.world.getBlock(bx, stand.y + 1, bz),
        below: G.world.getBlock(bx, stand.y - 1, bz) });
    }
    G.inventory.clear({});
    G.inventory.add('sword_iron', 1); G.inventory.select(0);
    const swings = [];
    for (let k = 0; k < 10; k++) {
      const m = G.mobs.guardianMob();
      if (!m) { swings.push({ k, err: 'no-guardian' }); break; }
      T.teleport(m.pos.x + 2.2, m.pos.y, m.pos.z);
      await sleep(90);
      const dx = m.pos.x - G.controller.pos.x, dz = m.pos.z - G.controller.pos.z;
      G.controller.yaw = Math.atan2(-dx, -dz); G.controller.pitch = 0;
      G.controller.health = 20; G.controller.invulnerable = 0;
      await sleep(60);
      const before = T.guardianInfo().hp;
      const tgt = G.interaction.target;
      G.input.state.mouseLeft = false; await sleep(40);
      G.input.state.mouseLeft = true; await sleep(60);
      G.input.state.mouseLeft = false;
      await sleep(120);
      const after = T.guardianInfo().hp;
      swings.push({
        k,
        dist: +Math.hypot(m.pos.x - G.controller.pos.x, m.pos.z - G.controller.pos.z).toFixed(2),
        posDist: +Math.hypot(m.pos.x - G.controller.pos.x, m.pos.y - G.controller.pos.y, m.pos.z - G.controller.pos.z).toFixed(2),
        blockTarget: tgt ? { x: tgt.x, y: tgt.y, z: tgt.z, dist: +tgt.dist.toFixed(2) } : null,
        hp: before + '→' + after, hit: after < before,
        phase: T.guardianInfo().phase,
        attackTimer: +G.interaction.attackTimer.toFixed(3),
        player: { x: +G.controller.pos.x.toFixed(2), y: +G.controller.pos.y.toFixed(2), z: +G.controller.pos.z.toFixed(2) },
        guardian: { x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2) }
      });
      await sleep(500);
    }
    return { site: { id: s.id, x: s.x, y: s.y, z: s.z }, stand, ring, swings };
  `);
  fs.writeFileSync(path.join(OUT, 'guardian-melee-diag.json'), JSON.stringify(diag, null, 2));
  console.log(JSON.stringify(diag.stand) + ' ring=' + JSON.stringify(diag.ring));
  for (const s of diag.swings) console.log(JSON.stringify(s));
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
