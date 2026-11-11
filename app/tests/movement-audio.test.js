import test from 'node:test';
import assert from 'node:assert/strict';
import { Interaction } from '../renderer/js/player/interaction.js';
import { B } from '../renderer/js/core/blocks.js';
import { VoxelWorld } from '../renderer/js/world/world.js';
import { PlayerController } from '../renderer/js/player/controller.js';
import { SFX_FILE_IDS, sfxFileFor, validateSfxFile } from '../renderer/js/core/sfxfiles.js';
import { SOUND_NAMES, SOUND_DEF_NAMES } from '../renderer/js/audio/sfx.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

const IDLE = { keyW: false, keyS: false, keyA: false, keyD: false, jump: false, sprint: false, sneak: false };
function scene({ water = false } = {}) {
  const world = new VoxelWorld(173);
  for (let cx = -1; cx <= 0; cx++) for (let cz = -2; cz <= 0; cz++) world.ensureChunk(cx, cz);
  for (let x = -2; x <= 3; x++) for (let z = -20; z <= 5; z++) {
    world.setBlock(x, 48, z, B.GRASS);
    for (let y = 49; y <= 60; y++) world.setBlock(x, y, z, water && y === 49 ? B.WATER : B.AIR);
  }
  const controller = new PlayerController(world);
  controller.creative = true;
  controller.spawnAt(0.5, 49, 4.5);
  controller.update(0.02, IDLE);
  return { world, controller };
}

test('移动音效：同材质相邻踏步不重复同一个录音变体', (t) => {
  t.mock.method(Math, 'random', () => 0);
  const interaction = new Interaction({});
  const names = Array.from({ length: 8 }, () => interaction.stepSoundName(B.GRASS));
  for (let i = 1; i < names.length; i++) {
    assert.notEqual(names[i], names[i - 1], '相邻草土踏步应使用不同录音');
  }
});

test('移动音效：浅水触地移动不产生干地踏步', () => {
  const { controller } = scene({ water: true });
  const footsteps = [];
  controller.on('footstep', (id) => footsteps.push(id));
  for (let i = 0; i < 80; i++) controller.update(0.02, { ...IDLE, keyW: true });
  assert.ok(controller.pos.z < 3, '角色应确实在浅水移动');
  assert.ok(controller.onGround && controller.inWater, '场景应保持浅水触地');
  assert.equal(footsteps.length, 0, '浅水中的地面接触不应发干脚步');
});

test('移动音效：慢速潜行也按实际走过的地面产生踏步', () => {
  const { controller } = scene();
  controller.blocking = true;
  const footsteps = [];
  controller.on('footstep', id => footsteps.push(id));
  for (let i = 0; i < 300; i++) controller.update(0.02, { ...IDLE, keyW: true, sneak: true });
  assert.ok(controller.pos.z < 2, '举盾潜行应实际走出一段距离');
  assert.ok(footsteps.length >= 1, '慢速移动也应形成踏步');
});

test('移动音效：每组四条录音及落地都随包登记、可播放且来源有效', () => {
  for (const material of ['grass', 'stone', 'wood', 'sand', 'snow']) {
    for (const action of ['step', 'land']) {
      const fingerprints = new Set();
      for (const suffix of ['', '_b', '_c', '_d']) {
        const id = `${action}_${material}${suffix}`;
        assert.ok(SFX_FILE_IDS.includes(id), id + ' 应为随包录音');
        assert.ok(SOUND_NAMES.includes(id) && SOUND_DEF_NAMES.includes(id), id + ' 应有可用播放入口');
        const entry = sfxFileFor(id);
        assert.deepEqual(validateSfxFile(id).problems, []);
        const bytes = fs.readFileSync(new URL('../renderer/media/sfx/' + entry.file, import.meta.url));
        assert.equal(bytes.length, entry.bytes);
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
        fingerprints.add(entry.sha256);
      }
      assert.equal(fingerprints.size, 4, material + ' 应有四个不同音频');
    }
  }
});

test('移动音效：真实跳跃只产生一次起跳和一次落地，同次接触不双响', () => {
  const { controller } = scene();
  const events = [];
  let frame = 0;
  for (const kind of ['jump', 'land', 'footstep']) controller.on(kind, id => events.push({ kind, frame, id }));
  controller.update(0.02, { ...IDLE, keyW: true, jump: true });
  for (frame = 1; frame < 75; frame++) controller.update(0.02, { ...IDLE, keyW: true });
  assert.deepEqual(events.filter(e => e.kind !== 'footstep').map(e => e.kind), ['jump', 'land']);
  const landing = events.find(e => e.kind === 'land');
  assert.equal(landing.id, B.GRASS);
  assert.equal(events.filter(e => e.kind === 'footstep' && e.frame === landing.frame).length, 0);
});

