'use strict';
/*
 * 方块注册表：数字 ID -> 属性（中文名 / 贴图 / 硬度 / 工具 / 掉落 / 光照 / 碰撞）
 * 所有游戏系统（世界生成、网格化、光照、挖掘、掉落、合成、存档）都以这张表为唯一真源。
 */

export const AIR = 0;

export const B = {
  AIR: 0,
  STONE: 1,
  DIRT: 2,
  GRASS: 3,
  COBBLESTONE: 4,
  BEDROCK: 5,
  SAND: 6,
  SANDSTONE: 7,
  GRAVEL: 8,
  WATER: 9,
  LOG: 10,
  LEAVES: 11,
  BIRCH_LOG: 12,
  BIRCH_LEAVES: 13,
  PLANKS: 14,
  BRICK: 15,
  STONE_BRICKS: 16,
  MOSSY: 17,
  COAL_ORE: 18,
  IRON_ORE: 19,
  GOLD_ORE: 20,
  DIAMOND_ORE: 21,
  EMERALD_ORE: 22,
  LAPIS_ORE: 23,
  OBSIDIAN: 24,
  CRAFTING_TABLE: 25,
  FURNACE: 26,
  FURNACE_LIT: 27,
  GLOWSTONE: 28,
  GLASS: 29,
  IRON_BLOCK: 30,
  GOLD_BLOCK: 31,
  DIAMOND_BLOCK: 32,
  SNOW: 33,
  TORCH: 34,
  DIRT_PATH: 35,
  FARMLAND: 36,
  WHEAT: 37,
  SAPLING: 38,
  CHEST: 39,
  TALL_GRASS: 40,
  POPPY: 41,
  DANDELION: 42,
  DEAD_BUSH: 43,
  CACTUS: 44,
  PUMPKIN: 45,
  MUSHROOM_BROWN: 46,
  MUSHROOM_RED: 47,
  PUMPKIN_LAMP: 48,
  BED: 49,
  TNT: 50,
  SLIME_BLOCK: 51,
  DOOR_BOTTOM: 52,
  DOOR_TOP: 53,
  DOOR_BOTTOM_OPEN: 54,
  DOOR_TOP_OPEN: 55,
  /* 阶段 2 建材扩充（14 种，全部是新的数字 ID，旧存档里不存在这些下标 → 原样兼容） */
  GRANITE: 56,
  DIORITE: 57,
  ANDESITE: 58,
  POLISHED_GRANITE: 59,
  POLISHED_DIORITE: 60,
  POLISHED_ANDESITE: 61,
  SMOOTH_STONE: 62,
  MOSSY_STONE_BRICKS: 63,
  CRACKED_STONE_BRICKS: 64,
  CHISELED_STONE_BRICKS: 65,
  SMOOTH_SANDSTONE: 66,
  CHISELED_SANDSTONE: 67,
  CUT_SANDSTONE: 68,
  WOOL_BLOCK: 69,
  /* 阶段 1 深板岩族（新档 y<=深板岩界 的岩层本体 + 它的熔炼建材）。
     同样是「大于旧存档最大 ID」的新号段 → 旧档 diff 键不会错位；
     旧布局的地形永远不会放置它们，只有 genVersion=1 的新档才天然生成。 */
  DEEPSLATE: 70,
  POLISHED_DEEPSLATE: 71,
  /* 阶段 7：桦木板。用大于所有既有 ID 的新号段，旧存档里不存在这个下标，
     旧档的 planks（14）与其它方块 ID 一字不动 —— 读档不会错位。 */
  BIRCH_PLANKS: 72,
  /* 第二轮 C1：建筑构件。全部追加在末尾，旧档的 planks(14)/birch_planks(72) 与其它 ID 完全不动。
     shape 描述非整块外形；碰撞、网格、放置都读它，meta 位用来表达朝向与上下半。 */
  SLAB_PLANKS: 73,
  SLAB_STONE: 74,
  STAIRS_PLANKS: 75,
  STAIRS_STONE: 76
};

