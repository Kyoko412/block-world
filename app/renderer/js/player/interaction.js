'use strict';
/*
 * 交互：挖掘（含进度/破损音/粒子/掉落/耐久）、放置、使用（打开工作台与熔炉）、
 * 以及掉落物的物理与拾取。
 */
import { B, BLOCKS, AIR, breakTime, blockDrops, hasFacing, isReplaceable, isPlant, isDoorBlock } from '../core/blocks.js';
import { WORLD_H } from '../world/chunk.js';
import { getItem, maxStack } from '../core/items.js';
import { BOW_CHARGE_SECONDS, bowCanFire } from '../core/projectile.js';
import { itemToBlockId } from './inventory.js';
import { MELEE_REACH, attackCooldownFor, attackCharge } from '../core/melee.js';
import { Particles, DropMeshFactory } from '../gfx/entities.js';

const STEP_SOUND = {
  [B.GRASS]: 'step_grass', [B.DIRT]: 'step_grass', [B.LEAVES]: 'step_grass',
  [B.DIRT_PATH]: 'step_grass', [B.FARMLAND]: 'step_grass', [B.BIRCH_LEAVES]: 'step_grass',
  [B.STONE]: 'step_stone', [B.COBBLESTONE]: 'step_stone', [B.SANDSTONE]: 'step_stone',
  [B.BEDROCK]: 'step_stone', [B.GLOWSTONE]: 'step_stone', [B.OBSIDIAN]: 'step_stone',
  [B.SAND]: 'step_sand', [B.GRAVEL]: 'step_sand',
  [B.LOG]: 'step_wood', [B.PLANKS]: 'step_wood', [B.CRAFTING_TABLE]: 'step_wood', [B.FURNACE]: 'step_stone',
  [B.BIRCH_LOG]: 'step_wood', [B.BIRCH_PLANKS]: 'step_wood', [B.CHEST]: 'step_wood', [B.BED]: 'step_wood',
  [B.DOOR_BOTTOM]: 'step_wood', [B.DOOR_TOP]: 'step_wood',
  [B.SLAB_PLANKS]: 'step_wood', [B.STAIRS_PLANKS]: 'step_wood',
  [B.SLAB_STONE]: 'step_stone', [B.STAIRS_STONE]: 'step_stone', [B.SNOW]: 'step_snow'
};

const DIG_SOUND = {
  [B.GRASS]: 'dig_grass', [B.DIRT]: 'dig_dirt', [B.SAND]: 'dig_sand', [B.GRAVEL]: 'dig_gravel',
  [B.LOG]: 'dig_wood', [B.PLANKS]: 'dig_wood', [B.CRAFTING_TABLE]: 'dig_wood',
  [B.LEAVES]: 'dig_grass', [B.BIRCH_LEAVES]: 'dig_grass', [B.BIRCH_LOG]: 'dig_wood'
};
const BREAK_SOUND = {
  [B.GRASS]: 'break_grass', [B.DIRT]: 'break_dirt', [B.SAND]: 'break_sand', [B.GRAVEL]: 'break_sand',
  [B.LOG]: 'break_wood', [B.PLANKS]: 'break_wood', [B.CRAFTING_TABLE]: 'break_wood',
  [B.LEAVES]: 'break_grass', [B.BIRCH_LEAVES]: 'break_grass', [B.BIRCH_LOG]: 'break_wood'
};

/* 本轮 D：放置按材质分出三种接触（木 / 石 / 土 + 沙的干碎），其余仍走原 place。
   分组依据与 step/dig/break 同一套归类，玩家听到的「这是什么材质」在三种动作间是一致的。 */
const PLACE_SOUND = {
  [B.LOG]: 'place_wood', [B.PLANKS]: 'place_wood', [B.BIRCH_PLANKS]: 'place_wood',
  [B.CRAFTING_TABLE]: 'place_wood', [B.BIRCH_LOG]: 'place_wood', [B.CHEST]: 'place_wood',
  [B.STONE]: 'place_stone', [B.COBBLESTONE]: 'place_stone', [B.MOSSY]: 'place_stone',
  [B.STONE_BRICKS]: 'place_stone', [B.SANDSTONE]: 'place_stone', [B.FURNACE]: 'place_stone',
  [B.OBSIDIAN]: 'place_stone', [B.DEEPSLATE]: 'place_stone', [B.POLISHED_DEEPSLATE]: 'place_stone',
  [B.GLOWSTONE]: 'place_stone', [B.BEDROCK]: 'place_stone',
  [B.GRASS]: 'place_dirt', [B.DIRT]: 'place_dirt', [B.DIRT_PATH]: 'place_dirt', [B.FARMLAND]: 'place_dirt',
  [B.SAND]: 'place_sand', [B.GRAVEL]: 'place_sand'
};
export function placeSoundName(blockId) { return PLACE_SOUND[blockId] || 'place'; }

