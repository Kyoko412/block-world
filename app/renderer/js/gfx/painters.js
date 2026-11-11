'use strict';
/*
 * painters.js —— 程序化像素贴图生成器（16x16 tile，MC 风格）
 *
 * 完全离线、零外部资源：所有材质都由整数坐标的 1x1 / 2x1 / 2x2 fillRect 拼出。
 * 约定：
 *   painter(g, rand, size)
 *     g    —— 已 translate 到某个 tile 左上角的 CanvasRenderingContext2D
 *     rand —— 确定性伪随机函数，返回 [0,1)；禁止使用 Math.random，保证可复现
 *     size —— 固定 16（本文件内部一律以 TILE=16 为边界，绝不画出 tile）
 *
 * 美术原则：低分辨率 + 柔和颗粒 + 2~4 档色阶；自然方块不描边（可无缝平铺），
 * 只有功能性方块（工作台 / 熔炉 / 金属块 / 火把 / 图标类）才允许方向性边框。
 */

const TILE = 16;

/* ============================================================
 * 颜色工具
 * ============================================================ */

const _colorCache = new Map();

function toRGB(c) {
  if (typeof c !== 'string') return c;
  let s = c.charAt(0) === '#' ? c.slice(1) : c;
  if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
  return [
    parseInt(s.slice(0, 2), 16) || 0,
    parseInt(s.slice(2, 4), 16) || 0,
    parseInt(s.slice(4, 6), 16) || 0
  ];
}

function css(c) {
  return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
}

/* amount ∈ [-1,1]：负数向黑靠（变暗），正数向白靠（变亮） */
function tone(hex, amount) {
  const key = 't' + hex + '|' + amount;
  let v = _colorCache.get(key);
  if (v !== undefined) return v;
  const c = toRGB(hex);
  const target = amount < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amount));
  v = css([
    Math.max(0, Math.min(255, c[0] + (target - c[0]) * p)),
    Math.max(0, Math.min(255, c[1] + (target - c[1]) * p)),
    Math.max(0, Math.min(255, c[2] + (target - c[2]) * p))
  ]);
  _colorCache.set(key, v);
  return v;
}

/* 两种颜色线性混合，t=0 取 a，t=1 取 b */
function mix(a, b, t) {
  const key = 'm' + a + '|' + b + '|' + t;
  let v = _colorCache.get(key);
  if (v !== undefined) return v;
  const ca = toRGB(a), cb = toRGB(b);
  v = css([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
  _colorCache.set(key, v);
  return v;
}

function rgba(r, g_, b, a) {
  return 'rgba(' + r + ',' + g_ + ',' + b + ',' + a + ')';
}

/* ============================================================
 * 绘制工具（全部带边界裁剪，绝不越出 (0,0)-(16,16)）
 * ============================================================ */

function rect(g, x, y, w, h, color) {
  if (x < 0) { w += x; x = 0; }
  if (y < 0) { h += y; y = 0; }
  if (w <= 0 || h <= 0 || x >= TILE || y >= TILE) return;
  if (x + w > TILE) w = TILE - x;
  if (y + h > TILE) h = TILE - y;
  g.fillStyle = color;
  g.fillRect(x | 0, y | 0, w | 0, h | 0);
}

function px(g, x, y, color) { rect(g, x, y, 1, 1, color); }

function pxIn(g, x, y, color) {
  if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
  px(g, x, y, color);
}

/* 跨越边界时把像素绕到对侧，保证自然方块无缝平铺 */
function wrapPx(g, x, y, color) {
  if (x < 0) x += TILE; else if (x >= TILE) x -= TILE;
  if (y < 0) y += TILE; else if (y >= TILE) y -= TILE;
  pxIn(g, x, y, color);
}

function fillTile(g, color) { rect(g, 0, 0, TILE, TILE, color); }

/* 只清比自己小的局部区域（用于玻璃 / 火把 / 树叶 / 物品图标的透明底） */
function clearTile(g, size) {
  const s = size > 0 ? Math.min(size, TILE) : TILE;
  g.clearRect(0, 0, s, s);
}

function pick(arr, rand) {
  if (!arr.length) return 0;
  let i = (rand() * arr.length) | 0;
  if (i < 0) i = 0; else if (i >= arr.length) i = arr.length - 1;
  return arr[i];
}

/* 逐像素颗粒底纹：levels 是若干明暗档位（2~4 档色阶的 MC 观感） */
function grain(g, rand, base, levels) {
  const lv = levels || LV_MID;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) px(g, x, y, tone(base, pick(lv, rand)));
  }
}

/*
 * 稀疏颗粒：先用底色铺平，只让一部分像素取明暗档位。
 * 本轮 B 的「材质噪声」修正 —— grain() 让每一个像素都在抖，铺满 8×8 以后就是
 * 一层均匀噪点（远看像脏了的纯色块，近看没有可辨认的结构）。
 * 这里把覆盖率降到 0.30~0.45、档位也收窄，然后由各材质自己用「成组」的
 * 斑块 / 纹理 / 接缝去建立结构。粒子尺度相同，只是不再满屏抖。
 */
function grainSparse(g, rand, base, levels, coverage) {
  const lv = levels || LV_SOFT;
  const cov = coverage === undefined ? 0.36 : coverage;
  fillTile(g, base);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      if (rand() > cov) continue;
      px(g, x, y, tone(base, pick(lv, rand)));
    }
  }
}

/* 稍大的色块斑块（MC 纹理里的"团块"感，比纯噪点更像原版） */
function patches(g, rand, count, base, amounts, minS, maxS) {
  for (let i = 0; i < count; i++) {
    const w = minS + ((rand() * (maxS - minS + 1)) | 0);
    const h = minS + ((rand() * (maxS - minS + 1)) | 0);
    const x = (rand() * (TILE - w + 1)) | 0;
    const y = (rand() * (TILE - h + 1)) | 0;
    rect(g, x, y, w, h, tone(base, pick(amounts, rand)));
  }
}

/* 随机散点（小石子、矿尘、杂质） */
function speckle(g, rand, count, colors, maxS) {
  const mx = maxS || 1;
  for (let i = 0; i < count; i++) {
    const s = mx > 1 && rand() < 0.3 ? 2 : 1;
    const x = (rand() * (TILE - s + 1)) | 0;
    const y = (rand() * (TILE - s + 1)) | 0;
    rect(g, x, y, s, s, pick(colors, rand));
  }
}

/* 椭圆团块；wrap=true 时跨边绕行（自然方块用），false 时裁掉（图标用） */
function blob(g, cx, cy, rx, ry, main, dark, light, wrap) {
  const put = wrap ? wrapPx : pxIn;
  const rxa = Math.max(0.6, rx), rya = Math.max(0.6, ry);
  for (let y = Math.floor(cy - rya) - 1; y <= Math.ceil(cy + rya) + 1; y++) {
    for (let x = Math.floor(cx - rxa) - 1; x <= Math.ceil(cx + rxa) + 1; x++) {
      const dx = (x + 0.5 - cx) / rxa, dy = (y + 0.5 - cy) / rya;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      let c = main;
      if (d > 0.72) c = dark;
      else if (dx + dy < -0.55) c = light;
      put(g, x, y, c);
    }
  }
}

/* 短线（裂纹、木纹、高光），整数步进，无抗锯齿 */
function line(g, x0, y0, x1, y1, color, wrap) {
  const put = wrap ? wrapPx : pxIn;
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    put(g, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), color);
  }
}

/* 周期性横线（左右无缝）；y 为若干行号 */
function hLines(g, rows, color, thickness) {
  for (let i = 0; i < rows.length; i++) rect(g, 0, rows[i], TILE, thickness || 1, color);
}

/* ============================================================
 * 调色板（接近 MC 原版的柔和饱和度）
 * ============================================================ */

const C = {
  /* 自然材质先控制平均色，再谈细节：低一档饱和度、收窄明暗噪声，
     让远处的地形先呈现清楚的色块，而不是整片高对比颗粒。 */
  grass: '#6f9645',
  grassDeep: '#5f813c',
  dirt: '#7b5c41',
  stone: '#7b7b77',
  stoneDark: '#5f5f5c',
  cobble: '#7f7f7c',
  bedrock: '#555552',
  sand: '#d6cd9d',
  sandstone: '#d3c894',
  gravel: '#837d78',
  water: '#3f6da3',
  snow: '#edf1f2',
  bark: '#6a563d',
  logTop: '#a48859',
  leaves: '#3f6c37',
  birch: '#cfcdc3',
  birchMark: '#37342f',
  planks: '#9a7b50',
  birchPlanks: '#d3bd91',
  brick: '#9e5f4b',
  brickMortar: '#513029',
  stoneBrick: '#828282',
  stoneBrickMortar: '#5d5d5d',
  /* 阶段 2 建材：先定平均色（花岗岩偏暖粉、闪长岩偏亮、安山岩中性偏绿），
     再谈细节 —— 与上面自然材质同一套做法，远处看是清楚的色块而不是灰糊。 */
  granite: '#9c6b5b',
  diorite: '#b3b1ac',
  andesite: '#7d7f79',
  smoothStone: '#8b8b88',
  /* 深板岩：比安山岩更冷更暗一档，地下里靠色相就能和浅部岩层分开（层理由 layeredRock 画） */
  deepslate: '#6b6b74',
  wool: '#eef0ee',
  coal: '#242424',
  iron: '#d8ad9d',
  gold: '#f0cf42',
  diamond: '#4ee0e0',
  emerald: '#22cc74',
  lapis: '#2a5fbf',
  obsidian: '#150f22',
  glow: '#d8a340',
  ironBlock: '#d8d8d8',
  goldBlock: '#eecb3d',
  diamondBlock: '#68d9d6',
  torchWood: '#7a5a34',
  path: '#7d6248',
  farmland: '#6b4c33',
  wheatGreen: '#5da03a',
  wheatGold: '#d9c04a',
  glassTint: '#bcd7e6',
  woodTool: '#8f6136',
  stoneTool: '#85898a',
  ironTool: '#b7c0c8',
  diamondTool: '#5fc4bc'
};

/* 明暗档位：普通材料不用满屏强对比噪声；基岩等少数材质才保留强档。 */
const LV_SOFT = [-0.025, 0, 0, 0.02, 0.035];
const LV_MID = [-0.075, -0.035, -0.035, 0, 0, 0.035, 0.065];
const LV_STRONG = [-0.22, -0.13, -0.07, -0.07, 0, 0, 0.06, 0.13, 0.20];

/* ============================================================
 * 基础 tile 复用块
 * ============================================================ */

function dirtTexture(g, rand) {
  /* 本轮 B：底色铺平 + 稀疏颗粒（覆盖率 0.34），让「土」由几块相连的斑块读出来，
     而不是 256 个像素各抖各的。档位也压窄一档。 */
  grainSparse(g, rand, C.dirt, [-0.035, -0.018, 0.02, 0.04], 0.34);
  /* 少量相连斑块负责“土”，散点只作补充，不再让每像素都抢着吸引视线。 */
  patches(g, rand, 4, C.dirt, [-0.06, -0.03, 0.03, 0.05], 2, 5);
  speckle(g, rand, 5, [tone(C.dirt, -0.08), tone(C.dirt, 0.07)], 1);
}

function stoneTexture(g, rand) {
  grainSparse(g, rand, C.stone, LV_SOFT, 0.30);
  patches(g, rand, 4, C.stone, [-0.04, -0.02, 0.02, 0.04], 3, 6);
  /* 短而连续的板岩纹理比均匀白噪点更容易辨认。 */
  for (let i = 0; i < 3; i++) {
    const x = (rand() * TILE) | 0, y = (rand() * TILE) | 0;
    const dx = 3 + ((rand() * 4) | 0), dy = rand() < 0.35 ? 0 : 1;
    line(g, x, y, x + dx, y + dy, tone(C.stone, -0.10), true);
  }
  speckle(g, rand, 4, [tone(C.stone, 0.07), tone(C.stone, -0.08)], 1);
}

function cobbleTexture(g, rand, mossy) {
  fillTile(g, tone(C.stone, -0.24));                     // 灰浆：比石块暗一档，但不是黑缝
  grain(g, rand, C.stoneDark, LV_SOFT);
  /* 9 块较大的圆石：块与块之间只留 1px 灰浆，远看是“砌块”而不是棋盘 */
  const stones = [
    [3.2, 2.8, 3.0, 2.2], [9.6, 2.6, 3.1, 2.1], [14.2, 3.6, 2.0, 2.4],
    [3.0, 8.6, 2.6, 2.8], [8.6, 8.2, 3.3, 2.9], [13.8, 9.2, 2.2, 2.6],
    [3.4, 14.0, 2.6, 1.8], [9.0, 13.8, 3.0, 1.9], [14.2, 14.2, 1.8, 1.8]
  ];
  for (const [cx, cy, rx, ry] of stones) {
    const v = -0.02 + rand() * 0.08;
    let main = tone(C.cobble, v);
    let light = tone(C.cobble, v + 0.12);
    let dark = tone(C.stone, -0.34);
    if (mossy && rand() < 0.4) {
      const gm = 0.45 + rand() * 0.35;
      main = mix(C.cobble, '#5c7a3a', gm);
      light = mix(tone(C.cobble, 0.12), '#7aa04d', gm);
      dark = mix(tone(C.stone, -0.34), '#3d5527', gm);
    }
    blob(g, cx, cy, rx, ry, main, dark, light, true);
    px(g, (cx - rx * 0.45) | 0, (cy - ry * 0.5) | 0, light);
  }
  if (mossy) speckle(g, rand, 10, [tone('#4f7a33', -0.08), tone('#5c8a3a', 0.1)], 1);
}

function planksTexture(g, rand) {
  /* 本轮 B：拆掉「编织纹」。
     旧画法在 16px 里画 4 条等高横板（接缝 y=3/7/11/15），每块板再补一条亮线（y=2/6/10/14）
     和一条竖接头（x 交替 5/13）—— 4×4 的等距格子 + 明暗双线，铺满墙面就读成布纹/编织。
     现在：
       · 板高不等（3/5/8），接缝深浅也分强弱，不再四等分；
       · 亮线只在局部出现（木纹高光），不横贯整格；
       · 竖接头只两处、位置不对称，其余板是整根通长；
       · 一枚木结（2×2 深色 + 一档亮边），近看有木料特征。
     16px 周期仍在，仍然四向无缝。 */
  grainSparse(g, rand, C.planks, [-0.03, -0.015, 0.015, 0.03], 0.34);
  const seam = (y, strong) => rect(g, 0, y, TILE, 1, tone(C.planks, strong ? -0.24 : -0.13));
  seam(3, true);
  seam(8, false);
  seam(11, true);
  seam(15, false);
  /* 木纹：长度不一的横向细纹，不横贯整格，避免形成等距横带 */
  for (let i = 0; i < 13; i++) {
    const y = (rand() * TILE) | 0;
    const x = (rand() * 9) | 0;
    const w = 3 + ((rand() * 6) | 0);
    rect(g, x, y, w, 1, tone(C.planks, rand() < 0.55 ? -0.05 : 0.045));
  }
  /* 竖向接头：两处，位置不对称，左右各一档明暗 */
  for (const [x, y0, y1] of [[6, 4, 7], [12, 12, 15]]) {
    rect(g, x, y0, 1, y1 - y0 + 1, tone(C.planks, -0.2));
    rect(g, x + 1, y0, 1, y1 - y0 + 1, tone(C.planks, 0.07));
  }
  /* 木结：一处，2×2 深色 + 上方一档亮边 */
  rect(g, 3, 9, 2, 2, tone(C.planks, -0.22));
  px(g, 4, 9, tone(C.planks, -0.32));
  px(g, 3, 8, tone(C.planks, 0.08));
  speckle(g, rand, 6, [tone(C.planks, -0.12), tone(C.planks, 0.1)], 1);
}

function oreTexture(g, rand, color) {
  stoneTexture(g, rand);
  const dark = tone(color, -0.34);
  const light = tone(color, 0.3);
  const clusters = 3 + ((rand() * 3) | 0);
  for (let i = 0; i < clusters; i++) {
    const cx = 2 + ((rand() * 12) | 0);
    const cy = 2 + ((rand() * 12) | 0);
    const rx = 1 + rand() * 1.3;
    const ry = 1 + rand() * 1.2;
    blob(g, cx, cy, rx, ry, color, dark, light, true);
    pxIn(g, cx - 1, cy - 1, light);
  }
}

/* ============================================================
 * 方块 painter 表
 * ============================================================ */

/* ---------- 阶段 2 建材共用的三个绘制器 ---------- */
/* 火成岩：底噪 + 密暗晶粒 + 少量亮晶粒；polish=true 时改为细颗粒并加一道很淡的横向抛光带。
   所有标记都避开最外圈（wrapPx 兜底），保证四向平铺不出现接缝。 */
function rockTexture(g, rand, base, dark, light, dense, polish) {
  grain(g, rand, base, polish ? LV_SOFT : LV_MID);
  patches(g, rand, polish ? 3 : 5, base, polish ? [-0.03, 0.035] : [-0.06, 0.06], 3, 6);
  const n = dense ? (polish ? 16 : 34) : (polish ? 12 : 22);
  for (let i = 0; i < n; i++) {
    const x = 1 + ((rand() * (TILE - 2)) | 0), y = 1 + ((rand() * (TILE - 2)) | 0);
    wrapPx(g, x, y, rand() < 0.62 ? dark : light);
    if (!polish && rand() < 0.35) wrapPx(g, x + 1, y, dark);
  }
  if (polish) {
    hLines(g, [5], tone(base, 0.07), 1);
    hLines(g, [10], tone(base, -0.05), 1);
  }
}

/* 深板岩族：它的可辨认特征是**水平层理**（原版深板岩一层一层的），不是火成岩那种均匀晶粒。
   层理周期 5 行 —— 暗缝放在 0/5/10/15（0 与 15 都是缝，上下平铺时正好接成一条连续缝，
   不会出现「半格错位」），亮面贴着缝上方一行。polish=true 时把层理压平、颗粒变细 → 磨制深板岩。 */
function layeredRock(g, rand, polish) {
  const base = C.deepslate;
  /* 本轮 B：层理改成**不等距、断续**。
     旧画法在 y=0/5/10/15 画满格暗线、y=1/6/11 再各配一条亮线 —— 16px 里四组等距
     「暗-亮」双线，铺成洞壁就是一层层平行的人工压痕（审计 15）。
     现在：暗线留在 0/6/13（不等距）、亮度只在一半位置出现，且每条线按段断开，
     再由零星的短裂纹补结构；近看仍是沉积岩，远看不再像瓦楞板。 */
  grainSparse(g, rand, base, polish ? LV_SOFT : [-0.05, -0.025, 0.025, 0.045], 0.30);
  patches(g, rand, polish ? 2 : 4, base, polish ? [-0.03, 0.03] : [-0.045, 0.04], 2, 5);
  const seam = (y, amount, gaps) => {
    for (let x = 0; x < TILE; x++) {
      if (gaps && ((x + y * 3) % 7) < 2) continue;
      px(g, x, y, tone(base, amount));
    }
  };
  seam(0, polish ? -0.08 : -0.15, false);
  seam(6, polish ? -0.07 : -0.13, true);
  seam(13, polish ? -0.06 : -0.12, true);
  if (!polish) {
    for (let x = 2; x < TILE; x += 6) px(g, x, 3, tone(base, 0.08));
    seam(9, 0.05, true);
  }
  speckle(g, rand, polish ? 5 : 8, [tone(base, -0.09), tone(base, 0.09)], 1);
}

