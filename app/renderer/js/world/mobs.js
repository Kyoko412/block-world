'use strict';
/*
 * 第二阶段：生物（动物与敌怪）——程序化方块模型 + 简单 AI + 物理 + 存档。
 * 不依赖任何外部模型文件。
 */
import * as THREE from '../../vendor/three.module.js';
import { B, AIR, blockBoxes } from '../core/blocks.js';
import { arrowSpeedFor, arrowDamageFor, stepArrow, arrowHitsBox, canPickupStuck, ARROW_STUCK_LIFE } from '../core/projectile.js';
import { getItem } from '../core/items.js';
import { ihash2, mulberry32 } from '../core/rng.js';
import { WORLD_H, CHUNK_SX, CHUNK_SZ } from './chunk.js';
import { CREEPER_FUSE_SECONDS, CREEPER_TRIGGER, CREEPER_ESCAPE } from '../core/explosion.js';
import { normalizeVillagerProfession } from '../core/village.js';
import { MELEE_REACH, pickAttackTarget, meleeDamageScale } from '../core/melee.js';
import { entityBrightness, shadeColor } from '../core/entitylight.js';
import { mobFaceMaterials, mobMaterial } from '../gfx/mobtex.js';
import {
  GUARDIAN_HP, GUARDIAN_TRIGGER, GUARDIAN_PHASE, GUARDIAN_WARDS, GUARDIAN_ATTACKS,
  defaultGuardianState, normalizeGuardianState, guardianSiteKey,
  guardianDamage, guardianDamageType, stepGuardian
} from '../core/guardian.js';

/* ---------- 方块模型（MC 风格的低多边形宠物/怪物） ---------- */
/**
 * @param {number} w 宽 @param {number} h 高 @param {number} d 深 @param {number} color 纯色（无贴图时用）
 * @param {{tex?:string, faces?:object, pivot?:'top'|'bottom'}} [opts] 阶段 3b 新增：
 *   tex   = 六面同一张生物贴图（见 gfx/painters.js 的 mobPainters）
 *   faces = 按面给贴图（正面画眼窝/肋骨，侧面画脊柱 —— 转个身就看得出是同一具骨架）
 *   pivot = 'top'/'bottom'：把几何体沿 Y 挪半个高度，让部件**绕关节**转而不是绕中间转。
 *           注意：挪几何体的同时，调用方给的 pos 要填关节高度，整体轮廓与旧版逐格相同。
 */
function box(w, h, d, color, opts = {}) {
  const geo = new THREE.BoxGeometry(w, h, d);
  if (opts.pivot === 'top') geo.translate(0, -h / 2, 0);
  else if (opts.pivot === 'bottom') geo.translate(0, h / 2, 0);
  /* 阶段 3c 的翅膀绕 Z 拍：'left' 把几何体推到 -x（铰链在贴着身体的右缘），
     'right' 推到 +x —— 这样 mesh.rotation.z 抬起来的是翼尖而不是整片翅膀自转。 */
  else if (opts.pivot === 'left') geo.translate(-w / 2, 0, 0);
  else if (opts.pivot === 'right') geo.translate(w / 2, 0, 0);
  const mat = opts.faces ? mobFaceMaterials(opts.faces)
    : (opts.tex ? mobMaterial(opts.tex) : new THREE.MeshBasicMaterial({ color }));
  const m = new THREE.Mesh(geo, mat);
  if (opts.tex || opts.faces) m.userData.tex = opts.tex || Object.keys(opts.faces).map(k => k + ':' + opts.faces[k]).join(',');
  if (opts.pivot) m.userData.pivot = opts.pivot;
  return m;
}

/* 阶段 3b：把一根细长盒子摆成「两点之间的弦」——位置取中点、朝向取连线、Y 方向按长度缩放。
   纯函数（只算数，不碰 THREE），所以能在 Node 里单测，render 只负责把结果写进部件。 */
export function stringSeg(y1, z1, y2, z2) {
  const dy = y2 - y1, dz = z2 - z1;
  const len = Math.hypot(dy, dz);
  return { y: (y1 + y2) / 2, z: (z1 + z2) / 2, rotX: Math.atan2(dz, dy), scale: len };
}

/* 骷髅拉弓（本作约定，见原版参照规格.md）：0.7 秒把弦从弓腹拉到脸颊，
   这段时间箭**还没离弦**，玩家看得见「先拉」才躲得住「后放」。 */
export const SKELETON_DRAW_SECONDS = 0.7;
export const SKELETON_BOW_TIP_Y = 0.17;     // 上下弓梢（相对弓把）
export const SKELETON_BOW_TIP_Z = 0.05;     // 弓梢向前弯
export const SKELETON_STRING_REST_Z = -0.02; // 静止时弦贴着弓腹
export const SKELETON_STRING_PULL_Z = -0.20; // 拉满时弦到了脸颊
/** 拉弦进度 t∈[0,1] → 拉弦点在 Z 上的位置（纯函数，验收直接钉这条曲线） */
export function bowNockZ(t) {
  const k = Math.max(0, Math.min(1, t));
  return SKELETON_STRING_REST_Z + (SKELETON_STRING_PULL_Z - SKELETON_STRING_REST_Z) * k;
}

/* 阶段 3b：苦力怕嘶声的间隔（秒），按下标 = 引信档位（0/1/2）取。
   越接近爆炸叫得越急 —— 玩家不用看数值也知道「现在该跑了」。 */
export const CREEPER_HISS_GAP = [0.5, 0.32, 0.18];

/* 阶段 5 / 本轮 A2：守卫追击的两个速率常数（单位统一成 1/秒，与帧率无关）
   · CHASE_RATE：速度向「单位方向×speed」指数收敛的速率，约 0.17 秒走完 63%；
   · STOP_RATE ：离开追击分支（前摇/硬直）时速度衰减的速率，旧值 0.8/帧 ≈ 13.4/秒。
   两条都用 1-exp(-rate*dt)，所以 30/60/120 FPS 在相同真实秒数里走同样远。 */
/* 第二轮 D：守卫光弹的飞行参数（格/秒 与 秒）。速度刻意慢于玩家侧移，才躲得开。 */
export const GUARDIAN_BOLT_SPEED = 11;
export const GUARDIAN_BOLT_LIFE = 3.2;
export const GUARDIAN_CHASE_RATE = 6;
export const GUARDIAN_STOP_RATE = 13.4;
/** 守卫的追击目标速度（米/秒）。旧实现把它乘了 dt，等于「每帧位移」，本轮已修正。 */
export function guardianChaseSpeed(base) {
  const v = Number(base);
  return Number.isFinite(v) && v > 0 ? v : 1.9;
}

/* 阶段 3b：骷髅手里那把弓要「可辨认」——三段弓臂向前弯出弧度、弓弦拆成上下两段（拉弦时
   两段在拉弦点张开成 V），再搭一支箭（只在拉弦阶段可见）。弦两段与箭都挂在 group.userData 上，
   render() 用 stringSeg()/bowNockZ() 算出的数摆它们，模型几何本身不参与决策。 */
function makeBowMesh() {
  const g = new THREE.Group();
  const seg = (h, y, z, rotX) => {
    const m = box(0.05, h, 0.055, 0x7a5a34, { tex: 'skeleton_bow' });
    m.position.set(0, y, z); m.rotation.x = rotX;
    g.add(m); return m;
  };
  seg(0.19, SKELETON_BOW_TIP_Y * 0.62, SKELETON_BOW_TIP_Z * 0.55, -0.52);
  seg(0.19, 0, 0, 0);
  seg(0.19, -SKELETON_BOW_TIP_Y * 0.62, SKELETON_BOW_TIP_Z * 0.55, 0.52);
  const mkString = () => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.012, 1, 0.012),
      new THREE.MeshBasicMaterial({ color: 0xe6e2d4 }));
    m.userData.segLen = 1;                 // 单位长：render 用 stringSeg 的 scale 直接拉伸
    g.add(m); return m;
  };
  const upper = mkString(), lower = mkString();
  const arrow = new THREE.Group();
  const shaft = box(0.022, 0.022, 0.34, 0xcfc4a8);
  const head = box(0.03, 0.03, 0.06, 0x9aa0a8); head.position.z = 0.19;
  const fletch = box(0.05, 0.014, 0.07, 0xe8e4da); fletch.position.z = -0.15;
  arrow.add(shaft); arrow.add(head); arrow.add(fletch);
  arrow.visible = false;
  g.add(arrow);
  g.userData.stringUpper = upper; g.userData.stringLower = lower; g.userData.arrow = arrow;
  g.userData.nockZ = SKELETON_STRING_REST_Z;
  g.userData.tex = 'skeleton_bow';
  return g;
}

/* ---------- 阶段 3c：刷怪判据与地下通路（数值与抽出来之前一字不差） ----------
 * SPAWN_DARK_LIMIT / SPAWN_DAY_LIGHT 原来是 findSpawnPoint 里写死的 0.34 / 0.5，
 * 抽成具名常量是为了让 spawnSiteOk 既能被地下通路复用，也能被单测直接钉住——
 * 「同一点位插火把前后」的 A/B 用的就是这一份判据，两处不许各有阈值。 */
export const SPAWN_DARK_LIMIT = 0.34;      // 敌对：局部亮度必须 ≤ 这个数
export const SPAWN_DAY_LIGHT = 0.5;        // 动物：局部亮度必须 ≥ 这个数
export const UNDERGROUND_TRIES = 14;       // 每次节拍最多试多少个地下候选格
export const UNDERGROUND_SCAN_UP = 40;     // 判断「头顶有没有盖」向上最多扫几格（超出世界顶部自然停）
export const UNDERGROUND_MIN_COVER = 5;    // 至少埋这么深才算地下（否则是地表凹坑，仍被天光照着）
export const UNDERGROUND_MAX_DEPTH = 28;   // 但也不无限深：候选带取地表往下 5~28 格（深洞与矿脉都在这带里）
export const SPAWN_UNDERGROUND_MIN_DIST = 10;   // 太近不刷（别在玩家脚下冒出来）
export const SPAWN_UNDERGROUND_RANGE = 18;      // 水平搜索带：10 ~ 28 格
export const SPAWN_CAVE_INTERVAL = 3.3;    // 地下通路自己的节拍；陆上/水域/林冠各自的节拍互不抢占
export const SPAWN_CAVE_CAP = 6;           // 地下敌怪上限（与 maxMobs 取更严的那个，别让洞穴吃满总量）

/* ---------- 阶段 3c：会飞的鸟（鹦鹉近似，确定性林冠站点，不入库） ----------
 * 与鱼同一套做法：AIR_TYPES 单独成表，parrot **不进 DAY_TYPES / NIGHT_TYPES** ——
 * 那两张表走「地表高度 + 亮度阈值」的落地刷怪路径，鸟混进去就会被刷成站在地上的鸡。
 * 站点由种子决定（birdFlockOf），扫描有总量闸（BIRD_MAX_ALIVE + maxMobs），
 * 站点键 bk 跟着存档走，读档后同一格里不会补第二群。 */
export const AIR_TYPES = ['parrot'];
export const FLYING_TYPES = AIR_TYPES;    // 与 AQUATIC_TYPES 对称的命名（验收与单测读这个更直观）
export const BIRD_SITE_STEP = 16;          // 每 16×16 列一个候选停栖站点
export const BIRD_FLOCK_MIN = 2;           // 两只起才算「一对」，一只像贴图掉了
export const BIRD_FLOCK_MAX = 4;
export const BIRD_MAX_ALIVE = 8;           // 同时存活的鸟上限（飞行动作每帧都要算，成本比鱼高）
export const BIRD_SPAWN_INTERVAL = 1.7;    // 站点扫描节奏（比鱼慢一档，避免与鱼群抢同一把闸）
export const BIRD_SITE_CHANCE = 34;        // 约 34% 的站点有鸟（森林/林冠由 perch 扫描再筛一次）
export const BIRD_CANOPY_MIN = 2;          // 林冠至少高出地面 2 格才值得去（否则没得停）
export const BIRD_HOVER_MIN = 2.5;         // 悬停高度带：林冠上方 2.5~6 格
export const BIRD_HOVER_MAX = 6.0;
export const BIRD_PERCH_REACH = 5;         // 找停栖点时水平最多扫 5 格
export const BIRD_PERCH_FALLBACK = 0.05;   // 栖点已是树叶顶的上一格空气；模型底面约在 pos.y+0.09，再抬高就会「悬空停栖」
export const BIRD_PERCH_SETTLE_DIST = 1.6; // 短飞结束允许落下停栖的水平误差；更远转 hover 再绕回来
export const BIRD_FLY_SPEED = 3.4;         // 短飞速度（格/秒）
export const BIRD_HOVER_SPEED = 1.6;       // 悬停/巡游速度
export const BIRD_TURN_RATE = 2.6;         // 每秒最多转这么多弧度：转向要看得见，但不许抽风
export const BIRD_FLAP_RATE = 8.5;         // 拍翅角速度（弧度/秒的相位）
export const BIRD_FLAP_MAX = 0.95;         // 翅膀抬起来的最大弧度（绕 Z，有界）
export const BIRD_GLIDE_FLAP = 0.22;       // 停栖/滑翔时的收拢幅度
export const BIRD_PERCH_FLAP = BIRD_FLAP_MAX * 0.08; // 停栖时只剩一点微颤；半幅拍动会让「停栖」看起来像在悬停
export const BIRD_FLY_SECONDS = [1.6, 4.2];// 一次短飞的时长带
export const BIRD_PERCH_SECONDS = [3.0, 8.0]; // 停栖时长带
export const BIRD_ESCAPE_DIST = 2.6;       // 玩家靠到这么近会起飞躲开
export const BIRD_RANGE_MIN = 8;           // 站点太近不刷（免得头顶突然冒出来）
export const BIRD_RANGE_MAX = 48;          // 超出加载范围不管

/** 站点纯函数：同一颗种子任何时刻算出同一个结果（与 fishSchoolOf 同一套做法） */
export function birdFlockOf(seed, sx, sz) {
  const h = ihash2(sx, sz, (seed >>> 0) ^ 0xB14D005);
  if (h % 100 >= BIRD_SITE_CHANCE) return null;
  const rand = mulberry32(h >>> 0);
  const ox = Math.floor(rand() * BIRD_SITE_STEP);
  const oz = Math.floor(rand() * BIRD_SITE_STEP);
  const count = BIRD_FLOCK_MIN + Math.floor(rand() * (BIRD_FLOCK_MAX - BIRD_FLOCK_MIN + 1));
  return {
    sx, sz,
    key: 'b' + sx + ',' + sz,
    x: sx * BIRD_SITE_STEP + ox + 0.5,
    z: sz * BIRD_SITE_STEP + oz + 0.5,
    count, seed: h >>> 0
  };
}

/** 悬停高度带（纯函数）：林冠顶 + [BIRD_HOVER_MIN, BIRD_HOVER_MAX]，t∈[0,1] 由 AI 推进 */
export function birdHoverY(canopyY, t = 0.5) {
  const k = Math.max(0, Math.min(1, Number(t) || 0));
  return canopyY + BIRD_HOVER_MIN + (BIRD_HOVER_MAX - BIRD_HOVER_MIN) * k;
}

/** 停栖站位（纯函数）：站在栖点上方 BIRD_PERCH_FALLBACK，不埋进树叶 */
export function birdPerchY(perchTopY) {
  return perchTopY + BIRD_PERCH_FALLBACK;
}

/** AI 必须遵守的界，导出给单测与验收（断言里的界就是代码里的界） */
export function flightRules() {
  return Object.freeze({
    siteStep: BIRD_SITE_STEP, flockMin: BIRD_FLOCK_MIN, flockMax: BIRD_FLOCK_MAX,
    maxAlive: BIRD_MAX_ALIVE, interval: BIRD_SPAWN_INTERVAL, siteChance: BIRD_SITE_CHANCE,
    canopyMin: BIRD_CANOPY_MIN, hoverMin: BIRD_HOVER_MIN, hoverMax: BIRD_HOVER_MAX,
    perchReach: BIRD_PERCH_REACH, perchFallback: BIRD_PERCH_FALLBACK,
    flySpeed: BIRD_FLY_SPEED, hoverSpeed: BIRD_HOVER_SPEED,
    turnRate: BIRD_TURN_RATE, flapMax: BIRD_FLAP_MAX, glideFlap: BIRD_GLIDE_FLAP,
    flySeconds: BIRD_FLY_SECONDS.slice(), perchSeconds: BIRD_PERCH_SECONDS.slice(),
    escapeDist: BIRD_ESCAPE_DIST, rangeMin: BIRD_RANGE_MIN, rangeMax: BIRD_RANGE_MAX
  });
}

/* 转向：把当前 yaw 朝目标角逼近，每步不超过 BIRD_TURN_RATE × dt（纯函数，单测钉住「不抽风」） */
export function approachYaw(yaw, target, dt) {
  let d = target - yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const step = BIRD_TURN_RATE * Math.max(0, Number(dt) || 0);
  return yaw + Math.max(-step, Math.min(step, d));
}

/* 阶段 3c：只在内存里有效的生物序号。验收脚本要能盯住「同一只鸟」从停栖到起飞，
   而不是拿位置去猜是不是同一只（鸟会动）。**不入库**：serialize() 里没有这个字段，
   旧档读写与逐字节对比的单测因此完全不受影响。 */
let MOB_UID = 0;

