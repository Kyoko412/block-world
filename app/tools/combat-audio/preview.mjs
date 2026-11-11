/*
 * 战斗试听世界与短对照（制作/交付用）。
 *   · createCombatPreview()：平地竞技场，一只僵尸（近战挨打/格挡）和一只骷髅（箭矢），
 *     背包预置铁甲、盾、弓与箭、铁剑；noSpawn，不会从别处补怪。
 *   · createCombatClips()：把导出的 WAV 按动作分组拼成短对照（命中 / 受伤 / 盾甲 / 弓箭）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoxelWorld, SAVE_VERSION, NEW_WORLD_GEN_VERSION } from '../../renderer/js/world/world.js';
import { B } from '../../renderer/js/core/blocks.js';
import { monoWave } from '../movement-audio/wave.mjs';
import { keyGain } from '../../renderer/js/audio/sfx.js';

export const PREVIEW_NAME = '战斗试听-自然录音-20261111';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SR = 44100;

export function createCombatPreview() {
  const seed = 60811, floor = 48;
  const world = new VoxelWorld(seed, { genVersion: NEW_WORLD_GEN_VERSION });
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) world.ensureChunk(cx, cz);
  for (let x = -8; x <= 8; x++) for (let z = -14; z <= 8; z++) {
    world.setBlock(x, floor - 1, z, B.STONE);
    world.setBlock(x, floor, z, B.GRASS);
    for (let y = floor + 1; y <= floor + 8; y++) world.setBlock(x, y, z, B.AIR);
  }
  /* 弓靶：北墙，箭扎上去能听「扎进木头」 */
  for (let x = -3; x <= 3; x++) for (let y = floor + 1; y <= floor + 4; y++) world.setBlock(x, y, -12, B.PLANKS);
  for (let x = -3; x <= 3; x++) world.setBlock(x, floor + 2, -11, B.PLANKS);
  /* 侧向矮墙：躲箭与听方位用 */
  for (let z = -6; z <= 2; z++) { world.setBlock(-6, floor + 1, z, B.STONE); world.setBlock(6, floor + 1, z, B.STONE); }
  for (const x of [-6, 6]) for (const z of [-6, 0]) world.setBlock(x, floor + 2, z, B.TORCH);
  /* 左侧五级木台：每次跳上一级，台顶走落到草地可实际摔伤。 */
  for (let step = 0; step < 5; step++) for (let y = 1; y <= step + 1; y++) world.setBlock(-4, floor + y, 4 - step, B.PLANKS);
  for (const x of [-4, -3]) for (const z of [-1, 0]) world.setBlock(x, floor + 5, z, B.PLANKS);
  /* 右侧三格深水池：实际憋气受伤；空格可上浮离开。 */
  for (let x = 3; x <= 5; x++) for (let z = 2; z <= 4; z++) {
    world.setBlock(x, floor - 3, z, B.STONE);
    for (let y = floor - 2; y <= floor; y++) world.setBlock(x, y, z, B.WATER);
  }
  const spawn = { x: 0.5, y: floor + 1.02, z: 4.5 };
  return {
    meta: {
      name: PREVIEW_NAME, seed: String(seed), numericSeed: seed, mode: 'survival', version: SAVE_VERSION,
      genVersion: NEW_WORLD_GEN_VERSION, createdAt: Date.UTC(2026, 10, 11), noSpawn: true, mobsFixed: true
    },
    player: { ...spawn, yaw: 0, pitch: -0.05, health: 20, hunger: 20, saturation: 5, flying: false, spawn },
    inventory: [
      { i: 'sword_iron', c: 1 },
      { i: 'shield', c: 1 },
      { i: 'bow', c: 1 },
      { i: 'arrow', c: 64 },
      { i: 'iron_helmet', c: 1 },
      { i: 'iron_chestplate', c: 1 },
      { i: 'iron_leggings', c: 1 },
      { i: 'iron_boots', c: 1 },
      { i: 'bread', c: 16 },
      { i: 'shield', c: 1, d: 1 },
      { i: 'iron_helmet', c: 1, d: 1 }
    ],
    selected: 0,
    armor: [{ i: 'iron_helmet', d: 165 }, { i: 'iron_chestplate', d: 240 }, { i: 'iron_leggings', d: 225 }, { i: 'iron_boots', d: 195 }],
    /* 黄昏避免敌怪在试听过程中日晒消失，保留正常 AI 和伤害。 */
    time: 0.51, chunks: world.serializeEdits(), furnaces: {}, containers: {},
    weather: { t: 'clear', left: 600, el: 0, inten: 0 },
    /* 预先站好两只怪：僵尸近战（可格挡、可被砍），骷髅远程（箭矢与格挡箭） */
    mobs: [
      { t: 'zombie', x: 0, y: floor + 1, z: -4.5, yaw: 0, hp: 20 },
      { t: 'skeleton', x: 3, y: floor + 1, z: -8.5, yaw: 2.4, hp: 20 }
    ]
  };
}

