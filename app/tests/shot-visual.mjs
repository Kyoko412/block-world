/*
 * 视觉/交互对照取证（V0）：
 *   cd app && npx electron tests/shot-visual.mjs baseline
 *   （改进后再跑 `after`，用同一种子/坐标/时间/天气/视距/亮度/窗口尺寸）
 * 产出 artifacts/visual/<label>/{a-grass, b-materials, c-cave, d-combat-shield,
 *   d-combat-bow, e-inventory}.png 与 meta.json。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
/* P0 A/B：允许自定义隔离目录名（如 ab-20261105-before / -after），
   不再覆盖既有 baseline/after 证据。字符白名单防止路径穿越。 */
const _argv = process.argv.slice(1);
const _custom = _argv.find(a => /^ab-[0-9A-Za-z_\-]+$/.test(a));
const LABEL = _custom || (_argv.includes('after') ? 'after' : 'baseline');
const OUT = path.join(ART, LABEL);
const SAVES = path.join(APP, 'tests', '.visual-saves');
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.setName('方块世界-视觉取证');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 视觉取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => {
    try { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.showInactive(); win.moveTop(); } catch (e) { /* ignore */ }
  }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  const meta = { label: LABEL, seed: 'visual-audit-2026', mode: 'survival', window: { width: 1280, height: 720 }, settings: {}, time: 0.3, weather: 'clear', scenes: [] };
  /* P0 A/B 像素统计：nativeImage.toBitmap() 直接给原始 BGRA，无需 PNG 解码库。
     只做同机位「改前 vs 改后」的相对比较，不设绝对阈值（避免把主观审美塞进门禁）。 */
  const stats = [];
  const stat = (img, name) => {
    const sz = img.getSize(), W = sz.width, H = sz.height;
    const bmp = img.toBitmap();
    const region = (x0, y0, x1, y1) => {
      let n = 0, lum = 0, lum2 = 0, sat = 0, warm = 0;
      const xa = Math.max(0, Math.floor(x0 * W)), xb = Math.min(W, Math.ceil(x1 * W));
      const ya = Math.max(0, Math.floor(y0 * H)), yb = Math.min(H, Math.ceil(y1 * H));
      for (let y = ya; y < yb; y += 2) for (let x = xa; x < xb; x += 2) {
        const i = (y * W + x) * 4;
        const b = bmp[i] / 255, g = bmp[i + 1] / 255, r = bmp[i + 2] / 255;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        lum += L; lum2 += L * L; sat += mx > 0 ? (mx - mn) / mx : 0; warm += r - b;
        n++;
      }
      const mean = n ? lum / n : 0;
      return {
        mean: +mean.toFixed(4),
        contrast: +Math.sqrt(Math.max(0, n ? lum2 / n - mean * mean : 0)).toFixed(4),
        saturation: +(n ? sat / n : 0).toFixed(4),
        warm: +(n ? warm / n : 0).toFixed(4)
      };
    };
    const s = {
      name, width: W, height: H,
      ground: region(0.15, 0.55, 0.85, 0.92),
      horizon: region(0.05, 0.35, 0.95, 0.50),
      sky: region(0.10, 0.05, 0.90, 0.22),
      center: region(0.35, 0.45, 0.65, 0.75)
    };
    stats.push(s);
    return s;
  };
  const shot = async (name) => {
    await evl("const w=document.querySelector('#toast-wrap'); if(w) w.innerHTML=''; const a=document.querySelector('#ach-toast'); if(a) a.classList.remove('show'); return true;");
    const img = await win.webContents.capturePage();
    const size = img.getSize();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    stat(img, name);
    console.log('[截图] ' + path.join('artifacts', 'visual', LABEL, name + '.png') + ' ' + size.width + 'x' + size.height);
    return size;
  };

  await win.loadURL(srv.url);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await evl('return !!(window.__game && window.__test);').catch(() => false);
    if (!ready) await sleep(200);
  }
  if (!ready) { console.error('前端未就绪'); await srv.close(); app.exit(1); return; }
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '视觉取证';
    document.querySelector('#inp-seed').value = 'visual-audit-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl(`
      const G = window.__game;
      return !G || G.state !== 'playing' || (G.world && (G.world.genQueue.length > 0 || G.world.dirtyMesh.size > 0));
    `);
    if (!busy) break;
    await sleep(300);
  }
  const base = await evl(`
    const G = window.__game, T = window.__test;
    G.settings.renderDistance = 6; G.settings.brightness = 1; G.settings.fov = 70;
    T.setTime(0.3); T.setWeather('clear', 600);
    G.mobs.maxMobs = 0; G.mobs.clear();
    G.ui.hudVisible = false; document.querySelector('#hud').classList.add('hidden');
    return { spawn: G.spawn, settings: { renderDistance: G.settings.renderDistance, brightness: G.settings.brightness, fov: G.settings.fov } };
  `);
  meta.settings = base.settings;
  meta.spawn = base.spawn;
  const sx = Math.floor(base.spawn.x), sz = Math.floor(base.spawn.z);

  const prep = async (x, z) => evl(`
    const G = window.__game, T = window.__test;
    G.controller.setCreative(true); G.controller.flying = true;
    T.teleport(${x} + 0.5, 40, ${z} + 0.5);
    await T.waitChunks(1); await new Promise(r => setTimeout(r, 250));
    return G.world.topSolidY(${x}, ${z}) + 1;
  `);

  /* ---------- A 晴朗草地与林缘 ---------- */
  let gy = await prep(sx - 50, sz);
  await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx - 50}, z0 = ${sz}, y0 = ${gy};
    for (let dz = -9; dz <= 13; dz++) for (let dx = -13; dx <= 13; dx++) {
      T.setBlock(x0 + dx, y0 - 1, z0 + dz, 3);
      for (let h = 0; h <= 9; h++) T.setBlock(x0 + dx, y0 + h, z0 + dz, 0);
    }
    for (let dz = -6; dz <= -2; dz++) for (let dx = -12; dx <= -8; dx++) T.setBlock(x0 + dx, y0 - 1, z0 + dz, 2);
    /* 水池：内部真正的水（id 9），四周一圈沙 */
    for (let dz = -7; dz <= 2; dz++) for (let dx = 3; dx <= 11; dx++) {
      const edge = dx === 3 || dx === 11 || dz === -7 || dz === 2;
      T.setBlock(x0 + dx, y0 - 1, z0 + dz, edge ? 6 : 9);
      T.setBlock(x0 + dx, y0, z0 + dz, 0);
    }
    for (let dx = -8; dx <= -3; dx++) for (let dz = 4; dz <= 9; dz++) {
      T.setBlock(x0 + dx, y0 - 1, z0 + dz, 4);
      T.setBlock(x0 + dx, y0, z0 + dz, dx < -6 ? 1 : 4);
      if (dz < 7) T.setBlock(x0 + dx, y0 + 1, z0 + dz, 4);
    }
    for (const [tx, tz] of [[-11, -8], [10, -8]]) {
      for (let h = 0; h < 7; h++) T.setBlock(x0 + tx, y0 + h, z0 + tz, 10);
      for (let dy = 4; dy <= 7; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dz * dz <= 6) T.setBlock(x0 + tx + dx, y0 + dy, z0 + tz + dz, 11);
      }
    }
    T.teleport(x0 + 0.5, y0 + 3.1, z0 + 11.5);
    G.controller.yaw = 0; G.controller.pitch = -0.17;
    await T.waitChunks(1); await new Promise(r => setTimeout(r, 500));
    return true;
  `);
  await sleep(700);
  let size = await shot('a-grass');
  meta.scenes.push({ name: 'a-grass', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- B 材质陈列墙 ---------- */
  gy = await prep(sx + 60, sz);
  await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 60}, z0 = ${sz}, y0 = Math.max(${gy}, G.world.seaLevel + 2);
    for (let dz = -3; dz <= 8; dz++) for (let dx = -12; dx <= 12; dx++) {
      T.setBlock(x0 + dx, y0 - 1, z0 + dz, 3);
      for (let h = 0; h <= 7; h++) T.setBlock(x0 + dx, y0 + h, z0 + dz, 0);
    }
    const mats = [14, 10, 1, 4, 6, 19, 29];     // 木板/原木/石头/圆石/沙/铁矿石/玻璃
    mats.forEach((id, i) => {
      const bx = x0 - 9 + i * 3;
      for (let dy = 0; dy <= 1; dy++) for (let dz = 0; dz <= 1; dz++) {
        T.setBlock(bx, y0 + dy, z0 - 5 + dz, id);
      }
    });
    T.teleport(x0 + 0.5, y0 + 2.2, z0 + 6.5);
    G.controller.yaw = 0; G.controller.pitch = -0.06;
    await T.waitChunks(1); await new Promise(r => setTimeout(r, 500));
    return true;
  `);
  await sleep(700);
  size = await shot('b-materials');
  meta.scenes.push({ name: 'b-materials', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- C 室内与洞穴光 ---------- */
  gy = await prep(sx + 120, sz);
  await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 120}, z0 = ${sz}, y0 = Math.max(${gy}, G.world.seaLevel + 2);
    for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) {
      for (let h = -1; h <= 5; h++) T.setBlock(x0 + dx, y0 + h, z0 + dz, 0);
      T.setBlock(x0 + dx, y0 - 1, z0 + dz, 16);
      T.setBlock(x0 + dx, y0 + 4, z0 + dz, 16);
      if (Math.abs(dx) === 6 || Math.abs(dz) === 6) {
        for (let h = 0; h <= 3; h++) T.setBlock(x0 + dx, y0 + h, z0 + dz, 16);
      }
    }
    /* 正门开口（+z 墙中间两格高） */
    for (let h = 0; h <= 2; h++) { T.setBlock(x0, y0 + h, z0 + 6, 0); T.setBlock(x0 + 1, y0 + h, z0 + 6, 0); }
    T.setBlock(x0, y0 + 2, z0 - 6, 34);
    T.setBlock(x0 - 5, y0 + 2, z0 - 2, 34);
    T.setBlock(x0 + 5, y0 + 2, z0 + 2, 34);
    T.teleport(x0 + 0.5, y0 + 1.2, z0 + 3.5);
    G.controller.yaw = 0; G.controller.pitch = -0.02;
    await T.waitChunks(1); await new Promise(r => setTimeout(r, 600));
    return true;
  `);
  await sleep(700);
  size = await shot('c-cave');
  meta.scenes.push({ name: 'c-cave', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- C2 真·封闭洞穴（只有火把这一个光源） ----------
     c-cave 那间房实测室内 sky=7~13：外围被清成 1 格通天沟、门洞 2 格宽、火把还直接塞进墙格
     （火把是 cross 透明方块，等于在墙上开了个透光洞）。那样拍出来的「洞穴」根本没有暗部，
     改前改后都看不出差别。这里补一个真正封闭的石室：外壳 17x11x17 全部填实心，
     内部凿 9x4x9，火把放在贴着墙面的空气格里，不占墙格。 */
  gy = await prep(sx + 60, sz);
  const c2light = await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 60}, z0 = ${sz}, y0 = Math.max(${gy}, G.world.seaLevel + 6);
    /* 关键：T.setBlock 对「还没生成的区块」会静默丢弃，外壳会留下透光洞
       （第一版实测室内 sky=14 就是这么来的）。先把半径 3 的区块都要来。 */
    await T.waitChunks(3);
    for (let dy = -4; dy <= 6; dy++) for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++)
      T.setBlock(x0 + dx, y0 + dy, z0 + dz, 1);
    for (let dy = 0; dy <= 3; dy++) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++)
      T.setBlock(x0 + dx, y0 + dy, z0 + dz, 0);
    /* 火把：放在室内贴墙的空气格（墙格本身保持实心，否则等于开透光洞） */
    T.setBlock(x0, y0 + 2, z0 - 4, 34);
    T.setBlock(x0 - 4, y0 + 2, z0 + 1, 34);
    T.setBlock(x0 + 4, y0 + 2, z0 + 3, 34);
    T.teleport(x0 + 0.5, y0 + 1.2, z0 + 2.5);
    G.controller.yaw = 0; G.controller.pitch = -0.04;      // yaw=0 朝 -Z，正对挂火把的那面墙
    await T.waitChunks(1); await new Promise(r => setTimeout(r, 1200));
    return {
      y0, torch: T.lightAt(x0, y0 + 2, z0 - 4), centre: T.lightAt(x0, y0 + 1, z0),
      farWall: T.lightAt(x0 - 3, y0 + 1, z0), ceiling: T.lightAt(x0, y0 + 3, z0),
      corner: T.lightAt(x0 + 3, y0 + 1, z0 + 3), floor: T.lightAt(x0, y0, z0 - 3)
    };
  `);
  await sleep(900);
  size = await shot('c2-cave-sealed');
  meta.scenes.push({ name: 'c2-cave-sealed', light: c2light, camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- D 战斗平台：盾 / 弓 ---------- */
  gy = await prep(sx + 180, sz);
  await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 180}, z0 = ${sz}, y0 = Math.max(${gy}, G.world.seaLevel + 2);
    for (let dz = -14; dz <= 9; dz++) for (let dx = -10; dx <= 10; dx++) {
      T.setBlock(x0 + dx, y0 - 1, z0 + dz, 3);
      for (let h = 0; h <= 8; h++) T.setBlock(x0 + dx, y0 + h, z0 + dz, 0);
    }
    G.controller.setCreative(false); G.controller.flying = false;
    T.teleport(x0 + 0.5, y0, z0 + 4.5);
    G.controller.health = 20; G.controller.invulnerable = 999;
    G.controller.yaw = 0; G.controller.pitch = -0.03;
    const mobs = [['pig', 3, -5], ['zombie', -3, -6], ['skeleton', 4, -10], ['creeper', -6, -12]];
    for (const [t, dx, dz] of mobs) {
      const m = G.mobs.spawn(t, x0 + 0.5 + dx, y0, z0 + 0.5 + dz);
      if (m) { m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = 0; if ('attackCd' in m) m.attackCd = 999; }
    }
    G.inventory.clear();
    G.inventory.set(0, { item: 'shield', count: 1, dur: 336 });
    G.inventory.set(1, { item: 'bow', count: 1, dur: 200 });
    G.inventory.set(2, { item: 'arrow', count: 16 });
    G.inventory.emit('load');
    G.selectHotbar(0);
    G.ui.hudVisible = true; document.querySelector('#hud').classList.remove('hidden');
    G.ui.updateHUD(G);
    G.input.state.mouseRight = true;
    await new Promise(r => setTimeout(r, 120));
    await T.waitChunks(1); await new Promise(r => setTimeout(r, 500));
    return true;
  `);
  await sleep(700);
  size = await shot('d-combat-shield');
  meta.scenes.push({ name: 'd-combat-shield', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  await evl(`
    const G = window.__game, T = window.__test;
    G.input.state.mouseRight = false;
    G.selectHotbar(1);
    G.controller.yaw = 0; G.controller.pitch = -0.05;
    G.input.state.mouseRight = true;
    await new Promise(r => setTimeout(r, 900));
    return true;
  `);
  await sleep(150);
  size = await shot('d-combat-bow');
  meta.scenes.push({ name: 'd-combat-bow', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });
  await evl('window.__game.input.state.mouseRight = false; window.__game.controller.invulnerable = 0; return true;');

  /* ---------- E 背包 / 快捷栏 ---------- */
  await evl(`
    const G = window.__game, T = window.__test;
    G.mobs.clear();
    const inv = G.inventory;
    T.resetAchievements();
    const achEl = document.querySelector('#ach-toast');
    if (achEl) achEl.style.display = 'none';
    inv.clear();
    ['grass_block','dirt','stone','cobblestone','planks','oak_log','glass','torch','crafting_table'].forEach((it, i) => inv.set(i, { item: it, count: 64 }));
    ['pickaxe_iron','axe_iron','sword_diamond','bow','shield','map','compass','bread','torch'].forEach((it, i) => inv.set(9 + i, { item: it, count: 1, dur: it === 'shield' ? 336 : (it === 'bow' ? 200 : undefined) }));
    inv.set(18, { item: 'iron_chestplate', count: 1, dur: 240 });
    inv.set(19, { item: 'diamond_leggings', count: 1, dur: 495 });
    inv.armor = [
      { item: 'iron_helmet', count: 1, dur: 165 },
      { item: 'iron_chestplate', count: 1, dur: 240 },
      { item: 'iron_leggings', count: 1, dur: 225 },
      { item: 'iron_boots', count: 1, dur: 195 }
    ];
    inv.emit('load');
    G.selectHotbar(0);
    G.ui.updateHUD(G);
    G.openInventory();
    return true;
  `);
  await sleep(500);
  size = await shot('e-inventory');
  meta.scenes.push({ name: 'e-inventory', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- F 功能方块正面（工作台/熔炉/箱子/门） ---------- */
  await evl('window.__game.closeUI(); return true;');
  gy = await prep(sx + 240, sz);
  await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 240}, z0 = ${sz}, y0 = Math.max(${gy}, G.world.seaLevel + 2);
    for (let dz = -4; dz <= 7; dz++) for (let dx = -8; dx <= 8; dx++) {
      T.setBlock(x0 + dx, y0 - 1, z0 + dz, 3);
      for (let h = 0; h <= 6; h++) T.setBlock(x0 + dx, y0 + h, z0 + dz, 0);
    }
    T.setBlock(x0 - 6, y0, z0, 25);   // 工作台
    T.setBlock(x0 - 2, y0, z0, 26);   // 熔炉
    T.setBlock(x0 + 2, y0, z0, 39);   // 箱子
    T.setBlock(x0 + 6, y0, z0, 52);   // 门下半
    T.setBlock(x0 + 6, y0 + 1, z0, 53);
    G.inventory.set(0, null); G.inventory.emit('load');
    T.teleport(x0 + 0.5, y0 + 2.4, z0 + 8.5);
    G.controller.yaw = 0; G.controller.pitch = -0.12;
    G.ui.hudVisible = false; document.querySelector('#hud').classList.add('hidden');
    await T.waitChunks(1); await new Promise(r => setTimeout(r, 500));
    return true;
  `);
  await sleep(700);
  size = await shot('f-blocks');
  meta.scenes.push({ name: 'f-blocks', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- G 远树线正对天空（P0 反馈：远景与天空脱节 / 白蓝一片） ----------
     刻意不整地、不种树：就用天然地形，只把相机周围几格清掉免得被树干挡住，
     水平望向天然林缘，horizon 区域（y 0.35~0.50）正好落在远树线上。 */
  gy = await prep(sx + 300, sz);
  await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 300}, z0 = ${sz};
    const y0 = G.world.topSolidY(x0, z0) + 1;
    for (let dy = 0; dy <= 2; dy++) for (let dz = 0; dz <= 2; dz++) for (let dx = -1; dx <= 1; dx++)
      T.setBlock(x0 + dx, y0 + dy, z0 + dz, 0);
    T.teleport(x0 + 0.5, y0 + 0.05, z0 + 0.5);
    G.controller.flying = false; G.controller.setCreative(false);
    await new Promise(r => setTimeout(r, 600));
    await T.waitChunks(1);
    G.controller.yaw = 0; G.controller.pitch = 0.0;
    G.ui.hudVisible = false; document.querySelector('#hud').classList.add('hidden');
    await new Promise(r => setTimeout(r, 700));
    return { y0, surface: G.world.surfaceHeight(x0, z0) };
  `);
  await sleep(900);
  size = await shot('g-treeline');
  meta.scenes.push({ name: 'g-treeline', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- J 生物采样世界光照（P1：夜暗 + 火把光池，人工看图用） ----------
     同一支火把、同一片草地，四只生物离火把由近到远：
     如果生物不采样世界光，这四只会一样亮（改前就是这样）。 */
  gy = await prep(sx + 120, sz + 120);
  const jlight = await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 120}, z0 = ${sz + 120}, y0 = ${gy};
    T.setTime(0.75);
    await T.waitChunks(2);
    for (let dz = -6; dz <= 6; dz++) for (let dx = -12; dx <= 12; dx++) {
      T.setBlock(x0 + dx, y0 - 1, z0 + dz, 3);
      for (let h = 0; h <= 6; h++) T.setBlock(x0 + dx, y0 + h, z0 + dz, 0);
    }
    G.mobs.maxMobs = 0; G.mobs.clear();
    T.setBlock(x0 - 11, y0, z0, 4);
    T.setBlock(x0 - 11, y0 + 1, z0, 34);                 // 唯一光源
    const row = [['pig', -10], ['sheep', -7], ['creeper', -2], ['zombie', 4]];
    const out = {};
    for (const [t, dx] of row) {
      const m = G.mobs.spawn(t, x0 + dx + 0.5, y0, z0 + 0.5);
      if (!m) continue;
      m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = 0;
      if ('attackCd' in m) m.attackCd = 999;
      out[t] = { dx, dist: Math.abs(dx + 11) };
    }
    const cam = { x: x0 + 7.5, y: y0 + 1.7, z: z0 + 8.5 };
    const tgt = { x: x0 - 3.5, y: y0 + 0.8, z: z0 };
    T.teleport(cam.x, cam.y, cam.z);
    G.controller.yaw = Math.atan2(-(tgt.x - cam.x), -(tgt.z - cam.z));
    G.controller.pitch = -0.05;
    await T.waitChunks(1);
    /* waitChunks 只管 genQueue 与 dirtyMesh，建造之后排队的 dirtyLight 不在里面；
       而 world.getLight 对「还没点亮的区块」会返回「y 高于纯函数地表就当 15」的近似 ——
       上一版因此把四只生物的眼睛格全读成 (sky 15, block 0)，看起来像火把完全没发光。 */
    for (let i = 0; i < 200; i++) {
      const p = G.world.pending();
      if (!p.light && !p.gen && !p.mesh) break;
      await new Promise(r => setTimeout(r, 60));
    }
    await new Promise(r => setTimeout(r, 1200));
    for (const m of G.mobs.list) {
      const body = (() => { let b = null; m.mesh.traverse(o => { if (o.isMesh && !b) b = o; }); return b; })();
      const l = T.lightAt(Math.floor(m.pos.x), Math.floor(m.eyeY), Math.floor(m.pos.z));
      /* 阶段 3b：骷髅/苦力怕的躯干是六面材质数组（正面眼窝、侧面脊柱），取第一面代表整体压暗结果 */
      const mat0 = body ? (Array.isArray(body.material) ? body.material[0] : body.material) : null;
      out[m.type] = Object.assign(out[m.type] || {}, {
        sky: l.sky, block: l.block, shade: +(m._shade || 0).toFixed(4),
        color: mat0 ? '0x' + mat0.color.getHexString() : null,
        faces: body && Array.isArray(body.material) ? body.material.length : 1,
        base: body && body.userData.base ? '0x' + body.userData.base.toString(16) : null
      });
    }
    return { y0, time: +G.time.toFixed(3), mobs: out };
  `);
  await sleep(900);
  size = await shot('j-mob-light');
  meta.scenes.push({ name: 'j-mob-light', light: jlight, camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- H 夜间地表带火把（P0 要求的第四张同条件图） ---------- */
  gy = await prep(sx + 240, sz);
  const hlight = await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 240}, z0 = ${sz}, y0 = ${gy};
    T.setTime(0.75);                                   // TIME_NIGHT
    for (let dz = -10; dz <= 10; dz++) for (let dx = -14; dx <= 16; dx++) {
      T.setBlock(x0 + dx, y0 - 1, z0 + dz, 3);
      for (let h = 0; h <= 8; h++) T.setBlock(x0 + dx, y0 + h, z0 + dz, 0);
    }
    /* 火把间隔 9 格：中间应当回到月光基线，而不是两支火把连成一片 */
    for (const tx of [-12, -3, 6, 15]) {
      T.setBlock(x0 + tx, y0, z0, 4);                  // 圆石垫高一格（id 5 是基岩，别用）
      T.setBlock(x0 + tx, y0 + 1, z0, 34);             // 火把放在空气格里
    }
    T.teleport(x0 - 12.5, y0 + 1.6, z0 + 5.5);
    G.controller.yaw = -Math.PI / 2;                   // yaw=0 朝 -Z，-90° 朝 +X
    G.controller.pitch = -0.03;
    await T.waitChunks(1); await new Promise(r => setTimeout(r, 1600));
    return {
      time: +G.time.toFixed(3), y0,
      beside: T.lightAt(x0 - 2, y0 + 1, z0),
      mid: T.lightAt(x0 - 7, y0 + 1, z0),
      far: T.lightAt(x0 + 11, y0 + 1, z0),
      moon: T.lightAt(x0, y0 + 1, z0 + 9)
    };
  `);
  await sleep(900);
  size = await shot('h-night-torch');
  meta.scenes.push({ name: 'h-night-torch', light: hlight, camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- K 深地三层岩剖面（阶段 1 要求：截图要有地表 + 两个岩层 + 基岩读数） ---------- */
  gy = await prep(sx + 300, sz);
  const kstrata = await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 300}, z0 = ${sz};
    const B = T.blockIds;
    /* 剖面：把 x=x0 这一格厚度的岩体从地表一直切到基岩带以下。
       机位就站在这一格空气里**沿切口往远处看** —— 切口两侧（x0±1）就是露出来的岩面，
       地层阶梯沿着走廊退开，一帧里同时有草皮/泥土、石头、深板岩、基岩。
       （先前先在侧面凿 60 格长的平巷再远拍：平巷那一头的区块写入没生效，机位被顶到地表，
         拍出来是夜景地表而不是剖面 —— 站在切口里就不依赖任何额外开挖。） */
    for (let y = ${gy} + 3; y >= -62; y--)
      for (let dz = -12; dz <= 12; dz++) T.setBlock(x0, y, z0 + dz, 0);
    for (const ty of [${gy} - 4, 10, -14, -30, -46]) {
      T.setBlock(x0, ty, z0 - 6, 34);
      T.setBlock(x0, ty, z0 + 6, 34);
    }
    /* 切口是一格厚的空槽，站进去之前先给自己垫一格地板，不然机位就是无底槽 */
    T.setBlock(x0, -20, z0 - 11, 1);
    T.setBlock(x0, -47, z0 + 11, 70);
    /* 机位一：靠北端，朝南看，稍微抬头 */
    T.teleport(x0 + 0.5, -19.0, z0 - 11.0);
    G.controller.yaw = Math.PI;                       // yaw=0 朝 -Z，180° 朝 +Z
    G.controller.pitch = 0.22;
    await T.waitChunks(1, { light: true });
    await new Promise(r => setTimeout(r, 1800));
    /* 读数取切口东侧那一列**没被切开的**岩体 */
    const wx = x0 + 1, wz = z0;
    let stoneTop = null, stoneBot = null, dsTop = null, dsBot = null, bedTop = null;
    const samples = [];
    for (let y = ${gy}; y >= -63; y--) {
      const id = T.blockAt(wx, y, wz).id;
      if (id === B.STONE) { if (stoneTop === null) stoneTop = y; stoneBot = y; }
      else if (id === B.DEEPSLATE) { if (dsTop === null) dsTop = y; dsBot = y; }
      else if (id === B.BEDROCK && bedTop === null) bedTop = y;
      if (y === ${gy} - 2 || y === 8 || y === -12 || y === -40 || y === -60) samples.push(y + ':' + id);
    }
    return {
      surfaceY: ${gy}, column: [wx, wz], stoneTop, stoneBot, dsTop, dsBot, firstBedrock: bedTop,
      columnDepth: bedTop === null ? null : ${gy} - bedTop, samples,
      cutLightUpper: T.lightAt(x0, -19, z0 - 4), cutLightDeep: T.lightAt(x0, -46, z0 + 2)
    };
  `);
  await sleep(900);
  const kCam = () => evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };');
  size = await shot('k-deep-strata-upper');
  meta.scenes.push({ name: 'k-deep-strata-upper', strata: kstrata, note: '机位一：站在切口里朝南看 —— 草皮/泥土 → 石头 → 深板岩边界', camera: await kCam(), image: size });

  /* 机位二：同一切口南端往北看、压低到深部，拍深板岩层到底部基岩带 */
  await evl(`
    const G = window.__game, T = window.__test;
    const x0 = ${sx + 300}, z0 = ${sz};
    T.teleport(x0 + 0.5, -46.0, z0 + 11.0);
    G.controller.yaw = 0;                             // 朝 -Z（回到切口北端方向）
    G.controller.pitch = 0.10;
    await T.waitChunks(1, { light: true });
    await new Promise(r => setTimeout(r, 1500));
    return true;
  `);
  await sleep(900);
  size = await shot('k-deep-strata-lower');
  meta.scenes.push({ name: 'k-deep-strata-lower', strata: kstrata, note: '机位二：深板岩层 → 底部基岩带', camera: await kCam(), image: size });

  /* ---------- L 可步行的深洞（阶段 1 要求：深部要有能走进去探索的空腔） ---------- */
  const lcave = await evl(`
    const G = window.__game, T = window.__test;
    const B = T.blockIds;
    const x0 = ${sx + 300}, z0 = ${sz};
    const air = (x, y, z) => T.blockAt(x, y, z).id === 0;
    const floor = (x, y, z) => {
      const id = T.blockAt(x, y, z).id;
      if (id === 0 || id === B.WATER || id === B.BEDROCK) return false;
      return air(x, y + 1, z) && air(x, y + 2, z);
    };
    let best = 0, spot = null;
    for (let y = -54; y <= -12; y += 1) {
      for (let z = z0 - 20; z <= z0 + 20; z += 2) {
        for (let x = x0 - 20; x <= x0 + 20; x += 2) {
          if (!floor(x, y, z)) continue;
          let run = 1, cy = y;
          for (let k = 1; k <= 24; k++) {
            const nx = x + k;
            let nf = null;
            for (let d = 1; d >= -1; d--) if (floor(nx, cy + d, z)) { nf = cy + d; break; }
            if (nf === null) break;
            cy = nf; run++;
          }
          if (run > best) { best = run; spot = { x, y, z }; }
        }
      }
    }
    if (!spot) return { found: false, best: 0 };
    /* 站到洞里、洞底插两支火把，画面里要能看出「这是一条能走的地面」而不是竖井壁 */
    T.setBlock(spot.x + 2, spot.y + 1, spot.z, 34);
    T.setBlock(spot.x + 9, spot.y + 1, spot.z - 1, 34);
    T.teleport(spot.x + 0.5, spot.y + 1.7, spot.z + 0.5);
    G.controller.yaw = -Math.PI / 2;
    G.controller.pitch = -0.06;
    await T.waitChunks(1, { light: true });
    await new Promise(r => setTimeout(r, 1800));
    return {
      found: true, spot, run: best,
      floorBlock: T.blockAt(spot.x, spot.y, spot.z).id,
      headLight: T.lightAt(spot.x, spot.y + 1, spot.z),
      ceilY: (() => { for (let y = spot.y + 1; y <= spot.y + 12; y++) if (!air(spot.x, y, spot.z)) return y; return null; })()
    };
  `);
  await sleep(900);
  size = await shot('l-deep-cave');
  meta.scenes.push({ name: 'l-deep-cave', cave: lcave, camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'), image: size });

  /* ---------- N 阶段 3b：骷髅与苦力怕的贴图 / 轮廓 / 转轴 / 引信阶段 ----------
     任务书要求「白天、暗处、火把边都能看出区别」+「从斜侧看得出四足」「接近时能听到嘶声并看出引信阶段」
     +「用真实 AI 遭遇录动作，摆拍用于对照模型」。
     所以 N.1~N.5 是摆拍（只用来对照模型本身），N.6 是真实 AI 遭遇（拉弓动作来自真实主循环）。 */
  const nSetup = await evl(`
    const G = window.__game, T = window.__test;
    const bx = ${sx} + 240, bz = ${sz} + 4;
    const by = G.world.topSolidY(bx, bz);
    for (let dz = -8; dz <= 12; dz++) for (let dx = -8; dx <= 16; dx++) {
      T.setBlock(bx + dx, by, bz + dz, 1);
      for (let h = 1; h <= 12; h++) T.setBlock(bx + dx, by + h, bz + dz, 0);
    }
    G.mobs.maxMobs = 0; G.mobs.clear();
    T.setTime(0.3); T.setWeather('clear', 600);
    await T.waitChunks(1, { light: true });
    return { bx, by, bz, seaLevel: G.world.seaLevel };
  `);
  const nbx = nSetup.bx, nby = nSetup.by, nbz = nSetup.bz;

  /* 摆拍：造一只生物、冻住它的漫游、按给定朝向站好，并回报它的光照与贴图读数 */
  const nPose = (type, x, y, z, faceYaw) => evl(`
    const G = window.__game, T = window.__test;
    const m = G.mobs.spawn('${type}', ${x}, ${y}, ${z});
    if (!m) return null;
    m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = m.vel.y = 0;
    m.yaw = ${faceYaw};
    await new Promise(r => setTimeout(r, 250));
    const parts = m.mesh.userData.parts || {};
    const texOf = (o) => (o && o.userData && o.userData.tex) || null;
    return {
      type: m.type, id: G.mobs.list.indexOf(m),
      pos: [+m.pos.x.toFixed(2), +m.pos.y.toFixed(2), +m.pos.z.toFixed(2)],
      light: T.lightAt(Math.floor(m.pos.x), Math.floor(m.eyeY), Math.floor(m.pos.z)),
      shade: m._shade === undefined ? null : +m._shade.toFixed(3),
      tex: { body: texOf(parts.body), head: texOf(parts.head), leg0: texOf(parts.leg0), bow: texOf(parts.bow) },
      faces: { body: Array.isArray(parts.body.material) ? parts.body.material.length : 1 },
      hp: m.hp
    };
  `);
  const nClear = () => evl('const G=window.__game; G.mobs.list.forEach(m => m.remove(G.scene)); G.mobs.clear(); return G.mobs.list.length;');
  /* 敌怪的朝向每帧都被真实 AI 改写成「面朝玩家」，所以摆拍要一帧一帧把角度钉回去，
     并且要贴着快门结束钉 —— 不然拍到的永远是正面（斜侧那张就白拍了）。 */
  const nHold = (id, yaw, ms) => evl(`
    const G = window.__game;
    const m = G.mobs.list[${id}];
    if (!m) return false;
    const t0 = performance.now();
    while (performance.now() - t0 < ${ms}) {
      m.yaw = ${yaw}; m.walking = false; m.wanderT = 9999;
      m.vel.x = 0; m.vel.z = 0;
      await new Promise(r => requestAnimationFrame(r));
    }
    return true;
  `);
  const nLook = (cx, cy, cz, tx, ty, tz) => evl(`
    const G = window.__game, T = window.__test;
    T.teleport(${cx}, ${cy}, ${cz});
    const dx = ${tx} - ${cx}, dy = ${ty} - (${cy} + 1.62), dz = ${tz} - ${cz};
    const L = Math.hypot(dx, dy, dz) || 1;
    G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    G.controller.pitch = Math.asin(Math.max(-1, Math.min(1, dy / L)));
    await T.waitChunks(1, { light: true });
    await new Promise(r => setTimeout(r, 900));
    return true;
  `);
  const nCam = () => evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };');
  const nRead = (type) => evl(`
    const T = window.__test;
    const i = T.mobCombatInfo().find(x => x.type === '${type}');
    return i || null;
  `);

  /* N.1 白天：骷髅正对镜头 —— 眼窝、肋骨、弓形（模型正面 = +Z，朝向 = (sin yaw, cos yaw)） */
  const nSk1 = await nPose('skeleton', nbx + 2.4, nby + 1, nbz, -Math.PI / 2);
  await nLook(nbx - 0.6, nby + 1.0, nbz, nbx + 2.4, nby + 1.5, nbz);
  await nHold(nSk1.id, -Math.PI / 2, 500);
  size = await shot('n-skeleton-day');
  meta.scenes.push({ name: 'n-skeleton-day', mob: nSk1, note: '摆拍：白天正对镜头的骷髅（眼窝/肋骨/弓）', camera: await nCam(), image: size });
  await nClear();

  /* N.2/N.3 暗处 vs 火把边：直接用 L 小节那条「已经验证能站人」的深洞。
     自己新挖一间地下石室再 T.teleport 进去是行不通的：区块还没生成时 isSolidAt 走地形近似，
     会把 y=-29 判成实心，spawnAt 一路把镜头顶回地面（实测相机 y=42、骷髅还在 -29）。
     同一地点、同一条件，只差一支火把 —— 这才是可比的两张。 */
  const nDark = lcave.found ? lcave.spot : null;
  let nSk2 = null, nTorch = null;
  if (nDark) {
    await evl(`
      const T = window.__test;
      const s = ${JSON.stringify(nDark)};
      T.setBlock(s.x + 2, s.y + 1, s.z, 0);          // 清掉 L 小节插的两支火把
      T.setBlock(s.x + 9, s.y + 1, s.z - 1, 0);
      await T.waitChunks(1, { light: true });
      await new Promise(r => setTimeout(r, 1200));
      return true;
    `);
    nSk2 = await nPose('skeleton', nDark.x + 5, nDark.y + 1, nDark.z, -Math.PI / 2);
    await nLook(nDark.x + 1, nDark.y + 1.0, nDark.z, nDark.x + 5, nDark.y + 1.5, nDark.z);
    await nHold(nSk2.id, -Math.PI / 2, 500);
    size = await shot('n-skeleton-dark');
    meta.scenes.push({ name: 'n-skeleton-dark', mob: nSk2, cave: nDark, note: '摆拍：深洞里没有光源（暗处轮廓，与 n-skeleton-torch 同一地点）', camera: await nCam(), image: size });

    /* N.3 火把边：同一间洞、同一只骷髅，只在镜头旁点一支火把 */
    nTorch = await evl(`
      const G = window.__game, T = window.__test;
      const s = ${JSON.stringify(nDark)};
      T.setBlock(s.x + 1, s.y + 1, s.z - 1, 34);
      await T.waitChunks(1, { light: true });
      await new Promise(r => setTimeout(r, 1400));
      const m = G.mobs.list.find(x => x.type === 'skeleton');
      return m ? { light: T.lightAt(Math.floor(m.pos.x), Math.floor(m.eyeY), Math.floor(m.pos.z)), shade: +(m._shade || 0).toFixed(3) } : null;
    `);
    await nHold(nSk2.id, -Math.PI / 2, 300);
    size = await shot('n-skeleton-torch');
    meta.scenes.push({ name: 'n-skeleton-torch', mob: nSk2, torch: nTorch, cave: nDark, note: '摆拍：同一地点只多点一支火把（与 n-skeleton-dark 同条件 A/B）', camera: await nCam(), image: size });
    await nClear();
  } else {
    meta.scenes.push({ name: 'n-skeleton-dark', note: 'L 小节没找到可步行的深洞，暗处/火把对照跳过' });
  }

  /* N.4 斜侧：苦力怕从斜前方看 —— 四条腿要数得出来（朝向钉在 -135°，镜头才拿得到侧面） */
  const nCr1 = await nPose('creeper', nbx + 2.6, nby + 1, nbz + 2.6, -Math.PI * 0.75);
  await nLook(nbx - 0.8, nby + 1.0, nbz - 0.8, nbx + 2.6, nby + 1.2, nbz + 2.6);
  await nHold(nCr1.id, -Math.PI * 0.75, 500);
  size = await shot('n-creeper-oblique');
  meta.scenes.push({ name: 'n-creeper-oblique', mob: nCr1, note: '摆拍：斜侧 45° 的苦力怕（四腿前后分开 + 绿皮花斑）', camera: await nCam(), image: size });
  await nClear();

  /* N.5 引信阶段：真实 AI —— 苦力怕贴近玩家开始嘶嘶充能，在还剩半截引信时按快门 */
  const nCr2 = await nPose('creeper', nbx + 2.4, nby + 1, nbz, -Math.PI / 2);
  await nLook(nbx, nby + 1.0, nbz, nbx + 2.4, nby + 1.2, nbz);
  const nFuse = await evl(`
    const G = window.__game, T = window.__test;
    const t0 = performance.now();
    while (performance.now() - t0 < 4000) {
      const i = T.mobCombatInfo().find(x => x.type === 'creeper');
      if (i && i.charging && i.fuse <= 0.7) return i;
      await new Promise(r => setTimeout(r, 16));
    }
    return T.mobCombatInfo().find(x => x.type === 'creeper') || null;
  `);
  const nFuseCam = await nCam();
  size = await shot('n-creeper-fuse');
  await nClear();                      // 立刻收掉：引信只剩 0.7 秒，别让它在快门之后炸开
  meta.scenes.push({ name: 'n-creeper-fuse', mob: nCr2, fuse: nFuse, note: '真实 AI：苦力怕充能到引信后段（胀大 + 闪白交替的一帧）', camera: nFuseCam, image: size });

  /* N.6 先拉后放：真实 AI 遭遇的一帧。
     说明：骷髅面朝玩家拉弓时，弓臂与弦都落在视线方向上，正面只能看到一条侧刃 —— 这是几何决定的，
     原版正面看也是这条线。所以这一张的「先拉」证据在 meta 的读数里（bowDraw / nockZ / 搭箭可见 / 箭数），
     而不是靠剪影；弓形本身的轮廓对照看 n-skeleton-day。 */
  const nSk3 = await nPose('skeleton', nbx + 3.4, nby + 1, nbz, -Math.PI / 2);
  await nLook(nbx - 1.4, nby + 1.0, nbz, nbx + 3.4, nby + 1.4, nbz);
  const nDraw = await evl(`
    const G = window.__game, T = window.__test;
    const t0 = performance.now();
    let last = null;
    while (performance.now() - t0 < 5000) {
      const i = T.mobCombatInfo().find(x => x.type === 'skeleton');
      if (i) { last = i; if (i.bowDraw >= 0.6 && i.arrows === 0) return i; }
      await new Promise(r => setTimeout(r, 16));
    }
    return last;
  `);
  size = await shot('n-skeleton-draw');
  meta.scenes.push({ name: 'n-skeleton-draw', mob: nSk3, draw: nDraw, note: '真实 AI：拉弓到 bowDraw≥0.6 且箭数仍为 0 的一帧（弦已退到 nockZ、箭搭在弦上、尚未离弦）', camera: await nCam(), image: size });
  await nClear();

  /* ---------- M 阶段 3a：自然生成的成群鱼（水下机位 + 水面俯视机位） ----------
     全程不手动 spawn：只按确定性站点把玩家送到那一格的另一个角，等站点扫描自己刷出一群。
     站位要留出 ≥6 格：刷怪有「离玩家太近不刷」的保护，站在站点正上方一条鱼都不会生。 */
  const fish = await evl(`
    const G = window.__game, T = window.__test;
    const lim = T.fishLimits(), step = lim.siteStep;
    const bx = Math.floor(G.spawn.x / step), bz = Math.floor(G.spawn.z / step);
    let hit = null, scan = 0, pass = null;
    /* 两遍扫描：先要「近岸浅水」（水面下 1~3 格就有鱼，玩家浮潜看得见、也拍得清），
       8 圈内没有浅水站点才退回任意深度。站点是纯函数，两遍都是同一颗子的同一批格子。 */
    for (const maxDepth of [6, Infinity]) {
      for (let ring = 1; ring <= 8 && !hit; ring++) {
        for (let dz = -ring; dz <= ring && !hit; dz++) {
          for (let dx = -ring; dx <= ring && !hit; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
            const s = T.fishSiteAt(bx + dx, bz + dz); if (!s) continue;
            if (maxDepth === 6) scan++;
            const w = G.mobs.fishWaterAt(s.x, s.z);
            if (w && w.depth <= maxDepth) { hit = { s, w }; pass = maxDepth === 6 ? 'nearshore' : 'deep'; }
          }
        }
      }
      if (hit) break;
    }
    if (!hit) return { found: false, scan };
    const ox = hit.s.x - hit.s.sx * step, oz = hit.s.z - hit.s.sz * step;
    const px = hit.s.sx * step + (ox < 8 ? step - 0.6 : 0.6);
    const pz = hit.s.sz * step + (oz < 8 ? step - 0.6 : 0.6);
    G.mobs.clear();
    G.controller.setCreative(true); G.controller.flying = true;
    T.teleport(px, G.world.seaLevel + 1.6, pz);
    G.mobs.maxMobs = 26;                       // 这一节测的就是「自然生成」，要有自然刷怪的额度
    /* 前面 j/h 两个机位把时间设成了夜里 0.75 且没有还原；鱼群这两张要的是「白天浮潜看得见鱼」的观感。 */
    T.setTime(0.3); T.setWeather('clear', 600);
    await T.waitChunks(1, { light: true });
    const t0 = performance.now();
    while (G.mobs.list.filter(m => m.def.aquatic && m.school === hit.s.key).length < lim.schoolMin &&
      performance.now() - t0 < 25000) await new Promise(r => setTimeout(r, 150));
    const school = G.mobs.list.filter(m => m.def.aquatic && m.school === hit.s.key).map(m => ({
      x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2),
      tail: +(m.mesh.userData.parts.tail.rotation.y).toFixed(3),
      shade: m._shade === undefined ? null : +m._shade.toFixed(3)
    }));
    const n = school.length || 1;
    const c = {
      x: +school.reduce((a, f) => a + f.x, 0).toFixed(2) / n,
      y: +school.reduce((a, f) => a + f.y, 0).toFixed(2) / n,
      z: +school.reduce((a, f) => a + f.z, 0).toFixed(2) / n
    };
    const fishCol = Math.round(c.x), fishRow = Math.round(c.z);
    return {
      found: true, scan, pass, key: hit.s.key, site: hit.s, water: hit.w,
      stand: { x: +px.toFixed(2), z: +pz.toFixed(2), d: +Math.hypot(px - hit.s.x, pz - hit.s.z).toFixed(1) },
      waitMs: Math.round(performance.now() - t0), school, center: c, seaLevel: G.world.seaLevel,
      time: +G.time.toFixed(3),
      lightFish: T.lightAt(fishCol, Math.round(c.y), fishRow),
      lightSurface: T.lightAt(fishCol, G.world.seaLevel + 2, fishRow)
    };
  `);
  if (!fish.found || fish.school.length < 4) {
    meta.scenes.push({ name: 'm-fish-underwater', fish, note: '未找到可住鱼的站点或自然刷群不足 4 条' });
  } else {
    /* 两个机位都在按快门前重新算一次鱼群中心：鱼是会游的，用几秒前的坐标摆机会拍到没鱼的方向。
       视线公式：lookDir = (-sin yaw, sin pitch, -cos yaw)，所以 yaw = atan2(-dx, -dz)。 */
    const aim = (d, eyeExpr) => evl(`
      const G = window.__game, T = window.__test;
      const KEY = ${JSON.stringify(fish.key)};
      const f = G.mobs.list.filter(m => m.def.aquatic && m.school === KEY);
      if (!f.length) return { fish: 0 };
      const c = { x: 0, y: 0, z: 0 };
      for (const m of f) { c.x += m.pos.x / f.length; c.y += m.pos.y / f.length; c.z += m.pos.z / f.length; }
      const D = ${d.toFixed(2)};
      const camX = c.x - D, camZ = c.z, eyeY = ${eyeExpr};
      T.teleport(camX, eyeY - 1.62, camZ);
      const dx = c.x - camX, dz = c.z - camZ;
      G.controller.yaw = Math.atan2(-dx, -dz);
      G.controller.pitch = -Math.atan2(eyeY - c.y, Math.hypot(dx, dz));
      await T.waitChunks(1, { light: true });
      await new Promise(r => setTimeout(r, 400));
      return {
        fish: f.length, center: { x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2) },
        cam: { x: +camX.toFixed(2), eyeY: +eyeY.toFixed(2), z: +camZ.toFixed(2) },
        yaw: +G.controller.yaw.toFixed(4), pitch: +G.controller.pitch.toFixed(4),
        lightFish: T.lightAt(Math.round(c.x), Math.round(c.y), Math.round(c.z)),
        tails: f.map(m => +(m.mesh.userData.parts.tail.rotation.y).toFixed(3))
      };
    `);
    const aimUnder = await aim(4.2, 'c.y + 0.15');
    size = await shot('m-fish-underwater');
    meta.scenes.push({
      name: 'm-fish-underwater', fish, aim: aimUnder,
      note: '机位：水下平视 ' + aimUnder.fish + ' 条自然生成的鳕鱼（无手动 spawn；站点' + (fish.pass === 'nearshore' ? '选的是近岸浅水' : '水深 ' + fish.water.depth) + '）',
      camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'),
      image: size
    });

    /* 机位二：水面之上往下看 —— 玩家浮潜时看到的就是这个视角 */
    const aimSurf = await aim(5.5, 'G.world.seaLevel + 1.2');
    size = await shot('m-fish-surface');
    meta.scenes.push({
      name: 'm-fish-surface', fish, aim: aimSurf,
      note: '机位：水面俯视同一群鱼（鱼群中心在水面下 ' + (fish.seaLevel - fish.center.y).toFixed(1) + ' 格）',
      camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'),
      image: size
    });
  }

  /* ---------- O 阶段 3c：自然飞鸟（林冠停栖 + 被惊飞的两张）与暗洞敌怪点亮前后的判据对照 ----------
     鸟这两张要能一眼看出「有翅膀轮廓」：停栖那张翅膀收在身上，飞的那张翼尖抬起来、两侧反相。
     全程不手动 spawn 鸟 —— 与验收同一口径，只按确定性站点把玩家送到那一列，等站点扫描自己刷群。
     洞穴那一对不是新的观感摆拍，而是把 LG 的 A/B 搬到真实画面上：同一个已经验证能站人的深洞
     （L 小节那条），先读「不点灯时这一格通不通过敌怪判据」，再在镜头旁点一支火把读第二次。
     注意 N 小节留下的教训：**不要**为了拍照新挖一间地下石室再 teleport 进去 ——
     区块没生成时 isSolidAt 走地形近似，spawnAt 会把镜头一路顶回地面。 */
  const bird = await evl(`
    const G = window.__game, T = window.__test;
    const lim = T.birdLimits(), step = lim.siteStep;
    const bx = Math.floor(G.spawn.x / step), bz = Math.floor(G.spawn.z / step);
    let hit = null;
    for (let ring = 0; ring <= 6 && !hit; ring++) {
      for (let dz = -ring; dz <= ring && !hit; dz++) {
        for (let dx = -ring; dx <= ring && !hit; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const s = T.birdSiteAt(bx + dx, bz + dz); if (!s) continue;
          const perch = T.birdPerchAt(s.x, s.z); if (!perch) continue;
          hit = { s, perch, ring };
        }
      }
    }
    if (!hit) return { found: false };
    G.mobs.clear();
    G.controller.setCreative(true); G.controller.flying = true;
    T.teleport(hit.s.x, G.world.surfaceHeight(Math.floor(hit.s.x), Math.floor(hit.s.z)) + 1, hit.s.z);
    G.mobs.maxMobs = 26;                       // 这一节测的就是「正常探索能遇见」，额度必须开着
    T.setTime(0.3); T.setWeather('clear', 600);
    await T.waitChunks(2, { light: true });
    const t0 = performance.now();
    while (T.birdInfo().length < lim.flockMin && performance.now() - t0 < 20000) await new Promise(r => setTimeout(r, 150));
    const waitMs = Math.round(performance.now() - t0);
    /* 等一只真的停着（翅膀收拢那一张），最多 12 秒：停栖 3~8 秒、短飞 1.6~4.2 秒，一定撞得到 */
    const t1 = performance.now();
    let sit = null;
    while (performance.now() - t1 < 12000) {
      sit = T.birdInfo().find(b => b.phase === 'perched');
      if (sit) break;
      await new Promise(r => setTimeout(r, 120));
    }
    return {
      found: true, key: hit.s.key, site: hit.s, perch: hit.perch, ring: hit.ring, waitMs,
      birds: T.birdInfo(), sit: sit || null, limits: lim,
      canopy: G.world.surfaceHeight(Math.floor(hit.perch.x), Math.floor(hit.perch.z))
    };
  `);
  if (!bird.found || !bird.birds.length) {
    meta.scenes.push({ name: 'o-parrot-perch', bird, note: '没找到「有站点 + 林冠停得住」的列，鸟机位跳过' });
  } else {
    /* 机位：站在离栖点 4.6 格、比树冠低 1 格的位置仰看 —— 真人抬头看树上的鸟就是这个视角 */
    const perch = bird.perch;
    const aimBird = (dist, eyeUp, target) => evl(`
      const G = window.__game, T = window.__test;
      const t = ${JSON.stringify(target)};
      const camX = t.x - ${dist.toFixed(2)}, camZ = t.z, camY = t.y + ${eyeUp.toFixed(2)};
      T.teleport(camX, camY, camZ);
      G.controller.flying = true;
      const dx = t.x - camX, dy = t.y - (camY + 1.62), dz = t.z - camZ;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.yaw = Math.atan2(-dx / L, -dz / L);
      G.controller.pitch = Math.asin(Math.max(-1, Math.min(1, dy / L)));
      await T.waitChunks(1, { light: true });
      await new Promise(r => setTimeout(r, 500));
      const i = T.birdInfo().find(b => b.uid === ${JSON.stringify(target.uid || -1)}) || T.birdInfo()[0] || null;
      return {
        birds: T.birdInfo().length,
        target: i ? { uid: i.uid, phase: i.phase, pos: [i.x, i.y, i.z], wingL: i.wingL, wingR: i.wingR, tail: i.tail, yaw: i.yaw } : null,
        yaw: +G.controller.yaw.toFixed(4), pitch: +G.controller.pitch.toFixed(4)
      };
    `);
    const sitAim = await aimBird(4.6, -0.6, bird.sit || { x: perch.x, y: perch.y + 1.5, z: perch.z, uid: -1 });
    size = await shot('o-parrot-perch');
    meta.scenes.push({
      name: 'o-parrot-perch', bird, aim: sitAim,
      note: '机位：林冠上停栖的鹦鹉（自然刷群，无手动 spawn；翅膀收拢、尾羽下垂）',
      camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'),
      image: size
    });

    /* 第二张：站到鸟正下方把它惊飞，等同一只离开停栖态再拍 —— 翼尖抬起、两侧反相的那一帧 */
    const flyAim = await evl(`
      const G = window.__game, T = window.__test;
      const b = ${JSON.stringify(bird.sit || bird.birds[0])};
      T.teleport(b.x, b.y - 1.2, b.z);
      const t0 = performance.now();
      let f = null;
      while (performance.now() - t0 < 8000) {
        f = T.birdInfo().find(x => x.uid === b.uid && x.phase !== 'perched');
        if (f) break;
        await new Promise(r => setTimeout(r, 100));
      }
      if (!f) return { flew: false };
      /* 让它先飞满一拍再追机位：起飞第一帧翅膀还在收拢位 */
      await new Promise(r => setTimeout(r, 420));
      const now = T.birdInfo().find(x => x.uid === b.uid) || T.birdInfo()[0];
      const camX = now.x - 3.4, camZ = now.z, camY = now.y - 0.8;
      T.teleport(camX, camY, camZ); G.controller.flying = true;
      const dx = now.x - camX, dy = now.y - (camY + 1.62), dz = now.z - camZ;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.yaw = Math.atan2(-dx / L, -dz / L);
      G.controller.pitch = Math.asin(Math.max(-1, Math.min(1, dy / L)));
      await new Promise(r => setTimeout(r, 260));
      const again = T.birdInfo().find(x => x.uid === b.uid) || T.birdInfo()[0];
      return {
        flew: true, ms: Math.round(performance.now() - t0),
        target: again ? { uid: again.uid, phase: again.phase, pos: [again.x, again.y, again.z], wingL: again.wingL, wingR: again.wingR, tail: again.tail, speed: again.speed } : null,
        yaw: +G.controller.yaw.toFixed(4), pitch: +G.controller.pitch.toFixed(4),
        all: T.birdInfo().map(x => ({ uid: x.uid, phase: x.phase, wingL: x.wingL, wingR: x.wingR }))
      };
    `);
    size = await shot('o-parrot-flight');
    meta.scenes.push({
      name: 'o-parrot-flight', bird, aim: flyAim,
      note: '机位：被玩家惊飞的那一只（phase=' + (flyAim && flyAim.target ? flyAim.target.phase : '?') +
        '，翼尖角度 ' + (flyAim && flyAim.target ? flyAim.target.wingL : '?') + '/' + (flyAim && flyAim.target ? flyAim.target.wingR : '?') + '）',
      camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:G.controller.yaw, pitch:G.controller.pitch };'),
      image: size
    });
  }

  /* O.3/O.4 暗洞敌怪 A/B：不复用 L 小节那条步行洞当「暗边」—— 那洞里为了截图插过两支火把，
   * 中心亮度 0.785，判据只能读 0/25，对照没有意义；而且深洞的 Y 在地下刷怪带（地表以下 5~28 格）之外。
   * 这里照 CV.0~CV.3 的办法现场挖一间 27×27 密封石室（地表以下 10 格：实心地板 + 4 格净空 + 5 格顶盖），
   * 排空三段队列并回读，点灯前后各扫一次中心 5×5、各跑 120 次候选点搜索（同一个 box 筛选）。 */
  if (nDark) {
    const oCarve = await evl(`
      const G = window.__game, T = window.__test;
      const s = ${JSON.stringify(nDark)};
      const surf = G.world.surfaceHeight(s.x, s.z);
      const ry = Math.max(G.world.minY + 8, surf - 10);
      G.controller.setCreative(true);
      T.teleport(s.x + 0.5, ry, s.z + 0.5);
      G.controller.flying = true;
      await T.waitChunks(1, { light: true });
      let writes = 0;
      for (let dz = -13; dz <= 13; dz++) for (let dx = -13; dx <= 13; dx++) {
        T.setBlock(s.x + dx, ry - 1, s.z + dz, 1); writes++;                              // 地板实心
        for (let h = 0; h <= 3; h++) { T.setBlock(s.x + dx, ry + h, s.z + dz, 0); writes++; }   // 掏空 4 格高
        for (let h = 4; h <= 8; h++) { T.setBlock(s.x + dx, ry + h, s.z + dz, 1); writes++; }   // 顶盖 5 格：把天光挡死
      }
      const t0 = Date.now();
      while (Date.now() - t0 < 25000) {
        const p = T.worldPending();
        if (p && p.gen === 0 && p.light === 0 && p.mesh === 0) break;
        await new Promise(r => setTimeout(r, 60));
      }
      return { ry, surf, writes, pending: T.worldPending(),
        back: { center: T.blockAt(s.x, ry, s.z).id, roof: T.blockAt(s.x, ry + 4, s.z).id,
          corner: T.blockAt(s.x + 13, ry, s.z + 13).id, floor: T.blockAt(s.x, ry - 1, s.z).id } };
    `);
    const oRy = oCarve.ry;
    const oBox = { x0: nDark.x - 13, x1: nDark.x + 13, y0: oRy, y1: oRy + 3, z0: nDark.z - 13, z1: nDark.z + 13 };
    const judgeDark = await evl(`
      const G = window.__game, T = window.__test;
      const s = ${JSON.stringify(nDark)}, ry = ${oRy}, box = ${JSON.stringify(oBox)};
      const cells = [];
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const r = T.mobSiteOk(true, s.x + dx + 0.5, ry, s.z + dz + 0.5, 1.0);
        cells.push(r.ok ? 1 : (r.why === 'light' ? 0 : -1));
      }
      return {
        day: 1.0, exposed: T.exposedToSky(s.x + 0.5, ry, s.z + 0.5),
        center: T.mobSiteOk(true, s.x + 0.5, ry, s.z + 0.5, 1.0),
        pass: cells.filter(v => v === 1).length, cells: cells.length,
        light: T.lightAt(s.x, ry, s.z),
        probe: T.caveSiteProbe(1.0, 120, box)
      };
    `);
    const oMob = await nPose('zombie', nDark.x + 4, oRy, nDark.z, -Math.PI / 2);
    await nLook(nDark.x, oRy, nDark.z, nDark.x + 4, oRy + 1.5, nDark.z);
    await nHold(oMob.id, -Math.PI / 2, 400);
    size = await shot('o-cave-dark');
    meta.scenes.push({ name: 'o-cave-dark', mob: oMob, judge: judgeDark, carve: oCarve, cave: nDark, note: '密封石室（写入 ' + oCarve.writes + '，回读 ' + JSON.stringify(oCarve.back) + '）：正午 ' + judgeDark.pass + '/' + judgeDark.cells + ' 格通过敌怪判据，中心亮度 ' + judgeDark.center.light + '，候选搜索落进这间 ' + judgeDark.probe.inBox + '/' + judgeDark.probe.tries + '（摆拍僵尸 + 判据读数）', camera: await nCam(), image: size });

    const judgeLit = await evl(`
      const G = window.__game, T = window.__test;
      const s = ${JSON.stringify(nDark)}, ry = ${oRy}, box = ${JSON.stringify(oBox)};
      for (const dx of [-12, -6, 0, 6, 12]) for (const dz of [-12, -6, 0, 6, 12]) T.setBlock(s.x + dx, ry, s.z + dz, 34);   // 25 盏火把，间距 6，铺满整间（与 CV 同布局）
      await T.waitChunks(1, { light: true });
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        const p = T.worldPending();
        if (p && p.gen === 0 && p.light === 0 && p.mesh === 0) break;
        await new Promise(r => setTimeout(r, 60));
      }
      const cells = [];
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const r = T.mobSiteOk(true, s.x + dx + 0.5, ry, s.z + dz + 0.5, 1.0);
        cells.push(r.ok ? 1 : (r.why === 'light' ? 0 : -1));
      }
      return {
        center: T.mobSiteOk(true, s.x + 0.5, ry, s.z + 0.5, 1.0),
        pass: cells.filter(v => v === 1).length, rejectLight: cells.filter(v => v === 0).length,
        rejectStand: cells.filter(v => v === -1).length, cells: cells.length,
        light: T.lightAt(s.x, ry, s.z), torch: T.blockAt(s.x, ry, s.z).id,
        probe: T.caveSiteProbe(1.0, 120, box)
      };
    `);
    await nHold(oMob.id, -Math.PI / 2, 300);
    size = await shot('o-cave-torch');
    meta.scenes.push({ name: 'o-cave-torch', mob: oMob, judge: judgeLit, cave: nDark, note: '同一间只多点 25 盏火把：通过判据的格子从 ' + judgeDark.pass + ' 变成 ' + judgeLit.pass + '（挡下的原因全是亮度 ' + judgeLit.rejectLight + ' 格，中心 ' + judgeDark.center.light + '→' + judgeLit.center.light + '），候选搜索落进这间 ' + judgeDark.probe.inBox + '→' + judgeLit.probe.inBox, camera: await nCam(), image: size });
    await evl(`
      const T = window.__test;
      const s = ${JSON.stringify(nDark)}, ry = ${oRy};
      for (let dz = -13; dz <= 13; dz++) for (let dx = -13; dx <= 13; dx++) {
        for (let h = 0; h <= 3; h++) T.setBlock(s.x + dx, ry + h, s.z + dz, 1);   // 石室填回，不留大腔
      }
      await T.waitChunks(1, { light: true });
      return true;
    `);
    await nClear();
  } else {
    meta.scenes.push({ name: 'o-cave-dark', note: 'L 小节没找到可步行的深洞，暗洞判据 A/B 跳过' });
  }
  const cs = win.getContentSize();
  meta.window.actual = { width: cs[0], height: cs[1] };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({
    label: LABEL, seed: meta.seed, mode: meta.mode, time: meta.time,
    weather: meta.weather, window: meta.window.actual, regions: {
      ground: 'x 0.15~0.85, y 0.55~0.92 近景地表',
      horizon: 'x 0.05~0.95, y 0.35~0.50 远景/树线',
      sky: 'x 0.10~0.90, y 0.05~0.22 天空',
      center: 'x 0.35~0.65, y 0.45~0.75 画面中心（火把/前景）'
    }, scenes: stats
  }, null, 2));
  console.log('[meta] ' + path.join('artifacts', 'visual', LABEL, 'meta.json'));
  console.log('[stats] ' + path.join('artifacts', 'visual', LABEL, 'stats.json'));
  await srv.close();
  app.exit(0);
}
run().catch(async (e) => { console.error('取证失败：' + ((e && e.stack) || e)); app.exit(1); });
