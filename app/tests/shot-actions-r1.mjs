/*
 * 短动作片段取证（本轮 C3）：在真实遗迹里拍守卫的待机/前摇/出手/硬直，
 * 以及第一人称的挥镐、命中、格挡。输出帧序列 + 每帧的只读读数。
 *   cd app && npx electron tests/shot-actions-r1.mjs --tag after
 *
 * 「动作片段」= 同一机位、同一场景的一串帧（PNG），带时间戳与状态读数；
 * 不是换机位摆拍。守卫段落在真实站点（种子 guardian-2026，产品自己的地标扫描建出来的）。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const TAG = (() => { const i = process.argv.indexOf('--tag'); return i > 0 ? process.argv[i + 1] : 'after'; })();
const OUT = path.join(APP, '..', 'artifacts', 'quality-round1', TAG, 'actions');
const SAVES = path.join(APP, 'tests', '.actions-r1-' + TAG);
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

async function run() {
  await app.whenReady();
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, useContentSize: true, show: true, title: '动作取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setContentSize(1280, 720);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => { try { if (win.isDestroyed()) return; win.showInactive(); win.moveTop(); } catch (e) { } }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');

  await win.loadURL(srv.url);
  for (let i = 0; i < 150; i++) {
    if (await evl('return !!(window.__game && window.__test);').catch(() => false)) break;
    await sleep(200);
  }
  await evl("window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;");
  await evl(`
    document.querySelector('[data-a=new]').click();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('#inp-name').value = '动作取证';
    document.querySelector('#inp-seed').value = 'guardian-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 400; i++) {
    const ready = await evl('const G=window.__game; return G.state==="playing" && G.world && G.world.genQueue.length===0;').catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(900);

  const shot = async (name) => {
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 720 });
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    return name;
  };
  const meta = { tag: TAG, at: new Date().toISOString(), frames: [], notes: [] };

  /* ---------- 1. 守卫：真实站点 + 真实交战 ---------- */
  const site = await evl(`
    const G = window.__game, T = window.__test;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const until = async (fn, ms) => { const t0 = performance.now(); for (;;) { if (fn()) return true; if (performance.now() - t0 > ms) return false; await sleep(150); } };
    T.setTime(0.30); G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 1;
    G.mobs.maxMobs = 8; G.mobs.clear(); G.input.setUIMode(false);
    await until(() => G.landmarkCandidates().length > 0, 12000);
    const c0 = T.landmarkCandidates()[0];
    if (!c0) return { ok: false, why: 'no-candidate' };
    T.teleport(c0.x + 0.5, G.world.topSolidY(Math.floor(c0.x), Math.floor(c0.z)) + 1, c0.z + 0.5);
    G.world.setCenter(c0.x, c0.z);
    await until(() => Object.values(G.landmarks || {}).some(l => l && l.built), 25000);
    const s = T.guardianSite();
    if (!s) return { ok: false, why: 'no-site' };
    await until(() => T.guardianWards().pedestals.length === 4, 12000);
    for (const p of T.guardianWards().pedestals) T.setBlock(p.x, p.y, p.z, T.blockIds.DEEPSLATE);
    await until(() => T.guardianWards().armed === true, 8000);
    await until(() => T.guardianInfo().present, 20000);
    const info = T.guardianInfo();
    /* 站到守卫正面 3.2 格、抬高一点视线，看清姿态与危险方向 */
    const m = G.mobs.guardianMob();
    const gx = m ? m.pos.x : s.x, gz = m ? m.pos.z : s.z, gy = m ? m.pos.y : s.y + 1;
    T.teleport(gx + 3.2, gy, gz + 0.6);
    G.controller.yaw = Math.atan2(-(gx - (gx + 3.2)), -(gz - (gz + 0.6)));
    G.controller.pitch = 0.02;
    G.inventory.clear({});
    G.inventory.add('sword_iron', 1); G.inventory.add('shield', 1); G.inventory.select(0);
    await sleep(600);
    return { ok: true, site: { id: s.id, x: s.x, y: s.y, z: s.z }, stand: info.stand, guardian: T.guardianInfo() };
  `);
  log('守卫现场 = ' + JSON.stringify(site));
  meta.notes.push({ scene: '守卫', site });
  if (site.ok) {
    /* 逐帧拍：等到每个相位都至少抓一帧 */
    const seen = new Set();
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 26000 && seen.size < 4) {
      const info = await evl(`
        const G = window.__game, T = window.__test;
        const gi = T.guardianInfo();
        const m = G.mobs.guardianMob();
        /* 机位钉住：始终正面 3.2 格（守卫会逼近，不钉住就拍不到前摇正面） */
        if (m) {
          const gx = m.pos.x, gz = m.pos.z, gy = m.pos.y;
          T.teleport(gx + 3.2, gy, gz + 0.6);
          G.controller.pitch = 0.02; G.controller.yaw = Math.atan2(3.2, 0.6);
          G.controller.pitch = 0.02;
        }
        G.controller.health = 20; G.controller.invulnerable = 1;
        return { phase: gi.phase, attack: gi.attack, hp: gi.hp, t: gi.t, animAttack: m ? +(m.animAttack || 0).toFixed(3) : null,
                 pose: T.mobPose(0) ? { arm0: T.mobPose(0).applied.arm0, head: T.mobPose(0).applied.headX } : null };
      `);
      if (!seen.has(info.phase)) {
        seen.add(info.phase);
        const name = 'g' + (++i) + '-' + info.phase;
        await shot(name);
        meta.frames.push({ scene: '守卫', name, at: Date.now() - t0, info });
        log('  帧 ' + name + ' ' + JSON.stringify(info));
      }
      await sleep(60);
    }
    /* 一次真实的举盾格挡 */
    const blk = await evl(`
      const G = window.__game, T = window.__test;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      G.inventory.select(G.inventory.slots.findIndex(s => s && s.item === 'shield'));
      G.input.state.mouseRight = true;
      let blocks = 0;
      for (let k = 0; k < 140; k++) {
        const m = G.mobs.guardianMob();
        if (m) { T.teleport(m.pos.x + 2.4, m.pos.y, m.pos.z + 0.4); G.controller.yaw = Math.atan2(2.4, 0.4); }
        G.controller.health = 20;
        if ((G.feedback && G.feedback.block) > blocks) { blocks = G.feedback.block; break; }
        await sleep(60);
      }
      G.input.state.mouseRight = false;
      return { blocks, feedback: G.feedback || null, gi: T.guardianInfo() };
    `);
    await shot('g-block');
    meta.frames.push({ scene: '守卫', name: 'g-block', info: blk });
    log('  格挡 = ' + JSON.stringify(blk));
  }

  /* ---------- 2. 第一人称：挥镐 / 命中 / 空挥 ---------- */
  const fp = await evl(`
    const G = window.__game, T = window.__test;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    G.mobs.clear(); G.mobs.maxMobs = 6;
    const px = Math.floor(G.controller.pos.x), pz = Math.floor(G.controller.pos.z);
    T.teleport(px + 0.5, G.world.topSolidY(px, pz) + 1, pz + 0.5);
    G.controller.yaw = -Math.PI / 2; G.controller.pitch = 0.12;
    G.inventory.clear({});
    G.inventory.add('pickaxe_iron', 1); G.inventory.select(0);
    await sleep(400);
    /* 空挥一帧（模型举起时） */
    G.input.locked = true;
    const canvas = document.getElementById('game-canvas');
    const mouse = (down, btn) => canvas.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup', { button: btn, bubbles: true }));
    G.swing(1, 'attack');
    await sleep(90);
    return { swing: G.heldSwingPhase, item: T.state().held };
  `);
  await shot('f1-swing');
  meta.frames.push({ scene: '第一人称挥镐', name: 'f1-swing', info: fp });
  log('  帧 f1-swing ' + JSON.stringify(fp));

  fs.writeFileSync(path.join(OUT, 'frames.json'), JSON.stringify(meta, null, 2));
  log('→ ' + path.join(OUT, 'frames.json'));
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
