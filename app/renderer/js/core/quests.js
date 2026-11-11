'use strict';
/*
 * Q1：目标链与反馈（纯逻辑，不碰 DOM / THREE / 存档）。
 *
 * 设计边界（本轮刻意不做的事，改之前请先读）：
 *   - 这是**独立于成就**的一套状态。ACHIEVEMENTS 的 8 条 / count() / list() / ids 与
 *     「无前置、拿到物品即解锁」的语义一个字都不改；成就继续由 achievements.js 自己负责。
 *   - 目标链只是「当前该做什么」的线性进度，没有奖励、没有经验、没有排行榜，
 *     也不解锁或屏蔽任何配方 —— 配方数值、材料、产物一律沿用 recipes.js。
 *   - 提示是否弹过由 shown 集合决定，同一目标只提示一次；读档用 silent 推断，
 *     绝不把「你已完成 X」重新弹一遍。
 *   - 存档只新增一个 quests 字段；旧档缺字段时由 deserialize + silent sync 推断，
 *     不改写其它任何字段的语义。
 *
 * 为什么线性补全：玩家把工作台放到地上、木镐丢进箱子后，背包里就没有这些物品了。
 * 若只看「当前背包有什么」，进度会倒退。链上任意一步被证实达成，即认为它之前的步骤
 * 都已经走过（这是进度链，不是物品清单），这也是旧档能推断出正确进度的关键。
 */

export const QUESTS = Object.freeze([
  Object.freeze({
    id: 'log', order: 1, name: '砍树',
    /* 阶段 7：两种原木各有各的配方（输入互斥），提示要把这件事说清楚，
       否则只砍到白桦的玩家照着「原木 → 木板」去做会一直合不出来。
       recipeId 仍钉 log_to_planks —— 主线第一步与旧档进度不变，配方书里另有桦木板配方。 */
    hint: '对着树干按住左键拿原木：橡木做木板，白桦做桦木板；两种板都能接着做工作台',
    items: Object.freeze(['oak_log', 'birch_log']), achievements: Object.freeze(['wood']),
    recipeId: 'log_to_planks'
  }),
  Object.freeze({
    id: 'table', order: 2, name: '做出工作台',
    hint: '按 E 打开背包，用 4 块木板合成工作台',
    items: Object.freeze(['crafting_table']), achievements: Object.freeze(['crafting_table']),
    recipeId: 'crafting_table'
  }),
  Object.freeze({
    id: 'wood_pick', order: 3, name: '做出木镐',
    hint: '放下工作台并右键打开 3×3，用 3 木板 + 2 木棍做木镐',
    items: Object.freeze(['pickaxe_wood', 'pickaxe_stone', 'pickaxe_iron', 'pickaxe_diamond']),
    achievements: Object.freeze([]),
    recipeId: 'pickaxe_wood'
  }),
  Object.freeze({
    id: 'cobble', order: 4, name: '挖到圆石',
    hint: '拿木镐去挖石头，拿回圆石',
    items: Object.freeze(['cobblestone']), achievements: Object.freeze(['cobblestone']),
    recipeId: null
  }),
  Object.freeze({
    id: 'furnace', order: 5, name: '做出熔炉',
    hint: '用 8 块圆石围成一圈合成熔炉',
    items: Object.freeze(['furnace']), achievements: Object.freeze(['furnace']),
    recipeId: 'furnace'
  }),
  Object.freeze({
    id: 'iron', order: 6, name: '烧出铁锭',
    hint: '挖铁矿放进熔炉，加煤或木板当燃料',
    items: Object.freeze(['iron_ingot']), achievements: Object.freeze(['iron_ingot']),
    recipeId: null
  })
]);

export const QUEST_IDS = Object.freeze(QUESTS.map(q => q.id));
export const QUEST_BY_ID = Object.freeze(Object.fromEntries(QUESTS.map(q => [q.id, q])));

/** 主线配方按进度先后排列，用于「下一步建议」的排序权重 */
const MAIN_RECIPE_IDS = Object.freeze(QUESTS.map(q => q.recipeId).filter(Boolean));

/**
 * 快照：{ items: {itemId: count}, achievementIds: string[] }
 * 只读取现状，不改任何东西；由 game.questSnapshot() 提供。
 */
function questDone(snapshot, q) {
  const items = snapshot && snapshot.items ? snapshot.items : {};
  const ach = new Set(snapshot && Array.isArray(snapshot.achievementIds) ? snapshot.achievementIds : []);
  return q.items.some(id => (items[id] || 0) > 0) || q.achievements.some(id => ach.has(id));
}