test('移动音效：中心悬空但脚底仍有支撑时使用实际支撑材质', () => {
  const { world, controller } = scene();
  for (let z = -20; z <= 5; z++) {
    world.setBlock(0, 48, z, B.PLANKS);
    for (let x = 1; x <= 3; x++) world.setBlock(x, 48, z, B.AIR);
  }
  controller.setPositions(1.15, 49, 4.5);
  const contacts = [];
  controller.on('footstep', id => contacts.push(id));
  for (let i = 0; i < 100; i++) controller.update(0.02, { ...IDLE, keyW: true });
  assert.ok(controller.onGround, '角色仍应由木板边缘支撑');
  assert.ok(contacts.length > 0);
  assert.ok(contacts.every(id => id === B.PLANKS), '边缘踏步应使用木板而非空气回退');
});

test('移动音效：五类材质及木石建筑构件不会回退到错误材质', () => {
  const interaction = new Interaction({});
  const materials = [
    [B.GRASS, 'grass'], [B.DIRT, 'grass'], [B.DIRT_PATH, 'grass'], [B.FARMLAND, 'grass'],
    [B.STONE, 'stone'], [B.DEEPSLATE, 'stone'], [B.SLAB_STONE, 'stone'], [B.STAIRS_STONE, 'stone'],
    [B.PLANKS, 'wood'], [B.BIRCH_PLANKS, 'wood'], [B.BIRCH_LOG, 'wood'],
    [B.SLAB_PLANKS, 'wood'], [B.STAIRS_PLANKS, 'wood'],
    [B.DOOR_BOTTOM, 'wood'], [B.DOOR_TOP, 'wood'],
    [B.SAND, 'sand'], [B.GRAVEL, 'sand'], [B.SNOW, 'snow']
  ];
  for (const [id, material] of materials) {
    assert.match(interaction.stepSoundName(id), new RegExp('^step_' + material + '(?:_[bcd])?$'));
    assert.match(interaction.movementSoundName(id, 'land'), new RegExp('^land_' + material + '(?:_[bcd])?$'));
  }
});

test('移动音效：顶墙、停下和原地传送不会继续踏步或补播', () => {
  const { world, controller } = scene();
  for (let x = -2; x <= 3; x++) for (let y = 49; y <= 52; y++) world.setBlock(x, y, 0, B.STONE);
  const contacts = [];
  controller.on('footstep', id => contacts.push(id));
  for (let i = 0; i < 150; i++) controller.update(0.02, { ...IDLE, keyW: true });
  assert.ok(contacts.length > 0, '到墙之前应有实际踏步');
  const before = contacts.length;
  for (let i = 0; i < 100; i++) controller.update(0.02, { ...IDLE, keyW: true });
  for (let i = 0; i < 80; i++) controller.update(0.02, IDLE);
  controller.setPositions(0.5, 49, 4.5);
  for (let i = 0; i < 10; i++) controller.update(0.02, IDLE);
  assert.equal(contacts.length, before);
});

test('移动音效：自动上台阶不重落地，从台阶走下才有一次接触声', () => {
  const { world, controller } = scene();
  for (let x = -2; x <= 3; x++) for (let z = 0; z <= 1; z++) world.setBlock(x, 49, z, B.PLANKS);
  const landings = [];
  controller.on('land', (id, impact) => landings.push({ id, z: controller.pos.z, speed: impact.speed }));
  for (let i = 0; i < 120; i++) controller.update(0.02, { ...IDLE, keyW: true });
  assert.ok(controller.stepups > 0, '本场景应真正走上台阶');
  assert.equal(landings.length, 1, '只应在离开台阶后真实落地时发声');
  assert.ok(landings[0].z < 0 && landings[0].speed > 1);
});

test('移动音效：进入浅水的当帧就停止新的干地踏步', () => {
  const { world, controller } = scene();
  for (let x = -2; x <= 3; x++) for (let z = -20; z < 0; z++) world.setBlock(x, 49, z, B.WATER);
  controller.setPositions(0.5, 49, 0.3);
  controller.update(0.02, IDLE);
  const contacts = [];
  controller.on('footstep', () => contacts.push(controller.pos.z));
  for (let i = 0; i < 50; i++) controller.update(0.02, { ...IDLE, keyW: true });
  assert.ok(controller.pos.z < -1, '角色应从陆地实际走进浅水');
  assert.ok(contacts.every(z => z >= 0), '进入水体的当帧不能新发干脚步');
});
