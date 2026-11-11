'use strict';
/*
 * 全部界面：主菜单 / 新建世界 / 存档列表 / 设置 / 暂停 / 死亡 /
 * HUD（快捷栏、血量、调试）/ 背包与合成 / 熔炉 / 创造物品栏。
 */
import { getItem, ITEMS, itemName, maxStack, CREATIVE_TABS, ARMOR_SLOT_NAMES } from '../core/items.js';
import { blockName, BLOCKS, B } from '../core/blocks.js';
import { RECIPES, smeltResult, expandIngredient, allocateForCraft } from '../core/recipes.js';
import { getItemIcon, initAtlas } from '../gfx/atlas.js';
import { HOTBAR_SIZE } from '../player/inventory.js';
import { DEFAULT_SETTINGS } from '../player/game.js';
import { tradesFor, professionName } from '../core/village.js';
import { MAP_PALETTE } from '../core/map.js';
import { filterCreativeItems } from '../core/creative.js';
import { nightPhase, nightHintText } from '../core/hud.js';
import { QUESTS, suggestRecipes } from '../core/quests.js';
import { describeItem } from '../core/iteminfo.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

/* B：第一次用户手势唤醒音频 + 菜单按钮点击音（只在按钮上，不常驻、不每帧） */
const GESTURE_EVENTS = ['pointerdown', 'mousedown', 'keydown', 'touchstart'];
const GESTURE_OPTS = { capture: true, passive: true };
const MENU_BUTTON_SELECTOR = ['#screen-menu', '#screen-newworld', '#screen-worlds', '#screen-settings', '#screen-pause', '#screen-death']
  .map((id) => id + ' .btn').join(', ');