/* 石砖族共用的无缝砖面（与 stone_bricks 同一套 4 行 / 竖缝周期 8 的骨架） */
function brickField(g, rand, base, mortar) {
  fillTile(g, mortar);
  for (let row = 0; row < 4; row++) {
    const y0 = row * 4;
    const joints = (row % 2 === 0) ? [1, 9] : [5, 13];
    for (let y = y0; y < y0 + 3; y++) {
      for (let x = 0; x < TILE; x++) px(g, x, y, tone(base, pick(LV_MID, rand)));
      for (let j = 0; j < joints.length; j++) {
        px(g, joints[j], y, mortar);
        px(g, joints[j] + 1, y, tone(base, 0.12));
      }
      px(g, 0, y, tone(base, -0.12));
    }
    rect(g, 0, y0, TILE, 1, tone(base, 0.08));
  }
}

/* 羊毛：近白底 + 极浅纤维短划，不用深色颗粒（否则远处像石头） */
function fibreTexture(g, rand, base) {
  grain(g, rand, base, [-0.02, -0.01, 0, 0, 0.015, 0.03]);
  for (let i = 0; i < 26; i++) {
    const x = 1 + ((rand() * (TILE - 3)) | 0), y = 1 + ((rand() * (TILE - 2)) | 0);
    const c = tone(base, rand() < 0.5 ? -0.05 : 0.045);
    wrapPx(g, x, y, c);
    if (rand() < 0.5) wrapPx(g, x + 1, y, c); else wrapPx(g, x, y + 1, c);
  }
}

