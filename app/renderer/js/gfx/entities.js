'use strict';
/*
 * 视觉辅助：挖掘粒子、手持物品模型、掉落物实体模型。
 * 全部使用程序化图集，无外部资源。
 */
import * as THREE from '../../vendor/three.module.js';
import { BLOCKS, B, tileForFace } from '../core/blocks.js';
import { getItem } from '../core/items.js';
import { tileUVCached, getBlockAverageColor, getItemIconTexture, getItemIconCanvas, getAtlasTexture } from './atlas.js';
import { mobMaterial, mobFaceMaterials } from './mobtex.js';

/* ================= 粒子 ================= */
export class Particles {
  constructor(scene, max = 900) {
    this.max = max;
    this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.size = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.geo = g;
    this.mat = new THREE.PointsMaterial({
      size: 0.09, vertexColors: true, sizeAttenuation: true,
      transparent: true, opacity: 0.95, depthWrite: true
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
    this.count = 0;
  }

  spawn(x, y, z, color, n = 8, spread = 0.5, up = 2.2) {
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      this.pos[i * 3] = x + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 1] = y + Math.random() * spread;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      this.vel[i * 3] = (Math.random() - 0.5) * 1.6;
      this.vel[i * 3 + 1] = Math.random() * up;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.6;
      const tint = 0.75 + Math.random() * 0.45;
      this.col[i * 3] = color[0] * tint;
      this.col[i * 3 + 1] = color[1] * tint;
      this.col[i * 3 + 2] = color[2] * tint;
      this.life[i] = 0.55 + Math.random() * 0.5;
    }
    this.count = Math.min(this.max, this.count + n);
  }

  spawnBlock(x, y, z, blockId, n = 12) {
    this.spawn(x, y, z, getBlockAverageColor(blockId), n);
  }

