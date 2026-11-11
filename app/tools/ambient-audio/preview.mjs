import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoxelWorld, SAVE_VERSION, NEW_WORLD_GEN_VERSION } from '../../renderer/js/world/world.js';
import { B } from '../../renderer/js/core/blocks.js';
import { stereoWave } from './wave.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)), SR = 44100;
export const PREVIEW_SCENES = [
  { id: 'wind', label: '白天林地', time: 0.25, weather: 'clear' },
  { id: 'insects', label: '夜晚', time: 0.75, weather: 'clear' },
  { id: 'rain', label: '雨天', time: 0.25, weather: 'rain' },
  { id: 'cave', label: '洞穴', time: 0.25, weather: 'clear', position: 'cave' },
  { id: 'underwater', label: '水下', time: 0.25, weather: 'clear', position: 'water' },
  { id: 'snow', label: '雪天', time: 0.25, weather: 'snow' }
].map(scene => ({ ...scene, name: '环境试听-' + scene.label + '-20261111' }));
export const PREVIEW_NAME = PREVIEW_SCENES[0].name;

export function createAmbientPreviews() {
  const seed = 62941, world = new VoxelWorld(seed, { genVersion: NEW_WORLD_GEN_VERSION });
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) world.ensureChunk(cx, cz);
  let floor = 0;
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) floor = Math.max(floor, world.surfaceHeight(x, z));
  floor++;
  for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) {
    world.setBlock(x, floor - 1, z, B.DIRT); world.setBlock(x, floor, z, B.GRASS);
    for (let y = floor + 1; y <= floor + 12; y++) world.setBlock(x, y, z, B.AIR);
  }
  /* 木屋朝向出生点，门与窗可直接对比遮蔽；屋外站位上方保持露天。 */
  for (let x = -7; x <= -3; x++) for (let z = -3; z <= 2; z++) {
    world.setBlock(x, floor, z, B.PLANKS); world.setBlock(x, floor + 4, z, B.PLANKS);
    for (let y = floor + 1; y <= floor + 3; y++) if (x === -7 || x === -3 || z === -3 || z === 2) world.setBlock(x, y, z, B.PLANKS);
  }
  for (let y = floor + 1; y <= floor + 2; y++) world.setBlock(-5, y, 2, B.AIR);
  world.setBlock(-3, floor + 2, 0, B.GLASS); world.setBlock(-6, floor + 1, -2, B.TORCH);
  for (const [x, z] of [[-2, 4], [1, -3], [8, 5]]) world.setBlock(x, floor + 1, z, B.TORCH);
  for (const [x, z] of [[-9, -7], [9, -7], [-9, 8], [9, 8]]) {
    for (let y = 1; y <= 4; y++) world.setBlock(x, floor + y, z, B.BIRCH_LOG);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 4; dy <= 5; dy++) {
      if (Math.abs(dx) + Math.abs(dz) <= 3) world.setBlock(x + dx, floor + dy, z + dz, B.BIRCH_LEAVES);
    }
  }
  for (let x = 3; x <= 7; x++) for (let z = 0; z <= 4; z++) {
    world.setBlock(x, floor - 3, z, B.STONE);
    for (let y = floor - 2; y <= floor; y++) world.setBlock(x, y, z, B.WATER);
  }
  let caveFloor = floor;
  for (let x = -2; x <= 2; x++) for (let z = -10; z <= -4; z++) caveFloor = Math.min(caveFloor, world.surfaceHeight(x, z) - 7);
  for (let x = -3; x <= 3; x++) for (let z = -11; z <= -3; z++) for (let y = caveFloor; y <= caveFloor + 5; y++) {
    world.setBlock(x, y, z, x === -3 || x === 3 || z === -11 || z === -3 || y === caveFloor || y === caveFloor + 5 ? B.STONE : B.AIR);
  }
  world.setBlock(-2, caveFloor + 1, -9, B.TORCH); world.setBlock(2, caveFloor + 1, -4, B.TORCH);
  const positions = { outdoor: { x: 0.5, y: floor + 1.02, z: 6.5 },
    cave: { x: 0.5, y: caveFloor + 1.02, z: -5.5 }, water: { x: 5.5, y: floor - 1.98, z: 2.5 } };
  const chunks = world.serializeEdits();
  return PREVIEW_SCENES.map(scene => {
    const position = positions[scene.position || 'outdoor'];
    return { name: scene.name, data: {
      meta: { name: scene.name, seed: String(seed), numericSeed: seed, mode: 'creative', version: SAVE_VERSION,
        genVersion: NEW_WORLD_GEN_VERSION, createdAt: Date.UTC(2026, 10, 11), noSpawn: true },
      player: { ...position, spawn: positions.outdoor, yaw: 0, pitch: -0.10, health: 20, hunger: 20, saturation: 5, flying: false },
      inventory: [{ i: 'torch', c: 64 }, { i: 'planks', c: 64 }, null, null, null, null, null, null, null], selected: 0,
      time: scene.time, chunks, furnaces: {}, containers: {}, mobs: [],
      weather: { t: scene.weather, left: 600, el: 30, inten: scene.weather === 'clear' ? 0 : 1 }
    } };
  });
}

export function createAmbientClips(destination) {
  const source = path.resolve(HERE, '../../renderer/media/ambient'); fs.mkdirSync(destination, { recursive: true });
  const length = SR * 8, album = [new Float32Array(length * 5), new Float32Array(length * 5)];
  const clips = [['wind', '白天林地'], ['insects', '夜晚'], ['rain', '雨天'], ['cave', '洞穴'], ['underwater', '水下']];
  clips.forEach(([id, label], n) => {
    const bytes = fs.readFileSync(path.join(source, id + '.wav')), frames = (bytes.length - 44) / 4;
    const channels = [new Float32Array(length), new Float32Array(length)];
    for (let i = 0; i < length; i++) for (let ch = 0; ch < 2; ch++) {
      channels[ch][i] = bytes.readInt16LE(44 + ((i % frames) * 2 + ch) * 2) / 32768
        * 0.8 * 0.55 * 0.7 * (id === 'underwater' ? 0.6 : 1)
        * Math.min(1, i / (SR * 0.3), (length - 1 - i) / (SR * 0.5));
    }
    fs.writeFileSync(path.join(destination, label + '.wav'), stereoWave(channels));
    channels.forEach((channel, ch) => album[ch].set(channel, n * length));
  });
  fs.writeFileSync(path.join(destination, '环境声对照.wav'), stereoWave(album));
}