export const blockPainters = {

  /* ---------- 自然 / 基础 ---------- */

  grass_top(g, rand) {
    /* 本轮 B：底色铺平 + 稀疏颗粒（0.32），草簇仍然是 2px 短块，
       但不再叠「满屏白噪点 + speckle 再抖一遍」——那样铺满山坡就是一层均匀颗粒。 */
    grainSparse(g, rand, C.grass, [-0.025, -0.012, 0.015, 0.028], 0.32);
    patches(g, rand, 5, C.grass, [-0.045, -0.018, 0.025, 0.045], 3, 5);
    /* 草簇用 2px 短块，不再撒满独立黑点；远看是一整块草，近看有细小起伏 */
    for (let i = 0; i < 7; i++) {
      const x = (rand() * (TILE - 1)) | 0, y = (rand() * (TILE - 1)) | 0;
      rect(g, x, y, 2, 1, tone(C.grass, rand() < 0.5 ? -0.03 : 0.04));
    }
    speckle(g, rand, 4, [tone(C.grass, 0.05), tone(C.grassDeep, 0.03)], 1);
  },

  grass_side(g, rand) {
    dirtTexture(g, rand);
    /* 顶部草皮 + 参差不齐的下缘（逐列随机 2~4 px），草沿之下先压一层深色土。
       本轮 B：去掉原来那条**横贯整格**的亮线 hLines([0], +0.08)。
       它让每一块草方块的侧面顶端都有一条一模一样的亮绿横线，山坡一梯一梯铺开时
       这些亮线连成长距离的水平亮带（审计 06/10/15 的「草皮横条」）。
       现在改成逐列 1 像素的草沿高光，且只有约 40% 的列点亮 —— 断开的草沿，
       远看仍是一条绿边，近看没有复制粘贴的水平直线。 */
    for (let x = 0; x < TILE; x++) {
      const d = 2 + ((rand() * 3) | 0);
      for (let y = 0; y < d; y++) {
        const lv = pick([-0.06, -0.02, 0, 0.035, 0.07], rand);
        px(g, x, y, tone(C.grass, lv));
      }
      px(g, x, d, tone(C.grassDeep, -0.04));
      if (rand() < 0.35) px(g, x, d + 1, tone(C.dirt, -0.10));
      if (rand() < 0.4) px(g, x, 0, tone(C.grass, 0.06));
    }
  },

  dirt(g, rand) { dirtTexture(g, rand); },

  stone(g, rand) { stoneTexture(g, rand); },

  cobblestone(g, rand) { cobbleTexture(g, rand, false); },

  mossy_cobblestone(g, rand) { cobbleTexture(g, rand, true); },

  bedrock(g, rand) {
    grain(g, rand, C.bedrock, LV_STRONG);
    for (let i = 0; i < 14; i++) {
      const cx = (rand() * TILE) | 0, cy = (rand() * TILE) | 0;
      const r = rand();
      blob(g, cx, cy, 1 + r * 2.4, 1 + r * 2.2,
        r < 0.45 ? tone(C.bedrock, -0.4) : tone(C.bedrock, 0.22),
        tone(C.bedrock, -0.5), tone(C.bedrock, 0.34), true);
    }
    speckle(g, rand, 30, [tone(C.bedrock, -0.45), '#2c2c2c', tone(C.bedrock, 0.26)], 2);
  },

  sand(g, rand) {
    grain(g, rand, C.sand, [-0.05, -0.02, 0, 0, 0.025, 0.055]);
    patches(g, rand, 4, C.sand, [-0.045, 0.035], 3, 6);
    speckle(g, rand, 8, [tone(C.sand, -0.10), tone(C.sand, 0.07)], 1);
  },

  sandstone(g, rand) {
    grain(g, rand, C.sandstone, LV_SOFT);
    /* 柔和横向层理，避开上下边缘以保持可平铺 */
    hLines(g, [4], tone(C.sandstone, -0.12), 1);
    hLines(g, [11], tone(C.sandstone, -0.09), 1);
    hLines(g, [7], tone(C.sandstone, 0.1), 1);
    patches(g, rand, 5, C.sandstone, [-0.05, 0.06], 3, 6);
  },

  gravel(g, rand) {
    grain(g, rand, C.gravel, LV_MID);
    for (let i = 0; i < 16; i++) {
      const cx = (rand() * TILE) | 0, cy = (rand() * TILE) | 0;
      const kind = rand();
      const col = kind < 0.35 ? '#9a9490' : kind < 0.6 ? '#6f6a66' : kind < 0.8 ? '#8d7f70' : '#a39b8c';
      blob(g, cx, cy, 1 + rand() * 1.6, 1 + rand() * 1.4,
        col, tone(col, -0.3), tone(col, 0.2), true);
    }
    speckle(g, rand, 22, ['#5d5854', '#a8a29a', '#7d6f60'], 1);
  },

  water(g, rand) {
    /* 第二轮 B1：水面贴图再降一档对比，改成「低对比、尺度协调的水纹」。
       第一轮把方向性长条换成了散点反光，但 10 个 1px 亮点 + 4 个暗点仍然是满屏碎屑，
       铺开以后远处被亮点噪声占满（复核 2-1 的「碎屑铺满」）。
       现在：底色铺平 → 稀疏颗粒（覆盖率 0.22、档位 ±0.02）→ 3 段 2~3px 的低对比横纹
       （水纹的“面”），只在最后放 2 个孤立反光点（水纹的“闪”）。 */
    grainSparse(g, rand, C.water, [-0.02, -0.01, 0.012, 0.022], 0.22);
    patches(g, rand, 5, C.water, [-0.03, 0.02, 0.035], 3, 6);
    /* 水纹：横纹而不是碎点，长度 2~4px、只比底色亮/暗一档 */
    for (let i = 0; i < 3; i++) {
      const y = 2 + ((rand() * 12) | 0);
      const x = (rand() * 12) | 0;
      const w = 2 + ((rand() * 3) | 0);
      rect(g, x, y, w, 1, tone(C.water, rand() < 0.6 ? 0.05 : -0.05));
      if (rand() < 0.5) px(g, (x + w) % TILE, y, tone(C.water, 0.03));
    }
    /* 只有两个孤立反光点，不构成网格 */
    for (let i = 0; i < 2; i++) {
      const x = (rand() * TILE) | 0, y = (rand() * TILE) | 0;
      px(g, x, y, tone('#8fb8e0', -0.02));
    }
  },

  snow_block(g, rand) {
    grain(g, rand, C.snow, [-0.05, -0.02, 0, 0, 0.03]);
    patches(g, rand, 5, C.snow, [-0.04, 0.04], 3, 5);
    speckle(g, rand, 12, [tone('#d5e2ea', 0), '#ffffff'], 1);
  },

  /* ---------- 木头 / 建材 ---------- */

  oak_log_top(g, rand) {
    grain(g, rand, C.logTop, LV_SOFT);
    /* 年轮：以中心为原点交替明暗环（顶面允许有树皮边框） */
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const dx = x - 7.5, dy = y - 7.5;
        const r = Math.sqrt(dx * dx + dy * dy);
        let c = null;
        if (r > 6.6) c = tone(C.bark, -0.08);
        else if (r > 5.6) c = tone(C.logTop, 0.14);
        else if (r > 4.6) c = tone(C.logTop, -0.16);
        else if (r > 3.2) c = tone(C.logTop, 0.08);
        else if (r > 2.2) c = tone(C.logTop, -0.14);
        else if (r > 1.0) c = tone(C.logTop, 0.06);
        else c = tone(C.logTop, -0.1);
        px(g, x, y, c);
      }
    }
    rect(g, 0, 0, TILE, 1, tone(C.bark, -0.18));
    rect(g, 0, TILE - 1, TILE, 1, tone(C.bark, -0.18));
    rect(g, 0, 0, 1, TILE, tone(C.bark, -0.18));
    rect(g, TILE - 1, 0, 1, TILE, tone(C.bark, -0.18));
    speckle(g, rand, 10, [tone(C.logTop, -0.2)], 1);
  },

  oak_log_side(g, rand) {
    grain(g, rand, C.bark, [-0.10, -0.05, -0.05, 0, 0, 0.05, 0.09]);
    /* 纵向树皮条纹：用 2~3px 的连续脊线，而不是每列随机断点 */
    let x = 0;
    while (x < TILE) {
      const w = 1 + ((rand() * 3) | 0);
      const c = tone(C.bark, rand() < 0.5 ? -0.16 : 0.08);
      const skip = rand() < 0.2;
      for (let k = 0; k < w && x + k < TILE; k++) {
        if (skip) continue;
        for (let y = 0; y < TILE; y++) {
          if (rand() < 0.92) px(g, x + k, y, c);
        }
      }
      x += w;
    }
    /* 两个树结：短横线打断纵向纹理 */
    for (let i = 0; i < 2; i++) {
      const ky = 3 + ((rand() * 9) | 0), kx = 3 + ((rand() * 8) | 0);
      rect(g, kx, ky, 3, 2, tone(C.bark, -0.24));
      px(g, kx, ky, tone(C.bark, 0.12));
    }
    speckle(g, rand, 7, [tone(C.bark, -0.22), tone(C.bark, 0.10)], 1);
  },

  oak_leaves(g, rand) {
    grain(g, rand, C.leaves, [-0.075, -0.04, -0.04, 0, 0, 0.03, 0.06]);
    patches(g, rand, 5, C.leaves, [-0.08, 0.05, 0.09], 3, 5);
    speckle(g, rand, 7, ['#355f2f', '#527b45'], 1);
    /* 叶簇：少量 2px 透空成簇出现，避免整面均匀镂成闪烁筛网 */
    const holes = 7 + ((rand() * 3) | 0);
    for (let i = 0; i < holes; i++) {
      const x = (rand() * TILE) | 0, y = (rand() * TILE) | 0;
      g.clearRect(x, y, 1, 1);
      if (rand() < 0.35) g.clearRect((x + 1) % TILE, y, 1, 1);
      if (rand() < 0.2) g.clearRect(x, (y + 1) % TILE, 1, 1);
    }
  },

  birch_log_side(g, rand) {
    grain(g, rand, C.birch, [-0.06, -0.03, 0, 0, 0.04]);
    for (let x = 0; x < TILE; x++) if (rand() < 0.3) line(g, x, 0, x, TILE - 1, tone(C.birch, -0.07), true);
    /* 桦树黑色"眼"与短横斑 */
    for (let i = 0; i < 5; i++) {
      const y = (rand() * TILE) | 0;
      const x = (rand() * (TILE - 4)) | 0;
      const w = 2 + ((rand() * 3) | 0);
      rect(g, x, y, w, 1, C.birchMark);
      px(g, x + w, y, tone(C.birchMark, 0.2));
      if (rand() < 0.5) px(g, x + 1, (y + 1) % TILE, tone(C.birchMark, -0.1));
    }
    speckle(g, rand, 14, [tone(C.birch, -0.14), '#f4f4f0'], 1);
  },

  planks(g, rand) { planksTexture(g, rand); },

  /* 阶段 7：桦木板。板缝周期与橡木板完全一致（y=3/7/11/15、竖缝周期 8），
     这样两种板混着铺也能无缝拼接；颜色改为浅米黄，节疤换成白桦式的浅灰短横纹，
     远看是一整块浅板、近看才分得出材质。不改动 planksTexture 本身。 */
  birch_planks(g, rand) {
    const base = C.birchPlanks;
    grain(g, rand, base, LV_MID);
    hLines(g, [3, 7, 11, 15], tone(base, -0.26), 1);
    hLines(g, [2, 6, 10, 14], tone(base, 0.1), 1);
    const rows = [[0, 3], [4, 7], [8, 11], [12, 15]];
    for (let i = 0; i < rows.length; i++) {
      const joint = (i % 2 === 0) ? 5 : 13;
      rect(g, joint, rows[i][0], 1, rows[i][1] - rows[i][0] + 1, tone(base, -0.24));
      rect(g, joint - 1, rows[i][0], 1, rows[i][1] - rows[i][0] + 1, tone(base, 0.1));
    }
    for (let i = 0; i < 6; i++) {
      const x = (rand() * 13) | 0, y = (rand() * 16) | 0;
      rect(g, x, y, 2, 1, tone(base, -0.18));
    }
    speckle(g, rand, 12, [tone(base, -0.14), tone(base, 0.12)], 1);
  },

  brick(g, rand) {
    fillTile(g, C.brickMortar);
    /* 砖缝周期 4（y=3,7,11,15）与 8（竖缝），四向无缝 */
    for (let row = 0; row < 4; row++) {
      const y0 = row * 4;
      const off = (row % 2) * 4;
      for (let b = 0; b < 2; b++) {
        const x0 = off + b * 8;
        for (let y = y0; y < y0 + 3; y++) {
          for (let x = x0; x < x0 + 7; x++) {
            const xx = x % TILE;
            px(g, xx, y, tone(C.brick, pick([-0.1, -0.04, 0, 0.05, 0.1], rand)));
          }
        }
        rect(g, x0 % TILE, y0, 1, 3, tone(C.brick, 0.14));
      }
    }
    speckle(g, rand, 18, [tone(C.brick, -0.2), tone(C.brickMortar, 0.18)], 1);
  },

  stone_bricks(g, rand) {
    /* 砖缝行 y=3,7,11,15、竖缝周期 8 —— 四向无缝 */
    fillTile(g, C.stoneBrickMortar);
    for (let row = 0; row < 4; row++) {
      const y0 = row * 4;
      const joints = (row % 2 === 0) ? [1, 9] : [5, 13];
      for (let y = y0; y < y0 + 3; y++) {
        for (let x = 0; x < TILE; x++) px(g, x, y, tone(C.stoneBrick, pick(LV_MID, rand)));
        for (let j = 0; j < joints.length; j++) {
          px(g, joints[j], y, C.stoneBrickMortar);
          px(g, joints[j] + 1, y, tone(C.stoneBrick, 0.12));
        }
        px(g, 0, y, tone(C.stoneBrick, -0.12));
      }
      rect(g, 0, y0, TILE, 1, tone(C.stoneBrick, 0.08));
    }
    speckle(g, rand, 16, [tone(C.stoneBrick, -0.2), tone(C.stoneBrick, 0.16)], 1);
  },

  /* ---------- 阶段 2 建材扩充（14 种，彼此要能一眼分开） ---------- */

  granite(g, rand) { rockTexture(g, rand, C.granite, tone(C.granite, -0.34), tone(C.granite, 0.2), true, false); },
  polished_granite(g, rand) { rockTexture(g, rand, C.granite, tone(C.granite, -0.2), tone(C.granite, 0.16), true, true); },
  diorite(g, rand) { rockTexture(g, rand, C.diorite, tone(C.diorite, -0.3), '#e6e5e1', false, false); },
  polished_diorite(g, rand) { rockTexture(g, rand, C.diorite, tone(C.diorite, -0.16), '#eae9e5', false, true); },
  andesite(g, rand) { rockTexture(g, rand, C.andesite, tone(C.andesite, -0.28), tone(C.andesite, 0.16), false, false); },
  polished_andesite(g, rand) { rockTexture(g, rand, C.andesite, tone(C.andesite, -0.17), tone(C.andesite, 0.13), false, true); },

  /* ---------- 阶段 1 深板岩族（层理质感，刻意与火成岩的均匀晶粒分开） ---------- */

  deepslate(g, rand) { layeredRock(g, rand, false); },
  polished_deepslate(g, rand) { layeredRock(g, rand, true); },

  smooth_stone(g, rand) {
    /* 熔炼过的石头：几乎没有团块，只有很浅的横向抛光带 */
    grain(g, rand, C.smoothStone, LV_SOFT);
    hLines(g, [3], tone(C.smoothStone, 0.05), 1);
    hLines(g, [11], tone(C.smoothStone, -0.05), 1);
    speckle(g, rand, 6, [tone(C.smoothStone, -0.1), tone(C.smoothStone, 0.08)], 1);
  },

  mossy_stone_bricks(g, rand) {
    brickField(g, rand, C.stoneBrick, C.stoneBrickMortar);
    /* 苔藓从两个角长出来，中间仍留砖面，避免整块变绿看不出是石砖 */
    patches(g, rand, 4, C.grass, [-0.06, -0.02, 0.04], 2, 4);
    for (let i = 0; i < 12; i++) {
      const x = (rand() * TILE) | 0, y = (rand() * TILE) | 0;
      wrapPx(g, x, y, tone(C.grassDeep, rand() < 0.5 ? -0.04 : 0.05));
    }
  },

  cracked_stone_bricks(g, rand) {
    brickField(g, rand, tone(C.stoneBrick, -0.02), C.stoneBrickMortar);
    /* 裂纹：从砖缝起笔的 1px 折线，避开外圈以保持平铺 */
    for (let k = 0; k < 4; k++) {
      let x = 2 + ((rand() * 12) | 0), y = 2 + ((rand() * 12) | 0);
      const len = 4 + ((rand() * 5) | 0);
      for (let i = 0; i < len; i++) {
        pxIn(g, x, y, tone(C.stoneBrick, -0.3));
        x += rand() < 0.5 ? 1 : 0;
        y += rand() < 0.6 ? 1 : -1;
        if (x < 1 || x > 14 || y < 1 || y > 14) break;
      }
    }
  },

  chiseled_stone_bricks(g, rand) {
    brickField(g, rand, C.stoneBrick, C.stoneBrickMortar);
    /* 中央雕纹：一圈凹进去的方框 + 十字，跟「普通石砖」一眼分得开 */
    rect(g, 4, 4, 8, 1, tone(C.stoneBrick, -0.24));
    rect(g, 4, 11, 8, 1, tone(C.stoneBrick, 0.12));
    rect(g, 4, 4, 1, 8, tone(C.stoneBrick, -0.24));
    rect(g, 11, 4, 1, 8, tone(C.stoneBrick, 0.12));
    rect(g, 7, 5, 2, 6, tone(C.stoneBrick, -0.14));
    rect(g, 5, 7, 6, 2, tone(C.stoneBrick, -0.14));
  },

  smooth_sandstone(g, rand) {
    grain(g, rand, tone(C.sandstone, 0.03), LV_SOFT);
    hLines(g, [2], tone(C.sandstone, -0.06), 1);
    speckle(g, rand, 5, [tone(C.sandstone, -0.07)], 1);
  },

  chiseled_sandstone(g, rand) {
    grain(g, rand, C.sandstone, LV_SOFT);
    /* 雕面：中央菱形 + 四角暗点，保持砂岩的横向层理 */
    hLines(g, [4, 11], tone(C.sandstone, -0.1), 1);
    for (let i = 0; i < 5; i++) {
      pxIn(g, 8 + i, 8 - i, tone(C.sandstone, -0.2));
      pxIn(g, 8 - i, 8 - i, tone(C.sandstone, -0.2));
      pxIn(g, 8 + i, 8 + i, tone(C.sandstone, 0.1));
      pxIn(g, 8 - i, 8 + i, tone(C.sandstone, 0.1));
    }
    speckle(g, rand, 4, [tone(C.sandstone, -0.12)], 1);
  },

  cut_sandstone(g, rand) {
    /* 切制：把整块切成 2×2 的小方块，切缝比砂岩层理更硬更直 */
    grain(g, rand, tone(C.sandstone, 0.01), LV_SOFT);
    rect(g, 7, 0, 2, TILE, tone(C.sandstone, -0.16));
    rect(g, 0, 7, TILE, 2, tone(C.sandstone, -0.16));
    rect(g, 8, 0, 1, TILE, tone(C.sandstone, 0.12));
    rect(g, 0, 8, TILE, 1, tone(C.sandstone, 0.12));
    speckle(g, rand, 8, [tone(C.sandstone, -0.09), tone(C.sandstone, 0.07)], 1);
  },

  wool_block(g, rand) { fibreTexture(g, rand, C.wool); },

  /* ---------- 矿石 ---------- */

  coal_ore(g, rand) { oreTexture(g, rand, C.coal); },
  iron_ore(g, rand) { oreTexture(g, rand, C.iron); },
  gold_ore(g, rand) { oreTexture(g, rand, C.gold); },
  diamond_ore(g, rand) { oreTexture(g, rand, C.diamond); },
  emerald_ore(g, rand) { oreTexture(g, rand, C.emerald); },
  lapis_ore(g, rand) { oreTexture(g, rand, C.lapis); },

  obsidian(g, rand) {
    grain(g, rand, C.obsidian, [-0.24, -0.12, 0, 0, 0.06, 0.12]);
    for (let i = 0; i < 9; i++) {
      const cx = (rand() * TILE) | 0, cy = (rand() * TILE) | 0;
      blob(g, cx, cy, 1 + rand() * 2, 1 + rand() * 1.8,
        mix(C.obsidian, '#241844', 0.35 + rand() * 0.35), '#05040a', '#2c2150', true);
    }
    speckle(g, rand, 12, ['#05040a', '#332457', '#5a4796'], 1);
  },

  /* ---------- 功能方块（有方向性，允许边框/图案） ---------- */

  crafting_table_top(g, rand) {
    planksTexture(g, rand);
    const frame = tone(C.bark, -0.28);
    rect(g, 0, 0, TILE, 1, frame);
    rect(g, 0, TILE - 1, TILE, 1, frame);
    rect(g, 0, 0, 1, TILE, frame);
    rect(g, TILE - 1, 0, 1, TILE, frame);
    /* 九宫格刻线 */
    for (const p of [5, 10]) {
      rect(g, p, 2, 1, TILE - 4, tone(C.planks, -0.34));
      rect(g, 2, p, TILE - 4, 1, tone(C.planks, -0.34));
      rect(g, p + 1, 2, 1, TILE - 4, tone(C.planks, 0.12));
      rect(g, 2, p + 1, TILE - 4, 1, tone(C.planks, 0.12));
    }
    speckle(g, rand, 12, [tone(C.planks, -0.2)], 1);
  },

  crafting_table_front(g, rand) {
    planksTexture(g, rand);
    rect(g, 0, 0, TILE, 2, tone(C.bark, -0.24));
    rect(g, 0, 2, TILE, 1, tone(C.bark, 0.1));
    /* 左侧：锯子（竖直锯条 + 木柄） */
    rect(g, 3, 5, 2, 8, '#c9ccd0');
    rect(g, 3, 5, 1, 8, '#eef1f4');
    for (let i = 0; i < 4; i++) px(g, 5, 7 + i * 2, '#aeb2b7');
    rect(g, 3, 3, 2, 2, tone(C.woodTool, 0.12));
    /* 右侧：锤子 */
    rect(g, 9, 4, 5, 3, '#b9bdc2');
    rect(g, 9, 4, 5, 1, '#dee2e6');
    rect(g, 11, 7, 2, 7, tone(C.woodTool, -0.08));
    rect(g, 11, 7, 1, 7, tone(C.woodTool, 0.14));
    rect(g, 0, TILE - 2, TILE, 2, tone(C.bark, -0.3));
  },

  crafting_table_side(g, rand) {
    planksTexture(g, rand);
    rect(g, 0, 0, TILE, 2, tone(C.bark, -0.24));
    rect(g, 0, 2, TILE, 1, tone(C.bark, 0.1));
    rect(g, 0, TILE - 2, TILE, 2, tone(C.bark, -0.3));
    /* 木钉与刻痕 */
    px(g, 4, 6, tone(C.planks, -0.3));
    px(g, 11, 6, tone(C.planks, -0.3));
    px(g, 4, 11, tone(C.planks, -0.3));
    px(g, 11, 11, tone(C.planks, -0.3));
    rect(g, 2, 8, 12, 1, tone(C.planks, -0.16));
    speckle(g, rand, 10, [tone(C.planks, 0.14)], 1);
  },

  furnace_top(g, rand) {
    stoneTexture(g, rand);
    const d = tone(C.stone, -0.34);
    rect(g, 2, 2, 12, 1, d);
    rect(g, 2, 13, 12, 1, d);
    rect(g, 2, 2, 1, 12, d);
    rect(g, 13, 2, 1, 12, d);
    rect(g, 4, 5, 8, 6, tone(C.stone, -0.12));
    speckle(g, rand, 8, [tone(C.stone, -0.4), tone(C.stone, 0.18)], 1);
  },

  furnace_side(g, rand) {
    stoneTexture(g, rand);
    rect(g, 0, 0, TILE, 1, tone(C.stone, -0.26));
    rect(g, 0, TILE - 1, TILE, 1, tone(C.stone, -0.3));
    for (let y = 4; y < 13; y += 3) {
      rect(g, 3, y, 2, 1, tone(C.stone, -0.3));
      rect(g, 11, y, 2, 1, tone(C.stone, -0.3));
    }
    speckle(g, rand, 8, [tone(C.stone, 0.16)], 1);
  },

  furnace_front(g, rand) { furnaceFace(g, rand, false); },
  furnace_front_lit(g, rand) { furnaceFace(g, rand, true); },

  glowstone(g, rand) {
    grain(g, rand, C.glow, [-0.14, -0.06, 0, 0.06, 0.12]);
    for (let i = 0; i < 9; i++) {
      const cx = (rand() * TILE) | 0, cy = (rand() * TILE) | 0;
      blob(g, cx, cy, 1 + rand() * 1.8, 1 + rand() * 1.6,
        tone('#8a5c25', rand() * 0.2), tone('#5c3a14', 0), tone(C.glow, 0.2), true);
    }
    speckle(g, rand, 26, ['#fff0b8', '#ffe08a', '#f7c65c'], 1);
    rect(g, 0, 0, TILE, 1, tone(C.glow, 0.16));
    rect(g, 0, TILE - 1, TILE, 1, tone(C.glow, -0.18));
    rect(g, 0, 0, 1, TILE, tone(C.glow, 0.1));
    rect(g, TILE - 1, 0, 1, TILE, tone(C.glow, -0.12));
  },

  glass(g, rand) {
    clearTile(g, TILE);
    void rand;
    const t = toRGB(C.glassTint);
    const edge = rgba(t[0], t[1], t[2], 0.92);
    const edgeSoft = rgba(t[0], t[1], t[2], 0.5);
    const hi = rgba(232, 244, 252, 0.85);
    rect(g, 0, 0, TILE, 1, edge);
    rect(g, 0, TILE - 1, TILE, 1, edgeSoft);
    rect(g, 0, 0, 1, TILE, edge);
    rect(g, TILE - 1, 0, 1, TILE, edgeSoft);
    /* 少量高光斜线（纯像素，不做模糊） */
    for (let i = 0; i < 4; i++) line(g, 3 + i, 12 - i * 2, 5 + i, 10 - i * 2, hi, false);
    line(g, 10, 4, 12, 2, rgba(232, 244, 252, 0.7), false);
    px(g, 3, 3, rgba(t[0] + 20, t[1] + 12, t[2] + 10, 0.5));
    px(g, 12, 11, rgba(t[0], t[1], t[2], 0.4));
  },

  iron_block(g, rand) { metalBlock(g, rand, C.ironBlock, false); },
  gold_block(g, rand) { metalBlock(g, rand, C.goldBlock, false); },
  diamond_block(g, rand) { metalBlock(g, rand, C.diamondBlock, true); },

  torch(g, rand) {
    clearTile(g, TILE);
    /* 木柄（下半） */
    rect(g, 7, 7, 2, 9, C.torchWood);
    rect(g, 7, 7, 1, 9, tone(C.torchWood, 0.16));
    rect(g, 8, 7, 1, 9, tone(C.torchWood, -0.2));
    px(g, 7, 15, tone(C.torchWood, -0.3));
    /* 火焰（顶部），四周保持透明 */
    rect(g, 6, 4, 4, 3, '#ff9d24');
    rect(g, 7, 2, 2, 3, '#ffc23a');
    rect(g, 7, 3, 2, 2, '#ffe98a');
    px(g, 7, 4, '#fff6cf');
    px(g, 6, 6, tone('#ff9d24', -0.2));
    px(g, 9, 6, tone('#ff9d24', -0.2));
    px(g, 8, 1, '#ffd45c');
    speckle(g, rand, 3, ['rgba(255,220,120,0.55)'], 1);
  },

  /* ---------- 路径 / 耕地 / 小麦 ---------- */

  dirt_path_top(g, rand) {
    grain(g, rand, C.path, LV_MID);
    patches(g, rand, 8, C.path, [-0.14, 0.1, 0.2], 2, 4);
    speckle(g, rand, 22, [tone('#a3866a', 0), tone(C.dirt, -0.2), '#8f8a7a'], 1);
    for (let i = 0; i < 4; i++) {
      const x = (rand() * TILE) | 0, y = (rand() * TILE) | 0;
      line(g, x, y, x + 2, y, tone('#6b5a44', -0.1), true);
    }
  },

  farmland(g, rand) {
    grain(g, rand, C.farmland, LV_MID);
    /* 4px 周期的垄：上亮下暗，上下可无缝 */
    for (let band = 0; band < 4; band++) {
      const y0 = band * 4;
      rect(g, 0, y0, TILE, 1, tone(C.farmland, 0.16));
      rect(g, 0, y0 + 1, TILE, 1, tone(C.farmland, 0.04));
      rect(g, 0, y0 + 2, TILE, 1, tone(C.farmland, -0.14));
      rect(g, 0, y0 + 3, TILE, 1, tone(C.farmland, -0.26));
    }
    speckle(g, rand, 16, [tone(C.dirt, -0.16), tone(C.farmland, 0.2)], 1);
  },

  farmland_wet(g, rand) {
    /* T1 湿润耕地：同一套垄纹，整体压暗并偏冷，与水边耕地对应 */
    const col = tone(C.farmland, -0.24);
    grain(g, rand, col, LV_MID);
    for (let band = 0; band < 4; band++) {
      const y0 = band * 4;
      rect(g, 0, y0, TILE, 1, tone(col, 0.14));
      rect(g, 0, y0 + 1, TILE, 1, tone(col, 0.02));
      rect(g, 0, y0 + 2, TILE, 1, tone(col, -0.14));
      rect(g, 0, y0 + 3, TILE, 1, tone(col, -0.28));
    }
    speckle(g, rand, 14, [tone(col, -0.18), '#3f5560'], 1);
  },

  /* ---------- T2 床（俯视枕头+红毯；侧面毯子压木板） ---------- */
  bed_top(g, rand) {
    grain(g, rand, '#eceadf', LV_MID);
    rect(g, 0, 0, TILE, 4, '#f7f5ee');                /* 枕头端 */
    rect(g, 0, 3, TILE, 1, '#d3ccbd');
    rect(g, 0, 5, TILE, 10, '#b4322c');               /* 红毯 */
    rect(g, 0, 5, TILE, 1, '#cf4a41');
    rect(g, 0, 14, TILE, 1, '#7d211d');
    line(g, 0, 10, TILE, 10, '#9c2a24', true);
    pxIn(g, 2, 1, '#ffffff'); pxIn(g, 12, 2, '#ffffff');
  },
  bed_side(g, rand) {
    grain(g, rand, '#b4322c', LV_MID);
    rect(g, 0, 0, TILE, 2, '#cf4a41');
    rect(g, 0, 2, TILE, 8, '#a82d27');
    rect(g, 0, 10, TILE, 2, '#8a5a34');               /* 木板床脚 */
    rect(g, 0, 12, TILE, 4, '#77492b');
    pxIn(g, 3, 12, '#8a5a34'); pxIn(g, 11, 13, '#8a5a34');
    pxIn(g, 0, 1, '#e06a60'); pxIn(g, 15, 1, '#e06a60');
  },
  bed_front(g, rand) {
    grain(g, rand, '#8a5a34', LV_MID);                /* 床头板 */
    rect(g, 0, 0, TILE, 6, '#9c6b3c');
    rect(g, 0, 6, TILE, 1, '#6b4526');
    rect(g, 2, 8, 12, 6, '#eceadf');                  /* 露出的白枕头 */
    rect(g, 2, 8, 12, 1, '#f7f5ee');
    pxIn(g, 4, 2, '#a97a48'); pxIn(g, 10, 3, '#a97a48');
    pxIn(g, 5, 11, '#d3ccbd');
  },

  wheat_0(g, rand) { wheatStage(g, rand, 0); },
  wheat_1(g, rand) { wheatStage(g, rand, 1); },
  wheat_2(g, rand) { wheatStage(g, rand, 2); },

  /* ---------- 第二阶段补充：树苗 / 箱子 / 装饰植物 / 仙人掌 / 南瓜 / 蘑菇 / 南瓜灯 ---------- */

  sapling_oak(g, rand) {
    clearTile(g);
    rect(g, 7, 9, 2, 7, C.torchWood);
    rect(g, 7, 9, 1, 7, tone(C.torchWood, 0.18));
    leafSprig(g, rand, C.leaves, tone(C.leaves, 0.22));
  },

  sapling_birch(g, rand) {
    clearTile(g);
    rect(g, 7, 9, 2, 7, '#c9c4b4');
    rect(g, 8, 9, 1, 7, '#8f8b7d');
    leafSprig(g, rand, '#7fb84a', '#a8d873');
  },

  /* T5 TNT：红色炸药块 + 白色 TNT 字带 + 深色包边；六面共用同一张贴图 */
  tnt(g, rand) {
    const red = '#b33a32', redL = '#c94b41', redD = '#8f2a25', deep = '#6b1d19';
    grain(g, rand, red, [-0.08, -0.03, 0, 0.04, 0.08]);
    rect(g, 0, 0, TILE, 1, redD);
    rect(g, 0, 15, TILE, 1, deep);
    rect(g, 0, 0, 1, TILE, redL);
    rect(g, 15, 0, 1, TILE, redD);
    // 白色标签带
    rect(g, 1, 5, 14, 6, '#e9e4d8');
    rect(g, 1, 10, 14, 1, '#c9c2b4');
    // TNT 三个字母（3×5 像素，粗体）
    const ink = '#3a2b27';
    const letterT = (x) => {
      rect(g, x, 6, 3, 1, ink);
      rect(g, x + 1, 6, 1, 4, ink);
    };
    letterT(2);
    // N
    rect(g, 6, 6, 1, 4, ink);
    rect(g, 7, 7, 1, 2, ink);
    rect(g, 8, 6, 1, 4, ink);
    letterT(10);
    // 顶部引信口
    rect(g, 7, 0, 2, 2, '#4a3a2e');
    pxIn(g, 8, 1, '#d8b45a');
    // 铆钉/磨损
    pxIn(g, 2, 3, redD); pxIn(g, 13, 3, redL);
    pxIn(g, 2, 13, deep); pxIn(g, 13, 13, deep);
  },

  /* T6 粘液块：半透明感果冻绿 + 内层方块纹 + 高光 */
  slime_block(g, rand) {
    const base = '#63b85a', deep = '#3f8b3d', light = '#8ad77c', glow = '#b6ef9f';
    grain(g, rand, base, [-0.06, -0.02, 0.02, 0.06]);
    rect(g, 0, 0, TILE, 1, deep);
    rect(g, 0, 15, TILE, 1, deep);
    rect(g, 0, 0, 1, TILE, light);
    rect(g, 15, 0, 1, TILE, deep);
    // 内层果冻块（错位的 4×4 方格）
    for (let y = 3; y < 14; y += 5) {
      for (let x = 3; x < 14; x += 5) {
        rect(g, x, y, 3, 3, deep);
        pxIn(g, x, y, light);
        pxIn(g, x + 2, y + 2, glow);
      }
    }
    speckle(g, rand, 8, [light, deep, glow], 1);
    pxIn(g, 2, 2, glow); pxIn(g, 13, 2, light);
  },

  /* T6 木门：上下两半；竖木板 + 深色门框 + 铁把手 */
  door_lower(g, rand) {
    const wood = '#9a7b50', dark = '#6d5232', light = '#b9925f', ink = '#4a3722';
    grain(g, rand, wood, [-0.06, -0.02, 0.02, 0.06]);
    rect(g, 0, 0, TILE, 1, dark);
    rect(g, 0, 15, TILE, 1, dark);
    rect(g, 0, 0, 2, TILE, dark);
    rect(g, 14, 0, 2, TILE, dark);
    for (const x of [5, 10]) rect(g, x, 1, 1, 14, ink);
    rect(g, 3, 4, 2, 6, light);
    rect(g, 11, 9, 2, 5, light);
    // 铁把手（靠右）
    rect(g, 11, 6, 2, 2, '#d9dde2');
    pxIn(g, 11, 6, '#f5f7f9');
    pxIn(g, 12, 8, '#8d949d');
  },
  door_upper(g, rand) {
    const wood = '#9a7b50', dark = '#6d5232', light = '#b9925f', ink = '#4a3722';
    grain(g, rand, wood, [-0.06, -0.02, 0.02, 0.06]);
    rect(g, 0, 0, TILE, 1, dark);
    rect(g, 0, 15, TILE, 1, dark);
    rect(g, 0, 0, 2, TILE, dark);
    rect(g, 14, 0, 2, TILE, dark);
    rect(g, 4, 3, 8, 4, dark);
    rect(g, 5, 4, 6, 2, '#8b6c45');
    rect(g, 4, 9, 8, 4, dark);
    rect(g, 5, 10, 6, 2, '#8b6c45');
    rect(g, 7, 5, 2, 2, light);
    pxIn(g, 5, 9, ink); pxIn(g, 10, 9, ink);
  },

  chest_top(g, rand) {
    woodBase(g, rand, C.planks);
    rect(g, 0, 0, TILE, 3, tone(C.planks, -0.28));
    rect(g, 6, 3, 4, 5, tone(C.planks, -0.4));
    rect(g, 7, 5, 2, 2, '#c9a227');
    px(g, 8, 6, '#5b4a12');
  },

  chest_side(g, rand) {
    chestBody(g, rand, false);
  },

  chest_front(g, rand) {
    chestBody(g, rand, true);
  },

  tall_grass(g, rand) {
    clearTile(g);
    for (let i = 0; i < 9; i++) {
      const x = 1 + ((rand() * 14) | 0);
      const h = 5 + ((rand() * 8) | 0);
      const col = pick([C.grass, C.grassDeep, tone(C.grass, 0.18)], rand);
      for (let k = 0; k < h; k++) pxIn(g, x + (k > h - 3 ? (rand() < 0.5 ? -1 : 1) : 0), TILE - 1 - k, col);
    }
  },

  poppy(g, rand) {
    clearTile(g);
    stem(g, rand, C.grassDeep);
    petal(g, '#c93b3b', '#e8635c', '#8f2626');
  },

  dandelion(g, rand) {
    clearTile(g);
    stem(g, rand, C.grass);
    petal(g, '#e8c93a', '#fbe97a', '#a8892a');
  },

  dead_bush(g, rand) {
    clearTile(g);
    const col = '#8a6b3a';
    line(g, 8, 15, 8, 7, col, false);
    line(g, 8, 11, 4, 6, tone(col, -0.15), false);
    line(g, 8, 11, 12, 6, tone(col, 0.12), false);
    line(g, 8, 8, 6, 3, col, false);
    line(g, 8, 8, 10, 3, tone(col, -0.2), false);
    pxIn(g, 4, 6, col); pxIn(g, 12, 6, col); pxIn(g, 6, 3, col); pxIn(g, 10, 3, col);
  },

  cactus_top(g, rand) {
    grain(g, rand, '#4f8a3c', LV_MID);
    rect(g, 4, 4, 8, 8, tone('#4f8a3c', 0.16));
    rect(g, 6, 6, 4, 4, tone('#4f8a3c', 0.3));
    speckle(g, rand, 10, ['#e8e2b8', '#3c6b2c'], 1);
  },

  cactus_side(g, rand) {
    grain(g, rand, '#3f7a31', LV_MID);
    rect(g, 0, 0, 2, TILE, tone('#3f7a31', -0.22));
    rect(g, 14, 0, 2, TILE, tone('#3f7a31', -0.22));
    rect(g, 3, 0, 2, TILE, tone('#3f7a31', 0.16));
    rect(g, 11, 0, 2, TILE, tone('#3f7a31', 0.16));
    for (let y = 1; y < TILE; y += 4) {
      pxIn(g, 6, y, '#e6e0b0'); pxIn(g, 9, y + 2, '#e6e0b0');
    }
  },

  pumpkin_top(g, rand) {
    pumpkinTop(g, rand);
  },

  pumpkin_side(g, rand) {
    pumpkinSide(g, rand);
  },

  /* 注意：这个对象里的方法被 dispatch() 以 fn(g, rand, size) 直接调用，
     `this` 在严格模式下是 undefined。想「复用另一张画笔」必须走下面这些
     函数级 helper（pumpkinSide / pumpkinTop / lampSide），不能写 pumpkin_side(g, rand) ——
     那是一个不存在的自由变量，会抛 ReferenceError 被 dispatch 的 catch 吃掉，
     整面贴图变成品红 missing（本轮修的就是这个）。 */
  pumpkin_front(g, rand) {
    pumpkinSide(g, rand);
    carveFace(g, '#3a2408');
  },

  mushroom_brown_block(g, rand) {
    clearTile(g);
    mushroomSprite(g, rand, '#8a6248', '#b98a68', '#e8dcc8');
  },

  mushroom_red_block(g, rand) {
    clearTile(g);
    mushroomSprite(g, rand, '#c0392b', '#e05a48', '#f2e6d8');
  },

  lamp_top(g, rand) {
    pumpkinTop(g, rand);
    rect(g, 5, 5, 6, 6, '#f0b428');
    pxIn(g, 7, 7, '#fff0a8'); pxIn(g, 8, 8, '#fff0a8');
  },

  lamp_side(g, rand) {
    lampSide(g, rand);
  },

  lamp_front(g, rand) {
    lampSide(g, rand);
    rect(g, 3, 9, 10, 1, '#5b3a10');
  }
};

