/*
 * TNT 取证（只截图，不做断言）：
 *   cd app && npx electron tests/shot-tnt.mjs
 * 产出 artifacts/tnt-01-点燃引信.png 与 artifacts/tnt-02-爆炸坑.png。
 * 点燃走生产入口 Game.igniteTnt()（与打火石右键同一条路径），不是直接改世界。
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts');
const SHOT_SAVES = path.join(APP, 'tests', '.shot-saves');
fs.mkdirSync(ART, { recursive: true });
fs.rmSync(SHOT_SAVES, { recursive: true, force: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.setName('方块世界-TNT取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SHOT_SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · TNT 取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
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
  if (!ready) {
    console.error('前端未就绪');
    await srv.close();
    app.exit(1);
    return;
  }
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = 'TNT取证';
    document.querySelector('#inp-seed').value = 'tnt-shot';
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
    for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) T.setBlock(cx + dx, top - 1, cz + dz, 3);
    for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) {
      for (let dy = 0; dy <= 8; dy++) T.setBlock(cx + dx, top + dy, cz + dz, 0);
    }
    T.teleport(cx + 0.5, top, cz + 0.5);
    G.inventory.set(0, { item: 'flint_and_steel', count: 1, dur: 64 });
    G.selectHotbar(0);
    // 把 TNT 放在玩家正前方 4 格
    G.selectHotbar(8);
    T.placeAt(cx + 4, top, cz, 'tnt');
    G.selectHotbar(0);
    return { cx, cz, top };
  `);
  console.log('[站位] 平台 y=' + stand.top + ' TNT=(' + (stand.cx + 4) + ',' + stand.top + ',' + stand.cz + ')');
  await sleep(1200);

  const lit = await evl(`
    const G = window.__game, T = window.__test;
    G.controller.yaw = -Math.PI / 2; G.controller.pitch = -0.27;   // 面朝 +X 的 TNT
    const ok = T.igniteTnt(${stand.cx + 4}, ${stand.top}, ${stand.cz});
    return { ok, info: T.tntInfo() };
  `);
  console.log('[读数] 点燃：' + JSON.stringify(lit));
  await sleep(900);
  await shot('tnt-01-点燃引信');

  let boom = null;
  for (let i = 0; i < 30; i++) {
    boom = await evl('return window.__test.tntInfo();');
    if (boom && boom.blasts > 0) break;
    await sleep(300);
  }
  console.log('[读数] 爆炸：' + JSON.stringify(boom));
  await sleep(600);
  // 爆炸会把脚下地板一起掀掉；飞到斜上方固定机位再拍坑，避免相机掉进洞里
  await evl(`
    const G = window.__game;
    G.controller.setCreative(true);
    G.controller.flying = true;
    G.controller.pos.x = ${stand.cx + 9.5};
    G.controller.pos.y = ${stand.top + 7};
    G.controller.pos.z = ${stand.cz + 9.5};
    G.controller.vel.x = G.controller.vel.y = G.controller.vel.z = 0;
    G.controller.yaw = Math.PI / 4;
    G.controller.pitch = -0.62;
    return true;
  `);
  await sleep(700);
  await shot('tnt-02-爆炸坑');

  await srv.close();
  app.exit(0);
}

run().catch(async (e) => {
  console.error('取证失败：' + ((e && e.stack) || e));
  app.exit(1);
});
