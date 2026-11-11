/*
 * 最小取证：阶段 4 文件轨的「真实电平 / 留白 / 音量」三条曲线。
 *   cd app && npx electron tests/repro-mf.mjs
 *
 * 为什么需要它：e2e 的 MF.3 第一次跑红，读数「文件 rms=0.017 合成 rms=0.045」——
 * 这两个数都是 master 之后的**总输出**，里面混着环境床（风）与其它音效，
 * 不是「这两首曲子各自的响度」。不先把底噪剥掉，判据就是在一团混合信号上猜。
 *
 * 本脚本只做三件事，全部走产品自己的入口：
 *   A. 把 sfx 音量滑条拉到 0（环境床归音效层，一起闭掉）→ 采「纯音乐」的文件轨 / 合成轨电平；
 *   B. 音乐开关关掉 → 采同条件下的底噪，确认 A 的读数不是线路噪声；
 *   C. 用产品自己的 _scheduleLoop 把「这一段还剩 6 秒」重排一遍 → 采样 busGain / rms 曲线，
 *      看清段尾淡出与留白各自用了多久（MF.7 之前红就是因为把 nextStart 和 loopSeconds 各加了 6 秒）。
 * 结果写 artifacts/repro-mf.json，不碰验收用的 .e2e-saves。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const SAVES = path.join(APP, 'tests', '.repro-saves');
const OUT = path.join(APP, '..', 'artifacts', 'repro-mf.json');
fs.rmSync(SAVES, { recursive: true, force: true });

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const PROBE = `(async () => {
  const G = window.__game, T = window.__test;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const mi = () => T.musicInfo();
  const en = () => T.audioEnergy();
  const out = {};

  G.mobs.maxMobs = 0; G.mobs.clear();
  T.setWeather('clear', 600); T.tickWeather(0.05, 60);
  T.setTime(0.3);
  G.input.setUIMode(false);

  /* 底噪只在「音乐也关掉」时才量得到：环境床归音效层，所以 A 步先把 sfx 归零，
     这样 music 总线上只剩主曲自己，两条曲线才是可比的。 */
  const playing = () => { const m = mi(); return !!m && m.activeMusicCount === 1 && m.cycle && m.cycle.phase === 'playing' && m.busTarget > 0 && m.busGain >= 0.8 * m.busTarget; };
  const waitPlay = async (label, budget) => {
    let t = 0;
    while (t < budget) { if (playing()) return { ok: true, ms: t, label }; await sleep(120); t += 120; }
    return { ok: false, ms: t, label, snap: mi() };
  };
  const sample = async (ms) => {
    const rows = [];
    const t1 = performance.now();
    while (performance.now() - t1 < ms) {
      const m = mi(), e = en();
      rows.push({
        t: Math.round(performance.now() - t1), src: m.source, phase: m.cycle ? m.cycle.phase : null,
        busGain: m.busGain, busTotal: m.busGainTotal, busTarget: m.busTarget,
        gains: e ? e.gains : null, targets: e ? e.targets : null,
        rms: e && e.available ? +e.rms.toFixed(5) : null, peak: e && e.available ? +e.peak.toFixed(5) : null
      });
      await sleep(100);
    }
    let rms = 0, peak = 0;
    for (const r of rows) { if (r.rms > rms) rms = r.rms; if (r.peak > peak) peak = r.peak; }
    return { rows, rms, peak, n: rows.length };
  };

  /* A1：文件轨 + 只有音乐 */
  await G.applySettingsLive({ volumeMaster: 0.8, volumeSfx: 0, volumeMusic: 0.45 });
  const w1 = await waitPlay('文件轨', 16000);
  out.A_file = { w: w1, ...(w1.ok ? await sample(1500) : {}) };
  out.A_file.source = mi().source; out.A_file.fileName = mi().fileName;

  /* A2：合成轨 + 只有音乐 */
  T.setFileTracksEnabled(false);
  const w2 = await waitPlay('合成轨', 16000);
  out.B_synth = { w: w2, ...(w2.ok ? await sample(1500) : {}) };
  out.B_synth.source = mi().source;

  /* A3：合成轨开回来，再把音乐开关关掉 → 同一套滑条下的底噪（应该≈0） */
  T.setFileTracksEnabled(true);
  await waitPlay('回到文件轨', 20000);
  await G.applySettingsLive({ music: false });
  await sleep(1200);
  out.C_floor = await sample(800);
  await G.applySettingsLive({ music: true });
  await waitPlay('音乐回来', 20000);

  /* D：留白曲线——把「这一段还剩 6 秒」交给产品自己的 _scheduleLoop */
  const m = G.sfx._music;
  out.D_before = { src: m.source, loop: m.loopSeconds, nextIn: +(m.nextStart - G.sfx.ctx.currentTime).toFixed(2) };
  if (m.src) G.sfx._stopTrackSource(m, 0);
  m.loopSeconds = 6;
  m.nextStart = G.sfx.ctx.currentTime + 0.2;
  if (m.timer) clearTimeout(m.timer);
  const tD = performance.now();
  G.sfx._scheduleLoop(m);
  const rows = [];
  let gapAt = null, silentAt = null, backPlaying = null;
  for (let i = 0; i < 200; i++) {
    const mm = mi();
    const el = Math.round(performance.now() - tD);
    if (mm.cycle && mm.cycle.phase === 'gap' && gapAt === null) gapAt = el;
    if (gapAt !== null && mm.busGain <= 0.002 && silentAt === null) silentAt = el;
    if (gapAt !== null && mm.cycle && mm.cycle.phase === 'playing' && backPlaying === null) backPlaying = el;
    rows.push({ t: el, phase: mm.cycle ? mm.cycle.phase : null, busGain: mm.busGain, rms: en() && en().available ? +en().rms.toFixed(5) : null });
    if (backPlaying !== null) break;
    if (el > 26000) break;
    await sleep(120);
  }
  out.D_gap = { gapAt, silentAt, backPlaying, gapSeconds: mi().cycle ? mi().cycle.gapSeconds : null, rows: rows.filter((r, i) => i % 2 === 0 || r.phase === 'gap') };
  /* 观察完把音量与段落恢复成验收用的默认 */
  await G.applySettingsLive({ volumeMaster: 0.8, volumeSfx: 0.8, volumeMusic: 0.4 });
  G.sfx._switchMusic(mi().trackId, 0.3);

  /* E：路由与量级定点取证（第二版，第一版被环境床污染了）。
     e2e 的 MF.3 读到「文件 rms=0.049 / 合成 rms=0.0023」，而离线渲染（同一档增益）
     量到的是两者同量级。要么文件轨绕过了 music 总线，要么短窗把稀疏的合成编排低估了。
     这一段全程把 sfx 滑条留在 0（环境床归音效层），每步量 6 秒，
     并且只用产品自己的入口改音量（setMusicVolume），不去钉 AudioParam——
     钉了也会被 updateAmbient 每帧按回目标值，读数就成了半产品半夹具的混合体。 */
  await G.applySettingsLive({ volumeMaster: 0.8, volumeSfx: 0, volumeMusic: 0.45 });
  const stepE = async (label, vol) => {
    if (vol === 'off') await G.applySettingsLive({ music: false });
    else { await G.applySettingsLive({ music: true, volumeMusic: vol }); await waitPlay(label, 20000); }
    await sleep(1200);                        // 让缓入 / setTargetAtTime 走稳
    const s = await sample(6000);
    const mi2 = mi(), e2 = en();
    return {
      label, src: mi2.source, rms: s.rms, peak: s.peak, n: s.n,
      busGain: mi2.busGain, busTotal: mi2.busGainTotal, busTarget: mi2.busTarget,
      gains: e2 ? e2.gains : null, musicBus: G.sfx ? G.sfx.musicBus.gain.value : null,
      trim: mi2.fileTrim
    };
  };
  out.E_routing = {};
  out.E_routing.fileFull = await stepE('文件轨 @0.45', 0.45);
  out.E_routing.fileTenth = await stepE('文件轨 @0.045', 0.045);
  out.E_routing.floor = await stepE('音乐全关', 'off');
  await G.applySettingsLive({ music: true, volumeMaster: 0.8, volumeSfx: 0, volumeMusic: 0.45 });
  T.setFileTracksEnabled(false);
  out.E_routing.synthFull = await stepE('合成轨 @0.45', 0.45);
  out.E_routing.synthTenth = await stepE('合成轨 @0.045', 0.045);
  T.setFileTracksEnabled(true);
  await waitPlay('回到文件轨', 20000);

  out.final = { src: mi().source, loop: mi().loopSeconds, file: mi().fileName, states: mi().fileStates, loads: mi().bytesDecoded };
  out.resourceUrls = performance.getEntriesByType('resource').map(e => e.name).filter(u => /\\/media\\/music\\//.test(u));
  return out;
})()`;

async function main() {
  await app.whenReady();
  app.setName('方块世界-配乐取证');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1100, height: 700, show: true, title: '方块世界 · 配乐取证',
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
    `(async () => { await window.__game.newWorld('取证-配乐MF', 'r4-route-2026', 'survival'); return window.__game.state; })()`);
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
  const brief = (k) => {
    const s = out[k];
    if (!s) return k + ' 缺失';
    return k + ' src=' + s.source + ' rms=' + s.rms + ' peak=' + s.peak + ' n=' + s.n + ' 就绪=' + JSON.stringify(s.w && { ok: s.w.ok, ms: s.w.ms });
  };
  log(brief('A_file'));
  log(brief('B_synth'));
  log(brief('C_floor'));
  log('D 留白：gap@' + out.D_gap.gapAt + 'ms 增益贴零@' + out.D_gap.silentAt + 'ms 回到 playing@' + out.D_gap.backPlaying +
    'ms gapSeconds=' + out.D_gap.gapSeconds);
  log('D 采样（每 2 行取 1）：' + JSON.stringify(out.D_gap.rows.slice(0, 40).filter((_, i) => i % 3 === 0)));
  const ER = out.E_routing || {};
  const eLine = (k) => {
    const s = ER[k];
    if (!s) return k + ' 缺失';
    return k + ' src=' + s.src + ' rms=' + s.rms + ' peak=' + s.peak + ' n=' + s.n +
      ' bus=' + s.busGain + '/' + s.busTarget + ' total=' + s.busTotal + ' musicBus=' + (s.musicBus === null ? '?' : s.musicBus.toFixed(4)) + ' trim=' + s.trim;
  };
  log('E 路由/量级：');
  ['fileFull', 'fileTenth', 'floor', 'synthFull', 'synthTenth'].forEach(k => log('   ' + eLine(k)));
  log('   比值 文件(全/十分)=' + (ER.fileFull && ER.fileTenth ? (ER.fileFull.rms / Math.max(1e-9, ER.fileTenth.rms)).toFixed(2) : '?') +
    ' 合成(全/十分)=' + (ER.synthFull && ER.synthTenth ? (ER.synthFull.rms / Math.max(1e-9, ER.synthTenth.rms)).toFixed(2) : '?') +
    ' 文件/合成(同音量)=' + (ER.fileFull && ER.synthFull ? (ER.fileFull.rms / Math.max(1e-9, ER.synthFull.rms)).toFixed(2) : '?'));
  log('资源列表里的素材 URL：' + JSON.stringify(out.resourceUrls));
  log('收尾：' + JSON.stringify(out.final));
  clearInterval(topTimer);
  try { powerSaveBlocker.stop(psb); } catch (e) { /* ignore */ }
  await srv.close();
  app.exit(0);
}

main().catch(e => { log('harness 异常: ' + ((e && e.stack) || e)); app.exit(1); });
