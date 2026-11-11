'use strict';
/*
 * 区块网格化：只生成暴露面；顶点色承载「平滑光照 + 环境光遮蔽 + 面朝向明暗」。
 * 输出三组几何数据：不透明、镂空（树叶/玻璃/火把/小麦）、水（独立平铺贴图，可动画）。
 */
import { AIR, B, BLOCKS, tileForFace, cullsSame, blockBoxes } from '../core/blocks.js';
import { CHUNK_SX, CHUNK_SZ, WORLD_H, idx } from './chunk.js';
import { tileUVCached } from '../gfx/atlas.js';

/* 面表（0fps 体素网格化标准表）：dir + 4 角（pos 顶点位置，uv 贴图坐标） */
export const FACES = [
  { name: 'negx', dir: [-1, 0, 0], corners: [
      { pos: [0, 1, 0], uv: [0, 1] }, { pos: [0, 0, 0], uv: [0, 0] },
      { pos: [0, 1, 1], uv: [1, 1] }, { pos: [0, 0, 1], uv: [1, 0] }] },
  { name: 'posx', dir: [1, 0, 0], corners: [
      { pos: [1, 1, 1], uv: [0, 1] }, { pos: [1, 0, 1], uv: [0, 0] },
      { pos: [1, 1, 0], uv: [1, 1] }, { pos: [1, 0, 0], uv: [1, 0] }] },
  { name: 'bottom', dir: [0, -1, 0], corners: [
      { pos: [1, 0, 1], uv: [1, 0] }, { pos: [0, 0, 1], uv: [0, 0] },
      { pos: [1, 0, 0], uv: [1, 1] }, { pos: [0, 0, 0], uv: [0, 0] }] },
  { name: 'top', dir: [0, 1, 0], corners: [
      { pos: [0, 1, 1], uv: [1, 1] }, { pos: [1, 1, 1], uv: [0, 1] },
      { pos: [0, 1, 0], uv: [1, 0] }, { pos: [1, 1, 0], uv: [0, 0] }] },
  { name: 'negz', dir: [0, 0, -1], corners: [
      { pos: [1, 0, 0], uv: [0, 0] }, { pos: [0, 0, 0], uv: [1, 0] },
      { pos: [1, 1, 0], uv: [0, 1] }, { pos: [0, 1, 0], uv: [1, 1] }] },
  { name: 'posz', dir: [0, 0, 1], corners: [
      { pos: [0, 0, 1], uv: [0, 0] }, { pos: [1, 0, 1], uv: [1, 0] },
      { pos: [0, 1, 1], uv: [0, 1] }, { pos: [1, 1, 1], uv: [1, 1] }] }
];

const AO_LEVELS = [0.46, 0.66, 0.85, 1.0];
const FACE_SHADE = { top: 1.0, bottom: 0.6, posx: 0.84, negx: 0.84, posz: 0.72, negz: 0.72 };
const CHUNK_AREA_LOCAL = CHUNK_SX * CHUNK_SZ;

class Builder {
  constructor() { this.reset(); }
  reset() { this.pos = []; this.norm = []; this.uv = []; this.col = []; this.ind = []; }
  get count() { return this.pos.length / 3; }
  quad(corners, uvRect, nx, ny, nz) {
    const base = this.count;
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      this.pos.push(c.px, c.py, c.pz);
      this.norm.push(nx, ny, nz);
      this.uv.push(uvRect[0] + c.u * (uvRect[2] - uvRect[0]),
                   uvRect[1] + c.v * (uvRect[3] - uvRect[1]));
      this.col.push(c.color[0], c.color[1], c.color[2]);
    }
    this.ind.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
}

function finish(b) {
  if (!b.count) return null;
  return {
    position: new Float32Array(b.pos),
    normal: new Float32Array(b.norm),
    uv: new Float32Array(b.uv),
    color: new Float32Array(b.col),
    index: new Uint32Array(b.ind)
  };
}