function readWav(file) {
  const bytes = fs.readFileSync(file);
  const data = new Int16Array(bytes.buffer, bytes.byteOffset + 44, (bytes.length - 44) >> 1);
  const signal = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) signal[i] = data[i] / 32768;
  return signal;
}

/* 五组短对照，按游戏内各动作的相对音量排列。 */
export const CLIP_GROUPS = {
  挥击与命中: [['swing', 0.1], ['hit_flesh', 0.5], ['hit_flesh_b', 0.9], ['hit_flesh_c', 1.3], ['hit_armor', 1.9], ['hit_armor_b', 2.3]],
  受伤: [['hurt_body', 0.1], ['hurt_body_b', 0.65], ['hurt_body_c', 1.2], ['hurt_fall', 1.75], ['hurt_fall_b', 2.25], ['death', 2.75]],
  盾与甲: [['shield_block', 0], ['shield_block_b', 0.45], ['shield_break', 0.95], ['armor_break', 1.6], ['armor_break_b', 2.2]],
  弓与箭: [['bow_release', 0.1], ['arrow_hit', 0.5], ['bow_release_b', 1.1], ['arrow_hit_b', 1.5]],
  溺水: [['hurt_drown', 0.2], ['hurt_drown_b', 1.2]]
};
function cueVolume(name) {
  if (name.startsWith('swing')) return 0.34;
  if (name.startsWith('hit_flesh')) return 0.72;
  if (name.startsWith('hit_armor')) return 0.32;
  if (name.startsWith('hurt_body')) return 0.70;
  if (name.startsWith('hurt_fall')) return 0.46;
  if (name.startsWith('hurt_drown')) return 0.50;
  if (name.startsWith('shield_')) return 0.76;
  if (name.startsWith('armor_break')) return 0.70;
  if (name.startsWith('bow_release')) return 0.78;
  if (name.startsWith('arrow_hit')) return 0.50;
  return 0.55;
}

export function createCombatClips(destination) {
  const source = path.resolve(HERE, '../../renderer/media/sfx');
  fs.mkdirSync(destination, { recursive: true });
  const length = Math.round(SR * 3.2);
  const album = [];
  for (const [label, cues] of Object.entries(CLIP_GROUPS)) {
    const clip = new Float32Array(length);
    for (const [name, at] of cues) {
      const signal = readWav(path.join(source, name + '.wav'));
      const start = Math.round(at * SR);
      for (let i = 0; i < signal.length && start + i < clip.length; i++) clip[start + i] += signal[i] * cueVolume(name) * keyGain(name);
    }
    let peak = 0;
    for (const value of clip) peak = Math.max(peak, Math.abs(value));
    if (peak > 0.9) for (let i = 0; i < clip.length; i++) clip[i] *= 0.9 / peak;
    fs.writeFileSync(path.join(destination, label + '.wav'), monoWave(clip));
    album.push(clip);
  }
  const total = new Float32Array(length * album.length);
  album.forEach((clip, index) => total.set(clip, index * length));
  fs.writeFileSync(path.join(destination, '战斗与受伤对照.wav'), monoWave(total));
}
