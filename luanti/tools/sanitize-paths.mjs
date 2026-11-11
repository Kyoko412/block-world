/* 公开前清洗：把文档与脚本里的本机绝对路径换成相对路径或占位符。
 * 用法： node luanti/tools/sanitize-paths.mjs        （改前会打印将要改的文件）
 *        node luanti/tools/sanitize-paths.mjs --check （只检查，不写盘）
 */
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const checkOnly = process.argv.includes('--check');
const list = execSync('git -c core.quotePath=false ls-files', { encoding: 'utf8' })
  .split('\n').filter(Boolean);

const patterns = [
  [/E:\/MinecraftOffline\//g, ''],
  [/E:\\MinecraftOffline\\/g, ''],
  [/E:\/MinecraftOffline-external\/[^\s"'`)]*/g, '<外部工具目录>'],
  [/C:\/Users\/UserX\/[^\s"'`)]*/g, '<本机路径>'],
  [/C:\/Users\/朱佳瑞\/[^\s"'`)]*/g, '<本机路径>']
];

let changed = 0;
for (const file of list) {
  if (!/\.(md|mjs|js|ps1|sh|json|bat|txt|conf|lua)$/i.test(file)) continue;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const before = text;
  for (const [re, to] of patterns) text = text.replace(re, to);
  if (text === before) continue;
  changed++;
  if (checkOnly) { console.log('待清洗：' + file); continue; }
  fs.writeFileSync(file, text);
  console.log('已清洗：' + file);
}
console.log((checkOnly ? '待清洗文件数：' : '清洗文件数：') + changed);
process.exitCode = checkOnly && changed > 0 ? 1 : 0;
