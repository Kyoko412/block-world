/*
 * 地图/指南针取证（只截图，不做断言）：
 *   cd app && npx electron tests/shot-map.mjs
 * 产出 artifacts/map-01-地图面板.png、map-02-指南针HUD.png
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
  app.setName('方块世界-地图取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 地图取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => {
    try { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.showInactive(); win.moveTop(); } catch (e) { /* ignore */ }
  }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ } });
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
    document.querySelector('#inp-name').value = '地图取证';
    document.querySelector('#inp-seed').value = 'map-shot';
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

  await evl(`
    const G = window.__game, T = window.__test;
    T.setTime(0.3);
    G.mobs.maxMobs = 0;
    G.inventory.clear(); G.inventory.emit('load');
    T.give('map', 1); T.give('compass', 1);
    const mi = G.inventory.slots.findIndex(s => s && s.item === 'map');
    if (mi >= 0) { G.inventory.set(0, G.inventory.get(mi)); G.inventory.set(mi, null); }
    G.selectHotbar(0);
    G.openMap();
    return true;
  `);
  await sleep(800);
  await shot('map-01-地图面板');

  await evl(`
    const G = window.__game, T = window.__test;
    G.closeUI();
    const ci = G.inventory.slots.findIndex(s => s && s.item === 'compass');
    if (ci >= 0) { G.inventory.set(1, G.inventory.get(ci)); if (ci !== 1) G.inventory.set(ci, null); }
    G.selectHotbar(1);
    G.controller.yaw = 0.6; G.controller.pitch = -0.08;
    return true;
  `);
  await sleep(700);
  await shot('map-02-指南针HUD');

  await srv.close();
  app.exit(0);
}
run().catch(async (e) => { console.error('取证失败：' + ((e && e.stack) || e)); app.exit(1); });