const MOBS = {
  pig: {
    name: '猪', hp: 10, passive: true, drop: [{ item: 'pork_raw', count: 1, bonus: 1 }],
    breedable: true, food: ['carrot', 'potato'],
    scale: 1, parts: (c) => [
      { part: 'body', mesh: box(0.62, 0.5, 0.92, 0xe89a9a, { tex: 'pig_body' }), pos: [0, 0.52, 0] },
      { part: 'head', mesh: box(0.44, 0.42, 0.4, 0xefa8a8, { tex: 'pig_head' }), pos: [0, 0.6, 0.62] },
      { part: 'leg0', mesh: box(0.18, 0.32, 0.18, 0xd07f7f, { tex: 'pig_leg' }), pos: [-0.2, 0.16, 0.3] },
      { part: 'leg1', mesh: box(0.18, 0.32, 0.18, 0xd07f7f, { tex: 'pig_leg' }), pos: [0.2, 0.16, 0.3] },
      { part: 'leg2', mesh: box(0.18, 0.32, 0.18, 0xd07f7f, { tex: 'pig_leg' }), pos: [-0.2, 0.16, -0.3] },
      { part: 'leg3', mesh: box(0.18, 0.32, 0.18, 0xd07f7f, { tex: 'pig_leg' }), pos: [0.2, 0.16, -0.3] }
    ],
    nose: { build: () => box(0.2, 0.14, 0.06, 0xc96f6f), pos: [0, 0.52, 0.83] }
  },
  cow: {
    name: '牛', hp: 10, passive: true, drop: [{ item: 'beef_raw', count: 1, bonus: 1 }, { item: 'leather', count: 1 }],
    breedable: true, food: ['wheat'],
    scale: 1.1, parts: (c) => [
      { part: 'body', mesh: box(0.66, 0.6, 1.0, 0x4a3b32, { tex: 'cow_body' }), pos: [0, 0.62, 0] },
      { part: 'head', mesh: box(0.46, 0.44, 0.42, 0x3a2e27, { tex: 'cow_head' }), pos: [0, 0.72, 0.66] },
      { part: 'leg0', mesh: box(0.2, 0.38, 0.2, 0x2b211c, { tex: 'cow_leg' }), pos: [-0.22, 0.19, 0.32] },
      { part: 'leg1', mesh: box(0.2, 0.38, 0.2, 0x2b211c, { tex: 'cow_leg' }), pos: [0.22, 0.19, 0.32] },
      { part: 'leg2', mesh: box(0.2, 0.38, 0.2, 0x2b211c, { tex: 'cow_leg' }), pos: [-0.22, 0.19, -0.32] },
      { part: 'leg3', mesh: box(0.2, 0.38, 0.2, 0x2b211c, { tex: 'cow_leg' }), pos: [0.22, 0.19, -0.32] }
    ],
    horn: { build: () => box(0.5, 0.06, 0.1, 0xd9d2c4), pos: [0, 0.94, 0.66] }
  },
  chicken: {
    name: '鸡', hp: 4, passive: true, drop: [{ item: 'chicken_raw', count: 1, bonus: 1 }, { item: 'feather', count: 1 }],
    breedable: true, food: ['wheat_seeds'],
    scale: 0.7, parts: (c) => [
      { part: 'body', mesh: box(0.4, 0.42, 0.52, 0xf0efe6), pos: [0, 0.42, 0] },
      { part: 'head', mesh: box(0.24, 0.26, 0.24, 0xfafaf2), pos: [0, 0.72, 0.24] },
      { part: 'leg0', mesh: box(0.07, 0.22, 0.07, 0xe0a03a), pos: [-0.1, 0.11, 0.02] },
      { part: 'leg1', mesh: box(0.07, 0.22, 0.07, 0xe0a03a), pos: [0.1, 0.11, 0.02] }
    ],
    beak: { build: () => box(0.1, 0.07, 0.12, 0xe8a33a), pos: [0, 0.7, 0.4] }
  },
  /* 阶段 3a 鳕鱼：水生、成群、只在水体里自然生成（见 fishSchoolOf / spawnFishSchools）。
     模型与其它生物一样正面朝 +Z（D3 的 yaw 约定），尾鳍单独成一个 part，
     这样摆尾只旋转 tail，不会把身体朝向带偏。 */
  cod: {
    name: '鳕鱼', hp: 5, passive: true, aquatic: true, speed: 1.9,
    drop: [{ item: 'fish_raw', count: 1, bonus: 1 }],
    scale: 0.8, w: 0.5, h: 0.45, parts: (c) => [
      /* 阶段 3c：几何体、色值、位置一字未动，只加 tex —— 材质层次来自贴图，
         远看色调与阶段 3a 一致，近看才有背深腹亮、侧线、鳞片与鳍条。 */
      { part: 'body', mesh: box(0.26, 0.3, 0.66, 0x9fb8c6, { tex: 'cod_body' }), pos: [0, 0.26, 0] },
      { part: 'head', mesh: box(0.22, 0.24, 0.2, 0xb6cbd6, { tex: 'cod_head' }), pos: [0, 0.26, 0.4] },
      { part: 'tail', mesh: box(0.06, 0.26, 0.24, 0x89a6b6, { tex: 'cod_tail' }), pos: [0, 0.26, -0.42] },
      { part: 'finL', mesh: box(0.16, 0.08, 0.2, 0x8fa9b8, { tex: 'cod_fin' }), pos: [-0.19, 0.22, 0.02] },
      { part: 'finR', mesh: box(0.16, 0.08, 0.2, 0x8fa9b8, { tex: 'cod_fin' }), pos: [0.19, 0.22, 0.02] },
      { part: 'finTop', mesh: box(0.06, 0.12, 0.26, 0x7f9dad, { tex: 'cod_top' }), pos: [0, 0.44, -0.02] }
    ]
  },
  /* 阶段 3c 鹦鹉：飞行生物，只在林冠附近按确定性站点自然生成（birdFlockOf / spawnBirdFlocks）。
     两片翅膀是**独立部件**并且几何体按 'left'/'right' 推到身体边缘 —— 铰链在肩上，
     拍动抬起来的是翼尖（关节端几乎不动），与阶段 3b 的肢体转轴同一口径；
     尾羽单独成 tail，做方向舵时只转 tail，不会把身体朝向带偏（D3：朝向只由 yaw 决定）。 */
  parrot: {
    name: '鹦鹉', hp: 6, passive: true, flying: true, speed: BIRD_FLY_SPEED, sound: 'chicken',
    drop: [{ item: 'feather', count: 1 }, { item: 'chicken_raw', count: 1, chance: 0.4 }],
    scale: 0.62, w: 0.42, h: 0.42, parts: (c) => [
      { part: 'body', mesh: box(0.26, 0.32, 0.44, 0x3fa93f, { tex: 'parrot_body' }), pos: [0, 0.30, 0] },
      { part: 'head', mesh: box(0.22, 0.22, 0.22, 0x49b84a, { tex: 'parrot_head' }), pos: [0, 0.50, 0.26] },
      { part: 'tail', mesh: box(0.12, 0.05, 0.34, 0xc8402f, { tex: 'parrot_tail' }), pos: [0, 0.26, -0.36] },
      { part: 'wingL', mesh: box(0.26, 0.05, 0.34, 0x2f8f46, { tex: 'parrot_wing', pivot: 'left' }), pos: [-0.13, 0.36, -0.02] },
      { part: 'wingR', mesh: box(0.26, 0.05, 0.34, 0x2f8f46, { tex: 'parrot_wing', pivot: 'right' }), pos: [0.13, 0.36, -0.02] }
    ],
    beak: { build: () => box(0.1, 0.09, 0.12, 0xe0a03a), pos: [0, 0.48, 0.42] }
  },
  sheep: {
    name: '羊', hp: 8, passive: true, sound: 'sheep', shearable: true,
    breedable: true, food: ['wheat'],
    drop: [{ item: 'wool', count: 1 }, { item: 'wool', count: 1, chance: 0.5 }],
    scale: 0.95,
    /* 第二参数 sheared：剪过毛之后身体明显变薄、露出粉色皮肤（原版就是这个观感） */
    /* 阶段 6：没剪的用羊毛贴图，剪过毛的用**独立的皮肤贴图** sheep_skin。
       封版前这里曾复用 sheep_head（带口鼻/鼻孔/额毛），近看会在羊身上看到第二张脸；
       现在身体与头部贴图各司其职。贴图只补像素层次，尺寸与位置一字未动 ——
       旧断言（体积 0.62×0.56×0.9 → 0.44×0.40×0.72）不受影响。 */
    parts: (c, sheared) => sheared ? [
      { part: 'body', mesh: box(0.44, 0.40, 0.72, 0xe7b3a9, { tex: 'sheep_skin' }), pos: [0, 0.50, 0] },
      { part: 'head', mesh: box(0.34, 0.34, 0.34, 0xd8cfc2, { tex: 'sheep_head' }), pos: [0, 0.60, 0.52] },
      { part: 'leg0', mesh: box(0.15, 0.3, 0.15, 0xbdb3a4, { tex: 'sheep_leg' }), pos: [-0.17, 0.15, 0.22] },
      { part: 'leg1', mesh: box(0.15, 0.3, 0.15, 0xbdb3a4, { tex: 'sheep_leg' }), pos: [0.17, 0.15, 0.22] },
      { part: 'leg2', mesh: box(0.15, 0.3, 0.15, 0xbdb3a4, { tex: 'sheep_leg' }), pos: [-0.17, 0.15, -0.22] },
      { part: 'leg3', mesh: box(0.15, 0.3, 0.15, 0xbdb3a4, { tex: 'sheep_leg' }), pos: [0.17, 0.15, -0.22] }
    ] : [
      { part: 'body', mesh: box(0.62, 0.56, 0.9, 0xecebe3, { tex: 'sheep_body' }), pos: [0, 0.56, 0] },
      { part: 'head', mesh: box(0.36, 0.36, 0.36, 0xd8cfc2, { tex: 'sheep_head' }), pos: [0, 0.66, 0.6] },
      { part: 'leg0', mesh: box(0.16, 0.3, 0.16, 0xbdb3a4, { tex: 'sheep_leg' }), pos: [-0.2, 0.15, 0.28] },
      { part: 'leg1', mesh: box(0.16, 0.3, 0.16, 0xbdb3a4, { tex: 'sheep_leg' }), pos: [0.2, 0.15, 0.28] },
      { part: 'leg2', mesh: box(0.16, 0.3, 0.16, 0xbdb3a4, { tex: 'sheep_leg' }), pos: [-0.2, 0.15, -0.28] },
      { part: 'leg3', mesh: box(0.16, 0.3, 0.16, 0xbdb3a4, { tex: 'sheep_leg' }), pos: [0.2, 0.15, -0.28] }
    ],
    nose: { build: () => box(0.18, 0.12, 0.06, 0xc2a08a), pos: [0, 0.6, 0.79] }
  },
  zombie: {
    name: '僵尸', hp: 14, hostile: true, damage: 3, reach: 1.6, speed: 2.4, burnInDay: true,
    drop: [{ item: 'rotten_flesh', count: 1, chance: 0.6 }],
    scale: 1,
    /* 本轮 C：僵尸补像素贴图（正面才有脸，侧面/顶面/底面各不相同），
       与骷髅/苦力怕/动物同一套「按面取图」的做法，不再是一个纯绿色盒子。 */
    parts: (c) => [
      { part: 'body', mesh: box(0.5, 0.62, 0.28, 0x2f6a52, { tex: 'zombie_body' }), pos: [0, 1.02, 0] },
      {
        part: 'head',
        mesh: box(0.46, 0.46, 0.46, 0x3f8a63, {
          faces: {
            front: 'zombie_head', back: 'zombie_head_side', side: 'zombie_head_side',
            top: 'zombie_head_top', bottom: 'zombie_head_top'
          }
        }),
        pos: [0, 1.56, 0]
      },
      { part: 'arm0', mesh: box(0.14, 0.56, 0.14, 0x357a58, { tex: 'zombie_arm' }), pos: [-0.33, 1.06, 0.16] },
      { part: 'arm1', mesh: box(0.14, 0.56, 0.14, 0x357a58, { tex: 'zombie_arm' }), pos: [0.33, 1.06, 0.16] },
      { part: 'leg0', mesh: box(0.16, 0.66, 0.16, 0x2b3b63, { tex: 'zombie_leg' }), pos: [-0.13, 0.34, 0] },
      { part: 'leg1', mesh: box(0.16, 0.66, 0.16, 0x2b3b63, { tex: 'zombie_leg' }), pos: [0.13, 0.34, 0] }
    ]
  },
  creeper: {
    /* T5：靠近玩家就开始嘶嘶充能，到点自爆（炸方块 + 按距离掉血）。
       没有 damage/reach —— 它不近战，伤害走爆炸那条路（见 game.js 的 onCreeperExplode）。 */
    name: '苦力怕', hp: 20, hostile: true, explode: true, speed: 2.5,
    drop: [{ item: 'gunpowder', count: 1, bonus: 1 }],
    scale: 1, w: 0.6, h: 1.7, parts: (c) => [
      /* 阶段 3b：身体/头用花斑绿皮（顶面压暗一档，逆光也分得开轮廓）；
         四条腿挪到前后分开（z ±0.19）并 pivot:'top' 绕髋转 ——
         斜侧视角里四条腿各自看得见，不再糊成一对。 */
      { part: 'body', mesh: box(0.5, 0.92, 0.34, 0x4faf4a, { faces: { front: 'creeper_skin', side: 'creeper_skin', back: 'creeper_skin', top: 'creeper_skin_dark', bottom: 'creeper_skin_dark' } }), pos: [0, 0.94, 0] },
      { part: 'head', mesh: box(0.42, 0.42, 0.42, 0x5cc256, { faces: { front: 'creeper_skin', side: 'creeper_skin', back: 'creeper_skin', top: 'creeper_skin_dark', bottom: 'creeper_skin_dark' } }), pos: [0, 1.56, 0] },
      { part: 'eye0', mesh: box(0.11, 0.11, 0.04, 0x141414), pos: [-0.11, 1.63, 0.22] },
      { part: 'eye1', mesh: box(0.11, 0.11, 0.04, 0x141414), pos: [0.11, 1.63, 0.22] },
      { part: 'mouth', mesh: box(0.16, 0.15, 0.04, 0x1a1a1a), pos: [0, 1.46, 0.22] },
      { part: 'mouthL', mesh: box(0.055, 0.09, 0.04, 0x1a1a1a), pos: [-0.055, 1.36, 0.22] },
      { part: 'mouthR', mesh: box(0.055, 0.09, 0.04, 0x1a1a1a), pos: [0.055, 1.36, 0.22] },
      { part: 'leg0', mesh: box(0.2, 0.44, 0.2, 0x43993f, { tex: 'creeper_leg', pivot: 'top' }), pos: [-0.16, 0.44, 0.19] },
      { part: 'leg1', mesh: box(0.2, 0.44, 0.2, 0x43993f, { tex: 'creeper_leg', pivot: 'top' }), pos: [0.16, 0.44, 0.19] },
      { part: 'leg2', mesh: box(0.2, 0.44, 0.2, 0x43993f, { tex: 'creeper_leg', pivot: 'top' }), pos: [-0.16, 0.44, -0.19] },
      { part: 'leg3', mesh: box(0.2, 0.44, 0.2, 0x43993f, { tex: 'creeper_leg', pivot: 'top' }), pos: [0.16, 0.44, -0.19] }
    ]
  },
  spider: {
    /* T4：敌对、能爬墙、不怕太阳、掉「线」。体型矮而宽（原版蜘蛛就是趴着冲过来的那种） */
    name: '蜘蛛', hp: 16, hostile: true, climb: true, damage: 3, reach: 1.8, speed: 2.9,
    drop: [{ item: 'string', count: 1, bonus: 1 }],
    scale: 1, w: 0.9, h: 1.0, parts: (c) => [
      { part: 'body', mesh: box(0.7, 0.42, 0.62, 0x3a2b2b), pos: [0, 0.42, -0.3] },
      { part: 'head', mesh: box(0.42, 0.3, 0.4, 0x4a3636), pos: [0, 0.38, 0.42] },
      { part: 'eye0', mesh: box(0.08, 0.08, 0.06, 0xd24040), pos: [-0.12, 0.46, 0.62] },
      { part: 'eye1', mesh: box(0.08, 0.08, 0.06, 0xd24040), pos: [0.12, 0.46, 0.62] },
      { part: 'leg0', mesh: box(0.5, 0.08, 0.1, 0x2f2424), pos: [-0.42, 0.34, 0.18] },
      { part: 'leg1', mesh: box(0.5, 0.08, 0.1, 0x2f2424), pos: [0.42, 0.34, 0.18] },
      { part: 'leg2', mesh: box(0.5, 0.08, 0.1, 0x2f2424), pos: [-0.42, 0.34, 0.0] },
      { part: 'leg3', mesh: box(0.5, 0.08, 0.1, 0x2f2424), pos: [0.42, 0.34, 0.0] },
      { part: 'leg4', mesh: box(0.5, 0.08, 0.1, 0x2f2424), pos: [-0.42, 0.34, -0.18] },
      { part: 'leg5', mesh: box(0.5, 0.08, 0.1, 0x2f2424), pos: [0.42, 0.34, -0.18] },
      { part: 'leg6', mesh: box(0.5, 0.08, 0.1, 0x2f2424), pos: [-0.42, 0.34, -0.36] },
      { part: 'leg7', mesh: box(0.5, 0.08, 0.1, 0x2f2424), pos: [0.42, 0.34, -0.36] }
    ]
  },
  wolf: {
    /* T6 狼：白天森林/草地生成；3 根骨头驯服（本作确定性简化），驯服后项圈变红。
       右键空手切换坐下/起身；坐下不动；起身后跟随玩家，并主动攻击附近的敌对生物。 */
    name: '狼', hp: 8, hostile: false, tameable: true, damage: 3, reach: 1.5, speed: 3.0,
    drop: [], scale: 0.8, parts: (c) => [
      { part: 'body', mesh: box(0.46, 0.4, 0.8, 0xb9b3aa), pos: [0, 0.48, -0.04] },
      { part: 'head', mesh: box(0.4, 0.36, 0.4, 0xc8c2b8), pos: [0, 0.64, 0.52] },
      { part: 'nose', mesh: box(0.18, 0.14, 0.12, 0x2c2a28), pos: [0, 0.6, 0.76] },
      { part: 'ear0', mesh: box(0.1, 0.16, 0.06, 0xa9a39a), pos: [-0.13, 0.86, 0.46] },
      { part: 'ear1', mesh: box(0.1, 0.16, 0.06, 0xa9a39a), pos: [0.13, 0.86, 0.46] },
      { part: 'collar', mesh: box(0.52, 0.1, 0.46, 0xb83a32), pos: [0, 0.55, 0.34] },
      { part: 'leg0', mesh: box(0.12, 0.3, 0.12, 0x9e988f), pos: [-0.15, 0.15, 0.25] },
      { part: 'leg1', mesh: box(0.12, 0.3, 0.12, 0x9e988f), pos: [0.15, 0.15, 0.25] },
      { part: 'leg2', mesh: box(0.12, 0.3, 0.12, 0x9e988f), pos: [-0.15, 0.15, -0.3] },
      { part: 'leg3', mesh: box(0.12, 0.3, 0.12, 0x9e988f), pos: [0.15, 0.15, -0.3] }
    ]
  },
  villager: {
    /* 滚动任务 6 + E2：村庄里的三名职业村民。被动、不会自然刷、离开村庄范围会自己走回去；
       外观按职业区分（草帽/眼镜与蓝袍/铁匠围裙与锤子），右键打开该职业自己的交易界面。 */
    name: '村民', hp: 20, passive: true, profession: 'farmer', noDespawn: true,
    desc: '村民', scale: 1, w: 0.6, h: 1.9,
    parts: (c, _sheared, _baby, profession) => {
      const p = normalizeVillagerProfession(profession);
      const look = p === 'librarian'
        ? { body: 0x405a7a, arm: 0x4d6888, leg: 0x2f3a4a }
        : p === 'blacksmith'
          ? { body: 0x3f3b36, arm: 0x8a5a3c, leg: 0x2b2824 }
          : { body: 0x6d4a2f, arm: 0x7d5535, leg: 0x3f2f24 };
      const list = [
        { part: 'body', mesh: box(0.5, 0.76, 0.34, look.body), pos: [0, 0.94, 0] },
        { part: 'head', mesh: box(0.44, 0.44, 0.44, 0xd8b48a), pos: [0, 1.6, 0] },
        { part: 'nose', mesh: box(0.12, 0.16, 0.16, 0xc79d75), pos: [0, 1.56, 0.27] },
        { part: 'arm0', mesh: box(0.14, 0.5, 0.18, look.arm), pos: [-0.34, 1.0, 0.02] },
        { part: 'arm1', mesh: box(0.14, 0.5, 0.18, look.arm), pos: [0.34, 1.0, 0.02] },
        { part: 'leg0', mesh: box(0.16, 0.46, 0.16, look.leg), pos: [-0.13, 0.32, 0] },
        { part: 'leg1', mesh: box(0.16, 0.46, 0.16, look.leg), pos: [0.13, 0.32, 0] }
      ];
      if (p === 'farmer') {
        list.push({ part: 'hat', mesh: box(0.52, 0.09, 0.52, 0xc9a24a), pos: [0, 1.84, 0] });
      } else if (p === 'librarian') {
        list.push({ part: 'hair', mesh: box(0.46, 0.1, 0.46, 0x5a4030), pos: [0, 1.83, 0] });
        list.push({ part: 'glasses0', mesh: box(0.11, 0.09, 0.04, 0x2a2a2a), pos: [-0.11, 1.63, 0.23] });
        list.push({ part: 'glasses1', mesh: box(0.11, 0.09, 0.04, 0x2a2a2a), pos: [0.11, 1.63, 0.23] });
        list.push({ part: 'glassesBridge', mesh: box(0.08, 0.03, 0.03, 0x2a2a2a), pos: [0, 1.63, 0.23] });
      } else {
        list.push({ part: 'apron', mesh: box(0.38, 0.5, 0.05, 0x6b2f27), pos: [0, 0.92, 0.19] });
        list.push({ part: 'band', mesh: box(0.46, 0.07, 0.46, 0x8c2f24), pos: [0, 1.8, 0] });
        list.push({ part: 'hammerHead', mesh: box(0.22, 0.14, 0.14, 0x8d949b), pos: [0.45, 1.08, 0.16] });
        list.push({ part: 'hammerGrip', mesh: box(0.06, 0.34, 0.06, 0x6b4a2f), pos: [0.45, 0.84, 0.16] });
      }
      return list;
    }
  },
  slime: {
    /* T6 史莱姆：会跳、被打死后分裂成更小的；最小的掉粘液球。
       尺寸 4/2/1，生命 = size²，伤害 4/2/0（最小史莱姆不咬人）。
       生成规则简化：夜间暗处地表（见 NIGHT_TYPES），不做沼泽/区块高度限制。 */
    name: '史莱姆', hp: 4, hostile: true, slime: true, split: true, sound: 'slime',
    damage: 2, reach: 1.6, speed: 2.0,
    drop: [{ item: 'slime_ball', count: 1, bonus: 2 }],
    scale: 1, parts: (c) => [
      { part: 'body', mesh: box(0.86, 0.86, 0.86, 0x6fbf5a), pos: [0, 0.43, 0] },
      { part: 'eye0', mesh: box(0.12, 0.12, 0.04, 0x1b2a1b), pos: [-0.16, 0.52, 0.44] },
      { part: 'eye1', mesh: box(0.12, 0.12, 0.04, 0x1b2a1b), pos: [0.16, 0.52, 0.44] },
      { part: 'mouth', mesh: box(0.2, 0.08, 0.04, 0x2d4a2d), pos: [0, 0.36, 0.44] }
    ]
  },
  skeleton: {
    name: '骷髅', hp: 12, hostile: true, ranged: true, damage: 2, reach: 12, speed: 2.2, burnInDay: true,
    drop: [{ item: 'bone', count: 1 }, { item: 'arrow', count: 1, chance: 0.5 }],
    scale: 1, parts: (c) => [
      /* 阶段 3b：躯干正面 = 肋骨 + 暗体腔，侧面/背面 = 脊柱；头正面 = 眼窝/鼻腔/齿列。
         四肢 pivot:'top' 绕肩/髋转、头 pivot:'bottom' 绕颈转 ——
         轮廓与旧版逐格相同（几何体挪半格 + 位置填关节高度），但甩腿抬手不再从中间折断。 */
      { part: 'body', mesh: box(0.4, 0.56, 0.22, 0xd8d8cf, { faces: { front: 'skeleton_ribs', side: 'skeleton_spine', back: 'skeleton_spine', top: 'skeleton_bone', bottom: 'skeleton_bone' } }), pos: [0, 1.04, 0] },
      { part: 'head', mesh: box(0.42, 0.42, 0.42, 0xe7e7de, { faces: { front: 'skeleton_skull_front', side: 'skeleton_skull_side', back: 'skeleton_skull_side', top: 'skeleton_skull_top', bottom: 'skeleton_bone' }, pivot: 'bottom' }), pos: [0, 1.33, 0] },
      { part: 'arm0', mesh: box(0.12, 0.52, 0.12, 0xcfcfc6, { tex: 'skeleton_bone', pivot: 'top' }), pos: [-0.3, 1.32, 0.1] },
      { part: 'arm1', mesh: box(0.12, 0.52, 0.12, 0xcfcfc6, { tex: 'skeleton_bone', pivot: 'top' }), pos: [0.3, 1.32, 0.1] },
      { part: 'leg0', mesh: box(0.13, 0.68, 0.13, 0xc4c4bb, { tex: 'skeleton_bone', pivot: 'top' }), pos: [-0.11, 0.68, 0] },
      { part: 'leg1', mesh: box(0.13, 0.68, 0.13, 0xc4c4bb, { tex: 'skeleton_bone', pivot: 'top' }), pos: [0.11, 0.68, 0] }
    ],
    bow: { part: 'bow', build: makeBowMesh, pos: [0.36, 1.10, 0.30] }
  },
  /* 阶段 5：地牢守卫（本作原创过渡 Boss）。不进 NIGHT_TYPES / DAY_TYPES，
     只由地标的稳定 ID 生成；noDespawn 保证走远再回来还在。
     外形沿用 box() 的按面材质与 pivot 关节，不新增贴图文件；
     胸口金色核心 + 橙色眼窝是「这是守卫不是普通敌怪」的辨识点。 */
  guardian: {
    name: '地牢守卫', hp: GUARDIAN_HP, hostile: true, guardian: true, noDespawn: true,
    speed: 1.9, damage: 0, reach: 3.4, scale: 1.35, w: 0.95, h: 2.35,
    drop: [],   /* 奖励由 game.js 按地点结算，不走普通掉落，避免重复发 */
    parts: (c) => [
      { part: 'body', mesh: box(0.86, 1.05, 0.5, 0x4a5560, { tex: 'guardian_body' }), pos: [0, 1.10, 0] },
      { part: 'core', mesh: box(0.28, 0.28, 0.06, 0xe8c65a, { tex: 'guardian_core' }), pos: [0, 1.16, 0.28] },
      {
        part: 'head',
        mesh: box(0.56, 0.5, 0.5, 0x39434d, {
          faces: {
            front: 'guardian_head', back: 'guardian_head_side', side: 'guardian_head_side',
            top: 'guardian_head_side', bottom: 'guardian_head_side'
          }
        }),
        pos: [0, 1.88, 0]
      },
      { part: 'eye0', mesh: box(0.10, 0.08, 0.05, 0xff6b3d, { tex: 'guardian_eye' }), pos: [-0.14, 1.92, 0.26] },
      { part: 'eye1', mesh: box(0.10, 0.08, 0.05, 0xff6b3d, { tex: 'guardian_eye' }), pos: [0.14, 1.92, 0.26] },
      { part: 'arm0', mesh: box(0.24, 0.90, 0.24, 0x5a6773, { pivot: 'top', tex: 'guardian_limb' }), pos: [-0.58, 1.62, 0] },
      { part: 'arm1', mesh: box(0.24, 0.90, 0.24, 0x5a6773, { pivot: 'top', tex: 'guardian_limb' }), pos: [0.58, 1.62, 0] },
      { part: 'leg0', mesh: box(0.28, 0.72, 0.28, 0x333c45, { pivot: 'top', tex: 'guardian_limb' }), pos: [-0.22, 0.72, 0] },
      { part: 'leg1', mesh: box(0.28, 0.72, 0.28, 0x333c45, { pivot: 'top', tex: 'guardian_limb' }), pos: [0.22, 0.72, 0] }
    ]
  }
};
export const MOB_TYPES = MOBS;
/* T4：夜里刷的敌对池与白天刷的动物池。导出成常量，好让「蜘蛛进了夜池、没进白池」这种
   事有用例可钉，而不是靠读 if/else 的肉眼判断。 */
export const NIGHT_TYPES = ['zombie', 'skeleton', 'spider', 'creeper', 'slime'];
export const DAY_TYPES = ['pig', 'cow', 'chicken', 'sheep', 'wolf'];
export const CLIMB_SPEED = 2.0;          // 蜘蛛贴墙上升速度（格/秒）