  update(dt, world) {
    const p = this.pos, v = this.vel, l = this.life;
    for (let i = 0; i < this.max; i++) {
      if (l[i] <= 0) continue;
      l[i] -= dt;
      if (l[i] <= 0) { p[i * 3 + 1] = -1000; continue; }
      v[i * 3 + 1] -= 14 * dt;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      // 简单地面阻挡
      if (world && world.isSolidAt(Math.floor(p[i * 3]), Math.floor(p[i * 3 + 1]), Math.floor(p[i * 3 + 2]))) {
        p[i * 3 + 1] = Math.floor(p[i * 3 + 1]) + 1.001;
        v[i * 3] *= 0.4; v[i * 3 + 1] = Math.abs(v[i * 3 + 1]) * 0.22; v[i * 3 + 2] *= 0.4;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }

  dispose(scene) { scene.remove(this.points); this.geo.dispose(); this.mat.dispose(); }
}

/* ================= 方块立方体（带正确分面 UV） ================= */
const FACE_ORDER = ['posx', 'negx', 'top', 'bottom', 'posz', 'negz'];

export function makeBlockCubeGeometry(blockId, meta = 0) {
  const g = new THREE.BoxGeometry(1, 1, 1);
  const uv = g.attributes.uv;
  for (let f = 0; f < 6; f++) {
    const rect = tileUVCached(tileForFace(blockId, meta, FACE_ORDER[f]));
    // 每个面 4 个顶点，顺序：左上、右上、左下、右下
    const base = f * 4;
    setUv(uv, base + 0, rect[0], rect[3]);
    setUv(uv, base + 1, rect[2], rect[3]);
    setUv(uv, base + 2, rect[0], rect[1]);
    setUv(uv, base + 3, rect[2], rect[1]);
  }
  uv.needsUpdate = true;
  return g;
}

function setUv(attr, i, u, v) { attr.setXY(i, u, v); }

export function makeBlockCubeMaterial(blockId) {
  const b = BLOCKS[blockId];
  const cutout = !!(b && !b.opaque);
  return new THREE.MeshBasicMaterial({
    map: getAtlasTexture(),
    alphaTest: cutout ? 0.35 : 0.5,
    transparent: false,
    side: THREE.FrontSide
  });
}

/* ================= 手持物品 ================= */
/* 第一人称持握：按类别给不同的落点/角度，而不是所有物品共用一套姿态 */
function holdPoseFor(itemId, it) {
  /* 位置以相机为原点（米）：FOV 70 时垂直半角 35°，y/z 超过 tan35°≈0.70 就掉出画面底部。
     工具/手都放在 y≈-0.34、z≈-0.62（约 29°），既在画面里又不会挡住准星。 */
  if (!it) return { pos: [0.33, -0.24, -0.52], rot: [-0.62, -0.26, 0.34] };   // 空手：小臂斜伸进画面右下
  if (it.shield) return { pos: [0.46, -0.40, -0.72], rot: [-0.12, 0.7, 0] };
  if (it.blockId !== undefined && it.blockId !== null) return { pos: [0.48, -0.40, -0.72], rot: [-0.12, 0.7, 0] };
  if (it.bow) return { pos: [0.33, -0.36, -0.60], rot: [0, 0.18, 0.05] };
  if (it.mapItem || it.compassItem) return { pos: [0.34, -0.30, -0.60], rot: [-0.45, 0.35, 0.12] };
  if (it.toolType || /^sword_/.test(itemId) || /_(pickaxe|axe|shovel|hoe)$/.test(itemId)) {
    return { pos: [0.32, -0.20, -0.62], rot: [-0.16, 0.50, -0.30] };
  }
  return { pos: [0.40, -0.34, -0.64], rot: [-0.28, 0.55, 0.06] };
}

/* ---------- 本轮 C：第一人称的「手」与「有厚度的工具」 ----------
 * 旧实现：空手直接不画；工具是一张 0.30×0.30 的平面贴图 —— 屏幕上看就是一张竖着的图标，
 * 没有厚度、没有握持、也看不出是拿在手里。
 * 现在：
 *   · 空手画一段小臂 + 手（player_arm 像素贴图，袖口/皮肤两段，指缝一条）；
 *   · 工具用几块小方盒拼出**有厚度**的形体：木柄 + 金属头（镐尖/斧刃/铲面/锄刃/剑身 + 护手），
 *     并按木材/石/铁/钻石换色，屏幕占比比原来那张平面图标更大、更靠下，像真的握在手里；
 *   · 剑单独走一条（薄剑身 + 护手 + 缠柄），不再和镐共用一个平面。
 * 全部是程序化几何 + 现有像素贴图，不引入外部模型资源。 */
const TOOL_MATERIAL_COLOR = {
  wood: { head: 0xb08a52, edge: 0xd0aa70, grip: 0x5a3d22 },
  stone: { head: 0x8b8f90, edge: 0xb3b8b9, grip: 0x6b4a2a },
  iron: { head: 0xaab6c2, edge: 0xd2dae2, grip: 0x6b4a2a },
  diamond: { head: 0x5fc4bc, edge: 0x9ff0e8, grip: 0x6b4a2a },
  gold: { head: 0xe8c85a, edge: 0xfff0a8, grip: 0x6b4a2a }
};

function toolTierOf(itemId, it) {
  const m = /^(pickaxe|axe|shovel|hoe|sword)_(wood|stone|iron|diamond|gold)$/.exec(itemId || '');
  if (m) return m[2];
  if (it && it.toolLevel !== undefined && it.toolLevel >= 3) return 'diamond';
  return 'wood';
}

function boxMesh(w, h, d, color) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
}

/* ---------- 第二轮 B2：按物品图标做「像素挤出」的工具 ----------
 * 复核 2-4：铁剑是一根浅色长条、工具是纯色小盒，和 16×16 图标不是同一套美术。
 * 现在直接从图标的像素本身生成几何：
 *   · 正/背面：图标同款贴图（透明像素不生成面），像素边缘保持硬；
 *   · 侧面：沿剪影边界逐个像素挤出一小段厚度，颜色取该像素自身颜色压暗一档；
 *   · 厚度 2/16 单位：近看有体积、远看仍是像素剪影，不会变成一根白条。
 * 于是「图标长什么样，手里就是什么样」——以后改图标，工具跟着变。
 */
const ICON_EXTRUDE = { size: 16, height: 0.34, thickness: 0.036 };

function makeIconExtrusion(itemId, opts = {}) {
  const size = ICON_EXTRUDE.size;
  const H = opts.height || ICON_EXTRUDE.height;
  const T = opts.thickness || ICON_EXTRUDE.thickness;
  const canvas = getItemIconCanvas(itemId);
  let data = null;
  try {
    const g = canvas.getContext('2d', { willReadFrequently: true });
    data = g.getImageData(0, 0, size, size).data;
  } catch (e) { data = null; }
  const group = new THREE.Group();
  const px2world = H / size;
  if (!data) {
    /* 没有画布（极端情况）时退回一张平面，别让手空着 */
    const m = new THREE.Mesh(new THREE.PlaneGeometry(H, H),
      new THREE.MeshBasicMaterial({ map: getItemIconTexture(itemId), transparent: true, alphaTest: 0.06, side: THREE.DoubleSide }));
    group.add(m);
    return group;
  }
  const at = (x, y) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return null;
    const o = (y * size + x) * 4;
    return { r: data[o], g: data[o + 1], b: data[o + 2], a: data[o + 3] };
  };
  const solid = (x, y) => { const p = at(x, y); return !!p && p.a > 96; };