/* ---------- 采样器：本区块 -> 邻居区块 -> 地形纯函数近似 ---------- */
export function makeSampler(chunk, world) {
  const x0 = chunk.cx * CHUNK_SX, z0 = chunk.cz * CHUNK_SZ;
  const nb = new Array(9);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const c = world.getChunkAt(x0 + dx * CHUNK_SX, z0 + dz * CHUNK_SZ, true);
      nb[(dz + 1) * 3 + (dx + 1)] = (c && c.state >= 2) ? c : null;
    }
  }
  /* 布局字段：默认 0..WORLD_H（旧布局），与改造前逐位一致。
     用 Number.isFinite 回落是为了「拿不到布局字段的老 mock 也不会把 y 判断成 NaN」。
     下一刀启用负 Y 布局后，采样才不会把 -1 当成基岩、把 70 当成空气。 */
  const W_MIN = Number.isFinite(world.minY) ? world.minY : 0;
  const W_TOP = Number.isFinite(world.topY) ? world.topY : WORLD_H;
  function locate(wx, wz) {
    const dx = ((wx - x0) >> 4) + 1, dz = ((wz - z0) >> 4) + 1;
    if (dx < 0 || dx > 2 || dz < 0 || dz > 2) return null;
    const c = nb[dz * 3 + dx];
    if (!c) return null;
    const minY = Number.isFinite(c.minY) ? c.minY : 0;
    const topY = Number.isFinite(c.topY) ? c.topY : WORLD_H;
    return { c, lx: wx - c.cx * CHUNK_SX, lz: wz - c.cz * CHUNK_SZ, minY, topY };
  }
  function getBlock(wx, wy, wz) {
    const l = locate(wx, wz);
    if (l) {
      if (wy < l.minY) return B.BEDROCK;
      if (wy >= l.topY) return AIR;
      return l.c.blocks[idx(l.lx, wy, l.lz, l.minY)];
    }
    if (wy < W_MIN) return B.BEDROCK;
    if (wy >= W_TOP) return AIR;
    const h = world.surfaceHeight(wx, wz);
    if (wy > h) return AIR;
    if (wy === h) {
      // 地表方块近似：用水下/高度判断给一个合理值，仅用于遮挡判断，精度要求低
      return h <= world.seaLevel ? B.SAND : B.GRASS;
    }
    return B.STONE;
  }
  function getLight(wx, wy, wz) {
    const l = locate(wx, wz);
    if (l) {
      if (wy >= l.topY) return 0xf0;
      if (wy < l.minY) return 0;
      return l.c.light[idx(l.lx, wy, l.lz, l.minY)];
    }
    if (wy >= W_TOP) return 0xf0;
    if (wy < W_MIN) return 0;
    const h = world.surfaceHeight(wx, wz);
    return wy > h ? 0xf0 : 0;
  }
  return { getBlock, getLight, nb };
}

/* ---------- 主入口 ---------- */
export function buildChunkGeometry(chunk, world) {
  const s = makeSampler(chunk, world);
  const opaque = new Builder();
  const cutout = new Builder();
  const water = new Builder();
  /* 每列的水面高度缓存（深度着色用，见 buildWater） */
  const waterTopCache = new Map();

  const x0 = chunk.cx * CHUNK_SX, z0 = chunk.cz * CHUNK_SZ;
  const blocks = chunk.blocks, metaArr = chunk.meta;
  /* 扫描范围 = 这一块自己的布局；行偏移必须换算成「层号」，
     否则负 Y 布局会把第 0 层当成世界 y=0（旧布局两者相同，所以行为不变）。 */
  const yBot = Number.isFinite(chunk.minY) ? chunk.minY : 0;
  const yTop = Number.isFinite(chunk.topY) ? chunk.topY : WORLD_H;

  for (let y = yBot; y < yTop; y++) {
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      const rowBase = lz * CHUNK_SX + (y - yBot) * CHUNK_AREA_LOCAL;
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const i = rowBase + lx;
        const id = blocks[i];
        if (id === AIR) continue;
        const b = BLOCKS[id];
        const m = metaArr[i];
        const wx = x0 + lx, wz = z0 + lz;

        if (b.cross) { buildCross(b.id, m, s, cutout, wx, y, wz); continue; }
        if (id === B.WATER) {
          /* 这一列的水面高度：往上数连续的水。用于「越深越暗」的深度着色。 */
          const key = wx + ',' + wz;
          let sy = waterTopCache.get(key);
          if (sy === undefined) {
            sy = y;
            while (s.getBlock(wx, sy + 1, wz) === B.WATER) sy++;
            waterTopCache.set(key, sy);
          }
          buildWater(s, water, wx, y, wz, sy);
          continue;
        }

        const isCutout = !b.opaque;
        const target = isCutout ? cutout : opaque;

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const d = face.dir;
          const nid = s.getBlock(wx + d[0], y + d[1], wz + d[2]);
          if (nid !== AIR) {
            if (nid === id && cullsSame(id)) continue;
            const nbl = BLOCKS[nid];
            if (nbl && nbl.opaque) continue;
            if (isCutout && nid === id) continue;
            if (id === B.GLASS && nid === B.WATER) continue;
          }
          const uvRect = tileUVCached(tileForFace(id, m, face.name));
          emitFace(target, s, face, wx, y, wz, uvRect);
        }
      }
    }
  }

  const cut = finish(cutout), wat = finish(water);
  return {
    opaque: finish(opaque),
    cutout: cut ? Object.assign(cut, { doubleSide: true }) : null,
    water: wat ? Object.assign(wat, { doubleSide: true }) : null
  };
}

