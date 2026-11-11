'use strict';
/*
 * 滚动任务 8：地图与指南针的纯逻辑（无 DOM / 无 three，可无头单测）。
 *  - 地图按 16×16 区块存「俯视顶层方块 → 调色板索引」，每格 1 个十六进制字符；
 *  - 指南针只算「目标方位相对玩家朝向的角度」与距离，不依赖渲染。
 * 存档里只存已探索区块的 256 字符网格，旧档没有 mapSeen 就是空地图。
 */

export const MAP_CHUNK = 16;
export const MAP_PALETTE = [
  '#0b0b0b', // 0 未知
  '#5f9e3f', // 1 草
  '#8a5a34', // 2 泥土
  '#7e7e7e', // 3 石头
  '#6b6b6b', // 4 圆石
  '#d8cc8a', // 5 沙
  '#3f6fb0', // 6 水
  '#6b4a2c', // 7 原木
  '#3f6b32', // 8 树叶
  '#eef4f7', // 9 雪
  '#b08a50', // 10 木板
  '#9a7b4f', // 11 土径/沙岩
  '#6d4f2f', // 12 耕地
  '#c9b34a', // 13 小麦
  '#5a5a5a', // 14 深色石/基岩
  '#8f8f8f'  // 15 其他
];

const COLOR_OF = {
  1: 3, 2: 2, 3: 1, 4: 4, 5: 14, 6: 5, 7: 11, 8: 6, 9: 6, 10: 7, 11: 8, 12: 7, 13: 8,
  14: 10, 15: 11, 16: 3, 17: 4, 18: 3, 19: 3, 20: 3, 21: 3, 22: 3, 23: 3, 24: 14,
  25: 10, 26: 3, 27: 3, 28: 9, 29: 9, 30: 15, 31: 15, 32: 15, 33: 9, 34: 10,
  35: 11, 36: 12, 37: 13, 38: 8, 39: 10, 40: 1, 41: 1, 42: 1, 43: 11, 44: 8,
  45: 13, 46: 2, 47: 2, 48: 13, 49: 10, 50: 14, 51: 1, 52: 10, 53: 10, 54: 10, 55: 10
};

/** 方块 id → 调色板索引（顶层方块；未知统一 15） */
export function mapColorIndex(id) {
  return Object.prototype.hasOwnProperty.call(COLOR_OF, id) ? COLOR_OF[id] : 15;
}

/**
 * 生成一个区块的 256 字符网格（z 行优先、x 列）。
 * @param {(x:number,z:number)=>{id:number}=} sample 局部坐标 0..15 的顶层方块采样
 */
export function buildMapChunk(sample) {
  if (typeof sample !== 'function') return '0'.repeat(MAP_CHUNK * MAP_CHUNK);
  let out = '';
  for (let z = 0; z < MAP_CHUNK; z++) {
    for (let x = 0; x < MAP_CHUNK; x++) {
      let id = 0;
      try { id = (sample(x, z) || {}).id || 0; } catch (e) { id = 0; }
      out += mapColorIndex(id).toString(16);
    }
  }
  return out;
}

const norm360 = (d) => ((d % 360) + 360) % 360;

/**
 * 指南针指针相对屏幕正上方的旋转角（顺时针为正）。
 * 玩家 yaw 约定与 controller.lookDir 一致：yaw=0 看向 -Z。
 * @param {number} dx 目标 - 玩家（x）
 * @param {number} dz 目标 - 玩家（z）
 * @param {number} yaw 玩家朝向
 */
export function compassDegrees(dx, dz, yaw) {
  const targetYaw = Math.atan2(-dx, -dz);
  return norm360((yaw - targetYaw) * 180 / Math.PI);
}

/** 目标在世界里的绝对方位（北=0°，东=90°），与玩家朝向无关 */
export function bearingDegrees(dx, dz) {
  return norm360(Math.atan2(dx, -dz) * 180 / Math.PI);
}

/** 目标方位的中文八方向，用于右键读数；与当前朝向无关 */
export function compassDirection(dx, dz) {
  const d = bearingDegrees(dx, dz);
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return names[Math.round(d / 45) % 8];
}

/* ==================== R3：已发现地点的地图标记 ==================== */

export const MAP_CANVAS = 400;         // 画布边长（5×5 区块 × 16 格 × 5px）
export const MAP_BLOCK_PX = 5;         // 每格方块的像素，与出生点/玩家箭头同一套换算

/**
 * 把「玩家真的发现过」的地点换算成画布标记。纯函数，不碰 DOM，便于单测网格映射。
 * 规则（R3 的硬要求）：
 *  - 只认 `discovered`，未发现的候选点绝不出现；
 *  - 地点所在区块必须在 `m.seen` 里有快照（= 玩家真探索过这块），否则不画；
 *  - 换算与出生点红叉/玩家箭头完全一致：`((坐标 + 0.5) - 左上区块 * 16) * PX`。
 * @param {{cx:number,cz:number,seen:Object<string,string>}} m Game.mapModel() 的结果
 * @param {Array<{id:string,x:number,z:number,discovered?:boolean,built?:boolean}>} landmarks
 * @param {{px?:number,size?:number}} [opts]
 */
export function mapLandmarkMarkers(m, landmarks, opts = {}) {
  const PX = opts.px || MAP_BLOCK_PX;
  const SIZE = opts.size || MAP_CANVAS;
  const out = [];
  if (!m || !m.seen) return out;
  const oCX = m.cx - 2, oCZ = m.cz - 2;
  for (const lm of landmarks || []) {
    if (!lm || !lm.discovered) continue;
    const ccx = Math.floor(lm.x / 16), ccz = Math.floor(lm.z / 16);
    const key = ccx + ',' + ccz;
    if (!m.seen[key]) continue;                       // 未探索区块：不提前暴露
    const mx = (lm.x + 0.5 - oCX * MAP_CHUNK) * PX;
    const my = (lm.z + 0.5 - oCZ * MAP_CHUNK) * PX;
    if (mx < 0 || mx > SIZE || my < 0 || my > SIZE) continue;
    out.push({
      id: lm.id, type: lm.type, name: lm.name, x: lm.x, z: lm.z,
      chunk: key, mx: Math.round(mx * 10) / 10, my: Math.round(my * 10) / 10
    });
  }
  return out;
}
