'use strict';
/*
 * 合成台与熔炉的纯逻辑（不依赖 DOM，可在 Node 里单测）。
 */
import { findRecipe, smeltResult, isFuel, RECIPES, expandIngredient, allocateForCraft } from '../core/recipes.js';
import { getItem, maxStack } from '../core/items.js';

export const SMELT_BASE_SECONDS = 8;     // 每件物品的熔炼时间
export const FUEL_SECONDS_PER_ITEM = 8;   // 燃料值 1 = 可熔炼 1 件

/* ================= 合成网格 ================= */
export class CraftingGrid {
  constructor(size = 2) {
    this.size = size;
    this.slots = new Array(size * size).fill(null);  // {item,count}
  }

  grid() {
    const g = [];
    for (let y = 0; y < this.size; y++) {
      const row = [];
      for (let x = 0; x < this.size; x++) {
        const s = this.slots[y * this.size + x];
        row.push(s ? s.item : null);
      }
      g.push(row);
    }
    return g;
  }

  set(index, stack) {
    if (stack && stack.count > 0 && getItem(stack.item)) this.slots[index] = stack;
    else this.slots[index] = null;
  }

  get(index) { return this.slots[index] || null; }

  result() {
    const r = findRecipe(this.grid());
    return r ? { item: r.result.item, count: r.result.count, recipeId: r.id } : null;
  }

  /* 一次合成消耗每个非空格子 1 个 */
  craftTimes() {
    if (!this.result()) return 0;
    let t = Infinity;
    for (const s of this.slots) if (s) t = Math.min(t, s.count);
    return Number.isFinite(t) ? t : 0;
  }

  /* 执行 n 次合成：扣除网格材料，返回产物数组（可能因格子限制而不完整） */
  craft(n = 1) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const r = this.result();
      if (!r) break;
      if (this.craftTimes() < 1) break;
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (!s) continue;
        s.count -= 1;
        if (s.count <= 0) this.slots[i] = null;
      }
      out.push({ item: r.item, count: r.count });
    }
    return out;
  }

  /* 关闭界面时退回材料 */
  drain(inventory) {
    const leftover = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      const rest = inventory.addStack(s);
      if (rest) leftover.push(rest);
      this.slots[i] = null;
    }
    return leftover;
  }

  /* 从背包一键填充当前配方（配方书点击） */
  fillFrom(recipeId, inventory) {
    const rec = findRecipeId(recipeId);
    if (!rec) return false;
    /* 本轮 A3：**先判尺寸，再动材料**。
       旧写法把 3×3 配方塞进 2×2 网格：placePattern 只摆得下左上角几格，
       摆出来的图案恰好又能匹配到另一条配方（木镐 → 木锄），于是「请求木镐」被当成成功。
       现在：形状配方放不进当前网格就直接拒绝，一个材料都不取；摆完还要核对
       结果真的是这一条配方，否则整笔回滚。 */
    if (!recipeFitsGrid(rec, this.size)) return false;
    /* 本轮 A3：网格里已有的材料先退回背包，再重新摆。
       旧写法 `this.clear()` 直接丢格子内容 —— 配方书连点两次，第一次摆进去的那份材料就没了
       （探针「反复点工作台 5 次」第一次跑出来就是这个形状）。 */
    if (inventory) {
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (!s) continue;
        inventory.add(s.item, s.count);
        this.slots[i] = null;
      }
    } else this.clear();
    /* 阶段 7：把背包传进去，标签配方的一键填充才能按玩家实际有的板子选材料
       （只有桦木板时也能一键摆出工作台 / 木棍 / 盾）。 */
    const need = collectNeeds(rec, inventory);
    if (!need) return false;
    const taken = [];
    for (const [item, count] of Object.entries(need)) {
      const got = inventory.takeForCraft(item, count);
      if (got < count) { // 还回去
        for (const t of taken) inventory.add(t.item, t.count);
        this.clear();
        return false;
      }
      taken.push({ item, count: got });
    }
    // 摆放
    let spare = [];
    if (rec.type === 'shapeless') {
      let i = 0;
      for (const t of taken) {
        let placed = 0;
        for (let k = 0; k < t.count && i < this.slots.length; k++, i++, placed++) {
          this.slots[i] = { item: t.item, count: 1 };
        }
        if (placed < t.count) spare.push({ item: t.item, count: t.count - placed });
      }
    } else {
      spare = placePattern(this, rec, taken);
    }
    for (const s of spare) if (s.count > 0) inventory.add(s.item, s.count);
    /* 本轮 A3：摆完必须核对**这就是请求的那条配方**。
       形状配方在摆不下的网格里会截断成另一条配方（木镐的 iii/ s / s 截成 ii/ s = 木锄），
       旧写法只看 result() 非空，于是把「另一个产物」当成功返回。
       现在 id 与产物都要对上，否则整笔回滚（材料原样退回背包，网格清空）。 */
    const made = this.result();
    if (!made || made.recipeId !== rec.id || made.item !== rec.result.item) {
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (!s) continue;
        inventory.add(s.item, s.count);
        this.slots[i] = null;
      }
      return false;
    }
    return true;
  }

  clear() { this.slots.fill(null); }

  serialize() { return this.slots.map(s => s ? { i: s.item, c: s.count } : null); }
  deserialize(arr) {
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < this.slots.length; i++) {
      const s = arr[i];
      this.slots[i] = s && getItem(s.i) ? { item: s.i, count: Math.max(1, s.c | 0) } : null;
    }
  }
}