/* 把一个局部盒的 6 个面推进 target。
   顶点位置按 box 缩放/平移；UV 沿用整张 tile（半砖/楼梯看起来仍是同一块材质）。 */
function emitBox(target, wx, wy, wz, box, uvRect, light) {
  const [bx0, by0, bz0, bx1, by1, bz1] = box;
  const shade = 1;
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const corners = face.corners.map(cc => {
      const p = cc.pos;
      const px = wx + (p[0] ? bx1 : bx0);
      const py = wy + (p[1] ? by1 : by0);
      const pz = wz + (p[2] ? bz1 : bz0);
      const c = light * FACE_SHADE[face.name] * shade;
      return { px, py, pz, u: cc.uv[0], v: cc.uv[1], color: [c * 0.95, c * 0.95, c * 1.0] };
    });
    target.quad(corners, uvRect, face.dir[0], face.dir[1], face.dir[2]);
  }
}

/* 面顶点：光照取相邻空气格 2x2 平均（平滑光照）+ 经典 AO */
function emitFace(target, s, face, wx, wy, wz, uvRect) {
  const d = face.dir;
  const ax = wx + d[0], ay = wy + d[1], az = wz + d[2];
  const axes = [0, 1, 2].filter(a => d[a] === 0);
  const tA = axes[0], tB = axes[1];
  const shade = FACE_SHADE[face.name];
  const base = s.getLight(ax, ay, az);
  const baseSky = base >> 4, baseBlk = base & 15;

  const corners = [];
  for (let ci = 0; ci < 4; ci++) {
    const c = face.corners[ci];
    const p = c.pos;
    const offA = p[tA] ? 1 : -1;
    const offB = p[tB] ? 1 : -1;
    const pa = [0, 0, 0]; pa[tA] = offA;
    const pb = [0, 0, 0]; pb[tB] = offB;

    const n1 = [ax + pa[0], ay + pa[1], az + pa[2]];
    const n2 = [ax + pb[0], ay + pb[1], az + pb[2]];
    const n3 = [ax + pa[0] + pb[0], ay + pa[1] + pb[1], az + pa[2] + pb[2]];

    const o1 = isOpaqueAt(s, n1), o2 = isOpaqueAt(s, n2), o3 = isOpaqueAt(s, n3);
    const L1 = o1 ? [baseSky, baseBlk] : lightPair(s, n1);
    const L2 = o2 ? [baseSky, baseBlk] : lightPair(s, n2);
    const L3 = o3 ? [baseSky, baseBlk] : lightPair(s, n3);
    const sky = (baseSky + L1[0] + L2[0] + L3[0]) / 4;
    const blk = (baseBlk + L1[1] + L2[1] + L3[1]) / 4;

    let ao = 3;
    if (o1 && o2) ao = 0; else ao = 3 - ((o1 ? 1 : 0) + (o2 ? 1 : 0) + (o3 ? 1 : 0));

    corners.push({
      px: wx + p[0], py: wy + p[1], pz: wz + p[2], u: c.uv[0], v: c.uv[1],
      color: [sky / 15, blk / 15, AO_LEVELS[ao] * shade]
    });
  }
  target.quad(corners, uvRect, d[0], d[1], d[2]);
}

function lightPair(s, p) {
  const l = s.getLight(p[0], p[1], p[2]);
  return [l >> 4, l & 15];
}
function isOpaqueAt(s, p) {
  const id = s.getBlock(p[0], p[1], p[2]);
  const b = BLOCKS[id];
  return !!(b && b.opaque);
}

/* 十字面片 */
function buildCross(id, m, s, target, wx, wy, wz) {
  const b = BLOCKS[id];
  const uvRect = tileUVCached(tileForFace(id, m, 'top'));
  const l = s.getLight(wx, wy, wz + 0);
  const own = s.getLight(wx, wy + 1, wz);
  const sky = Math.max(l >> 4, own >> 4), blk = Math.max(l & 15, own & 15);
  const lv = Math.max(sky / 15, (blk / 15) * 1.05);
  const v = 0.08 + 0.92 * Math.pow(lv, 1.1);
  const c = [v, v, v];
  const cx = wx + 0.5, cz = wz + 0.5;
  const r = 0.42;
  const y0 = wy, y1 = wy + 1;
  const mk = (x0, z0, x1, z1) => ([
    { px: x0, py: y0, pz: z0, u: 0, v: 0, color: c },
    { px: x1, py: y0, pz: z1, u: 1, v: 0, color: c },
    { px: x0, py: y1, pz: z0, u: 0, v: 1, color: c },
    { px: x1, py: y1, pz: z1, u: 1, v: 1, color: c }
  ]);
  let q = mk(cx - r, cz - r, cx + r, cz + r); target.quad(q, uvRect, 0, 1, 0);
  q = mk(cx - r, cz + r, cx + r, cz - r); target.quad(q, uvRect, 0, 1, 0);
}

