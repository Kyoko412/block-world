/*
 * 成就 UI 取证（只截图，不做断言）：
 *   cd app && npx electron tests/shot-achievements.mjs
 * 产出 artifacts/achievements-01-toast.png 与 achievements-02-暂停清单.png。
 * toast 通过生产路径 Game.unlockAchievement() 触发（与拾取/合成时同一个方法），
 * 不是直接改 DOM 伪造。
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
  app.setName('方块世界-成就取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SHOT_SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 成就取证',
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
    const boot = await evl('return (document.getElementById("boot-error")||{}).textContent || "(无)";');
    console.error('前端未就绪，boot-error=' + boot);
    await srv.close();
    app.exit(1);
    return;
  }
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '成就取证';
    document.querySelector('#inp-seed').value = 'ach-shot';
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
    T.setTime(0.32);
    const cx = Math.floor(G.controller.pos.x), cz = Math.floor(G.controller.pos.z);
    const top = Math.max(G.world.topSolidY(cx, cz), 20) + 5;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) T.setBlock(cx + dx, top - 1, cz + dz, 1);
    for (let dx = -7; dx <= 7; dx++) for (let dz = -7; dz <= 7; dz++) {
      for (let dy = 0; dy <= 10; dy++) T.setBlock(cx + dx, top + dy, cz + dz, 0);
    }
    T.teleport(cx + 0.5, top, cz + 0.5);
    G.controller.pitch = -0.04;
    G.controller.yaw = 0.55;
    return { x: cx, z: cz, y: top };
  `);
  console.log('[站位] 平台顶面 y=' + stand.y + '（出生点 ' + stand.x + ',' + stand.z + '）');
  await sleep(1600);

  const r1 = await evl(`
    const G = window.__game, T = window.__test;
    T.resetAchievements();
    const d = G.unlockAchievement('wood');
    const d2 = G.unlockAchievement('crafting_table');
    return { d, d2, info: T.achievementsInfo() };
  `);
  console.log('[读数] toast：' + JSON.stringify(r1.info));
  await sleep(500);
  await shot('achievements-01-toast');

  const r2 = await evl(`
    const G = window.__game, T = window.__test;
    for (const id of ['cobblestone', 'furnace', 'iron_ingot', 'armor', 'shield', 'diamond']) G.unlockAchievement(id);
    G.pause();
    return T.achievementsInfo();
  `);
  console.log('[读数] 暂停清单：count=' + r2.count + ' toasts=' + r2.toasts);
  await sleep(600);
  await shot('achievements-02-暂停清单');

  await srv.close();
  app.exit(0);
}

run().catch(async (e) => {
  console.error('取证失败：' + ((e && e.stack) || e));
  app.exit(1);
});
