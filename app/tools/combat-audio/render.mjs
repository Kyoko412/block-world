/*
 * 战斗/受伤音效的离线导出（制作端）。
 *   node app/tools/combat-audio/render.mjs
 *
 * 与 movement / interaction 同一套 harness（Electron + superdough + 单个 OfflineAudioContext），
 * 独立入口：不重渲染已经验收的移动与挖放音频。
 * 产出：app/renderer/media/sfx/{hit,hurt,shield,armor,bow,arrow}_*.wav + app/renderer/js/core/combatfiles.js
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

const USED_FOR = {
  hit: '玩家打中生物 / 打在有甲目标上的反馈',
  hurt: '玩家自己受伤（按原因分身份）',
  shield: '盾牌格挡与碎裂',
  armor: '护甲被磨损到碎掉',
  bow: '开弓放箭',
  arrow: '箭矢命中',
  swing: '挥空的风声',
  death: '死亡时衣料落定，衬托最后一次受伤'
};
/* 合成兜底：随包文件没取到时退回同名合成配方（必须指向真实存在的配方名，指向自己等于没有兜底）。 */
const FALLBACK = { hit_flesh: 'hit', hit_armor: 'hit', hurt_body: 'hurt', hurt_fall: 'hurt', hurt_drown: 'splash', bow_release: 'bow', arrow_hit: 'hit' };
const fallbackOf = id => { const base = id.replace(/_[b-d]$/, ''); return FALLBACK[base] || base; };
const actionOf = id => id.startsWith('hit_') ? 'hit'
  : id.startsWith('hurt_') ? 'hurt'
  : id.startsWith('shield_') ? 'shield'
  : id.startsWith('armor_') ? 'armor'
  : id.startsWith('bow_') ? 'bow'
  : id.startsWith('arrow_') ? 'arrow' : id.startsWith('swing') ? 'swing' : 'death';