/* ---------- 阶段 3a：成群游动的鱼（确定性站点，不入库） ----------
 * AQUATIC_TYPES 单独成表，且 cod **不进 DAY_TYPES / NIGHT_TYPES** ——
 * 那两张表走的是「地表高度选点 + 亮度阈值」的陆上刷怪路径（findSpawnPoint 里 `h <= seaLevel` 直接跳过），
 * 鱼一旦混进去就会在海底或岸上刷出来。单测 FC.1 钉住这条隔离。 */
export const AQUATIC_TYPES = ['cod'];
export const FISH_SITE_STEP = 16;        // 每 16×16 列一个候选站点
export const FISH_SCHOOL_MIN = 4;        // 「成群」的下界（3 只以下看着像散兵）
export const FISH_SCHOOL_MAX = 6;
export const FISH_WATER_DEPTH = 3;       // 至少 3 格深的水体才住鱼（原版鳕鱼要求 2 格，本作取更稳的 3）
export const FISH_AIR_SECONDS = 20;      // 本作约定：离水 20 秒开始窒息（原版宽得多，这里要让「回到水里」有反馈）
export const FISH_MAX_ALIVE = 18;        // 同时存活的鱼上限（一帧一帧的 AI/物理成本要封顶）
export const FISH_SPAWN_INTERVAL = 1.1;  // 站点扫描节奏，与陆上刷怪同一把节拍器


/**
 * 某个 16×16 站点格里到底有没有鱼群、在哪儿、几条 —— 纯函数（种子 + 站点坐标）。
 * 与村庄/营地/地标同一套「确定性发现」做法：同一颗子任何时刻、任何机器算出同一个结果，
 * 于是「这群鱼属于哪一格」是个可复算的身份 —— 存档把它（sk）连同鱼本身一起存下，
 * 读档后站点扫描认出已被占用，不会在同一格里补第二群。
 * @returns {null|{sx:number, sz:number, key:string, x:number, z:number, count:number, seed:number}}
 */
export function fishSchoolOf(seed, sx, sz) {
  const h = ihash2(sx, sz, (seed >>> 0) ^ 0xF15415);
  if (h % 100 < 42) return null;                       // 约 42% 的格子是鱼群候选
  const rand = mulberry32(h >>> 0);
  const ox = Math.floor(rand() * FISH_SITE_STEP);
  const oz = Math.floor(rand() * FISH_SITE_STEP);
  const count = FISH_SCHOOL_MIN + Math.floor(rand() * (FISH_SCHOOL_MAX - FISH_SCHOOL_MIN + 1));
  return {
    sx, sz,
    key: sx + ',' + sz,
    x: sx * FISH_SITE_STEP + ox + 0.5,
    z: sz * FISH_SITE_STEP + oz + 0.5,
    count, seed: h >>> 0
  };
}

let _geoCache = null;
function makeMesh(type, sheared, baby, profession) {
  const def = MOBS[type];
  const g = new THREE.Group();
  const parts = {};
  for (const p of def.parts(undefined, sheared, baby, profession)) { g.add(p.mesh); parts[p.part] = p.mesh; p.mesh.position.set(...p.pos); }
  for (const extra of ['nose', 'horn', 'beak', 'bow']) {
    const e = def[extra];
    if (!e) continue;
    /* 阶段 3b：附加件每次**新建**一个实例。原来是 `def[extra].mesh` 这个模块级共享对象
       —— 两只猪会把同一根鼻子抢来抢去（后生成的那只把上一只的摘走），
       骷髅的弓更明显：一把弓在几只骷髅之间跳。 */
    const m = e.build ? e.build() : e.mesh;
    m.position.set(...e.pos);
    m.userData.extra = extra;
    g.add(m);
    if (e.part) parts[e.part] = m;          // 要被姿态驱动的附加件（骷髅的弓）注册进 parts
  }
  // 眼睛（敌怪更明显）
  const eyeMat = new THREE.MeshBasicMaterial({ color: def.hostile ? 0xff5a3c : 0x1a1a1a });
  /* 阶段 3b：已经有自己的眼睛部件（苦力怕的 eye0/eye1、蜘蛛的红色眼）就不要再钉一对通用眼，
     否则小方块会盖在脸上的大方块前面，苦力怕那张脸就糊了。 */
  if (parts.head && !parts.eye0) {
    const head = parts.head;
    const hp = head.geometry.parameters;
    /* pivot 把头部几何体挪了半格，眼睛的局部 Y 要跟着挪回去，
       否则换了转轴之后眼睛会掉到下巴上（世界位置必须与旧版一致）。 */
    const eyeY = 0.06 + (head.userData.pivot === 'bottom' ? hp.height / 2
      : head.userData.pivot === 'top' ? -hp.height / 2 : 0);
    for (const sx of [-0.11, 0.11]) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, 0.03), eyeMat);
      e.position.set(sx, eyeY, hp.depth / 2 + 0.02);
      head.add(e);
    }
  }
  g.scale.setScalar((def.scale || 1) * (baby ? BABY_SCALE : 1));
  g.userData.parts = parts;
  return g;
}

/* ---------- 实体 ---------- */
/* P0：受击叠色（纯函数，可无头单测）。
 * 旧做法把整个模型涂成 0xff4040，远看就是一团纯红剪影，认不出是什么生物；
 * 现在只在红通道叠 38%、绿蓝各压到 78%，保留原来的明度与色相。 */
export function hurtTint(baseHex) {
  const base = Math.max(0, Math.min(0xffffff, baseHex | 0));
  const r = (base >> 16) & 255, g = (base >> 8) & 255, b = base & 255;
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return (ch(r * 0.62 + 255 * 0.38) << 16) | (ch(g * 0.78) << 8) | ch(b * 0.78);
}

/* 羊毛再生：本作按「时间」长回毛（原版要羊吃草才长），90 秒是一个不打扰游玩又看得见的节奏 */
/* A：轻量姿态计算（纯函数，不碰 THREE/DOM，可在 Node 单测）。
 * 只读 m 上的当前动画字段（animAttack / hurtT / age / moving / animIdle），返回各部件目标角度；
 * render() 负责应用，update 循环负责衰减 animAttack —— 姿态本身**不扣时间**，
 * 否则同帧里 update 与 computePose 各减一次 dt，攻击动画会提前一半结束（单测 A1 钉住这条）。
 * 刻意不动 position / 碰撞 / AI / 生命周期，也不产出 rotation.y（D3 回归钉死身体朝向）。
 * dt 保留在签名里（计划要求）但对输出无影响。 */
export const MOB_ATTACK_POSE_SECONDS = 0.36;
export const MOB_POSE_LIMITS = { arm: 2.6, head: 0.45, headYaw: 0.22, bodyScale: 0.06, tilt: 0.16, front: 0.9 };
const clamp = (v, k) => Math.max(-MOB_POSE_LIMITS[k], Math.min(MOB_POSE_LIMITS[k], v));
export function computePose(m, dt = 0.016) {
  const attackT = Math.max(0, Math.min(MOB_ATTACK_POSE_SECONDS, m.animAttack || 0));
  const atk = attackT > 0 ? Math.sin((1 - attackT / MOB_ATTACK_POSE_SECONDS) * Math.PI) : 0;
  const hurt = m.hurtT > 0 ? Math.min(1, m.hurtT / 0.32) : 0;
  const t = (m.age || 0) * (m.moving ? 9 : 2.2);
  const leg = Math.sin(t) * (m.moving ? 0.55 : 0.06);
  const hostile = !!(m.def && m.def.hostile);
  const ph = m.animIdle || 0;
  return {
    attackT, atk, hurt,
    /* legSwing 把 render 里用到的步态摆动项一起交出去：
       前腿最终角度 = legSwing - atkFront，测试才能把「前扑」从「走路甩腿」里剥出来看 */
    legSwing: leg,
    arm0: clamp((hostile ? -1.4 : leg) - atk * 1.1, 'arm'),
    arm1: clamp((hostile ? -1.4 : -leg) - atk * 1.1, 'arm'),
    headX: clamp(-atk * 0.18 + hurt * 0.35, 'head'),
    headY: clamp(Math.sin((m.age || 0) * 0.7 + ph) * MOB_POSE_LIMITS.headYaw * (1 - atk) * (1 - hurt), 'headYaw'),
    bodyScaleY: 1 + clamp(Math.sin((m.age || 0) * 1.9 + ph) * 0.018 - hurt * 0.04, 'bodyScale'),
    tiltZ: clamp(hurt * 0.13 * (ph % 2 < 1 ? 1 : -1), 'tilt'),
    atkFront: clamp(atk * 0.85, 'front'),
    /* 阶段 3a（只新增字段，既有输出一字不动）：鱼的尾鳍左右扫。
       用与步态同一个 age/moving 驱动，所以「游得快摆得快」不需要额外状态；
       只旋转 tail 部件，绝不碰 mesh.rotation.y（D3 钉死身体朝向只由 yaw 决定）。 */
    finSwim: Math.sin((m.age || 0) * (m.moving ? 7.5 : 2.6)) * (m.moving ? 0.55 : 0.12),
    /* 阶段 3b（只新增字段，既有输出一字不动）：骷髅的拉弓进度。
       直接读 m.bowDraw —— 秒数由 AI 推进，姿态本身不扣时间（与 animAttack 同一口径，A1 钉过这条）。
       render 只拿它摆「弓弦两段 + 搭着的箭」，**不碰 arm0/arm1**：
       A.1 要求 applied.arm0 与 pose.arm0 逐位相等，手臂数值由姿态独占。 */
    bowDraw: Math.max(0, Math.min(1, m.bowDraw || 0)),
    nock: !!(m.bowDraw > 0),
    /* 阶段 3c（只新增字段，既有输出一字不动）：翅膀与尾舵。
       数值全部由 m.flapPhase / m.phase / m.vel 推出来，姿态本身不扣时间（与 A1 同一口径）；
       非飞行生物三项恒为 0，所以猪/牛/羊/骷髅那些既有姿态读数一个都不会变。
       振幅有界：|wingFlap| ≤ BIRD_FLAP_MAX；停栖只留 BIRD_PERCH_FLAP 的微颤（收拢轮廓），
       hover 巡游保留半幅慢拍，fly 全幅。 */
    wingFlap: (m.def && m.def.flying)
      ? Math.sin(m.flapPhase || 0) * (m.phase === 'fly' ? BIRD_FLAP_MAX : (m.phase === 'perched' ? BIRD_PERCH_FLAP : BIRD_FLAP_MAX * 0.45))
      : 0,
    wingFold: (m.def && m.def.flying && m.phase === 'perched') ? BIRD_GLIDE_FLAP : 0,
    rudder: (m.def && m.def.flying)
      ? Math.max(-0.45, Math.min(0.45, (m.turnRate || 0) * 0.3))
      : 0
  };
}

export const SHEEP_REGROW_SECONDS = 90;
export const BABY_GROW_SECONDS = 120;      /* 幼崽长大所需秒数 */
export const BREED_COOLDOWN_SECONDS = 60;  /* 生完之后父母多久不能再繁殖 */
export const BREED_PARTNER_RANGE = 8;      /* 配偶搜索半径（格） */
export const TAME_BONES = 3;               /* 本作简化：3 根骨头必定驯服，不做随机概率 */
export const WOLF_FOLLOW_RANGE = 4;        /* 超过这个距离才开始跟随 */
export const WOLF_ATTACK_RANGE = 1.5;      /* 狼近战距离 */
export const WOLF_HUNT_RANGE = 10;         /* 主动寻找敌对生物的距离 */
export const BABY_SCALE = 0.55;            /* 幼崽的模型与碰撞盒缩放 */
export const SEPARATION_RATE = 14;         /* 生物互相推开的逼近速率（约 0.07 秒收敛，观感是「挤一下让位」） */

export class Mob {
  constructor(type, x, y, z, scene, opts) {
    const baby = !!(opts && opts.baby);
    this.type = type;
    this.uid = ++MOB_UID;            // 阶段 3c：内存序号，只给验收脚本盯「同一只」用，不入库
    const def = MOBS[type];
    this.def = def;
    this.name = def.name;
    /* E2：村民职业由生成参数决定（旧存档没有字段 → 农夫），影响外观、交易表与存档字段。 */
    this.profession = type === 'villager'
      ? normalizeVillagerProfession(opts && opts.profession)
      : null;
    /* T6 史莱姆尺寸：4/2/1；生命 = size²，伤害 4/2/0，碰撞盒随尺寸走 */
    this.slimeSize = def.slime
      ? Math.max(1, Math.min(4, (opts && opts.slimeSize) || (Math.random() < 0.5 ? 1 : 2)))
      : 0;
    this.hp = def.slime ? this.slimeSize * this.slimeSize : def.hp;
    this.maxHp = this.hp;
    this.damage = def.slime ? (this.slimeSize >= 4 ? 4 : this.slimeSize >= 2 ? 2 : 0) : (def.damage || 0);
    this.hopT = 0.35 + Math.random() * 0.7;
    /* T6 狼：驯服/坐下/项圈状态（不入库时默认未驯服） */
    this.tamed = false;
    this.sitting = false;
    this.tameProgress = 0;
    this.collar = null;
    /* 滚动任务 6：村民的“家”坐标（只有村庄村民有；离开太远会自己走回去） */
    this.home = opts && opts.home ? { x: opts.home.x, y: opts.home.y, z: opts.home.z } : null;
    this.pos = { x, y, z };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = Math.random() * Math.PI * 2;
    this.onGround = false;
    this.age = 0;
    this.wanderT = 0;
    this.attackCd = 0;
    this.hurtT = 0;
    /* A：动画瞬态，刻意不入库（读档后从静止开始，不残留半截姿态） */
    this.animAttack = 0;
    this.animIdle = Math.random() * Math.PI * 2;
    this.fire = 0;
    this.isBaby = baby;            // 幼崽：模型与碰撞盒都缩小，不能繁殖
    this.growT = baby ? BABY_GROW_SECONDS : 0;
    this.breedCd = 0;              // 繁殖冷却
    this.sheared = false;        // 仅羊用：被剪过毛
    this.regenT = 0;             // 剪过后长回毛的倒计时（秒）
    this.mesh = makeMesh(type, false, baby, this.profession);
    if (def.slime) this.mesh.scale.setScalar(0.36 * this.slimeSize);
    if (def.tameable) {
      this.collar = (this.mesh.userData.parts || {}).collar || null;
      if (this.collar) this.collar.visible = false;
    }
    this.mesh.position.set(x, y, z);
    scene.add(this.mesh);
    const bs = baby ? BABY_SCALE : 1;
    if (def.slime) {
      this.width = 0.38 * this.slimeSize;
      this.height = 0.38 * this.slimeSize;
    } else {
      this.width = (def.w || (def.hostile ? 0.6 : 0.6 * (def.scale || 1))) * bs;
      this.height = (def.h || (def.hostile ? 1.9 : 0.9) * (def.scale || 1)) * bs;
    }
    this.dead = false;
    this.inWater = 0;
    this.fuse = CREEPER_FUSE_SECONDS;   // T5：苦力怕充能倒计时（不入库：读档后不该突然爆炸）
    this.charging = false;               // 正在嘶嘶充能（模型会胀大闪白）
    /* 阶段 3b：骷髅「先拉后放」——drawing/drawT/bowDraw 都是动画态，和 fuse 一样**不入库**：
       读档不该读到半张的弓（否则一进场就有一支莫名其妙的箭飞出来）。
       fuseStage = 引信走到第几档（0/1/2），只由当帧的 fuse 算出来，供观感与验收读取。 */
    this.drawing = false;
    this.drawT = 0;
    this.bowDraw = 0;
    this.fuseStage = 0;
    this.hissT = 0;                      // 嘶声节拍倒计时（越接近爆炸叫得越急）
    this.climbing = false;      // T4：蜘蛛贴墙上升中（每帧由 ai() 重新判定，不持久化）
    this.climbStuck = 0;        // 爬不动的累计秒数（顶到天花板时用来放弃，不许贴墙抖）
    /* 阶段 3a 水生：school = 所属的确定性站点键（入库为 sk，见 serialize/applySaved：
       不存的话读档后站点认不出这群鱼，会在同一格里再刷一群），
       homeY = 它要游回去的水深，airT = 离水累计秒数（超过 FISH_AIR_SECONDS 开始窒息） */
    this.school = null;
    this.homeX = x;
    this.homeZ = z;
    this.homeY = y;
    this.airT = 0;
    /* 阶段 3c 飞行：birdSite = 这只鸟所属的确定性林冠站点键（入库为 bk，读档后站点扫描才认得出它，
       不会在同一列里补第二群），perch = 它停的那个树冠格（入库为 px/py/pz）。
       phase / flapPhase / turnRate / flyT / perchT / hoverT / flyTo / heading 全是动画态，
       与 fuse、drawing 同一口径**不入库**：读档不该读到一只「正在半空中转弯」的鸟，
       它落地重新从停栖开始即可。undergroundSpawn 只标记「这一只是从地下通路刷出来的」，
       用于洞穴总量上限与验收读数，同样不入库。 */
    this.birdSite = null;
    this.perch = null;
    this.phase = 'perched';
    this.flapPhase = 0;
    this.turnRate = 0;
    this.flyT = 0;
    this.perchT = 0;
    this.hoverT = 0.5;
    this.flyTo = null;
    this.heading = 0;
    this.undergroundSpawn = false;
  }

  get eyeY() { return this.pos.y + this.height * 0.85; }

  /** 驯服状态：项圈显隐同步（模型与状态不能只改一个） */
  setTamed(v) {
    this.tamed = !!v;
    this.tameProgress = this.tamed ? TAME_BONES : 0;
    if (this.collar) this.collar.visible = this.tamed;
    return this.tamed;
  }

  /* 幼崽 <-> 成年：换模型并同步碰撞盒尺寸（不能只改外观） */
  setBaby(v, scene) {
    const b = !!v;
    if (this.isBaby === b) return false;
    this.isBaby = b;
    const bs = b ? BABY_SCALE : 1;
    this.width = (this.def.w || (this.def.hostile ? 0.6 : 0.6 * (this.def.scale || 1))) * bs;
    this.height = (this.def.h || (this.def.hostile ? 1.9 : 0.9) * (this.def.scale || 1)) * bs;
    const old = this.mesh;
    const px = old.position.x, py = old.position.y, pz = old.position.z, ry = old.rotation.y;
    this.mesh = makeMesh(this.type, this.sheared, b, this.profession);
    this.mesh.position.set(px, py, pz);
    this.mesh.rotation.y = ry;
    if (scene) scene.add(this.mesh);
    this.removeMesh(old, scene);
    return true;
  }

  remove(scene) {
    scene.remove(this.mesh);
    this.mesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (Array.isArray(o.material)) { for (const mm of o.material) mm.dispose(); }
      else if (o.material) o.material.dispose();
    });
  }

  /* 剪毛 / 长回毛：换一套模型，位置朝向保持不变 */
  setSheared(v, scene) {
    const s = !!v && !!this.def.shearable;
    if (this.sheared === s) return false;
    this.sheared = s;
    const old = this.mesh;
    const p = { x: old.position.x, y: old.position.y, z: old.position.z, ry: old.rotation.y };
    this.mesh = makeMesh(this.type, s, false, this.profession);
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.rotation.y = p.ry;
    if (scene) scene.add(this.mesh);
    this.removeMesh(old, scene);
    return true;
  }

  removeMesh(mesh, scene) {
    if (!mesh) return;
    if (scene) scene.remove(mesh);
    mesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      /* 阶段 3b：贴图盒子用的是六面材质数组，dispose 要逐面走（数组上没有 .dispose） */
      if (Array.isArray(o.material)) { for (const mm of o.material) mm.dispose(); }
      else if (o.material) o.material.dispose();
    });
  }

  serialize() {
    const o = { t: this.type, x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw, hp: this.hp };
    if (this.isBaby) o.bb = Math.round(this.growT);
    if (this.breedCd > 0) o.bc = Math.round(this.breedCd);
    if (this.sheared) { o.sh = 1; o.rt = Math.round(this.regenT); }   // 只给剪过的羊多写两个字段，旧档格式不变
    if (this.def.slime) o.sl = this.slimeSize;                        // 旧档没有 sl → 生成时随机 1/2
    if (this.def.tameable && this.tamed) { o.tm = 1; if (this.sitting) o.st = 1; }
    if (this.type === 'villager' && this.home) {                      // 村民的巡逻中心；旧档没有就不写
      o.hx = +this.home.x.toFixed(2); o.hy = +this.home.y.toFixed(2); o.hz = +this.home.z.toFixed(2);
      o.pr = this.profession || 'farmer';                             // 旧档没有 pr → 读成农夫
    }
    /* 阶段 3a：鱼群的身份必须入库。站点键 sk 是「这一群属于哪个 16×16 站点」的唯一凭据，
       读档后若丢了它，站点扫描会认不出已有鱼群、在一格里反复刷群直到 FISH_MAX_ALIVE，
       把生物列表灌满（实测污染了以列表为准的其他断言）。fx/fy/fz = 它要游回去的那一点。
       没有站点的生物（陆上动物、旧档）一个字都不多写，存档格式保持原样。 */
    if (this.school) {
      o.sk = this.school;
      o.fx = +this.homeX.toFixed(2); o.fy = +this.homeY.toFixed(2); o.fz = +this.homeZ.toFixed(2);
    }
    /* 阶段 3c：只有带站点的鸟多写这四个字段（bk + 栖点三坐标），
       其它生物的存档载荷逐字节不变 —— 「存档格式兼容旧档」这条不许被顺手扩大。 */
    if (this.birdSite) {
      o.bk = this.birdSite;
      if (this.perch) {
        o.px = +this.perch.x.toFixed(2); o.py = +this.perch.y.toFixed(2); o.pz = +this.perch.z.toFixed(2);
      }
    }
    return o;
  }
}

/* 阶段 3b 取证读数（只读，不改任何行为）：
   mobSkinReadout —— 这个生物的模型到底用了哪些贴图、几个面、转轴在哪、纹理真的挂上了没有；
   limbPivotRead  —— 把肢体转一个角度，看「关节端」和「末端」各走了多远：
                      绕关节转 = 关节端几乎不动、末端大幅划弧；绕中间转（旧版）两端一起被甩。 */
export function mobSkinReadout(type, sheared = false) {
  /* 阶段 6 封版：允许读「剪过毛」状态的模型，PN.1 才能验证身体贴图不是头部贴图。
     默认仍是未剪毛，旧调用点一字不改。 */
  const g = makeMesh(type, !!sheared, false, null);
  const out = { type, sheared: !!sheared, parts: [], extras: [] };
  for (const key of Object.keys(g.userData.parts || {})) {
    const o = g.userData.parts[key];
    const mats = o.isMesh ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    out.parts.push({
      part: key,
      tex: o.userData.tex || null,
      pivot: o.userData.pivot || null,
      faces: o.isMesh ? mats.length : null,
      hasMap: mats.length > 0 && mats.every(m => !!(m.map && m.map.image)),
      texSize: mats[0] && mats[0].map && mats[0].map.image ? mats[0].map.image.width : null
    });
  }
  for (const c of g.children) {
    if (c.userData && c.userData.extra) out.extras.push({ extra: c.userData.extra, tex: c.userData.tex || null, children: c.children.length });
  }
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (Array.isArray(o.material)) { for (const mm of o.material) mm.dispose(); }
    else if (o.material) o.material.dispose();
  });
  return out;
}

