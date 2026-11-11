/* 自然环境录音：长留白、低力度、真实声场。Strudel 只用于离线制作。 */
const recording = (author, id, file, preview, sha256, byteLimit) => ({
  author, authorPage: `https://freesound.org/people/${author}/`,
  source: `https://freesound.org/people/${author}/sounds/${id}/`, file, download: preview, sha256, byteLimit,
  note: `真实野外录音的公开 HQ MP3 试听${byteLimit ? `，仅取开头 ${byteLimit} 字节` : ''}；不是原始 WAV`
});
export const SOURCES = {
  wind: recording('kvgarlic', 781681, 'wind-hq.mp3', 'https://cdn.freesound.org/previews/781/781681_1050391-hq.mp3', '70267180cbcf935b34f157b1d738586b89cf75c34bcb152db2d1ec13f44e6465', 1048576),
  night: recording('kvgarlic', 810306, 'night-hq.mp3', 'https://cdn.freesound.org/previews/810/810306_1050391-hq.mp3', '379586d76300f543f5d0049ca08a32de45d1459be9acfaa40936ea75ff8127b1', 1048576),
  rain: recording('kvgarlic', 136540, 'rain-hq.mp3', 'https://cdn.freesound.org/previews/136/136540_1050391-hq.mp3', 'd914b573fbe1c7a7849272bd360f5b8fdcf18326c3fa456aa072f46123468de8', 1048576),
  cave: recording('mentos987', 818888, 'cave-hq.mp3', 'https://cdn.freesound.org/previews/818/818888_15684938-hq.mp3', '32c870200a863234c0c5732a4b48b119337144eb7b0b8dc3b045646323c1d904'),
  birds: recording('naturenotesuk', 418425, 'birds-hq.mp3', 'https://cdn.freesound.org/previews/418/418425_7455632-hq.mp3', '89aa04563c24eea80757863a57ab0d7da37cd4d0bae1bf0b55dbe0f28f0156da'),
  water: recording('felix.blume', 384218, 'water-hq.mp3', 'https://cdn.freesound.org/previews/384/384218_1661766-hq.mp3', 'c1b4844606b066de8b5d2f28e733381ec01f75bd58c0595f157067aeba7f77cf', 262144)
};
const layer = (source, begin, end, at = 0, rms = 0.05) => ({ source, begin, end, at, rms });
export const JOBS = [
  { id: 'wind', title: '林地轻风与稀疏鸟鸣', seconds: 32, rms: 0.046, tone: { hpf: 100, lpf: 6400 }, layers: [
    layer('wind', 1, 35), layer('birds', 0.6, 2.35, 4.5, 0.020), layer('birds', 5.6, 8.4, 21.5, 0.018)] },
  { id: 'insects', title: '夜间虫鸣与自然停顿', seconds: 32, rms: 0.032, tone: { hpf: 160, lpf: 5400 }, layers: [layer('night', 2, 36)] },
  { id: 'rain', title: '柔和的秋雨', seconds: 32, rms: 0.064, tone: { hpf: 130, lpf: 6200 }, layers: [layer('rain', 3, 37)] },
  { id: 'cave', title: '洞穴空气与实录滴水', seconds: 24, rms: 0.022, tone: { hpf: 90, lpf: 4800 }, layers: [layer('cave', 1, 27)] },
  { id: 'underwater', title: '水下流动与远处气泡', seconds: 8, rms: 0.032, tone: { hpf: 80, lpf: 750 }, layers: [layer('water', 0.65, 10.65)] }
];
export const LOOP_CROSSFADE = 2;