/* ---------- 南瓜 / 南瓜灯的可复用画法（对象方法之间不能互相调用，见上方注释） ---------- */

function pumpkinTop(g, rand) {
  grain(g, rand, '#c9832f', LV_MID);
  for (let x = 1; x < TILE; x += 4) rect(g, x, 0, 1, TILE, tone('#c9832f', -0.16));
  rect(g, 6, 6, 4, 4, '#6f8a3a');
  rect(g, 7, 7, 2, 2, '#8fae4d');
}

function pumpkinSide(g, rand) {
  grain(g, rand, '#d18a32', LV_MID);
  for (let x = 1; x < TILE; x += 4) rect(g, x, 0, 1, TILE, tone('#d18a32', -0.2));
  rect(g, 0, 0, TILE, 2, tone('#d18a32', 0.14));
}

function lampSide(g, rand) {
  grain(g, rand, '#e09a2c', LV_MID);
  for (let x = 1; x < TILE; x += 4) rect(g, x, 0, 1, TILE, tone('#e09a2c', -0.18));
  rect(g, 2, 4, 3, 3, '#5b3a10');
  rect(g, 11, 4, 3, 3, '#5b3a10');
  rect(g, 5, 10, 6, 3, '#5b3a10');
  rect(g, 6, 4, 1, 1, '#ffe08a');
  rect(g, 12, 4, 1, 1, '#ffe08a');
}

/* ---------- 新增画笔的内部实现 ---------- */

function woodBase(g, rand, base) {
  grain(g, rand, base, LV_MID);
  patches(g, rand, 6, base, [-0.12, 0.1, 0.2], 2, 4);
  for (let y = 3; y < TILE; y += 5) rect(g, 0, y, TILE, 1, tone(base, -0.24));
}

function chestBody(g, rand, withLatch) {
  woodBase(g, rand, C.planks);
  rect(g, 0, 0, TILE, 4, tone(C.planks, -0.2));          // 箱盖
  rect(g, 0, 4, TILE, 1, tone(C.planks, -0.42));         // 盖缝
  rect(g, 0, 0, TILE, 1, tone(C.planks, 0.16));
  rect(g, 0, 14, TILE, 2, tone(C.planks, -0.3));
  rect(g, 0, 0, 1, TILE, tone(C.planks, -0.3));
  rect(g, 15, 0, 1, TILE, tone(C.planks, -0.3));
  if (withLatch) {
    rect(g, 7, 2, 2, 6, '#3b2c18');
    rect(g, 7, 2, 2, 1, '#c9a227');
    px(g, 8, 5, '#e8c85a');
  }
}

function leafSprig(g, rand, main, light) {
  for (let i = 0; i < 16; i++) {
    const x = 3 + ((rand() * 10) | 0), y = 2 + ((rand() * 8) | 0);
    pxIn(g, x, y, rand() < 0.35 ? light : main);
    pxIn(g, x + 1, y, main);
  }
  rect(g, 5, 4, 6, 4, main);
  rect(g, 6, 3, 4, 1, light);
  pxIn(g, 4, 6, tone(main, -0.2)); pxIn(g, 11, 5, tone(main, -0.2));
}

function stem(g, rand, col) {
  rect(g, 7, 8, 2, 8, col);
  rect(g, 7, 8, 1, 8, tone(col, 0.15));
  pxIn(g, 5, 11, col); pxIn(g, 10, 13, col);
  line(g, 7, 12, 5, 10, col, false);
  line(g, 9, 14, 11, 12, col, false);
}

function petal(g, main, light, dark) {
  rect(g, 5, 2, 6, 5, main);
  rect(g, 4, 3, 8, 3, main);
  rect(g, 6, 2, 2, 2, light);
  pxIn(g, 8, 3, light);
  rect(g, 5, 6, 6, 1, dark);
  pxIn(g, 4, 4, dark); pxIn(g, 11, 4, dark);
  pxIn(g, 7, 4, '#3a2a12'); pxIn(g, 8, 4, '#3a2a12');
}

function carveFace(g, hole) {
  rect(g, 3, 5, 3, 3, hole);          // 左眼
  rect(g, 10, 5, 3, 3, hole);         // 右眼
  pxIn(g, 4, 6, '#ffd86a'); pxIn(g, 11, 6, '#ffd86a');
  rect(g, 6, 7, 4, 2, hole);          // 鼻
  rect(g, 3, 11, 10, 2, hole);        // 嘴
  rect(g, 5, 10, 1, 1, hole); rect(g, 8, 10, 1, 1, hole); rect(g, 11, 10, 1, 1, hole);
  pxIn(g, 4, 13, hole); pxIn(g, 7, 13, hole); pxIn(g, 10, 13, hole);
}

function mushroomSprite(g, rand, cap, capLight, stalk) {
  // 菌柄
  rect(g, 6, 9, 4, 6, stalk);
  rect(g, 6, 9, 1, 6, tone(stalk, -0.16));
  rect(g, 5, 8, 6, 1, tone(stalk, -0.3));
  // 菌盖
  rect(g, 3, 4, 10, 5, cap);
  rect(g, 4, 3, 8, 1, cap);
  rect(g, 4, 3, 6, 2, capLight);
  rect(g, 3, 8, 10, 1, tone(cap, -0.28));
  for (let i = 0; i < 5; i++) {
    const x = 4 + ((rand() * 8) | 0), y = 4 + ((rand() * 3) | 0);
    pxIn(g, x, y, '#f2ece0');
  }
}

/* ---------- 功能方块的内部实现（放在表外，便于复用） ---------- */

function furnaceFace(g, rand, lit) {
  stoneTexture(g, rand);
  rect(g, 0, 0, TILE, 2, tone(C.stone, -0.3));
  rect(g, 0, 2, TILE, 1, tone(C.stone, 0.14));
  /* 石砖感的侧面分割 */
  rect(g, 1, 4, 2, 10, tone(C.stone, -0.16));
  rect(g, 13, 4, 2, 10, tone(C.stone, -0.16));
  /* 拱形开口：x 3..12, y 5..13 */
  const x0 = 3, x1 = 12, y0 = 5, y1 = 13;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const inset = (y === y0 && (x <= x0 + 1 || x >= x1 - 1)) ||
        (y === y0 + 1 && (x === x0 || x === x1));
      if (inset) continue;
      px(g, x, y, '#141414');
    }
  }
  /* 开口边框 */
  for (let x = x0 - 1; x <= x1 + 1; x++) {
    px(g, x, y0 - 1, tone(C.stone, -0.34));
    px(g, x, y0, tone(C.stone, 0.1));
  }
  for (let y = y0; y <= y1 + 1; y++) {
    px(g, x0 - 1, y, tone(C.stone, -0.3));
    px(g, x1 + 1, y, tone(C.stone, -0.3));
  }
  if (lit) {
    /* 火光：由外圈橙红到内芯亮黄的色带（纯像素，无渐变对象） */
    for (let y = y0 + 1; y <= y1; y++) {
      for (let x = x0 + 1; x <= x1 - 1; x++) {
        const t = (y - (y0 + 1)) / Math.max(1, y1 - y0 - 1);
        let c = '#7a2a10';
        if (t > 0.15) c = '#c9541a';
        if (t > 0.4) c = '#f2891f';
        if (t > 0.62) c = '#ffc23a';
        if (t > 0.82) c = '#ffe98a';
        const cx = x - 7.5, cy = y - 10;
        if (cx * cx + cy * cy < 5) c = '#fff1b0';
        px(g, x, y, c);
      }
    }
    for (let i = 0; i < 5; i++) {
      const x = x0 + 2 + ((rand() * 7) | 0);
      const y = y0 + 1 + ((rand() * 7) | 0);
      px(g, x, y, pick(['#ffe98a', '#ffc23a', '#f2891f'], rand));
    }
  }
  rect(g, 0, y1 + 1, TILE, 1, tone(C.stone, 0.16));
  rect(g, 0, TILE - 2, TILE, 2, tone(C.stone, -0.24));
}

function metalBlock(g, rand, base, gem) {
  grain(g, rand, base, [-0.07, -0.03, 0, 0, 0.03, 0.07]);
  /* 内凹框 + 中央凸起，MC 金属块的压印感 */
  rect(g, 0, 0, TILE, 1, tone(base, 0.16));
  rect(g, 0, 0, 1, TILE, tone(base, 0.16));
  rect(g, 0, TILE - 1, TILE, 1, tone(base, -0.22));
  rect(g, TILE - 1, 0, 1, TILE, tone(base, -0.22));
  rect(g, 2, 2, 12, 1, tone(base, -0.14));
  rect(g, 2, 13, 12, 1, tone(base, 0.14));
  rect(g, 2, 2, 1, 12, tone(base, -0.14));
  rect(g, 13, 2, 1, 12, tone(base, 0.14));
  if (gem) {
    /* 钻石块：菱形花纹 */
    for (let i = 3; i <= 12; i++) {
      const w = i <= 7 ? i - 3 : 12 - i;
      rect(g, 8 - w, i, w * 2 + 1, 1, tone(base, 0.18));
    }
    speckle(g, rand, 14, ['#c6fff8', tone(base, -0.2)], 1);
  } else {
    rect(g, 5, 5, 6, 6, tone(base, 0.08));
    rect(g, 5, 5, 6, 1, tone(base, 0.2));
    rect(g, 5, 10, 6, 1, tone(base, -0.16));
    speckle(g, rand, 12, [tone(base, 0.22), tone(base, -0.18)], 1);
  }
}

function wheatStage(g, rand, stage) {
  clearTile(g, TILE);
  const stalks = 5 + stage;
  const heights = [4, 7, 11];
  const base = heights[Math.min(2, stage)];
  const green = stage === 2 ? mix(C.wheatGreen, C.wheatGold, 0.55) : C.wheatGreen;
  for (let i = 0; i < stalks; i++) {
    const x = 1 + ((i * 15 / stalks) | 0) + ((rand() * 2) | 0);
    const h = base - 1 + ((rand() * 3) | 0);
    const yTop = TILE - 1 - h;
    const col = tone(green, pick([-0.1, -0.03, 0.05, 0.12], rand));
    for (let y = TILE - 1; y >= yTop; y--) pxIn(g, x, y, col);
    pxIn(g, x, TILE - 1, tone(green, -0.24));
    /* 叶片：向两侧伸出的 1~2 px */
    if (h > 3) {
      const ly = yTop + 1 + ((rand() * (h - 2)) | 0);
      pxIn(g, x + 1, ly, tone(green, 0.08));
      if (rand() < 0.6) pxIn(g, x - 1, ly + 1, tone(green, -0.06));
    }
    /* 阶段 2：顶端的金黄色麦穗 */
    if (stage >= 2) {
      const gold = pick([C.wheatGold, tone(C.wheatGold, 0.14), tone(C.wheatGold, -0.12)], rand);
      for (let y = yTop; y <= yTop + 3; y++) {
        pxIn(g, x, y, gold);
        if (rand() < 0.7) { pxIn(g, x - 1, y, tone(gold, -0.08)); pxIn(g, x + 1, y, tone(gold, 0.1)); }
      }
    } else if (stage === 1) {
      pxIn(g, x, yTop, tone(green, 0.16));
    }
  }
}

/* ============================================================
 * 物品图标
 * ============================================================ */

function iconStart(g, size) { clearTile(g, size); }

function lumpIcon(g, rand, cx, cy, rx, ry, hex) {
  blob(g, cx, cy, rx, ry, tone(hex, 0), tone(hex, -0.32), tone(hex, 0.26), false);
  speckle(g, rand, 6, [tone(hex, -0.22), tone(hex, 0.2)], 1);
}

function ingotIcon(g, hex) {
  const light = tone(hex, 0.26), main = tone(hex, 0), dark = tone(hex, -0.22), deep = tone(hex, -0.4);
  rect(g, 5, 5, 6, 1, light);
  rect(g, 4, 6, 8, 1, main);
  rect(g, 3, 7, 10, 2, main);
  rect(g, 3, 9, 10, 1, dark);
  rect(g, 4, 10, 8, 1, dark);
  rect(g, 5, 11, 6, 1, deep);
  px(g, 6, 7, light);
  px(g, 7, 7, light);
  px(g, 11, 9, deep);
}

function gemIcon(g, hex, wide) {
  const light = tone(hex, 0.4), main = tone(hex, 0.05), dark = tone(hex, -0.25), deep = tone(hex, -0.45);
  const w = wide ? 5 : 4;
  rect(g, 8 - w, 5, w * 2, 1, light);
  for (let i = 1; i <= 4; i++) {
    const ww = w + (i < 2 ? 1 : 0);
    rect(g, 8 - ww, 5 + i, ww * 2, 1, i > 2 ? dark : main);
  }
  rect(g, 8 - w + 1, 10, (w - 1) * 2, 1, dark);
  rect(g, 7, 11, 2, 1, deep);
  px(g, 6, 6, '#ffffff');
  px(g, 7, 6, light);
}

function meatIcon(g, rand, hex, fatHex) {
  blob(g, 8, 8, 5, 4.4, tone(hex, 0), tone(hex, -0.3), tone(hex, 0.24), false);
  rect(g, 4, 7, 3, 1, fatHex);
  rect(g, 9, 10, 4, 1, fatHex);
  px(g, 6, 5, fatHex);
  speckle(g, rand, 6, [tone(hex, 0.18), tone(hex, -0.2)], 1);
}

function mushroomIcon(g, rand, capHex, spotHex) {
  /* 菌盖 */
  for (let y = 3; y <= 8; y++) {
    const t = (y - 3) / 5;
    const half = Math.round(3 + t * 3.2);
    rect(g, 8 - half, y, half * 2, 1, y >= 7 ? tone(capHex, -0.24) : tone(capHex, y === 3 ? 0.2 : 0));
  }
  px(g, 4, 5, tone(capHex, -0.2));
  px(g, 11, 6, tone(capHex, -0.18));
  /* 菌柄 */
  rect(g, 6, 9, 4, 5, '#e6dcc6');
  rect(g, 6, 9, 1, 5, '#f4efdf');
  rect(g, 9, 9, 1, 5, '#c8bda4');
  rect(g, 5, 13, 6, 1, '#d6cbb2');
  if (spotHex) {
    const spots = [[5, 5], [6, 4], [9, 4], [10, 5], [8, 6], [11, 7], [4, 7], [7, 3]];
    for (const s of spots) pxIn(g, s[0], s[1], spotHex);
  }
}

function featherIcon(g) {
  const vane = '#e8ecef', vaneDark = '#b6bcc4', spine = '#8f959d';
  for (let i = 0; i < 10; i++) {
    const x = 12 - i, y = 2 + i;
    pxIn(g, x, y, vane);
    pxIn(g, x - 1, y, vane);
    pxIn(g, x, y + 1, i > 6 ? vaneDark : vane);
    if (i < 8) { pxIn(g, x - 1, y + 1, vaneDark); }
  }
  for (let i = 0; i < 11; i++) pxIn(g, 12 - i, 2 + i, spine);
  pxIn(g, 3, 12, '#cfd5db');
  pxIn(g, 2, 13, '#aab0b8');
  pxIn(g, 13, 1, vane);
}

function boneIcon(g) {
  const main = '#eef0ea', light = '#ffffff', dark = '#b9bdb6';
  for (let i = 0; i < 8; i++) {
    pxIn(g, 5 + i, 10 - i, main);
    pxIn(g, 5 + i, 11 - i, dark);
    pxIn(g, 6 + i, 10 - i, light);
  }
  blob(g, 4, 11, 2.4, 2.2, main, dark, light, false);
  blob(g, 12, 4, 2.4, 2.2, main, dark, light, false);
  pxIn(g, 3, 12, dark);
  pxIn(g, 13, 5, dark);
}

function stringIcon(g) {
  const c = '#dfe3e6', d = '#a9aeb3';
  line(g, 3, 4, 8, 3, c, false);
  line(g, 8, 3, 12, 6, c, false);
  line(g, 12, 6, 6, 8, c, false);
  line(g, 6, 8, 4, 11, c, false);
  line(g, 4, 11, 11, 13, c, false);
  pxIn(g, 3, 4, d);
  pxIn(g, 11, 13, d);
  pxIn(g, 12, 6, d);
}

function seedsIcon(g, rand) {
  const pts = [[4, 6], [7, 4], [10, 6], [6, 9], [11, 10], [8, 12], [3, 11]];
  for (const p of pts) {
    pxIn(g, p[0], p[1], tone('#a89455', pick([-0.1, 0.05, 0.18], rand)));
    pxIn(g, p[0] + 1, p[1], tone('#8e7b45', 0));
  }
}

