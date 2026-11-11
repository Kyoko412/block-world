/*
 * Electron 主进程：启动本地回环服务 -> 打开游戏窗口。
 * 渲染端只通过 127.0.0.1 读写存档，不接触任何外部网络。
 */
import { app, BrowserWindow, Menu, shell, dialog, powerSaveBlocker } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* 自检专用防降频：与 tests/e2e-electron.mjs 完全一致，必须在 app ready 之前设置。
   runSelfTest() 里的置顶 / 防显示器休眠只解决了「窗口被遮挡」的一部分；Windows 还会把
   后台渲染进程的 rAF 压到 1fps，让熔炉等待、区块补加载、帧率断言成片假超时
   （2026-11-07 实测只跑到 137/526 并因 slot0 为 null 抛异常）。正常游玩不带 --selftest，不受影响。
   阶段 5：`--selftest-guardian` 走同一套环境修正（同一个 EXE 的另一个独立验收模式）。
   阶段 7：`--selftest-route` 用同一套环境修正在**最终 EXE** 里走正常生存路线取证，
   剧本、报告、存档目录各自独立，不挤进主线 600 秒预算。 */
const SELFTEST_KIND = process.argv.includes('--selftest-guardian') ? 'guardian'
  : (process.argv.includes('--selftest-natural') ? 'natural'
    : (process.argv.includes('--selftest-route') ? 'route'
      : (process.argv.includes('--selftest') ? 'main' : null)));
if (SELFTEST_KIND) {
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

let win = null;
let server = null;

/* 存档目录：打包后放在 exe 同级 saves/（便携），开发时放在项目 saves/ */
function resolveSaveRoot() {
  /* 阶段 6 封版：成品自检使用独立验收存档根目录。
     旧行为是自检修用普通便携 saves/，而 selftest-package.ps1 每次启动会清空该目录，
     于是后跑的守卫验收把先前主线写出的 JSON 报告一起删掉（本轮已复现）。
     · 正常运行（不带 --selftest / --selftest-guardian）：下面的解析链一字不动；
     · 自检：优先用运行器显式传入的 BLOCKWORLD_SELFTEST_SAVES，
       没传时退回系统临时目录下按 main / guardian 分开的目录，绝不读写普通 saves/。 */
  if (SELFTEST_KIND) {
    const explicit = (process.env.BLOCKWORLD_SELFTEST_SAVES || '').trim();
    const dir = explicit ? path.resolve(explicit)
      : path.join(os.tmpdir(), '方块世界-验收存档', SELFTEST_KIND);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const packed = app.isPackaged || process.execPath.toLowerCase().includes('electron') === false;
  const exeDir = path.dirname(app.getPath('exe'));
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(exeDir, 'saves'));
  candidates.push(path.join(__dirname, 'saves'));
  candidates.push(path.join(os.homedir(), 'Documents', '方块世界存档'));
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test');
      fs.writeFileSync(probe, '1');
      fs.unlinkSync(probe);
      return dir;
    } catch (e) { /* 试下一个 */ }
  }
  return path.join(os.tmpdir(), 'moshou-saves');
}

function windowStateFile() { return path.join(app.getPath('userData'), 'window.json'); }
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(windowStateFile(), 'utf8')); } catch (e) { return {}; }
}
function saveWindowState() {
  if (!win) return;
  try {
    const b = win.getBounds();
    fs.mkdirSync(path.dirname(windowStateFile()), { recursive: true });
    fs.writeFileSync(windowStateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch (e) { /* ignore */ }
}

/* 单实例：重复双击 exe 时聚焦已有窗口 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  main().catch(err => {
    console.error(err);
    try { dialog.showErrorBox('启动失败', String(err && err.stack || err)); } catch (e) { /* ignore */ }
  });
}

/* 自检模式：对打包后的 exe 做端到端验收。
   kind='main' 跑主线剧本（589 条），kind='guardian' 跑阶段 5 的独立守卫场景。
   两者共用同一 EXE、同一套保活与看门狗，但剧本、报告文件、退出码各自独立。 */
