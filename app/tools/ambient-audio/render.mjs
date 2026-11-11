/* node app/tools/ambient-audio/render.mjs —— 只导出环境声，不重做已验收动作音效或配乐。 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { SOURCES, JOBS, LOOP_CROSSFADE } from './patterns.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '../../..');
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = spawn(path.join(ROOT, 'app/node_modules/electron/dist/electron.exe'), [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => process.exit(code ?? 1));
} else runAuthor();

async function runAuthor() {
  const { app, BrowserWindow } = await import('electron');
  const authorRoot = path.join(ROOT, '.tmp-audio/strudel-authoring'), sourceRoot = path.join(ROOT, '.tmp-audio/ambient-source');
  const require = createRequire(path.join(authorRoot, 'package.json')), { build } = require('esbuild');
  let server, win;
  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    for (const source of Object.values(SOURCES)) {
      const file = path.join(sourceRoot, source.file);
      if (!fs.existsSync(file)) {
        const response = await fetch(source.download, { signal: AbortSignal.timeout(30000), headers: source.byteLimit ? { Range: `bytes=0-${source.byteLimit - 1}` } : {} });
        if (!response.ok) throw new Error('Field recording download failed: ' + source.source);
        let bytes;
        if (source.byteLimit) {
          const reader = response.body.getReader(), chunks = []; let size = 0;
          while (size < source.byteLimit) { const { value, done } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); size += value.length; }
          await reader.cancel(); bytes = Buffer.concat(chunks).subarray(0, source.byteLimit);
        } else bytes = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(file, bytes);
      }
      if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== source.sha256) throw new Error('Recording SHA-256 mismatch: ' + source.file);
    }
    await build({ entryPoints: [path.join(HERE, 'render-browser.mjs')], bundle: true, format: 'esm', platform: 'browser',
      nodePaths: [path.join(authorRoot, 'node_modules')], outfile: path.join(authorRoot, 'ambient-bundle.js') });
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost'); let file;
      if (url.pathname === '/browser.js') file = path.join(authorRoot, 'ambient-bundle.js');
      else if (url.pathname.startsWith('/raw/')) { const source = SOURCES[url.pathname.slice(5)]; if (source) file = path.join(sourceRoot, source.file); }
      else if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<script type="module" src="/browser.js"></script>'); return; }
      if (!file) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'audio/mpeg'); fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await app.whenReady();
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_e, _level, message) => console.log('[Strudel] ' + message));
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    for (let i = 0; i < 200 && !(await win.webContents.executeJavaScript('!!window.authorReady')); i++) await new Promise(r => setTimeout(r, 100));
    if (!(await win.webContents.executeJavaScript('!!window.authorReady'))) throw new Error('Field recording authoring page did not initialize');
    const output = path.join(ROOT, 'app/renderer/media/ambient'); fs.mkdirSync(output, { recursive: true });
    const entries = [], report = [];
    for (const job of JOBS) {
      const result = await win.webContents.executeJavaScript(`window.renderAmbient(${JSON.stringify(job.id)})`);
      const bytes = Buffer.from(result.base64, 'base64'), file = job.id + '.wav';
      fs.writeFileSync(path.join(output, file), bytes);
      const recordings = job.layers.map(layer => {
        const source = SOURCES[layer.source];
        return { author: source.author, authorPage: source.authorPage, source: source.source, sourceFile: source.file,
          recordingSha256: source.sha256, sourceNote: source.note, sourceRange: [layer.begin, layer.end], at: layer.at, targetRms: layer.rms };
      });
      entries.push({ id: job.id, file, title: job.title, ...recordings[0], extraSources: recordings.slice(1), bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'), seconds: result.seconds, channels: 2,
        licence: 'CC0-1.0', licenceName: 'Creative Commons Zero v1.0', modified: true,
        modifiedNote: `Strudel core 1.2.6 / superdough 1.3.0; ${JSON.stringify(job.tone)}; DC removal, stereo retained, ${LOOP_CROSSFADE}s equal-power tail/head loop crossfade and rotation, RMS calibrated, peak <=0.38; no oscillators, pitch shift or synthetic noise; 44.1kHz stereo 16bit WAV` });
      report.push({ id: result.id, seconds: result.seconds, rms: result.rms, peak: result.peak, seamDelta: result.seamDelta });
      console.log('Rendered ' + job.id);
    }
    fs.writeFileSync(path.join(ROOT, 'app/renderer/js/core/ambientfiles.js'), `// Generated by tools/ambient-audio/render.mjs. Real CC0 field recordings.
const CLIPS = ${JSON.stringify(entries, null, 2)};
export const AMBIENT_FILES = Object.freeze(Object.fromEntries(CLIPS.map(clip => [clip.id, Object.freeze(clip)])));
export const AMBIENT_FILE_IDS = Object.freeze(Object.keys(AMBIENT_FILES));
export const ambientFileFor = id => AMBIENT_FILES[id] || null;
export const ambientFileUrl = id => AMBIENT_FILES[id] ? '/media/ambient/' + AMBIENT_FILES[id].file : null;
`);
    const reportDir = path.join(ROOT, 'artifacts/ambient-audio'); fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'render-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), clips: report }, null, 2));
    console.log('Rendered 5 stereo field-recording loops; peak max ' + Math.max(...report.map(r => r.peak)).toFixed(4));
    win.destroy(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error?.stack || error); win?.destroy(); server?.close(); app.exit(1);
  }
}
