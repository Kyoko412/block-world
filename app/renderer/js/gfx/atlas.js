'use strict';
/*
 * 程序化纹理图集：把 painters.js 提供的像素画笔逐个画进一张大图，
 * 供区块网格化按 UV 采样；同时为 UI 生成物品图标（dataURL）。
 * 不加载任何外部图片，保证离线。
 */
import * as THREE from '../../vendor/three.module.js';
import { BLOCKS, B, tileForFace } from '../core/blocks.js';
import { ITEMS } from '../core/items.js';
import { paintBlock, paintItem } from './painters.js';
import { hashStringToSeed, mulberry32 } from '../core/rng.js';

export const TILE = 16;          // 每个 tile 的像素尺寸
export const ATLAS_COLS = 16;    // 图集列数

/* 收集需要的所有方块贴图名 */
const TILE_FACES = ['top', 'bottom', 'posx', 'negx', 'posz', 'negz'];
function collectBlockTiles() {
  const names = new Set();
  for (const b of BLOCKS) {
    if (!b) continue;
    for (const k of Object.keys(b.tiles || {})) {
      const v = b.tiles[k];
      if (typeof v === 'string' && v !== 'air') names.add(v);
    }
  }
  // 按 meta/朝向动态取用的贴图：直接遍历 tileForFace 的所有可能返回值，
  // 这样新增生长阶段/湿润状态时不会再漏进图集（曾漏掉 wheat_1、wheat_2）。
  for (let id = 0; id < BLOCKS.length; id++) {
    if (!BLOCKS[id]) continue;
    for (let meta = 0; meta <= 7; meta++) {
      for (const f of TILE_FACES) {
        const t = tileForFace(id, meta, f);
        if (typeof t === 'string' && t !== 'air') names.add(t);
      }
    }
  }
  names.add('missing');
  names.add('grass_top'); names.add('grass_side'); names.add('dirt'); names.add('stone');
  return [...names].sort();
}

/* 物品图标名（非方块物品用 itemPainters，方块物品直接复用其侧面贴图） */
function collectItemIcons() {
  const out = [];
  for (const id of Object.keys(ITEMS)) {
    const it = ITEMS[id];
    if (it.blockId !== undefined && it.blockId !== null) continue; // 方块物品用图集
    out.push(it.icon || id);
  }
  return [...new Set(out)].sort();
}

const state = {
  ready: false,
  texture: null,
  canvas: null,
  index: Object.create(null),   // tile 名 -> 序号
  itemIcons: Object.create(null),
  crackCanvas: null,
  crackTexture: null
};

function drawGrid(canvas, names, painter, startX) {
  const g = canvas.getContext('2d', { willReadFrequently: true });
  names.forEach((name, i) => {
    const col = i % ATLAS_COLS, row = Math.floor(i / ATLAS_COLS);
    const x = startX + col * TILE, y = row * TILE;
    g.save();
    g.beginPath();
    g.rect(x, y, TILE, TILE);
    g.clip();
    g.translate(x, y);
    const rand = mulberry32(hashStringToSeed(name + '#' + i));
    try {
      painter(name, g, rand, TILE);
    } catch (e) {
      g.fillStyle = '#ff00ff';
      g.fillRect(0, 0, TILE, TILE);
      console.warn('画笔失败:', name, e);
    }
    g.restore();
    state.index[name] = row * ATLAS_COLS + col;
  });
}

