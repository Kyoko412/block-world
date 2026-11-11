/* 原创探索配乐与提示音。音符、呼吸、力度和段落都在此定义，Strudel 离线演奏。 */
const CHORDS = {
  C: [36, [52, 57, 60]], Am: [45, [52, 55, 60]], F: [41, [53, 57, 64]],
  G: [43, [50, 59, 62]], Dm: [38, [53, 57, 60]], Em: [40, [55, 59, 62]],
  Gs: [43, [50, 57, 62]], Ce: [40, [52, 55, 60]],
  Gn: [43, [50, 55, 59]], Cn: [36, [52, 55, 59]], Dn: [38, [50, 57, 64]],
  An: [45, [52, 55, 60]], Fn: [41, [53, 60, 64]]
};
const note = (bank, midi, at, duration, gain, pan = 0.5, release = 0.8) => ({ bank, midi, at, duration, gain, pan, release });
const dayMelody = [
  [[.5,64,1],[1.75,67,.7],[2.75,69,.9]], [[.75,67,1],[2.25,62,1.2]],
  [[.25,64,.8],[1.5,67,.7],[2.5,72,1.1]], [[.75,69,.7],[2,67,1.4]],
  [[.5,64,.8],[1.75,62,.8],[3,60,.7]], [[.5,62,1],[2.25,67,1.3]],
  [[.5,67,.7],[1.5,64,.9],[2.75,62,.9]], [[1,64,.7],[2.25,62,1.4]],
  [[.5,64,1.2],[2.5,67,1]], [[1,69,.9],[2.5,72,1]],
  [[.25,71,.7],[1.5,67,1.2],[3,64,.7]], [[1,62,1.5]],
  [[.5,65,.8],[1.75,69,1.1]], [[.75,67,1],[2.5,64,.8]],
  [[.5,62,.8],[2,67,1.3]], [[.75,69,.7],[2,67,1.4]],
  [[.5,64,1],[1.75,67,.7],[2.75,69,.9]], [[.75,67,1],[2.25,62,1.2]],
  [[.25,64,.8],[1.5,67,.7],[2.5,72,1.1]], [[.75,69,.7],[2,67,1.4]],
  [[.5,65,.7],[1.75,64,.8],[3,62,.7]], [[.5,62,1],[2.25,67,1.3]],
  [[.75,64,1],[2.25,62,1]], [[.5,60,2.7]]
];
const dayHarmony = ['C','C','Am','F','Ce','G','F','Gs','Am','F','C','G','Dm','F','Gs','G','C','Em','Am','F','Dm','G','C','C'];
const nightPhrase = [
  [[.7,67,1.1],[2.5,71,1]], [[1.5,69,1.4]], [[.6,74,1.8]], [[1.5,71,.9],[3,67,.8]],
  [[.7,64,1],[2.4,67,1]], [[1.5,71,1.5]], [[.6,69,1],[2.6,66,.9]], [[1.3,62,1.8]]
];
function day() {
  const bpm = 76, beat = 60 / bpm, events = [], intro = 1;
  for (let bar = 0; bar < 24; bar++) {
    const base = intro + bar * 4 * beat, [bass, voicing] = CHORDS[dayHarmony[bar]];
    const dynamic = bar < 8 ? .9 : bar < 16 ? .8 : .95;
    voicing.forEach((midi, i) => events.push(note('piano', midi, base + i * .043, 1.65 * beat, .065 * dynamic, [.33,.52,.67][i], 1)));
    if (bar % 2 === 0) events.push(note('piano', bass, base + .015, 2.2 * beat, .055 * dynamic, .5, 1.1));
    dayMelody[bar].forEach(([b, midi, d], i) => events.push(note('piano', midi, base + b * beat + [0,.018,-.012][i % 3], d * beat,
      (.16 - i * .014) * dynamic, .52, .95)));
    if (bar % 4 === 3 && bar < 22) {
      const pitch = [72,69,67,74,72][Math.floor(bar / 4)];
      events.push(note('harp', pitch, base + 2.75 * beat, .7 * beat, .055, .38, 1.1));
    }
  }
  events.push(note('wood', 67, intro + 8 * 4 * beat + .14, .55, .025, .63, .6));
  return { id:'day', title:'林径初光', bpm, bars:24, tail:4, seconds:intro+24*4*beat+4, rms:.052,
    sections:['轻声开篇','旋律应答','主题回归与收束'], events };
}
function night() {
  const bpm = 64, beat = 60 / bpm, events = [], intro = 1.2;
  const harmony = ['Gn','Em','Cn','Dn','Gn','Em','Cn','Dn'];
  for (let bar = 0; bar < 24; bar++) {
    const base = intro + bar * 4 * beat, chord = bar === 23 ? 'Gn' : harmony[bar % 8];
    const [bass, allNotes] = CHORDS[chord], middle = bar >= 8 && bar < 16;
    const voicing = middle ? allNotes.slice(1) : allNotes;
    voicing.forEach((midi, i) => events.push(note('piano', midi, base + .09 * i, 2.15 * beat, .048, .35 + i * .14, 1.3)));
    if (bar % 8 === 0) events.push(note('piano', bass, base + .04, 3 * beat, .034, .5, 1.2));
    const phrase = bar === 23 ? [[.8,67,2.4]] : nightPhrase[bar % 8];
    phrase.forEach(([b,midi,d],i) => {
      if (middle && bar % 3 === 1) midi -= 12;
      events.push(note(middle ? 'harp' : 'piano', midi, base + b * beat + i * .02, d * beat, middle ? .095 : .125, .52, 1.35));
    });
    if (bar === 3 || bar === 19) events.push(note('harp', 74, base + 2.2 * beat, .8, .035, .36, 1.5));
  }
  return { id:'night', title:'星下归途', bpm, bars:24, tail:5, seconds:intro+24*4*beat+5, rms:.039,
    sections:['缓慢的星光主题','竖琴留白','钢琴归来与安静终止'], events };
}
function cave() {
  const bpm = 60, beat = 1, intro = 1.5, events = [], harmony=['C','An','Fn','Gs','Dm','C','Fn','Gs','Am','C'];
  for (let pair = 0; pair < 10; pair++) {
    const base = intro + pair * 8, [bass, voicing] = CHORDS[harmony[pair]];
    voicing.forEach((midi, i) => events.push(note('piano', midi, base + i * .43, 2.4, .048, .3 + i * .2, 1.5)));
    if (pair % 3 === 0) events.push(note('harp', Math.max(48,bass+12), base + 2.1, 1.1, .040, .5, 1.5));
    const phrase = pair < 4 ? [60,62,67] : pair < 7 ? [64,67,69] : [67,64,60];
    events.push(note('harp', phrase[0], base + 3.15, 1.05, .11, .42, 1.6));
    if (pair % 2 === 0) events.push(note('piano', phrase[1], base + 5.35, .85, .08, .57, 1.5));
    events.push(note('harp', phrase[2], base + 6.4, pair===9 ? 2 : .95, pair===9 ? .085 : .095, .5, 1.7));
  }
  return { id:'cave', title:'石间微光', bpm, bars:20, tail:5, seconds:intro+80+5, rms:.036,
    sections:['稀疏的问句','向上的回应','回到明亮主音'], events };
}
export const SCORES = [day(),night(),cave()].map(score => ({...score,events:score.events.sort((a,b)=>a.at-b.at)}));

