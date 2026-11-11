'use strict';
/*
 * 区块光照：天空光（自上而下 + 水平扩散）与方块光（火把/荧石/熔炉的 BFS 衰减）。
 * 邻区块的光只在「已点亮且不欠算」时可信；否则按**方块数据**近似其边界光照
 * （方块数据永远是最新的，光数组不一定是）。注意 world.update 补光后不会再把邻居
 * 重新标脏，所以近似只能取保守值 —— 宁可少一级光，也不许把露天时的旧值搬进墙里。
 */
import { AIR, B, BLOCKS, lightEmission } from '../core/blocks.js';
import { CHUNK_SX, CHUNK_SZ, WORLD_H, idx, coordKey } from './chunk.js';

/* 0=完全透光 1=衰减（水/树叶/玻璃） 2=阻挡 */
function opacityOf(id) {
  if (id === AIR) return 0;
  const b = BLOCKS[id];
  if (!b) return 0;
  if (b.cross) return 0;
  if (id === B.WATER || id === B.GLASS || id === B.LEAVES || id === B.BIRCH_LEAVES) return 1;
  return b.opaque ? 2 : 0;
}

/* 光照扩散队列：环形缓冲 + 自动扩容，保证不会丢扩散步骤 */
class Queue {
  constructor(cap) { this.a = new Int32Array(cap); this.head = 0; this.tail = 0; this.count = 0; }
  clear() { this.head = this.tail = this.count = 0; }
  get empty() { return this.count === 0; }
  push(v) {
    if (this.count === this.a.length) this._grow();
    this.a[this.tail] = v;
    this.tail = (this.tail + 1) % this.a.length;
    this.count++;
  }
  shift() {
    const v = this.a[this.head];
    this.head = (this.head + 1) % this.a.length;
    this.count--;
    return v;
  }
  _grow() {
    const n = new Int32Array(this.a.length * 2);
    for (let i = 0; i < this.count; i++) n[i] = this.a[(this.head + i) % this.a.length];
    this.a = n; this.head = 0; this.tail = this.count;
  }
}

const qSky = new Queue(CHUNK_SX * CHUNK_SZ * WORLD_H * 2);
const qBlock = new Queue(CHUNK_SX * CHUNK_SZ * WORLD_H * 2);

const NX = [1, -1, 0, 0, 0, 0];
const NY = [0, 0, 1, -1, 0, 0];
const NZ = [0, 0, 0, 0, 1, -1];

/**
 * 计算一个区块的光照。
 * @param chunk 目标区块
 * @param world 世界（提供 getBlock / getLightAt 跨区块查询、terrain 高度）
 */
/* 索引两套口径，混用就会串层：
   - chunkI(chunk, lx, 世界y, lz)：给「拿着世界坐标」的地方用（垂直扫描、自发光、接缝）。
   - layI(lx, 层号, lz)：BFS 专用。BFS 从下标反推出来的就是层号，
     只在层号空间里加减越界判断，不需要也不应该碰 minY。 */
function chunkI(chunk, lx, wy, lz) { return idx(lx, wy, lz, chunk.minY); }
function layI(lx, ly, lz) { return idx(lx, ly, lz, 0); }

export function lightChunk(chunk, world) {
  const light = chunk.light;
  light.fill(0);
  qSky.clear(); qBlock.clear();

  const x0 = chunk.cx * CHUNK_SX, z0 = chunk.cz * CHUNK_SZ;
  const yTop = chunk.topY, yBot = chunk.minY;

  /* ---- 1. 天空光：垂直下落 ---- */
  for (let lz = 0; lz < CHUNK_SZ; lz++) {
    for (let lx = 0; lx < CHUNK_SX; lx++) {
      let lvl = 15;
      for (let y = yTop - 1; y >= yBot; y--) {
        const id = chunk.blocks[chunkI(chunk, lx, y, lz)];
        const op = opacityOf(id);
        if (op === 2) { lvl = 0; }
        else if (op === 1) { lvl = Math.max(0, lvl - 1); }
        if (lvl === 0 && op === 2) {
          // 以下全部为 0，直接跳出（前提是下方没有自发光源，光块仍会被 BFS 填充）
          light[chunkI(chunk, lx, y, lz)] = 0;
          // 但下面可能还有洞穴需要 blocklight，垂直天空光一定为 0，跳出循环
          break;
        }
        light[chunkI(chunk, lx, y, lz)] = lvl << 4;
        if (lvl > 1) qSky.push(chunkI(chunk, lx, y, lz));
      }
    }
  }

  /* ---- 2. 邻居边界种子（已加载用真实光照，未加载用地形高度近似） ---- */
  seedBorders(chunk, world, x0, z0);

  /* ---- 3. 自发光方块 ---- */
  for (let y = yBot; y < yTop; y++) {
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const i = chunkI(chunk, lx, y, lz);
        const e = lightEmission(chunk.blocks[i]);
        if (e > 0) {
          light[i] = (light[i] & 0xf0) | e;
          qBlock.push(i);
        }
      }
    }
  }

  /* ---- 4. BFS 扩散 ---- */
  bfs(chunk, qSky, true);
  bfs(chunk, qBlock, false);

  chunk.dirtyLight = false;
  chunk.state = 2; // LIT
}

