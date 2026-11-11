'use strict';
/*
 * 玩家控制器：AABB 逐轴碰撞、重力、跳跃/冲刺/潜行、创造飞行、游泳、掉落伤害。
 * 坐标系：pos 为脚底中心（方块边对齐 0.5），eye 在 pos.y + 1.62。
 */
import { B, BLOCKS, isSolid, hurtsOnTouch, blockBoxes } from '../core/blocks.js';
import { getItem } from '../core/items.js';
import { ARMOR_DAMAGE_TYPES, applyArmorReduction } from '../core/armor.js';
import { inShieldArc, shieldCanBlock } from '../core/shield.js';
import { WORLD_H } from '../world/chunk.js';

export const PHYS = {
  gravity: 28,
  jumpSpeed: 8.4,
  terminal: 60,
  walkSpeed: 4.317,
  sprintSpeed: 5.612,
  sneakSpeed: 1.3,
  flySpeed: 10.5,
  flySprintSpeed: 21,
  swimSpeed: 2.2,
  airControl: 0.35,
  groundFriction: 0.72,
  width: 0.6,
  height: 1.8,
  eye: 1.62,
  sneakEye: 1.5,
  reach: 5.0,
  reachCreative: 6.0
};

export const STEP_HEIGHT = 1.05;   // T4 自动上台阶允许抬升的最大高度（格）
export const SHIELD_MOVE_MULT = 0.45;   // T2 举盾时的地面移动倍率
export const PUSH_UP_LIMIT = 8;      // T3 被埋时向上顶出的最大格数（一棵树最高 6 格，留 2 格余量）
export const PUSH_SIDE_LIMIT = 3;    // T3 向上走不通时，水平方向最多挪几格

/* 纯函数：给定脚底高度 y，返回「站上来的那一格顶面」；抬升超过 max 就不算台阶 */
export function stepTargetY(y, max = STEP_HEIGHT) {
  const EPS = 1e-4;
  const base = Math.floor(y + EPS) + 1;
  if (base <= y) return null;
  return (base - y) <= max ? base : null;
}

export class PlayerController {
  constructor(world, opts = {}) {
    this.world = world;
    this.pos = { x: 0.5, y: 40, z: 0.5 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0;          // 绕 Y（弧度），0 朝 -Z
    this.pitch = 0;        // 绕 X
    this.onGround = false;
    this.inWater = false;
    this.eyeInWater = false;
    this.flying = false;
    this.sprinting = false;
    this.sneaking = false;
    this.creative = false;
    this.health = 20;
    this.maxHealth = 20;
    this.hunger = 20;
    this.maxHunger = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.regenT = 0;
    this.starveT = 0;
    this.poisonT = 0;
    this.fallStart = null;
    this.walkDist = 0;
    this.bob = 0;
    this.stepTimer = 0.35;
    this.audioAirTime = 0;
    this.audioSteppingUp = false;
    this.dims = { w: PHYS.width, h: PHYS.height };
    this.listeners = {};
    this.gravityScale = 1;
    this.invulnerable = 0;
    this.air = 10;            // 水下呼吸气泡（0~10）
    this._suffocateT = 0;
    /* T1 护甲挂钩：由 Game 注入 { points():number, onHit():string[] }。
       不在这里 import Inventory —— 控制器只负责「这次伤害该扣多少」，耐久由背包扣。
       没有挂钩（旧测试/无装备）时等价于无甲。 */
    this.armor = null;
    this.lastHurt = null;     // 最近一次伤害的明细（供 HUD/测试读数）
    /* T2 盾牌：blocking 由 Interaction 每帧根据「手持盾牌 + 右键 + 没有对准可交互对象」维护。
       不入存档；切物品/开界面/死亡时由 Game 明确清零，不能永久减速。 */
    this.blocking = false;
    this.onShieldBlock = null;   // Game 注入：扣盾牌耐久、播格挡音、粒子与轻反馈
    this.lastBlock = null;
  }

  on(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); }
  /* 第三个参数是「这次事件的明细」（受伤时是 {type, absorbed, armorPoints…}）。
     旧的 emit 只转发两个参数，明细会在传递路上丢掉 —— 受伤原因/护甲吸收就全没了。 */
  emit(evt, a, b, c) { const l = this.listeners[evt]; if (l) for (const f of l) f(a, b, c); }

  get eyeY() { return this.pos.y + (this.sneaking ? PHYS.sneakEye : PHYS.eye); }

