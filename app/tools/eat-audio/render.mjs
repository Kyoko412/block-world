/*
 * 进食音效的离线导出（制作端）。
 *   node app/tools/eat-audio/render.mjs
 * 产出：app/renderer/media/sfx/eat_*.wav + app/renderer/js/core/eatfiles.js
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

const actionOf = id => id.startsWith('eat_bite') ? 'bite' : id.startsWith('eat_chew') ? 'chew' : 'swallow';
const USED_FOR = {
  bite: '咬下一口（干粮 / 果蔬 / 柔软熟食）',
  chew: '咀嚼（在咬与吞之间，音量更轻）',
  swallow: '吞下：这一刻才真正加饱食并扣物品'
};

async function runAuthor() {
  const { app, BrowserWindow } = await import('electron');
  const authorRoot = path.join(ROOT, '.tmp-audio/strudel-authoring');
  const require = createRequire(path.join(authorRoot, 'package.json'));
  const { build } = require('esbuild');
  const { JOBS, BANKS, SOURCES } = await import('./patterns.mjs');
  const sourceDir = path.join(ROOT, '.tmp-audio/eating-source');
  let server, win;
  try {
    fs.mkdirSync(sourceDir, { recursive: true });
    for (const source of Object.values(SOURCES)) {
      const file = path.join(sourceDir, source.file);
      if (!fs.existsSync(file)) {
        const response = await fetch(source.download);
        if (!response.ok) throw new Error('Recording download failed: ' + source.download);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (source.download.endsWith('.zip')) {
          const archive = path.join(sourceDir, 'warsong-rpg-foley.zip');
          fs.writeFileSync(archive, bytes);
          const appRequire = createRequire(path.join(ROOT, 'app/package.json'));
          await appRequire('extract-zip')(archive, { dir: sourceDir });
        } else fs.writeFileSync(file, bytes);
      }
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (hash !== source.sha256) throw new Error('Recording SHA-256 mismatch: ' + source.file);
    }
    await build({ entryPoints: [path.join(HERE, 'render-browser.mjs')], bundle: true, format: 'esm', platform: 'browser',
      nodePaths: [path.join(authorRoot, 'node_modules')], outfile: path.join(authorRoot, 'eat-bundle.js') });
    console.log('Strudel authoring bundle ready');
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let file;
      if (url.pathname === '/browser.js') file = path.join(authorRoot, 'eat-bundle.js');
      else if (url.pathname.startsWith('/raw/')) {
        const name = decodeURIComponent(url.pathname.slice(5));
        if (Object.values(SOURCES).some(source => source.file === name)) file = path.join(sourceDir, name);
      }
      else if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<script type="module" src="/browser.js"></script>'); return; }
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav');
      fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await app.whenReady();
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_e, _level, message) => console.log('[Strudel] ' + message));
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    for (let i = 0; i < 150 && !(await win.webContents.executeJavaScript('!!window.authorReady')); i++) await new Promise(r => setTimeout(r, 100));
    if (!(await win.webContents.executeJavaScript('!!window.authorReady'))) throw new Error('Authoring page did not initialize');

    const output = path.join(ROOT, 'app/renderer/media/sfx');
    const report = [], entries = [];
    for (const job of JOBS) {
      const result = await win.webContents.executeJavaScript(`window.renderEat(${JSON.stringify(job.id)})`);
      const bytes = Buffer.from(result.base64, 'base64');
      fs.writeFileSync(path.join(output, result.id + '.wav'), bytes);
      const cut = BANKS[job.layers[0].bank][job.layers[0].take];
      const recording = SOURCES[cut.source];
      entries.push({
        id: result.id,
        file: result.id + '.wav',
        action: actionOf(result.id),
        author: recording.author,
        authorPage: recording.authorPage,
        source: recording.source,
        sourceFile: recording.file,
        recordingSha256: recording.sha256,
        sourceRange: [cut.begin, cut.end].map(value => +value.toFixed(6)),
        sourceNote: recording.note || '真实拟音录音，CC0-1.0',
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        seconds: +result.seconds.toFixed(6),
        fallback: 'eat',
        modifiedNote: 'Strudel core 1.2.6 / superdough 1.3.0; ' + JSON.stringify({ tone: result.tone, layers: result.layers }) +
          '; real recording cut, DC removal, gentle filters, no bitcrush or synthetic layers; 8ms fade-in, 25ms fade-out, clip RMS / peak limited, 44.1kHz mono 16bit WAV'
      });
      report.push({ id: result.id, seconds: result.seconds, rms: result.rms, peak: result.peak });
      console.log('Rendered ' + result.id);
    }

    const metadata = `// Generated by the Strudel eat-audio authoring tool.
/* 进食音效：真实 CC0 录音；逐条记录来源、切片、加工参数与指纹。 */
const CLIPS = ${JSON.stringify(entries, null, 2)};
export const EAT_SFX_FILES = Object.freeze(Object.fromEntries(CLIPS.map(clip => [clip.id, Object.freeze({
  licence: 'CC0-1.0', licenceName: 'Creative Commons Zero v1.0',
  attribution: 'CC0 recordings by Wareya and thedapperdan; credit optional',
  title: clip.id, usedFor: ${JSON.stringify(USED_FOR)}[clip.action], modified: true, ...clip
})])));
`;
    fs.writeFileSync(path.join(ROOT, 'app/renderer/js/core/eatfiles.js'), metadata);
    const reportDir = path.join(ROOT, 'artifacts/eat-audio');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'render-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), clips: report }, null, 2));
    console.log('Strudel rendered ' + entries.length + ' WAV files; peak max ' + Math.max(...report.map(r => r.peak)).toFixed(4));
    win.destroy(); server.close(); app.exit(0);
  } catch (error) {
    console.error('Authoring failed: ' + (error?.stack || error?.message || String(error)));
    win?.destroy(); server?.close(); app.exit(1);
  }
}