export class UI {
  constructor(game) {
    this.game = game;
    this.hudVisible = true;
    this.craftSize = 2;
    this.creativeTab = 0;
    this.creativeQuery = '';
    this.lastCountKey = '';
    this.bindGlobal();
    // 面板事件只绑定一次（内部内容会被反复重建）
    for (const sel of ['#panel-inventory', '#panel-furnace']) {
      const node = $(sel);
      node.addEventListener('mousedown', (e) => this.onPanelMouseDown(e));
      node.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  /* ==================== 基础 ==================== */
  get canvas() { return this.game.canvas; }

  bindGlobal() {
    window.addEventListener('mousemove', (e) => {
      const c = $('#cursor-stack');
      c.style.left = e.clientX + 'px';
      c.style.top = e.clientY + 'px';
    });
    window.addEventListener('resize', () => this.game.resize && this.game.resize());
    document.addEventListener('mouseleave', () => {
      if (this.game.input) { this.game.input._clearAll(); }
    });
    /* B：主菜单以前是全静音的 —— AudioContext 要等到进世界（或点画面）才创建，
       而菜单按钮的点击音在那之前就被 play() 丢掉了。这里在 capture 阶段抢在任何按钮
       处理器之前，用「第一次真实用户手势」把音频上下文唤醒；就绪之后立即摘掉监听，不常驻。 */
    const kick = () => {
      const sfx = this.game && this.game.sfx;
      if (!sfx) return;
      try { sfx.resume(); } catch (e) { /* 自动播放策略未放行，下次手势再试 */ }
      if (sfx.ready || sfx._disposed) {
        for (const ev of GESTURE_EVENTS) window.removeEventListener(ev, kick, GESTURE_OPTS);
      }
    };
    for (const ev of GESTURE_EVENTS) window.addEventListener(ev, kick, GESTURE_OPTS);
    /* B：菜单/暂停/设置/死亡面板的按钮给轻点击音。只挂在按钮上（不是 mousemove、不是每帧），
       同名 40ms 限流已经把卡片里原有的那一次 play 去重了，不会「双响」。 */
    document.addEventListener('click', (e) => {
      const sfx = this.game && this.game.sfx;
      if (!sfx || !e.target || !e.target.closest) return;
      const btn = e.target.closest(MENU_BUTTON_SELECTOR);
      if (!btn || btn.disabled) return;
      sfx.play('click', { volume: 0.26, rate: 1.06 });
    });
    /* C：物品 tooltip。只在真正悬停到有物品的槽位时出现；
       鼠标锁定（正在玩）时绝不弹，避免挡住准星与判断。 */
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement) { if (this.tipNode) this.hideTip(); return; }
      const node = e.target && e.target.closest ? e.target.closest('.slot') : null;
      if (!node || !node.dataset || !node.dataset.item) { if (this.tipNode) this.hideTip(); return; }
      this.showTip(node, e.clientX, e.clientY);
    });
  }

  /* ---------- C：物品 tooltip（只加一层信息，不换皮、不动任何既有底色/边框/尺寸） ---------- */

  ensureTip() {
    let t = document.getElementById('item-tip');
    if (!t) {
      t = el('div', '');
      t.id = 'item-tip';
      document.body.appendChild(t);
    }
    return t;
  }

  /** 内容全部来自 describeItem(既有字段)，颜色阈值与槽位耐久条一致 */
  tipHTML(d) {
    let h = '<div class="tname">' + escapeHtml(d.name) + '</div>';
    if (d.use) h += '<div class="tuse">' + escapeHtml(d.use) + '</div>';
    for (const line of d.lines) h += '<div class="tline">' + escapeHtml(line) + '</div>';
    if (d.dur) {
      const c = d.dur.pct > 0.5 ? '#4cd44c' : d.dur.pct > 0.22 ? '#e8d33a' : '#d94b4b';
      h += '<div class="tdur"><i style="width:' + Math.round(d.dur.pct * 100) + '%;background:' + c + '"></i></div>';
    }
    return h;
  }

  /** 贴边翻转：靠右/靠底时换到另一侧，最后再夹进视口，保证不溢出窗口 */
  placeTip(t, cx, cy) {
    const w = t.offsetWidth || 180, h = t.offsetHeight || 64;
    const vw = window.innerWidth, vh = window.innerHeight;
    let x = cx + 16, y = cy + 18;
    if (x + w > vw - 6) x = cx - w - 14;
    if (y + h > vh - 6) y = cy - h - 12;
    if (x < 6) x = 6;
    if (y < 6) y = 6;
    t.style.left = Math.round(x) + 'px';
    t.style.top = Math.round(y) + 'px';
    return { x, y, w, h, vw, vh };
  }

  showTip(node, cx, cy) {
    const id = node.dataset.item;
    const dur = node.dataset.dur !== undefined ? Number(node.dataset.dur) : undefined;
    const stack = dur === undefined ? null : { dur };
    const key = id + '|' + (dur === undefined ? '-' : dur);
    const t = this.ensureTip();
    if (this.tipKey !== key) {
      t.innerHTML = this.tipHTML(describeItem(id, stack));
      this.tipKey = key;
    }
    t.classList.add('show');
    const box = this.placeTip(t, cx, cy);
    this.tipNode = node;
    this.tipBox = box;
    return true;
  }

  hideTip() {
    const t = document.getElementById('item-tip');
    if (t) t.classList.remove('show');
    this.tipKey = null;
    this.tipNode = null;
  }

  /*
   * 提示（toast）：带优先级与上限。
   * 本轮 C：接近遗迹时会同时撞上「发现地点」「封印石座说明」「守卫沉睡中」三条 ——
   * 加上成就横幅，屏幕上同时出现四块说明，把守卫和场地全挡住了（审计 29 的同一问题）。
   * 现在：
   *   · 最多同时显示 2 条（CAP）；
   *   · 危险/失败（priority 2）可以顶掉普通提示，普通提示不能顶掉危险提示；
   *   · 同一段文案 2.5 秒内重复只延长这一条，不再叠新的。
   */
  toast(text, bad = false, ttl = 1800, opts = {}) {
    const wrap = $('#toast-wrap');
    if (!wrap) return null;
    const CAP = 2;
    const priority = Number.isFinite(opts.priority) ? opts.priority : (bad ? 2 : 0);
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._toasts = this._toasts || [];
    /* 同文案去重：仍在屏上的那一条直接延长 TTL */
    const dup = this._toasts.find(t => t.text === text && t.node.parentNode === wrap);
    if (dup) {
      dup.t = now;
      clearTimeout(dup.timer);
      dup.timer = setTimeout(() => this._dropToast(dup), ttl);
      return dup.node;
    }
    const t = el('div', 'toast' + (bad ? ' bad' : ''), escapeHtml(text));
    wrap.appendChild(t);
    const rec = { text, node: t, priority, t: now, timer: null };
    rec.timer = setTimeout(() => this._dropToast(rec), ttl);
    this._toasts.push(rec);
    this._trimToasts(CAP, priority);
    return t;
  }

  /* 第二轮 D：按内容撤掉过期的提示。
     战斗开始时「守卫沉睡着 · 四座封印还缺…」这类说明已经不再成立，
     留着会盖住真正的危险预警（复核也提到提示拥挤）。 */
  clearToast(text) {
    const live = (this._toasts || []).filter(t => t.node && t.node.parentNode);
    let n = 0;
    for (const t of live) {
      if (!text || t.text.indexOf(text) >= 0) { this._dropToast(t); n++; }
    }
    return n;
  }

  _dropToast(rec) {
    if (!rec) return;
    clearTimeout(rec.timer);
    this._toasts = (this._toasts || []).filter(x => x !== rec);
    const n = rec.node;
    if (!n || !n.parentNode) return;
    n.style.transition = 'opacity .3s';
    n.style.opacity = '0';
    setTimeout(() => n.remove(), 320);
  }

  /* 超上限时挑「最老且优先级不高过新来者」的那条先让位；同级就按先后顺序淘汰最老的 */
  _trimToasts(cap, incomingPriority) {
    const live = (this._toasts || []).filter(t => t.node && t.node.parentNode);
    if (live.length <= cap) return;
    const victims = live
      .slice()
      .sort((a, b) => (a.priority - b.priority) || (a.t - b.t))
      .filter(t => t.priority <= incomingPriority);
    let need = live.length - cap;
    for (const v of victims) {
      if (need <= 0) break;
      this._dropToast(v);
      need--;
    }
  }

  show(sel) { $(sel).classList.remove('hidden'); }
  hide(sel) { $(sel).classList.add('hidden'); }

  /* T3 弓蓄力条：v 为 0~1，0 时隐藏 */
  /** 阶段 5：守卫血条。info 来自 MobManager.guardianInfo()，UI 不自己算血量与相位。 */
  setGuardianBar(info) {
    const bar = $('#guardian-bar');
    if (!bar) return;
    const on = !!info && info.present && !info.defeated;
    bar.classList.toggle('hidden', !on);
    if (!on) return;
    const fill = $('#gb-fill'), phase = $('#gb-phase');
    if (fill) fill.style.width = Math.max(0, Math.min(100, info.hp / info.maxHp * 100)) + '%';
    if (phase) {
      phase.textContent = info.phase === 'telegraph'
        ? '蓄力：' + (info.attack === 'bolt' ? '光弹' : '横扫')
        : info.phase === 'recover' ? '硬直' : '';
    }
  }

  setBowCharge(v) {
    const bar = $('#bow-charge');
    if (!bar) return;
    const on = Number(v) > 0.001;
    bar.classList.toggle('hidden', !on);
    if (on && bar.firstElementChild) bar.firstElementChild.style.width = Math.round(Math.min(1, v) * 100) + '%';
  }

  /* P0：攻击恢复进度（1 = 可满额命中）。低调细线，满蓄时藏起来。 */
  setAttackCharge(v) {
    const bar = $('#attack-charge');
    if (!bar) return;
    const p = Math.max(0, Math.min(1, Number(v)));
    bar.classList.toggle('hidden', p > 0.999);
    if (bar.firstElementChild) bar.firstElementChild.style.width = Math.round(p * 100) + '%';
  }

  /* 滚动任务 7：雷暴闪电的全屏冷白闪（重播动画要先把类摘掉再强制回流） */
  lightningFlash(ms = 320) {
    const f = $('#lightning-flash');
    if (!f) return false;
    f.classList.remove('flash');
    void f.offsetWidth;
    f.classList.add('flash');
    clearTimeout(this._lightningFlashT);
    this._lightningFlashT = setTimeout(() => f.classList.remove('flash'), Math.max(40, ms));
    return true;
  }
  hideAllScreens() {
    for (const s of ['#screen-menu', '#screen-newworld', '#screen-worlds', '#screen-settings', '#screen-pause', '#screen-death', '#screen-loading']) this.hide(s);
  }
  hidePanels() {
    this.hide('#panel-inventory'); this.hide('#panel-furnace'); this.hide('#panel-villager'); this.hide('#panel-map');
    this.creativeQuery = '';                 // E1：关闭再打开不残留过滤，避免误以为物品消失
    if (this.game.state === 'menu') this.showMenu();
  }

  /* T2：分片加载的进度（0~1）。读档现在横跨多帧，进度条要真的动起来，
     否则玩家看到的还是「点了没反应」，只是这次连卡住的都是画面。 */
  setLoadingProgress(frac, total) {
    const bar = $('.loading-bar i');
    if (!bar) return false;
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    const pct = Math.round(4 + f * 94);
    // 点存档时界面会先把条写成 20%~25%，第一片进度却是 0% —— 不许往回跳，只允许往前走
    const prev = parseFloat(bar.style.width) || 0;
    bar.style.width = (f >= 1 ? pct : Math.max(pct, prev)) + '%';
    const tip = $('.loading-tip');
    if (tip) {
      const n = Number(total);
      tip.textContent = '正在准备区块 ' + Math.round(f * 100) + '%' +
        (Number.isFinite(n) && n > 0 ? '（本世界共 ' + n + ' 项待办）' : '');
    }
    return true;
  }

  /* 恢复游戏时要把全屏界面（暂停/死亡/设置）与面板一起关掉 */
  hideOverlays() {
    this.hideAllScreens();
    this.hide('#panel-inventory'); this.hide('#panel-furnace'); this.hide('#panel-villager'); this.hide('#panel-map');
    const lf = $('#lightning-flash'); if (lf) lf.classList.remove('flash');
    this.setBowCharge(0);                       // T3：界面切换时蓄力条不能残留
    if (this.game.state === 'menu') { this.showMenu(); return; }
    if (this.game.state === 'playing' && this.hudVisible) this.show('#hud');
  }

  /* ==================== 主菜单 ==================== */
  showMenu() {
    this.game.state = 'menu';
    this.hideAllScreens();
    this.hide('#hud');
    const box = $('#screen-menu');
    box.innerHTML = '';
    const card = el('div', 'card narrow');
    card.innerHTML = `
      <div class="title">方块世界</div>
      <div class="subtitle">MINECRAFT 风格 · 中文体素沙盒 · 完全离线</div>
      <button class="btn primary" data-a="new">新建世界</button>
      <button class="btn" data-a="load">读取存档</button>
      <button class="btn" data-a="settings">设置</button>
      <button class="btn" data-a="help">操作说明</button>
      <button class="btn danger" data-a="quit">退出游戏</button>
      <div class="hint" style="margin-top:14px">
        版本 1.0 · 世界地形由种子确定性生成，所有改动保存在本地存档目录。<br>
        本项目使用开源引擎 Three.js（MIT 许可），详见「帮助 → 开源许可」。
      </div>`;
    card.addEventListener('click', (e) => {
      const a = e.target.dataset.a;
      if (!a) return;
      this.game.sfx.play('click', { volume: 0.4 });
      if (a === 'new') this.showNewWorld();
      if (a === 'load') this.showWorlds();
      if (a === 'settings') this.showSettings('menu');
      if (a === 'help') this.showHelp();
      if (a === 'quit') this.game.quitGame();
    });
    box.appendChild(card);
    this.show('#screen-menu');
  }

  showHelp() {
    this.hideAllScreens();
    const box = $('#screen-menu');
    box.innerHTML = '';
    const card = el('div', 'card');
    card.innerHTML = `
      <h3 class="sec">移动与视角</h3>
      <div class="hint">
        <span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> 移动　
        <span class="kbd">空格</span> 跳跃（创造模式双击切换飞行）　
        <span class="kbd">Ctrl</span> 冲刺　<span class="kbd">Shift</span> 潜行/下降　
        鼠标 视角（点击画面锁定鼠标，按 <span class="kbd">Esc</span> 释放）
      </div>
      <h3 class="sec">方块操作</h3>
      <div class="hint">
        鼠标左键（按住）挖掘方块　鼠标右键放置方块或使用工作台/熔炉　
        <span class="kbd">中键</span> 创造模式取色　<span class="kbd">1</span>~<span class="kbd">9</span> 或 滚轮 切换物品　
        <span class="kbd">Q</span> 丢弃手持物品
      </div>
      <h3 class="sec">物品与制作</h3>
      <div class="hint">
        <span class="kbd">E</span> 打开背包（含 2×2 合成）　对着工作台按右键打开 3×3 合成　
        左键拿起整堆、右键拿一半、Shift+左键快速移动　
        主线：砍树 → 原木变木板 → 工作台 → 木镐 → 挖石头 → 石镐 + 熔炉 → 采矿 → 烧铁
      </div>
      <h3 class="sec">动物与天气</h3>
      <div class="hint">
        剪刀（2 铁锭 + 2 木棍）对着有毛的羊按右键剪羊毛，约 90 秒后羊毛会长回来　
        手持小麦（牛/羊）、胡萝卜或马铃薯（猪）、小麦种子（鸡）对着成年动物按右键，
        <b>旁边还要有一只同类</b>才会生幼崽；生完 60 秒内不能连续生，幼崽会慢慢长大　
        下雨/下雪时天变暗、雾变近，躲进屋里或洞穴就几乎看不到降水；夜里睡一觉可以放晴　
        夜里还会刷<b>蜘蛛</b>：它跑得比僵尸快、不怕太阳、<b>能贴着墙往上爬</b>，杀掉掉「线」，4 线可合成羊毛
      </div>
      <h3 class="sec">存档</h3>
      <div class="hint">
        自动按间隔保存，也可按 <span class="kbd">F5</span> 手动保存　<span class="kbd">F11</span> 全屏　
        <span class="kbd">F3</span> 调试信息　<span class="kbd">F12</span> 截图（保存在存档目录 screenshots/）
      </div>
      <button class="btn primary" data-a="back">返回</button>`;
    card.addEventListener('click', (e) => { if (e.target.dataset.a === 'back') this.showMenu(); });
    box.appendChild(card);
    this.show('#screen-menu');
  }

  showNewWorld() {
    this.hideAllScreens();
    const box = $('#screen-newworld');
    box.innerHTML = '';
    const card = el('div', 'card narrow');
    card.innerHTML = `
      <h3 class="sec">世界名称</h3>
      <input type="text" id="inp-name" value="新的世界" maxlength="24">
      <h3 class="sec">种子（留空则随机）</h3>
      <div class="row">
        <input type="text" id="inp-seed" placeholder="例如：12345 或 中文字符串">
        <button class="btn small" id="btn-random" style="flex:0 0 auto">随机</button>
      </div>
      <h3 class="sec">游戏模式</h3>
      <div class="btnrow">
        <button class="btn primary" id="m-survival">生存模式</button>
        <button class="btn" id="m-creative">创造模式</button>
      </div>
      <div class="hint" id="mode-desc">生存：需要自己采集工具与食物，摔落会受伤，死亡掉落物品。</div>
      <div class="btnrow" style="margin-top:18px">
        <button class="btn" id="btn-back">返回</button>
        <button class="btn primary" id="btn-create">创建世界</button>
      </div>`;
    box.appendChild(card);
    this.show('#screen-newworld');

    let mode = 'survival';
    const setMode = (m) => {
      mode = m;
      $('#m-survival').className = 'btn' + (m === 'survival' ? ' primary' : '');
      $('#m-creative').className = 'btn' + (m === 'creative' ? ' primary' : '');
      $('#mode-desc').textContent = m === 'survival'
        ? '生存：需要自己采集工具与食物，摔落会受伤，死亡掉落物品。'
        : '创造：无限方块、可以飞行、瞬间挖掘，专心建造。';
    };
    setMode('survival');
    $('#m-survival').onclick = () => setMode('survival');
    $('#m-creative').onclick = () => setMode('creative');
    $('#btn-random').onclick = () => { $('#inp-seed').value = Math.floor(Math.random() * 1e9) + ''; };
    $('#btn-back').onclick = () => this.showMenu();
    $('#btn-create').onclick = async () => {
      const name = $('#inp-name').value.trim() || '新的世界';
      const seed = $('#inp-seed').value;
      await this.createWorld(name, seed, mode);
    };
  }

  async createWorld(name, seed, mode) {
    this.hideAllScreens();
    this.show('#screen-loading');
    $('.loading-bar i').style.width = '20%';
    try {
      this.game.settings.pendingMode = mode;
      await this.game.newWorld(name, seed, mode);
      $('.loading-bar i').style.width = '100%';
    } catch (e) {
      console.error(e);
      this.hide('#screen-loading');
      this.toast('创建世界失败：' + e.message, true, 4000);
      this.showNewWorld();
    }
  }

  async showWorlds() {
    this.hideAllScreens();
    const box = $('#screen-worlds');
    box.innerHTML = '';
    const card = el('div', 'card');
    card.innerHTML = `<h3 class="sec">读取存档</h3><div class="world-list" id="wl"><div class="hint">正在扫描存档目录…</div></div>
      <div class="btnrow" style="margin-top:14px">
        <button class="btn" id="btn-back">返回</button>
        <button class="btn primary" id="btn-new">新建世界</button>
      </div>
      <div class="hint" style="margin-top:10px">存档目录：${escapeHtml(await this.game.storage.dirHint ? '' : '')}</div>`;
    box.appendChild(card);
    this.show('#screen-worlds');
    $('#btn-back').onclick = () => this.showMenu();
    $('#btn-new').onclick = () => this.showNewWorld();

    const list = $('#wl');
    let worlds = [];
    try { worlds = await this.game.storage.listWorlds(); } catch (e) { list.innerHTML = '<div class="hint">读取存档失败：' + e.message + '</div>'; return; }
    if (!worlds.length) { list.innerHTML = '<div class="hint">还没有存档。点击「新建世界」开始你的第一局。</div>'; return; }
    list.innerHTML = '';
    for (const w of worlds) {
      const item = el('div', 'world-item');
      const date = w.savedAt ? new Date(w.savedAt).toLocaleString('zh-CN', { hour12: false }) : '未知时间';
      item.innerHTML = `
        <div class="meta">
          <div class="nm">${escapeHtml(w.name)}</div>
          <div class="sub">种子 ${escapeHtml(String(w.seed))} · 保存于 ${date} · ${(w.size / 1024).toFixed(1)} KB</div>
        </div>
        <span class="badge ${w.mode === 'creative' ? 'creative' : 'survival'}">${w.mode === 'creative' ? '创造' : '生存'}</span>
        <button class="btn small danger" data-del="${escapeHtml(w.name)}">删除</button>`;
      item.addEventListener('click', async (e) => {
        if (e.target.dataset.del) {
          e.stopPropagation();
          if (!confirm('确定删除存档「' + w.name + '」？此操作不可恢复。')) return;
          try { await this.game.storage.deleteWorld(w.name); } catch (err) { /* ignore */ }
          this.showWorlds();
          return;
        }
        this.hideAllScreens();
        this.show('#screen-loading');
        $('.loading-bar i').style.width = '25%';
        try {
          await this.game.loadWorld(w.name);
        } catch (err) {
          console.error(err);
          this.hide('#screen-loading');
          this.toast('读取存档失败：' + err.message, true, 4000);
          this.showWorlds();
        }
      });
      list.appendChild(item);
    }
  }

  /* ==================== 设置 ==================== */
  showSettings(from) {
    this.hideAllScreens();
    if (from === 'pause') this.game.pause();
    const box = $('#screen-settings');
    box.innerHTML = '';
    const g = this.game;
    const s = g.settings;
    const card = el('div', 'card');
    const rows = [
      ['volumeMaster', '主音量', 0, 1, 0.05, 'percent'],
      ['volumeSfx', '音效音量', 0, 1, 0.05, 'percent'],
      ['volumeMusic', '音乐音量', 0, 1, 0.05, 'percent'],
      ['sensitivity', '鼠标灵敏度', 0.0006, 0.006, 0.0002, 'sens'],
      ['fov', '视野角度 FOV', 55, 110, 1, 'deg'],
      ['renderDistance', '视距（区块）', 2, 12, 1, 'chunk'],
      ['brightness', '亮度', 0.6, 1.8, 0.05, 'mul'],
      ['renderScale', '渲染分辨率', 0.5, 1.5, 0.1, 'mul'],
      ['autosaveSeconds', '自动保存间隔（秒）', 10, 300, 5, 'sec'],
      ['dayLengthSeconds', '一整天时长（秒）', 120, 2400, 60, 'sec']
    ];
    let html = '<h3 class="sec">音频 · 画面 · 手感</h3>';
    for (const [key, label, min, max, step, fmt] of rows) {
      html += `<div class="slider-row" data-key="${key}" data-min="${min}" data-max="${max}" data-step="${step}" data-fmt="${fmt}">
        <span class="name">${label}</span>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${s[key]}">
        <span class="val"></span></div>`;
    }
    html += `<h3 class="sec">其他</h3>
      <div class="check-row"><input type="checkbox" id="ck-music" ${s.music ? 'checked' : ''}><label for="ck-music">播放背景音乐</label></div>
      <div class="check-row"><input type="checkbox" id="ck-particles" ${s.particles ? 'checked' : ''}><label for="ck-particles">挖掘粒子效果</label></div>
      <div class="check-row"><input type="checkbox" id="ck-hud" ${this.hudVisible ? 'checked' : ''}><label for="ck-hud">显示 HUD（血条 / 快捷栏）</label></div>
      <div class="hint">设置会立即生效并写入 settings.json。画面卡顿时优先调低「视距」和「渲染分辨率」。</div>
      <div class="btnrow" style="margin-top:16px">
        <button class="btn primary" id="btn-back2">返回</button>
        <button class="btn" id="btn-default">恢复默认</button>
      </div>`;
    card.innerHTML = html;
    box.appendChild(card);
    this.show('#screen-settings');

    const fmtVal = (fmt, v) => {
      if (fmt === 'percent') return Math.round(v * 100) + '%';
      if (fmt === 'deg') return v + '°';
      if (fmt === 'chunk') return v + ' × 16 格';
      if (fmt === 'mul') return '×' + Number(v).toFixed(2);
      if (fmt === 'sec') return v + ' 秒';
      if (fmt === 'sens') return Number(v).toFixed(4);
      return String(v);
    };
    const readSliders = () => {
      const obj = {};
      for (const r of card.querySelectorAll('.slider-row')) obj[r.dataset.key] = parseFloat(r.querySelector('input').value);
      return obj;
    };
    const paintVals = () => {
      for (const r of card.querySelectorAll('.slider-row')) {
        r.querySelector('.val').textContent = fmtVal(r.dataset.fmt, parseFloat(r.querySelector('input').value));
      }
    };
    const commit = () => {
      const obj = readSliders();
      Object.assign(g.settings, obj);
      if (g.world) g.applySettingsLive(obj);
      else if (g.applyAudioVolumes) g.applyAudioVolumes();   // B：与 init / 游戏内设置同一条下发路径
      g.storage.saveSettings(g.settings);
      paintVals();
    };
    card.addEventListener('input', (e) => {
      if (!e.target.matches('input[type=range]')) return;
      const row = e.target.closest('.slider-row');
      if (row) row.querySelector('.val').textContent = fmtVal(row.dataset.fmt, parseFloat(e.target.value));
      clearTimeout(this._settT);
      this._settT = setTimeout(commit, 150);
    });
    card.addEventListener('change', (e) => {
      if (e.target.id === 'ck-music') {
        s.music = e.target.checked;
        if (s.music && g.world) g.sfx.startMusic(); else g.sfx.stopMusic();
        g.storage.saveSettings(s);
      }
      if (e.target.id === 'ck-particles') { s.particles = e.target.checked; g.storage.saveSettings(s); }
      if (e.target.id === 'ck-hud') { this.setHudVisible(e.target.checked); }
    });
    paintVals();
    $('#btn-back2').onclick = () => {
      commit();
      if (from === 'pause') this.game.resume();
      else this.showMenu();
    };
    $('#btn-default').onclick = () => {
      Object.assign(g.settings, DEFAULT_SETTINGS);
      this.showSettings(from);
      if (g.world) g.applySettingsLive(g.settings);
      g.storage.saveSettings(g.settings);
    };
  }

  setHudVisible(v) {
    this.hudVisible = !!v;
    if (this.game.state !== 'menu') (v ? this.show : this.hide).call(this, '#hud');
  }
  toggleHud() { this.setHudVisible(!this.hudVisible); }

  /* ==================== 暂停 / 死亡 ==================== */
  showPause() {
    this.hideAllScreens();
    const box = $('#screen-pause');
    box.innerHTML = '';
    const g = this.game;
    const modeLabel = g.meta && g.meta.mode === 'creative' ? '创造模式' : '生存模式';
    const card = el('div', 'card narrow');
    card.innerHTML = `
      <div class="subtitle" style="margin-bottom:8px">${escapeHtml(g.meta ? g.meta.name : '')} · ${modeLabel}</div>
      <button class="btn primary" data-a="resume">回到游戏</button>
      <button class="btn" data-a="save">保存进度 (F5)</button>
      <button class="btn" data-a="mode">切换到 ${g.meta && g.meta.mode === 'creative' ? '生存' : '创造'}模式</button>
      <button class="btn" data-a="settings">设置</button>
      <button class="btn" data-a="worlds">返回主菜单（自动保存）</button>
      <button class="btn danger" data-a="quit">退出游戏</button>`;
    card.addEventListener('click', async (e) => {
      const a = e.target.dataset.a;
      if (!a) return;
      this.game.sfx.play('click', { volume: 0.4 });
      if (a === 'resume') this.game.resume();
      if (a === 'save') await this.game.save('manual');
      if (a === 'mode') { this.game.setMode(g.meta.mode === 'creative' ? 'survival' : 'creative'); this.showPause(); }
      if (a === 'settings') this.showSettings('pause');
      if (a === 'worlds') { await this.game.save('auto'); this.game.toMenu(); }
      if (a === 'quit') this.game.quitGame();
    });
    // T3：暂停界面可查看 8 个成就的完成情况（只读，不可点击领取）
    if (g.achievements) {
      const list = g.achievements.list();
      const ach = el('div', 'ach-box');
      ach.id = 'achievement-list';
      ach.innerHTML = `<div class="ach-head">成就 ${g.achievements.count()}/${list.length}</div>` +
        list.map(a => `<div class="ach-row ${a.unlocked ? 'on' : ''}"><span class="ach-dot"></span>` +
          `<span class="ach-name">${escapeHtml(a.name)}</span><span class="ach-desc">${escapeHtml(a.desc)}</span></div>`).join('') +
        /* R3：额外成就与已发现地点（单独样式，不参与「成就 8/8、8 行点亮」） */
        (g.achievements.extras() || []).map(a =>
          `<div class="ach-extra ${a.unlocked ? 'on' : ''}"><span class="ach-tag">额外</span>` +
          `<span class="ach-name">${escapeHtml(a.name)}</span><span class="ach-desc">${escapeHtml(a.desc)}</span></div>`).join('') +
        (() => {
          const found = g.discoveredLandmarks ? g.discoveredLandmarks() : [];
          return `<div class="ach-places">已发现地点 ${found.length}：` +
            (found.length ? found.map(k => escapeHtml(k.name) + '(' + k.x + ',' + k.z + ')').join('、') : '暂无，走近荒野才会出现') +
            `</div>`;
        })();
      card.appendChild(ach);
    }
    box.appendChild(card);
    this.show('#screen-pause');
  }

  showDeath(reason) {
    this.hideAllScreens();
    const box = $('#screen-death');
    box.innerHTML = '';
    const card = el('div', 'card narrow');
    card.innerHTML = `<div class="death-title">你死了！</div>
      <div class="subtitle">${escapeHtml(reason || '')}</div>
      <button class="btn primary" id="btn-respawn">重生</button>
      <button class="btn" id="btn-menu">返回主菜单</button>
      <div class="hint" style="margin-top:10px">掉落的物品还在原地，重生后可以走过去捡回（附近有吸附拾取范围）。</div>`;
    box.appendChild(card);
    this.show('#screen-death');
    $('#btn-respawn').onclick = () => this.game.respawn();
    $('#btn-menu').onclick = async () => { await this.game.save('auto'); this.game.toMenu(); };
  }

  /* T3：命中标记 / 护甲碎裂闪 / 成就 toast（都不挡准星中心） */
  hitMarker() {
    const o = $('#hit-marker');
    if (!o) return;
    o.classList.remove('show');
    void o.offsetWidth;
    o.classList.add('show');
    /* V4：动画 0.2 秒结束后把 show 摘掉，否则类会一直挂着，
       「空挥没有命中标记」的读数会被上一次命中污染。 */
    clearTimeout(this._hitMarkerT);
    this._hitMarkerT = setTimeout(() => o.classList.remove('show'), 240);
  }

  armorBreakFlash() {
    const o = $('#armor-bar');
    if (!o) return;
    o.classList.remove('break');
    void o.offsetWidth;
    o.classList.add('break');
    clearTimeout(this._armorFlashT);
    this._armorFlashT = setTimeout(() => o.classList.remove('break'), 600);
  }

  achievementToast(def) {
    const box = $('#ach-toast');
    if (!box || !def) return;
    box.innerHTML = `<span class="ach-ico"></span><div><span class="ach-t">成就达成</span>` +
      `<span class="ach-n">${escapeHtml(def.name)}</span><span class="ach-d">${escapeHtml(def.desc)}</span></div>`;
    box.classList.remove('show');
    void box.offsetWidth;
    box.classList.add('show');
    clearTimeout(this._achT);
    this._achT = setTimeout(() => box.classList.remove('show'), 3400);
  }

  /* T2：盾牌格挡成功的轻反馈（冷白边缘闪一下；不挡准星中心） */
  blockFlash() {
    const o = $('#block-overlay');
    if (!o) return;
    o.classList.remove('flash');
    void o.offsetWidth;
    o.classList.add('flash');
  }

  damageFlash(amount, reason) {
    const o = $('#damage-overlay');
    o.classList.remove('flash');
    void o.offsetWidth;
    o.classList.add('flash');
    if (reason) this.toast(reason, true, 1200);
  }

  /* ==================== HUD ==================== */
  onWorldReady() {
    initAtlas();
    this.hideAllScreens();
    this.hidePanels();
    if (this.hudVisible) this.show('#hud');
    this.buildHotbar();
    this.updateHotbar();
    this.updateHUD(this.game);
    this.refreshUI();
    /* Q1：不再开局一次性塞完整长文，目标与操作提示由 updateQuestHint 按进度填写 */
    $('#hint-bar').innerHTML = '';
  }

  /* ==================== Q1：按进度出现的操作提示 ====================
   * - 只显示「当前这一步」的短提示，放在右下角 #hint-bar，不挡屏幕中心准星；
   * - hint 非空时才弹一次 toast（走既有 top 72px 通道），同一目标由 quests.shown 保证只一次；
   * - 可关闭，关闭后只留一个「目标」小按钮重新展开，不强迫玩家一直看。 */
  updateQuestHint(current, hint, dismissed) {
    const bar = $('#hint-bar');
    if (!bar) return;
    bar.innerHTML = '';
    if (dismissed) {
      const reopen = el('button', 'quest-reopen', '目标');
      reopen.title = '重新显示当前目标';
      reopen.onclick = () => {
        if (this.game.quests) this.game.quests.reopen();
        this.updateQuestHint(this.game.quests ? this.game.quests.current : null, null, false);
      };
      bar.appendChild(reopen);
      return;
    }
    if (current) {
      const line = el('div', 'quest-line');
      line.innerHTML = `<b>目标 ${current.order}/${QUESTS.length}</b> ${escapeHtml(current.name)} — ${escapeHtml(current.hint)}`;
      bar.appendChild(line);
      bar.appendChild(el('div', 'quest-keys', 'E 背包 · 左键挖掘 · 右键放置 · Esc 菜单 · H 折叠'));
    } else {
      bar.appendChild(el('div', 'quest-line done', '主线目标全部完成 · 接下来想盖点什么？'));
      bar.appendChild(el('div', 'quest-keys', 'E 背包 · 左键挖掘 · 右键放置 · Esc 菜单 · H 折叠'));
    }
    const close = el('button', 'quest-close', '×');
    close.title = '关闭目标提示';
    close.onclick = () => {
      if (this.game.quests) this.game.quests.dismiss();
      this.updateQuestHint(this.game.quests ? this.game.quests.current : null, null, true);
    };
    bar.appendChild(close);
    if (hint) {
      this.toast('新目标：' + hint.name + ' — ' + hint.hint, false, 2600);
      this.questHintToasts = (this.questHintToasts || 0) + 1;
    }
  }

  /** P2：H 键把常驻目标提示收成可选层。复用 Q1 的 dismiss/reopen 状态与存档字段，
      不新建状态、不改目标链；返回 true 表示当前是「已收起」。 */
  toggleQuestHint() {
    const q = this.game && this.game.quests;
    if (!q) return null;
    if (q.dismissed) q.reopen(); else q.dismiss();
    this.updateQuestHint(q.current, null, q.dismissed);
    return q.dismissed;
  }

  /** P2 首夜引导：只读时间与背包，不改目标链 / 成就 / 存档。
      提示是常显的一行（不是弹窗），每个阶段只记一次，供断言核对「不反复打扰」。 */
  updateNightHint(time, opts = {}) {
    const box = $('#night-hint');
    if (!box) return null;
    const phase = nightPhase(time);
    const text = nightHintText(phase, opts);
    if (!this._nightHintLog) this._nightHintLog = [];
    if (phase && this._nightHintLog.indexOf(phase) < 0) this._nightHintLog.push(phase);
    box.textContent = text;
    box.classList.toggle('show', !!text);
    box.dataset.phase = phase || '';
    return { phase, text, log: this._nightHintLog.slice() };
  }

  buildHotbar() {
    const bar = $('#hotbar');
    bar.innerHTML = '';
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = el('div', 'slot');
      s.dataset.slot = i;
      s.dataset.from = 'hotbar';
      s.innerHTML = `<span class="keyhint">${i + 1}</span>`;
      bar.appendChild(s);
    }
  }

  /**
   * C：目标链高亮。只加一个描边 class，槽位底色/尺寸/内阴影一律不动（6.1a 钉死的读数不受影响）。
   * 目标本身完全沿用 Q1 的 quests.current，不新建任何任务系统。
   */
  markQuestNeeds() {
    const g = this.game;
    const cur = g && g.quests ? g.quests.current : null;
    const need = cur && Array.isArray(cur.items) ? cur.items : [];
    const nodes = document.querySelectorAll('#hotbar .slot, #inv-main .slot, #inv-hotbar .slot, #equip-grid .slot');
    let marked = 0;
    nodes.forEach(s => {
      const id = s.dataset ? s.dataset.item : '';
      const on = !!id && need.indexOf(id) >= 0;
      s.classList.toggle('quest-need', on);
      if (on) marked++;
    });
    this.questNeedMarked = marked;
    return marked;
  }

  updateHotbar() {
    if (!this.game.inventory) return;
    const inv = this.game.inventory;
    const slots = document.querySelectorAll('#hotbar .slot');
    slots.forEach((el2, i) => {
      el2.classList.toggle('selected', i === inv.selected);
      paintSlot(el2, inv.get(i));
    });
    this.markQuestNeeds();          // C：目标链高亮跟着真实背包状态走
    const h = inv.held();
    const nameEl = $('#held-name');
    if (h) {
      nameEl.textContent = itemName(h.item);
      nameEl.classList.add('show');
      clearTimeout(this._nameT);
      this._nameT = setTimeout(() => nameEl.classList.remove('show'), 1600);
    } else {
      nameEl.classList.remove('show');
    }
  }

  updateHUD(g) {
    if (!g.controller) return;
    const c = g.controller;
    // 血量
    const hearts = $('#hearts');
    const need = 10;
    if (hearts.childElementCount !== need) {
      hearts.innerHTML = '';
      for (let i = 0; i < need; i++) hearts.appendChild(pipEl('heart'));
    }
    const hp = c.health;
    [...hearts.children].forEach((p, i) => {
      const v = Math.max(0, Math.min(2, hp - i * 2));
      p.dataset.fill = v >= 2 ? 'full' : (v >= 1 ? 'half' : 'empty');
      p.innerHTML = heartSvg(v);
    });
    // D6：创造模式血条与饥饿条都要隐藏（原来漏了血条这一半）
    hearts.style.opacity = c.creative ? '0' : '1';
    // T1：护甲值（有甲才显示；数值与背包点数同源，不是另算一遍）
    const armorPts = g.inventory && g.inventory.armorPoints ? g.inventory.armorPoints() : 0;
    const armorVal = $('#armor-value');
    if (armorVal) armorVal.textContent = String(armorPts);
    const armorBar = $('#armor-bar');
    if (armorBar) {
      armorBar.classList.toggle('on', armorPts > 0);
      armorBar.dataset.points = String(armorPts);
    }
    // 饥饿（鸡腿）
    const hunger = $('#hunger');
    if (hunger.childElementCount !== 10) {
      hunger.innerHTML = '';
      for (let i = 0; i < 10; i++) hunger.appendChild(pipEl('food'));
    }
    const hg = c.hunger === undefined ? 20 : c.hunger;
    [...hunger.children].forEach((p, i) => {
      const v = Math.max(0, Math.min(2, hg - i * 2));
      p.innerHTML = foodSvg(v);
    });
    hunger.style.opacity = c.creative ? '0' : '1';
    // 呼吸（水下气泡）—— D4：以前只把整条 breath 的透明度改一下，气泡从不逐个消失。
    // 现在固定 10 个节点，每帧按剩余空气逐个显示/隐藏；出水时整条淡出但节点保留，上浮时能看到逐个恢复。
    const breath = $('#breath');
    if (breath.childElementCount !== 10) {
      breath.innerHTML = '';
      for (let i = 0; i < 10; i++) breath.appendChild(el('div', 'bubble'));
    }
    const airLeft = Math.max(0, Math.min(10, Math.ceil((c.air === undefined ? 10 : c.air) - 1e-6)));
    [...breath.children].forEach((b, i) => { b.style.display = i < airLeft ? '' : 'none'; });
    breath.style.opacity = c.eyeInWater ? (airLeft > 0 ? '1' : '0.35') : '0';
    // 水下叠加
    $('#water-overlay').classList.toggle('on', !!c.eyeInWater);

    // 调试
    const dbg = $('#debug');
    if (g.settings.showFps) {
      dbg.classList.add('on');
      const p = c.pos;
      const bt = g.interaction && g.interaction.target;
      dbg.textContent = [
        'FPS ' + g.fps + '  绘制三角 ' + Math.round((g.view.triangles || 0) / 1000) + 'k  区块 ' + g.world.chunks.size,
        '坐标  X ' + p.x.toFixed(1) + '  Y ' + p.y.toFixed(1) + '  Z ' + p.z.toFixed(1),
        '区块  ' + Math.floor(p.x / 16) + ', ' + Math.floor(p.z / 16) + '   待生成 ' + g.world.genQueue.length + '   待网格 ' + g.world.dirtyMesh.size,
        '朝向  ' + (bt ? blockName(bt.id) + ' (' + bt.x + ',' + bt.y + ',' + bt.z + ')' : '无目标'),
        '时间  ' + timeLabel(g.time) + '   生命 ' + c.health + '/20   饥饿 ' + Math.round(c.hunger) + '/20   护甲 ' + armorPts + '   模式 ' + (c.creative ? '创造' : '生存') + (c.flying ? ' · 飞行' : ''),
        '生物  ' + (g.mobs ? g.mobs.count() : 0) + '   掉落物 ' + (g.interaction ? g.interaction.drops.list.length : 0) + '   作物 ' + (g.crops ? g.crops.size : 0) +
          '   顶出 ' + (g.embedRescues || 0) + '  台阶 ' + (g._stepupEv || 0) + '  (瞬移排查用)',
        '种子  ' + g.meta.seed + '   已挖掘 ' + g.stats.mined + '  已放置 ' + g.stats.placed + '  已合成 ' + g.stats.crafted
      ].join('\n');
    } else dbg.classList.remove('on');

    this.updateSaveIndicator(g.lastSaveAt);
    this.updateHotbarSelectionOnly();
  }

  updateHotbarSelectionOnly() {
    const inv = this.game.inventory;
    if (!inv) return;
    document.querySelectorAll('#hotbar .slot').forEach((s, i) => s.classList.toggle('selected', i === inv.selected));
  }

  updateSaveIndicator(ts) {
    const e = $('#save-indicator');
    if (!ts) { e.textContent = ''; return; }
    const d = Math.round((Date.now() - ts) / 1000);
    e.textContent = d < 3 ? '已保存 ✓' : '上次保存 ' + (d < 60 ? d + ' 秒前' : Math.round(d / 60) + ' 分钟前');
  }

  flashSaved() { this.updateSaveIndicator(Date.now()); }

  setPointerLocked(locked) {
    if (!this.game.world) return;
    $('#crosshair').style.opacity = locked && this.game.state === 'playing' ? '.85' : '.25';
  }

  async saveScreenshot() {
    if (!this.game.view) return;
    try {
      const url = this.game.view.screenshot();
      const r = await this.game.storage.saveScreenshot(url, (this.game.meta ? this.game.meta.name : 'shot'));
      this.toast('截图已保存：' + (r.file || ''));
    } catch (e) { this.toast('截图失败：' + e.message, true); }
  }

  /* ==================== 背包 / 合成 ==================== */
  showInventory() { this.buildInventoryPanel(2); }
  showCrafting(size) { this.craftSize = size; this.buildInventoryPanel(size); }

  buildInventoryPanel(size) {
    const panel = $('#panel-inventory');
    panel.innerHTML = '';
    this.creativeQuery = '';
    const g = this.game;
    const wrap = el('div', 'inv-wrap');

    /* 左：合成区 + 背包 */
    const left = el('div');
    left.appendChild(el('div', 'ptitle', size === 3 ? '工作台 · 3×3 合成' : '背包 · 2×2 合成'));

    const craftLine = el('div', 'craft-line');
    const grid = el('div', 'grid-slots ' + (size === 3 ? 'g3' : 'g2'));
    grid.id = 'craft-grid';
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const s = slotEl('craft:' + (y * size + x));
        grid.appendChild(s);
      }
    }
    craftLine.appendChild(grid);
    craftLine.appendChild(el('div', 'arrow', '', ));
    const outWrap = el('div');
    outWrap.appendChild(slotEl('craft-out'));
    craftLine.appendChild(outWrap);
    left.appendChild(craftLine);

    /* T1 装备格：与 36 格背包分开；点击装备/取下复用同一套槽位事件 */
    left.appendChild(el('div', 'section-label', '装备（每点护甲减免 4%，最多 80%）'));
    const equipRow = el('div', 'grid-slots g4');
    equipRow.id = 'equip-grid';
    for (let i = 0; i < 4; i++) {
      const s = slotEl('equip:' + i);
      s.classList.add('equip-slot');
      s.dataset.label = ARMOR_SLOT_NAMES[i];
      s.title = ARMOR_SLOT_NAMES[i] + '：拿起背包里的护甲点这里穿上；点已穿的取下';
      equipRow.appendChild(s);
    }
    left.appendChild(equipRow);

    left.appendChild(el('div', 'section-label', '背包（上 3 排为储存格，下 1 排为快捷栏）'));
    const main = el('div', 'grid-slots g9');
    main.id = 'inv-main';
    for (let i = 9; i < 36; i++) main.appendChild(slotEl('inv:' + i));
    left.appendChild(main);
    const hot = el('div', 'grid-slots g9');
    hot.id = 'inv-hotbar';
    hot.style.marginTop = '10px';
    for (let i = 0; i < 9; i++) hot.appendChild(slotEl('inv:' + i));
    left.appendChild(hot);
    if (g.controller && g.controller.creative) {
      const btn = el('button', 'btn small', '打开创造物品栏');
      btn.onclick = () => this.showCreativeTab();
      left.appendChild(btn);
    }
    wrap.appendChild(left);

    /* 右：配方书 */
    const book = el('div', 'recipe-book');
    book.id = 'recipe-book';
    wrap.appendChild(book);
    panel.appendChild(wrap);
    panel.classList.remove('hidden');
    this.refreshUI();
  }

  showCreativeTab() {
    const panel = $('#panel-inventory');
    panel.innerHTML = '';
    const g = this.game;
    const wrap = el('div');

    /* E1：跨全部分类的搜索框。输入只重建下方网格，不重建输入框本身（保持焦点）。 */
    const searchRow = el('div', 'creative-search-row');
    const input = el('input', 'creative-search');
    input.id = 'inp-creative-search';
    input.type = 'search';
    input.placeholder = '搜索物品（中文名或 id，例如：铁 / compass）';
    input.value = this.creativeQuery || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', '搜索创造物品');
    input.addEventListener('input', () => {
      this.creativeQuery = input.value;
      this.renderCreativeGrid();
    });
    input.addEventListener('keydown', (e) => {
      // 搜索框里的字母/数字不得落到玩法键或 E 关闭逻辑；Esc 仍交给全局关闭界面
      if (e.code !== 'Escape') e.stopPropagation();
    });
    searchRow.appendChild(input);
    const count = el('span', 'creative-count');
    count.id = 'creative-count';
    searchRow.appendChild(count);
    wrap.appendChild(searchRow);

    const tabs = el('div', 'tabs');
    CREATIVE_TABS.forEach((t, i) => {
      const b = el('div', 'tab' + (i === this.creativeTab ? ' on' : ''), t.name);
      b.dataset.tab = String(i);
      b.onclick = () => {
        this.creativeTab = i;
        this.creativeQuery = '';
        this.showCreativeTab();
      };
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);

    const grid = el('div', 'grid-slots g9');
    grid.id = 'creative-grid';
    wrap.appendChild(grid);
    const empty = el('div', 'creative-empty');
    empty.id = 'creative-empty';
    wrap.appendChild(empty);
    wrap.appendChild(el('div', 'hint', '点击物品放入当前选中的快捷栏格子（创造模式数量无限）。搜索会跨全部分类；清空搜索恢复当前分类。'));
    const back = el('button', 'btn small primary', '返回背包');
    back.onclick = () => this.buildInventoryPanel(this.craftSize);
    wrap.appendChild(back);
    panel.appendChild(wrap);
    panel.classList.remove('hidden');
    this.renderCreativeGrid();
    if (this.creativeQuery) { try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ } }
  }

  renderCreativeGrid() {
    const grid = $('#creative-grid');
    if (!grid) return;
    const q = String(this.creativeQuery || '').trim();
    let res;
    if (q) res = filterCreativeItems(q);
    else {
      const tab = CREATIVE_TABS[this.creativeTab] || { items: [] };
      const items = tab.items.filter(id => !!ITEMS[id]);
      res = { query: '', items, count: items.length, empty: items.length === 0, mode: 'tab' };
    }
    grid.innerHTML = '';
    for (const id of res.items) {
      if (!ITEMS[id]) continue;
      const s = slotEl('give:' + id);
      paintSlot(s, { item: id, count: 0, noCount: true });
      s.title = itemName(id) + '（' + id + '）';
      grid.appendChild(s);
    }
    const count = $('#creative-count');
    if (count) {
      count.textContent = res.mode === 'filtered'
        ? (res.empty ? '没有找到匹配物品' : '找到 ' + res.count + ' 项')
        : '当前分类 ' + res.count + ' 项';
    }
    const empty = $('#creative-empty');
    if (empty) {
      empty.classList.toggle('on', res.empty);
      empty.textContent = res.empty ? '没有匹配「' + res.query + '」的物品；清空搜索或换一个中文名/id。' : '';
    }
  }

  showFurnace() {
    const panel = $('#panel-furnace');
    panel.innerHTML = '';
    const f = this.game.activeFurnace;
    if (!f) return;
    panel.appendChild(el('div', 'ptitle', '熔炉  ·  坐标 ' + f.x + ', ' + f.y + ', ' + f.z));
    const wrap = el('div', 'furnace-wrap');

    const col1 = el('div', 'furnace-col');
    col1.appendChild(slotEl('fur:input'));
    const flameBox = el('div', 'flame');
    const flameFill = el('i');
    flameBox.appendChild(flameFill);
    col1.appendChild(flameBox);
    col1.appendChild(slotEl('fur:fuel'));
    col1.appendChild(el('div', 'tiny', '燃料：煤 / 木炭 / 木板 / 原木 / 木棍'));
    wrap.appendChild(col1);

    const ar = el('div', 'arrow');
    ar.id = 'furnace-arrow';
    ar.appendChild(el('i', 'fill'));          // C：按 Furnace 真实 progress 填一条，不用假动画
    wrap.appendChild(ar);

    const col2 = el('div', 'furnace-col');
    col2.appendChild(slotEl('fur:output'));
    col2.appendChild(el('div', 'tiny', '点击产物取出<br>Shift+点击一次取全部'));
    wrap.appendChild(col2);
    panel.appendChild(wrap);

    const info = el('div', 'tiny');
    info.id = 'furnace-info';
    info.style.marginTop = '10px';
    panel.appendChild(info);

    panel.classList.remove('hidden');
    this.refreshUI();
  }

  showChest() {
    const panel = $('#panel-inventory');
    panel.innerHTML = '';
    const g = this.game;
    const chest = g.activeChest;
    if (!chest) return;
    const wrap = el('div');
    wrap.appendChild(el('div', 'ptitle', '箱子  ·  坐标 ' + chest.x + ', ' + chest.y + ', ' + chest.z));
    const grid = el('div', 'grid-slots g9');
    grid.id = 'chest-grid';
    for (let i = 0; i < 27; i++) grid.appendChild(slotEl('chest:' + i));
    wrap.appendChild(grid);
    wrap.appendChild(el('div', 'section-label', '背包（Shift+点击可在箱子与背包之间快速转移）'));
    const main = el('div', 'grid-slots g9');
    main.id = 'inv-main';
    for (let i = 9; i < 36; i++) main.appendChild(slotEl('inv:' + i));
    wrap.appendChild(main);
    const hot = el('div', 'grid-slots g9');
    hot.id = 'inv-hotbar';
    hot.style.marginTop = '10px';
    for (let i = 0; i < 9; i++) hot.appendChild(slotEl('inv:' + i));
    wrap.appendChild(hot);
    wrap.appendChild(el('div', 'hint', '箱子被破坏时里面的物品会掉在地上；关闭界面时手上拿的物品会自动放回背包。'));
    panel.appendChild(wrap);
    panel.classList.remove('hidden');
    this.refreshUI();
  }

  /* 滚动任务 6 + E2：村民交易面板。按当前村民的职业显示对应三条交易；
     按钮直接走 Game.tradeWithVillager(i)，成功/失败都由生产代码结算。 */
  showVillager() {
    const panel = $('#panel-villager');
    panel.innerHTML = '';
    const g = this.game;
    const v = g.activeVillager;
    const prof = v && (v.profession || v.def.profession);
    const trades = tradesFor(prof);
    panel.appendChild(el('div', 'ptitle', '村民 · ' + professionName(prof) +
      (v ? '  ·  生命 ' + Math.max(0, Math.round(v.hp)) : '')));
    panel.appendChild(el('div', 'hint',
      '每个村民只做自己职业的生意。右键村民可随时重新打开交易；手上有材料时按钮才可能成功，失败不会扣任何东西。'));
    const list = el('div', 'trade-list');
    trades.forEach((t, i) => {
      const have = g.inventory.countOf(t.give.item);
      const row = el('div', 'trade-row');
      const cost = el('div', 'trade-item');
      const ci = el('img', 'icon');
      ci.src = getItemIcon(t.give.item, 26);
      ci.alt = itemName(t.give.item);
      cost.appendChild(ci);
      cost.appendChild(el('span', 'trade-text', itemName(t.give.item) + ' ×' + t.give.count));
      row.appendChild(cost);

      row.appendChild(el('div', 'trade-arrow', '→'));

      const gain = el('div', 'trade-item');
      const gi = el('img', 'icon');
      gi.src = getItemIcon(t.get.item, 26);
      gi.alt = itemName(t.get.item);
      gain.appendChild(gi);
      gain.appendChild(el('span', 'trade-text', itemName(t.get.item) + ' ×' + t.get.count));
      row.appendChild(gain);

      const btn = el('button', 'btn small primary', '交易');
      btn.dataset.trade = String(i);
      btn.title = '需要 ' + itemName(t.give.item) + ' ×' + t.give.count + '（背包有 ' + have + '）';
      btn.onclick = () => g.tradeWithVillager(i);
      row.appendChild(btn);
      row.appendChild(el('span', 'tiny trade-have', '拥有 ' + have + '/' + t.give.count));
      list.appendChild(row);
    });
    panel.appendChild(list);
    const foot = prof === 'librarian'
      ? '图书管理员收购皮革，出售地图与指南针；绿宝石可以从其他村民那里换。'
      : prof === 'blacksmith'
        ? '铁匠收购煤炭与燧石，出售铁锭；绿宝石可以从其他村民那里换。'
        : '农夫收购小麦并出售面包与铁锭；小麦可以直接在村里的农田收。';
    panel.appendChild(el('div', 'hint', foot));
    panel.classList.remove('hidden');
  }

  /* 滚动任务 8：地图面板。5×5 区块，每格方块 5px；未探索保持黑色。
     数据来自 Game.mapModel()（只记录真正加载过的区块），不读外部图片。 */
  showMap() {
    const panel = $('#panel-map');
    panel.innerHTML = '';
    const g = this.game;
    const m = g.mapModel();
    panel.appendChild(el('div', 'ptitle',
      '地图 · 已探索 ' + m.explored + ' 个区块 · (' + Math.round(m.px) + ', ' + Math.round(m.pz) + ')'));
    const canvas = el('canvas', 'map-canvas');
    canvas.id = 'map-canvas';
    canvas.width = 400; canvas.height = 400;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = MAP_PALETTE[0];
    ctx.fillRect(0, 0, 400, 400);
    const oCX = m.cx - 2, oCZ = m.cz - 2;
    const PX = 5;                              // 每格方块 5px
    for (let cdz = 0; cdz < 5; cdz++) {
      for (let cdx = 0; cdx < 5; cdx++) {
        const grid = m.seen[(oCX + cdx) + ',' + (oCZ + cdz)];
        if (!grid) continue;
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const idx = parseInt(grid.charAt(z * 16 + x), 16) || 0;
            ctx.fillStyle = MAP_PALETTE[idx] || MAP_PALETTE[0];
            ctx.fillRect((cdx * 16 + x) * PX, (cdz * 16 + z) * PX, PX, PX);
          }
        }
        ctx.strokeStyle = 'rgba(0,0,0,.22)';
        ctx.strokeRect(cdx * 80 + 0.5, cdz * 80 + 0.5, 79, 79);
      }
    }
    /* 出生点红叉 */
    const sx = (m.spawn.x - oCX * 16) * PX, sz = (m.spawn.z - oCZ * 16) * PX;
    if (sx >= 4 && sx <= 396 && sz >= 4 && sz <= 396) {
      ctx.strokeStyle = '#c43a32'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx - 4, sz - 4); ctx.lineTo(sx + 4, sz + 4);
      ctx.moveTo(sx + 4, sz - 4); ctx.lineTo(sx - 4, sz + 4); ctx.stroke();
    }
    /* 玩家白色箭头（yaw=0 朝 -Z，在图上朝上） */
    const px = (m.px - oCX * 16) * PX, py = (m.pz - oCZ * 16) * PX;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-m.yaw);
    ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#111'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4, 4); ctx.lineTo(0, 2); ctx.lineTo(-4, 4); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,.82)'; ctx.font = 'bold 12px sans-serif';
    ctx.fillText('N', 6, 15);
    /* R3：已发现地点标记（金色菱形 + 名称）。数据已在 Game.mapModel() 里过滤过：
       只有「玩家真的发现过」且「所在区块已探索」的才会进来，未探索的候选点永远不会被提前画出来。 */
    const marks = m.landmarks || [];
    this.lastMapMarkers = marks;
    for (const k of marks) {
      ctx.save();
      ctx.translate(k.mx, k.my);
      ctx.fillStyle = '#f5d24a'; ctx.strokeStyle = '#20160a'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(5, 0); ctx.lineTo(0, 5); ctx.lineTo(-5, 0);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
      const label = k.name || k.type;
      ctx.font = 'bold 10px sans-serif';
      const tw = ctx.measureText(label).width;
      const lx = Math.min(Math.max(k.mx + 7, 2), 398 - tw);
      const ly = Math.min(Math.max(k.my - 4, 10), 396);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(lx - 2, ly - 9, tw + 4, 12);
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText(label, lx, ly);
    }
    panel.appendChild(canvas);
    const marksBox = el('div', 'map-markers');
    marksBox.id = 'map-markers';
    marksBox.innerHTML = marks.length
      ? marks.map(k => '<span class="map-marker">' + escapeHtml(k.name || k.type) +
        ' (' + k.x + ', ' + k.z + ')</span>').join('')
      : '<span class="map-marker none">已发现地点：0（走近荒野地点后才会出现标记）</span>';
    panel.appendChild(marksBox);
    const legend = el('div', 'map-legend');
    legend.innerHTML = '<span>白箭头 = 你</span><span>红叉 = 出生点</span>' +
      '<span>金菱 = 已发现地点</span><span>黑色 = 未探索</span>';
    panel.appendChild(legend);
    panel.appendChild(el('div', 'hint',
      '右键地图打开；走到新地方会自动记录。地点标记只有在你真的走近发现之后才会出现，' +
      '未探索的区域保持空白。地图与已发现地点都随存档保存。'));
    panel.classList.remove('hidden');
  }

  /* 指南针 HUD：只在真正游玩且手持指南针时显示；换手/开界面/暂停自动收起 */
  updateCompass(s) {
    const hud = $('#compass-hud');
    if (!hud) return;
    const on = !!(s && s.held) && this.game.state === 'playing' && !this.game.openUI;
    hud.classList.toggle('hidden', !on);
    if (!on) return;
    const needle = $('#compass-needle');
    if (needle) needle.style.transform = 'rotate(' + Number(s.deg || 0).toFixed(1) + 'deg)';
    const d = $('#compass-dist');
    if (d) d.innerHTML = s.dir + ' ' + Math.round(s.dist) + ' 格<br>' + s.target;
  }

  /* ==================== 面板交互 ==================== */
  onPanelMouseDown(e) {
    const g = this.game;
    const t = e.target.closest('.slot');
    if (!t) return;
    e.preventDefault();
    const tag = t.dataset.slot;
    const right = e.button === 2;
    const shift = e.shiftKey;
    const inv = g.inventory;

    if (tag.startsWith('give:')) {
      const item = tag.slice(5);
      if (right) inv.set(inv.selected, null);
      else inv.set(inv.selected, { item, count: 64 });
      g.sfx.play('click', { volume: 0.3 });
      this.refreshUI(); this.updateHotbar();
      return;
    }

    if (tag === 'craft-out') {
      this.takeCraft(shift ? 64 : 1);
      return;
    }

    let handled = false;
    if (tag.startsWith('inv:')) {
      const i = parseInt(tag.slice(4), 10);
      if (shift && g.openUI === 'chest') { this.moveInvToChest(i); handled = true; }
      else if (shift) { this.quickMove(i); handled = true; }
      else { inv.clickSlot(i, right); handled = true; }
    } else if (tag.startsWith('equip:')) {
      const i = parseInt(tag.slice(6), 10);
      const cur = inv.armor[i];
      if (!inv.cursor && cur) {
        inv.cursor = cur; inv.armor[i] = null; inv.emit('equip', i);
      } else if (inv.cursor) {
        if (inv.armorSlotOf(inv.cursor.item) === i) {
          inv.armor[i] = inv.cursor; inv.cursor = cur || null; inv.emit('equip', i);
        } else {
          this.toast('这件装备穿不到这个位置', true);
        }
      }
      g.sfx.play('click', { volume: 0.18, rate: 1.2 });
      this.refreshUI(); this.updateHotbar(); this.updateHUD(g);
      return;
    } else if (tag.startsWith('craft:')) {
      const i = parseInt(tag.slice(6), 10);
      const grid = g.activeCraft;
      const cur = grid.get(i);
      if (!inv.cursor && cur) { inv.cursor = cur; grid.set(i, null); }
      else if (inv.cursor && !cur) {
        const take = right ? 1 : inv.cursor.count;
        grid.set(i, { item: inv.cursor.item, count: Math.min(take, maxStack(inv.cursor.item)) });
        inv.cursor.count -= take;
        if (inv.cursor.count <= 0) inv.cursor = null;
      } else if (inv.cursor && cur) {
        if (cur.item === inv.cursor.item && !cur.dur) {
          const max = maxStack(cur.item);
          const can = Math.min(max, cur.count + inv.cursor.count);
          cur.count = can;
          if (right) { inv.cursor.count -= 1; if (inv.cursor.count <= 0) inv.cursor = null; }
          else { inv.cursor = null; }
          grid.set(i, cur);
        } else { grid.set(i, inv.cursor); inv.cursor = cur; }
      }
      g.sfx.play('click', { volume: 0.18, rate: 1.2 });
      this.refreshUI();
      return;
    } else if (tag.startsWith('chest:')) {
      const i = parseInt(tag.slice(6), 10);
      const slots = g.activeChest && g.activeChest.slots;
      if (!slots) return;
      const cur = slots[i];
      if (shift) {
        // 箱子 → 背包
        const stack = cur;
        if (stack) {
          const left = inv.add(stack.item, stack.count);
          slots[i] = left > 0 ? { item: stack.item, count: left } : null;
        }
      } else if (!inv.cursor && cur) {
        inv.cursor = cur; slots[i] = null;
      } else if (inv.cursor && !cur) {
        const take = right ? 1 : inv.cursor.count;
        slots[i] = { item: inv.cursor.item, count: Math.min(take, maxStack(inv.cursor.item)) };
        inv.cursor.count -= take;
        if (inv.cursor.count <= 0) inv.cursor = null;
      } else if (inv.cursor && cur) {
        if (cur.item === inv.cursor.item && !cur.dur && !inv.cursor.dur) {
          const max = maxStack(cur.item);
          const can = Math.min(max, cur.count + inv.cursor.count);
          const rest = cur.count + inv.cursor.count - can;
          cur.count = can;
          if (right) { inv.cursor.count -= 1; if (inv.cursor.count <= 0) inv.cursor = null; }
          else inv.cursor = null;
        } else { slots[i] = inv.cursor; inv.cursor = cur; }
      }
      g.sfx.play('click', { volume: 0.18, rate: 1.2 });
      this.refreshUI();
      return;
    } else if (tag.startsWith('fur:')) {
      const slot = tag.slice(4);
      if (shift && slot === 'output') { this.takeAllFromFurnace(); return; }
      g.activeFurnace.clickSlot(slot, right, inv);
      g.sfx.play('click', { volume: 0.18, rate: 1.2 });
      this.refreshUI();
      return;
    }

    if (!handled && inv.cursor) { /* 已在别处处理 */ }
    this.renderCursor();
    this.refreshInventoryGrids();
    this.updateHotbar();
    g.sfx.play('click', { volume: 0.18, rate: 1.2 });
  }

  moveInvToChest(index) {
    const g = this.game, inv = g.inventory;
    const s = inv.get(index);
    if (!s || !g.activeChest) return;
    const slots = g.activeChest.slots;
    const max = maxStack(s.item);
    // 先合堆
    for (let i = 0; i < 27 && s.count > 0; i++) {
      const t = slots[i];
      if (t && t.item === s.item && !t.dur && t.count < max) {
        const add = Math.min(max - t.count, s.count);
        t.count += add; s.count -= add;
      }
    }
    // 再放空格
    for (let i = 0; i < 27 && s.count > 0; i++) {
      if (!slots[i]) {
        const add = Math.min(max, s.count);
        slots[i] = { item: s.item, count: add };
        s.count -= add;
      }
    }
    if (s.count <= 0) inv.set(index, null);
    this.refreshChestGrid();
    this.refreshInventoryGrids();
    this.updateHotbar();
  }

  quickMove(invIndex) {
    const inv = this.game.inventory;
    const s = inv.get(invIndex);
    if (!s) return;
    // T1：Shift+点击护甲 = 直接穿到对应装备格（换下的旧装备回到这一格）
    if (inv.armorSlotOf(s.item) >= 0) {
      if (inv.equipFrom(invIndex)) {
        this.refreshInventoryGrids();
        this.updateHotbar();
        this.updateHUD(this.game);
        return;
      }
    }
    const from = invIndex < 9 ? 'hot' : 'main';
    const range = from === 'hot' ? [9, 36] : [0, 9];
    const max = maxStack(s.item);
    // 先合堆
    for (let i = range[0]; i < range[1] && s.count > 0; i++) {
      const t = inv.get(i);
      if (t && t.item === s.item && !t.dur && t.count < max) {
        const add = Math.min(max - t.count, s.count);
        t.count += add; s.count -= add;
        if (s.count <= 0) inv.set(invIndex, null);
      }
    }
    // 再放空格
    for (let i = range[0]; i < range[1] && s.count > 0; i++) {
      if (!inv.get(i)) {
        const add = Math.min(max, s.count);
        inv.set(i, { item: s.item, count: add });
        s.count -= add;
        if (s.count <= 0) inv.set(invIndex, null);
      }
    }
    if (s.count <= 0) inv.set(invIndex, null);
    this.refreshInventoryGrids();
    this.updateHotbar();
  }

  takeCraft(maxTimes) {
    const g = this.game;
    const grid = g.activeCraft;
    const res = grid.result();
    if (!res) return;
    let times = Math.min(maxTimes, grid.craftTimes());
    if (times <= 0) return;
    let madeAny = false;
    for (let k = 0; k < times; k++) {
      const made = grid.craft(1);
      if (!made.length) break;
      const m = made[0];
      const left = g.inventory.add(m.item, m.count);
      if (left > 0) {
        // 背包满：把多余的回退为掉落
        const drop = g.interaction && g.interaction.drops;
        if (drop) drop.spawn(m.item, left, g.controller.pos.x, g.controller.pos.y, g.controller.pos.z, false);
      }
      g.stats.crafted++;
      if (g.onItemCrafted) g.onItemCrafted(m.item, m.count);   // T3 制作类成就走真实合成结果
      madeAny = true;
    }
    if (madeAny) {
      g.sfx.play('craft', { volume: 0.6 });
      this.refreshUI();
      this.updateHotbar();
    }
  }

  takeAllFromFurnace() {
    const f = this.game.activeFurnace;
    if (!f || !f.output) return;
    const left = this.game.inventory.add(f.output.item, f.output.count);
    if (left <= 0) f.output = null; else f.output.count = left;
    this.refreshUI();
  }

  /* ==================== 刷新 ==================== */
  refreshUI() {
    if (!this.game.inventory) return;
    const g = this.game;
    if (!$('#panel-inventory').classList.contains('hidden')) {
      this.refreshInventoryGrids();
      if (g.openUI === 'chest') this.refreshChestGrid();
      else this.refreshRecipeBook();
    }
    if (!$('#panel-furnace').classList.contains('hidden')) this.refreshFurnace();
    this.renderCursor();
    this.updateHotbar();
  }

  refreshChestGrid() {
    const g = this.game;
    if (!g.activeChest) return;
    document.querySelectorAll('#chest-grid .slot').forEach((s, i) => {
      paintSlot(s, g.activeChest.slots[i] || null);
    });
  }

  refreshInventoryGrids() {
    const g = this.game;
    const size = g.activeCraft.size;
    document.querySelectorAll('#craft-grid .slot').forEach((s, i) => {
      if (i < size * size) paintSlot(s, g.activeCraft.get(i));
    });
    const out = document.querySelector('[data-slot="craft-out"]');
    if (out) {
      const r = g.activeCraft.result();
      paintSlot(out, r ? { item: r.item, count: r.count } : null);
      const arrow = out.previousElementSibling;
      if (arrow && arrow.classList.contains('arrow')) arrow.classList.toggle('hot', !!r);
    }
    document.querySelectorAll('#inv-main .slot, #inv-hotbar .slot').forEach(s => {
      const i = parseInt(s.dataset.slot.slice(4), 10);
      paintSlot(s, g.inventory.get(i));
    });
    document.querySelectorAll('#equip-grid .slot').forEach(s => {
      const i = parseInt(s.dataset.slot.slice(6), 10);
      paintSlot(s, g.inventory.armor[i] || null);
    });
    this.markQuestNeeds();          // C：打开背包就能看到当前目标缺的那件被圈出来
  }

  refreshRecipeBook() {
    const book = $('#recipe-book');
    if (!book) return;
    const g = this.game;
    const inv = g.inventory;
    book.innerHTML = '';
    const have = Object.create(null);
    for (const s of inv.slots) if (s) have[s.item] = (have[s.item] || 0) + s.count;
    for (const s of g.activeCraft.slots) if (s) have[s.item] = (have[s.item] || 0) + s.count;
    /* 本轮 A4：能否一键做出来，用「按格分配」的同一份算法判断。
       旧写法 `alts.some(a => have[a] >= n.count)` 要求单个候选够量，
       于是橡木板 2 + 桦木板 2 的背包在配方书里连工作台都不会亮。 */
    const haveFn = (id) => have[id] || 0;
    const canMake = (r) => allocateForCraft(r, haveFn).ok;
    const okList = RECIPES.filter(canMake);

    /* Q1「下一步建议」：独立容器 + 独立 class，不占用 .recipe-item，
       所以既有「配方书里有木板配方」「列出可用配方」等断言的读数完全不变。
       这里只做「提示 + 自动摆料」，绝不自动合成、不改任何配方数值。 */
    const cur = g.quests ? g.quests.current : null;
    const picks = suggestRecipes(RECIPES, canMake, cur ? cur.id : null, 3);
    if (picks.length) {
      const box = el('div', 'quest-suggestions');
      box.id = 'quest-suggestions';
      /* P2：建议区可折叠，默认展开。折叠只隐藏建议行，#quest-suggestions 节点仍在，
         .recipe-item 数量与 Q1.4 / Q1.12 / 6.4a 的查询一个都不受影响。 */
      const toggle = el('button', 'quest-suggestions-toggle', this.questSuggestionsCollapsed ? '展开' : '收起');
      toggle.title = '收起 / 展开下一步建议';
      toggle.onclick = (e) => {
        e.stopPropagation();
        this.questSuggestionsCollapsed = !this.questSuggestionsCollapsed;
        this.refreshRecipeBook();
      };
      box.appendChild(toggle);
      box.appendChild(el('div', 'section-label', '下一步建议' + (cur ? ' · ' + escapeHtml(cur.name) : '')));
      for (const p of picks) {
        const r = p.recipe;
        const row = el('div', 'quest-suggestion' +
          (p.reason === 'current' ? ' current' : '') + (p.canMake ? '' : ' not-ready'));
        row.innerHTML = `<img src="${getItemIcon(r.result.item, 32)}" alt="">` +
          `<span class="rn">${itemName(r.result.item)} ×${r.result.count}</span>` +
          `<em>${p.reason === 'current' ? '当前目标' : p.canMake ? '材料够' : '材料不足'}</em>`;
        row.onclick = () => this.applyRecipeRow(r);
        box.appendChild(row);
      }
      if (this.questSuggestionsCollapsed) box.classList.add('collapsed');
      box.dataset.collapsed = this.questSuggestionsCollapsed ? '1' : '0';
      book.appendChild(box);
    }

    book.appendChild(el('div', 'section-label', '可制作的配方（点击自动摆放）'));
    if (!okList.length) {
      book.appendChild(el('div', 'hint', '当前材料还做不出新东西。<br>第一步：对着树干按住<b>左键</b>挖几段原木，<br>然后按 <b>E</b> 打开背包，在 2×2 格里放 1 个原木得到木板。'));
      return;
    }
    for (const r of okList.slice(0, 48)) {
      const row = el('div', 'recipe-item');
      row.innerHTML = `<img src="${getItemIcon(r.result.item, 32)}" alt=""><span class="rn">${itemName(r.result.item)} ×${r.result.count}</span>`;
      row.onclick = () => this.applyRecipeRow(r);
      book.appendChild(row);
    }
  }

  /** Q1：建议区与原有配方行走同一条自动摆料路径，行为与改前完全一致 */
  applyRecipeRow(r) {
    const g = this.game;
    if (g.activeCraft.size === 2 && r.type === 'shaped' && recipeTooBig(r)) { this.toast('这个配方需要工作台（3×3）', true); return; }
    g.activeCraft.clear();
    if (!placeRecipe(g.activeCraft, r, g.inventory)) { this.toast('材料不足', true); g.activeCraft.clear(); }
    g.sfx.play('click', { volume: 0.25 });
    this.refreshUI();
  }

  refreshFurnace() {
    const g = this.game;
    const f = g.activeFurnace;
    if (!f) return;
    document.querySelectorAll('#panel-furnace .slot').forEach(s => {
      const k = s.dataset.slot.slice(4);
      paintSlot(s, f[k] ? { item: f[k].item, count: f[k].count } : null);
    });
    const flame = $('#panel-furnace .flame i');
    if (flame) {
      const p = f.burnTotal > 0 ? Math.max(0, f.burnTime / f.burnTotal) : 0;
      flame.style.height = Math.round(p * 100) + '%';
    }
    const arrow = $('#furnace-arrow');
    if (arrow) arrow.classList.toggle('hot', f.canSmelt() && f.isBurning);
    /* C：熔炼进度用 Furnace 自己的 progress，不另起计时器、不做假动画 */
    const res0 = f.currentResult();
    const total = res0 ? res0.time : (f.recipeTime || 8);
    const frac = total > 0 ? Math.max(0, Math.min(1, (f.progress || 0) / total)) : 0;
    const fill = arrow ? arrow.querySelector('.fill') : null;
    if (fill) fill.style.width = Math.round(frac * 100) + '%';
    if (arrow) arrow.dataset.progress = frac.toFixed(3);
    const info = $('#furnace-info');
    if (info) {
      const r = f.currentResult();
      const pctTxt = r && frac > 0.001 ? '<span class="fpct"> · 进度 ' + Math.round(frac * 100) +
        '%（还需约 ' + Math.max(0, Math.ceil(total - (f.progress || 0))) + ' 秒）</span>' : '';
      info.innerHTML = r
        ? `正在熔炼：${itemName(f.input.item)} → ${itemName(r.item)}（${f.isBurning ? '燃烧中' : '需要燃料'}）` + pctTxt
        : '把可熔炼物品放在上方格子（铁矿石 / 金矿石 / 沙子 / 圆石 / 原木 / 生肉），下方放燃料。';
    }
  }

  renderCursor() {
    const inv = this.game.inventory;
    const c = $('#cursor-stack');
    if (!inv || !inv.cursor) { c.classList.add('hidden'); c.innerHTML = ''; return; }
    c.classList.remove('hidden');
    c.innerHTML = `<img src="${getItemIcon(inv.cursor.item, 40)}" alt="">` +
      (inv.cursor.count > 1 ? `<span class="count">${inv.cursor.count}</span>` : '');
  }

  applySettings(s) { if (s.showFps !== undefined) this.updateHUD(this.game); }
  async saveSettings(s) { await this.game.storage.saveSettings(s); }
}

