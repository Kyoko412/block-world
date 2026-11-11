// Strudel is an authoring dependency only. The game receives rendered WAV files.
export const MATERIALS = {
  grass: { bank: 'grass', hpf: 85, lpf: 6200, speed: 1, max: 0.46 },
  stone: { bank: 'stone', hpf: 95, lpf: 7600, speed: 0.97, max: 0.34 },
  wood: { bank: 'wood', hpf: 80, lpf: 5600, speed: 0.98, max: 0.36 },
  sand: { bank: 'sand', hpf: 140, lpf: 7200, speed: 1, max: 0.44 },
  snow: { bank: 'snow', hpf: 110, lpf: 6800, speed: 0.99, max: 0.42 },
  body: { bank: 'body', hpf: 160, lpf: 2800, speed: 1.1, max: 0.18 }
};

export function movementPattern(s, material, variant, action) {
  const tone = MATERIALS[material];
  const landing = action === 'land';
  return s(tone.bank).n(variant)
    .hpf(tone.hpf).lpf(tone.lpf * (landing ? 0.8 : 1))
    .speed(tone.speed * (landing ? 0.86 : 1))
    .gain(0.8).attack(0.002).release(0.025);
}
