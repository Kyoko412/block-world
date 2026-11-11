'use strict';
/*
 * E4：雨天耕地与作物联动（纯逻辑，无 DOM / 无 world 依赖）。
 *
 * 规则：
 *   - 只有「雨」能让露天的耕地变湿、让作物随机生长 ×1.5；雪不算雨。
 *   - 头顶有任意实心方块（屋顶/洞顶/树叶）就算遮蔽：不淋湿、不加速。
 *   - 水渠的湿润判定仍由 world.isFarmlandWet 负责；这里只补「雨水」这一路。
 */

export const RAIN_GROWTH_MULTIPLIER = 1.5;

/** 雨（含雷暴）才是 wet 来源；雪不是。 */
export function isRainWeather(type) {
  return type === 'rain';
}

/**
 * 从 (x,y) 方块向上看是否露天。
 * @param {(x:number,y:number,z:number)=>boolean} isSolidAt
 * @param {number} x @param {number} y @param {number} z 被检查方块坐标
 * @param {number} worldH 世界高度上限
 */
export function isSkyExposed(isSolidAt, x, y, z, worldH) {
  if (typeof isSolidAt !== 'function') return false;
  for (let yy = y + 1; yy < worldH; yy++) {
    if (isSolidAt(x, yy, z)) return false;
  }
  return true;
}

/** 这块耕地是否会因为雨而湿润（已有水渠湿润由 world.isFarmlandWet 另算）。 */
export function rainWetsFarmland(weatherType, exposed) {
  return isRainWeather(weatherType) && !!exposed;
}

/** 作物的雨天生长倍率：露天 + 下雨 = 1.5，其余一律 1。 */
export function cropRainMultiplier(weatherType, exposed) {
  return isRainWeather(weatherType) && exposed ? RAIN_GROWTH_MULTIPLIER : 1;
}
