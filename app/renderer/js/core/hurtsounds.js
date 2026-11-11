'use strict';
/*
 * 受伤反馈的「该响哪些声音」——纯函数，不碰 AudioContext，方便单测钉住语义。
 *
 * controller.hurt() 传来的 info 带 type（melee / arrow / explosion / fall / drown / cactus /
 * starve / poison / void / generic）、absorbed（护甲吃掉的部分）与 armorPoints。
 *
 * 规则（本轮 E2）：
 *   · fall：落地撞击已经由移动那一包负责，这里只留一个短、低、无冲击的闷哼，绝不叠第二个撞击；
 *   · drown：专用真实水下气泡，避免普通落水声和身体撞击；
 *   · starve / poison：持续伤害更轻，别和战斗受击一样抢耳；
 *   · 其余（近战 / 箭 / 爆炸 / 仙人掌）：身体受击本体；护甲真的吸收时才叠金属接触。
 *
 * 变体由调用方给 variant 序号轮换，保证连续两次同因受伤不重复同一条录音。
 */
const HURT_BODY = ['', '_b', '_c'];
const HURT_FALL = ['', '_b'];
const HIT_ARMOR = ['', '_b', '_c'];

export function hurtSoundPlan(info, variant = 0) {
  if (info && (info.blocked || (Number.isFinite(info.taken) && info.taken <= 0))) return [];
  const type = (info && info.type) || 'generic';
  const absorbed = info && Number.isFinite(info.absorbed) ? info.absorbed : 0;
  const pick = (suffixes, index) => suffixes[((index % suffixes.length) + suffixes.length) % suffixes.length];

  if (type === 'fall') {
    return [{ name: 'hurt_fall' + pick(HURT_FALL, variant), volume: 0.46, rate: 1 }];
  }
  if (type === 'drown') {
    return [{ name: 'hurt_drown' + pick(HURT_FALL, variant), volume: 0.50, rate: 1 }];
  }
  const quiet = type === 'starve' || type === 'poison';
  const plan = [{
    name: 'hurt_body' + pick(HURT_BODY, variant),
    volume: quiet ? 0.32 : (type === 'cactus' ? 0.50 : 0.70),
    rate: 1
  }];
  if (absorbed > 0) {
    plan.push({ name: 'hit_armor' + pick(HIT_ARMOR, variant), volume: 0.32, rate: 1 });
  }
  return plan;
}

export default { hurtSoundPlan };
