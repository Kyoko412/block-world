'use strict';
/*
 * 天气系统（纯逻辑，无 DOM / 无 three，可无头单测）。
 *
 * 设计要点：
 *  - 只有三种状态：clear（晴）/ rain（雨）/ snow（雪），与原版的 clear/rain/thunderstorm 相比
 *    先把「看得见、摸得着」的两条做出来，雷暴留作后续（需要闪电与音效）。
 *  - 随机性全部走注入的 rnd：同一种子 → 同一切换序列，测试可确定；默认 Math.random。
 *  - intensity（0~1）用于渐入渐出：刚切换不会「哗」地砸满屏，快结束时也不会突然停。
 *  - 存档只存 {t, left, el, inten}，读档时对任何缺失/非法值都回落到晴天，绝不抛异常
 *    （旧版本存档根本没有 weather 字段，必须能读）。
 */

export const WEATHER_TYPES = ['clear', 'rain', 'snow'];
export const WEATHER_LABEL = { clear: '晴', rain: '雨', snow: '雪' };
export const STORM_LABEL = '雷暴';

/* 额外压暗系数（乘在昼夜光照上）：雨天最暗，雪天偏灰但没那么黑；雷暴再暗一档 */
export const WEATHER_LIGHT = { clear: 1, rain: 0.62, snow: 0.80 };
/* 雾的浓度倍数（>1 表示视距更短） */
export const WEATHER_FOG = { clear: 1, rain: 1.9, snow: 1.45 };
/* 每段持续秒数范围 [min, max]：晴天明显更长，免得下个不停 */
export const WEATHER_RANGE = { clear: [240, 720], rain: [45, 180], snow: [60, 240] };

/* 雷暴是「雨的加强子状态」，不新增 WEATHER_TYPES —— 旧断言、旧存档与音频环境床
   仍然只认 clear/rain/snow；storm 只是雨天上的一个布尔标记。 */
export const STORM_LIGHT = 0.48;
export const STORM_FOG = 2.35;
export const STORM_CHANCE = 0.18;        // 晴天转降水时，转成雷暴的概率

export const RAMP_UP_SECONDS = 8;      // 渐入到满强度所需时间
export const RAMP_DOWN_SECONDS = 6;    // 剩余时间低于这个值就开始渐出
export const RAIN_TO_SNOW_ON_COLD = false;  // 本作暂无温度/生物群系判定，留作扩展位

export function weatherLight(type, storm = false) {
  if (storm && type === 'rain') return STORM_LIGHT;
  return Object.prototype.hasOwnProperty.call(WEATHER_LIGHT, type) ? WEATHER_LIGHT[type] : 1;
}

export function weatherFog(type, storm = false) {
  if (storm && type === 'rain') return STORM_FOG;
  return Object.prototype.hasOwnProperty.call(WEATHER_FOG, type) ? WEATHER_FOG[type] : 1;
}

export function weatherLabel(type, storm = false) {
  return storm && type === 'rain' ? STORM_LABEL
    : (WEATHER_LABEL[type] || WEATHER_LABEL.clear);
}

export function isWetType(type) {
  return type === 'rain' || type === 'snow';
}

export class Weather {
  /** @param {() => number} [rnd] 注入的随机源（0~1），便于测试确定性 */
  constructor(rnd = Math.random) {
    this.rnd = typeof rnd === 'function' ? rnd : Math.random;
    this.type = 'clear';
    this.timeLeft = this.rollRange('clear');
    this.elapsed = 0;        // 当前这段已经走了多少秒（用于渐入）
    this.intensity = 0;      // 0~1，粒子与环境因子的权重
    this.storm = false;      // 雷暴标记（只对 rain 有意义）
  }

  get isWet() { return isWetType(this.type); }
  get isStorm() { return this.storm && this.type === 'rain'; }
  get label() { return weatherLabel(this.type, this.isStorm); }

  rollRange(type) {
    const r = WEATHER_RANGE[type] || WEATHER_RANGE.clear;
    const span = Math.max(0, r[1] - r[0]);
    return r[0] + span * clamp01(this.rnd());
  }

