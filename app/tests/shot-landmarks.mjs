/*
 * R2 探索地点取证：固定种子，实际走近触发三类地点，拍外观/内部/箱子。
 *   cd app && npx electron tests/shot-landmarks.mjs
 * 产出 artifacts/visual/landmarks-*.png 与 landmarks-samples.json
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const SAVES = path.join(APP, 'tests', '.landmark-shot-saves');
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
    width: 1280, height: 720, show: true, title: '方块世界 · 探索地点取证',
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
    document.querySelector('#inp-name').value = '地点取证';
    document.querySelector('#inp-seed').value = 'acceptance-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click(); return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl('const G=window.__game; return !G || G.state!=="playing" || G.world.genQueue.length>0 || G.world.dirtyMesh.size>0;');
    if (!busy) break;
    await sleep(300);
  }
  const specs = [
    { type: 'outpost', x: 24, z: 48, tag: 'outpost' },
    { type: 'tower', x: 356, z: 68, tag: 'tower' },
    { type: 'ruin', x: 124, z: -412, tag: 'ruin' }
  ];
  const samples = { specs: [], shots: [] };
  for (const s of specs) {
    const built = await evl(`
      const G = window.__game, T = window.__test;
      T.setTime(0.3); T.setWeather('clear', 600); G.mobs.maxMobs = 0; G.mobs.clear();
      T.teleport(${s.x} + 6.5, G.world.surfaceHeight(${s.x} + 6, ${s.z}) + 2, ${s.z} + 0.5);
      await new Promise(r => setTimeout(r, 1600));
      const rec = T.landmarksInfo().list.find(l => l.type === ${JSON.stringify(s.type)});
      if (!rec) return { error: 'not built', info: T.landmarksInfo() };
      return rec;
    `);
    samples.specs.push(built);
    if (!built || built.error) continue;
    /* 外观：飞到斜上方；只清掉挡住镜头的树叶/外围树干（不碰结构半径 4 内）。 */
    await evl(`
      const G = window.__game, T = window.__test;
      const rec = ${JSON.stringify(built)};
      for (let dz = -10; dz <= 10; dz++) for (let dx = -10; dx <= 10; dx++) {
        if (Math.hypot(dx, dz) <= 4.5) continue;
        for (let y = rec.y; y <= rec.y + 12; y++) {
          const id = G.world.getBlock(rec.x + dx, y, rec.z + dz);
          if (id === 11 || id === 13 || id === 10 || id === 12) G.world.setBlock(rec.x + dx, y, rec.z + dz, 0, 0);
        }
      }
      await new Promise(r => setTimeout(r, 700));
      G.controller.setCreative(true); G.controller.flying = true;
      T.teleport(rec.x + 7.5, rec.y + 4.5, rec.z + 7.5);
      const dx = rec.x - (rec.x + 7.5), dy = (rec.y + 1.4) - (rec.y + 4.5), dz = rec.z - (rec.z + 7.5);
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.yaw = Math.atan2(-dx / L, -dz / L); G.controller.pitch = Math.asin(dy / L);
      await new Promise(r => setTimeout(r, 700));
      return true;
    `);
    await shot('landmarks-' + s.tag + '-exterior');

    /* 内部/箱子：走进门口，真实右键开箱。 */
    const inside = await evl(`
      const G = window.__game, T = window.__test;
      const rec = ${JSON.stringify(built)};
      G.controller.setCreative(false); G.controller.flying = false;
      T.teleport(rec.x + 0.5, rec.y + 1.05, rec.z + 3.8);
      await new Promise(r => setTimeout(r, 500));
      G.controller.yaw = 0; G.controller.pitch = 0;
      T.key('KeyW', true);
      await new Promise(r => setTimeout(r, 1000));
      T.key('KeyW', false);
      await new Promise(r => setTimeout(r, 250));
      const ch = rec.chests[0];
      const walk = { x: G.controller.pos.x, y: G.controller.pos.y, z: G.controller.pos.z };
      G.controller.setCreative(true); G.controller.flying = true;
      const view = rec.type === 'tower'
        ? { x: rec.x + 1.2, y: rec.y + 2.2, z: rec.z + 1.4 }
        : { x: rec.x + 2.4, y: rec.y + 2.1, z: rec.z + 3.2 };
      T.teleport(view.x, view.y, view.z);
      const dx = (rec.x + 0.2) - view.x, dy = (rec.y + 0.8) - view.y, dz = (rec.z + 0.2) - view.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.pitch = Math.asin(dy / L); G.controller.yaw = Math.atan2(-dx / L, -dz / L);
      await new Promise(r => setTimeout(r, 400));
      return { walk, pos: { x: +G.controller.pos.x.toFixed(2), y: +G.controller.pos.y.toFixed(2), z: +G.controller.pos.z.toFixed(2) }, chest: ch };
    `);
    samples.shots.push({ tag: s.tag, inside });
    await shot('landmarks-' + s.tag + '-inside');
    const opened = await evl(`
      const G = window.__game, T = window.__test;
      const rec = ${JSON.stringify(built)};
      const walk = ${JSON.stringify(inside.walk)};
      const ch = rec.chests[0];
      G.controller.setCreative(true); G.controller.flying = true;
      T.teleport(walk.x, walk.y, walk.z);
      const dx = (ch.x + 0.5) - G.controller.pos.x, dy = (ch.y + 0.5) - G.controller.eyeY, dz = (ch.z + 0.5) - G.controller.pos.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.pitch = Math.asin(dy / L); G.controller.yaw = Math.atan2(-dx / L, -dz / L);
      G.interaction.placeCd = 0;
      G.input.state.mouseRight = true; G.interaction.update(0.02);
      G.input.state.mouseRight = false; G.interaction.update(0.02);
      await new Promise(r => setTimeout(r, 450));
      return { openUI: G.openUI, slots: document.querySelectorAll('#chest-grid .slot').length };
    `);
    samples.shots[samples.shots.length - 1].opened = opened;
    await shot('landmarks-' + s.tag + '-chest');
    await evl('window.__game.closeUI(); await new Promise(r => setTimeout(r, 200)); return true;');
  }
  samples.final = await evl('return window.__test.landmarksInfo();');
  fs.writeFileSync(path.join(ART, 'landmarks-samples.json'), JSON.stringify(samples, null, 2));
  console.log('[数据] artifacts/visual/landmarks-samples.json');
  console.log(JSON.stringify(samples));
  win.destroy();
  await srv.close();
  app.quit();
}

run().catch(e => { console.error(e); app.exit(1); });
