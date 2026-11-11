/*
 * MF.3 环境声保留的针对性探针（本轮 A1）。
 *   cd app && npx electron tests/probe-ambient-keep.mjs
 *
 * 复核指出的缺口：`ambientCount >= 0` 在零个环境源时也成立，证明不了「关掉音乐后环境床还在响」。
 * 这里走产品真实入口，按 MF.3 的顺序验三件事：
 *   ① 场景里环境床确实启用（源数 > 0）且 ambient 总线有可测信号；
 *   ② applySettingsLive({music:false}) → 主曲释放、环境源仍在、ambient 总线仍有信号；
 *   ③ setAmbientEnabled(false)（暂停释放用的同一入口）→ 源与信号都归零。
 * 全程同时记录 master 总线，用来区分「真的没声音」和「只是某条总线为 0」。
 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(__dirname, '..');
const OUT = path.join(APP, '..', 'artifacts', 'quality-round2');
const SAVES = path.join(APP, 'tests', '.ambient-probe-saves');
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(SAVES, { recursive: true, force: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  await app.whenReady();
  const srv = await createServer({ staticRoot: path.join(APP, 'renderer'), saveRoot: SAVES, port: 0 });
  const win = new BrowserWindow({ width: 1280, height: 720, show: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
  win.setAlwaysOnTop(true, 'screen-saver');
  const evl = (code) => win.webContents.executeJavaScript('(async () => {' + code + '})()');
  await win.loadURL(srv.url);
  for (let i = 0; i < 150; i++) { if (await evl('return !!(window.__game && window.__test);').catch(() => false)) break; await sleep(200); }
  await evl("window.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;");
  await evl(`
    document.querySelector('[data-a=new]').click();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('#inp-name').value = '环境声探针';
    document.querySelector('#inp-seed').value = 'visual-audit-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    return true;
  `);
  for (let i = 0; i < 300; i++) { if (await evl('const G=window.__game; return G.state==="playing" && G.world && G.world.genQueue.length===0;').catch(() => false)) break; await sleep(250); }
  await sleep(1200);

  const res = await evl(`
    const G = window.__game, T = window.__test;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const peakOver = async (ms) => {
      const out = { ambient: 0, music: 0, master: 0, sfx: 0, samples: 0, ambientSources: 0, ambientId: null };
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        const be = T.audioBusEnergy();
        if (be && be.available) {
          out.samples++;
          out.ambient = Math.max(out.ambient, be.ambient.peak);
          out.music = Math.max(out.music, be.music.peak);
          out.master = Math.max(out.master, be.master.peak);
          out.sfx = Math.max(out.sfx, be.sfx.peak);
          out.ambientSources = be.ambientSources;
          out.ambientId = be.ambientId;
        }
        await sleep(60);
      }
      return out;
    };
    /* 场地：白天露天，音乐开启，环境床应为 wind */
    T.setTime(0.32); T.setWeather('clear', 600); T.tickWeather(0.05, 30);
    await G.applySettingsLive({ music: true, volumeMaster: 0.8, volumeSfx: 0.8, volumeMusic: 0.45 });
    await sleep(2500);
    const A = await peakOver(900);
    const mi0 = T.musicInfo();
    /* ② 只关音乐 */
    await G.applySettingsLive({ music: false });
    await sleep(2200);
    const B = await peakOver(900);
    const mi1 = T.musicInfo();
    /* ③ 关环境开关（与暂停释放同一入口） */
    G.sfx.setAmbientEnabled(false);
    await sleep(1800);
    const C = await peakOver(900);
    const mi2 = T.musicInfo();
    /* 恢复，确认能回来 */
    await G.applySettingsLive({ music: true, volumeMaster: 0.8, volumeSfx: 0.8, volumeMusic: 0.45 });
    G.sfx.setAmbientEnabled(true);
    await sleep(2200);
    const D = await peakOver(900);
    return { A, B, C, D, mi: { before: { act: mi0.activeMusicCount, amb: mi0.activeAmbient, src: mi0.ambientSources },
      musicOff: { act: mi1.activeMusicCount, amb: mi1.activeAmbient, src: mi1.ambientSources },
      ambientOff: { act: mi2.activeMusicCount, amb: mi2.activeAmbient, src: mi2.ambientSources } } };
  `);

  const fails = [];
  if (!(res.A.ambientSources > 0 && res.A.ambient > 1e-5)) fails.push('场景本身没有环境床信号：' + JSON.stringify(res.A));
  if (!(res.B.ambientSources > 0 && res.B.ambient > 1e-5)) fails.push('关音乐后环境床没了：' + JSON.stringify(res.B));
  if (!(res.B.music <= Math.max(1e-5, res.A.music * 0.2))) fails.push('关音乐后音乐总线仍有信号：' + JSON.stringify(res.B));
  if (!(res.C.ambientSources === 0 && res.C.ambient <= Math.max(1e-5, res.A.ambient * 0.05))) fails.push('关环境开关后仍在出声：' + JSON.stringify(res.C));
  if (!(res.D.ambient > 1e-5)) fails.push('恢复后环境床没回来：' + JSON.stringify(res.D));

  const report = { at: new Date().toISOString(), note: '分总线能量读数（master/sfx/music/ambient 各自 0 增益旁路 Analyser）', res, fails };
  fs.writeFileSync(path.join(OUT, 'ambient-keep.json'), JSON.stringify(report, null, 2));
  console.log('① 场景：ambient 源=' + res.A.ambientSources + ' id=' + res.A.ambientId + ' 峰值=' + res.A.ambient.toFixed(6) + ' music 峰值=' + res.A.music.toFixed(6));
  console.log('② 关音乐：主曲=' + res.mi.musicOff.act + ' 环境源=' + res.B.ambientSources + ' ambient 峰值=' + res.B.ambient.toFixed(6) + ' music 峰值=' + res.B.music.toFixed(6));
  console.log('③ 关环境开关：环境源=' + res.C.ambientSources + ' ambient 峰值=' + res.C.ambient.toFixed(6));
  console.log('④ 恢复：环境源=' + res.D.ambientSources + ' ambient 峰值=' + res.D.ambient.toFixed(6));
  if (fails.length) { console.log('\n失败 ' + fails.length + ' 项：'); for (const f of fails) console.log('  ✗ ' + f); process.exitCode = 1; }
  else console.log('\n通过：关音乐后环境床仍在出声（源与信号都在），关环境开关后两者都归零，恢复后回来。');
  await srv.close();
  app.exit(fails.length ? 1 : 0);
}
run().catch((e) => { console.error(e); app.exit(1); });