/* ==================== 辅助 ==================== */
function slotEl(tag) {
  const s = el('div', 'slot');
  s.dataset.slot = tag;
  return s;
}

function paintSlot(node, stack) {
  if (!node) return;
  const old = node.querySelector('.keyhint');
  node.innerHTML = '';
  if (old) node.appendChild(old);
  if (!stack) {
    /* C：空格子把诊断字段清干净，tooltip 才不会拿着上一件的耐久不放 */
    if (node.dataset) { delete node.dataset.item; delete node.dataset.dur; }
    return;
  }
  if (node.dataset) {
    node.dataset.item = stack.item;
    if (typeof stack.dur === 'number') node.dataset.dur = String(stack.dur);
    else delete node.dataset.dur;
  }
  const img = document.createElement('img');
  img.className = 'icon';
  img.src = getItemIcon(stack.item, 40);
  img.draggable = false;
  node.appendChild(img);
  if (!stack.noCount && stack.count > 1) {
    const c = el('span', 'count', String(stack.count));
    node.appendChild(c);
  }
  const it = getItem(stack.item);
  if (it && it.durability && stack.dur !== undefined) {
    const pct = Math.max(0, Math.min(1, stack.dur / it.durability));
    const bar = el('div', 'dur', '');
    const i = el('i');
    i.style.width = (pct * 100) + '%';
    i.style.background = pct > 0.5 ? '#4cd44c' : pct > 0.22 ? '#e8d33a' : '#d94b4b';
    bar.appendChild(i);
    node.appendChild(bar);
  }
  node.title = itemName(stack.item) + (it && it.durability && stack.dur !== undefined ? `（耐久 ${stack.dur}/${it.durability}）` : '');
}