  /* 正/背面：整张贴图的两张平面（alphaTest 把透明像素切掉） */
  const tex = getItemIconTexture(itemId);
  for (const z of [T / 2, -T / 2]) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(H, H), new THREE.MeshBasicMaterial({
      /* 颜色乘 0.92：图标本身是高对比像素图，直接贴到近景会刺眼（铁剑原来看起来像一根白条） */
      map: tex, color: 0xeaedf0, transparent: true, alphaTest: 0.06, side: THREE.FrontSide
    }));
    plane.position.z = z;
    if (z < 0) plane.rotation.y = Math.PI;
    group.add(plane);
  }
  /* 侧面：只给剪影边界上的像素挤出，避免 256 个像素全建盒子 */
  const pos = [];
  const col = [];
  const pushQuad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, c) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, cx, cy, cz, bx, by, bz, dx, dy, dz);
    for (let i = 0; i < 6; i++) col.push(c[0], c[1], c[2]);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!solid(x, y)) continue;
      const p = at(x, y);
      /* 顶行 y=0 在贴图上是「上」，世界坐标里 y 向上，所以世界 y 要翻过来 */
      const x0 = (x / size - 0.5) * H, x1 = ((x + 1) / size - 0.5) * H;
      const y1 = (0.5 - y / size) * H, y0 = (0.5 - (y + 1) / size) * H;
      const c = [Math.min(1, p.r / 255 * 0.78), Math.min(1, p.g / 255 * 0.78), Math.min(1, p.b / 255 * 0.78)];
      const zf = T / 2, zb = -T / 2;
      if (!solid(x, y - 1)) pushQuad(x0, y1, zf, x1, y1, zf, x0, y1, zb, x1, y1, zb, c);   // 上边
      if (!solid(x, y + 1)) pushQuad(x0, y0, zf, x1, y0, zf, x0, y0, zb, x1, y0, zb, c);   // 下边
      if (!solid(x - 1, y)) pushQuad(x0, y0, zf, x0, y1, zf, x0, y0, zb, x0, y1, zb, c);   // 左边
      if (!solid(x + 1, y)) pushQuad(x1, y0, zf, x1, y1, zf, x1, y0, zb, x1, y1, zb, c);   // 右边
    }
  }
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const side = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    group.add(side);
  }
  group._ownGeo = true;
  return group;
}

