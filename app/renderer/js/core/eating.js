'use strict';
/*
 * 进食过程的纯逻辑：吃什么、几口、每口什么时候响、什么时候真正吞下。
 *
 * 这个文件不碰音频与 DOM，单测可以直接钉住：
 *   · 两口/三口的节奏由食物回复量决定，重的东西多嚼一口；
 *   · 真正的加饱食与扣物品发生在「吞下」那一刻，不是点击瞬间；
 *   · 中断（松手 / 切物品 / 开界面 / 暂停）不会吞下，也不会扣物品。
 *
 * 材质：干粮、果蔬的清脆水分、熟食的柔软口感。
 */
const JUICY = new Set(['apple', 'carrot', 'beef_raw', 'pork_raw', 'chicken_raw', 'fish_raw', 'rotten_flesh', 'potato']);
const SOFT = new Set(['beef_cooked', 'pork_cooked', 'chicken_cooked', 'fish_cooked', 'potato_baked', 'cake', 'mushroom_stew']);

export function eatTexture(itemId) {
  return SOFT.has(itemId) ? 'soft' : JUICY.has(itemId) ? 'juicy' : 'dry';
}

/** 需要几口：回复越多的食物多嚼一口，避免所有东西都两口完事。 */
export function eatBites(food) {
  const value = Number.isFinite(food) ? food : 4;
  return value >= 7 ? 3 : 2;
}

/**
 * @param {{id:string, food:number}} item  食物定义
 * @returns {{total:number, texture:string, beats:Array<{at:number,name:string,kind:string,volume:number}>}}
 */
export function eatPlan(item) {
  const texture = eatTexture(item.id);
  const bites = eatBites(item.food);
  const beats = [];
  for (let i = 0; i < bites; i++) {
    const cycle = 0.18 + i * 0.48;
    beats.push({ at: cycle, kind: 'bite', name: `eat_bite_${texture}`, volume: 0.55 });
    beats.push({ at: cycle + 0.24, kind: 'chew', name: `eat_chew_${texture}`, volume: 0.38 });
  }
  const swallowAt = 0.18 + (bites - 1) * 0.48 + 0.46;
  beats.push({ at: swallowAt, kind: 'swallow', name: 'eat_swallow', volume: 0.38 });
  return { total: swallowAt + 0.2, texture, bites, beats };
}

/** 咬有三条，嚼与吞各两条；每个动作单独轮换。 */
export function eatVariantName(base, variantIndex) {
  const pool = base.startsWith('eat_bite_') ? 3 : 2;
  const pick = ((variantIndex % pool) + pool) % pool;
  return base + ['', '_b', '_c'][pick];
}

/**
 * 进食会话：Game 只负责「什么时候开始/中断/吞下」，节奏与排程都在这里。
 * 每次 tick 返回这一刻该响的声音，以及是否到了「吞下」。
 */
export function createEatSession(item, variants = Object.create(null)) {
  return { item: item.id, plan: eatPlan(item), t: 0, next: 0, variants, done: false };
}

export function tickEatSession(session, dt) {
  const cues = [];
  let swallow = false;
  if (!session || session.done) return { cues, swallow };
  session.t += dt;
  while (session.next < session.plan.beats.length && session.plan.beats[session.next].at <= session.t) {
    const beat = session.plan.beats[session.next++];
    const variant = session.variants[beat.name] || 0;
    session.variants[beat.name] = variant + 1;
    const cue = { name: eatVariantName(beat.name, variant), volume: beat.volume, kind: beat.kind };
    if (beat.kind === 'swallow') {
      session.done = true;
      swallow = true;
      cues.push(cue);
      break;
    }
    cues.push(cue);
  }
  return { cues, swallow };
}

export default { eatTexture, eatBites, eatPlan, eatVariantName, createEatSession, tickEatSession };
