/*
 * 最小复现：阶段 3b 改过视线判定之后，Q.1「苦力怕贴近就充能并起爆」为什么不再起爆。
 *   cd app && npx electron tests/repro-q.mjs
 * 复刻验收剧本第 35 节的场地（13×13 平台 + 5×5×3 实心立方体 + 西侧 1×3 壁龛），
 * 然后把苦力怕生在立方体正中心、玩家钉在壁龛里，逐帧打印：
 *   在场 / hp / charging / fuse / onGround / 双方 Y / 距离 / 胸口那格是否实心 / lineOfSightToPlayer / 起爆数
 * 结果写 artifacts/repro-q.json。只读，不改任何产品行为。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const SAVES = path.join(APP, 'tests', '.repro-saves');
const OUT = path.join(APP, '..', 'artifacts', 'repro-q.json');
fs.rmSync(SAVES, { recursive: true, force: true });

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const PROBE = `(async () => {
  const G = window.__game, T = window.__test;
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  const nap = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { seed: G.meta && G.meta.seed, spawn: [G.spawn.x, G.spawn.y, G.spawn.z] };
  /* 对照实验：证明「Q.1 不充能」的真因是**区块没叫齐时 setBlock 被静默丢弃**（world.js:207）。
     先照 Z.9 那样存盘 → 回主菜单 → 读档，然后：
       旧顺序：不等区块，直接在出生点外 7 格搭 5×5×3；
       新顺序：先传过去 + waitChunks + 排空，再在出生点外 30 格搭同样的立方体。
     各读一次中心格：0 就是「根本没写进去」。 */
  await G.save('manual');
  G.toMenu(); await nap(400);
  await G.loadWorld(G.meta ? G.meta.name : '复现-Q2');
  for (let i = 0; i < 300; i++) { if (G.state === 'playing') break; await nap(100); }
  out.afterLoad = { state: G.state, pos: [+G.controller.pos.x.toFixed(1), +G.controller.pos.y.toFixed(1), +G.controller.pos.z.toFixed(1)] };
  const boxAt = (cx, cy, cz) => {
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (let dy = 0; dy < 3; dy++) T.setBlock(cx + dx, cy + dy, cz + dz, 1);
  };
  const py = Math.floor(G.controller.pos.y), pz = Math.floor(G.controller.pos.z), pxx = Math.floor(G.controller.pos.x);
  // 旧顺序：读档后立刻在出生点外 7 格搭
  boxAt(pxx + 9, py, pz);
  out.oldOrder = { at: [pxx + 9, py, pz], center: G.world.getBlock(pxx + 9, py, pz) };
  // 新顺序：先传过去等区块与队列，再在更外面搭
  const nx = pxx + 34;
  T.teleport(nx + 0.5, py, pz + 0.5);
  await T.waitChunks(1, { light: true });
  let w = 0;
  while (w < 20000) { const p = T.worldPending(); if (p && p.gen === 0 && p.light === 0 && p.mesh === 0) break; await nap(40); w += 40; }
  boxAt(nx + 2, Math.floor(G.controller.pos.y), pz);
  out.newOrder = { at: [nx + 2, Math.floor(G.controller.pos.y), pz], center: G.world.getBlock(nx + 2, Math.floor(G.controller.pos.y), pz), waitMs: w };

  const qbY = Math.floor(G.controller.pos.y);
  const qbX = Math.floor(G.controller.pos.x) + 7, qbZ = Math.floor(G.controller.pos.z);
  out.at = { qbX, qbY, qbZ };
  let wq = 0;
  while (wq < 20000) { const p = T.worldPending(); if (p && p.gen === 0 && p.light === 0 && p.mesh === 0) break; await nap(40); wq += 40; }
  out.preArenaDrainMs = wq;
  for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
    T.setBlock(qbX + dx, qbY - 1, qbZ + dz, 1);
    for (let h = 0; h <= 7; h++) T.setBlock(qbX + dx, qbY + h, qbZ + dz, 0);
  }
  const qcX = qbX + 2, qcZ = qbZ;
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (let dy = 0; dy < 3; dy++) {
    T.setBlock(qcX + dx, qbY + dy, qcZ + dz, 1);
  }
  const drained = async () => { let w = 0; while (w < 15000) { const p = T.worldPending(); if (p && p.gen === 0 && p.light === 0 && p.mesh === 0) return w; await nap(40); w += 40; } return -1; };
  out.drain1 = await drained();
  const cell = (x, y, z) => G.world.getBlock(x, y, z);
  out.beforeCarve = { center: cell(qcX, qbY, qcZ), above: cell(qcX, qbY + 1, qcZ), west: cell(qcX - 2, qbY, qcZ),
    shell0: (() => { let n = 0; for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) for (let dy = -5; dy <= 5; dy++) {
      const d = Math.hypot(dx, dy, dz); if (d <= 5 && G.world.isSolidAt(qcX + dx, qbY + dy, qcZ + dz)) n++; } return n; })() };
  for (let dy = 0; dy <= 2; dy++) T.setBlock(qcX - 2, qbY + dy, qcZ, 0);
  out.drain2 = await drained();
  out.afterCarve = { center: cell(qcX, qbY, qcZ), above: cell(qcX, qbY + 1, qcZ), west: cell(qcX - 2, qbY, qcZ),
    westTop: cell(qcX - 2, qbY + 2, qcZ) };

  G.mobs.maxMobs = 0; G.mobs.clear();
  G.controller.setCreative(false);
  G.controller.health = 20; G.controller.invulnerable = 0;
  const boom0 = T.blastInfo().explosions;
  const c = G.mobs.spawn('creeper', qcX + 0.5, qbY + 0.0, qcZ + 0.5);
  const standX = qcX - 1.5;
  G.controller.setPositions(standX, qbY, qcZ + 0.5);
  out.spawned = !!c;
  out.defH = c ? c.height : null;
  const pin = () => {
    if (c && G.mobs.list.includes(c)) {
      c.pos.x = qcX + 0.5; c.pos.y = qbY; c.pos.z = qcZ + 0.5;
      c.vel.x = 0; c.vel.y = 0; c.vel.z = 0;
    }
    G.controller.setPositions(standX, qbY, qcZ + 0.5);
  };
  out.trace = [];
  const t0 = performance.now();
  let ticks = 0;
  while (performance.now() - t0 < 4000) {
    pin(); ticks++;
    if (ticks % 10 === 0) out.trace.push({
      ms: Math.round(performance.now() - t0), inList: G.mobs.list.includes(c),
      hp: c ? +c.hp.toFixed(2) : null, charging: c ? c.charging : null, fuse: c ? +c.fuse.toFixed(2) : null,
      onGround: c ? c.onGround : null, mobY: c ? +c.pos.y.toFixed(2) : null, py: +G.controller.pos.y.toFixed(2),
      dist: c ? +Math.hypot(c.pos.x - G.controller.pos.x, c.pos.y - G.controller.pos.y, c.pos.z - G.controller.pos.z).toFixed(2) : null,
      chestSolid: c ? G.world.isSolidAt(Math.floor(c.pos.x), Math.floor(c.pos.y + (c.height || 1.8) * 0.7), Math.floor(c.pos.z)) : null,
      los: c ? G.mobs.lineOfSightToPlayer(c, G.controller) : null,
      creative: G.controller.creative, state: G.state, boom: T.blastInfo().explosions - boom0
    });
    await frame();
  }
  out.ticks = ticks;
  // 再来一轮：不钉住，看它自己会走到哪
  G.mobs.clear();
  G.controller.health = 20; G.controller.invulnerable = 0;
  const boom1 = T.blastInfo().explosions;
  const c2 = G.mobs.spawn('creeper', qcX + 0.5, qbY + 0.0, qcZ + 0.5);
  G.controller.setPositions(standX, qbY, qcZ + 0.5);
  out.freeTrace = [];
  const t1 = performance.now();
  let k2 = 0;
  while (performance.now() - t1 < 4000) {
    k2++;
    if (k2 % 20 === 0) out.freeTrace.push({ ms: Math.round(performance.now() - t1),
      pos: [+c2.pos.x.toFixed(2), +c2.pos.y.toFixed(2), +c2.pos.z.toFixed(2)],
      ppos: [+G.controller.pos.x.toFixed(2), +G.controller.pos.y.toFixed(2), +G.controller.pos.z.toFixed(2)],
      charging: c2.charging, fuse: +c2.fuse.toFixed(2), boom: T.blastInfo().explosions - boom1, hp: +G.controller.hp === 0 ? 0 : +G.controller.health.toFixed(1) });
    await frame();
  }
  G.mobs.clear();
  return out;
})()`;

async function main() {
  await app.whenReady();
  app.setName('方块世界-Q复现');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · Q 复现',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const topTimer = setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.showInactive(); win.moveTop();
    } catch (e) { /* ignore */ }
  }, 500);
  const consoleErrs = [];
  win.webContents.on('console-message', (e, level, message, line, src) => {
    if (level >= 2) consoleErrs.push('[' + (src || '').split('/').pop() + ':' + line + '] ' + message);
  });

  await win.loadURL(srv.url);
  let ready = false;
  for (let i = 0; i < 300; i++) {
    ready = await win.webContents.executeJavaScript('!!(window.__game && window.__test)').catch(() => false);
    if (ready) break;
    await sleep(100);
  }
  if (!ready) { log('前端未就绪'); await srv.close(); app.exit(1); return; }

  await win.webContents.executeJavaScript(
    `(async () => { await window.__game.newWorld('复现-Q2', 'r4-route-2026', 'survival'); return window.__game.state; })()`);
  for (let i = 0; i < 300; i++) {
    const st = await win.webContents.executeJavaScript('window.__game.state').catch(() => null);
    if (st === 'playing') break;
    await sleep(100);
  }
  log('世界就绪，开始取证…');
  const out = await win.webContents.executeJavaScript(PROBE).catch(e => ({ error: String(e && e.stack || e) }));
  out.consoleErrs = consoleErrs.slice(0, 12);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  log('写出 ' + OUT);
  log('对照：旧顺序（不等区块）中心格=' + JSON.stringify(out.oldOrder) + ' 新顺序（先等）中心格=' + JSON.stringify(out.newOrder));
  log('坐标 ' + JSON.stringify(out.at) + ' 挖壁龛前 ' + JSON.stringify(out.beforeCarve) + ' 后 ' + JSON.stringify(out.afterCarve));
  log('钉住轮（前 6 条）:');
  for (const t of (out.trace || []).slice(0, 6)) log('  ' + JSON.stringify(t));
  log('自由轮（前 6 条）:');
  for (const t of (out.freeTrace || []).slice(0, 6)) log('  ' + JSON.stringify(t));
  clearInterval(topTimer);
  try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ }
  await srv.close();
  app.exit(0);
}

main().catch(e => { log('harness 异常: ' + ((e && e.stack) || e)); app.exit(1); });
