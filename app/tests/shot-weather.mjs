/*
 * 天气界面取证（只截图，不做断言）：
 *   cd app && npx electron tests/shot-weather.mjs
 * 产出 artifacts/06-下雨.png 与 artifacts/07-下雪.png。
 *
 * 为什么要单独一个脚本：e2e 剧本跑满全程时，渲染进程几乎不让出主线程，
 * 宿主每 300ms 的轮询实际只在剧本结束后拿到一次状态，中途请求的截图会拍到最终画面
 * （实测：请求「下雨」截图得到的却是晴天的收尾画面）。所以视觉取证单独跑一次，
 * 每一步都用 await 让宿主真正回到页面里截图。
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
  app.setName('方块世界-天气取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SHOT_SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 天气取证',
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
    document.querySelector('#inp-name').value = '天气取证';
    document.querySelector('#inp-seed').value = 'weather-shot';
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
  // 正午、平视、露天：在出生点上方架一个石头平台站上去，
  // 否则出生点可能长在树林里，树冠会触发「头顶遮挡」把雨压到几乎看不见（第一版就拍成一堆树叶）
  const stand = await evl(`
    const G = window.__game, T = window.__test;
    T.setTime(0.3);
    const cx = Math.floor(G.controller.pos.x), cz = Math.floor(G.controller.pos.z);
    const top = Math.max(G.world.topSolidY(cx, cz), 20) + 6;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) T.setBlock(cx + dx, top - 1, cz + dz, 1);
    T.teleport(cx + 0.5, top, cz + 0.5);
    // 站上平台后把四周 15×15、上方 12 格清空：第一版没清，人正好长在树冠里，画面全是树叶
    for (let dx = -7; dx <= 7; dx++) for (let dz = -7; dz <= 7; dz++) {
      for (let dy = 0; dy <= 12; dy++) T.setBlock(cx + dx, top + dy, cz + dz, 0);
    }
    G.controller.pitch = -0.12;
    return { x: cx, z: cz, y: top };
  `);
  console.log('[站位] 平台顶面 y=' + stand.y + '（出生点 ' + stand.x + ',' + stand.z + '）');
  await sleep(1800);        // 等区块网格重建完再拍

  const rain = await evl(`
    const T = window.__test;
    T.setWeather('rain', 600);
    T.tickWeather(0.05, 400);
    return T.weatherInfo();
  `);
  console.log('[读数] 雨：type=' + (rain && rain.type) + ' shelter=' + (rain && rain.shelter) + ' intensity=' + (rain && rain.intensity) + ' 粒子=' + JSON.stringify(rain && rain.fx) + ' uCloud=' + (rain && rain.uCloud) + ' uDay=' + (rain && rain.uDay));
  await sleep(1500);
  await shot('06-下雨');

  const snow = await evl(`
    const T = window.__test;
    T.setWeather('snow', 600);
    T.tickWeather(0.05, 400);
    return T.weatherInfo();
  `);
  console.log('[读数] 雪：type=' + (snow && snow.type) + ' shelter=' + (snow && snow.shelter) + ' intensity=' + (snow && snow.intensity) + ' 粒子=' + JSON.stringify(snow && snow.fx) + ' uCloud=' + (snow && snow.uCloud) + ' uDay=' + (snow && snow.uDay));
  await sleep(1500);
  await shot('07-下雪');

  await srv.close();
  app.exit(0);
}

run().catch(async (e) => {
  console.error('取证失败：' + ((e && e.stack) || e));
  app.exit(1);
});