/* 生成 10 阶段挖掘破坏纹理（160x16，每段 16x16） */
function buildCrackSheet() {
  const c = document.createElement('canvas');
  c.width = TILE * 10; c.height = TILE;
  const g = c.getContext('2d');
  for (let stage = 0; stage < 10; stage++) {
    g.save();
    g.translate(stage * TILE, 0);
    g.clearRect(0, 0, TILE, TILE);
    const rand = mulberry32(0x1234 + stage * 977);
    const cracks = 2 + stage * 3;
    g.fillStyle = 'rgba(0,0,0,0.72)';
    for (let i = 0; i < cracks; i++) {
      let x = Math.floor(rand() * TILE), y = Math.floor(rand() * TILE);
      const len = 3 + Math.floor(rand() * (2 + stage * 2));
      let dx = rand() < 0.5 ? 1 : -1, dy = rand() < 0.5 ? 1 : -1;
      if (rand() < 0.4) dx = 0; else if (rand() < 0.3) dy = 0;
      for (let s = 0; s < len; s++) {
        g.fillRect(((x % TILE) + TILE) % TILE, ((y % TILE) + TILE) % TILE, 1, 1);
        x += dx; y += dy;
        if (rand() < 0.3) { const t = dx; dx = dy; dy = t; }
      }
    }
    g.restore();
  }
  state.crackCanvas = c;
  state.crackTexture = new THREE.CanvasTexture(c);
  state.crackTexture.magFilter = THREE.NearestFilter;
  state.crackTexture.minFilter = THREE.NearestFilter;
  state.crackTexture.generateMipmaps = false;
}

/* 初始化（同步，几毫秒） */
export function initAtlas() {
  if (state.ready) return state;
  const blockTiles = collectBlockTiles();
  const rows = Math.max(1, Math.ceil(blockTiles.length / ATLAS_COLS));
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * TILE;
  canvas.height = rows * TILE;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid(canvas, blockTiles, paintBlock, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  state.canvas = canvas;
  state.texture = texture;
  state.blockTiles = blockTiles;
  state.itemIconNames = collectItemIcons();
  buildCrackSheet();
  state.ready = true;
  return state;
}

const UV_INSET = 0.02; // 防采样出血（像素级）

export function tileIndex(name) {
  const i = state.index[name];
  if (i === undefined) return state.index['missing'] || 0;
  return i;
}

/* 返回 [u0,v0,u1,v1]（v 轴按 three 的左下原点翻转） */
export function tileUV(name) {
  const idx = tileIndex(name);
  const col = idx % ATLAS_COLS, row = Math.floor(idx / ATLAS_COLS);
  const w = state.canvas.width, h = state.canvas.height;
  const x0 = col * TILE / w, x1 = (col + 1) * TILE / w;
  // three 的 UV 原点在左下，canvas 原点在左上，因此 row 需要反向
  const y0 = 1 - (row + 1) * TILE / h, y1 = 1 - row * TILE / h;
  return [x0 + UV_INSET / w, y0 + UV_INSET / h, x1 - UV_INSET / w, y1 - UV_INSET / h];
}

/* 缓存 tileUV，网格化里高频调用 */
const uvCache = Object.create(null);
export function tileUVCached(name) {
  let v = uvCache[name];
  if (!v) { v = tileUV(name); uvCache[name] = v; }
  return v;
}

export function crackUV(stage) {
  const s = Math.max(0, Math.min(9, Math.floor(stage)));
  const w = state.crackCanvas.width;
  return [s * TILE / w, 1 - TILE / state.crackCanvas.height, (s + 1) * TILE / w, 1];
}

/* ---------- UI 物品图标 ---------- */
function drawToDataURL(canvas, size, scale) {
  const out = document.createElement('canvas');
  out.width = size; out.height = size;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, size, size);
  return out.toDataURL('image/png');
}

export function getItemIcon(itemId, size = 32) {
  const key = itemId + '@' + size;
  if (state.itemIcons[key]) return state.itemIcons[key];
  const src = getItemIconCanvas(itemId);
  const out = document.createElement('canvas');
  out.width = size; out.height = size;
  const g = out.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, src.width, src.height, 0, 0, size, size);
  const url = out.toDataURL('image/png');
  state.itemIcons[key] = url;
  return url;
}

/* 生成 3D 用方块纹理（掉落物方块渲染） */
export function getBlockItemTexture(blockId) {
  if (!state.blockTexCache) state.blockTexCache = Object.create(null);
  const b = BLOCKS[blockId];
  const name = b.tiles.side || b.tiles.all || b.tiles.top || 'missing';
  if (state.blockTexCache[name]) return state.blockTexCache[name];
  const c = document.createElement('canvas');
  c.width = TILE; c.height = TILE;
  const g = c.getContext('2d');
  const idx = tileIndex(name);
  const col = idx % ATLAS_COLS, row = Math.floor(idx / ATLAS_COLS);
  g.drawImage(state.canvas, col * TILE, row * TILE, TILE, TILE, 0, 0, TILE, TILE);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
  state.blockTexCache[name] = t;
  return t;
}