/* 本轮 E1：敲击、破坏、放置各用自己的变体序列。
   随包文件里每类材质有 4 条敲击、3 条破坏、3 条放置，全部是不同录音（见 core/digfiles.js）；
   连续两个动作不重复同一条，敲一串石头不会听成同一个采样在循环。
   单测只需要「相邻不重复」与「名字都在登记表里」，不钉具体概率。
   脚步骤材的变体由 movementSoundName 自己轮换（同一套思路，四条录音）。 */
const ACTION_VARIANTS = { dig: 4, break: 3, place: 3 };
const VARIANT_SUFFIX = ['', '_b', '_c', '_d'];
/* 不同材料的敲击力度：土最闷最重，草/叶碎响要听得见（原先偏轻），石头偏硬但别扎耳，木居中。 */
const DIG_VOLUME = { dig_dirt: 0.5, dig_grass: 0.5, dig_stone: 0.46, dig_wood: 0.5, dig_sand: 0.48, dig_gravel: 0.5 };
export const BREAK_VOLUME = 0.8;
export const PLACE_VOLUME = 0.5;

export class Interaction {
  constructor(ctx) {
    this.ctx = ctx;            // {world, view, controller, inventory, sfx, game}
    this.target = null;
    this.mining = { hit: null, progress: 0, total: 1, digTimer: 0 };
    this.placeCd = 0;
    this.bowCharge = 0;          // T3 蓄力进度 0~1；-1 表示「没有箭」的占位状态
    this.bowLast = null;
    this.mineSwingT = 0;         // V3：挖掘循环里周期性触发挥镐，而不是只有开始/结束两帧
    /* P0：攻击恢复。空挥也进恢复，连点不能连续结算满额伤害。 */
    this.attackTimer = 0;
    this.attackTotal = 0.25;
    this.enabled = true;
    this.movementVariants = Object.create(null);
    this.actionVariants = Object.create(null);   // 'dig:dig_stone' -> 上一条变体序号
    this.drops = new DropManager(ctx);
    if (ctx.view && ctx.view.scene) this.drops.init(ctx.view.scene);
  }

  /* ---------- 目标射线 ---------- */
  updateTarget() {
    const c = this.ctx.controller, w = this.ctx.world;
    const d = c.lookDir();
    const hit = w.raycast(c.pos.x, c.eyeY, c.pos.z, d.x, d.y, d.z, c.reach(),
      (id) => id !== B.WATER);
    this.target = hit;
    this.ctx.view.setSelection(hit);
    if (this.mining.hit && (!hit || hit.x !== this.mining.hit.x || hit.y !== this.mining.hit.y || hit.z !== this.mining.hit.z)) {
      this.mining.hit = null; this.mining.progress = 0;
    }
    return hit;
  }

