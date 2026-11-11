'use strict';
/*
 * sfx.js —— Web Audio 音效与音乐引擎
 *
 * 音效完全离线：移动与部分事件播放随包录音，并保留实时合成兜底。
 * 音乐（阶段 4 起）分两层：
 *   1) 程序化合成曲（audio/music.js 的 TRACKS）——永远保留，是兜底与降级路径；
 *   2) 随包的完整外部曲目（core/musicfiles.js 的 FILE_TRACKS）——day / night / cave
 *      各一首正式曲目，走**本地回环同源 URL**（/media/music/*.ogg），不发外部请求。
 *   解码好了就用文件曲（AudioBufferSourceNode → trim → music 总线），
 *   没解码好 / 解码失败 / 显式关掉文件轨时**立刻退回合成曲**，
 *   绝不允许「等文件」造成静音；文件就绪后再用 2~3 秒交叉淡化切过去。
 *
 * 用法：
 *   const sfx = new Sfx();
 *   首次用户交互时调用 sfx.resume();      // 只在这里 new AudioContext
 *   sfx.play('dig_stone', { pan: -0.3, rate: 1.05, volume: 1, detune: -40 });
 *   sfx.startMusic(); sfx.stopMusic();
 *
 * 约束：
 *   - 没有 AudioContext（或 ctx 已关闭）时 play() 静默返回，任何情况下都不抛异常；
 *   - 同名音效 40ms 内不重复触发；同时活跃 voice 上限 24；
 *   - 共享噪声 buffer 只生成一次；每个 voice 结束后 stop() + disconnect()；
 *   - 除 furnace_crack（炉火循环嘶声，规格要求 1~2 秒）外，音效时长都在 30~400ms；
 *   - 所有包络从 0 线性起振、指数收尾，不会出现爆音；
 *   - 任何时刻最多一条主曲（文件曲与合成曲共用同一套 lead-in / 淡入淡出 / 曲终留白状态机）；
 *   - 外部曲目的许可与来源是代码里的数据（core/musicfiles.js），由断言钉住，不只写在文档里。
 */

import { TRACKS, scheduleTrack, selectAmbient, ambientMix, trackInfo, AMBIENT_IDS } from './music.js';
import { MUSIC_TIMING, timingConfig, pickLeadIn, pickGap, segmentWaitMs } from '../core/musictiming.js';
import { FILE_TRACKS, FILE_TRACK_IDS, fileTrackFor, fileUrl } from '../core/musicfiles.js';
import { SFX_FILE_IDS, sfxFileFor, sfxFileUrl } from '../core/sfxfiles.js';
import { AMBIENT_FILE_IDS, ambientFileFor, ambientFileUrl } from '../core/ambientfiles.js';

export const SOUND_NAMES = [
  'step_grass', 'step_stone', 'step_sand', 'step_wood', 'step_snow',
  'dig_grass', 'dig_dirt', 'dig_stone', 'dig_wood', 'dig_sand', 'dig_gravel',
  'break_grass', 'break_dirt', 'break_stone', 'break_wood', 'break_sand',
  'place', 'hurt', 'death', 'eat', 'craft', 'pickup', 'click',
  'open_ui', 'close_ui', 'splash', 'swim', 'furnace_crack', 'explode', 'thunder', 'door',
  'pig', 'cow', 'chicken', 'sheep', 'zombie', 'skeleton', 'slime', 'wolf',
  'bow', 'hit', 'levelup', 'shield_block', 'shield_break', 'armor_break',
  'hiss', 'swing',
  /* 阶段 6：两条随包 CC0 音效（登记表 core/sfxfiles.js）。文件没取到时自动退回下面的合成配方。 */
  'guardian_awaken', 'guardian_reward',
  /* 本轮 D：把「借来的声音」拆成自己的身份，并给材质补真实差异。
     place_*  ：木的闷接触 / 石的短硬撞 / 土的松散落定（旧实现所有方块都是同一个 place）
     jump     ：起跳的身体声（原来借 UI 的 click）
     tool_break：工具断裂（原来借受伤的 hurt）
     guardian_warn：守卫前摇（原来借苦力怕的 hiss）
     *_b      ：步/挖的第二种瞬态结构（同一配方只改音高会听成机械重复） */
  'place_wood', 'place_stone', 'place_dirt', 'place_sand',
  'jump', 'tool_break', 'guardian_warn',
  'step_grass_b', 'step_stone_b', 'step_sand_b', 'step_wood_b',
  'dig_stone_b', 'dig_wood_b', 'dig_dirt_b'
];
for (const id of SFX_FILE_IDS) if (!SOUND_NAMES.includes(id)) SOUND_NAMES.push(id);

/* T4 关键音效：这些是「世界在回应你」的动作音，统一给一档可听性增益。
   用相对系数而不是绝对 dB，测试只钉系数与记账，不钉听感。 */
export const KEY_SOUNDS = Object.freeze([
  'step_grass', 'step_stone', 'step_sand', 'step_wood', 'step_snow',
  'dig_grass', 'dig_dirt', 'dig_stone', 'dig_wood', 'dig_sand', 'dig_gravel',
  'break_grass', 'break_dirt', 'break_stone', 'break_wood', 'break_sand',
  'place', 'hit', 'swing', 'shield_block', 'hiss',
  /* 本轮 E2：战斗与受伤分身份；变体名靠 keyGain 的基名规则继承同一档增益。 */
  'hurt_body', 'hurt_fall', 'hurt_drown', 'hit_flesh', 'hit_armor', 'shield_break', 'armor_break', 'bow_release', 'arrow_hit',
  /* 进食：干粮、果蔬、柔软熟食的咬/嚼/吞。 */
  'eat_bite_dry', 'eat_bite_juicy', 'eat_bite_soft', 'eat_chew_dry', 'eat_chew_juicy', 'eat_chew_soft', 'eat_swallow',
  ...SFX_FILE_IDS.filter(id => (id.startsWith('step_') || id.startsWith('land_')) &&
    !['step_grass', 'step_stone', 'step_sand', 'step_wood', 'step_snow'].includes(id))
]);
export const KEY_SFX_GAIN = 1.22;
/* 同一动作的第二/第三/第四条变体（dig_dirt_c 这类）必须和主名同档增益，
   否则连续敲击会在两条录音之间忽大忽小 —— 那不是「变体」，是音量抖动。 */
const VARIANT_SUFFIX = /_[b-d]$/;
export function keyGain(name) {
  if (KEY_SOUNDS.indexOf(name) >= 0) return KEY_SFX_GAIN;
  const base = VARIANT_SUFFIX.test(name) ? name.replace(VARIANT_SUFFIX, '') : name;
  return KEY_SOUNDS.indexOf(base) >= 0 ? KEY_SFX_GAIN : 1;
}

const MAX_VOICES = 24;
const THROTTLE_MS = 40;
const LEVEL = 1.25;                                  // 总线响度标定
const MUS_SCALE = [261.63, 293.66, 329.63, 392.0, 440.0]; // 五声音阶 C D E G A
/* 合成兜底曲相对随包曲目的增益（见 MF.3：把两条路拉到同一量级，避免素材缺席时突然掉音量） */
const SYNTH_MUSIC_TRIM = 2.4;
const DEFAULTS = { master: 0.8, sfx: 0.85, music: 0.4 };

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

const _now = (typeof globalThis !== 'undefined' && globalThis.performance && globalThis.performance.now)
  ? function () { return globalThis.performance.now(); }
  : function () { return Date.now(); };

/* ============================================================================
 * 音效配方
 *   签名 (ctx, out, t, em) -> 该音效的总时长（秒）
 *   em(kind, at, o, dest) 声明一个声音元素，返回它的结束时间（用于算总时长）：
 *     'n'  噪声（配 f/freq/q 滤波器）—— 沙、土、石、水这类质感
 *     'nt' 噪声进"音高门"（base/vib）—— 动物叫声、呻吟
 *     'o'  振荡器（w 波形、freq→freqTo 滑音、vib 颤音）
 *     'od' 振荡器进音高门
 *     'pre' 整形子总线（dist 软削波 + lp/bp 滤波），返回其输入节点作 dest
 * ========================================================================== */