export function getWaterTexture() {
  if (state.waterTex) return state.waterTex;
  const idx = tileIndex('water');
  const col = idx % ATLAS_COLS, row = Math.floor(idx / ATLAS_COLS);
  const c = document.createElement('canvas');
  c.width = TILE; c.height = TILE;
  const g = c.getContext('2d');
  g.drawImage(state.canvas, col * TILE, row * TILE, TILE, TILE, 0, 0, TILE, TILE);
  const t = new THREE.CanvasTexture(c);
  /* 第二轮 B1：水面**单独**开 mipmap，且只这一张贴图。
     复核 2-1 指出远处被亮点噪声占满；根源之一是水面在缩小时仍用 Nearest 单层采样，
     1px 反光点在远处会随机命中/漏掉，形成闪烁的碎屑。
     · magFilter 保持 Nearest：近景像素边缘依旧硬；
     · minFilter 用 LinearMipmapNearest：mip 层级之间 Nearest（不糊），
       层内做线性（缩小时不闪）；
     · 16×16 是 2 的幂，mipmap 生成安全。
     全局 atlas 不开 mipmap —— 那会让方块图集在缩小时互相串色。 */
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.LinearMipmapNearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.anisotropy = 2;
  t.colorSpace = THREE.SRGBColorSpace;
  state.waterTex = t;
  return t;
}

/* tile 平均色（用于挖掘粒子、掉落物光晕） */
export function getAtlasTexture() {
  if (!state.ready) initAtlas();
  return state.texture;
}

export function getTileAverageColor(name) {
  if (!state.avgCache) state.avgCache = Object.create(null);
  if (state.avgCache[name]) return state.avgCache[name];
  const idx = tileIndex(name);
  const col = idx % ATLAS_COLS, row = Math.floor(idx / ATLAS_COLS);
  const g = state.canvas.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(col * TILE, row * TILE, TILE, TILE).data;
  let r = 0, gg = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 40) continue;
    r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++;
  }
  if (!n) n = 1;
  const c = [r / n / 255, gg / n / 255, b / n / 255];
  state.avgCache[name] = c;
  return c;
}

export function getBlockAverageColor(blockId) {
  const b = BLOCKS[blockId];
  if (!b) return [0.5, 0.5, 0.5];
  const name = (b.tiles && (b.tiles.side || b.tiles.all || b.tiles.top)) || 'missing';
  return getTileAverageColor(name);
}

/* 物品图标 16x16 canvas（UI 与 3D 共用） */
export function getItemIconCanvas(itemId) {
  if (!state.iconCanvas) state.iconCanvas = Object.create(null);
  if (state.iconCanvas[itemId]) return state.iconCanvas[itemId];
  const it = ITEMS[itemId];
  const c = document.createElement('canvas');
  c.width = TILE; c.height = TILE;
  const g = c.getContext('2d');
  const rand = mulberry32(hashStringToSeed('item' + itemId));
  if (it && it.blockId !== undefined && it.blockId !== null && BLOCKS[it.blockId]) {
    const b = BLOCKS[it.blockId];
    const name = b.tiles.side || b.tiles.all || b.tiles.top || 'missing';
    const idx = tileIndex(name);
    g.drawImage(state.canvas, (idx % ATLAS_COLS) * TILE, Math.floor(idx / ATLAS_COLS) * TILE, TILE, TILE, 0, 0, TILE, TILE);
  } else {
    paintItem(it ? (it.icon || itemId) : itemId, g, rand, TILE);
  }
  state.iconCanvas[itemId] = c;
  return c;
}

export function getItemIconTexture(itemId) {
  if (!state.iconTex) state.iconTex = Object.create(null);
  if (state.iconTex[itemId]) return state.iconTex[itemId];
  const t = new THREE.CanvasTexture(getItemIconCanvas(itemId));
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  state.iconTex[itemId] = t;
  return t;
}

export function getWaterTextureRaw() { return getWaterTexture(); }
