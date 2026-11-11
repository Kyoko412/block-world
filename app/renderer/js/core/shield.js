'use strict';
/*
 * 盾牌方向性防御（纯逻辑）。
 *
 * 规则：
 *   - 只挡「战斗伤害」里的近战与箭矢；
 *   - 只挡正面 120° 扇区（以玩家视线水平方向为中线，左右各 60°）；
 *   - 爆炸 / 摔落 / 仙人掌 / 溺水 / 饥饿 / 中毒一律不挡（爆炸在本作是范围伤害，不吃方向性防御）；
 *   - 背后攻击照常结算。
 *
 * 耐久与音效不在纯函数里：控制器只回答「这次挡没挡住」，由 Game 扣耐久并给反馈。
 */

/** 总扇区角（弧度）：120° */
export const SHIELD_BLOCK_ANGLE = Math.PI * 2 / 3;
/** 半角：60° */
export const SHIELD_HALF_ANGLE = SHIELD_BLOCK_ANGLE / 2;
const COS_HALF = Math.cos(SHIELD_HALF_ANGLE);

/** 哪些伤害类型会被盾牌挡住（爆炸明确不在内） */
export function shieldCanBlock(type) {
  return type === 'melee' || type === 'arrow';
}

/**
 * 视线水平方向 (lx,lz) 与「玩家指向来源」的水平方向 (dx,dz) 的夹角是否 ≤60°。
 * 任一方向为零长度时返回 false（不能靠退化向量白挡）。
 * @param {number} lx @param {number} lz 单位视线（水平分量，可不严格单位化）
 * @param {number} dx @param {number} dz 从玩家指向攻击来源的向量
 */
export function inShieldArc(lx, lz, dx, dz) {
  const ll = Math.hypot(lx, lz);
  const dl = Math.hypot(dx, dz);
  if (ll < 1e-6 || dl < 1e-6) return false;
  const dot = (lx * dx + lz * dz) / (ll * dl);
  return dot >= COS_HALF - 1e-9;
}
