/*
 * 挖掘 / 破坏 / 放置的制作参数。Strudel 只当制作端，游戏运行时拿到的是渲染好的 WAV。
 *
 * 素材（全部 CC0）：
 *   · Kenney「Impact Sounds」：真实撞击瞬态（mine / plate / soft / wood / plank / generic）；
 *   · Peludo 沙地录音：切成短颗粒，做「沙沙」的沙、砾、以及干叶的碎响（树叶没有现成 CC0 单品，
 *     用同一段颗粒摩擦加工成宽带碎响，比拿一条轻点击冒充更像叶子）。
 *
 * 每类材质的每个变体都换一组不同原始颗粒；破坏叠两层不同录音 + 一层低频落定；
 * 同一材质在「持续敲击 / 最终破坏 / 放置」里共用滤波与音高，听得出是同一块材料。
 */
export const BANKS = {
  soft: 'impactSoft_medium',        // 松散的软接触
  softHeavy: 'impactSoft_heavy',    // 更重的软接触 / 碎的落定
  mine: 'impactMining',             // 镐尖落石
  woodLight: 'impactWood_light',
  woodMedium: 'impactWood_medium',
  plank: 'impactPlank_medium',
  generic: 'impactGeneric_light',   // 轻碎屑
  plate: 'impactPlate_light',       // 石的短硬撞
  metalLight: 'impactMetal_light'
};
/* 沙地录音切出来的 4 段颗粒（渲染页从 sand_footsteps.mp3 现场切，见 render-browser.mjs） */
export const SAND_BANK = 'sandgrain';

/* hpf/lpf/speed 决定「这是什么材料」；seconds/rms 决定每条导出多长、多响（混音里的相对量级）。
   石头这一版收低截止（7600 → 5200Hz）并加一层低频身体，压掉「尖」；沙子与叶子额外叠颗粒层。 */
const TONES = {
  dirt: { hpf: 60, lpf: 2500, speed: 0.93, seconds: 0.16, rms: 0.125 },
  grass: { hpf: 1100, lpf: 8200, speed: 1, seconds: 0.22, rms: 0.1 },
  stone: { hpf: 180, lpf: 5200, speed: 1, seconds: 0.15, rms: 0.11 },
  wood: { hpf: 120, lpf: 4100, speed: 0.97, seconds: 0.15, rms: 0.12 },
  sand: { hpf: 320, lpf: 6200, speed: 1, seconds: 0.2, rms: 0.1 },
  gravel: { hpf: 260, lpf: 5200, speed: 0.95, seconds: 0.2, rms: 0.105 }
};

const layer = (bank, take, at, speed, gain, extra) => Object.assign({ bank, take, at, speed, gain }, extra || {});
const rotate = (list, index) => list[index % list.length];

/* 主层：决定这个是「撞在什么上」。颗粒层见 DECOR。 */
const DIG_PRIMARY = {
  dirt: v => layer('soft', rotate([0, 1, 2, 3], v), 0, 0.93, 0.9),
  grass: v => layer('generic', rotate([0, 2, 3, 4], v), 0, 1.04, 0.3),
  stone: v => layer('mine', rotate([0, 1, 3, 4], v), 0, 1, 0.78),
  wood: v => layer(['woodLight', 'woodMedium', 'woodLight', 'plank'][v % 4], v % 5, 0, 0.97, 0.9),
  sand: v => layer('soft', rotate([1, 3, 0, 4], v), 0, 1.02, 0.5, { lpf: 5200 }),
  gravel: v => layer('softHeavy', rotate([2, 4, 3, 0], v), 0, 0.9, 0.55, { lpf: 4800 })
};

/* 颗粒层：沙子/砾石的「沙沙」，树叶的干碎响，石头的低频身体。 */
const DIG_DECOR = {
  dirt: () => [],
  wood: () => [],
  grass: v => [
    layer(SAND_BANK, v % 4, 0, 1.06, 0.72, { hpf: 1500, lpf: 8600 }),
    layer(SAND_BANK, (v + 2) % 4, 0.022, 1.24, 0.4, { hpf: 2600, lpf: 9200 })
  ],
  stone: v => [
    layer('soft', rotate([0, 1, 2, 3, 4], v), 0, 0.9, 0.4, { hpf: 50, lpf: 700 })
  ],
  sand: v => [
    layer(SAND_BANK, v % 4, 0, 1.02, 0.85, { hpf: 900, lpf: 7000 }),
    layer(SAND_BANK, (v + 1) % 4, 0.03, 1.12, 0.45, { hpf: 1300, lpf: 7600 })
  ],
  gravel: v => [
    layer(SAND_BANK, v % 4, 0, 0.9, 0.65, { hpf: 650, lpf: 5800 }),
    layer('softHeavy', (v + 2) % 5, 0.018, 0.95, 0.32, { hpf: 180, lpf: 2600 })
  ]
};

