/* 光照与夜景核对：挖一个洞放火把，分别在白天/夜晚截图 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const ART = path.join(APP, '..', 'artifacts');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (m) => process.stdout.write(m + '\n');

async function main() {
  await app.whenReady();
  fs.rmSync(path.join(APP, 'tests', '.light-saves'), { recursive: true, force: true });
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: path.join(APP, 'tests', '.light-saves') });
  const win = new BrowserWindow({ width: 1280, height: 720, show: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (e, lvl, msg) => { if (lvl >= 2) log('  页面错误: ' + msg); });
  await win.loadURL(srv.url);
  for (let i = 0; i < 200; i++) { if (await win.webContents.executeJavaScript('!!window.__game').catch(() => false)) break; await sleep(100); }
  const run = (js) => win.webContents.executeJavaScript(js);
  const shot = async (n) => { fs.writeFileSync(path.join(ART, n + '.png'), (await win.webContents.capturePage()).toPNG()); log('  截图 ' + n); };

  await run(`(async () => {
    const G = window.__game;
    await G.newWorld('光照核对', 'light-9', 'creative');
    while (G.state !== 'playing') await new Promise(r => setTimeout(r, 100));
    return true;
  })()`);
  await sleep(2500);

  // 挖一个 7x7x4 的房间，墙上间隔放火把与荧石
  await run(`(() => {
    const G = window.__game, T = window.__test;
    const x = Math.floor(G.controller.pos.x), z = Math.floor(G.controller.pos.z);
    const gy = G.world.topSolidY(x, z);
    for (let dy = -4; dy <= -1; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++)
      T.setBlock(x + dx, gy + dy, z + dz, 0);
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) T.setBlock(x + dx, gy - 5, z + dz, 1);
    T.setBlock(x - 3, gy - 2, z - 3, 28);
    T.setBlock(x + 3, gy - 2, z + 3, 28);
    T.setBlock(x + 3, gy - 2, z - 3, 34);
    T.setBlock(x - 3, gy - 2, z + 3, 34);
    T.setBlock(x, gy - 2, z + 3, 34);
    G.controller.spawnAt(x - 2.5, gy - 4.99, z - 2.5);
    G.controller.yaw = -0.78; G.controller.pitch = -0.06;
    return true;
  })()`);
  await sleep(1800);
  await shot('light-01-洞穴与火把');

  // 夜晚地表：移到露天平台并朝向月亮，避免树冠把月亮和星空全部挡住。
  await run(`(async () => { const G = window.__game, T = window.__test;
    const x = Math.floor(G.controller.pos.x), z = Math.floor(G.controller.pos.z);
    const top = Math.max(G.world.topSolidY(x, z), 20) + 12;
    for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) T.setBlock(x + dx, top - 1, z + dz, 1);
    for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++)
      for (let dy = 0; dy <= 12; dy++) T.setBlock(x + dx, top + dy, z + dz, 0);
    G.controller.spawnAt(x + 0.5, top + 0.05, z + 0.5);
    G.time = 0.62;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const m = G.view.sky.uniforms.uMoonDir.value;
    G.controller.yaw = Math.atan2(-m.x, -m.z);
    G.controller.pitch = Math.asin(m.y) - 0.50;
    return true; })()`);
  await sleep(1500);
  log('  夜景瞄准 ' + JSON.stringify(await run(`(() => { const G = window.__game;
    const d = G.camera.position.clone(); G.camera.getWorldDirection(d);
    const m = G.view.sky.uniforms.uMoonDir.value;
    return { dot: d.dot(m), camera: d.toArray(), moon: m.toArray(), pitch: G.controller.pitch, yaw: G.controller.yaw };
  })()`)));
  await shot('light-02-夜晚地表');

  await run(`(async () => { const G = window.__game;
    G.time = 0.06;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = G.view.sky.sunDir;
    G.controller.yaw = Math.atan2(-s.x, -s.z);
    G.controller.pitch = Math.asin(s.y) - 0.16;
  })()`);
  await sleep(1500);
  await shot('light-03-日出');

  // 正午：同一张图里核对硬边太阳、方块云和手持物的最终尺寸。
  await run(`(async () => { const G = window.__game;
    G.time = 0.22;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = G.view.sky.sunDir;
    G.controller.yaw = Math.atan2(-s.x, -s.z);
    G.controller.pitch = Math.asin(s.y) - 0.22;
  })()`);
  await sleep(1500);
  log('  正午瞄准 ' + JSON.stringify(await run(`(() => { const G = window.__game;
    const d = G.camera.position.clone(); G.camera.getWorldDirection(d);
    const s = G.view.sky.sunDir;
    return { dot: d.dot(s), camera: d.toArray(), sun: s.toArray(), camPos: G.view.sky.uniforms.uCamPos.value.toArray() };
  })()`)));
  await shot('light-04-方块云与太阳');

  await srv.close();
  app.exit(0);
}
main().catch(e => { log('异常 ' + ((e && e.stack) || e)); app.exit(1); });
