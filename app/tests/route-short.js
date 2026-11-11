/*
 * 短复现（E1—E4）：采集 → 工作台 3×3 → 木镐 → 采石 → 石镐。
 *   npx electron tests/e2e-electron.mjs --route-short
 *
 * 目的：先把「合成面板生命周期 / 关闭界面再放置 / 正常槽位选物 / 正确工具下的掉落与拾取」
 * 四件事在**产品现有规则**下跑通。不改拾取半径、不免除工具要求。
 *
 * 每个动作都记录可核对的读数：
 *   · 射线目标（格坐标/面/法线）、预期落点、放置前后方块 ID、背包扣量；
 *   · 挖掘时实际手持、物品耐久、破坏后掉落实体的位置/速度、拾取事件与入包数量。
 */
(async () => {
  const R = { done: false, steps: [], errors: [], diag: [] };
  window.__e2e = R;
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
  const SEED = window.__routeSeed || 'short-2026-1110';
  const WORLD = '短流程复现';

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
  /* 动作心跳：每次换动作或重试都刷新 at，运行器据此判断「还在动」还是「卡住」。
     换动作时重置次数；同一动作连续重试会累积 n。 */
  const act = (name, detail) => {
    const prev = R.act;
    const signature = name + '|' + String(detail || '');
    const n = prev && prev.signature === signature ? (prev.n || 0) + 1 : 0;
    R.act = { name, signature, detail: detail === undefined ? '' : String(detail), at: Date.now(), n };
    if (n > 0) R.diag.push({ at: 'retry', name, n, detail: String(detail || '') });
    return R.act;
  };
  /* 实时诊断：卡住时运行器直接取这一份，不用等整段脚本结束 */
  window.__runDiag = () => {
    const t = G.interaction ? G.interaction.target : null;
    return {
      pos: G.controller ? [+G.controller.pos.x.toFixed(2), +G.controller.pos.y.toFixed(2), +G.controller.pos.z.toFixed(2)] : null,
      onGround: G.controller ? !!G.controller.onGround : null,
      hp: G.controller ? G.controller.health : null,
      held: (G.inventory.held() || {}).item || null,
      openUI: G.openUI, uiMode: G.input ? !!G.input.uiMode : null,
      target: t ? { x: t.x, y: t.y, z: t.z, face: t.face, dist: +t.dist.toFixed(2) } : null,
      mining: G.interaction && G.interaction.mining ? { hit: G.interaction.mining.hit, progress: +G.interaction.mining.progress.toFixed(3) } : null,
      keys: G.input && G.input.state ? { W: !!G.input.state.keyW, A: !!G.input.state.keyA, S: !!G.input.state.keyS, D: !!G.input.state.keyD, L: !!G.input.state.mouseLeft, R: !!G.input.state.mouseRight } : null,
      act: R.act, steps: R.steps.length, bag: {
        log: G.inventory.countOf('oak_log') + G.inventory.countOf('birch_log'),
        planks: G.inventory.countOf('planks') + G.inventory.countOf('birch_planks'),
        stick: G.inventory.countOf('stick'), cobble: G.inventory.countOf('cobblestone')
      }
    };
  };
  const bag = (item) => G.inventory.countOf(item);
  const held = () => { const h = G.inventory.held(); return h ? h.item : null; };
  let driver = null;

  /* ---------- 面板：只在尺寸不对时切换，绝不把 3×3 打回 2×2 ---------- */
  const ensurePanel = async (size) => {
    const cur = G.openUI === 'crafting' ? 3 : (G.openUI === 'inventory' ? 2 : 0);
    const curSize = G.activeCraft ? G.activeCraft.size : 0;
    if (cur === size && curSize === size) return { ui: G.openUI, size: curSize, switched: false };
    if (size === 3) return { ui: G.openUI, size: 0, switched: false, why: 'right-click-table-first' };
    G.openInventory();
    await frame(); await frame();
    return { ui: G.openUI, size: G.activeCraft.size, switched: true };
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
    if (!row) return { ok: false, why: 'no-row', panel, rows: document.querySelectorAll('#recipe-book .recipe-item').length };
    row.click();
    await frame(); await frame();
    const out = document.querySelector('[data-slot="craft-out"]');
    if (!out) return { ok: false, why: 'no-out', panel };
    out.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    await frame();
    out.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await frame();
    return { ok: true, panel };
  };

  /* ---------- 槽位：用正常 UI 把背包物品移进快捷栏，再选中并核验手持 ---------- */
  const moveToHotbar = async (item) => {
    let idx = G.inventory.slots.findIndex((s, i) => i < 9 && s && s.item === item);
    if (idx >= 0) { G.selectHotbar(idx); return { ok: held() === item, idx, moved: false, held: held() }; }
    const src = G.inventory.slots.findIndex(s => s && s.item === item);
    if (src < 0) return { ok: false, why: 'not-in-bag' };
    await ensurePanel(2);
    const node = document.querySelector('[data-slot="inv:' + src + '"]');
    if (!node) return { ok: false, why: 'no-slot-ui', src };
    /* shift+左键 = quickMove（产品自己的「快速移动」） */
    node.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, shiftKey: true }));
    await frame(); await frame();
    idx = G.inventory.slots.findIndex((s, i) => i < 9 && s && s.item === item);
    if (idx >= 0) G.selectHotbar(idx);
    return { ok: idx >= 0 && held() === item, idx, moved: true, held: held(), src };
  };

  /* ---------- 放置：关面板 → 核对手持 → 读射线目标 → 右键 → 核对指定格与扣量 ---------- */
  const placeHeldOnGround = async (item) => {
    /* 先找一块露天地面，再精确瞄准它的顶面（旧写法只把 pitch 设成 -0.62 靠运气，
       实测射线打在 0.38 格外的侧面上，落点完全不是想要的那格）。 */
    const base = findPlaceBase();
    if (!base) return { ok: false, why: 'no-base' };
    await aimAtBlock(base.x, base.y, base.z);
    return await placeHeldCore(item, base);
  };
  const placeHeldCore = async (item, base) => {
    const close = await closePanels();
    const sel = await moveToHotbar(item);
    if (!sel.ok) return { ok: false, why: 'not-held', close, sel };
    const before = { bag: bag(item), held: held() };
    await aimAtBlock(base.x, base.y, base.z);
    const tgt = G.interaction.target;
    const ray = tgt ? { x: tgt.x, y: tgt.y, z: tgt.z, face: tgt.face, dist: +tgt.dist.toFixed(2) } : null;
    let expect = null;
    if (tgt) {
      const p = G.world.placementTarget(tgt);
      if (p) expect = { x: p.x, y: p.y, z: p.z };
    }
    const blockBefore = expect ? G.world.getBlock(expect.x, expect.y, expect.z) : null;
    G.input.state.mouseRight = false; await frame();
    G.input.state.mouseRight = true; await frame(); await frame();
    G.input.state.mouseRight = false; await frame(); await frame();
    const blockAfter = expect ? G.world.getBlock(expect.x, expect.y, expect.z) : null;
    const after = { bag: bag(item), held: held() };
    const itemDef = T.itemDef ? T.itemDef(item) : null;
    await closePanels();
    /* 判据：落点那一格的方块 ID 必须等于这件物品对应的方块（不是「变成非空气」就算），
       并且背包正好少一个。旧写法只比 base 的相邻关系，摆放方向一变就误判失败。 */
    const wantId = itemDef && itemDef.blockId !== undefined ? itemDef.blockId : null;
    return {
      ok: !!expect && blockAfter !== blockBefore && after.bag === before.bag - 1 &&
        (wantId === null || blockAfter === wantId),
      wantId, close, sel, before, after, ray, expect, base, blockBefore, blockAfter, itemDef
    };
  };

  /* Only mine a reachable face. The driver waits for real gameplay progress
     and keeps the attack held across frame scheduling, with bounded failure. */
  const mineWith = (x, y, z, budgetMs) => driver.mineWith(x, y, z, budgetMs);
  /* 掉落实体读数（位置/速度）与拾取：靠走过去，不改拾取半径 */
  const dropInfo = () => {
    const dm = G.interaction && G.interaction.drops;
    if (!dm || !dm.list) return [];
    return dm.list.map(d => ({ item: d.item, n: d.count,
      x: +d.x.toFixed(2), y: +d.y.toFixed(2), z: +d.z.toFixed(2), vy: +(d.vy || 0).toFixed(2),
      age: +(d.age || 0).toFixed(2), pickDelay: +(d.pickDelay || 0).toFixed(2) }));
  };

  const aimAtBlock = (x, y, z) => driver.aimAtBlock(x, y, z);
  const findPlaceBase = () => driver.findPlacementBase();

  try {
    /* ---------- E1 新档 ---------- */
    document.querySelector('[data-a=new]').click();
    await frame();
    document.querySelector('#inp-name').value = WORLD;
    document.querySelector('#inp-seed').value = SEED;
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    const w = await until(() => G.state === 'playing' && G.world && G.world.genQueue.length === 0, 60000, '世界就绪');
    await sleep(600);
    driver = window.__createRouteDriver(G, T, { frame, report: R, action: act });
    step('S1 正常生存新档（真实点击，无传送）', w.ok && G.meta.mode === 'survival',
      'mode=' + G.meta.mode + ' seed=' + G.meta.seed + ' pos=' + JSON.stringify(T.state().pos) + ' 用时=' + w.ms + 'ms');

    /* ---------- E2 采集原木（真实走到树旁 + 真实左键） ---------- */
    const walkTo = (x, z, budgetMs, y) => driver.walkTo(x, z, budgetMs, y);
    const countLogs = () => bag('oak_log') + bag('birch_log');
    let trees = 0;
    const tried = new Set();
    for (let a = 0; a < 16 && countLogs() < 4; a++) {
      const tgt = driver.findBlock([T.blockIds.LOG, T.blockIds.BIRCH_LOG], tried);
      if (!tgt) { R.diag.push({ at: 'no-reachable-tree', pos: { ...G.controller.pos } }); break; }
      const targetKey = [tgt.x, tgt.y, tgt.z].join(',');
      const approached = await walkTo(tgt.stand.x + .5, tgt.stand.z + .5, 12000, tgt.stand.y);
      if (!approached.ok) { tried.add(targetKey); continue; }
      const beforeLogs = countLogs();
      const m = await mineWith(tgt.x, tgt.y, tgt.z, 12000);
      tried.add(targetKey);
      if (m.broke) {
        trees++;
        await driver.collectDrops(5000);
      }
      R.diag.push({ at: 'harvest-log', target: tgt, approached, mine: m, logs: [beforeLogs, countLogs()] });
    }
    step('S2 真实砍树并捡起 ≥4 根原木', countLogs() >= 4,
      '挖掉原木块=' + trees + ' 原木=' + countLogs());

    /* ---------- E3 合成：木板 → 木棍 → 工作台（2×2），再放工作台、3×3 做木镐 ---------- */
    const planksNow = () => bag('planks') + bag('birch_planks');
    let plankClicks = 0;
    while (planksNow() < 10 && (bag('oak_log') + bag('birch_log')) > 0 && plankClicks < 6) {
      const r = await clickRecipeIn(2, '木板');
      if (!r.ok) { R.diag.push({ at: 'planks', r }); break; }
      plankClicks++;
    }
    const cStick = await clickRecipeIn(2, '木棍');
    const cTable = await clickRecipeIn(2, '工作台');
    const afterInv = { planks: planksNow(), sticks: bag('stick'), tables: bag('crafting_table') };
    /* 关面板 → 放工作台（并核对射线/落点/方块 ID/扣量） */
    const placedTable = await placeHeldOnGround('crafting_table');
    /* 工作台放好后：对着**实际方块**用产品入口打开 3×3（右键该格 = openCrafting） */
    const openPlacedTable = async () => {
      if (!placedTable.ok || !placedTable.expect) return { ok: false, why: 'no-table' };
      const e = placedTable.expect;
      await closePanels();
      const target = driver.findBlock([T.blockIds.CRAFTING_TABLE], new Set(), 28, e);
      if (!target) return { ok: false, why: 'no-table-path' };
      const s = target.stand;
      const moved = await walkTo(s.x + .5, s.z + .5, 18000, s.y);
      if (!moved.ok) return { ok: false, why: moved.reason };
      await until(() => G.interaction.placeCd <= 0, 2000, '放置冷却结束');
      const tg = await aimAtBlock(e.x, e.y, e.z);
      const openedAt = { target: tg ? { x: tg.x, y: tg.y, z: tg.z, face: tg.face } : null };
      if (!tg) return { ok: false, why: 'table-not-aimed' };
      G.input.state.mouseRight = false; await frame();
      G.input.state.mouseRight = true; await frame(); await frame();
      G.input.state.mouseRight = false;
      const opened = await until(() => G.openUI === 'crafting' && G.activeCraft && G.activeCraft.size === 3,
        2000, '右键工作台打开 3×3');
      openedAt.ok = opened.ok;
      openedAt.ui = G.openUI;
      openedAt.size = G.activeCraft ? G.activeCraft.size : 0;
      openedAt.ms = opened.ms;
      return openedAt;
    };
    const openViaBlock = await openPlacedTable();
    /* 3×3 里做木镐：面板尺寸必须还是 3 */
    const cPick = await clickRecipeIn(3, '木镐');
    const afterPick = { ui: G.openUI, size: G.activeCraft ? G.activeCraft.size : 0, woodPick: bag('pickaxe_wood') };
    const selPick = afterPick.woodPick > 0 ? await moveToHotbar('pickaxe_wood') : { ok: false, why: 'no-pick' };
    await closePanels();
    R.diag.push({ at: 'E3', plankClicks, cStick, cTable, afterInv, placedTable, openViaBlock, cPick, afterPick, selPick });
    step('S3 合成链：10 木板 / 木棍 / 工作台；放下工作台后 3×3 做出木镐并正常选中',
      afterInv.tables >= 1 && afterPick.woodPick >= 1 && selPick.ok && openViaBlock.size === 3,
      '板=' + afterInv.planks + ' 棍=' + afterInv.sticks + ' 台=' + afterInv.tables +
      ' 放置=' + JSON.stringify({ ok: placedTable.ok, expect: placedTable.expect, before: placedTable.blockBefore, after: placedTable.blockAfter, bag: [placedTable.before && placedTable.before.bag, placedTable.after && placedTable.after.bag] }) +
      ' 开3×3=' + JSON.stringify(openViaBlock) + ' 木镐=' + afterPick.woodPick + ' 手持=' + selPick.held);

    /* ---------- E4 采石 → 石镐 ---------- */
    let dig = { steps: 0, cobble: 0, cobblePeak: 0, drops: [], pickups: [], targets: [] };
    if (afterPick.woodPick > 0 && selPick.ok) {
      const excluded = new Set();
      for (let k = 0; k < 8 && bag('cobblestone') < 3; k++) {
        let target = driver.findBlock([T.blockIds.STONE], excluded);
        // Expose nearby stone with normal single-block digs if the surface has
        // no rock face. Each dig is confirmed before falling/collecting.
        for (let soil = 0; !target && soil < 4; soil++) {
          const c = G.controller;
          const p = { x: Math.floor(c.pos.x), y: Math.floor(c.pos.y) - 1, z: Math.floor(c.pos.z) };
          const r = await mineWith(p.x, p.y, p.z, 10000);
          if (!r.broke) break;
          await until(() => G.controller.onGround, 2500, '单格下挖后落地');
          await driver.collectDrops(2500);
          target = driver.findBlock([T.blockIds.STONE], excluded);
        }
        if (!target) break;
        const dropStart = driver.events.drops.length, pickStart = driver.events.pickups.length;
        const moved = await walkTo(target.stand.x + .5, target.stand.z + .5, 12000, target.stand.y);
        excluded.add([target.x, target.y, target.z].join(','));
        if (!moved.ok) { dig.targets.push({ ...target, moved }); continue; }
        const m = await mineWith(target.x, target.y, target.z, 12000);
        dig.targets.push({ ...target, broke: m.broke, why: m.why });
        if (!m.broke) continue;
        dig.steps++;
        await driver.collectDrops(5000);
        const spawned = driver.events.drops.slice(dropStart);
        dig.drops.push({ block: 'stone', held: m.heldBefore, new: spawned });
        dig.pickups.push(...driver.events.pickups.slice(pickStart));
        dig.cobble = bag('cobblestone');
        dig.cobblePeak = Math.max(dig.cobblePeak, dig.cobble);
      }
    }
    const returnedToTable = bag('cobblestone') >= 3 && bag('stick') >= 2 ? await openPlacedTable() : { ok: false, why: 'no-material' };
    const cStonePick = returnedToTable.ok ? await clickRecipeIn(3, '石镐') : returnedToTable;
    const stonePick = bag('pickaxe_stone');
    await closePanels();
    R.diag.push({ at: 'E4', dig, returnedToTable, cStonePick, stonePick });
    step('S4 正确工具（木镐）下挖石材：生成了圆石掉落并真的进了背包，再做出石镐',
      dig.steps > 0 && dig.cobblePeak >= 1 && stonePick > 0 &&
      dig.drops.some(d => (d.new || []).some(x => x.item === 'cobblestone')),
      '挖=' + dig.steps + ' 圆石(峰值)=' + dig.cobblePeak + ' 当前=' + dig.cobble + ' 拾取次数=' + dig.pickups.length +
      ' 掉落样本=' + JSON.stringify(dig.drops.slice(0, 2)) + ' 石镐=' + stonePick + ' c=' + JSON.stringify(cStonePick));
  } catch (e) {
    R.errors.push('剧本异常: ' + (e && e.stack || e));
    step('S.异常', false, String(e && e.stack || e), 'blocked');
  }
  if (driver) { driver.dispose(); R.routeEvents = driver.events; }
  R.pass = R.steps.filter(s => s.pass).length;
  R.total = R.steps.length;
  R.done = true;
})();
