'use strict';
/*
 * 背包/物品栏：36 格（0~8 为快捷栏）+ 鼠标持握格。
 * 提供堆叠、拆分、交换、增删、序列化，所有变更通过 change 事件通知界面刷新。
 */
import { getItem, maxStack, blockToItem } from '../core/items.js';
import { BLOCKS } from '../core/blocks.js';

export const HOTBAR_SIZE = 9;
export const INV_SIZE = 36;

export class Inventory {
  constructor(size = INV_SIZE) {
    this.size = size;
    this.slots = new Array(size).fill(null);
    /* T1 装备格：0 头盔 / 1 胸甲 / 2 护腿 / 3 靴子。
       与 36 格背包分开存放，旧存档没有这个字段时保持四个空位。 */
    this.armor = new Array(4).fill(null);
    this.selected = 0;
    this.cursor = null;         // 拖拽时持握的堆叠
    this._ev = Object.create(null);
    this.infinite = false;      // 创造模式：取出永远是满堆
  }

  on(evt, fn) { (this._ev[evt] = this._ev[evt] || []).push(fn); }
  off(evt, fn) {
    const l = this._ev[evt];
    if (l) this._ev[evt] = l.filter(f => f !== fn);
  }
  emit(kind, a, b) {
    const fire = (name) => { const l = this._ev[name]; if (l) for (const f of l) f(a, b, kind); };
    fire(kind);
    if (kind !== 'select') fire('change');   // 任何变更都刷新界面
  }
  onChange(fn) { this.on('change', fn); }

  get(i) { return this.slots[i] || null; }
  set(i, stack) {
    if (stack && (stack.count <= 0 || !getItem(stack.item))) stack = null;
    this.slots[i] = stack || null;
  }

  /* 当前手持物品（快捷栏选中格） */
  held() {
    if (this.infinite) {
      const s = this.slots[this.selected];
      return s ? { item: s.item, count: 64, dur: s.dur } : null;
    }
    return this.slots[this.selected] || null;
  }

  heldItem() { const h = this.held(); return h ? h.item : null; }
  heldDur() { const h = this.held(); return h && h.dur !== undefined ? h.dur : null; }

  heldBlockId() {
    const h = this.held();
    if (!h) return null;
    const it = getItem(h.item);
    return it && it.blockId !== undefined && it.blockId !== null ? it.blockId : null;
  }

  /* 放入物品，返回放不下的数量 */
  add(item, count = 1, meta) {
    if (!getItem(item)) return count;
    const max = maxStack(item);
    // 1) 合并已有堆
    for (let i = 0; i < this.size && count > 0; i++) {
      const s = this.slots[i];
      if (s && s.item === item && s.count < max && !s.dur) {
        const add = Math.min(max - s.count, count);
        s.count += add; count -= add;
      }
    }
    // 2) 空格
    for (let i = 0; i < this.size && count > 0; i++) {
      if (!this.slots[i]) {
        const add = Math.min(max, count);
        const st = { item, count: add };
        const def = getItem(item);
        if (def && def.durability) st.dur = def.durability;
        if (meta) Object.assign(st, meta);
        this.slots[i] = st;
        count -= add;
      }
    }
    this.emit('add', item, count);
    return count;
  }

  /* 移除若干个物品（跨格），返回实际移除数 */
  remove(item, count = 1) {
    let removed = 0;
    for (let i = 0; i < this.size && removed < count; i++) {
      const s = this.slots[i];
      if (!s || s.item !== item) continue;
      const take = Math.min(s.count, count - removed);
      s.count -= take; removed += take;
      if (s.count <= 0) this.slots[i] = null;
    }
    if (removed) this.emit('remove', item, removed);
    return removed;
  }

  countOf(item) {
    let n = 0;
    for (const s of this.slots) if (s && s.item === item) n += s.count;
    return n;
  }

  /* 为配方填充取料：数量不足则一个都不取，避免扣料扣一半 */
  takeForCraft(item, count) {
    if (this.countOf(item) < count) return 0;
    return this.remove(item, count);
  }

  has(item, count = 1) { return this.countOf(item) >= count; }

  firstEmpty() {
    for (let i = 0; i < this.size; i++) if (!this.slots[i]) return i;
    return -1;
  }

