/*
 * 护甲取证（只截图，不做断言）：
 *   cd app && npx electron tests/shot-armor.mjs
 * 产出 artifacts/armor-01-护甲HUD.png、armor-02-装备格与耐久.png、armor-03-钻石套HUD.png。
 *
 * 与 shot-weather.mjs 同样的理由：e2e 剧本跑满时宿主轮询被饿住，中途截图只会拍到收尾画面，
 * 所以视觉取证单独跑一次，每一步都用 await 真正让宿主回到页面里。
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
  app.setName('方块世界-护甲取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SHOT_SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 护甲取证',
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
    document.querySelector('#inp-name').value = '护甲取证';
    document.querySelector('#inp-seed').value = 'armor-shot';
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

  // 架高平台：护甲徽标要压在 HUD 左下、并且不能拍到树冠糊住准星
  const stand = await evl(`
    const G = window.__game, T = window.__test;
    T.setTime(0.32);
    const cx = Math.floor(G.controller.pos.x), cz = Math.floor(G.controller.pos.z);
    const top = Math.max(G.world.topSolidY(cx, cz), 20) + 5;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) T.setBlock(cx + dx, top - 1, cz + dz, 1);
    for (let dx = -7; dx <= 7; dx++) for (let dz = -7; dz <= 7; dz++) {
      for (let dy = 0; dy <= 10; dy++) T.setBlock(cx + dx, top + dy, cz + dz, 0);
    }
    T.teleport(cx + 0.5, top, cz + 0.5);
    G.controller.pitch = -0.05;
    G.controller.yaw = 0.6;
    return { x: cx, z: cz, y: top };
  `);
  console.log('[站位] 平台顶面 y=' + stand.y + '（出生点 ' + stand.x + ',' + stand.z + '）');
  await sleep(1600);

  const info1 = await evl(`
    const G = window.__game, T = window.__test;
    for (const id of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) {
      G.inventory.add(id, 1);
      const i = G.inventory.slots.findIndex(s => s && s.item === id);
      T.equipArmor(i);
    }
    G.inventory.armor[0].dur = 120;      // 让它显示一段绿色耐久的中间状态
    G.inventory.emit('equip');
    G.ui.updateHUD(G);
    return T.armorInfo();
  `);
  console.log('[读数] 铁套 points=' + info1.points + ' hud=' + info1.hud + ' pieces=' + JSON.stringify(info1.pieces));
  await sleep(900);
  await shot('armor-01-护甲HUD');

  const info2 = await evl(`
    const G = window.__game, T = window.__test;
    G.openInventory();
    return Object.assign(T.armorInfo(), { slots: document.querySelectorAll('#equip-grid .slot').length });
  `);
  console.log('[读数] 背包打开 points=' + info2.points + ' 装备格=' + info2.slots);
  await sleep(700);
  await shot('armor-02-装备格与耐久');

  // 钻石套：HUD 数字 20（封顶 80% 的那一档），顺便核对徽标没挡住血条
  const info3 = await evl(`
    const G = window.__game, T = window.__test;
    G.closeUI();
    G.inventory.armor = [null, null, null, null];
    for (const id of ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']) {
      G.inventory.add(id, 1);
      const i = G.inventory.slots.findIndex(s => s && s.item === id);
      T.equipArmor(i);
    }
    G.ui.updateHUD(G);
    return T.armorInfo();
  `);
  console.log('[读数] 钻石套 points=' + info3.points + ' hud=' + info3.hud);
  await sleep(900);
  await shot('armor-03-钻石套HUD');

  await srv.close();
  app.exit(0);
}

run().catch(async (e) => {
  console.error('取证失败：' + ((e && e.stack) || e));
  app.exit(1);
});