  update(dt) {
    if (!this.enabled) {
      // 打开背包/暂停/死亡：格挡必须当场清掉，不能因为「没走到 update 尾部」永久减速
      this.cancelBlocking();
      this.ctx.view.setBreakProgress(null, 0);
      this.drops.update(dt);
      return;
    }
    const st = this.ctx.input.state;
    this.updateTarget();
    if (this.placeCd > 0) this.placeCd -= dt;
    /* P0：攻击恢复按真实 dt 推进（不按帧数），并把进度交给低调的准星提示。 */
    if (this.attackTimer > 0) this.attackTimer = Math.max(0, this.attackTimer - dt);
    const p0Held = this.ctx.inventory.held();
    const p0Def = p0Held ? getItem(p0Held.item) : null;
    this.attackTotal = attackCooldownFor(p0Def);
    const p0Charge = attackCharge(this.attackTimer, this.attackTotal);
    if (this.ctx.game.ui && this.ctx.game.ui.setAttackCharge) this.ctx.game.ui.setAttackCharge(p0Charge);

    /* T2 盾牌：手持盾牌 + 右键 + 没有对准可交互对象 → 举盾。
       对准工作台/熔炉/箱子/床时 wantBlock=false，优先走原来的 tryPlace 交互链路，
       不吞掉旧右键。举盾期间不能攻击、不能挖掘、不能放方块。 */
    const wantBlock = this.isShieldHeld() && !!st.mouseRight && !this.isInteractiveTarget();
    this.ctx.controller.blocking = wantBlock;
    if (wantBlock && this.mining.hit) {
      this.mining.hit = null; this.mining.progress = 0;
      this.ctx.view.setBreakProgress(null, 0);
    }

    // 挖掘（左键按下的一瞬间优先尝试攻击生物）；举盾时左键不做任何战斗动作
    if (st.mouseLeft && !this._wasLeft && !wantBlock) {
      /* V4：即使挥空也要有挥动动作；命中音/红闪/命中标记只由 hitMob 触发，
         这样「空挥」与「打中」在画面与声音上都能区分。 */
      this.ctx.heldSwing && this.ctx.heldSwing(1, 'attack');
      const chargeNow = attackCharge(this.attackTimer, this.attackTotal);
      const blockDist = this.target && this.target.dist !== undefined ? this.target.dist : Infinity;
      const mob = this.ctx.mobs
        ? this.ctx.mobs.attackMelee(MELEE_REACH, blockDist, chargeNow) : null;
      /* 空挥也进入恢复：原版如此，也是「连点不刷满额伤害」的关键。 */
      this.attackTimer = this.attackTotal;
      if (this.ctx.game.ui && this.ctx.game.ui.setAttackCharge) this.ctx.game.ui.setAttackCharge(0);
      if (mob) {
        this._attacked = true;
        this.ctx.game.onMobAttacked && this.ctx.game.onMobAttacked(mob);
      } else {
        this._attacked = false;
        /* T4：只有对着空气挥空才有挥击声；对着方块时交给挖掘循环，避免两种音叠在一起。
           挥空用两条真实挥动录音轮换，短而轻，不叠命中声。 */
        if (!this.target) {
          this.swingVariant = ((this.swingVariant || 0) + 1) % 2;
          this.ctx.sfx.play('swing' + ['', '_b'][this.swingVariant], { volume: 0.34, rate: 0.98 + Math.random() * 0.04 });
        }
      }
    }
    this._wasLeft = st.mouseLeft;

    if (st.mouseLeft && this.target && !this._attacked && !wantBlock) {
      if (!this.mining.hit || this.mining.hit.x !== this.target.x) this.startMining(this.target);
      this.mineTick(dt);
    } else if (this.mining.hit) {
      this.mining.hit = null; this.mining.progress = 0;
      this.ctx.view.setBreakProgress(null, 0);
    }

    // 放置（右键，带冷却，支持长按）；T3：手持弓时右键改成蓄力射击；剪刀：右键剪羊毛；动物食物：右键喂食繁殖
    if (wantBlock) { /* 举盾：右键只用于格挡，不放置、不使用物品 */ }
    else if (this.isBowHeld()) this.updateBow(dt, st);
    else if (this.isShearsHeld()) this.updateShears(st);
    /* 本轮 E3：吃东西不需要瞄准方块（对着天也能吃），按住右键才推进；
       真正的咬/嚼/吞节奏与扣物品都在 Game 的进食过程里。 */
    else if (st.mouseRight && this.isFoodHeld()) {
      if (this.eatCd === undefined) this.eatCd = 0;
      if (this.eatCd <= 0) this.eatCd = 0.25;
      this.ctx.game.startEating(this.ctx.inventory.held());
    }
    else if (st.mouseRight && this.placeCd <= 0 && this.tryVillagerInteract(st)) { /* 打开村民交易 */ }
    else if (st.mouseRight && this.placeCd <= 0 && this.tryMapTool(st)) { /* 地图 / 指南针 */ }
    else if (st.mouseRight && this.placeCd <= 0 && this.tryWolfInteract(st)) { /* 骨头驯服 / 空手坐下 */ }
    else if (st.mouseRight && this.placeCd <= 0 && this.tryFeedNearby(st)) { /* 已被喂食逻辑消费 */ }
    else if (st.mouseRight && this.placeCd <= 0) this.tryPlace();

    this.drops.update(dt);
    this._wasRight = !!st.mouseRight;         // 上升沿检测统一在这里收尾，换手持物也不会失灵
  }

  /* ---------- T2 盾牌 ---------- */
  isShieldHeld() {
    const h = this.ctx.inventory.held();
    const it = h ? getItem(h.item) : null;
    return !!(it && it.shield);
  }

  /** 手里是不是食物（吃东西不依赖准星目标） */
  isFoodHeld() {
    const h = this.ctx.inventory.held();
    const it = h ? getItem(h.item) : null;
    return !!(it && it.food);
  }

  /** 准星对着的方块是不是「右键有原交互」的对象（工作台/熔炉/箱子/床/村民） */
  isInteractiveTarget() {
    if (this.target) {
      const id = this.ctx.world.getBlock(this.target.x, this.target.y, this.target.z);
      if (id === B.CRAFTING_TABLE || id === B.FURNACE || id === B.FURNACE_LIT || id === B.CHEST || id === B.BED) return true;
    }
    /* 滚动任务 6：准星对着村民时，右键必须打开交易而不是举盾格挡 */
    if (this.ctx.mobs) {
      const c = this.ctx.controller;
      if (this.ctx.mobs.pickNearest(c.reach(), m => m.type === 'villager' && m.hp > 0)) return true;
    }
    return false;
  }

  cancelBlocking() {
    this.ctx.controller.blocking = false;
    /* V5：开界面/暂停/死亡/切栏时把拉弓也取消掉；否则关闭界面后的第一帧
       会把「已经松开的右键」当成松手，朝天上射出一箭。 */
    if (this.bowCharge !== 0) {
      this.bowCharge = 0;
      const ui = this.ctx.game && this.ctx.game.ui;
      if (ui && ui.setBowCharge) ui.setBowCharge(0);
    }
  }

  /* ---------- 剪刀：右键对有毛的羊剪毛 ---------- */
  isShearsHeld() {
    const h = this.ctx.inventory.held();
    const it = h ? getItem(h.item) : null;
    return !!(it && it.shears);
  }

