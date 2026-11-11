import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {SCORES,CUES} from './score.mjs';
import {SOURCES,SAMPLE_REVISION} from './recordings.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),ROOT=path.resolve(HERE,'../../..');
if(!process.versions.electron){const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const child=spawn(path.join(ROOT,'app/node_modules/electron/dist/electron.exe'),[fileURLToPath(import.meta.url)],{env,stdio:'inherit',windowsHide:true});child.on('exit',code=>process.exit(code??1));
}else run();
async function run(){
  const {app,BrowserWindow}=await import('electron'),authorRoot=path.join(ROOT,'.tmp-audio/strudel-authoring'),sourceRoot=path.join(ROOT,'.tmp-audio/music-source');
  const require=createRequire(path.join(authorRoot,'package.json')),{build}=require('esbuild');let server,win;
  const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  try{
    for(const source of SOURCES){const file=path.join(sourceRoot,source.file);if(!fs.existsSync(file))throw Error('Run app/tools/music-audio/prepare-sources.ps1 first: '+source.file);if(sha(fs.readFileSync(file))!==source.sha256)throw Error('Sample SHA mismatch: '+source.file);}
    await build({entryPoints:[path.join(HERE,'render-browser.mjs')],bundle:true,format:'esm',platform:'browser',nodePaths:[path.join(authorRoot,'node_modules')],outfile:path.join(authorRoot,'music-bundle.js')});
    server=http.createServer((req,res)=>{const url=new URL(req.url,'http://localhost');let file;
      if(url.pathname==='/browser.js')file=path.join(authorRoot,'music-bundle.js');
      else if(url.pathname.startsWith('/raw/')){const name=url.pathname.slice(5);if(SOURCES.some(s=>s.file===name))file=path.join(sourceRoot,name);}
      else if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/browser.js"></script>');return;}
      if(!file){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'audio/wav');fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));await app.whenReady();
    win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    win.webContents.on('console-message',(_e,_level,message)=>console.log('[Strudel] '+message));
    await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
    for(let i=0;i<250&&!(await win.webContents.executeJavaScript('!!window.authorReady'));i++)await new Promise(r=>setTimeout(r,100));
    if(!(await win.webContents.executeJavaScript('!!window.authorReady')))throw Error('Strudel music authoring did not initialize');
    const tracks={},cues=[],report=[],scoreHash=sha(fs.readFileSync(path.join(HERE,'score.mjs')));
    for(const job of [...SCORES,...CUES]){
      const result=await win.webContents.executeJavaScript(`window.renderMusicAsset(${JSON.stringify(job.id)})`),bytes=Buffer.from(result.base64,'base64');
      const isMusic=result.kind==='music',file=(isMusic?'original_'+job.id:job.id)+'.wav',folder=path.join(ROOT,'app/renderer/media',isMusic?'music':'sfx');
      fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,file),bytes);
      const used=new Set(job.events.map(e=>e.bank)),sampleSources=SOURCES.filter(s=>used.has(s.bank)).map(s=>({file:s.path,midi:s.midi,sha256:s.sha256,url:s.url,licence:'CC0-1.0'}));
      const common={file,title:job.title,author:'本项目原创编曲',authorPage:'local://tools/music-audio/score.mjs',source:'local://tools/music-audio/score.mjs',
        licence:'CC0-1.0',licenceName:'Creative Commons Zero v1.0',attribution:'Original score produced with Strudel; VSCO 2 CE recordings: Versilian Studios / Sam Gossner; piano: Ivy Audio / Simon Dalzell (CC0)',
        bytes:bytes.length,sha256:sha(bytes),modified:true,modifiedNote:'Original Strudel score; pitched CC0 piano/harp/marimba multisamples, gentle filtering, original recorded resonance, musical dynamics, fades, RMS/peak calibrated; 44.1kHz 16bit PCM WAV',
        scoreSha256:scoreHash,sampleRevision:SAMPLE_REVISION,sampleSources,noteCount:result.notes,channels:result.channels};
      if(isMusic){const rounded=Math.round(result.seconds);tracks[job.id]={scene:job.id,...common,declaredDuration:Math.floor(rounded/60)+':'+String(rounded%60).padStart(2,'0'),formats:'WAV',loopsSeamlessly:false,
        measuredDuration:result.seconds,measuredRawRms:result.rms,trim:1,bpm:job.bpm,bars:job.bars,sections:job.sections};}
      else cues.push({id:job.id,...common,sourceFile:'score.mjs#'+job.id,seconds:result.seconds,fallback:job.id,usedFor:job.title});
      report.push({id:result.id,kind:result.kind,seconds:result.seconds,rms:result.rms,peak:result.peak,notes:result.notes});console.log('Rendered '+job.id);
    }
    const musicFile=path.join(ROOT,'app/renderer/js/core/musicfiles.js'),old=fs.readFileSync(musicFile,'utf8');
    let tail=old.slice(old.indexOf('export const FILE_TRACK_IDS'));
    tail=tail.replace("if (!/^https:\\/\\//.test(String(t.source)))", "if (!/^(https:\\/\\/|local:\\/\\/tools\\/)/.test(String(t.source)))");
    fs.writeFileSync(musicFile,`// Original Strudel compositions. Instrument sources and score hashes are recorded per track.
export const MUSIC_FILE_DIR = 'media/music';
export const LICENCE_ALLOWLIST = Object.freeze(['CC0-1.0']);
const TRACK_DATA = ${JSON.stringify(tracks,null,2)};
export const FILE_TRACKS = Object.freeze(Object.fromEntries(Object.entries(TRACK_DATA).map(([id,t])=>[id,Object.freeze(t)])));
${tail}`);
    fs.writeFileSync(path.join(ROOT,'app/renderer/js/core/notifyfiles.js'),`// Generated by the Strudel music/notification authoring tool.
const CLIPS = ${JSON.stringify(cues,null,2)};
export const NOTIFY_SFX_FILES = Object.freeze(Object.fromEntries(CLIPS.map(clip=>[clip.id,Object.freeze(clip)])));
`);
    const out=path.join(ROOT,'artifacts/music-audio');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'render-report.json'),JSON.stringify({generatedAt:new Date().toISOString(),clips:report},null,2));
    console.log('Rendered 3 original scores and 8 short cues');win.destroy();server.close();app.exit(0);
  }catch(error){console.error(error?.stack||error);win?.destroy();server?.close();app.exit(1);}
}