function wheatIcon(g) {
  const gold = C.wheatGold, gd = tone(gold, -0.22), gl = tone(gold, 0.2);
  for (let y = 15; y >= 3; y--) pxIn(g, 8, y, tone('#b8a24a', -0.05));
  for (let i = 0; i < 5; i++) {
    const y = 3 + i * 2;
    pxIn(g, 6, y, gold); pxIn(g, 7, y, gl);
    pxIn(g, 9, y, gold); pxIn(g, 10, y, gd);
    pxIn(g, 6, y + 1, gd); pxIn(g, 10, y + 1, gd);
  }
  pxIn(g, 8, 2, gl);
  pxIn(g, 5, 8, gd);
  pxIn(g, 11, 10, gd);
}

/* ---- 工具：共用斜柄 + 各自的头部 ---- */

const HANDLE_LIGHT = tone(C.woodTool, 0.2);
const HANDLE_MAIN = tone(C.woodTool, 0);
const HANDLE_DARK = tone(C.woodTool, -0.26);

function shaft(g, x0, y0, len) {
  /* 从 (x0,y0) 向左下画 len 段 45° 双像素柄；上缘固定受光，下缘固定阴影 */
  for (let i = 0; i < len; i++) {
    pxIn(g, x0 - i, y0 + i, HANDLE_MAIN);
    pxIn(g, x0 - i, y0 + i + 1, HANDLE_DARK);
    if (i % 3 === 0) pxIn(g, x0 - i, y0 + i - 1, HANDLE_LIGHT);
    if (i === 0) pxIn(g, x0, y0 - 1, HANDLE_LIGHT);
  }
}

/* 工具材质：不是简单把同一个灰调亮/调暗，而是分别给出受光、主色、阴影、深影 */
const TOOL_SHADES = new Map([
  [C.woodTool, { M: '#9a6a3e', m: '#c18a54', '#': '#6b4726', d: '#4f341b' }],
  [C.stoneTool, { M: '#85898a', m: '#b0b3b2', '#': '#606463', d: '#464948' }],
  [C.ironTool, { M: '#b7c0c8', m: '#e3ebf1', '#': '#78838c', d: '#555f68' }],
  [C.diamondTool, { M: '#5fc4bc', m: '#a3e7df', '#': '#3b8b85', d: '#2a6763' }]
]);

function matColors(hex) {
  const s = TOOL_SHADES.get(hex);
  if (s) return Object.assign({}, s);
  return {
    M: tone(hex, 0),
    m: tone(hex, 0.3),
    '#': tone(hex, -0.3),
    d: tone(hex, -0.48)
  };
}

/* 镐头：以 (10,3.5) 为圆心的上半圆弧带，两端下垂 */
function pickHead(g, col) {
  const cx = 10, cy = 3.5, rO = 5.4, rI = 3.4;
  for (let y = 0; y <= 9; y++) {
    for (let x = 3; x <= 15; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > rO || d < rI) continue;
      let a = Math.atan2(dy, dx) * 180 / Math.PI;
      if (a < 0) a += 360;
      /* 屏幕坐标 y 向下：270° 是正上方，只保留上弧（含两端略下垂） */
      if (!((a >= 150 && a <= 360) || (a >= 0 && a <= 30))) continue;
      let ch = 'M';
      if (a > 240 && a < 310) ch = 'm';
      if (a <= 30 || a >= 330 || (a >= 150 && a < 180)) ch = '#';
      if (d < rI + 0.5 && a > 190 && a < 340) ch = '#';
      pxIn(g, x, y, col[ch]);
    }
  }
}

/* 斧头：贴在柄顶端右侧的厚斧刃；左上受光、右下阴影，右缘保留刃口但不再整条发白 */
function axeHead(g, col) {
  for (let y = 1; y <= 7; y++) {
    for (let x = 8; x <= 15; x++) {
      const dx = x - 10.5, dy = y - 4;
      if ((dx * dx) / 20 + (dy * dy) / 8.5 > 1) continue;
      let c = col.M;
      if (x <= 10 && y <= 3) c = col.m;
      if (y >= 6 || x >= 14) c = col['#'];
      if (x >= 13 && y >= 5) c = col.d;
      pxIn(g, x, y, c);
    }
  }
  rect(g, 9, 0, 3, 1, col.m);
  pxIn(g, 8, 1, col.m);
  pxIn(g, 8, 5, col.d);
}

/* 铲头：柄顶端的小方铲，带圆角与下缘暗色 */
function shovelHead(g, col) {
  for (let y = 0; y <= 5; y++) {
    let xa = 9, xb = 14;
    if (y === 0) { xa = 10; xb = 13; }
    if (y === 5) { xa = 11; xb = 12; }
    for (let x = xa; x <= xb; x++) {
      let c = col.M;
      if (y === 0) c = col.m;
      if (x === xb && y > 0 && y < 5) c = col['#'];
      if (y === 4) c = col['#'];
      if (y === 5) c = col.d;
      pxIn(g, x, y, c);
    }
  }
  pxIn(g, 8, 2, col.m);
  pxIn(g, 14, 2, col.m);
}

/* 锄头：柄顶端向左伸出的横刃（上缘亮、下缘暗，末端略下垂） */
function hoeHead(g, col) {
  for (let x = 4; x <= 10; x++) {
    pxIn(g, x, 2, col.M);
    pxIn(g, x, 3, col.m);
  }
  for (let x = 4; x <= 6; x++) pxIn(g, x, 4, col['#']);
  pxIn(g, 3, 2, col.d);
  pxIn(g, 3, 3, col['#']);
  pxIn(g, 4, 1, col.d);
  pxIn(g, 10, 1, col.m);
  pxIn(g, 7, 4, col.d);
}

/* 剑：细长刀片沿对角线延伸到右上，十字护手 + 短木柄 */
function swordIcon(g, col) {
  for (let i = 0; i < 10; i++) {
    const x = 4 + i, y = 10 - i;
    pxIn(g, x, y, i === 9 ? col.m : col.M);
    pxIn(g, x, y - 1, col.m);
    pxIn(g, x, y + 1, i < 8 ? col['#'] : col.M);
  }
  pxIn(g, 14, 0, col.m);
  pxIn(g, 13, 0, col.m);
  /* 护手（与刀片垂直） */
  const guard = [[2, 7], [3, 8], [5, 10], [6, 11], [7, 12]];
  for (const p of guard) pxIn(g, p[0], p[1], col['#']);
  pxIn(g, 4, 11, col.d);
  /* 木柄与柄头 */
  pxIn(g, 3, 12, HANDLE_MAIN);
  pxIn(g, 2, 13, HANDLE_MAIN);
  pxIn(g, 2, 14, HANDLE_DARK);
  pxIn(g, 1, 13, HANDLE_DARK);
}

function drawTool(g, kind, matHex) {
  const col = matColors(matHex);
  if (kind === 'sword') { swordIcon(g, col); return; }
  shaft(g, 9, 3, 9);
  if (kind === 'pickaxe') pickHead(g, col);
  else if (kind === 'axe') axeHead(g, col);
  else if (kind === 'shovel') shovelHead(g, col);
  else if (kind === 'hoe') hoeHead(g, col);
}

/* T1 护甲图标：四件各有可辨认的剪影（头盔/胸甲/护腿/靴子），材质只换色阶 */
function armorIcon(g, kind, hex) {
  const main = tone(hex, 0), light = tone(hex, 0.32), dark = tone(hex, -0.3), deep = tone(hex, -0.52);
  if (kind === 'helmet') {
    rect(g, 5, 3, 6, 1, light);
    rect(g, 4, 4, 8, 1, main);
    rect(g, 3, 5, 10, 4, main);
    rect(g, 3, 5, 1, 4, light);
    rect(g, 12, 5, 1, 4, dark);
    rect(g, 3, 9, 3, 3, dark);          // 左右护颈
    rect(g, 10, 9, 3, 3, dark);
    rect(g, 3, 9, 1, 3, deep);
    rect(g, 12, 9, 1, 3, deep);
    rect(g, 6, 8, 4, 5, deep);          // 面部开口
    rect(g, 6, 8, 4, 1, tone(hex, -0.62));
    pxIn(g, 5, 5, light); pxIn(g, 6, 5, light);
    pxIn(g, 12, 8, dark);
  } else if (kind === 'chestplate') {
    rect(g, 4, 3, 3, 2, light);         // 肩甲
    rect(g, 9, 3, 3, 2, light);
    rect(g, 4, 5, 8, 1, main);
    rect(g, 3, 6, 10, 6, main);
    rect(g, 3, 6, 1, 6, light);
    rect(g, 12, 6, 1, 6, dark);
    rect(g, 3, 11, 10, 1, dark);
    rect(g, 6, 5, 4, 1, deep);          // 领口
    rect(g, 7, 7, 2, 5, deep);          // 中缝
    rect(g, 4, 7, 2, 4, light);
    pxIn(g, 11, 7, dark); pxIn(g, 11, 8, dark);
  } else if (kind === 'leggings') {
    rect(g, 4, 3, 8, 2, main);          // 腰带
    rect(g, 4, 3, 8, 1, light);
    rect(g, 4, 5, 3, 9, main);
    rect(g, 9, 5, 3, 9, main);
    rect(g, 4, 5, 1, 9, light);
    rect(g, 6, 5, 1, 9, dark);
    rect(g, 9, 5, 1, 9, light);
    rect(g, 11, 5, 1, 9, dark);
    rect(g, 4, 12, 3, 2, deep);          // 裤脚
    rect(g, 9, 12, 3, 2, deep);
    rect(g, 5, 6, 1, 2, deep);           // 侧袋
  } else {
    rect(g, 3, 7, 4, 2, light);          // 靴筒
    rect(g, 9, 7, 4, 2, light);
    rect(g, 3, 9, 4, 3, main);
    rect(g, 9, 9, 4, 3, main);
    rect(g, 4, 11, 5, 3, main);          // 鞋面朝右
    rect(g, 10, 11, 5, 3, main);
    rect(g, 3, 9, 1, 5, light);
    rect(g, 9, 9, 1, 5, light);
    rect(g, 4, 13, 5, 1, deep);
    rect(g, 10, 13, 5, 1, deep);
    rect(g, 6, 8, 1, 4, dark);
    rect(g, 12, 8, 1, 4, dark);
  }
}

