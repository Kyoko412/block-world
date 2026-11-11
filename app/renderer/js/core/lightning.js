'use strict';
/*
 * 滚动任务 7：雷暴闪电的纯逻辑（无 DOM / 无 three，可无头单测）。
 * 只做三件事：下一次落雷间隔、落点偏移、按距离算伤害。
 * 真正的闪光、雷声、方块/生物结算在 game.js / gfx/lightning.js 里完成。
 */

export const LIGHTNING_DAMAGE_RANGE = 6;     // 伤害半径（格）
export const LIGHTNING_MAX_DAMAGE = 12;      // 爆心伤害
export const LIGHTNING_STRIKE_MIN = 3.5;     // 两次落雷的最短间隔（秒）
export const LIGHTNING_STRIKE_MAX = 8.5;     // 最长间隔
export const LIGHTNING_RADIUS_MIN = 6;       // 落点与玩家的水平距离范围
export const LIGHTNING_RADIUS_MAX = 15;
export const LIGHTNING_FLASH_SECONDS = 0.22; // 闪电可见时长
export const THUNDER_DELAY_MIN = 0.25;       // 雷声延迟（秒）
export const THUNDER_DELAY_MAX = 1.1;

const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

/** 按距离衰减的闪电伤害：6 格外 0，中心 12；平方衰减，近处更疼 */
export function lightningDamage(dist, range = LIGHTNING_DAMAGE_RANGE, max = LIGHTNING_MAX_DAMAGE) {
  if (!(dist >= 0) || dist > range) return 0;
  const f = 1 - dist / range;
  return Math.max(0, Math.round(max * f * f));
}

/** 下一次落雷倒计时（秒），rnd ∈ [0,1) */
export function nextStrikeDelay(rnd = Math.random) {
  return LIGHTNING_STRIKE_MIN + (LIGHTNING_STRIKE_MAX - LIGHTNING_STRIKE_MIN) * clamp01(rnd());
}

/** 以玩家为中心的落点偏移（dx, dz），距离落在 6~15 格，方向均匀 */
export function pickStrikeOffset(rnd = Math.random) {
  const ang = clamp01(rnd()) * Math.PI * 2;
  const dist = LIGHTNING_RADIUS_MIN + (LIGHTNING_RADIUS_MAX - LIGHTNING_RADIUS_MIN) * clamp01(rnd());
  return { dx: Math.cos(ang) * dist, dz: Math.sin(ang) * dist, dist };
}

/** 雷声延迟：越远越晚（给视听一点距离感） */
export function thunderDelay(rnd = Math.random) {
  return THUNDER_DELAY_MIN + (THUNDER_DELAY_MAX - THUNDER_DELAY_MIN) * clamp01(rnd());
}
