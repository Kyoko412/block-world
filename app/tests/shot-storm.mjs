/*
 * 雷暴取证（只截图，不做断言）：
 *   cd app && npx electron tests/shot-storm.mjs
 * 产出 artifacts/storm-01-雷暴压顶.png 与 storm-02-闪电落雷.png
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
  app.setName('方块世界-雷暴取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 雷暴取证',
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
    document.querySelector('#inp-name').value = '雷暴取证';
    document.querySelector('#inp-seed').value = 'storm-shot';
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
    const cx = Math.floor(G.controller.pos.x), cz = Math.floor(G.controller.pos.z);
    const top = Math.max(G.world.topSolidY(cx, cz), 20) + 2;
    for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) {
      T.setBlock(cx + dx, top - 1, cz + dz, 3);
      for (let h = 0; h <= 10; h++) T.setBlock(cx + dx, top + h, cz + dz, 0);
    }
    T.teleport(cx + 0.5, top, cz + 8.5);
    G.controller.yaw = 0; G.controller.pitch = -0.12;
    T.setWeather('clear', 100);
    T.setStorm(true);
    return { cx, cz, top };
  `);
  console.log('[雷暴] ' + JSON.stringify(info));
  await sleep(2200);
  await shot('storm-01-雷暴压顶');

  /* 闪电只亮 0.22 秒：落雷后立刻抓一张；抓完确认折线还在，否则重试 */
  for (let attempt = 0; attempt < 8; attempt++) {
    await evl(`
      const G = window.__game, T = window.__test;
      T.strikeLightningAt(${info.cx + 0}, ${info.cz - 4});
      return true;
    `);
    await sleep(60);                       // 让这一帧真的渲染出来再抓（闪电总时长 0.22s）
    const img = await win.webContents.capturePage();
    const vis = await evl('return !!(window.__test.thunderInfo().bolt && window.__test.thunderInfo().bolt.visible);');
    if (vis || attempt === 7) {
      fs.writeFileSync(path.join(ART, 'storm-02-闪电落雷.png'), img.toPNG());
      console.log('[截图] artifacts/storm-02-闪电落雷.png（折线可见=' + vis + '，尝试 ' + (attempt + 1) + '）');
      break;
    }
    await sleep(450);
  }

  await srv.close();
  app.exit(0);
}
run().catch(async (e) => { console.error('取证失败：' + ((e && e.stack) || e)); app.exit(1); });
