/*
 * B.5 有界最小采样探针（独立脚本，不进 e2e、不改产品）。
 *   cd app && npx electron tests/probe-audio.mjs
 * 目的：把「三段 RMS 全零」拆成可判定的三种情况——
 *   ① 音效有信号、音乐无信号 → 音乐轨（OGG / bus / 留白）问题；
 *   ② 音效也无信号 → analyser / master 采集链问题；
 *   ③ 都有信号 → 整程 B.5 的时序问题（例如采样正落在曲间留白）。
 * 产出 artifacts/probe-audio.json
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'probe-audio.json');
const SAVES = path.join(APP, 'tests', '.probe-audio-saves');
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.setName('方块世界-音频探针');
  for (const sw of ['disable-background-timer-throttling', 'disable-renderer-backgrounding',
    'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(sw);
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '方块世界 · 音频探针',
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

  /* 一次真实手势解锁音频图（走产品入口，不直调内部） */
  await evl("window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;");
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '音频探针';
    document.querySelector('#inp-seed').value = 'audio-probe-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 240; i++) {
    const busy = await evl("const G=window.__game; return !G || G.state!=='playing' || (G.world && (G.world.genQueue.length>0 || G.world.dirtyMesh.size>0));");
    if (!busy) break;
    await sleep(300);
  }
  await sleep(600);

  const sample = async (label, ms) => evl(`
    const T = window.__test;
    let rms = 0, peak = 0, n = 0, last = null;
    const t1 = performance.now();
    while (performance.now() - t1 < ${Number(ms) || 600}) {
      const e = T.audioEnergy();
      if (e && e.available) { rms = Math.max(rms, e.rms); peak = Math.max(peak, e.peak); n++; last = e; }
      await new Promise(r => setTimeout(r, 40));
    }
    return { label: ${JSON.stringify(label)}, rms, peak, n,
      last: last ? { state: last.state, gains: last.gains, targets: last.targets,
        musicPlaying: last.musicPlaying, ambientPlaying: last.ambientPlaying,
        currentTime: last.currentTime, masterGain: last.masterGain, tapChain: last.tapChain } : null,
      music: T.musicInfo() };
  `);

  const out = { stages: [] };
  out.ctx = await evl("const G=window.__game,T=window.__test; const e=T.audioEnergy(); return { e, stats: T.sfxStats(), music: T.musicInfo() };");

  /* ① 单个确定有信号的音效：这一步能直接判定 analyser / master 链是否活着 */
  await evl("window.__game.sfx.play('explode',{volume:1}); return true;");
  out.stages.push(await sample('after-sfx', 900));

  /* ② 音乐开关打开：等主曲与环境床回来，再看有没有信号 */
  await evl("await window.__game.applySettingsLive({ music: true }); return true;");
  for (let i = 0; i < 60; i++) {
    const ok = await evl("const m=window.__test.musicInfo(); return m.activeMusicCount===1 && m.activeAmbient!==null;");
    if (ok) break;
    await sleep(100);
  }
  await sleep(2600);   // 等淡入
  out.stages.push(await sample('music-on', 900));

  /* ③ 再补一次音效，确认播放态下音效链也活着 */
  await evl("window.__game.sfx.play('hit',{volume:1}); return true;");
  out.stages.push(await sample('music-on-plus-sfx', 900));

  /* ④ 关音乐，等释放，测静音态 */
  await evl("await window.__game.applySettingsLive({ music: false }); return true;");
  for (let i = 0; i < 90; i++) {
    const ok = await evl("const m=window.__test.musicInfo(); return m.activeMusicCount===0 && m.activeAmbient===null && m.fadingMusicCount===0 && m.ambientFadingCount===0;");
    if (ok) break;
    await sleep(100);
  }
  await sleep(300);
  out.stages.push(await sample('music-off', 700));

  /* ⑤ 复现 B.5 的播放态：从「已关闭且全释放」重新打开，等主曲/环境床回来 + 音频时钟走过淡入 */
  await evl("await window.__game.applySettingsLive({ music: true }); return true;");
  for (let i = 0; i < 90; i++) {
    const ok = await evl("const m=window.__test.musicInfo(); return m.activeMusicCount===1 && m.activeAmbient!==null;");
    if (ok) break;
    await sleep(100);
  }
  const fadeT0 = await evl("const e=window.__test.audioEnergy(); return e ? e.currentTime : 0;");
  for (let i = 0; i < 80; i++) {
    const done = await evl("const e=window.__test.audioEnergy(); return !!e && e.currentTime - " + Number(fadeT0) + " >= 2.2;");
    if (done) break;
    await sleep(100);
  }
  out.stages.push(await sample('reopen-music', 900));

  /* ⑥ 暂停态：G.pause() 后等全释放 */
  await evl("window.__game.pause(); return true;");
  await sleep(1600);
  out.stages.push(await sample('paused', 700));
  await evl("window.__game.resume(); return true;");

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  for (const s of out.stages) {
    console.log('[AUDIO] ' + s.label.padEnd(20) + ' rms=' + s.rms + ' peak=' + s.peak +
      ' n=' + s.n + ' music=' + (s.music && s.music.trackId) + ' amb=' + (s.music && s.music.activeAmbient) +
      ' phase=' + (s.music && s.music.cycle && s.music.cycle.phase));
  }
  console.log('[AUDIO] ctx=' + JSON.stringify(out.ctx && out.ctx.e && {
    available: out.ctx.e.available, state: out.ctx.e.state, gains: out.ctx.e.gains,
    masterGain: out.ctx.e.masterGain, tapChain: out.ctx.e.tapChain
  }));
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
