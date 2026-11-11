'use strict';
/*
 * 地形生成：全部使用「世界坐标纯函数」，因此同一坐标在任何时刻、任何机器上
 * 得到完全相同的结果；区块之间可以安全地「越界写入」（树冠、矿脉跨区块无缝拼接）。
 */
import { B, AIR } from '../core/blocks.js';
import { ValueNoise2D, ValueNoise3D, hashFloat, hashFloat2, ihash3, ihash2, mulberry32 } from '../core/rng.js';
import { CHUNK_SX, CHUNK_SZ, WORLD_H, SEA_LEVEL, DEEP_MIN_Y, idx } from './chunk.js';

export const BIOME = {
  OCEAN: 0, BEACH: 1, PLAINS: 2, FOREST: 3, DESERT: 4, TAIGA: 5, MOUNTAINS: 6, SNOWY_PLAINS: 7
};
export const BIOME_NAMES = ['海洋', '沙滩', '平原', '森林', '沙漠', '针叶林', '山地', '雪原'];

export class TerrainGen {
  constructor(seed, opts = {}) {
    this.seed = seed >>> 0;
    /* 阶段 1 第 3 刀：deep = 新档深地布局。所有「让地下变深/变样」的分支都只在这个标志下走，
       旧档（deep=false）连一次比较都不多做，地形与改造前逐位相同（指纹常数钉着）。 */
    this.deep = !!(opts && opts.deep);
    /* 深洞挖空规则按生成版本切换：1 = 旧的两层噪声走廊；2 = 走廊 + 洞室/石柱/高差 */
    this.genVersion = Number(opts && opts.genVersion) || 0;
    this.chambers = this.genVersion >= 2;
    this.nHeight = new ValueNoise2D(this.seed ^ 0x1111);
    this.nDetail = new ValueNoise2D(this.seed ^ 0x2222);
    this.nRidge = new ValueNoise2D(this.seed ^ 0x3333);
    this.nTemp = new ValueNoise2D(this.seed ^ 0x4444);
    this.nRain = new ValueNoise2D(this.seed ^ 0x5555);
    this.nCave = new ValueNoise3D(this.seed ^ 0x6666);
    this.nCave2 = new ValueNoise3D(this.seed ^ 0x7777);
    this.nOre = this.seed ^ 0x8888;
    this._hCache = new Map();      // 列高度缓存（网格化/光照会重复查询同一列）
    this._bCache = new Map();
  }

  /* 地表最高点（实心方块的 y），纯函数 */
  heightAt(wx, wz) {
    const ck = wx * 100000 + wz;
    const hit = this._hCache.get(ck);
    if (hit !== undefined) return hit;
    const h = this._heightAtRaw(wx, wz);
    if (this._hCache.size > 60000) this._hCache.clear();
    this._hCache.set(ck, h);
    return h;
  }

  _heightAtRaw(wx, wz) {
    // 大陆度：周期约 118 格，保证出生点几百格内就有海洋与陆地
    const cont = this.nHeight.fbm(wx * 0.0085, wz * 0.0085, 3);
    const land = (cont - 0.5) * 2;                          // 典型 -0.35 ~ 0.35
    const hill = this.nDetail.fbm(wx * 0.03, wz * 0.03, 4) - 0.5;
    const ridge = this.nRidge.fbm(wx * 0.007, wz * 0.007, 3);
    const mount = Math.pow(Math.max(0, ridge - 0.5) * 2, 1.6);

    let h = SEA_LEVEL + 3 + land * 48 + hill * 8;
    if (h > SEA_LEVEL) h += mount * 22 * Math.min(1, (h - SEA_LEVEL) / 12 + 0.2);
    // 海岸缓冲：贴近海平面时轻微压平，形成沙滩
    if (Math.abs(h - SEA_LEVEL) < 2.5) h = SEA_LEVEL + (h - SEA_LEVEL) * 0.55;
    return Math.max(2, Math.min(WORLD_H - 8, Math.round(h)));
  }

  biomeAt(wx, wz, hIn) {
    const ck = wx * 100000 + wz;
    const hit = this._bCache.get(ck);
    if (hit !== undefined) return hit;
    const h = hIn === undefined ? this.heightAt(wx, wz) : hIn;
    const bi = this._biomeAtRaw(wx, wz, h);
    if (this._bCache.size > 60000) this._bCache.clear();
    this._bCache.set(ck, bi);
    return bi;
  }

