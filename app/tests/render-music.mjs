/*
 * 三首主曲的离线渲染与机器检查（不做“人工试听”）：
 *   cd app && npx electron tests/render-music.mjs
 *
 * 用 OfflineAudioContext + 真实编排代码（renderer/js/audio/music.js 的 scheduleTrack）
 * 各渲染一轮到 artifacts/audio/{day,night,cave}.wav，然后检查：
 *   - 时长 ≥ 20 秒；
 *   - 非静音（RMS / 峰值）；
 *   - 不削波（没有样本贴到 ±1，峰值 < 0.98）；
 *   - 循环边界平顺：首尾样本都接近静音，且首尾差 < 0.05（不会“啪”一声）。
 *
 * 阶段 4 之后这里同时产出**改前 / 改后**两套可听样本：
 *   {id}.wav        改前：程序化合成曲（真实编曲代码离线渲染）
 *   {id}-file.wav   改后：随包外部曲目（前 60 秒样本，走 trim × 0.9 的同一档总线增益）
 * 外部曲目另做一遍全曲取证（artifacts/music-files-report.json）：
 *   时长 / 采样率 / 声道 / RMS / 峰值 / NaN / 削波 / 首尾与中段能量 / 孤立瞬态（周期性噪声）位置与间隔。
 * `--measure` 只解码取证、不写样本，用来量原始响度以确定 trim；
 * 默认模式会额外钉「改后与改前 RMS 同量级（比值 0.6~1.6）」，
 * 因为 B / T4 那一组能量验收的基准是按合成曲响度标定的，换曲不许把它们整体抬高。
 *
 * 机器检查不能冒充人工试听：报告里会分开写“机器检查通过”和“未做人工试听”。
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';
import { FILE_TRACKS, fileTracksReport } from '../renderer/js/core/musicfiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'audio');
const SAVES = path.join(APP, 'tests', '.shot-saves');
const MEASURE = process.argv.includes('--measure');
const SAMPLE_SECONDS = 60;
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function checkWav(file) {
  const b = fs.readFileSync(file);
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  const dataBytes = b.readUInt32LE(40);
  const n = dataBytes / (channels * (bits / 8));
  const duration = n / rate;
  let peak = 0, sum = 0, clipped = 0;
  for (let i = 0; i < n; i++) {
    const v = b.readInt16LE(44 + i * 2) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  const first = b.readInt16LE(44) / 32768;
  const last = b.readInt16LE(44 + (n - 1) * 2) / 32768;
  const edge = Math.abs(first - last);
  const headMax = Math.max(...Array.from({ length: Math.min(2205, n) }, (_, i) => Math.abs(b.readInt16LE(44 + i * 2) / 32768)));
  const tailMax = Math.max(...Array.from({ length: Math.min(2205, n) }, (_, i) => Math.abs(b.readInt16LE(44 + (n - 1 - i) * 2) / 32768)));
  const pass = duration >= 20 && rms > 0.004 && peak > 0.02 && peak < 0.98 && clipped === 0 &&
    Math.abs(first) < 0.05 && Math.abs(last) < 0.05 && edge < 0.05;
  return {
    file: path.basename(file), channels, rate, bits,
    duration: +duration.toFixed(3), peak: +peak.toFixed(4), rms: +rms.toFixed(4),
    clipped, first: +first.toFixed(4), last: +last.toFixed(4), edge: +edge.toFixed(4),
    headMax: +headMax.toFixed(3), tailMax: +tailMax.toFixed(3), pass
  };
}

/* 外部曲目的样本判据与合成曲不同：成品母带不是「首尾归零」的循环体，
   所以这里钉的是「整段有内容（RMS/中段峰值）、不削波、时长够长、开头不是数字静音、结尾有信号（没被剪短）」，
   而不是循环边界平顺。两套判据各写各的，谁也不许顺着谁放宽。 */
