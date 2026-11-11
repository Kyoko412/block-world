'use strict';
/*
 * 雷暴闪电的视觉层：一条程序化折线闪电 + 地面光球，持续约 0.22 秒。
 * 没有外部贴图/模型；坐标是世界坐标，由 Game.strikeLightningAt 驱动。
 */
import * as THREE from '../../vendor/three.module.js';
import { LIGHTNING_FLASH_SECONDS } from '../core/lightning.js';

export class LightningFX {
  constructor(scene) {
    this.scene = scene || null;
    this.group = new THREE.Group();
    this.group.visible = false;
    if (this.scene) this.scene.add(this.group);
    this.mesh = null;
    this.glow = null;
    this.ttl = 0;
    this.total = LIGHTNING_FLASH_SECONDS;
    this.strikes = 0;
  }

  /** 在方块顶面 (x,y,z) 生成一条从天而降的闪电；y 是地面顶层方块坐标 */
  strike(x, y, z) {
    this.clear();
    const H = 18;
    const pts = [];
    let px = 0, pz = 0;
    const segs = 8;
    for (let i = 0; i < segs; i++) {
      const nx = (Math.random() - 0.5) * 1.7;
      const nz = (Math.random() - 0.5) * 1.7;
      const y0 = H - (i / segs) * H;
      const y1 = H - ((i + 1) / segs) * H;
      pts.push(px, y0, pz, nx, y1, nz);
      px = nx; pz = nz;
    }
    /* 两条分叉，让轮廓不是一根直棍 */
    for (let b = 0; b < 2; b++) {
      const sy = H * (0.35 + 0.25 * b);
      const sx = (Math.random() - 0.5) * 1.2;
      const sz = (Math.random() - 0.5) * 1.2;
      pts.push(sx, sy, sz, sx + (Math.random() - 0.5) * 3.2, sy - 2.4, sz + (Math.random() - 0.5) * 3.2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.mat = new THREE.LineBasicMaterial({
      color: 0xe4f4ff, transparent: true, opacity: 0.95, depthWrite: false
    });
    this.mesh = new THREE.LineSegments(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.group.add(this.mesh);

    /* 1 像素的线在 1280 宽截图里太细，加一根发光的核心柱（折线仍然保留，负责轮廓） */
    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xeaf6ff, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.core = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.2, H, 6, 1, true), this.coreMat);
    this.core.position.y = H / 2;
    this.core.renderOrder = 8;
    this.group.add(this.core);

    this.glowMat = new THREE.MeshBasicMaterial({
      color: 0xcfe8ff, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false
    });
    this.glow = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), this.glowMat);
    this.glow.position.set(0, 0.55, 0);
    this.group.add(this.glow);

    this.group.position.set(x + 0.5, y, z + 0.5);
    this.group.visible = true;
    this.ttl = LIGHTNING_FLASH_SECONDS;
    this.total = LIGHTNING_FLASH_SECONDS;
    this.strikes++;
    return this;
  }

  update(dt) {
    if (this.ttl <= 0) return false;
    this.ttl = Math.max(0, this.ttl - dt);
    const k = this.total > 0 ? this.ttl / this.total : 0;
    if (this.mat) this.mat.opacity = 0.95 * k;
    if (this.coreMat) this.coreMat.opacity = 0.8 * k;
    if (this.glowMat) this.glowMat.opacity = 0.55 * k;
    if (this.ttl <= 0) this.group.visible = false;
    return true;
  }

  clear() {
    for (const child of this.group.children.slice()) {
      this.group.remove(child);
      if (child.geometry) child.geometry.dispose();
      if (child.material) child.material.dispose();
    }
    this.mesh = null; this.glow = null; this.core = null;
    this.group.visible = false;
    this.ttl = 0;
  }

  info() {
    return {
      visible: !!this.group.visible,
      ttl: +this.ttl.toFixed(3),
      strikes: this.strikes
    };
  }

  dispose() {
    this.clear();
    if (this.scene) this.scene.remove(this.group);
  }
}
