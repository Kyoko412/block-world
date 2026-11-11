/*
 * 固定条件场景取证（本轮 B/C 用）：四组场景 + 角色/第一人称近景。
 *   cd app && npx electron tests/shot-scenes-r1.mjs --tag before
 *   cd app && npx electron tests/shot-scenes-r1.mjs --tag after
 *
 * 「固定条件」是硬约束：世界种子、坐标、朝向、天气、时刻、亮度、视距、FOV、分辨率
 * 全部写进 artifacts/quality-round1/scene-plan.json；第二次运行直接读同一份 plan，
 * 不允许靠换机位/曝光/隐藏 HUD 制造改进。默认 HUD 保持可见（游玩视角）。
 *
 * 场景：林缘 / 岸边+水下 / 小屋(村庄) / 负 Y 洞穴 / 角色近景（僵尸·守卫）/ 第一人称持握
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

/* 这些开关必须在 app ready 之前设置：force-device-scale-factor 决定截图分辨率
   （Windows 默认 150% 缩放会把 1280×720 抓成 1920×1080，前后图尺寸就不一致了）。 */
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '0');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const TAG = (() => { const i = process.argv.indexOf('--tag'); return i > 0 ? process.argv[i + 1] : 'before'; })();
const PLAN_F = path.join(APP, '..', 'artifacts', 'quality-round2', 'scene-plan.json');
const OUT = path.join(APP, '..', 'artifacts', 'quality-round2', TAG);
const SAVES = path.join(APP, 'tests', '.scenes-r1-' + TAG);
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

