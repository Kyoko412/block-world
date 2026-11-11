/* 进食：过程节奏、吞下时点、变体、资源与接线。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Game } from '../renderer/js/player/game.js';
import { Inventory } from '../renderer/js/player/inventory.js';
import { PlayerController } from '../renderer/js/player/controller.js';
import { VoxelWorld } from '../renderer/js/world/world.js';
import { eatPlan, eatTexture, eatBites, eatVariantName, createEatSession, tickEatSession } from '../renderer/js/core/eating.js';
import { sfxFileFor } from '../renderer/js/core/sfxfiles.js';
import { SOUND_NAMES, SOUND_DEF_NAMES, keyGain, KEY_SFX_GAIN } from '../renderer/js/audio/sfx.js';

function runSession(item, step, limit = 5) {
  const session = createEatSession(item);
  const cues = [];
  let swallowed = 0;
  for (let t = 0; t < limit; t += step) {
    const { cues: now, swallow } = tickEatSession(session, step);
    cues.push(...now);
    if (swallow) swallowed++;
  }
  return { session, cues, swallowed };
}

test('真实录音：三类食物各三条咬、两条嚼，共用两条吞，文件与指纹准确', () => {
  const families = {
    eat_bite_dry: ['', '_b', '_c'],
    eat_bite_juicy: ['', '_b', '_c'],
    eat_bite_soft: ['', '_b', '_c'],
    eat_chew_dry: ['', '_b'],
    eat_chew_juicy: ['', '_b'],
    eat_chew_soft: ['', '_b'],
    eat_swallow: ['', '_b']
  };
  for (const [base, suffixes] of Object.entries(families)) {
    const fingerprints = new Set();
    for (const suffix of suffixes) {
      const id = base + suffix;
      const entry = sfxFileFor(id);
      assert.ok(entry, id + ' 没有随包登记');
      assert.ok(SOUND_NAMES.includes(id), id + ' 没进音效名表');
      assert.ok(SOUND_DEF_NAMES.includes(id), id + ' 缺合成兜底');
      const bytes = fs.readFileSync(new URL('../renderer/media/sfx/' + entry.file, import.meta.url));
      assert.equal(bytes.length, entry.bytes, id + ' 字节数与登记不符');
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256, id + ' 指纹不符');
      assert.match(entry.source, /^https:\/\//, id + ' 应登记真实录音原页');
      assert.match(entry.recordingSha256, /^[0-9a-f]{64}$/);
      assert.ok(entry.sourceRange[1] > entry.sourceRange[0]);
      fingerprints.add(entry.sha256);
    }
    assert.equal(fingerprints.size, suffixes.length, base + ' 的变体必须是不同声音');
  }
  for (const name of ['eat_bite_dry', 'eat_bite_juicy_b', 'eat_bite_soft_c', 'eat_chew_dry', 'eat_chew_soft_b', 'eat_swallow_b']) {
    assert.equal(keyGain(name), KEY_SFX_GAIN, name + ' 应和主名同档关键音增益');
  }
});

test('进食节奏：轻的东西两口、重的三口，吞下一定是最后一下', () => {
  const light = eatPlan({ id: 'bread', food: 5 });
  const heavy = eatPlan({ id: 'beef_cooked', food: 8 });
  assert.equal(light.bites, 2);
  assert.equal(heavy.bites, 3);
  assert.ok(heavy.total > light.total, '三口应当比两口久');
  for (const plan of [light, heavy]) {
    const kinds = plan.beats.map(beat => beat.kind);
    assert.equal(kinds[kinds.length - 1], 'swallow', '最后一下必须是吞咽');
    assert.equal(kinds.filter(kind => kind === 'bite').length, plan.bites);
    assert.equal(kinds.filter(kind => kind === 'chew').length, plan.bites);
    for (let i = 1; i < plan.beats.length; i++) assert.ok(plan.beats[i].at > plan.beats[i - 1].at, '节拍必须递增');
    assert.ok(plan.total > plan.beats[plan.beats.length - 1].at, '总时长要覆盖到吞下之后');
  }
});

test('进食材质：面包、果蔬、熟食有不同口感', () => {
  assert.equal(eatTexture('bread'), 'dry');
  assert.equal(eatTexture('beef_cooked'), 'soft');
  assert.equal(eatTexture('potato_baked'), 'soft');
  assert.equal(eatTexture('apple'), 'juicy');
  assert.equal(eatTexture('mushroom_stew'), 'soft');
  assert.equal(eatTexture('beef_raw'), 'juicy');
  assert.equal(eatBites(3), 2);
  assert.equal(eatBites(7), 3);
});

test('进食过程：按住才推进，每一步都有声音，吞下只发生一次', () => {
  const { cues, swallowed, session } = runSession({ id: 'bread', food: 5 }, 1 / 60);
  assert.equal(swallowed, 1, '一次进食只吞一次');
  assert.equal(session.done, true);
  const bites = cues.filter(cue => cue.kind === 'bite').length;
  const chews = cues.filter(cue => cue.kind === 'chew').length;
  assert.equal(bites, 2);
  assert.equal(chews, 2);
  assert.equal(cues[cues.length - 1].kind, 'swallow');
  for (const cue of cues) assert.ok(cue.volume > 0 && cue.volume <= 0.6, '音量应在混音预算内');
});

test('进食中断：停在咬与吞之间就再也不会吞下，也不会继续排新声音', () => {
  const session = createEatSession({ id: 'beef_cooked', food: 8 });
  for (let i = 0; i < 40; i++) tickEatSession(session, 1 / 60);   // 约 0.66s：已咬两口、还没吞
  assert.equal(session.done, false);
  /* 松手：Game 直接丢掉会话（这里模拟成不再 tick），后续不应有任何声音 */
  const after = tickEatSession({ ...session, done: true }, 1);
  assert.equal(after.swallow, false);
  assert.equal(after.cues.length, 0);
});

