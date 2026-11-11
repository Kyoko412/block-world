'use strict';
/*
 * E3：废弃矿工营地（纯逻辑，无 THREE / DOM / 世界依赖）。
 *
 * 这里只负责四件可无头测试的事：
 *   1. chooseCampSite()  —— 在出生点 24~48 格内挑一块干燥平地，避开海洋与村庄；
 *   2. campLayout()      —— 地面营地 + 短楼梯 + 7×7 地下房间的确定方块布局；
 *   3. campLoot()        —— 两个箱子的固定战利品（钻石由种子/坐标确定，不是开箱时随机）；
 *   4. campChests()      —— 箱子相对坐标与其战利品表名。
 *
 * 真正的方块写入、容器登记与存档都在 game.js / world.js 里完成。
 */
import { B } from './blocks.js';

/* 地面营地整平半径（9×9），楼梯与地下房间向南延伸，最远到 +15。 */
export const CAMP_RADIUS = 4;
export const CAMP_MAX_EXTENT = 16;

/* 候选站点：固定顺序、距离出生点 24~48 格；不会随机漂移。 */
const CAMP_OFFSETS = Object.freeze([
  [28, 0], [0, 28], [-28, 0], [0, -28],
  [32, 18], [-18, 32], [18, -32], [-32, -18],
  [40, 0], [0, 40], [-40, 0], [0, -40],
  [36, 24], [-24, 36], [24, -36], [-36, -24],
  [46, 0], [0, 46], [-46, 0], [0, -46]
]);

/**
 * 选择营地站点。地面必须高于海平面、起伏小；站点与村庄（含营地延伸范围）不能重叠。
 * @param {(x:number,z:number)=>number} sample 纯地形高度采样
 * @param {{x:number,z:number}} spawn 出生点
 * @param {number} seaLevel 海平面
 * @param {number} worldH 世界高度
 * @param {{x:number,z:number}|null} village 村庄站点（可空）
 */
export function chooseCampSite(sample, spawn, seaLevel, worldH, village) {
  if (typeof sample !== 'function') return null;
  const sx = Math.round(Number(spawn && spawn.x) || 0);
  const sz = Math.round(Number(spawn && spawn.z) || 0);
  for (const off of CAMP_OFFSETS) {
    const x = sx + off[0], z = sz + off[1];
    const distSpawn = Math.hypot(x - sx, z - sz);
    if (distSpawn < 24 || distSpawn > 48) continue;
    if (village && Math.hypot(x - village.x, z - village.z) < CAMP_RADIUS + CAMP_MAX_EXTENT + 4) continue;
    let minH = Infinity, maxH = -Infinity;
    for (let dz = -CAMP_RADIUS; dz <= CAMP_RADIUS; dz++) {
      for (let dx = -CAMP_RADIUS; dx <= CAMP_RADIUS; dx++) {
        const h = sample(x + dx, z + dz);
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }
    }
    if (!Number.isFinite(minH) || !Number.isFinite(maxH)) continue;
    /* 干地、起伏不超过 5 格、地面之上留得下棚顶、地下留得下房间 */
    if (minH >= seaLevel + 1 && maxH - minH <= 5 && maxH + 8 < worldH && maxH - 8 > 1) {
      return { x, z, y: maxH, minH, maxH, spread: maxH - minH, offset: off.slice() };
    }
  }
  return null;
}

/* 箱子相对坐标与战利品表名；两个箱子都在 layout 里登记为 CHEST。 */
export const CAMP_CHESTS = Object.freeze([
  Object.freeze({ x: -2, y: 1, z: 0, table: 'surface' }),
  Object.freeze({ x: 2, y: -4, z: 10, table: 'underground' })
]);

