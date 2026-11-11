/*
 * 村庄取证（只截图，不做断言）：
 *   cd app && npx electron tests/shot-village.mjs
 * 产出 artifacts/village-01-村庄全景.png 与 village-02-村民交易.png
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts');
const SAVES = path.join(APP, 'tests', '.shot-saves');
fs.mkdirSync(ART, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.setName('方块世界-村庄取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 村庄取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'normal');
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  win.on('closed', () => { try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ART, name + '.png'), img.toPNG());
    console.log('[截图] artifacts/' + name + '.png');
  };

  await win.loadURL(srv.url);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await evl('return !!(window.__game && window.__test);').catch(() => false);
    if (!ready) await sleep(200);
  }
  if (!ready) { console.error('前端未就绪'); await srv.close(); app.exit(1); return; }
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '村庄取证';
    document.querySelector('#inp-seed').value = 'village-shot';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl(`
      const G = window.__game;
      return !G || G.state !== 'playing' || (G.world && (G.world.genQueue.length > 0 || G.world.dirtyMesh.size > 0));
    `);
    if (!busy) break;
    await sleep(300);
  }

  const info = await evl(`
    const G = window.__game, T = window.__test;
    T.setTime(0.3);
    G.mobs.maxMobs = 0;
    const v = T.villageInfo();
    const o = v.origin;
    G.controller.setCreative(true);
    G.controller.flying = true;
    T.teleport(o.x + 9.5, o.y + 7.0, o.z + 12.5);
    const dx = -9.5, dz = -12.5;
    G.controller.yaw = Math.atan2(-dx, -dz);
    G.controller.pitch = -0.42;
    return v;
  `);
  console.log('[村庄] ' + JSON.stringify(info));
  await sleep(2200);
  await shot('village-01-村庄全景');

  await evl(`
    const G = window.__game, T = window.__test;
    const v = T.villageInfo();
    const o = v.origin;
    G.controller.setCreative(false);
    G.controller.flying = false;
    T.teleport(o.x + 3.5, o.y + 1.05, o.z - 1.5);
    await new Promise(r => setTimeout(r, 500));
    let m = G.mobs.list.find(x => x.type === 'villager');
    if (!m) m = G.mobs.spawn('villager', o.x + 3.5, o.y + 1, o.z - 3.5, { home: { x: o.x + 3.5, y: o.y + 1, z: o.z - 3.5 } });
    if (m) { m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = 0; }
    G.openVillager(m);
    return true;
  `);
  await sleep(900);
  await shot('village-02-村民交易');

  await srv.close();
  app.exit(0);
}
run().catch(async (e) => { console.error('取证失败：' + ((e && e.stack) || e)); app.exit(1); });