async function runSelfTest(win, server, saveRoot, kind = 'main') {
  const GUARD = kind === 'guardian';
  const ROUTE = kind === 'route';
  /* 第二轮 E：自然生存路线是独立的第四种剧本 —— 与上面的混合冒烟路线分开，
     各自报告、各自存档目录、各自预算（自然路线要看真实采集与熔炼，600 秒不够）。 */
  const NATURAL = kind === 'natural';
  const scenarioFile = GUARD ? 'guardian-scenario.js'
    : (NATURAL ? 'survival-natural.js' : (ROUTE ? 'survival-route.js' : 'e2e-scenario.js'));
  const reportFile = GUARD ? 'guardian-report.json'
    : (NATURAL ? 'natural-route-report.json' : (ROUTE ? 'route-report.json' : 'selftest-report.json'));
  const tag = GUARD ? '[守卫自检]' : (NATURAL ? '[自然路线]' : (ROUTE ? '[生存路线]' : '[自检]'));
  /* 看门狗：自然路线允许更长的真实采集/熔炼/战斗链（默认 600 秒只够主线和守卫）。 */
  const WATCHDOG_TICKS = NATURAL ? 6000 : 2400;   // ×250ms = 25 分钟
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const out = (m) => process.stdout.write(m + '\n');
  /* 验收环境修正（与 tests/e2e-electron.mjs 一致，只在 --selftest 生效）：
     Windows 会把被遮挡/最小化的窗口 rAF 压到 1fps，实测熔炉等待、区块补加载、
     帧率断言会成片假超时，甚至让剧本中途抛异常只跑到 137/505。
     置顶 + 阻止显示器休眠，正常游玩路径完全不受影响。 */
  try {
    powerSaveBlocker.start('prevent-display-sleep');
    win.setAlwaysOnTop(true, 'screen-saver');
    win.show();
    win.focus();
  } catch (e) { /* 环境不支持时继续跑，不因此判定失败 */ }
  /* 与 tests/e2e-electron.mjs 同一套保活：只做一次置顶不够 —— 实测进游戏后 Windows 仍会把
     验收窗口最小化/遮住，rAF 直接掉到 ~1fps，熔炉等待、区块补加载、帧率与位移断言成片假超时，
     严重时剧本在读取一个还没画出来的 DOM 节点时抛异常（历史读数 133/137 + null.dispatchEvent）。
     每 0.5 秒恢复并提到最上层，但用 showInactive/moveTop 不抢焦点。仅自检窗口，正常游玩不受影响。 */
  const topTimer = setInterval(() => {
    try {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.showInactive();
      win.moveTop();
    } catch (e) { /* ignore */ }
  }, 500);
  const stopTopTimer = () => { try { clearInterval(topTimer); } catch (e) { /* ignore */ } };
  try {
    const file = path.join(__dirname, 'selftest', 'e2e-scenario.js');
    const sfile = path.join(__dirname, 'selftest', scenarioFile);
    const useFile = fs.existsSync(sfile) ? sfile : file;
    if (!fs.existsSync(useFile)) { out(tag + ' 剧本不存在：' + useFile); stopTopTimer(); app.exit(3); return; }
    const scenario = fs.readFileSync(useFile, 'utf8');
    for (let i = 0; i < 300; i++) {
      const ok = await win.webContents.executeJavaScript('!!(window.__game && window.__test)').catch(() => false);
      if (ok) break;
      await sleep(100);
    }
    out(tag + ' 验收存档目录：' + saveRoot);
    out(tag + ' 注入验收剧本：' + path.basename(useFile) + '…');
    const p = win.webContents.executeJavaScript(scenario).catch(e => out('[自检] 脚本异常 ' + e));
    void p;
    let report = null;
    /* 看门狗：2400 × 250ms = 600 秒（阶段 1 第 3 刀之前的上限是 1400 × 250ms = 350 秒）。
       新档高度从 64 格扩到 128 格，生成/补光/网格三段都要成倍涨，
       350 秒会把「跑完但慢」误判成超时退出码 2 —— 本轮预算已批准放宽到 600 秒。
       真实的整程耗时由剧本里的 PF.1 分段计时打印，不靠这条上限猜。 */
    for (let i = 0; i < WATCHDOG_TICKS; i++) {
      const st = await win.webContents.executeJavaScript(
        'window.__e2e ? {done: window.__e2e.done, n: window.__e2e.steps ? window.__e2e.steps.length : 0} : null').catch(() => null);
      if (st && st.done) { report = await win.webContents.executeJavaScript('JSON.stringify(window.__e2e)'); break; }
      await sleep(250);
    }
    if (!report) { out(tag + ' 超时未完成'); stopTopTimer(); app.exit(2); return; }
    const R = JSON.parse(report);
    fs.writeFileSync(path.join(saveRoot, reportFile), JSON.stringify(R, null, 2));
    for (const s of R.steps) out((s.pass ? '  ✓ ' : '  ✗ ') + s.name + (s.info ? '  → ' + s.info : ''));
    out(tag + ' 通过 ' + R.pass + '/' + R.total + (R.errors.length ? '，运行错误 ' + R.errors.length + ' 条' : ''));
    out(tag + ' 报告：' + path.join(saveRoot, reportFile));
    stopTopTimer();
    await server.close();
    const okAll = R.pass === R.total && (R.errors || []).length === 0;
    app.exit(okAll ? 0 : 1);
  } catch (e) {
    out(tag + ' 失败：' + ((e && e.stack) || e));
    stopTopTimer();
    app.exit(1);
  }
}

