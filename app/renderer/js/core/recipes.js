'use strict';
/*
 * 合成与熔炼配方。
 *  shaped   : 有序图案（自动裁剪空行空列，并尝试水平镜像）
 *  shapeless: 无序材料集合
 * 输入可以是物品 id、id 数组（任选其一）、或标签名（见 TAGS）。
 */
import { getItem } from './items.js';

/* 可互相替代的材料标签。
   阶段 7：planks 现在同时包含橡木木板与桦木板 —— 工作台、木棍、木工具、盾、
   门、箱子、床等下游配方全部按标签匹配，两种板（甚至混着摆）都能用。
   旧的 logs 标签随「log_to_planks 输入收窄为橡木原木」一起撤掉：不再有配方引用它，
   留着只会让人误以为一条配方还能吃两种原木。 */
export const TAGS = {
  planks: ['planks', 'birch_planks'],
  cobblestone: ['cobblestone'],
  stone: ['stone', 'cobblestone']
};

function expand(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return TAGS[input] ? TAGS[input].slice() : [input];
  if (Array.isArray(input)) {
    const out = [];
    for (const x of input) out.push(...(typeof x === 'string' && TAGS[x] ? TAGS[x] : [x]));
    return out;
  }
  if (input.tag) return TAGS[input.tag].slice();
  return null;
}

function matches(input, itemId) {
  const list = expand(input);
  if (!list) return itemId === null;
  return itemId !== null && list.indexOf(itemId) >= 0;
}

const RECIPES = [];

/* pattern: 字符串数组，空格表示空位；key: 字符 -> 输入 */
function shaped(pattern, key, result, count, id) {
  RECIPES.push({ type: 'shaped', id, pattern, key, result: { item: result, count } });
}
function shapeless(inputs, result, count, id) {
  RECIPES.push({ type: 'shapeless', id, inputs, result: { item: result, count } });
}

/* ============ 主线 progression：砍树 → 木板 → 工作台 → 木镐 → 石头 → 石镐/熔炉 → 采矿熔炼 ============ */
/* 阶段 7：两条原木配方**输入互斥**、各有独立 ID。
   · log_to_planks：ID 与「4 木板」产物一字不动，输入收窄为橡木原木（旧档/任务/断言仍认它）；
   · birch_log_to_birch_planks：白桦原木 → 4 桦木板。
   findRecipe 返回第一条匹配，两条都是单格 shapeless，oak_log 与 birch_log 不会互相串味。 */
shapeless(['oak_log'], 'planks', 4, 'log_to_planks');
shapeless(['birch_log'], 'birch_planks', 4, 'birch_log_to_birch_planks');
shaped(['p', 'p'], { p: 'planks' }, 'stick', 4, 'sticks');
shaped(['pp', 'pp'], { p: 'planks' }, 'crafting_table', 1, 'crafting_table');
/* 第二轮 C1：建筑构件。半砖 3 进 6 出、楼梯 6 进 4 出（与 MC 同比例）；planks 标签通吃两种板。 */
shaped(['ppp'], { p: 'planks' }, 'slab_planks', 6, 'slab_planks');
shaped(['p  ', 'pp ', 'ppp'], { p: 'planks' }, 'stairs_planks', 4, 'stairs_planks');
shaped(['ccc'], { c: 'cobblestone' }, 'slab_stone', 6, 'slab_stone');
shaped(['c  ', 'cc ', 'ccc'], { c: 'cobblestone' }, 'stairs_stone', 4, 'stairs_stone');
shaped(['ccc', 'c c', 'ccc'], { c: 'cobblestone' }, 'furnace', 1, 'furnace');

const MATS = [['wood', 'planks'], ['stone', 'cobblestone'], ['iron', 'iron_ingot'], ['diamond', 'diamond']];
for (const [name, mat] of MATS) {
  shaped(['iii', ' s ', ' s '], { i: mat, s: 'stick' }, 'pickaxe_' + name, 1, 'pickaxe_' + name);
  shaped(['ii', 'is', ' s'], { i: mat, s: 'stick' }, 'axe_' + name, 1, 'axe_' + name);
  shaped(['i', 's', 's'], { i: mat, s: 'stick' }, 'shovel_' + name, 1, 'shovel_' + name);
  shaped(['i', 'i', 's'], { i: mat, s: 'stick' }, 'sword_' + name, 1, 'sword_' + name);
  // T1 锄头：2 材料 + 1 木棍（斜角），自动支持水平镜像
  shaped(['ii', ' s'], { i: mat, s: 'stick' }, 'hoe_' + name, 1, 'hoe_' + name);
}
shaped(['c', 's'], { c: ['coal', 'charcoal'], s: 'stick' }, 'torch', 4, 'torch');

