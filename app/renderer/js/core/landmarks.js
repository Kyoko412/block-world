'use strict';
/*
 * R1/R2：出生点之外的小型探索地点（纯逻辑，无 THREE / DOM / world 依赖）。
 *
 * - 地区网格固定 96 格，每区最多一个候选点；种子 + 地区坐标决定类型/变体/偏移/战利品。
 * - 站点必须干燥、平坦、离出生点/村庄/营地/已建地点足够远；纯函数可在 Node 单测。
 * - 布局只返回相对站点的方块表与箱子坐标，真正的写入、容器登记、发现状态在 game.js。
 * - 三类模板：荒野废墟（ruin）/ 废弃哨塔（tower）/ 荒废前哨（outpost），各三种微变化。
 */
import { B } from './blocks.js';

export const LANDMARK_REGION = 96;
export const LANDMARK_MIN_GAP = 40;
export const LANDMARK_TRIGGER_RADIUS = 28;
export const LANDMARK_DISCOVER_RADIUS = 18;
export const LANDMARK_SCAN_SECONDS = 0.6;

export const LANDMARK_TYPES = Object.freeze({
  ruin: Object.freeze({ id: 'ruin', name: '荒野废墟', color: '#c8b46a', radius: 4 }),
  tower: Object.freeze({ id: 'tower', name: '废弃哨塔', color: '#b98b5a', radius: 4 }),
  outpost: Object.freeze({ id: 'outpost', name: '荒废前哨', color: '#7fae6c', radius: 4 })
});
export const LANDMARK_TYPE_IDS = Object.freeze(['ruin', 'tower', 'outpost']);

function hashText(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 地区固定元信息：类型/变体/偏移索引全部由种子与地区坐标决定。 */
export function regionInfo(seed, rx, rz) {
  const h = hashText(String(seed ?? '') + '|' + rx + '|' + rz);
  return {
    id: rx + ',' + rz,
    rx, rz,
    type: LANDMARK_TYPE_IDS[h % LANDMARK_TYPE_IDS.length],
    variant: (h >>> 4) % 3,
    offsetIndex: (h >>> 8) % 8
  };
}

const SITE_OFFSETS = Object.freeze([
  [0, 0], [24, 0], [-24, 0], [0, 24], [0, -24],
  [20, 20], [-20, 20], [20, -20], [-20, -20]
]);

/**
 * 求一个地区的候选站点。
 * @param {number|string} seed
 * @param {number} rx @param {number} rz
 * @param {(x:number,z:number)=>number} sample
 * @param {{spawn?:object, village?:object, camp?:object, landmarks?:object[],
 *          isBlocked?:function, seaLevel?:number, worldH?:number}} [opts]
 * @returns {object|null}
 */
export function candidateFor(seed, rx, rz, sample, opts = {}) {
  if (typeof sample !== 'function') return null;
  const info = regionInfo(seed, rx, rz);
  const sea = Number.isFinite(opts.seaLevel) ? opts.seaLevel : 32;
  const worldH = Number.isFinite(opts.worldH) ? opts.worldH : 64;
  const spawn = opts.spawn || { x: 0, z: 0 };
  const cx = rx * LANDMARK_REGION + Math.floor(LANDMARK_REGION / 2);
  const cz = rz * LANDMARK_REGION + Math.floor(LANDMARK_REGION / 2);
  const radius = LANDMARK_TYPES[info.type].radius;
  const landmarks = Array.isArray(opts.landmarks) ? opts.landmarks : [];
  const offset = SITE_OFFSETS[info.offsetIndex % SITE_OFFSETS.length];
  const x = cx + offset[0];
  const z = cz + offset[1];
  let minH = Infinity, maxH = -Infinity;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const h = sample(x + dx, z + dz);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  if (!Number.isFinite(minH) || !Number.isFinite(maxH)) return null;
  if (minH < sea + 2 || maxH - minH > 3 || maxH + 8 >= worldH || maxH - 3 <= 1) return null;
  if (Math.hypot(x - spawn.x, z - spawn.z) < 34) return null;
  if (opts.village && Math.hypot(x - opts.village.x, z - opts.village.z) < 26) return null;
  if (opts.camp && Math.hypot(x - opts.camp.x, z - opts.camp.z) < 30) return null;
  for (const lm of landmarks) {
    if (!lm || !Number.isFinite(lm.x) || !Number.isFinite(lm.z)) continue;
    if (Math.hypot(x - lm.x, z - lm.z) < LANDMARK_MIN_GAP) return null;
  }
  if (typeof opts.isBlocked === 'function' && opts.isBlocked(x, z, radius + 1)) return null;
  /* R4：地板必须压在实心地面上。上面那些廉价条件都过了才做这次 9×9×2 的洞穴探测——
     只要有一格地表下方两格内是洞穴，整平就等于把洞穴口封死，这种站点直接不要。 */
  if (typeof opts.caveAt === 'function') {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const h = sample(x + dx, z + dz);
        if (opts.caveAt(x + dx, h - 1, z + dz) || opts.caveAt(x + dx, h - 2, z + dz)) return null;
      }
    }
  }
  return {
    id: info.id, region: { rx, rz }, type: info.type, variant: info.variant,
    name: LANDMARK_TYPES[info.type].name,
    x, z, y: maxH, minH, maxH, spread: maxH - minH, radius
  };
}

