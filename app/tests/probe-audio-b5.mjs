/*
 * B.5 最小复现探针（不进验收门禁）：单跑「静音 / 播放 / 暂停」三态的能量读数，
 * 把整程 8 分钟的失败压成 30 秒的可判定实验。
 *   cd app && npx electron tests/probe-audio-b5.mjs
 *
 * instrument：每次采样同时记录 master / sfx / music / ambient 四条链路的实时增益，
 * 以及环境床来源数。目的是分清「真静音」与「信号在某条总线上被乘成 0」。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'probe-audio-b5.json');
const SAVES = path.join(APP, 'tests', '.probe-audio-saves');
fs.mkdirSync(SAVES, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: 'B.5 探针',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => { try { if (win.isDestroyed()) return; win.showInactive(); win.moveTop(); } catch (e) { } }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { } });

  await win.loadURL(srv.url);
  for (let i = 0; i < 100; i++) {
    const ok = await win.webContents.executeJavaScript('!!(window.__game && window.__test)').catch(() => false);
    if (ok) break;
    await sleep(200);
  }
  /* 必须先有用户手势才建 AudioContext */
  await win.webContents.executeJavaScript("window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));true");
  await win.webContents.executeJavaScript(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '音频探针';
    document.querySelector('#inp-seed').value = 'visual-audit-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    true;
  `);
  for (let i = 0; i < 240; i++) {
    const ok = await win.webContents.executeJavaScript('const G=window.__game;return G.state==="playing"&&G.world&&G.world.genQueue.length===0;').catch(() => false);
    if (ok) break;
    await sleep(250);
  }
  await sleep(800);

  const res = await win.webContents.executeJavaScript(`(async () => {
    const G = window.__game, T = window.__test;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const out = { steps: [] };
    const snap = (tag) => {
      const e = T.audioEnergy() || {};
      const mi = T.musicInfo() || {};
      const av = T.audioVolumes() || {};
      return {
        tag, rms: e.rms, peak: e.peak, n: e.frames, state: e.state,
        gains: e.gains, targets: e.targets, masterGain: e.masterGain,
        clock: e.currentTime,
        music: { src: mi.source, phase: mi.cycle && mi.cycle.phase, busGain: mi.busGain, busTotal: mi.busGainTotal, amb: mi.activeAmbient, ambSources: mi.ambientSources, act: mi.activeMusicCount, ambCount: mi.ambientCount },
        vols: av.delivered
      };
    };
    const sample = async (ms) => {
      const rows = []; let rms = 0, peak = 0, n = 0;
      const t1 = performance.now();
      while (performance.now() - t1 < ms) { const s = snap('s'); if (s.rms > rms) rms = s.rms; if (s.peak > peak) peak = s.peak; n++; rows.push(s); await sleep(40); }
      return { rms: +rms.toFixed(6), peak: +peak.toFixed(6), n, rows: rows.slice(0, 3).concat(rows.slice(-2)) };
    };
    /* 夜间 + insects（B.5 在整程末尾就是这个条件） */
    T.setTime(0.75);
    await sleep(1500);
    out.steps.push({ where: '睡前', snap: snap('pre') });

    await G.applySettingsLive({ music: false });
    await sleep(2600);
    out.steps.push({ where: '静音', sample: await sample(500) });

    await G.applySettingsLive({ music: true });
    await sleep(3500);
    out.steps.push({ where: '播放', sample: await sample(600) });

    G.pause();
    await sleep(2600);
    out.steps.push({ where: '暂停', sample: await sample(500) });
    G.resume();
    await sleep(2500);
    out.steps.push({ where: '恢复', sample: await sample(600) });
    return out;
  })()`);
  fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
  for (const s of res.steps) {
    if (s.sample) {
      const r = s.sample.rows[s.sample.rows.length - 1];
      console.log(s.where.padEnd(4), 'rms=' + s.sample.rms, 'peak=' + s.sample.peak,
        'gains=' + JSON.stringify(r.gains), 'amb=' + r.music.amb + '/' + r.music.ambSources,
        'busTotal=' + r.music.busTotal, 'vols=' + JSON.stringify(r.vols));
    } else {
      console.log(s.where.padEnd(4), JSON.stringify(s.snap.gains), s.snap.music.amb);
    }
  }
  console.log('→ ' + OUT);
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
