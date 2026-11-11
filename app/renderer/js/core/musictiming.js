/*
 * T4 音乐出场时机（纯函数，可无头单测）
 *
 * 参照口径：官方 Taking Inventory: Music Disc 只给了定性描述
 *   "doesn't play constantly … Most of the time you only hear the in-game sound effects,
 *    but very occasionally … gently fade in"。
 * minecraft.wiki/w/Music 的曲间随机间隔被反爬拦截，具体 ticks 查不到（见 原版参照规格.md「待查证」）。
 * 所以下面全部数值都是**本作设计约定，非原版数值**：只把「稀疏 / 缓入 / 曲终留白」
 * 这三条定性约束落成机器可判定的常数，不伪装成查证结果。
 *
 * 这个文件不碰 AudioContext、不碰曲目数据；sfx.js 只负责把包络与计时接上。
 */

export const MUSIC_TIMING = Object.freeze({
  leadInMin: 14,       // 进入世界后先安静 14~28 秒，再缓缓出现
  leadInMax: 28,
  fadeIn: 6,           // 缓入秒数（比原来的 2~3 秒交叉淡化更长）
  fadeOut: 5,          // 曲终淡出秒数
  gapMin: 110,         // 原创曲约 81—96 秒；曲间留白 110—190 秒，让环境声承担多数氛围
  gapMax: 190,
  loopsBeforeGap: 1    // 每播完一段就进留白
});

/** 返回一份可改的副本（诊断读数用；常量本体冻结，不许运行时篡改） */
export function timingConfig() { return Object.assign({}, MUSIC_TIMING); }

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

/** 注入 rng 便于单测钉边界；生产用 Math.random */
export function pickLeadIn(rng = Math.random, cfg = MUSIC_TIMING) {
  const r = clamp(Number(rng()), 0, 1);
  return +(cfg.leadInMin + (cfg.leadInMax - cfg.leadInMin) * r).toFixed(3);
}

export function pickGap(rng = Math.random, cfg = MUSIC_TIMING) {
  const r = clamp(Number(rng()), 0, 1);
  return +(cfg.gapMin + (cfg.gapMax - cfg.gapMin) * r).toFixed(3);
}

/**
 * 「doesn't play constantly」的可判定落地：一段音乐的播放时长占整个
 * 「播放 + 淡出 + 最短留白」周期的比例必须明显小于一半。
 * 用 loopSeconds（约 25~32 秒）算出占空比，给单测钉住，避免以后把留白调没。
 */
export function dutyCycle(loopSeconds, cfg = MUSIC_TIMING) {
  const play = Math.max(0.001, Number(loopSeconds) || 0.001);
  return +(play / (play + cfg.fadeOut + cfg.gapMin)).toFixed(6);
}

/**
 * 传入「离这一段播完还有多少秒」，返回该开始曲终淡出的等待毫秒数。
 * 提前 150ms 触发，让淡出盖住最后一点尾音；下限 1.2 秒防止异常参数把定时器压成 0。
 * 用「到段尾的剩余时间」而不是固定 loopSeconds，是为了兼容首次进入时的 lead-in 静默。
 */
export function segmentWaitMs(secondsUntilEnd) {
  const left = Math.max(0.001, Number(secondsUntilEnd) || 0.001);
  return Math.max(1200, Math.round(left * 1000) - 150);
}
