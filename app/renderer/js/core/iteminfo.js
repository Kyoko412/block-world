'use strict';
/*
 * 阶段 C：物品「用途」文案 —— 纯数据函数，不碰 DOM / THREE，可在 Node 单测里直接跑。
 *
 * 为什么单独一个文件：ui.js 需要 document 才能加载，把「这条物品该怎么解释」写成纯函数，
 * 才能被单测钉住，也才能被 tooltip、配方书、以后的任务提示复用。
 *
 * 铁律：所有内容一律从 items.js / blocks.js / recipes.js 的**已有字段**推导，
 * 不新增物品、不新增数值、不写死任何与配方/伤害/掉落有关的设定。
 */
import { ITEMS, itemName, ARMOR_SLOT_NAMES, TOOL_MATERIALS, TOOL_KIND_LABELS } from './items.js';
import { blockName } from './blocks.js';
import { RECIPES, smeltResult, isFuel, expandIngredient } from './recipes.js';

/* 工具类用途：只描述「用它干什么」，速度/伤害仍来自 ITEMS 里的字段 */
export const TOOL_USE_TEXT = {
  pickaxe: '挖掘石头与矿物',
  axe: '砍树与劈木板',
  shovel: '铲土、铲雪与挖草方块',
  hoe: '锄地把泥土/草方块变成耕地',
  sword: '近战攻击生物'
};

/* 特殊功能物品：字段里已有标记（bow/shears/shield/ignites），这里只翻成人话 */
export const SPECIAL_USE_TEXT = {
  bow: '按住右键蓄力，松手射箭',
  shears: '右键剪羊毛与切树叶',
  shield: '按住右键格挡正面攻击',
  flint_and_steel: '右键点燃 TNT 或生火'
};

/** 有多少条配方把这个物品当材料（标签按 expandIngredient 展开后再数） */
export function recipeUseCount(itemId) {
  let n = 0;
  for (const r of RECIPES) {
    const inputs = r.type === 'shapeless' ? r.inputs : (r.key ? Object.values(r.key) : []);
    let hit = false;
    for (const input of inputs) {
      const list = expandIngredient(input);
      if (list && list.indexOf(itemId) >= 0) { hit = true; break; }
    }
    if (hit) n++;
  }
  return n;
}

/**
 * 把一件物品解释成「名字 + 用途 + 数值」三行可读文本。
 * @param {string} id 物品 id
 * @param {{count?:number, dur?:number, noCount?:boolean}|null} stack 背包里的这一堆（可空）
 * @returns {{id:string, name:string, known:boolean, lines:string[], dur:null|{cur:number,max:number,pct:number}, use:string}}
 */
export function describeItem(id, stack = null) {
  const it = ITEMS[id];
  if (!it) return { id, name: String(id), known: false, lines: [], dur: null, use: '' };
  const lines = [];
  let use = '';

  if (it.toolType && TOOL_USE_TEXT[it.toolType]) {
    use = TOOL_USE_TEXT[it.toolType];
    const mat = String(id).split('_')[1];
    const label = TOOL_MATERIALS && TOOL_MATERIALS[mat] ? TOOL_MATERIALS[mat].label : mat;
    const kindLabel = TOOL_KIND_LABELS && TOOL_KIND_LABELS[it.toolType] ? TOOL_KIND_LABELS[it.toolType].label : it.toolType;
    lines.push(kindLabel + ' · ' + label + '级（工具等级 ' + it.toolLevel + '）');
    lines.push((it.toolType === 'sword' ? '' : '挖掘速度 ×' + it.toolSpeed + ' · ') + '攻击 ' + it.damage);
  } else if (SPECIAL_USE_TEXT[id]) {
    use = SPECIAL_USE_TEXT[id];
    if (it.damage) lines.push('攻击 ' + it.damage);
  } else if (it.food) {
    use = '可以吃';
    lines.push('恢复饥饿 ' + it.food + ' 点' + (it.saturation ? ' · 饱和度 ' + it.saturation : ''));
  } else if (it.armorPoints) {
    use = '穿在身上';
    const slotName = ARMOR_SLOT_NAMES && typeof it.armorSlot === 'number' ? ARMOR_SLOT_NAMES[it.armorSlot] : '';
    lines.push('护甲 +' + it.armorPoints + ' 点' + (slotName ? '（' + slotName + '）' : ''));
  } else if (it.blockId) {
    use = '可以放到地上';
    lines.push('方块：' + blockName(it.blockId));
  }

  /* 与熔炉/燃料有关的信息：直接读 recipes.js 的表，不另立数值 */
  const smelted = smeltResult(id);
  if (smelted) lines.push('可熔炼 → ' + itemName(smelted.output) + '（' + smelted.time + ' 秒）');
  if (isFuel(id)) lines.push('可作熔炉燃料');
  if (!use) {
    const n = recipeUseCount(id);
    use = n ? '合成材料（' + n + ' 个配方）' : '材料与合成原料';
  }

  let dur = null;
  if (it.durability && stack && typeof stack.dur === 'number') {
    const pct = Math.max(0, Math.min(1, stack.dur / it.durability));
    dur = { cur: stack.dur, max: it.durability, pct };
    lines.push('耐久 ' + stack.dur + '/' + it.durability + '（' + Math.round(pct * 100) + '%）');
  } else if (it.durability) {
    lines.push('耐久上限 ' + it.durability);
  }
  if (!it.stack || it.stack > 1) lines.push('可堆叠 ' + (it.stack || 64));

  return { id, name: it.name, known: true, lines, dur, use };
}

export default describeItem;