async function main() {
  await app.whenReady();
  app.setName('方块世界');

  const saveRoot = resolveSaveRoot();
  server = await createServer({
    staticRoot: path.join(__dirname, 'renderer'),
    saveRoot,
    onQuit: () => { app.quit(); }
  });

  const st = loadWindowState();
  win = new BrowserWindow({
    width: st.width || 1440,
    height: st.height || 900,
    x: st.x, y: st.y,
    minWidth: 960,
    minHeight: 600,
    title: '方块世界 · 中文体素沙盒',
    backgroundColor: '#8ac4ff',
    show: false,
    fullscreen: st.fullscreen === true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.on('close', saveWindowState);
  win.on('move', () => { /* 关闭时统一保存 */ });
  win.on('maximize', saveWindowState);
  win.on('unmaximize', saveWindowState);
  win.on('leave-fullscreen', saveWindowState);
  win.on('enter-fullscreen', saveWindowState);

  await win.loadURL(server.url);

  if (SELFTEST_KIND) runSelfTest(win, server, saveRoot, SELFTEST_KIND);

  const toggleFS = () => {
    const fs2 = !win.isFullScreen();
    win.setFullScreen(fs2);
    if (win.webContents) win.webContents.send('menu-fullscreen', fs2);
  };

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '游戏',
      submenu: [
        {
          label: '保存进度',
          accelerator: 'F5',
          click: () => { win.webContents.executeJavaScript('window.__game && window.__game.requestManualSave && window.__game.requestManualSave()'); }
        },
        {
          label: '返回主菜单',
          accelerator: 'Alt+Home',
          click: () => { win.webContents.executeJavaScript('window.__game && window.__game.showMenu && window.__game.showMenu()'); }
        },
        { type: 'separator' },
        { label: '退出游戏', accelerator: 'Alt+Q', click: () => app.quit() }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '全屏切换', accelerator: 'F11', click: toggleFS },
        { label: '重新加载游戏', accelerator: 'Ctrl+R', click: () => win.reload() },
        { type: 'separator' },
        { label: '打开存档文件夹', click: () => shell.openPath(saveRoot) }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '操作说明',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: '操作说明',
              message: '方块世界 · 操作说明',
              detail: [
                '移动：W A S D      跳跃：空格      冲刺：左 Ctrl',
                '视角：鼠标        鼠标锁定：点击画面 / 按 Esc 释放',
                '挖掘：鼠标左键（按住）   放置：鼠标右键',
                '选择物品：1~9 数字键 / 滚轮    背包：E',
                '合成：背包内的 2x2 格，或对着工作台按右键打开 3x3',
                '创造/生存切换：Esc 菜单中的「游戏模式」',
                '保存：自动保存 + 手动 F5      全屏：F11',
                '截图：F12（保存在存档目录 screenshots/）'
              ].join('\n'),
              buttons: ['知道了']
            });
          }
        },
        {
          label: '开源许可',
          click: () => {
            const p = path.join(__dirname, 'LICENSES.md');
            if (fs.existsSync(p)) shell.openPath(p);
            else dialog.showMessageBox(win, { type: 'info', message: '许可文件未随包提供', detail: p });
          }
        }
      ]
    }
  ]));

  win.on('closed', () => { win = null; app.quit(); });
  console.log('[方块世界] 本地服务已启动：' + server.url + '  存档目录：' + saveRoot);
}

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => { saveWindowState(); if (server) server.close(); });
