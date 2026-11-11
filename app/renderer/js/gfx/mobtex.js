'use strict';
/*
 * mobtex.js —— 生物像素贴图的「画布 → THREE 纹理 → 材质」这一段（阶段 3b）。
 *
 * 分工：像素怎么画全在 gfx/painters.js 的 mobPainters 里（与方块/物品同一套画法）；
 * 本文件只负责浏览器侧的缓存与材质装配。
 *
 * 三条约束：
 *  1) 纹理按名字缓存（同名只画一次，重复造生物不再重复建画布）；
 *  2) **材质不共享** —— 每个部件自己的材质，只共用那张缓存好的纹理。
 *     生物材质要按世界光照压暗、受击要闪红（mobs.js render 的 traverse），
 *     共享材质会让 A 的受击闪红把 B 也一起涂了（P1 的亮度曲线是按个体算的）。
 *  3) **无 DOM 时不许炸**。Node 单测里会直接 `new Mob('creeper')` 走同一套模型代码，
 *     那边没有 document.createElement —— 此时退化成「按名字给一档代表色的无贴图材质」，
 *     AI/物理/姿态/存档那些断言照旧可跑；像素内容的验收放在浏览器 e2e 里读画布。
 */
import * as THREE from '../../vendor/three.module.js';
import { hashStringToSeed, mulberry32 } from '../core/rng.js';
import { MOB_TEX_SIZE, mobPainters, paintMobTex } from './painters.js';

const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';
const _cache = new Map();          // name -> canvas（浏览器）
const _texCache = new Map();       // name -> THREE.CanvasTexture（浏览器）

/* 无 DOM 时的代表色：只用来让 headless 模型不至于全白，不参与任何断言 */
const FALLBACK_COLOR = {
  skeleton: 0xd8d8ce, creeper: 0x57a84e, bow: 0x7a5a34,
  parrot: 0x3fa93f, parrotWing: 0x2f8f46,
  cod: 0x9fb8c6, codHead: 0xb6cbd6, codTail: 0x89a6b6, codFin: 0x8fa9b8, codTop: 0x7f9dad,
  /* 本轮 C：僵尸与守卫的分区代表色（与 painters.js 的调色一致） */
  zombie: 0x3f8a63, zombieBody: 0x2f6a52, zombieArm: 0x357a58, zombieLeg: 0x2b3b63,
  guardian: 0x5a636d, guardianCore: 0xe8c65a, guardianLimb: 0x5a6773
};
function fallbackColor(name) {
  if (name.indexOf('bow') >= 0) return FALLBACK_COLOR.bow;
  if (name.indexOf('creeper') === 0) return FALLBACK_COLOR.creeper;
  if (name.indexOf('parrot_wing') === 0) return FALLBACK_COLOR.parrotWing;
  if (name.indexOf('parrot') === 0) return FALLBACK_COLOR.parrot;
  if (name.indexOf('cod_head') === 0) return FALLBACK_COLOR.codHead;
  if (name.indexOf('cod_tail') === 0) return FALLBACK_COLOR.codTail;
  if (name.indexOf('cod_top') === 0) return FALLBACK_COLOR.codTop;
  if (name.indexOf('cod_fin') === 0) return FALLBACK_COLOR.codFin;
  if (name.indexOf('cod') === 0) return FALLBACK_COLOR.cod;
  if (name.indexOf('zombie_body') === 0) return FALLBACK_COLOR.zombieBody;
  if (name.indexOf('zombie_arm') === 0) return FALLBACK_COLOR.zombieArm;
  if (name.indexOf('zombie_leg') === 0) return FALLBACK_COLOR.zombieLeg;
  if (name.indexOf('zombie') === 0) return FALLBACK_COLOR.zombie;
  if (name.indexOf('guardian_core') === 0) return FALLBACK_COLOR.guardianCore;
  if (name.indexOf('guardian_limb') === 0) return FALLBACK_COLOR.guardianLimb;
  if (name.indexOf('guardian') === 0) return FALLBACK_COLOR.guardian;
  return FALLBACK_COLOR.skeleton;
}

