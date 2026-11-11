'use strict';
/*
 * P0 近战命中与攻击恢复（纯逻辑，不碰 THREE / DOM / 存档，可无头单测）。
 *
 * 为什么单独一层：mobs.js 的 pickNearest() 还被村民交易、剪羊毛、喂食、
 * 狼驯服、盾牌判定五个入口共用，直接改它会大面积回归。这里提供**攻击专用**
 * 的精确命中链，共用入口保持原样，只在 e2e 里回归验证。
 *
 * 距离与冷却是本作设计约定，不是原版实测数值（见 原版参照规格.md）：
 * 原版攻击距离条目被反爬拦截，未取到；冷却参考公开条目但按本作武器表简化。
 */

/**
 * 实体攻击上限 4.0（本作设计约定）。
 * - 方块交互距离仍然走 controller.reach()（生存 5 / 创造 6），两者分离；P0 之前近战直接借用 5 格，
 *   于是「挖方块的距离」变成了「打怪距离」。
 * - 为什么不取 3.6：既有回归 回归.1 打的是站在低一格、水平 3.5 格外的猪，盒面最近距离实测 3.82，
 *   3.6 会让这一发合法命中变成打空（回归.1/回归.2 双双变红）。
 * - 为什么不取 3.0：Java 1.21 的近战距离被反爬拦截没查到（见 原版参照规格.md「待查证」），
 *   所以这里取「明显短于方块交互 5 格、又不推翻既有手感」的 4.0，并把它当成本作约定。
 */
export const MELEE_REACH = 4.0;
/** 命中盒扩边：本作设计约定（原版 hitbox margin 数值未查到，见 原版参照规格.md）。 */
export const HITBOX_MARGIN = 0.35;
/**
 * 盒顶再向上放 0.55。玩家眼睛离地 1.62，而猪/羊/牛的盒顶只有 0.9~1.1，
 * 纯 AABB + 0.35 会让「平视正前方 2 格的猪」完全打不中（D1 回归就是这么暴露的）。
 * P0 之前的 pickNearest 用的是 0.85 的三维垂直容差，比这里更宽，所以这不是放宽而是收紧后仍保留的手感。
 * 只放宽垂直方向：横向容差与方块遮挡判定不变，墙后目标照样打不到。
 */
export const HITBOX_TOP_TOLERANCE = 0.55;

/**
 * 射线与 AABB 求交（slab method），返回入口距离 t；不相交返回 null。
 * 射线起点若在盒内返回 0。dir 需为单位向量。
 */
export function rayAABB(ox, oy, oz, dx, dy, dz, box, maxT = Infinity) {
  let tmin = 0, tmax = maxT;
  const axes = [
    [ox, dx, box.minX, box.maxX],
    [oy, dy, box.minY, box.maxY],
    [oz, dz, box.minZ, box.maxZ]
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let t1 = (lo - o) / d, t2 = (hi - o) / d;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

/**
 * 攻击专用目标选择：真实视点 + 生物碰撞盒 + 方块遮挡。
 * @param {Array} list MobManager.list
 * @param {{x,y,z}} origin 眼睛位置（controller.eyeY）
 * @param {{x,y,z}} dir 视线单位向量
 * @param {number} maxDist 攻击上限
 * @param {number} blockDist 射线命中的第一个方块距离；生物比它更远就被挡住
 * @returns {{mob:object|null, dist:number|null, blocked:boolean}}
 */
export function pickAttackTarget(list, origin, dir, maxDist = MELEE_REACH, blockDist = Infinity) {
  const limit = Math.min(maxDist, MELEE_REACH);
  let best = null, bestT = limit, sawBlocked = false;
  for (const m of list || []) {
    if (!m || m.dead || m.hp <= 0) continue;
    const hw = (m.width || 0.6) / 2 + HITBOX_MARGIN, h = m.height || 1;
    const t = rayAABB(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, {
      minX: m.pos.x - hw, maxX: m.pos.x + hw,
      minY: m.pos.y - HITBOX_MARGIN, maxY: m.pos.y + h + HITBOX_MARGIN + HITBOX_TOP_TOLERANCE,
      minZ: m.pos.z - hw, maxZ: m.pos.z + hw
    }, bestT);
    if (t === null || t >= bestT) continue;
    if (t > blockDist + 1e-3) { sawBlocked = true; continue; }
    bestT = t; best = m;
  }
  return { mob: best, dist: best ? bestT : null, blocked: !best && sawBlocked };
}

/** 按武器给出攻击恢复秒数（本作设计约定，非原版数值）。 */
export function attackCooldownFor(item) {
  if (!item) return 0.25;
  const kind = item.toolType || '';
  const id = String(item.id || item.item || '');
  if (kind === 'sword' || /^sword_/.test(id)) return 0.625;
  if (kind === 'axe' || /^axe_/.test(id)) return 0.8;
  if (kind === 'pickaxe' || /^pickaxe_/.test(id)) return 0.5;
  if (kind === 'shovel' || /^shovel_/.test(id)) return 0.5;
  if (kind === 'hoe' || /^hoe_/.test(id)) return 0.4;
  return 0.25;
}

/** 未满蓄伤害系数（参考公开条目的 0.2 + 0.8p²，本作简化为单一倍率）。 */
export function meleeDamageScale(p) {
  const x = Math.max(0, Math.min(1, p));
  return 0.2 + 0.8 * x * x;
}

/** 攻击恢复进度 p（0 刚挥完，1 完全恢复）。 */
export function attackCharge(remain, total) {
  if (!(total > 0)) return 1;
  return Math.max(0, Math.min(1, 1 - remain / total));
}
