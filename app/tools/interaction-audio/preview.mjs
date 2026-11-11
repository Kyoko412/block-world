/*
 * 挖掘/放置的试听世界与短对照（制作/交付用，不进游戏运行期）。
 *   · createDigPreview()：一个平坦的生存试玩场地，四组材质墙面 + 一片空地用于放置；
 *     meta.noSpawn 保持安静，工具与方块预先放进背包，保证「按住左键就能听到持续敲击」。
 *   · createInteractionClips()：把导出的 WAV 按真实顺序（敲四下 → 破坏 → 放置两下）拼成短对照。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoxelWorld, SAVE_VERSION, NEW_WORLD_GEN_VERSION } from '../../renderer/js/world/world.js';
import { B } from '../../renderer/js/core/blocks.js';
import { monoWave } from '../movement-audio/wave.mjs';

export const PREVIEW_NAME = '挖放试听-20261110';
export const MATERIAL_LABELS = { dirt: '土', stone: '石', wood: '木', sand: '沙砾', grass: '草叶' };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100;

export function createDigPreview() {
  const seed = 51877, floor = 48;
  const world = new VoxelWorld(seed, { genVersion: NEW_WORLD_GEN_VERSION });
  for (let cx = -1; cx <= 1; cx++) for (let cz = -2; cz <= 1; cz++) world.ensureChunk(cx, cz);
  /* 先把场地清平：一块石基、一层草面，上面留出 8 格空气 */
  for (let x = -4; x <= 22; x++) for (let z = -12; z <= 10; z++) {
    world.setBlock(x, floor - 1, z, B.STONE);
    world.setBlock(x, floor, z, B.GRASS);
    for (let y = floor + 1; y <= floor + 9; y++) world.setBlock(x, y, z, B.AIR);
  }
  const station = (x0, z0, width, height, depth, ids) => {
    for (let x = x0; x < x0 + width; x++) for (let y = floor + 1; y <= floor + height; y++) {
      for (let z = z0; z < z0 + depth; z++) {
        const id = ids[(x - x0 + (y - floor - 1) + (z - z0)) % ids.length];
        world.setBlock(x, y, z, id);
      }
    }
  };
  /* 一排材质墙：站在前面按住左键就能听这一层的持续敲击。 */
  station(0, -8, 3, 3, 2, [B.DIRT, B.GRASS, B.DIRT]);
  station(4, -8, 3, 3, 2, [B.STONE, B.COBBLESTONE, B.DEEPSLATE]);
  station(8, -8, 3, 3, 2, [B.LOG, B.BIRCH_LOG, B.PLANKS]);
  station(12, -8, 3, 3, 2, [B.SAND, B.GRAVEL, B.SAND]);
  station(16, -8, 3, 3, 2, [B.LEAVES, B.BIRCH_LEAVES, B.LEAVES]);
  /* 放置区：一圈木板边框，中间空地，方便听不同材质的落定接触 */
  for (let x = 0; x <= 8; x++) { world.setBlock(x, floor, 6, B.PLANKS); world.setBlock(x, floor, 2, B.PLANKS); }
  for (let z = 2; z <= 6; z++) { world.setBlock(0, floor, z, B.PLANKS); world.setBlock(8, floor, z, B.PLANKS); }
  const spawn = { x: 4.5, y: floor + 1.02, z: 4.5 };
  return {
    meta: {
      name: PREVIEW_NAME, seed: String(seed), numericSeed: seed, mode: 'survival', version: SAVE_VERSION,
      genVersion: NEW_WORLD_GEN_VERSION, createdAt: Date.UTC(2026, 10, 10, 14), noSpawn: true
    },
    player: { ...spawn, yaw: 0, pitch: -0.08, health: 20, hunger: 20, saturation: 5, flying: false, spawn },
    /* 存档里的背包是槽位数组 {i,c}，选中格单独放在 selected；写错形状会读成空手。 */
    inventory: [
      { i: 'pickaxe_wood', c: 1 },
      { i: 'axe_wood', c: 1 },
      { i: 'shovel_wood', c: 1 },
      { i: 'dirt', c: 64 },
      { i: 'stone', c: 64 },
      { i: 'planks', c: 64 },
      { i: 'sand', c: 64 },
      { i: 'birch_planks', c: 64 },
      null
    ],
    selected: 0,
    time: 0.28, chunks: world.serializeEdits(), furnaces: {}, containers: {},
    weather: { t: 'clear', left: 600, el: 0, inten: 0 }, mobs: []
  };
}

function readWav(file) {
  const bytes = fs.readFileSync(file);
  const data = new Int16Array(bytes.buffer, bytes.byteOffset + 44, (bytes.length - 44) >> 1);
  const signal = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) signal[i] = data[i] / 32768;
  return signal;
}

/* 一段对照 = 四下敲击（0.03s 起、每 0.30s 一下）→ 破坏 → 两下放置。 */
export function createInteractionClips(destination) {
  const source = path.resolve(HERE, '../../renderer/media/sfx');
  fs.mkdirSync(destination, { recursive: true });
  const length = Math.round(SR * 3.7);
  const album = [];
  for (const [family, label] of Object.entries(MATERIAL_LABELS)) {
    const clip = new Float32Array(length);
    const add = (name, at, gain) => {
      let signal;
      try { signal = readWav(path.join(source, name + '.wav')); } catch { return; }
      const start = Math.round(at * SR);
      for (let i = 0; i < signal.length && start + i < clip.length; i++) clip[start + i] += signal[i] * gain;
    };
    const digBase = 'dig_' + family;
    for (const [n, suffix] of ['', '_b', '_c', '_d'].entries()) add(digBase + suffix, 0.05 + n * 0.3, 0.55);
    add('break_' + family, 1.45, 0.8);
    const placeBase = family === 'grass' ? 'place' : 'place_' + family;
    add(placeBase, 2.15, 0.5);
    add(placeBase + '_b', 2.5, 0.5);
    let peak = 0;
    for (const value of clip) peak = Math.max(peak, Math.abs(value));
    if (peak > 0.92) for (let i = 0; i < clip.length; i++) clip[i] *= 0.92 / peak;
    fs.writeFileSync(path.join(destination, label + '.wav'), monoWave(clip));
    album.push(clip);
  }
  const total = new Float32Array(length * album.length);
  album.forEach((clip, index) => total.set(clip, index * length));
  fs.writeFileSync(path.join(destination, '五种材质对照.wav'), monoWave(total));
}
