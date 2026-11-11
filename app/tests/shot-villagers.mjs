/*
 * E2 三职业村民取证：固定种子新世界，抓村庄三名村民的外观与各自交易面板。
 *   cd app && npx electron tests/shot-villagers.mjs
 * 产出 artifacts/visual/villagers-01-lineup.png、villagers-02-farmer.png、
 *      villagers-03-librarian.png、villagers-04-blacksmith.png、villagers-samples.json
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const SAVES = path.join(APP, 'tests', '.villager-shot-saves');
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
    width: 1280, height: 720, show: true, title: '方块世界 · 村民取证',
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
    document.querySelector('#inp-name').value = '村民取证';
    document.querySelector('#inp-seed').value = 'villager-shot-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click(); return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl('const G=window.__game; return !G || G.state!=="playing" || G.world.genQueue.length>0 || G.world.dirtyMesh.size>0;');
    if (!busy) break;
    await sleep(300);
  }
  const info = await evl(`
    const G = window.__game, T = window.__test;
    T.setTime(0.3); T.setWeather('clear', 600); G.mobs.maxMobs = 0;
    await new Promise(r => setTimeout(r, 800));
    const v = T.villageInfo();
    const ox = v.origin.x, oy = v.origin.y, oz = v.origin.z;
    const list = G.mobs.list.filter(m => m.type === 'villager');
    /* 仅取证：把三名村民排到村内空地同一排，方便一张图比较外观；不改生成位置与存档。 */
    const slots = [[0.5, 2.8], [2.5, 2.8], [4.5, 2.8]];
    list.forEach((m, i) => {
      if (!slots[i]) return;
      m.pos.x = ox + slots[i][0]; m.pos.z = oz + slots[i][1];
      m.pos.y = oy + 1; m.vel.x = m.vel.y = m.vel.z = 0;
      m.mesh.position.set(m.pos.x, m.pos.y, m.pos.z);
      m.home = { x: m.pos.x, y: m.pos.y, z: m.pos.z };
      m.yaw = 0; m.mesh.rotation.y = 0;
      m.walking = false; m.wanderT = 9999;
    });
    T.teleport(ox + 2.5, oy + 1.05, oz + 5.3);
    G.controller.yaw = 0; G.controller.pitch = -0.02;
    await new Promise(r => setTimeout(r, 900));
    return { village: v, roster: list.map(m => ({ profession: m.profession, x: m.pos.x, y: m.pos.y, z: m.pos.z })) };
  `);
  await shot('villagers-01-lineup');

  const panels = [];
  for (const [i, p] of ['farmer', 'librarian', 'blacksmith'].entries()) {
    const res = await evl(`
      const G = window.__game, T = window.__test;
      const v = G.mobs.list.find(m => m.type === 'villager' && m.profession === ${JSON.stringify(p)});
      if (!v) return null;
      const ox = T.villageInfo().origin.x, oy = T.villageInfo().origin.y, oz = T.villageInfo().origin.z;
      /* 仅取证：把目标放到镜头右前方，另外两名移到镜头背后，避免面板背景里认错人。 */
      G.mobs.list.filter(m => m.type === 'villager').forEach((m, k) => {
        if (m === v) {
          m.pos.x = ox + 3.6; m.pos.z = oz + 3.4;
        } else {
          m.pos.x = ox + (k === 0 ? 0.2 : 4.8); m.pos.z = oz + 6.4;
        }
        m.pos.y = oy + 1; m.vel.x = m.vel.y = m.vel.z = 0;
        m.mesh.position.set(m.pos.x, m.pos.y, m.pos.z);
        m.home = { x: m.pos.x, y: m.pos.y, z: m.pos.z };
        m.walking = false; m.wanderT = 9999;
      });
      const dx = v.pos.x - (ox + 2.5), dz = v.pos.z - (oz + 5.6);
      v.yaw = Math.atan2(-dx, -dz); v.mesh.rotation.y = v.yaw;
      T.teleport(ox + 2.5, oy + 1.05, oz + 5.6);
      G.controller.yaw = Math.atan2(-dx, -dz); G.controller.pitch = 0.04;
      await new Promise(r => setTimeout(r, 500));
      G.openVillager(v);
      await new Promise(r => setTimeout(r, 400));
      const panel = document.querySelector('#panel-villager');
      return {
        profession: v.profession, title: panel.querySelector('.ptitle').textContent,
        buttons: panel.querySelectorAll('[data-trade]').length,
        trades: T.villageInfo().trades.map(t => t.id),
        parts: Object.keys(v.mesh.userData.parts || {})
      };
    `);
    panels.push(res);
    await shot('villagers-0' + (i + 2) + '-' + p);
    await evl('window.__game.closeUI(); await new Promise(r => setTimeout(r, 300)); return true;');
  }
  const samples = { info, panels };
  fs.writeFileSync(path.join(ART, 'villagers-samples.json'), JSON.stringify(samples, null, 2));
  console.log('[数据] artifacts/visual/villagers-samples.json');
  console.log(JSON.stringify(samples));
  win.destroy();
  await srv.close();
  app.quit();
}

run().catch(e => { console.error(e); app.exit(1); });
