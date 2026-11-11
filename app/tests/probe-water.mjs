/*
 * 阶段 6 取证：水面观感的 A/B（结构读数 + 三个固定机位截图）。
 *   cd app && npx electron tests/probe-water.mjs before
 *   ...改完再跑 after
 * 产出 artifacts/visual/water-<label>/{w-bank, w-surface, w-under}.png 与 meta.json。
 *
 * 三个机位是任务书点名的：固定岸边、水面俯视、水下平视。
 * 结构读数回答「条带/侧面/亮点」来自哪一类面：按法线统计水面三角形、
 * 统计同一平面上的重叠层数（重叠 + depthWrite:false = 典型的重复亮点）。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const LABEL = (process.argv.slice(1).find(a => /^(before|after)$/.test(a))) || 'before';
const OUT = path.join(ART, 'water-' + LABEL);
const SAVES = path.join(APP, 'tests', '.water-saves');
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.setName('方块世界-水面取证');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 水面取证',
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
  const meta = { label: LABEL, seed: 'visual-audit-2026', window: { width: 1280, height: 720 }, time: 0.3, weather: 'clear', scenes: [], structure: null };

  const shot = async (name) => {
    await evl("const w=document.querySelector('#toast-wrap'); if(w) w.innerHTML=''; const a=document.querySelector('#ach-toast'); if(a) a.classList.remove('show'); return true;");
    const img = await win.webContents.capturePage();
    const sz = img.getSize();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    console.log('[截图] ' + path.join('artifacts', 'visual', 'water-' + LABEL, name + '.png') + ' ' + sz.width + 'x' + sz.height);
    return { width: sz.width, height: sz.height };
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
    document.querySelector('#inp-name').value = '水面取证';
    document.querySelector('#inp-seed').value = 'visual-audit-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 240; i++) {
    const ok = await evl('const G=window.__game; return G.state==="playing" && G.world && G.world.genQueue.length===0 && G.world.dirtyMesh.size===0;').catch(() => false);
    if (ok) break;
    await sleep(250);
  }
  await sleep(600);

  /* ---- 找一片「够深、够大」的水：按世界坐标扫水柱，取水深 ≥ 4 且周围 9×9 都有水的那一列 ---- */
  const spot = await evl(`
    const G = window.__game, T = window.__test;
    const sea = G.world.seaLevel;
    let best = null;
    const cx0 = Math.floor(G.controller.pos.x), cz0 = Math.floor(G.controller.pos.z);
    for (let r = 8; r <= 64 && !best; r += 4) {
      for (let dx = -r; dx <= r && !best; dx += 4) {
        for (let dz = -r; dz <= r && !best; dz += 4) {
          const x = cx0 + dx, z = cz0 + dz;
          let depth = 0;
          for (let y = sea; y > sea - 12; y--) { if (G.world.getBlock(x, y, z) === T.blockIds.WATER) depth++; else break; }
          if (depth < 4) continue;
          let wet = 0;
          for (let ax = -4; ax <= 4; ax += 2) for (let az = -4; az <= 4; az += 2) {
            if (G.world.getBlock(x + ax, sea - 1, z + az) === T.blockIds.WATER) wet++;
          }
          if (wet >= 20) best = { x, z, depth, sea, wet };
        }
      }
    }
    if (!best) return null;
    T.teleport(best.x + 0.5, best.sea + 3, best.z + 0.5);
    G.world.setCenter(best.x, best.z);
    await T.waitChunks(2, { light: true });
    return best;
  `);
  if (!spot) { console.error('找不到合适的水域'); await srv.close(); app.exit(1); return; }
  console.log('水域 =', JSON.stringify(spot));
  meta.water = spot;

  /* ---- 结构读数：直接读**正在渲染**的水网格（不是重算一遍）---- */
  meta.structure = await evl(`
    const G = window.__game;
    const out = { top: 0, bottom: 0, sideX: 0, sideZ: 0, planes: {}, dupPlanes: 0, maxOverlap: 0, meshes: 0, verts: 0 };
    for (const [, c] of G.world.chunks) {
      if (!c.meshes || c.meshes.length < 3) continue;
      const mesh = c.meshes[2];                 // [opaque, cutout, water]
      const g = mesh && mesh.geometry;
      if (!g) continue;
      const pos = g.getAttribute('position'), nor = g.getAttribute('normal');
      if (!pos) continue;
      out.meshes++; out.verts += pos.count;
      for (let i = 0; i < pos.count; i += 4) {
        const ny = nor.getY(i);
        if (ny > 0.5) out.top++;
        else if (ny < -0.5) out.bottom++;
        else if (Math.abs(nor.getX(i)) > 0.5) out.sideX++;
        else out.sideZ++;
        const y0 = pos.getY(i), y1 = pos.getY(i + 1), y2 = pos.getY(i + 2), y3 = pos.getY(i + 3);
        const key = (ny > 0.5 ? 'T' : ny < -0.5 ? 'B' : Math.abs(nor.getX(i)) > 0.5 ? 'X' : 'Z')
          + '@' + Math.max(y0, y1, y2, y3).toFixed(3);
        out.planes[key] = (out.planes[key] || 0) + 1;
      }
    }
    const ent = Object.entries(out.planes).sort((a, b) => b[1] - a[1]);
    out.dupPlanes = ent.filter(([, v]) => v > 1).length;
    out.maxOverlap = ent.length ? ent[0][1] : 0;
    out.topPlanes = ent.slice(0, 6);
    delete out.planes;
    return out;
  `);
  console.log('结构 =', JSON.stringify(meta.structure));

  /* ---- 机位 1：固定岸边（站在水边干地上，平视水面）---- */
  await evl(`
    const G = window.__game, T = window.__test;
    const s = ${JSON.stringify(spot)};
    /* 从水中心向外找一格干地（水面之上不是水、脚下实心），站上去朝水里看 */
    let bank = null;
    for (let r = 4; r <= 16 && !bank; r++) {
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r]]) {
        const x = s.x + dx, z = s.z + dz;
        if (G.world.getBlock(x, s.sea, z) === T.blockIds.WATER) continue;
        const top = G.world.topSolidY(x, z);
        if (top < s.sea - 2) continue;
        bank = { x, z, y: top + 1 };
        break;
      }
    }
    if (!bank) bank = { x: s.x + 8, z: s.z, y: s.sea + 1 };
    T.teleport(bank.x + 0.5, bank.y, bank.z + 0.5);
    const dx = s.x - bank.x, dz = s.z - bank.z;
    G.controller.yaw = Math.atan2(-dx, -dz);
    G.controller.pitch = -0.08;
    await T.waitChunks(2, { light: true });
    await new Promise(r => setTimeout(r, 500));
    return bank;
  `);
  meta.scenes.push({ name: 'w-bank', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:+G.controller.yaw.toFixed(3), pitch:+G.controller.pitch.toFixed(3) };'), image: await shot('w-bank') });

  /* ---- 机位 2：水面俯视（水中心正上方，往下看）---- */
  await evl(`
    const G = window.__game, T = window.__test;
    const s = ${JSON.stringify(spot)};
    T.teleport(s.x + 0.5, s.sea + 4.2, s.z + 0.5);
    G.controller.yaw = 0.6;
    G.controller.pitch = -0.85;
    await T.waitChunks(1, { light: true });
    await new Promise(r => setTimeout(r, 500));
    return true;
  `);
  meta.scenes.push({ name: 'w-surface', camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:+G.controller.yaw.toFixed(3), pitch:+G.controller.pitch.toFixed(3) };'), image: await shot('w-surface') });

  /* ---- 机位 3：水下平视（水面下 1.5 格朝水平方向看）---- */
  const under = await evl(`
    const G = window.__game, T = window.__test;
    const s = ${JSON.stringify(spot)};
    T.teleport(s.x + 0.5, s.sea - 2.5, s.z + 0.5);
    G.controller.yaw = 0.6;
    G.controller.pitch = 0.02;
    await T.waitChunks(1, { light: true });
    await new Promise(r => setTimeout(r, 500));
    return { y: +G.controller.pos.y.toFixed(2), inWater: !!G.controller.inWater, underwater: !!G.sfx._underwater,
      sea: s.sea, waterAt: G.world.getBlock(Math.floor(G.controller.pos.x), s.sea - 1, Math.floor(G.controller.pos.z)) };
  `);
  meta.scenes.push({ name: 'w-under', under, camera: await evl('const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:+G.controller.yaw.toFixed(3), pitch:+G.controller.pitch.toFixed(3) };'), image: await shot('w-under') });

  /* ---- 出水过渡：同一位置抬到水面上一格，确认「水中 → 上岸」没有突变 ---- */
  const above = await evl(`
    const G = window.__game, T = window.__test;
    const s = ${JSON.stringify(spot)};
    T.teleport(s.x + 0.5, s.sea + 1.4, s.z + 0.5);
    await new Promise(r => setTimeout(r, 400));
    return { y: +G.controller.pos.y.toFixed(2), inWater: !!G.controller.inWater };
  `);
  meta.scenes.push({ name: 'w-above', above, image: await shot('w-above') });

  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log('meta →', path.join('artifacts', 'visual', 'water-' + LABEL, 'meta.json'));
  await srv.close();
  app.exit(0);
}
run().catch(async (e) => { console.error(e); app.exit(1); });