  updateShears(st) {
    if (!st.mouseRight || this._wasRight || this.placeCd > 0) return;   // 只认「刚按下」这一帧
    const mob = this.ctx.mobs ? this.ctx.mobs.shear(this.ctx.controller.reach()) : null;
    if (mob) {
      this.placeCd = 0.25;
      this.ctx.heldSwing && this.ctx.heldSwing(1, 'use');
      // 创造模式不扣耐久（与其他工具一致）；扣到 0 会由 inventory 发 toolBreak 事件
      if (!this.ctx.controller.creative) this.ctx.inventory.damageHeldTool(1);
      return;
    }
    this.placeCd = 0.6;
    const ui = this.ctx.game && this.ctx.game.ui;
    if (ui && ui.toast) ui.toast('剪刀要对着有毛的羊按右键');
    this.ctx.sfx.play('click', { volume: 0.3 });
  }

  /* ---------- 喂食繁殖：手持动物食物对着成年动物按右键 ---------- */
  /**
   * @returns {boolean} true 表示这次右键已被喂食逻辑消费（不再走放置/进食）
   */
  tryFeedNearby(st) {
    if (!st.mouseRight || this._wasRight) return false;          // 只认「刚按下」这一帧
    const inv = this.ctx.inventory, c = this.ctx.controller;
    const held = inv.held();
    if (!held || !this.ctx.mobs || !this.ctx.mobs.isAnimalFood(held.item)) return false;
    const reach = c.reach();
    const target = this.ctx.mobs.pickNearest(reach, (m) => m.def.breedable && m.hp > 0);
    if (!target) return false;                                    // 没对着动物：交回原来的吃/放逻辑
    const res = this.ctx.mobs.feedNearby(reach, target);
    const ui = this.ctx.game && this.ctx.game.ui;
    if (res.ok) {
      this.placeCd = 0.4;
      if (!c.creative) inv.consumeHeld(1);
      this.ctx.heldSwing && this.ctx.heldSwing(1, 'use');
      if (ui && ui.toast) ui.toast('生了一只小' + (res.baby ? res.baby.name : '动物'));
      return true;
    }
    if (res.reason === 'no_target') return false;                 // 手上这个不是它的食物：让玩家照常吃东西
    this.placeCd = 0.4;
    if (ui && ui.toast) {
      ui.toast(res.reason === 'cooldown' ? '它刚繁殖过，还在冷却' : '旁边还要再有一只同类的成年动物');
    }
    return true;
  }

  /* ---------- 滚动任务 6：村民交易 ---------- */
  /** 右键对着村民：打开交易面板（手持任何东西都可以，不会被放置逻辑吞掉） */
  tryVillagerInteract(st) {
    if (!st.mouseRight || this._wasRight) return false;
    const mobs = this.ctx.mobs;
    if (!mobs) return false;
    const reach = this.ctx.controller.reach();
    const target = mobs.pickNearest(reach, m => m.type === 'villager' && m.hp > 0);
    if (!target) return false;
    const opened = this.ctx.game.openVillager ? this.ctx.game.openVillager(target) : false;
    this.placeCd = 0.4;
    return !!opened;
  }

  /* ---------- 滚动任务 8：地图 / 指南针右键 ---------- */
  tryMapTool(st) {
    if (!st.mouseRight || this._wasRight) return false;
    const held = this.ctx.inventory.held();
    const it = held ? getItem(held.item) : null;
    if (!it) return false;
    if (it.mapItem) {
      const opened = this.ctx.game.openMap ? this.ctx.game.openMap() : false;
      this.placeCd = 0.4;
      return !!opened;
    }
    if (it.compassItem) {
      this.placeCd = 0.5;
      return !!(this.ctx.game.readCompass && this.ctx.game.readCompass());
    }
    return false;
  }

  /* ---------- T6 狼：骨头驯服 / 空手切换坐下 ---------- */
  tryWolfInteract(st) {
    if (!st.mouseRight || this._wasRight) return false;
    const inv = this.ctx.inventory, c = this.ctx.controller, mobs = this.ctx.mobs;
    if (!mobs) return false;
    const ui = this.ctx.game && this.ctx.game.ui;
    const held = inv.held();
    const it = held ? getItem(held.item) : null;
    const reach = c.reach();
    // 骨头 → 未驯服的狼
    if (it && it.id === 'bone') {
      const target = mobs.pickNearest(reach, m => m.type === 'wolf' && !m.tamed && m.hp > 0);
      if (!target) return false;
      const res = mobs.tameWolf(target);
      this.placeCd = 0.35;
      if (!c.creative) inv.consumeHeld(1);
      this.ctx.heldSwing && this.ctx.heldSwing(1, 'use');
      if (ui && ui.toast) {
        ui.toast(res.tamed ? '驯服了这只狼：空手右键可以让它坐下/起身' :
          '它信任你了（' + res.progress + '/' + (res.need || 3) + ' 根骨头）');
      }
      return true;
    }
    // 空手 → 已驯服的狼：坐下 / 起身
    if (!held) {
      const target = mobs.pickNearest(reach, m => m.type === 'wolf' && m.tamed && m.hp > 0);
      if (!target) return false;
      const sitting = mobs.toggleWolfSit(target);
      this.placeCd = 0.35;
      if (ui && ui.toast) ui.toast(sitting ? '狼坐下了' : '狼起身了');
      return true;
    }
    return false;
  }

