/*
 * 生成原创蜜蜂模型、像素贴图和音效（CC0）。
 *   node luanti/tools/bee-assets.mjs --art-only
 * 省略 --art-only 时还会用 FFMPEG 生成嗡鸣、受伤和死亡音效。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOD = path.join(ROOT, 'luanti/mods/mc_mobs');
const TEX = path.join(MOD, 'textures');
const MODELS = path.join(MOD, 'models');
const SFX = path.join(MOD, 'sounds');
const FFMPEG = process.env.FFMPEG || '<外部工具目录>';
fs.mkdirSync(TEX, { recursive: true });
fs.mkdirSync(MODELS, { recursive: true });

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

/* ---------- 像素贴图。身体各面、两翼和小部件共用一张图集 ---------- */
const ATLAS_WIDTH = 64;
const ATLAS_HEIGHT = 32;
const tiles = {
  face:   { x:  2, y:  2, w:  8, h:  7 },
  side:   { x: 13, y:  2, w: 10, h:  7 },
  back:   { x: 26, y:  2, w:  8, h:  7 },
  top:    { x:  2, y: 12, w:  8, h: 10 },
  bottom: { x: 13, y: 12, w:  8, h: 10 },
  wing:   { x: 26, y: 12, w:  7, h:  5 },
  dark:   { x: 37, y:  2, w:  3, h:  3 },
  amber:  { x: 43, y:  2, w:  3, h:  3 },
};
const facePixels = [
  'gghhhhgg',
  'ghhhhhhg',
  'hHnhhnHh',
  'hnBggBnh',
  'hnnggnnh',
  'gccmmccg',
  'ssggggss',
];
const faceColors = {
  h: 0xf6c655, g: 0xeab048, s: 0xc88735, c: 0xf4b94c, m: 0xa15f31,
};
const eyeColors = {
  calm:  { n: 0x262a37, B: 0x577c9a, H: 0xf4f5db },
  angry: { n: 0x671f2b, B: 0xc4312f, H: 0xff7b60 },
};
const wingPixels = [
  'bbbbbbb',
  'bwwwllb',
  'blwlwwb',
  'blllwwb',
  'bbbbbbb',
];
const wingColors = { b: 0x9ab5bb, l: 0xc5dbe0, w: 0xf0f0de };

