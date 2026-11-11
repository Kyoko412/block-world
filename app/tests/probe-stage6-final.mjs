/*
 * 阶段 6 封版体验取证（临时探针，不随包、不提交）：
 *   env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/electron/dist/electron.exe tests/probe-stage6-final.mjs
 *
 * 补齐上一轮证据的三个缺口：
 *   ① animals-stage6/p-animals-day.png 实际拍到的是树叶近景，没拍到动物 —— 这里把台面
 *      周围与上方彻底清空，重新拍猪/牛/羊 + 骷髅/苦力怕/鹦鹉同框，以及剪毛羊对照；
 *   ② 水面只拍了四个机位，缺跨区块边界与水下看鱼；
 *   ③ 同种子 / 同天气 / 同时刻，机位写进 meta.json，前后可复现。
 * 输出 artifacts/visual/animals-final/ 与 artifacts/visual/water-final/。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const OUT_A = path.join(ART, 'animals-final');
const OUT_W = path.join(ART, 'water-final');
const SAVES = path.join(APP, 'tests', '.stage6-final-saves');
for (const d of [OUT_A, OUT_W]) fs.mkdirSync(d, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const meta = { seed: 'visual-audit-2026', time: 0.3, weather: 'clear', window: { width: 1280, height: 720 }, animals: [], water: null };

async function run() {
  await app.whenReady();
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '阶段6 体验取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => { try { if (!win.isDestroyed()) { win.showInactive(); win.moveTop(); } } catch (e) { } }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  const shot = async (dir, name) => {
    await evl("const w=document.querySelector('#toast-wrap'); if(w) w.innerHTML=''; return true");
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
    const sz = img.getSize();
    console.log('[图] ' + name + '.png ' + sz.width + 'x' + sz.height);
    return { width: sz.width, height: sz.height };
  };
  const cam = () => evl(`const G=window.__game; return { x:+G.controller.pos.x.toFixed(2), y:+G.controller.pos.y.toFixed(2), z:+G.controller.pos.z.toFixed(2), yaw:+G.controller.yaw.toFixed(3), pitch:+G.controller.pitch.toFixed(3) };`);

  await win.loadURL(srv.url);
  for (let i = 0; i < 100; i++) {
    if (await evl('return !!(window.__game && window.__test);').catch(() => false)) break;
    await sleep(200);
  }
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '阶段6取证';
    document.querySelector('#inp-seed').value = 'visual-audit-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 240; i++) {
    if (await evl('const G=window.__game; return G.state==="playing" && G.world && G.world.genQueue.length===0 && G.world.dirtyMesh.size===0;').catch(() => false)) break;
    await sleep(250);
  }
  await sleep(600);

  /* ================= 动物：干净台面 + 固定机位 ================= */
  const platform = await evl(`
    const G = window.__game, T = window.__test;
    G.controller.setCreative(true);
    G.mobs.clear(); G.mobs.maxMobs = 0;
    const bx = Math.floor(G.controller.pos.x), bz = Math.floor(G.controller.pos.z);
    const gy = G.world.topSolidY(bx, bz) + 1;
    /* 半径 9、上方 6 格清空：上一轮就是被没清掉的树冠挡住了镜头。
       范围够覆盖两排动物 + 机位，又不至于上万次 setBlock 拖垮取证。 */
    for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) {
      T.setBlock(bx + dx, gy - 1, bz + dz, 3);
      for (let dy = 0; dy < 6; dy++) T.setBlock(bx + dx, gy + dy, bz + dz, 0);
    }
    await T.waitChunks(2, { light: true });
    return { bx, bz, gy };
  `);
  const P = platform;

  const spawnAll = await evl(`
    const G = window.__game, T = window.__test;
    const P = ${JSON.stringify(P)};
    G.mobs.clear(); G.mobs.maxMobs = 0;
    const list = [
      ['pig', -4], ['cow', -2], ['sheep', 0], ['skeleton', 2.4], ['creeper', 4.6], ['parrot', 6.8]
    ];
    const out = [];
    for (const [t, dx] of list) {
      const m = G.mobs.spawn(t, P.bx + dx + 0.5, P.gy, P.bz + 0.5);
      if (!m) continue;
      m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = 0; m.yaw = Math.PI;
      out.push({ t, x: P.bx + dx + 0.5, y: P.gy, z: P.bz + 0.5 });
    }
    /* 剪毛羊单放一排前面，与未剪毛的羊同框对照：验证身体不是第二张脸 */
    const sh = G.mobs.spawn('sheep', P.bx + 0.5, P.gy, P.bz - 3.5);
    if (sh) { sh.setSheared(true, G.mobs.scene); sh.walking = false; sh.wanderT = 9999; sh.vel.x = sh.vel.z = 0; sh.yaw = Math.PI; }
    await new Promise(r => setTimeout(r, 350));
    return { list: out, shorn: !!sh, skin: T.mobSkinInfo('sheep', true).parts.filter(p=>p.part==='body').map(p=>p.tex) };
  `);
  meta.animalSpawn = spawnAll;

  const aimAt = async (targetZ, eyeY, pitch) => evl(`
    const G = window.__game, T = window.__test;
    const P = ${JSON.stringify(P)};
    T.teleport(P.bx + 0.5, ${eyeY}, P.bz - 6.2);
    G.controller.yaw = Math.PI;
    G.controller.pitch = ${pitch};
    await T.waitChunks(1, { light: true });
    await new Promise(r => setTimeout(r, 500));
    return true;
  `);

  await aimAt(P.bz + 0.5, P.gy + 1.2, -0.06);
  meta.animals.push({ name: 'a-day', camera: await cam(), image: await shot(OUT_A, 'a-day') });

  /* 火把旁：在动物前排插一排火把，看近景与暖光下的贴图协调性 */
  await evl(`const G=window.__game,T=window.__test,P=${JSON.stringify(P)};
    for (const dx of [-6,-3,0,3,6]) T.setBlock(P.bx+dx, P.gy+1, P.bz-1.5, T.blockIds.TORCH);
    await T.waitChunks(1,{light:true}); await new Promise(r=>setTimeout(r,500)); return true;`);
  meta.animals.push({ name: 'a-torch', camera: await cam(), image: await shot(OUT_A, 'a-torch') });

  /* 暗处：用真实夜晚时间压暗天光，不盖实体顶 —— 盖顶会把玩家/怪物挤到镜头前（第一版 a-dark 整张被苦力怕糊住） */
  await evl(`const G=window.__game,T=window.__test,P=${JSON.stringify(P)};
    G.time = 0.82;
    T.teleport(P.bx + 0.5, P.gy + 1.2, P.bz - 6.2);
    G.controller.yaw = Math.PI; G.controller.pitch = -0.06;
    await T.waitChunks(1,{light:true}); await new Promise(r=>setTimeout(r,900)); return true;`);
  meta.animals.push({ name: 'a-dark', camera: await cam(), image: await shot(OUT_A, 'a-dark') });

  /* 羊的特写：把「未剪毛」与「剪过毛」并排摆在同一深度，机位与它们齐平，
     避免第一版被清空区外的土坡挡住、也避免两只前后重叠。 */
  await evl(`const G=window.__game,T=window.__test,P=${JSON.stringify(P)};
    G.time = 0.3;
    G.mobs.clear(); G.mobs.maxMobs = 0;
    const wool = G.mobs.spawn('sheep', P.bx - 1.7, P.gy, P.bz + 0.5);
    const shorn = G.mobs.spawn('sheep', P.bx + 1.7, P.gy, P.bz + 0.5);
    if (wool) { wool.walking=false; wool.wanderT=9999; wool.vel.x=wool.vel.z=0; wool.yaw=Math.PI; }
    if (shorn) { shorn.setSheared(true, G.mobs.scene); shorn.walking=false; shorn.wanderT=9999; shorn.vel.x=shorn.vel.z=0; shorn.yaw=Math.PI; }
    /* 与 a-day 完全相同的机位（那一张确认能拍到动物），只把动物换成两只羊 */
    T.teleport(P.bx + 0.5, P.gy + 1.2, P.bz - 6.2);
    G.controller.yaw = Math.PI; G.controller.pitch = -0.06;
    await T.waitChunks(1,{light:true}); await new Promise(r=>setTimeout(r,700)); return true;`);
  meta.animals.push({ name: 'a-sheep-compare', camera: await cam(), image: await shot(OUT_A, 'a-sheep-compare') });

  /* ================= 水面：跨区块边界 / 水下看鱼 / 上岸过渡 ================= */
  const spot = await evl(`
    const G = window.__game, T = window.__test;
    const sea = G.world.seaLevel;
    const cx0 = Math.floor(G.controller.pos.x), cz0 = Math.floor(G.controller.pos.z);
    let best = null;
    for (let r = 8; r <= 80 && !best; r += 4) {
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
  if (!spot) { console.error('找不到水域'); fs.writeFileSync(path.join(OUT_W, 'meta.json'), JSON.stringify({ error: 'no water' })); await srv.close(); app.exit(1); return; }
  meta.water = spot;
  const S = spot;

  /* 机位 A：跨区块边界斜看（找水域内 x 或 z 为 16 倍数的列） */
  const edge = await evl(`
    const G = window.__game, T = window.__test, s = ${JSON.stringify(S)};
    let ex = null, ez = null, axis = null;
    for (let dx = -8; dx <= 8 && !ex; dx++) {
      const x = s.x + dx;
      if (((x % 16) + 16) % 16 !== 0) continue;
      if (G.world.getBlock(x, s.sea - 1, s.z) === T.blockIds.WATER) { ex = x; axis = 'x'; }
    }
    if (!ex) for (let dz = -8; dz <= 8 && !ez; dz++) {
      const z = s.z + dz;
      if (((z % 16) + 16) % 16 !== 0) continue;
      if (G.world.getBlock(s.x, s.sea - 1, z) === T.blockIds.WATER) { ez = z; axis = 'z'; }
    }
    const px = axis === 'x' ? ex : s.x, pz = axis === 'z' ? ez : s.z;
    T.teleport(px + 0.5, s.sea + 2.2, pz + 6.5);
    G.controller.yaw = 0; G.controller.pitch = -0.34;
    await T.waitChunks(2, { light: true }); await new Promise(r => setTimeout(r, 600));
    return { axis, x: px, z: pz, boundary: axis === 'x' ? px : pz };
  `);
  meta.waterEdge = edge;
  meta.waterScenes = [];
  meta.waterScenes.push({ name: 'w-chunk-edge', info: edge, camera: await cam(), image: await shot(OUT_W, 'w-chunk-edge') });

  /* 机位 B：水下平视看鱼（真实生成鱼群，不手动摆模型） */
  const fish = await evl(`
    const G = window.__game, T = window.__test, s = ${JSON.stringify(S)};
    G.mobs.clear(); G.mobs.maxMobs = 0;
    const made = [];
    for (let i = 0; i < 5; i++) {
      const m = G.mobs.spawn('cod', s.x + 0.5 + (i-2)*1.1, s.sea - 2.2, s.z + 3.2 + (i%2)*0.8);
      if (m) { m.yaw = Math.PI; made.push({ x: m.pos.x, y: m.pos.y, z: m.pos.z }); }
    }
    T.teleport(s.x + 0.5, s.sea - 2.6, s.z + 0.5);
    G.controller.yaw = Math.PI; G.controller.pitch = 0.02;
    await T.waitChunks(1, { light: true }); await new Promise(r => setTimeout(r, 700));
    return { count: made.length, inWater: !!G.controller.inWater, underwater: !!G.sfx._underwater, sample: made.slice(0,2) };
  `);
  meta.waterScenes.push({ name: 'w-under-fish', info: fish, camera: await cam(), image: await shot(OUT_W, 'w-under-fish') });

  /* 机位 C：上岸过渡 —— 固定在水面上方回看，确认眼睛已出水、没有残留的水下滤镜 */
  const above = await evl(`
    const G = window.__game, T = window.__test, s = ${JSON.stringify(S)};
    G.controller.setCreative(true);
    G.controller.flying = true;
    T.teleport(s.x + 0.5, s.sea + 2.2, s.z + 0.5);
    G.controller.yaw = Math.PI; G.controller.pitch = -0.42;
    await T.waitChunks(1, { light: true }); await new Promise(r => setTimeout(r, 800));
    return { y: +G.controller.pos.y.toFixed(2), inWater: !!G.controller.inWater, underwater: !!G.sfx._underwater, flying: !!G.controller.flying };
  `);
  meta.waterScenes.push({ name: 'w-shore-up', info: above, camera: await cam(), image: await shot(OUT_W, 'w-shore-up') });

  fs.writeFileSync(path.join(OUT_A, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(OUT_W, 'meta.json'), JSON.stringify(meta, null, 2));
  console.log('→ meta.json 已写出（animals-final / water-final）');
  await srv.close();
  app.exit(0);
}
run().catch(async (e) => { console.error(e); app.exit(1); });
