'use strict';
/*
 * 物品注册表：物品 ID 一律用字符串（存档可读、不易错位）。
 * 方块物品带 blockId，工具带 toolType/toolLevel/toolSpeed/durability，
 * 食物带 hunger/saturation（第二阶段使用），燃料带 fuel（可熔炼数量）。
 */
import { B } from './blocks.js';

export const ITEMS = Object.create(null);

function item(id, o) {
  o.id = id;
  o.stack = o.stack || 64;
  o.icon = o.icon || id;
  o.name = o.name || id;
  ITEMS[id] = o;
  return o;
}

/* ---------- 可由方块掉落的方块物品 ---------- */
function blockItem(itemId, blockId, name, opts = {}) {
  return Object.assign(item(itemId, Object.assign({ name, blockId }, opts)), { itemId });
}

blockItem('grass_block', B.GRASS, '草方块');
blockItem('dirt', B.DIRT, '泥土');
blockItem('cobblestone', B.COBBLESTONE, '圆石');
blockItem('stone', B.STONE, '石头');
blockItem('sand', B.SAND, '沙子');
blockItem('sandstone', B.SANDSTONE, '沙岩');
blockItem('gravel', B.GRAVEL, '砂砾');
blockItem('oak_log', B.LOG, '橡木原木', { fuel: 1.5 });
blockItem('birch_log', B.BIRCH_LOG, '白桦原木', { fuel: 1.5 });
blockItem('oak_leaves', B.LEAVES, '橡树树叶', { fuel: 0.2 });
blockItem('birch_leaves', B.BIRCH_LEAVES, '白桦树叶', { fuel: 0.2 });
blockItem('planks', B.PLANKS, '木板', { fuel: 1.5 });
/* 阶段 7：桦木板。物品 ID 与方块 ID 都是新增的，旧 planks 的 ID 一字不动。 */
blockItem('birch_planks', B.BIRCH_PLANKS, '桦木板', { fuel: 1.5 });
/* 第二轮 C1：建筑构件（半砖 / 楼梯）。木板类可当燃料，石类不可。 */
blockItem('slab_planks', B.SLAB_PLANKS, '木板半砖', { fuel: 0.75 });
blockItem('stairs_planks', B.STAIRS_PLANKS, '木板楼梯', { fuel: 1.5 });
blockItem('slab_stone', B.SLAB_STONE, '石半砖');
blockItem('stairs_stone', B.STAIRS_STONE, '石楼梯');
blockItem('brick', B.BRICK, '砖块');
blockItem('stone_bricks', B.STONE_BRICKS, '石砖');
blockItem('mossy_cobblestone', B.MOSSY, '苔石');
blockItem('coal_ore', B.COAL_ORE, '煤矿石');
blockItem('iron_ore', B.IRON_ORE, '铁矿石');
blockItem('gold_ore', B.GOLD_ORE, '金矿石');
blockItem('diamond_ore', B.DIAMOND_ORE, '钻石矿石');
blockItem('emerald_ore', B.EMERALD_ORE, '绿宝石矿石');
blockItem('lapis_ore', B.LAPIS_ORE, '青金石矿石');
blockItem('obsidian', B.OBSIDIAN, '黑曜石');
blockItem('crafting_table', B.CRAFTING_TABLE, '工作台', { fuel: 1.5 });
blockItem('furnace', B.FURNACE, '熔炉');
blockItem('glowstone', B.GLOWSTONE, '荧石');
blockItem('glass', B.GLASS, '玻璃');
blockItem('iron_block', B.IRON_BLOCK, '铁块');
blockItem('gold_block', B.GOLD_BLOCK, '金块');
blockItem('diamond_block', B.DIAMOND_BLOCK, '钻石块');
blockItem('snow_block', B.SNOW, '雪块');
blockItem('torch', B.TORCH, '火把');
blockItem('bedrock', B.BEDROCK, '基岩');
blockItem('farmland', B.FARMLAND, '耕地');
blockItem('dirt_path', B.DIRT_PATH, '土径');