  _biomeAtRaw(wx, wz, h) {
    if (h < SEA_LEVEL - 1) return BIOME.OCEAN;
    if (h <= SEA_LEVEL + 1) return BIOME.BEACH;
    // 温度/降水周期约 77 格，让出生点附近就能看到群系变化
    const t = this.nTemp.fbm(wx * 0.013, wz * 0.013, 3);
    const p = this.nRain.fbm(wx * 0.011 + 40, wz * 0.011 - 17, 3);
    if (h > SEA_LEVEL + 26) return BIOME.MOUNTAINS;
    if (t < 0.38) return p > 0.46 ? BIOME.TAIGA : BIOME.SNOWY_PLAINS;
    if (t > 0.60 && p < 0.46) return BIOME.DESERT;
    if (p > 0.54) return BIOME.FOREST;
    return BIOME.PLAINS;
  }

  isCave(wx, wy, wz) {
    /* 新档先问深洞：深洞全部在 y<-6，与下面 2..46 的浅洞带互不重叠；旧档没有这条分支。 */
    if (this.deep && this.deepCave(wx, wy, wz)) return true;
    if (wy < 2 || wy > 46) return false;
    const a = this.nCave.value(wx * 0.045, wy * 0.075, wz * 0.045);
    const b = this.nCave2.value(wx * 0.045 - 11, wy * 0.075 + 7, wz * 0.045 + 23);
    const d = Math.abs(a - 0.5) + Math.abs(b - 0.5);
    return d < 0.115;
  }

  /* 石头 / 深板岩的分界（只有新档读）：名义 -8，随低频噪声上下漂 ±6 格。
     原版那一层是噪声曲面而不是平面 —— 写死一个平面会在 -8 处切出一整片「天花板」，
     玩家挖到那一层时看起来像掉进了一个盒子。 */
  deepslateTop(wx, wz) {
    const v = this.nDetail.fbm(wx * 0.014, wz * 0.014, 2);           // 0..1
    return Math.max(-14, Math.min(-2, -8 + Math.round((v - 0.5) * 12)));
  }

  /* 深洞（新档）：一条**连片、平底、净空 3 格**的可步行洞系，而不是零散针孔。
     做法是两层低频噪声：
       mask = 周期约 33 格（0.030）的超水平集，阈值 0.55 → 命中处是几十格见方的连片洞区，
              不是每列独立掷骰子（上一版按 2×2 列独立决定，实测最长只能连走 4 格，玩家走两步就撞壁）；
       floor = 更低频（0.016）的曲面决定洞底高度 -16..-46 → 相邻列高差最多 1 格，
              正好是本作的台阶高度，走在洞底不需要跳跃也不需要挖路；
     只挖 floor **以上** 3 格、floor 本身保持实心 → 有干净的可站立地面，且洞顶封在深板岩层里
     （上界 -8，与浅洞带 2..46 不连通，也不会灌进海水 —— 本作海洋水位在 26）。
     频率与阈值是扫描出来的本作数值（四根审计柱在出生点 ±24 内都能连走 ≥41 格、
     有洞底的列占 26%~63%；洞只 3 格高，所以多出来的空气体积仍很小）。 */
  deepCave(wx, wy, wz) {
    if (!this.deep) return false;
    if (this.chambers) return this.deepCaveChambers(wx, wy, wz);
    if (wy > -8 || wy < DEEP_MIN_Y + 8) return false;
    /* nCave2/nCave 是 3D 噪声，各取一个固定 y 切面当 2D 用
       （只传两个参数会让 z 变 NaN → 整片噪声报废） */
    const mask = this.nCave2.value(wx * 0.030, 0.31, wz * 0.030);
    if (mask < 0.55) return false;
    const floor = Math.round(-16 - this.nCave.value(wx * 0.016, 0.11, wz * 0.016) * 30);
    return wy > floor && wy <= floor + 3;
  }