const DEFS = {

  /* ---------- 脚步：区分度靠滤波中心频率与时长 ---------- */

  step_grass(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 2700, dur: 0.07, g: 0.26 });
    e = Math.max(e, em('n', t + 0.02, { f: 'bandpass', freq: 5200, q: 1.2, dur: 0.05, g: 0.12 }));
    e = Math.max(e, em('o', t, { w: 'sine', freq: 120, freqTo: 78, dur: 0.05, g: 0.09 }));
    return e - t;
  },
  step_stone(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 3300, dur: 0.05, g: 0.2 });
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 230, freqTo: 130, dur: 0.05, g: 0.16 }));
    e = Math.max(e, em('o', t, { w: 'sine', freq: 82, dur: 0.09, g: 0.12 }));
    return e - t;
  },
  step_sand(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 4700, dur: 0.1, g: 0.16, atk: 0.012 });
    e = Math.max(e, em('n', t, { f: 'bandpass', freq: 7200, q: 1.5, dur: 0.06, g: 0.1 }));
    return e - t;
  },
  step_wood(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 1300, q: 2.2, dur: 0.04, g: 0.24 });
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 190, freqTo: 108, dur: 0.06, g: 0.2 }));
    return e - t;
  },
  step_snow(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 5200, dur: 0.09, g: 0.14, atk: 0.01 });
    e = Math.max(e, em('n', t + 0.03, { f: 'bandpass', freq: 3400, q: 1.4, dur: 0.05, g: 0.09 }));
    return e - t;
  },

  /* ---------- 挖掘 ---------- */

  dig_grass(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 2900, freqTo: 1500, dur: 0.13, g: 0.28 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 150, freqTo: 85, dur: 0.08, g: 0.1 }));
    return e - t;
  },
  dig_dirt(c, out, t, em) {
    let e = em('n', t, { f: 'lowpass', freq: 460, freqTo: 220, dur: 0.14, g: 0.38, atk: 0.008 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 104, freqTo: 66, dur: 0.12, g: 0.22 }));
    return e - t;
  },
  dig_stone(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 3100, dur: 0.055, g: 0.28 });
    e = Math.max(e, em('o', t, { w: 'square', freq: 300, freqTo: 140, dur: 0.035, g: 0.1 }));
    e = Math.max(e, em('o', t, { w: 'sine', freq: 96, dur: 0.11, g: 0.24 }));
    return e - t;
  },
  dig_wood(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 1500, q: 2.6, dur: 0.035, g: 0.26 });
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 250, freqTo: 130, dur: 0.05, g: 0.2 }));
    e = Math.max(e, em('n', t + 0.055, { f: 'bandpass', freq: 2100, q: 2.2, dur: 0.03, g: 0.14 }));
    return e - t;
  },
  dig_sand(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 5200, freqTo: 3000, dur: 0.15, g: 0.18, atk: 0.02 });
    e = Math.max(e, em('n', t, { f: 'bandpass', freq: 900, q: 1.1, dur: 0.1, g: 0.08 }));
    return e - t;
  },
  dig_gravel(c, out, t, em) {
    let e = t;
    for (let i = 0; i < 4; i++) {
      const tt = t + i * 0.035 + i * 0.012;
      e = Math.max(e, em('n', tt, { f: 'bandpass', freq: 900 + i * 620, q: 2.4, dur: 0.035, g: 0.2 - i * 0.03 }));
      e = Math.max(e, em('o', tt, { w: 'triangle', freq: 170 + i * 34, dur: 0.03, g: 0.08 }));
    }
    return e - t;
  },

  /* ---------- 破坏 ---------- */

  break_grass(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 3200, freqTo: 1100, dur: 0.24, g: 0.3 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 170, freqTo: 66, dur: 0.2, g: 0.14 }));
    return e - t;
  },
  break_dirt(c, out, t, em) {
    let e = em('n', t, { f: 'lowpass', freq: 560, freqTo: 180, dur: 0.28, g: 0.42, atk: 0.01 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 116, freqTo: 48, dur: 0.26, g: 0.26 }));
    e = Math.max(e, em('n', t + 0.09, { f: 'bandpass', freq: 1500, q: 1.1, dur: 0.12, g: 0.1 }));
    return e - t;
  },
  break_stone(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 2600, dur: 0.1, g: 0.3 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 120, freqTo: 44, dur: 0.32, g: 0.34 }));
    for (let i = 0; i < 3; i++) {
      e = Math.max(e, em('n', t + 0.1 + i * 0.07, {
        f: 'bandpass', freq: 2100 + i * 900, q: 2, dur: 0.05, g: 0.13
      }));
    }
    return e - t;
  },
  break_wood(c, out, t, em) {
    let e = t;
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.085;
      e = Math.max(e, em('n', tt, { f: 'bandpass', freq: 1200 + i * 500, q: 2.2, dur: 0.05, g: 0.24 }));
      e = Math.max(e, em('o', tt, { w: 'triangle', freq: 210 - i * 24, freqTo: 96, dur: 0.07, g: 0.14 }));
    }
    e = Math.max(e, em('o', t, { w: 'sine', freq: 74, dur: 0.24, g: 0.14 }));
    return e - t;
  },
  break_sand(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 5000, freqTo: 1700, dur: 0.3, g: 0.2, atk: 0.015 });
    e = Math.max(e, em('n', t, { f: 'lowpass', freq: 420, dur: 0.16, g: 0.1 }));
    return e - t;
  },

  place(c, out, t, em) {
    let e = em('n', t, { f: 'lowpass', freq: 900, dur: 0.06, g: 0.24 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 210, freqTo: 118, dur: 0.08, g: 0.2 }));
    return e - t;
  },

  /* ---------- 本轮 D：按材质的「放置」 ----------
   * 旧实现：木/石/土/玻璃全走同一个 place，只靠 rate 变一点点 —— 放十个方块听起来像同一个动作。
   * 三个新配方各自有接触 + 尾音的结构差异：
   *   wood  ：闷接触（低通噪声短促）+ 木头自身的低频共鸣，尾巴收得快
   *   stone ：短硬撞（高通脆声 + 中频敲击）+ 一点碎屑，像石头落在石头上
   *   dirt  ：松散的落定（宽带噪声 + 低频塌陷），尾巴稍长、颗粒更粗 */
  place_wood(c, out, t, em) {
    let e = em('n', t, { f: 'lowpass', freq: 620, dur: 0.05, g: 0.26, atk: 0.004 });
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 176, freqTo: 128, dur: 0.07, g: 0.22 }));
    e = Math.max(e, em('n', t + 0.012, { f: 'bandpass', freq: 1400, q: 2.4, dur: 0.03, g: 0.1 }));
    return e - t;
  },
  place_stone(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 2400, dur: 0.04, g: 0.24 });
    e = Math.max(e, em('o', t, { w: 'square', freq: 320, freqTo: 180, dur: 0.03, g: 0.12 }));
    e = Math.max(e, em('o', t, { w: 'sine', freq: 108, freqTo: 74, dur: 0.09, g: 0.2 }));
    e = Math.max(e, em('n', t + 0.05, { f: 'bandpass', freq: 3000, q: 2.2, dur: 0.03, g: 0.07 }));
    return e - t;
  },
  place_dirt(c, out, t, em) {
    let e = em('n', t, { f: 'lowpass', freq: 480, freqTo: 240, dur: 0.13, g: 0.26, atk: 0.012 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 120, freqTo: 62, dur: 0.12, g: 0.18 }));
    e = Math.max(e, em('n', t + 0.035, { f: 'bandpass', freq: 1100, q: 1.0, dur: 0.07, g: 0.08 }));
    return e - t;
  },
  place_sand(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 3600, freqTo: 1800, dur: 0.1, g: 0.16, atk: 0.02 });
    e = Math.max(e, em('n', t, { f: 'lowpass', freq: 380, dur: 0.1, g: 0.12 }));
    return e - t;
  },

  /* ---------- 本轮 D：拆分被借用的声音身份 ---------- */

  /* 起跳：身体/布料的一下（旧实现借 UI click，听起来像点了按钮） */
  jump(c, out, t, em) {
    let e = em('n', t, { f: 'lowpass', freq: 1100, freqTo: 520, dur: 0.1, g: 0.16, atk: 0.008 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 168, freqTo: 104, dur: 0.09, g: 0.12 }));
    return e - t;
  },
  /* 工具断裂：木柄崩裂 + 金属/石头的短谐振（旧实现借受伤 hurt，玩家分不清自己被打还是工具坏了） */
  tool_break(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 1900, q: 1.6, dur: 0.06, g: 0.3 });
    e = Math.max(e, em('n', t + 0.05, { f: 'bandpass', freq: 900, q: 1.2, dur: 0.08, g: 0.2 }));
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 300, freqTo: 120, dur: 0.12, g: 0.16 }));
    e = Math.max(e, em('o', t + 0.06, { w: 'sine', freq: 96, freqTo: 58, dur: 0.14, g: 0.14 }));
    return e - t;
  },
  /* 守卫前摇：石头/金属蓄能的低频扬起（旧实现借苦力怕 hiss —— 两种完全不同的危险听起来一样） */
  guardian_warn(c, out, t, em) {
    let e = em('o', t, { w: 'triangle', freq: 74, freqTo: 128, dur: 0.55, g: 0.24, atk: 0.08 });
    e = Math.max(e, em('o', t + 0.04, { w: 'sine', freq: 148, freqTo: 196, dur: 0.5, g: 0.12, atk: 0.1 }));
    e = Math.max(e, em('n', t, { f: 'bandpass', freq: 2600, q: 1.4, dur: 0.5, g: 0.06, atk: 0.12 }));
    return e - t;
  },

  /* ---------- 本轮 D：步/挖的第二瞬态结构 ----------
   * 「同一配方换音高」听久了就是机械重复。这几条换了颗粒结构：
   * 草步 b 多一下草叶回弹；石步 b 换成两次错开的硬点；沙步 b 更干、更短；
   * 木步 b 把敲击变成一次空腔回响；石挖 b 是碎屑先落、硬点在后。 */
  step_grass_b(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 2100, dur: 0.09, g: 0.22, atk: 0.006 });
    e = Math.max(e, em('n', t + 0.035, { f: 'bandpass', freq: 4200, q: 1.0, dur: 0.06, g: 0.1 }));
    e = Math.max(e, em('o', t + 0.02, { w: 'sine', freq: 104, freqTo: 72, dur: 0.06, g: 0.07 }));
    return e - t;
  },
  step_stone_b(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 4100, dur: 0.035, g: 0.18 });
    e = Math.max(e, em('n', t + 0.03, { f: 'highpass', freq: 2800, dur: 0.04, g: 0.14 }));
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 260, freqTo: 150, dur: 0.04, g: 0.13 }));
    return e - t;
  },
  step_sand_b(c, out, t, em) {
    let e = em('n', t, { f: 'highpass', freq: 5800, dur: 0.06, g: 0.15, atk: 0.004 });
    e = Math.max(e, em('n', t + 0.02, { f: 'bandpass', freq: 3000, q: 0.9, dur: 0.05, g: 0.07 }));
    return e - t;
  },
  step_wood_b(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 900, q: 1.8, dur: 0.03, g: 0.2 });
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 168, freqTo: 122, dur: 0.08, g: 0.16 }));
    e = Math.max(e, em('o', t + 0.01, { w: 'sine', freq: 420, freqTo: 300, dur: 0.05, g: 0.06 }));
    return e - t;
  },
  dig_stone_b(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 2400, q: 1.2, dur: 0.05, g: 0.16 });
    e = Math.max(e, em('n', t + 0.03, { f: 'highpass', freq: 3400, dur: 0.03, g: 0.22 }));
    e = Math.max(e, em('o', t + 0.03, { w: 'sine', freq: 92, dur: 0.08, g: 0.2 }));
    return e - t;
  },
  dig_wood_b(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 1100, q: 2.0, dur: 0.04, g: 0.2 });
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 210, freqTo: 150, dur: 0.06, g: 0.16 }));
    e = Math.max(e, em('n', t + 0.03, { f: 'bandpass', freq: 2600, q: 2.6, dur: 0.025, g: 0.1 }));
    return e - t;
  },
  dig_dirt_b(c, out, t, em) {
    let e = em('n', t, { f: 'lowpass', freq: 380, freqTo: 190, dur: 0.12, g: 0.32, atk: 0.006 });
    e = Math.max(e, em('n', t + 0.02, { f: 'bandpass', freq: 1300, q: 1.0, dur: 0.06, g: 0.08 }));
    e = Math.max(e, em('o', t, { w: 'sine', freq: 88, dur: 0.1, g: 0.18 }));
    return e - t;
  },

  /* ---------- 玩家状态 / UI ---------- */

  hurt(c, out, t, em) {
    const d = em('pre', t, { lp: 820 });
    let e = em('o', t, { w: 'sawtooth', freq: 168, freqTo: 92, dur: 0.17, g: 0.3 }, d);
    e = Math.max(e, em('o', t, { w: 'square', freq: 112, freqTo: 74, dur: 0.14, g: 0.16 }, d));
    e = Math.max(e, em('n', t, { f: 'bandpass', freq: 620, q: 1.2, dur: 0.12, g: 0.16 }, d));
    return e - t;
  },
  death(c, out, t, em) {
    let e = em('o', t, { w: 'triangle', freq: 420, freqTo: 68, dur: 0.38, g: 0.26 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 210, freqTo: 40, dur: 0.4, g: 0.18 }));
    e = Math.max(e, em('n', t, { f: 'lowpass', freq: 800, freqTo: 180, dur: 0.3, g: 0.12 }));
    return e - t;
  },
  eat(c, out, t, em) {
    let e = t;
    for (let i = 0; i < 2; i++) {
      const tt = t + i * 0.13;
      e = Math.max(e, em('n', tt, { f: 'lowpass', freq: 320 + i * 60, dur: 0.09, g: 0.3, atk: 0.01 }));
      e = Math.max(e, em('o', tt, { w: 'sine', freq: 128, freqTo: 92, dur: 0.07, g: 0.16 }));
    }
    e = Math.max(e, em('n', t + 0.24, { f: 'highpass', freq: 3600, dur: 0.04, g: 0.08 }));
    return e - t;
  },
  craft(c, out, t, em) {
    let e = em('o', t, { w: 'triangle', freq: MUS_SCALE[1], dur: 0.1, g: 0.14, lp: 4200 });
    e = Math.max(e, em('o', t + 0.08, { w: 'triangle', freq: MUS_SCALE[3] * 2, dur: 0.14, g: 0.13, lp: 4200 }));
    e = Math.max(e, em('n', t, { f: 'bandpass', freq: 2600, q: 1.8, dur: 0.05, g: 0.07 }));
    return e - t;
  },
  pickup(c, out, t, em) {
    let e = em('o', t, { w: 'sine', freq: 820, freqTo: 1560, dur: 0.09, g: 0.15 });
    e = Math.max(e, em('o', t + 0.02, { w: 'sine', freq: 1230, freqTo: 2050, dur: 0.07, g: 0.07 }));
    return e - t;
  },
  click(c, out, t, em) {
    const e = em('n', t, { f: 'highpass', freq: 6200, dur: 0.03, g: 0.09, atk: 0.004 });
    return e - t;
  },
  open_ui(c, out, t, em) {
    let e = t;
    for (let i = 0; i < 3; i++) {
      e = Math.max(e, em('o', t + i * 0.05, { w: 'sine', freq: 520 + i * 160, dur: 0.07, g: 0.07, lp: 5200 }));
    }
    return e - t;
  },
  close_ui(c, out, t, em) {
    let e = t;
    for (let i = 0; i < 3; i++) {
      e = Math.max(e, em('o', t + i * 0.05, { w: 'sine', freq: 860 - i * 180, dur: 0.07, g: 0.06, lp: 4600 }));
    }
    return e - t;
  },
  levelup(c, out, t, em) {
    const notes = [MUS_SCALE[0] * 2, MUS_SCALE[2] * 2, MUS_SCALE[3] * 2, MUS_SCALE[4] * 4];
    let e = t;
    for (let i = 0; i < notes.length; i++) {
      const tt = t + i * 0.085;
      e = Math.max(e, em('o', tt, { w: 'sine', freq: notes[i], dur: 0.22, g: 0.11, lp: 6400 }));
      e = Math.max(e, em('o', tt, { w: 'triangle', freq: notes[i] * 0.5, dur: 0.18, g: 0.05 }));
    }
    return e - t;
  },

  /* ---------- 水 ---------- */

  splash(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 420, freqTo: 2700, q: 1.3, dur: 0.11, g: 0.28 });
    e = Math.max(e, em('o', t, { w: 'sine', freq: 720, freqTo: 210, dur: 0.13, g: 0.2 }));
    e = Math.max(e, em('n', t + 0.1, { f: 'highpass', freq: 4200, dur: 0.2, g: 0.14, atk: 0.02 }));
    return e - t;
  },
  swim(c, out, t, em) {
    let e = em('n', t, { f: 'lowpass', freq: 380, freqTo: 1500, dur: 0.26, g: 0.2, atk: 0.06 });
    e = Math.max(e, em('n', t + 0.05, { f: 'bandpass', freq: 2200, q: 1.1, dur: 0.16, g: 0.06, atk: 0.05 }));
    return e - t;
  },

  /* ---------- 熔炉 / 爆炸 ---------- */

  /* 规格明确要求的例外：低频循环嘶声 + 木柴爆裂，1.4 秒自然衰减 */
  furnace_crack(c, out, t, em) {
    let e = em('n', t, { f: 'lowpass', freq: 640, freqTo: 260, dur: 1.4, g: 0.14, atk: 0.18, hold: 0.35 });
    e = Math.max(e, em('n', t, { f: 'bandpass', freq: 190, q: 0.8, dur: 1.2, g: 0.09, atk: 0.25 }));
    let tt = t + 0.12;
    for (let i = 0; i < 5; i++) {
      e = Math.max(e, em('n', tt, { f: 'bandpass', freq: 900 + i * 460, q: 2.6, dur: 0.04, g: 0.13 }));
      tt += 0.16 + i * 0.05;
    }
    return e - t;
  },
  hiss(c, out, t, em) {
    /* T5 苦力怕点燃：一段由低到高的噪声嘶嘶，末尾再来一声更尖的（原版是「嘶——」的引信声） */
    const d = em('pre', t, { bp: 2200, q: 1.2 });
    let e = em('n', t, { f: 'bandpass', freq: 1100, freqTo: 3000, dur: 0.85, g: 0.16 }, d);
    e = Math.max(e, em('n', t + 0.45, { f: 'bandpass', freq: 2400, freqTo: 4200, dur: 0.45, g: 0.13 }, d));
    return e - t;
  },
  explode(c, out, t, em) {
    const d = em('pre', t, { lp: 1600 });
    let e = em('n', t, { f: 'lowpass', freq: 2600, freqTo: 130, dur: 0.38, g: 0.45 }, d);
    e = Math.max(e, em('o', t, { w: 'sine', freq: 86, freqTo: 28, dur: 0.36, g: 0.4 }, d));
    for (let i = 0; i < 3; i++) {
      e = Math.max(e, em('n', t + 0.16 + i * 0.06, {
        f: 'bandpass', freq: 1500 + i * 1200, q: 3, dur: 0.05, g: 0.1
      }));
    }
    return e - t;
  },
  thunder(c, out, t, em) {
    /* 滚动任务 7：雷暴的远处闷雷。低频噪声滚下 + 两次延迟回声，不做外部音频。 */
    const d = em('pre', t, { lp: 900 });
    let e = em('n', t, { f: 'lowpass', freq: 420, freqTo: 70, dur: 2.2, g: 0.5, atk: 0.02 }, d);
    e = Math.max(e, em('o', t, { w: 'sine', freq: 55, freqTo: 26, dur: 2.4, g: 0.34 }, d));
    e = Math.max(e, em('n', t + 0.4, { f: 'lowpass', freq: 180, freqTo: 45, dur: 1.5, g: 0.24 }, d));
    e = Math.max(e, em('n', t + 1.0, { f: 'lowpass', freq: 120, freqTo: 40, dur: 1.2, g: 0.14 }, d));
    return e - t;
  },

  /* ---------- 动物 ---------- */

  pig(c, out, t, em) {
    let e = t;
    for (let i = 0; i < 2; i++) {
      const tt = t + i * 0.16;
      const d = em('pre', tt, { bp: 720, q: 3.2 });
      e = Math.max(e, em('o', tt, { w: 'sawtooth', freq: 320, freqTo: 168, dur: 0.13, g: 0.22 }, d));
      e = Math.max(e, em('n', tt, { f: 'bandpass', freq: 620, q: 2, dur: 0.1, g: 0.08 }, d));
    }
    return e - t;
  },
  cow(c, out, t, em) {
    const d = em('pre', t, { lp: 1100 });
    let e = em('o', t, { w: 'sawtooth', freq: 196, freqTo: 148, dur: 0.38, g: 0.2, vib: 5.5, vibDepth: 7 }, d);
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 98, freqTo: 74, dur: 0.36, g: 0.12 }, d));
    return e - t;
  },
  chicken(c, out, t, em) {
    let e = t;
    for (let i = 0; i < 2; i++) {
      const tt = t + i * 0.12;
      const d = em('pre', tt, { bp: 1500, q: 3 });
      e = Math.max(e, em('o', tt, { w: 'square', freq: 1420, freqTo: 1980, dur: 0.08, g: 0.12 }, d));
    }
    return e - t;
  },
  sheep(c, out, t, em) {
    const d = em('pre', t, { bp: 900, q: 2.2 });
    const e = em('o', t, { w: 'sawtooth', freq: 322, dur: 0.34, g: 0.2, vib: 6.5, vibDepth: 16 }, d);
    em('o', t, { w: 'triangle', freq: 161, dur: 0.3, g: 0.07 }, d);
    return e - t;
  },
  zombie(c, out, t, em) {
    const d = em('pre', t, { lp: 700 });
    let e = em('od', t, { base: 118, freq: 118, freqTo: 88, dur: 0.38, g: 0.24, vib: 4.5, vibDepth: 5 }, d);
    e = Math.max(e, em('od', t, { base: 176, freq: 176, freqTo: 132, dur: 0.34, g: 0.1, detune: -12 }, d));
    e = Math.max(e, em('nt', t, { base: 520, freq: 520, q: 1.4, dur: 0.36, g: 0.07, atk: 0.08 }, d));
    return e - t;
  },
  skeleton(c, out, t, em) {
    let e = t;
    for (let i = 0; i < 5; i++) {
      const tt = t + i * 0.045;
      e = Math.max(e, em('n', tt, { f: 'bandpass', freq: 2400 + (i % 3) * 700, q: 6, dur: 0.028, g: 0.2 }));
      e = Math.max(e, em('o', tt, { w: 'triangle', freq: 620 - i * 40, dur: 0.03, g: 0.07 }));
    }
    return e - t;
  },

  /* ---------- 战斗 ---------- */

  bow(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 760, freqTo: 2600, q: 1.6, dur: 0.12, g: 0.2 });
    e = Math.max(e, em('n', t + 0.02, { f: 'highpass', freq: 5200, dur: 0.05, g: 0.08 }));
    return e - t;
  },
  /* T4 空挥：短促气流声，与 hit 的厚重撞击在音色和时长上都区分得开 */
  swing(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 900, freqTo: 2100, q: 0.9, dur: 0.13, g: 0.14, atk: 0.02 });
    e = Math.max(e, em('n', t + 0.03, { f: 'highpass', freq: 3200, dur: 0.08, g: 0.08 }));
    return e - t;
  },

  hit(c, out, t, em) {
    const d = em('pre', t, { lp: 1400 });
    let e = em('o', t, { w: 'square', freq: 200, freqTo: 92, dur: 0.08, g: 0.24 }, d);
    e = Math.max(e, em('n', t, { f: 'bandpass', freq: 1900, q: 1.4, dur: 0.06, g: 0.22 }, d));
    e = Math.max(e, em('o', t, { w: 'sine', freq: 70, dur: 0.11, g: 0.16 }));
    return e - t;
  },
  /* T2 盾牌：木面被砸的闷响 + 铁边的高频短 ping（与 hit 区分：不发低频方波） */
  shield_block(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 1250, q: 1.8, dur: 0.07, g: 0.26 });
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 640, freqTo: 420, dur: 0.1, g: 0.2 }));
    e = Math.max(e, em('o', t + 0.005, { w: 'sine', freq: 1680, freqTo: 1400, dur: 0.07, g: 0.1 }));
    return e - t;
  },
  shield_break(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 900, freqTo: 320, q: 1.2, dur: 0.28, g: 0.3 });
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 260, freqTo: 90, dur: 0.3, g: 0.24 }));
    e = Math.max(e, em('n', t + 0.06, { f: 'highpass', freq: 2600, dur: 0.12, g: 0.12 }));
    return e - t;
  },
  /* T6 木门：短促的吱呀 + 木头闷响 */
  door(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 900, freqTo: 1500, q: 2.2, dur: 0.16, g: 0.14 });
    e = Math.max(e, em('o', t, { w: 'triangle', freq: 180, freqTo: 120, dur: 0.12, g: 0.12 }));
    e = Math.max(e, em('n', t + 0.1, { f: 'lowpass', freq: 700, dur: 0.08, g: 0.1 }));
    return e - t;
  },
  /* T6 狼：短促的两声吠叫 */
  wolf(c, out, t, em) {
    let e = em('o', t, { w: 'square', freq: 330, freqTo: 180, dur: 0.09, g: 0.16 });
    e = Math.max(e, em('o', t + 0.13, { w: 'square', freq: 290, freqTo: 150, dur: 0.1, g: 0.14 }));
    e = Math.max(e, em('n', t, { f: 'bandpass', freq: 900, q: 1.4, dur: 0.08, g: 0.08 }));
    return e - t;
  },
  /* T6 史莱姆：湿软的“啵嘤”弹跳声 */
  slime(c, out, t, em) {
    let e = em('o', t, { w: 'sine', freq: 250, freqTo: 90, dur: 0.18, g: 0.22 });
    e = Math.max(e, em('n', t, { f: 'bandpass', freq: 700, q: 1.2, dur: 0.1, g: 0.1 }));
    e = Math.max(e, em('o', t + 0.04, { w: 'triangle', freq: 160, freqTo: 70, dur: 0.12, g: 0.12 }));
    return e - t;
  },
  /* T3 护甲碎裂：三下金属脆响 + 一点布料撕裂，和工具损坏/盾碎都能听出区别 */
  armor_break(c, out, t, em) {
    let e = em('n', t, { f: 'bandpass', freq: 1500, freqTo: 700, q: 1.6, dur: 0.16, g: 0.24 });
    for (let i = 0; i < 3; i++) {
      e = Math.max(e, em('o', t + i * 0.045, { w: 'square', freq: 1250 - i * 180, freqTo: 880 - i * 160, dur: 0.06, g: 0.1 }));
    }
    e = Math.max(e, em('o', t + 0.02, { w: 'sine', freq: 180, freqTo: 110, dur: 0.18, g: 0.16 }));
    return e - t;
  },

  /* 阶段 6：随包 CC0 音效的**合成兜底**。文件还没解码好 / 取不到 / 主动关掉文件音效时，
     这两个名字照样要出声（与「外部曲目没取到就走合成编排」同一口径）。
     文件就绪后 play() 会改播文件，这两段只在兜底时用到。 */
  guardian_awaken(c, out, t, em) {
    let e = t;
    for (let i = 0; i < 3; i++) {
      e = Math.max(e, em('o', t + i * 0.2, { w: 'square', freq: 220 + i * 30, freqTo: 170 + i * 30, dur: 0.16, g: 0.14, atk: 0.01 }));
    }
    e = Math.max(e, em('n', t, { f: 'lowpass', freq: 420, dur: 0.55, g: 0.1 }));
    return e - t;
  },
  guardian_reward(c, out, t, em) {
    let e = t;
    const notes = [392, 523.25, 659.25, 783.99];
    for (let i = 0; i < notes.length; i++) {
      e = Math.max(e, em('o', t + i * 0.095, { w: 'square', freq: notes[i], dur: 0.17, g: 0.12, atk: 0.005 }));
    }
    return e - t;
  }
};