/* ---------- 阶段 2 建材扩充（14 种，物品 id 与贴图名一致，图标走 blockPainters） ---------- */
blockItem('granite', B.GRANITE, '花岗岩');
blockItem('diorite', B.DIORITE, '闪长岩');
blockItem('andesite', B.ANDESITE, '安山岩');
blockItem('polished_granite', B.POLISHED_GRANITE, '磨制花岗岩');
blockItem('polished_diorite', B.POLISHED_DIORITE, '磨制闪长岩');
blockItem('polished_andesite', B.POLISHED_ANDESITE, '磨制安山岩');
blockItem('smooth_stone', B.SMOOTH_STONE, '平滑石头');
blockItem('mossy_stone_bricks', B.MOSSY_STONE_BRICKS, '苔石砖');
blockItem('cracked_stone_bricks', B.CRACKED_STONE_BRICKS, '裂石砖');
blockItem('chiseled_stone_bricks', B.CHISELED_STONE_BRICKS, '錾制石砖');
blockItem('smooth_sandstone', B.SMOOTH_SANDSTONE, '平滑沙岩');
blockItem('chiseled_sandstone', B.CHISELED_SANDSTONE, '雕纹沙岩');
blockItem('cut_sandstone', B.CUT_SANDSTONE, '切制沙岩');
blockItem('wool_block', B.WOOL_BLOCK, '羊毛块');

/* ---------- 阶段 1 深板岩族（新档主岩层，物品 id 与贴图名一致） ---------- */
blockItem('deepslate', B.DEEPSLATE, '深板岩');
blockItem('polished_deepslate', B.POLISHED_DEEPSLATE, '磨制深板岩');

/* ---------- 材料 ---------- */
item('stick', { name: '木棍', fuel: 0.5 });
item('coal', { name: '煤炭', fuel: 8 });
item('charcoal', { name: '木炭', fuel: 8 });
item('iron_ingot', { name: '铁锭' });
item('gold_ingot', { name: '金锭' });
item('diamond', { name: '钻石' });
item('emerald', { name: '绿宝石' });
item('lapis_lazuli', { name: '青金石' });
item('flint', { name: '燧石' });
item('leather', { name: '皮革' });
item('string', { name: '线' });
item('feather', { name: '羽毛' });
item('bone', { name: '骨头' });
item('gunpowder', { name: '火药' });
item('egg', { name: '鸡蛋' });
item('sugar', { name: '糖' });
item('oak_sapling', { name: '橡树树苗', blockId: B.SAPLING, plantable: true, saplingMeta: 0, icon: 'oak_sapling' });
item('birch_sapling', { name: '白桦树苗', blockId: B.SAPLING, plantable: true, saplingMeta: 1, icon: 'birch_sapling' });
item('clay_ball', { name: '黏土球' });
item('slime_ball', { name: '粘液球' });
/* 以下方块的实体表现属于第二阶段，先保证配方产出有对应物品 */
item('ladder', { name: '梯子', pendingBlock: true, icon: 'planks' });
item('arrow', { name: '箭', stack: 64 });
item('potato_baked', { name: '烤马铃薯', food: 6, saturation: 6 });
item('cake', { name: '蛋糕', food: 14, saturation: 2.8 });
item('mushroom_stew', { name: '蘑菇煲', food: 10, saturation: 12, icon: 'mushroom_stew' });

/* ---------- 新增装饰/农作物方块物品 ---------- */
blockItem('chest', B.CHEST, '箱子', { fuel: 1.5 });
blockItem('poppy', B.POPPY, '虞美人');
blockItem('dandelion', B.DANDELION, '蒲公英');
blockItem('dead_bush', B.DEAD_BUSH, '枯灌木');
blockItem('cactus', B.CACTUS, '仙人掌');
blockItem('pumpkin', B.PUMPKIN, '南瓜');
blockItem('pumpkin_lamp', B.PUMPKIN_LAMP, '南瓜灯');
blockItem('tall_grass', B.TALL_GRASS, '高草');
blockItem('bed', B.BED, '床');
blockItem('slime_block', B.SLIME_BLOCK, '粘液块');
/* T6 门：不是单方块物品，放置时一次占两格（interaction.placeDoor） */
item('door', { name: '门', stack: 64, doorItem: true, icon: 'door' });

/* ---------- T2 羊毛（床上游材料，由羊掉落） ---------- */
item('wool', { name: '羊毛' });

/* ---------- 食物（第二阶段生效） ---------- */
item('apple', { name: '苹果', food: 4, saturation: 2.4 });
item('bread', { name: '面包', food: 5, saturation: 6 });
item('wheat', { name: '小麦', icon: 'wheat' });
item('wheat_seeds', { name: '小麦种子', plantable: true, seedFor: B.WHEAT });
item('carrot', { name: '胡萝卜', food: 3, saturation: 3.6 });
item('potato', { name: '马铃薯', food: 1, saturation: 0.6 });
item('beef_raw', { name: '生牛肉', food: 3, saturation: 1.8, smeltTo: 'beef_cooked' });
item('beef_cooked', { name: '牛排', food: 8, saturation: 12.8 });
item('pork_raw', { name: '生猪肉', food: 3, saturation: 1.8, smeltTo: 'pork_cooked' });
item('pork_cooked', { name: '熟猪肉', food: 8, saturation: 12.8 });
item('chicken_raw', { name: '生鸡肉', food: 2, saturation: 1.2, smeltTo: 'chicken_cooked', poison: 0.3 });
item('chicken_cooked', { name: '熟鸡肉', food: 6, saturation: 7.2 });
/* 阶段 3a 鱼：数值沿用本作「生 2 / 熟 6」这一档（与生鸡肉同级），
   生鱼**不带 poison** —— 在本作里「生吃有风险」是生鸡肉与腐肉那条既有例外，不再扩大到鱼。 */
