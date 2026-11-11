'use strict';
/*
 * 最小可用 TNT（T5）。
 *
 * 只做「手动点燃单体」：
 *   - 打火石右键 TNT → 3 秒引信；
 *   - 引信期间每 0.25 秒闪一次，不写入存档；
 *   - 到点后复用 core/explosion.js 的 explosionCells / explosionDamage 结算；
 *   - 有限连锁：只向下传 1 层、单次最多 6 个；
 *   - 明确水中规则：被水淹没时「湿火药」不破坏方块、不连锁、伤害减半；
 *     水方块本身永远不在可破坏清单里。
 *
 * 这里只放常量和纯函数，方便单测；真正的 setBlock / 音效 / 粒子在 Game 里。
 */

import { B } from './blocks.js';

export const TNT_FUSE_SECONDS = 3;
export const TNT_FLASH_EVERY = 0.25;
export const TNT_POWER = 4;
export const TNT_DAMAGE_RANGE = 8;
export const TNT_MAX_DAMAGE = 20;

/* 有限连锁：只向下传 1 层，单次最多点燃 6 个，避免无限雪崩 */
export const TNT_CHAIN_RADIUS = 5;
export const TNT_CHAIN_DEPTH = 1;
export const TNT_CHAIN_FUSE = 0.7;
export const TNT_CHAIN_MAX = 6;

/* 水中规则：TNT 被水淹没（上方水，或同层 3 面以上是水）时「湿火药」——
   不破坏方块、不连锁，伤害范围/上限减半。明确、可测，不冒充原版。 */
export const TNT_WET_POWER = 2;
export const TNT_WET_RANGE = 4;
export const TNT_WET_MAX_DAMAGE = 8;

export function tntBlastSpec(submerged) {
  if (submerged) {
    return {
      submerged: true, power: TNT_WET_POWER, range: TNT_WET_RANGE, maxDamage: TNT_WET_MAX_DAMAGE,
      breaksBlocks: false, chains: false
    };
  }
  return {
    submerged: false, power: TNT_POWER, range: TNT_DAMAGE_RANGE, maxDamage: TNT_MAX_DAMAGE,
    breaksBlocks: true, chains: true
  };
}

/** 判断 TNT 是否被水淹没；world 需提供 getBlock(x,y,z)。 */
export function tntSubmerged(world, x, y, z) {
  if (!world || typeof world.getBlock !== 'function') return false;
  if (world.getBlock(x, y + 1, z) === B.WATER) return true;
  let wet = 0;
  if (world.getBlock(x + 1, y, z) === B.WATER) wet++;
  if (world.getBlock(x - 1, y, z) === B.WATER) wet++;
  if (world.getBlock(x, y, z + 1) === B.WATER) wet++;
  if (world.getBlock(x, y, z - 1) === B.WATER) wet++;
  return wet >= 3;
}

/**
 * 推进一步引信。
 * @returns {{fuse:number, exploded:boolean, wasExploded:boolean, toggle:boolean}}
 *   exploded 只在「这一帧刚好归零」时为 true（调用方据此只引爆一次）；
 *   wasExploded 表示进来时就已经是 0（防止重复结算）。
 */
export function stepFuse(fuse, dt, flashEvery = TNT_FLASH_EVERY) {
  const wasExploded = !(fuse > 0);
  const before = Math.max(0, fuse);
  const after = Math.max(0, before - Math.max(0, dt));
  const b0 = Math.floor(before / flashEvery), b1 = Math.floor(after / flashEvery);
  return {
    fuse: after,
    exploded: !wasExploded && after <= 0,
    wasExploded,
    toggle: after > 0 && b0 !== b1
  };
}