export function limbPivotRead(m, part, rotX = 0.6) {
  const o = m && m.mesh && m.mesh.userData.parts && m.mesh.userData.parts[part];
  if (!o || !o.isMesh) return null;
  const geo = o.geometry;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const pv = o.userData.pivot || null;
  const jointY = pv === 'top' ? bb.max.y : pv === 'bottom' ? bb.min.y : 0;
  const tipY = pv === 'top' ? bb.min.y : pv === 'bottom' ? bb.max.y : 0;
  const v = new THREE.Vector3();
  const saved = o.rotation.x;
  const pt = (y, ang) => {
    o.rotation.x = ang;
    o.updateWorldMatrix(true, false);
    v.set(0, y, 0).applyMatrix4(o.matrixWorld);
    /* 三个轴都要读：整组模型按 yaw 旋转过，只算 (y,z) 会把腿的一部分摆动藏进 x 里
       （实测 0.259 的位移被低估成 0.111）。 */
    return { x: +v.x.toFixed(4), y: +v.y.toFixed(4), z: +v.z.toFixed(4) };
  };
  const joint0 = pt(jointY, 0), jointR = pt(jointY, rotX);
  const tip0 = pt(tipY, 0), tipR = pt(tipY, rotX);
  o.rotation.x = saved;
  o.updateWorldMatrix(true, false);
  const shift = (a, b) => +Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z).toFixed(4);
  return {
    part, pivot: pv, rotX,
    pos: [+o.position.x.toFixed(4), +o.position.y.toFixed(4), +o.position.z.toFixed(4)],
    joint0, jointR, tip0, tipR,
    jointShift: shift(joint0, jointR), tipShift: shift(tip0, tipR),
    height: +(geo.parameters.height).toFixed(4)
  };
}

/* ---------- 管理器 ---------- */
export class MobManager {
  constructor(ctx) {
    this.ctx = ctx;             // {world, scene, game, sfx, controller, particles}
    this.list = [];
    this.arrows = [];
    this.maxMobs = 26;
    this.spawnTimer = 0;
    this.fishTimer = 0;              // 阶段 3a：鱼群站点扫描的独立节拍（不与陆上刷怪互相抢）
    /* 阶段 3c：地下敌怪与林冠鸟群也各自有自己的节拍 —— 谁都不许抢别人的那一次机会，
       但**总量闸只有一把**（maxMobs），四条通路都必须听它，否则关掉自然刷怪的验收段会被偷偷灌满。 */
    this.caveTimer = 0;
    this.birdTimer = 0;
    /* 阶段 5：守卫的状态由 game.js 的 meta.guardian 按地点稳定 ID 持久化，
       这里只持有一份运行时副本；临时相位不跨读档（normalizeGuardianState 负责）。
       _guardianArmed/_guardianWards 是「石座封印」的实况（每 0.6 秒由 game.js 重算），
       不进 state —— 它可以从世界方块直接读出来，落盘会多一份可失同步的副本。 */
    this.guardianSite = null;
    this.guardianState = null;
    this._guardianArmed = true;
    this._guardianWards = 0;
    this._guardianLockedHint = 0;
    /* 「出招」计数与最后一发读数：STRIKE 只占一帧，靠外部按 50ms 采样去撞它会漏。
       验收与 HUD 都读这两个计数器，就不必赌采样时机。 */
    this.guardianStrikes = 0;
    this.guardianLastFire = null;
    this._guardianSealHint = 0;
    this.scene = ctx.scene;
  }

  spawn(type, x, y, z, opts) {
    if (!MOBS[type]) return null;
    const m = new Mob(type, x, y, z, this.scene, opts);
    /* 生成点可能来自相邻列的高度：先做一次有界脱嵌，别让生物从实心土里开始。
       只向上找，不水平改坐标；四格内没有空位时仍保留原位置，交由后续物理处理。 */
    if (this.mobAABBBlocked(m, x, y, z)) {
      for (let dy = 1; dy <= 4; dy++) {
        if (!this.mobAABBBlocked(m, x, y + dy, z)) {
          m.pos.y = y + dy;
          m.mesh.position.y = m.pos.y;
          break;
        }
      }
    }
    this.list.push(m);
    return m;
  }

  count() { return this.list.length; }

  clear() {
    for (const m of this.list) m.remove(this.scene);
    this.list.length = 0;
    for (const a of this.arrows) this.scene.remove(a.mesh);
    this.arrows.length = 0;
  }

  /* 世界坐标处是否适合站怪 */
  canStandAt(x, y, z) {
    const w = this.ctx.world;
    if (!w.isSolidAt(Math.floor(x), Math.floor(y - 0.1), Math.floor(z))) return false;
    if (w.isSolidAt(Math.floor(x), Math.floor(y), Math.floor(z))) return false;
    if (w.isSolidAt(Math.floor(x), Math.floor(y + 1), Math.floor(z))) return false;
    if (w.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === B.WATER) return false;
    return true;
  }

  /**
   * 这一格到底能不能刷（阶段 3c 把判据抽出来，是为了让「同一点位插火把前后」的 A/B
   * 能直接量这一个函数，而不是靠随机采样去撞——红的时候要说得出是「不够暗」还是「站不住」。
   * 敌对：局部亮度必须 ≤ SPAWN_DARK_LIMIT（原版与本作一致：亮度数的是**那一点**的局部光）；
   * 动物：必须 ≥ SPAWN_DAY_LIGHT（要在亮处）。两者都还要 canStandAt（脚下实心 + 自身与头顶空 + 不在水里）。
   */
  spawnSiteOk(hostile, x, y, z, dayFactor) {
    const w = this.ctx.world;
    if (!this.canStandAt(x, y, z)) return { ok: false, why: 'standable', light: null };
    const light = w.brightnessAt(Math.floor(x), Math.floor(y), Math.floor(z), dayFactor);
    if (hostile) return light > SPAWN_DARK_LIMIT ? { ok: false, why: 'light', light } : { ok: true, why: 'dark', light };
    return light < SPAWN_DAY_LIGHT ? { ok: false, why: 'dark', light } : { ok: true, why: 'light', light };
  }

  /** 头顶是否通透见到天（用来区分「真正的洞穴」与「地表凹坑」：后者仍然被天光照亮） */
  exposedToSky(x, y, z) {
    const w = this.ctx.world;
    const fy = Math.floor(y);
    const top = Math.min(w.topY - 1, fy + UNDERGROUND_SCAN_UP);
    for (let yy = fy + 1; yy <= top; yy++) if (w.isSolidAt(Math.floor(x), yy, Math.floor(z))) return false;
    return true;
  }

  /**
   * 阶段 3c：陆上那一路还能用多少额度（只读，update 与验收都用这一个数）。
   * `maxMobs` 是陆上 / 水域 / 林冠 / 地下**共用的一把总量闸**。
   * 在只有陆上一路的时候这把闸没有问题；加上地下通路之后实测：玩家站在洞里 15 秒，
   * 26 个格子被「头顶看不见的地表动物」占满（陆上节拍 1.1 秒一只，洞穴节拍 3.3 秒一次），
   * 地下通路一次机会都抢不到 —— 任务书要的「给鱼、鸟、敌怪保留合理机会」落不了地。
   * 规则：玩家不在地表时，给洞穴与林冠各留一段自己的额度（它们本来就还有各自的上限），
   *       陆上一路最多用到 `maxMobs −（SPAWN_CAVE_CAP + BIRD_MAX_ALIVE）`；
   *       玩家回到地表，留量为 0，地表刷怪口径与旧版逐格相同（阈值、节拍、分档都没动）。
   * @returns {number} 陆上通路可用的总量上限（仍与 maxMobs 一起构成硬顶）
   */
  playerUnderground() {
    const c = this.ctx.controller, w = this.ctx.world;
    if (!w || !c) return false;
    return c.pos.y <= w.surfaceHeight(Math.floor(c.pos.x), Math.floor(c.pos.z)) - 2;
  }

  landSpawnCap() {
    if (!this.playerUnderground()) return this.maxMobs;  // 在地表：与旧版完全一致
    const reserve = Math.min(this.maxMobs, SPAWN_CAVE_CAP + BIRD_MAX_ALIVE);
    return Math.max(0, this.maxMobs - reserve);
  }

  /**
   * 阶段 3c：水域（鱼群）与林冠（鸟群）那两路能用的额度。
   * 玩家在地表 → 就是 maxMobs，阶段 3a/3b 的口径一字未改；
   * 玩家在地下 → 先给洞穴通路留出 SPAWN_CAVE_CAP 格，其余才归地表那三路分。
   * 为什么这一条也必须留：实测玩家站在洞里时「鱼 18 + 鸟 6 = 24」先把闸吃满，
   * 洞穴那一路只剩 2 格，正午地下的风险又变成了一件碰运气的事
   * （CV.1 第一轮读数 total=27、caveHostiles=1 就是这个形状 —— 而且是**溢出**了总量闸，
   *   根因见 spawnFishSchools 里那条逐条复查）。
   * @returns {number}
   */
  surfaceSpawnCap() {
    if (!this.playerUnderground()) return this.maxMobs;
    return Math.max(0, this.maxMobs - Math.min(this.maxMobs, SPAWN_CAVE_CAP));
  }

  findSpawnPoint(hostile, dayFactor) {
    const c = this.ctx.controller, w = this.ctx.world;
    for (let tries = 0; tries < 14; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = hostile ? 16 + Math.random() * 26 : 14 + Math.random() * 30;
      const x = c.pos.x + Math.cos(ang) * dist, z = c.pos.z + Math.sin(ang) * dist;
      const h = w.surfaceHeight(Math.floor(x), Math.floor(z));
      if (h <= w.seaLevel) continue;
      const y = h + 1;
      if (y > WORLD_H - 3) continue;
      /* 判据抽到 spawnSiteOk：阈值还是那两个（0.34 / 0.5），一字未改 */
      const site = this.spawnSiteOk(hostile, x, y, z, dayFactor);
      if (!site.ok) continue;
      return { x, y, z };
    }
    return null;
  }

  /**
   * 阶段 3c：地下敌怪候选点。
   * 原来只有 findSpawnPoint 那一条地表通路，它对 `h <= seaLevel` 直接 continue，
   * 而且候选高度永远取 `surfaceHeight + 1` —— 等于「敌怪永远不在地下刷」，
   * 于是「白天地下有风险、插火把之后风险下降」这件事在本作里根本不存在。
   * 这里改成在玩家附近的**柱子里**找一个埋深的候选格：
   *   ① 埋深在 [UNDERGROUND_MIN_COVER, UNDERGROUND_MAX_DEPTH] 之间（头顶至少要盖几格才算地下）；
   *   ② 通透见到天的格子不算（那是地表凹坑，仍然被天光照着）；
   *   ③ 亮度与可站立一律走 spawnSiteOk 那一份判据（同一条代码，A/B 才可比）。
   * 节拍与总量闸由调用方（update）拿 maxMobs 与 SPAWN_CAVE_INTERVAL 管，
   * 与陆上/水域刷怪共用同一把闸，不会各自超量。
   *
   * 为什么是「把整根柱子扫一遍」而不是「在带里随机取一个 y」：
   * 埋深带有 UNDERGROUND_MAX_DEPTH−UNDERGROUND_MIN_COVER≈24 格，而天然洞穴只占其中一两格。
   * 一次只撞一个 y 的写法实测每 14 次尝试约命中 1.5%（取证见 app/tests/probe-underground.mjs），
   * 换算成「玩家站在洞里 15 秒」平均刷不出 0.2 只 —— 等于这条通路形同不存在。
   * 扫描版本命中 95% 以上，而且**判据一字未改**：通不过 spawnSiteOk 的格子照样不刷。
   * 顶盖测试每根柱子只做一次（取带顶 yTop）：被盖住的格子，它下面的格子也一定被盖住。
   */
  findUndergroundSpawnPoint(dayFactor) {
    const c = this.ctx.controller, w = this.ctx.world;
    for (let tries = 0; tries < UNDERGROUND_TRIES; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = SPAWN_UNDERGROUND_MIN_DIST + Math.random() * SPAWN_UNDERGROUND_RANGE;
      const x = c.pos.x + Math.cos(ang) * dist, z = c.pos.z + Math.sin(ang) * dist;
      const fx = Math.floor(x), fz = Math.floor(z);
      const surf = w.surfaceHeight(fx, fz);
      const yTop = surf - UNDERGROUND_MIN_COVER;
      const yBot = Math.max(w.minY + 2, surf - UNDERGROUND_MAX_DEPTH);
      if (yTop <= yBot) continue;                       // 这根柱子没那么深的地方
      if (yTop < w.minY + 1 || yTop >= w.topY - 2) continue;
      if (this.exposedToSky(x, yTop, z)) continue;      // 见到天 → 整根柱子都算地表
      let cells = 0, pick = null;
      for (let y = yBot; y <= yTop; y++) {
        const site = this.spawnSiteOk(true, x, y, z, dayFactor);
        if (!site.ok) continue;
        cells++;                                        // 蓄水池抽样：不分配数组也能等概率取一个
        if (Math.random() < 1 / cells) pick = { x, y, z, light: site.light, underground: true };
      }
      if (pick) return pick;
    }
    return null;
  }

  /**
   * 生物 AABB 在 (x,y,z) 是否与实心方块相交。
   * 注意：这里不能用 canStandAt —— 它还要求脚下正好压着整数格，
   * 而真实主循环里落地后的 y 常带 epsilon（如 40.9999），会把「明明站着」误判成站不住，
   * 结果分离推力全被跳过（实测最小间距只涨到 0.226）。分离只关心「会不会挤进方块」。
   */
  mobAABBBlocked(m, x, y, z) {
    const w = this.ctx.world, hw = m.width / 2, EPS = 1e-4;
    const x0 = Math.floor(x - hw + EPS), x1 = Math.floor(x + hw - EPS);
    const y0 = Math.floor(y + EPS), y1 = Math.floor(y + m.height - EPS);
    const z0 = Math.floor(z - hw + EPS), z1 = Math.floor(z + hw - EPS);
    for (let yy = y0; yy <= y1; yy++) {
      for (let zz = z0; zz <= z1; zz++) {
        for (let xx = x0; xx <= x1; xx++) if (w.isSolidAt(xx, yy, zz)) return true;
      }
    }
    return false;
  }