/* 非整块方块的碰撞盒（局部 0..1 坐标）：[x0,y0,z0,x1,y1,z1]
   · 整块：一个满盒
   · 半砖：下半或上半（meta & 8 表示上半）
   · 楼梯：下半整片 + 朝向那一侧的上半（meta & 3 = 朝向 0:+z 1:-z 2:+x 3:-x） */
export function blockBoxes(id, meta = 0) {
  const b = BLOCKS[id];
  if (!b || !b.shape) return [[0, 0, 0, 1, 1, 1]];
  if (b.shape === 'slab') {
    return (meta & 8) ? [[0, 0.5, 0, 1, 1, 1]] : [[0, 0, 0, 1, 0.5, 1]];
  }
  if (b.shape === 'stairs') {
    const face = meta & 3;
    const boxes = [[0, 0, 0, 1, 0.5, 1]];
    if (face === 0) boxes.push([0, 0.5, 0, 1, 1, 0.5]);        // 朝 +z：高的半片在 -z 侧
    else if (face === 1) boxes.push([0, 0.5, 0.5, 1, 1, 1]);   // 朝 -z
    else if (face === 2) boxes.push([0, 0.5, 0, 0.5, 1, 1]);   // 朝 +x
    else boxes.push([0.5, 0.5, 0, 1, 1, 1]);                   // 朝 -x
    return boxes;
  }
  return [[0, 0, 0, 1, 1, 1]];
}

/** 这一格在 x/z 上是否占满（半砖与楼梯都占满），用于放置与邻接判断 */
export function blockFullFootprint(id) {
  const b = BLOCKS[id];
  return !b || !b.shape;
}

/*
 * 字段说明
 *  name        中文名（界面显示）
 *  tiles       贴图：{all} 或 {top,bottom,side,front}
 *  hardness    徒手挖掘基准秒数（近似 MC 数值）
 *  tool        有效工具类型
 *  toolLevel   能够收获掉落物所需的最低工具等级（0 徒手 1 木 2 石 3 铁 4 钻）
 *  drop        掉落：{item,count} / null(不掉落) / 'self' / 函数
 *  solid       是否参与碰撞
 *  opaque      是否不透明（影响面剔除与光照阻挡）
 *  cross       是否用十字面片渲染（火把/小麦）
 *  liquid      是否液体
 *  light       自发光 0~15
 *  placeable   玩家能否放置
 *  replaceable 放置时能否被替换（水、空气）
 *  meta        是否使用方块数据（朝向/生长阶段）
 */
function def(id, o) {
  o.id = id;
  o.solid = o.solid !== false;
  o.opaque = o.opaque !== false && o.liquid !== true && o.cross !== true;
  o.light = o.light || 0;
  o.hardness = o.hardness === undefined ? 1 : o.hardness;
  o.tool = o.tool || null;
  o.toolLevel = o.toolLevel || 0;
  o.placeable = o.placeable !== false;
  o.replaceable = o.replaceable === true;
  o.cross = o.cross === true;
  o.liquid = o.liquid === true;
  o.meta = o.meta === true;
  return o;
}

export const BLOCKS = [];
function register(id, o) { BLOCKS[id] = def(id, o); return BLOCKS[id]; }

