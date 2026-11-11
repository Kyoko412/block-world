// Authoring only: npm install --prefix .tmp-audio/strudel-authoring @strudel/core@1.2.6 @strudel/webaudio@1.3.0 esbuild
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
  let server, win;
  try {
    await build({ entryPoints: [path.join(HERE, 'render-browser.mjs')], bundle: true, format: 'esm', platform: 'browser',
      nodePaths: [path.join(authorRoot, 'node_modules')], outfile: path.join(authorRoot, 'bundle.js') });
    console.log('Strudel authoring bundle ready');
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let file;
      if (url.pathname === '/browser.js') file = path.join(authorRoot, 'bundle.js');
      else if (url.pathname === '/sand.mp3') file = path.join(sourceRoot, 'sand_footsteps.mp3');
      else if (/^\/raw\/[\w.-]+$/.test(url.pathname)) file = path.join(sourceRoot, 'kenney/Audio', path.basename(url.pathname));
      else if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<script type="module" src="/browser.js"></script>'); return; }
      if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await app.whenReady();
    console.log('Authoring audio context host ready');
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    win.webContents.on('console-message', (_e, _level, message) => console.log('[Strudel] ' + message));
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    for (let i = 0; i < 100 && !(await win.webContents.executeJavaScript('!!window.authorReady')); i++) await new Promise(r => setTimeout(r, 100));
    if (!(await win.webContents.executeJavaScript('!!window.authorReady'))) throw new Error('Strudel authoring page did not initialize');
    const output = path.join(ROOT, 'app/renderer/media/sfx');
    const report = [], entries = [];
    for (const material of ['grass', 'stone', 'wood', 'sand', 'snow', 'body']) {
      for (const action of material === 'body' ? ['jump'] : ['step', 'land']) {
        for (let n = 0; n < (material === 'body' ? 1 : 4); n++) {
          const id = action === 'jump' ? 'jump' : `${action}_${material}${['', '_b', '_c', '_d'][n]}`;
          const result = await win.webContents.executeJavaScript(`window.renderMovement(${JSON.stringify(material)},${n},${JSON.stringify(action)})`);
          const bytes = Buffer.from(result.base64, 'base64');
          fs.writeFileSync(path.join(output, id + '.wav'), bytes);
          entries.push({ id, file: id + '.wav', material,
            sourceFile: material === 'sand' ? 'sand_footsteps_0.mp3' : `footstep_${({ stone: 'concrete', body: 'carpet' })[material] || material}_00${n}.ogg`,
            bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), seconds: +result.seconds.toFixed(6),
            fallback: action === 'jump' ? 'jump' : 'step_' + material,
            modifiedNote: `Strudel core 1.2.6 / superdough 1.3.0; ${JSON.stringify(result.parameters)}; ${result.region ? 'source region ' + JSON.stringify(result.region) + '; ' : ''}trim, 18ms fade, RMS/peak limited, 44.1kHz mono 16bit WAV` });
          report.push({ id, seconds: result.seconds, rms: result.rms, peak: result.peak, region: result.region, strudel: result.parameters });
        }
        console.log('Rendered ' + material + ' / ' + action);
      }
    }
    const commons = {
      kenney: { author: 'Kenney', authorPage: 'https://kenney.nl', source: 'https://kenney.nl/assets/impact-sounds' },
      sand: { author: 'Peludo', authorPage: 'https://opengameart.org/users/peludo', source: 'https://opengameart.org/content/water-splash-and-sand-footsteps' }
    };
    const metadata = `// Generated by the Strudel movement-audio authoring tool.\nconst SOURCES = ${JSON.stringify(commons, null, 2)};\nconst CLIPS = ${JSON.stringify(entries, null, 2)};\nexport const MOVEMENT_SFX_FILES = Object.freeze(Object.fromEntries(CLIPS.map(clip => [clip.id, Object.freeze({\n  ...SOURCES[clip.material === 'sand' ? 'sand' : 'kenney'],\n  licence: 'CC0-1.0', licenceName: 'Creative Commons Zero v1.0',\n  attribution: 'CC0; sources credited in LICENSES.md',\n  title: clip.id, usedFor: '第一人称移动接触反馈', modified: true, ...clip\n})])));\n`;
    fs.writeFileSync(path.join(ROOT, 'app/renderer/js/core/movementfiles.js'), metadata);
    fs.writeFileSync(path.join(authorRoot, 'render-report.json'), JSON.stringify(report, null, 2));
    console.log('Strudel rendered ' + entries.length + ' WAV files; peak max ' + Math.max(...report.map(r => r.peak)).toFixed(4));
    win.destroy(); server.close(); app.exit(0);
  } catch (error) {
    console.error('Authoring failed: ' + (error?.stack || error?.message || String(error)));
    win?.destroy(); server?.close(); app.exit(1);
  }
}
