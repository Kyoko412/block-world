'use strict';
/*
 * 存档读写：全部走本地回环 HTTP（Electron 与浏览器测试模式共用同一套接口）。
 * 没有任何外部网络请求，断网可用。
 */
const BASE = '';

async function req(method, url, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opt.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(BASE + url, opt);
  const j = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!res.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + res.status));
  return j;
}

export class Storage {
  async ping() { return req('GET', '/api/ping'); }

  async loadSettings() {
    try { const j = await req('GET', '/api/settings'); return j.settings || {}; }
    catch (e) { console.warn('读取设置失败', e); return {}; }
  }

  async saveSettings(obj) {
    try { await req('POST', '/api/settings', obj); return true; }
    catch (e) { console.warn('保存设置失败', e); return false; }
  }

  async listWorlds() {
    const j = await req('GET', '/api/worlds');
    return j.worlds || [];
  }

  async loadWorld(name) {
    const j = await req('GET', '/api/world/load?name=' + encodeURIComponent(name));
    return j.data;
  }

  async saveWorld(name, obj) {
    const j = await req('POST', '/api/world/save', obj);
    return j.savedTo;
  }

  async deleteWorld(name) {
    return req('POST', '/api/world/delete?name=' + encodeURIComponent(name));
  }

  async saveScreenshot(dataUrl, name) {
    return req('POST', '/api/screenshot', { dataUrl, name: name || 'shot' });
  }

  quit() {
    return req('POST', '/api/quit').catch(() => { window.close(); });
  }
}
