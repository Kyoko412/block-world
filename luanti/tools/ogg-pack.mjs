/*
 * 把已经导出好的 WAV 音效转成 Luanti 的 OGG 声音组（单声道）。
 *   node .tools/ogg-pack.mjs
 *
 * Luanti 只认 Ogg Vorbis；定位播放必须单声道；同名 <name>.ogg / <name>.0.ogg …
 * 构成一个声音组，播放时由引擎随机挑一条 —— 正好对应我们 _b/_c/_d 的变体设计。
 *
 * 产出：luanti/mods/mc_soundpack/sounds/*.ogg（再用 cp -r 同步进便携包）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
const SRC = path.join(ROOT, 'app/renderer/media/sfx');
const MOD = path.join(ROOT, 'luanti/mods/mc_soundpack');
const OUT = path.join(MOD, 'sounds');
const FFMPEG = process.env.FFMPEG || '<外部工具目录>';

/* 组名 → 我们的文件（第一条是主名，其余是 .0/.1/.2 变体） */
const GROUPS = {
  mc_step_grass: ['step_grass', 'step_grass_b', 'step_grass_c', 'step_grass_d'],
  mc_step_stone: ['step_stone', 'step_stone_b', 'step_stone_c', 'step_stone_d'],
  mc_step_wood: ['step_wood', 'step_wood_b', 'step_wood_c', 'step_wood_d'],
  mc_step_sand: ['step_sand', 'step_sand_b', 'step_sand_c', 'step_sand_d'],
  mc_step_snow: ['step_snow', 'step_snow_b', 'step_snow_c', 'step_snow_d'],
  mc_dig_stone: ['dig_stone', 'dig_stone_b', 'dig_stone_c', 'dig_stone_d'],
  mc_dig_dirt: ['dig_dirt', 'dig_dirt_b', 'dig_dirt_c', 'dig_dirt_d'],
  mc_dig_wood: ['dig_wood', 'dig_wood_b', 'dig_wood_c', 'dig_wood_d'],
  mc_dig_sand: ['dig_sand', 'dig_sand_b', 'dig_sand_c', 'dig_sand_d'],
  mc_dig_gravel: ['dig_gravel', 'dig_gravel_b', 'dig_gravel_c', 'dig_gravel_d'],
  mc_dig_grass: ['dig_grass', 'dig_grass_b', 'dig_grass_c', 'dig_grass_d'],
  mc_break_stone: ['break_stone', 'break_stone_b', 'break_stone_c'],
  mc_break_dirt: ['break_dirt', 'break_dirt_b', 'break_dirt_c'],
  mc_break_wood: ['break_wood', 'break_wood_b', 'break_wood_c'],
  mc_break_sand: ['break_sand', 'break_sand_b', 'break_sand_c'],
  mc_break_grass: ['break_grass', 'break_grass_b', 'break_grass_c'],
  mc_place_stone: ['place_stone', 'place_stone_b', 'place_stone_c'],
  mc_place_wood: ['place_wood', 'place_wood_b', 'place_wood_c'],
  mc_place_dirt: ['place_dirt', 'place_dirt_b', 'place_dirt_c'],
  mc_place_sand: ['place_sand', 'place_sand_b', 'place_sand_c'],
  mc_place: ['place', 'place_b', 'place_c'],
  /* 引擎内置特殊组：丢进文件就生效，不用写 Lua */
  player_damage: ['hurt_body', 'hurt_body_b', 'hurt_body_c'],
  player_falling_damage: ['hurt_fall', 'hurt_fall_b'],
  player_jump: ['jump']
};

fs.mkdirSync(OUT, { recursive: true });
let made = 0, missing = [];
for (const [group, files] of Object.entries(GROUPS)) {
  files.forEach((file, index) => {
    const input = path.join(SRC, file + '.wav');
    if (!fs.existsSync(input)) { missing.push(file); return; }
    const output = path.join(OUT, group + (index === 0 ? '' : '.' + (index - 1)) + '.ogg');
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', input, '-ac', '1', '-c:a', 'libvorbis', '-q:a', '5', output], { stdio: 'inherit' });
    made++;
  });
}
console.log('OGG 声音组已生成：' + made + ' 个文件 → ' + OUT);
if (missing.length) console.log('缺少源文件：' + missing.join(', '));
