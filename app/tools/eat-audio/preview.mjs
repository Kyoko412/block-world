/*
 * 进食试听世界与短对照（制作/交付用）。
 *   · createEatPreview()：安静草地、三类食物、可连续试听的饥饿余量；
 *   · createEatClips()：使用游戏里的进食时间表与变体规则生成短对照。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoxelWorld, SAVE_VERSION, NEW_WORLD_GEN_VERSION } from '../../renderer/js/world/world.js';
import { B } from '../../renderer/js/core/blocks.js';
import { monoWave } from '../movement-audio/wave.mjs';
import { createEatSession, tickEatSession } from '../../renderer/js/core/eating.js';
import { keyGain } from '../../renderer/js/audio/sfx.js';

export const PREVIEW_NAME = '进食试听-自然录音-20261111';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100;
const FLOOR = 48;

export function createEatPreview() {
  const seed = 70513;
  const world = new VoxelWorld(seed, { genVersion: NEW_WORLD_GEN_VERSION });
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) world.ensureChunk(cx, cz);
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) {
    world.setBlock(x, FLOOR - 1, z, B.STONE);
    world.setBlock(x, FLOOR, z, B.GRASS);
    for (let y = FLOOR + 1; y <= FLOOR + 8; y++) world.setBlock(x, y, z, B.AIR);
  }
  /* 一圈木板围出「小饭桌」，不是必须，只是让站位有个参照 */
  for (let x = -2; x <= 2; x++) { world.setBlock(x, FLOOR, -3, B.PLANKS); world.setBlock(x, FLOOR, 1, B.PLANKS); }
  for (let z = -3; z <= 1; z++) { world.setBlock(-2, FLOOR, z, B.PLANKS); world.setBlock(2, FLOOR, z, B.PLANKS); }
  const spawn = { x: 0.5, y: FLOOR + 1.02, z: 4.5 };
  return {
    meta: {
      name: PREVIEW_NAME, seed: String(seed), numericSeed: seed, mode: 'survival', version: SAVE_VERSION,
      genVersion: NEW_WORLD_GEN_VERSION, createdAt: Date.UTC(2026, 10, 11), noSpawn: true
    },
    /* 2/20：面包→苹果→熟牛肉各一份后为 19/20，可连续比较三组声音。 */
    player: { ...spawn, yaw: 0, pitch: -0.02, health: 20, hunger: 2, saturation: 0, flying: false, spawn },
    inventory: [
      { i: 'bread', c: 8 },
      { i: 'apple', c: 8 },
      { i: 'beef_cooked', c: 8 },
      { i: 'carrot', c: 8 },
      { i: 'mushroom_stew', c: 4 },
      null, null, null, null
    ],
    selected: 0,
    time: 0.3, chunks: world.serializeEdits(), furnaces: {}, containers: {},
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

export function createEatClips(destination) {
  const source = path.resolve(HERE, '../../renderer/media/sfx');
  fs.mkdirSync(destination, { recursive: true });
  const length = Math.round(SR * 2.2);
  const clips = { 干粮: { id: 'bread', food: 5 }, 果蔬: { id: 'apple', food: 4 }, 柔软熟食: { id: 'beef_cooked', food: 8 } };
  const album = [];
  for (const [label, item] of Object.entries(clips)) {
    const session = createEatSession(item);
    const { cues } = tickEatSession(session, session.plan.total);
    const clip = new Float32Array(length);
    for (let n = 0; n < cues.length; n++) {
      const cue = cues[n];
      const signal = readWav(path.join(source, cue.name + '.wav'));
      const start = Math.round(session.plan.beats[n].at * SR);
      for (let i = 0; i < signal.length && start + i < clip.length; i++) clip[start + i] += signal[i] * cue.volume * keyGain(cue.name);
    }
    let peak = 0;
    for (const value of clip) peak = Math.max(peak, Math.abs(value));
    if (peak > 0.9) for (let i = 0; i < clip.length; i++) clip[i] *= 0.9 / peak;
    fs.writeFileSync(path.join(destination, label + '.wav'), monoWave(clip));
    album.push(clip);
  }
  const total = new Float32Array(length * album.length);
  album.forEach((clip, index) => total.set(clip, index * length));
  fs.writeFileSync(path.join(destination, '进食对照.wav'), monoWave(total));
}