  /** 强制进入某个天气并按配置随机取时长（非法类型一律回落到晴天） */
  roll(type) {
    this.type = WEATHER_TYPES.includes(type) ? type : 'clear';
    this.timeLeft = this.rollRange(this.type);
    this.elapsed = 0;
    this.storm = false;          // 定点设置默认普通天气；雷暴由 setStorm 显式打开
    return this;
  }

  /** 开启/关闭雷暴（只对雨天生效；切到晴天/雪天会自动关闭） */
  setStorm(on) {
    this.storm = !!on && this.type === 'rain';
    return this.isStorm;
  }

  /** 一段走完之后的下一段：晴 → 降水（雨/雪/雷暴），降水 → 晴 */
  rollNext() {
    if (this.type === 'clear') {
      const r = this.rnd();
      if (r < STORM_CHANCE) {
        this.roll('rain');
        this.storm = true;
        return this;
      }
      return this.roll(r < 0.50 ? 'rain' : 'snow');
    }
    return this.roll('clear');
  }

  /**
   * 调试/外部指令用的定点设置：`set('rain')` 走随机时长，`set('rain', 60)` 固定 60 秒。
   * 与「自然切换」的区别：显式设置要求**立即生效**（`sleep` 放晴这类场景不该还挂着一屏雨滴），
   * 所以直接把强度归零；自然到点的 rollNext 才走渐入渐出。
   * @param {string} type @param {number} [seconds]
   */
  set(type, seconds) {
    this.roll(type);
    this.intensity = 0;
    if (typeof seconds === 'number' && seconds > 0) this.timeLeft = seconds;
    return this;
  }

  update(dt) {
    if (!(dt > 0)) return this;
    this.timeLeft -= dt;
    this.elapsed += dt;
    if (this.timeLeft <= 0) this.rollNext();     // 到点立刻换下一段，timeLeft 始终为正
    // 目标强度：晴天恒为 0；降水时「渐入」与「渐出」取较小者
    let want = 0;
    if (this.type !== 'clear') {
      want = Math.min(1, this.elapsed / RAMP_UP_SECONDS);
      want = Math.min(want, Math.max(0, this.timeLeft / RAMP_DOWN_SECONDS));
    }
    // 平滑逼近（与帧率无关：步进用 1-e^(-k·dt) 的近似）
    const k = 5;
    this.intensity += (want - this.intensity) * Math.min(1, k * dt);
    if (this.intensity < 1e-4) this.intensity = 0;
    if (this.intensity > 1 - 1e-4) this.intensity = 1;
    return this;
  }

  serialize() {
    const o = {
      t: this.type,
      left: +this.timeLeft.toFixed(3),
      el: +this.elapsed.toFixed(3),
      inten: +this.intensity.toFixed(4)
    };
    if (this.isStorm) o.s = 1;       // 旧档没有 s → 普通天气；普通天气也不写，保持旧格式精简
    return o;
  }

  /** 任何输入都不许抛异常：缺字段/类型不对/数值越界一律安全回落 */
  static deserialize(obj) {
    const w = new Weather();
    if (!obj || typeof obj !== 'object') return w;
    if (WEATHER_TYPES.includes(obj.t)) w.type = obj.t;
    const left = Number(obj.left);
    w.timeLeft = Number.isFinite(left) && left > 0 ? left : w.rollRange(w.type);
    const el = Number(obj.el);
    w.elapsed = Number.isFinite(el) && el >= 0 ? Math.min(el, 600) : 0;
    const inten = Number(obj.inten);
    w.intensity = Number.isFinite(inten) ? clamp01(inten) : (w.type === 'clear' ? 0 : 1);
    /* 只有「雨 + s 为真」才算雷暴；雪/晴上残留的 s 一律忽略，旧档缺 s 也是普通天气 */
    w.storm = !!obj.s && w.type === 'rain';
    return w;
  }
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}
