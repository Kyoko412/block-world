/*
 * 极小 PNG 编码器（Node，零依赖）：给「贴图小样 / 材质对照表」出可打开的图片证据。
 * 只做 8bit RGB(A)、无滤波、单张 IDAT。用于 tests/probe-painters.mjs 与材质对照脚本。
 */
import zlib from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** rgba: Uint8ClampedArray/Buffer 长度 w*h*4 → PNG Buffer */
export function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer ? rgba.buffer : rgba, rgba.byteOffset || 0, rgba.length)
      .copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 把若干 16×16 tile 拼成一张带间距的对照图 */
export function encodeTileSheet(tiles, opts = {}) {
  const scale = opts.scale || 6;
  const pad = opts.pad || 4;
  const cols = opts.cols || tiles.length;
  const rows = Math.ceil(tiles.length / cols);
  const cell = 16 * scale;
  const w = cols * cell + (cols + 1) * pad;
  const h = rows * cell + (rows + 1) * pad;
  const out = new Uint8ClampedArray(w * h * 4);
  // 背景（棋盘格，用于看清透明区域）
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const c = ((x >> 3) + (y >> 3)) % 2 ? 40 : 26;
    out[o] = c; out[o + 1] = c; out[o + 2] = c; out[o + 3] = 255;
  }
  tiles.forEach((t, i) => {
    const cx = pad + (i % cols) * (cell + pad);
    const cy = pad + Math.floor(i / cols) * (cell + pad);
    for (let y = 0; y < 16 * scale; y++) for (let x = 0; x < 16 * scale; x++) {
      const sx = (x / scale) | 0, sy = (y / scale) | 0;
      const so = (sy * 16 + sx) * 4;
      const a = t.rgba[so + 3] / 255;
      if (a <= 0) continue;
      const o = ((cy + y) * w + cx + x) * 4;
      out[o] = t.rgba[so] * a + out[o] * (1 - a);
      out[o + 1] = t.rgba[so + 1] * a + out[o + 1] * (1 - a);
      out[o + 2] = t.rgba[so + 2] * a + out[o + 2] * (1 - a);
      out[o + 3] = 255;
    }
  });
  return { width: w, height: h, buffer: encodePNG(w, h, out) };
}