function paintBee(eyes) {
  const atlas = new Uint32Array(ATLAS_WIDTH * ATLAS_HEIGHT);
  function paint(tile, pixel) {
    // Extend edge colors by one texel so adjacent tiles do not bleed.
    for (let y = -1; y <= tile.h; y++) {
      for (let x = -1; x <= tile.w; x++) {
        const u = Math.max(0, Math.min(tile.w - 1, x));
        const v = Math.max(0, Math.min(tile.h - 1, y));
        atlas[(tile.y + y) * ATLAS_WIDTH + tile.x + x] = pixel(u, v);
      }
    }
  }
  function stripe(depth, shade) {
    const dark = depth === 3 || depth === 4 || depth >= 8;
    const colors = dark ? [0x694431, 0x543429, 0x402a25] : [0xf4c65a, 0xe7a840, 0xbf7c33];
    return colors[shade];
  }
  paint(tiles.face, (x, y) => {
    const ink = facePixels[y][x];
    return eyes[ink] ?? faceColors[ink];
  });
  paint(tiles.side, (x, y) => stripe(x, y === 0 ? 0 : y >= 5 ? 2 : 1));
  paint(tiles.top, (x, y) => stripe(y, x === 0 || x === 7 ? 1 : 0));
  paint(tiles.bottom, (_x, y) => stripe(y, 2));
  paint(tiles.back, (x, y) => (x === 0 || x === 7 || y >= 5) ? 0x513126 : 0x70452c);
  paint(tiles.wing, (x, y) => wingColors[wingPixels[y][x]]);
  paint(tiles.dark, (_x, y) => y === 0 ? 0x624132 : 0x392721);
  paint(tiles.amber, (_x, y) => y === 0 ? 0xa6753b : 0x74513a);
  return png(ATLAS_WIDTH, ATLAS_HEIGHT, (x, y) => {
    const rgb = atlas[y * ATLAS_WIDTH + x];
    return [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
  });
}

/* ---------- 低多边形模型。每像素 0.05 格，正面朝 glTF 的 +Z ---------- */
function beeMesh() {
  const positions = [], normals = [], uv = [], joints = [], weights = [], indices = [];
  const pixel = 0.5; // Luanti 网格中 10 单位等于 1 格。
  const hinge = (side) => [side * 2.8, 8.1, 1.7];
  const difference = (a, b) => a.map((v, i) => v - b[i]);

  function face(points, texcoords, tile, joint = 0) {
    const start = positions.length / 3;
    const [a, b, c] = points;
    const [ux, uy, uz] = difference(b, a);
    const [vx, vy, vz] = difference(c, a);
    const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const length = Math.hypot(...normal);
    for (let i = 0; i < points.length; i++) {
      positions.push(...points[i].map(v => v * pixel));
      normals.push(...normal.map(v => v / length));
      const [u, v] = texcoords[i];
      uv.push((tile.x + u * tile.w) / ATLAS_WIDTH, (tile.y + v * tile.h) / ATLAS_HEIGHT);
      joints.push(joint, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    for (let i = 1; i < points.length - 1; i++) indices.push(start, start + i, start + i + 1);
  }

  // Corners of a rectangle are listed in the order top left, bottom left, bottom right, top right.
  const rect = [[0, 0], [0, 1], [1, 1], [1, 0]];
  const flipped = rect.map(([u, v]) => [1 - u, v]);
  function box([x0, y0, z0], [x1, y1, z1], surface) {
    const tile = typeof surface === 'string' ? () => tiles[surface] : name => tiles[name];
    face([[x0,y1,z1], [x0,y0,z1], [x1,y0,z1], [x1,y1,z1]], rect, tile('face'));
    face([[x1,y1,z0], [x1,y0,z0], [x0,y0,z0], [x0,y1,z0]], rect, tile('back'));
    face([[x0,y1,z0], [x0,y0,z0], [x0,y0,z1], [x0,y1,z1]], flipped, tile('side'));
    face([[x1,y1,z1], [x1,y0,z1], [x1,y0,z0], [x1,y1,z0]], rect, tile('side'));
    face([[x1,y1,z1], [x1,y1,z0], [x0,y1,z0], [x0,y1,z1]], rect, tile('top'));
    face([[x0,y0,z1], [x0,y0,z0], [x1,y0,z0], [x1,y0,z1]], rect, tile('bottom'));
  }

  box([-4, 1, -5], [4, 8, 5]);
  box([-0.38, 3.2, -7.1], [0.38, 4, -4.9], 'dark');
  for (const side of [-1, 1]) {
    const x = side * 2.6;
    box([x - 0.38, 7.9, 3.5], [x + 0.38, 10.2, 4.2], 'dark');
    box([x - 0.4, 9.6, 4.1], [x + 0.4, 10.4, 5.25], 'amber');
    for (const z of [-3.4, -0.5, 2.4]) {
      const foot = side * 2.9;
      box([foot - 0.38, 0.15, z], [foot + 0.38, 1.15, z + 0.85], 'dark');
    }

    const [hx, hy, hz] = hinge(side);
    const outline = [[0,1], [4.8,1], [6.3,0.2], [6.3,-2.1], [5.1,-3.1], [1.2,-2.7], [0,-1]];
    const points = outline.map(([x, z]) => [hx + x * side, hy, hz + z]);
    const texcoords = outline.map(([x, z]) => [x / 6.3, (1 - z) / 4.1]);
    const joint = side === -1 ? 1 : 2;
    face(points, texcoords, tiles.wing, joint);
    face(points.toReversed(), texcoords.toReversed(), tiles.wing, joint);
  }
  return { positions, normals, uv, joints, weights, indices, hinges: [-1, 1].map(side => hinge(side).map(v => v * pixel)) };
}

function beeGlb() {
  const mesh = beeMesh();
  const data = [];
  const bufferViews = [];
  const accessors = [];
  let byteLength = 0;
  function accessor(values, Type, componentType, type, components, bounds) {
    const bytes = Buffer.from(new Type(values).buffer);
    const padding = (4 - bytes.length % 4) % 4;
    const bufferView = bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length }) - 1;
    data.push(bytes, Buffer.alloc(padding));
    byteLength += bytes.length + padding;
    return accessors.push({ bufferView, componentType, type, count: values.length / components, ...bounds }) - 1;
  }
  const floats = (values, type, components, bounds) => accessor(values, Float32Array, 5126, type, components, bounds);
  const bounds = [0, 1, 2].map(axis => mesh.positions.filter((_v, index) => index % 3 === axis));
  const attributes = {
    POSITION: floats(mesh.positions, 'VEC3', 3, { min: bounds.map(a => Math.min(...a)), max: bounds.map(a => Math.max(...a)) }),
    NORMAL: floats(mesh.normals, 'VEC3', 3),
    TEXCOORD_0: floats(mesh.uv, 'VEC2', 2),
    JOINTS_0: accessor(mesh.joints, Uint8Array, 5121, 'VEC4', 4),
    WEIGHTS_0: floats(mesh.weights, 'VEC4', 4),
  };
  const indices = accessor(mesh.indices, Uint16Array, 5123, 'SCALAR', 1);
  const inverseBind = ([x, y, z]) => [1,0,0,0, 0,1,0,0, 0,0,1,0, -x,-y,-z,1];
  const inverseBindMatrices = floats([[0,0,0], ...mesh.hinges].flatMap(inverseBind), 'MAT4', 16);
  const times = [0, 0.04, 0.08, 0.12, 0.16];
  const input = floats(times, 'SCALAR', 1, { min: [times[0]], max: [times.at(-1)] });
  const rotations = [-1, 1].map(side => floats([19, 49, 19, -17, 19].flatMap(degrees => {
    const halfAngle = side * degrees * Math.PI / 360;
    return [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)];
  }), 'VEC4', 4));

  const gltf = {
    asset: { version: '2.0', generator: 'Block World CN bee-assets' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: 'bee', mesh: 0, skin: 0 },
      { name: 'body', children: [2, 3] },
      { name: 'wing_left', translation: mesh.hinges[0] },
      { name: 'wing_right', translation: mesh.hinges[1] },
    ],
    meshes: [{ primitives: [{ attributes, indices, material: 0 }] }],
    skins: [{ joints: [1, 2, 3], skeleton: 1, inverseBindMatrices }],
    animations: [{
      name: 'flap',
      samplers: rotations.map(output => ({ input, output, interpolation: 'LINEAR' })),
      channels: rotations.map((_rotation, index) => ({ sampler: index, target: { node: index + 2, path: 'rotation' } })),
    }],
    // Luanti supplies the base-color image through the entity's textures property.
    textures: [{}],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    accessors, bufferViews, buffers: [{ byteLength }],
  };
  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonPadding = Buffer.alloc((4 - json.length % 4) % 4, 0x20);
  const header = Buffer.alloc(12);
  header.write('glTF');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + jsonPadding.length + 8 + byteLength, 8);
  function glbChunk(length, type) {
    const result = Buffer.alloc(8);
    result.writeUInt32LE(length);
    result.write(type, 4);
    return result;
  }
  return Buffer.concat([
    header, glbChunk(json.length + jsonPadding.length, 'JSON'), json, jsonPadding,
    glbChunk(byteLength, 'BIN\0'), ...data,
  ]);
}

