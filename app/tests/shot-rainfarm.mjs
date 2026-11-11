/*
 * E4 雨天耕地取证：固定种子新世界，造两块无水源耕地（一块露天、一块在石顶下），
 * 开雨后对照湿润位，并截带雨幕的俯视图。
 *   cd app && npx electron tests/shot-rainfarm.mjs
 * 产出 artifacts/visual/rainfarm-01-overview.png、rainfarm-02-close.png、rainfarm-samples.json
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const SAVES = path.join(APP, 'tests', '.rainfarm-shot-saves');
fs.mkdirSync(ART, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 雨天耕地取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver'); win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => {
    try { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.showInactive(); win.moveTop(); } catch (e) { /* ignore */ }
  }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ART, name + '.png'), img.toPNG());
    console.log('[截图] artifacts/visual/' + name + '.png');
  };
  await win.loadURL(srv.url);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await evl('return !!(window.__game && window.__test);').catch(() => false);
    if (!ready) await sleep(200);
  }
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '雨天耕地取证';
    document.querySelector('#inp-seed').value = 'rain-farm-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click(); return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl('const G=window.__game; return !G || G.state!=="playing" || G.world.genQueue.length>0 || G.world.dirtyMesh.size>0;');
    if (!busy) break;
    await sleep(300);
  }
  const setup = await evl(`
    const G = window.__game, T = window.__test;
    T.setTime(0.3); T.setWeather('clear', 600); G.mobs.maxMobs = 0; G.mobs.clear();
    /* 选一块四周足够大的干地（离海和海岸远一点），避免把试验田搭在小岛上。 */
    let bx = null, bz = null, by = null;
    for (const [ox, oz] of [[24, 0], [0, -24], [-24, 0], [0, 24], [32, 24], [-24, 32], [40, -16], [-36, -24], [48, 0]]) {
      const x = Math.floor(G.spawn.x) + ox, z = Math.floor(G.spawn.z) + oz;
      let lo = Infinity, hi = -Infinity;
      for (let dz = -7; dz <= 7; dz++) for (let dx = -8; dx <= 8; dx++) {
        const h = G.world.surfaceHeight(x + dx, z + dz);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      if (lo > G.world.seaLevel + 3 && hi - lo <= 3) { bx = x; bz = z; by = hi; break; }
    }
    if (bx === null) { bx = Math.floor(G.spawn.x) + 24; bz = Math.floor(G.spawn.z) - 24; by = G.world.surfaceHeight(bx, bz); }
    T.teleport(bx + 0.5, by + 2, bz + 0.5);
    await new Promise(r => setTimeout(r, 800));
    by = Math.floor(G.controller.pos.y);
    for (let dz = -4; dz <= 4; dz++) for (let dx = -6; dx <= 6; dx++) {
      G.world.setBlock(bx + dx, by - 1, bz + dz, 3, 0);
      for (let h = 0; h <= 6; h++) G.world.setBlock(bx + dx, by + h, bz + dz, 0, 0);
    }
    G.farmlands.clear(); G.crops.clear();
    const ex = bx + 2, sh = bx - 2;
    for (let z = bz - 1; z <= bz + 1; z++) {
      for (let x = ex - 1; x <= ex + 1; x++) {
        G.world.setBlock(x, by, z, 36, 0);
        G.farmlands.set(x + ',' + by + ',' + z, { dryT: 0, need: 55 });
      }
      for (let x = sh - 1; x <= sh + 1; x++) {
        G.world.setBlock(x, by, z, 36, 0);
        G.farmlands.set(x + ',' + by + ',' + z, { dryT: 0, need: 55 });
      }
    }
    /* 遮蔽顶用玻璃：实心挡雨，同时能从上方看见下面保持干燥的耕地。 */
    for (let z = bz - 2; z <= bz + 2; z++) for (let x = sh - 2; x <= sh + 2; x++) G.world.setBlock(x, by + 3, z, 29, 0);
    for (const [x, z] of [[sh - 2, bz - 2], [sh + 2, bz - 2], [sh - 2, bz + 2], [sh + 2, bz + 2]]) {
      G.world.setBlock(x, by + 1, z, 10, 0); G.world.setBlock(x, by + 2, z, 10, 0);
    }
    G.controller.setCreative(true); G.controller.flying = true;
    T.teleport(bx + 7.0, by + 5.0, bz + 7.0);
    const dx = bx - (bx + 7.0), dy = (by + 0.6) - (by + 5.0), dz = bz - (bz + 7.0);
    const L = Math.hypot(dx, dy, dz) || 1;
    G.controller.yaw = Math.atan2(-dx / L, -dz / L); G.controller.pitch = Math.asin(dy / L);
    T.setWeather('rain', 600);
    await new Promise(r => setTimeout(r, 4500));
    return {
      origin: { x: bx, y: by, z: bz }, ex, sh,
      exposed: T.blockAt(ex, by, bz), sheltered: T.blockAt(sh, by, bz),
      waterExposed: T.farmlandWet(ex, by, bz), waterSheltered: T.farmlandWet(sh, by, bz),
      weather: T.weatherInfo()
    };
  `);
  await shot('rainfarm-01-overview');
  const close = await evl(`
    const G = window.__game, T = window.__test;
    const s = ${JSON.stringify(setup)};
    T.teleport(s.origin.x + 5.5, s.origin.y + 3.0, s.origin.z + 5.5);
    const dx = s.origin.x - (s.origin.x + 5.5), dy = (s.origin.y + 0.6) - (s.origin.y + 3.0), dz = s.origin.z - (s.origin.z + 5.5);
    const L = Math.hypot(dx, dy, dz) || 1;
    G.controller.yaw = Math.atan2(-dx / L, -dz / L); G.controller.pitch = Math.asin(dy / L);
    await new Promise(r => setTimeout(r, 700));
    return { exposed: T.blockAt(s.ex, s.origin.y, s.origin.z), sheltered: T.blockAt(s.sh, s.origin.y, s.origin.z), weather: T.weatherInfo() };
  `);
  await shot('rainfarm-02-close');
  fs.writeFileSync(path.join(ART, 'rainfarm-samples.json'), JSON.stringify({ setup, close }, null, 2));
  console.log('[数据] artifacts/visual/rainfarm-samples.json');
  console.log(JSON.stringify({ setup, close }));
  win.destroy();
  await srv.close();
  app.quit();
}

run().catch(e => { console.error(e); app.exit(1); });