  /* ---------- T3 弓：按住右键蓄力，松手射出 ---------- */
  isBowHeld() {
    const h = this.ctx.inventory.held();
    const it = h ? getItem(h.item) : null;
    return !!(it && it.bow);
  }

  updateBow(dt, st) {
    const inv = this.ctx.inventory, c = this.ctx.controller;
    const ui = this.ctx.game && this.ctx.game.ui;
    if (st.mouseRight) {
      if (this.bowCharge === 0 && !c.creative && !inv.has('arrow', 1)) {
        this.bowCharge = -1;
        if (ui && ui.toast) ui.toast('没有箭了：燧石 + 木棍 + 羽毛可以合成');
        this.ctx.sfx.play('click', { volume: 0.4 });
      } else if (this.bowCharge >= 0) {
        this.bowCharge = Math.min(1, this.bowCharge + dt / BOW_CHARGE_SECONDS);
      }
      if (ui && ui.setBowCharge) ui.setBowCharge(Math.max(0, this.bowCharge));
      return;
    }
    const charged = this.bowCharge;
    this.bowCharge = 0;
    if (ui && ui.setBowCharge) ui.setBowCharge(0);
    if (charged < 0 || !bowCanFire(charged)) return;
    this.fireBow(charged);
  }

  fireBow(power) {
    const c = this.ctx.controller, inv = this.ctx.inventory;
    if (!this.ctx.mobs || !this.ctx.mobs.firePlayerArrow) return false;
    if (!c.creative && !inv.has('arrow', 1)) return false;
    const res = this.ctx.mobs.firePlayerArrow(c.lookDir(), power);
    if (!c.creative) {
      inv.remove('arrow', 1);
      inv.damageHeldTool(1);
    }
    this.ctx.heldSwing && this.ctx.heldSwing(1, 'use');
    const g = this.ctx.game;
    if (g && g.stats) g.stats.shot = (g.stats.shot || 0) + 1;
    this.bowLast = Object.assign({ power }, res);
    return true;
  }

  startMining(hit) {
    const c = this.ctx.controller;
    const held = this.ctx.inventory.held();
    const tool = held ? getItem(held.item) : null;
    const id = this.ctx.world.getBlock(hit.x, hit.y, hit.z);
    const total = breakTime(id, tool, c.creative);
    if (!Number.isFinite(total)) { this.mining.hit = null; return; }
    this.mining.hit = Object.assign({}, hit);
    this.mining.total = total;
    this.mining.progress = 0;
    this.mining.digTimer = 0;
    this.mineSwingT = 0;
  }

  /* 挖掘循环：真实进度、真实落点。
     顺序是「先判目标 → 推进进度 → 挥镐/碎屑 → 够了就破坏并 return → 否则按节奏补一记敲击」，
     所以一次成功破坏只会有收尾声一次，不会同一帧再叠一记敲击。 */
  mineTick(dt) {
    const m = this.mining;
    if (!m.hit) return;
    const w = this.ctx.world;
    const id = w.getBlock(m.hit.x, m.hit.y, m.hit.z);
    /* 目标已经不存在（被别人挖掉、爆炸、读档回退）：松手，不再对着空气继续敲。 */
    if (id === AIR) { this.stopMining(); return; }
    m.progress += dt / m.total;
    m.digTimer -= dt;
    this.mineSwingT -= dt;
    if (this.mineSwingT <= 0) {
      this.mineSwingT = 0.26;               // 与挥镐节奏一致，不每帧触发
      this.ctx.heldSwing && this.ctx.heldSwing(0.55, 'mine');
      /* 挖掘过程中少量碎屑：颜色取命中方块平均色，数量/寿命由 Particles 上限管住 */
      this.ctx.particles.spawnBlock(m.hit.x + 0.5, m.hit.y + 0.5, m.hit.z + 0.5, id, 2);
    }
    if (m.progress >= 1) { this.finishBreak(m.hit); return; }
    if (m.digTimer <= 0) {
      m.digTimer = 0.24;
      const base = DIG_SOUND[id] || 'dig_stone';
      this.ctx.sfx.play(this.actionSoundName('dig', base), {
        rate: 0.98 + Math.random() * 0.04,
        volume: DIG_VOLUME[base] === undefined ? 0.48 : DIG_VOLUME[base]
      });
    }
    this.ctx.view.setBreakProgress(m.hit, Math.min(0.999, m.progress));
  }

  /* 敲击/破坏/放置的变体轮换：同一动作的下一条不重复上一条录音。 */
  actionSoundName(action, base) {
    const pool = ACTION_VARIANTS[action] || 1;
    const key = action + ':' + base;
    const last = this.actionVariants[key];
    let pick = Math.floor(Math.random() * (last === undefined ? pool : pool - 1));
    if (last !== undefined && pick >= last) pick++;
    this.actionVariants[key] = pick;
    return base + VARIANT_SUFFIX[pick];
  }

