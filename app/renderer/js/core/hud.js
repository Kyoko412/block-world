'use strict';
/*
 * P2 HUD / 首夜引导的纯逻辑（不依赖 THREE 与 DOM，可无头单测）。
 *
 * 边界：不改六步目标链、不改成就、不改 dayLengthSeconds。
 * 规格文档明确写了「不照搬原版 1200 秒」—— 把一整天拉长会让所有等昼夜的 e2e 断言时长翻倍、
 * 自检逼近 350s 上限，必须先优化测试才动；本轮只把「第一晚该干什么」做成看得见的提示。
 */
import { NIGHT_START, isNight, wrapTime } from './time.js';

/** 入夜前多久开始预警：占一整个昼夜周期的比例。600s 制下 = 36 秒 */
export const NIGHT_WARNING_LEAD = 0.06;

/**
 * 当前该显示哪种夜间提示：
 *   'soon'  入夜前一小段（给玩家做准备的时间）
 *   'night' 已入夜
 *   null    其余白天时段（含清晨），不占 HUD
 */
export function nightPhase(t) {
  const x = wrapTime(t);
  if (isNight(x)) return 'night';
  /* 1e-9 容差：0.55 - 0.06 在浮点里是 0.49000000000000005，不让边界那一瞬漏掉预警 */
  if (x >= NIGHT_START - NIGHT_WARNING_LEAD - 1e-9 && x < NIGHT_START) return 'soon';
  return null;
}

/** 提示文案：按玩家手上有没有照明 / 床 / 是否遮蔽，给不同的具体下一步 */
export function nightHintText(phase, opts = {}) {
  const torch = !!opts.torch, bed = !!opts.bed, sheltered = !!opts.sheltered;
  if (phase === 'soon') {
    if (!torch && !bed) return '天快黑了 · 做火把（煤 + 木棍）、挖个洞躲起来，或用床跳过夜晚';
    return '天快黑了 · 已有火把或床，找个安全位置准备过夜';
  }
  if (phase === 'night') {
    if (sheltered) return '夜里 · 待在亮处或屋里，别在露天久留';
    return '夜里 · 插火把照亮附近，或回庇护所等天亮';
  }
  return '';
}

/**
 * 两个矩形是否相交（HUD 遮挡判据）。
 * 双尺寸取证脚本用它在 900×500 / 1280×720 下判定目标提示有没有侵入快捷栏第 9 格；
 * 抽成纯函数是为了让「不相交」这条几何约束能进单测，而不是只靠人眼看截图。
 */
export function rectsOverlap(a, b) {
  if (!a || !b) return false;
  const ax2 = a.left + a.width, ay2 = a.top + a.height;
  const bx2 = b.left + b.width, by2 = b.top + b.height;
  return a.left < bx2 && ax2 > b.left && a.top < by2 && ay2 > b.top;
}