/**
 * 配方书的「下一步建议」排序（纯函数，便于单测）。
 * - 当前目标对应的配方永远排第一（它就是「下一步」）；
 * - 其余按「可做性 → 主线进度顺序 → 配方表原顺序」排；
 * - 不修改传入数组，不自动合成、不改配方数值。
 * @param {Array} recipes RECIPES
 * @param {(r:object)=>boolean} canMake 当前材料是否够
 * @param {string|null} currentQuestId 当前目标 id
 * @param {number} limit 最多几条
 * @returns {Array<{recipe:object, reason:string, canMake:boolean}>}
 */
export function suggestRecipes(recipes, canMake, currentQuestId, limit = 3) {
  const list = Array.isArray(recipes) ? recipes : [];
  const make = typeof canMake === 'function' ? canMake : () => false;
  const cur = currentQuestId ? QUEST_BY_ID[currentQuestId] : null;
  const targetId = cur ? cur.recipeId : null;
  const scored = list.map((r, i) => {
    const doable = !!make(r);
    let score = 0;
    if (targetId && r.id === targetId) score += 1000;   // 当前目标永远是「下一步」
    if (doable) score += 600;                           // 其次按可做性
    const mi = MAIN_RECIPE_IDS.indexOf(r.id);
    if (mi >= 0) score += 500 - mi * 10;                // 同档内按主线进度先后
    return { recipe: r, canMake: doable, score, index: i };
  });
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  const n = Math.max(0, Math.min(limit | 0 || 3, scored.length));
  return scored.slice(0, n).map(s => ({
    recipe: s.recipe,
    canMake: s.canMake,
    reason: targetId && s.recipe.id === targetId ? 'current'
      : s.canMake ? 'available' : 'prepare'
  }));
}

export class QuestChain {
  /** @param {object|null} saved 存档里的 quests 字段；缺字段 / 坏数据一律安全回落 */
  constructor(saved) {
    this.completed = new Set();
    this.shown = new Set();       // 已经展示过提示的目标 id（保证同一提示只出现一次）
    this.hintLog = [];            // 展示记录，供 e2e 断言「只出现一次」
    this.dismissed = false;
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.completed)) {
        for (const id of saved.completed) if (QUEST_BY_ID[id]) this.completed.add(id);
      }
      if (Array.isArray(saved.shown)) {
        for (const id of saved.shown) if (QUEST_BY_ID[id]) this.shown.add(id);
      }
      if (Array.isArray(saved.hintLog)) {
        this.hintLog = saved.hintLog.filter(id => QUEST_BY_ID[id]).slice(-32);
      }
      this.dismissed = !!saved.dismissed;
    }
  }

  /** 第一个未完成目标；全部完成返回 null */
  get current() {
    for (const q of QUESTS) if (!this.completed.has(q.id)) return q;
    return null;
  }

  get index() {
    const c = this.current;
    return c ? c.order : QUESTS.length;
  }

  /**
   * 按快照推进进度。
   * @param {object} snapshot {items, achievementIds}
   * @param {boolean} silent 读档/旧档推断：只推进状态，不返回任何提示，并把已完成步骤与
   *                        当前目标都记为「已展示」，绝不弹「你已完成 X」。
   * @returns {{completedNow:string[], hint:object|null, current:string|null}}
   */
  sync(snapshot, silent = false) {
    let maxIdx = -1;
    for (let i = 0; i < QUESTS.length; i++) {
      if (questDone(snapshot, QUESTS[i])) maxIdx = i;
    }
    const completedNow = [];
    /* 线性链：第 i 步被证实达成 → 0..i 全部完成（进度只前进，不回退） */
    for (let i = 0; i <= maxIdx; i++) {
      const q = QUESTS[i];
      if (!this.completed.has(q.id)) { this.completed.add(q.id); completedNow.push(q.id); }
    }
    const cur = this.current;
    let hint = null;
    if (silent) {
      for (const id of completedNow) this.shown.add(id);
      if (cur) this.shown.add(cur.id);
    } else if (cur && !this.shown.has(cur.id)) {
      this.shown.add(cur.id);
      this.hintLog.push(cur.id);
      if (this.hintLog.length > 32) this.hintLog.shift();
      hint = cur;
    }
    return { completedNow, hint, current: cur ? cur.id : null };
  }

  dismiss() { this.dismissed = true; }
  reopen() { this.dismissed = false; }

  serialize() {
    return {
      completed: [...this.completed],
      shown: [...this.shown],
      hintLog: this.hintLog.slice(-32),
      dismissed: this.dismissed
    };
  }

  info() {
    const cur = this.current;
    return {
      current: cur ? cur.id : null,
      currentName: cur ? cur.name : null,
      currentHint: cur ? cur.hint : null,
      order: cur ? cur.order : QUESTS.length,
      total: QUESTS.length,
      completed: [...this.completed],
      shown: [...this.shown],
      hintLog: this.hintLog.slice(),
      dismissed: this.dismissed
    };
  }

  static deserialize(data) { return new QuestChain(data); }
}
