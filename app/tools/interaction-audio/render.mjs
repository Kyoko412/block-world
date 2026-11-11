/*
 * 挖掘/放置音频的离线导出（制作端）。
 *   node app/tools/interaction-audio/render.mjs
 *
 * 与 movement-audio 同一套 harness（Electron + superdough + 单个 OfflineAudioContext），
 * 但独立一份入口：移动音频已经验收，不因为新素材重渲染它。
 * 产出：app/renderer/media/sfx/{dig,break,place}_*.wav + app/renderer/js/core/digfiles.js
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(path.join(ROOT, 'app/node_modules/electron/dist/electron.exe'), [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  runAuthor();
}

async function runAuthor() {
  const { app, BrowserWindow } = await import('electron');
  const authorRoot = path.join(ROOT, '.tmp-audio/strudel-authoring');
  const sourceRoot = path.join(ROOT, '.tmp-audio/movement-source');
  const require = createRequire(path.join(authorRoot, 'package.json'));
  const { build } = require('esbuild');
  const { BANKS, SAND_BANK, ACTIONS, jobs } = await import('./patterns.mjs');
  let server, win;
  try {
    await build({ entryPoints: [path.join(HERE, 'render-browser.mjs')], bundle: true, format: 'esm', platform: 'browser',
      nodePaths: [path.join(authorRoot, 'node_modules')], outfile: path.join(authorRoot, 'interaction-bundle.js') });
    console.log('Strudel authoring bundle ready');
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let file;
      if (url.pathname === '/browser.js') file = path.join(authorRoot, 'interaction-bundle.js');
      else if (url.pathname === '/sand.mp3') file = path.join(sourceRoot, 'sand_footsteps.mp3');
      else if (/^\/raw\/[\w.-]+$/.test(url.pathname)) file = path.join(sourceRoot, 'kenney/Audio', path.basename(url.pathname));
      else if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<script type="module" src="/browser.js"></script>'); return; }
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await app.whenReady();
    console.log('Authoring audio context host ready');
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_e, _level, message) => console.log('[Strudel] ' + message));
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    for (let i = 0; i < 150 && !(await win.webContents.executeJavaScript('!!window.authorReady')); i++) await new Promise(r => setTimeout(r, 100));
    if (!(await win.webContents.executeJavaScript('!!window.authorReady'))) throw new Error('Authoring page did not initialize');

    const output = path.join(ROOT, 'app/renderer/media/sfx');
    const SOURCES = {
      kenney: { author: 'Kenney', authorPage: 'https://kenney.nl', source: 'https://kenney.nl/assets/impact-sounds' },
      peludo: { author: 'Peludo', authorPage: 'https://opengameart.org/users/peludo', source: 'https://opengameart.org/content/water-splash-and-sand-footsteps' }
    };
    const sourceOf = bank => bank === SAND_BANK ? SOURCES.peludo : SOURCES.kenney;
    const fileOf = (bank, take) => bank === SAND_BANK ? `sand_footsteps_0.mp3#grain${take}` : `${BANKS[bank]}_00${take}.ogg`;
    const report = [], entries = [];
    for (const action of ACTIONS) {
      for (const job of jobs(action)) {
        const result = await win.webContents.executeJavaScript(`window.renderInteraction(${JSON.stringify(job.id)})`);
        const bytes = Buffer.from(result.base64, 'base64');
        fs.writeFileSync(path.join(output, result.id + '.wav'), bytes);
        const primary = result.layers[0];
        const primarySource = sourceOf(primary.bank);
        entries.push({
          id: result.id,
          file: result.id + '.wav',
          family: job.family,
          action,
          /* 撞击层来自 Kenney；沙/叶的颗粒层来自 Peludo sand 录音，逐条按实际用到的层如实标注。 */
          author: primarySource.author,
          authorPage: primarySource.authorPage,
          source: primarySource.source,
          sourceFile: fileOf(primary.bank, primary.take),
          extraSources: result.layers.slice(1).map(layer => ({
            sourceFile: fileOf(layer.bank, layer.take), at: layer.at,
            author: sourceOf(layer.bank).author, source: sourceOf(layer.bank).source
          })),
          bytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          seconds: +result.seconds.toFixed(6),
          fallback: job.id.replace(/_[b-d]$/, ''),
          modifiedNote: 'Strudel core 1.2.6 / superdough 1.3.0; ' + JSON.stringify({ tone: result.tone, layers: result.layers }) +
            '; trim, 12ms fade-in, 25ms fade-out, RMS/peak limited, 44.1kHz mono 16bit WAV'
        });
        report.push({ id: result.id, seconds: result.seconds, rms: result.rms, peak: result.peak, layers: result.layers });
      }
      console.log('Rendered ' + jobs(action).length + ' clips: ' + action);
    }

    const usedFor = {
      dig: '第一人称持续敲击：同一材料的重复落点',
      break: '方块真正被破坏时的收尾',
      place: '方块放置落定的短接触'
    };
    const metadata = `// Generated by the Strudel interaction-audio authoring tool.\n/* 每条的撞击层与颗粒层来源分开记录：Kenney（Impact Sounds, CC0）与 Peludo（沙地录音, CC0）。 */\nconst CLIPS = ${JSON.stringify(entries, null, 2)};\nexport const DIG_SFX_FILES = Object.freeze(Object.fromEntries(CLIPS.map(clip => [clip.id, Object.freeze({\n  licence: 'CC0-1.0', licenceName: 'Creative Commons Zero v1.0',\n  attribution: 'CC0; sources credited in LICENSES.md',\n  title: clip.id, usedFor: ${JSON.stringify(usedFor)}[clip.action], modified: true, ...clip\n})])));\n`;
    fs.writeFileSync(path.join(ROOT, 'app/renderer/js/core/digfiles.js'), metadata);
    const reportDir = path.join(ROOT, 'artifacts/interaction-audio');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'render-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), clips: report }, null, 2));
    console.log('Strudel rendered ' + entries.length + ' WAV files; peak max ' + Math.max(...report.map(r => r.peak)).toFixed(4));
    win.destroy(); server.close(); app.exit(0);
  } catch (error) {
    console.error('Authoring failed: ' + (error?.stack || error?.message || String(error)));
    win?.destroy(); server?.close(); app.exit(1);
  }
}