/** 画一张 16×16 的生物贴图（同名只画一次）；无 DOM 返回 null */
export function mobTexCanvas(name) {
  if (!HAS_DOM) return null;
  const hit = _cache.get(name);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = MOB_TEX_SIZE; c.height = MOB_TEX_SIZE;
  const g = c.getContext('2d', { willReadFrequently: true });
  // 每个名字固定一颗 rand：同一张贴图每次画出来逐像素相同（取证与回归都靠这条）
  paintMobTex(name, g, mulberry32(hashStringToSeed('mobtex:' + name)), MOB_TEX_SIZE);
  _cache.set(name, c);
  return c;
}

export function mobTexture(name) {
  if (!HAS_DOM) return null;
  const hit = _texCache.get(name);
  if (hit) return hit;
  const t = new THREE.CanvasTexture(mobTexCanvas(name));
  t.magFilter = THREE.NearestFilter;          // 像素风不许糊
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;        // 与 atlas 同一套色彩空间
  t.needsUpdate = true;
  _texCache.set(name, t);
  return t;
}

/** 六面同一张贴图时的简写；无 DOM 退化成代表色 */
export function mobMaterial(name) {
  const map = mobTexture(name);
  return new THREE.MeshBasicMaterial(map ? { color: 0xffffff, map } : { color: fallbackColor(name) });
}

/**
 * 单个部件的六面贴图（BoxGeometry 的材质顺序：+x, -x, +y, -y, +z, -z）。
 * 正面 = +z（生物模型正面朝 +Z，D3 的朝向约定），所以 front 只给 +z 那一面。
 * @param {{front?:string, back?:string, side?:string, top?:string, bottom?:string}} faces
 * @returns {THREE.Material[]} 长度 6；贴图件颜色留白，压暗/闪红由 mobs.js 乘上去
 */
export function mobFaceMaterials(faces) {
  const side = faces.side || faces.front || faces.back || 'missing';
  const skin = faces.front || side;
  const names = [
    side, side,
    faces.top || skin,
    faces.bottom || skin,
    faces.front || skin,
    faces.back || skin
  ];
  return names.map(mobMaterial);
}

/**
 * 取证/验收读数：把一张贴图压成几个可断言的数（颜色档数、RGB 均值、暗像素占比）。
 * 「骷髅与苦力怕贴图不同」不能靠肉眼看提交说明，要有数。
 * 无 DOM（Node 单测）时返回 { headless:true, painter: 有没有对应画笔 }，
 * 让单测至少能钉住「名字拼错会露品红」这一层。
 */
export function mobTexStats(name) {
  const hasPainter = typeof mobPainters[name] === 'function';
  /* 阶段 3c：把「无 DOM 时这张名字会掉到哪一档代表色」也交出去 ——
     以前新贴图忘了扩 FALLBACK_COLOR 就悄悄落回骨架骨白，单测看不出来；
     现在单测能直接钉「每个被引用的名字都有自己的代表色」。 */
  const fb = fallbackColor(name);
  if (!HAS_DOM) return { name, headless: true, hasPainter, size: MOB_TEX_SIZE, fallbackColor: fb };
  const c = mobTexCanvas(name);
  const g = c.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const buckets = new Set();
  let r = 0, gg = 0, b = 0, dark = 0, n = 0, missing = 0;
  for (let i = 0; i < d.length; i += 4) {
    const pr = d[i], pg = d[i + 1], pb = d[i + 2];
    r += pr; gg += pg; b += pb;
    buckets.add((pr >> 4) + ',' + (pg >> 4) + ',' + (pb >> 4));
    const lum = 0.299 * pr + 0.587 * pg + 0.114 * pb;
    if (lum < 70) dark++;
    if (pr > 190 && pg < 90 && pb > 140) missing++;      // 品红 = 画笔缺失
    n++;
  }
  const round = (v) => Math.round(v * 100) / 100;
  return {
    name, hasPainter, size: c.width, pixels: n, fallbackColor: fb,
    colorBuckets: buckets.size,
    meanR: round(r / n), meanG: round(gg / n), meanB: round(b / n),
    darkRatio: round(dark / n), missingRatio: round(missing / n)
  };
}
