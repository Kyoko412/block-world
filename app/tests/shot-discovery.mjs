/*
 * R3 发现感取证：固定种子，真实按住 W 走进制发现半径，拍「发现：某某」提示 + 地图标记 + 暂停界面。
 *   cd app && npx electron tests/shot-discovery.mjs
 * 产出 artifacts/visual/landmarks-r3-{toast,map,pause,loaded}.png 与 landmarks-r3-samples.json
 *
 * 说明：这里只做取证，不改产品逻辑。窗口每 0.5 秒被宿主 showInactive/moveTop 一次，
 * window blur 会清空按键状态，所以走路时每帧重新按下 KeyW（仍然是真实键盘链路）。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const SAVES = path.join(APP, 'tests', '.discovery-shot-saves');
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
    width: 1280, height: 720, show: true, title: '方块世界 · 发现感取证',
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
    document.querySelector('#inp-name').value = '发现取证';
    document.querySelector('#inp-seed').value = 'r3-discovery-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click(); return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl('const G=window.__game; return !G || G.state!=="playing" || G.world.genQueue.length>0;');
    if (!busy) break;
    await sleep(300);
  }

  /* 1) 找一个附近候选站点，先站在触发半径内、发现半径外（只建造，不该有提示/标记） */
  const target = await evl(`
    const G = window.__game, T = window.__test;
    G.mobs.maxMobs = 0; T.setTime(0.35); T.setWeather('clear', 600);
    let cands = T.landmarkCandidates();
    for (let hop = 0; hop < 6 && !(cands && cands.length); hop++) {
      T.teleport(G.controller.pos.x + 96, G.world.surfaceHeight(G.controller.pos.x + 96, G.controller.pos.z) + 2, G.controller.pos.z);
      await new Promise(r => setTimeout(r, 900));
      cands = T.landmarkCandidates();
    }
    if (!cands || !cands.length) return { error: '附近没有候选站点' };
    const c = cands[0];
    T.teleport(c.x + 0.5, G.world.surfaceHeight(c.x, c.z + 25) + 2, c.z + 25);
    await new Promise(r => setTimeout(r, 2000));
    const rec = T.landmarksInfo().list.find(l => l.id === c.id);
    return { cand: c, rec, info: T.landmarksInfo(), map: T.mapInfo(), ach: T.achievementsInfo() };
  `);
  if (!target || target.error) { console.log('[取证失败]', JSON.stringify(target)); }
  await shot('landmarks-r3-before');

  /* 2) 真实按 W 走进发现半径；一发现就立刻截图（提示与成就 toast 都还在屏上） */
  const walk = await evl(`
    const G = window.__game, T = window.__test;
    const id = ${JSON.stringify(target.cand && target.cand.id)};
    const rec = T.landmarksInfo().list.find(l => l.id === id);
    if (!rec) return { error: '没建成' };
    const baseDisc = T.landmarksInfo().stats.discoveries;
    T.teleport(rec.x + 0.5, rec.y + 1.2, rec.z + 20);
    await new Promise(r => setTimeout(r, 700));
    const start = { x: G.controller.pos.x, z: G.controller.pos.z };
    const end = performance.now() + 16000;
    let off = 0, okWalk = false;
    const heads = [0, 1.1, -1.1, 2.2, -2.2];
    while (performance.now() < end && !okWalk) {
      const dx = rec.x - G.controller.pos.x, dz = rec.z - G.controller.pos.z;
      G.controller.yaw = Math.atan2(-dx, -dz) + heads[off]; G.controller.pitch = 0;
      let guard = 0;
      while (performance.now() < end && guard++ < 40) {
        T.key('KeyW', true);
        await new Promise(r => requestAnimationFrame(r));
        if (T.landmarksInfo().stats.discoveries > baseDisc) { okWalk = true; break; }
      }
      T.key('KeyW', false);
      if (okWalk) break;
      if (guard >= 40) off = Math.min(off + 1, heads.length - 1);
    }
    return {
      walked: +Math.hypot(G.controller.pos.x - start.x, G.controller.pos.z - start.z).toFixed(2),
      okWalk,
      toastDom: document.querySelector('#toast-wrap').textContent,
      achToastDom: document.querySelector('#ach-toast').textContent,
      info: T.landmarksInfo(), map: T.mapInfo(), ach: T.achievementsInfo()
    };
  `);
  const toastLive = await evl(`
    await new Promise(r => setTimeout(r, 350));
    const wrap = document.querySelector('#toast-wrap');
    const nodes = Array.from(wrap.children).map(n => {
      const cs = getComputedStyle(n), r = n.getBoundingClientRect();
      return { text: n.textContent, opacity: cs.opacity, cls: n.className, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
    });
    const ach = document.querySelector('#ach-toast');
    return { nodes, achShow: ach.classList.contains('show'), achText: ach.textContent };
  `);
  await shot('landmarks-r3-toast');
  await shot('landmarks-r3-toast2');

  /* 3) 真实右键打开地图：金菱标记 + 名称清单 */
  const mapShot = await evl(`
    const G = window.__game, T = window.__test;
    if (G.openUI) G.closeUI();
    await new Promise(r => setTimeout(r, 200));
    G.inventory.set(0, { item: 'map', count: 1 }); G.selectHotbar(0);
    await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
    G.interaction.placeCd = 0;
    G.input.state.mouseRight = true; G.interaction.update(0.02);
    await new Promise(r => setTimeout(r, 350));
    G.input.state.mouseRight = false; G.interaction.update(0.02);
    await new Promise(r => setTimeout(r, 400));
    return { openUI: G.openUI, map: T.mapInfo(), chips: Array.from(document.querySelectorAll('#map-markers .map-marker')).map(n => n.textContent) };
  `);
  await shot('landmarks-r3-map');

  /* 4) 暂停界面：8 个基础成就 + 额外的探索者 + 已发现地点清单 */
  const pauseShot = await evl(`
    const G = window.__game, T = window.__test;
    if (G.openUI) G.closeUI();
    await new Promise(r => setTimeout(r, 250));
    const closedUI = G.openUI;
    const scr = document.querySelector('#screen-pause');
    let visible = false, tries = 0;
    while (!visible && tries++ < 8) {
      G.pause();
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => requestAnimationFrame(r));
      visible = !!scr && !scr.classList.contains('hidden');
      if (!visible) { await new Promise(r => setTimeout(r, 120)); G.resume(); await new Promise(r => setTimeout(r, 60)); }
    }
    const box = document.querySelector('#achievement-list');
    const placesEl = box.querySelector('.ach-places');
    if (placesEl && placesEl.scrollIntoView) placesEl.scrollIntoView({ block: 'end' });
    await new Promise(r => setTimeout(r, 120));
    return {
      closedUI, state: G.state, pauseVisible: visible, tries,
      head: box.querySelector('.ach-head').textContent,
      rows: box.querySelectorAll('.ach-row').length,
      rowsOn: box.querySelectorAll('.ach-row.on').length,
      extra: box.querySelector('.ach-extra') ? box.querySelector('.ach-extra').textContent : null,
      places: box.querySelector('.ach-places') ? box.querySelector('.ach-places').textContent : null
    };
  `);
  await shot('landmarks-r3-pause');

  /* 5) 存档往返后：标记仍在、不重新弹提示、探索者仍在（基础 8 个计数不变） */
  await evl('window.__game.resume(); await window.__game.save("manual"); await new Promise(r => setTimeout(r, 400)); return true;');
  await evl('window.__game.toMenu(); await new Promise(r => setTimeout(r, 500)); return true;');
  await evl('await window.__game.loadWorld("发现取证"); return true;');
  for (let i = 0; i < 120; i++) {
    const st = await evl('return window.__game.state;');
    if (st === 'playing') break;
    await sleep(300);
  }
  const loaded = await evl(`
    const G = window.__game, T = window.__test;
    G.mobs.maxMobs = 0;
    await new Promise(r => setTimeout(r, 1800));
    return { info: T.landmarksInfo(), map: T.mapInfo(), ach: T.achievementsInfo(), toastDom: document.querySelector('#toast-wrap').textContent };
  `);
  await shot('landmarks-r3-loaded');

  const samples = {
    world: '发现取证', seed: 'r3-discovery-2026',
    before: target, walk, toastLive, map: mapShot, pause: pauseShot, loaded
  };
  fs.writeFileSync(path.join(ART, 'landmarks-r3-samples.json'), JSON.stringify(samples, null, 2));
  console.log('[数据] artifacts/visual/landmarks-r3-samples.json');
  console.log(JSON.stringify({
    站点: target && target.cand,
    走路: { walked: walk.walked, ok: walk.okWalk, toast: walk.toastDom, achToast: walk.achToastDom },
    发现后: { discoveries: walk.info.stats.discoveries, toasts: walk.info.stats.discoveryToasts, markers: walk.map.markerCount, explorer: walk.ach.explorer },
    地图: { openUI: mapShot.openUI, chips: mapShot.chips, marker: mapShot.map.markers },
    暂停: pauseShot,
    读档: { disc: loaded.info.discovered, toasts: loaded.info.stats.discoveryToasts, markers: loaded.map.markerCount, ach: loaded.ach }
  }, null, 1));
  win.destroy();
  await srv.close();
  app.quit();
}

run().catch(e => { console.error(e); app.exit(1); });
