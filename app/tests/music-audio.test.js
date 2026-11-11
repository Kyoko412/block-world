import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Sfx } from '../renderer/js/audio/sfx.js';
import { SCORES, CUES } from '../tools/music-audio/score.mjs';
import { FILE_TRACKS } from '../renderer/js/core/musicfiles.js';
import { NOTIFY_SFX_FILES } from '../renderer/js/core/notifyfiles.js';
import { sfxFileFor } from '../renderer/js/core/sfxfiles.js';
import { SOUND_NAMES, SOUND_DEF_NAMES } from '../renderer/js/audio/sfx.js';
import { dutyCycle } from '../renderer/js/core/musictiming.js';
const param=()=>({value:1,setValueAtTime(v){this.value=v;},linearRampToValueAtTime(v){this.value=v;},exponentialRampToValueAtTime(v){this.value=v;},setTargetAtTime(v){this.value=v;},cancelScheduledValues(){}});
function fixture(){const starts=[],node=()=>({gain:param(),connect(){},disconnect(){}}),s=new Sfx();
  s.ctx={currentTime:100,state:'running',createGain:node,createBufferSource(){return{connect(){},disconnect(){},stop(){},start(when){starts.push(when);}}}};
  s.sfxBus=node();s.musicBus=node();s._musicWanted=true;s._dayT=.25;s._vols.music=.5;s._fileBufs.set('day',{duration:80});
  return{s,starts};
}
test('配乐音量只乘一次：单曲包络与总线组合保持滑条的线性关系',()=>{const{s}=fixture();try{s._switchMusic('day',2);s.setMusicVolume(.5);
  assert.ok(Math.abs(s._music.bus.gain.value*s.musicBus.gain.value-s._musicTarget())<1e-9,'不能把音乐目标增益平方');}finally{s.dispose();}});
test('首次留白期间换入曲目，不得把出场时点提前',()=>{const{s,starts}=fixture();try{s._leadInPending=true;s._switchMusic('day',2);const first=starts.at(-1);s.ctx.currentTime+=1;s._switchMusic('day',2);
  assert.ok(starts.at(-1)>=first-.01,'解码完成的换源不能跳过入场留白');}finally{s.dispose();}});

test('三首 Strudel 原创配乐都有完整段落、许可来源与准确的立体声 WAV',()=>{
  const scoreHash=crypto.createHash('sha256').update(fs.readFileSync(new URL('../tools/music-audio/score.mjs',import.meta.url))).digest('hex');
  assert.equal(SCORES.length,3);
  for(const score of SCORES){const entry=FILE_TRACKS[score.id];
    assert.ok(score.sections.length>=3 && score.events.length>=50);
    assert.ok(score.seconds>=70 && score.seconds<=100);
    assert.ok(dutyCycle(score.seconds)<.5,'音乐应给环境声留出更多时间');
    assert.equal(entry.scoreSha256,scoreHash);
    const bytes=fs.readFileSync(new URL('../renderer/media/music/'+entry.file,import.meta.url));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);
    assert.equal(bytes.readUInt16LE(22),2);assert.equal(bytes.readUInt32LE(24),44100);
    assert.ok(Math.abs((bytes.length-44)/4/44100-score.seconds)<1/44100);
    assert.ok(entry.sampleSources.every(s=>s.licence==='CC0-1.0'&&/^[0-9a-f]{64}$/.test(s.sha256)));
    assert.ok(score.events.every(e=>e.at>=0&&e.at+e.duration<score.seconds&&e.midi>=30&&e.midi<=84));
  }
});
test('八个短提示音接入既有入口，指纹一致且起止无硬切',()=>{
  assert.equal(CUES.length,8);
  for(const cue of CUES){const entry=NOTIFY_SFX_FILES[cue.id];assert.equal(sfxFileFor(cue.id),entry);
    assert.ok(SOUND_NAMES.includes(cue.id)&&SOUND_DEF_NAMES.includes(cue.id));
    const bytes=fs.readFileSync(new URL('../renderer/media/sfx/'+entry.file,import.meta.url));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),entry.sha256);
    assert.equal(bytes.readInt16LE(44),0);assert.equal(bytes.readInt16LE(bytes.length-2),0);
    assert.ok(entry.seconds<=1 && entry.channels===1);
  }
});
