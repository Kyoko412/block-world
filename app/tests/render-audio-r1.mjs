/*
 * 第一轮品质收敛：真实操作/战斗实录 + 分轨（本轮 A5 / D3 共用）。
 *   cd app && npx electron tests/render-audio-r1.mjs [--tag r1] [--only 1,3]
 *
 * 与旧 render-mix.mjs 的差别（这些差别就是本轮 A5 要证明的东西）：
 *   ① **先开录，再动作**。每个场景分「布景」与「动作」两段：布景（时间/天气/传送/挖场地）
 *      在录音之前完成；录音开始后才执行正常产品交互（真实 mousedown / keydown / 交互链路），
 *      动作全部结束后再留尾音才停止。
 *   ② 不复用 T.setBlock 冒充挖放：挖掘走 interaction.startMining/mineTick（左键按住），
 *      放置走 interaction.tryPlace（右键），音效由产品自己的 Sfx 出口播放。
 *   ③ 同时录 **master / 音效 / 音乐 / 环境** 四条，便于定位「是哪一层出的问题」；
 *      事件时点写进报告（相对录音开始的毫秒数）。
 *   ④ 每条轨都做信号分析：总 RMS/峰值、<120Hz 占比（本轮洞穴常驻低频的量化）、削波。
 *
 * 覆盖四段（任务书要求）：地表挖放、夜晚移动、洞穴采矿、守卫交战。
 * 声音事实边界：本会话没有音频输入能力，报告只写信号与触发事实，不写「好听/不好听」。
 */
import { app, BrowserWindow, powerSaveBlocker } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const TAG = (() => { const i = process.argv.indexOf('--tag'); return i > 0 ? process.argv[i + 1] : 'r1'; })();
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i < 0) return null;
  return String(process.argv[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
})();
const OUT = path.join(APP, '..', 'artifacts', 'audio', 'round1', TAG);
const SAVES = path.join(APP, 'tests', '.audio-r1-saves-' + TAG);
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function writeWav(file, f32, sr) {
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
}

