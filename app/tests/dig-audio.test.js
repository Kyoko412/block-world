/* 挖掘 / 破坏 / 放置：真实触发、变体、混音的定向检查（不走浏览器，纯逻辑 + 资源对账）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Interaction, BREAK_VOLUME, PLACE_VOLUME } from '../renderer/js/player/interaction.js';
import { B } from '../renderer/js/core/blocks.js';
import { VoxelWorld } from '../renderer/js/world/world.js';
import { PlayerController } from '../renderer/js/player/controller.js';
import { Inventory } from '../renderer/js/player/inventory.js';
import { sfxFileFor } from '../renderer/js/core/sfxfiles.js';
import { SOUND_NAMES, SOUND_DEF_NAMES } from '../renderer/js/audio/sfx.js';

function fixture({ creative = false } = {}) {
  const world = new VoxelWorld(9317);
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) world.ensureChunk(cx, cz);
  for (let x = -3; x <= 8; x++) for (let z = -3; z <= 8; z++) {
    world.setBlock(x, 48, z, B.DIRT);
    for (let y = 49; y <= 56; y++) world.setBlock(x, y, z, B.AIR);
  }
  const controller = new PlayerController(world);
  controller.creative = creative;
  controller.spawnAt(0.5, 49, 4.5);
  controller.update(0.02, { keyW: false, jump: false, sneak: false, sprint: false });
  const plays = [], progress = [];
  const inventory = new Inventory();
  inventory.infinite = creative;
  const interaction = new Interaction({
    world, controller, inventory,
    sfx: { play(name, opts) { plays.push({ name, ...(opts || {}) }); } },
    view: { setSelection() {}, setBreakProgress(value) { progress.push(value); }, rebuildChunk() {} },
    particles: { spawnBlock() {} },
    input: { state: {} },
    heldSwing() {},
    game: { onBlockBroken() {}, onBlockPlaced() {} }
  });
  return { world, controller, inventory, interaction, plays, progress };
}

const digNames = plays => plays.filter(p => p.name.startsWith('dig_')).map(p => p.name);
const breakNames = plays => plays.filter(p => p.name.startsWith('break_')).map(p => p.name);

test('挖放音效：每个动作的四/三条录音都是不同文件，且都已随包登记', () => {
  const families = {
    dig: ['dig_dirt', 'dig_stone', 'dig_wood'],
    break: ['break_dirt', 'break_stone', 'break_wood'],
    place: ['place_dirt', 'place_stone', 'place_wood']
  };
  const suffixes = { dig: ['', '_b', '_c', '_d'], break: ['', '_b', '_c'], place: ['', '_b', '_c'] };
  for (const [action, list] of Object.entries(families)) {
    for (const base of list) {
      const fingerprints = new Set();
      for (const suffix of suffixes[action]) {
        const id = base + suffix;
        const entry = sfxFileFor(id);
        assert.ok(entry, action + ' 缺少登记：' + id);
        assert.ok(SOUND_NAMES.includes(id), id + ' 没进音效名表');
        assert.ok(SOUND_DEF_NAMES.includes(id), id + ' 缺合成兜底（文件没取到会静音）');
        assert.ok(fs.existsSync(new URL('../renderer/media/sfx/' + entry.file, import.meta.url)), id + ' 文件不存在');
        fingerprints.add(entry.sha256);
      }
      assert.equal(fingerprints.size, suffixes[action].length, base + ' 的变体必须是不同录音，不是同一条改音高');
    }
  }
});

test('挖放音效：连续敲击轮换录音，相邻两下不重复', (t) => {
  const seq = [0.1, 0.45, 0.8, 0.25, 0.65, 0.95, 0.3, 0.7];
  let pick = 0;
  t.mock.method(Math, 'random', () => seq[pick++ % seq.length]);
  const { interaction } = fixture();
  const names = Array.from({ length: 8 }, () => interaction.actionSoundName('dig', 'dig_stone'));
  for (let i = 1; i < names.length; i++) assert.notEqual(names[i], names[i - 1], '相邻两下用了同一条录音');
  assert.ok(new Set(names).size >= 3, '八次敲击至少覆盖三条不同录音，实际 ' + new Set(names).size);
});

test('挖放音效：持续敲击按真实进度出声，破坏只响一次且是最后一声', () => {
  const { world, interaction, plays, progress } = fixture();
  interaction.target = { x: 2, y: 48, z: 4, face: [0, 1, 0], dist: 2 };
  interaction.startMining(interaction.target);
  for (let i = 0; i < 200 && interaction.mining.hit; i++) interaction.mineTick(0.02);
  const dig = digNames(plays), broke = breakNames(plays);
  assert.ok(dig.length >= 2, '持续敲击应多次出声，实际 ' + dig.length);
  assert.equal(broke.length, 1, '破坏声只响一次，实际 ' + broke.length);
  assert.equal(world.getBlock(2, 48, 4), B.AIR, '方块必须真的被破坏');
  assert.equal(plays[plays.length - 1].name, broke[0], '破坏声必须是这段动作的最后一声，不能之后又补敲击');
  assert.ok(progress.some(value => value === null), '结束后要清掉破坏进度显示');
  for (const play of plays) {
    if (play.name.startsWith('dig_')) assert.ok(play.volume > 0 && play.volume <= 0.5, '敲击音量应在混音预算内：' + play.volume);
    if (play.name.startsWith('break_')) assert.equal(play.volume, BREAK_VOLUME);
  }
});

test('挖放音效：目标中途消失就停手，不再对着空气敲', () => {
  const { world, interaction, plays } = fixture();
  interaction.target = { x: 2, y: 48, z: 4, face: [0, 1, 0], dist: 2 };
  interaction.startMining(interaction.target);
  interaction.mineTick(0.02);
  const afterFirst = digNames(plays).length;
  assert.ok(afterFirst >= 1, '第一记敲击应先响');
  world.setBlock(2, 48, 4, B.AIR);           // 被别的途径挖掉 / 爆炸 / 读档回退
  for (let i = 0; i < 10; i++) interaction.mineTick(0.05);
  assert.equal(interaction.mining.hit, null, '目标失效后必须松手');
  assert.equal(digNames(plays).length, afterFirst, '目标没了还在继续敲');
  assert.equal(breakNames(plays).length, 0, '没有真实破坏就不该有破坏声');
});

test('挖放音效：放置成功响一次按材质的接触声，失败不响', () => {
  const { world, interaction, inventory, plays } = fixture();
  inventory.add('dirt', 4);
  inventory.select(0);
  interaction.target = { x: 4, y: 48, z: 4, face: [0, 1, 0], dist: 4 };
  assert.equal(interaction.tryPlace(), true, '空地放置应成功');
  assert.equal(world.getBlock(4, 49, 4), B.DIRT, '放置后应有方块');
  const place = plays.filter(p => p.name.startsWith('place'));
  assert.equal(place.length, 1, '一次成功放置只响一次');
  assert.ok(place[0].name.startsWith('place_dirt'), '土块应使用土质接触声：' + place[0].name);
  assert.equal(place[0].volume, PLACE_VOLUME);

  const before = plays.length;
  assert.equal(interaction.tryPlace(), false, '同一格再放应失败');
  assert.equal(plays.length, before, '失败放置不许响成功声');
});