/** 当前位置附近 3×3 地区（只算玩家附近，不扫描全局）。 */
export function nearbyRegions(px, pz) {
  const rx = Math.floor(px / LANDMARK_REGION), rz = Math.floor(pz / LANDMARK_REGION);
  const out = [];
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) out.push({ rx: rx + dx, rz: rz + dz });
  return out;
}

function landmarkLootFor(type, variant, h) {
  const maybe = (pct) => (h % 100) < pct;
  if (type === 'tower') {
    const out = [
      { item: 'iron_ingot', count: 3 },
      { item: 'emerald', count: 1 },
      { item: 'arrow', count: 8 },
      { item: 'bread', count: 2 }
    ];
    if (maybe(35)) out.push({ item: 'torch', count: 4 });
    return out;
  }
  if (type === 'outpost') {
    const out = [
      { item: 'iron_ingot', count: 2 },
      { item: 'bread', count: 2 },
      { item: 'arrow', count: 6 },
      { item: 'torch', count: 2 }
    ];
    if (maybe(30)) out.push({ item: 'emerald', count: 1 });
    return out;
  }
  const out = [
    { item: 'bread', count: 2 + (variant % 2) },
    { item: 'arrow', count: 6 },
    { item: 'torch', count: 3 },
    { item: 'iron_ingot', count: 1 }
  ];
  if (maybe(15)) out.push({ item: 'emerald', count: 1 });
  return out;
}

/** 固定战利品：同种子 + 同地点 id 完全一致。 */
export function landmarkLoot(seed, lm) {
  const h = hashText(String(seed ?? '') + '|loot|' + (lm ? lm.id : '') + '|' + (lm ? lm.type : ''));
  return landmarkLootFor(lm ? lm.type : 'ruin', lm ? lm.variant : 0, h);
}

/* ---------- 三类布局（相对站点，y=0 为整平后的地面顶层方块） ---------- */
function layoutBuilder() {
  const map = new Map();
  const put = (x, y, z, id, meta = 0) => map.set(x + ',' + y + ',' + z, { x, y, z, id, meta });
  const cells = () => Array.from(map.values()).sort((a, b) => (a.y - b.y) || (a.z - b.z) || (a.x - b.x));
  return { put, cells };
}