function bfs(chunk, q, isSky) {
  const light = chunk.light;
  const blocks = chunk.blocks;
  const nLayers = chunk.layers;
  while (!q.empty) {
    const i = q.shift();
    // 还原坐标：i = lx + lz*16 + 层号*256。这里的 y 是**层号**，不是世界 y（别加 minY 出去用）
    const y = Math.floor(i / (CHUNK_SX * CHUNK_SZ));
    const rem = i - y * CHUNK_SX * CHUNK_SZ;
    const lz = Math.floor(rem / CHUNK_SX);
    const lx = rem - lz * CHUNK_SX;
    const cur = isSky ? (light[i] >> 4) : (light[i] & 15);
    if (cur <= 1) continue;
    for (let d = 0; d < 6; d++) {
      const nx = lx + NX[d], ny = y + NY[d], nz = lz + NZ[d];
      if (nx < 0 || nx >= CHUNK_SX || nz < 0 || nz >= CHUNK_SZ || ny < 0 || ny >= nLayers) continue;
      const ni = layI(nx, ny, nz);
      const op = opacityOf(blocks[ni]);
      if (op === 2) continue;
      // 天空光垂直向下不衰减
      let cost = 1 + (op === 1 ? 1 : 0);
      if (isSky && d === 3 && op === 0) cost = 0;
      const val = cur - cost;
      if (val <= 0) continue;
      if (isSky) {
        if ((light[ni] >> 4) >= val) continue;
        light[ni] = (val << 4) | (light[ni] & 15);
      } else {
        if ((light[ni] & 15) >= val) continue;
        light[ni] = (light[ni] & 0xf0) | val;
      }
      if (val > 1) q.push(ni);
    }
  }
}

/* 本区块这一列从上往下第一个「不透明」方块的 y；整列透光返回 chunk.minY-1（布局下界再往下一格）。
   用来判断接缝格到底露不露天天 —— 近似天空光绝不能灌进被实心包住的格子。 */
function columnTopOpaque(chunk, lx, lz) {
  for (let y = chunk.topY - 1; y >= chunk.minY; y--) {
    if (opacityOf(chunk.blocks[chunkI(chunk, lx, y, lz)]) === 2) return y;
  }
  return chunk.minY - 1;   // 整列透光：任何 y 都「高于」它 → 按露天处理（旧布局下就是 -1）
}

/* 接缝四条边：本块的格子 (lx,lz) 与邻块对应格子 (nlx,nlz) 的下标换算 */
function seamIndex(side, k) {
  const lx = side === 0 ? CHUNK_SX - 1 : side === 1 ? 0 : k;
  const lz = side === 2 ? CHUNK_SZ - 1 : side === 3 ? 0 : k;
  const nlx = side === 0 ? 0 : side === 1 ? CHUNK_SX - 1 : k;
  const nlz = side === 2 ? 0 : side === 3 ? CHUNK_SZ - 1 : k;
  return [lx, lz, nlx, nlz];
}

/* 邻居是否还欠一次补光：world.markDirty / touchNeighbor 只会往 dirtyLight 集合里加键，
   并不会改区块对象上的 dirtyLight 标记，所以判断「邻居的光数组是不是旧的」只能看这个集合。 */
function nbIsPending(world, nb) {
  if (!nb || nb.state < 2) return true;
  if (nb.dirtyLight) return true;
  const set = world && world.dirtyLight;
  return !!(set && set.has(coordKey(nb.cx, nb.cz)));
}