/* ============ T3 弓与箭 ============ */
/* 本作没有蜘蛛，羊毛拆成线（原版是反过来：4 线 → 羊毛），文档已注明 */
shapeless(['wool'], 'string', 2, 'wool_to_string');
/* T4：原版链路是「蜘蛛掉线 → 4 线合成羊毛」。上面那条「羊毛拆线」是本作的便利简化（既有验收断言依赖它），
   两条同时存在不会变成刷材料漏洞：4 羊毛 → 8 线 → 2 羊毛，往返是净亏损的。 */
shapeless(['string', 'string', 'string', 'string'], 'wool', 1, 'string_to_wool');
shaped(['f', 's', 'p'], { f: 'flint', s: 'stick', p: 'feather' }, 'arrow', 4, 'arrow');
shaped(['##s', '# s', '  s'], { s: 'string', '#': 'stick' }, 'bow', 1, 'bow');
/* 剪刀：2 铁锭斜角 + 2 木棍（本作简化摆法，原版同样是 2 铁锭 2 木棍） */
shaped(['i ', ' i', 'ss'], { i: 'iron_ingot', s: 'stick' }, 'shears', 1, 'shears');

/* T2 盾牌：6 木板 + 1 铁锭（上 3 木板，中 木板-铁锭-木板，下 中 1 木板） */
shaped(['ppp', 'pip', ' p '], { p: 'planks', i: 'iron_ingot' }, 'shield', 1, 'shield');

/* T5 TNT：4 沙 + 5 火药（无序，让火药终于有去处）；打火石：1 铁锭 + 1 燧石 */
shapeless(['sand', 'sand', 'sand', 'sand', 'gunpowder', 'gunpowder', 'gunpowder', 'gunpowder', 'gunpowder'], 'tnt', 1, 'tnt');
shapeless(['iron_ingot', 'flint'], 'flint_and_steel', 1, 'flint_and_steel');
/* T6 粘液块：9 个粘液球（3×3 无序） */
shapeless(['slime_ball', 'slime_ball', 'slime_ball', 'slime_ball', 'slime_ball', 'slime_ball', 'slime_ball', 'slime_ball', 'slime_ball'], 'slime_block', 1, 'slime_block');
/* T6 门：6 木板 2×3 → 3 扇门 */
shaped(['pp', 'pp', 'pp'], { p: 'planks' }, 'door', 3, 'door');

/* 滚动任务 8：地图 = 8 皮革 + 1 木棍；指南针 = 4 铁锭 + 1 玻璃（镜头） */
shaped(['lll', 'lsl', 'lll'], { l: 'leather', s: 'stick' }, 'map', 1, 'map');
shaped([' i ', 'igi', ' i '], { i: 'iron_ingot', g: 'glass' }, 'compass', 1, 'compass');

/* ============ T1 护甲：皮革 / 铁 / 钻石（经典图案，缺角=空位） ============
 * 头盔与靴子只有两行，2×2 背包格也能做；胸甲/护腿需要 3 行，必须用工作台。 */
const ARMOR_PATTERNS = {
  helmet: ['iii', 'i i'],
  chestplate: ['i i', 'iii', 'iii'],
  leggings: ['iii', 'i i', 'i i'],
  boots: ['i i', 'i i']
};
for (const [mat, ing] of [['leather', 'leather'], ['iron', 'iron_ingot'], ['diamond', 'diamond']]) {
  for (const [kind, pattern] of Object.entries(ARMOR_PATTERNS)) {
    const id = mat + '_' + kind;
    shaped(pattern, { i: ing }, id, 1, id);
  }
}

/* ============ 建筑 / 存储 / 食物 ============ */
shaped(['ss', 'ss'], { s: 'stone' }, 'stone_bricks', 4, 'stone_bricks');
shaped(['ss', 'ss'], { s: 'sand' }, 'sandstone', 1, 'sandstone_block');
shaped(['ccc', 'c c', 'ccc'], { c: 'planks' }, 'chest', 1, 'chest');
/* T2 床：3 羊毛（羊掉落）+ 3 木板 */
shaped(['www', 'ppp'], { w: 'wool', p: 'planks' }, 'bed', 1, 'bed');
shaped(['iii', 'iii', 'iii'], { i: 'iron_ingot' }, 'iron_block', 1, 'iron_block');
shaped(['ggg', 'ggg', 'ggg'], { g: 'gold_ingot' }, 'gold_block', 1, 'gold_block');
shaped(['ddd', 'ddd', 'ddd'], { d: 'diamond' }, 'diamond_block', 1, 'diamond_block');
shaped(['www'], { w: 'wheat' }, 'bread', 1, 'bread');
shapeless(['pumpkin', 'glowstone'], 'pumpkin_lamp', 1, 'pumpkin_lamp');
shapeless(['mushroom_brown', 'mushroom_red'], 'mushroom_stew', 1, 'mushroom_stew');
shapeless(['tall_grass'], 'wheat_seeds', 1, 'grass_to_seeds');