export const itemPainters = {

  /* ---------- 材料 ---------- */

  stick(g, rand) {
    iconStart(g);
    void rand;
    for (let i = 0; i < 10; i++) {
      pxIn(g, 4 + i, 12 - i, HANDLE_MAIN);
      pxIn(g, 4 + i, 13 - i, HANDLE_DARK);
    }
    pxIn(g, 4, 13, HANDLE_LIGHT);
    pxIn(g, 13, 3, HANDLE_LIGHT);
  },

  coal(g, rand) { iconStart(g); lumpIcon(g, rand, 8, 8, 4.6, 4, '#2a2a2a'); speckle(g, rand, 8, ['#4d4d4d', '#111111'], 1); },
  charcoal(g, rand) {
    iconStart(g);
    lumpIcon(g, rand, 8, 8, 4.8, 3.8, '#261d17');
    line(g, 5, 6, 10, 5, '#3d3027', false);
    line(g, 6, 10, 11, 9, '#180f0b', false);
  },

  iron_ingot(g) { iconStart(g); ingotIcon(g, C.ironTool); },
  gold_ingot(g) { iconStart(g); ingotIcon(g, '#f2cf3f'); },
  diamond(g) { iconStart(g); gemIcon(g, C.diamondTool, false); },
  emerald(g) { iconStart(g); gemIcon(g, '#26c96f', true); },
  lapis_lazuli(g, rand) {
    iconStart(g);
    const pts = [[6, 6], [9, 5], [10, 9], [6, 10], [8, 12]];
    for (const p of pts) blob(g, p[0], p[1], 1.8, 1.6, C.lapis, tone(C.lapis, -0.4), tone(C.lapis, 0.4), false);
    speckle(g, rand, 8, ['#5f92e0', '#173d80'], 1);
  },

  apple(g, rand) {
    iconStart(g);
    blob(g, 8, 9, 4.8, 4.6, '#c22f2a', '#7d1c17', '#e8544a', false);
    pxIn(g, 6, 5, '#e8544a');
    pxIn(g, 8, 4, '#b32a24');
    rect(g, 8, 2, 1, 3, '#6b4a2a');
    pxIn(g, 9, 2, '#4f8f34');
    pxIn(g, 10, 2, '#63ab43');
    pxIn(g, 10, 3, '#4f8f34');
    pxIn(g, 6, 7, '#f0846f');
    void rand;
  },

  bread(g, rand) {
    iconStart(g);
    blob(g, 8, 9, 5.6, 3.4, '#c08a3e', '#7f5322', '#e0aa5c', false);
    rect(g, 4, 7, 8, 1, '#e6b86c');
    for (let i = 0; i < 3; i++) {
      pxIn(g, 5 + i * 3, 8, '#8a5c26');
      pxIn(g, 6 + i * 3, 8, '#a3712f');
    }
    speckle(g, rand, 6, ['#d9a05a'], 1);
  },

  wheat(g) { iconStart(g); wheatIcon(g); },
  wheat_seeds(g, rand) { iconStart(g); seedsIcon(g, rand); },

  carrot(g, rand) {
    iconStart(g);
    for (let i = 0; i < 8; i++) {
      const w = 3 - ((i / 3) | 0);
      rect(g, 6 - w + i, 6 + i, w * 2 + 1, 1, i > 5 ? '#d4791f' : '#ef9534');
    }
    pxIn(g, 9, 5, '#c76a17');
    rect(g, 6, 2, 1, 4, '#4f8f34');
    rect(g, 8, 1, 1, 5, '#63ab43');
    rect(g, 10, 2, 1, 4, '#3f7a29');
    pxIn(g, 7, 8, '#f8ad55');
    void rand;
  },

  potato(g, rand) {
    iconStart(g);
    blob(g, 8, 8, 5, 3.8, '#a97b3e', '#6f4d24', '#c99a56', false);
    speckle(g, rand, 10, ['#6b4520', '#5a3a1a'], 1);
    pxIn(g, 5, 6, '#4f3517');
    pxIn(g, 10, 9, '#4f3517');
  },

  beef_raw(g, rand) { iconStart(g); meatIcon(g, rand, '#b5424a', '#f2cfc7'); },
  beef_cooked(g, rand) {
    iconStart(g);
    blob(g, 8, 8, 5, 4.2, '#8a4b26', '#5a2f16', '#b06a35', false);
    line(g, 4, 7, 11, 7, '#5f3016', false);
    line(g, 5, 10, 12, 10, '#5f3016', false);
    speckle(g, rand, 6, ['#c98a4a'], 1);
  },
  pork_raw(g, rand) { iconStart(g); meatIcon(g, rand, '#e08a90', '#f7e3d8'); },
  pork_cooked(g, rand) {
    iconStart(g);
    blob(g, 8, 8, 5, 4.2, '#c07a44', '#8a4d24', '#e0a06a', false);
    rect(g, 4, 6, 3, 1, '#f0d0a8');
    rect(g, 9, 10, 4, 1, '#8a4d24');
    speckle(g, rand, 5, ['#d9975c'], 1);
  },
  chicken_raw(g, rand) {
    iconStart(g);
    blob(g, 7, 8, 4.4, 3.8, '#f0b9b0', '#c98a80', '#ffd8cf', false);
    rect(g, 10, 9, 4, 2, '#f7e0d6');
    pxIn(g, 13, 10, '#d8b3a6');
    speckle(g, rand, 6, ['#e0a49a'], 1);
  },
  chicken_cooked(g, rand) {
    iconStart(g);
    blob(g, 7, 8, 4.4, 3.8, '#d1954a', '#8f5c22', '#eebb76', false);
    rect(g, 10, 9, 4, 2, '#e6cfae');
    speckle(g, rand, 7, ['#a86a28', '#f3c98a'], 1);
  },

  /* 阶段 3a 鱼：与生/熟肉同一套「同轮廓换配色」的做法，一眼分得清生熟。
     轮廓 = 右侧鱼身 + 左侧尾鳍 + 一个深色眼点，全部避开最外圈像素。 */
  fish_raw(g, rand) {
    iconStart(g);
    blob(g, 9, 8, 4.6, 3.0, '#9fb8c6', '#5f7c8c', '#d6e6ee', false);
    rect(g, 3, 6, 3, 4, '#89a6b6');            // 尾鳍
    rect(g, 4, 7, 1, 2, '#6b8798');
    rect(g, 8, 5, 4, 1, '#c7dbe4');            // 背鳍高光
    pxIn(g, 12, 8, '#1d2b33');                 // 眼睛
    speckle(g, rand, 5, ['#7f9dad', '#cfe0e8'], 1);
  },
  fish_cooked(g, rand) {
    iconStart(g);
    blob(g, 9, 8, 4.6, 3.0, '#c08a4a', '#8a5a26', '#e8c084', false);
    rect(g, 3, 6, 3, 4, '#a8763c');
    rect(g, 4, 7, 1, 2, '#7d5223');
    rect(g, 7, 7, 5, 1, '#5d3a17');            // 烤痕
    pxIn(g, 12, 8, '#33200f');
    speckle(g, rand, 5, ['#d9a860', '#8a5a26'], 1);
  },

  leather(g, rand) {
    iconStart(g);
    rect(g, 3, 3, 10, 10, '#9a6b45');
    rect(g, 3, 3, 10, 1, '#b98a5f');
    rect(g, 3, 3, 1, 10, '#b08055');
    rect(g, 3, 12, 10, 1, '#6f4a2c');
    rect(g, 12, 3, 1, 10, '#6f4a2c');
    rect(g, 10, 10, 4, 4, '#c39a6e');
    rect(g, 10, 10, 4, 1, '#8a5f3a');
    rect(g, 10, 10, 1, 4, '#8a5f3a');
    speckle(g, rand, 10, ['#7d5535', '#b3835a'], 1);
  },

  string(g) { iconStart(g); stringIcon(g); },
  wool(g, rand) {
    /* T2 羊毛：一团蓬松白毛 */
    void rand;
    iconStart(g);
    blob(g, 8, 9, 5.2, 4.4, '#f2f0e6', '#c9c3b2', '#ffffff', false);
    blob(g, 6, 8, 1.8, 1.5, '#ffffff', '#dcd6c6', '#ffffff', false);
    blob(g, 10, 10, 1.8, 1.5, '#e9e5d8', '#c3bcab', '#ffffff', false);
  },
  feather(g) { iconStart(g); featherIcon(g); },
  bone(g) { iconStart(g); boneIcon(g); },

  gunpowder(g, rand) {
    iconStart(g);
    blob(g, 8, 10, 5, 3, '#8d8d8d', '#4f4f4f', '#b0b0b0', false);
    blob(g, 6, 7, 2.6, 1.8, '#7a7a7a', '#454545', '#9d9d9d', false);
    speckle(g, rand, 16, ['#3d3d3d', '#bcbcbc', '#6b6b6b'], 1);
  },

  egg(g, rand) {
    iconStart(g);
    blob(g, 8, 9, 3.6, 4.6, '#f2e8d5', '#c9bda6', '#fffaf0', false);
    pxIn(g, 6, 6, '#ffffff');
    speckle(g, rand, 4, ['#dcd0b8'], 1);
  },

  mushroom_brown(g, rand) { iconStart(g); mushroomIcon(g, rand, '#a0743f', null); },
  mushroom_red(g, rand) { iconStart(g); mushroomIcon(g, rand, '#c02f2b', '#f2eae2'); },

  sugar(g, rand) {
    iconStart(g);
    blob(g, 8, 10, 5, 2.8, '#f4f2ee', '#c2bdb4', '#ffffff', false);
    blob(g, 7, 6, 2.4, 1.6, '#efedea', '#bdb8ae', '#ffffff', false);
    speckle(g, rand, 12, ['#ffffff', '#d5d1c9'], 1);
  },

  flint(g, rand) {
    iconStart(g);
    blob(g, 8, 8, 5, 4.2, '#3a3a42', '#1d1d24', '#5d5d68', false);
    line(g, 5, 6, 10, 4, '#7d7d8a', false);
    pxIn(g, 11, 8, '#8f8f9c');
    pxIn(g, 6, 11, '#151519');
    speckle(g, rand, 7, ['#25252c'], 1);
  },

  /* ---------- 工具 ---------- */

  pickaxe_wood(g) { iconStart(g); drawTool(g, 'pickaxe', C.woodTool); },
  pickaxe_stone(g) { iconStart(g); drawTool(g, 'pickaxe', C.stoneTool); },
  pickaxe_iron(g) { iconStart(g); drawTool(g, 'pickaxe', C.ironTool); },
  pickaxe_diamond(g) { iconStart(g); drawTool(g, 'pickaxe', C.diamondTool); },

  axe_wood(g) { iconStart(g); drawTool(g, 'axe', C.woodTool); },
  axe_stone(g) { iconStart(g); drawTool(g, 'axe', C.stoneTool); },
  axe_iron(g) { iconStart(g); drawTool(g, 'axe', C.ironTool); },
  axe_diamond(g) { iconStart(g); drawTool(g, 'axe', C.diamondTool); },

  shovel_wood(g) { iconStart(g); drawTool(g, 'shovel', C.woodTool); },
  shovel_stone(g) { iconStart(g); drawTool(g, 'shovel', C.stoneTool); },
  shovel_iron(g) { iconStart(g); drawTool(g, 'shovel', C.ironTool); },
  shovel_diamond(g) { iconStart(g); drawTool(g, 'shovel', C.diamondTool); },

  hoe_wood(g) { iconStart(g); drawTool(g, 'hoe', C.woodTool); },
  hoe_stone(g) { iconStart(g); drawTool(g, 'hoe', C.stoneTool); },
  hoe_iron(g) { iconStart(g); drawTool(g, 'hoe', C.ironTool); },
  hoe_diamond(g) { iconStart(g); drawTool(g, 'hoe', C.diamondTool); },

  sword_wood(g) { iconStart(g); drawTool(g, 'sword', C.woodTool); },
  sword_stone(g) { iconStart(g); drawTool(g, 'sword', C.stoneTool); },
  sword_iron(g) { iconStart(g); drawTool(g, 'sword', C.ironTool); },
  sword_diamond(g) { iconStart(g); drawTool(g, 'sword', C.diamondTool); },

  /* ---------- 补充：树苗 / 农作物 / 容器 / 建筑 ---------- */

  oak_sapling(g, rand) {
    iconStart(g);
    line(g, 8, 14, 8, 9, tone(C.woodTool, -0.15), false);
    line(g, 8, 12, 6, 11, tone(C.woodTool, -0.3), false);
    blob(g, 8, 6, 4.2, 3.4, C.grass, C.grassDeep, tone(C.grass, 0.3), false);
    speckle(g, rand, 6, [tone(C.grass, 0.35), tone(C.grassDeep, -0.2)], 1);
  },

  birch_sapling(g, rand) {
    iconStart(g);
    line(g, 8, 14, 8, 9, '#d6d2c4', false);
    line(g, 8, 12, 10, 11, '#b9b4a4', false);
    blob(g, 8, 6, 3.8, 3.2, '#8cc05a', '#5f8f38', '#b4dc7f', false);
    speckle(g, rand, 5, ['#a6d473', '#4f7a2e'], 1);
  },

  clay_ball(g, rand) {
    iconStart(g);
    blob(g, 8, 8, 4.4, 4.0, '#9fa5b0', '#7a808c', '#c2c7d1', false);
    speckle(g, rand, 6, ['#8b919c', '#b6bcc7'], 1);
  },

  potato_baked(g, rand) {
    iconStart(g);
    blob(g, 8, 9, 5.0, 4.0, '#a9762f', '#7d531c', '#d3a05a', false);
    line(g, 5, 8, 11, 7, '#6b431a', false);
    speckle(g, rand, 8, ['#8a5e22', '#e0b877', '#5a3512'], 1);
  },

  chest(g, rand) {
    iconStart(g);
    const body = '#8a6a3c', dark = '#5f4626', light = '#a88152';
    rect(g, 2, 5, 12, 9, body);
    rect(g, 2, 5, 12, 3, dark);                    // 箱盖
    rect(g, 2, 7, 12, 1, tone(dark, -0.25));
    rect(g, 7, 6, 2, 4, '#3b2c18');                // 锁扣
    rect(g, 7, 6, 2, 1, '#c9a227');
    speckle(g, rand, 9, [light, dark], 1);
    rect(g, 2, 13, 12, 1, tone(dark, -0.2));
  },

  ladder(g) {
    iconStart(g);
    const rail = '#9c7a45', rung = '#7d5f34';
    rect(g, 3, 1, 2, 14, rail);
    rect(g, 11, 1, 2, 14, rail);
    for (let y = 3; y < 15; y += 4) rect(g, 3, y, 10, 2, rung);
    rect(g, 3, 1, 1, 14, tone(rail, 0.22));
  },

  arrow(g) {
    iconStart(g);
    line(g, 3, 13, 11, 5, '#8d6a3a', false);
    line(g, 4, 13, 11, 6, tone('#8d6a3a', -0.25), false);
    // 箭头
    pxIn(g, 12, 4, '#cfd3d8'); pxIn(g, 13, 3, '#e8ecef'); pxIn(g, 12, 3, '#9aa0a8'); pxIn(g, 13, 4, '#9aa0a8');
    pxIn(g, 11, 5, '#b6bcc4');
    // 尾羽
    pxIn(g, 2, 14, '#e6e2dc'); pxIn(g, 3, 12, '#d7d2ca'); pxIn(g, 4, 14, '#cfc9c0'); pxIn(g, 2, 12, '#f2efe9');
  },

  bow(g, rand) {
    /* T3 弓：向右开口的木弧 + 连接两端的浅色弓弦 */
    void rand;
    iconStart(g);
    for (let a = -62; a <= 62; a += 4) {
      const rad = a * Math.PI / 180;
      const x = Math.round(5 + Math.cos(rad) * 5.4), y = Math.round(8 + Math.sin(rad) * 5.4);
      pxIn(g, x, y, Math.abs(a) < 24 ? HANDLE_LIGHT : HANDLE_MAIN);
      pxIn(g, x - 1, y, HANDLE_DARK);
    }
    line(g, 8, 3, 8, 13, '#efe9d6', false);
    pxIn(g, 8, 3, HANDLE_LIGHT); pxIn(g, 8, 13, HANDLE_LIGHT);
    pxIn(g, 11, 8, HANDLE_MAIN);
  },

  /* T6 门：竖长木门图标 + 把手 */
  door(g) {
    iconStart(g);
    const wood = '#9a7b50', dark = '#6d5232', light = '#b9925f', ink = '#4a3722';
    rect(g, 4, 1, 8, 14, wood);
    rect(g, 4, 1, 8, 1, light);
    rect(g, 4, 1, 1, 14, light);
    rect(g, 11, 1, 1, 14, dark);
    rect(g, 4, 14, 8, 1, dark);
    rect(g, 6, 3, 4, 4, dark);
    rect(g, 7, 4, 2, 2, '#8b6c45');
    rect(g, 6, 9, 4, 4, dark);
    rect(g, 7, 10, 2, 2, '#8b6c45');
    rect(g, 8, 6, 2, 2, '#d9dde2');
    pxIn(g, 8, 6, '#f5f7f9');
    pxIn(g, 9, 8, ink);
  },

  /* T6 粘液球：绿色胶质球 + 高光 */
  slime_ball(g, rand) {
    iconStart(g);
    blob(g, 8, 8.5, 5.2, 4.8, '#6cc45f', '#3f8b3d', '#9fe28d', false);
    pxIn(g, 6, 6, '#c8f5b8'); pxIn(g, 7, 5, '#d9ffd0'); pxIn(g, 5, 7, '#a8e89a');
    pxIn(g, 10, 11, '#397c37');
    speckle(g, rand, 4, ['#4f9e46', '#86d27a'], 1);
  },

  /* T5 打火石：弯曲钢条 + 燧石 + 火星 */
  flint_and_steel(g) {
    iconStart(g);
    const steel = '#d7dbe0', steelD = '#8d949d', steelL = '#f2f5f7';
    const flint = '#4b4f55', flintL = '#6d737b', flintD = '#2f3237';
    // 钢条：右上到左下的一条弯钩
    for (let i = 0; i < 8; i++) {
      pxIn(g, 6 + i, 3 + i, steel);
      pxIn(g, 7 + i, 3 + i, steelD);
      if (i < 5) pxIn(g, 6 + i, 2 + i, steelL);
    }
    for (let i = 0; i < 4; i++) pxIn(g, 6 + i, 10 - i, steelD);
    // 燧石：左下角一块棱角石头
    blob(g, 4.5, 11.5, 3.2, 2.4, flint, flintD, flintL, false);
    pxIn(g, 2, 13, flintD); pxIn(g, 6, 13, flintD);
    // 火星
    pxIn(g, 9, 8, '#ffd84a'); pxIn(g, 10, 7, '#ffb02e');
    pxIn(g, 11, 9, '#fff2a8'); pxIn(g, 8, 10, '#ff8f2e');
  },

  /* T2 盾牌：木板面 + 铁边 + 中心铁扣，16×16 内看清轮廓 */
  shield(g) {
    iconStart(g);
    const wood = '#8a6a3f', woodL = '#a9854f', woodD = '#5d4529', seam = '#4a3722';
    const iron = '#cfd3d8', ironL = '#eef1f4', ironD = '#8b929a';
    // 外形：上宽下尖
    const rows = [[4, 8], [3, 10], [2, 12], [2, 12], [2, 12], [2, 12], [2, 12], [3, 10], [4, 8], [5, 6], [6, 4], [7, 2]];
    rows.forEach(([x0, w], i) => {
      const y = 2 + i;
      rect(g, x0, y, w, 1, wood);
      pxIn(g, x0, y, woodL);
      pxIn(g, x0 + w - 1, y, woodD);
    });
    // 木板竖缝
    for (const x of [5, 8, 11]) for (let y = 3; y <= 11; y++) {
      if (y >= 2 && y <= 3 + rows.length) pxIn(g, x, y, seam);
    }
    // 铁边：上下横条 + 两侧
    rect(g, 4, 2, 8, 1, ironL);
    rect(g, 3, 3, 10, 1, iron);
    rect(g, 2, 4, 1, 7, iron);
    rect(g, 13, 4, 1, 7, iron);
    rect(g, 6, 12, 4, 1, iron);
    rect(g, 7, 13, 2, 1, ironD);
    // 中心铁扣
    rect(g, 7, 6, 2, 3, ironL);
    pxIn(g, 7, 6, '#ffffff');
    pxIn(g, 9, 8, ironD);
    // 铆钉
    pxIn(g, 3, 4, ironD); pxIn(g, 12, 4, ironD);
    pxIn(g, 4, 10, ironD); pxIn(g, 11, 10, ironD);
  },

  /* T1 三套护甲：同一剪影，靠材质色阶区分 */
  leather_helmet(g) { iconStart(g); armorIcon(g, 'helmet', '#a06a3c'); },
  leather_chestplate(g) { iconStart(g); armorIcon(g, 'chestplate', '#a06a3c'); },
  leather_leggings(g) { iconStart(g); armorIcon(g, 'leggings', '#a06a3c'); },
  leather_boots(g) { iconStart(g); armorIcon(g, 'boots', '#a06a3c'); },
  iron_helmet(g) { iconStart(g); armorIcon(g, 'helmet', '#b7c0c8'); },
  iron_chestplate(g) { iconStart(g); armorIcon(g, 'chestplate', '#b7c0c8'); },
  iron_leggings(g) { iconStart(g); armorIcon(g, 'leggings', '#b7c0c8'); },
  iron_boots(g) { iconStart(g); armorIcon(g, 'boots', '#b7c0c8'); },
  diamond_helmet(g) { iconStart(g); armorIcon(g, 'helmet', '#5fc4bc'); },
  diamond_chestplate(g) { iconStart(g); armorIcon(g, 'chestplate', '#5fc4bc'); },
  diamond_leggings(g) { iconStart(g); armorIcon(g, 'leggings', '#5fc4bc'); },
  diamond_boots(g) { iconStart(g); armorIcon(g, 'boots', '#5fc4bc'); },

  shears(g, rand) {
    /* 剪刀：两片钢刃交叉 + 中间转轴 + 下方两个握环 */
    void rand;
    iconStart(g);
    line(g, 3, 2, 9, 8, '#dfe3e8', false);          // 刀刃（亮面）
    line(g, 4, 2, 10, 8, '#aeb4bc', false);         // 刀刃（暗面，做出厚度）
    line(g, 12, 2, 6, 8, '#dfe3e8', false);
    line(g, 11, 2, 5, 8, '#aeb4bc', false);
    pxIn(g, 7, 6, '#6b717a'); pxIn(g, 8, 6, '#6b717a');
    pxIn(g, 7, 7, '#454a52'); pxIn(g, 8, 7, '#454a52');   // 转轴
    // 握环：左右各一个小圆环
    for (const [cx, cy] of [[4, 12], [11, 12]]) {
      pxIn(g, cx - 1, cy - 1, '#8d949d'); pxIn(g, cx, cy - 2, '#aeb4bc'); pxIn(g, cx + 1, cy - 1, '#8d949d');
      pxIn(g, cx - 2, cy, '#7d838c'); pxIn(g, cx + 2, cy, '#7d838c');
      pxIn(g, cx - 1, cy + 1, '#6b717a'); pxIn(g, cx, cy + 2, '#7d838c'); pxIn(g, cx + 1, cy + 1, '#6b717a');
    }
    pxIn(g, 6, 9, '#8d949d'); pxIn(g, 9, 9, '#8d949d');   // 环与刃的连接
  },

  cake(g, rand) {
    iconStart(g);
    rect(g, 2, 8, 12, 5, '#efe3c8');               // 奶油层
    rect(g, 2, 8, 12, 1, '#f7eeda');
    rect(g, 2, 10, 12, 2, '#d9b98a');              // 蛋糕体
    rect(g, 2, 12, 12, 1, '#c8a476');
    rect(g, 2, 7, 12, 1, '#e0555f');               // 樱桃/果酱
    for (let x = 3; x < 14; x += 3) pxIn(g, x, 6, '#ff7a83');
    speckle(g, rand, 6, ['#c8a476', '#f7eeda'], 1);
  },

  planks(g, rand) {
    iconStart(g);
    rect(g, 2, 4, 12, 8, C.woodTool);
    for (let y = 6; y < 12; y += 3) rect(g, 2, y, 12, 1, tone(C.woodTool, -0.3));
    speckle(g, rand, 8, [tone(C.woodTool, 0.2), tone(C.woodTool, -0.18)], 1);
  },

  mushroom_stew(g, rand) {
    iconStart(g);
    rect(g, 3, 8, 10, 5, '#c9c2b4');               // 碗身
    rect(g, 3, 8, 10, 1, '#e6e0d2');
    rect(g, 2, 12, 12, 2, '#9d9689');              // 碗底
    rect(g, 4, 6, 8, 2, '#b5824a');                // 汤面
    pxIn(g, 5, 6, '#e8dcc8'); pxIn(g, 8, 7, '#8a6248'); pxIn(g, 10, 6, '#e8dcc8');
    speckle(g, rand, 4, ['#8a6248', '#e8dcc8'], 1);
  },

  rotten_flesh(g, rand) {
    iconStart(g);
    blob(g, 8, 8, 5.0, 4.2, '#8c4a3c', '#5e2f26', '#a8604f', false);
    speckle(g, rand, 10, ['#6f8a4a', '#4a2a22', '#b98a76'], 1);
    pxIn(g, 5, 6, '#d8cfc0'); pxIn(g, 6, 6, '#d8cfc0'); pxIn(g, 10, 10, '#d8cfc0');
  },

  /* ---------- 滚动任务 8：地图与指南针 ---------- */
  map(g, rand) {
    iconStart(g);
    rect(g, 2, 3, 12, 10, '#d9c89a');               // 羊皮纸
    rect(g, 2, 3, 12, 1, '#efe1b8');
    rect(g, 2, 12, 12, 1, '#a89263');
    rect(g, 3, 4, 1, 8, '#b9a678');                 // 折痕
    rect(g, 8, 4, 1, 8, '#c4b184');
    rect(g, 12, 4, 1, 8, '#b9a678');
    line(g, 5, 10, 10, 5, '#6f5a36', false);        // 小径
    line(g, 10, 5, 12, 7, '#6f5a36', false);
    pxIn(g, 11, 5, '#b23a32'); pxIn(g, 12, 5, '#b23a32'); pxIn(g, 11, 6, '#b23a32'); pxIn(g, 12, 6, '#b23a32'); // 红叉
    speckle(g, rand, 5, ['#8a7448', '#c9b784'], 1);
  },
  compass(g) {
    iconStart(g);
    blob(g, 8, 8, 6.2, 6.2, '#6d737a', '#34383d', '#aeb5bd', false);   // 外壳
    blob(g, 8, 8, 4.8, 4.8, '#d7dde3', '#9aa2aa', '#ffffff', false);   // 表盘
    line(g, 8, 8, 10, 5, '#b23a32', false);          // 红色 N 针
    line(g, 8, 8, 6, 11, '#e8edf1', false);          // 白色 S 针
    pxIn(g, 8, 8, '#2b2f33');
    pxIn(g, 8, 4, '#3b4250'); pxIn(g, 8, 11, '#3b4250');
  }
};

/* ============================================================
 * 对外入口 + missing texture 兜底
 * ============================================================ */

export function missingTexture(g, size) {
  const s = size > 0 ? Math.min(size, TILE) : TILE;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const d = (x + y) % 8;
      const stripe = d < 4;
      let c;
      if (stripe) c = (x + y) % 8 < 2 ? '#ff2bff' : '#d400d4';
      else c = (x + y) % 8 < 6 ? '#2b0030' : '#4a0052';
      rect(g, x, y, 1, 1, c);
    }
  }
}

function dispatch(table, name, g, rand, size) {
  if (!g) return false;
  const fn = table ? table[name] : null;
  if (typeof fn !== 'function') { missingTexture(g, size); return false; }
  try {
    fn(g, rand, size || TILE);
  } catch (e) {
    missingTexture(g, size);
    return false;
  }
  return true;
}

export function paintBlock(name, g, rand, size) {
  return dispatch(blockPainters, name, g, rand, size);
}

export function paintItem(name, g, rand, size) {
  return dispatch(itemPainters, name, g, rand, size);
}

/* ============================================================
 * 阶段 3b：生物像素贴图（先做骷髅与苦力怕两种）
 * 任务书：「每个以独立像素贴图、轮廓和正确转轴重做头/身/肢体，
 *          白天、暗处、火把边都能看出区别」。
 * 与方块/物品同一套约定：整数 fillRect、确定性 rand、绝不画出 16×16、不给躯体描边。
 * 画布第 0 行 = 面朝时的上方（THREE 纹理默认 flipY），所以「脚部深一档」写在下面几行。
 * 名字就是 mobs.js 里 box(..., {tex:'...'}) 引用的键；写错名字会走 missingTexture（品红），
 * 由单测「阶段3b 贴图注册表」把每个被引用的名字钉成真实存在的画笔。
 * ============================================================ */

const MOBSK = {
  bone: '#d8d8ce', boneDark: '#a8a89f', boneShade: '#83837b', boneLight: '#eeeee6',
  socket: '#20201d', cavity: '#3a3a36', rib: '#e4e4db',
  wood: '#7a5a34', woodLight: '#a3814c', woodDark: '#4e3620',
  green: '#57a84e', greenLight: '#7ccf6c', greenDark: '#3b7d38', greenDeep: '#28582a'
};