fs.writeFileSync(path.join(MODELS, 'mc_mobs_bee.glb'), beeGlb());
fs.writeFileSync(path.join(TEX, 'mc_mobs_bee.png'), paintBee(eyeColors.calm));
fs.writeFileSync(path.join(TEX, 'mc_mobs_bee_angry.png'), paintBee(eyeColors.angry));
console.log('已生成蜜蜂模型和普通、红眼贴图');

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
if (!process.argv.includes('--art-only')) {
  fs.mkdirSync(SFX, { recursive: true });
  fs.writeFileSync(path.join(SFX, 'mc_bee_idle.wav'), wav(buzz(0.6, 220, 0.55)));
  fs.writeFileSync(path.join(SFX, 'mc_bee_hurt.wav'), wav(buzz(0.35, 320, 0.22)));
  fs.writeFileSync(path.join(SFX, 'mc_bee_death.wav'), wav(buzz(0.5, 180, 0.3)));
  for (const name of ['mc_bee_idle', 'mc_bee_hurt', 'mc_bee_death']) {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', path.join(SFX, name + '.wav'), '-ac', '1', '-c:a', 'libvorbis', '-q:a', '4', path.join(SFX, name + '.ogg')]);
    fs.unlinkSync(path.join(SFX, name + '.wav'));
  }
  console.log('已生成蜜蜂的 3 条 OGG 音效');
}
