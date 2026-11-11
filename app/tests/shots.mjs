/*
 * 界面截图取证：把主菜单之外的各个面板与夜景都截一张图，便于人工核对布局与美术。
 *   npx electron tests/shots.mjs
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts');
fs.mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => process.stdout.write(m + '\n');

async function main() {
  await app.whenReady();
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: path.join(APP, 'tests', '.shots-saves') });
  const win = new BrowserWindow({ width: 1280, height: 720, show: true, title: '方块世界 · 界面核对', webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2) log('  页面错误: ' + msg); });
  await win.loadURL(srv.url);
  for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript('!!window.__game').catch(() => false)) break; await sleep(100); }

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ART, name + '.png'), img.toPNG());
    log('  截图 ' + name);
  };
  const run = (js) => win.webContents.executeJavaScript(js);

  await run(`(async () => {
    const T = window.__test, G = window.__game;
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '界面核对';
    document.querySelector('#inp-seed').value = 'showcase-77';
    document.querySelector('#m-creative').click();
    document.querySelector('#btn-create').click();
    while (G.state !== 'playing') await new Promise(r => setTimeout(r, 100));
    return true;
  })()`);
  await sleep(2500);
  await shot('ui-01-创造模式白天');

  // 背包 + 2x2 合成 + 配方书
  await run(`(() => { const G = window.__game;
    G.inventory.clear();
    G.inventory.add('oak_log', 8); G.inventory.add('planks', 12); G.inventory.add('stick', 6);
    G.inventory.add('cobblestone', 24); G.inventory.add('iron_ingot', 6); G.inventory.add('coal', 8);
    G.inventory.add('diamond', 3); G.inventory.add('pickaxe_iron', 1); G.inventory.add('bread', 4);
    G.openInventory(); return true; })()`);
  await sleep(400);
  await shot('ui-02-背包与配方书');

  // 工作台 3x3：摆一个铁镐配方（不合成，只为看界面）
  await run(`(() => { const G = window.__game; G.closeUI(); G.openCrafting(3);
    const s = G.tableCraft; s.clear();
    s.set(0, { item: 'iron_ingot', count: 1 }); s.set(1, { item: 'iron_ingot', count: 1 }); s.set(2, { item: 'iron_ingot', count: 1 });
    s.set(4, { item: 'stick', count: 1 }); s.set(7, { item: 'stick', count: 1 });
    G.ui.refreshUI(); return true; })()`);
  await sleep(400);
  await shot('ui-03-工作台3x3与产物');

  // 熔炉界面（放入铁矿石与煤，推进几秒）
  await run(`(async () => { const G = window.__game, T = window.__test; G.closeUI();
    const x = Math.floor(G.controller.pos.x) + 2, y = Math.floor(G.controller.pos.y) - 1, z = Math.floor(G.controller.pos.z);
    T.setBlock(x, y, z, 26);
    const f = G.world.getFurnace(x, y, z);
    f.input = { item: 'iron_ore', count: 3 }; f.fuel = { item: 'coal', count: 2 };
    for (let i = 0; i < 60; i++) f.tick(0.05);
    G.openFurnace({ x, y, z });
    return true; })()`);
  await sleep(500);
  await shot('ui-04-熔炉界面');
  await run(`window.__game.closeUI()`);

  // 创造物品栏
  await run(`(() => { const G = window.__game; G.openInventory(); G.ui.showCreativeTab(); return true; })()`);
  await sleep(400);
  await shot('ui-05-创造物品栏');
  await run(`window.__game.closeUI()`);

  // 夜晚 + 生物 + 地下光照
  await run(`(async () => { const G = window.__game, T = window.__test;
    G.time = 0.78;                                  // 深夜
    const gy = G.world.topSolidY(Math.floor(G.controller.pos.x), Math.floor(G.controller.pos.z));
    G.mobs.spawn('zombie', G.controller.pos.x + 3.5, gy + 1, G.controller.pos.z + 1);
    G.mobs.spawn('skeleton', G.controller.pos.x - 4, gy + 1, G.controller.pos.z + 2);
    G.mobs.spawn('pig', G.controller.pos.x + 1, gy + 1, G.controller.pos.z + 5);
    T.setBlock(Math.floor(G.controller.pos.x) + 2, gy + 1, Math.floor(G.controller.pos.z) + 2, 34);  // 火把
    T.setBlock(Math.floor(G.controller.pos.x) + 2, gy + 2, Math.floor(G.controller.pos.z) + 2, 28);  // 荧石
    G.controller.yaw = -0.9; G.controller.pitch = -0.12;
    return true; })()`);
  await sleep(1200);
  await shot('ui-06-夜晚火把与生物');

  // 设置界面
  await run(`(() => { const G = window.__game; G.pause(); G.ui.showSettings('pause'); return true; })()`);
  await sleep(400);
  await shot('ui-07-设置界面');

  // 新内容：花草近景（先关掉设置全屏界面）
  await run(`(() => { const G = window.__game; G.state = 'playing'; G.ui.hideOverlays(); return true; })()`);
  await run(`(() => { const G = window.__game, T = window.__test;
    const x = Math.floor(G.controller.pos.x), z = Math.floor(G.controller.pos.z);
    const gy = G.world.topSolidY(x, z);
    T.setBlock(x + 2, gy + 1, z + 1, 41);   // 虞美人
    T.setBlock(x + 3, gy + 1, z + 1, 42);   // 蒲公英
    T.setBlock(x + 4, gy + 1, z + 1, 40);   // 高草
    T.setBlock(x + 5, gy + 1, z + 1, 45);   // 南瓜
    T.setBlock(x + 6, gy + 1, z + 1, 48);   // 南瓜灯
    T.setBlock(x + 7, gy + 1, z + 1, 44);   // 仙人掌
    T.setBlock(x + 7, gy + 2, z + 1, 44);
    T.setBlock(x + 8, gy + 1, z + 1, 46);   // 棕蘑菇
    T.setBlock(x + 9, gy + 1, z + 1, 47);   // 红蘑菇
    G.controller.spawnAt(x + 0.5, gy + 1.05, z - 1.5);
    G.controller.yaw = Math.PI; G.controller.pitch = -0.18;
    G.time = 0.2; return true; })()`);
  await sleep(1600);
  await shot('ui-09-装饰植物与新方块');

  // 箱子界面
  await run(`(async () => { const G = window.__game, T = window.__test;
    const x = Math.floor(G.controller.pos.x) + 2, z = Math.floor(G.controller.pos.z) + 1;
    const gy = G.world.topSolidY(x, z);
    T.setBlock(x, gy + 1, z, 39);
    const slots = G.world.getContainer(x, gy + 1, z);
    slots[0] = { item: 'diamond', count: 12 }; slots[1] = { item: 'bread', count: 5 };
    slots[2] = { item: 'pickaxe_iron', count: 1 }; slots[3] = { item: 'pumpkin', count: 3 };
    slots[4] = { item: 'poppy', count: 8 }; slots[9] = { item: 'cobblestone', count: 64 };
    G.openChest({ x, y: gy + 1, z }); return true; })()`);
  await sleep(700);
  await shot('ui-10-箱子容器界面');
  await run(`window.__game.closeUI()`);

  // 树苗长成的树
  await run(`(() => { const G = window.__game, T = window.__test;
    const x = Math.floor(G.controller.pos.x) - 3, z = Math.floor(G.controller.pos.z) - 2;
    const gy = G.world.topSolidY(x, z);
    T.setBlock(x, gy + 1, z, 38);
    G.growTreeAt(x, gy + 1, z, 'oak');
    G.controller.spawnAt(x + 4.5, gy + 1.05, z + 4.5);
    G.controller.yaw = -2.4; G.controller.pitch = 0.12;
    return true; })()`);
  await sleep(1500);
  await shot('ui-11-树苗长成树');

  // T1/T2：锄头开垦的干耕地与湿润耕地、成熟小麦、床、羊，以及快捷栏里的锄头/床/羊毛图标
  await run(`(() => { const G = window.__game, T = window.__test;
    const x = Math.floor(G.controller.pos.x), z = Math.floor(G.controller.pos.z) + 6;
    const gy = G.world.topSolidY(x, z);
    T.setBlock(x, gy, z - 1, 9);                       // 紧挨着耕地放水 → 开垦时算出湿润
    for (const dx of [-1, 0, 1]) { T.setBlock(x + dx, gy + 1, z, 0); T.setBlock(x + dx, gy + 2, z, 0); }
    G.inventory.set(0, { item: 'hoe_wood', count: 1, dur: 59 });
    G.inventory.set(1, { item: 'bed', count: 1 });
    G.inventory.set(2, { item: 'wool', count: 3 });
    G.selectHotbar(0);
    T.useHeldAt(x - 1, gy, z);                         // 干耕地（真实开垦）
    T.useHeldAt(x, gy, z);                             // 湿润耕地（真实开垦）
    T.setBlock(x + 1, gy, z, 36);
    G.world.setBlock(x + 1, gy + 1, z, 37, 6);         // 成熟小麦
    G.world.refreshImmediate(x + 1, gy + 1, z, G.view);
    T.placeAt(x - 3, gy + 1, z, 'bed');                // 床
    const sy = G.world.topSolidY(x + 4, z);
    G.mobs.spawn('sheep', x + 4.5, sy + 1, z);
    G.controller.spawnAt(x - 1.5, gy + 1.05, z + 4.5);
    G.controller.yaw = 0; G.controller.pitch = -0.2;
    G.closeUI();
    return true; })()`);
  await sleep(1600);
  await shot('ui-12-锄头耕地床与羊');
  await run(`(() => { const G = window.__game; G.openInventory(); return true; })()`);
  await sleep(700);
  await shot('ui-13-背包里的锄头与床');
  await run(`window.__game.closeUI()`);

  // 死亡界面
  await run(`(() => { const G = window.__game; G.ui.showMenu(); G.newWorld('死亡演示','dead-1','survival'); return true; })()`);
  await sleep(3500);
  await run(`(() => { const G = window.__game; G.controller.hurt(20, '演示'); return true; })()`);
  await sleep(600);
  await shot('ui-08-死亡界面');

  await srv.close();
  app.exit(0);
}
main().catch(e => { log('异常 ' + ((e && e.stack) || e)); app.exit(1); });
