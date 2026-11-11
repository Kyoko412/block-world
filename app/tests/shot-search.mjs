/*
 * E1 创造栏搜索取证：真实打开创造背包、输入中文/英文/无结果，截图并记录搜索读数。
 *   cd app && npx electron tests/shot-search.mjs
 * 产出 artifacts/visual/search-01-chinese.png、search-02-empty.png、search-samples.json
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts', 'visual');
const SAVES = path.join(APP, 'tests', '.search-saves');
fs.mkdirSync(ART, { recursive: true });
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
    width: 1280, height: 720, show: true, title: '方块世界 · 创造搜索取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver'); win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => {
    try { if (!win || win.isDestroyed()) return; if (win.isMinimized()) win.restore(); win.showInactive(); win.moveTop(); } catch (e) { /* ignore */ }
  }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ART, name + '.png'), img.toPNG());
    console.log('[截图] artifacts/visual/' + name + '.png');
  };
  await win.loadURL(srv.url);
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await evl('return !!(window.__game && window.__test);').catch(() => false);
    if (!ready) await sleep(200);
  }
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '创造搜索取证';
    document.querySelector('#inp-seed').value = 'search-shot';
    document.querySelector('#m-creative').click();
    document.querySelector('#btn-create').click(); return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl('const G=window.__game; return !G || G.state!=="playing" || G.world.genQueue.length>0 || G.world.dirtyMesh.size>0;');
    if (!busy) break;
    await sleep(300);
  }
  await evl(`
    const G = window.__game, T = window.__test;
    T.setTime(0.3); T.setWeather('clear', 600); G.mobs.maxMobs = 0; G.mobs.clear();
    await new Promise(r => setTimeout(r, 600));
    G.openInventory();
    await new Promise(r => requestAnimationFrame(r));
    const btn = [...document.querySelectorAll('#panel-inventory .btn')].find(b => b.textContent.includes('创造'));
    if (btn) btn.click();
    await new Promise(r => requestAnimationFrame(r));
    return true;
  `);
  const setQuery = async (q) => {
    await evl(`
      const inp = document.querySelector('#inp-creative-search');
      inp.focus(); inp.value = ${JSON.stringify(q)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => requestAnimationFrame(r));
      await new Promise(r => setTimeout(r, 250));
      return true;
    `);
    return evl('return window.__test.creativeState();');
  };
  const s1 = await setQuery('铁');
  await shot('search-01-chinese');
  const s2 = await setQuery('COMPASS');
  await shot('search-02-english');
  const s3 = await setQuery('zzzz-no-such-item');
  await shot('search-03-empty');
  const samples = { chinese: s1, englishUpper: s2, empty: s3 };
  fs.writeFileSync(path.join(ART, 'search-samples.json'), JSON.stringify(samples, null, 2));
  console.log('[数据] artifacts/visual/search-samples.json');
  console.log(JSON.stringify(samples));
  win.destroy();
  await srv.close();
  app.quit();
}

run().catch(e => { console.error(e); app.exit(1); });
