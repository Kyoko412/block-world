'use strict';
/*
 * T3 抛射物（箭）的纯逻辑：不依赖 THREE 与 DOM，可在 Node 里直接单测。
 * mobs.js 只负责渲染与实体管理，物理与命中判定全部走这里的函数。
 */

export const ARROW_GRAVITY = 14;          // 与 mobs.updateArrows 原本用的重力一致
export const ARROW_MIN_SPEED = 20;        // 刚拉开就松手（最小蓄力）的初速度
export const ARROW_MAX_SPEED = 42;        // 满蓄力的初速度
export const ARROW_MIN_DAMAGE = 2;
export const ARROW_MAX_DAMAGE = 8;
export const BOW_CHARGE_SECONDS = 0.9;    // 蓄满所需秒数
export const BOW_MIN_CHARGE = 0.12;       // 低于这个比例不射出（手抖不算）
export const ARROW_STUCK_LIFE = 25;       // 插在地上的箭存在秒数
export const ARROW_PICKUP_DIST = 1.7;     // 玩家靠近到几格内可以把插着的箭捡回来

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

/* 蓄力比例 -> 初速度 / 伤害（线性，蓄力越久越快越痛） */
export function arrowSpeedFor(power) {
  const p = clamp01(power);
  return ARROW_MIN_SPEED + (ARROW_MAX_SPEED - ARROW_MIN_SPEED) * p;
}
export function arrowDamageFor(power) {
  const p = clamp01(power);
  return ARROW_MIN_DAMAGE + (ARROW_MAX_DAMAGE - ARROW_MIN_DAMAGE) * p;
}

/* 蓄力是否足够射出一箭 */
export function bowCanFire(charge) {
  return clamp01(charge) >= BOW_MIN_CHARGE;
}

/*
 * 推进一支箭。a = {x,y,z,vx,vy,vz,life,stuck}
 * isSolid(x,y,z) 由调用方提供（世界采样）。返回状态字符串：
 *   'flying'  仍在飞
 *   'stuck'   这一帧撞上方块，已插住
 *   'expired' 生命周期结束，该回收
 */
export function stepArrow(a, dt, isSolid) {
  if (!a) return 'expired';
  if (a.stuck) {
    a.life -= dt;
    return a.life <= 0 ? 'expired' : 'stuck';
  }
  a.life -= dt;
  a.vy -= ARROW_GRAVITY * dt;
  a.x += a.vx * dt;
  a.y += a.vy * dt;
  a.z += a.vz * dt;
  if (isSolid && isSolid(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z))) {
    a.stuck = true;
    a.vx = 0; a.vy = 0; a.vz = 0;
    return 'stuck';
  }
  return a.life <= 0 ? 'expired' : 'flying';
}

/* 箭是否命中一个竖直盒（生物）：box = {x,y,z,w,h}，(x,y,z) 为脚底中心 */
export function arrowHitsBox(a, box) {
  if (!a || !box || a.stuck) return false;
  const hw = (box.w || 0.6) / 2;
  const h = box.h || 1.8;
  return Math.abs(a.x - box.x) <= hw + 0.12 &&
    Math.abs(a.z - box.z) <= hw + 0.12 &&
    a.y >= box.y - 0.1 && a.y <= box.y + h + 0.1;
}

/* 玩家能否拾回插着的箭 */
export function canPickupStuck(a, px, py, pz) {
  if (!a || !a.stuck) return false;
  const dx = a.x - px, dy = a.y - (py + 0.9), dz = a.z - pz;
  return Math.hypot(dx, dy, dz) <= ARROW_PICKUP_DIST;
}
