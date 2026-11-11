// Short packaged-game check only. No survival route, navigation or mining automation.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PREVIEW_NAME } from '../tools/movement-audio/preview.mjs';
import { monoWave } from '../tools/movement-audio/wave.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACK = path.join(ROOT, '游戏/方块世界-移动音效');
const OUT = path.join(ROOT, 'artifacts/audio/movement-20261110');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
fs.mkdirSync(OUT, { recursive: true });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
const child = spawn(path.join(PACK, '方块世界.exe'), [`--remote-debugging-port=${port}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  { cwd: PACK, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', socket, sequence = 0;
child.stdout.on('data', bytes => { log += bytes.toString(); });
child.stderr.on('data', bytes => { log += bytes.toString(); });
const pending = new Map();
function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const key = (code, down) => command('Input.dispatchKeyEvent', { type: down ? 'keyDown' : 'keyUp', code, key: ({ KeyW: 'w', ControlLeft: 'Control', ShiftLeft: 'Shift', Space: ' ' })[code],
  windowsVirtualKeyCode: ({ KeyW: 87, ControlLeft: 17, ShiftLeft: 16, Space: 32 })[code] });
const results = [];
try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    if (child.exitCode !== null) throw new Error('Packaged game exited before startup: ' + child.exitCode);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch { /* local server is starting */ }
    if (!page) await delay(150);
  }
  if (!page) throw new Error('Packaged game did not expose its startup page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
  };
  for (let i = 0; i < 80 && !(await evaluate('return !!window.__game;')); i++) await delay(100);
  const worlds = await evaluate('return await window.__game.storage.listWorlds();');
  if (!worlds.some(world => world.name === PREVIEW_NAME)) throw new Error('Packaged game cannot see its supplied preview world');
  await evaluate(`await window.__game.loadWorld(${JSON.stringify(PREVIEW_NAME)}); window.__game.sfx.resume(); return window.__game.state;`);
  for (let i = 0; i < 50; i++) {
    const files = await evaluate('return window.__game.sfx.sfxFilesInfo();');
    if (files.files.every(file => file.state === 'ready')) break;
    if (i === 49) throw new Error('Packaged audio decoding incomplete: ' + JSON.stringify(files));
    await delay(100);
  }
  await evaluate(`const G=window.__game,ctx=G.sfx.ctx;
    const tap=ctx.createScriptProcessor(2048,1,1),silent=ctx.createGain();silent.gain.value=0;
    const chunks=[];tap.onaudioprocess=e=>chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    G.sfx.master.connect(tap);tap.connect(silent);silent.connect(ctx.destination);
    window.__movementCapture={tap,silent,chunks,sampleRate:ctx.sampleRate};
    /* 逐条记录实际播放的调用：stats().last 只是全模块最后一条事件，附近生物/弹跳会把它覆盖掉，
       曾出现 sneak 读成 slime、雪道落地读成 slime 的误判。 */
    window.__events=[];
    const original=G.sfx.play.bind(G.sfx);
    G.sfx.play=(name,opts)=>{try{window.__events.push({name,volume:opts&&opts.volume});}catch{}return original(name,opts);};
    return true;`);
  const fileInfo = await evaluate('return window.__game.sfx.sfxFilesInfo();');
  const readyIds = new Set(fileInfo.files.filter(file => file.state === 'ready').map(file => file.id));
  for (const [lane, material] of ['grass', 'stone', 'wood', 'sand', 'snow'].entries()) {
    await evaluate(`const G=window.__game;G.controller.setPositions(${1.5 + lane * 5},49.02,4.5);G.controller.yaw=0;window.__events.length=0;return true;`);
    await delay(180);
    await key('KeyW', true); await delay(850); await key('KeyW', false); await delay(150);
    await key('Space', true); await delay(50); await key('Space', false); await delay(850);
    const events = await evaluate('return window.__events.slice()');
    const steps = events.filter(event => String(event.name).startsWith('step_' + material)).length;
    const lands = events.filter(event => String(event.name).startsWith('land_' + material));
    const fromFile = steps > 0 && lands.every(land => readyIds.has(land.name));
    if (steps < 1 || lands.length !== 1 || !fromFile) {
      throw new Error(material + ' did not play recorded steps and one landing: ' +
        JSON.stringify({ steps, lands, events: events.map(event => event.name) }));
    }
    results.push({ material, steps, lands: lands.length, landName: lands[0].name, lastSource: 'file' });
  }
  const modes = {};
  for (const mode of ['walk', 'run', 'sneak']) {
    await evaluate('window.__events.length=0;window.__game.controller.setPositions(1.5,49.02,4.5);window.__game.controller.yaw=0;return true;');
    await delay(200);
    if (mode === 'run') await key('ControlLeft', true);
    if (mode === 'sneak') await key('ShiftLeft', true);
    await key('KeyW', true); await delay(1000); await key('KeyW', false);
    await key('ControlLeft', false); await key('ShiftLeft', false);
    await delay(120);
    const events = await evaluate('return window.__events.slice()');
    const steps = events.filter(event => String(event.name).startsWith('step_'));
    if (!steps.length) throw new Error(mode + ' produced no footstep sound: ' + JSON.stringify(events));
    const lastStep = steps[steps.length - 1];
    modes[mode] = { steps: steps.length, name: lastStep.name, volume: lastStep.volume };
  }
  if (!(modes.run.volume > modes.walk.volume && modes.walk.volume > modes.sneak.volume)) throw new Error('Walk/run/sneak force did not follow the movement state: ' + JSON.stringify(modes));
  const pauseBefore = await evaluate('window.__game.pause();return window.__game.sfx.stats().played;');
  await delay(300);
  const pauseAfter = await evaluate('return window.__game.sfx.stats().played;');
  if (pauseBefore !== pauseAfter) throw new Error('New sounds were scheduled while paused');
  await evaluate('window.__game.resume(); return true;');
  await evaluate('window.__game.controller.setPositions(11.5,49.02,7.5);window.__game.controller.yaw=0.55;window.__game.controller.pitch=-0.23;return true;');
  await delay(200);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '试听世界.png'), Buffer.from(screenshot.data, 'base64'));
  const audio = await evaluate(`const capture=window.__movementCapture;window.__game.sfx.master.disconnect(capture.tap);capture.tap.disconnect();capture.silent.disconnect();
    const length=capture.chunks.reduce((n,c)=>n+c.length,0),signal=new Float32Array(length);let offset=0;
    for(const chunk of capture.chunks){signal.set(chunk,offset);offset+=chunk.length;}
    const bytes=new Uint8Array(signal.buffer);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {base64:btoa(binary),sampleRate:capture.sampleRate};`);
  const pcm = Buffer.from(audio.base64, 'base64');
  const signal = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  let peak = 0, sum = 0;
  for (const sample of signal) { peak = Math.max(peak, Math.abs(sample)); sum += sample * sample; }
  if (peak <= 0.001 || peak >= 1) throw new Error('Captured output is silent or digitally clipped: ' + peak);
  fs.writeFileSync(path.join(OUT, '实机移动试玩.wav'), monoWave(signal, audio.sampleRate));
  fs.writeFileSync(path.join(OUT, 'smoke.json'), JSON.stringify({ results, modes, pausedNoNewSounds: true, seconds: signal.length / audio.sampleRate, peak, rms: Math.sqrt(sum / signal.length) }, null, 2));
  console.log(JSON.stringify({ results, modes, startup: 'packaged executable', pausedNoNewSounds: true, seconds: signal.length / audio.sampleRate, peak }, null, 2));
  socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
} catch (error) {
  console.error(error.stack || error);
  fs.writeFileSync(path.join(OUT, 'startup.log'), log);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
}