  stopMining() {
    m_reset(this.mining);
    this.ctx.view.setBreakProgress(null, 0);
  }

  finishBreak(hit) {
    const w = this.ctx.world, c = this.ctx.controller, inv = this.ctx.inventory;
    const id = w.getBlock(hit.x, hit.y, hit.z);
    if (id === AIR || id === B.BEDROCK) { m_reset(this.mining); return; }
    const meta = w.getMeta(hit.x, hit.y, hit.z);
    const b = BLOCKS[id];
    // T6 门：任意一半被破坏，整扇门一起消失，只掉一扇门
    if (isDoorBlock(id)) { this.breakDoor(hit, id); return; }
    // 工具等级不够 → 无掉落（但方块仍被破坏）
    const held = inv.held();
    const tool = held ? getItem(held.item) : null;
    const canHarvest = !b.toolLevel || (tool && tool.toolType === b.tool && (tool.toolLevel || 0) >= b.toolLevel);
    const rand = () => Math.random();
    const drops = canHarvest ? blockDrops(id, meta, rand) : [];

    w.setBlock(hit.x, hit.y, hit.z, AIR, 0);
    w.refreshImmediate(hit.x, hit.y, hit.z, this.ctx.view);
    // 箱子被破坏：内容物一并掉出
    if (id === B.CHEST && w.removeContainer) {
      const slots = w.removeContainer(hit.x, hit.y, hit.z);
      if (slots) for (const s of slots) {
        if (s) this.drops.spawn(s.item, s.count, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, true);
      }
    }
    // T2 床被破坏：设在这张床的重生点失效
    if (id === B.BED && this.ctx.game.onBedBroken) this.ctx.game.onBedBroken(hit);
    this.ctx.particles.spawnBlock(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, id, 14);
    this.ctx.sfx.play(this.actionSoundName('break', BREAK_SOUND[id] || 'break_stone'), { volume: BREAK_VOLUME });
    if (!c.creative) {
      for (const d of drops) this.drops.spawn(d.item, d.count, hit.x + 0.5, hit.y + 0.4, hit.z + 0.5, true);
      const broke = inv.damageHeldTool(1);
      if (broke) this.ctx.sfx.play('toolBreak' in this.ctx ? 'toolBreak' : 'hurt', { volume: 0.6 });
    }
    this.ctx.game.onBlockBroken && this.ctx.game.onBlockBroken(id, hit);
    m_reset(this.mining);
    this.ctx.view.setBreakProgress(null, 0);
  }

  /* T6 门：破坏任意一半 → 两格一起清空，只掉一扇门 */
  breakDoor(hit, id) {
    const w = this.ctx.world, c = this.ctx.controller;
    const bottomY = (id === B.DOOR_TOP || id === B.DOOR_TOP_OPEN) ? hit.y - 1 : hit.y;
    w.setBlock(hit.x, bottomY, hit.z, AIR, 0);
    w.setBlock(hit.x, bottomY + 1, hit.z, AIR, 0);
    w.refreshImmediate(hit.x, bottomY, hit.z, this.ctx.view);
    w.refreshImmediate(hit.x, bottomY + 1, hit.z, this.ctx.view);
    this.ctx.particles.spawnBlock(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, B.DOOR_BOTTOM, 12);
    this.ctx.sfx.play(this.actionSoundName('break', 'break_wood'), { volume: BREAK_VOLUME });
    if (!c.creative) this.drops.spawn('door', 1, hit.x + 0.5, hit.y + 0.4, hit.z + 0.5, true);
    this.ctx.game.onBlockBroken && this.ctx.game.onBlockBroken(id, hit);
    m_reset(this.mining);
    this.ctx.view.setBreakProgress(null, 0);
  }

  /* T6 门：一次放两格；朝向由视线决定，meta 低 2 位保存 */
  placeDoor(hit) {
    const w = this.ctx.world, c = this.ctx.controller, inv = this.ctx.inventory;
    const place = w.placementTarget(hit);
    if (!place || place.y + 1 >= WORLD_H) return false;
    if (!isReplaceable(w.getBlock(place.x, place.y, place.z))) return false;
    if (!isReplaceable(w.getBlock(place.x, place.y + 1, place.z))) return false;
    if (!w.isSolidAt(place.x, place.y - 1, place.z)) return false;
    const d = c.lookDir();
    const facing = Math.abs(d.x) > Math.abs(d.z) ? (d.x > 0 ? 2 : 3) : (d.z > 0 ? 0 : 1);
    w.setBlock(place.x, place.y, place.z, B.DOOR_BOTTOM, facing);
    w.setBlock(place.x, place.y + 1, place.z, B.DOOR_TOP, facing);
    w.refreshImmediate(place.x, place.y, place.z, this.ctx.view);
    w.refreshImmediate(place.x, place.y + 1, place.z, this.ctx.view);
    if (!c.creative) inv.consumeHeld(1);
    this.ctx.sfx.play(this.actionSoundName('place', 'place_wood'), { volume: PLACE_VOLUME });
    this.ctx.heldSwing && this.ctx.heldSwing(1, 'use');
    this.placeCd = 0.3;
    this.ctx.game.onBlockPlaced && this.ctx.game.onBlockPlaced(B.DOOR_BOTTOM, place);
    return true;
  }