async function runAuthor() {
  const { app, BrowserWindow } = await import('electron');
  const authorRoot = path.join(ROOT, '.tmp-audio/strudel-authoring');
  const sourceRoot = path.join(ROOT, '.tmp-audio/combat-source');
  const require = createRequire(path.join(authorRoot, 'package.json'));
  const { build } = require('esbuild');
  const { JOBS } = await import('./patterns.mjs');
  const { SOURCES } = await import('./recordings.mjs');
  const recordingPath = source => source.cache === 'kenney'
    ? path.join(ROOT, '.tmp-audio/movement-source/kenney/Audio', source.file) : path.join(sourceRoot, source.file);
  let server, win;
  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    for (const source of Object.values(SOURCES)) {
      const file = recordingPath(source);
      if (!fs.existsSync(file)) {
        if (!source.download) throw new Error('Reuse the prepared Kenney Impact Sounds cache: ' + source.file);
        const response = await fetch(source.download, { signal: AbortSignal.timeout(30000),
          headers: source.byteLimit ? { Range: `bytes=0-${source.byteLimit - 1}` } : {} });
        if (!response.ok) throw new Error('Recording download failed: ' + source.download);
        let bytes;
        if (source.byteLimit) {
          const reader = response.body.getReader(), chunks = []; let size = 0;
          while (size < source.byteLimit) { const { value, done } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); size += value.length; }
          await reader.cancel(); bytes = Buffer.concat(chunks).subarray(0, source.byteLimit);
        } else bytes = Buffer.from(await response.arrayBuffer());
        if (source.download.endsWith('.zip')) {
          const archive = path.join(sourceRoot, 'warsong-rpg-foley.zip'); fs.writeFileSync(archive, bytes);
          const appRequire = createRequire(path.join(ROOT, 'app/package.json'));
          await appRequire('extract-zip')(archive, { dir: sourceRoot });
        } else fs.writeFileSync(file, bytes);
      }
      const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (hash !== source.sha256) throw new Error('Recording SHA-256 mismatch: ' + source.file);
    }
    await build({ entryPoints: [path.join(HERE, 'render-browser.mjs')], bundle: true, format: 'esm', platform: 'browser',
      nodePaths: [path.join(authorRoot, 'node_modules')], outfile: path.join(authorRoot, 'combat-bundle.js') });
    console.log('Strudel authoring bundle ready');
    server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      let file;
      if (url.pathname === '/browser.js') file = path.join(authorRoot, 'combat-bundle.js');
      else if (url.pathname.startsWith('/raw/')) {
        const source = SOURCES[url.pathname.slice(5)]; if (source) file = recordingPath(source);
      }
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
    for (let i = 0; i < 150 && !(await win.webContents.executeJavaScript('!!window.authorReady')); i++) await new Promise(r => setTimeout(r, 100));
    if (!(await win.webContents.executeJavaScript('!!window.authorReady'))) throw new Error('Authoring page did not initialize');

    const output = path.join(ROOT, 'app/renderer/media/sfx');
    const report = [], entries = [];
    for (const job of JOBS) {
      const result = await win.webContents.executeJavaScript(`window.renderCombat(${JSON.stringify(job.id)})`);
      const bytes = Buffer.from(result.base64, 'base64');
      fs.writeFileSync(path.join(output, result.id + '.wav'), bytes);
      const recordings = result.layers.map(layer => {
        const source = SOURCES[layer.source];
        return { author: source.author, authorPage: source.authorPage, source: source.source,
          sourceFile: source.file, recordingSha256: source.sha256, sourceNote: source.note,
          sourceRange: layer.sourceRange, at: layer.at, gain: layer.gain, speed: layer.speed };
      });
      entries.push({
        id: result.id,
        file: result.id + '.wav',
        action: actionOf(result.id),
        ...recordings[0],
        extraSources: recordings.slice(1),
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        seconds: +result.seconds.toFixed(6),
        fallback: fallbackOf(result.id),
        modifiedNote: 'Strudel core 1.2.6 / superdough 1.3.0; ' + JSON.stringify({ tone: result.tone, layers: result.layers }) +
          '; real recording cuts, DC removal, gentle filters; no synthetic layers, bitcrush, pitch shifting or reverb; 3/8ms fade-in, 30ms fade-out, clip RMS / peak limited, 44.1kHz mono 16bit WAV'
      });
      report.push({ id: result.id, seconds: result.seconds, rms: result.rms, peak: result.peak, layers: result.layers });
      console.log('Rendered ' + result.id);
    }

    const metadata = `// Generated by the Strudel combat-audio authoring tool.
/* 战斗与受伤：全部使用真实 CC0 录音，每层记录原页、切片与指纹。 */
const CLIPS = ${JSON.stringify(entries, null, 2)};
export const COMBAT_SFX_FILES = Object.freeze(Object.fromEntries(CLIPS.map(clip => [clip.id, Object.freeze({
  licence: 'CC0-1.0', licenceName: 'Creative Commons Zero v1.0',
  attribution: 'CC0 recordings by Kenney, Wareya, unfa, Ali_6868 and felix.blume; credit optional',
  title: clip.id, usedFor: ${JSON.stringify(USED_FOR)}[clip.action], modified: true, ...clip
})])));
`;
    fs.writeFileSync(path.join(ROOT, 'app/renderer/js/core/combatfiles.js'), metadata);
    const reportDir = path.join(ROOT, 'artifacts/combat-audio');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'render-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), clips: report }, null, 2));
    console.log('Strudel rendered ' + entries.length + ' WAV files; peak max ' + Math.max(...report.map(r => r.peak)).toFixed(4));
    win.destroy(); server.close(); app.exit(0);
  } catch (error) {
    console.error('Authoring failed: ' + (error?.stack || error?.message || String(error)));
    win?.destroy(); server?.close(); app.exit(1);
  }
}
