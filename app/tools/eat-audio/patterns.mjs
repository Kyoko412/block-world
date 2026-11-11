/* 真实 CC0 录音的切片与 Strudel 制作参数；不同变体选不同接触片段。 */
const warsong = {
  author: 'Wareya', authorPage: 'https://warsong.pages.dev/',
  source: 'https://warsong.pages.dev/tags/sounds/',
  download: 'https://warsong.pages.dev/sounds/rpg%20foley.zip'
};
export const SOURCES = {
  munch: { ...warsong, file: 'foley - munch.wav', sha256: 'd818ca1da09e04dfc51d5dfefb6491936c19b359e49984ae18062c671a2a0f67' },
  swallow: { ...warsong, file: 'foley - swallow.wav', sha256: '2d76391b80a328208ac3c45557da47e8dfa156a1250a7d3ac5651ab7f90e9faa' },
  quaff: { ...warsong, file: 'foley - quaff.wav', sha256: 'ab7b487b592c0d64edc079af6db80d181bba21625503f962c21d1f726e3aa9d2' },
  apple: {
    author: 'thedapperdan', authorPage: 'https://freesound.org/people/thedapperdan/',
    source: 'https://freesound.org/people/thedapperdan/sounds/199923/',
    download: 'https://cdn.freesound.org/previews/199/199923_11337-hq.mp3',
    file: 'apple-199923-hq.mp3', sha256: '4378afba23bfeb13b14d35b88517353f0f0241994b02313b1aed956fb50cd265',
    note: '作者公开的高质量 MP3 试听版本，同一 CC0 录音；不是原始 WAV'
  }
};

const interval = 37800 / 44100;
const munch = (take, start = 0.005, length = 0.23) => ({ source: 'munch', begin: take * interval + start, end: take * interval + start + length });
export const BANKS = {
  dryBite: [munch(0), munch(1), munch(2)],
  dryChew: [munch(3, 0.06, 0.19), munch(4, 0.075, 0.19)],
  juicyBite: [{ source: 'apple', begin: 0.26, end: 0.51 }, { source: 'apple', begin: 2.09, end: 2.33 }, { source: 'apple', begin: 3.36, end: 3.60 }],
  juicyChew: [{ source: 'apple', begin: 5.09, end: 5.29 }, { source: 'apple', begin: 6.96, end: 7.16 }],
  softBite: [munch(4, 0.03, 0.23), munch(5, 0.025, 0.23), munch(6, 0.025, 0.23)],
  softChew: [munch(5, 0.10, 0.18), munch(6, 0.12, 0.18)],
  swallow: [{ source: 'swallow', begin: 0.045, end: 0.235 }, { source: 'quaff', begin: 0.19, end: 0.38 }]
};

const jobs = (base, bank, count, seconds, rms, hpf, lpf) => Array.from({ length: count }, (_, take) => ({
  id: base + ['', '_b', '_c'][take], seconds, rms,
  tone: { hpf, lpf }, layers: [{ bank, take, at: 0, speed: 1, gain: 1 }]
}));
export const JOBS = [
  ...jobs('eat_bite_dry', 'dryBite', 3, 0.23, 0.060, 180, 4300),
  ...jobs('eat_chew_dry', 'dryChew', 2, 0.19, 0.036, 140, 2600),
  ...jobs('eat_bite_juicy', 'juicyBite', 3, 0.23, 0.060, 140, 3800),
  ...jobs('eat_chew_juicy', 'juicyChew', 2, 0.19, 0.032, 160, 2200),
  ...jobs('eat_bite_soft', 'softBite', 3, 0.23, 0.050, 120, 1700),
  ...jobs('eat_chew_soft', 'softChew', 2, 0.18, 0.030, 120, 1500),
  ...jobs('eat_swallow', 'swallow', 2, 0.19, 0.030, 100, 1600)
];

export function layersFor(job) {
  return job.layers.map(item => ({ ...item, hpf: job.tone.hpf, lpf: job.tone.lpf }));
}
