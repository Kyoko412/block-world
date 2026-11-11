'use strict';
/*
 * 世界：区块流式加载/卸载、方块读写（记录改动 diff）、光照与网格的重算调度、射线检测。
 * 这一层完全不依赖 THREE 与 DOM，方便在 Node 里直接做逻辑单元测试。
 */
import { AIR, B, BLOCKS, isSolid, isReplaceable, isPlant, FARMLAND_WET_RADIUS } from '../core/blocks.js';
import { Chunk, CHUNK_SX, CHUNK_SZ, WORLD_H, SEA_LEVEL, DEEP_MIN_Y, DEEP_LAYERS, idx, coordKey } from './chunk.js';
export { DEEP_MIN_Y, DEEP_LAYERS };
import { TerrainGen } from './terrain.js';
import { lightChunk } from './lighting.js';

export const SAVE_VERSION = 1;
/* 阶段 1：世界「生成版本」。
 * 0 = 旧档布局（0..63 共 64 格，`idx = x + z*16 + y*256`，存档 diff 的键就是这个下标）；
 * 1 = 新档深地布局（向下扩到 Y=-64）。
 * 旧存档里没有这个字段 → 一律按 0 处理：方块 ID、编辑位置、容器内容才谈得上「原样恢复」。
 * 布局字段绝不能靠「大概兼容」推断，只能显式分版本。 */
export const GEN_LEGACY = 0;
export const GEN_DEEP = 1;
/* 第二轮 C3：深洞洞室版本。布局与 GEN_DEEP 完全一致（-64/128），只改**深洞的挖空规则**；
   旧档（0/1）继续按原规则生成新区块，存档里的既有方块本来就在 diff 里，不受影响。 */
export const GEN_DEEP_CHAMBERS = 2;
/* 深地布局的尺寸：地表尺度完全不动（顶还是 63、海平面还是 26），只把下界扩到 Y=-64，
 * 共 128 格。参照 Java 1.21 的「向上不扩、先给地下」做法，本阶段不动高空。
 * 常量本身定义在 chunk.js（DEEP_MIN_Y / DEEP_LAYERS），这里只 re-export。 */
/* 新档用哪个版本 —— 这是「深地布局」唯一的总开关。
 * 第 3 刀起翻成 GEN_DEEP：负 Y 布局、岩层、矿脉重排、深洞就在这一次改动里一起落地。
 * 之前两刀不能翻，是因为存档会被标成深地版本而 diff 键还是旧布局下标 —— 那是最难查的一类损坏。
 * 现在仍然守着同一条不变量：**标签与布局必须同版本**，所以
 * layoutByGenVersion() 是唯一入口，任何「手动传 layout」都只用于测试。 */
export const NEW_WORLD_GEN_VERSION = GEN_DEEP_CHAMBERS;

/* 生成版本 → 区块布局的唯一映射。旧档（缺字段/脏值 → GEN_LEGACY）永远拿 0..63，
 * 与改造前的 idx() 下标逐位相同，存档 diff 的键才谈得上「原样恢复」。 */
export function layoutByGenVersion(gv) {
  return (gv === GEN_DEEP || gv === GEN_DEEP_CHAMBERS)
    ? { minY: DEEP_MIN_Y, layers: DEEP_LAYERS } : { minY: 0, layers: WORLD_H };
}

/* 从存档 meta 里决定生成版本：只有显式写了 GEN_DEEP 才算深地档。
 * 旧档缺字段、字段是脏值（字符串 / null / 别的数字）→ 一律 GEN_LEGACY。
 * 单独做成纯函数是为了能在 Node 里直接单测，不用起浏览器。 */
export function genVersionFromMeta(meta) {
  /* 第二轮 C3：显式记住 1/2 两种深地版本；缺字段/脏值仍旧回落 GEN_LEGACY。 */
  if (!meta) return GEN_LEGACY;
  if (meta.genVersion === GEN_DEEP_CHAMBERS) return GEN_DEEP_CHAMBERS;
  if (meta.genVersion === GEN_DEEP) return GEN_DEEP;
  return GEN_LEGACY;
}

