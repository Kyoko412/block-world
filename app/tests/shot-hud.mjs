/*
 * P2 HUD 双尺寸 A/B 取证（独立脚本，不进 e2e、不占自检预算）
 *   cd app && npx electron tests/shot-hud.mjs --label=p2-hud-old-900 --size=900x500 --old
 *   cd app && npx electron tests/shot-hud.mjs --label=p2-hud-new-900 --size=900x500
 *   同理再跑 1280x720 两组
 * 产出 artifacts/visual/<label>/{hud.png,hud.json}；每次用独立 .hud-saves，不覆盖既有证据。
 * --old 注入改前 CSS（bottom:8px / max-width:none / 无首夜提示），同种子同时间复现「侵入第 9 格」。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';
import { rectsOverlap } from '../renderer/js/core/hud.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const argv = process.argv.slice(2);
const label = ((argv.find(a => a.startsWith('--label=')) || '').slice(8).replace(/[^0-9A-Za-z_\-]/g, '')) || 'p2-hud';
const sizeArg = (argv.find(a => a.startsWith('--size=')) || '--size=1280x720').slice(7);
const parts = sizeArg.split(/[xX]/).map(n => parseInt(n, 10));
const W = Math.max(320, parts[0] || 1280), H = Math.max(320, parts[1] || 720);
const OLD = argv.includes('--old');
const OUT = path.join(ART, label);
const SAVES = path.join(APP, 'tests', '.hud-saves');
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const OLD_CSS = '#hint-bar{bottom:8px!important;max-width:none!important} #night-hint{display:none!important}';

async function run() {
  await app.whenReady();
  app.setName('方块世界-HUD取证');
  for (const sw of ['disable-background-timer-throttling', 'disable-renderer-backgrounding',
    'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(sw);
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: W, height: H, show: true, title: '方块世界 · HUD 取证',
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

  await win.loadURL(srv.url);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await evl('return !!(window.__game && window.__test);').catch(() => false);
    if (!ready) await sleep(200);
  }
  if (!ready) { console.error('前端未就绪'); await srv.close(); app.exit(1); return; }

  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = 'HUD取证';
    document.querySelector('#inp-seed').value = 'hud-audit-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl('const G=window.__game; return !G || G.state!==\'playing\' || (G.world && (G.world.genQueue.length>0 || G.world.dirtyMesh.size>0));');
    if (!busy) break;
    await sleep(300);
  }
  await evl(`
    const G=window.__game, T=window.__test;
    G.settings.renderDistance = 6; G.settings.brightness = 1;
    T.setTime(0.52);                       /* 入夜前：首夜提示应出现 */
    G.mobs.maxMobs = 0; G.mobs.clear();
    return true;
  `);
  await sleep(900);                        /* 等 0.5s 节流刷新 + 世界稳定 */

  if (OLD) {
    await evl('let s=document.getElementById(\'p2-old-css\'); if(!s){s=document.createElement(\'style\');s.id=\'p2-old-css\';document.head.appendChild(s);} s.textContent=' + JSON.stringify(OLD_CSS) + '; return true;');
    await sleep(250);
  }

  const geom = await evl(`
    const r = (n) => { if(!n) return null; const b=n.getBoundingClientRect(); return {left:b.left,top:b.top,width:b.width,height:b.height}; };
    const bar=document.querySelector('#hint-bar');
    const slot=document.querySelectorAll('#hotbar .slot')[8];
    const night=document.querySelector('#night-hint');
    return {
      window:[innerWidth,innerHeight],
      hint:r(bar), slot9:r(slot), status:r(document.querySelector('#status-bars')), night:r(night),
      hintBottom:bar?getComputedStyle(bar).bottom:null,
      hintMaxWidth:bar?getComputedStyle(bar).maxWidth:null,
      hintBar:bar?bar.textContent.replace(/\\s+/g,' ').trim():'',
      nightText:night?night.textContent:'',
      nightShown:night?(night.classList.contains('show') && getComputedStyle(night).display!=='none'):false
    };
  `);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'hud.png'), img.toPNG());
  const report = {
    label, old: OLD, requested: [W, H], seed: 'hud-audit-2026', time: 0.52,
    window: geom.window,
    rects: { hint: geom.hint, slot9: geom.slot9, status: geom.status, night: geom.night },
    overlap: {
      hintVsSlot9: rectsOverlap(geom.hint, geom.slot9),
      hintVsStatus: rectsOverlap(geom.hint, geom.status)
    },
    hintBottom: geom.hintBottom, hintMaxWidth: geom.hintMaxWidth,
    hintBar: geom.hintBar, nightText: geom.nightText, nightShown: geom.nightShown,
    screenshot: 'hud.png'
  };
  fs.writeFileSync(path.join(OUT, 'hud.json'), JSON.stringify(report, null, 2));
  console.log('[HUD] ' + label + ' ' + geom.window.join('x') + ' old=' + OLD +
    ' overlap.slot9=' + report.overlap.hintVsSlot9 + ' overlap.status=' + report.overlap.hintVsStatus +
    ' night=' + geom.nightShown);
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