  /* ---------- 放置 / 使用 ---------- */
  tryPlace() {
    const w = this.ctx.world, inv = this.ctx.inventory, c = this.ctx.controller;
    const hit = this.target;
    if (!hit) return false;
    const id = w.getBlock(hit.x, hit.y, hit.z);
    const held = inv.held();
    const heldDef = held ? getItem(held.item) : null;

    // T5：打火石右键 TNT 点燃（先于放置/其他交互；只认 TNT 方块）
    if (id === B.TNT && heldDef && heldDef.ignites) {
      const lit = this.ctx.game.igniteTnt && this.ctx.game.igniteTnt(hit.x, hit.y, hit.z);
      this.placeCd = lit ? 0.5 : 0.3;
      if (lit) {
        this.ctx.heldSwing && this.ctx.heldSwing(1, 'use');
        if (!c.creative) inv.damageHeldTool(1);   // toolBreak 事件由 Game 统一提示
      } else if (this.ctx.game.ui && this.ctx.game.ui.toast) {
        this.ctx.game.ui.toast('这格 TNT 已经在燃烧了');
      }
      return true;
    }

    // 先处理可交互方块
    if (isDoorBlock(id)) {
      const res = this.ctx.game.toggleDoor ? this.ctx.game.toggleDoor(hit) : null;
      this.placeCd = 0.35;
      if (!res && this.ctx.game.ui && this.ctx.game.ui.toast) this.ctx.game.ui.toast('这扇门不完整');
      return true;
    }
    if (id === B.CRAFTING_TABLE) { this.ctx.game.openCrafting(3); this.placeCd = 0.35; this.ctx.sfx.play('open_ui'); return true; }
    if (id === B.FURNACE || id === B.FURNACE_LIT) { this.ctx.game.openFurnace(hit); this.placeCd = 0.35; this.ctx.sfx.play('open_ui'); return true; }
    if (id === B.CHEST) { this.ctx.game.openChest(hit); this.placeCd = 0.35; this.ctx.sfx.play('open_ui'); return true; }
    if (id === B.BED) { this.ctx.game.trySleep(hit); this.placeCd = 0.5; return true; }   // T2 睡觉
    if (heldDef && heldDef.doorItem) return this.placeDoor(hit);

    if (!held) return false;
    // 树苗：只能种在泥土/草地上，并登记生长
    if (heldDef && heldDef.saplingMeta !== undefined) {
      this.ctx.game.useNonBlockItem(held, hit);
      this.placeCd = 0.25;
      return false;
    }
    const blockId = itemToBlockId(held.item);
    if (blockId && blockId !== 0) {
      const place = w.placementTarget(hit);
      if (place && isPlant(blockId) && !w.isSolidAt(place.x, place.y - 1, place.z)) return false;
    }
    if (!blockId && blockId !== 0) {
      // 非方块物品：种子/食物/锄头等由各自动作处理。加冷却，避免按住右键时每帧触发一次
      const used = this.ctx.game.useNonBlockItem ? this.ctx.game.useNonBlockItem(held, hit) : false;
      this.placeCd = used ? 0.28 : 0.18;
      return false;
    }
    const place = w.placementTarget(hit);
    if (!place) return false;
    if (!w.canPlaceAt(place.x, place.y, place.z, blockId)) return false;
    // 不允许放进玩家身体
    if (playerOverlapsBlock(c, place)) return false;

    let meta = 0;
    if (hasFacing(blockId)) {
      const d = c.lookDir();
      meta = Math.abs(d.x) > Math.abs(d.z) ? (d.x > 0 ? 2 : 3) : (d.z > 0 ? 0 : 1);
    }
    /* 第二轮 C1：楼梯存朝向（0:+z 1:-z 2:+x 3:-x，与上面同一套）；
       半砖用「点天花板/上半格」放成上半砖（meta bit 3），其余情况是下半砖。 */
    const placedDef = BLOCKS[blockId];
    if (placedDef && placedDef.shape === 'stairs') {
      const d = c.lookDir();
      meta = Math.abs(d.x) > Math.abs(d.z) ? (d.x > 0 ? 2 : 3) : (d.z > 0 ? 0 : 1);
    } else if (placedDef && placedDef.shape === 'slab') {
      meta = (hit && hit.face && hit.face[1] === -1) ? 8 : 0;
    }
    w.setBlock(place.x, place.y, place.z, blockId, meta);
    w.refreshImmediate(place.x, place.y, place.z, this.ctx.view);
    if (!c.creative) inv.consumeHeld(1);
    /* 本轮 E1：放置的接触声也按材质取三条录音之一，并且和敲击同一档力度。
       失败放置在上面几个 return 之前就离开了，不会响成功声。 */
    this.ctx.sfx.play(this.actionSoundName('place', placeSoundName(blockId)), { volume: PLACE_VOLUME });
    this.ctx.heldSwing && this.ctx.heldSwing(1, 'use');
    this.placeCd = 0.22;
    this.ctx.game.onBlockPlaced && this.ctx.game.onBlockPlaced(blockId, place);
    return true;
  }