item('fish_raw', { name: '生鱼', food: 2, saturation: 1.2, smeltTo: 'fish_cooked' });
item('fish_cooked', { name: '熟鱼', food: 6, saturation: 7.2 });
item('mushroom_brown', { name: '棕色蘑菇', food: 1, saturation: 0.2, blockId: B.MUSHROOM_BROWN });
item('mushroom_red', { name: '红色蘑菇', food: 1, saturation: 0.2, poison: 0.6, blockId: B.MUSHROOM_RED });
item('rotten_flesh', { name: '腐肉', food: 4, saturation: 0.8, poison: 0.6 });

/* ---------- 工具 ---------- */
const MATERIALS = {
  wood: { level: 1, speed: 2, durability: 60, label: '木' },
  stone: { level: 2, speed: 4, durability: 132, label: '石' },
  iron: { level: 3, speed: 6, durability: 251, label: '铁' },
  diamond: { level: 4, speed: 8, durability: 1562, label: '钻石' }
};
const TOOL_KINDS = {
  pickaxe: { label: '镐', baseDamage: 2 },
  axe: { label: '斧', baseDamage: 3 },
  shovel: { label: '铲', baseDamage: 1 },
  hoe: { label: '锄', baseDamage: 1 },
  sword: { label: '剑', baseDamage: 4 }
};
export const TOOL_MATERIALS = MATERIALS;
export const TOOL_KIND_LABELS = TOOL_KINDS;

for (const [mat, m] of Object.entries(MATERIALS)) {
  for (const [kind, k] of Object.entries(TOOL_KINDS)) {
    const id = kind + '_' + mat;
    item(id, {
      name: m.label + k.label,
      stack: 1,
      toolType: kind,
      toolLevel: m.level,
      toolSpeed: m.speed,
      durability: m.durability,
      damage: k.baseDamage + m.level,
      icon: id
    });
  }
}

/* ---------- T3 弓（远程武器：按住右键蓄力，松手射出箭实体） ---------- */
item('bow', { name: '弓', stack: 1, bow: true, durability: 200, damage: 5, icon: 'bow' });

/* ---------- 剪刀（右键羊剪毛；不破坏方块、不放置方块） ---------- */
item('shears', { name: '剪刀', stack: 1, shears: true, durability: 64, icon: 'shears' });

/* ---------- T2 盾牌（右键举盾格挡正面 120° 的近战与箭矢） ---------- */
item('shield', { name: '盾牌', stack: 1, shield: true, durability: 336, icon: 'shield' });

/* ---------- T5 最小 TNT 与打火石 ---------- */
blockItem('tnt', B.TNT, 'TNT');
item('flint_and_steel', { name: '打火石', stack: 1, ignites: true, durability: 64, icon: 'flint_and_steel' });

/* ---------- 滚动任务 8：地图与指南针（离线、可存档） ---------- */
item('map', { name: '地图', stack: 1, mapItem: true, icon: 'map' });
item('compass', { name: '指南针', stack: 1, compassItem: true, icon: 'compass' });

/* ---------- T1 护甲：皮革 / 铁 / 钻石 × 头盔/胸甲/护腿/靴子 ----------
 * armorSlot: 0 头盔 / 1 胸甲 / 2 护腿 / 3 靴子（与 Inventory.armor 下标一致）
 * armorPoints: 每点减免 4%，套装合计皮革 5 / 铁 15 / 钻石 20（见 core/armor.js）
 * durability: 与原版同量级，按「每次实际受击每件 -1」消耗
 * 链甲与下界合金明确不做。 */
