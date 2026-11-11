/* 用桩化的 WebAudio 验证音效模块：所有音效名都能触发、不抛异常、voice 不泄漏 */
class Param {
  constructor(v = 0) { this.value = v; }
  setValueAtTime() { return this; } linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; } setTargetAtTime() { return this; }
  cancelScheduledValues() { return this; }
}
let created = 0, disconnected = 0, started = 0, stopped = 0;
class Node {
  constructor(type) { this.type = type; created++; this.gain = new Param(1); this.frequency = new Param(440); this.Q = new Param(1); this.detune = new Param(0); this.pan = new Param(0); this.playbackRate = new Param(1); this.delayTime = new Param(0); this.buffer = null; this.loop = false; this.onended = null; }
  connect(x) { return x; } disconnect() { disconnected++; }
  start() { started++; } stop() { stopped++; if (this.onended) setTimeout(() => this.onended({ target: this }), 0); }
}
class FakeCtx {
  constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = new Node('dest'); }
  createGain() { return new Node('gain'); }
  createOscillator() { return new Node('osc'); }
  createBufferSource() { return new Node('bufsrc'); }
  createBiquadFilter() { return new Node('filter'); }
  createStereoPanner() { return new Node('panner'); }
  createWaveShaper() { return new Node('shaper'); }
  createDelay(max) { const n = new Node('delay'); n._max = max || 1; return n; }
  createDynamicsCompressor() { const n = new Node('comp'); n.threshold = new Param(); n.knee = new Param(); n.ratio = new Param(); n.attack = new Param(); n.release = new Param(); return n; }
  createConvolver() { return new Node('conv'); }
  createBuffer(ch, len) { return { numberOfChannels: ch, length: len, sampleRate: 48000, duration: len / 48000, getChannelData: () => new Float32Array(len) }; }
  createPeriodicWave() { return {}; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
globalThis.AudioContext = FakeCtx;
globalThis.webkitAudioContext = FakeCtx;
if (!globalThis.window) globalThis.window = globalThis;

const mod = await import('../renderer/js/audio/sfx.js');
const { Sfx, SOUND_NAMES } = mod;
console.log('导出的音效名数量:', SOUND_NAMES.length);
console.log('导出符号:', Object.keys(mod).join(', '));

const sfx = new Sfx();
sfx.resume();
sfx.setMasterVolume(0.8);
sfx.setSfxVolume(0.9);
sfx.setMusicVolume(0.4);
let errs = [];
for (const n of SOUND_NAMES) {
  try { sfx.play(n, {}); } catch (e) { errs.push(n + ': ' + e.message); }
}
// 未知名字必须静默
try { sfx.play('不存在的音效'); } catch (e) { errs.push('unknown name threw: ' + e.message); }
// 变体与循环
for (const n of ['dig_stone', 'break_stone', 'step_grass']) {
  for (let i = 0; i < 30; i++) { sfx.play(n, { rate: 0.9 + i * 0.01 }); }
}
try { sfx.startMusic(); } catch (e) { errs.push('music: ' + e.message); }
if (typeof sfx.updateAmbient === 'function') { try { sfx.updateAmbient(0.5, false); sfx.updateAmbient(0.9, true); } catch (e) { errs.push('ambient: ' + e.message); } }
try { sfx.stopMusic(); } catch (e) { errs.push('stopMusic: ' + e.message); }

await new Promise(r => setTimeout(r, 60));
console.log('创建节点', created, '启动', started, '停止', stopped, '断开', disconnected);
console.log('错误:', errs.length ? errs.join('\n') : '（无）');
try { sfx.dispose(); } catch (e) { console.log('dispose 抛错: ' + e.message); }
console.log('SOUND_NAMES =', SOUND_NAMES.join(', '));