function checkFileSample(file, entry) {
  const c = checkWav(file);                       // 通用读数（时长/峰值/RMS/削波）
  const b = fs.readFileSync(file);
  const channels = b.readUInt16LE(22), rate = b.readUInt32LE(24), bits = b.readUInt16LE(34);
  const n = b.readUInt32LE(40) / (channels * (bits / 8));
  const at = (i) => Math.abs(b.readInt16LE(44 + i * 2) / 32768);
  /* 边沿窗口取 4 秒：成品曲目常常从数字静音淡入（洞穴这首第 1 秒整就是 0），
     1 秒窗口会把「渐入」误判成「坏文件」。这里判的是「开头不是全零、中段与结尾真有内容」。 */
  const w = Math.min(n, Math.round(4 * rate));
  let headMax = 0, tailMax = 0;
  for (let i = 0; i < w; i++) { if (at(i) > headMax) headMax = at(i); if (at(n - 1 - i) > tailMax) tailMax = at(n - 1 - i); }
  let midMax = 0;
  const mw = Math.min(n, Math.round(2 * rate));
  for (let i = Math.max(0, Math.round(n / 2) - (mw >> 1)); i < Math.min(n, Math.round(n / 2) + (mw >> 1)); i++) {
    if (at(i) > midMax) midMax = at(i);
  }
  const declared = entry ? entry.bytes : null;
  /* SAMPLE_SECONDS 是「取前 60 秒」的请求量：整曲不足 60 秒时样本就该等于整曲，
     不能拿 60 秒去判它「被剪短」（洞穴这首整曲 48.001 秒）。 */
  const want = Math.min(SAMPLE_SECONDS, (entry && entry.measuredDuration) ? entry.measuredDuration : SAMPLE_SECONDS);
  const pass = c.duration >= want - 2 && c.rms > 0.004 && c.peak > 0.02 &&
    c.peak < 0.98 && c.clipped === 0 && channels === 1 && bits === 16 &&
    headMax > 0 && midMax > 0.01 && tailMax > 0.01 && (declared === null || declared > 0);
  return Object.assign(c, {
    sourceBytes: declared, sampleBytes: fs.statSync(file).size,
    headMax4s: +headMax.toFixed(4), midMax2s: +midMax.toFixed(4), tailMax4s: +tailMax.toFixed(4), pass
  });
}

