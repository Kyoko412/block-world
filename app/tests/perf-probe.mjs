/*
 * T2 取证脚本（只测量，不断言）：
 *   cd app && npx electron tests/perf-probe.mjs
 *
 * 为什么要单独跑：已知问题 #20 说「读档 / 批量改方块时单帧最长 2547ms」，
 * 但 2547ms 是 e2e 收尾的累计口径，看不出**成本长在哪一段**。调分帧预算之前
 * 必须先拿到这些数：单个区块的生成/光照/网格各多少毫秒、250 次 setBlock+
 * refreshImmediate 一共多少毫秒、整次读档多少毫秒、有多少个区块要灌。
 */
import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const PROBE_SAVES = path.join(APP, 'tests', '.probe-saves');
fs.rmSync(PROBE_SAVES, { recursive: true, force: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.setName('方块世界-性能取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: PROBE_SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1100, height: 700, show: true, title: '方块世界 · 取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');

  await win.loadURL(srv.url);
  for (let i = 0; i < 100 && !(await evl('return !!(window.__game && window.__test);').catch(() => false)); i++) await sleep(200);

  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '取证世界';
    document.querySelector('#inp-seed').value = 'perf-probe';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 200; i++) {
    const busy = await evl(`const G=window.__game;return !G||G.state!=='playing'||(G.world&&(G.world.genQueue.length>0||G.world.dirtyMesh.size>0));`);
    if (!busy) break;
    await sleep(300);
  }

  const worldInfo = await evl(`
    const G = window.__game;
    return { radius: G.world.radius, renderDistance: G.settings.renderDistance,
             chunks: G.world.chunks.size, generated: G.world.stats.generated,
             meshed: G.world.stats.meshed, fps: G.fps };
  `);

  // 1) 单个区块的三段成本（挑一个远处未生成的坐标，避免碰到已渲染的区块）
  const perChunk = await evl(`
    const G = window.__game;
    const cx = 400, cz = 400;
    const t0 = performance.now();
    const c = G.world.ensureChunk(cx, cz);
    const t1 = performance.now();
    const x = cx * 16 + 8, z = cz * 16 + 8, y = G.world.topSolidY(x, z) + 1;
    const t2 = performance.now();
    G.world.refreshImmediate(x, y, z, null);        // 只算光照（不建网格，view 传 null）
    const t3 = performance.now();
    G.world.refreshImmediate(x, y, z, G.view);      // 光照 + 网格
    const t4 = performance.now();
    G.view.removeChunk(c);
    return { genMs: +(t1 - t0).toFixed(2), lightMs: +(t3 - t2).toFixed(2), lightMeshMs: +(t4 - t3).toFixed(2) };
  `);

  // 2) 批量改方块：250 次 T.setBlock（每块一次 refreshImmediate）
  await evl(`const T = window.__test; T.resetPosMon(); return true;`);
  const batch = await evl(`
    const G = window.__game, T = window.__test;
    const px = Math.floor(G.controller.pos.x), pz = Math.floor(G.controller.pos.z);
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < 900 && n < 250; i++) {
      const bx = px + (i % 16) - 8, bz = pz + (((i / 16) | 0) - 8);
      if (Math.abs(bx - px) <= 1 && Math.abs(bz - pz) <= 1) continue;
      T.setBlock(bx, G.world.topSolidY(bx, bz) + 1, bz, (i % 2) ? 4 : 1);
      n++;
    }
    return { placed: n, ms: +(performance.now() - t0).toFixed(1) };
  `);
  // 这一段主循环是活的，所以监视器能看到「批量改方块 = 一帧卡住」
  const afterBatch = await evl(`
    const T = window.__test, G = window.__game;
    const m = T.posMon();
    return { maxFrameMs: m && m.maxFrameMs, slowFrames: m && m.slowFrames, frames: m && m.frames,
             dirtyMesh: G.world.dirtyMesh.size, dirtyLight: G.world.dirtyLight.size, genQueue: G.world.genQueue.length };
  `);
  // 批量改方块现在只是排队，所以要看「排空要多久」而不是同步段多久
  const drain0 = Date.now();
  let drainMs = null;
  while (Date.now() - drain0 < 20000) {
    const left = await evl(`const T = window.__test; const p = T.worldPending(); return p ? p.gen + p.light + p.mesh : -1;`);
    if (left === 0) { drainMs = Date.now() - drain0; break; }
    await sleep(100);
  }
  const settle = await evl(`
    const T = window.__test, G = window.__game;
    const m = T.posMon();
    return { maxFrameMs: m && m.maxFrameMs, slowFrames: m && m.slowFrames, frames: m && m.frames,
             dirtyMesh: G.world.dirtyMesh.size, fps: G.fps, perf: T.worldPerf() };
  `);
  const drainInfo = { drainMs };

  // 3) 整次读档的墙钟时间与读档期间的最长帧
  const fresh = await evl(`
    const G = window.__game, T = window.__test;
    T.resetPosMon();
    const t0 = performance.now();
    await G.newWorld('取证新世界', 'perf-probe-2', 'survival');
    const ms = +(performance.now() - t0).toFixed(1);
    const m = T.posMon();
    return { ms, frames: m && m.frames, maxFrameMs: m && m.maxFrameMs,
             pending: G.world.genQueue.length + '/' + G.world.dirtyLight.size + '/' + G.world.dirtyMesh.size };
  `);
  const saveMs = await evl(`
    const G = window.__game;
    const t0 = performance.now();
    await G.save('manual');
    return +(performance.now() - t0).toFixed(1);
  `);
  const reload = await evl(`
    const G = window.__game, T = window.__test;
    const name = G.meta.name;
    T.resetPosMon();
    const t0 = performance.now();
    G.toMenu();
    await new Promise(r => setTimeout(r, 120));
    await G.loadWorld(name);
    const ms = +(performance.now() - t0).toFixed(1);
    const mon = T.posMon();
    return { name, ms, state: G.state, maxFrameMs: mon && mon.maxFrameMs, slowFrames: mon && mon.slowFrames,
             frames: mon && mon.frames, loadStats: T.loadStats(), pending: T.worldPending(),
             chunks: G.world.chunks.size, perf: T.worldPerf() };
  `);

  const out = { worldInfo, perChunk, batch, afterBatch, drainInfo, settle, fresh, saveMs, reload };
  console.log('[取证] ' + JSON.stringify(out, null, 1));
  await srv.close();
  fs.rmSync(PROBE_SAVES, { recursive: true, force: true });
  app.exit(0);
}

run().catch((e) => { console.error('取证失败：' + ((e && e.stack) || e)); app.exit(1); });
