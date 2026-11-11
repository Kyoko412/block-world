/*
 * 最小复现：Q1.3「真实左键挖到原木」为什么偶发拿不到原木。
 *   cd app && npx electron tests/repro-q1.mjs
 * 与 e2e-electron.mjs 同一套窗口/防降频设置，但只跑 Q1.3 这一段，并把任务书要求的现场量全部打出来：
 * 鼠标锁定状态、按下/松开时刻、准星命中的格子、挖掘进度曲线与总时长、掉落物位置、背包数量。
 * 隔离存档目录 tests/.repro-saves，不碰验收用的 .e2e-saves。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const SAVES = path.join(APP, 'tests', '.repro-saves');
const OUT = path.join(APP, '..', 'artifacts', 'repro-q1.json');
fs.rmSync(SAVES, { recursive: true, force: true });

const REPEAT = Number(process.argv[2] || 3);        // 同一个会话里连做几次（偶发要看重复率）
const SEED = process.argv[3] || 'r4-route-2026';    // 与验收 Q1 所在世界同一颗子

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

async function main() {
  await app.whenReady();
  app.setName('方块世界-Q1复现');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · Q1 复现',
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
  const ready = await (async () => {
    for (let i = 0; i < 300; i++) {
      const v = await win.webContents.executeJavaScript('!!(window.__game && window.__test)').catch(() => false);
      if (v) return true;
      await sleep(100);
    }
    return false;
  })();
  if (!ready) { log('前端未就绪'); await srv.close(); app.exit(1); return; }

  /* 走正常入口新建生存世界（与验收 Q1 所在世界同一颗子） */
  await win.webContents.executeJavaScript(`(async () => {
    await window.__game.newWorld('复现-Q1', ${JSON.stringify(SEED)}, 'survival');
    return window.__game.state;
  })()`);
  for (let i = 0; i < 200; i++) {
    const st = await win.webContents.executeJavaScript('window.__game.state');
    if (st === 'playing') break;
    await sleep(100);
  }

  const probe = `
    (async () => {
      const G = window.__game, T = window.__test;
      const frame = () => new Promise(r => requestAnimationFrame(() => r()));
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const qfx = Math.floor(G.controller.pos.x), qfz = Math.floor(G.controller.pos.z);
      const qgy = Math.floor(G.controller.pos.y) - 1;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) T.setBlock(qfx + dx, qgy, qfz + dz, 4);
      G.controller.spawnAt(qfx + 0.5, qgy + 1.05, qfz + 0.5);
      for (let i = 0; i < 80 && !G.controller.onGround; i++) await frame();
      const qtx = qfx + 2, qty = qgy + 1, qtz = qfz;
      T.setBlock(qtx, qty, qtz, 10);
      await sleep(60);
      const qAim = (tx, ty, tz) => {
        const ex = G.controller.pos.x, ey = G.controller.eyeY, ez = G.controller.pos.z;
        const dx = tx + 0.5 - ex, dy = ty + 0.5 - ey, dz = tz + 0.5 - ez;
        G.controller.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
        G.controller.yaw = Math.atan2(-dx, -dz);
      };
      qAim(qtx, qty, qtz);
      G.interaction.updateTarget();
      G.input.setUIMode(false);
      G.input.locked = true;
      /* 现场计数：失焦会走 input.js 的 _clearAll()（产品行为，真玩家切窗口就该松手）。
         这一节要分清「挖掘本身不对」还是「按住被系统打断」，所以把 blur/focus/mouseup 都数出来。 */
      const t0Wall = performance.now();
      const evCount = { blur: 0, focus: 0, mouseup: 0, pointerlockLost: 0 };
      const evAt = { blur: null, focus: null, mouseup: null };
      const onB = () => { evCount.blur++; if (evAt.blur === null) evAt.blur = Math.round(performance.now() - t0Wall); };
      const onF = () => { evCount.focus++; if (evAt.focus === null) evAt.focus = Math.round(performance.now() - t0Wall); };
      const onU = () => { evCount.mouseup++; if (evAt.mouseup === null) evAt.mouseup = Math.round(performance.now() - t0Wall); };
      const onP = () => { if (!document.pointerLockElement) evCount.pointerlockLost++; };
      window.addEventListener('blur', onB);
      window.addEventListener('focus', onF);
      window.addEventListener('mouseup', onU);
      document.addEventListener('pointerlockchange', onP);
      const log0 = G.inventory.countOf('oak_log');
      const blockNow = () => {
        const t = G.interaction.target;
        return t ? [t.x, t.y, t.z, G.world.getBlock(t.x, t.y, t.z)] : null;
      };
      const trace = [];
      const t0 = t0Wall;
      const canvas = document.querySelector('#game-canvas');
      canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      const downAt = Math.round(performance.now() - t0);
      let upAt = null, gotAt = null;
      for (let i = 0; i < 240; i++) {                 // 最多 12 秒（240 × 50ms）
        const m = T.miningInfo();
        trace.push({
          ms: Math.round(performance.now() - t0),
          prog: +m.progress.toFixed(3),
          hit: m.hit ? [m.hit.x, m.hit.y, m.hit.z] : null,
          target: blockNow(),
          crack: !!m.crackVisible,
          log: G.inventory.countOf('oak_log'),
          drops: G.interaction.drops.list.filter(d => d.item === 'oak_log')
            .map(d => [ +d.x.toFixed(2), +d.y.toFixed(2), +d.z.toFixed(2), d.count ]),
          locked: !!G.input.locked, ml: !!G.input.state.mouseLeft, blur: evCount.blur, mp: evCount.pointerlockLost, state: G.state, fps: G.fps,
          pos: [+G.controller.pos.x.toFixed(2), +G.controller.pos.y.toFixed(2), +G.controller.pos.z.toFixed(2)]
        });
        if (gotAt === null && G.inventory.countOf('oak_log') > log0) gotAt = Math.round(performance.now() - t0);
        if (gotAt !== null) break;
        await sleep(50);
      }
      if (upAt === null) {
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
        upAt = Math.round(performance.now() - t0);
      }
      await frame();
      return {
        seed: G.world.seed, spawn: [qfx, qgy, qfz], logBlock: [qtx, qty, qtz],
        log0, events: Object.assign({}, evCount), eventAt: Object.assign({}, evAt), logNow: G.inventory.countOf('oak_log'), gotAt, downAt, upAt,
        totalMs: Math.round(performance.now() - t0),
        quest: T.questsInfo().current, traceHead: trace.slice(0, 6), traceTail: trace.slice(-4),
        traceLen: trace.length,
        maxProg: Math.max(...trace.map(t => t.prog)),
        targetNeverLog: trace.filter(t => t.target && t.target[3] !== 10).length,
        fpsMin: Math.min(...trace.map(t => t.fps || 0)),
        stateNeverPlaying: trace.filter(t => t.state !== 'playing').length,
        lockedNever: trace.filter(t => !t.locked).length
      };
    })()
  `;

  const runs = [];
  for (let k = 0; k < REPEAT; k++) {
    const r = await win.webContents.executeJavaScript(probe).catch(e => ({ error: String(e && e.stack || e) }));
    runs.push(r);
    log('--- 第 ' + (k + 1) + ' 次：' + JSON.stringify({
      gotAt: r.gotAt, logNow: r.logNow, maxProg: r.maxProg, targetNeverLog: r.targetNeverLog,
      lockedNever: r.lockedNever, stateNeverPlaying: r.stateNeverPlaying, fpsMin: r.fpsMin,
      traceLen: r.traceLen, error: r.error
    }));
    await sleep(300);
  }
  fs.writeFileSync(OUT, JSON.stringify({ seed: SEED, runs, consoleErrs: consoleErrs.slice(0, 20) }, null, 2));
  log('明细写入 artifacts/repro-q1.json');
  clearInterval(topTimer);
  try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ }
  await srv.close();
  app.exit(runs.some(r => r.gotAt === null || r.gotAt === undefined) ? 1 : 0);
}

main().catch(async (e) => { log('harness 异常: ' + ((e && e.stack) || e)); app.exit(2); });