/* ============================================================================
 * 引擎
 * ========================================================================== */

/** 音画对账：配方表与名字表双向一致（T4 抓到 hiss 有配方却漏登记） */
for (const id of SFX_FILE_IDS) {
  const fallback = sfxFileFor(id).fallback;
  if (!DEFS[id] && fallback) DEFS[id] = DEFS[fallback];
}
export const SOUND_DEF_NAMES = Object.keys(DEFS);

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;      // 总音量
    this.toneFilter = null;  // 水下低通
    this.sfxBus = null;      // 音效音量
    this.musicBus = null;    // 音乐音量
    this.ambientBus = null;  // 环境声随音效滑条，与背景音乐的开关及音量独立
    this.noiseBuf = null;    // 共享白噪声（只生成一次）
    this.distCurve = null;   // 共享软削波曲线

    this._echo = null;
    this._voices = new Set();
    this._lastAt = Object.create(null);
    this._music = null;          // 当前唯一主曲 {id, bus, timer, nextStart, track, source, buffer, trimNode, src, loopSeconds, ...}
    this._fading = new Set();    // 交叉淡化中的旧曲（不循环、不计入 activeMusicCount）
    this._musicWanted = false;
    this._envWanted = true;      // 本轮 D：环境床独立开关（与音乐开关解耦，默认常开）
    this._musicScene = 'day';
    /* 阶段 4：外部曲目。_fileBufs 存已解码的 AudioBuffer（与 ctx 无关，可跨 resume 复用），
       _fileState 记每条轨的取数状态，解码没就绪的场景照旧走合成曲，绝不因为等文件而静音。 */
    this._fileBufs = new Map();                    // scene -> AudioBuffer
    this._fileState = Object.create(null);         // scene -> 'idle' | 'loading' | 'ready' | 'failed'
    this._fileStats = Object.create(null);         // scene -> {fetchMs, decodeMs, bytes, mime}
    this._fileOrder = [];                          // 解码就绪顺序，用于只保留最近几条
    this._fileLastError = null;
    this._filesEnabled = true;                     // 关掉就只用合成曲（验收要证明兜底真的能出声）
    this._fileKeep = 2;                             // 常驻内存的解码轨上限（当前 + 上一条）
    /* 阶段 6：随包 CC0 短音效（守卫预警 / 领奖）。与音乐文件轨分开管理：
       体积小、常驻、解码失败就由 DEFS 的同名合成配方兜底，绝不让玩家听不到反馈。 */
    this._sfxFileBufs = new Map();                  // id -> AudioBuffer
    this._sfxFileState = Object.create(null);       // id -> idle / loading / ready / failed
    this._sfxFileStats = Object.create(null);
    this._sfxFilesEnabled = true;                   // 关掉就只走合成兜底（验收要证明兜底真的能出声）
    this._sfxFileLastError = null;
    this._leadInPending = false;  // T4：从「无曲」到「有曲」时先安静一段再缓入
    this._leadInDone = false;     // 只在首次进入世界用一次；恢复 / 开关重开必须立刻有声（B.5、MU.6、MU.8）
    this._ambient = null;        // 当前环境床
    this._ambientId = null;
    this._ambientFading = new Set();
    this._ambientBuffers = new Map();
    this._ambientFileState = Object.create(null);
    this._ambientMix = { gain: 1, lowpass: 12000 };
    this._disposed = false;
    this._underwater = false;
    this._dayT = 0.5;
    this._vols = { master: DEFAULTS.master, sfx: DEFAULTS.sfx, music: DEFAULTS.music };
    /* B：播放计数（只读诊断，不入存档、不影响听觉）。
       dropped 记「被要求但放不出来」的次数——主菜单静音就是靠这个字段暴露出来的。 */
    this._stats = { played: 0, dropped: 0, keyPlays: 0, byName: Object.create(null), last: null };
    this._tap = null;            // B：输出能量旁路（只在诊断时创建，不接 destination 之外的任何新链路）
    this._busTaps = null;        // A1：分总线（master/sfx/music/ambient）能量旁路，同样按需创建
  }

  get ready() { return !!this.ctx && this.ctx.state !== 'closed' && !!this.sfxBus; }

  /* ---------------- 生命周期 ---------------- */

  resume() {
    if (this._disposed) return;
    if (!this.ctx) {
      const g = typeof globalThis !== 'undefined' ? globalThis : {};
      const AC = g.AudioContext || g.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { this.ctx = null; return; }
      try { this._buildGraph(); } catch (e) { this.ctx = null; return; }
    }
    try {
      if (this.ctx.state === 'suspended' && this.ctx.resume) {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(noop);
      }
    } catch (e) { /* 自动播放策略尚未放行，下次交互再试 */ }
    /* 阶段 6：首次用户交互时顺带把两条随包短音效解码好（全异步、不阻塞）。 */
    this.ensureSfxFiles();
    this.ensureAmbientFiles();
    if (this._musicWanted && !this._music) this.startMusic();
  }

  /* 阶段 6：把登记表里的 CC0 短音效取回并解码。
     同源 URL、离线可用；任何一步失败只记状态，play() 会自动退回同名合成配方。 */
  ensureSfxFiles() {
    if (this._disposed || !this._sfxFilesEnabled) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    for (const id of SFX_FILE_IDS) {
      const st = this._sfxFileState[id];
      if (st === 'loading' || st === 'ready') continue;
      const entry = sfxFileFor(id);
      if (!entry) continue;
      const url = sfxFileUrl(entry);
      this._sfxFileState[id] = 'loading';
      const t0 = _now();
      fetch(url).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        return r.arrayBuffer();
      }).then((ab) => {
        const bytes = ab.byteLength;
        return new Promise((res, rej) => {
          let settled = false;
          const ok = (b) => { if (!settled) { settled = true; res({ buf: b, bytes }); } };
          const bad = (e) => { if (!settled) { settled = true; rej(e instanceof Error ? e : new Error(String(e))); } };
          try {
            const p = ctx.decodeAudioData(ab, ok, bad);   // 老实现只回调，新实现给 Promise，两条都接
            if (p && typeof p.then === 'function') p.then(ok, bad);
          } catch (e) { bad(e); }
        });
      }).then(({ buf, bytes }) => {
        if (this._disposed || !buf || !(buf.duration > 0)) throw new Error('解码结果为空');
        this._sfxFileBufs.set(id, buf);
        this._sfxFileState[id] = 'ready';
        this._sfxFileStats[id] = {
          bytes, duration: +buf.duration.toFixed(3),
          sampleRate: buf.sampleRate, channels: buf.numberOfChannels,
          totalMs: +(_now() - t0).toFixed(1)
        };
      }).catch((e) => {
        if (this._disposed) return;
        this._sfxFileState[id] = 'failed';
        this._sfxFileLastError = String((e && e.message) || e);
      });
    }
  }

  /** 只读诊断：文件音效加载到了哪一步（验收用来区分「播的是文件」还是「合成兜底」） */
  sfxFilesInfo() {
    return {
      enabled: this._sfxFilesEnabled,
      lastError: this._sfxFileLastError,
      files: SFX_FILE_IDS.map(id => ({
        id, state: this._sfxFileState[id] || 'idle',
        hasBuffer: this._sfxFileBufs.has(id),
        stats: this._sfxFileStats[id] || null
      }))
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._musicWanted = false;
    this.stopMusic(0.02);
    this.stopAmbient(0.02);
    this._hardStopMusic();
    this._releaseFileBuffers();          // 阶段 4：解码出来的整曲母带是引擎里最大的一块内存，退出必须放掉
    this._sfxFileBufs.clear();           // 阶段 6：随包短音效的解码缓冲也一起放掉
    this._ambientBuffers.clear();
    const voices = Array.from(this._voices);
    for (const v of voices) this._release(v);
    this._voices.clear();
    this._lastAt = Object.create(null);
    const extra = [];
    if (this._echo) extra.push(this._echo.delay, this._echo.fb, this._echo.lp, this._echo.wet);
    if (this._tap) extra.push(this._tap.a, this._tap.sink);
    /* 本轮 A1：分总线旁路也要一起释放，否则分析节点会一直挂在总线上 */
    if (this._busTaps) for (const k of Object.keys(this._busTaps)) {
      const t = this._busTaps[k];
      if (t) extra.push(t.a, t.sink);
    }
    extra.push(this.sfxBus, this.toneFilter, this.musicBus, this.ambientBus, this.master);
    for (const nd of extra) this._free(nd);
    this._echo = null;
    this._tap = null;
    this._busTaps = null;
    this.sfxBus = this.toneFilter = this.musicBus = this.ambientBus = this.master = null;
    this.noiseBuf = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.close) {
      try { const p = ctx.close(); if (p && p.catch) p.catch(noop); } catch (e) { /* ignore */ }
    }
  }

  _buildGraph() {
    const ctx = this.ctx;

    /* 2 秒白噪声，所有噪声音效共享（loop + 随机起点） */
    const len = Math.max(1024, Math.floor(ctx.sampleRate * 2));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    /* tanh 软削波曲线（受伤 / 爆炸的粗糙质感） */
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 2.6) * 0.86;
    }
    this.distCurve = curve;

    const master = ctx.createGain();
    master.gain.value = this._vols.master;
    master.connect(ctx.destination);
    this.master = master;

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 18000;
    tone.connect(master);
    this.toneFilter = tone;

    const sfx = ctx.createGain();
    sfx.gain.value = this._vols.sfx * LEVEL;
    sfx.connect(tone);
    this.sfxBus = sfx;

    const music = ctx.createGain();
    music.gain.value = 0.0001;
    music.connect(master);
    this.musicBus = music;

    /* 环境声独立总线，音量由环境床自身按音效滑条与遮蔽控制。 */
    const ambient = ctx.createGain();
    ambient.gain.value = 1;
    ambient.connect(master);
    this.ambientBus = ambient;

    /* 自建反馈延迟给音乐一点空间感（不使用任何脉冲响应文件） */
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.42;
    const fb = ctx.createGain();
    fb.gain.value = 0.34;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    music.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    lp.connect(wet);
    wet.connect(master);
    this._echo = { delay: delay, fb: fb, lp: lp, wet: wet };
  }

  /* ---------------- 音量 ---------------- */

  setMasterVolume(v) {
    this._vols.master = clamp(num(v, 1), 0, 1);
    if (this.master) this._set(this.master.gain, this._vols.master);
  }

  setSfxVolume(v) {
    this._vols.sfx = clamp(num(v, 1), 0, 1);
    if (this.sfxBus) this._set(this.sfxBus.gain, this._vols.sfx * LEVEL);
    if (this._ambient) this._set(this._ambient.gain.gain, this._ambientTarget(), 0.15);
  }

  setMusicVolume(v) {
    this._vols.music = clamp(num(v, 1), 0, 1);
    if (this._music && this.musicBus) {
      this._set(this.musicBus.gain, this._musicTarget(), 0.3);
    }
  }

  _ambientTarget() {
    if (this._envWanted === false) return 0.0001;
    const uw = this._underwater ? 0.6 : 1;
    /* T4：环境床归属音效层，改乘 _vols.sfx 而不是 _vols.music。
       原实现把音乐音量滑条拉到 0 会连风声 / 雨声 / 虫鸣一起压没，
       但玩家只关掉了旋律；留白期间与「音乐=0」时世界仍该有声音。 */
    return Math.max(0.0001, this._vols.sfx * 0.55 * uw * this._ambientMix.gain);
  }

  _musicTarget() {
    // time: 0.25=正午、0.75=午夜；越接近午夜越安静（旧公式把 0.5 当午夜，是反的）
    const night = clamp(1 - Math.abs(this._dayT - 0.75) * 2, 0, 1);
    const uw = this._underwater ? 0.55 : 1;
    return Math.max(0.0001, this._vols.music * 0.6 * (1 - night * 0.35) * uw);   // B：0.5 → 0.6，只改系数
  }

  _set(param, value, smooth) {
    try {
      if (smooth && param.setTargetAtTime) param.setTargetAtTime(value, this.ctx.currentTime, smooth);
      else param.value = value;
    } catch (e) { try { param.value = value; } catch (e2) { /* ignore */ } }
  }

  /* ---------------- 播放 ---------------- */

  /**
   * 注册「听者」：每帧由 Game 传入相机位置与朝向，供 playWorld 算方向与距离。
   * 只读回调，Sfx 不反过来依赖 THREE/Game。
   */
  setListener(fn) {
    this._listener = typeof fn === 'function' ? fn : null;
    return !!this._listener;
  }

  /**
   * 世界声源：按相对听者的**方向与距离**给 pan 与音量衰减（本轮 D）。
   * 旧实现里生物/守卫的叫声一律 `play(name, {volume})`，没有位置，玩家分不清声音从哪来。
   * 现在：
   *   · 距离衰减 = 1/(1 + (d/ref)^1.6)，超过 maxDist 直接不播（省 voice）；
   *   · pan = 声源在听者右向量上的投影（-1 左 / +1 右），乘 0.85 留一点居中余量；
   *   · 远处的声源再压低一档高频（低通），近处保持原样 —— 这是「远」的直觉线索。
   * UI 与自身反馈（click/click 类）仍然走 play()，不受这里影响。
   */
  playWorld(name, pos, opts) {
    if (!pos) return this.play(name, opts);
    const l = this._listener ? this._listener() : null;
    if (!l) return this.play(name, opts);
    const dx = pos.x - l.x, dz = pos.z - l.z;
    const d = Math.hypot(dx, dz);
    const o = Object.assign({}, opts || {});
    const maxDist = num(o.maxDist, 42);
    if (d > maxDist) { this._drop('far'); return; }
    const ref = num(o.refDist, 9);
    const att = 1 / (1 + Math.pow(d / ref, 1.6));
    const yaw = num(l.yaw, 0);
    /* 右向量（yaw 约定与相机一致：前向 = (-sin, -cos)） */
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const pan = d > 0.001 ? clamp(((dx * rx) + (dz * rz)) / d, -1, 1) * 0.85 : 0;
    o.volume = clamp(num(o.volume, 1) * att, 0, 4);
    o.pan = clamp(num(o.pan, 0) + pan, -1, 1);
    if (num(o.rate, 1) === 1 && d > ref * 1.6) o.rate = 0.96;
    return this.play(name, o);
  }

  play(name, opts) {
    if (this._disposed || !this.ready) { this._drop('not-ready'); return; }
    const def = DEFS[name];
    if (!def) { this._drop('unknown'); return; }          // 未知名字：静默
    const o = opts || {};
    const rate = clamp(num(o.rate, 1), 0.25, 4);
    const now = _now();
    if (now - (this._lastAt[name] || -1e9) < THROTTLE_MS) { this._drop('throttle'); return; }  // 同名限流
    this._sweep(now);
    if (this._voices.size >= MAX_VOICES) { this._drop('voices'); return; }       // voice 上限
    this._lastAt[name] = now;

    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.01;
    /* T4：关键动作音统一给一档相对增益（可听性），非关键音原样 */
    const volScale = clamp(num(o.volume, 1) * keyGain(name), 0, 4);
    const cents = num(o.detune, 0);
    const voice = { nodes: new Set(), pending: 0, endAt: now + 3000 };
    this._voices.add(voice);

    /* 可选声道 */
    let out = this.sfxBus;
    const panVal = clamp(num(o.pan, 0), -1, 1);
    if (panVal !== 0 && ctx.createStereoPanner) {
      try {
        const p = ctx.createStereoPanner();
        p.pan.value = panVal;
        p.connect(this.sfxBus);
        voice.nodes.add(p);
        out = p;
      } catch (e) { out = this.sfxBus; }
    }

    const em = (kind, at, cfg, dest) =>
      this._emit(kind, t0 + Math.max(0, at - t0) / rate, cfg, dest || out, voice, rate, volScale, cents);

    let dur = 0;
    try {
      /* 阶段 6：登记表里的短音效若已解码就绪就播随包文件；否则走同名合成兜底。
         两条路径都记进同一套播放统计，验收能直接对账。 */
      const fbuf = this._sfxFilesEnabled ? this._sfxFileBufs.get(name) : null;
      dur = fbuf ? this._playSfxFile(fbuf, out, t0, { ...o, volume: volScale, rate }, voice) : def(ctx, out, t0, em);
    } catch (e) {
      this._release(voice);
      this._drop('emit-error');
      return;
    }
    if (!(dur > 0.03)) dur = 0.03;
    voice.endAt = now + (dur + 0.5) * 1000;
    const s = this._stats;
    s.played++;
    if (keyGain(name) > 1) s.keyPlays++;
    s.byName[name] = (s.byName[name] || 0) + 1;
    s.last = { name, at: now, volume: volScale, rate,
      source: this._sfxFilesEnabled && this._sfxFileBufs.has(name) ? 'file' : 'synth' };
  }

  /* 阶段 6：播放一段已解码的随包音效。节点挂进 voice.nodes，由 _release/_sweep 统一回收。 */
  _playSfxFile(buf, out, t0, o, voice) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = clamp(num(o.rate, 1), 0.5, 2);
    const g = ctx.createGain();
    g.gain.value = clamp(num(o.volume, 1), 0, 2);
    src.connect(g);
    g.connect(out);
    voice.nodes.add(src);
    voice.nodes.add(g);
    this._watch(src, voice);
    src.start(t0);
    return buf.duration / src.playbackRate.value;
  }

  /* ---------------- B：只读诊断（不参与任何音频决策） ---------------- */

  _drop(reason) {
    const s = this._stats;
    s.dropped++;
    s.lastDrop = { reason, at: _now() };
  }

  stats() {
    const s = this._stats;
    return {
      played: s.played, dropped: s.dropped, keyPlays: s.keyPlays,
      keyGain: KEY_SFX_GAIN, keySoundCount: KEY_SOUNDS.length,
      byName: Object.assign({}, s.byName),
      last: s.last || null, lastDrop: s.lastDrop || null,
      ready: this.ready, ctxState: this.ctx ? this.ctx.state : 'none'
    };
  }

  /**
   * 真实输出能量读数。做法：master 之后并一路到 AnalyserNode，分析节点再经一个 0 增益节点接 destination
   * —— 有到 destination 的通路才会被音频图拉起来计算，而 0 增益保证玩家听不到任何额外声音。
   * 只读、按需创建；没有声卡的机器上 AudioContext 仍然会渲染（走静音 sink），所以这里给的是相对量，
   * 测试也只用「同一轮里静音态 vs 播放态」的相对比较，不钉绝对 dB。
   */
  energyInfo() {
    if (this._disposed || !this.ctx || !this.master) {
      return { available: false, state: this.ctx ? this.ctx.state : 'none', rms: 0, peak: 0, nan: 0, frames: 0 };
    }
    if (!this._tap) {
      try {
        const a = this.ctx.createAnalyser();
        a.fftSize = 2048;
        a.smoothingTimeConstant = 0;
        const sink = this.ctx.createGain();
        sink.gain.value = 0;                 // 静音旁路：不加任何可听内容
        this.master.connect(a);
        a.connect(sink);
        sink.connect(this.ctx.destination);
        this._tap = { a, sink, buf: new Float32Array(a.fftSize) };
      } catch (e) {
        return { available: false, state: this.ctx.state, error: String((e && e.message) || e), rms: 0, peak: 0, nan: 0, frames: 0 };
      }
    }
    const tap = this._tap;
    try { tap.a.getFloatTimeDomainData(tap.buf); } catch (e) {
      return { available: false, state: this.ctx.state, error: String((e && e.message) || e), rms: 0, peak: 0, nan: 0, frames: 0 };
    }
    let sum = 0, peak = 0, nan = 0, n = 0;
    for (let i = 0; i < tap.buf.length; i++) {
      const v = tap.buf[i];
      if (!isFinite(v)) { nan++; continue; }
      sum += v * v;
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
      n++;
    }
    return {
      available: true, state: this.ctx.state,
      rms: n ? +Math.sqrt(sum / n).toFixed(6) : 0,
      peak: +peak.toFixed(6), nan, frames: n,
      volumes: { master: this._vols.master, sfx: this._vols.sfx, music: this._vols.music },
      gains: {
        master: this.master ? +this.master.gain.value.toFixed(6) : null,
        sfx: this.sfxBus ? +this.sfxBus.gain.value.toFixed(6) : null,
        music: this.musicBus ? +this.musicBus.gain.value.toFixed(6) : null,
        ambient: this.ambientBus ? +this.ambientBus.gain.value.toFixed(6) : null
      },
      targets: { music: +this._musicTarget().toFixed(6), ambient: +this._ambientTarget().toFixed(6) },
      musicPlaying: !!this._music, ambientPlaying: !!this._ambient
    };
  }

  /* ---------------- 声音元素 ---------------- */

  /**
   * 分总线能量读数（本轮 A1）。energyInfo() 只测 master，没法证明「关掉音乐后环境床还在响」——
   * 因为 master 上还混着 sfx 与其它东西。这里给每条总线各挂一个 0 增益旁路分析节点，
   * 直接读该总线自己的 RMS/峰值。同样只读、按需创建、不产生可听内容。
   * 返回 { ambient: {rms, peak, frames}, music: {...}, sfx: {...}, master: {...} }
   */
  busEnergy() {
    const names = ['master', 'sfx', 'music', 'ambient'];
    const out = { available: false, state: this.ctx ? this.ctx.state : 'none' };
    if (this._disposed || !this.ctx || !this.master) {
      for (const n of names) out[n] = { rms: 0, peak: 0, frames: 0 };
      return out;
    }
    this._busTaps = this._busTaps || Object.create(null);
    const nodeOf = (n) => (n === 'sfx' ? this.sfxBus : n === 'music' ? this.musicBus
      : n === 'ambient' ? this.ambientBus : this.master);
    for (const n of names) {
      const node = nodeOf(n);
      if (!node) { out[n] = { rms: 0, peak: 0, frames: 0, missing: true }; continue; }
      let tap = this._busTaps[n];
      if (!tap) {
        try {
          const a = this.ctx.createAnalyser();
          a.fftSize = 2048;
          a.smoothingTimeConstant = 0;
          const sink = this.ctx.createGain();
          sink.gain.value = 0;
          node.connect(a);
          a.connect(sink);
          sink.connect(this.ctx.destination);
          tap = { a, sink, buf: new Float32Array(a.fftSize) };
          this._busTaps[n] = tap;
        } catch (e) {
          out[n] = { rms: 0, peak: 0, frames: 0, error: String((e && e.message) || e) };
          continue;
        }
      }
      try { tap.a.getFloatTimeDomainData(tap.buf); } catch (e) {
        out[n] = { rms: 0, peak: 0, frames: 0, error: String((e && e.message) || e) };
        continue;
      }
      let sum = 0, peak = 0, cnt = 0;
      for (let i = 0; i < tap.buf.length; i++) {
        const v = tap.buf[i];
        if (!isFinite(v)) continue;
        sum += v * v;
        const av = v < 0 ? -v : v;
        if (av > peak) peak = av;
        cnt++;
      }
      out[n] = {
        rms: cnt ? +Math.sqrt(sum / cnt).toFixed(6) : 0,
        peak: +peak.toFixed(6), frames: cnt
      };
    }
    out.available = true;
    out.state = this.ctx.state;
    out.ambientId = this._ambient ? this._ambient.id : null;
    out.ambientSources = this._ambient ? this._ambient.sources.length : 0;
    out.envWanted = this._envWanted !== false;
    out.musicWanted = !!this._musicWanted;
    return out;
  }

  _emit(kind, t0, o, dest, voice, rate, volScale, cents) {
    const ctx = this.ctx;
    if (kind === 'pre') return this._chain(o, dest, voice);

    const dur = Math.max(0.03, num(o.dur, 0.1) / rate);
    const end = t0 + dur + 0.02;
    const amp = ctx.createGain();
    voice.nodes.add(amp);

    /* 接收上游的节点：默认就是增益本身，有滤波时是滤波器 */
    let head = amp;

    if (kind === 'nt' || kind === 'od') {
      const gate = this._pitchGate(o, t0, dur, voice);
      if (gate) { gate.connect(amp); head = gate; }
    }

    let src;
    if (kind === 'n' || kind === 'nt') {
      src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      src.playbackRate.value = clamp(rate * num(o.rate, 1), 0.1, 4);
      if (o.f) {
        const flt = ctx.createBiquadFilter();
        flt.type = o.f;
        flt.Q.value = num(o.q, 1);
        flt.frequency.setValueAtTime(clamp(num(o.freq, 1000), 20, 20000), t0);
        if (o.freqTo) {
          flt.frequency.exponentialRampToValueAtTime(clamp(o.freqTo, 20, 20000), t0 + dur);
        }
        voice.nodes.add(flt);
        flt.connect(head);
        head = flt;
      }
    } else {
      src = ctx.createOscillator();
      try { src.type = o.w || 'sine'; } catch (e) { /* ignore */ }
      const shift = Math.pow(2, (num(o.detune, 0) + cents) / 1200);
      const f0 = clamp(num(o.freq, 440) * shift, 20, 20000);
      src.frequency.setValueAtTime(f0, t0);
      if (o.freqTo) src.frequency.exponentialRampToValueAtTime(clamp(o.freqTo * shift, 20, 20000), t0 + dur);
      if (o.vib) {
        const lfo = ctx.createOscillator();
        const lg = ctx.createGain();
        lfo.type = 'sine';
        lfo.frequency.value = clamp(o.vib, 0.1, 60);
        lg.gain.value = clamp(num(o.vibDepth, 6), 0, 400);
        lfo.connect(lg);
        lg.connect(src.frequency);
        voice.nodes.add(lfo); voice.nodes.add(lg);
        try { lfo.start(t0); lfo.stop(t0 + dur + 0.05); } catch (e) { /* ignore */ }
      }
    }

    src.connect(head);
    if (o.lp) {
      const post = ctx.createBiquadFilter();
      post.type = 'lowpass';
      post.frequency.value = clamp(o.lp, 40, 20000);
      voice.nodes.add(post);
      amp.disconnect();
      amp.connect(post);
      post.connect(dest);
    } else {
      amp.connect(dest);
    }

    this._envelope(amp.gain, t0, dur, o, volScale);
    this._watch(src, voice);
    try {
      if (kind === 'n' || kind === 'nt') src.start(t0, Math.random() * 1.2);
      else src.start(t0);
      src.stop(end + 0.02);
    } catch (e) { /* ignore */ }
    return end;
  }

  /* 整形子总线：软削波 + 可选低通/带通，返回它的输入增益节点 */
  _chain(o, dest, voice) {
    const ctx = this.ctx;
    const head = ctx.createGain();
    head.gain.value = 1;
    voice.nodes.add(head);
    let last = head;

    if (o.dist !== false && ctx.createWaveShaper) {
      try {
        const ws = ctx.createWaveShaper();
        ws.curve = this.distCurve;
        try { ws.oversample = '2x'; } catch (e) { /* ignore */ }
        last.connect(ws);
        voice.nodes.add(ws);
        last = ws;
      } catch (e) { /* 不支持就跳过 */ }
    }
    const mkFilter = (type, freq, q) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = clamp(freq, 20, 20000);
      if (q) f.Q.value = q;
      last.connect(f);
      voice.nodes.add(f);
      last = f;
    };
    if (o.lp) mkFilter('lowpass', o.lp, o.q);
    if (o.bp) mkFilter('bandpass', o.bp, o.q);
    last.connect(dest);
    return head;
  }

  /* 音高门：带通中心频率被 LFO 轻微摆动，把噪声"音高化" */
  _pitchGate(o, t0, dur, voice) {
    const ctx = this.ctx;
    try {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = clamp(num(o.base, num(o.freq, 400)), 40, 12000);
      f.Q.value = clamp(num(o.gateQ, 4), 0.0001, 30);
      voice.nodes.add(f);
      if (o.vib) {
        const lfo = ctx.createOscillator();
        const lg = ctx.createGain();
        lfo.frequency.value = clamp(o.vib, 0.1, 60);
        lg.gain.value = clamp(num(o.vibDepth, 6) * 4, 0, 3000);
        lfo.connect(lg);
        lg.connect(f.frequency);
        voice.nodes.add(lfo); voice.nodes.add(lg);
        try { lfo.start(t0); lfo.stop(t0 + dur + 0.05); } catch (e) { /* ignore */ }
      }
      return f;
    } catch (e) { return null; }
  }

  /* 0 → peak → 0：线性起振 + 指数衰减，首尾都不突变 */
  _envelope(param, t0, dur, o, volScale) {
    const peak = Math.max(0.0004, clamp(num(o.g, 0.2), 0, 2) * volScale);
    const atk = clamp(num(o.atk, Math.min(0.012, dur * 0.22)), 0.0015, Math.max(0.002, dur * 0.5));
    const hold = t0 + atk + dur * clamp(num(o.hold, 0.12), 0, 0.5);
    const relStart = Math.min(hold, t0 + dur * 0.85);
    try {
      param.setValueAtTime(0.0001, t0);
      param.linearRampToValueAtTime(peak, t0 + atk);
      if (relStart > t0 + atk) param.setValueAtTime(peak, relStart);
      param.exponentialRampToValueAtTime(0.0001, t0 + dur);
      param.setValueAtTime(0, t0 + dur + 0.005);
    } catch (e) {
      try { param.value = peak * 0.4; } catch (e2) { /* ignore */ }
    }
  }

  /* 源结束后归还 voice 配额；voice 内所有源都结束即回收节点 */
  _watch(src, voice) {
    voice.pending++;
    src.onended = () => {
      try { src.onended = null; } catch (e) { /* ignore */ }
      this._free(src);
      voice.pending--;
      if (voice.pending <= 0) this._release(voice);
    };
  }

  _free(node) {
    if (!node) return;
    try { if (node.stop) node.stop(); } catch (e) { /* 未启动或已停止 */ }
    try { node.disconnect(); } catch (e) { /* 已断开 */ }
  }

  _release(voice) {
    if (!voice || !this._voices.has(voice)) return;
    this._voices.delete(voice);
    const nodes = Array.from(voice.nodes);
    for (const nd of nodes) this._free(nd);
    voice.nodes.clear();
  }

  /* 时间兜底回收（onended 在页面隐藏时可能不触发） */
  _sweep(now) {
    if (this._voices.size === 0) return;
    for (const v of Array.from(this._voices)) {
      if (v.endAt <= now) this._release(v);
    }
  }

  /* ============================================================
   * T4 程序化音乐（白天 / 夜晚 / 洞穴）与环境床
   * ============================================================ */

  /** 场景切换：day / night / cave。只在音乐已启动时真正切轨（2~4 秒交叉淡化）。 */
  setMusicScene(scene) {
    if (!TRACKS[scene]) return false;
    const changed = this._musicScene !== scene;
    this._musicScene = scene;
    if (this._musicWanted) this.ensureFileTrack(scene);
    if (changed && this._musicWanted && this.ready && this._music && this._music.id !== scene) {
      this._switchMusic(scene, 3);
    }
    return changed;
  }

  startMusic(scene) {
    if (this._disposed) return;
    if (scene && TRACKS[scene]) this._musicScene = scene;
    if (!this.ready) { this._musicWanted = true; return; }
    this._musicWanted = true;
    this.ensureFileTrack(this._musicScene);
    this._set(this.ambientBus.gain, 1, 0.5);
    if (this._music && this._music.id === this._musicScene) return;
    /* T4：只有首次进入世界才「先留白再缓入」。暂停恢复 / 音乐开关重开必须立刻有声，
       否则既有 B.5（输出能量相对变化）与 MU.6/MU.8 的恢复语义会被静默期吃掉。 */
    if (!this._music) {
      if (!this._leadInDone) this._leadInPending = true;
      this._leadInDone = true;
    }
    this._switchMusic(this._musicScene, this._music ? 3 : 2);
  }

  /* ---------------- 阶段 4：外部曲目（解码 / 兜底 / 常驻上限） ---------------- */

  /**
   * 只允许合成曲。给验收用的开关：证明「文件轨整条链路拿掉之后，音乐照旧出声」，
   * 而不是只有文件在的时候才响。关掉时会把正在播的文件轨立刻换成合成曲。
   */
  setFileTracksEnabled(on) {
    const next = !!on;
    if (this._filesEnabled === next) return next;
    this._filesEnabled = next;
    if (this._music && this.ready && !this._disposed) {
      const buf = next ? (this._fileBufs.get(this._music.id) || null) : null;
      const wantFile = !!(buf && buf.duration > 0.5);
      /* 开 / 关都要当场见效：关 → 立刻退回合成曲；开 → 已解码就立刻换回曲目。
         只改标记等下次切场景才生效的话，「关掉再打开」这条验收路径会一直停在合成曲上。 */
      if ((wantFile && this._music.source !== 'file') || (!next && this._music.source === 'file')) {
        this._switchMusic(this._music.id, 2);
      }
    }
    return next;
  }

  /**
   * 请求把某场景的外部曲目取回来并解码。
   * 幂等：loading / ready 直接返回；failed 允许以后再试（重进世界、重试网络）。
   * 任何失败都只影响「用哪个声源」，不影响能不能出声——合成曲兜底一直在。
   */
  ensureFileTrack(id) {
    if (this._disposed || !this._filesEnabled) return false;
    const entry = fileTrackFor(id);
    if (!entry) return false;
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return false;
    const st = this._fileState[id];
    if (st === 'loading' || st === 'ready') return true;
    this._fileState[id] = 'loading';
    const url = fileUrl(entry);
    const t0 = _now();
    let bytes = 0, mime = null, fetchMs = 0;
    try {
      fetch(url).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        mime = r.headers.get('content-type') || null;
        return r.arrayBuffer();
      }).then((ab) => {
        /* 字节数要在 decodeAudioData 之前记：它会把这块 ArrayBuffer 转移走，之后 byteLength 就是 0 */
        bytes = ab.byteLength;
        fetchMs = _now() - t0;
        return new Promise((res, rej) => {
          let settled = false;
          const ok = (b) => { if (!settled) { settled = true; res(b); } };
          const bad = (e) => { if (!settled) { settled = true; rej(e instanceof Error ? e : new Error(String(e))); } };
          try {
            const p = ctx.decodeAudioData(ab, ok, bad);      // 老实现只回调，新实现给 Promise，两条都接
            if (p && typeof p.then === 'function') p.then(ok, bad);
          } catch (e) { bad(e); }
        });
      }).then((buf) => {
        if (this._disposed) return;
        if (!buf || !(buf.duration > 0)) throw new Error('解码结果为空');
        this._fileBufs.set(id, buf);
        this._fileState[id] = 'ready';
        this._fileStats[id] = {
          fetchMs: +fetchMs.toFixed(1), decodeMs: +(_now() - t0 - fetchMs).toFixed(1),
          totalMs: +(_now() - t0).toFixed(1), bytes, mime,
          duration: +buf.duration.toFixed(3), sampleRate: buf.sampleRate, channels: buf.numberOfChannels
        };
        if (this._fileOrder.indexOf(id) < 0) this._fileOrder.push(id);
        this._evictFileBuffers(id);
        /* 正在放同场景的合成曲 → 文件就绪后交叉淡化过去。
           首次进世界通常还在这段的 lead-in 静默里，所以玩家一般听不出这次换轨。 */
        if (this._music && this._music.id === id && this._music.source === 'synth' &&
          this._musicWanted && !this._disposed && this.ready) {
          this._switchMusic(id, 2);
        }
      }).catch((e) => {
        this._fileState[id] = 'failed';
        this._fileLastError = (url + ': ' + ((e && e.message) || e)).slice(0, 200);
      });
    } catch (e) {
      this._fileState[id] = 'failed';
      this._fileLastError = (url + ': ' + ((e && e.message) || e)).slice(0, 200);
    }
    return true;
  }

  /** 常驻上限：只留最近就绪的几条（当前场景永远保留），免得三首立体声母带一直压着内存 */
  _evictFileBuffers(keepId) {
    const cur = this._music ? this._music.id : null;
    while (this._fileOrder.length > Math.max(1, this._fileKeep)) {
      let victim = -1;
      for (let i = 0; i < this._fileOrder.length; i++) {
        const id = this._fileOrder[i];
        if (id === keepId || id === cur || id === this._musicScene) continue;
        victim = i; break;
      }
      if (victim < 0) break;                                  // 全是「要留的」，就到此为止
      const id = this._fileOrder.splice(victim, 1)[0];
      this._fileBufs.delete(id);
      this._fileState[id] = 'idle';                            // 下次用到再取，不是失败
    }
  }

  _releaseFileBuffers() {
    this._fileBufs.clear();
    this._fileOrder = [];
    for (const k of Object.keys(this._fileState)) delete this._fileState[k];
  }

  /** 只保留一条主曲：切轨时旧曲进入 _fading（不循环、不计数），3 秒后释放 */
  _switchMusic(id, fade) {
    const ctx = this.ctx;
    if (!ctx || !TRACKS[id]) return;
    const pendingLeadUntil = this._music ? num(this._music.leadUntil, 0) : 0;
    this._flushFading(0.22);                 // 快速连切时，先把上一条淡出中的旧曲收干净
    if (this._music) {
      this._dropMusic(this._music, fade);
      this._music = null;
    }
    const t0 = ctx.currentTime;
    const lead = this._leadInPending ? pickLeadIn(Math.random, MUSIC_TIMING) : Math.max(0, pendingLeadUntil - t0);
    this._leadInPending = false;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t0);
    if (lead > 0) bus.gain.setValueAtTime(0.0001, t0 + lead);   // 先安静一会儿，音乐再出现
    bus.connect(this.musicBus);
    const track = TRACKS[id];
    /* 阶段 4：有解码好的外部曲目就放曲目，没有就放同一场景的合成编排。
       m.track 始终指向合成表，是为了让 section / trackId 这些既有读数一字不变；
       出声用的是哪一路由 m.source 说明。 */
    const entry = this._filesEnabled ? fileTrackFor(id) : null;
    const buffer = entry ? (this._fileBufs.get(id) || null) : null;
    const useFile = !!(buffer && buffer.duration > 0.5);
    if (!useFile) this.ensureFileTrack(id);     // idle / failed 都在这儿再试一次（ready / loading 是空操作）
    const m = {
      id, bus, timer: 0, nextStart: t0 + lead + 0.06, track,
      source: useFile ? 'file' : 'synth',
      buffer: useFile ? buffer : null,
      trim: null, src: null,
      loopSeconds: useFile ? buffer.duration : track.loopSeconds,
      phase: 'playing', gapCount: 0, gapSeconds: 0, leadInSeconds: lead, leadUntil: t0 + lead
    };
    if (useFile) {
      m.trim = ctx.createGain();
      m.trim.gain.value = clamp(num(entry.trim, 1), 0.0001, 1);
      m.trim.connect(bus);
    } else {
      /* 第二轮 MF.3：合成兜底以前比随包曲目轻一大截（实测文件/合成 RMS 比 4.41，
         而产品要求是同一场景、同一总线上「同量级」，否则素材没取到的那一刻会突然掉音量）。
         这里给合成路一条固定的兜底增益，把两路拉近；随包曲目仍走自己的 trim。 */
      m.trim = ctx.createGain();
      m.trim.gain.value = SYNTH_MUSIC_TRIM;
      m.trim.connect(bus);
    }
    this._music = m;
    const fadeIn = lead > 0 ? MUSIC_TIMING.fadeIn : Math.max(0.05, num(fade, 2));
    try { bus.gain.linearRampToValueAtTime(1, t0 + lead + fadeIn); } catch (e) { /* ignore */ }
    this._scheduleLoop(m);
  }

  _scheduleLoop(m) {
    if (!m || this._music !== m || this._disposed || !this.ready) return;
    const ctx = this.ctx;
    if (m.source === 'file' && m.buffer) {
      /* 文件轨：一段 = 整曲播一遍（时长取解码结果），和合成曲共用同一套「段尾淡出 → 留白 → 缓入」*/
      const when = Math.max(ctx.currentTime + 0.02, m.nextStart);
      let started = false;
      try {
        const src = ctx.createBufferSource();
        src.buffer = m.buffer;
        src.loop = false;
        if (m.trim) src.connect(m.trim); else src.connect(m.bus);
        src.onended = () => {
          if (m.src === src) m.src = null;
          try { src.disconnect(); } catch (e) { /* ignore */ }
        };
        src.start(when);
        m.src = src;
        started = true;
      } catch (e) {
        m.src = null;
      }
      if (started) {
        m.nextStart = when + m.loopSeconds;
      } else {
        /* 起不来（比如 ctx 刚关）就当场降级成合成曲，下一条段再试曲目 */
        m.source = 'synth'; m.buffer = null;
        m.loopSeconds = m.track.loopSeconds;
        /* 合成编排走 trim（没有 trim 时退回总线）—— MF.3 的兜底增益就挂在这上面 */
        try { scheduleTrack(ctx, m.trim || m.bus, { id: m.id, start: when, loops: 1, gain: 0.92 }); } catch (e) { /* ignore */ }
        m.nextStart = when + m.loopSeconds;
      }
    } else {
      try {
        scheduleTrack(ctx, m.trim || m.bus, { id: m.id, start: m.nextStart, loops: 1, gain: 0.92 });
      } catch (e) { /* 编排失败也不许把主循环拖垮 */ }
      m.nextStart += m.loopSeconds;
    }
    /* T4：播完一段不再无缝接下一段 —— 曲终淡出 → 长留白 → 缓入 → 再排。
       留白期间 _music 对象仍在（trackId / activeMusicCount 不变），
       所以 MU.1~MU.8 的「任何时刻一条主曲」语义一字未动，只是听感变稀疏。
       任何时刻只有一个 m.timer（段尾定时器或留白定时器），_dropMusic 清一个就够。 */
    const untilEndMs = segmentWaitMs(m.nextStart - ctx.currentTime);
    m.timer = setTimeout(() => {
      m.timer = 0;
      if (this._music !== m || this._disposed || !this.ready) return;
      const now = ctx.currentTime;
      try {
        m.bus.gain.cancelScheduledValues(now);
        m.bus.gain.setValueAtTime(Math.max(0.0001, num(m.bus.gain.value, this._musicTarget())), now);
        m.bus.gain.linearRampToValueAtTime(0.0001, now + MUSIC_TIMING.fadeOut);
      } catch (e) { /* ignore */ }
      m.phase = 'gap';
      m.gapCount++;
      m.gapSeconds = pickGap(Math.random, MUSIC_TIMING);
      m.timer = setTimeout(() => {
        m.timer = 0;
        if (this._music !== m || this._disposed || !this.ready) return;
        m.phase = 'playing';
        m.nextStart = ctx.currentTime + 0.06;   // 留白期间时间照走，重新对齐到当下
        try {
          m.bus.gain.setValueAtTime(0.0001, ctx.currentTime);
          m.bus.gain.linearRampToValueAtTime(1, ctx.currentTime + MUSIC_TIMING.fadeIn);
        } catch (e) { /* ignore */ }
        this._scheduleLoop(m);
      }, Math.round((MUSIC_TIMING.fadeOut + m.gapSeconds) * 1000));
    }, untilEndMs);
  }

  _dropMusic(m, fade) {
    if (!m) return;
    if (m.timer) { clearTimeout(m.timer); m.timer = 0; }
    if (!this.ctx || this.ctx.state === 'closed') {
      this._stopTrackSource(m, 0);
      try { if (m.trim) m.trim.disconnect(); } catch (e) { /* ignore */ }
      try { m.bus.disconnect(); } catch (e) { /* ignore */ }
      return;
    }
    const now = this.ctx.currentTime;
    /* 留白期间本来就近乎静音，别把一个已经淡出的曲子拉回满增益再收尾 */
    const fd = m.phase === 'gap' ? 0.05 : clamp(num(fade, 2), 0.05, 4);
    try {
      m.bus.gain.cancelScheduledValues(now);
      m.bus.gain.setValueAtTime(clamp(num(m.bus.gain.value, this._musicTarget()), 0.0001, 1), now);
      m.bus.gain.exponentialRampToValueAtTime(0.0001, now + fd);
    } catch (e) { /* ignore */ }
    this._stopTrackSource(m, now + fd);          // 文件轨：淡出走完后真的停下，不留一条静音长跑的 source
    m.cleanup = setTimeout(() => {
      this._stopTrackSource(m, 0);
      try { if (m.src) m.src.disconnect(); } catch (e) { /* ignore */ }
      m.src = null;
      try { if (m.trim) m.trim.disconnect(); } catch (e) { /* ignore */ }
      try { m.bus.disconnect(); } catch (e) { /* ignore */ }
      this._fading.delete(m);
    }, fd * 1000 + 120);
    this._fading.add(m);
  }

  /** 停掉这条轨的声源：at 为 0 表示「立刻」，否则排到 at 时刻（淡出还要听得见） */
  _stopTrackSource(m, at) {
    if (!m || !m.src) return;
    const src = m.src;
    try {
      if (typeof at === 'number' && at > 0) src.stop(at); else src.stop();
    } catch (e) { /* 已经 ended / 还没 start 都会抛，忽略即可 */ }
    if (at === 0) m.src = null;
  }

  _flushFading(fast) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    for (const m of Array.from(this._fading)) {
      if (m.cleanup) clearTimeout(m.cleanup);
      try {
        if (this.ctx) {
          m.bus.gain.cancelScheduledValues(now);
          m.bus.gain.setValueAtTime(Math.max(0.0001, m.bus.gain.value), now);
          m.bus.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.05, fast));
        }
      } catch (e) { /* ignore */ }
      this._stopTrackSource(m, now + Math.max(0.05, fast));
      const bus = m.bus, trim = m.trim, src = m.src;
      setTimeout(() => {
        try { if (src) src.disconnect(); } catch (e) { /* ignore */ }
        try { if (trim) trim.disconnect(); } catch (e) { /* ignore */ }
        try { bus.disconnect(); } catch (e) { /* ignore */ }
      }, Math.max(60, fast * 1000 + 60));
      this._fading.delete(m);
    }
  }

  _hardStopMusic() {
    if (this._music) {
      if (this._music.timer) clearTimeout(this._music.timer);
      this._stopTrackSource(this._music, 0);
      try { if (this._music.src) this._music.src.disconnect(); } catch (e) { /* ignore */ }
      try { if (this._music.trim) this._music.trim.disconnect(); } catch (e) { /* ignore */ }
      try { this._music.bus.disconnect(); } catch (e) { /* ignore */ }
      this._music = null;
    }
    for (const m of Array.from(this._fading)) {
      if (m.cleanup) clearTimeout(m.cleanup);
      this._stopTrackSource(m, 0);
      try { if (m.src) m.src.disconnect(); } catch (e) { /* ignore */ }
      try { if (m.trim) m.trim.disconnect(); } catch (e) { /* ignore */ }
      try { m.bus.disconnect(); } catch (e) { /* ignore */ }
    }
    this._fading.clear();
  }

  stopMusic(fade) {
    this._musicWanted = false;
    // 环境声由自己的开关/生命周期释放，避免暂停时重复停止打断淡出。
    if (this._music) {
      this._dropMusic(this._music, fade === undefined ? 0.9 : fade);
      this._music = null;
    }
    // 连关音乐时也把仍在淡出的旧曲收干净，避免残留循环
    this._flushFading(0.25);
  }

  /*
   * 本轮 D：「背景音乐」这个开关的语义。
   * 旧行为：设置里关掉背景音乐 → applySettingsLive 调 stopMusic() → **环境床一起停**
   * （风、虫鸣、洞穴滴水全没了），玩家只是想安静一点，世界却突然变成静音。
   * 现在：
   *   · setMusicEnabled(false)：只停主曲，环境床照常按场景切换（_envWanted 保持 true）；
   *   · setMusicEnabled(true)：重新起主曲（场景由 ensureScene 决定）；
   *   · stopAmbient 仍然只在暂停/退出时调用 —— 暂停释放规则不变。
   */
  setMusicEnabled(on) {
    if (!on) {
      this._musicWanted = false;
      if (this._music) { this._dropMusic(this._music, 0.8); this._music = null; }
      this._flushFading(0.2);
      return false;
    }
    this._musicWanted = true;
    if (this.ready && !this._music) this.startMusic();
    return true;
  }

  /* 环境床的总开关（默认常开）：与音乐开关分开，只有暂停/退出才关 */
  setAmbientEnabled(on) {
    this._envWanted = on !== false;
    if (!this._envWanted) this.stopAmbient(0.6);
    return this._envWanted;
  }

  /* ---------------- 环境床（风 / 虫鸣 / 洞穴滴水 / 雨声） ---------------- */

  updateAmbient(state = {}) {
    this._dayT = clamp(num(state.dayT, this._dayT), 0, 1);
    const uw = !!state.underwater;
    const underwaterChanged = uw !== this._underwater;
    const mix = ambientMix(state);
    const changed = underwaterChanged || mix.lowpass !== this._ambientMix.lowpass;
    this._ambientMix = mix;
    this._underwater = uw;
    if (this._disposed || !this.ready) return;
    if (underwaterChanged) this._set(this.toneFilter.frequency, uw ? 640 : 18000, 0.25);
    /* 本轮 D：环境床只听 _envWanted（默认常开），不再跟音乐开关联动 */
    if (this._envWanted === false) return;
    const want = selectAmbient(state);
    if (want !== this._ambientId) this._switchAmbient(want, 2);
    // 音量跟随昼夜变化时每 ~0.8 秒更新一次即可，避免每帧堆自动化事件
    const nowMs = _now();
    if (changed || !this._lastMix || nowMs - this._lastMix > 800) {
      this._lastMix = nowMs;
      if (this._music) this._set(this.musicBus.gain, this._musicTarget(), 0.6);
      if (this._ambient) this._set(this._ambient.gain.gain, this._ambientTarget(), 0.8);
      if (this._ambient) this._set(this._ambient.filter.frequency, mix.lowpass, 0.35);
    }
  }

  _switchAmbient(id, fade) {
    if (!AMBIENT_IDS.includes(id)) return;
    if (this._ambientId === id && this._ambient) return;
    this._flushAmbientFading(0.22);          // 快速切环境床时最多保留一条淡出中的旧床
    if (this._ambient) {
      const old = this._ambient;
      this._ambient = null;
      this._ambientId = null;
      this._fadeAmbient(old, fade);
    }
    const bed = this._createAmbientBed(id, fade);
    this._ambient = bed;
    this._ambientId = id;
    this._attachAmbientBuffer(bed);
  }

  /** 环境长录音单独解码，不进入短音效的限流、变速或播放队列。 */
  ensureAmbientFiles() {
    if (this._disposed || !this.ctx || this.ctx.state === 'closed') return;
    const ctx = this.ctx;
    for (const id of AMBIENT_FILE_IDS) {
      if (this._ambientFileState[id] === 'loading' || this._ambientFileState[id] === 'ready') continue;
      this._ambientFileState[id] = 'loading';
      fetch(ambientFileUrl(id)).then(response => {
        if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + ambientFileUrl(id));
        return response.arrayBuffer();
      }).then(bytes => ctx.decodeAudioData(bytes)).then(buffer => {
        if (this._disposed || this.ctx !== ctx) return;
        if (!(buffer.duration > 0)) throw new Error('Empty ambient recording: ' + id);
        this._ambientBuffers.set(id, buffer);
        this._ambientFileState[id] = 'ready';
        if (this._ambient && this._ambient.id === id) this._attachAmbientBuffer(this._ambient);
      }).catch(error => {
        if (this._disposed) return;
        this._ambientFileState[id] = 'failed';
        this._ambientFileError = String(error.message || error);
      });
    }
  }

  ambientFilesInfo() {
    return { active: this._ambientId, source: this._ambient ? this._ambient.source : null,
      fading: this._ambientFading.size, lastError: this._ambientFileError || null,
      files: AMBIENT_FILE_IDS.map(id => ({ id, file: ambientFileFor(id).file,
        state: this._ambientFileState[id] || 'idle', seconds: this._ambientBuffers.get(id)?.duration || null })) };
  }

  _createAmbientBed(id, fade) {
    const ctx = this.ctx, gain = ctx.createGain(), filter = ctx.createBiquadFilter();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.connect(this.ambientBus);
    filter.type = 'lowpass'; filter.frequency.value = this._ambientMix.lowpass; filter.Q.value = 0.5;
    filter.connect(gain);
    gain.gain.setTargetAtTime(this._ambientTarget(), ctx.currentTime, Math.max(0.05, fade / 3));
    return { id, gain, filter, sources: [], lfos: [], timers: [], nodes: [filter], stopped: false, source: 'loading' };
  }

  _attachAmbientBuffer(bed) {
    if (!bed || this._ambient !== bed || bed.stopped || this._envWanted === false || this._disposed || bed.sources.length) return;
    const buffer = this._ambientBuffers.get(bed.id);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer; src.loop = true; src.connect(bed.filter);
    // 随机进入同一条平滑长循环，避免每次出门都从相同鸟句/风阵开始。
    src.start(this.ctx.currentTime + 0.02, Math.random() * buffer.duration);
    bed.sources.push(src); bed.nodes.push(src); bed.source = 'file';
  }

  _fadeAmbient(bed, fade) {
    if (!bed) return;
    bed.stopped = true;
    for (const t of bed.timers) clearTimeout(t);
    bed.timers.length = 0;
    const now = this.ctx ? this.ctx.currentTime : 0;
    const fd = clamp(num(fade, 1), 0.05, 4);
    try {
      bed.gain.gain.cancelScheduledValues(now);
      bed.gain.gain.setValueAtTime(Math.max(0.0001, bed.gain.gain.value), now);
      bed.gain.gain.exponentialRampToValueAtTime(0.0001, now + fd);
    } catch (e) { /* ignore */ }
    const cleanup = setTimeout(() => {
      for (const s of bed.sources) { try { s.stop(); } catch (e) { /* ignore */ } }
      for (const l of bed.lfos) { try { l.stop(); } catch (e) { /* ignore */ } }
      for (const n of bed.nodes || []) { try { n.disconnect(); } catch (e) { /* ignore */ } }
      try { bed.gain.disconnect(); } catch (e) { /* ignore */ }
      this._ambientFading.delete(bed);
    }, fd * 1000 + 120);
    this._ambientFading.add(bed);
    bed.cleanup = cleanup;
  }

  _flushAmbientFading(fast) {
    for (const bed of Array.from(this._ambientFading)) {
      if (bed.cleanup) clearTimeout(bed.cleanup);
      for (const t of bed.timers) clearTimeout(t);
      for (const s of bed.sources) { try { s.stop(); } catch (e) { /* ignore */ } }
      for (const l of bed.lfos) { try { l.stop(); } catch (e) { /* ignore */ } }
      for (const n of bed.nodes || []) { try { n.disconnect(); } catch (e) { /* ignore */ } }
      try { bed.gain.disconnect(); } catch (e) { /* ignore */ }
      this._ambientFading.delete(bed);
    }
  }

  stopAmbient(fade) {
    // 先记下调用前就在淡出的旧床，只硬停它们；当前床按 fade 正常收尾
    const previous = Array.from(this._ambientFading);
    if (this._ambient) {
      const bed = this._ambient;
      this._ambient = null;
      this._ambientId = null;
      this._fadeAmbient(bed, fade === undefined ? 0.9 : fade);
    }
    for (const bed of previous) {
      if (bed.cleanup) clearTimeout(bed.cleanup);
      for (const t of bed.timers) clearTimeout(t);
      for (const s of bed.sources) { try { s.stop(); } catch (e) { /* ignore */ } }
      for (const l of bed.lfos) { try { l.stop(); } catch (e) { /* ignore */ } }
      for (const n of bed.nodes || []) { try { n.disconnect(); } catch (e) { /* ignore */ } }
      try { bed.gain.disconnect(); } catch (e) { /* ignore */ }
      this._ambientFading.delete(bed);
    }
  }

  /* ---------------- 只读诊断 ---------------- */
  musicInfo() {
    const m = this._music;
    const t = m ? m.track : null;
    const cur = m ? m.id : this._musicScene;
    const entry = fileTrackFor(cur);
    const states = {};
    for (const id of FILE_TRACK_IDS) states[id] = this._fileState[id] || 'idle';
    let bytesDecoded = 0;
    for (const id of FILE_TRACK_IDS) {
      const s = this._fileStats[id];
      if (s && this._fileState[id] === 'ready' && s.bytes) bytesDecoded += s.bytes;
    }
    return {
      ready: this.ready,
      wanted: this._musicWanted,
      scene: this._musicScene,
      trackId: m ? m.id : null,
      section: t ? t.section : null,
      activeMusicCount: m ? 1 : 0,
      fadingMusicCount: this._fading.size,
      activeAmbient: this._ambient ? this._ambient.id : null,
      ambientCount: this._ambient ? 1 : 0,
      /* 阶段 3c：光有床对象不代表有源在播。把持续源数量交出去，
         B.5 用它区分「环境层真的在出声」和「对象还在但源已停」。 */
      ambientSources: this._ambient ? this._ambient.sources.length : 0,
      ambientFadingCount: this._ambientFading.size,
      ambientSource: this._ambient ? this._ambient.source : null,
      ambientFile: this._ambient ? ambientFileFor(this._ambient.id)?.file : null,
      /* 阶段 4：loopSeconds 现在是「眼前这一段真的多长」——文件轨就是整曲时长；
         编排本身的多长仍然在 synthLoopSeconds，两个口径都留着，不互相冒充。 */
      loopSeconds: m ? +num(m.loopSeconds, 0).toFixed(3) : null,
      synthLoopSeconds: t ? +t.loopSeconds.toFixed(3) : null,
      source: m ? m.source : null,
      /* 这一条主曲自己的总线增益（缓入 / 段尾淡出 / 留白都体现在这里）与场景应有的目标增益 */
      busGain: m ? +num(m.bus ? m.bus.gain.value : 0, 0).toFixed(6) : null,
      /* 真正到 master 之前的合成增益 = 这一条自己的缓入 × music 总线（音量滑条动的是后者） */
      busGainTotal: m ? +(num(m.bus ? m.bus.gain.value : 0, 0) * num(this.musicBus ? this.musicBus.gain.value : 0, 0)).toFixed(6) : null,
      busTarget: +this._musicTarget().toFixed(6),
      fileName: entry ? entry.file : null,
      fileMeta: entry ? {
        title: entry.title, author: entry.author, licence: entry.licence,
        source: entry.source, attribution: entry.attribution, modified: entry.modified
      } : null,
      fileDuration: m && m.buffer ? +m.buffer.duration.toFixed(3) : null,
      fileTrim: entry ? entry.trim : null,
      fileState: this._fileState[cur] || 'idle',
      fileStates: states,
      fileReadyCount: FILE_TRACK_IDS.filter(id => this._fileState[id] === 'ready').length,
      filesEnabled: this._filesEnabled,
      bytesDecoded,
      fileLastError: this._fileLastError,
      volumes: { master: this._vols.master, music: this._vols.music, sfx: this._vols.sfx },
      /* T4：出场时机读数（纯参数，不等待真实留白）与当前循环相位 */
      timing: timingConfig(),
      ambientVolumeSource: 'sfx',
      leadInDone: this._leadInDone,
      cycle: m ? {
        phase: m.phase,
        gapCount: m.gapCount,
        gapSeconds: m.gapSeconds,
        leadInSeconds: m.leadInSeconds
      } : null
    };
  }

  /** 外部曲目登记表（只读诊断，许可信息跟着代码走） */
  fileTracksInfo() {
    return FILE_TRACK_IDS.map(id => {
      const e = FILE_TRACKS[id];
      const s = this._fileStats[id] || null;
      return {
        scene: id, file: e.file, title: e.title, author: e.author, licence: e.licence,
        source: e.source, bytes: e.bytes, trim: e.trim,
        state: this._fileState[id] || 'idle', load: s
      };
    });
  }

  trackInfo(id) { return trackInfo(id); }
  ambientIds() { return AMBIENT_IDS.slice(); }
}

function noop() {}

export default Sfx;
