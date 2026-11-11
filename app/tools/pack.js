/*
 * 打包脚本：把 Electron 运行时 + 游戏源码组装成免安装的可运行目录。
 *   node tools/pack.js
 * 产物：E:\\MinecraftOffline\\游戏\\方块世界\\方块世界.exe（双击即可玩，完全离线）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMovementPreview, createListeningClips, PREVIEW_NAME } from './movement-audio/preview.mjs';
import { createDigPreview, createInteractionClips, PREVIEW_NAME as DIG_PREVIEW_NAME } from './interaction-audio/preview.mjs';
import { createCombatPreview, createCombatClips, PREVIEW_NAME as COMBAT_PREVIEW_NAME } from './combat-audio/preview.mjs';
import { createEatPreview, createEatClips, PREVIEW_NAME as EAT_PREVIEW_NAME } from './eat-audio/preview.mjs';
import { createAmbientPreviews, createAmbientClips } from './ambient-audio/preview.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');                 // app/
const OUT_ROOT = path.join(ROOT, '..', '游戏');           // 交付目录
const APP_NAME = '方块世界';
const MOVEMENT_PREVIEW = process.argv.includes('--movement-audio');
const INTERACTION_PREVIEW = process.argv.includes('--interaction-audio');
const COMBAT_PREVIEW = process.argv.includes('--combat-audio');
const EAT_PREVIEW = process.argv.includes('--eat-audio');
const AMBIENT_PREVIEW = process.argv.includes('--ambient-audio');
const DEST = path.join(OUT_ROOT, MOVEMENT_PREVIEW ? APP_NAME + '-移动音效' : INTERACTION_PREVIEW ? APP_NAME + '-挖放音效' : COMBAT_PREVIEW ? APP_NAME + '-战斗音效' : EAT_PREVIEW ? APP_NAME + '-进食音效' : AMBIENT_PREVIEW ? APP_NAME + '-环境声' : APP_NAME);
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function log(m) { process.stdout.write(m + '\n'); }

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name), d = path.join(dst, name);
    const st = fs.statSync(s);
    if (filter && !filter(name, st)) continue;
    if (st.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

function dirSize(p) {
  let total = 0;
  for (const name of fs.readdirSync(p)) {
    const s = path.join(p, name), st = fs.statSync(s);
    total += st.isDirectory() ? dirSize(s) : st.size;
  }
  return total;
}

if (!fs.existsSync(ELECTRON_DIST)) { console.error('未找到 Electron 运行时，请先 npm install'); process.exit(1); }

log('清理输出目录…');
/* 本轮：打包不许清掉玩家存档（任务书「普通玩家 saves 不清空」）。
   旧写法直接 rm -rf 整个交付目录，只是这台机器上 saves/ 恰好是空的才没出事。
   现在有内容就先备份到 artifacts/.pack-saves-backup-<stamp>，复制完源码再原样放回。 */
const SAVES_DIR = path.join(DEST, 'saves');
let savesBackup = null;
if (fs.existsSync(SAVES_DIR)) {
  let n = 0;
  try { n = fs.readdirSync(SAVES_DIR).length; } catch (e) { n = 0; }
  if (n > 0) {
    savesBackup = path.join(ROOT, '..', 'artifacts', '.pack-saves-backup-' + Date.now());
    copyDir(SAVES_DIR, savesBackup);
    log('玩家存档先备份：' + n + ' 项 → ' + savesBackup);
  }
}
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

log('复制 Electron 运行时…');
copyDir(ELECTRON_DIST, DEST, (name) => name !== 'default_app.asar');

log('重命名主程序…');
const exeFrom = path.join(DEST, 'electron.exe');
const exeTo = path.join(DEST, APP_NAME + '.exe');
if (fs.existsSync(exeTo)) fs.rmSync(exeTo);
fs.renameSync(exeFrom, exeTo);

