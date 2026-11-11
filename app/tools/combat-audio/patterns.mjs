/* 自然、温暖：真实接触与短呼气，保留动作辨识，不加湿挤压、振荡器或位深破坏。 */
const cut = (source, begin = 0, end) => ({ source, begin, end });
const beat = 37800 / 44100;
export const BANKS = {
  swish: [cut('swish', 0.02, 0.24), cut('swish', beat + 0.02, beat + 0.24)],
  punch: [cut('punch0'), cut('punch1'), cut('punch2')],
  soft: [cut('soft0'), cut('soft2'), cut('soft4')],
  cloth: [cut('cloth', 0.09, 0.29), cut('cloth', beat + 0.025, beat + 0.24), cut('cloth', beat * 2 + 0.025, beat * 2 + 0.22)],
  voice: [cut('voice', 6.18, 6.49), cut('voice', 7.29, 7.63), cut('voice', 8.47, 8.79)],
  fall: [cut('voice', 4.97, 5.27), cut('voice', 18.28, 18.60)],
  water: [cut('water', 0.30, 0.64), cut('water', 2.62, 2.96)],
  metal: [cut('metal0'), cut('metal3'), cut('plate4')],
  clank: [cut('clank', beat * 2, beat * 2 + 0.16), cut('clank', beat * 4, beat * 4 + 0.19)],
  wood: [cut('wood1'), cut('wood4')],
  woodBreak: [cut('woodHeavy1'), cut('woodHeavy3')],
  plank: [cut('plank2'), cut('plank4')],
  chain: [cut('chain', beat * 2 + 0.02, beat * 2 + 0.32), cut('chain', beat * 6 + 0.01, beat * 6 + 0.34)],
  bow: [cut('bow0', 0.185, 0.405), cut('bow1', 0.07, 0.29)],
  arrow: [cut('arrow0', 0.055, 0.215), cut('arrow1', 0.095, 0.255)],
  settle: [cut('cloth', beat * 3 + 0.015, beat * 3 + 0.405)]
};
const layer = (bank, take, gain = 1, at = 0, tone) => ({ bank, take, gain, at, speed: 1, ...tone });
const job = (id, seconds, rms, hpf, lpf, layers) => ({ id, seconds, rms, tone: { hpf, lpf }, layers });
const names = ['', '_b', '_c'];
export const JOBS = [
  ...[0, 1].map(i => job('swing' + names[i], 0.22, 0.042, 180, 4600, [layer('swish', i)])),
  ...[0, 1, 2].map(i => job('hit_flesh' + names[i], 0.18, 0.076, 100, 3300, [layer('punch', i), layer('cloth', i, 0.22)])),
  ...[0, 1, 2].map(i => job('hit_armor' + names[i], 0.20, 0.060, 240, 4800, [layer('metal', i)])),
  ...[0, 1, 2].map(i => job('hurt_body' + names[i], 0.32, 0.060, 100, 2600, [layer('voice', i), layer('soft', i, 0.18, 0, { lpf: 1700 })])),
  ...[0, 1].map(i => job('hurt_fall' + names[i], 0.30, 0.040, 100, 2200, [layer('fall', i)])),
  ...[0, 1].map(i => job('hurt_drown' + names[i], 0.34, 0.046, 90, 1500, [layer('water', i)])),
  ...[0, 1].map(i => job('shield_block' + names[i], 0.15, 0.075, 100, 3500, [layer('wood', i), layer('clank', i, 0.28, 0.005)])),
  ...[0, 1].map(i => job('shield_break' + names[i], 0.34, 0.085, 120, 4000, [layer('woodBreak', i), layer('plank', i, 0.45, 0.045), layer('clank', i, 0.24, 0.08)])),
  ...[0, 1].map(i => job('armor_break' + names[i], 0.34, 0.040, 220, 4500, [layer('clank', i), layer('chain', i, 0.55, 0.025)])),
  ...[0, 1].map(i => job('bow_release' + names[i], 0.22, 0.060, 140, 5000, [layer('bow', i)])),
  ...[0, 1].map(i => job('arrow_hit' + names[i], 0.16, 0.058, 120, 4000, [layer('arrow', i)])),
  /* 死亡仍由原入口触发：用衣料落定补足最后一次受伤，避免再叠一句人声或电子旋律。 */
  job('death', 0.39, 0.034, 100, 2300, [layer('settle', 0)])
];
export function layersFor(job) {
  return job.layers.map(item => ({ ...item, hpf: item.hpf ?? job.tone.hpf, lpf: item.lpf ?? job.tone.lpf }));
}
