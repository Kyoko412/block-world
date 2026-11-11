/*
 * R4 取证：固定种子 + 固定路线，拍三处地点「探索前 / 探索后」对比图，并记录性能读数。
 *   cd app && npx electron tests/shot-route.mjs
 * 产出 artifacts/visual/route-<tag>-{before,after}.png 与 route-perf.json
 *
 * 说明：探索前的机位刻意站在触发半径（28 格）之外，所以那一帧里站点位置还是纯自然地形；
 * 之后真实走近让它建造，再飞到同一个观察角度拍「探索后」，两张图用同一组相机参数便于对比。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const SAVES = path.join(APP, 'tests', '.route-shot-saves');
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
    width: 1280, height: 720, show: true, title: '方块世界 · 探索路线取证',
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
    document.querySelector('#inp-name').value = '路线取证';
    document.querySelector('#inp-seed').value = 'r4-route-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click(); return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl('const G=window.__game; return !G || G.state!=="playing" || G.world.genQueue.length>0;');
    if (!busy) break;
    await sleep(300);
  }
  const sites = [
    { id: '0,-3', tag: 'tower-a', x: 24, z: -240 },
    { id: '4,-4', tag: 'outpost', x: 432, z: -360 },
    { id: '-3,0', tag: 'ruin', x: -240, z: 48 }
  ];
  const out = { seed: 'r4-route-2026', world: '路线取证', sites: [], summary: {} };
  out.summary.start = await evl(`
    const G = window.__game, T = window.__test;
    G.mobs.maxMobs = 0; T.setTime(0.32); T.setWeather('clear', 900);
    T.resetPosMon();
    return { info: T.landmarksInfo(), chunks: G.world.chunks.size, queue: G.world.pending(), worldPerf: T.worldPerf() };
  `);
  for (const s of sites) {
    /* 探索前：站在 44 格外（触发半径 28 之外），同一坐标仍然是自然地形 */
    const before = await evl(`
      const G = window.__game, T = window.__test;
      const s = ${JSON.stringify(s)};
      G.controller.setCreative(true); G.controller.flying = true;
      T.teleport(s.x + 0.5, G.world.surfaceHeight(s.x, s.z + 44) + 6, s.z + 44.5);
      await new Promise(r => setTimeout(r, 1400));
      const dx = s.x - G.controller.pos.x, dy = (G.world.surfaceHeight(s.x, s.z) + 1.5) - G.controller.eyeY, dz = s.z - G.controller.pos.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.yaw = Math.atan2(-dx / L, -dz / L); G.controller.pitch = Math.asin(dy / L);
      await new Promise(r => setTimeout(r, 700));
      const rec = T.landmarksInfo().list.find(l => l.id === s.id);
      return { pos: [ +G.controller.pos.x.toFixed(1), +G.controller.pos.y.toFixed(1), +G.controller.pos.z.toFixed(1) ],
               rec: rec || null, built: T.landmarksInfo().built, chunks: G.world.chunks.size, queue: G.world.pending() };
    `);
    await shot('route-' + s.tag + '-before');
    /* 真实走近：站到 24 格（触发半径内）+ 按住 W 走 0.8 秒 */
    const after = await evl(`
      const G = window.__game, T = window.__test;
      const s = ${JSON.stringify(s)};
      G.controller.setCreative(false); G.controller.flying = false;
      T.teleport(s.x + 0.5, G.world.surfaceHeight(s.x, s.z + 24) + 2, s.z + 24.5);
      await new Promise(r => setTimeout(r, 800));
      const end = performance.now() + 800;
      G.controller.yaw = 0; G.controller.pitch = 0;
      while (performance.now() < end) { T.key('KeyW', true); await new Promise(r => requestAnimationFrame(r)); }
      T.key('KeyW', false);
      await new Promise(r => setTimeout(r, 2000));
      const info = T.landmarksInfo();
      const rec = info.list.find(l => l.id === s.id);
      /* 飞回与「探索前」同一观察角度，方便两张图对比 */
      G.controller.setCreative(true); G.controller.flying = true;
      T.teleport(s.x + 0.5, G.world.surfaceHeight(s.x, s.z + 44) + 6, s.z + 44.5);
      await new Promise(r => setTimeout(r, 1200));
      const dx = s.x - G.controller.pos.x, dy = (G.world.surfaceHeight(s.x, s.z) + 1.5) - G.controller.eyeY, dz = s.z - G.controller.pos.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.yaw = Math.atan2(-dx / L, -dz / L); G.controller.pitch = Math.asin(dy / L);
      await new Promise(r => setTimeout(r, 700));
      return { rec: rec || null, built: info.built, stats: info.stats, chunks: G.world.chunks.size,
               queue: G.world.pending(), worldPerf: T.worldPerf(), posMon: T.posMon() };
    `);
    await shot('route-' + s.tag + '-after');
    /* 远处同机位两张已经能证明「走近前后有无结构」，再补一张近景，方便肉眼看清模板与入口 */
    const close = await evl(`
      const G = window.__game, T = window.__test;
      const s = ${JSON.stringify(s)};
      const rec = T.landmarksInfo().list.find(l => l.id === s.id);
      if (!rec) return { error: 'no rec' };
      /* 取证用：只清站点半径外的树冠/树干，让近景看得清（临时存档目录，不影响产品逻辑） */
      let cleared = 0;
      for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) {
        if (Math.hypot(dx, dz) <= rec.radius + 1.5) continue;
        for (let y = rec.y - 1; y <= rec.y + 12; y++) {
          const id = G.world.getBlock(rec.x + dx, y, rec.z + dz);
          if (id === 11 || id === 12 || id === 13 || id === 10) { G.world.setBlock(rec.x + dx, y, rec.z + dz, 0, 0); cleared++; }
        }
      }
      await new Promise(r => setTimeout(r, 900));
      G.controller.setCreative(true); G.controller.flying = true;
      const cam = { x: rec.x + 8.5, y: rec.y + 3.2, z: rec.z + 9.5 };
      T.teleport(cam.x, cam.y, cam.z);
      await new Promise(r => setTimeout(r, 900));
      const dx = rec.x - cam.x, dy = (rec.y + 1.2) - (cam.y + 1.6), dz = rec.z - cam.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.yaw = Math.atan2(-dx / L, -dz / L); G.controller.pitch = Math.asin(dy / L);
      await new Promise(r => setTimeout(r, 700));
      return { cam: [ +cam.x.toFixed(1), +cam.y.toFixed(1), +cam.z.toFixed(1) ], rec: rec.id + '/' + rec.type };
    `);
    await shot('route-' + s.tag + '-close');
    out.sites.push({ want: s, before, after, close });
  }
  out.summary.end = await evl(`
    const G = window.__game, T = window.__test;
    return { info: T.landmarksInfo(), chunks: G.world.chunks.size, queue: G.world.pending(),
             worldPerf: T.worldPerf(), posMon: T.posMon(), map: T.mapInfo() };
  `);
  /* 存档往返一次，确认路线读数能落盘 */
  out.summary.roundTrip = await evl(`
    const G = window.__game, T = window.__test;
    await G.save('manual'); G.toMenu();
    await new Promise(r => setTimeout(r, 500));
    await G.loadWorld('路线取证');
    await new Promise(r => setTimeout(r, 2500));
    const info = T.landmarksInfo();
    return { built: info.built, discovered: info.discovered, builds: info.stats.builds,
             markers: T.mapInfo().markerCount, chunks: G.world.chunks.size };
  `);
  fs.writeFileSync(path.join(ART, 'route-perf.json'), JSON.stringify(out, null, 2));
  console.log('[数据] artifacts/visual/route-perf.json');
  console.log(JSON.stringify({
    起点: { built: out.summary.start.info.built, chunks: out.summary.start.chunks },
    每站: out.sites.map(x => ({ id: x.want.id, 探索前已建: !!x.before.rec, 探索后: x.after.rec ? x.after.rec.type + '@' + x.after.rec.x + ',' + x.after.rec.z + ' ' + x.after.rec.present + '/' + x.after.rec.expected : null, 建造ms: x.after.stats.maxBuildMs, 扫描ms: x.after.stats.maxScanMs, 区块: x.after.chunks, 队列: x.after.queue })),
    终点: { built: out.summary.end.info.built, chunks: out.summary.end.chunks, 最长帧: out.summary.end.posMon.total.maxFrameMs, 慢帧: out.summary.end.posMon.total.slowFrames, 帧数: out.summary.end.posMon.total.frames, 标记: out.summary.end.map.markerCount },
    往返: out.summary.roundTrip
  }, null, 1));
  win.destroy();
  await srv.close();
  app.quit();
}

run().catch(e => { console.error(e); app.exit(1); });
