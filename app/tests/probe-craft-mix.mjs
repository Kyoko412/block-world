/*
 * 混合木板一键合成探针（Node，无 DOM）：直接跑产品里的 CraftingGrid.fillFrom 与配方书用的
 * allocateForCraft，覆盖 2+2 / 1+3 / 纯橡木 / 纯桦木 / 材料不足回退。
 *
 * 复现的缺陷：collectNeeds 按「字符」整体挑候选并要求单候选够量，
 * 于是橡木板 2 + 桦木板 2 一键做工作台失败（配方书里也灰着）。
 *
 *   node tests/probe-craft-mix.mjs [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { CraftingGrid } from '../renderer/js/core/machines.js';
import { RECIPES, allocateForCraft, findRecipe } from '../renderer/js/core/recipes.js';
import { Inventory } from '../renderer/js/player/inventory.js';

const recipe = (id) => RECIPES.find(r => r.id === id) || null;
const resultOf = (g) => { const r = g.result(); return r ? r.item + '×' + r.count : null; };

function invWith(map) {
  const inv = new Inventory();
  inv.clear();
  for (const [item, n] of Object.entries(map)) inv.add(item, n);
  return inv;
}
function snapshot(inv) {
  const out = {};
  for (const s of inv.slots) if (s) out[s.item] = (out[s.item] || 0) + s.count;
  return out;
}

const cases = [];
function attempt(name, recipeId, stock, expectOk, expectResult, gridSize = 2) {
  const g = new CraftingGrid(gridSize);
  const inv = invWith(stock);
  const before = snapshot(inv);
  const ok = g.fillFrom(recipeId, inv);
  const after = snapshot(inv);
  const gridItems = g.slots.map(s => (s ? s.item : null));
  const res = resultOf(g);
  const consumed = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (before[k] || 0) - (after[k] || 0);
    if (d) consumed[k] = d;
  }
  /* 退回网格里的材料也要算回来：一键填充成功了材料就在网格里 */
  const inGrid = {};
  for (const s of g.slots) if (s) inGrid[s.item] = (inGrid[s.item] || 0) + s.count;
  const totalIn = (k) => (after[k] || 0) + (inGrid[k] || 0);
  const lost = {};
  for (const k of Object.keys(before)) {
    const d = (before[k] || 0) - totalIn(k);
    if (d !== 0) lost[k] = d;
  }
  const rec = recipe(recipeId);
  const alloc = allocateForCraft(rec, (id) => (before[id] || 0));
  cases.push({
    name, recipeId, gridSize, stock, ok, result: res, expected: expectResult,
    gridItems, consumed, lost, allocOk: alloc.ok, allocNeed: alloc.need,
    fail: (ok !== expectOk) || (expectResult && res !== expectResult) || Object.keys(lost).length > 0
  });
}

/* 工作台：2×2 全用 planks 标签 */
attempt('2 橡木 + 2 桦木 → 工作台', 'crafting_table', { planks: 2, birch_planks: 2 }, true, 'crafting_table×1');
attempt('1 橡木 + 3 桦木 → 工作台', 'crafting_table', { planks: 1, birch_planks: 3 }, true, 'crafting_table×1');
attempt('3 橡木 + 1 桦木 → 工作台', 'crafting_table', { planks: 3, birch_planks: 1 }, true, 'crafting_table×1');
attempt('4 橡木 → 工作台', 'crafting_table', { planks: 4 }, true, 'crafting_table×1');
attempt('4 桦木 → 工作台', 'crafting_table', { birch_planks: 4 }, true, 'crafting_table×1');
/* 材料不足：必须失败且一个不吞 */
attempt('2 橡木（不足）→ 工作台应失败', 'crafting_table', { planks: 2 }, false, null);
attempt('1+2（不足）→ 工作台应失败', 'crafting_table', { planks: 1, birch_planks: 2 }, false, null);
attempt('空背包 → 工作台应失败', 'crafting_table', {}, false, null);
/* 下游配方：木棍（2 竖板）、木镐、盾、箱子、床 —— 混合板都要能一键做。
   注意网格尺寸：3×3 配方必须给 3×3 网格（工作台），2×2 只放得下 2×2 内的配方。 */