log('复制游戏源码与资源…');
const APPDIR = path.join(DEST, 'resources', 'app');
fs.mkdirSync(APPDIR, { recursive: true });
copyDir(path.join(ROOT, 'renderer'), path.join(APPDIR, 'renderer'));
for (const f of ['main.js', 'server.js', 'package.json']) {
  fs.copyFileSync(path.join(ROOT, f), path.join(APPDIR, f));
}
if (MOVEMENT_PREVIEW || INTERACTION_PREVIEW || COMBAT_PREVIEW || EAT_PREVIEW || AMBIENT_PREVIEW) {
  const packageFile = path.join(APPDIR, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  metadata.name += MOVEMENT_PREVIEW ? '-movement-audio' : INTERACTION_PREVIEW ? '-interaction-audio' : COMBAT_PREVIEW ? '-combat-audio' : EAT_PREVIEW ? '-eat-audio' : '-ambient-audio';
  fs.writeFileSync(packageFile, JSON.stringify(metadata, null, 2));
}
fs.mkdirSync(path.join(APPDIR, 'selftest'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'tests', 'e2e-scenario.js'), path.join(APPDIR, 'selftest', 'e2e-scenario.js'));
/* 阶段 5：守卫的独立验收剧本随包。成品用 `--selftest-guardian` 触发同一份剧本，
   与主线 `--selftest` 共用 EXE、各自报告与退出码。 */
fs.copyFileSync(path.join(ROOT, 'tests', 'guardian-scenario.js'), path.join(APPDIR, 'selftest', 'guardian-scenario.js'));
/* 阶段 7：正常生存路线取证剧本随包。成品用 `--selftest-route` 触发同一套 runSelfTest，
   与主线/守卫共用 EXE、各自报告与独立验收存档目录。 */
fs.copyFileSync(path.join(ROOT, 'tests', 'survival-route.js'), path.join(APPDIR, 'selftest', 'survival-route.js'));
/* 第二轮 E：自然生存路线剧本随包（`--selftest-natural`）。 */
fs.copyFileSync(path.join(ROOT, 'tests', 'survival-natural.js'), path.join(APPDIR, 'selftest', 'survival-natural.js'));

// 随包文档
for (const f of ['LICENSES.md', '操作说明.md', '音频更新说明.md', 'VSCO-CC0.txt']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(DEST, f));
}
// 图标（若已生成）
const ico = path.join(ROOT, 'build', 'icon.ico');
if (fs.existsSync(ico)) {
  fs.mkdirSync(path.join(APPDIR, 'build'), { recursive: true });
  fs.copyFileSync(ico, path.join(APPDIR, 'build', 'icon.ico'));
}