register(B.AIR, { name: '空气', tiles: { all: 'air' }, solid: false, opaque: false, replaceable: true, hardness: 0, placeable: false, transparent: true });
register(B.STONE, { name: '石头', tiles: { all: 'stone' }, hardness: 1.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'cobblestone' } });
register(B.DIRT, { name: '泥土', tiles: { all: 'dirt' }, hardness: 0.5, tool: 'shovel', drop: { item: 'dirt' } });
register(B.GRASS, {
  name: '草方块', tiles: { top: 'grass_top', bottom: 'dirt', side: 'grass_side' }, hardness: 0.6, tool: 'shovel',
  // 掉落：永远是泥土，另有 15% 概率额外掉小麦种子（T1：种子来源）
  drop: (meta, rand) => rand() < 0.15
    ? [{ item: 'dirt', count: 1 }, { item: 'wheat_seeds', count: 1 }]
    : [{ item: 'dirt', count: 1 }]
});
register(B.COBBLESTONE, { name: '圆石', tiles: { all: 'cobblestone' }, hardness: 2, tool: 'pickaxe', toolLevel: 1, drop: { item: 'cobblestone' } });
register(B.BEDROCK, { name: '基岩', tiles: { all: 'bedrock' }, hardness: -1, drop: null, placeable: false });
register(B.SAND, { name: '沙子', tiles: { all: 'sand' }, hardness: 0.5, tool: 'shovel', drop: { item: 'sand' } });
register(B.SANDSTONE, { name: '沙岩', tiles: { all: 'sandstone' }, hardness: 0.8, tool: 'pickaxe', toolLevel: 1, drop: { item: 'sandstone' } });
register(B.GRAVEL, { name: '砂砾', tiles: { all: 'gravel' }, hardness: 0.6, tool: 'shovel', drop: { item: 'flint', chance: 0.35, or: 'gravel' } });
register(B.WATER, { name: '水', tiles: { all: 'water' }, solid: false, opaque: false, liquid: true, transparent: true, hardness: -1, drop: null, placeable: false, replaceable: true });
register(B.LOG, { name: '橡木原木', tiles: { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log_side' }, hardness: 2, tool: 'axe', drop: { item: 'oak_log' } });
register(B.LEAVES, { name: '橡树树叶', tiles: { all: 'oak_leaves' }, hardness: 0.2, tool: 'axe', opaque: false, transparent: true, drop: { leaves: true } });
register(B.BIRCH_LOG, { name: '白桦原木', tiles: { top: 'oak_log_top', bottom: 'oak_log_top', side: 'birch_log_side' }, hardness: 2, tool: 'axe', drop: { item: 'birch_log' } });
register(B.BIRCH_LEAVES, { name: '白桦树叶', tiles: { all: 'oak_leaves' }, hardness: 0.2, tool: 'axe', opaque: false, transparent: true, drop: { leaves: true } });
register(B.PLANKS, { name: '木板', tiles: { all: 'planks' }, hardness: 2, tool: 'axe', drop: { item: 'planks' } });
/* 阶段 7：白桦原木做出来的浅色板。与橡木木板同硬度/同工具/同燃料，
   两者都进 planks 标签，工作台、木棍、木工具、盾、门、箱子、床等下游配方通用。 */
register(B.BIRCH_PLANKS, { name: '桦木板', tiles: { all: 'birch_planks' }, hardness: 2, tool: 'axe', drop: { item: 'birch_planks' } });
/* 第二轮 C1：楼梯与半砖。opaque:false —— 让邻居的面照常画出来（否则会按整块剔除，
   半砖旁边会出现缺面）；光也照常进出，不当作遮光整块。meta:true 用来存朝向/上下半。 */
register(B.SLAB_PLANKS, {
  name: '木板半砖', tiles: { all: 'planks' }, hardness: 2, tool: 'axe',
  drop: { item: 'slab_planks' }, shape: 'slab', meta: true, opaque: false, transparent: true
});
register(B.SLAB_STONE, {
  name: '石半砖', tiles: { all: 'cobblestone' }, hardness: 2, tool: 'pickaxe', toolLevel: 1,
  drop: { item: 'slab_stone' }, shape: 'slab', meta: true, opaque: false, transparent: true
});
register(B.STAIRS_PLANKS, {
  name: '木板楼梯', tiles: { all: 'planks' }, hardness: 2, tool: 'axe',
  drop: { item: 'stairs_planks' }, shape: 'stairs', meta: true, opaque: false, transparent: true
});
register(B.STAIRS_STONE, {
  name: '石楼梯', tiles: { all: 'cobblestone' }, hardness: 2, tool: 'pickaxe', toolLevel: 1,
  drop: { item: 'stairs_stone' }, shape: 'stairs', meta: true, opaque: false, transparent: true
});
register(B.BRICK, { name: '砖块', tiles: { all: 'brick' }, hardness: 2, tool: 'pickaxe', toolLevel: 1, drop: { item: 'brick' } });
register(B.STONE_BRICKS, { name: '石砖', tiles: { all: 'stone_bricks' }, hardness: 2, tool: 'pickaxe', toolLevel: 1, drop: { item: 'stone_bricks' } });
register(B.MOSSY, { name: '苔石', tiles: { all: 'mossy_cobblestone' }, hardness: 2, tool: 'pickaxe', toolLevel: 1, drop: { item: 'mossy_cobblestone' } });
register(B.COAL_ORE, { name: '煤矿石', tiles: { all: 'coal_ore' }, hardness: 3, tool: 'pickaxe', toolLevel: 1, drop: { item: 'coal' } });
register(B.IRON_ORE, { name: '铁矿石', tiles: { all: 'iron_ore' }, hardness: 3, tool: 'pickaxe', toolLevel: 1, drop: { item: 'iron_ore' } });
register(B.GOLD_ORE, { name: '金矿石', tiles: { all: 'gold_ore' }, hardness: 3, tool: 'pickaxe', toolLevel: 3, drop: { item: 'gold_ore' } });
register(B.DIAMOND_ORE, { name: '钻石矿石', tiles: { all: 'diamond_ore' }, hardness: 3, tool: 'pickaxe', toolLevel: 3, drop: { item: 'diamond' } });
register(B.EMERALD_ORE, { name: '绿宝石矿石', tiles: { all: 'emerald_ore' }, hardness: 3, tool: 'pickaxe', toolLevel: 3, drop: { item: 'emerald' } });
register(B.LAPIS_ORE, { name: '青金石矿石', tiles: { all: 'lapis_ore' }, hardness: 3, tool: 'pickaxe', toolLevel: 2, drop: { item: 'lapis_lazuli', count: 4 } });
register(B.OBSIDIAN, { name: '黑曜石', tiles: { all: 'obsidian' }, hardness: 10, tool: 'pickaxe', toolLevel: 4, drop: { item: 'obsidian' } });
register(B.CRAFTING_TABLE, { name: '工作台', tiles: { top: 'crafting_table_top', bottom: 'planks', side: 'crafting_table_side', front: 'crafting_table_front' }, hardness: 2.5, tool: 'axe', drop: { item: 'crafting_table' } });
register(B.FURNACE, { name: '熔炉', tiles: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front' }, hardness: 3.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'furnace' }, meta: true });
register(B.FURNACE_LIT, { name: '熔炉', tiles: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', front: 'furnace_front_lit' }, hardness: 3.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'furnace' }, meta: true, light: 6 });
register(B.GLOWSTONE, { name: '荧石', tiles: { all: 'glowstone' }, hardness: 0.3, drop: { item: 'glowstone' }, light: 15 });
register(B.GLASS, { name: '玻璃', tiles: { all: 'glass' }, hardness: 0.3, opaque: false, transparent: true, drop: null });
register(B.IRON_BLOCK, { name: '铁块', tiles: { all: 'iron_block' }, hardness: 5, tool: 'pickaxe', toolLevel: 2, drop: { item: 'iron_block' } });
register(B.GOLD_BLOCK, { name: '金块', tiles: { all: 'gold_block' }, hardness: 3, tool: 'pickaxe', toolLevel: 3, drop: { item: 'gold_block' } });
register(B.DIAMOND_BLOCK, { name: '钻石块', tiles: { all: 'diamond_block' }, hardness: 5, tool: 'pickaxe', toolLevel: 3, drop: { item: 'diamond_block' } });
register(B.SNOW, { name: '雪块', tiles: { all: 'snow_block' }, hardness: 0.2, tool: 'shovel', drop: { item: 'snow_block', count: 1 } });
register(B.TORCH, { name: '火把', tiles: { all: 'torch' }, cross: true, solid: false, opaque: false, transparent: true, hardness: 0, light: 14, drop: { item: 'torch' } });
register(B.DIRT_PATH, { name: '土径', tiles: { top: 'dirt_path_top', bottom: 'dirt', side: 'dirt' }, hardness: 0.6, tool: 'shovel', drop: { item: 'dirt' } });
register(B.FARMLAND, { name: '耕地', tiles: { top: 'farmland', bottom: 'dirt', side: 'dirt' }, hardness: 0.6, tool: 'shovel', drop: { item: 'dirt' }, meta: true });
register(B.WHEAT, {
  name: '小麦', tiles: { all: 'wheat_0' }, cross: true, solid: false, opaque: false, transparent: true,
  hardness: 0.05, drop: { wheat: true }, meta: true, placeable: false
});
register(B.SAPLING, { name: '树苗', tiles: { all: 'sapling_oak' }, cross: true, solid: false, opaque: false, transparent: true, hardness: 0, drop: { sapling: true }, meta: true, replaceable: true });
register(B.CHEST, { name: '箱子', tiles: { top: 'chest_top', bottom: 'chest_top', side: 'chest_side', front: 'chest_front' }, hardness: 2.5, tool: 'axe', drop: { item: 'chest' }, meta: true });
register(B.TALL_GRASS, { name: '高草', tiles: { all: 'tall_grass' }, cross: true, solid: false, opaque: false, transparent: true, hardness: 0.05, drop: { grass: true }, replaceable: true });
register(B.POPPY, { name: '虞美人', tiles: { all: 'poppy' }, cross: true, solid: false, opaque: false, transparent: true, hardness: 0.05, drop: { item: 'poppy' }, replaceable: true });
register(B.DANDELION, { name: '蒲公英', tiles: { all: 'dandelion' }, cross: true, solid: false, opaque: false, transparent: true, hardness: 0.05, drop: { item: 'dandelion' }, replaceable: true });
register(B.DEAD_BUSH, { name: '枯灌木', tiles: { all: 'dead_bush' }, cross: true, solid: false, opaque: false, transparent: true, hardness: 0.05, drop: { item: 'stick', count: 2 }, replaceable: true });
register(B.CACTUS, { name: '仙人掌', tiles: { top: 'cactus_top', bottom: 'cactus_top', side: 'cactus_side' }, hardness: 0.4, drop: { item: 'cactus' } });
register(B.PUMPKIN, { name: '南瓜', tiles: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', front: 'pumpkin_front' }, hardness: 1.2, tool: 'axe', drop: { item: 'pumpkin' }, meta: true });
register(B.MUSHROOM_BROWN, { name: '棕色蘑菇', tiles: { all: 'mushroom_brown_block' }, cross: true, solid: false, opaque: false, transparent: true, hardness: 0.05, drop: { item: 'mushroom_brown' }, replaceable: true });
register(B.MUSHROOM_RED, { name: '红色蘑菇', tiles: { all: 'mushroom_red_block' }, cross: true, solid: false, opaque: false, transparent: true, hardness: 0.05, drop: { item: 'mushroom_red' }, replaceable: true });
register(B.PUMPKIN_LAMP, { name: '南瓜灯', tiles: { top: 'lamp_top', bottom: 'lamp_top', side: 'lamp_side', front: 'lamp_front' }, hardness: 1.2, tool: 'axe', drop: { item: 'pumpkin_lamp' }, light: 15, meta: true });
register(B.BED, {
  name: '床', tiles: { top: 'bed_top', bottom: 'planks', side: 'bed_side', front: 'bed_front' },
  hardness: 0.2, tool: 'axe', drop: { item: 'bed' }, meta: true
});
/* T5：最小 TNT。引信状态不入方块元数据、不入存档；方块本身与其他方块一样走 setBlock/diff。 */
register(B.TNT, {
  name: 'TNT', tiles: { all: 'tnt' }, hardness: 0.1,
  drop: { item: 'tnt' }
});
/* T6 粘液块：玩家落在上面会弹起且免摔落伤害（潜行时不弹）；不透明关闭，观感更接近果冻 */
register(B.SLIME_BLOCK, {
  name: '粘液块', tiles: { all: 'slime_block' }, hardness: 0.05,
  opaque: false, transparent: true, drop: { item: 'slime_block' }
});
/* T6 门：两格高（下半/上半），meta 低 2 位朝向、第 3 位开合。
   关闭时是实心整方块；打开时换成 cross 方块，视觉是两片门板、碰撞消失。
   掉落由 interaction 统一处理（只掉一扇门，不掉两个半块）。 */
register(B.DOOR_BOTTOM, { name: '门', tiles: { all: 'door_lower' }, hardness: 0.4, tool: 'axe', drop: null, meta: true });
register(B.DOOR_TOP, { name: '门', tiles: { all: 'door_upper' }, hardness: 0.4, tool: 'axe', drop: null, meta: true, placeable: false });
register(B.DOOR_BOTTOM_OPEN, {
  name: '门（开）', tiles: { all: 'door_lower' }, cross: true, solid: false, opaque: false,
  transparent: true, hardness: 0.4, drop: null, meta: true, placeable: false
});
register(B.DOOR_TOP_OPEN, {
  name: '门（开）', tiles: { all: 'door_upper' }, cross: true, solid: false, opaque: false,
  transparent: true, hardness: 0.4, drop: null, meta: true, placeable: false
});

/* ============ 阶段 2 建材扩充（14 种） ============
 * 硬度与工具沿用本作既有石材族（石头 1.5 / 圆石 2 / 沙岩 0.8）的量级，不是原版实测数值；
 * 掉落一律掉自己（磨制/砖族是合成产物，不存在「开采原矿」这条路）。 */
register(B.GRANITE, { name: '花岗岩', tiles: { all: 'granite' }, hardness: 1.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'granite' } });
register(B.DIORITE, { name: '闪长岩', tiles: { all: 'diorite' }, hardness: 1.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'diorite' } });
register(B.ANDESITE, { name: '安山岩', tiles: { all: 'andesite' }, hardness: 1.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'andesite' } });
register(B.POLISHED_GRANITE, { name: '磨制花岗岩', tiles: { all: 'polished_granite' }, hardness: 1.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'polished_granite' } });
register(B.POLISHED_DIORITE, { name: '磨制闪长岩', tiles: { all: 'polished_diorite' }, hardness: 1.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'polished_diorite' } });
register(B.POLISHED_ANDESITE, { name: '磨制安山岩', tiles: { all: 'polished_andesite' }, hardness: 1.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'polished_andesite' } });
register(B.SMOOTH_STONE, { name: '平滑石头', tiles: { all: 'smooth_stone' }, hardness: 1.5, tool: 'pickaxe', toolLevel: 1, drop: { item: 'smooth_stone' } });
register(B.MOSSY_STONE_BRICKS, { name: '苔石砖', tiles: { all: 'mossy_stone_bricks' }, hardness: 2, tool: 'pickaxe', toolLevel: 1, drop: { item: 'mossy_stone_bricks' } });
register(B.CRACKED_STONE_BRICKS, { name: '裂石砖', tiles: { all: 'cracked_stone_bricks' }, hardness: 2, tool: 'pickaxe', toolLevel: 1, drop: { item: 'cracked_stone_bricks' } });
register(B.CHISELED_STONE_BRICKS, { name: '錾制石砖', tiles: { all: 'chiseled_stone_bricks' }, hardness: 2, tool: 'pickaxe', toolLevel: 1, drop: { item: 'chiseled_stone_bricks' } });
register(B.SMOOTH_SANDSTONE, { name: '平滑沙岩', tiles: { all: 'smooth_sandstone' }, hardness: 0.8, tool: 'pickaxe', toolLevel: 1, drop: { item: 'smooth_sandstone' } });
register(B.CHISELED_SANDSTONE, { name: '雕纹沙岩', tiles: { all: 'chiseled_sandstone' }, hardness: 0.8, tool: 'pickaxe', toolLevel: 1, drop: { item: 'chiseled_sandstone' } });
register(B.CUT_SANDSTONE, { name: '切制沙岩', tiles: { all: 'cut_sandstone' }, hardness: 0.8, tool: 'pickaxe', toolLevel: 1, drop: { item: 'cut_sandstone' } });
register(B.WOOL_BLOCK, { name: '羊毛块', tiles: { all: 'wool_block' }, hardness: 0.8, drop: { item: 'wool_block' } });

/* ============ 阶段 1 深板岩族（新档 y ≤ 深板岩界 的主岩层本体） ============
 * 硬度比石头高一档（本作石头 1.5 / 深板岩 3），镐等级仍是 1：木镐挖得动，只是慢。
 * 挖掘掉「深板岩」本体 —— 本作约定**不给深板岩另设圆石形态**，
 * 免得「石头 → 圆石」这条既有掉落规则被牵进新分支；熔炼成磨制深板岩才是它的建材路线。
 * 贴图名与物品 id 同名（与阶段 2 建材族同一套做法），图标直接复用方块画笔。 */
register(B.DEEPSLATE, { name: '深板岩', tiles: { all: 'deepslate' }, hardness: 3, tool: 'pickaxe', toolLevel: 1, drop: { item: 'deepslate' } });
register(B.POLISHED_DEEPSLATE, { name: '磨制深板岩', tiles: { all: 'polished_deepslate' }, hardness: 3, tool: 'pickaxe', toolLevel: 1, drop: { item: 'polished_deepslate' } });

export function isDoorBlock(id) {
  return id === B.DOOR_BOTTOM || id === B.DOOR_TOP || id === B.DOOR_BOTTOM_OPEN || id === B.DOOR_TOP_OPEN;
}

export const BLOCK_COUNT = BLOCKS.length;

export function block(id) { return BLOCKS[id] || BLOCKS[B.AIR]; }
export function blockName(id) { const b = BLOCKS[id]; return b ? b.name : '未知'; }
export function isSolid(id) { const b = BLOCKS[id]; return !!b && b.solid; }
export function isOpaque(id) { const b = BLOCKS[id]; return !!b && b.opaque; }
export function isReplaceable(id) { const b = BLOCKS[id]; return !b || b.replaceable; }
export function blocksLight(id) {
  const b = BLOCKS[id];
  if (!b) return false;
  if (id === AIR) return false;
  if (b.liquid) return false;          // 水只衰减，不阻挡
  if (b.cross) return false;
  return b.opaque || id === B.GLASS;   // 玻璃阻挡天空光但面仍剔除
}
export function lightEmission(id) { const b = BLOCKS[id]; return b ? b.light : 0; }

/* 该方块能否被同种方块遮面（用于树叶/玻璃内部的额外剔除规则） */
export function cullsSame(id) {
  const b = BLOCKS[id];
  if (!b) return false;
  return b.opaque || id === B.GLASS || id === B.LEAVES || id === B.BIRCH_LEAVES;
}

/* 挖掘耗时（秒）。creative 传 instant=true */
export function breakTime(id, toolItem, instant = false) {
  const b = BLOCKS[id];
  if (!b || b.hardness < 0) return Infinity;
  if (instant) return 0.05;
  let speed = 1;
  if (toolItem && b.tool && toolItem.toolType === b.tool) {
    if ((toolItem.toolLevel || 0) >= b.toolLevel) speed = toolItem.toolSpeed || 2;
    else speed = 1;
  }
  let t = b.hardness * 1.5 / speed;
  // 需要更高级工具才能采到掉落物时，仍然能挖，只是慢
  if (b.toolLevel > 0 && !(toolItem && toolItem.toolType === b.tool && (toolItem.toolLevel || 0) >= b.toolLevel)) {
    t = b.hardness * 3.33;
  }
  return Math.max(0.05, t);
}

/* 掉落物（item id + 数量），rand 为 0~1 随机函数 */
export function blockDrops(id, meta, rand) {
  const b = BLOCKS[id];
  if (!b) return [];
  const d = b.drop;
  if (d === null || d === undefined) return [];
  if (typeof d === 'function') return d(meta, rand);
  if (d.leaves) {
    // 树叶：小概率掉落树苗与木棍
    const out = [];
    const r = rand();
    if (r < 0.06) out.push({ item: id === B.BIRCH_LEAVES ? 'birch_sapling' : 'oak_sapling', count: 1 });
    if (rand() < 0.03) out.push({ item: 'stick', count: 1 });
    if (rand() < 0.08) out.push({ item: 'apple', count: 1 });
    return out;
  }
  if (d.wheat) {
    const ripe = (meta || 0) >= 6;
    if (ripe) return [{ item: 'wheat', count: 1 + (rand() < 0.3 ? 1 : 0) }, { item: 'wheat_seeds', count: 1 }];
    return [{ item: 'wheat_seeds', count: 1 }];
  }
  if (d.sapling) {
    return [{ item: (meta & 1) ? 'birch_sapling' : 'oak_sapling', count: 1 }];
  }
  if (d.grass) {
    return rand() < 0.25 ? [{ item: 'wheat_seeds', count: 1 }] : [];
  }
  if (d.or) {
    return [{ item: rand() < (d.chance || 0.5) ? d.item : d.or, count: d.count || 1 }];
  }
  return [{ item: d.item, count: d.count || 1 }];
}

/* 按面名取贴图名。face ∈ 'top'|'bottom'|'posx'|'negx'|'posz'|'negz'
   带朝向的方块（熔炉/工作台）用 meta 决定哪一面是正面：0=+z 1=-z 2=+x 3=-x */
const SIDE_TO_META = { posz: 0, negz: 1, posx: 2, negx: 3 };

export function tileForFace(id, meta, face) {
  const b = BLOCKS[id];
  if (!b) return 'missing';
  if (id === B.WHEAT) {
    const g = Math.min(2, Math.floor((meta || 0) / 3));
    return 'wheat_' + g;
  }
  if (id === B.SAPLING) return (meta & 1) ? 'sapling_birch' : 'sapling_oak';
  if (id === B.FARMLAND && face === 'top') return (meta & 1) ? 'farmland_wet' : 'farmland';
  const t = b.tiles;
  if (t.all) return t.all;
  if (face === 'top') return t.top || t.side || t.bottom;
  if (face === 'bottom') return t.bottom || t.side || t.top;
  if (t.front && SIDE_TO_META[face] === (meta & 3)) return t.front;
  return t.side || t.top || t.bottom;
}

/* 该方块是否有方向性（存档/放置时需要写 meta） */
export function hasFacing(id) {
  const b = BLOCKS[id];
  return !!(b && b.tiles && b.tiles.front);
}

/* 地面装饰植物（不实体、不算地表） */
export function isPlant(id) {
  return id === B.SAPLING || id === B.WHEAT || id === B.TALL_GRASS || id === B.POPPY ||
    id === B.DANDELION || id === B.DEAD_BUSH || id === B.MUSHROOM_BROWN || id === B.MUSHROOM_RED;
}

/* ---------- T1：锄头开垦与种植规则（纯函数，无头测试直接覆盖） ---------- */

/* 锄头能开垦的方块：草方块与泥土；其上方必须是空气或可被替换的植物 */
export function canTill(belowId, aboveId) {
  if (belowId !== B.GRASS && belowId !== B.DIRT) return false;
  if (aboveId === AIR) return true;
  return isPlant(aboveId) || isReplaceable(aboveId);
}

/* 小麦种子只能种在耕地上（T1 前本作允许直接种泥土/草地，现收紧） */
export function canPlantSeed(groundId) {
  return groundId === B.FARMLAND;
}

/* 耕地湿润判定半径：水平 3 格、纵向 ±1 格内有水即湿润（原版为 4 格，本作取 3 便于手感） */
export const FARMLAND_WET_RADIUS = 3;

/* T4 接触就掉血的方块（本作只有仙人掌；岩浆/细雪等未实现） */
export function hurtsOnTouch(id) {
  return id === B.CACTUS;
}

/* T1 随机刻规则：干耕地（不湿润）且上方没有作物，累计干涸到 need 秒就退回泥土。
   纯函数，game.tickFarmland 与无头测试共用同一份判定。 */
export function farmlandShouldRevert(dryT, wet, hasCrop, need) {
  if (wet || hasCrop) return false;
  return dryT >= (need || 60);
}