  resetMovementAudio() {
    this.stepTimer = 0.35;
    this.audioAirTime = 0;
    this.audioSteppingUp = false;
  }

  setPositions(x, y, z) { this.pos.x = x; this.pos.y = y; this.pos.z = z; this.vel.x = this.vel.y = this.vel.z = 0; this.onGround = false; this.fallStart = null; this.resetMovementAudio(); this.emit('teleport'); }

  /* 把玩家放到地表之上 */
  spawnAt(x, y, z) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.onGround = false;
    // 若出生点卡进方块，向上顶出
    let guard = 0;
    while (this.intersectsSolid(this.pos.x, this.pos.y, this.pos.z) && guard++ < WORLD_H) this.pos.y += 1;
    this.fallStart = null;
    this.resetMovementAudio();
    this.emit('teleport');
  }

  /* T3：玩家 AABB 覆盖到的区块是否都已经真正生成。
     `VoxelWorld.getBlock` 对未生成的区块会用地形高度做**近似**（地下直接当石头），
     那种「近似实心」不能当成把人埋住了 —— 不然走到流式边界会被顶到一层隐形地面上。 */
  chunksAroundReady() {
    if (!this.world || typeof this.world.getChunkAt !== 'function') return true;
    const hw = this.dims.w / 2;
    const xs = [Math.floor(this.pos.x - hw + 1e-4), Math.floor(this.pos.x + hw - 1e-4)];
    const zs = [Math.floor(this.pos.z - hw + 1e-4), Math.floor(this.pos.z + hw - 1e-4)];
    for (const x of xs) for (const z of zs) {
      if (!this.world.getChunkAt(x, z, true)) return false;
    }
    return true;
  }

  /* T3：身体与实心方块重叠时（新区块在脚下生成完、树长在玩家站的那一格）把人推到最近的合法位置。
     与 spawnAt 的顶出同一套思路，但更保守：
       ① 只在覆盖到的区块都真的生成之后才动手（见 chunksAroundReady）；
       ② 向上最多 PUSH_UP_LIMIT 格；不行就回退，再向四个水平方向各试 1~PUSH_SIDE_LIMIT 格；
       ③ 都失败就原地不动返回 null，下一帧再审 —— 不许把人顶出世界，也不许每帧抖一次。
     成功时发 `teleport` 事件：这是「刻意的位移」，D2 位置监视器靠它做豁免，否则会记成可疑瞬移。 */
  pushOutOfSolid() {
    if (!this.intersectsSolid(this.pos.x, this.pos.y, this.pos.z)) return null;
    if (!this.chunksAroundReady()) return null;
    const x0 = this.pos.x, y0 = this.pos.y, z0 = this.pos.z;

    // ① 向上：步长 1 格，最小且有界
    let guard = 0;
    while (this.intersectsSolid(this.pos.x, this.pos.y, this.pos.z) && guard++ < PUSH_UP_LIMIT) this.pos.y += 1;
    if (this.pos.y <= WORLD_H && !this.intersectsSolid(this.pos.x, this.pos.y, this.pos.z)) {
      const mv = { dx: 0, dy: +(this.pos.y - y0).toFixed(3), dz: 0, dir: 'up' };
      this.vel.y = 0; this.onGround = false; this.fallStart = null;
      this.resetMovementAudio();
      this.emit('teleport');
      return mv;
    }
    this.pos.y = y0;

    // ② 水平：四向各试 1~3 格（树冠、贴着墙的埋法用得上）
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let step = 1; step <= PUSH_SIDE_LIMIT; step++) {
        this.pos.x = x0 + sx * step; this.pos.z = z0 + sz * step;
        if (!this.intersectsSolid(this.pos.x, this.pos.y, this.pos.z)) {
          const mv = { dx: +(this.pos.x - x0).toFixed(3), dy: 0, dz: +(this.pos.z - z0).toFixed(3), dir: 'side' };
          this.vel.x = 0; this.vel.z = 0; this.onGround = false; this.fallStart = null;
          this.resetMovementAudio();
          this.emit('teleport');
          return mv;
        }
      }
      this.pos.x = x0; this.pos.z = z0;
    }

    // ③ 无路可走：完全回退，等下一帧（区块可能刚补上真方块）
    this.pos.x = x0; this.pos.y = y0; this.pos.z = z0;
    return null;
  }

  /* 第二轮 C1：碰撞从「整格实心」升级为「格内碰撞盒」。
     半砖/楼梯这类 shape 方块只在自己占的体积里挡人（整块方块仍然是一个满盒，
     所以既有行为逐位不变）。玩家 AABB 与每个盒做重叠判定。 */
  intersectsSolid(x, y, z) {
    const hw = this.dims.w / 2;
    const EPS = 1e-4;
    const x0 = Math.floor(x - hw + EPS), x1 = Math.floor(x + hw - EPS);
    const y0 = Math.floor(y + EPS), y1 = Math.floor(y + this.dims.h - EPS);
    const z0 = Math.floor(z - hw + EPS), z1 = Math.floor(z + hw - EPS);
    const px0 = x - hw, px1 = x + hw, py0 = y, py1 = y + this.dims.h, pz0 = z - hw, pz1 = z + hw;
    for (let yy = y0; yy <= y1; yy++) {
      for (let zz = z0; zz <= z1; zz++) {
        for (let xx = x0; xx <= x1; xx++) {
          const id = this.world.getBlock(xx, yy, zz);
          if (!isSolid(id)) continue;
          const boxes = blockBoxes(id, this.world.getMeta ? this.world.getMeta(xx, yy, zz) : 0);
          if (boxes.length === 1 && boxes[0][1] === 0 && boxes[0][4] === 1) return true;   // 整块：快路径
          for (const b of boxes) {
            if (px1 > xx + b[0] + EPS && px0 < xx + b[3] - EPS &&
                py1 > yy + b[1] + EPS && py0 < yy + b[4] - EPS &&
                pz1 > zz + b[2] + EPS && pz0 < zz + b[5] - EPS) return true;
          }
        }
      }
    }
    return false;
  }

  /* 某个坐标附近是否有「非整块」方块参与碰撞（决定 moveAxis 用整数贴合还是二分贴合） */
  shapedNear(x, y, z) {
    const hw = this.dims.w / 2, EPS = 1e-4;
    const x0 = Math.floor(x - hw + EPS), x1 = Math.floor(x + hw - EPS);
    const y0 = Math.floor(y + EPS), y1 = Math.floor(y + this.dims.h - EPS);
    const z0 = Math.floor(z - hw + EPS), z1 = Math.floor(z + hw - EPS);
    for (let yy = y0; yy <= y1; yy++) for (let zz = z0; zz <= z1; zz++) for (let xx = x0; xx <= x1; xx++) {
      const id = this.world.getBlock(xx, yy, zz);
      const b = id ? blockBoxes(id, this.world.getMeta ? this.world.getMeta(xx, yy, zz) : 0) : null;
      if (b && !(b.length === 1 && b[0][1] === 0 && b[0][4] === 1)) return true;
    }
    return false;
  }

  blockAtFeet() {
    return this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.08), Math.floor(this.pos.z));
  }

  touchesWater() {
    return this.blockAtFeet() === B.WATER ||
      this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z)) === B.WATER;
  }

  supportBlockId() {
    const hw = this.dims.w / 2;
    const x0 = this.pos.x - hw, x1 = this.pos.x + hw;
    const z0 = this.pos.z - hw, z1 = this.pos.z + hw;
    let material = B.AIR, largestContact = 0;
    for (let y = Math.floor(this.pos.y - 0.1); y <= Math.floor(this.pos.y + 0.02); y++) {
      for (let z = Math.floor(z0); z <= Math.floor(z1); z++) {
        for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
          const id = this.world.getBlock(x, y, z);
          if (!isSolid(id)) continue;
          const meta = this.world.getMeta ? this.world.getMeta(x, y, z) : 0;
          for (const box of blockBoxes(id, meta)) {
            const top = y + box[4];
            if (top < this.pos.y - 0.1 || top > this.pos.y + 0.04) continue;
            const width = Math.max(0, Math.min(x1, x + box[3]) - Math.max(x0, x + box[0]));
            const depth = Math.max(0, Math.min(z1, z + box[5]) - Math.max(z0, z + box[2]));
            if (width * depth > largestContact) { largestContact = width * depth; material = id; }
          }
        }
      }
    }
    return material;
  }

  headBlockId() {
    return this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.eyeY), Math.floor(this.pos.z));
  }

  /* ---------- 主更新 ---------- */
  update(dt, input) {
    dt = Math.min(dt, 0.05);
    // D2 监视器要用「物理实际推进的时间」而不是 rAF 间隔：测试里会用固定步长手动推进物理，
    // 那种帧的位移是真实的物理结果，不该被当成瞬移。
    this.physicsTime = (this.physicsTime || 0) + dt;
    const wasOnGround = this.onGround;

    // 环境
    this.inWater = this.touchesWater();
    this.eyeInWater = this.headBlockId() === B.WATER;
    const onGroundNow = this.checkOnGround();
    if (onGroundNow) { this.onGround = true; }

    // 期望水平速度
    let forward = (input.keyW ? 1 : 0) - (input.keyS ? 1 : 0);
    let strafe = (input.keyD ? 1 : 0) - (input.keyA ? 1 : 0);
    if (input.pointerDir) { forward += input.pointerDir.f; strafe += input.pointerDir.s; }
    forward = Math.max(-1, Math.min(1, forward));
    strafe = Math.max(-1, Math.min(1, strafe));

    this.sneakHeld = !!input.sneak;          // 空中也记住「按着潜行」，落到粘液块时不弹
    this.sneaking = this.sneakHeld && !this.flying && this.onGround;
    this.sprinting = !!input.sprint && !this.sneaking && !this.blocking && (forward > 0.1);

    let speed;
    if (this.flying) speed = input.sprint ? PHYS.flySprintSpeed : PHYS.flySpeed;
    else if (this.inWater) speed = PHYS.swimSpeed;
    else if (this.sneaking) speed = PHYS.sneakSpeed;
    else if (this.sprinting) speed = PHYS.sprintSpeed;
    else speed = PHYS.walkSpeed;
    // T2：举盾时移动明显变慢（仍能移动，不钉在原地）
    if (this.blocking && !this.flying) speed *= SHIELD_MOVE_MULT;

    const sinY = Math.sin(this.yaw), cosY = Math.cos(this.yaw);
    // yaw=0 视线朝 -Z
    let wishX = (-sinY * forward) + (cosY * strafe);
    let wishZ = (-cosY * forward) + (-sinY * strafe);
    const wl = Math.hypot(wishX, wishZ);
    if (wl > 0.0001) { wishX /= wl; wishZ /= wl; } else { wishX = 0; wishZ = 0; }

    /* FL：创造飞行让 W/S 沿「视线方向」走，而不只是水平面。
       抬头按 W 往上飞、低头按 W 往下俯冲；A/D 仍是水平横移，
       Space/Shift 仍是垂直升降 —— 与 Minecraft 创造模式一致。
       只改写 flying 分支的期望方向；生存 / 游泳 / 水下移动的逻辑一字未动。 */
    let flyWishY = 0;
    if (this.flying) {
      const upRaw = (input.jump ? 1 : 0) - (input.sneak ? 1 : 0) +
        (input.pointerDir ? (input.pointerDir.u || 0) : 0);
      const up = Math.max(-1, Math.min(1, upRaw));
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      // 前向量含 pitch，右向量保持水平
      const dirX = (-sinY * cp) * forward + (cosY * strafe);
      const dirZ = (-cosY * cp) * forward + (-sinY * strafe);
      const dirY = sp * forward + up * 0.8;
      // 只做长度上限归一：单方向输入仍是满速，斜飞 / W+Space 不叠加超速
      const dl = Math.hypot(dirX, dirY, dirZ);
      wishX = dl > 1 ? dirX / dl : dirX;
      wishZ = dl > 1 ? dirZ / dl : dirZ;
      flyWishY = dl > 1 ? dirY / dl : dirY;
    }

    const accel = this.onGround || this.flying ? 12 : 12 * PHYS.airControl;
    const targetVX = wishX * speed, targetVZ = wishZ * speed;
    this.vel.x += (targetVX - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (targetVZ - this.vel.z) * Math.min(1, accel * dt);
    if (wl < 0.0001 && (this.onGround || this.flying)) {
      const f = Math.pow(this.flying ? 0.02 : PHYS.groundFriction, dt * 20);
      this.vel.x *= f; this.vel.z *= f;
    }

    // 垂直
    if (this.flying) {
      this.vel.y += (flyWishY * speed - this.vel.y) * Math.min(1, 12 * dt);
      this.fallStart = null;
    } else if (this.inWater) {
      this.vel.y -= PHYS.gravity * 0.16 * dt * this.gravityScale;
      if (input.jump) this.vel.y = Math.min(this.vel.y + 26 * dt, 3.2);
      this.vel.y = Math.max(this.vel.y, -3.2);
      this.fallStart = null;
    } else {
      this.vel.y -= PHYS.gravity * dt * this.gravityScale;
      if (this.vel.y < -PHYS.terminal) this.vel.y = -PHYS.terminal;
      if (input.jump && this.onGround) {
        this.vel.y = PHYS.jumpSpeed;
        this.onGround = false;
        this.audioSteppingUp = false;
        this.emit('jump');
      }
    }

    // 移动 + 碰撞（分步，避免高速穿墙）
    const moveX = this.pos.x, moveZ = this.pos.z;
    const impactSpeed = Math.max(0, -this.vel.y);
    const total = Math.max(Math.abs(this.vel.x), Math.abs(this.vel.y), Math.abs(this.vel.z)) * dt;
    const steps = Math.max(1, Math.ceil(total / 0.4));
    const sd = dt / steps;
    for (let k = 0; k < steps; k++) this.moveStep(sd);

    // 地面判定
    this.onGround = this.checkOnGround();
    const audioInWater = this.touchesWater();
    let landed = false;
    if (this.onGround && !wasOnGround) {
      this.onLand();
      if (this.onGround && !audioInWater && !this.flying && !this.audioSteppingUp &&
          this.audioAirTime >= 0.08 && impactSpeed >= 1.2) {
        this.emit('land', this.supportBlockId(), { speed: impactSpeed });
        this.stepTimer = 1.9;
        landed = true;
      }
    }
    if (this.onGround) {
      this.audioAirTime = 0;
      this.audioSteppingUp = false;
    } else if (!audioInWater && !this.flying) this.audioAirTime += dt;
    else this.audioAirTime = 0;
    if (!this.onGround && this.vel.y < 0 && this.fallStart === null && !this.flying) {
      this.fallStart = this.pos.y;
    }
    if (this.flying || this.inWater) this.fallStart = null;

    // 脚步声与视角摇晃
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const groundDistance = Math.hypot(this.pos.x - moveX, this.pos.z - moveZ);
    if (this.onGround && !landed && !audioInWater && !this.flying && groundDistance > 0.0001) {
      this.walkDist += groundDistance;
      this.bob = Math.sin(this.walkDist * 1.9) * (this.sprinting ? 0.055 : 0.035);
      this.stepTimer -= groundDistance;
      if (this.stepTimer <= 0) {
        this.stepTimer = 2.05;
        this.emit('footstep', this.supportBlockId());
      }
    } else {
      this.bob *= Math.pow(0.02, dt);
    }

    // 水下呼吸
    if (this.eyeInWater && !this.creative) {
      this.air = Math.max(0, (this.air === undefined ? 10 : this.air) - dt * 0.5);
      if (this.air <= 0) {
        this._drownT = (this._drownT || 0) + dt;
        if (this._drownT >= 2) { this._drownT = 0; this.hurt(1, '溺水', 'drown'); }
      }
    } else {
      this._drownT = 0;
      if (this.air === undefined) this.air = 10;
      else this.air = Math.min(10, this.air + dt * 4);
    }

    // T4 接触伤害（本作只有仙人掌）：贴着不掉，持续接触每 0.5 秒掉 1 血；创造模式免疫
    if (!this.creative && this.touchingHazard()) {
      this._hazT = (this._hazT || 0) + dt;
      if (this._hazT >= 0.5) { this._hazT = 0; this.hurt(1, '仙人掌', 'cactus'); }
    } else this._hazT = 0;

    // 饥饿与活动消耗
    if (hs > 0.9) this.addExhaustion(hs * dt * (this.sprinting ? 0.08 : 0.03));
    if (this.poisonT > 0) {
      this.poisonT -= dt;
      this._poisonTick = (this._poisonTick || 0) + dt;
      if (this._poisonTick > 1.4) { this._poisonTick = 0; this.hurt(1, '食物中毒', 'poison'); }
    }
    this.tickHunger(dt);

    /* 掉出世界底部：判据必须跟着布局走。
       旧布局底部是 0，写死 -8 = 「底部再往下 8 格」；新档底部是 -64，
       沿用 -8 会让玩家正常挖到 y=-9 就当场「掉出世界」死亡（阶段 1 第 3 刀的取证截图直接撞出来）。
       没有布局字段的老 mock 回落 -8，与改造前逐位一致。 */
    const voidY = Number.isFinite(this.world && this.world.minY) ? this.world.minY - 8 : -8;
    if (this.pos.y < voidY) { this.health = 0; this.emit('death', '掉出世界'); }
    if (this.invulnerable > 0) this.invulnerable -= dt;
  }

  moveStep(dt) {
    const dx = this.vel.x * dt, dz = this.vel.z * dt;
    if ((dx || dz) && this.tryStepUp(dx, dz)) return;      // T4：能抬上去的矮台阶直接走上去
    this.moveAxis('x', dx);
    this.moveAxis('y', this.vel.y * dt);
    this.moveAxis('z', dz);
  }

  /* T4 自动上台阶：贴地行走被 ≤1 格的高台挡住时，抬升一格再按原来的逐轴碰撞推进。
     潜行 / 飞行 / 水中 / 目标位置（含头顶）不干净 / 抬到仙人掌上 —— 一律不做。 */
  tryStepUp(dx, dz) {
    if (this.sneaking || this.flying || this.inWater || !this.onGround) return false;
    const blocked = this.intersectsSolid(this.pos.x + dx, this.pos.y, this.pos.z) ||
      this.intersectsSolid(this.pos.x, this.pos.y, this.pos.z + dz);
    if (!blocked) return false;
    const target = stepTargetY(this.pos.y);
    if (target === null) return false;
    // 起点与落点脚下那一排都不能是伤害方块：不许把自己「自动抬」上仙人掌
    if (this.hazardsUnder(this.pos.x, target, this.pos.z)) return false;
    if (this.hazardsUnder(this.pos.x + dx, target, this.pos.z + dz)) return false;
    if (this.intersectsSolid(this.pos.x, target, this.pos.z)) return false;
    // 抬升后的「落点」也必须干净，否则会出现白跳一下再掉回来的抖动（2 格高的墙就是这种情形）
    if (this.intersectsSolid(this.pos.x + dx, target, this.pos.z + dz)) return false;
    this.pos.y = target;
    this.onGround = false;
    this.fallStart = null;
    this.vel.y = Math.max(this.vel.y, 0);
    this.audioSteppingUp = true;
    this.moveAxis('x', dx);
    this.moveAxis('z', dz);
    this.stepups = (this.stepups || 0) + 1;
    this.emit('stepup');
    return true;
  }

  /* 站在 (x, y, z) 时脚下那一排格子里是否有伤害方块（按整个 AABB 宽度算） */
  hazardsUnder(x, y, z) {
    const hw = this.dims.w / 2, EPS = 1e-4;
    const x0 = Math.floor(x - hw + EPS), x1 = Math.floor(x + hw - EPS);
    const z0 = Math.floor(z - hw + EPS), z1 = Math.floor(z + hw - EPS);
    for (let zz = z0; zz <= z1; zz++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (hurtsOnTouch(this.world.getBlock(xx, y - 1, zz))) return true;
      }
    }
    return false;
  }

  /* T4 玩家 AABB 覆盖到的格子（含脚下踩着的那格）是否有接触伤害方块。
     把脚下的格子也算进来，才能覆盖「站在仙人掌上」这种情形（与原版一致：会持续掉血）。 */
  touchingHazard() {
    // 水平方向多算 0.03 格：仙人掌是实心方块，玩家永远进不到它那一格里，
    // 不加这点余量的话「贴着它的面」就不算接触（原版里碰到刺就会掉血）。
    const hw = this.dims.w / 2 + 0.03;
    const x0 = Math.floor(this.pos.x - hw), x1 = Math.floor(this.pos.x + hw);
    const z0 = Math.floor(this.pos.z - hw), z1 = Math.floor(this.pos.z + hw);
    const y0 = Math.floor(this.pos.y - 0.05), y1 = Math.floor(this.pos.y + this.dims.h - 0.02);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (hurtsOnTouch(this.world.getBlock(x, y, z))) return true;
        }
      }
    }
    return false;
  }

  moveAxis(axis, delta) {
    if (!delta) return;
    const old = this.pos[axis];
    const next = old + delta;
    this.pos[axis] = next;
    if (!this.intersectsSolid(this.pos.x, this.pos.y, this.pos.z)) return;

    const hw = this.dims.w / 2;
    const EPS = 1e-4;
    /* 第二轮 C1：碰到非整块（半砖/楼梯）时，整数贴合会把人钉到方块顶面之外
       （半砖顶面在 +0.5，整数贴合会算成 +1，于是站上去又被弹起）。
       这里对「旧位置（必定不重叠）→ 新位置（重叠）」做二分，取不重叠的一侧。 */
    if (this.shapedNear(this.pos.x, this.pos.y, this.pos.z)) {
      let lo = old, hi = next;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        this.pos[axis] = mid;
        if (this.intersectsSolid(this.pos.x, this.pos.y, this.pos.z)) hi = mid; else lo = mid;
      }
      this.pos[axis] = lo;
      if (axis === 'x') this.vel.x = 0; else if (axis === 'y') { this.vel.y = 0; if (delta < 0) this.onGround = true; } else this.vel.z = 0;
      return;
    }
    if (axis === 'y') {
      if (delta < 0) {
        // 脚下被撞：贴到该方块顶面
        this.pos.y = Math.floor(next) + 1 + EPS;
        this.vel.y = 0;
        this.onGround = true;
      } else {
        // 头顶被撞：贴到该方块底面
        this.pos.y = Math.floor(next + this.dims.h) - this.dims.h - EPS;
        this.vel.y = 0;
      }
    } else if (axis === 'x') {
      if (delta > 0) this.pos.x = Math.floor(next + hw) - hw - EPS;
      else this.pos.x = Math.floor(next - hw) + 1 + hw + EPS;
      this.vel.x = 0;
    } else {
      if (delta > 0) this.pos.z = Math.floor(next + hw) - hw - EPS;
      else this.pos.z = Math.floor(next - hw) + 1 + hw + EPS;
      this.vel.z = 0;
    }
    // 兜底：极端情况下对齐后仍相交则完全回退
    if (this.intersectsSolid(this.pos.x, this.pos.y, this.pos.z)) {
      this.pos[axis] = old;
      if (axis === 'x') this.vel.x = 0; else if (axis === 'y') this.vel.y = 0; else this.vel.z = 0;
    }
  }

  checkOnGround() {
    if (this.flying) return false;
    return this.intersectsSolid(this.pos.x, this.pos.y - 0.06, this.pos.z);
  }

  onLand() {
    if (this.fallStart === null) return;
    const dist = this.fallStart - this.pos.y;
    this.fallStart = null;
    // T6 粘液块：落在上面按坠落高度反弹，并完全免除这次摔落伤害；潜行时不弹
    const below = this.blockAtFeet();
    if (below === B.SLIME_BLOCK && !this.sneakHeld) {
      this.vel.y = 6.5 + Math.min(6, Math.max(0, dist) * 0.45);
      this.onGround = false;
      this.fallStart = null;
      this.emit('bounce', dist);
      return;
    }
    if (dist > 3.2 && !this.creative) {
      const dmg = Math.floor(dist - 3);
      if (dmg > 0) this.hurt(dmg, '摔落', 'fall');
    }
  }

  /* ---------- 饥饿与回血 ---------- */
  addExhaustion(n) {
    if (this.creative) return;
    this.exhaustion += n;
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
  }

  tickHunger(dt) {
    if (this.creative) { this.hunger = 20; this.saturation = 5; return; }
    // 自然消耗：站立很慢，行走/冲刺更快
    this.addExhaustion(dt * (this.onGround ? 0.06 : 0.02));
    // 回血：吃饱且非创造
    if (this.hunger >= 18 && this.health < this.maxHealth) {
      this.regenT += dt;
      if (this.regenT >= 3.2) {
        this.regenT = 0;
        this.health = Math.min(this.maxHealth, this.health + 1);
        this.addExhaustion(1.2);
        this.emit('heal', 1);
      }
    } else this.regenT = 0;
    // 饿死
    if (this.hunger <= 0) {
      this.starveT += dt;
      if (this.starveT >= 3.5) { this.starveT = 0; this.hurt(1, '饥饿', 'starve'); }
    } else this.starveT = 0;
  }

  /* 吃下物品，返回是否成功 */
  eat(itemId) {
    const it = getItem(itemId);
    if (!it || !it.food) return false;
    if (this.hunger >= 20 && !it.poison) return false;
    this.hunger = Math.max(0, Math.min(20, this.hunger + it.food));
    this.saturation = Math.min(this.hunger, this.saturation + (it.saturation || it.food * 0.6));
    if (it.poison && Math.random() < it.poison) {
      this.poisonT = 4;
      this.emit('poison', itemId);
    }
    this.emit('eat', itemId);
    return true;
  }

  /**
   * 受伤。type 必须由调用点**显式**给出（见下表的伤害入口），只有战斗类型会被护甲减免：
   *   'melee'     生物近战          （mobs.js ai）
   *   'arrow'     生物射出的箭      （mobs.js _arrowStrike）
   *   'explosion' 苦力怕/爆炸       （game.js onCreeperExplode）
   *   'fall' 摔落 / 'cactus' 仙人掌 / 'drown' 溺水 / 'starve' 饥饿 / 'poison' 中毒 / 'void' 掉出世界
   * 不允许省略 type 后靠默认值碰运气 —— 默认 'generic' 明确不可减免。
   * @returns {object|null} 本次伤害明细；被无敌帧/创造模式挡下时返回 null
   */
  hurt(amount, reason, type = 'generic', src = null) {
    if (this.invulnerable > 0 && type !== 'fall') return null;
    if (this.creative) return null;
    const raw = Math.max(0, Number.isFinite(amount) ? amount : 0);
    /* T2 盾牌：只挡正面 120° 的近战/箭矢；src 是攻击来源的 {x,z}（箭用箭的上游位置）。
       成功格挡不扣血、不穿护甲，耐久与音效由 Game 的 onShieldBlock 负责。
       爆炸（type='explosion'）不走这里 —— shieldCanBlock 明确返回 false。 */
    if (this.blocking && raw > 0 && shieldCanBlock(type) && src) {
      const d = this.lookDir();
      const dx = src.x - this.pos.x, dz = src.z - this.pos.z;
      if (inShieldArc(d.x, d.z, dx, dz)) {
        const info = {
          type, kind: src.kind || type, raw: Math.round(raw * 100) / 100, taken: 0, blocked: true,
          source: src.kind || type, reason,
          angle: Math.round(Math.acos(Math.max(-1, Math.min(1,
            (d.x * dx + d.z * dz) / ((Math.hypot(d.x, d.z) * Math.hypot(dx, dz)) || 1)))) * 180 / Math.PI)
        };
        const hook = this.onShieldBlock ? this.onShieldBlock(info) : null;
        this.lastBlock = Object.assign({}, info, hook || {});
        this.invulnerable = 0.35;
        this.emit('blocked', this.lastBlock);
        return info;
      }
    }
    let taken = raw;
    let armorPoints = 0;
    let blocked = 0;
    let broken = [];
    if (ARMOR_DAMAGE_TYPES.has(type) && this.armor && raw > 0) {
      armorPoints = Math.max(0, Number(this.armor.points ? this.armor.points() : 0) || 0);
      taken = applyArmorReduction(raw, armorPoints);
      blocked = Math.round((raw - taken) * 100) / 100;
      // 只有真正挨到伤害才算磨损：无敌帧在上面的 return 已经挡掉，创造模式也是
      if (armorPoints > 0) {
        const res = this.armor.onHit ? this.armor.onHit() : null;
        if (Array.isArray(res)) broken = res;
      }
    }
    this.health = Math.max(0, this.health - taken);
    this.invulnerable = 0.5;
    const info = {
      type, kind: type, blocked: false, absorbed: blocked,
      raw: Math.round(raw * 100) / 100, taken: Math.round(taken * 100) / 100,
      armorPoints, broken: broken.slice(), reason
    };
    this.lastHurt = info;
    this.emit('hurt', taken, reason, info);
    if (this.health <= 0) this.emit('death', reason);
    return info;
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
    this.emit('heal', amount);
  }

  respawn(spawn) {
    this.health = this.maxHealth;
    this.flying = false;
    this.spawnAt(spawn.x, spawn.y, spawn.z);
    this.emit('respawn');
  }

  setCreative(v) {
    this.creative = !!v;
    if (!v) this.flying = false;
    this.emit('modeChanged', v);
  }

  toggleFly() {
    if (!this.creative) return false;
    this.flying = !this.flying;
    if (this.flying) { this.vel.y = 0; this.fallStart = null; }
    this.emit('flyChanged', this.flying);
    return this.flying;
  }

  /* 相机姿态 */
  applyCamera(camera, shake = 0) {
    camera.position.set(this.pos.x, this.eyeY + this.bob, this.pos.z);
    camera.rotation.set(this.pitch, this.yaw + (shake ? (Math.random() - 0.5) * shake : 0), 0);
  }

  lookDir() {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }

  reach() { return this.creative ? PHYS.reachCreative : PHYS.reach; }
}