const cue = (id, title, seconds, rms, notes) => ({ id,title,seconds,rms,events:notes.map(([bank,midi,at,duration,gain])=>note(bank,midi,at,duration,gain,.5,.08)) });
export const CUES = [
  cue('click','轻木点按',.08,.035,[['wood',72,0,.025,.35]]),
  cue('open_ui','轻启',.20,.036,[['wood',60,0,.05,.32],['wood',64,.075,.055,.22]]),
  cue('close_ui','轻收',.18,.032,[['wood',62,0,.045,.28],['wood',57,.07,.05,.20]]),
  cue('pickup','拾取轻响',.23,.044,[['harp',76,0,.11,.32]]),
  cue('craft','制作完成',.34,.048,[['wood',60,0,.09,.30],['wood',67,.13,.10,.25]]),
  cue('levelup','成就与进展',.68,.052,[['harp',64,0,.16,.28],['wood',67,.15,.14,.22],['harp',72,.31,.22,.28]]),
  cue('guardian_awaken','守卫苏醒提醒',.72,.072,[['wood',48,0,.15,.36],['piano',55,.20,.18,.30],['wood',51,.40,.20,.30]]),
  cue('guardian_reward','守卫完成回响',.94,.061,[['harp',60,0,.17,.28],['wood',64,.17,.13,.20],['harp',67,.34,.16,.26],['harp',72,.52,.24,.28]])
];
