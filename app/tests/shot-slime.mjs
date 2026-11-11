/*
 * 史莱姆取证（只截图，不做断言）：
 *   cd app && npx electron tests/shot-slime.mjs
 * 产出 artifacts/slime-01-史莱姆与粘液块.png。
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
  app.setName('方块世界-史莱姆取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 史莱姆取证',
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
    document.querySelector('#inp-name').value = '史莱姆取证';
    document.querySelector('#inp-seed').value = 'slime-shot';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 200; i++) {
    const busy = await evl(`
      const G = window.__game;
      return !G || G.state !== 'playing' || (G.world && (G.world.genQueue.length > 0 || G.world.dirtyMesh.size > 0));
    `);
    if (!busy) break;
    await sleep(300);
  }

  const stand = await evl(`
    const G = window.__game, T = window.__test;
    T.setTime(0.3);
    const cx = Math.floor(G.controller.pos.x), cz = Math.floor(G.controller.pos.z);
    const top = Math.max(G.world.topSolidY(cx, cz), 20) + 4;
    for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) T.setBlock(cx + dx, top - 1, cz + dz, 3);
    for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
      for (let dy = 0; dy <= 8; dy++) T.setBlock(cx + dx, top + dy, cz + dz, 0);
    }
    T.teleport(cx + 0.5, top, cz + 6.5);
    G.controller.yaw = 0; G.controller.pitch = -0.08;
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.mobs.spawn('slime', cx + 0.5, top, cz - 1.5, { slimeSize: 4 });
    G.mobs.spawn('slime', cx + 3.0, top, cz - 1.0, { slimeSize: 2 });
    G.mobs.spawn('slime', cx - 2.5, top, cz - 1.0, { slimeSize: 1 });
    G.selectHotbar(8);
    T.placeAt(cx + 5, top, cz + 1, 'slime_block');
    return { cx, cz, top };
  `);
  console.log('[站位] ' + JSON.stringify(stand));
  await sleep(1800);
  const st = await evl('return window.__test.slimeInfo();');
  console.log('[读数] ' + JSON.stringify(st));
  await shot('slime-01-史莱姆与粘液块');

  await srv.close();
  app.exit(0);
}

run().catch(async (e) => { console.error('取证失败：' + ((e && e.stack) || e)); app.exit(1); });