/* 骨面底纹：低对比颗粒 + 三条纵向纹理，暗处不至于糊成一块白 */
function boneBase(g, rand) {
  grain(g, rand, MOBSK.bone, LV_SOFT);
  line(g, 4, 0, 5, 15, tone(MOBSK.boneDark, 0.06), true);
  line(g, 11, 0, 12, 15, tone(MOBSK.boneDark, 0.06), true);
  line(g, 7, 0, 7, 15, tone(MOBSK.boneLight, -0.02), true);
  speckle(g, rand, 7, [MOBSK.boneDark, MOBSK.boneShade], 1);
}

/* 四肢骨：两端是关节头（上端略亮、下端略暗），中间两条细小裂纹 */
function skeletonBone(g, rand) {
  boneBase(g, rand);
  rect(g, 0, 0, 16, 2, tone(MOBSK.bone, 0.10));
  rect(g, 0, 14, 16, 2, tone(MOBSK.boneDark, 0.04));
  line(g, 3, 5, 5, 6, MOBSK.boneShade, false);
  line(g, 10, 9, 12, 10, MOBSK.boneShade, false);
}

/* 骷髅正面：两个内凹眼窝 + 鼻腔 + 齿列（眼窝比 3D 红眼点大一圈，才读得出「窝」） */
function skeletonSkullFront(g, rand) {
  boneBase(g, rand);
  for (const x of [3, 10]) {
    rect(g, x, 4, 4, 4, MOBSK.boneDark);
    rect(g, x + 1, 5, 2, 2, MOBSK.socket);
    px(g, x, 4, MOBSK.boneShade);
    px(g, x + 3, 4, MOBSK.boneShade);
    px(g, x, 7, MOBSK.boneLight);
    px(g, x + 3, 7, MOBSK.boneLight);
  }
  rect(g, 7, 8, 2, 2, MOBSK.cavity);
  px(g, 7, 7, MOBSK.cavity);
  rect(g, 0, 9, 3, 2, tone(MOBSK.boneDark, -0.04));
  rect(g, 13, 9, 3, 2, tone(MOBSK.boneDark, -0.04));
  rect(g, 3, 11, 10, 1, MOBSK.boneShade);
  rect(g, 3, 12, 10, 3, tone(MOBSK.bone, 0.12));
  for (let x = 5; x < 13; x += 2) line(g, x, 12, x, 14, MOBSK.boneShade, false);
}

/* 骷髅侧面：眼窝后缘、颅缝、下颌 */
function skeletonSkullSide(g, rand) {
  boneBase(g, rand);
  rect(g, 11, 4, 5, 4, MOBSK.boneDark);
  rect(g, 12, 5, 3, 2, MOBSK.socket);
  line(g, 0, 8, 15, 7, tone(MOBSK.boneDark, 0.05), true);
  rect(g, 0, 12, 9, 2, tone(MOBSK.boneDark, -0.02));
  px(g, 9, 12, MOBSK.boneShade);
}

function skeletonSkullTop(g, rand) {
  boneBase(g, rand);
  line(g, 8, 0, 8, 15, MOBSK.boneShade, true);
  line(g, 2, 8, 14, 8, tone(MOBSK.boneDark, 0.04), true);
}

/* 躯干正面：暗体腔 + 四条肋骨横档 + 中线胸骨（远看是「一排横条」而不是一个白块） */
function skeletonRibs(g, rand) {
  fillTile(g, MOBSK.cavity);
  for (let y = 2; y <= 13; y += 3) {
    rect(g, 1, y, 14, 2, tone(MOBSK.rib, y === 2 ? 0.05 : -0.02));
    px(g, 0, y, MOBSK.boneDark);
    px(g, 15, y, MOBSK.boneDark);
    px(g, 0, y + 1, MOBSK.boneDark);
    px(g, 15, y + 1, MOBSK.boneDark);
  }
  rect(g, 7, 0, 2, 16, tone(MOBSK.bone, -0.06));
  speckle(g, rand, 9, [MOBSK.boneDark, '#4a4a45'], 1);
}

/* 躯干侧/背面：脊柱柱 + 每三行一个椎间盘 */
function skeletonSpine(g, rand) {
  boneBase(g, rand);
  rect(g, 6, 0, 4, 16, tone(MOBSK.bone, -0.05));
  for (let y = 1; y < 16; y += 3) rect(g, 6, y, 4, 1, MOBSK.boneDark);
  speckle(g, rand, 6, [MOBSK.boneShade], 1);
}

/* 弓臂木纹：LV_MID 的颗粒 + 一道缠手带，暗处也看得出「这是一把弓」而不是一根木条 */
function skeletonBow(g, rand) {
  grain(g, rand, MOBSK.wood, LV_MID);
  line(g, 0, 4, 15, 3, MOBSK.woodLight, true);
  line(g, 0, 11, 15, 12, MOBSK.woodDark, true);
  rect(g, 5, 0, 6, 16, MOBSK.woodDark);            // 缠手带
  line(g, 5, 0, 5, 15, tone(MOBSK.wood, 0.10), false);
  line(g, 10, 0, 10, 15, tone(MOBSK.wood, 0.10), false);
  speckle(g, rand, 8, [MOBSK.woodDark, MOBSK.woodLight], 1);
}

function creeperSkin(g, rand) {
  grain(g, rand, MOBSK.green, LV_SOFT);
  patches(g, rand, 10, MOBSK.green, [-0.10, -0.05, 0.05, 0.10], 2, 4);
  speckle(g, rand, 16, [MOBSK.greenLight, MOBSK.greenDark], 2);
}

/* 头顶/脚底：整体压暗一档，逆光与火把边都能把轮廓和身体分开。
   注意 base 必须是 16 进制色值：grain()/patches() 内部还会再调一次 tone()，
   而 tone() 只认 '#rrggbb' —— 把 tone() 的输出（'rgb(...)'）再喂进去会解析成乱色（本轮实测踩到）。 */
function creeperSkinDark(g, rand) {
  grain(g, rand, MOBSK.greenDark, LV_SOFT);
  patches(g, rand, 8, MOBSK.greenDark, [-0.08, 0.04, 0.10], 2, 3);
  speckle(g, rand, 12, [MOBSK.greenDeep, MOBSK.green], 2);
}

/* 四足：脚部明显深一档 + 一条分界，斜侧视时四条腿各自读得出来 */
function creeperLeg(g, rand) {
  grain(g, rand, MOBSK.green, LV_SOFT);
  rect(g, 0, 10, 16, 1, MOBSK.greenDeep);
  rect(g, 0, 11, 16, 5, MOBSK.greenDark);
  speckle(g, rand, 7, [MOBSK.greenLight, MOBSK.greenDeep], 1);
}

export const MOB_TEX_SIZE = TILE;

/* ============================================================
 * 阶段 3c：鹦鹉（飞鸟）像素贴图
 * 任务书要「清楚的翅膀轮廓」与「给鱼和鸟补上材质层次」：
 *   翅膀画成「一排叠压的飞羽 + 外缘亮一档的飞边」—— 收拢时读得出贴在身上的翼形，
 *   拍动时那圈飞边就是轮廓线；身体分胸腹（亮）与背（暗）两档并带斜向羽层，
 *   暗处和火把边都不会糊成一块纯绿。约定与上面完全一致：整数 fillRect、确定性 rand、
 *   不画出 16×16、不给躯体描边。
 * ============================================================ */

const MOBPR = {
  body: '#3fa93f', bodyLight: '#6cc85c', bodyDark: '#2b7a34', bodyDeep: '#1c5327',
  belly: '#d8ec86', chest: '#bfe177',
  wing: '#2f8f46', wingLight: '#79cf6a', wingEdge: '#a8e290', wingDark: '#1b5c31',
  head: '#49b84a', cheek: '#f2f2e6', eyeFront: '#2a3d24',
  tail: '#c8402f', tailDark: '#8e2c22', tailLight: '#e06a4c'
};

/* 羽底：低对比颗粒 + 两道斜向羽层走向（斜线让身体看起来是「一层层叠上去的」） */
function parrotBase(g, rand, c) {
  grain(g, rand, c, LV_SOFT);
  line(g, 0, 4, 15, 7, tone(c, -0.05), false);
  line(g, 0, 10, 15, 12, tone(c, 0.04), false);
  speckle(g, rand, 6, [tone(c, -0.07), tone(c, 0.05)], 1);
}

/* 身体侧面：胸腹亮一档（画布上半）、背与腹下暗一档，再压三道斜向羽层 */
function parrotBody(g, rand) {
  parrotBase(g, rand, MOBPR.body);
  rect(g, 0, 0, 16, 4, MOBPR.belly);
  rect(g, 1, 1, 14, 2, MOBPR.chest);
  rect(g, 0, 12, 16, 4, MOBPR.bodyDark);
  rect(g, 0, 15, 16, 1, MOBPR.bodyDeep);
  for (let y = 5; y < 12; y += 3) {
    line(g, 0, y, 15, y + 2, tone(MOBPR.bodyDark, 0.02), false);
    line(g, 0, y + 1, 15, y + 3, tone(MOBPR.bodyLight, -0.02), false);
  }
  px(g, 3, 7, MOBPR.wingDark);
  px(g, 11, 9, MOBPR.wingDark);
}

/* 翅膀：四条主翼羽自内向外叠压，最外一条是亮飞边 —— 收拢时是翼形，拍动时是轮廓线 */
function parrotWing(g, rand) {
  grain(g, rand, MOBPR.wing, LV_SOFT);
  rect(g, 0, 0, 16, 3, MOBPR.wingDark);
  for (let x = 0; x < 16; x += 4) {
    rect(g, x, 3, 4, 6, tone(MOBPR.wing, x >= 12 ? 0.05 : -0.02));
    line(g, x, 3, x, 9, MOBPR.wingDark, true);
    rect(g, x + 1, 4, 2, 4, MOBPR.wingLight);
  }
  rect(g, 0, 9, 16, 2, MOBPR.wingEdge);
  rect(g, 0, 11, 16, 3, MOBPR.wingDark);
  rect(g, 0, 14, 16, 2, MOBPR.bodyDeep);
  for (let x = 2; x < 16; x += 4) px(g, x, 10, tone(MOBPR.wingEdge, 0.06));
}

/* 头：绿色底 + 脸颊一块浅斑 + 眼先一道暗色（眼睛本体仍由 makeMesh 钉通用眼珠） */
function parrotHead(g, rand) {
  parrotBase(g, rand, MOBPR.head);
  rect(g, 0, 0, 16, 2, tone(MOBPR.head, 0.08));
  rect(g, 3, 6, 8, 5, MOBPR.cheek);
  rect(g, 4, 7, 6, 3, tone(MOBPR.cheek, -0.05));
  rect(g, 0, 5, 3, 4, MOBPR.eyeFront);
  rect(g, 0, 12, 16, 4, MOBPR.bodyDark);
  px(g, 1, 6, MOBPR.bodyDeep);
  px(g, 2, 8, MOBPR.bodyDeep);
}

/* 尾：收束的长尾羽，尖端深红，中间一道亮脊 —— 侧后方看是一条有层次的尾巴 */
function parrotTail(g, rand) {
  grain(g, rand, MOBPR.tail, LV_SOFT);
  rect(g, 0, 0, 16, 2, MOBPR.tailLight);
  rect(g, 0, 14, 16, 2, MOBPR.tailDark);
  for (let x = 1; x < 16; x += 3) {
    line(g, x, 2, x, 13, tone(MOBPR.tailDark, 0.03), true);
    px(g, x + 1, 6, MOBPR.tailLight);
  }
  rect(g, 7, 0, 2, 16, tone(MOBPR.tailLight, 0.05));
}

/* ============================================================
 * 阶段 3c：鳕鱼像素贴图（任务书「给鱼和鸟补上材质层次与可辨认的小幅动作」里的鱼那一半）
 * 阶段 3a 只给了平涂色块，水下近看是一块没有层次的蓝灰。这里按骷髅/苦力怕/鹦鹉
 * 同一套约定补贴图：整数 fillRect、确定性 rand、绝不画出 16×16、不给躯体描边。
 * 色值仍然取 mobs.js 里那几档原有平涂色（body/head/tail/fin），
 * 这样换了贴图之后群体的远看色调不变 —— 阶段 3a 的既有验收（鱼群成群、在水里、会游）
 * 不会因为「换了个颜色」而被牵连。
 * ============================================================ */
const MOBCOD = {
  body: '#9fb8c6', bodyLight: '#c3d7e0', bodyDark: '#7794a6', bodyDeep: '#5b7686',
  belly: '#dfe9ee', scale: '#8aa8b8', side: '#4f6d7d',
  head: '#b6cbd6', headDark: '#8ba6b4', gill: '#6f8d9c',
  tail: '#89a6b6', tailDark: '#5f7f90', tailLight: '#adc4cf',
  fin: '#8fa9b8', finDark: '#617f8f', top: '#7f9dad'
};

/* 鱼身侧面：背深腹亮 + 一排斜鳞 + 一条侧线横穿（远看是「有厚度的鱼」而不是一块蓝灰） */
function codBody(g, rand) {
  grain(g, rand, MOBCOD.body, LV_SOFT);
  rect(g, 0, 0, 16, 3, MOBCOD.bodyDark);
  rect(g, 0, 3, 16, 2, tone(MOBCOD.bodyDark, -0.03));
  rect(g, 0, 11, 16, 3, MOBCOD.belly);
  rect(g, 0, 14, 16, 2, tone(MOBCOD.belly, -0.03));
  line(g, 0, 7, 15, 7, MOBCOD.side, true);                 // 侧线：一整条不断开，暗处也读得出走向
  line(g, 0, 8, 15, 8, tone(MOBCOD.side, 0.10), true);
  for (let x = 1; x < 16; x += 3) {
    line(g, x, 4, x + 2, 10, tone(MOBCOD.scale, -0.03), false);
    px(g, x + 1, 5, MOBCOD.bodyLight);
  }
  speckle(g, rand, 8, [MOBCOD.bodyLight, MOBCOD.bodyDeep], 1);
}

/* 鱼头：鳃盖一道弧 + 吻部亮一档 + 眼先一块暗（眼睛本体仍由 makeMesh 钉通用眼珠） */
function codHead(g, rand) {
  grain(g, rand, MOBCOD.head, LV_SOFT);
  rect(g, 0, 0, 16, 3, tone(MOBCOD.headDark, -0.02));
  rect(g, 0, 12, 16, 4, MOBCOD.belly);
  line(g, 3, 1, 1, 14, MOBCOD.gill, true);                 // 鳃盖后缘
  line(g, 4, 1, 2, 14, tone(MOBCOD.gill, 0.08), true);
  rect(g, 0, 4, 2, 7, tone(MOBCOD.headDark, 0.04));
  px(g, 1, 6, MOBCOD.side);
  px(g, 1, 7, MOBCOD.side);
  rect(g, 12, 3, 4, 3, tone(MOBCOD.head, 0.06));           // 吻部亮一档
  line(g, 0, 8, 15, 9, tone(MOBCOD.headDark, 0.02), false);
  speckle(g, rand, 5, [MOBCOD.headDark, MOBCOD.belly], 1);
}

/* 尾鳍：尾柄在画布左侧，鳍条自内向外散开，末端深一档 —— 摆起来读得出「一片扇」 */
function codTail(g, rand) {
  grain(g, rand, MOBCOD.tail, LV_SOFT);
  rect(g, 0, 5, 3, 6, MOBCOD.tailDark);                    // 尾柄
  rect(g, 0, 0, 16, 2, tone(MOBCOD.tailDark, 0.04));
  rect(g, 0, 14, 16, 2, tone(MOBCOD.tailDark, 0.04));
  for (let i = 0; i < 8; i++) {
    const y = 2 + i;
    line(g, 3, 8, 15, y, tone(i % 2 ? MOBCOD.tailLight : MOBCOD.tailDark, 0.02), false);
  }
  for (let y = 2; y < 14; y += 2) px(g, 15, y, MOBCOD.tailDark);
  speckle(g, rand, 5, [MOBCOD.tailLight, MOBCOD.tailDark], 1);
}

/* 胸鳍 / 背鳍：平行软鳍条 + 一根硬棘，小幅摆动时才看得出「鳍」而不是一块突出 */
function codFin(g, rand, top) {
  grain(g, rand, top ? MOBCOD.top : MOBCOD.fin, LV_SOFT);
  rect(g, 0, 0, 16, 2, tone(top ? MOBCOD.top : MOBCOD.fin, -0.06));
  for (let x = 1; x < 16; x += 2) line(g, x, 2, x + 1, 13, tone(top ? MOBCOD.finDark : MOBCOD.tailDark, 0.03), true);
  line(g, 0, 6, 15, 5, MOBCOD.side, true);                 // 硬棘：暗一档，鳍面分两层
  rect(g, 0, 13, 16, 3, tone(top ? MOBCOD.finDark : MOBCOD.tailDark, 0.04));
  px(g, 2, 10, MOBCOD.tailLight);
  px(g, 9, 10, MOBCOD.tailLight);
}

function codFinTop(g, rand) { codFin(g, rand, true); }


/* ============================================================================
 * 阶段 6：常见家畜的像素贴图（猪 / 牛 / 羊）
 * 阶段 3b 只重做了骷髅与苦力怕、3c 补了鱼与鹦鹉；猪牛羊一直是**平涂色块**，
 * 站在骷髅旁边就像两种画风。这里按同一套画法（grain / speckle / line / rect，
 * 16×16、LV_SOFT 低对比颗粒）补齐，颜色仍沿用各自原来的底色，
 * 保证「近看有层次、远看还是那头猪」，也不影响任何以底色为准的旧断言。
 * ========================================================================== */
const MOBPIG = {
  skin: '#e89a9a', skinLight: '#f3b6b6', skinDark: '#c97b7b', skinDeep: '#a85f5f',
  snout: '#d98a8a', snoutDark: '#b96b6b', hoof: '#8d5f5f'
};
const MOBCOW = {
  hide: '#4a3b32', hideLight: '#6a564a', hideDark: '#32261f', hideDeep: '#241a15',
  patch: '#efe9df', patchDark: '#cdc4b6', hoof: '#241a15'
};
const MOBSHEEP = {
  wool: '#ecebe3', woolLight: '#fbfaf4', woolDark: '#c9c6bb', woolDeep: '#a8a49a',
  skin: '#e7b3a9', skinLight: '#f0c7bd', skinDark: '#c1907f', hoof: '#bdb3a4'
};

/* 猪身：背脊暗一档、腹侧亮一档 + 稀疏鬃毛点（远看仍是粉，近看有体积） */
function pigBody(g, rand) {
  grain(g, rand, MOBPIG.skin, LV_SOFT);
  rect(g, 0, 0, 16, 3, MOBPIG.skinDark);
  rect(g, 0, 2, 16, 1, tone(MOBPIG.skinDark, 0.04));
  rect(g, 0, 12, 16, 4, MOBPIG.skinLight);
  line(g, 0, 8, 15, 8, tone(MOBPIG.skinDark, 0.06), false);
  for (let x = 1; x < 16; x += 4) px(g, x + ((rand() * 2) | 0), 1 + ((rand() * 2) | 0), MOBPIG.skinDeep);
  speckle(g, rand, 9, [MOBPIG.skinLight, MOBPIG.skinDark], 1);
}

/* 猪头：一只朝前的鼻孔面 + 耳朵根部的暗带（眼睛本体仍由模型钉通用眼珠） */
function pigHead(g, rand) {
  grain(g, rand, MOBPIG.skin, LV_SOFT);
  rect(g, 0, 0, 16, 2, tone(MOBPIG.skinDark, 0.02));
  rect(g, 2, 4, 12, 8, MOBPIG.snout);
  rect(g, 3, 5, 4, 2, MOBPIG.snoutDark);
  rect(g, 9, 5, 4, 2, MOBPIG.snoutDark);
  rect(g, 2, 11, 12, 2, tone(MOBPIG.snout, -0.05));
  line(g, 1, 12, 14, 15, tone(MOBPIG.skinDark, 0.03), false);
  speckle(g, rand, 6, [MOBPIG.skinLight, MOBPIG.skinDeep], 1);
}

