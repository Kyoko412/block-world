import fs from 'node:fs';
import zlib from 'node:zlib';

const SRC = 'C:/l3tmp/world/map.txt';
const OUT = 'E:/MinecraftOffline/artifacts/l3-map.png';
const SCALE = 12;

const COLORS = {
  'mcl_core:stonebrick': [138, 138, 138],
  'mcl_core:goldblock': [242, 201, 76],
  'mcl_core:water_source': [58, 111, 216],
  'mcl_minecarts:rail': [122, 92, 58],
  'air': [245, 245, 245],
  'ignore': [255, 0, 255],
  'mcl_wool:red': [200, 40, 40],
  'mcl_wool:orange': [230, 130, 40],
  'mcl_wool:yellow': [230, 210, 60],
  'mcl_wool:green': [70, 150, 60],
  'mcl_wool:cyan': [40, 160, 170],
  'mcl_wool:blue': [50, 70, 190],
  'mcl_wool:purple': [120, 50, 170],
  'mcl_wool:magenta': [190, 60, 170],
  'mcl_wool:pink': [230, 150, 180],
  'mcl_wool:white': [235, 235, 235],
  'mcl_wool:grey': [110, 110, 110],
  'mcl_wool:black': [35, 35, 35]
};

const rows = fs.readFileSync(SRC, 'utf8').trim().split('\n');
const cells = new Map();
for (const row of rows) {
  const [x, z, raw] = row.split(' '); const name = (raw || '').trim();
  cells.set(`${x},${z}`, name);
}

const size = 49 * SCALE;
const px = Buffer.alloc(size * size * 3, 255);
for (let gx = -24; gx <= 24; gx++) {
  for (let gz = -24; gz <= 24; gz++) {
    const name = cells.get(`${gx},${gz}`) || 'air';
    const color = COLORS[name] || [160, 160, 160];
    const px0 = (gx + 24) * SCALE;
    const pz0 = (gz + 24) * SCALE;
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const at = ((pz0 + dy) * size + px0 + dx) * 3;
        px[at] = color[0]; px[at + 1] = color[1]; px[at + 2] = color[2];
      }
    }
  }
}

// 网格线
for (let i = 0; i <= 49; i++) {
  for (let d = 0; d < size; d++) {
    const pos = i * SCALE;
    for (const [x, y] of [[pos, d], [d, pos]]) {
      if (x >= size || y >= size) continue;
      const at = (y * size + x) * 3;
      px[at] = Math.min(px[at], 200); px[at + 1] = Math.min(px[at + 1], 200); px[at + 2] = Math.min(px[at + 2], 200);
    }
  }
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) c = crcTable[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;

const raw = Buffer.alloc((size * 3 + 1) * size);
for (let y = 0; y < size; y++) {
  raw[y * (size * 3 + 1)] = 0;
  px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
}
fs.writeFileSync(OUT, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]));
console.log('wrote', OUT, size + 'x' + size);
