/*
 * 战斗音效的实机短检查（不跑通关/寻路，不补血、不无敌）。
 * 用真实鼠标/键盘动作：砍僵尸、挨僵尸、举盾挡、拉弓射靶、摔一次，
 * 核对实际文件播放与扣血；溺水用低氧场景夹具缩短等待，不改伤害。
 *   node app/tests/combat-audio-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { PREVIEW_NAME } from '../tools/combat-audio/preview.mjs';
import { COMBAT_SFX_FILES } from '../renderer/js/core/combatfiles.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const PACK = path.join(ROOT, '游戏/方块世界-战斗音效');
const OUT = path.join(ROOT, 'artifacts/combat-audio');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
fs.mkdirSync(OUT, { recursive: true });
const wanted = Object.keys(COMBAT_SFX_FILES);
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
const mouse = (type, button, x = 640, y = 360) => command('Input.dispatchMouseEvent', {
  type, x, y, button, buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0, clickCount: 1
});
const events = () => evaluate('return window.__events.slice()');
const clearEvents = () => evaluate('window.__events.length=0;return true;');

const report = { steps: [] };
const record = (name, data) => { report.steps.push(Object.assign({ step: name }, data)); };

try {
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    if (child.exitCode !== null) throw new Error('打包版提前退出：' + child.exitCode);
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch { /* 服务还没起 */ }
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
  if (!worlds.some(world => world.name === PREVIEW_NAME)) throw new Error('包内找不到战斗试听世界');
  await evaluate(`await window.__game.loadWorld(${JSON.stringify(PREVIEW_NAME)}); window.__game.sfx.resume(); return true;`);
  for (let i = 0; i < 60; i++) {
    const info = await evaluate('return window.__game.sfx.sfxFilesInfo();');
    const missing = info.files.filter(file => wanted.includes(file.id) && file.state !== 'ready');
    if (!missing.length) break;
    if (i === 59) throw new Error('战斗音频解码未完成：' + JSON.stringify(missing));
    await delay(100);
  }
  report.ready = await evaluate(`const info=window.__game.sfx.sfxFilesInfo();
    return info.files.filter(f=>${JSON.stringify(wanted)}.includes(f.id)).length;`);
  await evaluate(`const G=window.__game;
    window.__events=[]; window.__combatEvents=[]; const watched=new Set(${JSON.stringify(wanted)}); const original=G.sfx.play.bind(G.sfx);
    G.sfx.play=(name,opts)=>{const before=G.sfx.stats().played; const result=original(name,opts); const after=G.sfx.stats();
      const event={name,volume:opts&&opts.volume,pan:opts&&opts.pan,played:after.played>before,source:after.last?.source,
        ...(name.startsWith('hurt_') ? {healthAtCue:G.controller.health, damage:G.controller.lastHurt} : {})};
      window.__events.push(event); if(watched.has(name)) window.__combatEvents.push(event); return result;};
    return true;`);
  report.arena = await evaluate('return {mobs: window.__game.mobs.list.map(m=>m.type), armor: window.__game.inventory.armor.filter(Boolean).length, health: window.__game.controller.health};');
  if (report.arena.mobs.length !== 2) throw new Error('战斗试听世界应保留预置的两只怪，实际 ' + JSON.stringify(report.arena.mobs));
  if (report.arena.armor !== 4) throw new Error('四件铁甲应已穿上，实际 ' + report.arena.armor);

  await mouse('mousePressed', 'left');
  await delay(60);
  await mouse('mouseReleased', 'left');
  await delay(250);
  report.lock = await evaluate(`if (document.pointerLockElement === document.querySelector('canvas')) return 'pointerlock';
    window.__game.input.locked = true; return 'injected-lock';`);

  /* 0) 挥空：抬头对着天空左键，右键不进方块，只该有风声 */
  await evaluate("const G=window.__game; G.controller.setPositions(0.5,49.02,4.5); G.controller.yaw=0; G.controller.pitch=1.2; G.inventory.select(0); window.__events.length=0; return true;");
  await delay(250);
  await mouse('mousePressed', 'left'); await delay(70); await mouse('mouseReleased', 'left');
  await delay(260);
  const swingEvents = await events();
  const swings = swingEvents.filter(event => String(event.name).startsWith('swing'));
  record('挥空', { names: [...new Set(swings.map(event => event.name))] });
  if (!swings.length) throw new Error('对着空气挥空没有风声');
  if (swingEvents.some(e=>e.name.startsWith('hit_flesh') || e.name.startsWith('hit_armor'))) throw new Error('挥空不能响命中声');

  /* 1) 砍僵尸：站到它面前，真实左键 */
  await evaluate(`const G=window.__game, z=G.mobs.list.find(m=>m.type==='zombie');
    G.controller.setPositions(z.pos.x+0.2, 49.02, z.pos.z+1.9); G.controller.yaw=0; G.controller.pitch=-0.18;
    G.inventory.select(0); return true;`);
  await delay(400);
  await clearEvents();
  /* 只砍一下，保留目标供下一步实际挨打与格挡。 */
  for (let i = 0; i < 1; i++) {
    await mouse('mousePressed', 'left'); await delay(70); await mouse('mouseReleased', 'left');
    await delay(320);
  }
  const hitEvents = await events();
  const flesh = hitEvents.filter(event => String(event.name).startsWith('hit_flesh'));
  record('砍僵尸', { hits: flesh.length, names: [...new Set(flesh.map(event => event.name))] });
  if (!flesh.length) throw new Error('真实左键砍僵尸没有命中音');
  report.zombieHp = await evaluate("return window.__game.mobs.list.filter(m=>m.type==='zombie').map(m=>m.hp);");
  if (!report.zombieHp.length) throw new Error('测试前提失败：僵尸已被砍死，没法制受击检查');

  /* 2) 站着挨打：等僵尸打到身上（护甲已穿，应叠一层金属） */
  await clearEvents();
  await evaluate(`const G=window.__game, z=G.mobs.list.find(m=>m.type==='zombie');
    G.controller.setPositions(z.pos.x, 49.02, z.pos.z+1.4); G.controller.yaw=0; return true;`);
  /* 僵尸被砍过会后退，持续跟到它身边（只动玩家位置，不补血、不改伤害）。 */
  for (let i = 0; i < 50; i++) {
    const heard = await events();
    if (heard.some(event => String(event.name).startsWith('hurt_'))) break;
    await evaluate("const G=window.__game,z=G.mobs.list.find(m=>m.type==='zombie'); if(z) G.controller.setPositions(z.pos.x,49.02,z.pos.z+1.5); return true;");
    await delay(150);
  }
  const hurtEvents = await events();
  const body = hurtEvents.filter(event => String(event.name).startsWith('hurt_body'));
  const armor = hurtEvents.filter(event => String(event.name).startsWith('hit_armor'));
  record('挨僵尸打', { body: body.length, armor: armor.length, names: [...new Set(hurtEvents.map(event => event.name))], lastHurt: await evaluate('return window.__game.controller.lastHurt;'), armorPoints: await evaluate('return window.__game.inventory.armorPoints();') });
  if (!body.length) throw new Error('被僵尸打到没有身体受击声');
  if (!armor.length) throw new Error('穿着四件铁甲挨打，应叠一层护甲金属声');

  /* 3) 举盾挡：选盾牌，右键按住，等僵尸再打一下 */
  await evaluate(`const G=window.__game; G.inventory.select(1); window.__events.length=0; return G.inventory.held();`);
  await mouse('mousePressed', 'right');
  await delay(120);
  for (let i = 0; i < 60; i++) {
    const heard = await events();
    if (heard.some(event => String(event.name).startsWith('shield_'))) break;
    await delay(120);
  }
  const blockEvents = await events();
  await mouse('mouseReleased', 'right');
  const blocks = blockEvents.filter(event => String(event.name).startsWith('shield_'));
  const blocked = await evaluate('return window.__game.shieldBlocks || 0');
  record('举盾格挡', { sounds: [...new Set(blocks.map(event => event.name))], blocks: blocked, health: await evaluate('return window.__game.controller.health;') });
  if (!blocked) throw new Error('举盾期间没有发生格挡');

  /* 4) 弓：选弓，右键蓄力，松手射向靶墙 */
  await evaluate(`const G=window.__game;
    G.controller.setPositions(0.5, 49.02, -3.5); G.controller.yaw=0; G.controller.pitch=-0.02;
    G.inventory.select(2); window.__events.length=0; return G.inventory.held();`);
  await delay(250);
  await mouse('mousePressed', 'right');
  await delay(950);
  await mouse('mouseReleased', 'right');
  await delay(700);
  const bowEvents = await events();
  const release = bowEvents.filter(event => String(event.name).startsWith('bow_release'));
  const arrowHit = bowEvents.filter(event => String(event.name).startsWith('arrow_hit'));
  record('拉弓射靶', { release: [...new Set(release.map(event => event.name))], arrowHit: [...new Set(arrowHit.map(event => event.name))] });
  if (!release.length) throw new Error('松手放箭没有弦的释放声');
  if (!arrowHit.length) throw new Error('箭命中靶墙没有实际命中音');

  /* 5) 摔一次：从矮墙上方落下来，落地声归移动，受创只留闷哼 */
  await clearEvents();
  await evaluate(`const G=window.__game; G.controller.setPositions(0.5, 56.2, 4.5); G.controller.vel.y = -4.5; return true;`);
  for (let i = 0; i < 40; i++) {
    const heard = await events();
    if (heard.some(event => String(event.name).startsWith('hurt_fall'))) break;
    await delay(80);
  }
  const fallEvents = await events();
  const fallHurt = fallEvents.filter(event => String(event.name).startsWith('hurt_fall'));
  const land = fallEvents.filter(event => String(event.name).startsWith('land_'));
  record('摔落', { hurtFall: [...new Set(fallHurt.map(event => event.name))], land: [...new Set(land.map(event => event.name))], health: await evaluate('return +window.__game.controller.health.toFixed(1);') });
  if (!fallHurt.length) throw new Error('摔伤没有闷哼');
  if (fallHurt.length > 1) throw new Error('一次摔伤不该有多条受创声：' + fallHurt.length);

  /* 深水池里的实际溺水：只预置低氧以免等 20 秒，仍由正常物理与伤害入口触发。 */
  await clearEvents();
  const waterBefore = await evaluate(`const G=__game; G.controller.setPositions(4.5,46.02,3.5); G.controller.air=0.1;
    return {health:G.controller.health, fixture:'low oxygen in the preview pool'};`);
  for (let i=0; i<60; i++) {
    if ((await events()).some(e=>e.name.startsWith('hurt_drown'))) break;
    await delay(100);
  }
  const waterEvents = await events();
  const waterAfter = await evaluate(`const G=__game; const result={health:G.controller.health, type:G.controller.lastHurt?.type};
    G.controller.setPositions(0.5,49.02,4.5); G.controller.yaw=0; G.controller.pitch=-0.12; return result;`);
  record('溺水', {before:waterBefore, after:waterAfter, events:waterEvents});
  /* 满饱食时自动回血可能抵消前后读数，核对伤害事件本身的 taken 与即时血量。 */
  if (waterAfter.type !== 'drown' || !waterEvents.some(e=>e.name.startsWith('hurt_drown') && e.damage?.taken > 0)) throw new Error('实际溺水掉血未触发专用水下录音');
  if (waterEvents.some(e=>e.name.startsWith('hurt_body') || e.name.startsWith('hit_armor'))) throw new Error('溺水不应叠普通身体或护甲受击');

  report.actualFilePlays = await evaluate('return window.__combatEvents;');
  for (const event of report.actualFilePlays) {
    if (!event.played || event.source !== 'file') throw new Error('未实际走随包录音：'+JSON.stringify(event));
  }

  const shot = await command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, '战斗试听场景.png'), Buffer.from(shot.data, 'base64'));
  fs.writeFileSync(path.join(OUT, 'combat-smoke.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
} catch (error) {
  console.error(error.stack || error);
  report.error = String(error.message || error);
  fs.writeFileSync(path.join(OUT, 'combat-smoke.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, 'combat-smoke-startup.log'), log);
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