async function run() {
  await app.whenReady();
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  /* 固定分辨率：Windows 缩放会把 1280×720 抓成 1920×1080，前后图必须同尺寸才能比 */
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, useContentSize: true, show: true, title: '场景取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setContentSize(1280, 720);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => { try { if (win.isDestroyed()) return; win.showInactive(); win.moveTop(); } catch (e) { } }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  const run1 = (code) => win.webContents.executeJavaScript(code);

  await win.loadURL(srv.url);
  for (let i = 0; i < 150; i++) {
    if (await evl('return !!(window.__game && window.__test);').catch(() => false)) break;
    await sleep(200);
  }
  await evl("window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;");
  const SEED = 'visual-audit-2026';
  await evl(`
    document.querySelector('[data-a=new]').click();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('#inp-name').value = '场景取证';
    document.querySelector('#inp-seed').value = ${JSON.stringify(SEED)};
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 400; i++) {
    const ready = await evl('const G=window.__game; return G.state==="playing" && G.world && G.world.genQueue.length===0;').catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(1000);

  /* ---------- 场景定位：第一次运行算出来并落盘，之后两次都用同一份 ---------- */
  let plan = null;
  if (fs.existsSync(PLAN_F)) { try { plan = JSON.parse(fs.readFileSync(PLAN_F, 'utf8')); } catch (e) { plan = null; } }
  if (!plan) {
    plan = await evl(`
      const G = window.__game, T = window.__test;
      const w = G.world;
      const sp = { x: Math.floor(G.controller.pos.x), z: Math.floor(G.controller.pos.z) };
      const solid = (x, y, z) => w.isSolidAt(x, y, z);
      const air = (x, y, z) => !solid(x, y, z);
      /* ① 林缘：必须是「真树」（原木上方 3 格内有树叶），附近没有木板/建筑（避开村庄），
         站位 3 格内不许有树干/树冠（否则镜头贴进树里），并朝向树群。
         上一版把村庄的风车原木当成了树，镜头直接怼在木板墙和小麦田上。 */
      let forest = null;
      for (let r = 3; r <= 70 && !forest; r++) {
        for (let a = 0; a < 24 && !forest; a++) {
          const ang = a * Math.PI / 12;
          const x = sp.x + Math.round(Math.cos(ang) * r), z = sp.z + Math.round(Math.sin(ang) * r);
          const y = w.topSolidY(x, z);
          if (w.getBlock(x, y, z) !== T.blockIds.GRASS) continue;
          let blocked = false;
          for (let dz2 = -3; dz2 <= 3 && !blocked; dz2++) for (let dx2 = -3; dx2 <= 3 && !blocked; dx2++) {
            for (let dy = 1; dy <= 6; dy++) {
              const id = w.getBlock(x + dx2, y + dy, z + dz2);
              if (id === T.blockIds.LOG || id === T.blockIds.BIRCH_LOG || id === T.blockIds.LEAVES) { blocked = true; break; }
            }
          }
          if (blocked) continue;
          /* 12 格内：真树（原木 + 上方树叶）计数，同时排除人造木板/门/工作台 */
          let trees = 0, sx = 0, sz = 0, planks = 0;
          for (let dz2 = -12; dz2 <= 12; dz2++) for (let dx2 = -12; dx2 <= 12; dx2++) {
            let isTree = false;
            for (let dy = 1; dy <= 8; dy++) {
              const id = w.getBlock(x + dx2, y + dy, z + dz2);
              if (id === T.blockIds.PLANKS || id === T.blockIds.BIRCH_PLANKS || id === T.blockIds.CRAFTING_TABLE) planks++;
              if (!isTree && (id === T.blockIds.LOG || id === T.blockIds.BIRCH_LOG)) {
                for (let dy2 = 1; dy2 <= 4; dy2++) {
                  if (w.getBlock(x + dx2, y + dy + dy2, z + dz2) === T.blockIds.LEAVES) { isTree = true; break; }
                }
              }
            }
            if (isTree) { trees++; sx += dx2; sz += dz2; }
          }
          if (planks > 2) continue;
          if (trees >= 4) forest = { x, y, z, trees, planks, lookX: +(sx / trees).toFixed(2), lookZ: +(sz / trees).toFixed(2) };
        }
      }
      /* ② 岸边：任意陆地格，12 格内有水面且水面不高于陆地 2 格；水下取水面下 3 格
         注意 topSolidY 会跳过水，所以找水必须直接查方块，不能拿「最高实心格」当水面。 */
      const waterTop = (x, z) => {
        for (let y = 36; y >= 26; y--) if (w.getBlock(x, y, z) === T.blockIds.WATER) return y;
        return null;
      };
      let shore = null, under = null;
      for (let r = 4; r <= 120 && !shore; r++) {
        for (let a = 0; a < 32 && !shore; a++) {
          const ang = a * Math.PI / 16;
          const x = sp.x + Math.round(Math.cos(ang) * r), z = sp.z + Math.round(Math.sin(ang) * r);
          const y = w.topSolidY(x, z);
          const id = w.getBlock(x, y, z);
          if (waterTop(x, z) !== null) continue;              // 站位要在陆地上
          if (!w.isSolidAt(x, y, z)) continue;
          for (let k = 2; k <= 14 && !shore; k++) {
            const wx = x + Math.round(Math.cos(ang) * k), wz = z + Math.round(Math.sin(ang) * k);
            const wt = waterTop(wx, wz);
            if (wt === null) continue;
            if (wt > y + 1 || wt < y - 6) continue;           // 水面与岸边高度接近
            shore = { x, y, z, ang, water: { x: wx, y: wt, z: wz }, shoreId: id };
            /* 水下点：沿同一方向继续走到水更深的位置 */
            let wcx = wx, wcz = wz, wty = wt;
            for (let k2 = 1; k2 <= 8; k2++) {
              const tx = x + Math.round(Math.cos(ang) * (k + k2)), tz = z + Math.round(Math.sin(ang) * (k + k2));
              const ty = waterTop(tx, tz);
              if (ty !== null) { wcx = tx; wcz = tz; wty = ty; }
            }
            under = { x: wcx, y: Math.max(wty - 3, w.minY + 2), z: wcz, surfaceY: wty };
          }
        }
      }
      /* ③ 村庄：产品自己的村庄中心 */
      const v = G.village || (G.villageSite ? G.villageSite() : null);
      const village = v ? { x: Math.floor(v.x), z: Math.floor(v.z), y: w.topSolidY(Math.floor(v.x), Math.floor(v.z)) } : null;
      /* ④ 负 Y 洞穴：y≈-20 处找一格「脚下实心、上方 3 格空气、头顶实心」的天然洞道 */
      let cave = null;
      for (let r = 0; r <= 26 && !cave; r++) {
        for (let dz = -r; dz <= r && !cave; dz++) for (let dx = -r; dx <= r && !cave; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = sp.x + dx, z = sp.z + dz;
          for (let y = -6; y >= -28; y--) {
            if (!solid(x, y, z)) continue;
            let ok = true;
            for (let k = 1; k <= 3; k++) if (!air(x, y + k, z)) { ok = false; break; }
            if (!ok) continue;
            if (!solid(x, y + 4, z)) continue;          // 有顶：不是露天竖井
            cave = { x, y: y + 1, z };
            break;
          }
        }
      }
      return { seed: ${JSON.stringify(SEED)}, spawn: sp, forest, shore, under, village, cave };
    `);
    fs.mkdirSync(path.dirname(PLAN_F), { recursive: true });
    fs.writeFileSync(PLAN_F, JSON.stringify(plan, null, 2));
    log('场景 plan 已生成：' + PLAN_F);
  } else {
    log('场景 plan 复用：' + PLAN_F);
  }
  log(JSON.stringify(plan, null, 2));

  /* ---------- 固定条件 ---------- */
  const FIXED = `
    T.setTime(%TIME%);
    T.setWeather('clear', 900); T.tickWeather(0.05, 40);
    G.settings.brightness = 1;
    G.view.applySettings({ brightness: 1, renderDistance: 6, fov: 70 });
    G.view.setRenderDistance(6); G.view.setFov(70);
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 1;
    G.mobs.maxMobs = 0;
    G.settings.showHud !== false && G.ui && G.ui.setHud && G.ui.setHud(true);
  `;
  const place = async (x, y, z, yaw, pitch, time) => {
    await evl(`
      const G = window.__game, T = window.__test;
      ${FIXED.replace('%TIME%', String(time))}
      T.teleport(${x}, ${y}, ${z});
      G.controller.yaw = ${yaw}; G.controller.pitch = ${pitch};
      G.world.setCenter(Math.floor(${x}), Math.floor(${z}));
      await new Promise(r => setTimeout(r, 1600));
      return { pos: T.state().pos, yaw: +G.controller.yaw.toFixed(4), fov: G.view.camera.fov,
        dist: G.view.uniforms.uFogFar.value, brightness: G.view.uniforms.uBrightness.value };
    `);
  };
  const shot = async (name) => {
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 720 });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, img.toPNG());
    const sz = img.getSize();
    log('  截图 ' + name + '  ' + sz.width + 'x' + sz.height);
    return { name, file, w: sz.width, h: sz.height };
  };

  const shots = [];
  const meta = { tag: TAG, at: new Date().toISOString(), seed: SEED, fixed: 'time/weather/brightness=1/renderDistance=6/fov=70/1280x720/HUD on', shots: [] };
  const want = (k) => !process.argv.includes('--only') || String(process.argv[process.argv.indexOf('--only') + 1]).split(',').includes(k);

  /* ① 林缘 */
  if (want('forest') && plan.forest) {
    const f = plan.forest;
    /* 朝向树群：模型正面约定 atan2(-dx,-dz) */
    const yaw = Math.atan2(-(f.lookX || 0), -(f.lookZ || -1));
    const info = await place(f.x + 0.5, f.y + 1, f.z + 0.5, yaw, 0.06, 0.30);
    shots.push(await shot('b1-林缘'));
    meta.shots.push({ scene: '林缘', view: info, plan: f });
  }
  /* ② 岸边 + 水下 */
  if (want('shore') && plan.shore) {
    const s = plan.shore;
    const yaw = Math.atan2(-Math.cos(s.ang), -Math.sin(s.ang));
    const info = await place(s.x + 0.5, s.y + 1, s.z + 0.5, yaw, 0.04, 0.32);
    shots.push(await shot('b2-岸边'));
    meta.shots.push({ scene: '岸边', view: info, plan: s });
    if (plan.under) {
      const u = plan.under;
      const info2 = await place(u.x + 0.5, u.y, u.z + 0.5, yaw, 0.0, 0.32);
      shots.push(await shot('b2b-水下'));
      meta.shots.push({ scene: '水下', view: info2, plan: u });
    }
  }
  /* ③ 小屋 / 村庄：从村外 14 格回看，避免镜头怼在墙面上 */
  if (want('village') && plan.village) {
    const v = plan.village;
    const info = await evl(`
      const G = window.__game, T = window.__test;
      ${FIXED.replace('%TIME%', '0.30')}
      const c = ${JSON.stringify(v)};
      const w = G.world;
      /* 在 14~18 格外的 16 个方向里挑第一个「站得住 + 视线不被方块挡住」的机位 */
      let best = null;
      for (let r = 14; r <= 18 && !best; r++) {
        for (let a = 0; a < 16 && !best; a++) {
          const ang = a * Math.PI / 8;
          const x = Math.floor(c.x + Math.cos(ang) * r), z = Math.floor(c.z + Math.sin(ang) * r);
          const y = w.topSolidY(x, z);
          if (y <= 0) continue;
          let blocked = 0;
          for (let k = 1; k < r; k++) {
            const px = Math.round(x + (c.x - x) * (k / r)), pz = Math.round(z + (c.z - z) * (k / r));
            for (let dy = 1; dy <= 6; dy++) if (w.isSolidAt(px, y + dy, pz)) { blocked++; break; }
          }
          if (blocked > 3) continue;
          best = { x, y, z, ang, blocked };
        }
      }
      if (!best) return { ok: false };
      T.teleport(best.x + 0.5, best.y + 1, best.z + 0.5);
      const dx = c.x - best.x, dz = c.z - best.z;
      G.controller.yaw = Math.atan2(-dx, -dz);
      G.controller.pitch = 0.10;
      G.world.setCenter(c.x, c.z);
      await new Promise(r2 => setTimeout(r2, 1700));
      return { ok: true, view: best, pos: T.state().pos, yaw: +G.controller.yaw.toFixed(4) };
    `);
    shots.push(await shot('b3-村庄'));
    meta.shots.push({ scene: '村庄', view: info, plan: v });
  }
  /* ④ 负 Y 洞穴：两支火把（与审计同一布置），暗处保留 */
  if (want('cave') && plan.cave) {
    const c = plan.cave;
    const info = await evl(`
      const G = window.__game, T = window.__test;
      ${FIXED.replace('%TIME%', '0.30')}
      const c = ${JSON.stringify(c)};
      const yaw = 0.6;
      /* 火把：沿视线方向摆在身前的地面上（与审计同样的「两支火把」做法），
         这样画面的光池一定在视野里，而不是摆在身后。 */
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const putTorch = (x, z) => {
        for (let dy = 2; dy >= -3; dy--) {
          const y = c.y + dy;
          if (!G.world.isSolidAt(x, y, z) && G.world.isSolidAt(x, y - 1, z)) {
            if (!G.world.isSolidAt(x, y + 1, z)) { T.setBlock(x, y, z, T.blockIds.TORCH); return true; }
          }
        }
        return false;
      };
      let torches = 0;
      for (const [d, side] of [[2.2, 0], [3.6, -1.4], [3.6, 1.4]]) {
        const tx = Math.round(c.x + fx * d - fz * side), tz = Math.round(c.z + fz * d + fx * side);
        if (putTorch(tx, tz)) torches++;
      }
      T.teleport(c.x + 0.5, c.y, c.z + 0.5);
      G.controller.yaw = yaw; G.controller.pitch = -0.05;
      G.world.setCenter(c.x, c.z);
      await new Promise(r => setTimeout(r, 1800));
      return { pos: T.state().pos, torches, light: T.lightAt(c.x, c.y + 1, c.z) };
    `);
    shots.push(await shot('b4-负Y洞穴'));
    meta.shots.push({ scene: '负Y洞穴', view: info, plan: c });
  }
  /* ⑤ 角色近景：僵尸 / 守卫 / 苦力怕 / 骷髅（临时布置，仅用于外观对照） */
  if (want('char')) {
    const info = await evl(`
      const G = window.__game, T = window.__test;
      ${FIXED.replace('%TIME%', '0.30')}
      const px = Math.floor(G.controller.pos.x), pz = Math.floor(G.controller.pos.z);
      const gy = G.world.topSolidY(px + 6, pz);
      /* 清出一块平整的对照台（仅外观取证，不代表自然生成） */
      for (let dx = 0; dx <= 10; dx++) for (let dz = -5; dz <= 5; dz++) {
        for (let dy = 1; dy <= 4; dy++) T.setBlock(px + dx, gy + dy, pz + dz, 0);
        T.setBlock(px + dx, gy, pz + dz, T.blockIds.STONE);
      }
      T.teleport(px + 0.5, gy + 1, pz + 0.5);
      G.controller.yaw = -Math.PI / 2; G.controller.pitch = 0.02;
      G.controller.invulnerable = 3; G.controller.health = 20;
      G.mobs.maxMobs = 10;
      G.mobs.clear();
      /* 四只并排在 6 格外、间距 2.2 格：看得清贴图，又不会挡住彼此 */
      const xs = 6.5, list = [['zombie', -3.3], ['creeper', -1.1], ['skeleton', 1.1], ['guardian', 3.6]];
      for (const [type, dz] of list) {
        const m = G.mobs.spawn(type, px + xs, gy + 1, pz + dz);
        if (m) { m.yaw = -Math.PI / 2; m.wanderT = 1e9; m.hostile = false; m.damage = 0; }
      }
      await new Promise(r => setTimeout(r, 1400));
      G.controller.health = 20; G.controller.invulnerable = 3;
      return { pos: T.state().pos, mobs: T.mobDump() };
    `);
    shots.push(await shot('c1-僵尸与敌怪'));
    meta.shots.push({ scene: '角色近景', view: info });
  }
  /* ⑥ 第一人称：空手 / 镐 / 剑 / 斧（清场后站在开阔地面，看地平线） */
  if (want('fp')) {
    const fp = [];
    const setupFp = async (item) => evl(`
      const G = window.__game, T = window.__test;
      ${FIXED.replace('%TIME%', '0.30')}
      /* 清场：角色近景那一段留下的怪会走进镜头（上一版就是这样把画面挡住的） */
      G.mobs.maxMobs = 0; G.mobs.clear();
      const px = Math.floor(G.controller.pos.x), pz = Math.floor(G.controller.pos.z);
      T.teleport(px + 0.5, G.world.topSolidY(px, pz) + 1, pz + 0.5);
      for (let dx = -3; dx <= 6; dx++) for (let dz = -3; dz <= 3; dz++) {
        for (let dy = 1; dy <= 4; dy++) {
          const y = G.world.topSolidY(px + dx, pz + dz) + dy;
          if (G.world.isSolidAt(px + dx, y, pz + dz) && dy <= 2) T.setBlock(px + dx, y, pz + dz, 0);
        }
      }
      G.inventory.clear();
      ${item ? 'G.inventory.add(' + JSON.stringify(item) + ', 1); G.inventory.select(0);' : 'G.inventory.select(0);'}
      G.controller.yaw = -Math.PI / 2; G.controller.pitch = 0.10;
      await new Promise(r => setTimeout(r, 800));
      return { held: T.state().held, mesh: (function(){ const v = G.heldView; return v && v.mesh ? (v.mesh.userData && v.mesh.userData.isArm ? 'arm' : (v.mesh.type || 'group')) : null; })() };
    `);
    for (const [name, item] of [['空手', null], ['木镐', 'pickaxe_wood'], ['铁剑', 'sword_iron'], ['铁斧', 'axe_iron']]) {
      const info = await setupFp(item);
      meta.shots.push({ scene: '第一人称持握 ' + name, view: info });
      fp.push(await shot('c2-持握-' + name));
    }
  }

  fs.writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(meta, null, 2));
  log('→ ' + path.join(OUT, 'shots.json'));
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