function ruinLayout(variant) {
  const b = layoutBuilder();
  /* 5×5 土径地面与一圈低矮断墙（南侧留门）。 */
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) b.put(x, 0, z, B.DIRT_PATH);
  const gaps = variant === 0 ? [[0, 3], [3, 0], [-2, -3], [-3, 2]]
    : variant === 1 ? [[0, 3], [-3, 0], [2, 3], [3, -2]]
      : [[0, 3], [3, 1], [-3, -1], [1, -3]];
  const isGap = (x, z) => gaps.some(g => g[0] === x && g[1] === z);
  for (let i = -3; i <= 3; i++) {
    for (const [x, z] of [[i, -3], [i, 3], [-3, i], [3, i]]) {
      if (isGap(x, z)) continue;
      b.put(x, 1, z, (x + z + variant) % 4 === 0 ? B.MOSSY : B.COBBLESTONE);
      if ((Math.abs(x) === 3 && Math.abs(z) === 3) || (variant === 2 && (x + z) % 5 === 0)) {
        b.put(x, 2, z, (x + z) % 2 ? B.MOSSY : B.COBBLESTONE);
      }
    }
  }
  /* 倒塌的木板/原木与火把 */
  b.put(2, 1, 2, B.PLANKS);
  b.put(1, 1, 2, B.PLANKS);
  b.put(-2, 1, 2, B.LOG);
  b.put(0, 1, 3, B.TORCH);
  const cx = variant === 0 ? -2 : variant === 1 ? 2 : 0;
  const cz = variant === 2 ? -2 : 0;
  b.put(cx, 1, cz, B.CHEST);
  return { name: LANDMARK_TYPES.ruin.name, cells: b.cells(), chests: [{ x: cx, y: 1, z: cz, table: 'main' }], radius: 4 };
}

function towerLayout(variant) {
  const b = layoutBuilder();
  const H = 4 + (variant === 2 ? 1 : 0);
  /* 第一层地板与 5×5 墙；南侧门洞 2 格高。 */
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) b.put(x, 0, z, B.PLANKS);
  for (let y = 1; y < H; y++) {
    for (let i = -2; i <= 2; i++) {
      for (const [x, z] of [[i, -2], [i, 2], [-2, i], [2, i]]) {
        if (x === 0 && z === 2 && y <= 2) continue;          // 门
        b.put(x, y, z, (Math.abs(x) === 2 && Math.abs(z) === 2) ? B.STONE_BRICKS
          : (x + z + y + variant) % 4 === 0 ? B.MOSSY : B.COBBLESTONE);
      }
    }
  }
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) b.put(x, H, z, B.PLANKS);
  /* 东侧外部踏台：4/5 级，每级升 1 格，顶部与屋顶同高。 */
  const side = variant === 1 ? -3 : 3;
  for (let i = 0; i < H; i++) {
    const z = 2 - i;
    for (let y = 1; y <= i + 1; y++) b.put(side, y, z, B.COBBLESTONE);
  }
  const cx = variant === 0 ? 1 : variant === 1 ? -1 : 0;
  const cz = -1;
  b.put(cx, 1, cz, B.CHEST);
  b.put(-1, 1, 0, B.TORCH);
  return { name: LANDMARK_TYPES.tower.name, cells: b.cells(), chests: [{ x: cx, y: 1, z: cz, table: 'main' }], radius: 4, height: H };
}

function outpostLayout(variant) {
  const b = layoutBuilder();
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) b.put(x, 0, z, B.PLANKS);
  for (const [px, pz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
    b.put(px, 1, pz, B.LOG);
    b.put(px, 2, pz, B.LOG);
  }
  const gaps = variant === 0 ? [[-1, -2]] : variant === 1 ? [[1, -2], [2, 0]] : [[-2, 0], [0, 2]];
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) {
    if (gaps.some(g => g[0] === x && g[1] === z)) continue;
    b.put(x, 3, z, variant === 2 && (x + z) % 3 === 0 ? B.MOSSY : B.PLANKS);
  }
  /* 短浅坑：一格深，底部有煤/铁矿，坑边留踏脚。 */
  const pitX = variant === 1 ? 1 : -1;
  for (let z = 2; z <= 3; z++) for (let x = pitX - 1; x <= pitX + 1; x++) {
    b.put(x, 0, z, B.AIR);
    b.put(x, -1, z, B.COBBLESTONE);
  }
  b.put(pitX - 1, -1, 3, B.COAL_ORE);
  b.put(pitX + 1, -1, 2, B.IRON_ORE);
  b.put(pitX, 1, 0, B.CHEST);
  b.put(0, 1, 2, B.TORCH);
  return { name: LANDMARK_TYPES.outpost.name, cells: b.cells(), chests: [{ x: pitX, y: 1, z: 0, table: 'main' }], radius: 4 };
}

export function landmarkLayout(type, variant = 0) {
  const v = ((Number(variant) % 3) + 3) % 3;
  if (type === 'tower') return towerLayout(v);
  if (type === 'outpost') return outpostLayout(v);
  return ruinLayout(v);
}
