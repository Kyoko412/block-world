'use strict';
/*
 * T2 昼夜时间的纯逻辑：不依赖 THREE 与 DOM，可在 Node 里直接单测。
 * time 取值 0~1，与 gfx/sky.js 的映射一致：
 *   0 = 日出、0.25 = 正午、0.5 = 日落、0.75 = 午夜
 */

export const TIME_SUNRISE = 0.0;
export const TIME_NOON = 0.25;
export const TIME_SUNSET = 0.5;
export const TIME_NIGHT = 0.75;

/* 睡觉后到达的时刻：清晨（太阳刚起来，与新建世界的初始时间接近） */
export const TIME_MORNING = 0.06;

/* 黄昏结束、真正入夜的时刻；黎明前的一小段（0 ~ 0.04）也算夜里，可以补睡到天亮 */
export const NIGHT_START = 0.55;
export const NIGHT_END = 0.04;

export function wrapTime(t) {
  const x = Number(t);
  if (!Number.isFinite(x)) return 0;
  return ((x % 1) + 1) % 1;
}

/* 是否天黑（床只在天黑时可用，与原版一致） */
export function isNight(t) {
  const x = wrapTime(t);
  return x >= NIGHT_START || x < NIGHT_END;
}

/* 天亮的时段（用于白天睡觉的提示文案） */
export function isDay(t) {
  return !isNight(t);
}

/* 睡觉后把时间推到下一个清晨 */
export function advanceToMorning(t) {
  void t;
  return TIME_MORNING;
}