  /* 中键取方块（创造模式拾色） */
  pickBlock() {
    if (!this.target) return;
    const id = this.ctx.world.getBlock(this.target.x, this.target.y, this.target.z);
    if (!this.ctx.controller.creative) return;
    this.ctx.game.pickBlockForCreative(id);
  }

  movementSoundName(blockId, action = 'step') {
    const base = (STEP_SOUND[blockId] || 'step_stone').replace('step_', action + '_');
    const previous = this.movementVariants[base];
    let variant = Math.floor(Math.random() * (previous === undefined ? 4 : 3));
    if (previous !== undefined && variant >= previous) variant++;
    this.movementVariants[base] = variant;
    return base + ['', '_b', '_c', '_d'][variant];
  }

  stepSoundName(blockId) { return this.movementSoundName(blockId); }
}

function m_reset(m) { m.hit = null; m.progress = 0; m.digTimer = 0; }

function playerOverlapsBlock(c, b) {
  const hw = c.dims.w / 2;
  const px0 = c.pos.x - hw, px1 = c.pos.x + hw;
  const pz0 = c.pos.z - hw, pz1 = c.pos.z + hw;
  const py0 = c.pos.y, py1 = c.pos.y + c.dims.h;
  return px1 > b.x && px0 < b.x + 1 && pz1 > b.z && pz0 < b.z + 1 && py1 > b.y && py0 < b.y + 1;
}

/* ================= 掉落物 ================= */
export class DropManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.list = [];
    this.factory = null;
  }

  init(scene) { this.factory = new DropMeshFactory(scene); this.scene = scene; }

  spawn(item, count = 1, x, y, z, throwUp = false) {
    if (!getItem(item)) return null;
    const d = {
      item, count, x, y, z,
      vx: (Math.random() - 0.5) * 1.2, vy: throwUp ? 2.4 + Math.random() * 0.8 : 1.2, vz: (Math.random() - 0.5) * 1.2,
      age: 0, pickDelay: 0.35, mesh: this.factory ? this.factory.create(item) : null,
      spin: Math.random() * Math.PI * 2, scale: count > 32 ? 1.35 : count > 8 ? 1.15 : 1
    };
    this.list.push(d);
    return d;
  }

  update(dt) {
    const c = this.ctx.controller, inv = this.ctx.inventory, w = this.ctx.world;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      d.age += dt;
      d.pickDelay -= dt;
      // 重力与碰撞
      d.vy -= 22 * dt;
      const nx = d.x + d.vx * dt, ny = d.y + d.vy * dt, nz = d.z + d.vz * dt;
      if (w.isSolidAt(Math.floor(d.x), Math.floor(ny), Math.floor(d.z))) {
        if (d.vy < 0) { d.y = Math.floor(d.y) + 1.0001; d.vy = 0; d.vx *= 0.6; d.vz *= 0.6; }
        else { d.vy = 0; }
      } else d.y = ny;
      if (!w.isSolidAt(Math.floor(nx), Math.floor(d.y), Math.floor(d.z))) d.x = nx; else d.vx = 0;
      if (!w.isSolidAt(Math.floor(d.x), Math.floor(d.y), Math.floor(nz))) d.z = nz; else d.vz = 0;

      // 吸附与拾取
      const dx = c.pos.x - d.x, dy = (c.pos.y + 0.9) - d.y, dz = c.pos.z - d.z;
      const dist = Math.hypot(dx, dy, dz);
      if (d.pickDelay <= 0 && dist < 2.4) {
        const pull = 8 * dt / Math.max(0.4, dist);
        d.vx += dx * pull * 4; d.vy += dy * pull * 3; d.vz += dz * pull * 4;
        if (dist < 0.9) {
          const left = inv.add(d.item, d.count);
          const taken = d.count - left;
          if (taken > 0) { this.ctx.sfx.play('pickup', { volume: 0.5 }); this.ctx.game.onPickup && this.ctx.game.onPickup(d.item, taken); }
          if (left <= 0) { this._remove(i); continue; }
          d.count = left;
        }
      }
      if (d.age > 300) { this._remove(i); continue; }

      if (d.mesh) {
        d.spin += dt * 1.4;
        d.mesh.position.set(d.x, d.y + 0.16 + Math.sin(d.age * 2.2) * 0.05, d.z);
        d.mesh.rotation.y = d.spin;
        d.mesh.scale.setScalar((d.mesh.geometry.type === 'BoxGeometry' ? 1 : 0.9) * d.scale * (d.mesh.userData.baseScale || 0.26 / 0.26));
        if (!d.mesh.userData.baseScale) { d.mesh.userData.baseScale = d.mesh.scale.x; }
      }
    }
  }

  _remove(i) {
    const d = this.list[i];
    if (d.mesh && this.factory) this.factory.destroy(d.mesh);
    this.list.splice(i, 1);
  }

  clear() { while (this.list.length) this._remove(this.list.length - 1); }
}
