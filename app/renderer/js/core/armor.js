'use strict';
/*
 * 护甲：纯逻辑（点数/减伤/伤害类型），不碰渲染与存档。
 *
 * 规则（可解释、可测试）：
 *   每 1 点护甲减免 4%，总减免封顶 80%（20 点）。
 *   皮革 5 / 铁 15 / 钻石 20 点为套装总点数。
 *   只减免「战斗伤害」：近战、生物箭矢、爆炸。
 *   溺水、饥饿、摔落、仙人掌、中毒等环境伤害走原样，不经过这里。
 *
 * 耐久消耗不在这里做（那是 Inventory 的事）；这里只回答「这次该扣多少血」。
 */

/** 可被护甲减免的伤害类型（调用方必须显式传入，见 PlayerController.hurt） */
export const ARMOR_DAMAGE_TYPES = new Set(['melee', 'arrow', 'explosion']);

/** 每点护甲减免比例 */
export const ARMOR_REDUCTION_PER_POINT = 0.04;
/** 总减免上限（20 点） */
export const ARMOR_MAX_REDUCTION = 0.8;
export const ARMOR_MAX_POINTS = ARMOR_MAX_REDUCTION / ARMOR_REDUCTION_PER_POINT;

/** 护甲点数 → 减免比例（0~0.8）；负数视为 0，不做增伤 */
export function armorReduction(points) {
  const p = Number.isFinite(points) ? points : 0;
  if (p <= 0) return 0;
  return Math.min(ARMOR_MAX_REDUCTION, p * ARMOR_REDUCTION_PER_POINT);
}

/** 一次伤害经过护甲后实际扣多少血（四舍五入到 0.01，避免浮点尾巴进存档） */
export function applyArmorReduction(amount, points) {
  const a = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (a <= 0) return 0;
  const taken = a * (1 - armorReduction(points));
  return Math.round(taken * 100) / 100;
}
