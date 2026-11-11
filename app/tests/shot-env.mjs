/*
 * V6 环境一致性取证：同一场地检查晴/黄昏/夜/雨/洞穴与生存/创造 HUD。
 *   cd app && npx electron tests/shot-env.mjs
 * 产出 artifacts/visual/env/*.png 与 meta.json（含 fps/三角形/光照读数）。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'visual', 'env');
const SAVES = path.join(APP, 'tests', '.env-saves');
fs.mkdirSync(OUT, { recursive: true });
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
    width: 1280, height: 720, show: true, title: '方块世界 · 环境取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver'); win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => {
    try { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.showInactive(); win.moveTop(); } catch (e) { /* ignore */ }
  }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  const meta = { seed: 'visual-audit-2026', window: { width: 1280, height: 720 }, settings: {}, scenes: [] };
  const shot = async (name) => {
    await evl("const w=document.querySelector('#toast-wrap'); if(w) w.innerHTML=''; const a=document.querySelector('#ach-toast'); if(a) a.classList.remove('show'); return true;");
    const img = await win.webContents.capturePage();
    const size = img.getSize();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    const info = await evl(`
      const G=window.__game, T=window.__test;
      const st=T.state();
      return { state: st.gameState, time: +G.time.toFixed(4), weather: T.weatherInfo(),
        fps: st.fps, triangles: G.view.triangles, perf: T.worldPerf(), uDay: +G.view.uniforms.uDay.value.toFixed(4),
        fogNear: +G.view.uniforms.uFogNear.value.toFixed(1), fogFar: +G.view.uniforms.uFogFar.value.toFixed(1),
        pos: { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2) } };
    `);
    console.log('[截图] artifacts/visual/env/' + name + '.png ' + size.width + 'x' + size.height + ' fps=' + info.fps);
    meta.scenes.push({ name, image: size, info });
  };

  await win.loadURL(srv.url);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await evl('return !!(window.__game && window.__test);').catch(() => false);
    if (!ready) await sleep(200);
  }
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '环境取证';
    document.querySelector('#inp-seed').value = 'visual-audit-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click(); return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl('const G=window.__game; return !G || G.state!=="playing" || G.world.genQueue.length>0 || G.world.dirtyMesh.size>0;');
    if (!busy) break;
    await sleep(300);
  }
  const base = await evl(`
    const G=window.__game, T=window.__test;
    G.settings.renderDistance = 6; G.settings.brightness = 1; G.settings.fov = 70;
    G.mobs.maxMobs = 0; G.mobs.clear();
    const x = Math.floor(G.spawn.x) - 40, z = Math.floor(G.spawn.z);
    T.teleport(x + 0.5, G.world.surfaceHeight(x, z) + 2, z + 0.5);
    await new Promise(r => setTimeout(r, 400));
    const y = Math.floor(G.controller.pos.y);
    for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) {
      T.setBlock(x + dx, y - 1, z + dz, 3);
      for (let h = 0; h <= 7; h++) T.setBlock(x + dx, y + h, z + dz, 0);
    }
    for (let dz = -5; dz <= 5; dz++) for (let dx = -4; dx <= -1; dx++) T.setBlock(x + dx, y - 1, z + dz, 2);
    for (let dz = 2; dz <= 6; dz++) for (let dx = 2; dx <= 6; dx++) T.setBlock(x + dx, y - 1, z + dz, 4);
    T.setBlock(x + 5, y, z - 4, 10); T.setBlock(x + 5, y + 1, z - 4, 10); T.setBlock(x + 5, y + 2, z - 4, 10);
    T.setBlock(x + 5, y + 3, z - 4, 11); T.setBlock(x + 5, y + 4, z - 4, 11);
    T.teleport(x + 0.5, y + 2.4, z + 8.5);
    G.controller.setCreative(true); G.controller.flying = true;
    G.controller.yaw = 0; G.controller.pitch = -0.12;
    G.ui.hudVisible = true; document.querySelector('#hud').classList.remove('hidden');
    T.setTime(0.3); T.setWeather('clear', 900);
    G.controller.health = 20; G.ui.updateHUD(G);
    await T.waitChunks(1); await new Promise(r => setTimeout(r, 600));
    return { x, y, z, settings: { renderDistance: G.settings.renderDistance, brightness: G.settings.brightness, fov: G.settings.fov } };
  `);
  meta.settings = base.settings;
  meta.stage = base;

  await sleep(700);
  await shot('env-01-day');

  await evl('const G=window.__game,T=window.__test; T.setTime(0.5); T.setWeather("clear",900); G.controller.pitch=-0.12; return true;');
  await sleep(900); await shot('env-02-dusk');

  await evl('const G=window.__game,T=window.__test; T.setTime(0.75); T.setWeather("clear",900); G.controller.pitch=-0.12; return true;');
  await sleep(900); await shot('env-03-night');

  await evl('const G=window.__game,T=window.__test; T.setTime(0.3); T.setWeather("rain",900); T.tickWeather(1,20); G.controller.pitch=-0.12; return true;');
  await sleep(900); await shot('env-04-rain');

  await evl(`
    const G=window.__game,T=window.__test;
    T.setWeather('clear',900); T.setTime(0.3);
    const x=${base.x}, y=${base.y}, z=${base.z};
    /* 室内/洞穴：石砖房间 + 火把，相机在暗处看向门口 */
    for (let dz=-4; dz<=4; dz++) for (let dx=-4; dx<=4; dx++) {
      T.setBlock(x+dx, y+1, z+dz, 16);
      T.setBlock(x+dx, y+5, z+dz, 16);
      if (Math.abs(dx)===4 || Math.abs(dz)===4) for (let h=2; h<=4; h++) T.setBlock(x+dx, y+h, z+dz, 16);
    }
    for (let h=2; h<=3; h++) { T.setBlock(x, y+h, z+4, 0); T.setBlock(x+1, y+h, z+4, 0); }
    T.setBlock(x-2, y+2, z-2, 34); T.setBlock(x+2, y+2, z+2, 34);
    T.teleport(x+0.5, y+2.2, z+2.5);
    G.controller.yaw=0; G.controller.pitch=-0.02;
    G.controller.flying=true;
    return true;
  `);
  await sleep(900); await shot('env-05-cave');

  await evl(`
    const G=window.__game,T=window.__test;
    T.setTime(0.3); T.setWeather('clear',900);
    const x=${base.x}, y=${base.y}, z=${base.z};
    /* 拆掉上面检查用的石砖房间，回到同一片草地视野；生存模式脚下落到草地 */
    for (let dz=-5; dz<=5; dz++) for (let dx=-5; dx<=5; dx++) {
      for (let h=0; h<=5; h++) T.setBlock(x+dx, y+h, z+dz, 0);
      T.setBlock(x+dx, y-1, z+dz, 3);
    }
    T.setBlock(x+5, y, z-4, 10); T.setBlock(x+5, y+1, z-4, 10); T.setBlock(x+5, y+2, z-4, 10);
    T.setBlock(x+5, y+3, z-4, 11); T.setBlock(x+5, y+4, z-4, 11);
    G.controller.setCreative(false); G.controller.flying=false;
    T.teleport(x+0.5, y+1.0, z+8.5);
    G.controller.yaw=0; G.controller.pitch=-0.10;
    G.controller.health=20; G.ui.updateHUD(G);
    await new Promise(r=>setTimeout(r,500));
    return true;
  `);
  await sleep(700); await shot('env-06-survival');

  await evl('const G=window.__game; G.setMode("creative"); G.controller.setCreative(true); G.controller.flying=true; G.controller.pos.y += 1.5; G.ui.updateHUD(G); return true;');
  await sleep(700); await shot('env-07-creative');

  const cs = win.getContentSize();
  meta.window.actual = { width: cs[0], height: cs[1] };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log('[meta] artifacts/visual/env/meta.json');
  await srv.close();
  app.exit(0);
}
run().catch(async (e) => { console.error('取证失败：' + ((e && e.stack) || e)); app.exit(1); });