/* 镐/斧/铲/锄：木柄 + 头部。headKind 决定头部怎么拼 */
function makeToolMesh(itemId, it) {
  const g = new THREE.Group();
  const kind = (/^(pickaxe|axe|shovel|hoe|sword)_/.exec(itemId) || [])[1] || 'pickaxe';
  const tier = toolTierOf(itemId, it);
  const col = TOOL_MATERIAL_COLOR[tier] || TOOL_MATERIAL_COLOR.wood;
  /* 木柄：0.05 见方、0.60 长，略向前倾 */
  const handle = boxMesh(0.052, 0.60, 0.052, col.grip);
  handle.position.set(0, -0.14, 0);
  g.add(handle);
  const headY = 0.20;
  if (kind === 'pickaxe') {
    /* 镐：中段横梁 + 两端下弯的尖，正面看是「⌐¬」形而不是一根棍 */
    const bar = boxMesh(0.34, 0.075, 0.075, col.head);
    bar.position.set(0, headY, 0);
    g.add(bar);
    for (const s of [-1, 1]) {
      const tip = boxMesh(0.13, 0.07, 0.07, col.edge);
      tip.position.set(s * 0.20, headY - 0.055, 0);
      tip.rotation.z = s * 0.55;
      g.add(tip);
    }
    const collar = boxMesh(0.085, 0.09, 0.085, col.edge);
    collar.position.set(0, headY - 0.075, 0);
    g.add(collar);
  } else if (kind === 'axe') {
    const blade = boxMesh(0.20, 0.22, 0.05, col.head);
    blade.position.set(0.11, headY - 0.02, 0);
    g.add(blade);
    const edge = boxMesh(0.06, 0.20, 0.035, col.edge);
    edge.position.set(0.21, headY - 0.02, 0);
    g.add(edge);
  } else if (kind === 'shovel') {
    const blade = boxMesh(0.15, 0.19, 0.035, col.head);
    blade.position.set(0, headY + 0.06, 0);
    g.add(blade);
    const lip = boxMesh(0.16, 0.04, 0.045, col.edge);
    lip.position.set(0, headY + 0.155, 0);
    g.add(lip);
  } else if (kind === 'hoe') {
    const neck = boxMesh(0.05, 0.10, 0.05, col.head);
    neck.position.set(0.04, headY, 0);
    g.add(neck);
    const blade = boxMesh(0.18, 0.05, 0.06, col.edge);
    blade.position.set(0.14, headY + 0.05, 0);
    g.add(blade);
  } else {
    /* 剑：薄剑身 + 护手 + 缠柄（单独一条，不再是平面图标） */
    const blade = boxMesh(0.075, 0.52, 0.028, col.head);
    blade.position.set(0, 0.30, 0);
    g.add(blade);
    const tip = boxMesh(0.045, 0.10, 0.026, col.edge);
    tip.position.set(0, 0.58, 0);
    g.add(tip);
    const edge = boxMesh(0.02, 0.50, 0.032, col.edge);
    edge.position.set(-0.035, 0.30, 0);
    g.add(edge);
    const guard = boxMesh(0.20, 0.045, 0.05, col.edge);
    guard.position.set(0, 0.02, 0);
    g.add(guard);
    const grip = boxMesh(0.045, 0.16, 0.045, col.grip);
    grip.position.set(0, -0.08, 0);
    g.add(grip);
    const pommel = boxMesh(0.06, 0.05, 0.06, col.head);
    pommel.position.set(0, -0.17, 0);
    g.add(pommel);
  }
  g.scale.setScalar(0.70);
  g._ownGeo = true;
  return g;
}

/* 小臂 + 手：袖口一段、皮肤一段、拇指一格。空手时整条手臂可见，
   持工具时只露出手掌握住柄的位置。 */
function makeArmMesh(short) {
  const g = new THREE.Group();
  const mat = mobMaterial('player_arm');
  const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.115, short ? 0.16 : 0.30, 0.115), mat.clone());
  sleeve.position.set(0, short ? -0.15 : -0.22, 0);
  g.add(sleeve);
  const skin = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.12, 0.10), mat.clone());
  skin.position.set(0, short ? -0.03 : -0.03, 0);
  g.add(skin);
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.06, 0.04), mat.clone());
  thumb.position.set(-0.06, 0.0, 0.03);
  g.add(thumb);
  g._ownGeo = true;
  g.userData.isArm = true;
  return g;
}

export class HeldItemView {
  constructor(camera, scene) {
    this.group = new THREE.Group();
    this.group.renderOrder = 10;
    this.group.frustumCulled = false;
    this.pivot = new THREE.Group();
    this.pivot.add(this.group);
    camera.add(this.pivot);
    this.mesh = null;
    /* 本轮 C：初值必须是 undefined 而不是 null —— setItem() 开头有「同名就早退」，
       而主循环每帧都会用 inventory.heldItem() 调一次；初值是 null 时，
       「空手」这一路永远被早退挡住，手臂一次都建不出来（实测空手画面右下是空的）。 */
    this.itemId = undefined;
    this.swing = 0;
    this.equip = 0;
    this.walkPhase = 0;
    this.walkWeight = 0;
    this.basePos = new THREE.Vector3(0.48, -0.40, -0.72);
    this.baseRot = new THREE.Euler(-0.12, 0.7, 0);
    this.camera = camera;
    this.blockWeight = 0;          // T2 举盾姿态插值（0=收起，1=举在身前）
    this.bowDraw = 0;              // V5 拉弓进度（0~1），驱动弓弦/搭箭
    this.bowNocked = false;
    this.shieldKick = 0;           // V5 成功格挡的短后坐
  }

