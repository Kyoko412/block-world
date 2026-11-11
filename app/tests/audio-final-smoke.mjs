/* 正式 EXE 的直接音频检查；临时试听存档与设置在退出后恢复，不走通关/寻路。 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createAmbientPreviews} from '../tools/ambient-audio/preview.mjs';
import {CUES} from '../tools/music-audio/score.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url)),PACK=path.join(ROOT,'游戏/方块世界'),OUT=path.join(ROOT,'artifacts/audio-final'),SAVES=path.join(PACK,'saves');
fs.mkdirSync(OUT,{recursive:true});
const preserved=new Map(fs.readdirSync(SAVES).filter(name=>fs.statSync(path.join(SAVES,name)).isFile()).map(name=>[name,fs.readFileSync(path.join(SAVES,name))]));
const fixtures=createAmbientPreviews().filter(p=>p.name.includes('白天林地')||p.name.includes('洞穴')).map((p,i)=>{
  p.name='__音频整合检查-'+i;p.data.meta.name=p.name;fs.writeFileSync(path.join(SAVES,p.name+'.json'),JSON.stringify(p.data));return p;
});
const delay=ms=>new Promise(r=>setTimeout(r,ms)),probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;await new Promise(r=>probe.close(r));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
const child=spawn(path.join(PACK,'方块世界.exe'),[`--remote-debugging-port=${port}`,'--autoplay-policy=no-user-gesture-required','--mute-audio','--disable-background-timer-throttling','--disable-renderer-backgrounding'],{cwd:PACK,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
const exited=new Promise(r=>child.once('exit',r));let socket,sequence=0,log='';const pending=new Map(),report={music:[],cues:[]};
child.stdout.on('data',b=>{log+=b});child.stderr.on('data',b=>{log+=b});
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
async function evaluate(body){const r=await command('Runtime.evaluate',{expression:`(async()=>{${body}})()`,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
async function energy(){return evaluate(`const S=__game.sfx;S.busEnergy();await new Promise(r=>setTimeout(r,100));let music=0,ambient=0,sfx=0;for(let i=0;i<10;i++){const e=S.busEnergy();music=Math.max(music,e.music.rms);ambient=Math.max(ambient,e.ambient.rms);sfx=Math.max(sfx,e.sfx.rms);await new Promise(r=>setTimeout(r,70));}const info=S.musicInfo();return{music,ambient,sfx,info:{trackId:info.trackId,source:info.source,fileName:info.fileName,phase:info.cycle?.phase,active:info.activeMusicCount,fading:info.fadingCount,busGain:info.busGainTotal,lead:info.cycle?.leadInSeconds},env:S.ambientFilesInfo()};`);}
async function waitFile(id){for(let i=0;i<100;i++){if(await evaluate(`return __game.sfx.musicInfo().trackId===${JSON.stringify(id)}&&__game.sfx.musicInfo().source==='file';`))return;await delay(100);}throw Error(id+' 没有换入完整原创配乐');}
try{
  let page;for(let i=0;i<80&&!page;i++){if(child.exitCode!==null)throw Error('正式程序提前退出');try{page=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.type==='page');}catch{}if(!page)await delay(100);}
  socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
  socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}};
  for(let i=0;i<80&&!(await evaluate('return !!window.__game;'));i++)await delay(100);
  // 设置仅用于此隔离检查，退出后恢复；正式包不覆盖原用户偏好。
  await evaluate('await __game.applySettingsLive({music:true,volumeMaster:.7,volumeMusic:.45,volumeSfx:.8});return true;');
  await evaluate(`await __game.loadWorld(${JSON.stringify(fixtures[0].name)});return true;`);await waitFile('day');
  report.entry=await evaluate('const S=__game.sfx,m=S._music;return {remaining:m.nextStart-m.loopSeconds-S.ctx.currentTime,lead:m.leadInSeconds,source:m.source};');
  if(report.entry.lead<=0||report.entry.remaining<1)throw Error('曲目换源跳过了首次留白');
  report.quiet=await energy();if(report.quiet.music>1e-5)throw Error('入场留白期间提前播放音乐');
  for(let i=0;i<80;i++){if(await evaluate('return __game.sfx.sfxFilesInfo().files.filter(f=>'+JSON.stringify(CUES.map(c=>c.id))+'.includes(f.id)).every(f=>f.state==="ready");'))break;await delay(100);}
  for(const cue of CUES){
    const result=await evaluate(`const S=__game.sfx;const before=S.stats().played;S.play(${JSON.stringify(cue.id)},{volume:.5});const after=S.stats();return {id:${JSON.stringify(cue.id)},played:after.played>before,source:after.last?.source};`);
    report.cues.push(result);if(!result.played||result.source!=='file')throw Error('提示音未实际走 Strudel 文件：'+cue.id);await delay(Math.ceil(cue.seconds*1000)+70);
  }
  const remaining=await evaluate('const S=__game.sfx,m=S._music;return Math.max(0,m.nextStart-m.loopSeconds-S.ctx.currentTime);');
  await delay(Math.ceil((remaining+4)*1000));const day=await energy();report.music.push({scene:'day',...day});
  if(day.info.source!=='file'||day.info.trackId!=='day'||day.music<=1e-5)throw Error('白天原创曲没有实际输出');
  await evaluate('__game.time=.75;__game.updateAudioScene();return true;');await waitFile('night');await delay(2400);const night=await energy();report.music.push({scene:'night',...night});
  if(night.info.source!=='file'||night.info.trackId!=='night'||night.music<=1e-5||night.info.active!==1)throw Error('夜晚原创曲或主曲数量不正确');
  await evaluate(`await __game.loadWorld(${JSON.stringify(fixtures[1].name)});return true;`);await waitFile('cave');await delay(2900);const cave=await energy();report.music.push({scene:'cave',...cave});
  if(cave.info.source!=='file'||cave.info.trackId!=='cave'||cave.music<=1e-5||cave.env.active!=='cave')throw Error('洞穴原创曲/环境未实际输出');
  // 音乐静音保留环境，再打开；停止/恢复与释放只核对直接音频行为。
  await evaluate('await __game.applySettingsLive({music:false});return true;');await delay(1300);report.musicOff=await energy();
  if(report.musicOff.music>1e-5||report.musicOff.ambient<=1e-6)throw Error('音乐开关与环境串联或主曲未释放');
  await evaluate('await __game.applySettingsLive({music:true});return true;');await waitFile('cave');await delay(2500);report.restored=await energy();
  if(report.restored.music<=1e-5)throw Error('重新打开音乐没有恢复原创文件');
  await evaluate('__game.pause();return true;');await delay(1800);report.paused=await energy();
  if(report.paused.music>1e-5||report.paused.ambient>1e-5)throw Error('暂停后音乐或环境仍持续播放');
  await evaluate('__game.resume();return true;');await waitFile('cave');await delay(2600);report.resumed=await energy();
  if(report.resumed.music<=1e-5||report.resumed.info.active!==1)throw Error('恢复后未回到唯一主曲');
  const shot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,'正式包音频检查.png'),Buffer.from(shot.data,'base64'));
  await evaluate('__game.disposeWorld();__game.state="menu";return true;');await delay(1500);report.exit=await energy();
  if(report.exit.music>1e-5||report.exit.ambient>1e-5)throw Error('退出世界没有释放声音');
  report.passed=true;fs.writeFileSync(path.join(OUT,'audio-final-smoke.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:true,music:report.music.map(x=>({scene:x.scene,file:x.info.fileName,rms:x.music})),cues:report.cues.length,leadPreserved:report.entry.lead,environmentIndependent:true,pauseAndExitReleased:true},null,2));
  socket.send(JSON.stringify({id:++sequence,method:'Browser.close'}));
}catch(error){report.error=String(error.stack||error);fs.writeFileSync(path.join(OUT,'audio-final-smoke.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(OUT,'startup.log'),log);console.error(error.stack||error);process.exitCode=1;}
finally{socket?.close();if(child.exitCode===null)child.kill();await exited;
  for(const fixture of fixtures){const name=fixture.name+'.json';if(!preserved.has(name)&&fs.existsSync(path.join(SAVES,name)))fs.unlinkSync(path.join(SAVES,name));}
  for(const[name,bytes]of preserved)fs.writeFileSync(path.join(SAVES,name),bytes);
  if(!preserved.has('settings.json')&&fs.existsSync(path.join(SAVES,'settings.json')))fs.unlinkSync(path.join(SAVES,'settings.json'));
}