const DEBRIS = {
  dirt: [['softHeavy', 2], ['soft', 3], ['softHeavy', 0]],
  grass: [[SAND_BANK, 1], [SAND_BANK, 3], [SAND_BANK, 2]],
  stone: [['plate', 0], ['plate', 2], ['plate', 3]],
  wood: [['plank', 1], ['plank', 2], ['plank', 4]],
  sand: [[SAND_BANK, 1], [SAND_BANK, 3], [SAND_BANK, 4]]
};

const PLACE_TAKES = {
  dirt: [['soft', 1], ['soft', 3], ['softHeavy', 4]],
  grass: [[SAND_BANK, 0], [SAND_BANK, 2], [SAND_BANK, 3]],
  stone: [['plate', 0], ['plate', 1], ['plate', 4]],
  wood: [['woodLight', 1], ['woodLight', 3], ['woodMedium', 4]],
  sand: [['softHeavy', 0], ['soft', 2], ['softHeavy', 2]]
};

export const BREAK_FAMILIES = ['dirt', 'grass', 'stone', 'wood', 'sand'];
export const PLACE_FAMILIES = ['grass', 'dirt', 'stone', 'wood', 'sand'];
export const DIG_FAMILIES = Object.keys(DIG_PRIMARY);
export const ACTIONS = ['dig', 'break', 'place'];

function digJob(family, variant) {
  const tone = TONES[family];
  return {
    id: 'dig_' + family + ['', '_b', '_c', '_d'][variant], action: 'dig', family, variant,
    seconds: tone.seconds, rms: tone.rms,
    layers: [DIG_PRIMARY[family](variant)].concat(DIG_DECOR[family](variant)),
    tone
  };
}

function breakJob(family, variant) {
  const tone = TONES[family];
  const primary = DIG_PRIMARY[family](variant);
  const [bank2, take2] = DEBRIS[family][variant % DEBRIS[family].length];
  return {
    id: 'break_' + family + ['', '_b', '_c'][variant], action: 'break', family, variant,
    seconds: 0.42, rms: tone.rms * 1.5,
    layers: [
      Object.assign({}, primary, { speed: primary.speed * 0.94, gain: 1 }),
      layer(bank2, take2, 0.07, tone.speed * 0.82, 0.6, family === 'grass' ? { hpf: 1400, lpf: 8000 } : null),
      layer('softHeavy', variant, 0.13, 0.7, 0.34, { hpf: 60, lpf: 900 })
    ].concat(DIG_DECOR[family](variant).slice(0, 1).map(extra => Object.assign({}, extra, { at: 0.04, gain: extra.gain * 0.8 }))),
    tone: { ...tone, lpf: tone.lpf * 0.9 }
  };
}

function placeJob(family, variant) {
  const tone = TONES[family];
  const [bank, take] = PLACE_TAKES[family][variant];
  const id = family === 'grass' ? 'place' + ['', '_b', '_c'][variant] : 'place_' + family + ['', '_b', '_c'][variant];
  /* 通用 'place' 借用草叶那一路：它不是某种材料的身份，只表示「手上没有更合适的材质」。 */
  const grain = family === 'grass' || family === 'sand'
    ? [layer(SAND_BANK, (variant + 1) % 4, 0.012, 1.1, 0.35, { hpf: 1600, lpf: 8000 })]
    : [];
  return {
    id, action: 'place', family, variant,
    seconds: 0.15, rms: 0.095,
    layers: [layer(bank, take, 0, tone.speed * 0.9, 0.7)].concat(grain),
    tone: { ...tone, lpf: tone.lpf * 0.75, hpf: Math.max(20, tone.hpf) }
  };
}

/* 渲染页按层取参数自己拼 Strudel 模式：这里只描述「用哪条录音、什么时间点、多大」。 */
export function layersFor(job) {
  const tone = job.tone;
  return job.layers.map(item => ({
    bank: item.bank, take: item.take, at: item.at,
    speed: item.speed, gain: item.gain,
    hpf: Math.max(20, item.hpf === undefined ? tone.hpf : item.hpf),
    lpf: Math.min(item.lpf === undefined ? tone.lpf : item.lpf, 12000)
  }));
}

export function jobs(action) {
  const build = action === 'dig' ? digJob : action === 'break' ? breakJob : placeJob;
  const families = action === 'dig' ? DIG_FAMILIES : action === 'break' ? BREAK_FAMILIES : PLACE_FAMILIES;
  const count = action === 'dig' ? 4 : 3;
  const list = [];
  for (const family of families) for (let variant = 0; variant < count; variant++) list.push(build(family, variant));
  return list;
}