  setItem(itemId) {
    /* 用 `===` 比原始值；this.itemId 初值是 undefined，所以第一次 setItem(null)
       也会走完整建模型（空手的手臂）。之后同名才早退。 */
    if ((itemId || null) === this.itemId) return;
    this.itemId = itemId || null;
    this.equip = 1;
    this.swing = 0;                 // 切换时清掉旧动作，避免新物品继承上一件的挥动
    this.blockWeight = 0;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this._disposeMesh(this.mesh);
      this.mesh = null;
    }
    const it = itemId ? getItem(itemId) : null;
    const pose = itemId ? holdPoseFor(itemId, it) : holdPoseFor(null, null);
    this.basePos.set(pose.pos[0], pose.pos[1], pose.pos[2]);
    this.baseRot.set(pose.rot[0], pose.rot[1], pose.rot[2]);
    /* 本轮 C：空手也要有一条手臂（旧实现这里直接 return，屏幕右下角什么都没有） */
    if (!itemId) {
      const arm = makeArmMesh(false);
      arm.scale.setScalar(1.15);
      arm.rotation.set(-0.30, -0.10, 0.18);
      arm.position.set(0, 0, 0);
      this.group.add(arm);
      this.mesh = arm;
      this.group.position.copy(this.basePos);
      this.group.rotation.copy(this.baseRot);
      this.bowDraw = 0; this.bowNocked = false; this.shieldKick = 0;
      return;
    }
    let mesh;
    if (it && it.shield) {
      mesh = this._makeShieldMesh();
    } else if (it && it.bow) {
      mesh = this._makeBowMesh();
    } else if (it && it.blockId !== undefined && it.blockId !== null && BLOCKS[it.blockId]) {
      const mesh2 = new THREE.Mesh(makeBlockCubeGeometry(it.blockId), makeBlockCubeMaterial(it.blockId));
      mesh = mesh2;
      mesh._ownGeo = true;
      mesh.scale.setScalar(0.24);
      mesh.rotation.copy(new THREE.Euler(-0.15, 0.6, 0.1));
    } else if (it && (it.toolType || /^sword_/.test(itemId) || /_(pickaxe|axe|shovel|hoe)$/.test(itemId))) {
      /* 第二轮 B2：工具 = 图标像素挤出（厚度 0.055、高 0.42）+ 一段握持的手。
         剑的剪影、护手、柄头全部来自图标本身，不再是用方块拼出来的白条。 */
      const holder = new THREE.Group();
      const tool = makeIconExtrusion(itemId, { height: /^sword_/.test(itemId) ? 0.26 : 0.24 });
      tool.position.set(-0.03, 0.02, 0);
      tool.rotation.set(0.06, -0.20, 0.62);
      holder.add(tool);
      const hand = makeArmMesh(true);
      hand.position.set(0.02, -0.24, 0.04);
      hand.scale.setScalar(0.82);
      hand.rotation.set(-0.25, 0, 0.10);
      holder.add(hand);
      mesh = holder;
      mesh._ownGeo = true;
    } else {
      const geo = new THREE.PlaneGeometry(0.26, 0.26);
      const mat = new THREE.MeshBasicMaterial({ map: getItemIconTexture(itemId), transparent: true, alphaTest: 0.06, side: THREE.DoubleSide });
      mesh = new THREE.Mesh(geo, mat);
      mesh._ownGeo = true;
      mesh.rotation.set(0, 0, -0.12);
    }
    this.group.add(mesh);
    this.mesh = mesh;
    this.bowDraw = 0; this.bowNocked = false; this.shieldKick = 0;
    if (mesh.userData && mesh.userData.isBow) this._setBowDraw(0);
    this.group.position.copy(this.basePos);
    this.group.rotation.copy(this.baseRot);
  }

  /* V5：独立弓模型（上下弓臂 + 弓弦 + 搭箭），弓弦随真实蓄力后拉 */
  _makeBowMesh() {
    const g = new THREE.Group();
    g.userData.isBow = true;
    const wood = new THREE.MeshBasicMaterial({ color: 0x8a6038 });
    const woodD = new THREE.MeshBasicMaterial({ color: 0x5f4227 });
    const stringMat = new THREE.LineBasicMaterial({ color: 0xe8edf1, transparent: true, opacity: 0.95 });
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.06), woodD);
    g.add(grip);
    for (const s of [-1, 1]) {
      const seg1 = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.30, 0.055), wood);
      seg1.position.set(0.015 * s, s * 0.24, 0);
      seg1.rotation.z = -s * 0.22;
      g.add(seg1);
      const seg2 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.05), wood);
      seg2.position.set(0.06 * s, s * 0.49, 0);
      seg2.rotation.z = -s * 0.42;
      g.add(seg2);
    }
    this.bowTips = [[0.13, 0.60, 0], [0.13, -0.60, 0]];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([
      this.bowTips[0][0], this.bowTips[0][1], 0,
      -0.08, 0, 0,
      this.bowTips[1][0], this.bowTips[1][1], 0
    ], 3));
    this.bowString = new THREE.Line(geo, stringMat);
    g.add(this.bowString);
    this.bowArrow = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.018, 0.018), new THREE.MeshBasicMaterial({ color: 0xd9c08a }));
    this.bowArrow.position.set(-0.24, 0, 0.02);
    this.bowArrow.visible = false;
    g.add(this.bowArrow);
    g.scale.setScalar(0.52);
    g._ownGeo = true;
    return g;
  }

  _setBowDraw(charge) {
    if (!this.mesh || !this.mesh.userData || !this.mesh.userData.isBow || !this.bowString) return;
    const q = Math.max(0, Math.min(1, Number(charge) || 0));
    this.bowDraw = q;
    const nocked = q > 0.001;
    this.bowNocked = nocked;
    const pull = 0.02 + q * 0.16;
    const p = this.bowString.geometry.attributes.position;
    p.setXYZ(0, this.bowTips[0][0], this.bowTips[0][1], 0);
    p.setXYZ(1, -0.08 - pull, 0, 0);
    p.setXYZ(2, this.bowTips[1][0], this.bowTips[1][1], 0);
    p.needsUpdate = true;
    this.bowArrow.visible = nocked;
    this.bowArrow.position.x = -0.08 - pull + 0.18;
    this.bowArrow.rotation.z = q * 0.08;
  }

  /* 程序的盾牌模型：木板面 + 三道竖纹 + 铁边 + 中心铁扣。
     Group 上的 userData.isShield 供验收确认「真的是独立模型」，不是把图标贴上去。 */
  _makeShieldMesh() {
    const g = new THREE.Group();
    g.userData.isShield = true;
    const wood = new THREE.MeshBasicMaterial({ color: 0x8a6a3f });
    const woodD = new THREE.MeshBasicMaterial({ color: 0x5d4529 });
    const iron = new THREE.MeshBasicMaterial({ color: 0xcfd3d8 });
    const ironD = new THREE.MeshBasicMaterial({ color: 0x8b929a });
    const face = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.05), wood);
    g.add(face);
    for (const dx of [-0.1, 0.1]) {
      const seam = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.42, 0.012), woodD);
      seam.position.set(dx, 0, 0.031);
      g.add(seam);
    }
    for (const dy of [-0.2, 0.2]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.035, 0.06), iron);
      band.position.set(0, dy, 0);
      g.add(band);
    }
    for (const dx of [-0.17, 0.17]) {
      const rim = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.40, 0.06), ironD);
      rim.position.set(dx, 0, 0);
      g.add(rim);
    }
    const boss = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.03), iron);
    boss.position.set(0, 0, 0.045);
    g.add(boss);
    // 0.62 与方块手持物的观感同量级；满尺寸会挡住血条/饥饿条
    g.scale.setScalar(0.70);
    g._ownGeo = true;
    return g;
  }

  _disposeMesh(mesh) {
    mesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  trigger(kind = 'attack') { this.swingKind = kind; }

  update(dt, moving, light = 1, blocking = false, charge = 0) {
    const kind = this.swingKind || 'attack';
    if (this.swing > 0) this.swing = Math.max(0, this.swing - dt * (kind === 'mine' ? 5.0 : (kind === 'use' ? 5.4 : 3.4)));
    if (this.equip > 0) this.equip = Math.max(0, this.equip - dt * 4.5);
    if (this.shieldKick > 0) this.shieldKick = Math.max(0, this.shieldKick - dt * 6.0);
    if (this.mesh && this.mesh.userData && this.mesh.userData.isBow) this._setBowDraw(charge);
    this.walkWeight += ((moving ? 1 : 0) - this.walkWeight) * Math.min(1, dt * 10);
    if (moving) this.walkPhase += dt * 9.2;
    this.blockWeight += ((blocking ? 1 : 0) - this.blockWeight) * Math.min(1, dt * 12);
    const s = Math.sin((1 - this.swing) * Math.PI);
    const equipDrop = this.equip * this.equip;
    const bobX = Math.cos(this.walkPhase * 0.5) * 0.014 * this.walkWeight;
    const bobY = Math.abs(Math.sin(this.walkPhase)) * 0.018 * this.walkWeight;
    const bw = this.blockWeight;
    const kick = this.shieldKick * this.shieldKick;
    /* 三类动作幅度不同：攻击大、挖掘中、使用小；盾牌格挡/成功格挡后坐单独叠加 */
    let ax = -0.055, ay = -0.15, az = 0.10, rx = -1.05, rz = -0.38, ry = 0.12;
    if (kind === 'mine') { ax = -0.035; ay = -0.10; az = 0.07; rx = -0.80; rz = -0.24; ry = 0.06; }
    else if (kind === 'use') { ax = -0.020; ay = -0.05; az = -0.045; rx = -0.38; rz = 0.12; ry = -0.05; }
    this.group.position.set(
      this.basePos.x + bobX + s * ax - bw * 0.10,
      this.basePos.y + bobY + s * ay - equipDrop * 0.22 + bw * 0.33 - kick * 0.02,
      this.basePos.z + s * az - bw * 0.06 + kick * 0.06
    );
    this.group.rotation.set(
      this.baseRot.x + s * rx + equipDrop * 0.42 + bw * 0.10 - kick * 0.08,
      this.baseRot.y + s * ry - bw * 0.58,
      this.baseRot.z + s * rz + bobX * 1.8 + bw * 0.10
    );
    if (this.mesh) {
      const v = Math.max(0.34, Math.min(1, 0.34 + 0.76 * light));
      // 方块/平面只有一个材质；盾牌是 Group（木面+铁边），要逐个子网格着色
      this.mesh.traverse(o => {
        if (!o.isMesh || !o.material || !o.material.color) return;
        if (o.material.userData.baseColor === undefined) o.material.userData.baseColor = o.material.color.getHex();
        o.material.color.setHex(o.material.userData.baseColor).multiplyScalar(v);
      });
    }
  }

  dispose(camera) { camera.remove(this.pivot); }
}

/* ================= 掉落物 ================= */
export class DropMeshFactory {
  constructor(scene) {
    this.scene = scene;
    this.cache = Object.create(null);
  }

  create(itemId) {
    const it = getItem(itemId);
    let mesh;
    if (it && it.blockId !== undefined && it.blockId !== null && BLOCKS[it.blockId]) {
      const geo = makeBlockCubeGeometry(it.blockId);
      const mat = makeBlockCubeMaterial(it.blockId);
      mesh = new THREE.Mesh(geo, mat);
      mesh.scale.setScalar(0.26);
    } else {
      const geo = new THREE.PlaneGeometry(0.3, 0.3);
      const mat = new THREE.MeshBasicMaterial({ map: getItemIconTexture(itemId), transparent: true, alphaTest: 0.06, side: THREE.DoubleSide });
      mesh = new THREE.Mesh(geo, mat);
    }
    this.scene.add(mesh);
    return mesh;
  }

  destroy(mesh) {
    this.scene.remove(mesh);
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) mesh.material.dispose();
  }
}
