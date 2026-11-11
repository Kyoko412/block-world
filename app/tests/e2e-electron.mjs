/*
 * 自动化验收运行器（Electron + 真实渲染）：
 *   npx electron tests/e2e-electron.mjs
 * 输出中文报告、逐条断言结果，并把关键界面截图保存到 artifacts/。
 *
 * 注意：Electron 的 ESM 入口在「模块求值完成」之前不会派发 ready，
 * 因此这里不能用顶层 await，必须包进函数再调用。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';
import { createRouteDriver, scenarioBootstrap } from './lib/route-driver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const RUN = (process.env.BLOCKWORLD_E2E_RUN || '').trim();
if (RUN && !/^[a-zA-Z0-9_-]+$/.test(RUN)) throw new Error('Invalid isolated test run name');
const ART = path.join(APP, '..', 'artifacts', ...(RUN ? [RUN] : []));
/* 阶段 5：守卫用独立场景与独立运行入口。
   理由（任务书已定）：主线成品自检已逼近 600 秒看门狗，守卫战与存档状态组合塞进主线会把门限顶穿。
   两边共用同一个运行器能力（同一个 Electron 窗口、同一套注入/轮询/退出码），但有各自的剧本、
   报告文件、退出码与独立存档目录 —— 互不污染。 */
const GUARDIAN = process.argv.includes('--guardian');
/* 第二轮 E：自然生存路线（独立剧本/报告/存档目录，和主线、守卫分开跑） */
const NATURAL = process.argv.includes('--natural');
/* 短复现（E1—E4）：先验证采集—工作台—木镐—采石—石镐这条短链路 */
const SHORT = process.argv.includes('--route-short');
const TEST_SAVES = RUN ? path.join(ART, 'saves') : path.join(APP, 'tests', GUARDIAN ? '.guardian-saves' : (SHORT ? '.route-short-saves' : (NATURAL ? '.natural-saves' : '.e2e-saves')));
fs.mkdirSync(ART, { recursive: true });
if (path.dirname(TEST_SAVES) !== (RUN ? ART : path.join(APP, 'tests'))) throw new Error('Test saves escaped their intended parent');
fs.rmSync(TEST_SAVES, { recursive: true, force: true });

let scenario = fs.readFileSync(path.join(__dirname, GUARDIAN ? 'guardian-scenario.js' : (SHORT ? 'route-short.js' : (NATURAL ? 'survival-natural.js' : 'e2e-scenario.js'))), 'utf8');
/* 短链路与自然路线共用同一份 route-driver.js（走真实键鼠与物理，不改产品规则）。
   `BLOCKWORLD_ROUTE_RESUME=1` 时自然路线进入「第二次进程：主菜单读档核对」分支。 */
if (SHORT || NATURAL) scenario = 'window.__createRouteDriver = ' + createRouteDriver.toString() + ';\n' +
  'window.__routeSeed = ' + JSON.stringify(process.env.BLOCKWORLD_ROUTE_SEED || '') + ';\n' +
  'window.__routeResume = ' + JSON.stringify(process.env.BLOCKWORLD_ROUTE_RESUME === '1') + ';\n' + scenario;
const REPORT = path.join(ART, GUARDIAN ? 'guardian-report.json' : (SHORT ? 'route-short-report.json' : (NATURAL ? 'natural-route-report.json' : 'e2e-report.json')));
const LOGF = path.join(ART, GUARDIAN ? 'guardian-live.log' : (SHORT ? 'route-short-live.log' : (NATURAL ? 'natural-live.log' : 'e2e-live.log')));
fs.writeFileSync(LOGF, '');
const logs = [];
let win = null;

/* 验收环境修正（不改产品）：Windows 会把被遮挡窗口的渲染/定时器降频，
   实测会把 rAF 压到 1fps，让所有「等条件」假超时。这几个开关必须放在 app ready 之前。 */
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

function log(...a) {
  const line = a.join(' ') + '\n';
  try { fs.appendFileSync(LOGF, line); } catch (e) { /* ignore */ }
  process.stdout.write(line);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function poll(fn, timeoutMs, intervalMs = 100) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(intervalMs);
  }
}

async function shot(name) {
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ART, name + '.png'), img.toPNG());
    log('  [截图] artifacts/' + name + '.png');
  } catch (e) { log('  [截图失败] ' + name + ': ' + e.message); }
}