/* ============ 阶段 2 建材扩充的获取路径 ============
 * 原版用切石机（stonecutter）做的「1 进 1 出」切割，本作没有切石机方块，
 * 这里统一改成工作台里的 2 格排列（**本作约定**，不是原版配方形状），
 * 保证每一种新建材都有「正常生存能拿到」的路径，而不是只能靠创造栏。 */
shaped(['gg', 'gg'], { g: 'granite' }, 'polished_granite', 4, 'polished_granite');
shaped(['dd', 'dd'], { d: 'diorite' }, 'polished_diorite', 4, 'polished_diorite');
shaped(['aa', 'aa'], { a: 'andesite' }, 'polished_andesite', 4, 'polished_andesite');
shapeless(['stone_bricks', 'mossy_cobblestone'], 'mossy_stone_bricks', 2, 'mossy_stone_bricks');
shaped(['s', 's'], { s: 'stone_bricks' }, 'chiseled_stone_bricks', 1, 'chiseled_stone_bricks');
shaped(['ss'], { s: 'sandstone' }, 'cut_sandstone', 2, 'cut_sandstone');
shaped(['c', 'c'], { c: 'cut_sandstone' }, 'chiseled_sandstone', 1, 'chiseled_sandstone');
shaped(['ww', 'ww'], { w: 'wool' }, 'wool_block', 1, 'wool_block');
shapeless(['wool_block'], 'wool', 4, 'wool_block_unpack');
shapeless(['iron_block'], 'iron_ingot', 9, 'iron_block_unpack');
shapeless(['gold_block'], 'gold_ingot', 9, 'gold_block_unpack');
shapeless(['diamond_block'], 'diamond', 9, 'diamond_block_unpack');

/* ============ 熔炼 ============ */
export const SMELTING = Object.create(null);
function smelt(input, output, time = 8) { SMELTING[input] = { output, time, input }; }
smelt('iron_ore', 'iron_ingot');
smelt('gold_ore', 'gold_ingot');
smelt('sand', 'glass');
smelt('cobblestone', 'stone');
/* 阶段 2 建材：三条熔炼路径（原版同样是「烧一下」得到平滑/裂开的那一档） */
smelt('stone', 'smooth_stone');
/* 阶段 1 深板岩族：新档地下主岩层的建材化路径（挖到 → 烧一下 → 磨制深板岩）。 */
smelt('deepslate', 'polished_deepslate');
smelt('stone_bricks', 'cracked_stone_bricks');
smelt('sandstone', 'smooth_sandstone');
smelt('oak_log', 'charcoal');
smelt('birch_log', 'charcoal');
smelt('beef_raw', 'beef_cooked');
smelt('pork_raw', 'pork_cooked');
smelt('chicken_raw', 'chicken_cooked');
/* 阶段 3a：鱼群掉落生鱼，熔炼成熟鱼（与牛排/熟鸡同一套路数） */
smelt('fish_raw', 'fish_cooked');
smelt('wheat', 'bread');
smelt('potato', 'potato_baked');
smelt('clay_ball', 'brick');

export function smeltResult(itemId) { return SMELTING[itemId] || null; }

/* ============ 燃料 ============ */
export function isFuel(itemId) {
  const it = getItem(itemId);
  return !!(it && it.fuel && it.fuel > 0);
}

/* ============ 匹配 ============ */
function trimPattern(pattern) {
  const width = Math.max(...pattern.map(r => r.length));
  let rows = pattern.map(r => r.padEnd(width, ' '));
  const empty = (r) => r.trim() === '';
  while (rows.length && empty(rows[0])) rows.shift();
  while (rows.length && empty(rows[rows.length - 1])) rows.pop();
  if (!rows.length) return { h: 0, w: 0, cells: [] };
  let minC = Infinity, maxC = -1;
  for (const r of rows) {
    for (let i = 0; i < r.length; i++) if (r[i] !== ' ') { if (i < minC) minC = i; if (i > maxC) maxC = i; }
  }
  return { h: rows.length, w: maxC - minC + 1, cells: rows.map(r => r.slice(minC, maxC + 1).split('')) };
}

function gridAt(grid, x, y) {
  const row = grid[y];
  if (!row) return null;
  const v = row[x];
  return v ? v : null;
}