test('进食变体：连续两口不重复同一条录音', () => {
  const names = [0, 1, 2, 3].map(index => eatVariantName('eat_bite_dry', index));
  for (let i = 1; i < names.length; i++) assert.notEqual(names[i], names[i - 1], '相邻两口用了同一条');
  assert.equal(new Set(names).size, 3, '三条变体都该用到');
  assert.equal(eatVariantName('eat_chew_dry', 2), 'eat_chew_dry');
  const variants = Object.create(null);
  const swallows = [];
  for (let i = 0; i < 2; i++) {
    const session = createEatSession({ id: 'bread', food: 5 }, variants);
    swallows.push(tickEatSession(session, 3).cues.at(-1).name);
  }
  assert.deepEqual(swallows, ['eat_swallow', 'eat_swallow_b']);
});

test('三口食物的每个咬嚼吞都对应可播放的登记资源', () => {
  for (const item of [{ id: 'beef_cooked', food: 8 }, { id: 'beef_raw', food: 8 }]) {
    const { cues } = runSession(item, 1 / 60);
    assert.equal(cues.filter(cue => cue.kind === 'chew').length, 3);
    for (const cue of cues) {
      assert.ok(sfxFileFor(cue.name), cue.name + ' 没有音频文件');
      assert.ok(SOUND_DEF_NAMES.includes(cue.name), cue.name + ' 没有播放定义');
    }
    const chews = cues.filter(cue => cue.kind === 'chew').map(cue => cue.name);
    assert.notEqual(chews[0], chews[1], '咀嚼应按自己的变体轮换');
  }
});

function eatingGame() {
  const game = Object.create(Game.prototype);
  let right = true;
  game.state = 'playing'; game.openUI = null;
  game.controller = new PlayerController(new VoxelWorld(1));
  game.controller.hunger = 12;
  game.inventory = new Inventory();
  game.inventory.set(0, { item: 'bread', count: 2 });
  game.interaction = { placeCd: 0, cancelBlocking() {} };
  game.input = { sync: () => ({ mouseRight: right }), setUIMode: value => { if (value) right = false; } };
  game.ui = { toast() {}, showPause() {}, hideOverlays() {}, updateHUD() {}, updateHotbar() {} };
  game.sfx = { play() {}, stopMusic() {}, setAmbientEnabled() {}, updateAmbient() {} };
  game.settings = { music: false };
  game.audioSceneState = () => ({});
  return { game, hold: () => { right = true; } };
}

test('暂停立刻取消旧进度，恢复后重新按住必须从第一口开始', () => {
  const { game, hold } = eatingGame();
  game.startEating(game.inventory.held());
  game.tickEating(0.6);
  game.pause();
  assert.equal(game.isEating(), false, '暂停不能冻结并保留旧进度');
  game.resume(); hold();
  assert.equal(game.startEating(game.inventory.held()), true);
  game.tickEating(0.65);
  assert.equal(game.controller.hunger, 12);
  assert.equal(game.inventory.held().count, 2);
});

test('切到同种食物的另一格也中断进度', () => {
  const { game } = eatingGame();
  game.inventory.set(1, { item: 'bread', count: 2 });
  game.startEating(game.inventory.held());
  game.tickEating(0.6);
  game.selectHotbar(1);
  assert.equal(game.isEating(), false);
  assert.equal(game.controller.hunger, 12);
  assert.equal(game.inventory.held().count, 2);
});

test('进食接线：吃东西不再瞬间生效，扣物品与加饱食都在吞下那一刻', () => {
  const game = fs.readFileSync(new URL('../renderer/js/player/game.js', import.meta.url), 'utf8');
  assert.ok(/startEating\(held\)/.test(game), '食物应走 startEating 而不是立即 eat()');
  assert.ok(!/if \(c\.eat\(held\.item\)\) \{/.test(game), '旧的「点击立刻吃完」入口应已移除');
  assert.ok(/finishEating\(\)[\s\S]{0,220}c\.eat\(e\.item\)[\s\S]{0,160}consumeHeld\(1\)/.test(game), '吞下时才加饱食并扣物品');
  assert.ok(/tickEating\(dt\)/.test(game), '进食过程需要每帧推进');
  assert.ok(/cancelEating\(\)/.test(game), '中断入口必须存在');
});