/* T2 分帧预算（已知问题 #20：读档 / 批量改方块时单帧最长 2547ms）。
 * 三段各自的预算 + 一个 total 硬上限：某段的结束点 = min(硬上限, 该段起点 + 该段预算)，
 * 前面没花完的时间可以借给后面。
 * 注意「单个区块是不可分割的工作量」——实测一个区块 = 生成 2.5ms、补光 1.2ms、重建网格 10.5ms，
 * 所以帧耗时的下界是「预算上限 + 一个区块的成本」，不是任意小。 */
export const FRAME_BUDGET = { total: 9, gen: 3.6, light: 3.0, mesh: 3.4 };
/* 读档用的分片预算：一片可以多做几个区块，片与片之间让出主循环（见 game.js pumpWorldLoading）。
 * 单片实测上界约 48+10.5=59ms，加上渲染与让帧，帧间隔压在 100ms 内，玩家看到的是进度条而不是冻结。 */
export const LOAD_SLICE_BUDGET = { total: 48, gen: 16, light: 12, mesh: 22 };

export class VoxelWorld {
  constructor(seed, opts = {}) {
    this.seed = seed >>> 0;
    /* 生成版本：只有显式传 GEN_DEEP 才走新布局，其它（undefined / 脏值 / 旧档缺字段）一律旧布局。
       这样「旧档原样恢复」是结构性保证，不依赖调用方记得传参。 */
    this.genVersion = (opts.genVersion === GEN_DEEP_CHAMBERS) ? GEN_DEEP_CHAMBERS
      : (opts.genVersion === GEN_DEEP ? GEN_DEEP : GEN_LEGACY);
    /* 阶段 1 第 3 刀：布局由 genVersion 决定（显式 opts.layout 只用于测试覆盖）。
       旧档 / 缺字段 / 脏值 → GEN_LEGACY → 0..63，与改造前逐位相同；
       新档 → GEN_DEEP → -64..63 共 128 格。标签与布局同源，不可能出现半套。 */
    const L = opts.layout || layoutByGenVersion(this.genVersion);
    this.minY = Number.isFinite(L.minY) ? (L.minY | 0) : 0;
    this.layers = Number.isFinite(L.layers) && L.layers > 0 ? (L.layers | 0) : WORLD_H;
    this.topY = this.minY + this.layers;
    /* 地形生成读同一个 deep 标志：岩层、矿脉分带、深洞都只在新档里变，
       旧档走的还是改造前那一条路径（指纹常数钉着）。 */
    this.deep = this.genVersion === GEN_DEEP || this.genVersion === GEN_DEEP_CHAMBERS;
    this.terrain = new TerrainGen(this.seed, { deep: this.deep, genVersion: this.genVersion });
    this.chunks = new Map();
    this.dirtyLight = new Set();
    this.dirtyMesh = new Set();
    this.genQueue = [];
    this.pendingSavedEdits = new Map();   // chunkKey -> Map(index -> [id, meta])
    this.radius = opts.radius || 6;
    this.centerX = 0; this.centerZ = 0;
    this.hasCenter = false;
    this.listeners = {};
    this.furnaces = new Map();
    this.containers = new Map();   // "x,y,z" -> 27 格箱子内容
    this.stats = { generated: 0, meshed: 0, unloaded: 0 };
    // T2 观测量：最近一次 update 花了多少、各段做了几个区块、顺序如何；max* 是进程内的峰值。
    // 没有这组数就只能靠体感说「卡不卡」，验收也就无从下断言。
    this.perf = {
      calls: 0, lastCallMs: 0, maxCallMs: 0,
      genMs: 0, lightMs: 0, meshMs: 0,
      genChunks: 0, lightChunks: 0, meshChunks: 0,
      lastLightKeys: [], lastMeshKeys: [],
      maxGenChunkMs: 0, maxLightChunkMs: 0, maxMeshChunkMs: 0,
      /* 阶段 1 分段计时：整程累计（上面那组是「最近一帧」，每帧都被覆盖，看不出总账）。
         之所以要总账：已提交的 artifacts/e2e-report.json 在 2fdecbf / f40b73b / 3528ea9
         是同一个 git blob，「读数一样」不能证明各提交的独立实测，
         265s → 318s 的差值只能靠真实分段累计来归因。 */
      totals: { frameMs: 0, genMs: 0, lightMs: 0, meshMs: 0, calls: 0, genChunks: 0, lightChunks: 0, meshChunks: 0 }
    };
  }

