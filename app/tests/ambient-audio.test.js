import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Sfx } from '../renderer/js/audio/sfx.js';
import { selectAmbient, ambientMix } from '../renderer/js/audio/music.js';
import { AMBIENT_FILES, AMBIENT_FILE_IDS, ambientFileUrl } from '../renderer/js/core/ambientfiles.js';

test('关背景音乐仍保留环境，环境开关和音效滑条才控制环境音量', () => {
  const sfx = new Sfx();
  sfx._musicWanted = false;
  sfx._envWanted = true;
  sfx._vols.sfx = 0.8;
  assert.ok(sfx._ambientTarget() > 0.1, '音乐关闭不能使环境静音');
  sfx._envWanted = false;
  assert.equal(sfx._ambientTarget(), 0.0001);
  sfx._envWanted = true; sfx._vols.sfx = 0;
  assert.equal(sfx._ambientTarget(), 0.0001);
});

test('环境随实际位置和天气切换：水下、洞穴优先；雪不播放雨', () => {
  assert.equal(selectAmbient({ underwater: true, underground: true, weather: 'rain', intensity: 1 }), 'underwater');
  assert.equal(selectAmbient({ underground: true, weather: 'rain', intensity: 1 }), 'cave');
  assert.equal(selectAmbient({ weather: 'snow', intensity: 1, night: false }), 'wind');
  assert.equal(selectAmbient({ weather: 'rain', intensity: 1, sheltered: true }), 'rain', '屋内应听到经遮蔽的远雨');
  assert.equal(selectAmbient({ night: true }), 'insects');
  assert.equal(selectAmbient({}), 'wind');
});

test('五种真实环境录音均随包：许可、原录音、立体声、时长和指纹正确', () => {
  assert.deepEqual(AMBIENT_FILE_IDS.slice().sort(), ['cave', 'insects', 'rain', 'underwater', 'wind']);
  for (const entry of Object.values(AMBIENT_FILES)) {
    const bytes = fs.readFileSync(new URL('../renderer/media/ambient/' + entry.file, import.meta.url));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    assert.equal(entry.licence, 'CC0-1.0');
    assert.equal(ambientFileUrl(entry.id), '/media/ambient/' + entry.file);
    assert.equal(bytes.readUInt16LE(22), 2);
    assert.equal(bytes.readUInt32LE(24), 44100);
    assert.equal((bytes.length - 44) / 4 / 44100, entry.seconds);
    for (const recording of [entry, ...entry.extraSources]) {
      assert.match(recording.source, /^https:\/\/freesound\.org\//);
      assert.match(recording.recordingSha256, /^[0-9a-f]{64}$/);
      assert.ok(recording.sourceRange[1] > recording.sourceRange[0]);
    }
  }
});

test('屋内保留远雨且更闷更轻，雨势和雪天有实际混音区别', () => {
  const outside = ambientMix({ weather: 'rain', intensity: 1 });
  const inside = ambientMix({ weather: 'rain', intensity: 1, sheltered: true });
  assert.ok(inside.gain < outside.gain && inside.lowpass < outside.lowpass);
  assert.ok(ambientMix({ weather: 'rain', intensity: 0.2 }).gain < outside.gain);
  assert.ok(ambientMix({ weather: 'snow', intensity: 1 }).gain < ambientMix({}).gain);
});

function audioFixture() {
  const parameter = () => ({ value: 1, setValueAtTime(value) { this.value = value; },
    linearRampToValueAtTime(value) { this.value = value; }, exponentialRampToValueAtTime(value) { this.value = value; },
    setTargetAtTime(value) { this.value = value; }, cancelScheduledValues() {} });
  const node = () => ({ gain: parameter(), frequency: parameter(), Q: parameter(), connect() {}, disconnect() {} });
  const sources = [];
  const sfx = new Sfx(); sfx._envWanted = true; sfx._musicWanted = false;
  sfx.ctx = { currentTime: 0, state: 'running', createGain: node, createBiquadFilter: node,
    createBufferSource() { const source = { ...node(), stopped: false, start() {}, stop() { this.stopped = true; } }; sources.push(source); return source; } };
  sfx.sfxBus = node(); sfx.ambientBus = node(); sfx.toneFilter = node();
  for (const id of AMBIENT_FILE_IDS) sfx._ambientBuffers.set(id, { duration: AMBIENT_FILES[id].seconds });
  return { sfx, sources };
}

test('重复更新不重启录音，快速切换最多一条当前和一条淡出；暂停释放声源', async () => {
  const { sfx, sources } = audioFixture();
  sfx.updateAmbient({});
  for (let i = 0; i < 20; i++) sfx.updateAmbient({});
  assert.equal(sources.length, 1, '逐帧更新不能重叠启动同一录音');
  assert.equal(sfx._ambient.source, 'file');
  sfx.stopMusic(0.05);
  assert.equal(sources.filter(source => !source.stopped).length, 1, '停止主曲不能顺带停环境');
  for (const state of [{ night: true }, { weather: 'rain', intensity: 1 }, { underground: true }, { underwater: true }]) {
    sfx.updateAmbient(state);
    assert.ok(sources.filter(source => !source.stopped).length <= 2);
    assert.ok(sfx._ambientFading.size <= 1);
  }
  sfx.stopAmbient(0.05);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(sources.filter(source => !source.stopped).length, 0);
  assert.equal(sfx._ambientFading.size, 0);
  assert.equal(sfx._ambient, null);
});

test('暂停后迟到的录音解码不能重新开声', () => {
  const { sfx, sources } = audioFixture();
  sfx.updateAmbient({}); const old = sfx._ambient;
  sfx.setAmbientEnabled(false);
  sfx._attachAmbientBuffer(old);
  assert.equal(sources.length, 1);
  // 立刻结束此测试的淡出，不把计时器留到其他检查之后。
  sfx.stopAmbient(0.05);
});
