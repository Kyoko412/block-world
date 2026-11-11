/* 校验程序化画笔与音效模块的接口完整性（在 Node 里用桩对象跑一遍） */
import { BLOCKS, B } from '../renderer/js/core/blocks.js';
import { ITEMS } from '../renderer/js/core/items.js';
import { blockPainters, itemPainters, paintBlock, paintItem } from '../renderer/js/gfx/painters.js';

/* --- 假 canvas 2D 上下文，记录绘制操作 --- */
let ops = 0, outOfBounds = 0, lastColor = '';
let oobList = [];
let currentTile = '';
function makeCtx() {
  const c = {
    fillStyle: '#000',
    globalAlpha: 1,
    _clip: null, _tx: 0, _ty: 0,
    save() { }, restore() { }, translate(x, y) { c._tx = x; c._ty = y; },
    beginPath() { }, closePath() { }, moveTo() { }, lineTo() { }, stroke() { },
    arc() { }, ellipse() { }, rect(x, y, w, h) { c._clip = [x, y, w, h]; },
    clip() { }, fill() { ops++; },
    fillRect(x, y, w, h) {
      ops++;
      lastColor = c.fillStyle;
      if (typeof c.fillStyle !== 'string') outOfBounds++;
      const L = c._clip ? c._clip[0] : 0, T = c._clip ? c._clip[1] : 0;
      const R = c._clip ? L + c._clip[2] : 16, Bo = c._clip ? T + c._clip[3] : 16;
      if (x < L - 0.001 || y < T - 0.001 || x + w > R + 0.001 || y + h > Bo + 0.001) outOfBounds++;
      if (!Number.isFinite(x + y + w + h)) throw new Error('非有限数值 fillRect');
    },
    clearRect() { ops++; },
    setTransform() { }, drawImage() { ops++; }, createLinearGradient() { return { addColorStop() { } }; },
    putImageData() { }, getImageData() { return { data: new Uint8ClampedArray(4) }; }
  };
  return c;
}

/* --- 我需要的所有方块贴图名 --- */
const need = new Set();
for (const b of BLOCKS) {
  if (!b) continue;
  for (const k of Object.keys(b.tiles || {})) {
    const v = b.tiles[k];
    if (typeof v === 'string' && v !== 'air') need.add(v);
  }
}
need.add('missing');
need.add('grass_top'); need.add('dirt'); need.add('stone');

/* --- 我需要的物品图标名 --- */
const needItems = new Set();
for (const id of Object.keys(ITEMS)) {
  const it = ITEMS[id];
  if (it.blockId !== undefined && it.blockId !== null) continue;
  needItems.add(it.icon || id);
}

const haveBlocks = new Set(Object.keys(blockPainters || {}));
const haveItems = new Set(Object.keys(itemPainters || {}));
const missB = [...need].filter(n => !haveBlocks.has(n));
const missI = [...needItems].filter(n => !haveItems.has(n));

console.log('需要方块贴图 ' + need.size + ' 个，画笔提供 ' + haveBlocks.size + ' 个');
console.log('缺失方块贴图: ' + (missB.length ? missB.join(', ') : '（无）'));
console.log('需要物品图标 ' + needItems.size + ' 个，画笔提供 ' + haveItems.size + ' 个');
console.log('缺失物品图标: ' + (missI.length ? missI.join(', ') : '（无）'));

/* --- 实跑一遍，确认不抛异常且真的画了东西 --- */
let painted = 0, empty = [], thrown = [];
for (const name of need) {
  const c = makeCtx();
  const before = ops;
  try { paintBlock(name, c, mulberry(), 16); } catch (e) { thrown.push(name + ': ' + e.message); continue; }
  if (ops === before) empty.push(name); else painted++;
}
for (const name of needItems) {
  const c = makeCtx();
  const before = ops;
  try { paintItem(name, c, mulberry(), 16); } catch (e) { thrown.push('item ' + name + ': ' + e.message); continue; }
  if (ops === before) empty.push('item:' + name); else painted++;
}
console.log('成功绘制 ' + painted + ' 个 tile；空绘制: ' + (empty.length ? empty.join(',') : '（无）'));
console.log('抛异常: ' + (thrown.length ? thrown.join(' | ') : '（无）'));
console.log('越界绘制次数: ' + outOfBounds);

/* --- 每个 tile 的颜色是否真的有变化（不是纯色填充） --- */
let flat = [];
for (const name of need) {
  const colors = new Set();
  const c = makeCtx();
  c.fillRect = (x, y, w, h) => { colors.add(c.fillStyle); };
  try { paintBlock(name, c, mulberry(), 16); } catch (e) { continue; }
  if (colors.size < 2) flat.push(name);
}
console.log('颜色单一（可能是纯色块）: ' + (flat.length ? flat.join(',') : '（无）'));

function mulberry(a) {
  let t = (a || 1) >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