async function run() {
  await app.whenReady();
  app.setName('方块世界-实录取证');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({
    width: 1280, height: 720, show: true, title: '实录取证',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.show(); win.focus();
  const psb = powerSaveBlocker.start('prevent-display-sleep');
  const keep = setInterval(() => { try { if (win.isDestroyed()) return; win.showInactive(); win.moveTop(); } catch (e) { } }, 500);
  win.on('closed', () => { clearInterval(keep); try { powerSaveBlocker.stop(psb); } catch (e) { } });
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  const log = (...a) => process.stdout.write(a.join(' ') + '\n');

  await win.loadURL(srv.url);
  for (let i = 0; i < 150; i++) {
    if (await evl('return !!(window.__game && window.__test);').catch(() => false)) break;
    await sleep(200);
  }
  await evl("window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;");
  await evl(`
    document.querySelector('[data-a=new]').click();
    document.querySelector('#inp-name').value = '实录';
    document.querySelector('#inp-seed').value = 'guardian-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 300; i++) {
    const ready = await evl('const G=window.__game; return G.state==="playing" && G.world && G.world.genQueue.length===0;').catch(() => false);
    if (ready) break;
    await sleep(250);
  }
  await sleep(1200);

  /* ---- 四条分轨的取样链路：只旁听，不改任何增益 ----
     用 ScriptProcessorNode 直接抓每个总线的 PCM，而不是 MediaRecorder：
     实测 MediaRecorder 对「长时间静音」的 WebAudio 流会跳过静音段，
     音效轨只剩 0.66 秒 —— 那样事件时点就没法和音频对齐，等于又回到「说不清什么时候响」。
     这里按块累积 Float32，采样点对齐、静音也照收。 */
  const taps = await evl(`
    const G = window.__game;
    const ctx = G.sfx.ctx;
    if (!ctx) return { ok: false, why: 'no-ctx' };
    const nodes = {
      master: G.sfx.master, sfx: G.sfx.sfxBus, music: G.sfx.musicBus, ambient: G.sfx.ambientBus
    };
    window.__tap = { on: false, chunks: {}, procs: {}, sr: ctx.sampleRate };
    for (const [name, node] of Object.entries(nodes)) {
      if (!node) continue;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      window.__tap.chunks[name] = [];
      proc.onaudioprocess = (e) => {
        if (!window.__tap.on) return;
        window.__tap.chunks[name].push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      node.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
      window.__tap.procs[name] = { proc, mute };
    }
    window.__tapReset = () => { for (const k of Object.keys(window.__tap.chunks)) window.__tap.chunks[k] = []; window.__tap.on = true; };
    window.__tapStop = () => { window.__tap.on = false; };
    window.__tapTake = (name) => {
      const list = window.__tap.chunks[name] || [];
      let n = 0; for (const c of list) n += c.length;
      const out = new Float32Array(n);
      let o = 0; for (const c of list) { out.set(c, o); o += c.length; }
      window.__tap.chunks[name] = [];
      return out;
    };
    return {
      ok: true, state: ctx.state, sampleRate: ctx.sampleRate,
      buses: Object.fromEntries(Object.entries(nodes).map(([k, v]) => [k, !!v]))
    };
  `);
  log('录音链路 = ' + JSON.stringify(taps));
  if (!taps.ok) { await srv.close(); app.exit(1); return; }

  const scene = (js) => evl('const G = window.__game, T = window.__test;\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n' + (js || '') + '\nreturn true;');

  /* 每段：先布景 → 起 4 路 MediaRecorder → 动作 → 尾音 → 停 → 取 PCM 分析 */
  const capture = async (label, opts) => {
    const tailMs = opts.tailMs === undefined ? 1100 : opts.tailMs;
    const info = await evl(`
      const G = window.__game, T = window.__test;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const canvas = document.getElementById('game-canvas');
      G.input.locked = true;
      const mouse = (down, button) => canvas.dispatchEvent(new MouseEvent(down ? 'mousedown' : 'mouseup',
        { button, bubbles: true, cancelable: true }));
      const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup',
        { code, bubbles: true, cancelable: true }));
      const standAndAim = (bx, by, bz, off) => {
        const d = Number.isFinite(off) ? off : 2.5;
        const px = bx + d, pz = bz + 0.5;
        T.teleport(px, G.world.topSolidY(Math.floor(px), Math.floor(pz)) + 1, pz);
        T.look(Math.atan2(-((bx + 0.5) - px), -((bz + 0.5) - pz)), 0.32);
      };
      const recs = {};
      window.__tapReset();
      await sleep(120);
      const t0 = performance.now();
      window.__ev = [];
      const mark = (name, extra) => window.__ev.push(Object.assign({ name, t: +(performance.now() - t0).toFixed(1) }, extra || {}));
      const stats = { rmsMax: 0, peak: 0, n: 0, sum: 0 };
      let taping = true;
      const meter = (async () => {
        while (taping) {
          const e = T.audioEnergy();
          if (e && e.available) { stats.rmsMax = Math.max(stats.rmsMax, e.rms); stats.peak = Math.max(stats.peak, e.peak); stats.sum += e.rms * e.rms; stats.n++; }
          await sleep(50);
        }
      })();
      try { ${opts.action || ''} } catch (e) { mark('error', { msg: String(e && (e.stack || e.message)) }); }
      taping = false; await meter;
      const actMs = Math.round(performance.now() - t0);
      await sleep(${tailMs});
      window.__tapStop();
      const sizes = {};
      for (const name of ['master', 'sfx', 'music', 'ambient']) {
        const pcm = window.__tapTake(name);
        window.__pcmStore = window.__pcmStore || {};
        window.__pcmStore[${JSON.stringify(label)}] = window.__pcmStore[${JSON.stringify(label)}] || {};
        window.__pcmStore[${JSON.stringify(label)}][name] = pcm;
        sizes[name] = pcm.length;
      }
      return {
        actionMs: actMs, tailMs: ${tailMs},
        events: window.__ev.slice(),
        engine: { rmsMax: +stats.rmsMax.toFixed(6), peak: +stats.peak.toFixed(6), rmsAvg: +(Math.sqrt(stats.sum / Math.max(1, stats.n))).toFixed(6), n: stats.n },
        sizes,
        music: (() => { const m = T.musicInfo(); return { src: m.source, track: m.trackId, amb: m.activeAmbient, ambSources: m.ambientSources, count: m.activeMusicCount, busGainTotal: m.busGainTotal, busTarget: m.busTarget }; })()
      };
    `);
    /* 逐个分轨分析（在页面里做，避免 Node 侧依赖 ffmpeg） */
    const tracks = {};
    for (const name of ['master', 'sfx', 'music', 'ambient']) {
      if (!info.sizes[name]) { tracks[name] = { bytes: 0, silent: true }; continue; }
      const a = await evl(`
        const name = ${JSON.stringify(name)};
        const ch = window.__pcmStore[${JSON.stringify(label)}][name];
        const sr = window.__tap.sr;
        let peak = 0, sum = 0, clip = 0;
        for (let i = 0; i < ch.length; i++) { const v = ch[i]; const av = Math.abs(v); if (av > peak) peak = av; if (av > 0.999) clip++; sum += v * v; }
        const rms = Math.sqrt(sum / Math.max(1, ch.length));
        const seg = Math.max(1, Math.round(sr * 0.25));
        const segs = [];
        for (let i = 0; i + seg <= ch.length; i += seg) {
          let s2 = 0;
          for (let k = 0; k < seg; k++) s2 += ch[i + k] * ch[i + k];
          segs.push(+Math.sqrt(s2 / seg).toFixed(5));
        }
        const bandRms = async (filterType, freq, q) => {
          const off = new OfflineAudioContext(1, Math.max(1, ch.length), sr);
          const b = off.createBuffer(1, Math.max(1, ch.length), sr);
          b.copyToChannel(ch, 0);
          const src = off.createBufferSource(); src.buffer = b;
          const f = off.createBiquadFilter();
          f.type = filterType; f.frequency.value = freq; f.Q.value = q === undefined ? 0.707 : q;
          src.connect(f); f.connect(off.destination); src.start();
          const out = await off.startRendering();
          const d = out.getChannelData(0);
          let s3 = 0;
          for (let i = 0; i < d.length; i++) s3 += d[i] * d[i];
          return Math.sqrt(s3 / Math.max(1, d.length));
        };
        const low = await bandRms('lowpass', 120);
        const mid = await bandRms('bandpass', 700, 0.6);
        const high = await bandRms('highpass', 2000);
        const totalE = rms * rms;
        /* 落盘：24kHz 单声道 16bit，足够试听；分析用的是原始 48k */
        const stride = 2;
        const n2 = Math.floor(ch.length / stride);
        const out = new Float32Array(n2);
        for (let i = 0; i < n2; i++) out[i] = ch[i * stride];
        const bytesOut = new Uint8Array(out.buffer);
        let s4 = '';
        const CH = 8192;
        for (let i = 0; i < bytesOut.length; i += CH) s4 += String.fromCharCode.apply(null, bytesOut.subarray(i, i + CH));
        return {
          ok: true, sr: Math.round(sr / stride), srcSr: sr, samples: n2, seconds: +(ch.length / sr).toFixed(3),
          peak: +peak.toFixed(5), rms: +rms.toFixed(6), clip,
          low120: +low.toFixed(6), mid700: +mid.toFixed(6), high2k: +high.toFixed(6),
          lowShare: totalE > 0 ? +(low * low / totalE).toFixed(4) : null,
          segs, b64: btoa(s4)
        };
      `);
      if (!a.ok) { tracks[name] = { error: a.why }; continue; }
      const file = path.join(OUT, label + '--' + name + '.wav');
      const bytes = writeWav(file, new Float32Array(Buffer.from(a.b64, 'base64').buffer.slice(0)), a.sr);
      delete a.b64;
      tracks[name] = Object.assign({ file, bytes }, a);
    }
    await evl('if (window.__pcmStore) delete window.__pcmStore[' + JSON.stringify(label) + ']; return true;');
    const rec = {
      label, scene: opts.title || label, actionMs: info.actionMs, tailMs: info.tailMs,
      events: info.events, engine: info.engine, music: info.music, tracks
    };
    log('[实录] ' + label + '  动作 ' + info.actionMs + 'ms + 尾音 ' + info.tailMs + 'ms  事件 ' +
      info.events.map(e => e.t + ':' + e.name).join(' '));
    for (const [n, t] of Object.entries(tracks)) {
      if (!t || t.error || t.silent) { log('    ' + n.padEnd(7) + ' 无内容 ' + (t && t.error ? t.error : '')); continue; }
      log('    ' + n.padEnd(7) + ' ' + String(t.seconds).padStart(6) + 's  rms=' + t.rms.toFixed(4) +
        ' peak=' + t.peak.toFixed(3) + ' <120Hz占比=' + (t.lowShare === null ? '-' : (t.lowShare * 100).toFixed(1) + '%') +
        ' clip=' + t.clip + '  ' + path.basename(t.file));
    }
    if (info.events.some(e => e.name === 'error')) log('    ⚠ 动作里出错：' + JSON.stringify(info.events.filter(e => e.name === 'error')));
    return rec;
  };

  const results = [];
  const want = (k) => !ONLY || ONLY.includes(String(k));

  /* ============ 1. 地表挖放（挖土块 → 放回木板） ============ */
  if (want(1)) {
    await scene(`
      T.setTime(0.32);
      T.setWeather('clear', 600); T.tickWeather(0.05, 30);
      G.controller.setCreative(false); G.controller.health = 20; G.controller.invulnerable = 0;
      G.mobs.maxMobs = 0; G.mobs.clear();
      const px = Math.floor(G.controller.pos.x), pz = Math.floor(G.controller.pos.z);
      T.teleport(px + 0.5, G.world.topSolidY(px, pz) + 1, pz + 0.5);
      const bx = px + 3, bz = pz;
      const by = G.world.topSolidY(bx, bz);
      T.setBlock(bx, by, bz, T.blockIds.DIRT);
      window.__t = { x: bx, y: by, z: bz };
      G.inventory.clear();
      G.inventory.add('shovel_wood', 2); G.inventory.add('planks', 16); G.inventory.add('dirt', 8);
      G.inventory.select(0);
    `);
    results.push(await capture('1-地表挖放', {
      title: '地表：真实左键挖土 + 右键放木板（默认音量，白天）',
      tailMs: 1200,
      action: `
        const t = window.__t;
        standAndAim(t.x, t.y, t.z, 2.6); await sleep(500);
        G.inventory.select(G.inventory.slots.findIndex(s => s && s.item === 'shovel_wood'));
        mark('dig-down');
        mouse(true, 0);
        for (let i = 0; i < 40; i++) { if (T.blockAt(t.x, t.y, t.z).id === 0) break; await sleep(60); }
        mark('dirt-broken');
        mouse(false, 0);
        await sleep(450);
        /* 放木板：手里换成木板，对着坑底右键（走 interaction.tryPlace） */
        G.inventory.select(G.inventory.slots.findIndex(s => s && s.item === 'planks'));
        T.look(G.controller.yaw, 0.75);
        await sleep(250);
        mark('place-down');
        mouse(true, 2); await sleep(220); mouse(false, 2);
        mark('place-up');
        await sleep(400);
        mark('done');
      `
    }));
  }

  /* ============ 2. 夜晚移动 ============ */
  if (want(2)) {
    await scene(`
      T.setTime(0.78);
      T.setWeather('clear', 600);
      G.controller.health = 20; G.controller.invulnerable = 0;
      G.mobs.maxMobs = 6;
      const px = Math.floor(G.controller.pos.x), pz = Math.floor(G.controller.pos.z);
      T.teleport(px + 0.5, G.world.topSolidY(px, pz) + 1, pz + 0.5);
      G.inventory.select(0);
    `);
    results.push(await capture('2-夜晚移动', {
      title: '夜晚：真实 WASD 走动（脚步 + 虫鸣 + 夜曲），默认音量',
      tailMs: 1400,
      action: `
        await sleep(700); mark('idle');
        mark('walk-start');
        key('KeyW', true); await sleep(1500);
        key('KeyA', true); await sleep(900);
        key('KeyA', false); key('KeyD', true); await sleep(900);
        key('KeyD', false); await sleep(400);
        key('KeyW', false); key('KeyS', true); await sleep(800); key('KeyS', false);
        mark('walk-stop');
        await sleep(500);
        mark('done');
      `
    }));
  }

  /* ============ 3. 洞穴采矿（负 Y：真正的地下层，触发洞穴环境床） ============ */
  if (want(3)) {
    await scene(`
      T.setTime(0.32);
      G.controller.health = 20; G.controller.invulnerable = 0;
      G.mobs.maxMobs = 0; G.mobs.clear();
      const px = Math.floor(G.controller.pos.x), pz = Math.floor(G.controller.pos.z);
      const top = G.world.topSolidY(px, pz);
      /* 本轮 D：洞穴段必须真的在 y<0（旧版只挖到地表下 12 格，洞穴环境床根本没触发，
         录到的「<120Hz 占比」不能代表洞穴常驻低频）。这里挖到 y=-20，与审计的深洞同层。 */
      const cy = -20;
      for (let y = cy; y <= top; y++) T.setBlock(px, y, pz, 0);
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 0; dy < 3; dy++) {
        T.setBlock(px + dx, cy + dy, pz + dz, 0);
      }
      T.setBlock(px + 2, cy, pz, T.blockIds.STONE);
      T.teleport(px + 0.5, cy, pz + 0.5);
      window.__c = { x: px + 2, y: cy, z: pz, depth: cy };
      G.inventory.clear();
      G.inventory.add('pickaxe_iron', 1); G.inventory.add('torch', 16);
      G.inventory.select(0);
      await sleep(1400);            // 等环境床切换 + 场景判定稳定
    `);
    results.push(await capture('3-洞穴采矿', {
      title: '洞穴（地下 12 格）：真实左键采矿 + 放火把，默认音量',
      tailMs: 1400,
      action: `
        const c = window.__c;
        await sleep(500); mark('cave-idle');
        standAndAim(c.x, c.y, c.z, 2.4); await sleep(400);
        mark('mine-down');
        mouse(true, 0);
        for (let i = 0; i < 70; i++) { if (T.blockAt(c.x, c.y, c.z).id === 0) break; await sleep(60); }
        mark('stone-broken');
        mouse(false, 0);
        await sleep(500);
        /* 放火把：换成火把右键墙边（走 tryPlace） */
        G.inventory.select(G.inventory.slots.findIndex(s => s && s.item === 'torch'));
        T.look(G.controller.yaw, 0.5);
        await sleep(250);
        mark('torch-place');
        mouse(true, 2); await sleep(220); mouse(false, 2);
        await sleep(700);
        mark('done');
      `
    }));
  }

  /* ============ 4. 守卫交战 ============ */
  if (want(4)) {
    await scene(`
      T.setTime(0.32);
      G.controller.health = 20; G.controller.invulnerable = 0;
      G.mobs.maxMobs = 8; G.mobs.clear();
      G.input.setUIMode(false);
      return true;
    `);
    /* 走到地标：等它建出来（产品自己的扫描），再解封 */
    const site = await evl(`
      const G = window.__game, T = window.__test;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const until = async (fn, ms) => { const t0 = performance.now(); for (;;) { if (fn()) return true; if (performance.now() - t0 > ms) return false; await sleep(150); } };
      await until(() => G.landmarkCandidates().length > 0, 12000);
      const c0 = T.landmarkCandidates()[0];
      if (!c0) return { ok: false, why: 'no-candidate' };
      T.teleport(c0.x + 0.5, G.world.topSolidY(Math.floor(c0.x), Math.floor(c0.z)) + 1, c0.z + 0.5);
      G.world.setCenter(c0.x, c0.z);
      await until(() => Object.values(G.landmarks || {}).some(l => l && l.built), 25000);
      const s = T.guardianSite();
      if (!s) return { ok: false, why: 'no-site' };
      await until(() => T.guardianWards().pedestals.length === 4, 12000);
      for (const p of T.guardianWards().pedestals) T.setBlock(p.x, p.y, p.z, T.blockIds.DEEPSLATE);
      await until(() => T.guardianWards().armed === true, 8000);
      T.teleport(s.x + 5.5, G.world.topSolidY(Math.floor(s.x) + 5, Math.floor(s.z) + 5) + 1, s.z + 5.5);
      G.world.setCenter(s.x, s.z);
      await until(() => T.guardianInfo().present, 20000);
      const info = T.guardianInfo();
      return { ok: !!info.present, site: { id: s.id, x: s.x, y: s.y, z: s.z }, stand: info.stand, pos: info.pos, phase: info.phase };
    `);
    log('守卫现场 = ' + JSON.stringify(site));
    if (site.ok) {
      results.push(await capture('4-守卫交战', {
        title: '遗迹：真实交战（接近 → 前摇 → 举盾/闪避 → 反击命中），默认音量',
        tailMs: 1500,
        action: `
          const G2 = window.__game;
          G2.inventory.clear();
          G2.inventory.add('sword_iron', 1); G2.inventory.add('shield', 1);
          G2.inventory.select(0);
          const gm = () => G2.mobs.guardianMob();
          const face = () => {
            const m = gm(); if (!m) return;
            const dx = m.pos.x - G2.controller.pos.x, dz = m.pos.z - G2.controller.pos.z;
            G2.controller.yaw = Math.atan2(-dx, -dz); G2.controller.pitch = 0.05;
          };
          const swing = async () => {
            face();
            G2.input.state.mouseLeft = false; await sleep(40);
            G2.input.state.mouseLeft = true; await sleep(60);
            G2.input.state.mouseLeft = false;
            await sleep(420);
          };
          await sleep(600); mark('approach');
          for (let k = 0; k < 26; k++) {
            const m = gm();
            if (!m) break;
            /* 站到守卫侧面 2.2 格（横扫射程内），保持朝向 */
            const ang = (k % 4) * Math.PI / 2;
            const tx = m.pos.x + Math.cos(ang) * 2.2, tz = m.pos.z + Math.sin(ang) * 2.2;
            const gy = G2.world.topSolidY(Math.floor(tx), Math.floor(tz));
            if (Math.abs(gy + 1 - m.pos.y) < 2) T.teleport(tx, gy + 1, tz);
            const ph = T.guardianInfo().phase;
            if (ph === 'telegraph') {
              mark('guardian-telegraph', { attack: T.guardianInfo().attack });
              G2.input.state.mouseRight = true;         // 举盾
              await sleep(700);
              G2.input.state.mouseRight = false;
              mark('shield-up');
            } else {
              await swing();
            }
            G2.controller.health = 20; G2.controller.invulnerable = 0;
          }
          mark('fight-end', { hp: T.guardianInfo().hp, phase: T.guardianInfo().phase });
          await sleep(400);
        `
      }));
    } else {
      log('⚠ 守卫现场没建起来：' + JSON.stringify(site));
    }
  }

  const report = {
    at: new Date().toISOString(),
    tag: TAG,
    note: '先开录再动作；事件时点相对录音开始（毫秒）。分轨 = master/sfx/music/ambient，只旁听不改增益。' +
      '本次会话没有音频输入能力：报告只给信号事实（RMS/峰值/频段占比/削波/分段 RMS），不给主观听感结论。',
    taps, recordings: results
  };
  fs.writeFileSync(path.join(OUT, 'audio-r1-report.json'), JSON.stringify(report, null, 2));
  log('→ ' + path.join(OUT, 'audio-r1-report.json'));
  await srv.close();
  app.exit(0);
}
run().catch((e) => { console.error(e); app.exit(1); });