  /**
   * 第二轮 C3：带洞室的深洞（只在 genVersion>=2 的新档启用）。
   *
   * 保留 v1 的「连片走廊 + 平底净空 3 格」作为骨架（保证一定走得通），在此之上叠加三种变化：
   *   ① **洞室**：第三层低频噪声（0.010，约 100 格周期）超过阈值的地方把净空抬到 7~10 格，
   *      形成真正的大洞室；天花板封在 y≤-9，不会捅穿到地表或深板岩顶层。
   *   ② **石柱**：洞室内按 7 格粗网格留 1×1 实心柱（还要过一道噪声），洞室因此有遮挡与体量感。
   *   ③ **高差**：洞室里的洞底按噪声上下浮动 ±2 格（走廊仍是 ±1 台阶），形成缓坡与落差。
   * 全部由既有的确定性噪声算出 —— 同种子同坐标每次都一样，跨区块不会接缝错位。
   */
  deepCaveChambers(wx, wy, wz) {
    if (wy > -9 || wy < DEEP_MIN_Y + 8) return false;
    const mask = this.nCave2.value(wx * 0.030, 0.31, wz * 0.030);
    if (mask < 0.55) return false;                       // 走廊骨架（与 v1 同一判据）
    /* 洞室分布要能在同一片洞系里交替出现（否则整段都是大厅、走廊消失）：
       用 0.035 的中频噪声（约 28 格周期），阈值 0.60 → 洞室约占 30~40%。 */
    const room = this.nDetail.fbm(wx * 0.035, wz * 0.035, 2);   // 0..1，洞室分布
    const isRoom = room > 0.60;
    let floor = Math.round(-16 - this.nCave.value(wx * 0.016, 0.11, wz * 0.016) * 30);
    if (isRoom) floor += Math.round((room - 0.5) * 4);   // 洞室里允许 ±2 格高差
    const cap = isRoom ? Math.min(-9, floor + 7 + Math.round(room * 4)) : floor + 3;
    if (wy <= floor || wy > cap) return false;
    /* 石柱：7 格粗网格的中心列 + 噪声过滤，留成实心 */
    if (isRoom && wy > floor) {
      const px = ((wx % 7) + 7) % 7, pz = ((wz % 7) + 7) % 7;
      if (px === 3 && pz === 3 && this.nCave2.value(wx * 0.09, 3.7, wz * 0.09) > 0.5) return false;
    }
    return true;
  }