  /**
   * 生物之间的分离（收敛旧「已知问题 #6：生物之间没有互相碰撞」）。
   * 规则：只在水平投影重叠时沿连线推开，每次最多补一半重叠量；
   * 推开前用 mobAABBBlocked 校验目标位置，被方块挡住的一侧把推力让给另一侧，
   * 两边都放不下就保持原样 —— 宁可挤着也不把同伴挤穿墙。
   * @param {number} dt 秒
   */
  separate(dt) {
    const n = this.list.length;
    if (n < 2) return;
    const rate = Math.min(1, SEPARATION_RATE * dt);      // 与帧率无关的逼近比例
    for (let i = 0; i < n - 1; i++) {
      const a = this.list[i];
      if (!a || a.dead || a.hp <= 0) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.list[j];
        if (!b || b.dead || b.hp <= 0) continue;
        const dy = Math.abs(b.pos.y - a.pos.y);
        if (dy > Math.min(a.height, b.height)) continue;  // 上下差太多不算挤在一起
        let dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const need = (a.width + b.width) * 0.5;
        let d = Math.hypot(dx, dz);
        if (d >= need) continue;
        if (d < 1e-4) { dx = 1; dz = 0; d = 1e-4; }       // 完全重合：给个固定方向拆开
        const push = (need - d) * 0.5 * rate;
        const ux = dx / d, uz = dz / d;
        const aAx = a.pos.x - ux * push, aAz = a.pos.z - uz * push;
        const bBx = b.pos.x + ux * push, bBz = b.pos.z + uz * push;
        const aOk = !this.mobAABBBlocked(a, aAx, a.pos.y, aAz);
        const bOk = !this.mobAABBBlocked(b, bBx, b.pos.y, bBz);
        if (aOk && bOk) {
          a.pos.x = aAx; a.pos.z = aAz; b.pos.x = bBx; b.pos.z = bBz;
        } else if (aOk) {
          // B 被挡住：A 承担全部推力，但同样要过方块检查（失败就退回半量）
          const fx = a.pos.x - ux * push * 2, fz = a.pos.z - uz * push * 2;
          if (!this.mobAABBBlocked(a, fx, a.pos.y, fz)) { a.pos.x = fx; a.pos.z = fz; }
          else { a.pos.x = aAx; a.pos.z = aAz; }
        } else if (bOk) {
          const fx = b.pos.x + ux * push * 2, fz = b.pos.z + uz * push * 2;
          if (!this.mobAABBBlocked(b, fx, b.pos.y, fz)) { b.pos.x = fx; b.pos.z = fz; }
          else { b.pos.x = bBx; b.pos.z = bBz; }
        }
        // 两边都放不下就保持原样，宁可挤着也不穿墙
      }
    }
  }

  update(dt, dayFactor) {
    const ctx = this.ctx, w = ctx.world, c = ctx.controller;
    this.spawnTimer -= dt;
    /* 阶段 3c：这一路的额度改成 landSpawnCap()——玩家在地表时它等于 maxMobs（一字未改），
       玩家下到洞里之后给洞穴/林冠留出额度，否则头顶的地表动物会把这把共用的闸吃满。 */
    if (this.spawnTimer <= 0 && this.list.length < this.landSpawnCap()) {
      this.spawnTimer = 1.1;
      const hostile = dayFactor < 0.35;
      const types = hostile ? NIGHT_TYPES : DAY_TYPES;
      const p = this.findSpawnPoint(hostile, dayFactor);
      if (p) this.spawn(types[(Math.random() * types.length) | 0], p.x, p.y, p.z);
    }
    /* 阶段 3a：鱼群按确定性站点自然生成（独立节拍，不跟陆上刷怪抢同一次机会） */
    this.fishTimer -= dt;
    if (this.fishTimer <= 0) {
      this.fishTimer = FISH_SPAWN_INTERVAL;
      this.spawnFishSchools();
    }
    /* 阶段 3c：地下敌怪。这条通路**故意不看 dayFactor**——白天地表安全、地下照样有风险，
       判据是候选格自己的局部亮度与有没有顶盖（spawnSiteOk / exposedToSky），
       插了火把的洞格会被亮度闸挡掉。上面那条地表通路的 hostile/动物分档一字未改。
       总量仍然只认 maxMobs 这一把闸，另加一个 SPAWN_CAVE_CAP 让洞穴通路不能吃满整把闸。 */
    this.caveTimer -= dt;
    if (this.caveTimer <= 0) {
      this.caveTimer = SPAWN_CAVE_INTERVAL;
      if (this.list.length < this.maxMobs) {
        let caveHostiles = 0;
        for (const m of this.list) if (m.def.hostile && m.undergroundSpawn) caveHostiles++;
        if (caveHostiles < SPAWN_CAVE_CAP) {
          const up = this.findUndergroundSpawnPoint(dayFactor);
          if (up) {
            const nm = this.spawn(NIGHT_TYPES[(Math.random() * NIGHT_TYPES.length) | 0], up.x, up.y, up.z);
            if (nm) nm.undergroundSpawn = true;
          }
        }
      }
    }
    /* 阶段 3c：林冠鸟群（确定性站点 + 读档去重，与鱼群一套做法） */
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = BIRD_SPAWN_INTERVAL;
      this.spawnBirdFlocks();
    }

    for (let i = this.list.length - 1; i >= 0; i--) {
      const m = this.list[i];
      m.age += dt;
      if (m.breedCd > 0) m.breedCd = Math.max(0, m.breedCd - dt);
      if (m.isBaby) {                            // 幼崽长大
        m.growT -= dt;
        if (m.growT <= 0) { m.growT = 0; m.setBaby(false, this.scene); }
      }
      if (m.sheared) {                         // 羊毛再生倒计时
        m.regenT -= dt;
        if (m.regenT <= 0) { m.regenT = 0; m.setSheared(false, this.scene); }
      }
      if (m.hurtT > 0) m.hurtT -= dt;
      if (m.attackCd > 0) m.attackCd -= dt;
      /* A：攻击姿态倒计时只在这里扣一次（computePose 只读当前值） */
      if (m.animAttack > 0) m.animAttack = Math.max(0, m.animAttack - dt);
      const d2 = (m.pos.x - c.pos.x) ** 2 + (m.pos.z - c.pos.z) ** 2;

      // 太远就卸载（动物保留，敌怪消失；村庄村民永远保留，否则走远再回来村子就空了）
      if (d2 > 120 * 120 && !m.def.noDespawn) { m.remove(this.scene); this.list.splice(i, 1); continue; }
      if (m.def.hostile && d2 > 78 * 78 && m.age > 12) { m.remove(this.scene); this.list.splice(i, 1); continue; }
      if (m.hp <= 0) { this.kill(m, false); this.list.splice(i, 1); continue; }

      // 阳光点燃敌怪
      if (m.def.burnInDay && dayFactor > 0.6 && w.brightnessAt(Math.floor(m.pos.x), Math.floor(m.eyeY), Math.floor(m.pos.z), dayFactor) > 0.8) {
        m.fire = 4;
      }
      if (m.fire > 0) {
        m.fire -= dt;
        m.hp -= dt * 1.6;
        if (Math.random() < dt * 4) ctx.particles.spawn(m.pos.x, m.eyeY, m.pos.z, [1, 0.55, 0.15], 2, 0.4, 1.4);
      }
      /* 阶段 3a：水生离水窒息（本作约定 FISH_AIR_SECONDS 秒后开始掉血，回到水里立刻停止并清零），
         顺带在水里冒几颗气泡 —— 水下要看得出生气，不能是一排静止的色块。 */
      if (m.def.aquatic) {
        if (!m.inWater) {
          m.airT += dt;
          if (m.airT > FISH_AIR_SECONDS) m.hp -= dt * 2;
        } else {
          m.airT = 0;
          if (Math.random() < dt * 0.7) ctx.particles.spawn(m.pos.x, m.eyeY + 0.1, m.pos.z, [0.75, 0.88, 0.95], 1, 0.5, 0.8);
        }
      }

      this.creeperFuse(m, dt, d2);
      const _yBefore = m.pos.y;
      this.ai(m, dt, d2, dayFactor);
      this.physics(m, dt);
      // T4：判定为在爬，却连续 1.2 秒没升高（上面封顶或被夹住）→ 放弃攀爬并转弯，别贴墙抖个不停
      if (m.def.climb && m.climbing) {
        if (m.pos.y - _yBefore > 0.01) m.climbStuck = 0;
        else m.climbStuck = (m.climbStuck || 0) + dt;
        if (m.climbStuck > 1.2) {
          m.climbing = false; m.climbStuck = 0;
          m.yaw += 1.9; m.walking = true; m.wanderT = 0.8;
        }
      }
      this.render(m, dt, dayFactor);
    }

    // 生物之间挤在一起时互相让位（放在整帧移动之后，避免把同伴推进刚要离开的方块）
    this.separate(dt);
    this.updateArrows(dt);
    /* 第二轮 D：守卫光弹也要每帧推进（放到渲染之后，与箭同一节奏） */
    this.updateGuardianBolts(dt);
  }

  /* 阶段 3b：墙体遮挡。原版口径是「怪物要看得到玩家才会发起攻击」，
     以前这里只按距离判定，实测隔一堵 1 格墙骷髅照样每 1.6 秒拉一次弓、箭全插在墙上，
     苦力怕也能隔墙直接开始嘶嘶。现在补一次 DDA 视线检测（从生物胸口到玩家眼睛）：
     被挡 ⇒ 远程不起手 / 拉弓途中取消、自爆不点火。
     注意两件事没变：① 追逐与朝向照旧，玩家绕过墙角它立刻就能射，掩体是暂时的；
     ② 苦力怕**已经点燃**的引信仍只按距离取消（原版点燃后不再看视线），所以判定只挂在起手那一步。 */
  lineOfSightToPlayer(m, c) {
    const w = this.ctx.world;
    if (!w || typeof w.raycast !== 'function' || !c || !c.pos) return true;
    const ox = m.pos.x, oz = m.pos.z;
    const oy = m.pos.y + Math.max(0.4, (m.height || 1.8) * 0.7);
    const ty = (typeof c.eyeY === 'number' && c.eyeY > c.pos.y) ? c.eyeY : c.pos.y + 1.4;
    const dx = c.pos.x - ox, dy = ty - oy, dz = c.pos.z - oz;
    const L = Math.hypot(dx, dy, dz);
    if (!(L > 1e-4)) return true;
    /* 例外：生物自己这一格就是实心（塌方埋住、或验收夹具故意把它放进石材里）时，
       「隔墙对峙」这个前提不成立 —— 这时候连它脚下都不正常，视线判定无从谈起，
       按原来的距离规则放行。玩家能用来躲墙的仍然是真正挡在中间的那堵墙：
       只要生物站在空气里，射线就会照常在墙面上命中。 */
    if (w.isSolidAt && w.isSolidAt(Math.floor(ox), Math.floor(oy), Math.floor(oz))) return true;
    // 终点前留 0.5 格余量：玩家自己站的那一格、以及贴身的那面墙不算遮挡
    return !w.raycast(ox, oy, oz, dx, dy, dz, Math.max(0.1, L - 0.5));
  }

  /* ---------------- 阶段 5：地牢守卫 ---------------- */
  setGuardian(site, rawState) {
    this.guardianSite = site || null;
    this.guardianState = normalizeGuardianState(rawState, guardianSiteKey(site));
    this._guardianLockedHint = 0;      // 封印未解开的提示去重（运行时字段，不进 state、不落盘）
    return this.guardianState;
  }

  /** 本轮 A3：守卫的固定站位（由 game.js 用 chooseGuardianStand 选好后交进来）。
   *  reset（玩家死亡/脱战回位）用它而不是「中心最上方实心格」，否则一复位又回到屋顶。 */
  setGuardianStand(stand) {
    this.guardianStand = stand && Number.isFinite(stand.x) && Number.isFinite(stand.y) && Number.isFinite(stand.z)
      ? { x: stand.x, y: stand.y, z: stand.z, ring: stand.ring || 0, fallback: !!stand.fallback }
      : null;
    return this.guardianStand;
  }

  guardianMob() { return this.list.find(m => m.def.guardian && !m.dead) || null; }

  /** 按地点生成守卫；已击败的档不再生成。返回 Mob 或 null。
   *  生成听 `maxMobs` 这把总闸（验收里 `maxMobs = 0` 表示「这一段关掉刷怪」，
   *  守卫不能偷偷成为例外）。卸载走通用敌怪的 78 格规则，走远再回来由 game.js
   *  的 `updateGuardian()` 按地点状态重建 —— 状态一直在存档里，实体不必常驻。 */
  spawnGuardianAt(site, x, y, z, rawState) {
    const key = guardianSiteKey(site);
    /* 只在首次（或换了地点）时归一化一次。normalizeGuardianState 是读档用的，
       它会把临时相位回落到 DORMANT；若每 0.6 秒扫描都调一次，前摇永远推不完。 */
    if (!this.guardianState || this.guardianState.siteKey !== key) this.setGuardian(site, rawState);
    const st = this.guardianState;
    if (st.defeated) return null;
    let m = this.guardianMob();
    if (!m) {
      if (!(this.maxMobs > 0)) return null;
      /* 实体被卸载/清场之后重新出现时，上一场的临时相位没有意义了（动画早丢了）：
         回到待机、血量按存档，玩家不会一进场就被一记「上一帧没放完的招」打到。 */
      if (st.phase !== GUARDIAN_PHASE.DORMANT && st.phase !== GUARDIAN_PHASE.DEAD) {
        st.phase = GUARDIAN_PHASE.DORMANT; st.attack = null; st.t = 0;
      }
      m = this.spawn('guardian', x, y, z);
      if (!m) return null;
      m.hp = st.hp;
    }
    return m;
  }

  /** 只读诊断：验收脚本与 HUD 都读这一份，不各自复制公式 */
  guardianInfo() {
    const m = this.guardianMob();
    const s = this.guardianState || defaultGuardianState();
    return {
      siteKey: s.siteKey, hp: m ? m.hp : s.hp, maxHp: GUARDIAN_HP,
      phase: s.phase, attack: s.attack, t: +s.t.toFixed(3),
      defeated: s.defeated, rewardClaimed: s.rewardClaimed, attempts: s.attempts,
      armed: this._guardianArmed !== false, wards: this._guardianWards || 0, wardTotal: GUARDIAN_WARDS,
      strikes: this.guardianStrikes || 0, lastFire: this.guardianLastFire || null,
      present: !!m,
      stand: this.guardianStand ? Object.assign({}, this.guardianStand) : null,
      pos: m ? { x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2) } : null
    };
  }

  guardianAI(m, dt, d2) {
    const c = this.ctx.controller, w = this.ctx.world;
    const st = this.guardianState || defaultGuardianState();
    const dist = Math.sqrt(d2) || 0.01;
    const alive = !!(c && c.health > 0);
    const r = stepGuardian(st, dt, {
      dist, playerAlive: alive, rng: Math.random,
      armed: this._guardianArmed !== false, wards: this._guardianWards || 0
    });
    this.guardianState = r.state;
    m.hp = r.state.hp;
    if (c) {
      const dx = c.pos.x - m.pos.x, dz = c.pos.z - m.pos.z;
      m.yaw = Math.atan2(-dx, -dz) + Math.PI;
      /* 前摇与硬直站定，玩家看得懂这两段；只有 IDLE 才缓慢逼近 */
      const chase = r.state.phase === GUARDIAN_PHASE.IDLE && dist < GUARDIAN_TRIGGER * 1.6 && dist > 2.2;
      if (chase) {
        /* BUG 修复（本轮 A2）：这里以前写的是 k = speed * dt / dist，
           再拿 dx*k 当「目标速度」。dx*k 是**这一帧的位移**（米/帧），
           physics() 随后又按 vel*dt 积分一次 → 真实速度变成 speed*dt，
           30/60/120 FPS 下分别是 0.063/0.032/0.016 格/秒：帧率越高追得越慢。
           现在目标速度直接用「单位方向 × speed」（米/秒），与 dt 无关。
           趋近用 1-exp(-rate*dt)：这是指数收敛，任意帧率下同一真实秒数走过的
           距离一致（线性 lerp(min(1,rate*dt)) 在低帧率会截断，120FPS 与 15FPS 仍有偏差）。 */
        const speed = guardianChaseSpeed(m.def.speed);
        const k = 1 - Math.exp(-GUARDIAN_CHASE_RATE * dt);
        m.vel.x += ((dx / dist) * speed - m.vel.x) * k;
        m.vel.z += ((dz / dist) * speed - m.vel.z) * k;
      } else {
        /* 站定阻尼同样要与帧率无关：旧写法每帧 *0.8 在 120FPS 一秒衰减 59 次、
           30FPS 只衰减 30 次，收势快慢会随机器变。这里换算成每秒同一条衰减曲线。 */
        const d = Math.exp(-GUARDIAN_STOP_RATE * dt);
        m.vel.x *= d; m.vel.z *= d;
      }
    }
    for (const e of r.events) {
      if (e.type === 'telegraph') {
        /* 第二轮 D：开打时把「守卫沉睡着 · 还缺 N 块深板岩」这类说明撤掉 ——
           它已经不再成立，留着会和危险预警抢同一块屏幕。 */
        const gg = this.ctx.game;
        if (gg && gg.ui && gg.ui.clearToast && !this._guardianClearedStale) {
          this._guardianClearedStale = 1;
          gg.ui.clearToast('守卫沉睡着');
          gg.ui.clearToast('石碑刻着挑战');
        }
        m.animAttack = 0.9;                 // 复用 A 段抬手姿态
        /* 本轮 D：守卫前摇用自己的声音身份（旧实现借苦力怕的 hiss）。
           按守卫位置给方向与距离：玩家能听出危险从哪边来，而不是只知道「有危险」。 */
        const sfx = this.ctx.sfx;
        if (sfx) {
          const o = { volume: 0.7, rate: e.attack === 'bolt' ? 1.12 : 0.92 };
          if (sfx.playWorld) sfx.playWorld('guardian_warn', m.pos, o);
          else sfx.play('guardian_warn', o);
        }
      } else if (e.type === 'fire') {
        this.guardianFire(m, e.attack, dist);
      } else if (e.type === 'locked') {
        /* 封印没解：十分钟内只提示一次，别把 toast 刷满 */
        const now = Date.now();
        if (now - (this._guardianLockedHint || 0) > 10000) {
          this._guardianLockedHint = now;
          const g = this.ctx.game;
          if (g && g.ui && g.ui.toast) {
            g.ui.toast('守卫沉睡着 · 四座封印还缺 ' + (GUARDIAN_WARDS - e.wards) + ' 块深板岩（挖 y<0 的深板岩）', false, 4200);
          }
        }
      } else if (e.type === 'reset' && this.guardianSite && w && typeof w.topSolidY === 'function') {
        /* 回位优先用选好的站位（A3）：没有它才退回旧的中心列。 */
        const st2 = this.guardianStand;
        const s = st2 || this.guardianSite;
        m.pos.x = s.x + (st2 ? 0.5 : 0);
        m.pos.z = s.z + (st2 ? 0.5 : 0);
        m.pos.y = st2 ? st2.y : (w.topSolidY(Math.floor(s.x), Math.floor(s.z)) + 1);
        m.vel.x = m.vel.y = m.vel.z = 0;
      }
    }
  }

  guardianFire(m, attackId, dist) {
    const c = this.ctx.controller;
    if (!c || c.health <= 0) return;
    /* 第二轮 D：光弹不再是「发射即扣血」。
       旧实现按距离+视线直接 controller.hurt()，玩家侧移毫无意义 —— 那不是能躲的招。
       现在 slam（近身横扫）仍即时结算（它本来就是一记贴身挥击），
       bolt（光弹）改成真正的飞行投射物：发射时锁方向、带飞行时间、碰墙消失、
       命中玩家才结算一次、飞出射程自动释放。侧移/绕柱都能躲。 */
    if (attackId === 'bolt') {
      this.spawnGuardianBolt(m, c);
      return;
    }
    const los = this.lineOfSightToPlayer(m, c);
    /* 双重结算防线：墙体与距离在这里判掉；**格挡交给 controller 的盾牌扇区**，
       这里不再自己减一次伤害（旧写法先扣 6 点、controller 又整发挡下，
       读数会出现「格挡了但已经掉血」的自相矛盾）。 */
    const res = guardianDamage(attackId, { dist, wallBetween: !los });
    let hurt = null;
    if (res.damage > 0) {
      hurt = c.hurt(res.damage, '被地牢守卫横扫击中',
        guardianDamageType(attackId), { x: m.pos.x, z: m.pos.z, kind: attackId });
    }
    this.guardianStrikes = (this.guardianStrikes || 0) + 1;
    this.guardianLastFire = {
      attack: attackId, at: Date.now(), dist: +dist.toFixed(2), los: !!los, why: res.why,
      damage: res.damage, dealt: hurt ? (hurt.blocked ? 0 : hurt.taken) : 0,
      blocked: !!(hurt && hurt.blocked)
    };
    /* 本轮 D：出招声跟招式身份对上，并带方向。横扫用 hit（金属/石的碰撞），
       光弹在 spawnGuardianBolt 里用 bow 的音色但压得很低，两者不再互相冒充。 */
    const sfx = this.ctx.sfx;
    if (sfx) {
      const o = { volume: 0.6, rate: 0.72 };
      if (sfx.playWorld) sfx.playWorld('hit', m.pos, o);
      else sfx.play('hit', o);
    }
  }

  /* ---------------- 第二轮 D：守卫光弹（真正的投射物） ---------------- */

  /** 生成一枚光弹：从守卫胸口朝玩家当前位置发射，飞行中可被墙体吸收、可被侧移躲开。 */
  spawnGuardianBolt(m, c) {
    const ox = m.pos.x, oy = m.pos.y + 1.16, oz = m.pos.z;
    const tx = c.pos.x, ty = c.pos.y + 1.0, tz = c.pos.z;
    const dx = tx - ox, dy = ty - oy, dz = tz - oz;
    const len = Math.hypot(dx, dy, dz) || 1;
    const speed = GUARDIAN_BOLT_SPEED;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffb066 }));
    mesh.position.set(ox, oy, oz);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff6b3d, transparent: true, opacity: 0.35 }));
    mesh.add(halo);
    this.scene.add(mesh);
    this.guardianBolts = this.guardianBolts || [];
    this.guardianBolts.push({
      mesh, x: ox, y: oy, z: oz,
      vx: dx / len * speed, vy: dy / len * speed, vz: dz / len * speed,
      life: GUARDIAN_BOLT_LIFE, damage: GUARDIAN_ATTACKS.bolt.damage, from: { x: ox, y: oy, z: oz }
    });
    this.guardianStrikes = (this.guardianStrikes || 0) + 1;
    this.guardianLastFire = {
      attack: 'bolt', at: Date.now(), dist: +Math.hypot(dx, dz).toFixed(2), los: true, why: 'launched',
      damage: GUARDIAN_ATTACKS.bolt.damage, dealt: 0, blocked: false, projectile: true
    };
    const sfx = this.ctx.sfx;
    if (sfx) {
      const o = { volume: 0.5, rate: 1.25 };
      if (sfx.playWorld) sfx.playWorld('bow', m.pos, o);
      else sfx.play('bow', o);
    }
    return true;
  }

  /** 每帧推进光弹：墙体吸收 → 命中玩家一次 → 超出射程/寿命释放。 */
  updateGuardianBolts(dt) {
    const list = this.guardianBolts;
    if (!list || !list.length) return;
    const w = this.ctx.world, c = this.ctx.controller;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      b.life -= dt;
      const speed = Math.hypot(b.vx, b.vy, b.vz);
      const steps = Math.max(1, Math.ceil(speed * dt / 0.3));
      const sdt = dt / steps;
      let done = false, why = 'expired';
      for (let s = 0; s < steps && !done; s++) {
        b.x += b.vx * sdt; b.y += b.vy * sdt; b.z += b.vz * sdt;
        if (w.isSolidAt(Math.floor(b.x), Math.floor(b.y), Math.floor(b.z))) { done = true; why = 'wall'; break; }
        if (c && c.health > 0) {
          const hw = 0.45;
          if (Math.abs(b.x - c.pos.x) <= hw && Math.abs(b.z - c.pos.z) <= hw &&
              b.y >= c.pos.y - 0.1 && b.y <= c.pos.y + 1.9) {
            const hurt = c.hurt(b.damage, '被地牢守卫光弹击中', guardianDamageType('bolt'),
              { x: b.from.x, z: b.from.z, kind: 'bolt' });
            this.guardianLastFire = {
              attack: 'bolt', at: Date.now(),
              dist: +Math.hypot(b.x - b.from.x, b.z - b.from.z).toFixed(2),
              los: true, why: 'hit', damage: b.damage,
              dealt: hurt ? (hurt.blocked ? 0 : hurt.taken) : 0,
              blocked: !!(hurt && hurt.blocked), projectile: true
            };
            done = true; why = 'hit';
          }
        }
        if (!done && Math.hypot(b.x - b.from.x, b.y - b.from.y, b.z - b.from.z) > GUARDIAN_ATTACKS.bolt.reach + 4) {
          done = true; why = 'range';
        }
      }
      b.mesh.position.set(b.x, b.y, b.z);
      if (done || b.life <= 0) {
        /* 只读诊断：这一枚光弹是怎么结束的（命中 / 撞墙 / 超程 / 寿命到） */
        this.guardianLastBoltEnd = { why: why, x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: +b.z.toFixed(2), at: Date.now() };
        if (this.ctx.particles) this.ctx.particles.spawn(b.x, b.y, b.z, [1, 0.55, 0.2], 6, 0.35, 0.9);
        this.scene.remove(b.mesh);
        try { b.mesh.geometry.dispose(); b.mesh.material.dispose(); } catch (e) { /* ignore */ }
        list.splice(i, 1);
        if (why === 'wall') {
          const sfx2 = this.ctx.sfx;
          if (sfx2 && sfx2.playWorld) sfx2.playWorld('hit', { x: b.x, y: b.y, z: b.z }, { volume: 0.25, rate: 1.5 });
        }
      }
    }
  }

  /** 只读诊断：场上还有几枚光弹、它们在哪（验收用来证明「看得见飞行过程」）。 */
  guardianBoltInfo() {
    const list = this.guardianBolts || [];
    return list.map(b => ({
      x: +b.x.toFixed(2), y: +b.y.toFixed(2), z: +b.z.toFixed(2),
      life: +b.life.toFixed(2),
      speed: +Math.hypot(b.vx, b.vy, b.vz).toFixed(2),
      damage: b.damage
    }));
  }

  ai(m, dt, d2, dayFactor) {
    const c = this.ctx.controller;
    const speed = m.def.speed || 1.6;
    /* 守卫的伤害必须走 guardian.js 的前摇 / 格挡 / 墙体判定，不能落进通用敌怪的 attackCd 分支 */
    if (m.def.guardian) { this.guardianAI(m, dt, d2); return; }
    m.wanderT -= dt;
    m.climbing = false;         // T4：每一帧重新判定，避免「 once 贴墙就一直飘着」
    if (m.type === 'wolf' && m.tamed) { this.wolfAI(m, dt); return; }
    if (m.type === 'villager') { this.villagerAI(m, dt); return; }
    /* 阶段 3a：水生走自己的 AI —— 陆上那套「前方没地面就转向 / 自动跳 1 格障碍」对鱼是反的 */
    if (m.def.aquatic) { this.fishAI(m, dt); return; }
    /* 阶段 3c：飞行同理 —— 陆上判据会把「头顶是树叶」当成要跳过去的障碍、
       把「脚下是空气」当成要掉下去的悬崖，鸟就会在树冠上原地抽搐。飞行走自己的三条避让。 */
    if (m.def.flying) { this.flyAI(m, dt); return; }
    let wantX = 0, wantZ = 0, wantYaw = m.yaw;

    /* BUG.5：原 46 格感知太短，玩家在夜色里看得见怪、怪却只在外面发呆。
       放宽到 56 格，让「看见敌怪」与「敌怪开始逼近」基本同步。 */
    if (m.def.hostile && c.health > 0 && d2 < 56 * 56 && this.ctx.game.state === 'playing') {
      const dx = c.pos.x - m.pos.x, dz = c.pos.z - m.pos.z;
      const dist = Math.sqrt(d2) || 1;
      wantYaw = Math.atan2(-dx, -dz) + Math.PI;   // 面朝玩家
      if (m.def.ranged) {
        /* 阶段 3b：骷髅改成「先拉后放」。
           原来一进射程就立刻有箭（attackCd 1.6 秒一发），玩家只能凭运气躲 —— 那不是预警，是抽奖。
           现在冷却好了先**起手拉弓** SKELETON_DRAW_SECONDS（0.7 秒，本作约定），
           这段时间它站定瞄准（移动量压到 0.2 倍）、弓弦逐帧拉开、箭搭在弦上但还没离弦，
           同时叫一声作为听觉提示；到点才真的 shootArrow。
           中途目标死了 / 跑出 1.25×reach / 被方块挡住视线就取消蓄力（不白等、也不留半张的弓给读档）。 */
        if (dist > 9) { wantX = dx / dist; wantZ = dz / dist; }
        else if (dist < 4) { wantX = -dx / dist; wantZ = -dz / dist; }
        if (m.drawing) {
          if (c.health <= 0 || dist > m.def.reach * 1.25 || !this.lineOfSightToPlayer(m, c)) {
            m.drawing = false; m.drawT = 0; m.bowDraw = 0;
          } else {
            m.drawT -= dt;
            m.bowDraw = Math.max(0, Math.min(1, 1 - Math.max(0, m.drawT) / SKELETON_DRAW_SECONDS));
            wantX *= 0.2; wantZ *= 0.2;
            if (m.drawT <= 0) {
              m.drawing = false; m.drawT = 0; m.bowDraw = 0;
              this.shootArrow(m, dx, dz, dist);
              m.attackCd = 1.6; m.animAttack = MOB_ATTACK_POSE_SECONDS;
            }
          }
        } else if (dist < m.def.reach && m.attackCd <= 0 && this.lineOfSightToPlayer(m, c)) {
          m.drawing = true; m.drawT = SKELETON_DRAW_SECONDS; m.bowDraw = 0;
          /* 本轮 D：骷髅拉弓的「身体声」带方向（远程威胁最需要知道它在你哪一侧） */
          if (this.ctx.sfx.playWorld) this.ctx.sfx.playWorld('skeleton', m.pos, { volume: 0.5 });
          else this.ctx.sfx.play('skeleton', { volume: 0.4 });
        }
      } else if (m.def.explode) {
        /* T5：苦力怕不近战 —— 它靠自爆，伤害与破坏都由 onCreeperExplode 结算。
           这里只负责「往玩家身上撞」，真正扣血发生在爆炸那一刻。 */
        wantX = dx / dist; wantZ = dz / dist;
      } else {
        wantX = dx / dist; wantZ = dz / dist;
        if (dist < m.def.reach && m.attackCd <= 0 && !c.creative) {
          if (m.damage > 0) {
            c.hurt(m.damage, '被' + m.name + '攻击', 'melee', { x: m.pos.x, z: m.pos.z, kind: 'melee' });
            wantX *= 0.2; wantZ *= 0.2;
          }
          m.attackCd = 1.2;
          m.animAttack = MOB_ATTACK_POSE_SECONDS;
        }
      }
      m.yaw = wantYaw;
    } else {
      /* BUG.5：敌怪原来 45% 概率站着发呆 1.5~5 秒，玩家在远处看到的就是「怪不动」。
         只对敌怪压到 20% / 0.8~2.6 秒；**被动生物必须保持原参数** —— SP.5 用 4 只猪
         贴墙验证分离力，猪一旦更爱漫游就会把同伴挤穿墙（成品自检实测撞红过一次）。
         静止期间 A 段的头部张望与呼吸仍在跑，不会像模型卡死。 */
      const roamIdle = m.def.hostile ? 0.2 : 0.45;
      const roamBase = m.def.hostile ? 0.8 : 1.5;
      const roamRand = m.def.hostile ? 1.8 : 3.5;
      if (m.wanderT <= 0) {
        m.wanderT = roamBase + Math.random() * roamRand;
        if (Math.random() < roamIdle) { m.yaw = Math.random() * Math.PI * 2; m.walking = false; }
        else { m.walking = true; m.yaw += (Math.random() - 0.5) * 1.6; }
      }
      // D3 修复：模型正面是 +Z（head/nose 都摆在 +Z），mesh.rotation.y = yaw 时正面在世界里指向
      // (sin yaw, cos yaw)。原来这里写的是 (-sin, -cos)，等于让身体朝正面反方向走 → 倒退着走路。
      if (m.walking) { wantX = Math.sin(m.yaw); wantZ = Math.cos(m.yaw); }
    }

    // 撞墙或前方无地面则转向
    const fx = m.pos.x + wantX * 0.6, fz = m.pos.z + wantZ * 0.6;
    if (wantX || wantZ) {
      if (!this.canStandAt(fx, m.pos.y, fz)) {
        /* T4 蜘蛛：正面贴着的是「墙」而不是「悬崖」时不转弯，改成沿墙向上爬。
           悬崖（前方脚下没方块但也不是实心）仍然走原来的转向逻辑，否则蜘蛛会往沟里跳。 */
        if (m.def.climb && this.wallAhead(m, wantX, wantZ)) m.climbing = true;
        else { m.yaw += 1.9; m.wanderT = 0.6; m.walking = true; wantX = 0; wantZ = 0; }
      }
    }
    const accel = 9;
    m.vel.x += (wantX * speed - m.vel.x) * Math.min(1, accel * dt);
    m.vel.z += (wantZ * speed - m.vel.z) * Math.min(1, accel * dt);
    m.moving = !!(wantX || wantZ);
    /* T6 史莱姆：落地后隔一小段时间弹一下（不是每帧跳），边跳边追 */
    if (m.def.slime) {
      m.hopT -= dt;
      if (m.onGround && m.hopT <= 0) {
        m.vel.y = 6.2;
        m.onGround = false;
        m.hopT = 0.9 + Math.random() * 0.6;
        /* E2：史莱姆在场外跳也要听得见方向，不能和身边一样响。 */
        if (this.ctx.sfx.playWorld) this.ctx.sfx.playWorld('slime', m.pos, { volume: 0.35, rate: 0.9 + Math.random() * 0.2 });
        else this.ctx.sfx.play('slime', { volume: 0.35, rate: 0.9 + Math.random() * 0.2 });
      }
    }
    // 水中向上游
    if (m.inWater > 0.2) m.vel.y = 2.6;
    // 自动跳起越过 1 格障碍
    if (m.moving && m.onGround && wantX || wantZ) {
      const ahead = this.blockInFront(m);
      if (ahead && m.onGround) m.vel.y = 7.2;
    }
  }

  /** 阶段 3a：这一格到底是不是水（鱼的活动范围完全由它约束） */
  isWaterAt(x, y, z) {
    return this.ctx.world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === B.WATER;
  }

  /**
   * 阶段 3a 鱼群 AI：贴着水深巡游，不爬墙、不跳障碍、不上岸。
   * 垂直方向只往「回家深度」游（homeY 生成时定好），所以鱼群看起来待在自己那片水里，
   * 而不是浮到水面或贴到河底。水平方向前方不是水就转向，并朝站点中心回带一点，
   * 避免整群鱼慢慢漂散出这片水域。
   */
  fishAI(m, dt) {
    m.wanderT -= dt;
    let wantX = 0, wantZ = 0;
    if (m.wanderT <= 0) {
      m.wanderT = 1.2 + Math.random() * 2.2;
      if (Math.random() < 0.3) { m.walking = false; m.yaw += Math.PI * (0.6 + Math.random() * 0.8); }
      else { m.walking = true; m.yaw += (Math.random() - 0.5) * 1.4; }
    }
    if (m.walking) { wantX = Math.sin(m.yaw); wantZ = Math.cos(m.yaw); }
    if (wantX || wantZ) {
      const fx = m.pos.x + wantX * 0.75, fz = m.pos.z + wantZ * 0.75;
      if (!this.isWaterAt(fx, m.pos.y, fz) || !this.isWaterAt(fx, m.pos.y + 0.4, fz)) {
        /* 前方出水（岸边、桥墩、方块缝）→ 掉头，并朝站点中心回带一点，鱼群不会散出去 */
        m.yaw += 2.3; m.wanderT = 0.8;
        if (Number.isFinite(m.homeX)) {
          const hx = m.homeX - m.pos.x, hz = m.homeZ - m.pos.z;
          const hd = Math.hypot(hx, hz);
          if (hd > 0.5) { wantX = hx / hd; wantZ = hz / hd; m.yaw = Math.atan2(wantX, wantZ); }
        } else { wantX = 0; wantZ = 0; }
      }
    }
    const speed = m.def.speed || 1.9;
    m.vel.x += (wantX * speed - m.vel.x) * Math.min(1, 6 * dt);
    m.vel.z += (wantZ * speed - m.vel.z) * Math.min(1, 6 * dt);
    const target = Number.isFinite(m.homeY) ? m.homeY : m.pos.y;
    m.vel.y = Math.max(-0.9, Math.min(0.9, (target - m.pos.y) * 1.6));
    m.moving = !!(wantX || wantZ) || Math.abs(target - m.pos.y) > 0.25;
  }

  /**
   * 阶段 3a：这一列水够不够深、能不能住一群鱼。
   * 先用**地形纯函数**筛（区块没生成也能判，避免「走近了才刷」的抖动），
   * 再用真实方块复核「河底实心 + 往上到水面全是水」——
   * 只信纯函数会把洞穴顶当河底，鱼就刷进岩石里了。
   * @returns {null|{y:number, depth:number}} y = 可游的深度（水面下一格、离底至少一格）
   */
  fishWaterAt(x, z) {
    const w = this.ctx.world;
    const bx = Math.floor(x), bz = Math.floor(z);
    const h = w.surfaceHeight(bx, bz);
    const depth = w.seaLevel - h;
    if (depth < FISH_WATER_DEPTH) return null;
    if (h < w.minY + 1) return null;
    if (!w.isSolidAt(bx, h, bz)) return null;
    for (let y = h + 1; y <= w.seaLevel; y++) if (w.getBlock(bx, y, bz) !== B.WATER) return null;
    return { y: Math.max(h + 1, w.seaLevel - 1), depth };
  }

  /**
   * 阶段 3a：按确定性站点自然生成鱼群。
   * 扫描顺序固定（由内向外一圈一圈），已有活群的站点跳过；
   * 太近不刷（免得玩家脚下突然冒出一群），超出加载范围不管，总数封顶到 FISH_MAX_ALIVE。
   * @returns {boolean} 这一次扫描是否刷出了一群
   */
  spawnFishSchools() {
    const c = this.ctx.controller, w = this.ctx.world;
    let alive = 0;
    for (const m of this.list) if (m.def.aquatic) alive++;
    if (alive >= FISH_MAX_ALIVE) return false;
    /* maxMobs 是整个管理器（陆上刷怪 + 鱼群）共用的总量闸：
       验收脚本一路用 `maxMobs = 0` 表达「这一段把自然刷怪关掉」，鱼群也必须听这道闸，
       否则它会在水体站点上自己把生物列表灌起来，污染以列表为准的其它观察。
       阶段 3c 之后这里读的是 surfaceSpawnCap()：玩家在地表它 == maxMobs（一字未改），
       玩家下到洞里时先替洞穴通路留出 SPAWN_CAVE_CAP 格。 */
    if (this.list.length >= this.surfaceSpawnCap()) return false;
    const step = FISH_SITE_STEP;
    const pcx = Math.floor(c.pos.x / step), pcz = Math.floor(c.pos.z / step);
    for (let ring = 0; ring <= 3; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const sx = pcx + dx, sz = pcz + dz;
          const site = fishSchoolOf(w.seed, sx, sz);
          if (!site) continue;
          const key = site.key;
          /* 占用判定带兜底：带站点键的直接比键；不带键的鱼（这份代码之前存下的旧档）
             按它站在哪一格算 —— 同一格已经站着一群就不许再补一群，免得读档一次涨一层。 */
          const occupied = this.list.some(m => m.def.aquatic && (
            m.school === key ||
            (Math.floor(m.pos.x / step) === sx && Math.floor(m.pos.z / step) === sz)));
          if (occupied) continue;
          const d2 = (site.x - c.pos.x) ** 2 + (site.z - c.pos.z) ** 2;
          if (d2 < 6 * 6 || d2 > 64 * 64) continue;
          const water = this.fishWaterAt(site.x, site.z);
          if (!water) continue;
          const rand = mulberry32((site.seed ^ 0x9E3779B9) >>> 0);
          let made = 0;
          for (let i = 0; i < site.count; i++) {
            /* 总量闸要**逐条**复查：只在函数入口看一次的话，场上 21/26 时一次扫描能把一整群
               （最多 schoolMax 条）全塞进去，总数就变成 27 —— 阶段 3c 的 CV.1/CV.3/CV.4 就是这样撞出来的
               （读数 total=27、鱼 18 = FISH_MAX_ALIVE）。与鸟群那条 per-bird 检查同一口径。 */
            if (alive + made >= FISH_MAX_ALIVE || this.list.length >= this.surfaceSpawnCap()) break;
            const px = site.x + (rand() - 0.5) * 5.0;
            const pz = site.z + (rand() - 0.5) * 5.0;
            const py = Math.max(water.y - 1, Math.min(w.seaLevel - 1,
              water.y + Math.round((rand() - 0.5) * 2)));
            if (!this.isWaterAt(px, py, pz)) continue;
            const m = this.spawn('cod', px, py, pz);
            if (!m) continue;
            m.school = key;
            m.homeX = site.x; m.homeZ = site.z; m.homeY = py;
            m.yaw = rand() * Math.PI * 2;
            m.wanderT = rand() * 2;
            made++;
          }
          if (made) return true;
        }
      }
    }
    return false;
  }

  /* ================= 阶段 3c：会飞的鸟（林冠站点 + 飞行 AI） ================= */

  /** 这一列的林冠顶：最高的树叶/原木格。没有明显高出地面的树冠就返回 null（没得停）。
   *  基准必须用**地形** surfaceHeight：树叶在 isSolidAt 里算实心，
   *  用 topSolidY 当「地面」会让树冠高度永远等于 0，一棵树都筛不出来（单测踩过）。 */
  canopyTopAt(x, z) {
    const w = this.ctx.world;
    const bx = Math.floor(x), bz = Math.floor(z);
    const surf = w.surfaceHeight(bx, bz);
    let top = -1;
    for (let y = Math.max(w.minY + 1, surf + 1); y <= Math.min(w.topY - 2, surf + 12); y++) {
      const id = w.getBlock(bx, y, bz);
      if (id === B.LEAVES || id === B.BIRCH_LEAVES || id === B.LOG || id === B.BIRCH_LOG) top = y;
    }
    if (top < 0) return null;
    if (top - surf < BIRD_CANOPY_MIN) return null;   // 只比地面高一两格的不算林冠
    return { y: top, ground: surf, solidTop: w.topSolidY(bx, bz) };
  }

  /** 鸟的碰撞盒在这一点是否全是空气且不泡水（水体不能当飞行空间） */
  canFlyAt(x, y, z) {
    const w = this.ctx.world;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    for (let dy = 0; dy <= 1; dy++) {
      const yy = by + dy;
      if (w.isSolidAt(bx, yy, bz)) return false;
      if (w.getBlock(bx, yy, bz) === B.WATER) return false;
    }
    return true;
  }

  /** 在 (x,z) 附近找一处能停的林冠（水平最多扫 BIRD_PERCH_REACH 格），返回栖点或 null */
  findPerchAt(x, z, reach) {
    const r = Math.max(1, Math.floor(reach === undefined ? BIRD_PERCH_REACH : reach));
    const bx = Math.floor(x), bz = Math.floor(z);
    const here = this.canopyTopAt(bx, bz);
    if (here && this.canFlyAt(bx + 0.5, here.y + 1, bz + 0.5)) return { x: bx + 0.5, y: here.y + 1, z: bz + 0.5 };
    for (let d = 1; d <= r; d++) {
      for (const [ox, oz] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]]) {
        const c = this.canopyTopAt(bx + ox, bz + oz);
        if (!c) continue;
        const px = bx + ox + 0.5, pz = bz + oz + 0.5, py = c.y + 1;
        if (this.canFlyAt(px, py, pz)) return { x: px, y: py, z: pz };
      }
    }
    return null;
  }

  /**
   * 阶段 3c：按确定性站点自然生成鸟群。与鱼群同一套做法：
   * 由内向外一圈一圈扫、有活群的站点跳过、旧档没带站点键时按「所在列」判占用兜底，
   * 太近不刷、总量受 BIRD_MAX_ALIVE 与整把 maxMobs 闸双重限制。
   * @returns {boolean} 这一次扫描是否刷出了一群
   */
  spawnBirdFlocks() {
    const c = this.ctx.controller, w = this.ctx.world;
    let alive = 0;
    for (const m of this.list) if (m.def.flying) alive++;
    if (alive >= BIRD_MAX_ALIVE) return false;
    if (this.list.length >= this.surfaceSpawnCap()) return false;    // 与陆上/水域共用同一把总量闸（在地下时替洞穴留出额度）
    const step = BIRD_SITE_STEP;
    const pcx = Math.floor(c.pos.x / step), pcz = Math.floor(c.pos.z / step);
    for (let ring = 0; ring <= 3; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const sx = pcx + dx, sz = pcz + dz;
          const site = birdFlockOf(w.seed, sx, sz);
          if (!site) continue;
          const occupied = this.list.some(m => m.def.flying && (
            m.birdSite === site.key ||
            (Math.floor(m.pos.x / step) === sx && Math.floor(m.pos.z / step) === sz)));
          if (occupied) continue;
          const d2 = (site.x - c.pos.x) ** 2 + (site.z - c.pos.z) ** 2;
          if (d2 < BIRD_RANGE_MIN * BIRD_RANGE_MIN || d2 > BIRD_RANGE_MAX * BIRD_RANGE_MAX) continue;
          const perch = this.findPerchAt(site.x, site.z, BIRD_PERCH_REACH);
          if (!perch) continue;                              // 这一格没有能停的树冠
          const rand = mulberry32((site.seed ^ 0x51ED270B) >>> 0);
          let made = 0;
          for (let i = 0; i < site.count; i++) {
            if (alive + made >= BIRD_MAX_ALIVE || this.list.length >= this.surfaceSpawnCap()) break;
            /* 直接落在栖点列上（旧版 ±1.5 格 + 随机再抬 1 格，「停栖」从出生起就是悬空摆拍）；
               微小抖动只防同群完全重叠，残差由停栖分支的水平弹簧收掉。 */
            const px = perch.x + (rand() - 0.5) * 0.8;
            const pz = perch.z + (rand() - 0.5) * 0.8;
            const py = birdPerchY(perch.y);
            if (!this.canFlyAt(px, py, pz)) continue;
            const m = this.spawn('parrot', px, py, pz);
            if (!m) continue;
            m.birdSite = site.key;
            m.perch = { x: perch.x, y: perch.y, z: perch.z };
            m.homeX = perch.x; m.homeY = perch.y; m.homeZ = perch.z;
            m.flyT = 0; m.perchT = BIRD_PERCH_SECONDS[0] + rand() * (BIRD_PERCH_SECONDS[1] - BIRD_PERCH_SECONDS[0]);
            m.phase = 'perched';
            m.yaw = rand() * Math.PI * 2;
            m.hoverT = rand();
            made++;
          }
          if (made) return true;
        }
      }
    }
    return false;
  }

  /**
   * 阶段 3c：飞行 AI（纯位移决策，不碰模型、不碰存档）。
   * 三个状态：perched（停在树冠上，翅膀收拢、只小幅转头）→ fly（一次短飞去下一个栖点）
   * → hover（在林冠上方 2.5~6 格巡游，等待下一次起飞）。
   * 三条避让：① 前方实体 → 按 BIRD_TURN_RATE 限速转向；② 低于林冠 +1 → 抬高；
   * ③ 下面是水 → 掉头并回带到家点（与 fishAI 的「前方出水就掉头」对称）。
   * 玩家靠到 BIRD_ESCAPE_DIST 内会立刻起飞躲避 —— 「能遇见」也意味着「会被惊飞」。
   */
  flyAI(m, dt) {
    const ctx = this.ctx, w = ctx.world, c = ctx.controller;
    m.flapPhase = (m.flapPhase || 0) + dt * (m.phase === 'fly' ? BIRD_FLAP_RATE : BIRD_FLAP_RATE * 0.55);
    if (m.hoverT === undefined || !Number.isFinite(m.hoverT)) m.hoverT = 0.5;
    const homeY = m.homeY === undefined ? m.pos.y : m.homeY;
    const hoverY = birdHoverY(homeY, m.hoverT);
    const pdx = c.pos.x - m.pos.x, pdz = c.pos.z - m.pos.z;
    const pd = Math.hypot(pdx, pdz);

    if (m.phase === 'perched') {
      m.perchT -= dt;
      m.moving = false;
      m.turnRate = 0;
      /* 停栖：不写 m.pos —— 位移一律交给通用的 physics(m, dt)（它对每个生物都积分一次速度）。
         这里只把速度压住：垂直顶在栖点站位那一档，水平用同一档弹簧贴回栖点列
         （出生抖动 / 落下残差都在一秒内收掉），下一格不通飞就清零该轴，绝不穿墙贴位。 */
      const sitX = m.perch ? m.perch.x : m.pos.x, sitZ = m.perch ? m.perch.z : m.pos.z;
      m.vel.x = Math.abs(sitX - m.pos.x) < 0.02 ? 0 : Math.max(-0.8, Math.min(0.8, (sitX - m.pos.x) * 6));
      m.vel.z = Math.abs(sitZ - m.pos.z) < 0.02 ? 0 : Math.max(-0.8, Math.min(0.8, (sitZ - m.pos.z) * 6));
      if (m.vel.x && !this.canFlyAt(m.pos.x + m.vel.x * dt, m.pos.y, m.pos.z)) m.vel.x = 0;
      if (m.vel.z && !this.canFlyAt(m.pos.x, m.pos.y, m.pos.z + m.vel.z * dt)) m.vel.z = 0;
      const sitY = m.perch ? birdPerchY(m.perch.y) : m.pos.y;
      m.vel.y = Math.max(-0.8, Math.min(0.8, (sitY - m.pos.y) * 6));
      if (pd < BIRD_ESCAPE_DIST || m.perchT <= 0) {
        m.phase = 'fly';
        m.flyT = BIRD_FLY_SECONDS[0] + Math.random() * (BIRD_FLY_SECONDS[1] - BIRD_FLY_SECONDS[0]);
        const nx = (m.perch ? m.perch.x : m.pos.x) + (Math.random() - 0.5) * 10;
        const nz = (m.perch ? m.perch.z : m.pos.z) + (Math.random() - 0.5) * 10;
        const p = this.findPerchAt(nx, nz, 3);
        m.flyTo = p ? { x: p.x, y: birdHoverY(p.y, 0.5), z: p.z, perch: p } : null;
        m.moving = true;
      }
      return;
    }

    let tx, ty, tz;
    if (m.phase === 'fly') {
      m.flyT -= dt;
      if (!m.flyTo) {
        const nx = (m.homeX || m.pos.x) + (Math.random() - 0.5) * 12;
        const nz = (m.homeZ || m.pos.z) + (Math.random() - 0.5) * 12;
        const p = this.findPerchAt(nx, nz, 3);
        m.flyTo = p ? { x: p.x, y: birdHoverY(p.y, 0.5), z: p.z, perch: p } : null;
      }
      if (m.flyTo) {
        tx = m.flyTo.x; tz = m.flyTo.z;
        /* 最后一段水平误差进闸后就压到栖点站位高度（不再悬在林冠上方 2.5~6 格），
           落下停栖那一帧才是「落到枝上」，不是停栖后再花几秒竖直滑下来。 */
        ty = (m.flyTo.perch && Math.hypot(m.flyTo.x - m.pos.x, m.flyTo.z - m.pos.z) <= BIRD_PERCH_SETTLE_DIST)
          ? birdPerchY(m.flyTo.perch.y) : m.flyTo.y;
      }
      else { tx = m.pos.x; ty = hoverY; tz = m.pos.z; }
      if (m.flyT <= 0) {
        /* 短飞结束：水平误差在 BIRD_PERCH_SETTLE_DIST 内才落下停栖，否则转 hover 再绕回来。
           旧版飞到哪就在哪「停栖」，鸟会冻在离树冠几格远的半空，任何机位看都是悬停。 */
        const lp = m.flyTo && m.flyTo.perch;
        const ldh = lp ? Math.hypot(lp.x - m.pos.x, lp.z - m.pos.z) : Infinity;
        const ldy = lp ? Math.abs(m.pos.y - birdPerchY(lp.y)) : Infinity;
        if (lp && ldh <= BIRD_PERCH_SETTLE_DIST && ldy <= 0.8) {
          m.perch = m.flyTo.perch;
          m.homeX = m.perch.x; m.homeY = m.perch.y; m.homeZ = m.perch.z;
          m.phase = 'perched';
          m.perchT = BIRD_PERCH_SECONDS[0] + Math.random() * (BIRD_PERCH_SECONDS[1] - BIRD_PERCH_SECONDS[0]);
          m.flyTo = null;
          return;
        }
        if (lp && ldh <= BIRD_PERCH_SETTLE_DIST) {
          /* 水平已到位但还偏高：补一段下降腿（目标就是栖点站位），下一帧到高度再落 */
          m.flyT = 0.9;
          m.flyTo = { x: lp.x, y: birdPerchY(lp.y), z: lp.z, perch: lp };
          return;
        }
        m.phase = 'hover';
        m.flyTo = null;
      }
    } else {
      /* hover：在林冠上方高度带里巡游，偶尔换高度，让「飞」看得出来在动 */
      if (Math.random() < dt * 0.5) m.hoverT = Math.random();
      if (Math.random() < dt * 0.35) m.heading = Math.random() * Math.PI * 2;
      const h = m.heading === undefined ? m.yaw : m.heading;
      tx = m.pos.x + Math.sin(h) * 4; tz = m.pos.z + Math.cos(h) * 4; ty = birdHoverY(homeY, m.hoverT);
      if (Math.random() < dt * 0.25) {
        m.phase = 'fly';
        m.flyT = BIRD_FLY_SECONDS[0] + Math.random() * (BIRD_FLY_SECONDS[1] - BIRD_FLY_SECONDS[0]);
        m.flyTo = null;
      }
    }

    let dx = tx - m.pos.x, dz = tz - m.pos.z;
    let d = Math.hypot(dx, dz);
    const _yaw0 = m.yaw;                     // 本帧起算朝向：turnRate 数的是「真的转了多少」
    if (d < 1e-3) { dx = 0; dz = 0; }
    else { dx /= d; dz /= d; }
    /* 转向限速：目标方位只能每秒改 BIRD_TURN_RATE 弧度，玩家看得见「它在转弯」而不是抽搐 */
    if (dx || dz) m.yaw = approachYaw(m.yaw, Math.atan2(dx, dz), dt);
    let vx = Math.sin(m.yaw), vz = Math.cos(m.yaw);
    const speed = m.phase === 'fly' ? BIRD_FLY_SPEED : BIRD_HOVER_SPEED;

    /* 避让 ①：正前方一格有实体 → 转 90° 以上再飞（宁可绕，不撞墙） */
    const ax = m.pos.x + vx * 1.1, az = m.pos.z + vz * 1.1;
    if (!this.canFlyAt(ax, m.pos.y, az)) {
      m.yaw += 2.1;
      if (m.phase === 'fly') { m.flyT = Math.min(m.flyT, 0.6); }
      vx = Math.sin(m.yaw); vz = Math.cos(m.yaw);
    }
    /* 避让 ③：下面是水 → 掉头并回带到家点 */
    const wx = m.pos.x + vx * 1.0, wz = m.pos.z + vz * 1.0;
    if (w.getBlock(Math.floor(wx), Math.floor(m.pos.y), Math.floor(wz)) === B.WATER ||
      w.getBlock(Math.floor(wx), Math.floor(m.pos.y - 1), Math.floor(wz)) === B.WATER) {
      m.yaw += 2.4;
      vx = Math.sin(m.yaw); vz = Math.cos(m.yaw);
    }
    m.vel.x = vx * speed;
    m.vel.z = vz * speed;
    let _dyaw = m.yaw - _yaw0;
    while (_dyaw > Math.PI) _dyaw -= Math.PI * 2;
    while (_dyaw < -Math.PI) _dyaw += Math.PI * 2;
    m.turnRate = dt > 0 ? _dyaw / dt : 0;                // 尾舵由「这一帧实际转过的角速度」驱动

    /* 避让 ②：高度下限看「脚下这一列」的林冠顶/地表（不是旧栖点的高度，
       否则从高的树换到矮的树时会被旧高度顶住，永远落不到新枝上），上限不超世界顶 */
    const fx = Math.floor(m.pos.x), fz = Math.floor(m.pos.z);
    const colTop = this.canopyTopAt(fx, fz);
    const floorY = colTop ? colTop.y + 1 : w.surfaceHeight(fx, fz);
    const wantY = Math.max(floorY, Math.min(w.topY - 2, ty));
    m.vel.y = Math.max(-1.2, Math.min(1.2, (wantY - m.pos.y) * 2.2));
    m.moving = true;
    /* 位移交给通用的 physics(m, dt)（它自己会做分步碰撞），这里只提前检查「下一步要不要走」：
       前方/上方那一格不能飞就把对应速度清零，宁可悬停也不让鸟埋进石头或穿树叶。 */
    const look = Math.max(0.35, speed * dt * 2);
    if (!this.canFlyAt(m.pos.x + vx * look, m.pos.y, m.pos.z + vz * look)) { m.vel.x = 0; m.vel.z = 0; }
    /* 垂直用「下一步」而不是固定 0.9 格：落枝要能贴到栖点站位（叶面上 0.05），
       固定余量会在半空把下降腿顶住，落下停栖闸就永远等不到高度条件 */
    if (!this.canFlyAt(m.pos.x, m.pos.y + m.vel.y * dt, m.pos.z)) m.vel.y = 0;
  }

  /* T6 驯服狼：坐下不动；起身后先打附近敌对生物，否则跟随玩家 */
  wolfAI(m, dt) {
    const c = this.ctx.controller;
    if (m.sitting) {
      m.moving = false;
      m.vel.x *= Math.pow(0.02, dt);
      m.vel.z *= Math.pow(0.02, dt);
      const dx = c.pos.x - m.pos.x, dz = c.pos.z - m.pos.z;
      if (Math.hypot(dx, dz) > 0.01) m.yaw = Math.atan2(dx, dz);
      return;
    }
    let target = null, best = WOLF_HUNT_RANGE;
    for (const other of this.list) {
      if (other === m || other.dead || other.hp <= 0 || !other.def.hostile) continue;
      const d = Math.hypot(other.pos.x - m.pos.x, other.pos.z - m.pos.z);
      if (d < best) { best = d; target = other; }
    }
    let dx, dz;
    if (target) { dx = target.pos.x - m.pos.x; dz = target.pos.z - m.pos.z; }
    else {
      dx = c.pos.x - m.pos.x; dz = c.pos.z - m.pos.z;
      if (Math.hypot(dx, dz) <= WOLF_FOLLOW_RANGE) {
        m.moving = false;
        m.vel.x *= Math.pow(0.02, dt);
        m.vel.z *= Math.pow(0.02, dt);
        return;
      }
    }
    const dist = Math.hypot(dx, dz) || 1;
    m.yaw = Math.atan2(dx, dz);
    if (target && dist <= WOLF_ATTACK_RANGE && m.attackCd <= 0) {
      this.hitMob(target, m.def.damage || 3, { x: dx / dist, z: dz / dist }, { marker: false });
      m.attackCd = 1.0;
      m.animAttack = MOB_ATTACK_POSE_SECONDS;   /* A：狼扑也走同一套攻击姿态（前腿前扑 + 头前倾） */
      m.vel.x *= 0.2; m.vel.z *= 0.2;
      m.moving = false;
      return;
    }
    const speed = m.def.speed || 3;
    m.vel.x += (dx / dist * speed - m.vel.x) * Math.min(1, 10 * dt);
    m.vel.z += (dz / dist * speed - m.vel.z) * Math.min(1, 10 * dt);
    m.moving = true;
    if (m.onGround && this.blockInFront(m)) m.vel.y = 7.2;
  }

  /* 滚动任务 6：村民只在自己的村子附近散步；玩家靠近时会转头看向玩家。
     没有战斗、没有繁殖，也不会被野兽主动攻击（狼只找 hostile）。 */
  villagerAI(m, dt) {
    const c = this.ctx.controller;
    const home = m.home;
    const dxp = c.pos.x - m.pos.x, dzp = c.pos.z - m.pos.z;
    const dp = Math.hypot(dxp, dzp);
    if (dp < 3 && dp > 0.01) {           // 玩家贴近：停下并看过来（交易时的观感）
      m.yaw = Math.atan2(dxp, dzp);
      m.moving = false;
      m.vel.x *= Math.pow(0.02, dt);
      m.vel.z *= Math.pow(0.02, dt);
      return;
    }
    const dh = home ? Math.hypot(home.x - m.pos.x, home.z - m.pos.z) : 0;
    let wantX = 0, wantZ = 0;
    if (home && dh > 7) {                // 走远了：直线回家
      const dx = home.x - m.pos.x, dz = home.z - m.pos.z, d = Math.hypot(dx, dz) || 1;
      m.yaw = Math.atan2(dx, dz);
      wantX = dx / d; wantZ = dz / d;
      m.moving = true;
      m.wanderT = 0.8;
    } else {
      m.wanderT -= dt;
      if (m.wanderT <= 0) {
        m.wanderT = 2.2 + Math.random() * 4.0;
        if (Math.random() < 0.45) { m.yaw = Math.random() * Math.PI * 2; m.walking = false; }
        else { m.walking = true; m.yaw += (Math.random() - 0.5) * 1.4; }
      }
      if (m.walking) { wantX = Math.sin(m.yaw); wantZ = Math.cos(m.yaw); m.moving = true; }
      else m.moving = false;
    }
    if ((wantX || wantZ) && !this.canStandAt(m.pos.x + wantX * 0.6, m.pos.y, m.pos.z + wantZ * 0.6)) {
      m.yaw += 1.9; m.wanderT = 0.7; m.walking = true; wantX = 0; wantZ = 0;
    }
    const speed = 1.15;
    m.vel.x += (wantX * speed - m.vel.x) * Math.min(1, 9 * dt);
    m.vel.z += (wantZ * speed - m.vel.z) * Math.min(1, 9 * dt);
    if (m.inWater > 0.2) m.vel.y = 2.6;
    if ((wantX || wantZ) && m.onGround && this.blockInFront(m)) m.vel.y = 6.8;
  }

  /* T5：苦力怕的充能。靠近就嘶嘶（播放一次 hiss + 模型胀大），到点引爆；
     充能途中玩家跑出 ESCAPE 距离就取消 —— 原版就是这种「点燃后你可以逃」的手感。
     被击杀则不引爆（kill 走掉落，见 C4 单测）。 */
  creeperFuse(m, dt, d2) {
    if (!m.def.explode) return;
    const c = this.ctx.controller;
    const playing = this.ctx.game.state === 'playing';
    const dist = Math.sqrt(d2);
    if (!(m.def.hostile && c.health > 0 && playing) || dist > CREEPER_ESCAPE) {
      /* 拉开距离就取消：充能态、引信、嘶声节拍、档位一起清干净，
         不许留「已经嘶嘶响到一半」的状态（读档/重遇时它会莫名其妙接着炸）。 */
      if (m.charging) { m.charging = false; m.fuse = CREEPER_FUSE_SECONDS; m.hissT = 0; m.fuseStage = 0; }
      return;
    }
    if (dist <= CREEPER_TRIGGER) {
      if (!m.charging) {
        /* 阶段 3b：隔墙不点火 —— 起手嘶嘶要有视线（原版：看不见就不点燃）。
           已经点燃的引信不复查视线，仍只按 CREEPER_ESCAPE 距离取消。 */
        if (!this.lineOfSightToPlayer(m, c)) return;
        m.charging = true;
        m.fuse = CREEPER_FUSE_SECONDS;
        m.fuseStage = 0;
        m.hissT = CREEPER_HISS_GAP[0];
        if (this.ctx.sfx.playWorld) this.ctx.sfx.playWorld('hiss', m.pos, { volume: 0.55 });
        else this.ctx.sfx.play('hiss', { volume: 0.55 });
      }
      m.fuse -= dt;
      /* 阶段 3b：引信分三档（按剩余秒数的三分之一切），嘶声按档位加密、音调按档位升高。
         原来只在起手叫一声，之后 1.5 秒里玩家既听不出「还剩多少」、也看不出该不该跑。
         档位与间隔都由**剩余秒数**决定，不由帧数决定 —— 打包版帧长抖动不会改变节奏。 */
      const f = Math.max(0, m.fuse);
      m.fuseStage = f > CREEPER_FUSE_SECONDS * 2 / 3 ? 0 : f > CREEPER_FUSE_SECONDS / 3 ? 1 : 2;
      m.hissT -= dt;
      if (m.hissT <= 0 && f > 0) {
        m.hissT = CREEPER_HISS_GAP[m.fuseStage];
        if (this.ctx.sfx.playWorld) this.ctx.sfx.playWorld('hiss', m.pos, { volume: 0.55, rate: 1.2 + 0.22 * m.fuseStage });
        else this.ctx.sfx.play('hiss', { volume: 0.55, rate: 1.2 + 0.22 * m.fuseStage });
      }
      if (m.fuse <= 0) { m.fuse = 0; this.detonate(m); }
    }
  }

  /* 引爆：先从列表里摘掉（不掉东西，与原版一致），再交给 Game 结算方块与伤害 */
  detonate(m) {
    const i = this.list.indexOf(m);
    if (i >= 0) this.list.splice(i, 1);
    const g = this.ctx.game;
    if (g && typeof g.onCreeperExplode === 'function') g.onCreeperExplode(m);
    m.remove(this.scene);
  }

  /* 正前方贴着的会不会是一堵墙（而不是悬崖）：脚下那一格是实心 = 墙 */
  wallAhead(m, wantX, wantZ) {
    const w = this.ctx.world;
    // 取样点要越过接触面：生物贴着墙时「自己那一格」是空气，墙在半个身位之外
    const reach = m.width / 2 + 0.2;
    const fx = Math.floor(m.pos.x + wantX * reach), fz = Math.floor(m.pos.z + wantZ * reach);
    const fy = Math.floor(m.pos.y + 0.2);
    return w.isSolidAt(fx, fy, fz);
  }

  blockInFront(m) {
    const w = this.ctx.world;
    // 与 ai() 里的移动方向保持同一套正面约定（D3）
    const fx = Math.floor(m.pos.x + Math.sin(m.yaw) * 0.7);
    const fz = Math.floor(m.pos.z + Math.cos(m.yaw) * 0.7);
    const fy = Math.floor(m.pos.y);
    return w.isSolidAt(fx, fy, fz) && !w.isSolidAt(fx, fy + 1, fz) && !w.isSolidAt(fx, fy + 2, fz);
  }

  physics(m, dt) {
    const w = this.ctx.world;
    const feet = w.getBlock(Math.floor(m.pos.x), Math.floor(m.pos.y), Math.floor(m.pos.z));
    const below = w.getBlock(Math.floor(m.pos.x), Math.floor(m.pos.y - 0.1), Math.floor(m.pos.z));
    m.inWater = (feet === B.WATER || below === B.WATER) ? 1 : 0;
    if (m.climbing) {
      m.vel.y = CLIMB_SPEED;                 // 蜘蛛贴墙上升：这一帧不按重力往下拽
    } else if (m.def.flying) {
      /* 阶段 3c：飞行生物的「升力」由 flyAI 每帧算进 vel.y（悬停高度带、降落、起飞都在那里），
         这里再叠一次重力就会把悬停压成锯齿下落，鸟看着像在往下掉。 */
    } else if (!m.inWater) {
      m.vel.y -= 24 * dt;
      if (m.vel.y < -50) m.vel.y = -50;
    } else {
      m.vel.y -= 6 * dt;
      if (m.vel.y < -2) m.vel.y = -2;
    }
    const hw = m.width / 2;
    const solid = (x, y, z) => {
      const id = w.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
      const b = id === undefined ? null : null;
      return w.isSolidAt(Math.floor(x), Math.floor(y), Math.floor(z));
    };
    const hit = (px, py, pz) => {
      const x0 = Math.floor(px - hw + 1e-4), x1 = Math.floor(px + hw - 1e-4);
      const y0 = Math.floor(py + 1e-4), y1 = Math.floor(py + m.height - 1e-4);
      const z0 = Math.floor(pz - hw + 1e-4), z1 = Math.floor(pz + hw - 1e-4);
      const bpx0 = px - hw, bpx1 = px + hw, bpy0 = py, bpy1 = py + m.height, bpz0 = pz - hw, bpz1 = pz + hw;
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const id = w.getBlock(x, y, z);
        if (!w.isSolidAt(x, y, z)) continue;
        const boxes = blockBoxes(id, w.getMeta ? w.getMeta(x, y, z) : 0);
        if (boxes.length === 1 && boxes[0][1] === 0 && boxes[0][4] === 1) return true;
        for (const b of boxes) {
          if (bpx1 > x + b[0] + 1e-4 && bpx0 < x + b[3] - 1e-4 &&
              bpy1 > y + b[1] + 1e-4 && bpy0 < y + b[4] - 1e-4 &&
              bpz1 > z + b[2] + 1e-4 && bpz0 < z + b[5] - 1e-4) return true;
        }
      }
      return false;
    };
    // 分步移动
    const step = 0.35;
    let dx = m.vel.x * dt, dy = m.vel.y * dt, dz = m.vel.z * dt;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) / step));
    dx /= n; dy /= n; dz /= n;
    for (let k = 0; k < n; k++) {
      if (!hit(m.pos.x + dx, m.pos.y, m.pos.z)) m.pos.x += dx; else m.vel.x = 0;
      if (!hit(m.pos.x, m.pos.y, m.pos.z + dz)) m.pos.z += dz; else m.vel.z = 0;
      if (!hit(m.pos.x, m.pos.y + dy, m.pos.z)) { m.pos.y += dy; m.onGround = false; }
      else {
        if (dy < 0) {
          m.pos.y = Math.floor(m.pos.y + dy) + 1 + 1e-4;
          m.onGround = true;
        }
        m.vel.y = 0;
      }
    }
    /* 掉出世界底部：判据要跟着布局走（与 controller.js 同一处修正）。
       旧布局底部 0 → 这里是 -6；新档底部 -64，写死 -6 会把深层的猪/鱼一掉到 -7 就直接抹掉。 */
    const wBottom = Number.isFinite(w.minY) ? w.minY : 0;
    if (m.pos.y < wBottom - 6) m.hp = 0;
  }

  render(m, dt, dayFactor = 1) {
    m.mesh.position.set(m.pos.x, m.pos.y, m.pos.z);
    m.mesh.rotation.y = m.yaw;                 /* D3 回归钉死：朝向只由 yaw 决定，姿态不得改写 */
    const parts = m.mesh.userData.parts;
    /* A：姿态只作用于部件旋转 + body 部件自身 scale.y，不碰 position / 碰撞 / 群组缩放
       （史莱姆 size 与幼崽 BABY_SCALE 都靠群组 scale，V4/SL 也靠生命周期不被动） */
    const pose = computePose(m, dt);
    m.pose = pose;
    const t = m.age * (m.moving ? 9 : 2.2);
    const sw = m.moving ? 0.55 : 0.06;
    const hasArms = !!parts.arm0;
    const lunge = hasArms ? 0 : pose.atkFront;   /* 没手臂的生物（狼/苦力怕/蜘蛛/动物/史莱姆）用前腿前扑表达攻击 */
    if (parts.leg0) { parts.leg0.rotation.x = Math.sin(t) * sw - lunge; parts.leg1.rotation.x = -Math.sin(t) * sw - lunge; }
    if (parts.leg2) { parts.leg2.rotation.x = -Math.sin(t) * sw; parts.leg3.rotation.x = Math.sin(t) * sw; }
    /* T4 蜘蛛有八条腿：后四条沿用同一套相位（偶数左、奇数右，对角交替） */
    if (parts.leg4) { parts.leg4.rotation.x = Math.sin(t) * sw; parts.leg5.rotation.x = -Math.sin(t) * sw; }
    if (parts.leg6) { parts.leg6.rotation.x = -Math.sin(t) * sw; parts.leg7.rotation.x = Math.sin(t) * sw; }
    if (parts.arm0) { parts.arm0.rotation.x = pose.arm0; parts.arm1.rotation.x = pose.arm1; }
    if (parts.head) { parts.head.rotation.x = pose.headX; parts.head.rotation.y = pose.headY; }
    if (parts.body) parts.body.scale.y = pose.bodyScaleY;
    /* 阶段 3a：鱼的尾鳍左右扫 + 胸鳍反相小幅摆动（陆上生物没有 tail，这条整段跳过） */
    if (parts.tail) {
      /* pose.rudder 对非飞行生物恒为 0（computePose 里就判了 def.flying），
         所以这一处加法对鱼/其它生物的既有读数逐位无影响 */
      parts.tail.rotation.y = pose.finSwim + (pose.rudder || 0);
      if (parts.finTop) parts.finTop.rotation.z = pose.finSwim * 0.22;
      if (parts.finL) { parts.finL.rotation.z = 0.18 + pose.finSwim * 0.5; parts.finR.rotation.z = -0.18 + pose.finSwim * 0.5; }
    }
    /* 阶段 3c：翅膀。两片部件的几何体已经按 'left'/'right' 推到身体边缘（铰链在肩上），
       所以这里只写 rotation.z 就是「翼尖抬起/落下」，不是整片翅膀自转；
       收拢（wingFold）与拍动（wingFlap）都来自 computePose 的有界数值，render 不做任何决策。 */
    if (parts.wingL && parts.wingR) {
      const flap = pose.wingFlap || 0, fold = pose.wingFold || 0;
      parts.wingL.rotation.z = -(flap + fold);
      parts.wingR.rotation.z = flap + fold;
    }
    /* 阶段 3b：骷髅的「先拉后放」要看得见 —— 弓弦拆成上下两段，拉弦点随 bowDraw 从弓腹退到脸颊，
       箭只在拉弦阶段出现并跟着拉弦点走。数值全来自 pose.bowDraw 与两个纯函数，render 只写部件。 */
    const bow = parts.bow;
    if (bow && bow.userData.stringUpper) {
      const dr = pose.bowDraw || 0;
      const nockZ = bowNockZ(dr);
      const up = stringSeg(SKELETON_BOW_TIP_Y, SKELETON_BOW_TIP_Z, 0, nockZ);
      const lo = stringSeg(-SKELETON_BOW_TIP_Y, SKELETON_BOW_TIP_Z, 0, nockZ);
      const su = bow.userData.stringUpper, sl = bow.userData.stringLower;
      su.position.set(0, up.y, up.z); su.rotation.x = up.rotX; su.scale.y = up.scale / su.userData.segLen;
      sl.position.set(0, lo.y, lo.z); sl.rotation.x = lo.rotX; sl.scale.y = lo.scale / sl.userData.segLen;
      const ar = bow.userData.arrow;
      ar.visible = dr > 0.02;
      ar.position.set(0, 0.02, nockZ + 0.14);      // 箭尾挨着拉弦点，箭头朝前
      bow.rotation.x = -0.12 * dr;                 // 拉满时弓略微抬起（对准视线）
      bow.userData.nockZ = nockZ;                  // 拉弦点本身（弦两段的 position 是它们的中点，不能当读数）
    }
    m.mesh.rotation.z = pose.tiltZ;
    // 受伤闪红；T5 苦力怕充能时胀大并闪白（原版就是「嘶——」然后鼓起来）
    if (m.def.explode) {
      const k = m.charging ? 1 + 0.28 * (1 - Math.max(0, m.fuse) / CREEPER_FUSE_SECONDS) : 1;
      m.mesh.scale.setScalar(k);
    }
    /* P1：生物采样世界光照（验收报告已知问题 #28 的第一半）。
       以前所有生物材质都是纯色，洞穴里的猪和太阳底下的猪一样亮 → 「生物不像活在这个世界里」。
       曲线与体素 shader 同源（core/entitylight.js + e2e EL.2 把两边钉在一起），
       0.2 秒才取一次光、并且只在闪色状态或亮度真的变了时才重刷材质，不每帧 traverse。 */
    const w = this.ctx && this.ctx.world;
    if (w) {
      m._lightT = (m._lightT || 0) + dt;
      if (m._shade === undefined || m._lightT > 0.2) {
        m._lightT = 0;
        /* 昼夜系数必须跟地形用的是**同一个值**：view 里的 uDay 是 (0.36+0.64·dayFactor)·天气系数，
           不是原始 dayFactor。直接拿原始值会让生物比地形暗一档（雨天尤其明显）。 */
        const uDay = this.ctx.game && this.ctx.game.view && this.ctx.game.view.uniforms
          ? this.ctx.game.view.uniforms.uDay.value : dayFactor;
        const l = w.getLight(Math.floor(m.pos.x), Math.floor(m.eyeY), Math.floor(m.pos.z));
        m._shade = entityBrightness(l >> 4, l & 15, uDay);
      }
    } else if (m._shade === undefined) m._shade = 1;
    const shade = m._shade === undefined ? 1 : m._shade;
    /* 阶段 3b：苦力怕的引信要「看得出阶段」。
       原来充能只是恒亮闪白 + 连续胀大，玩家在 1.5 秒里看不出还剩多少；
       现在按档位改闪烁频率（0 档 3Hz → 1 档 5.5Hz → 2 档 9Hz），
       相位用「已经过了多少秒」算，不用帧数 —— 打包版一帧 54ms 也不会改变闪烁节奏。 */
    let blink = true;
    if (m.charging) {
      const hz = m.fuseStage >= 2 ? 9 : m.fuseStage === 1 ? 5.5 : 3;
      blink = Math.sin((CREEPER_FUSE_SECONDS - Math.max(0, m.fuse)) * hz * Math.PI * 2) > 0;
    }
    const flash = m.hurtT > 0 ? 1 : (m.charging ? (blink ? 2 : 0) : 0);
    if (m._flash !== flash || m._appliedShade !== shade) {
      m._flash = flash;
      m._appliedShade = shade;
      m.mesh.traverse(o => {
        if (o.isMesh && o.material) {
          /* 阶段 3b：贴图的盒子用六面材质数组（正面眼窝、侧面脊柱），
             基准色取第一面即可（贴图件的颜色一律留白 0xffffff，压暗与闪红是「乘」在贴图上）。 */
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          if (!o.userData.base) o.userData.base = mats[0].color.getHex();
          const base = o.userData.base;
          const tint = flash === 2 ? 0xf2f2e6 : flash ? hurtTint(base) : base;
          const hex = shadeColor(tint, shade);
          for (const mm of mats) mm.color.setHex(hex);
        }
      });
    }
  }

  /* ---------- 战斗 ---------- */
  hitMob(m, damage, knockDir, opts) {
    /* V4：已经死亡的生物不能再被结算一次（否则会重复掉血/掉落，甚至把尸体再杀一遍） */
    if (!m || m.dead || m.hp <= 0) return false;
    /* 阶段 5：封印未解开时守卫免疫伤害 —— 准备材料（深板岩）才是挑战的入场券，
       否则玩家可以跳过深矿直接砍死它，任务书要的「备装 → 挑战」动机链就断了。
       这里返回 false（没有命中），准星/命中标记/音效都不会假装打到了。 */
    if (m.def.guardian && this._guardianArmed === false) {
      const g = this.ctx.game;
      if (g && g.ui && g.ui.toast && !this._guardianSealHint) {
        this._guardianSealHint = 1;
        g.ui.toast('封印护着它 · 先在四座石座上各放一块深板岩', false, 3200);
      }
      return false;
    }
    const quiet = !!(opts && opts.quiet);
    const marker = !(opts && opts.marker === false);
    m.hp -= damage;
    /* 阶段 5：守卫血量与击败状态同步回地点状态。结算只在这里触发一次 ——
       kill() 会把 Mob 从 list 移除，下一帧 guardianAI 就再也跑不到，不能等它发 defeated 事件。 */
    if (m.def.guardian && this.guardianState) {
      this.guardianState.hp = Math.max(0, m.hp);
      if (m.hp <= 0 && !this.guardianState.defeated) {
        this.guardianState.defeated = 1;
        this.guardianState.phase = GUARDIAN_PHASE.DEAD;
        const g = this.ctx.game;
        if (g && typeof g.onGuardianDefeated === 'function') g.onGuardianDefeated(this.guardianSite);
      }
    }
    m.hurtT = 0.32;
    /* A：受击打断攻击姿态——被打的瞬间抬手动作清零，由 hurtT 接管（单测 A2 钉优先级） */
    m.animAttack = 0;
    if (knockDir) {
      m.vel.x += knockDir.x * 5.2;
      m.vel.z += knockDir.z * 5.2;
      if (m.onGround) m.vel.y = 3.4;
      /* 第二轮 SK.7：把**实际施加的冲量**记下来。旧验收在下一帧采样速度峰值，
         会被同一帧的物理阻尼/碰撞抵消掉（实测 3.49 vs 门槛 3.5），既不能证明没打，
         也不能证明打了。这里记录施加瞬间的方向与冲量，配合同一段的真实位移做判据。 */
      this.lastKnockback = {
        type: m.type, ix: +knockDir.x.toFixed(3), iz: +knockDir.z.toFixed(3),
        impulse: 5.2, speedAfter: +Math.hypot(m.vel.x, m.vel.z).toFixed(3), at: Date.now()
      };
    }
    if (!quiet) {
      this.ctx.particles.spawn(m.pos.x, m.eyeY, m.pos.z, [0.7, 0.05, 0.05], 6, 0.5, 1.6);
      /* 本轮 E2：命中生物与命中护甲分开身份，并且用世界声源播放（近处实、远处虚）。
         原来这里固定播 'hit'，和守卫横扫共用一条音色，听不出打到了什么。 */
      const sfx = this.ctx.sfx;
      /* 这里只处理「玩家打中生物」；护甲音是玩家自己挨打且护甲吸收时的那一层（见 game.js）。 */
      const base = 'hit_flesh';
      this._hitVariant = ((this._hitVariant || 0) + 1) % 3;
      const name = base + ['', '_b', '_c'][this._hitVariant];
      const opts = { volume: 0.72, rate: 0.97 + Math.random() * 0.06 };
      if (sfx.playWorld) sfx.playWorld(name, m.pos, opts);
      else sfx.play(name, opts);
    }
    // T3：命中反馈（准星命中标记 + 计数）；狼/闪电等非玩家攻击不点亮玩家命中标记
    if (marker && this.ctx.game && this.ctx.game.onMobHit) this.ctx.game.onMobHit(m, damage);
    if (m.hp <= 0) this.kill(m, true);
    return true;
  }

  kill(m, byPlayer) {
    const ctx = this.ctx;
    if (m.dead) return;               // V4：同一次死亡只结算一次（掉落/分裂/音效都不重复）
    m.dead = true;
    /* T6 史莱姆分裂：大/中号被击杀后拆成 2~3 只更小的（不掉落），最小的才掉粘液球 */
    if (byPlayer !== false && m.def.split && m.slimeSize > 1) {
      const half = m.slimeSize > 2 ? 2 : 1;
      const n = 2 + (Math.random() < 0.5 ? 1 : 0);
      ctx.particles.spawn(m.pos.x, m.eyeY, m.pos.z, [0.45, 0.85, 0.4], 14, 0.7, 2.0);
      ctx.sfx.play('slime', { volume: 0.6, rate: 0.85 });
      m.remove(this.scene);
      const i = this.list.indexOf(m);
      if (i >= 0) this.list.splice(i, 1);
      for (let k = 0; k < n; k++) {
        this.spawn('slime', m.pos.x + (k - (n - 1) / 2) * 0.35, m.pos.y + 0.1, m.pos.z + (k % 2 ? 0.2 : -0.2),
          { slimeSize: half });
      }
      return;
    }
    ctx.particles.spawn(m.pos.x, m.eyeY, m.pos.z, [0.8, 0.2, 0.2], 12, 0.6, 1.8);
    if (byPlayer !== false) {
      /* 幼崽不掉任何东西（与原版一致） */
      for (const d of (m.isBaby ? [] : (m.def.drop || []))) {
        if (d.chance !== undefined && Math.random() > d.chance) continue;
        const n = d.count + (d.bonus ? Math.floor(Math.random() * (d.bonus + 1)) : 0);
        if (n > 0) ctx.game.spawnDrop(d.item, n, m.pos.x, m.pos.y + 0.3, m.pos.z);
      }
      /* 本轮 D：生物死亡声带方向与距离（旧实现只有音量，听不出死在哪边） */
      const name = m.def.sound || (m.def.hostile ? 'zombie' : 'pig');
      if (ctx.sfx.playWorld) ctx.sfx.playWorld(name, m.pos, { volume: 0.7 });
      else ctx.sfx.play(name, { volume: 0.6 });
    }
    m.remove(this.scene);
    const i = this.list.indexOf(m);
    if (i >= 0) this.list.splice(i, 1);
  }

  shootArrow(m, dx, dz, dist) {
    const w = this.ctx.world;
    const geo = new THREE.BoxGeometry(0.08, 0.08, 0.6);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xcfcfc6 }));
    const dy = (m.pos.y + 1.2) - (this.ctx.controller.pos.y + 1.2);
    const len = Math.hypot(dx, dz, dy) || 1;
    mesh.position.set(m.pos.x, m.eyeY, m.pos.z);
    this.scene.add(mesh);
    this.arrows.push({
      mesh, x: m.pos.x, y: m.eyeY, z: m.pos.z,
      vx: dx / len * 22, vy: dy / len * 22 + 0.6, vz: dz / len * 22,
      life: 6, fromMob: true, damage: m.def.damage || 2
    });
    this.ctx.sfx.playWorld ? this.ctx.sfx.playWorld('bow', m.pos, { volume: 0.5 }) : this.ctx.sfx.play('bow', { volume: 0.5 });
  }

  /* T3 玩家射出一箭：power(0~1) 决定初速度与伤害；箭是实体，命中生物走同一套 hitMob */
  firePlayerArrow(dir, power) {
    const c = this.ctx.controller;
    const p = Math.max(0, Math.min(1, power));
    const speed = arrowSpeedFor(p), damage = arrowDamageFor(p);
    const geo = new THREE.BoxGeometry(0.08, 0.08, 0.6);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xdadacf }));
    const x = c.pos.x + dir.x * 0.7, y = c.eyeY - 0.1, z = c.pos.z + dir.z * 0.7;
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    this.arrows.push({
      mesh, x, y, z,
      vx: dir.x * speed, vy: dir.y * speed + 0.5 * p, vz: dir.z * speed,
      life: 6, fromMob: false, damage, power: p
    });
    /* 玩家开弓：弦的释放单独一条身份（骷髅仍用自己的 bow），力度越大越亮。 */
    this._bowVariant = ((this._bowVariant || 0) + 1) % 2;
    this.ctx.sfx.play('bow_release' + ['', '_b'][this._bowVariant], { volume: 0.62 + 0.22 * p, rate: 0.96 + 0.12 * p });
    return { speed, damage };
  }

  /* 单支箭在这一帧是否命中目标（玩家或生物）。命中返回 true。 */
  _arrowStrike(a) {
    const c = this.ctx.controller;
    if (a.fromMob) {
      const dx = a.x - c.pos.x, dy = a.y - (c.pos.y + 0.9), dz = a.z - c.pos.z;
      if (dx * dx + dz * dz < 0.45 * 0.45 && Math.abs(dy) < 1.0) { c.hurt(a.damage, '被箭射中', 'arrow', { x: a.x - a.vx * 0.05, z: a.z - a.vz * 0.05, kind: 'arrow' }); return true; }
      return false;
    }
    for (const m of this.list) {
      if (m.hp <= 0) continue;
      if (arrowHitsBox(a, { x: m.pos.x, y: m.pos.y, z: m.pos.z, w: m.width, h: m.height })) {
        const kx = Math.abs(a.vx) >= Math.abs(a.vz) ? (Math.sign(a.vx) || 1) : 0;
        const kz = kx === 0 ? (Math.sign(a.vz) || 1) : 0;
        this.hitMob(m, a.damage, { x: kx, z: kz });
        return true;
      }
    }
    return false;
  }

  updateArrows(dt) {
    const c = this.ctx.controller, w = this.ctx.world, inv = this.ctx.inventory;
    const isSolid = (x, y, z) => w.isSolidAt(x, y, z);
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      let status;
      if (a.stuck) {
        status = stepArrow(a, dt, isSolid);
      } else {
        // 分小步推进：满蓄力的箭一帧能飞 0.7 格，不分步会直接穿过 0.6 宽的生物（隧穿）
        const sp = Math.hypot(a.vx, a.vy, a.vz);
        const sub = Math.max(1, Math.min(8, Math.ceil(sp * dt / 0.2)));
        status = 'flying';
        for (let k = 0; k < sub; k++) {
          status = stepArrow(a, dt / sub, isSolid);
          if (status !== 'flying') break;
          if (this._arrowStrike(a)) { status = 'hit'; break; }
        }
      }
      if (status === 'stuck' && !a.hitSound) {
        /* 箭扎到实体表面：一次命中一声，用箭的实际位置做世界声源 */
        a.hitSound = true;
        this._arrowVariant = ((this._arrowVariant || 0) + 1) % 2;
        const name = 'arrow_hit' + ['', '_b'][this._arrowVariant];
        const opts = { volume: 0.5, rate: 0.98 + Math.random() * 0.05 };
        if (this.ctx.sfx.playWorld) this.ctx.sfx.playWorld(name, { x: a.x, y: a.y, z: a.z }, opts);
        else this.ctx.sfx.play(name, opts);
      }
      if (status === 'stuck' && !a.fromMob && !a.lifeExtended) {   // 玩家箭插在地上，留一段时间可拾回
        a.lifeExtended = true;
        a.life = ARROW_STUCK_LIFE;
      }
      if (a.stuck && !a.fromMob && inv && canPickupStuck(a, c.pos.x, c.pos.y, c.pos.z)) {
        const left = inv.add('arrow', 1);
        if (left <= 0) {
          this.ctx.sfx.play('pickup', { volume: 0.5 });
          if (this.ctx.game && this.ctx.game.onPickup) this.ctx.game.onPickup('arrow', 1);
          status = 'hit';
        }
      }
      a.mesh.position.set(a.x, a.y, a.z);
      a.mesh.rotation.set(Math.atan2(a.vy, Math.hypot(a.vx, a.vz)), Math.atan2(-a.vx, -a.vz), 0);
      if (status === 'hit' || status === 'expired') {
        this.scene.remove(a.mesh);
        a.mesh.geometry.dispose(); a.mesh.material.dispose();
        this.arrows.splice(i, 1);
      }
    }
  }

  /* 视线内最近的生物（近战、剪毛、喂食与村民交易共用同一套目标选择）。
     瞄准点取生物身体的几何中心（相对玩家脚下），而不是「眼睛高度减固定值」——
     后者对 1.9 格高的村民会把判定中心压到膝盖，玩家明明看着头也点不中。
     这里沿用原来「射线原点视作脚下、再减去 1.2」的约定，避免打断既有动物用例，
     只把身高系数从 0.85 改成 0.5，让高个子目标真正可点。 */
  pickNearest(maxDist = 3.6, filter = null) {
    const c = this.ctx.controller;
    const d = c.lookDir();
    let best = null, bestT = maxDist;
    for (const m of this.list) {
      if (m.dead || m.hp <= 0) continue;
      if (filter && !filter(m)) continue;
      // 点到射线距离
      const ox = m.pos.x - c.pos.x;
      const oy = (m.pos.y + m.height * 0.5) - c.pos.y - 1.2;
      const oz = m.pos.z - c.pos.z;
      const t = ox * d.x + oy * d.y + oz * d.z;
      if (t < 0 || t > maxDist) continue;
      const cx = ox - d.x * t, cy = oy - d.y * t, cz = oz - d.z * t;
      const perp = Math.hypot(cx, cy, cz);
      if (perp < 0.85 && t < bestT) { bestT = t; best = m; }
    }
    return best;
  }

  /* P0：攻击专用精确命中（真实视点 + AABB + 方块遮挡）。
     pickNearest() 保留给村民/剪羊毛/喂食/狼/盾牌五个共用入口，不动它们。 */
  attackTarget(maxDist = MELEE_REACH, blockDist = Infinity) {
    const c = this.ctx.controller;
    return pickAttackTarget(this.list,
      { x: c.pos.x, y: c.eyeY, z: c.pos.z }, c.lookDir(), maxDist, blockDist);
  }

  /* 玩家近战：命中视线内、且没有被方块挡住的生物 */
  attackMelee(maxDist = MELEE_REACH, blockDist = Infinity, charge = 1) {
    const pick = this.attackTarget(maxDist, blockDist);
    if (!pick.mob) return null;
    const d = this.ctx.controller.lookDir();
    const held = this.ctx.inventory.held();
    // D1 修复：原来读的是 this.ctx.game.items[...]，而 Game 上根本没有 items 属性，
    // 于是「左键打到生物 + 手上拿着东西」必然抛 TypeError（表现为启动出错红框）。物品表要从 items.js 取。
    const it = held ? getItem(held.item) : null;
    const dmg = it && it.damage ? it.damage : 1;
    this.hitMob(pick.mob, Math.max(0.2, dmg * meleeDamageScale(charge)), { x: d.x, z: d.z });
    return pick.mob;
  }

  /* 手上的物品是否可作为某种动物的繁殖食物（供交互层判断，不必 import 生物表） */
  isAnimalFood(item) {
    if (!item) return false;
    for (const t of Object.keys(MOBS)) {
      const f = MOBS[t].food;
      if (f && f.indexOf(item) >= 0) return true;
    }
    return false;
  }

  /* 附近是否有可配的同类成年对象（另一只、非幼崽、不在冷却、距离够近） */
  findPartner(mate, other) {
    if (!other || other === mate || other.type !== mate.type) return null;
    if (!other.def.breedable || other.isBaby || other.breedCd > 0 || other.hp <= 0) return null;
    const d = Math.hypot(other.pos.x - mate.pos.x, other.pos.y - mate.pos.y, other.pos.z - mate.pos.z);
    return d <= BREED_PARTNER_RANGE ? other : null;
  }

  /**
   * 玩家手持食物右键喂食：需要「目标 + 附近同类成年配偶」才会生出幼崽（与原版需要两只一致）。
   * 只做判定与生成；是否消耗食物由调用方按 ok 决定。
   * @returns {{ok:boolean, reason?:string, baby?:object, parents?:object[]}}
   */
  feedNearby(maxDist = 3.6, target = null) {
    const held = this.ctx.inventory.held();
    const heldItem = held ? held.item : null;
    const t = target || this.pickNearest(maxDist, (m) => m.def.breedable && !m.isBaby && m.hp > 0);
    if (!t) return { ok: false, reason: "no_target" };
    const food = t.def.food || [];
    if (!heldItem || food.indexOf(heldItem) < 0) return { ok: false, reason: "no_target" };
    if (t.isBaby) return { ok: false, reason: "no_target" };
    if (t.breedCd > 0) return { ok: false, reason: "cooldown" };
    let partner = null;
    for (const other of this.list) {
      if (this.findPartner(t, other)) { partner = other; break; }
    }
    if (!partner) return { ok: false, reason: "no_partner" };
    const bx = (t.pos.x + partner.pos.x) / 2;
    const by = Math.min(t.pos.y, partner.pos.y);
    const bz = (t.pos.z + partner.pos.z) / 2;
    const baby = this.spawn(t.type, bx, by, bz, { baby: true });
    t.breedCd = BREED_COOLDOWN_SECONDS;
    partner.breedCd = BREED_COOLDOWN_SECONDS;
    if (this.ctx.sfx) this.ctx.sfx.play(t.def.sound || "pig", { volume: 0.55, rate: 1.25 });
    if (this.ctx.game && this.ctx.game.onMobBred) this.ctx.game.onMobBred(baby);
    return { ok: true, baby, parents: [t, partner] };
  }

  /* T6 狼：每根骨头推进 1 点驯服进度，3 根必定成功（本作确定性简化） */
  tameWolf(m) {
    if (!m || !m.def.tameable) return { ok: false, reason: 'not_wolf' };
    if (m.tamed) return { ok: true, tamed: true, progress: TAME_BONES };
    m.tameProgress = Math.min(TAME_BONES, (m.tameProgress || 0) + 1);
    if (m.tameProgress >= TAME_BONES) {
      m.setTamed(true);
      m.sitting = false;
      this.ctx.sfx.play('wolf', { volume: 0.6, rate: 1.0 });
      this.ctx.particles.spawn(m.pos.x, m.eyeY, m.pos.z, [0.95, 0.85, 0.4], 8, 0.4, 1.6);
      return { ok: true, tamed: true, progress: TAME_BONES };
    }
    this.ctx.sfx.play('wolf', { volume: 0.4, rate: 1.2 });
    this.ctx.particles.spawn(m.pos.x, m.eyeY, m.pos.z, [0.9, 0.9, 0.85], 4, 0.3, 1.2);
    return { ok: true, tamed: false, progress: m.tameProgress, need: TAME_BONES };
  }

  /** 右键已驯服狼：坐下/起身切换 */
  toggleWolfSit(m) {
    if (!m || !m.tamed) return null;
    m.sitting = !m.sitting;
    m.vel.x = m.vel.z = 0;
    this.ctx.sfx.play('wolf', { volume: 0.45, rate: m.sitting ? 0.9 : 1.1 });
    return m.sitting;
  }

  /**
   * 玩家用剪刀剪羊毛：只对「可剪、还有毛」的羊生效。
   * @returns {object|null} 被剪的那只羊；没有可剪目标时返回 null（由调用方决定扣不扣耐久）
   */
  shear(maxDist = 3.6) {
    const target = this.pickNearest(maxDist, m => m.def.shearable && !m.sheared && m.hp > 0);
    if (!target) return null;
    target.setSheared(true, this.scene);
    target.regenT = SHEEP_REGROW_SECONDS;
    const n = 1 + ((Math.random() * 3) | 0);            // 1~3 团羊毛（与原版一致）
    this.ctx.game.spawnDrop('wool', n, target.pos.x, target.pos.y + 0.3, target.pos.z);
    if (this.ctx.sfx) {
      this.ctx.sfx.play('craft', { volume: 0.3, rate: 1.7 });
      this.ctx.sfx.play('sheep', { volume: 0.6 });
    }
    return target;
  }

  /* 存档 */
  serialize() {
    /* 阶段 5：守卫不走普通生物存档，状态由 game.js 的 meta.guardian 按地点持久化。
       这样旧档格式一个字节都不变，也不会出现「生物表里的守卫 + 地点状态」两套互相矛盾。 */
    return this.list.filter(m => m.hp > 0 && !m.def.guardian).map(m => m.serialize());
  }

  applySaved(arr) {
    this.clear();
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (!MOBS[s.t]) continue;
      const opts = {};
      if (MOBS[s.t].slime) opts.slimeSize = s.sl;
      if (s.t === 'villager') opts.profession = normalizeVillagerProfession(s.pr);
      if (s.hx !== undefined && s.hz !== undefined) opts.home = { x: s.hx, y: s.hy, z: s.hz };
      const m = this.spawn(s.t, s.x, s.y, s.z, Object.keys(opts).length ? opts : undefined);
      if (m) {
        m.yaw = s.yaw || 0; m.hp = s.hp || m.maxHp;
        if (MOBS[s.t].tameable && s.tm) { m.setTamed(true); m.sitting = !!s.st; }
        if (s.bb) {
          const bb = Number(s.bb);
          m.setBaby(true, this.scene);
          m.growT = Number.isFinite(bb) && bb > 0 ? Math.min(bb, BABY_GROW_SECONDS) : BABY_GROW_SECONDS;
        }
        const bc = Number(s.bc);
        if (Number.isFinite(bc) && bc > 0) m.breedCd = Math.min(bc, BREED_COOLDOWN_SECONDS);
        if (s.sh) {
          m.setSheared(true, this.scene);
          const rt = Number(s.rt);
          m.regenT = Number.isFinite(rt) && rt > 0 ? Math.min(rt, SHEEP_REGROW_SECONDS) : SHEEP_REGROW_SECONDS;
        }
        /* 阶段 3a：读档要把鱼群站点键带回来，否则站点扫描认不出这群鱼、会在同一格里再刷一群。
           没有 sk 的鱼（这份代码之前写的旧档）交给 spawnFishSchools 的「按所在格判占用」兜底。 */
        if (typeof s.sk === 'string' && s.sk) {
          m.school = s.sk;
          const fx = Number(s.fx), fy = Number(s.fy), fz = Number(s.fz);
          if (Number.isFinite(fx)) m.homeX = fx;
          if (Number.isFinite(fy)) m.homeY = fy;
          if (Number.isFinite(fz)) m.homeZ = fz;
        }
        /* 阶段 3c：鸟的站点键与栖点。读档后一律从「停在那棵树上」开始，
           半空中的动画态（phase/flyT/flapPhase）刻意不入库，与 fuse、drawing 同一条规矩。 */
        if (typeof s.bk === 'string' && s.bk) {
          m.birdSite = s.bk;
          const px = Number(s.px), py = Number(s.py), pz = Number(s.pz);
          if (Number.isFinite(px) && Number.isFinite(py) && Number.isFinite(pz)) {
            m.perch = { x: px, y: py, z: pz };
            m.homeX = px; m.homeY = py; m.homeZ = pz;
            m.phase = 'perched';
            m.perchT = BIRD_PERCH_SECONDS[0] + Math.random() * (BIRD_PERCH_SECONDS[1] - BIRD_PERCH_SECONDS[0]);
            m.vel.x = 0; m.vel.y = 0; m.vel.z = 0;
          } else {
            m.phase = 'hover';                 // 旧档没带栖点：让它自己在林冠上方悬停找落点
          }
        }
      }
    }
  }
}