  on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); }
  emit(evt, a, b) { const l = this.listeners[evt]; if (l) for (const f of l) f(a, b); }

  /* ---------- 查询 ---------- */
  getChunkAt(wx, wz, exact = false) {
    const cx = Math.floor(wx / CHUNK_SX), cz = Math.floor(wz / CHUNK_SZ);
    const c = this.chunks.get(coordKey(cx, cz));
    if (!c) return null;
    if (exact && c.state < 1) return null;
    return c;
  }

  getBlock(x, y, z) {
    if (y < this.minY) return B.BEDROCK;
    if (y >= this.topY) return AIR;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunks.get(coordKey(cx, cz));
    if (!c || c.state < 1) {
      // 未加载区块：用地形纯函数近似（只用于遮挡/碰撞判断）
      const h = this.terrain.heightAt(x, z);
      if (y > h) return h < SEA_LEVEL && y <= SEA_LEVEL ? B.WATER : AIR;
      if (y === h) return h <= SEA_LEVEL + 1 ? B.SAND : B.GRASS;
      return B.STONE;
    }
    return c.blocks[idx(x - cx * CHUNK_SX, y, z - cz * CHUNK_SZ, c.minY)];
  }

  getMeta(x, y, z) {
    if (y < this.minY || y >= this.topY) return 0;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunks.get(coordKey(cx, cz));
    if (!c || c.state < 1) return 0;
    return c.meta[idx(x - cx * CHUNK_SX, y, z - cz * CHUNK_SZ, c.minY)];
  }

  isSolidAt(x, y, z) {
    return isSolid(this.getBlock(x, y, z));
  }

  /** T6 门：在任意一半上调用，切换整扇门；返回 {open,x,y,z,meta} 或 null */
  toggleDoor(x, y, z) {
    let by = y;
    const id = this.getBlock(x, y, z);
    if (id === B.DOOR_TOP || id === B.DOOR_TOP_OPEN) by = y - 1;
    const bottomId = this.getBlock(x, by, z), topId = this.getBlock(x, by + 1, z);
    const isClosed = bottomId === B.DOOR_BOTTOM && topId === B.DOOR_TOP;
    const isOpen = bottomId === B.DOOR_BOTTOM_OPEN && topId === B.DOOR_TOP_OPEN;
    if (!isClosed && !isOpen) return null;
    const meta = this.getMeta(x, by, z);
    const open = !isOpen;
    const nextMeta = (meta & 3) | (open ? 4 : 0);
    this.setBlock(x, by, z, open ? B.DOOR_BOTTOM_OPEN : B.DOOR_BOTTOM, nextMeta);
    this.setBlock(x, by + 1, z, open ? B.DOOR_TOP_OPEN : B.DOOR_TOP, nextMeta);
    return { open, x, y: by, z, meta: nextMeta };
  }

  /* T1 耕地湿润判定：水平 ±3 格、纵向 ±1 格内有水即湿润（只读区块数据，可无头测试） */
  isFarmlandWet(x, y, z) {
    const R = FARMLAND_WET_RADIUS;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -R; dz <= R; dz++) {
        for (let dx = -R; dx <= R; dx++) {
          if (this.getBlock(x + dx, y + dy, z + dz) === B.WATER) return true;
        }
      }
    }
    return false;
  }

  surfaceHeight(x, z) { return this.terrain.heightAt(x, z); }
  get seaLevel() { return SEA_LEVEL; }

  /* 精确的地表（考虑已加载区块里的真实方块，供出生点/放置用）：跳过水与装饰植物 */
  topSolidY(x, z) {
    for (let y = this.topY - 1; y >= this.minY; y--) {
      const id = this.getBlock(x, y, z);
      if (id === AIR || id === B.WATER) continue;
      if (isPlant(id)) continue;
      return y;
    }
    return 0;
  }

  getLight(x, y, z) {
    if (y >= this.topY) return 0xf0;
    if (y < this.minY) return 0;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunks.get(coordKey(cx, cz));
    if (!c || c.state < 2) {
      const h = this.terrain.heightAt(x, z);
      return y > h ? 0xf0 : 0;
    }
    return c.light[idx(x - cx * CHUNK_SX, y, z - cz * CHUNK_SZ, c.minY)];
  }

  /* 亮度（0~1），考虑昼夜的天空光衰减 */
  brightnessAt(x, y, z, dayFactor = 1) {
    const l = this.getLight(x, y, z);
    const sky = (l >> 4) / 15 * dayFactor;
    const blk = (l & 15) / 15;
    const v = Math.max(sky, blk);
    return 0.05 + 0.95 * Math.pow(v, 1.15);
  }

  /* ---------- 修改 ---------- */
  setBlock(x, y, z, id, meta = 0, opts = {}) {
    if (y < this.minY || y >= this.topY) return false;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunks.get(coordKey(cx, cz));
    if (!c || c.state < 1) return false;
    const lx = x - cx * CHUNK_SX, lz = z - cz * CHUNK_SZ;
    const i = idx(lx, y, lz, c.minY);
    if (c.blocks[i] === id && c.meta[i] === meta) return false;
    c.blocks[i] = id;
    c.meta[i] = meta;
    if (opts.record !== false) c.recordEdit(i, id, meta);
    this.markDirty(cx, cz, lx, y, lz);
    return true;
  }

  markDirty(cx, cz, lx, y, lz) {
    const k = coordKey(cx, cz);
    this.dirtyLight.add(k);
    this.dirtyMesh.add(k);
    // 边界改动会影响邻居的剔除与光照
    if (lx === 0) this.touchNeighbor(cx - 1, cz);
    if (lx === CHUNK_SX - 1) this.touchNeighbor(cx + 1, cz);
    if (lz === 0) this.touchNeighbor(cx, cz - 1);
    if (lz === CHUNK_SZ - 1) this.touchNeighbor(cx, cz + 1);
    if (lx === 0 && lz === 0) this.touchNeighbor(cx - 1, cz - 1);
    if (lx === CHUNK_SX - 1 && lz === 0) this.touchNeighbor(cx + 1, cz - 1);
    if (lx === 0 && lz === CHUNK_SZ - 1) this.touchNeighbor(cx - 1, cz + 1);
    if (lx === CHUNK_SX - 1 && lz === CHUNK_SZ - 1) this.touchNeighbor(cx + 1, cz + 1);
  }

  touchNeighbor(cx, cz) {
    const k = coordKey(cx, cz);
    const c = this.chunks.get(k);
    if (!c) return;
    this.dirtyLight.add(k);
    this.dirtyMesh.add(k);
  }

  /* T2：三段队列各排了多少。读档完成的判据、e2e 的断言口径都用它。 */
  pending() {
    return { gen: this.genQueue.length, light: this.dirtyLight.size, mesh: this.dirtyMesh.size };
  }

  /* 把区块键按「离世界中心的距离」排序。队列规模最多几百，排序成本远低于一次网格重建。 */
  sortNearFirst(keys) {
    const out = [];
    for (const k of keys) {
      const [cx, cz] = k.split(',').map(Number);
      out.push({ k, cx, cz, d: (cx - this.centerX) ** 2 + (cz - this.centerZ) ** 2 });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  /* 立即重建某区块的光照与网格（挖掘/放置的即时反馈） */
  refreshImmediate(x, y, z, view) {
    const cx = x >> 4, cz = z >> 4;
    const k = coordKey(cx, cz);
    const c = this.chunks.get(k);
    if (c && c.state >= 1) {
      lightChunk(c, this);
      if (view) view.rebuildChunk(c);
    }
    this.dirtyMesh.delete(k);
    this.dirtyLight.delete(k);
  }

  /* ---------- 流式加载 ---------- */
  setCenter(wx, wz) {
    this.centerX = Math.floor(wx / CHUNK_SX);
    this.centerZ = Math.floor(wz / CHUNK_SZ);
    this.hasCenter = true;
    this.buildGenQueue();
  }

  setRadius(r) {
    if (r === this.radius) return;
    this.radius = r;
    if (this.hasCenter) this.buildGenQueue();
  }

  buildGenQueue() {
    const list = [];
    const r = this.radius;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > (r + 0.5) * (r + 0.5)) continue;
        const cx = this.centerX + dx, cz = this.centerZ + dz;
        const key = coordKey(cx, cz);
        const c = this.chunks.get(key);
        if (c && c.state >= 1) continue;
        list.push({ cx, cz, key, d: d2 });
      }
    }
    list.sort((a, b) => a.d - b.d);
    this.genQueue = list;
  }

  ensureChunk(cx, cz) {
    const key = coordKey(cx, cz);
    let c = this.chunks.get(key);
    if (c && c.state >= 1) return c;
    if (!c) { c = new Chunk(cx, cz, this.seed, this.minY, this.layers); this.chunks.set(key, c); }
    this.terrain.generate(c);
    // 应用存档中的改动
    const edits = this.pendingSavedEdits.get(key);
    if (edits) {
      for (const [i, v] of edits) { c.blocks[i] = v[0]; c.meta[i] = v[1]; c.edits.set(i, v); }
    }
    // 已存在但之前算过光的区块，光照需要重算
    c.dirtyLight = true;
    c.dirtyMesh = true;
    this.dirtyLight.add(key);
    this.dirtyMesh.add(key);
    this.stats.generated++;
    this.emit('chunkGenerated', c);
    return c;
  }

  /* 每帧调用：在分帧预算内生成 / 补光 / 重算 / 卸载（T2）。
     「至少推进一项」是刻意的：预算的语义是尽量不超时，不是超时就不干活，
     否则机器一慢就每帧零进展、读档永远完不成（单测 F5 钉住这条）。 */
  update(dt, budgetMs, view) {
    const b = budgetMs || FRAME_BUDGET;
    const t0 = performance.now();
    const p = this.perf;
    p.calls++;
    p.genMs = p.lightMs = p.meshMs = 0;
    p.genChunks = p.lightChunks = p.meshChunks = 0;
    p.lastLightKeys = [];
    p.lastMeshKeys = [];
    const hardEnd = t0 + b.total;

    // 1) 生成区块（genQueue 建好时就按距离排过，近的在前）
    let end = Math.min(hardEnd, t0 + b.gen);
    while (this.genQueue.length) {
      const job = this.genQueue.shift();
      const s0 = performance.now();
      const c = this.ensureChunk(job.cx, job.cz);
      const cost = performance.now() - s0;
      p.genMs += cost; p.genChunks++;
      if (cost > p.maxGenChunkMs) p.maxGenChunkMs = cost;
      this.dirtyLight.add(coordKey(c.cx, c.cz));
      if (performance.now() >= end) break;
    }

    // 2) 光照：近处优先。旧写法按 Set 的插入顺序处理，玩家脚下那块可能排在远处后面
    end = Math.min(hardEnd, performance.now() + b.light);
    for (const it of this.sortNearFirst(this.dirtyLight)) {
      if (p.lightChunks >= 1 && performance.now() >= end) break;
      if (!this.dirtyLight.has(it.k)) continue;
      this.dirtyLight.delete(it.k);
      const c = this.chunks.get(it.k);
      if (!c || c.state < 1) continue;
      const s0 = performance.now();
      lightChunk(c, this);
      const cost = performance.now() - s0;
      p.lightMs += cost; p.lightChunks++;
      if (cost > p.maxLightChunkMs) p.maxLightChunkMs = cost;
      p.lastLightKeys.push(it.k);
      this.dirtyMesh.add(it.k);            // 光照变了，网格要跟着重算
    }

    // 3) 网格：同样近处优先；还没打过光的区块退回光照阶段，下一帧再来
    end = Math.min(hardEnd, performance.now() + b.mesh);
    for (const it of this.sortNearFirst(this.dirtyMesh)) {
      if (p.meshChunks >= 1 && performance.now() >= end) break;
      if (!this.dirtyMesh.has(it.k)) continue;
      this.dirtyMesh.delete(it.k);
      const c = this.chunks.get(it.k);
      if (!c || c.state < 2) { if (c) this.dirtyLight.add(it.k); continue; }
      const s0 = performance.now();
      if (view) view.rebuildChunk(c);
      c.dirtyMesh = false;
      const cost = performance.now() - s0;
      p.meshMs += cost; p.meshChunks++;
      if (cost > p.maxMeshChunkMs) p.maxMeshChunkMs = cost;
      p.lastMeshKeys.push(it.k);
      this.stats.meshed++;
    }

    p.lastCallMs = performance.now() - t0;
    if (p.lastCallMs > p.maxCallMs) p.maxCallMs = p.lastCallMs;
    /* 整程累计（阶段 1 分段计时）：p 里那组是「最近一帧」，下一帧就被清零重算，
       所以总账必须在这里加一次，否则只能看到峰值、看不到「320 秒花在哪一段」。 */
    const tt = p.totals;
    tt.frameMs += p.lastCallMs; tt.genMs += p.genMs; tt.lightMs += p.lightMs; tt.meshMs += p.meshMs;
    tt.calls++; tt.genChunks += p.genChunks; tt.lightChunks += p.lightChunks; tt.meshChunks += p.meshChunks;
    // 4) 卸载远处区块
    this.unloadFar(view);
  }

  unloadFar(view) {
    const keep = this.radius + 2;
    for (const [k, c] of this.chunks) {
      const dx = c.cx - this.centerX, dz = c.cz - this.centerZ;
      if (dx * dx + dz * dz > keep * keep) {
        /* 卸载前把改动转进 pendingSavedEdits：否则玩家/村庄在远处建的方块会在
           下次 save 时凭空消失（只存在于已卸载 chunk 的内存里）。 */
        const e = c.serializeEdits();
        if (e) {
          let map = this.pendingSavedEdits.get(k);
          if (!map) { map = new Map(); this.pendingSavedEdits.set(k, map); }
          for (let i = 0; i + 2 < e.length; i += 3) map.set(e[i], [e[i + 1], e[i + 2]]);
        }
        if (view) view.removeChunk(c);
        this.chunks.delete(k);
        this.dirtyMesh.delete(k);
        this.dirtyLight.delete(k);
        this.stats.unloaded++;
      }
    }
  }

  /* ---------- 射线检测（Amanatides & Woo DDA） ---------- */
  raycast(ox, oy, oz, dx, dy, dz, maxDist = 6, filter = null) {
    const len = Math.hypot(dx, dy, dz);
    if (!len) return null;
    dx /= len; dy /= len; dz /= len;
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / dx), tDeltaY = Math.abs(1 / dy), tDeltaZ = Math.abs(1 / dz);
    const borderX = stepX > 0 ? x + 1 - ox : ox - x;
    const borderY = stepY > 0 ? y + 1 - oy : oy - y;
    const borderZ = stepZ > 0 ? z + 1 - oz : oz - z;
    let tMaxX = tDeltaX * borderX, tMaxY = tDeltaY * borderY, tMaxZ = tDeltaZ * borderZ;
    let face = null, t = 0;
    for (let guard = 0; guard < 256; guard++) {
      const id = this.getBlock(x, y, z);
      if (id !== AIR && id !== B.WATER && (!filter || filter(id, x, y, z))) {
        return { x, y, z, id, face, dist: t };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        t = tMaxX; x += stepX; tMaxX += tDeltaX; face = [-stepX, 0, 0];
      } else if (tMaxY < tMaxZ) {
        t = tMaxY; y += stepY; tMaxY += tDeltaY; face = [0, -stepY, 0];
      } else {
        t = tMaxZ; z += stepZ; tMaxZ += tDeltaZ; face = [0, 0, -stepZ];
      }
      if (t > maxDist) return null;
    }
    return null;
  }

  /* 放置位置：命中面的相邻格 */
  placementTarget(hit) {
    if (!hit || !hit.face) return null;
    return { x: hit.x + hit.face[0], y: hit.y + hit.face[1], z: hit.z + hit.face[2] };
  }

  canPlaceAt(x, y, z, blockId) {
    const cur = this.getBlock(x, y, z);
    if (!isReplaceable(cur)) return false;
    const b = BLOCKS[blockId];
    if (!b) return false;
    if (b.solid) {
      // 不能把方块放进玩家身体里
      if (!this.isSolidAt(x, y, z)) {
        // 需要相邻支撑（防止空中浮空方块）
        const supported = this.isSolidAt(x + 1, y, z) || this.isSolidAt(x - 1, y, z) ||
          this.isSolidAt(x, y - 1, z) || this.isSolidAt(x, y + 1, z) ||
          this.isSolidAt(x, y, z + 1) || this.isSolidAt(x, y, z - 1);
        if (!supported) return false;
      }
    }
    return true;
  }

  /* ---------- 存档 ---------- */
  serializeEdits() {
    const out = {};
    for (const [k, c] of this.chunks) {
      const e = c.serializeEdits();
      if (e) out[k] = e;
    }
    // 加上尚未加载的存档改动（保持不丢失）
    for (const [k, map] of this.pendingSavedEdits) {
      if (out[k]) continue;
      const flat = [];
      for (const [i, v] of map) flat.push(i, v[0], v[1]);
      if (flat.length) out[k] = flat;
    }
    return out;
  }

  applySavedData(chunksObj) {
    this.pendingSavedEdits.clear();
    if (!chunksObj) return;
    for (const k of Object.keys(chunksObj)) {
      const flat = chunksObj[k];
      const map = new Map();
      for (let i = 0; i + 2 < flat.length; i += 3) map.set(flat[i], [flat[i + 1], flat[i + 2]]);
      this.pendingSavedEdits.set(k, map);
      const c = this.chunks.get(k);
      if (c && c.state >= 1) {
        for (const [i, v] of map) { c.blocks[i] = v[0]; c.meta[i] = v[1]; c.edits.set(i, v); }
        this.dirtyLight.add(k);
        this.dirtyMesh.add(k);
      }
    }
  }

  /* 熔炉等方块实体 */
  getFurnace(x, y, z) {
    const k = x + ',' + y + ',' + z;
    let f = this.furnaces.get(k);
    if (!f) {
      f = this.furnaceFactory
        ? this.furnaceFactory({ x, y, z })
        : { x, y, z, input: null, fuel: null, output: null, burnTime: 0, burnTotal: 0, progress: 0, lit: false, tick() { return {}; } };
      this.furnaces.set(k, f);
    }
    return f;
  }

  /* ---------- 箱子容器 ---------- */
  getContainer(x, y, z) {
    const k = x + ',' + y + ',' + z;
    let c = this.containers.get(k);
    if (!c) { c = new Array(27).fill(null); this.containers.set(k, c); }
    return c;
  }

  hasContainer(x, y, z) { return this.containers.has(x + ',' + y + ',' + z); }

  removeContainer(x, y, z) {
    const k = x + ',' + y + ',' + z;
    const c = this.containers.get(k);
    this.containers.delete(k);
    return c || null;
  }

  serializeContainers() {
    const out = {};
    for (const [k, slots] of this.containers) {
      if (!slots.some(s => s)) continue;
      out[k] = slots.map(s => s ? { i: s.item, c: s.count } : null);
    }
    return out;
  }

  applyContainers(obj) {
    this.containers.clear();
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      const slots = new Array(27).fill(null);
      const src = obj[k] || [];
      for (let i = 0; i < 27 && i < src.length; i++) {
        const s = src[i];
        if (s && s.i && s.c > 0) slots[i] = { item: s.i, count: s.c | 0 };
      }
      this.containers.set(k, slots);
    }
  }
  serializeFurnaces() {
    const out = {};
    for (const [k, f] of this.furnaces) {
      if (!f.input && !f.fuel && !f.output) continue;
      out[k] = { input: f.input, fuel: f.fuel, output: f.output, progress: f.progress, burnTime: f.burnTime, burnTotal: f.burnTotal };
    }
    return out;
  }
  applyFurnaces(obj) {
    this.furnaces.clear();
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      const [x, y, z] = k.split(',').map(Number);
      const f = this.getFurnace(x, y, z);
      Object.assign(f, obj[k]);
    }
  }

  dispose(view) {
    for (const [, c] of this.chunks) if (view) view.removeChunk(c);
    this.chunks.clear();
    this.dirtyMesh.clear();
    this.dirtyLight.clear();
    this.genQueue.length = 0;
  }
}
