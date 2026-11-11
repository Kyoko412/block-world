'use strict';
import { MOVEMENT_SFX_FILES } from './movementfiles.js';
import { DIG_SFX_FILES } from './digfiles.js';
import { COMBAT_SFX_FILES } from './combatfiles.js';
import { EAT_SFX_FILES } from './eatfiles.js';
import { NOTIFY_SFX_FILES } from './notifyfiles.js';
/*
 * sfxfiles.js —— 阶段 6 新增外部音效的机器可读登记表。
 *
 * 与 musicfiles.js 同一套口径：纯数据 + 纯函数，不 fetch、不碰 AudioContext，
 * 单测可以在 Node 里直接核对「登记的字节数 / SHA-256 / 许可」与磁盘上的文件一致。
 * 换素材却忘了改这张表（或换了许可不明的素材）会直接判红，而不是只写在文档里。
 *
 * 素材来源分组登记；最后一组是 Strudel 原创提示音与 CC0 乐器采样。
 * 全部走本地回环同源 URL，游戏运行期间不产生任何外部网络请求。
 */

export const SFX_FILE_DIR = 'media/sfx';

/** 允许随包分发的许可（只收公有领域 / 无需署名的一类） */
export const SFX_LICENCE_ALLOWLIST = Object.freeze(['CC0-1.0']);

export const SFX_FILES = Object.freeze({
  ...MOVEMENT_SFX_FILES,
  ...DIG_SFX_FILES,
  ...COMBAT_SFX_FILES,
  ...EAT_SFX_FILES,
  ...NOTIFY_SFX_FILES
});

export const SFX_FILE_IDS = Object.freeze(Object.keys(SFX_FILES));

export function sfxFileFor(id) {
  const e = SFX_FILES[id];
  return e && e.file ? e : null;
}

/** 同源相对 URL：`/media/sfx/xxx.wav` */
export function sfxFileUrl(entryOrId) {
  const e = typeof entryOrId === 'string' ? sfxFileFor(entryOrId) : entryOrId;
  if (!e || !e.file) return null;
  return '/' + SFX_FILE_DIR + '/' + e.file;
}

/** 单条登记的静态自检；磁盘一致性由单测/成品自检用 fs 补 */
export function validateSfxFile(id, entry) {
  const e = entry || sfxFileFor(id);
  const problems = [];
  if (!e) return { ok: false, problems: ['没有这条音效的登记'] };
  if (e.id !== id) problems.push('id 与表键不一致：' + e.id + ' vs ' + id);
  for (const k of ['file', 'sourceFile', 'title', 'author', 'authorPage', 'source', 'licence', 'licenceName', 'sha256', 'usedFor', 'modifiedNote']) {
    if (!e[k]) problems.push('缺字段 ' + k);
  }
  if (!/^[\w][\w.\-]*$/.test(String(e.file)) || /[\\/]/.test(String(e.file))) {
    problems.push('file 必须是 media/sfx 下的单个文件名：' + e.file);
  }
  if (sfxFileUrl(e) !== '/' + SFX_FILE_DIR + '/' + e.file) problems.push('拼出来的 URL 不是同源素材路径');
  if (SFX_LICENCE_ALLOWLIST.indexOf(e.licence) < 0) problems.push('许可不在允许清单：' + e.licence);
  if (!Number.isInteger(e.bytes) || e.bytes <= 0) problems.push('bytes 必须是正整数');
  if (!/^[0-9a-f]{64}$/.test(String(e.sha256))) problems.push('sha256 不是 64 位小写十六进制');
  if (!(typeof e.seconds === 'number' && e.seconds > 0 && e.seconds <= 3)) problems.push('seconds 超出短音效范围');
  if (e.modified !== true) problems.push('加工过的素材必须标 modified=true');
  /* 本项目原创的 Strudel 提示音用 local://tools/ 标明乐谱出处。 */
  if (!/^(https:\/\/|local:\/\/tools\/)/.test(String(e.source))) problems.push('source 要写作者原页的绝对地址（本机合成为 local://tools/…）');
  return { ok: problems.length === 0, problems };
}

export function sfxFilesReport() {
  return SFX_FILE_IDS.map(id => {
    const v = validateSfxFile(id);
    const e = SFX_FILES[id];
    return { id, file: e ? e.file : null, licence: e ? e.licence : null, bytes: e ? e.bytes : null, ok: v.ok, problems: v.problems };
  });
}

export function sfxFilesValid() {
  return sfxFilesReport().every(r => r.ok);
}

export default { SFX_FILES, SFX_FILE_IDS, sfxFileFor, sfxFileUrl, validateSfxFile, sfxFilesReport };