/* 从四个邻居取边界光照。邻居「已点亮且当前不欠算」才用它的真实值；
   否则用方块数据近似（方块数据永远是最新的，光数组不一定）。 */
function seedBorders(chunk, world, x0, z0) {
  const light = chunk.light;
  const push = (lx, y, lz, sky, block) => {
    const i = chunkI(chunk, lx, y, lz);
    /* 实心格里不许存光：以前把邻居值/近似值直接写进接缝的石头格，BFS 再从这格往空气扩散，
       等于让光「穿墙」。 */
    if (opacityOf(chunk.blocks[i]) === 2) return;
    const curSky = light[i] >> 4, curBlock = light[i] & 15;
    if (sky > curSky) light[i] = (sky << 4) | (light[i] & 15);
    if (block > curBlock) light[i] = (light[i] & 0xf0) | block;
    if (sky > 1 && sky > curSky) qSky.push(i);
    if (block > 1 && block > curBlock) qBlock.push(i);
  };

  for (let side = 0; side < 4; side++) {
    const nb = world.getChunkAt(
      x0 + (side === 0 ? CHUNK_SX : side === 1 ? -CHUNK_SX : 0),
      z0 + (side === 2 ? CHUNK_SZ : side === 3 ? -CHUNK_SZ : 0), true);
    /* 「算过光」不等于「光是对的」：建造/挖掘会让本块和邻块同时变脏，
       先算的那一块如果直接搬邻块的旧光数组，就把「这一带还是露天时的天空光 15」
       搬进了新砌的墙里面。实测：外壳 17×11×17 全实心、内部凿 9×4×9 的封闭石室，
       室内 sky 仍是 12~14 —— 而且算完之后没人再重算，错值就一直留着。
       旧写法还用 world.surfaceHeight()（纯噪声高度）近似「y 高于地表就是 15」，
       只要房间建得比纯函数地表高（玩家在地表盖房、抬高的洞穴室），整间屋子被灌满阳光。
       现在：邻居不可信 → 看**邻居那一列**的第一个不透明格；邻居根本不存在 → 看本区块自己的列。 */
    const trusted = nb && !nbIsPending(world, nb);
    const tops = [];
    if (!trusted) for (let k = 0; k < CHUNK_SX; k++) {
      const [lx, lz, nlx, nlz] = seamIndex(side, k);
      tops[k] = nb ? columnTopOpaque(nb, nlx, nlz) : columnTopOpaque(chunk, lx, lz);
    }
    for (let k = 0; k < CHUNK_SX; k++) {
      const [lx, lz, nlx, nlz] = seamIndex(side, k);
      for (let y = chunk.minY; y < chunk.topY; y++) {
        if (trusted) {
          const lv = nb.lightAt(nlx, y, nlz);
          /* 邻居那一格的光不许原样搬进我这格：光跨一格要衰减 1。
             原样搬的后果是接缝列比实际亮一级 —— 火把贴着接缝时，隔壁区块整片光池
             被整体抬高 1 级，区块边界上出现一个「台阶」，光池梯度也被压平。 */
          const ns = (lv >> 4) - 1, nbl = (lv & 15) - 1;
          push(lx, y, lz, ns > 0 ? ns : 0, nbl > 0 ? nbl : 0);
        } else {
          /* 露天才把邻格近似成 15（跨过来记 14）；被屋顶盖住的格子一律 0。
             方块光借邻居的旧值：最多偏高一级，而且只在邻格不是实心的时候借，
             这样贴着接缝的火把仍能把光递到隔壁区块。 */
          let blk = 0;
          /* 邻居用自己的 minY 索引；世界 y 落在邻居布局之外就不借（混合布局时不能越界读） */
          if (nb && y >= nb.minY && y < nb.topY) {
            const ni = idx(nlx, y, nlz, nb.minY);
            if (opacityOf(nb.blocks[ni]) !== 2) blk = (nb.light[ni] & 15) - 1;
          }
          push(lx, y, lz, y > tops[k] ? 14 : 0, blk > 0 ? blk : 0);
        }
      }
    }
  }
}

/* 供网格化取用：把 0~15 光照转成亮度系数 */
export function lightToBrightness(sky, block, dayFactor) {
  const s = (sky / 15) * dayFactor;
  const b = block / 15;
  const v = Math.max(s, b);
  // 提升暗部，避免全黑（体素游戏里纯黑看不出形状）
  return 0.06 + 0.94 * Math.pow(v, 1.25);
}