/* 水面：只画朝空气的面，表面高度降到 0.875
 *
 * 本轮 B 的三处修正（审计里「强长条 / 矩形补丁 / 层层透明叠色」的直接来源）：
 *  1) **逐顶点平滑光照**。旧写法每个水面方块整面只有一个颜色（取相邻空气格的光照），
 *     于是相邻两格光照差一级就在水面上留下一个整整齐齐的方块色块 —— 这就是「矩形补丁」。
 *     现在按 emitFace 的做法，对 4 个角的相邻格取平均，色块之间过渡成连续渐变。
 *  2) **UV 改成 1 格 = 1 张贴图**。之前的 6 格一个周期把 16px 贴图拉成每格 2.7px，
 *     单个像素成了 1/3 格宽的色块，远处必然读成大方块；现在与陆地同一像素密度。
 *  3) **按深度压暗**。水面以下的格子比表层暗一档，近岸浅、深处深，
 *     不再是一整片同色的平面。深度用「这一列水顶到这一格的差」近似，纯着色、不查方块。 */
function buildWater(s, target, wx, wy, wz, surfaceY) {
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const d = face.dir;
    const nid = s.getBlock(wx + d[0], wy + d[1], wz + d[2]);
    if (nid === B.WATER) continue;
    if (nid !== AIR && BLOCKS[nid] && BLOCKS[nid].opaque) continue;
    const ax = wx + d[0], ay = wy + d[1], az = wz + d[2];
    const base = s.getLight(ax, ay, az);
    const baseSky = base >> 4, baseBlk = base & 15;
    const axes = [0, 1, 2].filter(a => d[a] === 0);
    const tA = axes[0], tB = axes[1];
    const fs = FACE_SHADE[face.name];
    /* 深度：水面往下每格压暗 0.055（最多压到 0.62 倍），近岸浅水保持亮 */
    const depth = Math.max(0, (surfaceY === undefined ? wy : surfaceY) - wy);
    const depthMul = Math.max(0.62, 1 - depth * 0.055);
    /* 第二轮 B1：浅水要能读到岸底 —— 用**深度提亮**而不是改材质 alpha：
       浅水（depth 0~1）整体提高一档亮度并略降蓝偏，让水下的沙/石透过 0.62 的 alpha 读得出来；
       深水按 depthMul 压暗，色调自然过渡到深蓝。alpha 由 view.matWater 统一给（0.62）。 */
    const shallow = Math.max(0, 1 - depth * 0.5);
    const corners = face.corners.map(cc => {
      const p = cc.pos;
      const offA = p[tA] ? 1 : -1;
      const offB = p[tB] ? 1 : -1;
      const pa = [0, 0, 0]; pa[tA] = offA;
      const pb = [0, 0, 0]; pb[tB] = offB;
      const n1 = [ax + pa[0], ay + pa[1], az + pa[2]];
      const n2 = [ax + pb[0], ay + pb[1], az + pb[2]];
      const n3 = [ax + pa[0] + pb[0], ay + pa[1] + pb[1], az + pa[2] + pb[2]];
      const L1 = lightPair(s, n1), L2 = lightPair(s, n2), L3 = lightPair(s, n3);
      const sky = (baseSky + L1[0] + L2[0] + L3[0]) / 4;
      const blk = (baseBlk + L1[1] + L2[1] + L3[1]) / 4;
      const lv = Math.max(sky / 15, (blk / 15) * 1.05);
      const shade = lv === 0 ? 0.12 : (0.12 + 0.88 * Math.pow(lv, 1.1));
      const k = shade * fs * depthMul * (1 + shallow * 0.14);
      const top = p[1] === 1;
      return {
        px: wx + p[0],
        py: wy + (top && d[1] !== -1 ? 0.875 : p[1]),
        pz: wz + p[2],
        u: cc.uv[0], v: cc.uv[1],
        /* 浅水把绿/红抬一点（更接近岸沙的暖调），深水回到纯冷蓝 */
        color: [k * (0.58 + shallow * 0.10), k * (0.76 + shallow * 0.06), k * 1.0]
      };
    });
    /* UV：世界坐标连续、1 格 = 1 张贴图（与陆地同一像素密度），相邻格首尾相接 */
    if (face.name === 'top' || face.name === 'bottom') {
      for (const c of corners) { c.u = c.px; c.v = c.pz; }
    } else if (face.name === 'posx' || face.name === 'negx') {
      for (const c of corners) { c.u = c.pz; c.v = c.py; }
    } else {
      for (const c of corners) { c.u = c.px; c.v = c.py; }
    }
    target.quad(corners, [0, 0, 1, 1], d[0], d[1], d[2]);
  }
}
