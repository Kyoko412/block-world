/* 打包版环境声短检查：实际场景、真实录音信号、遮蔽、音量、暂停与退回菜单。 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PREVIEW_SCENES } from '../tools/ambient-audio/preview.mjs';
const ROOT = fileURLToPath(new URL('../../', import.meta.url)), PACK = path.join(ROOT, '游戏/方块世界-环境声');
const OUT = path.join(ROOT, 'artifacts/ambient-audio'), saves = path.join(PACK, 'saves');
fs.mkdirSync(OUT, { recursive: true });
const preserved = new Map([...PREVIEW_SCENES.map(scene => scene.name + '.json'), 'settings.json'].map(name => {
  const file = path.join(saves, name); return [file, fs.existsSync(file) ? fs.readFileSync(file) : null];
}));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const child = spawn(path.join(PACK, '方块世界.exe'), [`--remote-debugging-port=${port}`, '--autoplay-policy=no-user-gesture-required',
  '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { cwd: PACK, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.once('exit', resolve));
let socket, sequence = 0, log = ''; const pending = new Map(), report = { scenes: [] };
child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(body) {
  const result = await command('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
async function sample() {
  return evaluate(`const G=__game,S=G.sfx; S.busEnergy(); await new Promise(r=>setTimeout(r,100));
    let rms=0,peak=0; for(let i=0;i<8;i++){const e=S.busEnergy(); rms=Math.max(rms,e.ambient.rms); peak=Math.max(peak,e.ambient.peak); await new Promise(r=>setTimeout(r,70));}
    return {ambient:S.ambientFilesInfo(), rms, peak, scene:G.audioSceneState(), target:S._ambientTarget(),
      lowpass:S._ambient?.filter.frequency.value, sources:S._ambient?.sources.length||0, fading:S._ambientFading.size,
      music:G.settings.music, mainCount:S.musicInfo().activeMusicCount};`);
}
try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    if (child.exitCode !== null) throw new Error('环境声试玩程序提前退出');
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.type === 'page'); } catch {}
    if (!page) await delay(100);
  }
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => { const message = JSON.parse(event.data), entry = pending.get(message.id); if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); } };
  for (let i = 0; i < 80 && !(await evaluate('return !!window.__game;')); i++) await delay(100);
  for (const preset of PREVIEW_SCENES) {
    await evaluate(`await __game.loadWorld(${JSON.stringify(preset.name)}); __game.sfx.resume(); return true;`);
    for (let i = 0; i < 60; i++) {
      const ready = await evaluate('return __game.sfx.ambientFilesInfo().files.every(f=>f.state==="ready");');
      if (ready) break;
      if (i === 59) throw new Error('环境录音未全部解码');
      await delay(100);
    }
    await delay(1100); const result = await sample();
    report.scenes.push({ preset: preset.label, ...result });
    const expected = preset.id === 'snow' ? 'wind' : preset.id;
    if (result.ambient.active !== expected || result.ambient.source !== 'file' || result.sources !== 1) throw new Error(preset.label + ' 没有播放正确的唯一录音：' + JSON.stringify(result));
    if (result.music || result.mainCount !== 0) throw new Error('试玩环境应独立于背景音乐播放');
    if (!(result.rms > 1e-6)) throw new Error(preset.label + ' 的环境总线没有实际信号');
    if (preset.id === 'rain') {
      await evaluate('window.__rainSource=__game.sfx._ambient.sources[0]; const G=__game; G.controller.setPositions(-4.5,G.controller.pos.y,0.5); return true;');
      await delay(1400); const inside = await sample();
      inside.sameSource = await evaluate('return __game.sfx._ambient.sources[0]===window.__rainSource;'); report.shelter = inside;
      if (!inside.scene.sheltered || inside.ambient.active !== 'rain' || !inside.sameSource || inside.target >= result.target || inside.lowpass > 1800) throw new Error('屋内雨声没有正确遮蔽或重复启动');
    }
  }
  // 回到白天，走产品设置入口检验音乐开关、静音与恢复。
  await evaluate(`await __game.loadWorld(${JSON.stringify(PREVIEW_SCENES[0].name)}); return true;`);
  await delay(1000); const normal = await sample();
  await evaluate('window.__source=__game.sfx._ambient.sources[0]; await __game.applySettingsLive({music:true}); return true;');
  await delay(150);
  await evaluate('await __game.applySettingsLive({music:false}); return true;'); await delay(1000);
  report.musicOff = await sample();
  report.musicOff.sameSource = await evaluate('return __game.sfx._ambient.sources[0]===window.__source;');
  if (!report.musicOff.sameSource || report.musicOff.mainCount !== 0 || report.musicOff.rms <= 1e-6) throw new Error('关音乐影响了环境录音');
  await evaluate('await __game.applySettingsLive({volumeSfx:0}); return true;'); await delay(1500); report.muted = await sample();
  if (report.muted.rms > Math.max(1e-5, normal.rms * 0.02)) throw new Error('音效滑条为零时环境未静音');
  await evaluate('await __game.applySettingsLive({volumeSfx:0.8}); return true;'); await delay(700); report.restored = await sample();
  if (report.restored.rms <= report.muted.rms * 5) throw new Error('调高音效滑条后环境未恢复');
  await evaluate('__game.pause(); return true;'); await delay(1100); report.paused = await sample();
  if (report.paused.sources || report.paused.fading || report.paused.rms > 1e-5) throw new Error('暂停后环境声源或信号未释放');
  await evaluate('__game.resume(); return true;'); await delay(1000); report.resumed = await sample();
  if (report.resumed.sources !== 1 || report.resumed.ambient.source !== 'file' || report.resumed.rms <= 1e-6) throw new Error('恢复后环境录音未回来');
  // 快速改变场景选择只核对声源上限；不进行寻路或通关。
  report.rapid = await evaluate(`const S=__game.sfx; const rows=[]; for(const state of [{night:true},{weather:'rain',intensity:1},{underground:true},{underwater:true},{}]){S.updateAmbient(state); rows.push({active:S._ambientId,sources:S._ambient.sources.length,fading:S._ambientFading.size});}return rows;`);
  if (report.rapid.some(row => row.sources !== 1 || row.fading > 1)) throw new Error('快速切场景叠了多个环境床');
  await evaluate('__game.updateAudioScene(); return true;'); await delay(200);
  const image = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, '环境试听场景.png'), Buffer.from(image.data, 'base64'));
  await evaluate('__game.disposeWorld(); __game.state="menu"; return true;'); await delay(1200);
  report.exited = await evaluate('return {info:__game.sfx.ambientFilesInfo(),energy:__game.sfx.busEnergy().ambient};');
  if (report.exited.info.active || report.exited.info.fading || report.exited.energy.rms > 1e-5) throw new Error('退出世界后环境未释放');
  fs.writeFileSync(path.join(OUT, 'ambient-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, scenes: report.scenes.map(s => ({ scene: s.preset, file: s.ambient.active, rms: s.rms })), shelter: report.shelter.sameSource, musicOff: report.musicOff.sameSource, pauseReleased: !report.paused.sources, exitReleased: !report.exited.info.active }, null, 2));
  socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
} catch (error) {
  report.error = String(error.stack || error); fs.writeFileSync(path.join(OUT, 'ambient-smoke.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'ambient-smoke-startup.log'), log); console.error(error.stack || error); process.exitCode = 1;
} finally {
  socket?.close(); if (child.exitCode === null) child.kill(); await exited;
  for (const [file, bytes] of preserved) { if (bytes) fs.writeFileSync(file, bytes); else if (fs.existsSync(file)) fs.unlinkSync(file); }
}
