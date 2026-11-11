/* 战斗与受伤：受伤原因 → 声音身份、变体、位置化与资源一致性。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Game } from '../renderer/js/player/game.js';
import { Inventory } from '../renderer/js/player/inventory.js';
import { PlayerController } from '../renderer/js/player/controller.js';
import { VoxelWorld } from '../renderer/js/world/world.js';
import { hurtSoundPlan } from '../renderer/js/core/hurtsounds.js';
import { sfxFileFor, SFX_FILE_IDS } from '../renderer/js/core/sfxfiles.js';
import { SOUND_NAMES, SOUND_DEF_NAMES, keyGain, KEY_SFX_GAIN } from '../renderer/js/audio/sfx.js';

test('战斗音效：随包的命中/受伤/盾/弓/箭都已登记、可播放、指纹一致', () => {
  const expected = ['swing', 'hit_flesh', 'hit_armor', 'hurt_body', 'hurt_fall', 'hurt_drown', 'shield_block', 'shield_break', 'armor_break', 'bow_release', 'arrow_hit', 'death'];
  for (const id of expected) {
    const variants = id === 'death' ? [''] : id === 'hurt_fall' || id === 'hurt_drown' || id === 'bow_release' || id === 'arrow_hit' || id === 'shield_break' || id === 'shield_block' || id === 'armor_break' || id === 'swing'
      ? ['', '_b'] : ['', '_b', '_c'];
    const fingerprints = new Set();
    for (const suffix of variants) {
      const name = id + suffix;
      const entry = sfxFileFor(name);
      assert.ok(entry, name + ' 没有随包登记');
      assert.ok(SOUND_NAMES.includes(name), name + ' 没进音效名表');
      assert.ok(SOUND_DEF_NAMES.includes(name), name + ' 缺合成兜底（文件没取到会静音）');
      const bytes = fs.readFileSync(new URL('../renderer/media/sfx/' + entry.file, import.meta.url));
      assert.equal(bytes.length, entry.bytes, name + ' 字节数与登记不符');
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
      for (const recording of [entry, ...entry.extraSources]) {
        assert.match(recording.source, /^https:\/\//, name + ' 缺原录音来源');
        assert.match(recording.recordingSha256, /^[0-9a-f]{64}$/, name + ' 缺原录音指纹');
        assert.ok(recording.sourceRange[1] > recording.sourceRange[0]);
        assert.ok(!/本项目合成|SYNTH_/.test(recording.sourceFile), name + ' 仍有合成层');
      }
      fingerprints.add(entry.sha256);
    }
    assert.equal(fingerprints.size, variants.length, id + ' 的变体必须是不同录音');
  }
});

test('战斗音效：命中/格挡/挥空短促，真实录音不拖长尾', () => {
  const spec = { hit_flesh: 0.20, shield_block: 0.18, swing: 0.25 };
  for (const [id, seconds] of Object.entries(spec)) {
    const entry = sfxFileFor(id);
    assert.ok(entry, id + ' 没有随包登记');
    assert.ok(entry.seconds >= 0.06 && entry.seconds <= seconds, id + ' 应保留一次完整短动作，实际 ' + entry.seconds);
  }
  const swing = fs.readFileSync(new URL('../renderer/media/sfx/swing.wav', import.meta.url));
  assert.ok(swing.length > 44, '挥空音必须是随包文件，不能退回合成兜底');
});

test('战斗音效：变体名与主名同档关键音增益，连续两声不会忽大忽小', () => {
  for (const name of ['hurt_body', 'hurt_body_b', 'hurt_body_c', 'hurt_drown_b', 'hit_flesh_c', 'hit_armor_b', 'shield_break_b', 'arrow_hit_b']) {
    assert.equal(keyGain(name), KEY_SFX_GAIN, name + ' 应和主名同档');
  }
  assert.equal(keyGain('click'), 1, 'UI 音不该被顺带放大');
});

test('战斗音效：摔落受创只有一条闷哼，不叠第二个撞击', () => {
  const plan = hurtSoundPlan({ type: 'fall', taken: 4, absorbed: 0 }, 0);
  assert.equal(plan.length, 1, '摔落只该有一条声音');
  assert.ok(plan[0].name.startsWith('hurt_fall'), '摔落用的是无冲击的闷哼：' + plan[0].name);
  assert.ok(!plan.some(cue => cue.name.startsWith('land_') || cue.name.startsWith('step_')), '落地接触音由移动那一包负责，不能在这里重复');
});

test('战斗音效：溺水只出专用水下录音，不借普通落水或近战音', () => {
  const plan = hurtSoundPlan({ type: 'drown', taken: 1 }, 1);
  assert.deepEqual(plan.map(cue => cue.name), ['hurt_drown_b']);
  assert.ok(plan[0].volume < hurtSoundPlan({ type: 'melee', taken: 3 })[0].volume, '溺水应比近战更轻');
});

test('战斗音效：没有实际掉血或已被盾挡住时不出受伤音', () => {
  assert.deepEqual(hurtSoundPlan({ type: 'melee', taken: 0, absorbed: 0 }), []);
  assert.deepEqual(hurtSoundPlan({ type: 'arrow', taken: 0, blocked: true }), []);
});

test('真实格挡轮换录音；盾碎只播专用碎裂，不重复普通工具坏音', () => {
  const game = Object.create(Game.prototype), sounds = [];
  game.state = 'playing'; game.feedback = {};
  game.controller = new PlayerController(new VoxelWorld(2));
  game.inventory = new Inventory();
  game.inventory.set(0, { item: 'shield', count: 1, dur: 3 });
  game.ui = { toast() {}, updateHotbar() {} };
  game.sfx = { play: name => sounds.push(name) };
  game.checkItemAchievements = () => {};
  game.refreshQuests = () => {};
  game._wireEvents();
  const c = game.controller;
  c.blocking = true;
  for (let i = 0; i < 3; i++) {
    c.invulnerable = 0;
    const info = c.hurt(3, '检查格挡', 'melee', { x: c.pos.x, z: c.pos.z - 1 });
    assert.equal(info.blocked, true);
    assert.equal(c.health, 20);
  }
  assert.deepEqual(sounds.filter(name => name.startsWith('shield_block')), ['shield_block', 'shield_block_b', 'shield_block']);
  assert.deepEqual(sounds.filter(name => name.startsWith('shield_break')), ['shield_break']);
  assert.ok(!sounds.some(name => name.startsWith('hurt_') || name === 'tool_break'), sounds.join(', '));
});

test('战斗音效：只有护甲真正吸收伤害时才叠金属接触', () => {
  const bare = hurtSoundPlan({ type: 'melee', taken: 5, absorbed: 0, armorPoints: 0 }, 0);
  assert.equal(bare.length, 1, '没吸收就不该有护甲音');
  const armored = hurtSoundPlan({ type: 'melee', taken: 2, absorbed: 3, armorPoints: 15 }, 0);
  assert.equal(armored.length, 2);
  assert.ok(armored[1].name.startsWith('hit_armor'), '吸收时才叠金属接触：' + armored[1].name);
  assert.ok(armored[1].volume < armored[0].volume, '护甲音是衬底，不该盖过身体受击');
});

test('战斗音效：持续伤害（饥饿/中毒）比战斗受击更轻', () => {
  const melee = hurtSoundPlan({ type: 'melee', taken: 4 }, 0)[0].volume;
  for (const type of ['starve', 'poison']) {
    assert.ok(hurtSoundPlan({ type, taken: 1 }, 0)[0].volume < melee, type + ' 应更轻');
  }
  assert.ok(hurtSoundPlan({ type: 'cactus', taken: 1 }, 0)[0].volume < melee, '仙人掌也不该和挨刀一样重');
});

test('战斗音效：同因连击轮换录音，相邻两次不重复', () => {
  const names = [0, 1, 2, 3].map(variant => hurtSoundPlan({ type: 'melee', taken: 3 }, variant)[0].name);
  assert.equal(new Set(names).size, 3, '三次变体应覆盖三条不同录音：' + names.join(','));
  for (let i = 1; i < names.length; i++) assert.notEqual(names[i], names[i - 1], '相邻两次不该重复同一条');
});

test('战斗音效：生物声源与危险声改成世界声源播放（近处实、远处虚）', () => {
  const mobs = fs.readFileSync(new URL('../renderer/js/world/mobs.js', import.meta.url), 'utf8');
  for (const [label, pattern] of [
    ['苦力怕引信', /playWorld\('hiss', m\.pos/],
    ['史莱姆跳动', /playWorld\('slime', m\.pos/],
    ['骷髅拉弓', /playWorld\('skeleton', m\.pos/],
    ['玩家命中生物', /playWorld\(name, m\.pos/]
  ]) {
    assert.ok(pattern.test(mobs), label + ' 仍在使用固定音量的 sfx.play');
  }
  const game = fs.readFileSync(new URL('../renderer/js/player/game.js', import.meta.url), 'utf8');
  assert.ok(/playWorld\('hiss'/.test(game), 'TNT 引信应带位置');
  assert.ok(SFX_FILE_IDS.includes('hit_flesh'), '命中生物的音色必须随包存在');
});
