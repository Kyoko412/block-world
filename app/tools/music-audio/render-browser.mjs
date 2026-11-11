import { s } from '@strudel/core';
import { samples, superdough, setAudioContext, setSuperdoughAudioController, initAudio } from 'superdough';
import { SuperdoughAudioController } from 'superdough/superdoughoutput.mjs';
import { SCORES, CUES } from './score.mjs';
import { SOURCES } from './recordings.mjs';
import { stereoWave } from '../ambient-audio/wave.mjs';
import { monoWave } from '../movement-audio/wave.mjs';
const SR=44100;
function base64(bytes){let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}
const decoder=new OfflineAudioContext(2,SR,SR), banks={};
for(const source of SOURCES){
  const response=await fetch('/raw/'+source.file);if(!response.ok)throw Error('Missing instrument '+source.file);
  const buffer=await decoder.decodeAudioData(await response.arrayBuffer());
  let peak=0;for(let ch=0;ch<buffer.numberOfChannels;ch++)for(const x of buffer.getChannelData(ch))peak=Math.max(peak,Math.abs(x));
  const left=buffer.getChannelData(0);let start=left.findIndex(x=>Math.abs(x)>peak*.003);start=Math.max(0,start-100);
  const end=Math.min(buffer.length,start+Math.round(SR*(source.bank==='piano'?7:5)));
  const channels=[0,1].map(ch=>buffer.getChannelData(Math.min(ch,buffer.numberOfChannels-1)).slice(start,end));
  let energy=0,top=0;const window=Math.min(channels[0].length,Math.round(SR*.8));
  for(const channel of channels){const mean=channel.reduce((a,b)=>a+b,0)/channel.length;for(let i=0;i<channel.length;i++){channel[i]-=mean;top=Math.max(top,Math.abs(channel[i]));if(i<window)energy+=channel[i]**2;}}
  const gain=Math.min(.12/Math.sqrt(energy/(window*2)),.78/top);
  for(const channel of channels)for(let i=0;i<channel.length;i++)channel[i]*=gain*Math.min(1,i/90,(channel.length-1-i)/(SR*.08));
  (banks[source.bank] ||= []).push({source,url:'data:audio/wav;base64,'+base64(stereoWave(channels))});
}
for(const bank of Object.values(banks))bank.sort((a,b)=>a.source.midi-b.source.midi);
await samples(Object.fromEntries(Object.entries(banks).map(([name,bank])=>[name,bank.map(x=>x.url)])));
const jobs=[...SCORES.map(score=>({...score,kind:'music'})),...CUES.map(cue=>({...cue,kind:'cue'}))];
let cursor=0;for(const job of jobs){job.offset=cursor;cursor+=job.seconds+4;}
let promise;
async function renderAll(){
  const ctx=new OfflineAudioContext(2,Math.ceil((cursor+2)*SR),SR);setAudioContext(ctx);setSuperdoughAudioController(new SuperdoughAudioController(ctx));
  await initAudio({disableWorklets:true,maxPolyphony:128});
  for(let j=0;j<jobs.length;j++)for(const event of jobs[j].events){
    const job=jobs[j],bank=banks[event.bank];let take=0;
    for(let i=1;i<bank.length;i++)if(Math.abs(bank[i].source.midi-event.midi)<Math.abs(bank[take].source.midi-event.midi))take=i;
    const speed=2**((event.midi-bank[take].source.midi)/12);
    const hpf=event.bank==='piano'?45:100,lpf=job.kind==='cue'?3400:job.id==='night'?3500:job.id==='cave'?3200:4600;
    const pattern=s(event.bank).n(take).speed(speed).gain(event.gain).pan(event.pan).hpf(hpf).lpf(lpf).attack(job.kind==='cue'?.003:.008).release(event.release);
    const hap=pattern.queryArc(0,1,{_cps:1}).find(h=>h.hasOnset());
    const value={...hap.value,orbit:j};
    await superdough(value,job.offset+.04+event.at,event.duration,1,0);
  }
  return ctx.startRendering();
}
window.renderMusicAsset=async id=>{
  const job=jobs.find(j=>j.id===id);promise ||= renderAll().catch(error=>{throw new Error(error?.stack||error?.message||String(error));});const rendered=await promise;
  const length=Math.round(job.seconds*SR),begin=Math.round((job.offset+.04)*SR);
  let channels=[0,1].map(ch=>rendered.getChannelData(ch).slice(begin,begin+length));
  if(job.kind==='cue'){const mono=channels[0].map((v,i)=>(v+channels[1][i])/2);channels=[mono];}
  let energy=0,peak=0;
  const fadeIn=SR*(job.kind==='music'?.025:.004),fadeOut=SR*(job.kind==='music'?1.4:.035);
  for(const channel of channels)for(let i=0;i<channel.length;i++){channel[i]*=Math.min(1,i/fadeIn,(channel.length-1-i)/fadeOut);energy+=channel[i]**2;peak=Math.max(peak,Math.abs(channel[i]));}
  if(peak<1e-5)throw Error('Strudel rendered silence: '+id);
  const gain=Math.min(job.rms/Math.sqrt(energy/(length*channels.length)),(job.kind==='music'?.42:.45)/peak);
  peak=0;energy=0;for(const channel of channels)for(let i=0;i<channel.length;i++){channel[i]*=gain;energy+=channel[i]**2;peak=Math.max(peak,Math.abs(channel[i]));}
  return {id,kind:job.kind,base64:base64(job.kind==='music'?stereoWave(channels):monoWave(channels[0])),seconds:length/SR,
    rms:Math.sqrt(energy/(length*channels.length)),peak,notes:job.events.length,channels:channels.length};
};
window.authorReady=true;
