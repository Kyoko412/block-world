'use strict';
/*
 * 滚动任务 6：小型村庄探索切片（纯逻辑，无 THREE / DOM / 世界依赖）。
 *
 * 这里只负责三件可无头测试的事：
 *   1. villageLayout()      —— 一份完全确定的村庄方块布局（相对站点中心）；
 *   2. chooseVillageSite()  —— 在出生点附近挑一块平坦陆地（不淹水、不贴世界顶）；
 *   3. performTrade()       —— 三条村民交易的真实扣料/给货规则。
 *
 * 世界的实际写入、村民生成、界面与存档都在 game.js / mobs.js / ui.js 里完成。
 */
import { B } from './blocks.js';

/* 村庄占地半径（含地基），buildVillage 会把这个范围内的地形整平 */
export const VILLAGE_RADIUS = 6;

/* 村民交易：每个职业一张独立的三条交易表，材料都能在前期正常获得。
   农夫表沿用滚动任务 6 的三条（旧存档与旧断言语义不变），另两张表也只用现有物品。 */
const FARMER_TRADES = Object.freeze([
  {
    id: 'wheat_for_emerald', name: '小麦换绿宝石',
    give: { item: 'wheat', count: 10 }, get: { item: 'emerald', count: 1 }
  },
  {
    id: 'emerald_for_bread', name: '绿宝石换面包',
    give: { item: 'emerald', count: 1 }, get: { item: 'bread', count: 3 }
  },
  {
    id: 'emerald_for_iron', name: '绿宝石换铁锭',
    give: { item: 'emerald', count: 3 }, get: { item: 'iron_ingot', count: 1 }
  }
]);

const LIBRARIAN_TRADES = Object.freeze([
  {
    id: 'leather_for_emerald', name: '皮革换绿宝石',
    give: { item: 'leather', count: 3 }, get: { item: 'emerald', count: 1 }
  },
  {
    id: 'emerald_for_map', name: '绿宝石换地图',
    give: { item: 'emerald', count: 1 }, get: { item: 'map', count: 1 }
  },
  {
    id: 'emerald_for_compass', name: '绿宝石换指南针',
    give: { item: 'emerald', count: 2 }, get: { item: 'compass', count: 1 }
  }
]);

const BLACKSMITH_TRADES = Object.freeze([
  {
    id: 'coal_for_emerald', name: '煤炭换绿宝石',
    give: { item: 'coal', count: 3 }, get: { item: 'emerald', count: 1 }
  },
  {
    id: 'emerald_for_iron_ingot', name: '绿宝石换铁锭',
    give: { item: 'emerald', count: 2 }, get: { item: 'iron_ingot', count: 1 }
  },
  {
    id: 'flint_for_emerald', name: '燧石换绿宝石',
    give: { item: 'flint', count: 5 }, get: { item: 'emerald', count: 1 }
  }
]);

/** 三个职业的定义（名称 + 交易表）。顺序固定，生成与存档迁移都按这个顺序。 */
export const VILLAGER_PROFESSIONS = Object.freeze({
  farmer: Object.freeze({ id: 'farmer', name: '农夫', trades: FARMER_TRADES }),
  librarian: Object.freeze({ id: 'librarian', name: '图书管理员', trades: LIBRARIAN_TRADES }),
  blacksmith: Object.freeze({ id: 'blacksmith', name: '铁匠', trades: BLACKSMITH_TRADES })
});

export const VILLAGER_PROFESSION_IDS = Object.freeze(['farmer', 'librarian', 'blacksmith']);

/** 旧存档没有职业字段 → 一律按农夫读（与旧版唯一村民一致）。 */
export function normalizeVillagerProfession(id) {
  return VILLAGER_PROFESSIONS[id] ? id : 'farmer';
}

/** 取某个职业的交易表；未知/缺失职业回落到农夫，保证旧档与旧调用都能工作。 */
export function tradesFor(profession) {
  return VILLAGER_PROFESSIONS[normalizeVillagerProfession(profession)].trades;
}

export function professionName(profession) {
  return VILLAGER_PROFESSIONS[normalizeVillagerProfession(profession)].name;
}

/** 兼容旧导入：默认（农夫）交易表。 */
export const VILLAGER_TRADES = FARMER_TRADES;

/**
 * 三名村民相对村庄站点的确定性位置（不随机漂移）。
 * 农夫留在集市棚（旧版唯一村民的位置），图书管理员在屋内，铁匠在集市南侧的路边草地。
 */
export const VILLAGER_OFFSETS = Object.freeze([
  Object.freeze({ profession: 'farmer', x: 3.5, z: -3.5 }),
  Object.freeze({ profession: 'librarian', x: -3.5, z: -3.5 }),
  Object.freeze({ profession: 'blacksmith', x: 3.5, z: 2.5 })
]);

/** 站点候选：从出生点向外、按固定顺序找第一块平坦陆地（确定性，不随机） */
const SITE_OFFSETS = Object.freeze([
  [14, 0], [0, 14], [-14, 0], [0, -14],
  [16, 16], [-16, 16], [16, -16], [-16, -16],
  [22, 8], [-22, 8], [8, 22], [-8, 22]
]);

