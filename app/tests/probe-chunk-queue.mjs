/*
 * 阶段 6 取证：R4.0 的「区块队列」到底是什么量。
 *   cd app && npx electron tests/probe-chunk-queue.mjs
 *
 * 背景：成品自检读到 queue=49/47/49/43/40，越过 queue<40 的旧判据；
 * 源码同一份代码读到 21~31。要分清三件事：
 *   ① 队列是**流式加载**的待办量：`setCenter` 一次把半径内未生成的区块全排进来；
 *   ② 玩家每站传送一次 → 队列被重新灌满 → 读数是「这一刻排到哪」，不是「会不会积压」；
 *   ③ 消费速度是否被本轮改动（水面 UV / 动物贴图）拖慢。
 *
 * 探针只做有界观测：每次传送到站点后，按帧记录 genQueue 长度，直到排空或 6 秒上限，
 * 输出「灌入峰值 / 排空耗时 / 每秒消费块数 / 单块生成与网格成本」。
 * 不修改产品、不进验收门禁。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'probe-chunk-queue.json');
const SAVES = path.join(APP, 'tests', '.queue-saves');
fs.mkdirSync(SAVES, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '队列探针',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => { try { if (win.isDestroyed()) return; win.showInactive(); win.moveTop(); } catch (e) { } }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { } });
  await win.loadURL(srv.url);
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript('!!(window.__game && window.__test)').catch(() => false)) break;
    await sleep(200);
  }
  await win.webContents.executeJavaScript("window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));true");
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '队列探针';
    document.querySelector('#inp-seed').value = 'r4-route-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    true;
  `);
  for (let i = 0; i < 240; i++) {
    if (await win.webContents.executeJavaScript('const G=window.__game;return G.state==="playing"&&G.world&&G.world.genQueue.length===0;').catch(() => false)) break;
    await sleep(250);
  }
  await sleep(800);

  const res = await win.webContents.executeJavaScript(`(async () => {
    const G = window.__game, T = window.__test;
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    const out = { renderDistance: G.settings.renderDistance, sites: [] };

    /* 与 R4.0 同一条路线：五处站点（数值种子来自离线算好的固定路线） */
    const route = [
      { id: '0,-3', x: 24, z: -240 }, { id: '1,0', x: 120, z: 48 },
      { id: '4,-4', x: 432, z: -360 }, { id: '-3,0', x: -240, z: 48 }, { id: '4,3', x: 452, z: 316 }
    ];
    for (const s of route) {
      const y = G.world.topSolidY(s.x, s.z) + 2;
      T.teleport(s.x + 0.5, y, s.z + 0.5);
      G.world.setCenter(s.x, s.z);
      /* 传送后第一帧的队列长度 = 「灌入峰值」 */
      await frame();
      const peak = G.world.genQueue.length;
      const t0 = performance.now();
      let min = peak, frames = 0, last = peak;
      const trail = [];
      while (performance.now() - t0 < 6000) {
        await frame();
        frames++;
        const q = G.world.genQueue.length;
        last = q;
        min = Math.min(min, q);
        if (frames % 6 === 0 && trail.length < 10) trail.push(q);
        if (q === 0) break;
      }
      const ms = Math.round(performance.now() - t0);
      const perf = T.perfTotals ? T.perfTotals() : null;
      out.sites.push({
        id: s.id, peak, last, min, frames, ms,
        drained: min === 0,
        chunksPerSec: +(peak / Math.max(0.001, ms / 1000)).toFixed(1),
        chunks: G.world.chunks.size,
        trail,
        liveGen: perf ? perf.live && perf.live.genChunks : null,
        liveMesh: perf ? perf.live && perf.live.meshChunks : null
      });
      await new Promise(r => setTimeout(r, 400));
    }
    /* 「已经排空之后再读一次」：这就是修正后的取样语义 —— 读数是 0，而不是 40 */
    out.afterDrain = out.sites.map(s => s.min);
    return out;
  })()`);
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
  console.log('渲染距离=' + res.renderDistance);
  for (const s of res.sites) {
    console.log(s.id.padEnd(6), '灌入峰值=' + String(s.peak).padStart(3),
      '排空后=' + s.last, '最小=' + s.min, '耗时=' + String(s.ms).padStart(4) + 'ms',
      '帧=' + s.frames, '消费=' + s.chunksPerSec + '块/秒', '区块=' + s.chunks,
      '轨迹=' + JSON.stringify(s.trail));
  }
  console.log('→ ' + OUT);
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
