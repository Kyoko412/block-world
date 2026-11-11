'use strict';
/*
 * P1 实体光照：把体素 shader 里那条「天空光 / 方块光」亮度曲线搬到 JS，供生物、
 * 掉落物这类用内置 MeshBasicMaterial 的实体取色。
 *
 * 为什么要单独一层：验收报告已知问题 #28 —— 地形在 VOX_FRAG 里自己算亮度与雾，
 * 实体却一直是纯色材质，所以洞穴里的猪和太阳底下的猪一模一样亮，
 * 「生物不像活在这个世界里」。这里与 shader 用**同一组常数**，
 * e2e 的 EL.2 会把两边钉在一起（改了 shader 常数而没改这里，验收直接红）。
 *
 * 与 world.brightnessAt（0.05+0.95·v^1.15）和 lighting.lightToBrightness（0.06+0.94·v^1.25）
 * 不同：那两条是给生成判定与旧调用方用的公开 API，本轮不动它们（改了会牵动既有断言）。
 */

/** 可见度下限：全黑的地方仍要能看出剪影，否则玩家被暗处偷袭毫无反应。 */
export const ENTITY_LIGHT_FLOOR = 0.16;

/** 与 VOX_FRAG 同源的一组常数（改这里必须同时改 view.js，EL.2 会核对）。 */
export const CURVE = {
  flatA: 0.065, flatB: 0.935, flatPow: 1.12,   // 天空光主导：近乎线性的平坦曲线（白天）
  poolA: 0.045, poolB: 0.955, poolPow: 1.80    // 方块光主导：陡衰减，做出火把光池
};

/**
 * 实体亮度系数（0~1）。sky/block 取 0~15 原始等级，dayFactor 是昼夜系数。
 * 与 shader 的差别只有两点：① 这里额外夹了 ENTITY_LIGHT_FLOOR 保可见度；
 * ② shader 后面还有一层「暗部校准」和雾，那些是像素级效果，材质色不需要跟。
 */
export function entityBrightness(sky, block, dayFactor = 1) {
  const skyL = Math.max(0, Math.min(1, (sky / 15) * dayFactor));
  const blkL = Math.max(0, Math.min(1, block / 15));
  const lvl = Math.max(skyL, blkL);
  const bFlat = CURVE.flatA + CURVE.flatB * Math.pow(lvl, CURVE.flatPow);
  const bPool = CURVE.poolA + CURVE.poolB * Math.pow(lvl, CURVE.poolPow);
  const blkDom = Math.max(0, Math.min(1, (blkL - skyL) / Math.max(0.001, blkL + skyL)));
  const b = bFlat + (bPool - bFlat) * blkDom;
  return Math.max(ENTITY_LIGHT_FLOOR, Math.min(1, b));
}

/** 按系数压暗一个颜色（保留色相与相对明度，只做明度缩放）。 */
export function shadeColor(hex, k) {
  const x = Math.max(0, Math.min(1, k));
  const r = Math.round(((hex >> 16) & 255) * x);
  const g = Math.round(((hex >> 8) & 255) * x);
  const b = Math.round((hex & 255) * x);
  return (r << 16) | (g << 8) | b;
}

/**
 * 两色是否仍然可辨：给单测钉住「压暗之后同职业村民不会撞色」。
 * 逐通道最大差 >= d 才算分得开。
 */
export function colorsDistinguishable(list, d = 4) {
  const seen = [];
  for (const c of list) {
    for (const p of seen) {
      const dr = Math.abs(((c >> 16) & 255) - ((p >> 16) & 255));
      const dg = Math.abs(((c >> 8) & 255) - ((p >> 8) & 255));
      const db = Math.abs((c & 255) - (p & 255));
      if (Math.max(dr, dg, db) < d) return false;
    }
    seen.push(c);
  }
  return true;
}