/**
 * 选择村庄站点。
 * @param {(x:number,z:number)=>number} sample 纯地形高度采样（world.surfaceHeight）
 * @param {{x:number,z:number}} spawn 出生点
 * @param {number} seaLevel 海平面
 * @param {number} worldH 世界高度上限
 * @returns {{x:number,z:number,y:number,minH:number,maxH:number,spread:number,offset:number[]}|null}
 *   y 是整平后的地面顶层方块坐标（方块站在这上面一格）。
 */
export function chooseVillageSite(sample, spawn, seaLevel, worldH) {
  if (typeof sample !== 'function') return null;
  const sx = Math.round(Number(spawn && spawn.x) || 0);
  const sz = Math.round(Number(spawn && spawn.z) || 0);
  let best = null;
  for (const off of SITE_OFFSETS) {
    const x = sx + off[0], z = sz + off[1];
    let minH = Infinity, maxH = -Infinity;
    for (let dz = -VILLAGE_RADIUS; dz <= VILLAGE_RADIUS; dz++) {
      for (let dx = -VILLAGE_RADIUS; dx <= VILLAGE_RADIUS; dx++) {
        const h = sample(x + dx, z + dz);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    if (!Number.isFinite(minH) || !Number.isFinite(maxH)) continue;
    const cand = { x, z, y: maxH, minH, maxH, spread: maxH - minH, offset: off.slice() };
    if (!best || cand.spread < best.spread) best = cand;
    /* 干地、起伏不超过 6 格、上面还留得下房子与屋顶 */
    if (minH >= seaLevel + 1 && cand.spread <= 6 && maxH + 12 < worldH) return cand;
  }
  /* 实在找不到理想平地：退而求其次，选起伏最小的一块，并保证地面比海高 */
  if (best) {
    if (best.y < seaLevel + 2) best.y = seaLevel + 2;
    return best;
  }
  return null;
}

/**
 * 村庄布局（相对站点中心；y=0 是地面顶层方块）。
 * 房子 5×5（门朝 +z、床、火把、玻璃窗），集市棚（工作台 + 箱子 + 四根木柱），
 * 3 垄小麦 + 1 条水渠的农田，十字土径与广场火把。返回结果按 y/z/x 排序，完全确定。
 */
export function villageLayout() {
  const map = new Map();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const put = (x, y, z, id, meta = 0) => map.set(key(x, y, z), { x, y, z, id, meta });
  const del = (x, y, z) => map.delete(key(x, y, z));

  /* 1) 整平范围内的草地 */
  for (let z = -VILLAGE_RADIUS; z <= VILLAGE_RADIUS; z++) {
    for (let x = -VILLAGE_RADIUS; x <= VILLAGE_RADIUS; x++) put(x, 0, z, B.GRASS);
  }
  /* 2) 十字土径（从村口一直通到广场中心） */
  for (let i = -VILLAGE_RADIUS; i <= VILLAGE_RADIUS; i++) {
    put(i, 0, 0, B.DIRT_PATH);
    put(0, 0, i, B.DIRT_PATH);
  }

  /* 3) 西北：5×5 木屋（第二轮 C2 改造）。
     变化：石基座 + 木板地面、门洞前放石半砖台阶（不再悬空）、两扇玻璃窗、
     四边楼梯做屋檐 + 顶上一层半砖压脊 —— 从平顶盒子变成有屋檐的坡顶小屋。
     室内高度仍是 3 格（y=1..3 空气），床、火把、工作台都能正常使用。 */
  for (let z = -5; z <= -1; z++) for (let x = -5; x <= -1; x++) {
    put(x, 0, z, B.PLANKS);                                  // 地板
    if (x === -5 || x === -1 || z === -5 || z === -1) put(x, 0, z, B.COBBLESTONE);  // 基座
  }
  for (let y = 1; y <= 3; y++) {
    for (let x = -5; x <= -1; x++) { put(x, y, -5, B.PLANKS); put(x, y, -1, B.PLANKS); }
    for (let z = -5; z <= -1; z++) { put(-5, y, z, B.PLANKS); put(-1, y, z, B.PLANKS); }
  }
  /* 四角原木立柱（木框结构，比整面木板更像"盖起来的房子"；也保留原木这个建材语义） */
  for (const [px, pz] of [[-5, -5], [-1, -5], [-5, -1], [-1, -1]]) {
    put(px, 1, pz, B.LOG);
    put(px, 2, pz, B.LOG);
  }
  del(-3, 1, -1); del(-3, 2, -1);                            // 掏出门洞（2 格高）
  put(-3, 1, -1, B.DOOR_BOTTOM, 0);
  put(-3, 2, -1, B.DOOR_TOP, 0);
  put(-3, 1, 0, B.SLAB_STONE, 0);                            // 门前一级石台阶（0.5 格高）
  put(-3, 2, -5, B.GLASS);                                   // 后墙窗
  put(-5, 2, -3, B.GLASS);                                   // 侧墙窗
  put(-4, 1, -4, B.BED, 0);
  put(-2, 1, -4, B.TORCH);
  /* 屋檐：y=4 沿四边放朝外的楼梯（高半片朝屋里），中间 3×3 铺板，y=5 压一块半砖作屋脊 */
  for (let x = -5; x <= -1; x++) {
    put(x, 4, -1, B.STAIRS_PLANKS, 0);                       // +z 边，朝外
    put(x, 4, -5, B.STAIRS_PLANKS, 1);                       // -z 边
  }
  for (let z = -4; z <= -2; z++) {
    put(-1, 4, z, B.STAIRS_PLANKS, 2);                       // +x 边
    put(-5, 4, z, B.STAIRS_PLANKS, 3);                       // -x 边
  }
  for (let z = -4; z <= -2; z++) for (let x = -4; x <= -2; x++) put(x, 4, z, B.PLANKS);
  put(-3, 5, -3, B.SLAB_PLANKS, 0);                          // 屋脊

  /* 4) 东北：石砌作坊（第二轮 C2 改造）。
     半砖地面（进屋抬半步）+ 圆石墙 + 屋檐楼梯 + 工作台与箱子，作为「室内可使用」的第二种小屋。 */
  for (let z = -5; z <= -1; z++) for (let x = 1; x <= 5; x++) {
    put(x, 0, z, B.COBBLESTONE);                             // 整块地面（与室外同高，不陷下去）
  }
  for (let y = 1; y <= 3; y++) {
    for (let x = 1; x <= 5; x++) { put(x, y, -5, B.COBBLESTONE); put(x, y, -1, B.COBBLESTONE); }
    for (let z = -5; z <= -1; z++) { put(1, y, z, B.COBBLESTONE); put(5, y, z, B.COBBLESTONE); }
  }
  del(3, 1, -1); del(3, 2, -1);
  put(3, 1, -1, B.DOOR_BOTTOM, 0);
  put(3, 2, -1, B.DOOR_TOP, 0);
  put(3, 1, 0, B.SLAB_STONE, 0);                             // 门前一级石台阶（与木屋一致）
  put(3, 2, -5, B.GLASS);
  put(5, 2, -3, B.GLASS);
  put(2, 1, -4, B.CRAFTING_TABLE, 0);
  put(4, 1, -3, B.CHEST, 0);
  put(2, 1, -2, B.TORCH);
  for (let x = 1; x <= 5; x++) {
    put(x, 4, -1, B.STAIRS_STONE, 0);
    put(x, 4, -5, B.STAIRS_STONE, 1);
  }
  for (let z = -4; z <= -2; z++) {
    put(5, 4, z, B.STAIRS_STONE, 2);
    put(1, 4, z, B.STAIRS_STONE, 3);
  }
  for (let z = -4; z <= -2; z++) for (let x = 2; x <= 4; x++) put(x, 4, z, B.COBBLESTONE);
  put(3, 5, -3, B.SLAB_STONE, 0);

  /* 5) 西南：3 垄成熟小麦 + 1 条水渠（水渠两侧都在湿润半径内） */
  for (let x = -5; x <= -1; x++) {
    for (let z = 2; z <= 5; z++) {
      if (z === 3) put(x, 0, z, B.WATER);
      else {
        put(x, 0, z, B.FARMLAND, 1);
        put(x, 1, z, B.WHEAT, 7);
      }
    }
  }

  /* 6) 广场火把 */
  put(0, 1, 0, B.TORCH);

  return Array.from(map.values()).sort((a, b) => (a.y - b.y) || (a.z - b.z) || (a.x - b.x));
}

/** 交易前置检查：只读，不扣东西。 */
export function tradeCheck(inv, trade) {
  if (!trade || !trade.give || !trade.get) return { ok: false, reason: 'bad_trade' };
  const have = inv && typeof inv.countOf === 'function' ? inv.countOf(trade.give.item) : 0;
  if (have < trade.give.count) {
    return { ok: false, reason: 'materials', item: trade.give.item, need: trade.give.count, have };
  }
  return { ok: true, item: trade.give.item, need: trade.give.count, have };
}

/**
 * 真正执行一条交易：材料够才扣，扣完立刻给货。
 * @returns {{ok:boolean, reason?:string, item?:string, need?:number, have?:number,
 *            gave?:object, got?:object, leftover?:number}}
 *   leftover > 0 表示背包放不下、由调用方丢在脚下（绝不吞物品）。
 */
export function performTrade(inv, trade) {
  const chk = tradeCheck(inv, trade);
  if (!chk.ok) return chk;
  inv.remove(trade.give.item, trade.give.count);
  const left = inv.add(trade.get.item, trade.get.count);
  return {
    ok: true,
    trade: trade.id,
    gave: { item: trade.give.item, count: trade.give.count },
    got: { item: trade.get.item, count: trade.get.count },
    leftover: Math.max(0, left | 0)
  };
}