/* 稳定哈希：同一颗种子 + 同一站点 → 同一份钻石判定，不依赖开箱时的 Math.random。 */
function hashText(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function campDiamondRoll(seedText, site) {
  const h = hashText(String(seedText ?? '') + '|' + (site ? site.x : 0) + '|' + (site ? site.z : 0));
  return h % 100 < 20;                 // 小概率：约 20% 的营地
}

/**
 * 固定战利品。钻石只在种子/坐标判定通过时出现；其余物品固定。
 * @returns {{surface:object[], underground:object[], diamond:boolean}}
 */
export function campLoot(seedText, site) {
  const diamond = campDiamondRoll(seedText, site);
  const underground = [
    { item: 'iron_ingot', count: 2 },
    { item: 'emerald', count: 1 },
    { item: 'bread', count: 2 }
  ];
  if (diamond) underground.push({ item: 'diamond', count: 1 });
  return {
    surface: [
      { item: 'bread', count: 3 },
      { item: 'arrow', count: 8 },
      { item: 'torch', count: 4 }
    ],
    underground,
    diamond
  };
}

/**
 * 营地布局（相对站点，y=0 是整平后的地面顶层方块；地下为负）。
 * 地面：5×3 帐篷（木板地、四根原木柱、羊毛顶）、工作台、箱子、火把、砂砾；
 * 楼梯：从 z=3 向南 5 级、每级下降 1 格；
 * 地下：z=8..14 的 7×7 房间，石砖/苔石墙与顶、圆石地面，内部空气，无火把（保持黑暗）。
 * @returns {Array<{x:number,y:number,z:number,id:number,meta:number}>}
 */
export function campLayout() {
  const map = new Map();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const put = (x, y, z, id, meta = 0) => map.set(key(x, y, z), { x, y, z, id, meta });

  /* 1) 帐篷：木板地面 + 四根原木柱 + 羊毛顶（顶离地 3 格，玩家站得下） */
  for (let z = -3; z <= -1; z++) for (let x = -2; x <= 2; x++) put(x, 0, z, B.PLANKS);
  for (const [px, pz] of [[-2, -3], [2, -3], [-2, -1], [2, -1]]) {
    put(px, 1, pz, B.LOG);
    put(px, 2, pz, B.LOG);
  }
  for (let z = -3; z <= -1; z++) for (let x = -2; x <= 2; x++) put(x, 3, z, B.PLANKS);

  /* 2) 营地家具与杂物：工作台、地面箱子、火把、砂砾堆 */
  put(2, 1, 0, B.CRAFTING_TABLE);
  put(-2, 1, 0, B.CHEST);                  /* CAMP_CHESTS[0] */
  put(0, 1, 1, B.TORCH);
  put(-3, 0, 1, B.GRAVEL);
  put(3, 0, 1, B.GRAVEL);
  put(3, 1, 2, B.COBBLESTONE);
  put(-3, 1, 2, B.MOSSY);

  /* 3) 矿口木框：楼梯从 z=3 开始，左右立柱 + 顶梁 */
  for (let y = 1; y <= 2; y++) { put(-1, y, 3, B.LOG); put(1, y, 3, B.LOG); }
  put(0, 3, 3, B.PLANKS);

  /* 4) 短楼梯：z=3..7，每格向南下降 1；每级上方留 3 格空气 */
  for (let i = 0; i <= 4; i++) {
    const z = 3 + i, floorY = -i;
    put(0, floorY, z, B.COBBLESTONE);
    for (let h = 1; h <= 3; h++) put(0, floorY + h, z, B.AIR);
  }

  /* 5) 7×7 地下房间：z=8..14，内部 y=-4..-2，地面 -5，顶 -1。
        北墙 z=7 在 x=0 留 3 格高门洞，与最后一级楼梯相接。 */
  for (let z = 8; z <= 14; z++) {
    for (let x = -3; x <= 3; x++) {
      put(x, -5, z, B.COBBLESTONE);                       // 地面
      for (let y = -4; y <= -2; y++) put(x, y, z, B.AIR); // 内部空间
    }
  }
  for (let z = 8; z <= 14; z++) {
    for (let x = -3; x <= 3; x++) put(x, -1, z, B.STONE_BRICKS);   // 顶
  }
  for (let y = -5; y <= -1; y++) {
    for (let z = 8; z <= 14; z++) {
      put(-4, y, z, (z + y) % 3 === 0 ? B.MOSSY : B.STONE_BRICKS);
      put(4, y, z, (z + y) % 4 === 0 ? B.MOSSY : B.STONE_BRICKS);
    }
    for (let x = -4; x <= 4; x++) put(x, y, 15, (x + y) % 3 === 0 ? B.MOSSY : B.STONE_BRICKS);
  }
  for (let y = -5; y <= -1; y++) {
    for (let x = -4; x <= 4; x++) {
      if (x === 0 && y >= -3 && y <= -1) continue;          // 楼梯门洞
      put(x, y, 7, (x + y) % 3 === 0 ? B.MOSSY : B.STONE_BRICKS);
    }
  }
  /* 北墙在 x=0 留门洞；门洞脚下的最后一级台阶在墙循环之后补回圆石。 */
  put(0, -4, 7, B.COBBLESTONE);
  /* 矿脉暗示：墙面上各嵌一块煤/铁矿（只换墙面，不新增方块类型）。 */
  put(-4, -3, 10, B.COAL_ORE);
  put(4, -2, 12, B.IRON_ORE);
  put(-3, -3, 7, B.COAL_ORE);

  /* 6) 地下箱子：放在地面 -5 上、内部空气层 -4；CAMP_CHESTS[1] */
  put(2, -4, 10, B.CHEST);
  /* 房间保持黑暗：内部不放火把/荧石。 */

  return Array.from(map.values()).sort((a, b) => (a.y - b.y) || (a.z - b.z) || (a.x - b.x));
}