async function run() {
  await app.whenReady();
  app.setName('方块世界-音乐离线渲染');
  const srv = await createServer({ staticRoot: APP, saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 480, height: 320, show: false, title: '音乐离线渲染',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  const pageUrl = srv.url.replace(/\/index\.html$/, '') + '/tests/render-music.html';
  await win.loadURL(pageUrl);
  let ready = false;
  for (let i = 0; i < 80 && !ready; i++) {
    ready = await win.webContents.executeJavaScript('!!window.__renderMusicTrack && !!window.__analyzeFileTrack');
    if (!ready) await sleep(150);
  }
  if (!ready) {
    console.error('[失败] 渲染页未就绪');
    await srv.close();
    app.exit(1);
    return;
  }
  const tracks = await win.webContents.executeJavaScript('window.__musicTracks');
  const report = [];
  const fileReport = { generatedAt: new Date().toISOString(), measureOnly: MEASURE, tracks: [] };
  for (const id of tracks) {
    const t0 = Date.now();
    const r = await win.webContents.executeJavaScript('window.__renderMusicTrack(' + JSON.stringify(id) + ')');
    const file = path.join(OUT, id + '.wav');
    fs.writeFileSync(file, Buffer.from(r.base64, 'base64'));
    const c = checkWav(file);
    console.log('[渲染·改前] ' + id + ' 用时 ' + (Date.now() - t0) + 'ms → ' + file + ' ' + JSON.stringify(c));
    report.push(c);
  }
  fs.writeFileSync(path.join(OUT, 'render-report.json'), JSON.stringify(report, null, 2));

  const ids = await win.webContents.executeJavaScript('window.__fileTrackIds');
  for (const id of ids) {
    const t0 = Date.now();
    const a = await win.webContents.executeJavaScript('window.__analyzeFileTrack(' + JSON.stringify(id) + ')');
    const entry = FILE_TRACKS[id];
    const synth = report.find(x => x.file === id + '.wav') || null;
    const rec = {
      id, file: entry.file, title: entry.title, licence: entry.licence, author: entry.author,
      source: entry.source, declaredDuration: entry.declaredDuration, registeredBytes: entry.bytes,
      fullTrack: a, sample: null, sampleFile: null,
      loudness: null, pass: true, problems: []
    };
    // 解码得到的字节数必须与登记表一致（防止素材被换掉却忘了改许可表）
    if (a.load && a.load.bytes !== entry.bytes) rec.problems.push('字节数与登记不符：解码 ' + a.load.bytes + ' vs 登记 ' + entry.bytes);
    // 时长与作者页面标注对得上：只拦「比标注短」（被剪短的试听片段），
    // 比标注长是作者自己多铺了一遍循环（forest whisper 实测 164.6s = 1:22 两遍），记成观察值不判红。
    const dm = /^(\d+):(\d\d)$/.exec(entry.declaredDuration);
    const declaredSec = dm ? Number(dm[1]) * 60 + Number(dm[2]) : null;
    rec.durationNote = null;
    if (declaredSec !== null && a.duration + 2 < declaredSec) rec.problems.push('解码时长比页面标注还短，疑似截断：解码 ' + a.duration + 's vs 标注 ' + declaredSec + 's');
    else if (declaredSec !== null && a.duration > declaredSec + 2) rec.durationNote = '整曲 ' + a.duration + 's 是标注 ' + declaredSec + 's 的 ' + (a.duration / declaredSec).toFixed(2) + ' 倍（作者把可循环段落铺了多遍，取整曲作为一段）';
    if (a.nan > 0) rec.problems.push('解码后有 ' + a.nan + ' 个非有限样本');
    if (a.rms <= 0.002) rec.problems.push('整曲 RMS 过低，疑似静音/坏文件');
    if (a.tailRms <= 0.0005) rec.problems.push('结尾 2 秒几乎静音，疑似截断');
    // 试听片段的老毛病是每隔固定时间插一段宽频噪声；这里数孤立瞬态与它们的间隔
    rec.previewNoise = { spikes: a.spikeCount, times: a.spikeTimes, gaps: a.spikeGaps };
    if (a.spikeCount >= 3 && a.spikeGaps.length && (() => {
      const g = a.spikeGaps.filter(x => x > 0);
      if (g.length < 2) return false;
      const mn = Math.min.apply(null, g), mx = Math.max.apply(null, g);
      return mx - mn < 6;                       // 间隔几乎一致 = 周期性噪声
    })()) rec.problems.push('检测到周期性孤立噪声段，疑似带打断的试听版：' + JSON.stringify(a.spikeGaps));
    rec.pass = rec.problems.length === 0;
    console.log('[取证·整曲] ' + id + ' ' + JSON.stringify({
      dur: a.duration, sr: a.sampleRate, ch: a.channels, rms: a.rms, peak: a.peak,
      head: a.headRms, mid: a.midRms, tail: a.tailRms, spikes: a.spikeCount,
      gaps: a.spikeGaps.slice(0, 6), load: a.load
    }) + (rec.problems.length ? ' 问题=' + rec.problems.join(' / ') : ''));
    if (!MEASURE) {
      const s = await win.webContents.executeJavaScript('window.__renderFileTrack(' + JSON.stringify(id) + ',' + SAMPLE_SECONDS + ')');
      const sf = path.join(OUT, id + '-file.wav');
      fs.writeFileSync(sf, Buffer.from(s.base64, 'base64'));
      const c = checkFileSample(sf, entry);
      rec.sample = c; rec.sampleFile = path.basename(sf);
      if (!c.pass) { rec.pass = false; rec.problems.push('样本未通过机器判据：' + JSON.stringify(c)); }
      if (synth && synth.rms > 0) {
        const ratio = c.rms / synth.rms;
        rec.loudness = { synthRms: synth.rms, fileRms: c.rms, ratio: +ratio.toFixed(3), trim: entry.trim };
        if (!(ratio >= 0.6 && ratio <= 1.6)) { rec.pass = false; rec.problems.push('改后响度与改前不同量级：比值 ' + ratio.toFixed(3) + '（要求 0.6~1.6），建议 trim≈' + (entry.trim * synth.rms / Math.max(1e-9, c.rms)).toFixed(3)); }
      }
      console.log('[渲染·改后] ' + id + ' → ' + sf + ' ' + JSON.stringify(c) + ' 响度比=' + JSON.stringify(rec.loudness) + ' 用时 ' + (Date.now() - t0) + 'ms');
    }
    fileReport.tracks.push(rec);
  }
  fileReport.registry = fileTracksReport();
  fs.writeFileSync(path.join(APP, '..', 'artifacts', 'music-files-report.json'), JSON.stringify(fileReport, null, 2));
  await srv.close();

  const bad = report.filter(r => !r.pass);
  const badFiles = fileReport.tracks.filter(r => !r.pass);
  if (bad.length || badFiles.length) {
    console.error('[失败] 合成曲 ' + bad.length + ' 首未通过：' + bad.map(b => b.file).join(', ') +
      ' | 外部曲目 ' + badFiles.length + ' 条未通过：' + badFiles.map(b => b.id + '(' + b.problems.join('; ') + ')').join(' , '));
    app.exit(1);
  } else {
    console.log('[通过] ' + report.length + '/' + report.length + ' 首合成曲 WAV：非静音、无削波、时长 ≥20s、循环边界平顺。' +
      (MEASURE ? '（--measure：只取证，未写样本）' : '[通过] ' + fileReport.tracks.length + '/' + fileReport.tracks.length + ' 条外部曲目：字节与登记一致、解码时长不短于页面标注、无周期性噪声瞬态、样本整段有内容且不削波、开头非数字静音、中段与结尾有信号、响度与改前同量级。') +
      ' 未做人工试听。');
    app.exit(0);
  }
}

run().catch(async (e) => {
  console.error('渲染失败：' + ((e && e.stack) || e));
  app.exit(1);
});
