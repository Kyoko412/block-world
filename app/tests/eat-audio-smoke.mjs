/*
 * 进食的实机短检查：两口/三口、松手中断、暂停后重新开始。
 *   node app/tests/eat-audio-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { PREVIEW_NAME } from '../tools/eat-audio/preview.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const PACK = path.join(ROOT, '游戏/方块世界-进食音效');
const OUT = path.join(ROOT, 'artifacts/eat-audio');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
fs.mkdirSync(OUT, { recursive: true });
const saves = path.join(PACK, 'saves');
const preserved = new Map([PREVIEW_NAME + '.json', 'settings.json'].map(name => {
  const file = path.join(saves, name);
  return [file, fs.existsSync(file) ? fs.readFileSync(file) : null];
}));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(path.join(PACK, '方块世界.exe'),
  [`--remote-debugging-port=${port}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  { cwd: PACK, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', socket, sequence = 0;
const exited = new Promise(resolve => child.once('exit', resolve));
child.stdout.on('data', bytes => { log += bytes.toString(); });
child.stderr.on('data', bytes => { log += bytes.toString(); });
const pending = new Map();
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression: `(async()=>{${expression}})()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}
const mouse = (type, button = 'right') => command('Input.dispatchMouseEvent', {
  type, x: 640, y: 360, button, buttons: type === 'mousePressed' ? 2 : 0, clickCount: 1
});
const hold = async ms => { await mouse('mousePressed'); await delay(ms); await mouse('mouseReleased'); };
const events = () => evaluate('return window.__events.slice()');
async function eatOne() {
  await mouse('mousePressed');
  try {
    for (let i = 0; i < 100; i++) {
      if (await evaluate("return window.__events.some(e=>e.name.startsWith('eat_swallow'))")) return;
      await delay(50);
    }
    throw new Error('短检查内未完成一次进食');
  } finally { await mouse('mouseReleased'); }
}
const report = {};

try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    if (child.exitCode !== null) throw new Error('打包版提前退出：' + child.exitCode);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch {}
    if (!page) await delay(150);
  }
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
  };
  for (let i = 0; i < 80 && !(await evaluate('return !!window.__game;')); i++) await delay(100);
  const worlds = await evaluate('return await window.__game.storage.listWorlds();');
  if (!worlds.some(world => world.name === PREVIEW_NAME)) throw new Error('包内找不到进食试听世界');
  await evaluate(`await window.__game.loadWorld(${JSON.stringify(PREVIEW_NAME)}); window.__game.sfx.resume(); return true;`);
  for (let i = 0; i < 60; i++) {
    const info = await evaluate('return window.__game.sfx.sfxFilesInfo();');
    const missing = info.files.filter(file => file.id.startsWith('eat_') && file.state !== 'ready');
    if (!missing.length) break;
    if (i === 59) throw new Error('进食音频解码未完成：' + JSON.stringify(missing));
    await delay(100);
  }
  report.ready = await evaluate("return window.__game.sfx.sfxFilesInfo().files.filter(f=>f.id.startsWith('eat_')).length;");
  await evaluate(`window.__events=[]; const G=window.__game; const o=G.sfx.play.bind(G.sfx);
    G.sfx.play=(n,p)=>{ const before=G.sfx.stats().played; const result=o(n,p); const after=G.sfx.stats();
      if(n.startsWith('eat_')) window.__events.push({name:n, volume:p&&p.volume, played:after.played>before, source:after.last?.source});
      return result; };
    return true;`);

  /* 指针锁：点一下画布；自动化拿不到用户激活时只放开相机锁这一层 */
  await mouse('mousePressed', 'left'); await delay(60); await mouse('mouseReleased', 'left'); await delay(250);
  report.lock = await evaluate(`if (document.pointerLockElement === document.querySelector('canvas')) return 'pointerlock';
    window.__game.input.locked = true; return 'injected-lock';`);

  /* 先留一张场地照：站在小桌边，面向木板围栏 */
  await evaluate(`const G=window.__game; G.controller.setPositions(0.5,49.02,4.5); G.controller.yaw=0; G.controller.pitch=-0.18; return true;`);
  await delay(600);
  const sceneShot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '进食试听场景.png'), Buffer.from(sceneShot.data, 'base64'));
  await evaluate(`const G=window.__game; G.controller.setPositions(0.5,49.02,4.5); G.controller.yaw=0; G.controller.pitch=1.1; G.inventory.select(0);
    window.__events.length=0; return true;`);
  await delay(250);
  const before = await evaluate('return {hunger: window.__game.controller.hunger, held: window.__game.inventory.held()};');
  await eatOne();
  await delay(400);
  const eaten = await events();
  const after = await evaluate('return {hunger: window.__game.controller.hunger, held: window.__game.inventory.held(), eating: !!window.__game.eatingItem};');
  const kinds = names => names.map(name => name.startsWith('eat_bite') ? 'bite' : name.startsWith('eat_chew') ? 'chew' : name.startsWith('eat_swallow') ? 'swallow' : name);
  report.full = {
    before, after, sequence: kinds(eaten.map(event => event.name)),
    events: eaten,
    counts: {
      bite: eaten.filter(event => event.name.startsWith('eat_bite')).length,
      chew: eaten.filter(event => event.name.startsWith('eat_chew')).length,
      swallow: eaten.filter(event => event.name.startsWith('eat_swallow')).length
    }
  };
  if (report.full.counts.bite !== 2 || report.full.counts.chew !== 2) throw new Error('面包应完整两咬两嚼');
  if (report.full.counts.swallow !== 1) throw new Error('吞下应恰好一次，实际 ' + report.full.counts.swallow);
  if (after.hunger <= before.hunger) throw new Error('吃完饱食度应当上升：' + before.hunger + ' → ' + after.hunger);
  if (!after.held || after.held.count !== before.held.count - 1) throw new Error('吃完应扣掉一个：' + JSON.stringify([before.held, after.held]));
  if (after.eating) throw new Error('吃完后不该还留着进食状态');

  /* 三口食物：逐条核对真实播放统计，不能只统计 play() 调用而漏掉未知变体。 */
  await evaluate(`const G=window.__game; G.controller.hunger=8; G.selectHotbar(2); window.__events.length=0; return true;`);
  const beforeHeavy = await evaluate('return {hunger:__game.controller.hunger, count:__game.inventory.held().count};');
  await eatOne(); await delay(300);
  const heavyEvents = await events();
  const afterHeavy = await evaluate('return {hunger:__game.controller.hunger, count:__game.inventory.held().count};');
  report.threeBites = { before: beforeHeavy, after: afterHeavy, events: heavyEvents };
  if (heavyEvents.filter(e=>e.name.startsWith('eat_bite')).length !== 3 || heavyEvents.filter(e=>e.name.startsWith('eat_chew')).length !== 3 || heavyEvents.filter(e=>e.name.startsWith('eat_swallow')).length !== 1) throw new Error('熟牛肉应完整三咬三嚼一吞');
  if (afterHeavy.hunger !== 16 || afterHeavy.count !== beforeHeavy.count-1) throw new Error('熟牛肉吞下与扣物品不一致');

  /* 中断：按到一半松手，不吞、不扣、不补 */
  await evaluate(`window.__events.length=0; window.__game.inventory.select(1); return true;`);
  await delay(200);
  const beforeCut = await evaluate('return {hunger: window.__game.controller.hunger, held: window.__game.inventory.held()};');
  await hold(420);
  await delay(500);
  const cutEvents = await events();
  const afterCut = await evaluate('return {hunger: window.__game.controller.hunger, held: window.__game.inventory.held(), eating: !!window.__game.eatingItem};');
  report.interrupted = {
    before: beforeCut, after: afterCut,
    names: [...new Set(cutEvents.map(event => event.name))],
    swallow: cutEvents.filter(event => event.name.startsWith('eat_swallow')).length
  };
  if (!cutEvents.some(event => event.name.startsWith('eat_bite'))) throw new Error('中断前应当已经咬过一口');
  if (report.interrupted.swallow !== 0) throw new Error('中断不该吞下');
  if (afterCut.hunger !== beforeCut.hunger) throw new Error('中断不该补饱食：' + beforeCut.hunger + ' → ' + afterCut.hunger);
  if (!afterCut.held || afterCut.held.count !== beforeCut.held.count) throw new Error('中断不该扣物品');
  if (afterCut.eating) throw new Error('中断后进食状态应当清空');

  /* 暂停取消旧会话；恢复后真实右键只按半程，不应补上暂停前的进度。 */
  await evaluate(`const G=__game; G.controller.hunger=8; G.selectHotbar(0); window.__events.length=0; return true;`);
  const beforePause = await evaluate('return {hunger:__game.controller.hunger, count:__game.inventory.held().count};');
  await mouse('mousePressed'); await delay(750);
  const paused = await evaluate('const G=__game; const elapsed=G.eatingItem?.t; G.pause(); return {elapsed, state:G.state, eating:G.isEating()};');
  await mouse('mouseReleased'); await delay(200);
  await evaluate('const G=__game; G.resume(); G.input.locked=true; window.__events.length=0; return true;');
  await hold(450); await delay(300);
  const resumedEvents = await events();
  const afterPause = await evaluate('return {hunger:__game.controller.hunger, count:__game.inventory.held().count, eating:__game.isEating()};');
  report.pauseRestart = { before:beforePause, paused, after:afterPause, events:resumedEvents };
  if (!(paused.elapsed > 0 && paused.elapsed < 1.12) || paused.eating) throw new Error('暂停时必须立即清空未完成的进食');
  if (!resumedEvents.some(e=>e.name.startsWith('eat_bite')) || resumedEvents.some(e=>e.name.startsWith('eat_swallow'))) throw new Error('恢复后应从第一口重吃，半程不能吞下');
  if (afterPause.hunger !== beforePause.hunger || afterPause.count !== beforePause.count || afterPause.eating) throw new Error('暂停重吃中断不应补饱食或扣物品');
  for (const event of [...eaten, ...heavyEvents, ...cutEvents, ...resumedEvents]) {
    if (!event.played || event.source !== 'file') throw new Error('音效未实际走随包录音：'+JSON.stringify(event));
  }

  fs.writeFileSync(path.join(OUT, 'eat-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
} catch (error) {
  console.error(error.stack || error);
  report.error = String(error.message || error);
  fs.writeFileSync(path.join(OUT, 'eat-smoke.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'eat-smoke-startup.log'), log);
  process.exitCode = 1;
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
  await exited;
  for (const [file, bytes] of preserved) {
    if (bytes) fs.writeFileSync(file, bytes);
    else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}
