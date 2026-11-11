'use strict';
/*
 * 区块（Chunk）：16x16 的水平柱。
 * 高度不再写死为 64：每个区块带 minY / layers / topY，默认 0 / WORLD_H / 64，
 * 与旧布局（以及存档 diff 的下标）逐位一致。
 *
 * 阶段 1 第 2 刀只做「索引参数化」，生产路径仍走默认布局，行为中性；
 * 负 Y 布局由 VoxelWorld 的 layout 选项启用，真正的地形与矿脉重排在下一刀。
 * 坐标约定（非常重要）：idx() 的 y 参数永远是**世界 y**，不是层内序号；
 * BFS 从下标反推层号后必须加回 minY 才能得到世界 y。
 */
import { AIR, B } from '../core/blocks.js';

export const CHUNK_SX = 16;
export const CHUNK_SZ = 16;
export const WORLD_H = 64;
export const SEA_LEVEL = 26;
export const CHUNK_AREA = CHUNK_SX * CHUNK_SZ;
export const CHUNK_VOL = CHUNK_AREA * WORLD_H;

/* 阶段 1 深地布局的尺寸放在这一层（而不是 world.js）：`world.js` 与 `terrain.js` 都要读它，
   放上面谁 import 谁就形成环。地表尺度不动 —— 顶仍然是 WORLD_H，只把下界扩到 -64。 */
export const DEEP_MIN_Y = -64;
export const DEEP_LAYERS = WORLD_H - DEEP_MIN_Y;    // 64 - (-64) = 128 格

export const CHUNK_STATE = { EMPTY: 0, GENERATED: 1, LIT: 2, MESHED: 3 };

export function chunkKey(cx, cz) { return cx + ',' + cz; }
export function keyToCoords(key) {
  const i = key.indexOf(',');
  return [parseInt(key.slice(0, i), 10), parseInt(key.slice(i + 1), 10)];
}
export function coordKey(cx, cz) { return cx + ',' + cz; }

/* 局部索引：x + z*16 + (世界y - minY)*256。
   minY 默认 0 —— 旧调用（含既有单测）拿到的下标与改造前逐位相同。 */
export function idx(x, y, z, minY = 0) {
  return x + z * CHUNK_SX + (y - minY) * CHUNK_AREA;
}
export function inBounds(x, y, z, minY = 0, layers = WORLD_H) {
  return x >= 0 && x < CHUNK_SX && z >= 0 && z < CHUNK_SZ &&
    y >= minY && y < minY + layers;
}

export class Chunk {
  constructor(cx, cz, seed, minY = 0, layers = WORLD_H) {
    this.cx = cx; this.cz = cz;
    this.seed = seed >>> 0;
    /* 布局字段：默认与旧档完全一致。topY 是「上界，不含」，避免各处重复相加。 */
    this.minY = Number.isFinite(minY) ? (minY | 0) : 0;
    this.layers = Number.isFinite(layers) && layers > 0 ? (layers | 0) : WORLD_H;
    this.topY = this.minY + this.layers;
    this.volume = CHUNK_AREA * this.layers;
    this.blocks = new Uint8Array(this.volume);
    this.meta = new Uint8Array(this.volume);
    this.light = new Uint8Array(this.volume);     // 高 4 位天空光，低 4 位方块光
    this.heightMap = new Uint8Array(CHUNK_AREA);  // 地表高度（不含装饰）
    this.biome = new Uint8Array(CHUNK_AREA);
    this.state = CHUNK_STATE.EMPTY;
    this.dirtyLight = true;
    this.dirtyMesh = true;
    this.edits = new Map();      // 局部索引 -> [blockId, meta]（旧档键仍是旧下标）
    this.meshes = [];            // three Mesh 列表
    this.hasWater = false;
    this.lastUse = 0;
  }

  get(x, y, z) {
    if (y < this.minY) return B.BEDROCK;
    if (y >= this.topY) return AIR;
    return this.blocks[idx(x, y, z, this.minY)];
  }
  getMeta(x, y, z) {
    if (y < this.minY || y >= this.topY) return 0;
    return this.meta[idx(x, y, z, this.minY)];
  }
  set(x, y, z, id, m = 0) {
    if (y < this.minY || y >= this.topY) return;
    const i = idx(x, y, z, this.minY);
    this.blocks[i] = id;
    this.meta[i] = m;
  }
  setRaw(i, id, m) { this.blocks[i] = id; this.meta[i] = m; }

  getSky(x, y, z) {
    if (y >= this.topY) return 15;
    if (y < this.minY) return 0;
    return this.light[idx(x, y, z, this.minY)] >> 4;
  }
  getBlockLight(x, y, z) {
    if (y < this.minY || y >= this.topY) return 0;
    return this.light[idx(x, y, z, this.minY)] & 15;
  }
  setLight(x, y, z, sky, block) {
    if (y < this.minY || y >= this.topY) return;
    this.light[idx(x, y, z, this.minY)] = ((sky & 15) << 4) | (block & 15);
  }
  lightAt(x, y, z) {
    if (y >= this.topY) return 0xff;
    if (y < this.minY) return 0;
    return this.light[idx(x, y, z, this.minY)];
  }

  recordEdit(i, id, m) { this.edits.set(i, [id, m]); }

  serializeEdits() {
    if (!this.edits.size) return null;
    const out = [];
    for (const [i, v] of this.edits) out.push(i, v[0], v[1]);
    return out;
  }

  static fromSavedEdits(cx, cz, seed, flat) {
    const map = new Map();
    for (let k = 0; k + 2 < flat.length; k += 3) map.set(flat[k], [flat[k + 1], flat[k + 2]]);
    return map;
  }

  dispose(scene) {
    for (const m of this.meshes) {
      scene.remove(m);
      if (m.geometry) m.geometry.dispose();
    }
    this.meshes.length = 0;
  }
}
