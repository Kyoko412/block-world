/*
 * 本地回环 HTTP 服务：同时为 Electron 与浏览器测试模式提供
 *   1) 游戏前端静态资源
 *   2) 存档 / 设置的读写 API
 * 只监听 127.0.0.1，不访问任何外部网络，保证完全离线运行。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac'
};

/* 世界名只允许安全字符（含中文），防止路径穿越 */
export function safeName(name) {
  const s = String(name || '').trim();
  if (!s || s.length > 48) return null;
  if (!/^[0-9A-Za-z\u4e00-\u9fff _.\-]+$/.test(s)) return null;
  if (s.startsWith('.')) return null;
  return s;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj));
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { /* ignore */ }
  fs.renameSync(tmp, file);
}

export function createServer(opts) {
  const staticRoot = opts.staticRoot;
  const saveRoot = opts.saveRoot;
  fs.mkdirSync(saveRoot, { recursive: true });

  const worldFile = (name) => path.join(saveRoot, safeName(name) + '.json');
  const settingsFile = path.join(saveRoot, 'settings.json');

  function listWorlds() {
    let files = [];
    try { files = fs.readdirSync(saveRoot).filter(f => f.endsWith('.json') && f !== 'settings.json'); }
    catch (e) { return []; }
    const out = [];
    for (const f of files) {
      const data = readJson(path.join(saveRoot, f), null);
      if (!data || !data.meta) continue;
      out.push({
        file: f,
        name: data.meta.name,
        seed: data.meta.seed,
        mode: data.meta.mode,
        savedAt: data.meta.savedAt,
        version: data.meta.version,
        size: (() => { try { return fs.statSync(path.join(saveRoot, f)).size; } catch (e) { return 0; } })()
      });
    }
    out.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    return out;
  }

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store'
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > 256 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === '/api/ping') return sendJson(res, 200, { ok: true, app: 'moshou-shijie', offline: true });

      if (p === '/api/worlds' && req.method === 'GET') return sendJson(res, 200, { ok: true, worlds: listWorlds() });

      if (p === '/api/world/load' && req.method === 'GET') {
        const name = safeName(url.searchParams.get('name'));
        if (!name) return sendJson(res, 400, { ok: false, error: '非法世界名' });
        const data = readJson(worldFile(name), null);
        if (!data) return sendJson(res, 404, { ok: false, error: '存档不存在' });
        return sendJson(res, 200, { ok: true, data });
      }

      if (p === '/api/world/save' && req.method === 'POST') {
        const raw = await readBody(req);
        let data;
        try { data = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
        const name = safeName(data && data.meta && data.meta.name);
        if (!name) return sendJson(res, 400, { ok: false, error: '非法世界名' });
        data.meta.savedAt = Date.now();
        writeJsonAtomic(worldFile(name), data);
        return sendJson(res, 200, { ok: true, savedTo: worldFile(name) });
      }

      if (p === '/api/world/delete' && req.method === 'POST') {
        const name = safeName(url.searchParams.get('name'));
        if (!name) return sendJson(res, 400, { ok: false, error: '非法世界名' });
        try { fs.unlinkSync(worldFile(name)); } catch (e) { /* ignore */ }
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/settings' && req.method === 'GET') return sendJson(res, 200, { ok: true, settings: readJson(settingsFile, {}) });

      if (p === '/api/settings' && req.method === 'POST') {
        const raw = await readBody(req);
        let s; try { s = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
        writeJsonAtomic(settingsFile, s);
        return sendJson(res, 200, { ok: true });
      }

      if (p === '/api/screenshot' && req.method === 'POST') {
        const raw = await readBody(req);
        let j; try { j = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' }); }
        const dir = path.join(saveRoot, 'screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const base = String(j.name || 'shot').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40);
        const m = /^data:image\/png;base64,(.+)$/s.exec(String(j.dataUrl || ''));
        if (!m) return sendJson(res, 400, { ok: false, error: '不是 PNG dataURL' });
        const file = path.join(dir, base + '-' + Date.now() + '.png');
        fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
        return sendJson(res, 200, { ok: true, file });
      }

      if (p === '/api/quit' && req.method === 'POST') {
        sendJson(res, 200, { ok: true });
        if (opts.onQuit) setTimeout(() => opts.onQuit(), 150);
        return;
      }

      /* 静态文件 */
      const rel = p === '/' ? '/index.html' : p;
      const file = path.normalize(path.join(staticRoot, rel));
      if (!file.startsWith(path.normalize(staticRoot))) { res.writeHead(403); return res.end('forbidden'); }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found: ' + rel);
      }
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(opts.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server, port,
        url: 'http://127.0.0.1:' + port + '/index.html',
        saveRoot,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}

export function defaultStaticRoot() {
  return path.join(__dirname, 'renderer');
}

/* 优先使用程序目录下的 saves/（便携模式），失败则退回用户目录 */
export function pickSaveRoot(preferred) {
  if (preferred) {
    try { fs.mkdirSync(preferred, { recursive: true }); return preferred; } catch (e) { /* fallthrough */ }
  }
  const portable = path.join(process.cwd(), 'saves');
  try {
    fs.mkdirSync(portable, { recursive: true });
    const probe = path.join(portable, '.write-test');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return portable;
  } catch (e) {
    const alt = path.join(os.homedir(), '方块世界存档');
    try { fs.mkdirSync(alt, { recursive: true }); } catch (e2) { /* ignore */ }
    return alt;
  }
}