async function main() {
  await app.whenReady();
  app.setName('方块世界-自动化验收');
  log('Electron 就绪：' + process.versions.electron + ' / Node ' + process.versions.node);

  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: TEST_SAVES, port: 0 });
  log('验收服务：' + srv.url);

  win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 自动化验收',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  /* 窗口被其它窗口完全遮住 / 显示器休眠时，Windows 会把 rAF 降到 ~1fps，
     即使 backgroundThrottling:false 也会让 5 分钟预算被假超时打穿（实测 130/368）。
     验收期间把窗口置顶并阻止显示器休眠，这是测试环境修正，不改任何产品代码。 */
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show();
  win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  /* Windows 会把「被遮挡/最小化」的验收窗口当成后台，rAF 直接掉到 1~2fps
     （实测窗口在进游戏后会被系统最小化）。这里每 0.5 秒恢复并提到最上层，
     但不抢焦点（showInactive）；仅测试窗口，产品代码不受影响。 */
  const topTimer = setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.showInactive();
      win.moveTop();
    } catch (e) { /* ignore */ }
  }, 500);
  win.on('closed', () => {
    clearInterval(topTimer);
    try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ }
  });
  win.webContents.on('console-message', (e, level, message, line, src) => {
    const txt = '[' + (src ? src.split('/').pop() : 'page') + ':' + line + '] ' + message;
    logs.push(txt);
    if (level >= 2) log('  控制台(' + (level === 3 ? '错误' : '警告') + '): ' + txt);
  });
  win.webContents.on('page-error', (e) => log('  页面错误: ' + (e.error && e.error.message)));

  await win.loadURL(srv.url);
  const ready = await poll(() => win.webContents.executeJavaScript('!!(window.__game && window.__test)').catch(() => false), 30000);
  if (!ready) {
    log('前端未就绪，退出。');
    const boot = await win.webContents.executeJavaScript('document.getElementById("boot-error").textContent').catch(() => '');
    log('boot-error: ' + boot);
    await srv.close();
    app.exit(1);
    return;
  }
  log('前端已就绪（window.__game / window.__test 可用）');
  await shot('01-主菜单');

  /* 第五轮：进度监控与总超时**从注入前就开始**。
     旧写法注入后才起 t0，脚本一旦在第一步卡住（走路不走、瞄准打不到、挖掘进度不涨），
     运行器要到 600 秒才说话，中间没有任何「现在在第几步、在做什么、多久没进展」的输出。 */
  let report = null;
  const shotDone = {};
  let lastSteps = -1;
  const t0 = Date.now();
  const TOTAL_TIMEOUT = SHORT ? 240000 : (NATURAL ? 1500000 : 600000);
  const STALL_MS = SHORT ? 35000 : 120000;
  let lastProgressAt = Date.now();
  let lastSig = '';
  let lastActionLogAt = 0;
  log('注入验收剧本…（总超时 ' + Math.round(TOTAL_TIMEOUT / 1000) + 's，卡住判定 ' + Math.round(STALL_MS / 1000) + 's）');
  /* Do not return the scenario's async IIFE promise: executeJavaScript awaits
     returned promises. Return immediately so progress/stall polling runs while
     the scenario is still executing, rather than after it has finished. */
  await win.webContents.executeJavaScript(scenarioBootstrap(scenario));
  /* 整程看门狗 600 秒（2026-11-08 与打包自检 `main.js` 的 2400×250ms=600s 对齐，也是任务书批准的预算）。
     这里只是「运行器最多等多久」，不是任何断言的时间阈值：每条条件等待各自的 budgetMs 一字未改，
     真实整程耗时由剧本里的 PF.1 分段计时打印，超时会写出 artifacts/e2e-partial.json 并以退出码 2 结束。 */
  while (Date.now() - t0 < TOTAL_TIMEOUT) {
    const st = await win.webContents.executeJavaScript(
      'window.__e2e ? {done: window.__e2e.done, steps: window.__e2e.steps.length, ' +
      'last: window.__e2e.steps.length? window.__e2e.steps[window.__e2e.steps.length-1].name : "", ' +
      'shot: window.__e2e.shot, act: window.__e2e.act || null, progressAt: window.__e2e.progressAt || 0, ' +
      'err: (window.__e2e.errors||[]).slice(-1)[0] || null} : null'
    ).catch(() => null);
    if (!st) { await sleep(250); continue; }
    if (SHORT && st.err && !st.done) {
      log('短流程运行错误，停止当前动作：' + st.err);
      report = await win.webContents.executeJavaScript('JSON.stringify(window.__e2e)');
      break;
    }
    if (st.steps !== lastSteps) {
      lastSteps = st.steps;
      lastProgressAt = Date.now();
      log('  进度: ' + st.steps + ' 条断言 · 最近：' + st.last + ' · ' + Math.round((Date.now() - t0) / 1000) + 's');
    }
    /* 每 5 秒报一次「当前在做什么」（动作 + 细节 + 已持续多久） */
    if (st.act && st.act.name) {
      const sig = st.act.name + '|' + (st.act.n || 0);
      if (st.progressAt > lastProgressAt) lastProgressAt = Math.min(Date.now(), st.progressAt);
      if (sig !== lastSig || Date.now() - lastActionLogAt > 5000) {
        lastSig = sig;
        lastActionLogAt = Date.now();
        log('  动作: [' + st.act.name + '] ' + (st.act.detail || '') +
          ' · 第 ' + ((st.act.n || 0) + 1) + ' 次 · 已 ' + Math.round((Date.now() - (st.act.at || Date.now())) / 1000) + 's');
      }
    }
    /* 卡住判定：动作时间戳长时间不更新（脚本每次换动作/每次重试都会刷新它） */
    const actAge = Date.now() - lastProgressAt;
    if (st.act && actAge > STALL_MS) {
      const diag = await win.webContents.executeJavaScript(
        'JSON.stringify({ e2e: window.__e2e, diag: (window.__runDiag ? window.__runDiag() : null) })'
      ).catch(() => '{}');
      log('  ⚠ 卡住：动作 [' + st.act.name + '] 已 ' + Math.round(actAge / 1000) + 's 没有进展');
      log('  诊断: ' + String(diag).slice(0, 1800));
      fs.writeFileSync(path.join(ART, 'route-short-stall.json'), diag);
      log('  已写出 ' + path.join(ART, 'route-short-stall.json') + '，退出码 4');
      await srv.close();
      app.exit(4);
      return;
    }
    if (st.shot && !shotDone[st.shot]) {
      shotDone[st.shot] = true;
      const label = { world: '02-世界与地形', furnace: '03-熔炉与背包', mobs: '04-生物与战斗', final: '05-存档后场景' }[st.shot];
      if (label) await shot(label);
      /* 告知剧本「截图已完成」：capturePage 会短暂压住渲染，紧接着的移动/跳跃断言
         曾在截图后偶发 fps=1 假超时；剧本会等这个 ack 再继续。 */
      await win.webContents.executeJavaScript(
        'window.__e2e && (window.__e2e.shotAck = ' + JSON.stringify(st.shot) + '), true'
      ).catch(() => { });
    }
    if (st.done) {
      report = await win.webContents.executeJavaScript('JSON.stringify(window.__e2e)');
      break;
    }
    if (st.err) log('  最近错误：' + st.err);
    await sleep(300);
  }

  if (!report) {
    log('!! 验收超时未完成');
    const partial = await win.webContents.executeJavaScript('JSON.stringify(window.__e2e || {})').catch(() => '{}');
    fs.writeFileSync(path.join(ART, 'e2e-partial.json'), partial);
    const p = JSON.parse(partial);
    for (const s of p.steps || []) log((s.pass ? '  ✓ ' : '  ✗ ') + s.name + (s.info ? ' → ' + s.info : ''));
    await srv.close();
    app.exit(2);
    return;
  }

  const R = JSON.parse(report);
  R.pass = R.steps.filter(s => s.pass).length;
  R.total = R.steps.length;
  fs.writeFileSync(REPORT, JSON.stringify(R, null, 2));
  log('\n================ ' + (GUARDIAN ? '守卫验收' : '主线验收') + '结果 ================');
  for (const s of R.steps) log((s.pass ? '  ✓ ' : '  ✗ ') + s.name + (s.info ? '   → ' + s.info : ''));
  const fails = R.steps.filter(s => !s.pass);
  log('------------------------------------------');
  log('通过 ' + R.pass + '/' + R.total + '，失败 ' + fails.length);
  if (R.errors.length) { log('运行时错误：'); for (const e of R.errors.slice(0, 12)) log('  · ' + e); }
  const errLogs = logs.filter(l => /Error|error|Uncaught|失败/.test(l));
  if (errLogs.length) { log('控制台错误（去重）：'); for (const l of [...new Set(errLogs)].slice(0, 20)) log('  · ' + l); }
  log('==========================================');
  await shot('05-最终状态');
  await srv.close();
  app.exit(fails.length || R.errors.length ? 1 : 0);
}

main().catch(async (e) => {
  log('harness 异常: ' + ((e && e.stack) || e));
  try { await srv2close(); } catch (err) { /* ignore */ }
  app.exit(1);
});
function srv2close() { return Promise.resolve(); }
