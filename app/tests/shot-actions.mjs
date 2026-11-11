/*
 * V3 动作取证：分帧记录挖掘/攻击/切栏的真实 HeldItemView 状态，并截两张动作帧。
 *   cd app && npx electron tests/shot-actions.mjs
 * 产出 artifacts/visual/action-samples.json、action-01-mining.png、action-02-attack.png
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const SAVES = path.join(APP, 'tests', '.action-saves');
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
    width: 1280, height: 720, show: true, title: '方块世界 · 动作取证',
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
    document.querySelector('#inp-name').value = '动作取证';
    document.querySelector('#inp-seed').value = 'action-shot';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click(); return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl('const G=window.__game; return !G || G.state!=="playing" || G.world.genQueue.length>0 || G.world.dirtyMesh.size>0;');
    if (!busy) break;
    await sleep(300);
  }
  const setup = await evl(`
    const G = window.__game, T = window.__test;
    T.setTime(0.3); T.setWeather('clear', 600); G.mobs.maxMobs = 0; G.mobs.clear();
    const x = Math.floor(G.spawn.x) - 24, z = Math.floor(G.spawn.z) + 24;
    T.teleport(x + 0.5, G.world.surfaceHeight(x, z) + 2, z + 0.5);
    await new Promise(r => setTimeout(r, 500));
    const y = Math.floor(G.controller.pos.y);
    for (let dz = -5; dz <= 5; dz++) for (let dx = -4; dx <= 4; dx++) {
      T.setBlock(x + dx, y - 1, z + dz, 3);
      for (let h = 0; h <= 5; h++) T.setBlock(x + dx, y + h, z + dz, 0);
    }
    T.setBlock(x, y, z - 2, 1);
    T.teleport(x + 0.5, y, z + 0.5);
    G.controller.yaw = 0; G.controller.pitch = 0;
    G.inventory.clear();
    G.inventory.set(0, { item: 'pickaxe_iron', count: 1, dur: 200 });
    G.inventory.set(1, { item: 'grass_block', count: 64 });
    G.inventory.emit('load'); G.selectHotbar(0);
    await new Promise(r => setTimeout(r, 500));
    return { x, y, z };
  `);
  const { x, y, z } = setup;
  const samples = await evl(`
    const G = window.__game, T = window.__test;
    const ex = ${x} + 0.5, ey = ${y} + 0.5, ez = ${z} - 2 + 0.5;
    const dx = ex - G.controller.pos.x, dy = ey - G.controller.eyeY, dz = ez - G.controller.pos.z;
    const L = Math.hypot(dx, dy, dz);
    G.controller.pitch = Math.asin(dy / L); G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    const out = { mining: [], attack: [], switch: [] };
    G.input.state.mouseLeft = true;
    for (let i = 0; i < 18; i++) {
      await new Promise(r => requestAnimationFrame(r));
      out.mining.push(Object.assign({ i }, T.miningInfo(), { held: T.heldInfo() }));
    }
    G.input.state.mouseLeft = false;
    await new Promise(r => requestAnimationFrame(r));
    G.selectHotbar(1);
    await new Promise(r => setTimeout(r, 450));
    out.switch.push({ phase: 'rest', held: T.heldInfo() });
    G.swing(1, 'attack');
    for (let i = 0; i < 3; i++) {
      await new Promise(r => requestAnimationFrame(r));
      out.attack.push({ i, held: T.heldInfo() });
    }
    G.selectHotbar(0);
    await new Promise(r => requestAnimationFrame(r));
    out.switch.push({ phase: 'switch-mid-swing', held: T.heldInfo() });
    await new Promise(r => setTimeout(r, 450));
    out.switch.push({ phase: 'settled', held: T.heldInfo() });
    return out;
  `);
  fs.writeFileSync(path.join(ART, 'action-samples.json'), JSON.stringify(samples, null, 2));
  console.log('[数据] artifacts/visual/action-samples.json');

  await evl(`
    const G = window.__game, T = window.__test;
    G.selectHotbar(0); G.input.state.mouseLeft = true;
    const ex = ${x} + 0.5, ey = ${y} + 0.5, ez = ${z} - 2 + 0.5;
    const dx = ex - G.controller.pos.x, dy = ey - G.controller.eyeY, dz = ez - G.controller.pos.z;
    const L = Math.hypot(dx, dy, dz);
    G.controller.pitch = Math.asin(dy / L); G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    await new Promise(r => setTimeout(r, 220));
    return true;
  `);
  await shot('action-01-mining');
  await evl('window.__game.input.state.mouseLeft = false; return true;');
  await evl('window.__game.selectHotbar(1); return true;');
  await sleep(450);
  await evl('window.__game.swing(1, "attack"); return true;');
  await sleep(70);
  await shot('action-02-attack');

  await srv.close();
  app.exit(0);
}
run().catch(async (e) => { console.error('取证失败：' + ((e && e.stack) || e)); app.exit(1); });
