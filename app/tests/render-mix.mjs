/*
 * 阶段 6 取证：**默认音量**下的游戏混音实录（可听样本）。
 *   cd app && npx electron tests/render-mix.mjs
 *
 * 与 render-music.mjs 的区别：那一个是「离线渲染某一首曲子」，本脚本录的是
 * **真实主循环 + 默认音量（master 0.7 / sfx 0.8 / music 0.45）下 master 之后的总输出**，
 * 也就是玩家实际听到的东西：环境床 + 主曲 + 动作音 + 怪物预警。
 *
 * 做法：在 master 之后接 MediaStreamDestination（与 energyInfo 的静音旁路同一挂点，
 * 但不插 0 增益 —— 这里要的正是可听内容），用 MediaRecorder 录 webm/opus，
 * 再用离线 AudioContext 解码成 WAV 落盘。全程不改产品的任何增益或链路。
 *
 * 覆盖五段（每段都有可判定的读数）：
 *   1) 探索（白天露天，风 + 白天曲）
 *   2) 夜间（虫鸣 + 夜晚曲）
 *   3) 洞穴（滴水 + 洞穴曲）
 *   4) 暂停（主曲与环境床全部释放 → 应当接近底噪）
 *   5) 重进（读档回来，主曲与环境床恢复）
 * 另加一段「挖掘 / 放置 / 挥击 / 受伤」的动作音，用于检查关键音效是否清楚。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'audio', 'mix-stage6');
const SAVES = path.join(APP, 'tests', '.mix-saves');
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  app.setName('方块世界-混音取证');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  /* 录 WebAudio 需要允许自动播放（我们本来就是靠真实手势起 AudioContext） */
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '混音取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => { try { if (win.isDestroyed()) return; win.showInactive(); win.moveTop(); } catch (e) { } }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');

  await win.loadURL(srv.url);
  for (let i = 0; i < 100; i++) {
    if (await evl('return !!(window.__game && window.__test);').catch(() => false)) break;
    await sleep(200);
  }
  /* 真实手势：建 AudioContext（与玩家点画面同一条路） */
  await evl("window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;");
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '混音取证';
    document.querySelector('#inp-seed').value = 'visual-audit-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 240; i++) {
    if (await evl('const G=window.__game; return G.state==="playing" && G.world && G.world.genQueue.length===0;').catch(() => false)) break;
    await sleep(250);
  }
  await sleep(900);

  /* 建立录音链路：master → MediaStreamDestination → MediaRecorder */
  const recOk = await evl(`
    const G = window.__game;
    const ctx = G.sfx.ctx, master = G.sfx.master;
    if (!ctx || !master) return { ok: false, why: 'no-ctx' };
    const dest = ctx.createMediaStreamDestination();
    master.connect(dest);                 // 只旁听，不改任何增益
    window.__rec = { dest, chunks: [], rec: null, ctx };
    return { ok: true, state: ctx.state, sampleRate: ctx.sampleRate, tracks: dest.stream.getAudioTracks().length };
  `);
  console.log('录音链路 =', JSON.stringify(recOk));
  if (!recOk.ok) { await srv.close(); app.exit(1); return; }

  /* 本轮 A5：录音时序修正。
     旧写法把 setup（真实动作）放在 `r.rec.start()` **之前** —— 记录下来的只有动作之后的
     尾音与环境床，6-actions 根本不能证明挖放音效。现在顺序固定为：
       ① 先把场景/状态摆好（不发声的定位、时间、天气）→
       ② 起 MediaRecorder →
       ③ 再执行真实产品交互（鼠标事件 / 输入状态 / 正常交互链路），逐条记事件时点 →
       ④ 留足尾音（动作全部结束后再录 tailMs）→ 停止。
     返回的 events 是「相对录音开始」的毫秒数，报告里同时给出它的绝对值，
     这样「挖了 3 下」能在波形上被对上，而不是靠听起来差不多。 */
  const scene = async (js) => {
    if (!js) return;
    const r = await evl('const G = window.__game, T = window.__test;\n' + js + '\nreturn true;');
    return r;
  };

  const capture = async (label, actionJs, opts = {}) => {
    const tailMs = Number.isFinite(opts.tailMs) ? opts.tailMs : 900;
    const info = await evl(`
      const G = window.__game, T = window.__test;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      ${ACT_LIB}
      const r = window.__rec;
      r.chunks = [];
      r.rec = new MediaRecorder(r.dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 });
      r.rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) r.chunks.push(ev.data); };
      const done = new Promise(res => { r.rec.onstop = res; });
      await sleep(250);
      r.rec.start(200);
      const t0 = performance.now();
      window.__evLog = [];
      window.__evMark = (name, extra) => window.__evLog.push(Object.assign({ name, t: +(performance.now() - t0).toFixed(1) }, extra || {}));
      const stats = { rmsMax: 0, rmsSum: 0, n: 0, peak: 0 };
      let taping = true;
      const meter = (async () => {
        while (taping) {
          const e = T.audioEnergy();
          if (e && e.available) { stats.rmsMax = Math.max(stats.rmsMax, e.rms); stats.rmsSum += e.rms; stats.peak = Math.max(stats.peak, e.peak); stats.n++; }
          await sleep(50);
        }
      })();
      try {
        ${actionJs || ''}
      } catch (e) { window.__evMark('error', { msg: String(e) }); }
      taping = false; await meter;
      const actMs = performance.now() - t0;
      await sleep(${tailMs});
      r.rec.stop();
      await done;
      const blob = new Blob(r.chunks, { type: 'audio/webm' });
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return {
        bytes: bytes.length, b64: btoa(bin), actionMs: Math.round(actMs), tailMs: ${tailMs},
        events: window.__evLog.slice(),
        stats: { rmsMax: +stats.rmsMax.toFixed(6), rmsAvg: +(stats.rmsSum / Math.max(1, stats.n)).toFixed(6), peak: +stats.peak.toFixed(6), n: stats.n },
        music: (() => { const m = T.musicInfo(); return { src: m.source, track: m.trackId, phase: m.cycle && m.cycle.phase, amb: m.activeAmbient, ambSources: m.ambientSources, act: m.activeMusicCount }; })()
      };
    `);
    const raw = path.join(OUT, label + '.webm');
    fs.writeFileSync(raw, Buffer.from(info.b64, 'base64'));
    delete info.b64;
    info.label = label;
    info.file = raw;
    console.log('[录音] ' + label + '.webm ' + (info.bytes / 1024).toFixed(1) + 'KB  动作 ' + info.actionMs +
      'ms + 尾音 ' + info.tailMs + 'ms  ' + JSON.stringify(info.stats));
    if (info.events && info.events.length) console.log('        事件: ' + info.events.map(e => e.t + 'ms ' + e.name).join(' | '));
    return info;
  };

  /* 真实交互小工具：全部走产品的 input.state → interaction.update 链路（不是 T.setBlock） */
  const ACT_LIB = `
    const canvas = document.getElementById('game-canvas');
    G.input.locked = true;                 // 与 pointerlockchange 之后的真实状态一致
    const mouse = (down, button) => canvas.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup',
      { button, bubbles: true, cancelable: true }));
    const hold = async (ms, button) => { mouse(true, button); await sleep(ms); mouse(false, button); };
    /* 站到方块东侧 2.5 格处并盯住它（yaw 与模型正面约定一致） */
    const standAndAim = (bx, by, bz, off) => {
      const d = Number.isFinite(off) ? off : 2.5;
      const px = bx + d, pz = bz + 0.5;
      T.teleport(px, G.world.topSolidY(Math.floor(px), Math.floor(pz)) + 1, pz);
      const dx = (bx + 0.5) - px, dz = (bz + 0.5) - pz;
      T.look(Math.atan2(-dx, -dz), 0.3);
    };
  `;

  /* ---------------- 布景（不发声的定位/时间/天气，录制前完成） ---------------- */
  await scene(`
    T.setTime(0.30);
    T.setWeather('clear', 600); T.tickWeather(0.05, 30);
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    window.__evMark && 0;
  `);

  const all = [];
  all.push(await capture('1-explore-day', `
    await sleep(600);
    window.__evMark('explore-day');
    await sleep(2400);
  `));
  await scene('T.setTime(0.75);');
  all.push(await capture('2-night', `
    await sleep(600);
    window.__evMark('night');
    /* 夜间行走：真的按 W 走两秒（脚步 + 虫鸣 + 夜曲） */
    T.key('KeyW', true);
    window.__evMark('walk-start');
    await sleep(2200);
    T.key('KeyW', false);
    window.__evMark('walk-stop');
    await sleep(1200);
  `));
  /* 布景：挖一条竖井到底（天光归零 → 洞穴曲 + 滴水）。这里只是摆场地，不算动作证据。 */
  await scene(`
    const cx = Math.floor(G.controller.pos.x) + 4, cz = Math.floor(G.controller.pos.z);
    const top = G.world.topSolidY(cx, cz);
    for (let y = top - 9; y <= top + 1; y++) T.setBlock(cx, y, cz, 0);
    T.teleport(cx + 0.5, top - 9, cz + 0.5);
    /* 洞底留一格石头给「真实采矿」挖，脚底下垫实 */
    T.setBlock(cx + 1, top - 9, cz, 3);
    window.__cave = { x: cx + 1, y: top - 9, z: cz };
  `);
  all.push(await capture('3-cave', `
    const caveX = window.__cave.x, caveY = window.__cave.y, caveZ = window.__cave.z;
    window.__evMark('cave-idle');
    await sleep(1200);
    /* 洞穴采矿：真实左键挖那格石头 */
    standAndAim(caveX, caveY, caveZ);
    await sleep(400);
    mouse(true, 0); window.__evMark('dig-down');
    await sleep(1600);
    mouse(false, 0); window.__evMark('dig-up');
    await sleep(800);
  `, { tailMs: 1200 }));
  await scene('G.pause();');
  all.push(await capture('4-pause', `
    window.__evMark('pause');
    await sleep(1400);
  `, { tailMs: 300 }));
  all.push(await capture('5-resume-reload', `
    G.resume();
    window.__evMark('resume');
    await sleep(1200);
  `, { tailMs: 800 }));

  /* 布景：回地表，找一格方块当「真实挖掘」目标 */
  await scene(`
    T.setTime(0.30);
    const px = Math.floor(G.controller.pos.x), pz = Math.floor(G.controller.pos.z);
    T.teleport(px + 0.5, G.world.topSolidY(px, pz) + 1, pz + 0.5);
    const bx = px + 2, bz = pz;
    window.__dig = { x: bx, y: G.world.topSolidY(bx, bz), z: bz };
    G.inventory.set(0, { item: 'pickaxe_iron', count: 1 });
    G.inventory.set(1, { item: 'planks', count: 64 });
    G.selectHotbar(0);
  `);
  all.push(await capture('6-actions', `
    /* 真实的动作音：挖、放、空挥、受伤。每条都走产品出口（不是 T.setBlock）。 */
    const digX = window.__dig.x, digY = window.__dig.y, digZ = window.__dig.z;
    G.selectHotbar(0);
    standAndAim(digX, digY, digZ, 2.2);
    await sleep(500);
    window.__evMark('dig-start');
    mouse(true, 0);
    await sleep(1800);
    mouse(false, 0);
    window.__evMark('dig-break');
    await sleep(600);
    /* 放置：换成木板，对着挖出来的坑底右键（产品 tryPlace 链路） */
    G.selectHotbar(1);
    T.look(G.controller.yaw, 0.55);
    await sleep(300);
    mouse(true, 2); window.__evMark('place-start');
    await sleep(260);
    mouse(false, 2);
    window.__evMark('place-done');
    await sleep(500);
    /* 空挥（不对准方块）：抬头再挥 */
    G.selectHotbar(0);
    T.look(G.controller.yaw, -0.9);
    await sleep(300);
    mouse(true, 0); window.__evMark('swing');
    await sleep(120);
    mouse(false, 0);
    await sleep(600);
    /* 受伤（产品受伤出口） */
    T.hurtPlayer(2, 'melee', '取证：受伤音', { x: G.controller.pos.x + 1, z: G.controller.pos.z, kind: 'slam' });
    window.__evMark('hurt');
    await sleep(700);
  `, { tailMs: 1100 }));

  /* webm → wav：在页面里用离线 AudioContext 解码再编码，避免依赖外部工具 */
  const wavs = await evl(`
    const out = [];
    const files = ${JSON.stringify(all.map(a => ({ label: a.label, b64less: true })).map(a => a.label))};
    return out;
  `);
  /* 转码在 Node 侧做不了（没有 ffmpeg 保证），改为在页面里解码后把 PCM 交回来 */
  const pcmPack = [];
  for (const a of all) {
    const b64 = fs.readFileSync(a.file, 'base64');
    const pcm = await evl(`
      const bin = atob(${JSON.stringify(b64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      let buf;
      try { buf = await ctx.decodeAudioData(bytes.buffer.slice(0)); } catch (e) { return { ok: false, why: String(e) }; }
      const ch = buf.getChannelData(0);
      /* 每 4 个样本取 1 个，48k → 12k，样本足够听清音乐与环境床，体积可接受 */
      const stride = 4;
      const n = Math.floor(ch.length / stride);
      const out = new Float32Array(n);
      let peak = 0, sum = 0;
      for (let i = 0; i < n; i++) { const v = ch[i * stride]; out[i] = v; peak = Math.max(peak, Math.abs(v)); sum += v * v; }
      const bytesOut = new Uint8Array(out.buffer);
      let s = '';
      const CH = 8192;
      for (let i = 0; i < bytesOut.length; i += CH) s += String.fromCharCode.apply(null, bytesOut.subarray(i, i + CH));
      return { ok: true, sr: Math.round(buf.sampleRate / stride), n, peak: +peak.toFixed(5), rms: +Math.sqrt(sum / n).toFixed(6), b64: btoa(s) };
    `);
    if (!pcm.ok) { console.log('[转码失败] ' + a.label + ' ' + pcm.why); continue; }
    pcmPack.push({ label: a.label, ...pcm });
  }

  /* 写 WAV（16-bit PCM） */
  const writeWav = (file, f32, sr) => {
    const n = f32.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
    fs.writeFileSync(file, buf);
    return buf.length;
  };

  const report = [];
  for (const p of pcmPack) {
    const f32 = new Float32Array(Buffer.from(p.b64, 'base64').buffer.slice(0));
    const file = path.join(OUT, p.label + '.wav');
    const bytes = writeWav(file, f32, p.sr);
    const meta = all.find(a => a.label === p.label);
    report.push({
      label: p.label, file, bytes, sampleRate: p.sr, samples: p.n,
      peak: p.peak, rms: p.rms, engine: meta && meta.stats, music: meta && meta.music
    });
    console.log('[WAV] ' + p.label + '.wav ' + (bytes / 1024).toFixed(1) + 'KB  sr=' + p.sr +
      ' peak=' + p.peak + ' rms=' + p.rms + ' 引擎读数=' + JSON.stringify(meta && meta.stats));
  }
  fs.writeFileSync(path.join(OUT, 'mix-report.json'), JSON.stringify(report, null, 2));
  console.log('→ ' + path.join(OUT, 'mix-report.json'));
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
