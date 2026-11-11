import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoxelWorld, SAVE_VERSION, NEW_WORLD_GEN_VERSION } from '../../renderer/js/world/world.js';
import { B } from '../../renderer/js/core/blocks.js';
import { monoWave } from './wave.mjs';

export const PREVIEW_NAME = '移动音效试听-20261110';
export const MATERIAL_LABELS = { grass: '草土', stone: '石头', wood: '木板', sand: '沙砾', snow: '雪地' };
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createMovementPreview() {
  const seed = 73421, floor = 48;
  const world = new VoxelWorld(seed, { genVersion: NEW_WORLD_GEN_VERSION });
  for (let cx = -1; cx <= 1; cx++) for (let cz = -2; cz <= 0; cz++) world.ensureChunk(cx, cz);
  for (let x = -3; x <= 28; x++) for (let z = -22; z <= 10; z++) {
    for (let y = floor + 1; y < 63; y++) world.setBlock(x, y, z, B.AIR);
    world.setBlock(x, floor - 1, z, B.STONE);
    world.setBlock(x, floor, z, B.PLANKS);
  }
  const surfaces = [B.GRASS, B.STONE, B.PLANKS, B.SAND, B.SNOW];
  surfaces.forEach((id, lane) => {
    const left = lane * 5;
    for (let x = left; x < left + 4; x++) for (let z = -19; z <= 5; z++) {
      world.setBlock(x, floor, z, id);
      if (id === B.GRASS && z < -8) world.setBlock(x, floor, z, B.DIRT);
      if (id === B.SAND && z < -8) world.setBlock(x, floor, z, B.GRAVEL);
      if (id === B.PLANKS && z < -8) world.setBlock(x, floor, z, B.BIRCH_PLANKS);
    }
    for (let x = left; x < left + 4; x++) for (let y = floor + 1; y <= floor + 3; y++) world.setBlock(x, y, -20, B.STONE_BRICKS);
    for (let x = left + 1; x <= left + 2; x++) world.setBlock(x, floor + 1, -5, id);
  });
  for (const [left, slab, stairs, block] of [[5, B.SLAB_STONE, B.STAIRS_STONE, B.STONE], [10, B.SLAB_PLANKS, B.STAIRS_PLANKS, B.PLANKS]]) {
    for (let x = left; x < left + 4; x++) {
      world.setBlock(x, floor + 1, -11, slab);
      world.setBlock(x, floor + 1, -12, stairs, 1);
      world.setBlock(x, floor + 1, -13, block);
    }
  }
  for (let x = 25; x <= 27; x++) for (let z = -5; z <= -1; z++) world.setBlock(x, floor, z, B.WATER);
  const spawn = { x: 1.5, y: floor + 1.02, z: 7.5 };
  return {
    meta: { name: PREVIEW_NAME, seed: String(seed), numericSeed: seed, mode: 'creative', version: SAVE_VERSION,
      genVersion: NEW_WORLD_GEN_VERSION, createdAt: Date.UTC(2026, 10, 10, 12), noSpawn: true },
    player: { ...spawn, yaw: 0, pitch: -0.12, health: 20, hunger: 20, saturation: 5, flying: false, spawn },
    inventory: null, time: 0.23, chunks: world.serializeEdits(), furnaces: {}, containers: {},
    weather: { t: 'clear', left: 600, el: 0, inten: 0 }, mobs: []
  };
}

export function createListeningClips(destination) {
  const source = path.resolve(HERE, '../../renderer/media/sfx');
  fs.mkdirSync(destination, { recursive: true });
  const album = new Float32Array(44100 * 35);
  let group = 0;
  for (const [material, label] of Object.entries(MATERIAL_LABELS)) {
    const clip = new Float32Array(44100 * 7);
    const add = (name, at, gain) => {
      const bytes = fs.readFileSync(path.join(source, name + '.wav'));
      for (let i = 44, j = Math.round(at * 44100); i < bytes.length && j < clip.length; i += 2, j++) clip[j] += bytes.readInt16LE(i) / 32768 * gain;
    };
    for (let n = 0; n < 4; n++) {
      add('step_' + material + ['', '_b', '_c', '_d'][n], 0.2 + n * 0.55, 0.45);
      add('step_' + material + ['', '_b', '_c', '_d'][n], 2.7 + n * 0.37, 0.62);
    }
    add('jump', 4.55, 0.28); add('land_' + material, 5.1, 0.65);
    fs.writeFileSync(path.join(destination, label + '.wav'), monoWave(clip));
    album.set(clip, group++ * 44100 * 7);
  }
  fs.writeFileSync(path.join(destination, '五种材质对照.wav'), monoWave(album));
}