/* 猪腿：上端接身体（暗）、下端蹄（更深），中间一条竖纹 */
function pigLeg(g, rand) {
  grain(g, rand, MOBPIG.skinDark, LV_SOFT);
  rect(g, 0, 0, 16, 3, tone(MOBPIG.skinDark, -0.04));
  rect(g, 0, 12, 16, 4, MOBPIG.hoof);
  line(g, 7, 3, 7, 12, tone(MOBPIG.skinDeep, 0.04), true);
  speckle(g, rand, 5, [MOBPIG.skin, MOBPIG.skinDeep], 1);
}

/* 牛身：深棕底 + 大块白斑（边界故意不规则），这是牛与猪最好认的区别 */
function cowBody(g, rand) {
  grain(g, rand, MOBCOW.hide, LV_SOFT);
  rect(g, 0, 0, 16, 3, MOBCOW.hideDark);
  rect(g, 0, 13, 16, 3, tone(MOBCOW.hideDark, -0.02));
  /* 两块白斑：一块压在上半、一块斜切下半，边缘用零散像素打碎 */
  rect(g, 2, 3, 6, 5, MOBCOW.patch);
  rect(g, 8, 3, 3, 3, MOBCOW.patch);
  rect(g, 9, 9, 5, 4, MOBCOW.patch);
  for (let i = 0; i < 8; i++) px(g, 1 + ((rand() * 14) | 0), 2 + ((rand() * 11) | 0), MOBCOW.patchDark);
  for (let i = 0; i < 6; i++) px(g, 2 + ((rand() * 12) | 0), 4 + ((rand() * 9) | 0), MOBCOW.hideLight);
  speckle(g, rand, 7, [MOBCOW.hideLight, MOBCOW.hideDeep], 1);
}

/* 牛头：额头一块亮毛 + 鼻镜两道 + 双角根部（角本体是模型部件） */
function cowHead(g, rand) {
  grain(g, rand, MOBCOW.hide, LV_SOFT);
  rect(g, 0, 0, 16, 3, MOBCOW.hideDark);
  rect(g, 3, 2, 10, 3, MOBCOW.patch);
  rect(g, 2, 10, 12, 5, tone(MOBCOW.hideDark, 0.05));
  rect(g, 4, 12, 3, 2, MOBCOW.hideDeep);
  rect(g, 9, 12, 3, 2, MOBCOW.hideDeep);
  line(g, 1, 9, 14, 9, tone(MOBCOW.patchDark, 0.02), false);
  speckle(g, rand, 6, [MOBCOW.hideLight, MOBCOW.hideDeep], 1);
}

function cowLeg(g, rand) {
  grain(g, rand, MOBCOW.hideDark, LV_SOFT);
  rect(g, 0, 0, 16, 3, tone(MOBCOW.hideDark, -0.05));
  rect(g, 0, 12, 16, 4, MOBCOW.hoof);
  line(g, 8, 3, 8, 12, tone(MOBCOW.hideDeep, 0.06), true);
  speckle(g, rand, 4, [MOBCOW.hide, MOBCOW.hideDeep], 1);
}

/* 羊毛：满屏短卷（3px 的团簇），比平涂更能读成「毛」；剪过毛的皮肤色由模型自己换色 */
function sheepBody(g, rand) {
  grain(g, rand, MOBSHEEP.wool, LV_SOFT);
  for (let i = 0; i < 14; i++) {
    const x = (rand() * 14) | 0, y = (rand() * 14) | 0;
    rect(g, x, y, 2, 2, i % 2 ? MOBSHEEP.woolLight : MOBSHEEP.woolDark);
  }
  rect(g, 0, 0, 16, 2, MOBSHEEP.woolDark);
  rect(g, 0, 14, 16, 2, tone(MOBSHEEP.woolDark, -0.02));
  speckle(g, rand, 8, [MOBSHEEP.woolLight, MOBSHEEP.woolDeep], 1);
}

/* 剪过毛的羊身：只剩粉皮 + 稀疏残留短绒。这里是**身体**，不能带脸 ——
   口鼻、鼻孔、暗额与额前绒毛属于 sheep_head。阶段 6 早期把它直接铺到整个身体上，
   玩家近看会在羊身上看到第二张脸；现在独立成一张，语义与 sheep_body 对称。 */
function sheepSkin(g, rand) {
  grain(g, rand, MOBSHEEP.skin, LV_SOFT);
  rect(g, 0, 0, 16, 2, MOBSHEEP.skinDark);
  rect(g, 0, 14, 16, 2, tone(MOBSHEEP.skinDark, 0.03));
  for (let i = 0; i < 10; i++) {
    const x = (rand() * 13) | 0, y = 3 + ((rand() * 9) | 0);
    px(g, x, y, i % 2 ? MOBSHEEP.woolLight : MOBSHEEP.woolDark);
    px(g, x + 1, y, MOBSHEEP.woolDark);
  }
  speckle(g, rand, 6, [MOBSHEEP.skinLight, MOBSHEEP.skinDark], 1);
}

function sheepHead(g, rand) {
  grain(g, rand, MOBSHEEP.skin, LV_SOFT);
  rect(g, 0, 0, 16, 3, MOBSHEEP.skinDark);
  /* 额头一小撮留存的绒毛（剪过毛的羊头上还有一撮），再把口鼻提亮一档：
     多了这两层，色档从 3 提到 5，近看才分得清「粉皮 / 暗额 / 亮吻 / 鼻孔 / 绒」 */
  rect(g, 4, 3, 8, 2, MOBSHEEP.woolDark);
  rect(g, 3, 9, 10, 5, tone(MOBSHEEP.skin, 0.07));
  rect(g, 5, 11, 6, 2, MOBSHEEP.skinLight);
  line(g, 4, 11, 11, 11, MOBSHEEP.skinDark, false);
  px(g, 5, 12, MOBSHEEP.skinDark);
  px(g, 10, 12, MOBSHEEP.skinDark);
  speckle(g, rand, 6, [MOBSHEEP.woolLight, MOBSHEEP.skinDark], 1);
}

function sheepLeg(g, rand) {
  grain(g, rand, MOBSHEEP.hoof, LV_SOFT);
  rect(g, 0, 0, 16, 4, MOBSHEEP.woolDark);
  rect(g, 0, 12, 16, 4, tone(MOBSHEEP.hoof, -0.06));
  speckle(g, rand, 4, [MOBSHEEP.wool, MOBSHEEP.hoof], 1);
}

/* ---------- 本轮 C：僵尸与地牢守卫的像素贴图 ----------
 * 目的：把这两类角色从「纯色盒子」拉到与骷髅/苦力怕/动物同一档完成度。
 * 约束与其它生物贴图一致：整数 fillRect、确定性 rand、绝不画出 16×16、不给躯体描边。
 * 画布第 0 行 = 面朝时的上方（THREE 纹理默认 flipY）。 */
const MOBZ = {
  skin: '#7ba05b', skinLight: '#94b874', skinDark: '#5d7d46', skinDeep: '#445c34',
  shirt: '#2f6a52', shirtLight: '#3d7f63', shirtDark: '#234f3e',
  pants: '#2b3b63', pantsDark: '#1f2c4b', pantsLight: '#374a78',
  socket: '#26301f', eye: '#c9e08a'
};

/* 僵尸头：正面有眼窝/鼻孔/下颌，侧面是耳朵与鬓角，顶面头发，底面脖子 */
function zombieHeadFront(g, rand) {
  grainSparse(g, rand, MOBZ.skin, [-0.06, -0.03, 0.03, 0.06], 0.34);
  rect(g, 0, 0, 16, 2, MOBZ.skinDeep);                 // 额前阴影
  /* 眼窝：2×2 深坑 + 一点浑浊的亮 */
  rect(g, 3, 5, 3, 2, MOBZ.socket);
  rect(g, 10, 5, 3, 2, MOBZ.socket);
  px(g, 4, 6, MOBZ.eye); px(g, 11, 6, MOBZ.eye);
  /* 鼻梁与鼻孔 */
  rect(g, 7, 7, 2, 3, MOBZ.skinDark);
  px(g, 7, 9, MOBZ.socket); px(g, 8, 9, MOBZ.socket);
  /* 干裂的嘴：一条深线 + 两侧下垂 */
  rect(g, 4, 11, 8, 1, MOBZ.skinDeep);
  px(g, 4, 12, MOBZ.skinDeep); px(g, 11, 12, MOBZ.skinDeep);
  px(g, 6, 11, MOBZ.skinLight);
  speckle(g, rand, 6, [MOBZ.skinDark, MOBZ.skinLight], 1);
}

function zombieHeadSide(g, rand) {
  grainSparse(g, rand, MOBZ.skin, [-0.06, -0.03, 0.03, 0.06], 0.32);
  rect(g, 0, 0, 16, 2, MOBZ.skinDeep);
  rect(g, 0, 2, 3, 12, MOBZ.skinDeep);                 // 鬓角
  rect(g, 10, 6, 4, 4, MOBZ.skinDark);                 // 耳
  px(g, 12, 8, MOBZ.socket);
  rect(g, 4, 11, 8, 1, MOBZ.skinDeep);                 // 下颌线
  speckle(g, rand, 6, [MOBZ.skinDark, MOBZ.skinLight], 1);
}

function zombieHeadTop(g, rand) {
  grainSparse(g, rand, MOBZ.skinDark, [-0.05, -0.02, 0.03, 0.05], 0.34);
  rect(g, 2, 2, 12, 3, MOBZ.skinDeep);
  speckle(g, rand, 8, [MOBZ.skinDeep, MOBZ.skin], 1);
}

/* 躯干：破衬衫，露出肩颈皮肤与破洞 */
function zombieBody(g, rand) {
  grainSparse(g, rand, MOBZ.shirt, [-0.06, -0.03, 0.02, 0.05], 0.36);
  rect(g, 0, 0, 16, 3, MOBZ.shirtDark);                 // 衣领阴影
  rect(g, 1, 1, 14, 1, MOBZ.skin);                      // 露出的锁骨/颈根
  rect(g, 0, 0, 1, 16, MOBZ.shirtDark);
  rect(g, 15, 0, 1, 16, MOBZ.shirtDark);
  /* 破口：不规则的 2~3px 洞，露出皮肤 */
  for (const [x, y, w, h] of [[4, 6, 3, 2], [10, 9, 2, 3], [6, 12, 4, 2]]) {
    rect(g, x, y, w, h, MOBZ.skinDark);
    px(g, x, y, MOBZ.shirtDark);
  }
  speckle(g, rand, 8, [MOBZ.shirtLight, MOBZ.shirtDark], 1);
}

function zombieArm(g, rand) {
  grainSparse(g, rand, MOBZ.shirt, [-0.06, -0.02, 0.03, 0.05], 0.34);
  rect(g, 0, 9, 16, 7, MOBZ.skin);                      // 小臂与手：皮肤
  rect(g, 0, 9, 16, 1, MOBZ.skinDark);                  // 袖口
  px(g, 2, 13, MOBZ.skinDark); px(g, 5, 14, MOBZ.skinDark);
  px(g, 9, 13, MOBZ.skinDark); px(g, 12, 14, MOBZ.skinDark);
  rect(g, 0, 15, 16, 1, MOBZ.skinDeep);                 // 指尖压暗
  speckle(g, rand, 6, [MOBZ.shirtLight, MOBZ.skinLight], 1);
}

function zombieLeg(g, rand) {
  grainSparse(g, rand, MOBZ.pants, [-0.05, -0.02, 0.02, 0.05], 0.34);
  rect(g, 0, 0, 16, 2, MOBZ.pantsLight);                // 裤腰
  rect(g, 0, 10, 16, 1, MOBZ.pantsDark);                // 膝盖折痕
  rect(g, 0, 14, 16, 2, MOBZ.pantsDark);                // 裤脚
  speckle(g, rand, 6, [MOBZ.pantsLight, MOBZ.pantsDark], 1);
}

/* 守卫：石 / 金属 / 核心 三种材质分工 */
const MOBG = {
  stone: '#5a636d', stoneLight: '#707b86', stoneDark: '#454d56', stoneDeep: '#333a42',
  metal: '#8a939c', metalLight: '#aeb7c0', metalDark: '#5f676f',
  core: '#e8c65a', coreLight: '#fff0a8', coreDark: '#a8842c',
  eye: '#ff6b3d', eyeLight: '#ffb08a'
};

function guardianBody(g, rand) {
  /* 石质胸甲：中缝 + 两侧金属条 + 铆钉 */
  grainSparse(g, rand, MOBG.stone, [-0.06, -0.03, 0.03, 0.05], 0.34);
  rect(g, 0, 0, 16, 2, MOBG.stoneDark);
  rect(g, 0, 14, 16, 2, MOBG.stoneDeep);
  rect(g, 7, 2, 2, 12, MOBG.stoneDark);                  // 中缝
  rect(g, 1, 2, 2, 12, MOBG.metal);                      // 左右金属条
  rect(g, 13, 2, 2, 12, MOBG.metal);
  rect(g, 1, 2, 1, 12, MOBG.metalLight);
  rect(g, 13, 2, 1, 12, MOBG.metalLight);
  for (const y of [4, 8, 12]) { px(g, 4, y, MOBG.metalLight); px(g, 12, y, MOBG.metalLight); }
  /* 胸口核心的凹槽（核心本体是独立部件，这里只给凹槽一圈暗边） */
  rect(g, 5, 6, 6, 5, MOBG.stoneDeep);
  rect(g, 6, 7, 4, 3, '#3a2f16');
  speckle(g, rand, 7, [MOBG.stoneLight, MOBG.stoneDeep], 1);
}

function guardianCore(g, rand) {
  /* 核心：中心亮、边缘暗的十字光，带两档高光 */
  fillTile(g, '#3a2f16');
  rect(g, 1, 1, 14, 14, MOBG.coreDark);
  rect(g, 2, 2, 12, 12, MOBG.core);
  rect(g, 4, 4, 8, 8, MOBG.coreLight);
  rect(g, 6, 6, 4, 4, '#ffffff');
  px(g, 3, 3, MOBG.coreDark); px(g, 12, 12, MOBG.coreDark);
}

function guardianHeadFront(g, rand) {
  grainSparse(g, rand, MOBG.stoneDark, [-0.05, -0.02, 0.03, 0.05], 0.32);
  rect(g, 0, 0, 16, 2, MOBG.stoneDeep);
  rect(g, 0, 13, 16, 3, MOBG.stoneDeep);
  /* 面具：两条金属护额 + 眼缝（眼窝本体是独立发光部件） */
  rect(g, 0, 3, 16, 2, MOBG.metal);
  rect(g, 0, 3, 16, 1, MOBG.metalLight);
  rect(g, 2, 7, 4, 3, '#20262c');
  rect(g, 10, 7, 4, 3, '#20262c');
  rect(g, 2, 11, 12, 1, MOBG.stoneDeep);
  px(g, 3, 11, MOBG.metalLight); px(g, 12, 11, MOBG.metalLight);
  speckle(g, rand, 6, [MOBG.stoneLight, MOBG.stoneDeep], 1);
}

function guardianHeadSide(g, rand) {
  grainSparse(g, rand, MOBG.stone, [-0.05, -0.02, 0.03, 0.05], 0.32);
  rect(g, 0, 0, 16, 2, MOBG.stoneDeep);
  rect(g, 0, 3, 16, 2, MOBG.metal);
  rect(g, 0, 3, 16, 1, MOBG.metalLight);
  rect(g, 11, 7, 3, 3, '#20262c');
  rect(g, 0, 13, 16, 3, MOBG.stoneDeep);
  speckle(g, rand, 6, [MOBG.stoneLight, MOBG.stoneDeep], 1);
}

function guardianLimb(g, rand) {
  /* 关节段：上段石质，中段一圈金属箍，下段略暗 */
  grainSparse(g, rand, MOBG.stone, [-0.05, -0.02, 0.03, 0.05], 0.32);
  rect(g, 0, 5, 16, 2, MOBG.metal);
  rect(g, 0, 5, 16, 1, MOBG.metalLight);
  rect(g, 0, 12, 16, 4, MOBG.stoneDeep);
  px(g, 3, 8, MOBG.stoneLight); px(g, 9, 10, MOBG.stoneDeep);
  speckle(g, rand, 6, [MOBG.stoneLight, MOBG.stoneDeep], 1);
}

/* 眼窝里的那道橙光：中心亮核 + 一圈暗边，尺寸虽小但也要有「发光」的层次 */
function guardianEye(g, rand) {
  fillTile(g, '#5b1f10');
  rect(g, 1, 2, 14, 12, '#b53f1d');
  rect(g, 3, 4, 10, 8, MOBG.eye);
  rect(g, 5, 6, 6, 4, MOBG.eyeLight);
  rect(g, 7, 7, 2, 2, '#fff2e6');
}

/* 玩家自己的小臂与手（第一人称）：袖口 + 皮肤两段，一条指缝，与人形生物同一套色阶 */
function playerArm(g, rand) {
  grainSparse(g, rand, '#d9a978', [-0.05, -0.02, 0.02, 0.05], 0.32);
  rect(g, 0, 0, 16, 6, '#3f6fa8');                 // 袖子
  rect(g, 0, 5, 16, 1, '#345c8c');                 // 袖口
  rect(g, 0, 6, 16, 1, '#c99566');                 // 袖口下的暗影
  /* 手：拇指与指缝 */
  rect(g, 2, 9, 12, 5, '#e3b485');
  rect(g, 1, 10, 2, 3, '#e7bd90');                 // 拇指
  rect(g, 7, 12, 1, 3, '#c99566');                 // 指缝
  px(g, 3, 8, '#e7bd90'); px(g, 6, 8, '#e7bd90');
  speckle(g, rand, 5, ['#c99566', '#e7bd90'], 1);
}

export const mobPainters = {
  player_arm: playerArm,
  zombie_head: zombieHeadFront,
  zombie_head_side: zombieHeadSide,
  zombie_head_top: zombieHeadTop,
  zombie_body: zombieBody,
  zombie_arm: zombieArm,
  zombie_leg: zombieLeg,
  guardian_body: guardianBody,
  guardian_core: guardianCore,
  guardian_head: guardianHeadFront,
  guardian_head_side: guardianHeadSide,
  guardian_limb: guardianLimb,
  guardian_eye: guardianEye,
  skeleton_bone: skeletonBone,
  skeleton_skull_front: skeletonSkullFront,
  skeleton_skull_side: skeletonSkullSide,
  skeleton_skull_top: skeletonSkullTop,
  skeleton_ribs: skeletonRibs,
  skeleton_spine: skeletonSpine,
  skeleton_bow: skeletonBow,
  creeper_skin: creeperSkin,
  creeper_skin_dark: creeperSkinDark,
  creeper_leg: creeperLeg,
  parrot_body: parrotBody,
  parrot_wing: parrotWing,
  parrot_head: parrotHead,
  parrot_tail: parrotTail,
  cod_body: codBody,
  cod_head: codHead,
  cod_tail: codTail,
  cod_fin: (g, rand) => codFin(g, rand, false),
  cod_top: codFinTop,
  /* 阶段 6：常见家畜的贴图（与骷髅/苦力怕/鱼/鹦鹉同一套画法） */
  pig_body: pigBody,
  pig_head: pigHead,
  pig_leg: pigLeg,
  cow_body: cowBody,
  cow_head: cowHead,
  cow_leg: cowLeg,
  sheep_body: sheepBody,
  sheep_skin: sheepSkin,
  sheep_head: sheepHead,
  sheep_leg: sheepLeg
};

export function paintMobTex(name, g, rand, size) {
  return dispatch(mobPainters, name, g, rand, size);
}