function matchShaped(recipe, grid, size) {
  const src = trimPattern(recipe.pattern);
  if (!src.h || src.h > size || src.w > size) return false;
  for (let mirror = 0; mirror < 2; mirror++) {
    for (let oy = 0; oy + src.h <= size; oy++) {
      for (let ox = 0; ox + src.w <= size; ox++) {
        let good = true;
        for (let y = 0; y < size && good; y++) {
          for (let x = 0; x < size && good; x++) {
            const cellItem = gridAt(grid, x, y);
            const inWin = y >= oy && y < oy + src.h && x >= ox && x < ox + src.w;
            if (!inWin) { if (cellItem !== null) good = false; continue; }
            let ch = src.cells[y - oy][x - ox];
            if (mirror) ch = src.cells[y - oy][src.w - 1 - (x - ox)];
            if (ch === ' ') { if (cellItem !== null) good = false; continue; }
            if (!matches(recipe.key[ch], cellItem)) good = false;
          }
        }
        if (good) return true;
      }
    }
    if (src.w === 1) break; // 单列无需镜像
  }
  return false;
}

function matchShapeless(recipe, grid, size) {
  const pool = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const it = gridAt(grid, x, y);
    if (it) pool.push(it);
  }
  if (pool.length !== recipe.inputs.length) return false;
  const used = new Array(pool.length).fill(false);
  for (const req of recipe.inputs) {
    const list = expand(req);
    let found = -1;
    for (let i = 0; i < pool.length; i++) if (!used[i] && list.indexOf(pool[i]) >= 0) { found = i; break; }
    if (found < 0) return false;
    used[found] = true;
  }
  return true;
}

/* grid = [y][x] -> itemId | null（2x2 玩家背包格 或 3x3 工作台） */
export function findRecipe(grid) {
  let total = 0;
  for (const row of grid) for (const c of row) if (c) total++;
  if (!total) return null;
  const size = grid.length;
  for (const r of RECIPES) {
    if (r.type === 'shaped' ? matchShaped(r, grid, size) : matchShapeless(r, grid, size)) return r;
  }
  return null;
}

export function hasAnyIngredient(items) {
  // items: Set/array of item ids；用于配方界面灰显
  const set = items instanceof Set ? items : new Set(items);
  return RECIPES.some(r => {
    const need = r.type === 'shapeless' ? r.inputs : Object.values(r.key).map(v => v);
    return need.every(n => { const l = expand(n); return l && l.some(x => set.has(x)); });
  });
}

/* 配方展示用 */
export function listRecipes() {
  return RECIPES.map(r => ({
    id: r.id,
    result: r.result,
    type: r.type,
    pattern: r.type === 'shaped' ? trimPattern(r.pattern).cells.map(row => row.join('')) : null,
    key: r.type === 'shaped' ? Object.fromEntries(Object.entries(r.key).map(([k, v]) => [k, expand(v)])) : null,
    inputs: r.type === 'shapeless' ? r.inputs.map(expand) : null
  }));
}

/**
 * 一键填充 / 配方书灰显共用的一份材料分配（本轮 A4）。
 *
 * 旧实现按「字符」整体挑一个候选，要求单个候选有足量：
 * `alts.find(a => countOf(a) >= 该字符总数)`。于是橡木板 2 + 桦木板 2（同属 planks 标签）
 * 一键做工作台必然失败，1+3 同样失败 —— 玩家得手动摆。
 *
 * 这里改成**按格子**分配：每填一格就扣一次余额（countOf - 已分配），
 * 第一个余额用完就顺位到下一个候选。顺序固定 = expand() 里的候选顺序，
 * 所以同样的背包每次摆出同样的格子，可复现。
 *
 * @param {object} rec     RECIPES 里的一条
 * @param {(id:string)=>number} countOf 背包里某物品的数量
 * @returns {{ok:boolean, need:Object, slots:{ch:string,item:string}[], missing:string[]}}
 */
export function allocateForCraft(rec, countOf) {
  const have = typeof countOf === 'function' ? countOf : () => 0;
  const need = Object.create(null);
  const slots = [];
  const missing = [];
  /* 格子顺序：shaped 按 pattern 行优先（空格跳过），shapeless 按 inputs 顺序 */
  const cells = [];
  if (!rec) return { ok: false, need, slots, missing: ['recipe'] };
  if (rec.type === 'shapeless') {
    for (const inp of rec.inputs) cells.push({ ch: null, input: inp });
  } else {
    const w = Math.max(...rec.pattern.map(x => x.length));
    for (const row of rec.pattern) {
      const padded = row.padEnd(w, ' ');
      for (const ch of padded) if (ch !== ' ') cells.push({ ch, input: rec.key[ch] });
    }
  }
  for (const cell of cells) {
    const alts = expand(cell.input) || [];
    let picked = null;
    for (const a of alts) {
      if (have(a) - (need[a] || 0) > 0) { picked = a; break; }
    }
    if (!picked) {
      missing.push(cell.ch || String(cell.input));
      /* 继续往后算：让「缺什么」能一次报全 */
      continue;
    }
    need[picked] = (need[picked] || 0) + 1;
    slots.push({ ch: cell.ch, item: picked });
  }
  return { ok: missing.length === 0, need, slots, missing };
}

export { RECIPES, expand as expandIngredient };
