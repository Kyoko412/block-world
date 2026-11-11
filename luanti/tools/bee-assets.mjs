/*
 * 生成蜜蜂原型素材：16×16 条纹贴图 + 三条音效（嗡鸣/受伤/死亡）。
 * 全部由本项目生成（CC0），不依赖第三方素材。
 *   node .tools/bee-assets.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const MOD = path.join(ROOT, 'luanti/mods/mc_mobs');
const TEX = path.join(MOD, 'textures');
const SFX = path.join(MOD, 'sounds');
const FFMPEG = process.env.FFMPEG || '<外部工具目录>';
fs.mkdirSync(TEX, { recursive: true });
fs.mkdirSync(SFX, { recursive: true });

/* ---------- 最小 PNG 编码器（RGB，无 alpha） ---------- */
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
const crc32 = buf => {
  let c = 0xFFFFFFFF;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(width, height, pixels) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixels(x, y);
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* 蜜蜂：黄黑条纹 + 深色头 + 半透明翅膀位置用浅蓝白 */
const bee = (x, y) => {
  const stripe = Math.floor(y / 3) % 2 === 0;
  if (y <= 2) return [38, 32, 28];                 // 头
  if (x === 0 || x === 15 || y === 15) return [30, 26, 22];
  if (x >= 5 && x <= 10 && y >= 4 && y <= 9) return stripe ? [235, 198, 62] : [42, 36, 30];
  return stripe ? [228, 188, 52] : [46, 40, 34];
};
fs.writeFileSync(path.join(TEX, 'mc_mobs_bee.png'), png(16, 16, bee));

/* ---------- 音效：嗡鸣 / 受伤 / 死亡 ---------- */
const SR = 44100;
const wav = (samples, sr = SR) => {
  const n = samples.length, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
};
const buzz = (seconds, base, decay) => {
  const n = Math.round(seconds * SR), out = new Float32Array(n);
  let phase = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, u = t / seconds;
    const f = base * (1 + 0.06 * Math.sin(2 * Math.PI * 7 * t));
    phase += 2 * Math.PI * f / SR;
    const saw = ((phase / (2 * Math.PI)) % 1) * 2 - 1;
    lp += 0.25 * (saw - lp);
    const env = Math.min(1, t / 0.02) * Math.exp(-u / decay);
    out[i] = lp * env * 0.5;
  }
  return out;
};
fs.writeFileSync(path.join(SFX, 'mc_bee_idle.wav'), wav(buzz(0.6, 220, 0.55)));
fs.writeFileSync(path.join(SFX, 'mc_bee_hurt.wav'), wav(buzz(0.35, 320, 0.22)));
fs.writeFileSync(path.join(SFX, 'mc_bee_death.wav'), wav(buzz(0.5, 180, 0.3)));
for (const name of ['mc_bee_idle', 'mc_bee_hurt', 'mc_bee_death']) {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(SFX, name + '.wav'), '-ac', '1', '-c:a', 'libvorbis', '-q:a', '4', path.join(SFX, name + '.ogg')]);
  fs.unlinkSync(path.join(SFX, name + '.wav'));
}
console.log('蜜蜂原型素材已生成：textures/mc_mobs_bee.png + 3 条 OGG');