fs.mkdirSync(path.join(DEST, 'saves'), { recursive: true });
/* 备份过的玩家存档原样放回，然后删掉临时备份 */
if (savesBackup) {
  try {
    copyDir(savesBackup, SAVES_DIR);
    fs.rmSync(savesBackup, { recursive: true, force: true });
    log('玩家存档已放回 saves/');
  } catch (e) {
    log('⚠ 玩家存档放回失败，备份仍在：' + savesBackup + '（' + e.message + '）');
  }
}
if (MOVEMENT_PREVIEW) {
  const previewFile = path.join(SAVES_DIR, PREVIEW_NAME + '.json');
  if (!fs.existsSync(previewFile)) fs.writeFileSync(previewFile, JSON.stringify(createMovementPreview()));
  /* 旧包里的试听世界没有 noSpawn：只补这一个字段，读档时不再恢复旧生物也不再刷怪。
     玩家在试听世界里搭的东西、位置和背包一律不动。 */
  const preview = JSON.parse(fs.readFileSync(previewFile, 'utf8'));
  if (!preview.meta || !preview.meta.noSpawn) {
    preview.meta = Object.assign({}, preview.meta, { noSpawn: true });
    fs.writeFileSync(previewFile, JSON.stringify(preview));
    log('试听世界补上 noSpawn（不刷怪，听脚步不受生物打断）');
  }
  fs.copyFileSync(path.join(ROOT, '移动音效试玩说明.md'), path.join(DEST, '移动音效试玩说明.md'));
  createListeningClips(path.join(DEST, '试听'));
  log('已加入独立移动音效试听世界与短对照');
}
if (INTERACTION_PREVIEW) {
  const previewFile = path.join(SAVES_DIR, DIG_PREVIEW_NAME + '.json');
  if (!fs.existsSync(previewFile)) fs.writeFileSync(previewFile, JSON.stringify(createDigPreview()));
  const preview = JSON.parse(fs.readFileSync(previewFile, 'utf8'));
  if (!preview.meta || !preview.meta.noSpawn) {
    preview.meta = Object.assign({}, preview.meta, { noSpawn: true });
    fs.writeFileSync(previewFile, JSON.stringify(preview));
    log('挖放试听世界补上 noSpawn');
  }
  fs.copyFileSync(path.join(ROOT, '挖放音效试玩说明.md'), path.join(DEST, '挖放音效试玩说明.md'));
  createInteractionClips(path.join(DEST, '试听'));
  log('已加入挖放试听世界与短对照');
}
if (COMBAT_PREVIEW) {
  const previewFile = path.join(SAVES_DIR, COMBAT_PREVIEW_NAME + '.json');
  if (!fs.existsSync(previewFile)) fs.writeFileSync(previewFile, JSON.stringify(createCombatPreview()));
  const preview = JSON.parse(fs.readFileSync(previewFile, 'utf8'));
  if (!preview.meta || !preview.meta.noSpawn) {
    preview.meta = Object.assign({}, preview.meta, { noSpawn: true });
    fs.writeFileSync(previewFile, JSON.stringify(preview));
    log('战斗试听世界补上 noSpawn');
  }
  fs.copyFileSync(path.join(ROOT, '战斗音效试玩说明.md'), path.join(DEST, '战斗音效试玩说明.md'));
  createCombatClips(path.join(DEST, '试听'));
  log('已加入战斗试听世界与短对照');
}
if (EAT_PREVIEW) {
  const previewFile = path.join(SAVES_DIR, EAT_PREVIEW_NAME + '.json');
  if (!fs.existsSync(previewFile)) fs.writeFileSync(previewFile, JSON.stringify(createEatPreview()));
  fs.copyFileSync(path.join(ROOT, '进食音效试玩说明.md'), path.join(DEST, '进食音效试玩说明.md'));
  createEatClips(path.join(DEST, '试听'));
  log('已加入进食试听世界与短对照');
}
if (AMBIENT_PREVIEW) {
  for (const preview of createAmbientPreviews()) {
    const file = path.join(SAVES_DIR, preview.name + '.json');
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(preview.data));
  }
  const settings = path.join(SAVES_DIR, 'settings.json');
  if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ music: false }));
  fs.copyFileSync(path.join(ROOT, '环境声试玩说明.md'), path.join(DEST, '环境声试玩说明.md'));
  createAmbientClips(path.join(DEST, '试听'));
  log('已加入环境声试听场景与短对照');
}
fs.writeFileSync(path.join(DEST, 'start-game.bat'),
  '@echo off\r\n' +
  'rem Launch the game. ASCII-only content so cmd.exe parses it on any codepage.\r\n' +
  'cd /d "%~dp0"\r\n' +
  'for %%f in (*.exe) do start "" "%%f"\r\n');
fs.writeFileSync(path.join(DEST, '存档位置.txt'),
  '本文件夹内的 saves/ 就是你的存档目录（便携设计，拷贝到别处存档跟着走）。\r\n' +
  '如果 saves/ 无法写入（例如放在受保护目录），游戏会自动改用「文档\\方块世界存档」。\r\n');

log('完成：' + DEST);
log('体积：' + (dirSize(DEST) / 1048576).toFixed(1) + ' MB');