function findRecipeId(id) {
  return RECIPES.find(r => r.id === id) || null;
}

/**
 * 配方能不能放进当前合成网格（本轮 A3）。
 * 形状配方要求行数与最宽一行都不超过网格边长；无序配方要求格子数够。
 * 判据在 `fillFrom` 取料**之前**使用，所以「放不下」不会先扣料再回滚。
 */
export function recipeFitsGrid(rec, size) {
  const n = Number(size) || 2;
  if (!rec) return false;
  if (rec.type === 'shapeless') return (rec.inputs || []).length <= n * n;
  const rows = rec.pattern || [];
  if (rows.length > n) return false;
  const w = Math.max(...rows.map(r => r.length));
  return w <= n;
}

function collectNeeds(rec, inventory) {
  /* 阶段 7 / 本轮 A4：标签材料按格分配（与 UI 配方书共用 recipes.js 的 allocateForCraft）。
     旧写法只按「某个候选还剩 ≥1 个」挑一次，然后把整个字符的数量都记在它头上：
       · 2 橡木板 + 2 桦木板 一键做工作台 → 只认橡木板要 4 个 → 失败；
       · 1 橡木板 + 3 桦木板 → 只认橡木板要 4 个 → 失败。
     现在每填一格记一次账，余额 = countOf - 已分配，用完就顺位到下一个候选；
     所有候选都不够时返回 null，调用方在 take 之前返回 false，不会吞物品。
     没有 inventory（老调用）保持「取第一个候选」的旧行为。 */
  if (!inventory || typeof inventory.countOf !== 'function') {
    const need = Object.create(null);
    const cells = rec.type === 'shapeless'
      ? rec.inputs.map(inp => inp)
      : rec.pattern.map(r => r.padEnd(Math.max(...rec.pattern.map(x => x.length)), ' '))
        .join('').split('').filter(ch => ch !== ' ').map(ch => rec.key[ch]);
    for (const inp of cells) {
      const list = expandOne(inp);
      if (!list || !list.length) return null;
      need[list[0]] = (need[list[0]] || 0) + 1;
    }
    return need;
  }
  const alloc = allocateForCraft(rec, (id) => inventory.countOf(id));
  if (!alloc.ok) return null;
  const need = Object.create(null);
  for (const [id, n] of Object.entries(alloc.need)) need[id] = n;
  return need;
}

function expandOne(input) {
  if (!input) return null;
  /* 阶段 7：走与配方匹配 / 配方书展示同一套标签展开，不再只认字面字符串。 */
  if (typeof input === 'string') return expandIngredient(input) || [input];
  if (Array.isArray(input)) return expandIngredient(input) || input;
  return null;
}

function placePattern(grid, rec, taken) {
  const src = rec.pattern.map(r => r.padEnd(Math.max(...rec.pattern.map(x => x.length)), ' '));
  const pool = Object.create(null);
  for (const t of taken) pool[t.item] = t.count;
  for (let y = 0; y < src.length && y < grid.size; y++) {
    for (let x = 0; x < src[y].length && x < grid.size; x++) {
      const ch = src[y][x];
      if (ch === ' ') continue;
      const list = expandOne(rec.key[ch]);
      if (!list) continue;
      const item = list.find(i => (pool[i] || 0) > 0);
      if (!item) continue;
      pool[item]--;
      grid.slots[y * grid.size + x] = { item, count: 1 };
    }
  }
  /* 本轮 A4：网格装不下的那份材料必须能退回背包。
     旧实现直接把 pool 丢掉 —— 2×2 网格点 3×3 配方时会凭空少材料。 */
  return Object.entries(pool).filter(([, n]) => n > 0).map(([item, count]) => ({ item, count }));
}

/* ================= 熔炉 ================= */
export class Furnace {
  constructor(coords) {
    this.x = coords ? coords.x : 0;
    this.y = coords ? coords.y : 0;
    this.z = coords ? coords.z : 0;
    this.input = null;
    this.fuel = null;
    this.output = null;
    this.burnTime = 0;      // 剩余燃烧秒
    this.burnTotal = 0;
    this.progress = 0;
    this.recipeTime = SMELT_BASE_SECONDS;
    this.lit = false;
  }

  get isBurning() { return this.burnTime > 0; }

  currentResult() {
    if (!this.input) return null;
    const r = smeltResult(this.input.item);
    if (!r) return null;
    return { item: r.output, time: (r.time || SMELT_BASE_SECONDS) };
  }