function foodSvg(v) {
  const main = v >= 1 ? '#c98a3a' : '#3a3a3a';
  const bone = v >= 1 ? '#f2e6cf' : '#4a4a4a';
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <ellipse cx="9" cy="7" rx="4.6" ry="3.6" fill="${main}" stroke="#2b1a0c" stroke-width="1.1" transform="rotate(-25 9 7)"/>
    <path d="M4.6 10.4 l-2.4 2.4 M3.2 9.2 l-2.2 2.2" stroke="${bone}" stroke-width="1.8" stroke-linecap="round"/>
    ${v >= 1 && v < 2 ? `<path d="M9 3.4 a4.6 3.6 0 0 0 0 7.2 z" fill="#c98a3a" opacity=".95"/>` : ''}
    ${v >= 2 ? `<path d="M7.4 5.2 l1.6 -1" stroke="#f0c98a" stroke-width="1.1" fill="none"/>` : ''}
  </svg>`;
}

function pipEl(kind) {
  const d = el('div', 'pip');
  d.dataset.kind = kind;
  return d;
}

function heartSvg(fill) {
  const color = fill >= 1 ? '#e0424b' : '#3a3a3a';
  const half = fill >= 1 && fill < 2;
  return `<svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 14 L2 8.4 A3.4 3.4 0 0 1 8 4.2 A3.4 3.4 0 0 1 14 8.4 Z" fill="${color}" stroke="#1b1b1b" stroke-width="1.2"/>
    ${half ? `<path d="M8 14 L2 8.4 A3.4 3.4 0 0 1 8 4.2 Z" fill="#e0424b" stroke="#1b1b1b" stroke-width="1.2"/>` : ''}
    ${fill >= 2 ? `<path d="M5.4 6.2 l1.2 -1.2" stroke="#ff9aa0" stroke-width="1.2" fill="none"/>` : ''}
  </svg>`;
}

/* 配方需求展示已改为 recipes.js 的 allocateForCraft（按格分配，见本轮 A4）。
   旧 recipeNeeds 按「字符」聚合、要求单候选够量，是 2+2 混合木板失败的根源之一。 */

function recipeTooBig(r) {
  const rows = r.pattern;
  const w = Math.max(...rows.map(x => x.length));
  return rows.length > 2 || w > 2;
}

function gridFlat(grid) {
  const arr = [];
  if (grid) for (const row of grid) for (const c of row) if (c) arr.push(c);
  return { count: (x) => arr.filter(a => a === x).length };
}

function placeRecipe(grid, r, inv) {
  if (!inv) return false;
  const size = grid.size;
  if (r.type === 'shapeless') {
    if (r.inputs.length > size * size) return false;
    const need = Object.create(null);
    const choice = [];
    const poolCount = Object.create(null);
    for (const inp of r.inputs) {
      const alts = expandIngredient(inp) || [inp];
      const pick = alts.find(a => (poolCount[a] = inv.countOf(a) - (need[a] || 0)) > 0);
      if (!pick) return false;
      need[pick] = (need[pick] || 0) + 1;
      choice.push(pick);
    }
    for (const [it, n] of Object.entries(need)) if (inv.countOf(it) < n) return false;
    for (const [it, n] of Object.entries(need)) inv.remove(it, n);
    choice.forEach((it, i) => { grid.slots[i] = { item: it, count: 1 }; });
    return true;
  }
  // shaped：按格分配（标签材料可以混着用），确认材料充足再扣
  const alloc = allocateForCraft(r, (id) => inv.countOf(id));
  if (!alloc.ok) return false;
  for (const [it, n] of Object.entries(alloc.need)) inv.remove(it, n);
  {
    /* alloc.slots 已经是「行优先、只含非空格」的顺序，直接对位落格 */
    let k = 0;
    for (let y = 0; y < r.pattern.length && y < size; y++) {
      const row = r.pattern[y];
      for (let x = 0; x < row.length && x < size; x++) {
        const ch = row[x];
        if (ch === ' ') continue;
        const slot = alloc.slots[k++];
        if (!slot) continue;
        grid.slots[y * size + x] = { item: slot.item, count: 1 };
      }
    }
  }
  return true;
}

function timeLabel(t) {
  const hh = Math.floor(((t + 0.25) % 1) * 24);
  const mm = Math.floor(((((t + 0.25) % 1) * 24) % 1) * 60);
  const period = (hh >= 6 && hh < 18) ? '白天' : (hh >= 18 && hh < 20 || hh < 5 ? '夜晚' : '黄昏/黎明');
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ' ' + period;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
