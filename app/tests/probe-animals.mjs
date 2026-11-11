/*
 * 阶段 6 取证：猪 / 牛 / 羊 的贴图近景与材质接入（机读 + 截图）。
 *   cd app && npx electron tests/probe-animals.mjs
 *
 * 为什么需要它：PN.1 只证明「贴图挂上了、色档够、不露品红」——那是技术问题。
 * 「近看好不好看、和骷髅/苦力怕/鱼/鹦鹉是不是一套画风」必须看画面与像素分布。
 *
 * 做法（第一版踩过的坑写在这里，免得下回重犯）：
 *   ① 机位必须每次**重新瞄准**：暗处那张先盖了天花板，玩家会被顶出实体块，镜头随之抬高，
 *      三只动物直接跑出画面（实测 v=-0.35），两张截图变成同一张；
 *   ② 截图分析**不能靠颜色分类**找动物：草地/泥土会被判成「猪」，读数完全失真。
 *      改为在页面里把每只动物投影成屏幕坐标，再按坐标采样。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'visual', 'animals-stage6');
const SAVES = path.join(APP, 'tests', '.animals-saves');
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
    width: 1280, height: 720, show: true, title: '家畜贴图取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => { try { if (win.isDestroyed()) return; win.showInactive(); win.moveTop(); } catch (e) { } }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  const meta = { seed: 'visual-audit-2026', scenes: [], tex: null, parts: null };

  const shot = async (name) => {
    await evl("const w=document.querySelector('#toast-wrap'); if(w) w.innerHTML=''; true");
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    const sz = img.getSize();
    console.log('[截图] artifacts/visual/animals-stage6/' + name + '.png ' + sz.width + 'x' + sz.height);
    return { width: sz.width, height: sz.height };
  };

  await win.loadURL(srv.url);
  for (let i = 0; i < 100; i++) {
    if (await evl('return !!(window.__game && window.__test);').catch(() => false)) break;
    await sleep(200);
  }
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '家畜取证';
    document.querySelector('#inp-seed').value = 'visual-audit-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 240; i++) {
    if (await evl('const G=window.__game; return G.state==="playing" && G.world && G.world.genQueue.length===0;').catch(() => false)) break;
    await sleep(250);
  }
  await sleep(600);

  /* ---- 贴图像素统计：直接读画布（与产品同一份画笔） ---- */
  meta.tex = await evl(`
    const out = {};
    const names = ['pig_body','pig_head','pig_leg','cow_body','cow_head','cow_leg','sheep_body','sheep_head','sheep_leg'];
    const mod = await import('/js/gfx/painters.js');
    const rng = await import('/js/core/rng.js');
    for (const n of names) {
      const canvas = document.createElement('canvas');
      canvas.width = 16; canvas.height = 16;
      const g = canvas.getContext('2d');
      mod.paintMobTex(n, g, rng.mulberry32(rng.hashStringToSeed(n)), 16);
      const d = g.getImageData(0, 0, 16, 16).data;
      const buckets = new Set();
      let rSum = 0, gSum = 0, bSum = 0, mag = 0, lumMin = 9, lumMax = -9;
      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        if (d[i + 3] < 40) continue;
        buckets.add((R >> 3) + ',' + (G >> 3) + ',' + (B >> 3));
        rSum += R; gSum += G; bSum += B;
        if (R === 255 && B === 255 && G === 0) mag++;
        const L = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
        lumMin = Math.min(lumMin, L); lumMax = Math.max(lumMax, L);
      }
      let lo = 9, hi = -9;
      for (let y = 7; y < 12; y++) for (let x = 4; x < 12; x++) {
        const i = (y * 16 + x) * 4;
        const L = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        lo = Math.min(lo, L); hi = Math.max(hi, L);
      }
      out[n] = {
        buckets: buckets.size, magenta: mag,
        meanRGB: [+(rSum / 256).toFixed(1), +(gSum / 256).toFixed(1), +(bSum / 256).toFixed(1)],
        lumSpan: +(lumMax - lumMin).toFixed(3), faceContrast: +(hi - lo).toFixed(3)
      };
    }
    return out;
  `);
  console.log('贴图 =', JSON.stringify(meta.tex, null, 0));

  meta.parts = await evl(`
    const T = window.__test; const out = {};
    for (const t of ['pig','cow','sheep']) {
      const sk = T.mobSkinInfo(t);
      out[t] = (sk.parts || []).map(p => ({ part: p.part, tex: p.tex, hasMap: p.hasMap, size: p.texSize }));
    }
    return out;
  `);
  console.log('部件 =', JSON.stringify(meta.parts, null, 0));

  /* ---- 场景：摆一排 + 每次重新瞄准 ---- */
  const scene = async (label, opts) => {
    const info = await evl(`
      const G = window.__game, T = window.__test;
      const THREE = await import('/vendor/three.module.js');
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      G.controller.setCreative(true);
      G.mobs.clear();
      G.mobs.maxMobs = 0;
      const bx = Math.floor(G.controller.pos.x) + 8, bz = Math.floor(G.controller.pos.z) + 4;
      const gy = G.world.topSolidY(bx, bz) + 1;
      /* 台面 11×7，上面清空 4 格 */
      for (let dx = -5; dx <= 5; dx++) for (let dz = -3; dz <= 3; dz++) {
        T.setBlock(bx + dx, gy - 1, bz + dz, 3);
        for (let dy = 0; dy < 4; dy++) T.setBlock(bx + dx, gy + dy, bz + dz, 0);
      }
      ${opts.ceil ? `
      /* 盖顶：只留一层天光，模拟「暗处」；盖完再重新瞄准，玩家会被顶出实体块 */
      for (let dx = -6; dx <= 6; dx++) for (let dz = -4; dz <= 4; dz++) {
        for (let dy = 4; dy <= 6; dy++) T.setBlock(bx + dx, gy + dy, bz + dz, 1);
      }` : ''}
      await T.waitChunks(1, { light: true });
      const spawned = [];
      ['pig','cow','sheep'].forEach((t, i) => {
        const m = G.mobs.spawn(t, bx + i * 2.6 - 2.6 + 0.5, gy, bz + 0.5);
        if (m) { m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = 0; m.yaw = Math.PI; spawned.push(t); }
      });
      ${opts.torch ? `
      /* 火把插在动物前面一格、与眼同高：照的是它们的正面 */
      T.setBlock(bx, gy + 1, bz - 2, T.blockIds.TORCH);` : ''}
      await sleep(200);
      /* 机位：固定距离 6.5 格、正对三只动物的中点，俯角 -0.08 */
      const cx = bx + 0.5, cz = bz + 0.5, cy = gy;
      const camZ = cz - 4.2;
      T.teleport(cx, cy + 0.9, camZ);
      await sleep(320);
      await T.waitChunks(1, { light: true });
      const dx = cx - G.controller.pos.x, dz = cz - G.controller.pos.z;
      G.controller.yaw = Math.atan2(-dx, -dz);
      await sleep(120);
      /* 迭代瞄准：一次算出来的俯角会被「落地/顶出」改动过的实际眼高带偏
         （实测第一版三只动物全挤在画面顶边 v=0.05）。这里按投影误差修正 3 轮，
         直到中点落在画面中央附近；仍然只动相机，不动产品。 */
      const camNow = G.camera;
      const vv = new THREE.Vector3();
      const projNow = (x, y, z) => {
        camNow.updateMatrixWorld(true);           // 相机矩阵必须同步到这一帧的朝向
        vv.set(x, y, z).project(camNow);
        return 1 - (vv.y * 0.5 + 0.5);
      };
      G.controller.pitch = Math.atan2((cy + 0.55) - G.controller.eyeY, Math.hypot(dx, dz));
      for (let it = 0; it < 4; it++) {
        await sleep(140);
        const err = projNow(cx, cy + 0.55, cz) - 0.5;
        if (Math.abs(err) < 0.03) break;
        G.controller.pitch -= err * 1.2;
      }
      await sleep(260);
      /* 投影：每只动物取身体中心与头顶 */
      const cam = G.camera; cam.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      const proj = (x, y, z) => { cam.updateMatrixWorld(true); v.set(x, y, z).project(cam); return { u: +((v.x * 0.5 + 0.5)).toFixed(4), v: +((1 - (v.y * 0.5 + 0.5))).toFixed(4) }; };
      const list = G.mobs.list.filter(m => ['pig','cow','sheep'].includes(m.type)).map(m => ({
        t: m.type,
        body: proj(m.pos.x, m.pos.y + (m.height || 0.6) * 0.55, m.pos.z),
        head: proj(m.pos.x, m.pos.y + (m.height || 0.6) * 0.92, m.pos.z),
        dist: +Math.hypot(m.pos.x - G.controller.pos.x, m.pos.z - G.controller.pos.z).toFixed(2),
        light: (() => { const l = T.blockAt(Math.floor(m.pos.x), Math.floor(m.eyeY), Math.floor(m.pos.z)); return { sky: l.sky, block: l.block }; })()
      }));
      /* 自检：动物是否真的在视锥里、可见、且 mesh 挂在场景上。
         第一版拍到的是天空 —— 三只动物的投影点全落在画面中央，但那里的像素是 (235,234,233)
         与 (52,72,30)，说明画面里没有它们。这类「列表里有、场景里没有」的失败必须当场可判定，
         否则像素统计会把天空当成动物。 */
      const diag = list.map(it => {
        const m = G.mobs.list.find(x => x.type === it.t);
        if (!m) return { t: it.t, found: false };
        cam.updateMatrixWorld(true);
        const ndc = v.set(m.pos.x, m.pos.y + 0.3, m.pos.z).project(cam).clone();
        return {
          t: it.t, found: true,
          visible: !!m.mesh && m.mesh.visible !== false,
          inScene: !!(m.mesh && m.mesh.parent),
          meshPos: m.mesh ? [+m.mesh.position.x.toFixed(2), +m.mesh.position.y.toFixed(2), +m.mesh.position.z.toFixed(2)] : null,
          pos: [+m.pos.x.toFixed(2), +m.pos.y.toFixed(2), +m.pos.z.toFixed(2)],
          ndc: [+ndc.x.toFixed(3), +ndc.y.toFixed(3), +ndc.z.toFixed(3)],
          inFrustum: Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z > -1 && ndc.z < 1
        };
      });
      return { spawned, list, diag, camY: +G.controller.pos.y.toFixed(2),
        camEye: +G.controller.eyeY.toFixed(2),
        camPos: [+G.controller.pos.x.toFixed(2), +G.controller.pos.z.toFixed(2)],
        yaw: +G.controller.yaw.toFixed(3), pitch: +G.controller.pitch.toFixed(3),
        view: { W: G.view.renderer.domElement.clientWidth, H: G.view.renderer.domElement.clientHeight } };
    `);
    const image = await shot('p-animals-' + label);
    meta.scenes.push({ name: 'p-animals-' + label, ...info, image });
    return info;
  };

  await evl("const T=window.__test; T.setTime(0.3); return true;");
  const day = await scene('day', {});
  console.log('day =', JSON.stringify(day.list));
  const dark = await scene('dark', { ceil: true });
  console.log('dark =', JSON.stringify(dark.list));
  const torch = await scene('torch', { ceil: true, torch: true });
  console.log('torch =', JSON.stringify(torch.list));

  /* ---- 羊头近景（PN.1 的重点） ---- */
  const close = await evl(`
    const G = window.__game, T = window.__test;
    const THREE = await import('/vendor/three.module.js');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    G.mobs.clear(); G.mobs.maxMobs = 0;
    const bx = Math.floor(G.controller.pos.x) + 6, bz = Math.floor(G.controller.pos.z);
    const gy = G.world.topSolidY(bx, bz) + 1;
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      T.setBlock(bx + dx, gy - 1, bz + dz, 3);
      for (let dy = 0; dy < 3; dy++) T.setBlock(bx + dx, gy + dy, bz + dz, 0);
    }
    await T.waitChunks(1, { light: true });
    const m = G.mobs.spawn('sheep', bx + 0.5, gy, bz + 0.5);
    if (m) { m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = 0; m.yaw = Math.PI; }
    await sleep(200);
    T.teleport(bx + 0.5, gy + 0.35, bz - 1.9);
    await sleep(300);
    const dx = bx + 0.5 - G.controller.pos.x, dz = bz + 0.5 - G.controller.pos.z;
    G.controller.yaw = Math.atan2(-dx, -dz);
    const camNow = G.camera;
    const vv = new THREE.Vector3();
    const projNow = (x, y, z) => {
      camNow.updateMatrixWorld(true);
      vv.set(x, y, z).project(camNow);
      return 1 - (vv.y * 0.5 + 0.5);
    };
    G.controller.pitch = 0;
    for (let it = 0; it < 4; it++) {
      await sleep(140);
      const err = projNow(bx + 0.5, gy + 0.62, bz + 0.5) - 0.5;
      if (Math.abs(err) < 0.03) break;
      G.controller.pitch -= err * 1.2;
    }
    await sleep(260);
    const cam = G.camera; cam.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    v.set(m ? m.pos.x : bx, gy + 0.72, m ? m.pos.z : bz).project(cam);
    return { head: { u: +((v.x * 0.5 + 0.5)).toFixed(4), v: +((1 - (v.y * 0.5 + 0.5))).toFixed(4) },
      pos: m ? { x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2) } : null };
  `);
  meta.scenes.push({ name: 'p-sheep-closeup', ...close, image: await shot('p-sheep-closeup') });
  console.log('closeup =', JSON.stringify(close));

  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log('→ ' + path.join(OUT, 'meta.json'));
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