  canSmelt() {
    const res = this.currentResult();
    if (!res) return false;
    if (!this.output) return true;
    if (this.output.item !== res.item) return false;
    return this.output.count < maxStack(res.item);
  }

  /* 返回事件用于音效/方块状态更新 */
  tick(dt) {
    const ev = { litChanged: false, smelted: null, wasLit: this.lit };
    const res = this.currentResult();
    if (this.burnTime > 0) this.burnTime = Math.max(0, this.burnTime - dt);
    if (this.burnTime <= 0 && res && this.canSmelt() && this.fuel) {
      const f = fuelSeconds(this.fuel.item);
      if (f > 0) {
        this.fuel.count -= 1;
        if (this.fuel.count <= 0) this.fuel = null;
        this.burnTotal = f;
        this.burnTime = f;
      }
    }
    if (this.canSmelt() && this.burnTime > 0) {
      this.progress += dt;
      if (this.progress >= (res ? res.time : SMELT_BASE_SECONDS)) {
        this.progress = 0;
        const out = res.item;
        if (!this.output) this.output = { item: out, count: 1 };
        else this.output.count += 1;
        this.input.count -= 1;
        if (this.input.count <= 0) this.input = null;
        ev.smelted = out;
      }
    } else if (this.progress > 0 && this.burnTime <= 0) {
      this.progress = Math.max(0, this.progress - dt * 2);
    }
    this.lit = this.burnTime > 0;
    if (this.lit !== ev.wasLit) ev.litChanged = true;
    return ev;
  }

  /* UI 取放：slot ∈ 'input'|'fuel'|'output' */
  clickSlot(slot, rightButton, inventory) {
    const cur = this[slot];
    if (!inventory.cursor && cur) {
      inventory.cursor = cur; this[slot] = null;
    } else if (inventory.cursor && !cur) {
      const it = getItem(inventory.cursor.item);
      if (slot === 'input') {
        if (!smeltResult(inventory.cursor.item)) return;
        this[slot] = takeSplit(inventory, 1);
      } else if (slot === 'fuel') {
        if (!isFuel(inventory.cursor.item)) return;
        this[slot] = takeSplit(inventory, 1);
      } else {
        return;   // 产物只能取出不能放入
      }
    } else if (inventory.cursor && cur) {
      if (slot === 'output') {
        if (cur.item === inventory.cursor.item && !cur.dur) {
          const max = maxStack(cur.item);
          const can = Math.min(max, cur.count + inventory.cursor.count);
          const rest = cur.count + inventory.cursor.count - can;
          cur.count = can;
          inventory.cursor.count = rest;
          if (!inventory.cursor.count) inventory.cursor = null;
        }
        return;
      }
      if (cur.item === inventory.cursor.item && !cur.dur && !inventory.cursor.dur) {
        const max = maxStack(cur.item);
        const can = Math.min(max, cur.count + inventory.cursor.count);
        const rest = cur.count + inventory.cursor.count - can;
        cur.count = can;
        if (rest) inventory.cursor.count = rest; else inventory.cursor = null;
      } else {
        if (slot === 'input' && !smeltResult(inventory.cursor.item)) return;
        if (slot === 'fuel' && !isFuel(inventory.cursor.item)) return;
        this[slot] = inventory.cursor;
        inventory.cursor = cur;
      }
    } else if (inventory.cursor) {
      inventory.cursor = null;
    }
  }

  drain(inventory) {
    for (const k of ['input', 'fuel', 'output']) {
      if (this[k]) {
        const rest = inventory.addStack(this[k]);
        if (rest) return rest;      // 背包满：保留在熔炉里
        this[k] = null;
      }
    }
    return null;
  }

  serialize() {
    const pack = (s) => s ? { i: s.item, c: s.count } : null;
    return {
      input: pack(this.input), fuel: pack(this.fuel), output: pack(this.output),
      burnTime: round2(this.burnTime), burnTotal: round2(this.burnTotal),
      progress: round2(this.progress)
    };
  }

  deserialize(o) {
    if (!o) return;
    const unpack = (s) => (s && getItem(s.i)) ? { item: s.i, count: Math.max(1, s.c | 0) } : null;
    this.input = unpack(o.input); this.fuel = unpack(o.fuel); this.output = unpack(o.output);
    this.burnTime = 0; this.burnTotal = 0;      // 读档后不保留明火（与 MC 行为一致）
    this.progress = Math.min(o.progress || 0, SMELT_BASE_SECONDS);
    this.lit = false;
  }
}

function takeSplit(inventory, n) {
  const c = inventory.cursor;
  const take = Math.min(n, c.count);
  const out = { item: c.item, count: take };
  c.count -= take;
  if (c.count <= 0) inventory.cursor = null;
  return out;
}

export function fuelSeconds(itemId) {
  const it = getItem(itemId);
  if (!it || !it.fuel) return 0;
  return it.fuel * FUEL_SECONDS_PER_ITEM;
}

function round2(v) { return Math.round(v * 100) / 100; }
