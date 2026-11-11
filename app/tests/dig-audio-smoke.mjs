/*
 * 挖放音效的实机短检查（只做这一件事，不跑通关/寻路/挖矿机器人）。
 * 录音先开始，再用真实鼠标左键按住真方块、真实右键放置，最后统计实际播放的名字与音频信号。
 *   node app/tests/dig-audio-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { PREVIEW_NAME } from '../tools/interaction-audio/preview.mjs';
import { monoWave } from '../tools/movement-audio/wave.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const PACK = path.join(ROOT, '游戏/方块世界-挖放音效');
const OUT = path.join(ROOT, 'artifacts/interaction-audio');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
fs.mkdirSync(OUT, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(path.join(PACK, '方块世界.exe'),
  [`--remote-debugging-port=${port}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
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
const mouse = (type, button, x, y) => command('Input.dispatchMouseEvent', {
  type, x, y, button, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: 1
});
const key = (code, down) => command('Input.dispatchKeyEvent', {
  type: down ? 'keyDown' : 'keyUp', code,
  key: ({ Digit4: '4', Digit5: '5' })[code],
  windowsVirtualKeyCode: ({ Digit4: 52, Digit5: 53 })[code]
});

const report = { stations: [], place: null, capture: null };
try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    if (child.exitCode !== null) throw new Error('Packaged game exited before startup: ' + child.exitCode);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch { /* 本地服务还没起来 */ }
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
  if (!worlds.some(world => world.name === PREVIEW_NAME)) throw new Error('包内找不到挖放试听世界');
  await evaluate(`await window.__game.loadWorld(${JSON.stringify(PREVIEW_NAME)}); window.__game.sfx.resume(); return window.__game.state;`);
  for (let i = 0; i < 60; i++) {
    const info = await evaluate('return window.__game.sfx.sfxFilesInfo();');
    const pendingFiles = info.files.filter(file => (file.id.startsWith('dig_') || file.id.startsWith('break_') || file.id.startsWith('place')) && file.state !== 'ready');
    if (!pendingFiles.length) break;
    if (i === 59) throw new Error('挖放音频解码未完成：' + JSON.stringify(pendingFiles));
    await delay(100);
  }
  report.ready = await evaluate(`const info=window.__game.sfx.sfxFilesInfo();
    return info.files.filter(f=>/^(dig_|break_|place)/.test(f.id)).map(f=>f.id).length;`);

  /* 先开始录音，再做真实动作：ScriptProcessor 旁路接在 master 上 */
  await evaluate(`const G=window.__game,ctx=G.sfx.ctx;
    const tap=ctx.createScriptProcessor(2048,1,1),silent=ctx.createGain();silent.gain.value=0;
    const chunks=[];tap.onaudioprocess=e=>chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    G.sfx.master.connect(tap);tap.connect(silent);silent.connect(ctx.destination);
    window.__digCapture={tap,silent,chunks,sampleRate:ctx.sampleRate};
    window.__events=[];
    const original=G.sfx.play.bind(G.sfx);
    G.sfx.play=(name,opts)=>{try{window.__events.push({name,volume:opts&&opts.volume});}catch{}return original(name,opts);};
    return true;`);

  /* 指针锁：真实点击一次尝试锁定；自动化窗口拿不到用户激活时只放开「相机锁」这一层，
     挖掘/放置仍然走真实的鼠标按键事件与真实方块世界，不直接改方块数据。 */
  await mouse('mousePressed', 'left', 640, 360);
  await delay(80);
  await mouse('mouseReleased', 'left', 640, 360);
  await delay(300);
  report.lock = await evaluate(`const G=window.__game;
    if (document.pointerLockElement === document.querySelector('canvas')) return 'pointerlock';
    G.input.locked = true; return 'injected-lock';`);

  const stations = [
    { key: 'dirt', prefix: 'dig_dirt', x: 1.5, z: -5.4, label: '土墙' },
    { key: 'stone', prefix: 'dig_stone', x: 5.5, z: -5.4, label: '石墙' },
    { key: 'wood', prefix: 'dig_wood', x: 9.5, z: -5.4, label: '木墙' },
    { key: 'sand', prefix: 'dig_sand', x: 13.5, z: -5.4, label: '沙砾墙' },
    { key: 'leaves', prefix: 'dig_grass', x: 17.5, z: -5.4, label: '树叶墙' }
  ];
  /* 站到能同时看到五面材质墙的位置留一张现场图 */
  await evaluate(`const G=window.__game;
    G.controller.setPositions(8.5,49.02,6.5);G.controller.yaw=0;G.controller.pitch=-0.03;return true;`);
  await delay(600);
  const scene = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '挖放试听场景.png'), Buffer.from(scene.data, 'base64'));

  for (const station of stations) {
    await evaluate(`const G=window.__game;
      G.controller.setPositions(${station.x},49.02,${station.z});
      G.controller.yaw=0;G.controller.pitch=-0.02;
      G.inventory.select(0);
      window.__events.length=0;
      return true;`);
    await delay(350);
    await mouse('mousePressed', 'left', 640, 360);
    /* 一直按住，直到这一格真的被挖掉就松手：只验证「一次动作 → 一次破坏声」。
       继续按住会顺理成章地开始挖下一格，那是另一格的动作，不该混进同一条断言。 */
    for (let i = 0; i < 100; i++) {
      const broke = await evaluate('return window.__events.filter(e=>String(e.name).startsWith("break_")).length');
      if (broke >= 1) break;
      await delay(50);
    }
    await mouse('mouseReleased', 'left', 640, 360);
    await delay(450);
    const events = await evaluate('return window.__events.slice()');
    const dig = events.filter(event => String(event.name).startsWith('dig_'));
    const broke = events.filter(event => String(event.name).startsWith('break_'));
    const progress = await evaluate('return {mining: !!window.__game.interaction.mining.hit, progress: +window.__game.interaction.mining.progress.toFixed(2)}');
    report.stations.push({
      key: station.key, label: station.label,
      digCount: dig.length, digNames: [...new Set(dig.map(event => event.name))],
      breakCount: broke.length, breakNames: [...new Set(broke.map(event => event.name))],
      breakVolume: broke.length ? broke[0].volume : null,
      stillMining: progress.mining
    });
    if (dig.length < 3) throw new Error(station.label + ' 按住左键 2.4 秒只听到 ' + dig.length + ' 次敲击');
    if (broke.length !== 1) throw new Error(station.label + ' 破坏声应恰好一次，实际 ' + broke.length);
    if (new Set(dig.map(event => event.name)).size < 2) throw new Error(station.label + ' 连续敲击没有换录音');
    if (!dig.every(event => String(event.name).startsWith(station.prefix))) throw new Error(station.label + ' 用错了材质：' + [...new Set(dig.map(event => event.name))].join(','));
    if (!broke.every(event => String(event.name).startsWith('break_'))) throw new Error(station.label + ' 破坏声名字异常');
  }

  /* 放置：选中第 4 格（泥土），低头右键点地面 */
  await evaluate(`const G=window.__game;
    G.controller.setPositions(4.5,49.02,4.5);
    G.controller.yaw=0;G.controller.pitch=-0.62;
    window.__events.length=0;
    return G.inventory.slots.map(s=>s?s.item:null);`);
  await key('Digit4', true); await delay(60); await key('Digit4', false);
  await delay(200);
  const heldBefore = await evaluate('return window.__game.inventory.held();');
  const blocksBefore = await evaluate(`return window.__game.world.getBlock(4,49,2) + ':' + window.__game.world.getBlock(4,49,3)`);
  await mouse('mousePressed', 'right', 640, 360);
  await delay(120);
  await mouse('mouseReleased', 'right', 640, 360);
  await delay(500);
  const placeEvents = await evaluate('return window.__events.slice()');
  const placed = placeEvents.filter(event => String(event.name).startsWith('place'));
  const heldAfter = await evaluate('return window.__game.inventory.held();');
  const blocksAfter = await evaluate(`return window.__game.world.getBlock(4,49,2) + ':' + window.__game.world.getBlock(4,49,3)`);
  report.place = {
    names: placed.map(event => event.name), volume: placed.length ? placed[0].volume : null,
    heldBefore: heldBefore ? heldBefore.item + ' x' + heldBefore.count : null,
    heldAfter: heldAfter ? heldAfter.item + ' x' + heldAfter.count : null,
    blocksBefore, blocksAfter
  };
  if (placed.length !== 1) throw new Error('一次成功放置应恰好一条放置声，实际 ' + placed.length);
  if (heldBefore.count - heldAfter.count !== 1) throw new Error('放置应扣掉一块方块：' + heldBefore.count + ' → ' + (heldAfter && heldAfter.count));
  if (blocksBefore === blocksAfter) throw new Error('放置后地面方块没有变化：' + blocksBefore);

  /* 失败放置：对着自己脚下低头右键（会挤进玩家身体），不应响成功声也不扣方块 */
  await evaluate(`const G=window.__game;
    G.controller.pitch=-1.45;
    window.__events.length=0;return true;`);
  await delay(300);
  const heldAtFail = await evaluate('return window.__game.inventory.held();');
  const blockedTarget = await evaluate('return window.__game.interaction.target;');
  await mouse('mousePressed', 'right', 640, 360);
  await delay(150);
  await mouse('mouseReleased', 'right', 640, 360);
  await delay(400);
  const failEvents = await evaluate('return window.__events.slice()');
  const heldAfterFail = await evaluate('return window.__game.inventory.held();');
  report.placeRefused = {
    names: failEvents.filter(event => String(event.name).startsWith('place')).map(event => event.name),
    target: blockedTarget,
    heldBefore: heldAtFail ? heldAtFail.item + ' x' + heldAtFail.count : null,
    heldAfter: heldAfterFail ? heldAfterFail.item + ' x' + heldAfterFail.count : null
  };
  if (report.placeRefused.names.length !== 0) throw new Error('放不进去的位置不该响放置声：' + report.placeRefused.names.join(','));
  if (heldAtFail.count !== heldAfterFail.count) throw new Error('失败放置不该扣方块');

  const shot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '挖放试听世界.png'), Buffer.from(shot.data, 'base64'));
  const audio = await evaluate(`const capture=window.__digCapture;window.__game.sfx.master.disconnect(capture.tap);capture.tap.disconnect();capture.silent.disconnect();
    const length=capture.chunks.reduce((n,c)=>n+c.length,0),signal=new Float32Array(length);let offset=0;
    for(const chunk of capture.chunks){signal.set(chunk,offset);offset+=chunk.length;}
    const bytes=new Uint8Array(signal.buffer);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {base64:btoa(binary),sampleRate:capture.sampleRate};`);
  const pcm = Buffer.from(audio.base64, 'base64');
  const signal = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  let peak = 0, sum = 0;
  for (const sample of signal) { peak = Math.max(peak, Math.abs(sample)); sum += sample * sample; }
  if (peak <= 0.001 || peak >= 1) throw new Error('实机录音静音或削波：' + peak);
  fs.writeFileSync(path.join(OUT, '实机挖放.wav'), monoWave(signal, audio.sampleRate));
  report.capture = { seconds: signal.length / audio.sampleRate, peak, rms: Math.sqrt(sum / signal.length) };
  fs.writeFileSync(path.join(OUT, 'dig-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
} catch (error) {
  console.error(error.stack || error);
  fs.writeFileSync(path.join(OUT, 'dig-smoke-startup.log'), log);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
}
