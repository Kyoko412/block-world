/*
 * E3 废弃矿工营地取证：固定种子新世界，拍地面营地、地下房间与箱子内容。
 *   cd app && npx electron tests/shot-camp.mjs
 * 产出 artifacts/visual/camp-01-surface.png、camp-02-room.png、camp-03-chest.png、camp-samples.json
 * 地下房间本身没有光源；拍房间/箱子时临时放两把火把照明，截完立刻移除（不影响实际游玩）。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const SAVES = path.join(APP, 'tests', '.camp-shot-saves');
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
    width: 1280, height: 720, show: true, title: '方块世界 · 营地取证',
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
    document.querySelector('#inp-name').value = '营地取证';
    document.querySelector('#inp-seed').value = 'acceptance-2026';
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
    T.setTime(0.3); T.setWeather('clear', 600); G.mobs.maxMobs = 0; G.mobs.clear();
    const c = T.campInfo();
    /* 仅取证：飞到营地上方看全貌，避免站进楼梯沟里只看到土壁。 */
    G.controller.setCreative(true);
    G.controller.flying = true;
    T.teleport(c.origin.x + 7.5, c.origin.y + 4.05, c.origin.z + 7.5);
    const dx = c.origin.x - (c.origin.x + 7.5), dy = (c.origin.y + 1) - (c.origin.y + 4.05), dz = c.origin.z - (c.origin.z + 7.5);
    const L = Math.hypot(dx, dy, dz) || 1;
    G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    G.controller.pitch = Math.asin(dy / L);
    await new Promise(r => setTimeout(r, 700));
    const above = [];
    for (let y = c.origin.y + 1; y <= c.origin.y + 5; y++) for (let z = c.origin.z - 12; z <= c.origin.z + 20; z++) for (let x = c.origin.x - 12; x <= c.origin.x + 12; x++) {
      const id = G.world.getBlock(x, y, z);
      if ([4, 16, 17, 18, 19].includes(id)) above.push([x, y, z, id]);
    }
    return { camp: c, above };
  `);
  await shot('camp-01-surface');

  await evl(`
    const G = window.__game, T = window.__test;
    const c = T.campInfo();
    G.controller.setCreative(false);
    G.controller.flying = false;
    T.teleport(c.origin.x + 0.5, c.origin.y + 1.05, c.origin.z + 2.8);
    G.controller.yaw = 0; G.controller.pitch = 0.04;
    await new Promise(r => setTimeout(r, 600));
    return true;
  `);
  await shot('camp-01b-tent');

  const room = await evl(`
    const G = window.__game, T = window.__test;
    const c = T.campInfo();
    G.controller.setCreative(false);
    G.controller.flying = false;
    const torches = [
      [c.room.x0 + 1, c.room.floor + 1, c.room.z0 + 1],
      [c.room.x1 - 1, c.room.floor + 1, c.room.z1 - 1]
    ];
    torches.forEach(([x, y, z]) => T.setBlock(x, y, z, 34));
    const ch = c.chests.find(x => x.table === 'underground');
    const px = c.room.x0 + 1.5, pz = c.room.z0 + 4.5;
    T.teleport(px, c.room.floor + 1.05, pz);
    const dx = (ch.x + 0.5) - px, dy = (ch.y + 0.5) - (c.room.floor + 1.65), dz = (ch.z + 0.5) - pz;
    const L = Math.hypot(dx, dy, dz) || 1;
    G.controller.pitch = Math.asin(dy / L); G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    await new Promise(r => setTimeout(r, 900));
    return { torches, chest: ch, player: { x: px, y: c.room.floor + 1.05, z: pz } };
  `);
  await shot('camp-02-room');

  const chest = await evl(`
    const G = window.__game, T = window.__test;
    const c = T.campInfo();
    const ch = c.chests.find(x => x.table === 'underground');
    const dx = (ch.x + 0.5) - G.controller.pos.x;
    const dy = (ch.y + 0.5) - G.controller.eyeY;
    const dz = (ch.z + 0.5) - G.controller.pos.z;
    const L = Math.hypot(dx, dy, dz) || 1;
    G.controller.pitch = Math.asin(dy / L); G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    G.interaction.placeCd = 0;
    G.input.state.mouseRight = true;
    G.interaction.update(0.02);
    G.input.state.mouseRight = false;
    await new Promise(r => setTimeout(r, 500));
    return { openUI: G.openUI, slots: document.querySelectorAll('#chest-grid .slot').length,
      items: G.world.getContainer(ch.x, ch.y, ch.z).filter(Boolean).map(s => ({ item: s.item, count: s.count })) };
  `);
  await shot('camp-03-chest');
  const cleanup = await evl(`
    const G = window.__game, T = window.__test;
    G.closeUI();
    const torches = ${JSON.stringify(room.torches)};
    torches.forEach(([x, y, z]) => T.setBlock(x, y, z, 0));
    return { torchesAfter: torches.map(([x, y, z]) => G.world.getBlock(x, y, z)) };
  `);
  const samples = { info, room, chest, cleanup, note: '地下房间本身无光源；camp-02/03 的火把仅用于取证，截后已移除。' };
  fs.writeFileSync(path.join(ART, 'camp-samples.json'), JSON.stringify(samples, null, 2));
  console.log('[数据] artifacts/visual/camp-samples.json');
  console.log(JSON.stringify(samples));
  win.destroy();
  await srv.close();
  app.quit();
}

run().catch(e => { console.error(e); app.exit(1); });