const ARMOR_MATS = {
  leather: { label: '皮革', points: [1, 2, 1, 1], dur: [55, 80, 75, 65] },
  iron: { label: '铁', points: [2, 6, 5, 2], dur: [165, 240, 225, 195] },
  diamond: { label: '钻石', points: [3, 8, 6, 3], dur: [363, 528, 495, 429] }
};
const ARMOR_KINDS = [
  { key: 'helmet', label: '头盔' },
  { key: 'chestplate', label: '胸甲' },
  { key: 'leggings', label: '护腿' },
  { key: 'boots', label: '靴子' }
];
export const ARMOR_SLOT_NAMES = ARMOR_KINDS.map(k => k.label);
export const ARMOR_SET_POINTS = Object.fromEntries(
  Object.entries(ARMOR_MATS).map(([m, d]) => [m, d.points.reduce((a, b) => a + b, 0)]));

for (const [mat, m] of Object.entries(ARMOR_MATS)) {
  ARMOR_KINDS.forEach((kind, slot) => {
    const id = mat + '_' + kind.key;
    item(id, {
      name: m.label + kind.label,
      stack: 1,
      durability: m.dur[slot],
      armorSlot: slot,
      armorPoints: m.points[slot],
      armorSet: mat,
      icon: id
    });
  });
}

/* ---------- 查询 ---------- */
export function getItem(id) { return ITEMS[id] || null; }
export function itemName(id) { const it = ITEMS[id]; return it ? it.name : id; }
export function maxStack(id) { const it = ITEMS[id]; return it ? it.stack : 64; }
export function isTool(id) { const it = ITEMS[id]; return !!(it && it.toolType); }
export function fuelValue(id) { const it = ITEMS[id]; return it && it.fuel ? it.fuel : 0; }

const BLOCK_TO_ITEM = Object.create(null);
for (const id of Object.keys(ITEMS)) {
  const it = ITEMS[id];
  if (it.blockId !== undefined && it.blockId !== null && BLOCK_TO_ITEM[it.blockId] === undefined) {
    BLOCK_TO_ITEM[it.blockId] = id;
  }
}
export function blockToItem(blockId) { return BLOCK_TO_ITEM[blockId] || null; }

/* 创造模式物品栏分页 */
export const CREATIVE_TABS = [
  {
    name: '建筑',
    items: ['grass_block', 'dirt', 'stone', 'cobblestone', 'planks', 'birch_planks', 'slab_planks', 'stairs_planks', 'slab_stone', 'stairs_stone', 'oak_log', 'birch_log', 'oak_leaves', 'birch_leaves',
      'sand', 'sandstone', 'gravel', 'glass', 'brick', 'stone_bricks', 'mossy_cobblestone', 'snow_block', 'glowstone',
      'obsidian', 'iron_block', 'gold_block', 'diamond_block', 'bedrock',
      'granite', 'diorite', 'andesite', 'polished_granite', 'polished_diorite', 'polished_andesite', 'smooth_stone',
      'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks',
      'smooth_sandstone', 'chiseled_sandstone', 'cut_sandstone', 'wool_block',
      'deepslate', 'polished_deepslate']
  },
  {
    name: '功能与自然',
    items: ['crafting_table', 'furnace', 'chest', 'bed', 'torch', 'farmland', 'dirt_path', 'pumpkin', 'pumpkin_lamp',
      'cactus', 'poppy', 'dandelion', 'dead_bush', 'tall_grass', 'mushroom_brown', 'mushroom_red',
      'oak_sapling', 'birch_sapling', 'tnt', 'slime_block', 'door']
  },
  {
    name: '工具',
    items: ['pickaxe_wood', 'axe_wood', 'shovel_wood', 'hoe_wood', 'sword_wood',
      'pickaxe_stone', 'axe_stone', 'shovel_stone', 'hoe_stone', 'sword_stone',
      'pickaxe_iron', 'axe_iron', 'shovel_iron', 'hoe_iron', 'sword_iron',
      'pickaxe_diamond', 'axe_diamond', 'shovel_diamond', 'hoe_diamond', 'sword_diamond',
      'bow', 'shears', 'shield', 'flint_and_steel', 'map', 'compass',
      'leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots',
      'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
      'diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']
  },
  {
    name: '材料',
    items: ['stick', 'coal', 'charcoal', 'iron_ingot', 'gold_ingot', 'diamond', 'emerald', 'lapis_lazuli', 'flint',
      'leather', 'string', 'wool', 'slime_ball', 'feather', 'bone', 'egg', 'wheat', 'wheat_seeds', 'arrow']
  },
  {
    name: '食物',
    items: ['apple', 'bread', 'beef_raw', 'beef_cooked', 'pork_raw', 'pork_cooked', 'chicken_raw', 'chicken_cooked',
      'fish_raw', 'fish_cooked',
      'carrot', 'potato', 'potato_baked', 'mushroom_stew', 'rotten_flesh']
  }
];