  /* ---------- 区块生成 ---------- */
  generate(chunk) {
    const x0 = chunk.cx * CHUNK_SX, z0 = chunk.cz * CHUNK_SZ;
    const blocks = chunk.blocks, meta = chunk.meta, hm = chunk.heightMap, bio = chunk.biome;
    let hasWater = false;

    // 1) 基础填充
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const wx = x0 + lx, wz = z0 + lz;
        const h = this.heightAt(wx, wz);
        const bi = this.biomeAt(wx, wz, h);
        hm[lx + lz * CHUNK_SX] = h;
        bio[lx + lz * CHUNK_SX] = bi;
        const sandy = bi === BIOME.DESERT || bi === BIOME.BEACH || (bi === BIOME.OCEAN && h > SEA_LEVEL - 4);
        const soilDepth = sandy ? 4 : 3;
        /* 陡坡直接露出岩层，不再给每一级山崖都盖一条相同的草皮。 */
        let rockySurface = bi === BIOME.MOUNTAINS && h > SEA_LEVEL + 22;
        if (bi === BIOME.MOUNTAINS && !rockySurface) {
          const slope = Math.max(
            Math.abs(h - this.heightAt(wx + 1, wz)), Math.abs(h - this.heightAt(wx - 1, wz)),
            Math.abs(h - this.heightAt(wx, wz + 1)), Math.abs(h - this.heightAt(wx, wz - 1)));
          rockySurface = slope >= 3;
        }

        /* 深地布局：石头/深板岩的分界与基岩带宽度都按列算一次，不在 y 循环里重复取噪声。
           旧档 dsTop 取一个谁也到不了的值，分支条件与改造前等价。 */
        const dsTop = this.deep ? this.deepslateTop(wx, wz) : chunk.minY - 1;
        const bedrockBand = this.deep ? 4 : 3;

        for (let y = chunk.minY; y <= Math.max(h, SEA_LEVEL); y++) {
          const i = idx(lx, y, lz, chunk.minY);
          let id = AIR, m = 0;
          if (y === chunk.minY) id = B.BEDROCK;
          else if (y < chunk.minY + bedrockBand && hashFloat(wx, y, wz, this.seed ^ 0x99) < (chunk.minY + bedrockBand - y) / bedrockBand) id = B.BEDROCK;
          else if (y <= h) {
            if (y > h - soilDepth) {
              // 表层
              if (sandy) id = y === h ? B.SAND : B.SANDSTONE;
              else if (rockySurface && y === h) id = B.STONE;
              else if (bi === BIOME.SNOWY_PLAINS && y === h) id = B.SNOW;
              else id = y === h ? (bi === BIOME.OCEAN ? B.GRAVEL : B.GRASS) : B.DIRT;
            } else {
              /* 主体岩层：浅部石头、深部深板岩（分界是噪声曲面，不是平面） */
              id = y <= dsTop ? B.DEEPSLATE : B.STONE;
            }
            if (id !== B.BEDROCK && y < h - 1 && this.isCave(wx, y, wz)) {
              id = AIR;
            }
            // 山洞底部偶尔铺砂砾（增加真实感）；新档一直铺到接近基岩带
            if (id === AIR && y > (this.deep ? chunk.minY + 5 : 1) &&
                this.nCave.value(wx * 0.045, (y + 1) * 0.075, wz * 0.045) > 0.86) id = B.GRAVEL;
          } else if (y <= SEA_LEVEL) {
            id = B.WATER; hasWater = true;
          }
          blocks[i] = id; meta[i] = m;
        }
      }
    }

    // 2) 矿脉
    this.genOres(chunk, x0, z0);
    // 3) 树木与装饰
    this.genTrees(chunk, x0, z0);
    this.genDecorations(chunk, x0, z0);

    chunk.hasWater = hasWater;
    chunk.state = 1; // GENERATED
  }

  /* 只允许写入本区块范围，但扫描带边距的坐标，保证跨区块连续 */
  writeLocal(chunk, wx, wy, wz, id, m = 0, force = false) {
    if (wy < chunk.minY || wy >= chunk.topY) return;
    const lx = wx - chunk.cx * CHUNK_SX, lz = wz - chunk.cz * CHUNK_SZ;
    if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return;
    const i = idx(lx, wy, lz, chunk.minY);
    if (!force && chunk.blocks[i] !== AIR) return;
    chunk.blocks[i] = id;
    chunk.meta[i] = m;
  }

  genOres(chunk, x0, z0) {
    /* 阶段 2：三种火成岩沿深度分带（浅部花岗岩 / 中部闪长岩 / 深部安山岩），
       方向参照原版 1.18 的「granite 高、diorite 中、andesite 低」；
       阶段 1 第 3 刀：下面这张 LEGACY 表就是原来那份（旧档逐位不变），
       DEEP 表是把同一个思路铺到 -64..63 共 128 格：
       浅部煤铁照常可得，金/青金石/钻石挪到下界附近作为「挖得下去」的回报，
       火成岩三道分带跟着重新拉开。概率与区间是本作数值。 */
    const LEGACY_TYPES = [
      { id: B.COAL_ORE, p: 0.055, yMin: 4, yMax: 52, size: 7, seed: 11 },
      { id: B.IRON_ORE, p: 0.045, yMin: 3, yMax: 40, size: 6, seed: 22 },
      { id: B.GOLD_ORE, p: 0.014, yMin: 2, yMax: 24, size: 5, seed: 33 },
      { id: B.LAPIS_ORE, p: 0.018, yMin: 1, yMax: 26, size: 6, seed: 44 },
      { id: B.DIAMOND_ORE, p: 0.010, yMin: 1, yMax: 14, size: 4, seed: 55 },
      { id: B.EMERALD_ORE, p: 0.006, yMin: 1, yMax: 44, size: 1, seed: 66 },
      { id: B.GRANITE, p: 0.100, yMin: 24, yMax: 56, size: 12, seed: 77 },
      { id: B.DIORITE, p: 0.090, yMin: 12, yMax: 40, size: 12, seed: 88 },
      { id: B.ANDESITE, p: 0.100, yMin: 2, yMax: 28, size: 12, seed: 99 }
    ];
    const DEEP_TYPES = [
      { id: B.COAL_ORE, p: 0.055, yMin: 4, yMax: 52, size: 7, seed: 11 },
      { id: B.COAL_ORE, p: 0.030, yMin: -26, yMax: 4, size: 7, seed: 12 },
      { id: B.IRON_ORE, p: 0.045, yMin: 3, yMax: 40, size: 6, seed: 22 },
      { id: B.IRON_ORE, p: 0.030, yMin: -34, yMax: 2, size: 6, seed: 23 },
      { id: B.GOLD_ORE, p: 0.012, yMin: -50, yMax: -6, size: 5, seed: 33 },
      { id: B.GOLD_ORE, p: 0.008, yMin: -6, yMax: 20, size: 5, seed: 34 },
      { id: B.LAPIS_ORE, p: 0.020, yMin: -46, yMax: 2, size: 6, seed: 44 },
      { id: B.DIAMOND_ORE, p: 0.014, yMin: -58, yMax: -12, size: 4, seed: 55 },
      { id: B.DIAMOND_ORE, p: 0.006, yMin: -12, yMax: 12, size: 4, seed: 56 },
      { id: B.EMERALD_ORE, p: 0.006, yMin: -20, yMax: 44, size: 1, seed: 66 },
      { id: B.GRANITE, p: 0.100, yMin: -4, yMax: 44, size: 12, seed: 77 },
      { id: B.DIORITE, p: 0.090, yMin: -34, yMax: 6, size: 12, seed: 88 },
      { id: B.ANDESITE, p: 0.100, yMin: -56, yMax: -6, size: 12, seed: 99 }
    ];
    const TYPES = this.deep ? DEEP_TYPES : LEGACY_TYPES;
    const CELL = 3;
    for (const t of TYPES) {
      const span = Math.ceil((CHUNK_SX + 8) / CELL);
      for (let cz = -2; cz < -2 + span; cz++) {
        for (let cx = -2; cx < -2 + span; cx++) {
          for (let cy = Math.floor(t.yMin / CELL); cy <= Math.ceil(t.yMax / CELL); cy++) {
            const wx = (x0 + cx * CELL), wy = cy * CELL, wz = (z0 + cz * CELL);
            const r = ihash3(wx >> 1, wy, wz >> 1, this.nOre + t.seed);
            if (r % 1000 > t.p * 1000) continue;
            if (wy < t.yMin || wy > t.yMax) continue;
            const rand = mulberry32((r ^ (t.seed * 2654435761)) >>> 0);
            const n = 1 + Math.floor(rand() * t.size);
            for (let k = 0; k < n; k++) {
              const ox = Math.round((rand() - 0.5) * 3);
              const oy = Math.round((rand() - 0.5) * 2.2);
              const oz = Math.round((rand() - 0.5) * 3);
              const bx = wx + ox, by = wy + oy, bz = wz + oz;
              if (by < chunk.minY + 1 || by >= chunk.topY) continue;
              const local = this.localIndex(chunk, bx, by, bz);
              if (local < 0) continue;
              // 只在石头里替换；新档的深板岩层同样能长成矿（原版深板岩矿产掉的是同一种物品，
              // 所以下面的掉落/熔炼管线一字不改）
              const host = chunk.blocks[local];
              if (host !== B.STONE && !(this.deep && host === B.DEEPSLATE)) continue;
              chunk.blocks[local] = t.id;
            }
          }
        }
      }
    }
  }

  localIndex(chunk, wx, wy, wz) {
    const lx = wx - chunk.cx * CHUNK_SX, lz = wz - chunk.cz * CHUNK_SZ;
    if (lx < 0 || lx >= CHUNK_SX || lz < 0 || lz >= CHUNK_SZ) return -1;
    if (wy < chunk.minY || wy >= chunk.topY) return -1;
    return idx(lx, wy, lz, chunk.minY);
  }

  /* 树：用「3x3 区域 hash 最大值」保证间距，且完全由坐标决定，可越界安全生成 */
  treeAt(wx, wz) {
    const h = this.heightAt(wx, wz);
    const bi = this.biomeAt(wx, wz, h);
    if (bi === BIOME.OCEAN || bi === BIOME.BEACH || bi === BIOME.DESERT) return null;
    let density = 0;
    if (bi === BIOME.FOREST) density = 0.38;
    else if (bi === BIOME.TAIGA) density = 0.32;
    else if (bi === BIOME.PLAINS) density = 0.035;
    else if (bi === BIOME.SNOWY_PLAINS) density = 0.12;
    else if (bi === BIOME.MOUNTAINS) density = 0.035;
    if (hashFloat2(wx, wz, this.seed ^ 0xBEEF) > density) return null;
    // 局部最大：邻域内 hash 最大者才长树，天然保证间距
    let best = null, bestV = -1;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const v = hashFloat2(wx + dx, wz + dz, this.seed ^ 0xD0D0);
      if (v > bestV) { bestV = v; best = [wx + dx, wz + dz]; }
    }
    if (!best || best[0] !== wx || best[1] !== wz) return null;
    if (h <= SEA_LEVEL) return null;
    // 地下是洞穴则不长树
    if (this.isCave(wx, h - 1, wz)) return null;
    const kind = (bi === BIOME.TAIGA) ? 'spruce' : (hashFloat2(wx, wz, this.seed ^ 0x5151) < 0.25 ? 'birch' : 'oak');
    const r = hashFloat2(wx + 7, wz - 3, this.seed ^ 0x7070);
    const trunk = kind === 'birch' ? 5 + Math.floor(r * 3) : 4 + Math.floor(r * 4);
    return { kind, base: h + 1, trunk, seed: ihash2(wx, wz, this.seed ^ 0xA5A5) };
  }

  treeBlocks(tree, wx, wz) {
    // 返回相对树干的方块列表 [dx,dy,dz,id]
    const out = [];
    const rand = mulberry32(tree.seed);
    const t = tree.trunk;
    for (let k = 0; k < t; k++) out.push([0, k, 0, tree.kind === 'birch' ? B.BIRCH_LOG : B.LOG]);
    const leafId = tree.kind === 'birch' ? B.BIRCH_LEAVES : B.LEAVES;
    if (tree.kind === 'spruce') {
      /* 云杉用宽窄交替的阶梯叶层，新增叶层向上长，保留树干底部的净空。 */
      for (let layer = 0; layer < 6; layer++) {
        const ly = t - 4 + layer;
        const rad = [2, 2, 1, 2, 1, 0][layer];
        for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > rad * rad + 1) continue;
          if (rad > 0 && d2 === rad * rad + 1 && rand() < 0.55) continue;
          if (dx === 0 && dz === 0 && ly < t) continue;
          out.push([dx, ly, dz, leafId]);
        }
      }
    } else {
      /* 橡树/白桦：下宽上收的五层叶团。边缘按圆形距离与确定性缺口收束，
         保留足够树叶形成体量，但不再是一个削角的大立方体。 */
      const top = t;
      for (let dy = -3; dy <= 1; dy++) {
        const y = top + dy;
        const rad = dy <= -1 ? 2 : 1;
        for (let dz = -rad; dz <= rad; dz++) for (let dx = -rad; dx <= rad; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > rad * rad + 1) continue;
          if (dx === 0 && dz === 0 && dy < 1) continue;
          if (y >= WORLD_H) continue;
          const edge = d2 >= rad * rad;
          if (edge && rand() < (dy === 1 ? 0.32 : 0.16)) continue;
          if (!edge && dy === -3 && rand() < 0.07) continue;
          out.push([dx, y, dz, leafId]);
        }
      }
    }
    return out;
  }

  genTrees(chunk, x0, z0) {
    const MARGIN = 3;
    for (let lz = -MARGIN; lz < CHUNK_SZ + MARGIN; lz++) {
      for (let lx = -MARGIN; lx < CHUNK_SX + MARGIN; lx++) {
        const wx = x0 + lx, wz = z0 + lz;
        const tree = this.treeAt(wx, wz);
        if (!tree) continue;
        const list = this.treeBlocks(tree, wx, wz);
        for (const [dx, dy, dz, id] of list) {
          const wy = tree.base + dy;
          const bxx = wx + dx, bzz = wz + dz;
          if (id === B.LOG || id === B.BIRCH_LOG) {
            const li = this.localIndex(chunk, bxx, wy, bzz);
            if (li >= 0) { chunk.blocks[li] = id; chunk.meta[li] = 0; }
          } else {
            // 树冠：只填空气，避免覆盖别人的树干
            const li = this.localIndex(chunk, bxx, wy, bzz);
            if (li >= 0 && (chunk.blocks[li] === AIR || chunk.blocks[li] === B.WATER)) {
              chunk.blocks[li] = id;
              chunk.meta[li] = 0;
            }
          }
        }
      }
    }
  }

  /* 地表装饰：完全由坐标决定，跨区块一致 */
  genDecorations(chunk, x0, z0) {
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const wx = x0 + lx, wz = z0 + lz;
        const h = chunk.heightMap[lx + lz * CHUNK_SX];
        const bi = chunk.biome[lx + lz * CHUNK_SX];
        if (h + 1 >= WORLD_H) continue;
        const above = idx(lx, h + 1, lz, chunk.minY);
        if (chunk.blocks[above] !== AIR) continue;
        const surf = chunk.blocks[idx(lx, h, lz, chunk.minY)];
        const r = hashFloat2(wx, wz, this.seed ^ 0xDECA);
        /* 花草按约 5×5 的小群落出现，群落之间留出真正的草地。 */
        const cluster = hashFloat2(Math.floor(wx / 5), Math.floor(wz / 5), this.seed ^ 0xF10A);
        const clusterMul = cluster > 0.58 ? 1.65 : cluster < 0.30 ? 0.18 : 0.72;
        let put = 0;
        if (surf === B.GRASS) {
          if (bi === BIOME.PLAINS || bi === BIOME.FOREST) {
            const grassP = (bi === BIOME.FOREST ? 0.075 : 0.055) * clusterMul;
            const flowerP = 0.011 * clusterMul;
            if (r < grassP) put = B.TALL_GRASS;
            else if (r < grassP + flowerP) put = B.POPPY;
            else if (r < grassP + flowerP * 2) put = B.DANDELION;
          } else if (bi === BIOME.SNOWY_PLAINS) {
            if (r < 0.025 * clusterMul) put = B.TALL_GRASS;
          }
          if ((bi === BIOME.FOREST || bi === BIOME.TAIGA) && !put) {
            const r2 = hashFloat2(wx + 911, wz - 337, this.seed ^ 0xC0DE);
            if (r2 < 0.012) put = B.MUSHROOM_BROWN;
            else if (r2 < 0.018) put = B.MUSHROOM_RED;
            else if (r2 < 0.023) put = B.PUMPKIN;
          }
        } else if (surf === B.SAND && bi === BIOME.DESERT) {
          if (r < 0.03) put = B.DEAD_BUSH;
          else if (r < 0.042) {
            const tall = 2 + (hashFloat2(wx, wz + 77, this.seed ^ 0xCA5C) < 0.4 ? 1 : 0);
            for (let k = 0; k < tall; k++) {
              const i = idx(lx, h + 1 + k, lz, chunk.minY);
              if (h + 1 + k >= WORLD_H || chunk.blocks[i] !== AIR) break;
              chunk.blocks[i] = B.CACTUS;
            }
            continue;
          }
        }
        if (put) { chunk.blocks[above] = put; chunk.meta[above] = 0; }
      }
    }
  }

  /* 出生点：由近及远搜索，优先平坦、无水、无树的陆地 */
  findSpawn() {
    const GOOD = [BIOME.PLAINS, BIOME.FOREST, BIOME.BEACH, BIOME.TAIGA, BIOME.SNOWY_PLAINS, BIOME.DESERT];
    const PREFERRED = [BIOME.PLAINS, BIOME.FOREST, BIOME.BEACH];
    for (let pass = 0; pass < 2; pass++) {
      const accept = pass === 0 ? PREFERRED : GOOD;
      for (let r = 4; r <= 400; r += 6) {
        const steps = Math.max(16, Math.round(r * 1.6));
        for (let a = 0; a < steps; a++) {
          const ang = a / steps * Math.PI * 2;
          const wx = Math.round(Math.cos(ang) * r), wz = Math.round(Math.sin(ang) * r);
          const h = this.heightAt(wx, wz);
          const bi = this.biomeAt(wx, wz, h);
          if (h < SEA_LEVEL + 2 || accept.indexOf(bi) < 0) continue;
          let blocked = false;
          for (let dz = -1; dz <= 1 && !blocked; dz++) {
            for (let dx = -1; dx <= 1 && !blocked; dx++) {
              if (this.treeAt(wx + dx, wz + dz)) blocked = true;
              else if (this.heightAt(wx + dx, wz + dz) > h + 3) blocked = true;
            }
          }
          if (blocked) continue;
          return { x: wx + 0.5, y: h + 1.2, z: wz + 0.5, biome: bi, dist: r };
        }
      }
    }
    const h = Math.max(this.heightAt(0, 0), SEA_LEVEL + 3);
    return { x: 0.5, y: h + 1.2, z: 0.5, biome: BIOME.PLAINS, dist: 0 };
  }
}