  selectedIndex() { return this.selected; }
  select(i) {
    i = ((i % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    if (i === this.selected) return false;
    this.selected = i;
    this.emit('select', i);
    return true;
  }
  scroll(delta) { return this.select(this.selected + (delta > 0 ? 1 : -1)); }

  /* 消耗当前手持的 1 个（放置方块后） */
  consumeHeld(n = 1) {
    if (this.infinite) return true;
    const i = this.selected, s = this.slots[i];
    if (!s) return false;
    s.count -= n;
    if (s.count <= 0) this.slots[i] = null;
    this.emit('consume', i);
    return true;
  }

  /* 工具受损，破坏时返回 true 表示工具断裂 */
  damageHeldTool(amount = 1) {
    if (this.infinite) return false;
    const s = this.slots[this.selected];
    if (!s) return false;
    const it = getItem(s.item);
    if (!it || !it.durability) return false;
    s.dur = (s.dur === undefined ? it.durability : s.dur) - amount;
    if (s.dur <= 0) {
      this.slots[this.selected] = null;
      this.emit('toolBreak', s.item);
      return true;
    }
    this.emit('durability', s);
    return false;
  }

  /* ---------- 交互：左键快取 / 右键拆分 / 放置 ---------- */
  /* index 为界面槽位编号；由 UI 决定映射（背包 0..35、合成格 100.. 等） */
  clickSlot(index, rightButton) {
    const cur = index === 'cursor' ? null : this.slots[index];
    if (index === 'cursor') {
      // 点击在空白处：放下/收起整堆
      if (this.cursor) {
        const rest = this.addStack(this.cursor);
        this.cursor = rest;
      }
      this.emit('click', index);
      return;
    }
    const slot = this.slots[index];
    if (rightButton) {
      if (!this.cursor && slot) {
        // 取一半
        const half = Math.ceil(slot.count / 2);
        this.cursor = { item: slot.item, count: half, dur: slot.dur };
        slot.count -= half;
        if (slot.count <= 0) this.slots[index] = null;
      } else if (this.cursor && !slot) {
        this.slots[index] = { item: this.cursor.item, count: 1, dur: this.cursor.dur };
        this.cursor.count -= 1;
        if (this.cursor.count <= 0) this.cursor = null;
      } else if (this.cursor && slot && slot.item === this.cursor.item && !slot.dur) {
        const max = maxStack(slot.item);
        if (slot.count < max) { slot.count++; this.cursor.count--; if (this.cursor.count <= 0) this.cursor = null; }
      }
    } else {
      if (!this.cursor && slot) {
        this.cursor = slot; this.slots[index] = null;
      } else if (this.cursor && !slot) {
        this.slots[index] = this.cursor; this.cursor = null;
      } else if (this.cursor && slot) {
        if (slot.item === this.cursor.item && !slot.dur && !this.cursor.dur) {
          const max = maxStack(slot.item);
          const can = Math.min(slot.count + this.cursor.count, max);
          const rest = slot.count + this.cursor.count - can;
          slot.count = can;
          if (rest > 0) { this.cursor.count = rest; } else this.cursor = null;
        } else {
          this.slots[index] = this.cursor; this.cursor = slot;
        }
      }
    }
    this.emit('click', index);
  }

  addStack(stack) {
    if (!stack) return null;
    const left = this.add(stack.item, stack.count);
    if (left <= 0) return null;
    return { item: stack.item, count: left, dur: stack.dur };
  }

  /* ---------- T1 装备格 ---------- */
  /** 物品对应的装备槽（0~3），不是护甲返回 -1 */
  armorSlotOf(itemId) {
    const it = getItem(itemId);
    return it && it.armorSlot !== undefined && it.armorSlot !== null ? it.armorSlot : -1;
  }

  /** 把背包第 index 格穿到对应装备槽；原装备（若有）换回这一格。失败返回 false。 */
  equipFrom(index) {
    const s = this.slots[index];
    if (!s) return false;
    const slot = this.armorSlotOf(s.item);
    if (slot < 0) return false;
    const old = this.armor[slot] || null;
    this.armor[slot] = s;
    this.slots[index] = old;
    this.emit('equip', slot);
    return true;
  }

  /** 取下装备槽（放回第一个空格）；背包满时不动并返回 false */
  unequip(slot) {
    if (!(slot >= 0 && slot < this.armor.length)) return false;
    const s = this.armor[slot];
    if (!s) return false;
    const idx = this.firstEmpty();
    if (idx < 0) return false;
    this.slots[idx] = s;
    this.armor[slot] = null;
    this.emit('equip', slot);
    return true;
  }

  /** 当前四件护甲的点数合计（未知物品按 0 计） */
  armorPoints() {
    let n = 0;
    for (const s of this.armor) {
      if (!s) continue;
      const it = getItem(s.item);
      if (it && it.armorPoints) n += it.armorPoints;
    }
    return n;
  }

  hasArmor() { return this.armor.some(s => !!s); }

  /** 每次实际承受可减免伤害：已穿的每件各 -amount；耗尽的那件直接消失。
   *  返回本次损坏的装备 id 列表（供音效/成就/测试）。 */
  damageArmor(amount = 1) {
    const broken = [];
    if (this.infinite) return broken;              // 创造模式不磨损
    for (let i = 0; i < this.armor.length; i++) {
      const s = this.armor[i];
      if (!s) continue;
      const it = getItem(s.item);
      if (!it || !it.durability) continue;
      s.dur = (s.dur === undefined ? it.durability : s.dur) - amount;
      if (s.dur <= 0) {
        this.armor[i] = null;
        broken.push(s.item);
      }
    }
    if (broken.length || this.hasArmor()) this.emit('durability');
    for (const id of broken) this.emit('armorBreak', id);
    if (broken.length) this.emit('equip');
    return broken;
  }

  serializeArmor() {
    return this.armor.map(s => s ? {
      i: s.item, c: s.count,
      d: s.dur === undefined ? undefined : s.dur
    } : null);
  }

  deserializeArmor(arr) {
    this.armor = new Array(4).fill(null);
    if (!Array.isArray(arr)) return;               // 旧档：没有这个字段 → 四格空装备
    for (let i = 0; i < 4; i++) {
      const s = arr[i];
      if (!s || !getItem(s.i)) continue;
      const it = getItem(s.i);
      if (it.armorSlot !== i) continue;            // 头盔不能塞进胸甲槽
      const dur = Number.isFinite(s.d) ? Math.max(1, s.d) : it.durability;
      this.armor[i] = { item: s.i, count: 1, dur };
    }
    this.emit('equip');
  }

  /* 快捷栏与主背包之间拖拽（数字键 1~9 之外的 Q 键快速丢弃） */
  dropSelected(n = 1) {
    const s = this.slots[this.selected];
    if (!s) return null;
    const take = Math.min(n, s.count);
    const out = { item: s.item, count: take };
    s.count -= take;
    if (s.count <= 0) this.slots[this.selected] = null;
    this.emit('drop', out);
    return out;
  }

  clear() {
    this.slots.fill(null);
    this.cursor = null;
    this.emit('clear');
  }

  serialize() {
    return this.slots.map(s => s ? {
      i: s.item, c: s.count,
      d: s.dur === undefined ? undefined : s.dur
    } : null);
  }

  deserialize(arr) {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < this.size; i++) {
      const s = arr[i];
      if (!s || !getItem(s.i)) { this.slots[i] = null; continue; }
      this.slots[i] = { item: s.i, count: Math.max(1, Math.min(maxStack(s.i), s.c | 0)) };
      if (s.d !== undefined) this.slots[i].dur = s.d;
    }
    this.emit('load');
  }

  /* 生存模式开局给的少量物品（也可留空） */
  giveStartingItems(list) {
    for (const [item, count] of list) this.add(item, count);
  }
}

/* 方块 -> 可放置的方块 ID（用于右键放置） */
export function itemToBlockId(itemId) {
  const it = getItem(itemId);
  if (!it) return null;
  if (it.blockId !== undefined && it.blockId !== null) return it.blockId;
  return null;
}

export function isPlaceable(itemId) {
  const id = itemToBlockId(itemId);
  return id !== null && !!BLOCKS[id] && BLOCKS[id].placeable !== false;
}
