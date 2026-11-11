/*
 * 最小复现：阶段 3b 遭遇段（SK.5 八格外骷髅不拉弓 / SK.6 观察窗第一帧就读到已在拉弓）。
 *   cd app && npx electron tests/repro-3b.mjs
 * 只做三件事，全部走真实主循环：
 *   A. 按验收剧本同一手法搭 29×29 平台，然后沿 z 逐格打印地形高度与「视线是否通透」；
 *   B. 骷髅放 8 格外，采样 4 秒：drawing / los / dist / hp / fire / mobY；
 *   C. 先立墙再等站稳（新顺序），打印观察窗起点的 drawing，验证旧顺序为什么会误判。
 * 结果写 artifacts/repro-3b.json，不碰验收用的 .e2e-saves。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const SAVES = path.join(APP, 'tests', '.repro-saves');
const OUT = path.join(APP, '..', 'artifacts', 'repro-3b.json');
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
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = { seed: G.meta && G.meta.seed, spawn: [G.spawn.x, G.spawn.y, G.spawn.z] };
  const mbX = Math.floor(G.spawn.x) + 120, mbZ = Math.floor(G.spawn.z);
  /* 新顺序：先把区块叫出来，再动方块（world.js:207 对未生成区块的 setBlock 会静默 return false） */
  T.teleport(mbX + 0.5, G.spawn.y, mbZ + 0.5);
  await T.waitChunks(2, { light: true });
  const farOk = () => {
    const f = (dx, dz) => G.world.isSolidAt(mbX + dx, G.world.topSolidY(mbX + dx, mbZ + dz), mbZ + dz);
    return f(12, 12) && f(-12, -12) && f(12, -12) && f(-12, 12);
  };
  let waitMs = 0;
  while (!farOk() && waitMs < 20000) { await sleep(100); waitMs += 100; }
  out.chunksReady = farOk(); out.chunksWaitMs = waitMs;
  const mbY = G.world.topSolidY(mbX, mbZ);
  out.plat = { mbX, mbY, mbZ };
  for (let dz = -14; dz <= 14; dz++) for (let dx = -14; dx <= 14; dx++) {
    T.setBlock(mbX + dx, mbY, mbZ + dz, 1);
    for (let h = 1; h <= 7; h++) T.setBlock(mbX + dx, mbY + h, mbZ + dz, 0);
  }
  for (let dz = -14; dz <= 14; dz++) for (let dx = -1; dx <= 1; dx++)
    for (let h = 8; h <= 12; h++) T.setBlock(mbX + dx, mbY + h, mbZ + dz, 0);
  let drain = 0;
  while (drain < 20000) {
    const p = T.worldPending();
    if (p && p.gen === 0 && p.light === 0 && p.mesh === 0) break;
    await sleep(40); drain += 40;
  }
  out.drainMs = drain;
  out.cells = { platFar: G.world.getBlock(mbX + 13, mbY, mbZ + 13), aboveFar: G.world.getBlock(mbX + 13, mbY + 5, mbZ + 13),
    corridorHigh: G.world.getBlock(mbX, mbY + 10, mbZ + 12) };
  // A. 这条 z 线上每一格的实际顶高（topSolidY）—— 用来判断 8 格外的视线会不会被残留地形挡住
  out.lane = [];
  for (let dz = -14; dz <= 14; dz += 2) {
    const col = [];
    for (let h = 1; h <= 12; h++) {
      const id = G.world.getBlock(mbX, mbY + h, mbZ + dz);
      if (id !== 0) col.push(h + ':' + id);
    }
    out.lane.push({ dz, top: G.world.topSolidY(mbX, mbZ + dz), solid: col });
  }
  const skInfo = () => T.mobCombatInfo().find(x => x.type === 'skeleton') || {};
  const probe = (m) => ({ los: G.mobs.lineOfSightToPlayer(m, G.controller),
    dist: +Math.hypot(m.pos.x - G.controller.pos.x, m.pos.z - G.controller.pos.z).toFixed(2),
    mobY: +m.pos.y.toFixed(2), hp: +m.hp.toFixed(1), fire: +m.fire.toFixed(2), state: G.state, ...skInfo() });

  // B. 场地按新顺序建好之后：8 格外的遭遇到底会不会起手
  G.mobs.maxMobs = 0; G.mobs.clear();
  G.controller.setCreative(true);
  T.setTime(0.75);
  let m = G.mobs.spawn('skeleton', mbX + 0.5, mbY + 1, mbZ + 11.5);
  T.teleport(mbX + 0.5, mbY + 1, mbZ + 3.5);
  for (let i = 0; i < 20; i++) await frame();
  out.at8 = [];
  const t0 = performance.now();
  for (let i = 0; i < 100 && performance.now() - t0 < 4000; i++) {
    await frame();
    if (i % 5 === 0) out.at8.push({ ms: Math.round(performance.now() - t0), ...probe(m) });
  }
  out.drewAt8 = out.at8.some(s => s.drawing) || skInfo().drawing === true;

  // C. 先立墙再等站稳（新顺序）：观察窗起点不许已经在拉弓，且 los 必须是 false
  const wall = (id) => { for (let dx = -14; dx <= 14; dx++) for (let dy = 0; dy <= 3; dy++) T.setBlock(mbX + dx, mbY + 1 + dy, mbZ + 7, id); };
  G.mobs.clear();
  m = G.mobs.spawn('skeleton', mbX + 0.5, mbY + 1, mbZ + 9.5);
  T.teleport(mbX + 0.5, mbY + 1, mbZ + 4.5);
  wall(1);
  for (let i = 0; i < 30; i++) await frame();
  out.withWall = [];
  const t2 = performance.now();
  for (let i = 0; i < 100 && performance.now() - t2 < 3000; i++) {
    m.pos.x = mbX + 0.5; m.pos.z = mbZ + 9.5; m.vel.x = 0; m.vel.z = 0;
    await frame();
    if (i % 10 === 0) out.withWall.push({ ms: Math.round(performance.now() - t2), wallSolid: G.world.getBlock(mbX, mbY + 2, mbZ + 7) === 1, ...probe(m) });
  }
  out.drewWithWall = out.withWall.some(s => s.drawing);
  wall(0);
  for (let i = 0; i < 30; i++) await frame();
  out.afterWallGone = [];
  const t3 = performance.now();
  for (let i = 0; i < 100 && performance.now() - t3 < 3000; i++) {
    m.pos.x = mbX + 0.5; m.pos.z = mbZ + 9.5; m.vel.x = 0; m.vel.z = 0;
    await frame();
    if (i % 10 === 0) out.afterWallGone.push({ ms: Math.round(performance.now() - t3), ...probe(m) });
  }
  out.drewAfterWallGone = out.afterWallGone.some(s => s.drawing) || skInfo().drawing === true;
  G.mobs.clear();
  return out;
})()`;

async function main() {
  await app.whenReady();
  app.setName('方块世界-3b复现');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 3b 复现',
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
    `(async () => { await window.__game.newWorld('复现-3b', 'r4-route-2026', 'survival'); return window.__game.state; })()`);
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
  log('lane 顶高: ' + (out.lane || []).map(l => l.dz + '→' + l.top + (l.solid.length ? ' 有实心[' + l.solid.join(',') + ']' : '')).join(' | '));
  log('区块叫齐=' + out.chunksReady + '（等 ' + out.chunksWaitMs + 'ms）排空 ' + out.drainMs + 'ms 格子=' + JSON.stringify(out.cells));
  log('8 格外起手过吗: ' + out.drewAt8);
  log('隔墙起手过吗: ' + out.drewWithWall + '  墙拆掉后起手过吗: ' + out.drewAfterWallGone);
  log('隔墙采样: ' + JSON.stringify((out.withWall || []).slice(0, 3)));
  clearInterval(topTimer);
  try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ }
  await srv.close();
  app.exit(0);
}

main().catch(e => { log('harness 异常: ' + ((e && e.stack) || e)); app.exit(1); });
