'use strict';
/*
 * 首批 8 个成就（纯逻辑，不碰 DOM / 存档）。
 *
 * 触发原则：
 *   - 获得类（木头/圆石/铁锭/钻石）由「背包真的多出了这个物品」触发；
 *   - 制作类（工作台/熔炉/盾牌）只由「合成产物」触发 —— 捡到别人做好的工作台不算；
 *   - 穿甲由装备格变化触发；
 *   - 同一存档只解锁一次，重复事件返回 null（调用方据此不重复弹 toast）。
 *
 * 旧档初始化 inferAchievements() 只读取现有状态做一次补记，不弹 toast、不凭空猜测。
 * 不做排行榜、奖励点数、传送门或 Boss。
 */

export const ACHIEVEMENTS = [
  { id: 'wood', name: '木头到手', desc: '获得任意原木', toast: '获得木头' },
  { id: 'crafting_table', name: '工作台', desc: '亲手合成一个工作台', toast: '制作工作台' },
  { id: 'cobblestone', name: '圆石', desc: '获得圆石', toast: '获得圆石' },
  { id: 'furnace', name: '熔炉', desc: '亲手合成一个熔炉', toast: '制作熔炉' },
  { id: 'iron_ingot', name: '铁锭', desc: '获得铁锭', toast: '获得铁锭' },
  { id: 'armor', name: '披甲', desc: '穿上任意一件护甲', toast: '穿上护甲' },
  { id: 'shield', name: '举盾', desc: '亲手合成一面盾牌', toast: '制作盾牌' },
  { id: 'diamond', name: '钻石', desc: '获得钻石', toast: '获得钻石' }
];

export const ACHIEVEMENT_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));
export const ACHIEVEMENT_IDS = ACHIEVEMENTS.map(a => a.id);

/*
 * R3：额外成就（不计入「8 个基础成就」的 list()/count()，但仍走同一套 unlock/toast/存档机制）。
 * 探索者由「玩家真实走近并发现一处荒野地点」触发，只解锁一次并随存档保存。
 * 之所以放在 ACHIEVEMENTS 之外：既有单测与 e2e 断言把基础成就固定为 8 条（成就 8/8、8 行点亮），
 * 新成就不能改旧断言，只能作为附加条目序列化。
 */
export const EXTRA_ACHIEVEMENTS = [
  { id: 'explorer', name: '探索者', desc: '第一次走近并发现一处荒野地点', toast: '发现荒野地点' }
];

export const EXTRA_ACHIEVEMENT_BY_ID = Object.fromEntries(EXTRA_ACHIEVEMENTS.map(a => [a.id, a]));
export const ALL_ACHIEVEMENT_BY_ID = Object.assign({}, ACHIEVEMENT_BY_ID, EXTRA_ACHIEVEMENT_BY_ID);

/* 物品 → 获得类成就 */
const ITEM_ACHIEVEMENTS = {
  oak_log: 'wood', birch_log: 'wood',
  cobblestone: 'cobblestone',
  iron_ingot: 'iron_ingot',
  diamond: 'diamond'
};

/* 合成产物 → 制作类成就（只认亲手制作） */
const CRAFT_ACHIEVEMENTS = {
  crafting_table: 'crafting_table',
  furnace: 'furnace',
  shield: 'shield'
};

export function itemAchievementIds(itemId) {
  const id = ITEM_ACHIEVEMENTS[itemId];
  return id ? [id] : [];
}

export function craftAchievementIds(itemId) {
  const id = CRAFT_ACHIEVEMENTS[itemId];
  return id ? [id] : [];
}

/** 旧档补记：按「当前背包/装备」推断已经达成的成就，不弹 toast */
export function inferAchievements(state = {}) {
  const items = state.items || {};
  const out = [];
  if ((items.oak_log || 0) > 0 || (items.birch_log || 0) > 0) out.push('wood');
  if (items.crafting_table > 0) out.push('crafting_table');
  if (items.cobblestone > 0) out.push('cobblestone');
  if (items.furnace > 0) out.push('furnace');
  if (items.iron_ingot > 0) out.push('iron_ingot');
  if (state.armorEquipped) out.push('armor');
  if (items.shield > 0) out.push('shield');
  if (items.diamond > 0) out.push('diamond');
  return out;
}

export class Achievements {
  constructor(ids) {
    this.set = new Set();
    if (Array.isArray(ids)) for (const id of ids) if (ALL_ACHIEVEMENT_BY_ID[id]) this.set.add(id);
  }

  has(id) { return this.set.has(id); }
  /** 基础成就（8 个）的完成数；额外成就不计入，避免改动既有「成就 8/8」读数 */
  count() { return ACHIEVEMENTS.filter(a => this.set.has(a.id)).length; }

  /** @returns {object|null} 新解锁的定义；已解锁/未知 id 返回 null */
  unlock(id) {
    const def = ALL_ACHIEVEMENT_BY_ID[id];
    if (!def || this.set.has(id)) return null;
    this.set.add(id);
    return def;
  }

  /** 按定义顺序返回 [{...def, unlocked}]，供暂停界面展示 */
  list() {
    return ACHIEVEMENTS.map(a => Object.assign({}, a, { unlocked: this.set.has(a.id) }));
  }

  /** R3：额外成就单独一条列表（不参与「成就 x/8」计数与行数断言） */
  extras() {
    return EXTRA_ACHIEVEMENTS.map(a => Object.assign({}, a, { unlocked: this.set.has(a.id), extra: true }));
  }

  extraCount() { return EXTRA_ACHIEVEMENTS.filter(a => this.set.has(a.id)).length; }

  serialize() {
    return [...ACHIEVEMENTS, ...EXTRA_ACHIEVEMENTS].filter(a => this.set.has(a.id)).map(a => a.id);
  }

  static deserialize(arr) {
    return new Achievements(Array.isArray(arr) ? arr : []);
  }

  /** 旧档：补记已有状态（返回新解锁数量） */
  absorbInferred(state) {
    let n = 0;
    for (const id of inferAchievements(state)) if (this.unlock(id)) n++;
    return n;
  }
}
