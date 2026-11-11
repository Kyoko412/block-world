'use strict';
/*
 * 爆炸（T5 苦力怕）：把「炸掉哪些格子」和「离得越远掉血越少」抽成纯函数。
 * 这一层不碰 THREE、不碰 DOM、也不直接改世界 —— 由调用方（game.js）拿着它去 setBlock，
 * 这样破坏仍然走 world.setBlock 的正常脏标记链路（光照与网格交给 T2 的分帧预算消化）。
 *
 * 三条设计约束（都是被单测钉住的）：
 * ① 范围有界：任何被选中的格子到爆心的距离都不超过 power+1；
 * ② 不碰未生成区块：那里的 getBlock 只是地形近似，炸它等于在隐形地形上挖洞；
 * ③ 不可破的东西留着：基岩、水、熔炉与箱子（后者里面有独立状态，炸掉方块会变成无主数据）。
 */
import { B, AIR } from './blocks.js';

export const CREEPER_POWER = 3;              // 破坏半径（对应原版 power≈3）
export const CREEPER_DAMAGE_RANGE = 6;       // 伤害半径比破坏半径大一圈
export const CREEPER_MAX_DAMAGE = 12;        // 贴脸伤害（生存、无护甲）
export const CREEPER_FUSE_SECONDS = 1.5;     // 嘶嘶充能时间
export const CREEPER_TRIGGER = 3.2;          // 进入这个距离开始充能
export const CREEPER_ESCAPE = 6.0;           // 充能中跑到这个距离之外就取消

/* 爆炸不该碰的方块：基岩（hardness<0 表示不可破坏）、水、以及带独立状态数据的机器方块 */
const NON_BREAKABLE = new Set([B.BEDROCK, B.WATER, B.FURNACE, B.FURNACE_LIT, B.CHEST]);

/**
 * (x,y,z) 这一格「能不能被爆炸移除」：
 * 必须是已真正生成的区块、y 在世界高度内、方块是实心且不在不可破清单里。
 */
export function breakableAt(world, x, y, z) {
  if (!world || typeof world.getChunkAt !== 'function') return false;
  if (!world.getChunkAt(x, z, true)) return false;          // 未生成区块：那里没有真方块
  const id = world.getBlock(x, y, z);
  if (id === AIR || id === undefined) return false;
  if (NON_BREAKABLE.has(id)) return false;
  return world.isSolidAt(x, y, z);
}

/**
 * 返回要移除的格子列表。整体是一个立方体内切球形，边缘按「越靠外越小的概率」抖动，
 * 所以同一颗随机种子给出同一批格子（可复现），换种子形状会变（随机真的参与了）。
 */
export function explosionCells({ cx, cy, cz, power = CREEPER_POWER, rand = Math.random, canBreak }) {
  const r = Math.max(0.5, power);
  const ri = Math.ceil(r);
  const out = [];
  for (let dx = -ri; dx <= ri; dx++) {
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dz = -ri; dz <= ri; dz++) {
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > r + 1) continue;                              // 硬上限：范围有界
        if (d > r && rand() > (r + 1 - d)) continue;          // 外圈按线性概率抖动
        const x = cx + dx, y = cy + dy, z = cz + dz;
        if (!canBreak(x, y, z)) continue;
        out.push({ x, y, z });
      }
    }
  }
  return out;
}

/** 距离衰减：贴脸满伤害，到 range 归零，中间按平方衰减（单调不增） */
export function explosionDamage({ dist = 0, range = CREEPER_DAMAGE_RANGE, maxDamage = CREEPER_MAX_DAMAGE }) {
  if (!(range > 0) || !(maxDamage > 0)) return 0;
  if (dist >= range) return 0;
  const t = 1 - Math.max(0, dist) / range;
  return Math.round(maxDamage * t * t * 100) / 100;
}
