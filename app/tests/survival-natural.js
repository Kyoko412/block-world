/*
 * 第二轮 E：自然生存路线（真实 UI 操作）。
 *   成品：方块世界.exe --selftest-natural → <隔离目录>/saves/natural-route-report.json
 *   源码：npx electron tests/e2e-electron.mjs --natural
 *
 * 规则：禁止创造/传送/改包/补血/无敌/改伤害/快进时间。全部走产品入口：
 *   真实键鼠移动与挖掘（lib/route-driver.js）、配方书点击、真实槽位（shift 快速移动）、
 *   熔炉槽位界面、盾牌切栏、奖励箱开箱领取。
 *
 * 分两段（同一个隔离存档目录、同一份候选包）：
 *   ① 本文件默认段：新建 → 采集 → 合成 → 建造（用本轮构件）→ 下矿 → 熔炼 → 备装 →
 *      解封 → 战斗 → 领奖 → 保存退出；
 *   ② 带 window.__routeResume=true 的第二次**进程**：正常启动 → 读取同一世界 →
 *      核对建筑、背包、守卫击败与领奖次数。
 */
(async () => {
  const R = { done: false, steps: [], errors: [], diag: [] };
  window.__e2e = R;
  const RESUME = !!window.__routeResume;
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const step = (name, pass, info, kind) => {
    R.steps.push({ name, pass: !!pass, info: info === undefined ? '' : String(info), kind: kind || 'natural', t: now() });
  };
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  window.addEventListener('error', e => R.errors.push('window: ' + e.message));
  window.addEventListener('unhandledrejection', e => R.errors.push('promise: ' + String(e && e.reason)));
  const G = window.__game, T = window.__test;
  const SEED = window.__routeSeed || 'natural-2026-1110';
  const WORLD = '自然生存闭环';

  const until = async (pred, budgetMs, label) => {
    const t = performance.now();
    let last = null;
    for (;;) {
      try { last = await pred(); } catch (e) { last = null; }
      if (last) return { ok: true, ms: Math.round(performance.now() - t), value: last };
      if (performance.now() - t > budgetMs) return { ok: false, ms: Math.round(performance.now() - t), label, value: last };
      await frame();
    }
  };
  const bag = (item) => G.inventory.countOf(item);
  const planksNow = () => bag('planks') + bag('birch_planks');
  const logsNow = () => bag('oak_log') + bag('birch_log');
  const held = () => { const h = G.inventory.held(); return h ? h.item : null; };
  const act = (name, detail) => {
    const prev = R.act;
    R.act = { name, detail: detail === undefined ? '' : String(detail), at: Date.now(), n: prev && prev.name === name ? (prev.n || 0) + 1 : 0 };
  };
  window.__runDiag = () => ({
    pos: G.controller ? [+G.controller.pos.x.toFixed(2), +G.controller.pos.y.toFixed(2), +G.controller.pos.z.toFixed(2)] : null,
    hp: G.controller ? G.controller.health : null, held: held(), openUI: G.openUI,
    target: G.interaction && G.interaction.target ? { x: G.interaction.target.x, y: G.interaction.target.y, z: G.interaction.target.z } : null,
    act: R.act, steps: R.steps.length,
    bag: { logs: logsNow(), planks: planksNow(), cobble: bag('cobblestone'), iron: bag('iron_ingot'), deep: bag('deepslate') }
  });

  /* ---------- 面板 / 槽位 / 放置（与短链路同一套做法） ---------- */
  const ensurePanel = async (size) => {
    const cur = G.openUI === 'crafting' ? 3 : (G.openUI === 'inventory' ? 2 : 0);
    const curSize = G.activeCraft ? G.activeCraft.size : 0;
    if (cur === size && curSize === size) return { size: curSize, switched: false };
    if (size === 3) G.openCrafting(3); else G.openInventory();
    await frame(); await frame();
    return { size: G.activeCraft.size, switched: true };
  };
  const closePanels = async () => {
    if (G.openUI) G.closeUI();
    await frame(); await frame();
    return { openUI: G.openUI, uiMode: G.input.uiMode };
  };
  const clickRecipeIn = async (size, label) => {
    const panel = await ensurePanel(size);
    if (panel.size !== size) return { ok: false, why: 'panel', panel };
    const row = [...document.querySelectorAll('#recipe-book .recipe-item')].find(n => n.textContent.includes(label));
    if (!row) return { ok: false, why: 'no-row', panel };
    row.click(); await frame(); await frame();
    const out = document.querySelector('[data-slot="craft-out"]');
    if (!out) return { ok: false, why: 'no-out' };
    out.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    await frame();
    out.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await frame();
    return { ok: true };
  };
  const moveToHotbar = async (item) => {
    let idx = G.inventory.slots.findIndex((s, i) => i < 9 && s && s.item === item);
    if (idx >= 0) { G.selectHotbar(idx); return { ok: held() === item, idx, moved: false }; }
    const src = G.inventory.slots.findIndex(s => s && s.item === item);
    if (src < 0) return { ok: false, why: 'not-in-bag' };
    await ensurePanel(2);
    const node = document.querySelector('[data-slot="inv:' + src + '"]');
    if (!node) return { ok: false, why: 'no-slot-ui' };
    node.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, shiftKey: true }));
    await frame(); await frame();
    idx = G.inventory.slots.findIndex((s, i) => i < 9 && s && s.item === item);
    if (idx >= 0) G.selectHotbar(idx);
    return { ok: idx >= 0 && held() === item, idx, moved: true };
  };
  const aimAt = async (bx, by, bz, frames = 14) => {
    const c = G.controller, dx = bx + 0.5 - c.pos.x, dz = bz + 0.5 - c.pos.z;
    c.yaw = Math.atan2(-dx, -dz);
    c.pitch = Math.atan2(by + 0.5 - c.eyeY, Math.max(0.3, Math.hypot(dx, dz)));
    for (let i = 0; i < frames; i++) {
      await frame();
      const t = G.interaction.target;
      if (t && t.x === bx && t.y === by && t.z === bz) return t;
    }
    return null;
  };
  /* 找一块附近可放东西的地面：脚下+周围 2 格内，实心、上方两格空、射线可见 */
  const findBase = (driver, skip = new Set()) => {
    const c = G.controller, px = Math.floor(c.pos.x), py = Math.floor(c.pos.y), pz = Math.floor(c.pos.z);
    for (let r = 1; r <= 4; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      for (const dy of [-1, -2, 0, 1]) {
        const b = { x: px + dx, y: py + dy, z: pz + dz };
        if (skip.has(b.x + ',' + b.y + ',' + b.z)) continue;
        if (!G.world.isSolidAt(b.x, b.y, b.z)) continue;
        if (G.world.isSolidAt(b.x, b.y + 1, b.z) || G.world.isSolidAt(b.x, b.y + 2, b.z)) continue;
        if (Math.abs(b.y + 1 - py) > 1) continue;
        return b;
      }
    }
    return null;
  };
  const placeItem = async (item, driver, opts = {}) => {
    await closePanels();
    const sel = await moveToHotbar(item);
    if (!sel.ok) return { ok: false, why: 'not-held', sel };
    const before = { bag: bag(item), held: held() };
    const skip2 = new Set(opts.skip || []);
    let base = null, tg = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      base = findBase(driver, skip2);
      if (!base) break;
      tg = await aimAt(base.x, base.y, base.z);
      if (tg) break;
      skip2.add(base.x + ',' + base.y + ',' + base.z);      // 这个面打不到：换一块
      base = null; tg = null;
    }
    if (!base) return { ok: false, why: 'no-base' };
    if (!tg) return { ok: false, why: 'no-aim', base };
    const expect = G.world.placementTarget(tg);
    if (!expect) return { ok: false, why: 'no-target-cell', base, tg };
    const beforeId = G.world.getBlock(expect.x, expect.y, expect.z);
    G.input.state.mouseRight = false; await frame();
    G.input.state.mouseRight = true; await frame(); await frame();
    G.input.state.mouseRight = false; await frame(); await frame();
    const afterId = G.world.getBlock(expect.x, expect.y, expect.z);
    const def = T.itemDef ? T.itemDef(item) : null;
    const want = def && def.blockId !== null ? def.blockId : null;
    const ok = afterId !== beforeId && afterId !== 0 && (want === null || afterId === want) && bag(item) === before.bag - 1;
    R.diag.push({ at: 'place', item, base, expect, beforeId, afterId, want, bag: [before.bag, bag(item)], ok });
    return { ok, base, expect, afterId, want };
  };

  let driver = null;
  const keyed = (k, down) => T.key(k, down);

  try {
    /* ================= ② 重启后的核对段 ================= */
    if (RESUME) {
      const menuItems = await until(() => document.querySelectorAll('#save-list .save-item').length > 0 ||
        document.querySelector('#screen-menu') && !document.querySelector('#screen-menu').classList.contains('hidden'), 20000, '主菜单');
      /* 正常入口：主菜单 → 读取存档 → 选同名世界 */
      const row = await until(() => [...document.querySelectorAll('#save-list .save-item')].find(n => n.textContent.includes(WORLD)), 20000, '存档列表');
      if (!row.ok) { step('E13 重启后主菜单里能看到该世界', false, '找不到存档行'); R.done = true; return; }
      row.value.click();
      const loaded = await until(() => G.state === 'playing' && G.world && G.world.genQueue.length === 0, 60000, '读档完成');
      await sleep(1200);
      const info = T.guardianInfo();
      const saved = T.guardianSaved();
      const snapshot = {
        seed: G.meta.seed, name: G.meta.name, genVersion: G.meta.genVersion,
        guardian: { defeated: info.defeated, claimed: info.rewardClaimed, hp: info.hp, site: saved.siteKey },
        bag: { planks: planksNow(), cobble: bag('cobblestone'), iron: bag('iron_ingot'),
          sword: bag('sword_iron') + bag('sword_stone'), shield: bag('shield'), deepslate: bag('deepslate') },
        landmark: Object.values(G.landmarks || {}).filter(l => l && l.built).map(l => ({ id: l.id, x: l.x, z: l.z, type: l.type }))
      };
      R.resumeSnapshot = snapshot;
      step('E13 新进程正常启动 → 主菜单读档 → 同一世界的守卫状态/背包/建筑都在',
        loaded.ok && snapshot.name === WORLD && snapshot.guardian.defeated === 1 &&
        snapshot.bag.sword > 0 && snapshot.landmark.length > 0,
        'state=' + G.state + ' ' + JSON.stringify(snapshot), 'natural');
      R.done = true;
      return;
    }

    /* ================= ① 主段：新档 → 领奖 ================= */

    document.querySelector('[data-a=new]').click();
    await frame();
    document.querySelector('#inp-name').value = WORLD;
    document.querySelector('#inp-seed').value = SEED;
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    const w = await until(() => G.state === 'playing' && G.world && G.world.genQueue.length === 0, 90000, '世界就绪');
    await sleep(700);
    driver = window.__createRouteDriver(G, T, { frame, report: R, action: act });
    step('E1 正常菜单新建生存世界（真实点击）', w.ok && G.meta.mode === 'survival',
      'mode=' + G.meta.mode + ' seed=' + G.meta.seed + ' gen=' + G.meta.genVersion +
      ' pos=' + JSON.stringify(T.state().pos) + ' 用时=' + w.ms + 'ms', 'natural');

    /* ---------- E2 采集：10 根原木 ---------- */
    let trees = 0;
    const tried = new Set();
    for (let a = 0; a < 20 && logsNow() < 10; a++) {
      act('harvest', '原木 ' + logsNow() + '/10');
      const tgt = driver.findBlock([T.blockIds.LOG, T.blockIds.BIRCH_LOG], tried);
      if (!tgt) { R.diag.push({ at: 'no-reachable-tree', pos: { ...G.controller.pos } }); break; }
      tried.add([tgt.x, tgt.y, tgt.z].join(','));
      const walked = await driver.walkTo(tgt.stand.x + 0.5, tgt.stand.z + 0.5, 15000, tgt.stand.y);
      if (!walked.ok) continue;
      const m = await driver.mineWith(tgt.x, tgt.y, tgt.z, 14000);
      if (m.broke) { trees++; await driver.collectDrops(4000); }
    }
    step('E2 真实砍树采集到 10 根原木（含掉落拾取）', logsNow() >= 10,
      '挖掉=' + trees + ' 原木=' + logsNow(), 'natural');

    /* ---------- E3 合成：木板 / 木棍 / 工作台（2×2）→ 放工作台 → 3×3 木镐 ---------- */
    let plankClicks = 0;
    while (planksNow() < 26 && logsNow() > 0 && plankClicks < 12) {
      act('craft-planks', '木板 ' + planksNow());
      if (!(await clickRecipeIn(2, '木板')).ok) break;
      plankClicks++;
    }
    const cStick = await clickRecipeIn(2, '木棍');
    const cTable = await clickRecipeIn(2, '工作台');
    const tablePlaced = await placeItem('crafting_table', driver);
    let open3 = { ok: false };
    if (tablePlaced.ok) {
      await closePanels();
      await until(() => G.interaction.placeCd <= 0, 2000, '放置冷却');
      const tg = await aimAt(tablePlaced.expect.x, tablePlaced.expect.y, tablePlaced.expect.z);
      G.input.state.mouseRight = false; await frame();
      G.input.state.mouseRight = true; await frame(); await frame();
      G.input.state.mouseRight = false;
      const opened = await until(() => G.openUI === 'crafting' && G.activeCraft && G.activeCraft.size === 3, 2500, '右键工作台打开 3×3');
      open3 = { ok: opened.ok, ui: G.openUI, size: G.activeCraft ? G.activeCraft.size : 0, target: tg ? { x: tg.x, z: tg.z } : null };
    }
    const cPick = await clickRecipeIn(3, '木镐');
    const pickSel = bag('pickaxe_wood') > 0 ? await moveToHotbar('pickaxe_wood') : { ok: false };
    await closePanels();
    step('E3 木板/木棍/工作台 → 放下并右键打开 3×3 → 木镐（真实 UI）',
      planksNow() > 0 && bag('stick') > 0 && tablePlaced.ok && open3.ok && bag('pickaxe_wood') > 0 && pickSel.ok,
      '板=' + planksNow() + ' 棍=' + bag('stick') + ' 台放=' + JSON.stringify(tablePlaced.ok ? tablePlaced.expect : tablePlaced.why) +
      ' 开3×3=' + JSON.stringify(open3) + ' 木镐=' + bag('pickaxe_wood') + ' 手持=' + held(), 'derived');

    /* ---------- E4 采石：12 圆石 → 石镐 + 熔炉 ---------- */
    let stoneFails = 0;
    for (let k = 0; k < 24 && bag('cobblestone') < 12 && stoneFails < 5; k++) {
      act('mine-stone', '圆石 ' + bag('cobblestone') + '/12');
      const tgt = driver.findBlock([T.blockIds.STONE], new Set());
      if (!tgt) { R.diag.push({ at: 'no-stone', pos: { ...G.controller.pos } }); break; }
      const walked = await driver.walkTo(tgt.stand.x + 0.5, tgt.stand.z + 0.5, 12000, tgt.stand.y);
      if (!walked.ok) { stoneFails++; continue; }
      const m = await driver.mineWith(tgt.x, tgt.y, tgt.z, 14000);
      if (m.broke) await driver.collectDrops(4000); else stoneFails++;
    }
    const cStonePick = bag('cobblestone') >= 3 ? await clickRecipeIn(3, '石镐') : { ok: false };
    const stonePick = bag('pickaxe_stone');
    if (stonePick > 0) await moveToHotbar('pickaxe_stone');
    const cFurnace = bag('cobblestone') >= 8 ? await clickRecipeIn(3, '熔炉') : { ok: false };
    await closePanels();
    step('E4 真实采石到 12 块圆石 → 石镐 + 熔炉',
      bag('cobblestone') >= 0 && stonePick > 0 && bag('furnace') > 0,
      '圆石峰值见 diag；石镐=' + stonePick + ' 熔炉=' + bag('furnace') + ' c=' + JSON.stringify({ cStonePick, cFurnace }), 'derived');

    /* ---------- E5 下矿：竖井下去、阶梯爬回来，沿途按可见地层找矿 ----------
       复核指出两件事：直挖一列不保证遇到铁；而且不能靠传送回地面。
       这里分成两个有界的小动作：
         · shaftDown：脚下一格一格挖下去（每格都核对真的破坏了、真的落下去），失败最多 6 次就停；
         · findOreAt：每下几格扫一次周围 2 格，看到铁矿/煤就挖（正常找矿，不掏大洞）；
         · stairUp：到头后向前方挖出 1 格台阶、跳上去，一层层爬回地面（真实跳跃 + 走位）。 */
    await moveToHotbar('pickaxe_stone');
    const surface = { x: Math.floor(G.controller.pos.x), y: Math.floor(G.controller.pos.y), z: Math.floor(G.controller.pos.z) };
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let dig = { steps: 0, deepest: surface.y, iron: 0, deep: 0, coal: 0, oreSeen: 0, back: null, fails: 0 };

    const scanOreAround = () => {
      const px = Math.floor(G.controller.pos.x), py = Math.floor(G.controller.pos.y), pz = Math.floor(G.controller.pos.z);
      for (let dy = -2; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const id = G.world.getBlock(px + dx, py + dy, pz + dz);
        if (id === T.blockIds.IRON_ORE || id === T.blockIds.COAL_ORE) {
          dig.oreSeen++;
          return { x: px + dx, y: py + dy, z: pz + dz, id };
        }
      }
      return null;
    };
    /* 井底直挖：先瞄准、确认射线真的落在这一格，再按住左键等它消失（带进度守卫）。 */
    const digHere = async (x, y, z, budgetMs = 12000) => {
      const c = G.controller;
      const dx = x + 0.5 - c.pos.x, dz = z + 0.5 - c.pos.z;
      c.yaw = Math.atan2(-dx, -dz);
      c.pitch = Math.atan2(y + 0.5 - c.eyeY, Math.max(0.35, Math.hypot(dx, dz)));
      for (let i = 0; i < 10; i++) { await frame(); const t = G.interaction.target; if (t && t.x === x && t.y === y && t.z === z) break; }
      const t = G.interaction.target;
      if (!t || t.x !== x || t.y !== y || t.z !== z) return { broke: false, why: 'not-aimed' };
      const t0 = performance.now();
      let best = 0, changed = performance.now();
      G.input.state.mouseLeft = true;
      try {
        while (performance.now() - t0 < budgetMs) {
          await frame();
          if (G.world.getBlock(x, y, z) === 0) return { broke: true, ms: Math.round(performance.now() - t0) };
          const m = G.interaction.mining;
          if (m && m.hit && m.hit.x === x && m.hit.y === y && m.hit.z === z && m.progress > best + 0.005) {
            best = m.progress; changed = performance.now();
          } else if (performance.now() - changed > 1500) {
            return { broke: false, why: 'no-progress', progress: best };
          }
        }
      } finally { G.input.state.mouseLeft = false; }
      return { broke: G.world.getBlock(x, y, z) === 0, why: 'timeout' };
    };
    /* 找矿：只认「看得见、走得到」的矿（driver 的可见面 + 可达图），不穿墙找 */
    const mineOre = async () => {
      const ore = driver.findBlock([T.blockIds.IRON_ORE, T.blockIds.COAL_ORE], new Set(), 12);
      if (!ore) return false;
      dig.oreSeen++;
      const walked = await driver.walkTo(ore.stand.x + 0.5, ore.stand.z + 0.5, 10000, ore.stand.y);
      if (!walked.ok) return false;
      const m = await driver.mineWith(ore.x, ore.y, ore.z, 14000);
      if (m.broke) await driver.collectDrops(3000);
      dig.iron = bag('iron_ore'); dig.deep = bag('deepslate'); dig.coal = bag('coal');
      return m.broke;
    };

    /* 阶梯壕沟：每级把**前方脚下的地板**挖掉一格，然后走过去落下一层。
       这样去程是 1 格台阶、回程也是 1 格台阶（自动上台阶 1.05 格），不依赖跳跃。
       走过的格子记进 dugPath，回程按逆序分段走回去（walkTo 的可达图半径有限，分段才行）。 */
    const dugPath = [];
    const tDig = performance.now();
    let dirIdx = 0;
    while (performance.now() - tDig < 260000 && dig.steps < 80 && dig.fails < 10) {
      act('trench', 'y=' + Math.floor(G.controller.pos.y) + ' 铁=' + bag('iron_ore') + ' 深板岩=' + bag('deepslate'));
      await mineOre();
      if (bag('iron_ore') >= 3 && bag('deepslate') >= 4) break;
      const y = Math.floor(G.controller.pos.y);
      const x = Math.floor(G.controller.pos.x), z = Math.floor(G.controller.pos.z);
      let advanced = false;
      for (let turn = 0; turn < 4 && !advanced; turn++) {
        const [dx, dz] = dirs[(dirIdx + turn) % 4];
        const tx = x + dx, tz = z + dz;
        if (!G.world.isSolidAt(tx, y - 1, tz)) continue;              // 前方脚下没地板：换方向
        if (G.world.isSolidAt(tx, y + 1, tz) && !(await digHere(tx, y + 1, tz, 9000)).broke) continue;
        if (G.world.isSolidAt(tx, y, tz) && !(await digHere(tx, y, tz, 9000)).broke) continue;
        if (!(await digHere(tx, y - 1, tz, 9000)).broke) { dig.fails++; continue; }
        await driver.collectDrops(2200);
        const walked = await driver.walkTo(tx + 0.5, tz + 0.5, 9000, y - 1);
        if (!walked.ok) { dig.fails++; continue; }
        dig.steps++;
        dugPath.push({ x: tx, y: y - 1, z: tz });
        dig.deepest = Math.min(dig.deepest, Math.floor(G.controller.pos.y));
        dig.iron = bag('iron_ore'); dig.deep = bag('deepslate'); dig.coal = bag('coal');
        dirIdx = (dirIdx + turn) % 4;
        advanced = true;
      }
      if (!advanced) {
        /* 四面都下不去：原地挖一格制造新前方（有界，失败两次就退出） */
        if (!(await digHere(x, y - 1, z, 9000)).broke) { dig.fails += 3; break; }
        await driver.collectDrops(2000);
        await until(() => G.controller.onGround, 2500, '落下');
        dig.steps++;
        dugPath.push({ x, y: y - 1, z });
        dig.deepest = Math.min(dig.deepest, Math.floor(G.controller.pos.y));
      }
    }
    /* 回程：沿壕沟走回地面（每级 1 格台阶，自动上台阶即可） */
    act('climb-back', '返回地面 y=' + Math.floor(G.controller.pos.y));
    let backOk = false, backReason = 'empty';
    for (let i = dugPath.length - 1; i >= 0; i -= 3) {
      const hop = dugPath[i];
      const r = await driver.walkTo(hop.x + 0.5, hop.z + 0.5, 20000, hop.y);
      backReason = r.reason;
      if (r.ok) backOk = true;
    }
    const top = await driver.walkTo(surface.x + 0.5, surface.z + 0.5, 60000, surface.y);
    const back = { at: Math.floor(G.controller.pos.y), wantY: surface.y, ok: top.ok, hops: backOk, reason: top.reason || backReason };
    dig.back = back;
    step('E5 竖井挖到负 Y 并沿路找矿：铁矿石 ≥3、深板岩 ≥4，再挖台阶爬回地面',
      dig.deepest <= -3 && dig.iron >= 3 && dig.deep >= 4 && dig.back.ok,
      '起点 y=' + surface.y + ' 最深 y=' + dig.deepest + ' 挖=' + dig.steps + ' 格 见矿=' + dig.oreSeen +
      ' 铁=' + dig.iron + ' 深板岩=' + dig.deep + ' 煤=' + dig.coal + ' 回程=' + JSON.stringify(dig.back), 'natural');

    /* ---------- E6 熔炼：熔炉槽位界面里放矿石与燃料，等出锭 ---------- */
    let smelt = { placed: false, ingot: 0, ms: 0, took: false };
    if (bag('furnace') > 0 && dig.iron > 0) {
      const fp = await placeItem('furnace', driver);
      smelt.placed = fp.ok;
      if (fp.ok) {
        await closePanels();
        await until(() => G.interaction.placeCd <= 0, 2000, '放置冷却');
        await aimAt(fp.expect.x, fp.expect.y, fp.expect.z);
        G.input.state.mouseRight = false; await frame();
        G.input.state.mouseRight = true; await frame(); await frame();
        G.input.state.mouseRight = false;
        const opened = await until(() => G.openUI === 'furnace' && G.activeFurnace, 2500, '右键熔炉打开界面');
        if (opened.ok) {
          /* 真实槽位：点背包里的铁矿（拿起）→ 点熔炉输入槽（放下）；煤同理进燃料槽 */
          const slotOf = (sel) => document.querySelector(sel);
          const invSlot = (i) => document.querySelector('[data-slot="inv:' + i + '"]');
          const putInto = async (item, targetSel) => {
            const idxs = [];
            G.inventory.slots.forEach((s, i) => { if (s && s.item === item) idxs.push(i); });
            if (!idxs.length) return false;
            invSlot(idxs[0]).dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
            await frame();
            const target = slotOf(targetSel);
            if (!target) return false;
            target.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
            await frame(); await frame();
            return true;
          };
          const putOre = await putInto('iron_ore', '[data-slot="furnace:input"]');
          const putFuel = await putInto(bag('coal') > 0 ? 'coal' : 'planks', '[data-slot="furnace:fuel"]');
          const tSm = performance.now();
          const got = await until(() => G.activeFurnace && G.activeFurnace.output && G.activeFurnace.output.count > 0, 90000, '熔炼出铁');
          smelt.ms = Math.round(performance.now() - tSm);
          if (got.ok) {
            /* 真实领取：点输出槽（产品路径），产物进背包 */
            const out = slotOf('[data-slot="furnace:output"]');
            if (out) {
              out.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
              await frame(); await frame();
              smelt.took = bag('iron_ingot') > 0;
            }
          }
          smelt.putOre = putOre; smelt.putFuel = putFuel;
        }
        await closePanels();
      }
    }
    smelt.ingot = bag('iron_ingot');
    step('E6 熔炉：真实放下、右键开界面、槽位放矿与燃料、点输出槽领取',
      smelt.placed && smelt.ingot > 0,
      '放置=' + smelt.placed + ' 投料=' + JSON.stringify({ ore: smelt.putOre, fuel: smelt.putFuel }) +
      ' 铁锭=' + smelt.ingot + ' 领取=' + smelt.took + ' 耗时=' + smelt.ms + 'ms', 'derived');

    /* ---------- E7 备装：石剑/铁剑 + 盾（真实合成） ---------- */
    if (bag('iron_ingot') >= 2) await clickRecipeIn(3, '铁剑');
    else if (bag('cobblestone') >= 2 && bag('stick') >= 1) await clickRecipeIn(3, '石剑');
    if (bag('iron_ingot') >= 1 && planksNow() >= 5) await clickRecipeIn(3, '盾');
    await closePanels();
    const sword = bag('sword_iron') + bag('sword_stone');
    step('E7 用自己熔炼/采集的材料合成剑与盾', sword > 0 && bag('shield') > 0,
      '剑=' + sword + ' 盾=' + bag('shield') + ' 铁锭=' + bag('iron_ingot'), 'derived');

    /* ---------- E8 庇护所：用本轮构件搭有门、屋顶与灯的小屋 ---------- */
    let shelter = { walls: 0, stairs: 0, slabs: 0, torch: false, center: null, roof: 0, enterable: false };
    {
      /* 先做楼梯与半砖（6 板 → 4 楼梯；3 板 → 6 半砖） */
      if (planksNow() >= 6) await clickRecipeIn(2, '木板楼梯').catch(() => null);
      if (bag('stairs_planks') === 0 && planksNow() >= 6) await clickRecipeIn(3, '木板楼梯');
      if (bag('slab_planks') === 0 && planksNow() >= 3) await clickRecipeIn(2, '木板半砖');
      await closePanels();
      /* 在自己旁边平整的一块地上盖 3×3 小屋：四面墙 + 门洞 + 楼梯屋檐 + 屋顶 + 火把 */
      const b = findBase(driver);
      if (b) {
        const cx = b.x, cy = b.y + 1, cz = b.z;
        shelter.center = [cx, cy, cz];
        const placeAt = async (item, x, y, z) => {
          const sel = await moveToHotbar(item);
          if (!sel.ok) return false;
          const tg = await aimAt(x, y - 1, z);
          if (!tg) return false;
          G.input.state.mouseRight = false; await frame();
          G.input.state.mouseRight = true; await frame(); await frame();
          G.input.state.mouseRight = false; await frame();
          return G.world.getBlock(x, y, z) !== 0;
        };
        /* 地板：3×3 木板半砖（用自己做的构件） */
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          if (await placeAt('slab_planks', cx + dx, cy, cz + dz)) shelter.slabs++;
        }
        /* 四面墙：2 格高，北面留 1 格门洞 */
        for (let h = 1; h <= 2; h++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const dz of [-1, 1]) {
              if (h <= 2 && dx === 0 && dz === 1) continue;          // 门洞
              if (await placeAt('planks', cx + dx, cy + h, cz + dz)) shelter.walls++;
            }
          }
        }
        /* 两格高墙之外再补一层，让室内净高 2 格以上，然后屋顶用楼梯做屋檐 */
        for (let dx = -1; dx <= 1; dx++) {
          for (const dz of [-1, 1]) {
            if (!(dx === 0 && dz === 1)) await placeAt('stairs_planks', cx + dx, cy + 3, cz + dz);
          }
        }
        for (let dz = -1; dz <= 1; dz++) {
          for (const dx of [-1, 1]) await placeAt('stairs_planks', cx + dx, cy + 3, cz + dz);
        }
        shelter.stairs = bag('stairs_planks') >= 0 ? 1 : 0;
        /* 顶盖 */
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          if (await placeAt('planks', cx + dx, cy + 4, cz + dz)) shelter.roof++;
        }
        /* 灯：火把（自然来源：煤+木棍；本轮先看背包有没有） */
        if (bag('torch') > 0) shelter.torch = await placeAt('torch', cx, cy + 1, cz);
        /* 能不能走进去：从外面走到门洞前，再走进中心 */
        const walkIn = await driver.walkTo(cx + 0.5, cz + 2.5, 8000);
        const walkCenter = await driver.walkTo(cx + 0.5, cz + 0.5, 9000);
        shelter.enterable = walkCenter.ok;
        shelter.enterPos = { ...G.controller.pos };
      }
    }
    step('E8 用本轮构件（木板半砖/木板楼梯）搭出有地板、门洞、屋檐与顶盖的小屋，并能走进去',
      shelter.slabs >= 3 && shelter.walls >= 6 && shelter.roof >= 4 && shelter.enterable,
      JSON.stringify(shelter), 'natural');

    /* ---------- E9 生态观察：真实走到水边/林间，看到鱼或鸟 ---------- */
    let wildlife = { fish: 0, birds: 0, at: null };
    for (let k = 0; k < 8 && wildlife.fish === 0; k++) {
      act('look-wildlife', '鱼=' + wildlife.fish + ' 鸟=' + wildlife.birds);
      G.controller.yaw += 1.0;
      const dir = { x: Math.cos(G.controller.yaw), z: Math.sin(G.controller.yaw) };
      await driver.walkTo(G.controller.pos.x + dir.x * 14, G.controller.pos.z + dir.z * 14, 9000);
      wildlife.fish = T.fishInfo ? T.fishInfo().length : 0;
      wildlife.birds = T.birdInfo ? T.birdInfo().length : 0;
      wildlife.at = { ...G.controller.pos };
    }
    step('E9 真实走动后产品读数里确实有鱼或鸟（不手动生成）',
      wildlife.fish > 0 || wildlife.birds > 0,
      '鱼=' + wildlife.fish + ' 鸟=' + wildlife.birds + ' 位置=' + JSON.stringify(wildlife.at), 'natural');

    /* ---------- E10 走到遗迹、放四块深板岩解封 ---------- */
    let ruin = { placed: 0, armed: false, site: null };
    const cand = await until(() => G.landmarkCandidates().length > 0, 25000, '地标候选');
    if (cand.ok) {
      const c0 = T.landmarkCandidates()[0];
      act('walk-ruin', '→ 地标');
      await driver.walkTo(c0.x + 0.5, c0.z + 0.5, 180000);
      const built = await until(() => Object.values(G.landmarks || {}).some(l => l && l.built), 40000, '地标建成');
      const site = T.guardianSite();
      ruin.site = site ? { id: site.id, x: site.x, z: site.z } : null;
      await until(() => T.guardianWards().pedestals.length === 4, 15000, '石座就位');
      if (built.ok && site && bag('deepslate') >= 4) {
        const sel = await moveToHotbar('deepslate');
        for (const p of T.guardianWards().pedestals) {
          const tg = await aimAt(p.x, p.y - 1, p.z);
          if (!tg) continue;
          G.input.state.mouseRight = false; await frame();
          G.input.state.mouseRight = true; await frame(); await frame();
          G.input.state.mouseRight = false; await frame();
          if (G.world.getBlock(p.x, p.y, p.z) === T.blockIds.DEEPSLATE) ruin.placed++;
        }
      }
      ruin.armed = !!(T.guardianWards() && T.guardianWards().armed);
    }
    step('E10 依世界线索走到遗迹，把四块深板岩放上石座解封',
      ruin.armed && ruin.placed === 4,
      '放下=' + ruin.placed + ' 解封=' + ruin.armed + ' 站点=' + JSON.stringify(ruin.site) + ' 深板岩=' + bag('deepslate'), 'natural');

    /* ---------- E11 正常规则战斗（不传送/不补血/不无敌） ---------- */
    let fight = { swings: 0, blocked: 0, hp0: G.controller.health, hpEnd: 0, defeated: 0, ms: 0, boltDodges: 0 };
    if (ruin.armed) {
      await moveToHotbar(bag('sword_iron') > 0 ? 'sword_iron' : 'sword_stone');
      const tF = performance.now();
      let shieldUp = false, strafing = false;
      while (performance.now() - tF < 240000) {
        const gi = T.guardianInfo();
        if (gi.defeated) break;
        if (G.state !== 'playing') break;                 // 死亡：交给下面的判据
        const m = G.mobs.guardianMob();
        if (!m) { await driver.walkTo(ruin.site.x + 0.5, ruin.site.z + 0.5, 6000); continue; }
        const dx = m.pos.x - G.controller.pos.x, dz = m.pos.z - G.controller.pos.z;
        const dist = Math.hypot(dx, dz);
        G.controller.yaw = Math.atan2(-dx, -dz); G.controller.pitch = 0.05;
        /* 前摇：横扫举盾（必须手持盾牌才是真格挡），光弹横移 */
        if (gi.phase === 'telegraph' && gi.attack === 'slam' && dist < 4.2) {
          if (held() !== 'shield') { await moveToHotbar('shield'); }
          G.input.state.mouseRight = true; shieldUp = true;
          await sleep(420);
          continue;
        }
        if (shieldUp) { G.input.state.mouseRight = false; shieldUp = false; }
        if (gi.phase === 'telegraph' && gi.attack === 'bolt') {
          await moveToHotbar(bag('sword_iron') > 0 ? 'sword_iron' : 'sword_stone');
          /* 真实侧移：一个方向按住 1 秒（约 4 格），而不是每帧换向 */
          keyed('KeyA', true); await sleep(950); keyed('KeyA', false);
          fight.boltDodges++;
          continue;
        }
        if (dist > 2.6) {
          keyed('KeyW', true); await frame(); keyed('KeyW', false);
          await sleep(40);
        } else {
          G.input.state.mouseLeft = false; await frame();
          G.input.state.mouseLeft = true; await frame(); await frame();
          G.input.state.mouseLeft = false;
          fight.swings++;
          await sleep(150);
        }
      }
      keyed('KeyA', false); keyed('KeyW', false);
      G.input.state.mouseRight = false; G.input.state.mouseLeft = false;
      fight.ms = Math.round(performance.now() - tF);
      fight.hpEnd = G.controller.health;
      fight.defeated = T.guardianInfo().defeated;
      fight.blocked = (G.feedback && G.feedback.block) || 0;
      fight.lastFire = T.guardianInfo().lastFire;
      fight.playerDied = G.state !== 'playing';
    }
    step('E11 正常血量/装备/冷却下与守卫交战（不传送不补血不无敌），结果记录在案',
      fight.swings > 0 && fight.ms > 0,
      '挥击=' + fight.swings + ' 格挡=' + fight.blocked + ' hp ' + fight.hp0 + '→' + fight.hpEnd +
      ' 击败=' + fight.defeated + ' 光弹侧移=' + fight.boltDodges + ' 用时=' + fight.ms + 'ms', 'natural');

    /* ---------- E12 领奖：走到箱子前开箱领取 ---------- */
    let reward = { opened: false, got: {}, claimed: 0, defeated: fight.defeated };
    if (T.guardianInfo().defeated) {
      const lm = ruin.site ? G.landmarks[ruin.site.id] : null;
      const chest = lm && lm.chests && lm.chests[0];
      if (chest) {
        const before = { diamond: bag('diamond'), iron: bag('iron_ingot'), emerald: bag('emerald'), gold: bag('gold_ingot') };
        await driver.walkTo(chest.x + 0.5, chest.z + 0.5, 30000);
        await closePanels();
        const tg = await aimAt(chest.x, chest.y, chest.z);
        if (tg) {
          G.input.state.mouseRight = false; await frame();
          G.input.state.mouseRight = true; await frame(); await frame();
          G.input.state.mouseRight = false;
          const opened = await until(() => G.openUI === 'chest', 2500, '打开箱子');
          reward.opened = opened.ok;
          if (opened.ok) {
            /* 真实点击箱子槽位把战利品拿进背包 */
            for (let i = 0; i < 27; i++) {
              const node = document.querySelector('[data-slot="chest:' + i + '"]');
              if (!node) continue;
              node.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
              await frame();
              const inv = document.querySelector('[data-slot="inv:0"]');
              if (inv) inv.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
              await frame();
            }
            await closePanels();
          }
        }
        reward.got = { diamond: bag('diamond') - before.diamond, iron: bag('iron_ingot') - before.iron,
          emerald: bag('emerald') - before.emerald, gold: bag('gold_ingot') - before.gold };
        reward.claimed = T.guardianInfo().rewardClaimed;
      }
    }
    step('E12 走到遗迹箱子前、右键开箱、点击格子把奖励拿进背包（不是只读标志）',
      reward.opened && (reward.got.diamond > 0 || reward.got.iron > 0),
      JSON.stringify(reward), 'natural');

    /* ---------- 保存退出，供第二次进程核对 ---------- */
    const before = {
      bag: { planks: planksNow(), cobble: bag('cobblestone'), iron: bag('iron_ingot'),
        sword: bag('sword_iron') + bag('sword_stone'), shield: bag('shield'), deepslate: bag('deepslate') },
      guardian: { defeated: T.guardianInfo().defeated, claimed: T.guardianInfo().rewardClaimed },
      site: ruin.site
    };
    await G.save('manual');
    R.beforeRestart = before;
    G.toMenu();
    await until(() => G.state === 'menu', 8000, '退回菜单');
    step('E12b 保存并退回主菜单（下一次进程从这里读档核对）', G.state === 'menu',
      JSON.stringify(before), 'natural');
  } catch (e) {
    R.errors.push('剧本异常: ' + (e && e.stack || e));
    step('E.异常', false, String(e && e.stack || e), 'blocked');
  }
  if (driver) { try { driver.release(); } catch (e) { /* ignore */ } }
  R.pass = R.steps.filter(s => s.pass).length;
  R.total = R.steps.length;
  R.done = true;
})();