attempt('混合板 → 木棍', 'sticks', { planks: 1, birch_planks: 1 }, true, 'stick×4');
attempt('混合板 → 木镐', 'pickaxe_wood', { planks: 2, birch_planks: 1, stick: 2 }, true, 'pickaxe_wood×1', 3);
attempt('混合板 → 箱子', 'chest', { planks: 6, birch_planks: 2 }, true, 'chest×1', 3);
attempt('混合板 → 盾', 'shield', { planks: 5, birch_planks: 1, iron_ingot: 1 }, true, 'shield×1', 3);
attempt('混合板 → 木剑', 'sword_wood', { planks: 1, birch_planks: 1, stick: 1 }, true, 'sword_wood×1', 3);
/* 2×2 网格点 3×3 配方：产品入口（ui.js）会先拦下并提示「需要工作台」，
   底层 fillFrom 也必须**在扣料前拒绝**（本轮 A3）。
   旧版这里允许「失败或任意产物」，结果把截断后的木锄当成了请求木镐的成功；
   现在要求：ok=false、背包与网格都没有任何物品变化（材料守恒）。 */
{
  const g = new CraftingGrid(2);
  const inv = invWith({ planks: 2, birch_planks: 1, stick: 2 });
  const before = snapshot(inv);
  const ok = g.fillFrom('pickaxe_wood', inv);
  const after = snapshot(inv);
  const inGrid = {};
  for (const s of g.slots) if (s) inGrid[s.item] = (inGrid[s.item] || 0) + s.count;
  const sameBag = JSON.stringify(before) === JSON.stringify(snapshot(inv));
  const gridEmpty = g.slots.every(s => !s);
  cases.push({
    name: '2×2 网格请求 3×3 配方（必须拒绝且零取料）', recipeId: 'pickaxe_wood',
    ok, result: resultOf(g), expected: null,
    consumed: {}, lost: {},
    fail: ok !== false || !sameBag || !gridEmpty
  });
  cases[cases.length - 1].note = 'before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after) +
    ' grid=' + JSON.stringify(inGrid);
}
/* 反过来：3×3 网格请求 3×3 配方必须成功并得到木镐本身（不是木锄） */
{
  const g = new CraftingGrid(3);
  const inv = invWith({ planks: 2, birch_planks: 1, stick: 2 });
  const ok = g.fillFrom('pickaxe_wood', inv);
  const res = resultOf(g);
  cases.push({
    name: '3×3 网格请求木镐（产物必须就是木镐）', recipeId: 'pickaxe_wood',
    ok, result: res, expected: 'pickaxe_wood×1', consumed: {}, lost: {},
    fail: !ok || res !== 'pickaxe_wood×1'
  });
}
/* 反复点同一条配方不丢物品：12 格木板刚好够 3 次工作台，点 5 次后总量守恒、第 4/5 次干净失败 */
{
  const g = new CraftingGrid(2);
  const inv = invWith({ planks: 8, birch_planks: 4 });
  const total = (mp) => Object.values(mp).reduce((a, b) => a + b, 0);
  const t0 = total(snapshot(inv));
  let okN = 0;
  for (let i = 0; i < 5; i++) if (g.fillFrom('crafting_table', inv)) okN++;
  const inGrid = {};
  for (const s of g.slots) if (s) inGrid[s.item] = (inGrid[s.item] || 0) + s.count;
  const t1 = total(snapshot(inv)) + total(inGrid);
  cases.push({
    name: '反复点工作台 5 次（每次都成功且总量守恒）', recipeId: 'crafting_table',
    ok: okN > 0, result: resultOf(g), expected: 'crafting_table×1', consumed: {}, lost: {},
    /* 每次点都是「把网格里的料退回背包 → 重新摆一份」：材料没被消耗，所以 5 次都应成功，
       总量必须一直是 12。旧写法 clear() 直接丢格子内容，第 2 次就少 4 个。 */
    fail: t1 !== t0 || okN !== 5
  });
  cases[cases.length - 1].note = '材料 ' + t0 + ' → 背包+网格 ' + t1 + '，成功 ' + okN + ' 次';
}
/* 3×3 工作台格：床（羊毛 + 木板） */
attempt('3×3 混合板 → 床', 'bed', { planks: 2, birch_planks: 1, wool: 3 }, true, 'bed×1', 3);
/* 材料不足的下游配方也不能吞 */
attempt('混合板不足 → 箱子应失败', 'chest', { planks: 3, birch_planks: 4 }, false, null, 3);

/* 分配顺序固定：同一背包两次结果一样 */
{
  const a = allocateForCraft(recipe('crafting_table'), (id) => ({ planks: 2, birch_planks: 2 })[id] || 0);
  const b = allocateForCraft(recipe('crafting_table'), (id) => ({ planks: 2, birch_planks: 2 })[id] || 0);
  cases.push({ name: '分配可复现', ok: JSON.stringify(a) === JSON.stringify(b), expected: '两次一致', fail: JSON.stringify(a) !== JSON.stringify(b) });
}

const failures = cases.filter(c => c.fail);
const out = { at: new Date().toISOString(), cases, failures: failures.map(f => f.name) };
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx > 0) fs.writeFileSync(path.resolve(process.argv[jsonIdx + 1]), JSON.stringify(out, null, 2));

console.log('混合木板一键合成探针');
for (const c of cases) {
  console.log('  ' + (c.fail ? '✗' : '✓') + ' ' + c.name.padEnd(26) +
    ' ok=' + String(c.ok).padEnd(5) + ' 结果=' + String(c.result).padEnd(18) +
    (c.consumed ? ' 消耗=' + JSON.stringify(c.consumed) : '') +
    (c.lost && Object.keys(c.lost).length ? '  丢失=' + JSON.stringify(c.lost) : ''));
}
if (failures.length) {
  console.log('\n失败 ' + failures.length + ' 项：');
  for (const f of failures) console.log('  ✗ ' + f.name + ' → ' + JSON.stringify({ ok: f.ok, result: f.result, expected: f.expected, lost: f.lost }));
  process.exitCode = 1;
} else {
  console.log('\n' + cases.length + ' 项全部通过：2+2 / 1+3 / 纯板都能一键摆出，材料不足时正确回退且不吞物品。');
}
