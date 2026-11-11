'use strict';
/*
 * 天气视觉层：跟着相机的一段「降水盒子」，雨用线段（有拖曳感），雪用点（飘）。
 * 完全程序化，不依赖任何外部贴图；纯逻辑状态在 core/weather.js，这里只负责画面。
 *
 * 约定：
 *  - 粒子坐标存世界坐标，围绕相机维护一个盒子；落到盒子底或飘出水平范围就 recycled 到顶部。
 *  - `activeRain / activeSnow` 随强度线性增减（渐入渐出靠它，不是靠透明度突变）。
 *  - 遮雨处（头顶有方块）由上层传入 `shelter`，用来把强度压到很低：洞穴里不该看到雨。
 */
import * as THREE from '../../vendor/three.module.js';

const BOX_R = 17;          // 水平半径（格）
const BOX_UP = 13;         // 盒子在相机上方多高开始生成
const BOX_DOWN = 7;        // 相机下方多深就回收
const RAIN_SPEED = 22;     // 雨滴下落速度（格/秒）
const RAIN_LEN = 0.62;     // 雨线长度
const SNOW_SPEED = 1.7;    // 雪飘落速度
const SLANT = 0.22;        // 雨的水平拖曳

export class WeatherFX {
  constructor(scene, rainMax = 1500, snowMax = 900) {
    this.rainMax = rainMax;
    this.snowMax = snowMax;

    // ---- 雨：每滴两个顶点 ----
    this.rainPos = new Float32Array(rainMax * 6);
    this.rx = new Float32Array(rainMax);
    this.ry = new Float32Array(rainMax);
    this.rz = new Float32Array(rainMax);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rainMat = new THREE.LineBasicMaterial({
      color: 0xa8c4dd, transparent: true, opacity: 0.55, depthWrite: false
    });
    this.rainMesh = new THREE.LineSegments(rg, this.rainMat);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 6;
    this.rainMesh.visible = false;
    scene.add(this.rainMesh);

    // ---- 雪：点粒子 ----
    this.snowPos = new Float32Array(snowMax * 3);
    this.sx = new Float32Array(snowMax);
    this.sy = new Float32Array(snowMax);
    this.sz = new Float32Array(snowMax);
    this.sPhase = new Float32Array(snowMax);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3));
    this.snowMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 0.16, sizeAttenuation: true,
      transparent: true, opacity: 0.92, depthWrite: false
    });
    this.snowMesh = new THREE.Points(sg, this.snowMat);
    this.snowMesh.frustumCulled = false;
    this.snowMesh.renderOrder = 6;
    this.snowMesh.visible = false;
    scene.add(this.snowMesh);

    this.activeRain = 0;
    this.activeSnow = 0;
    this.time = 0;
    this.seeded = false;
  }

  /* 把第 i 滴雨/雪放到相机盒子里的随机位置（yTop 以下、盒子顶以上） */
  resetRain(i, cam, yTop) {
    this.rx[i] = cam.x + (Math.random() - 0.5) * 2 * BOX_R;
    this.rz[i] = cam.z + (Math.random() - 0.5) * 2 * BOX_R;
    this.ry[i] = yTop - Math.random() * (BOX_UP + BOX_DOWN);
  }

  resetSnow(i, cam, yTop) {
    this.sx[i] = cam.x + (Math.random() - 0.5) * 2 * BOX_R;
    this.sz[i] = cam.z + (Math.random() - 0.5) * 2 * BOX_R;
    this.sy[i] = yTop - Math.random() * (BOX_UP + BOX_DOWN);
    this.sPhase[i] = Math.random() * Math.PI * 2;
  }

  /**
   * @param {number} dt 秒
   * @param {{x,y,z}} cam 相机世界坐标
   * @param {'clear'|'rain'|'snow'} type
   * @param {number} intensity 0~1
   * @param {boolean} [shelter] 头顶有遮挡（洞穴/屋里）时把强度压到几乎不可见
   */
  update(dt, cam, type, intensity, shelter) {
    this.time += dt;
    const want = type === 'clear' ? 0 : Math.max(0, Math.min(1, intensity)) * (shelter ? 0.06 : 1);
    const targetRain = type === 'rain' ? Math.round(this.rainMax * want) : 0;
    const targetSnow = type === 'snow' ? Math.round(this.snowMax * want) : 0;
    const yTop = cam.y + BOX_UP, yBottom = cam.y - BOX_DOWN;

    if (!this.seeded) {
      for (let i = 0; i < this.rainMax; i++) this.resetRain(i, cam, yTop);
      for (let i = 0; i < this.snowMax; i++) this.resetSnow(i, cam, yTop);
      this.seeded = true;
    }

    // 雨
    this.activeRain = targetRain;
    this.rainMesh.visible = targetRain > 0;
    if (targetRain > 0) {
      const fall = RAIN_SPEED * dt;
      for (let i = 0; i < this.rainMax; i++) {
        if (i >= targetRain) {           // 没用上的滴藏到原点之外，避免半屏乱线
          const b = i * 6;
          this.rainPos[b] = this.rainPos[b + 3] = 0;
          this.rainPos[b + 1] = this.rainPos[b + 4] = -1e5;
          this.rainPos[b + 2] = this.rainPos[b + 5] = 0;
          continue;
        }
        this.ry[i] -= fall;
        this.rx[i] += SLANT * fall * 0.35;
        this.rz[i] += SLANT * fall * 0.2;
        if (this.ry[i] < yBottom || Math.abs(this.rx[i] - cam.x) > BOX_R || Math.abs(this.rz[i] - cam.z) > BOX_R) {
          this.resetRain(i, cam, yTop);
        }
        const b = i * 6;
        this.rainPos[b] = this.rx[i];
        this.rainPos[b + 1] = this.ry[i];
        this.rainPos[b + 2] = this.rz[i];
        this.rainPos[b + 3] = this.rx[i] - SLANT * RAIN_LEN;
        this.rainPos[b + 4] = this.ry[i] + RAIN_LEN;
        this.rainPos[b + 5] = this.rz[i] - SLANT * RAIN_LEN * 0.6;
      }
      this.rainMesh.geometry.attributes.position.needsUpdate = true;
    }

    // 雪
    this.activeSnow = targetSnow;
    this.snowMesh.visible = targetSnow > 0;
    if (targetSnow > 0) {
      const fall = SNOW_SPEED * dt;
      for (let i = 0; i < this.snowMax; i++) {
        if (i >= targetSnow) {
          const b = i * 3;
          this.snowPos[b] = 0; this.snowPos[b + 1] = -1e5; this.snowPos[b + 2] = 0;
          continue;
        }
        this.sy[i] -= fall;
        this.sx[i] += Math.sin(this.time * 0.8 + this.sPhase[i]) * dt * 1.1;
        this.sz[i] += Math.cos(this.time * 0.6 + this.sPhase[i] * 1.7) * dt * 0.9;
        if (this.sy[i] < yBottom || Math.abs(this.sx[i] - cam.x) > BOX_R || Math.abs(this.sz[i] - cam.z) > BOX_R) {
          this.resetSnow(i, cam, yTop);
        }
        const b = i * 3;
        this.snowPos[b] = this.sx[i];
        this.snowPos[b + 1] = this.sy[i];
        this.snowPos[b + 2] = this.sz[i];
      }
      this.snowMesh.geometry.attributes.position.needsUpdate = true;
    }
    return { activeRain: this.activeRain, activeSnow: this.activeSnow };
  }

  /** 切天气时清一次可见性，避免雨停了还挂着线 */
  hide() {
    this.rainMesh.visible = false;
    this.snowMesh.visible = false;
    this.activeRain = 0;
    this.activeSnow = 0;
  }

  info() {
    return {
      activeRain: this.activeRain, activeSnow: this.activeSnow,
      rainVisible: !!this.rainMesh.visible, snowVisible: !!this.snowMesh.visible
    };
  }

  dispose(scene) {
    scene.remove(this.rainMesh);
    scene.remove(this.snowMesh);
    this.rainMesh.geometry.dispose();
    this.rainMat.dispose();
    this.snowMesh.geometry.dispose();
    this.snowMat.dispose();
  }
}
