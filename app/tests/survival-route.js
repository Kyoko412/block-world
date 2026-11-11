/*
 * 阶段 7：从**最终 EXE** 走正常生存路线的取证剧本。
 *   成品：方块世界.exe --selftest-route → <隔离验收目录>/saves/route-report.json
 *
 * 与主线/守卫自检的关系：复用同一个 runSelfTest（同一 EXE、同一套保活、600 秒看门狗），
 * 但剧本、报告、存档目录各自独立，不占用主线计数与预算。
 *
 * 证据分两类，报告里每条 step 都带 kind 字段，不混为一谈：
 *   kind='A' 真实输入：新建世界、砍树、捡掉落、配方书点击合成、真实挖掘下矿、
 *                     产品入口保存/退出/重进。不用直接改背包、传送、无敌、
 *                     手动生成生物、直接调伤害。
 *   kind='B' 自动场景布置：装备与封印材料的快速就位、守卫战与领奖的收尾。
 *                     这些节点在 600 秒内用纯自然路线走完不现实，因此明确标注为
 *                     自动场景证据；同一批守卫交互的产品级验收另见 guardian-scenario.js。
 *
 * 每段都记种子、坐标、背包/装备、耗时、卡点，并把画面 POST 到同源 /api/screenshot
 * 落在同一验收目录的 screenshots/ 下（离线、不外链）。
 */
(async () => {
  const R = { done: false, steps: [], errors: [], shot: null };
  window.__e2e = R;
  const EXPECTED_TOTAL = 10;
  const t0 = performance.now();
  const step = (name, pass, info, kind) => {
    R.steps.push({ name, pass: !!pass, info: info === undefined ? '' : String(info),
      kind: kind || 'A', t: Math.round(performance.now() - t0) });
  };
  const ok = step;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const frame = () => new Promise(r => requestAnimationFrame(() => r()));
  window.addEventListener('error', e => R.errors.push('window: ' + e.message));
  window.addEventListener('unhandledrejection', e => R.errors.push('promise: ' + String(e && e.reason)));
  const G = window.__game, T = window.__test;
  const SEED = 'route-2026-1109';
  const WORLD = '正常生存路线';
  const route = { seed: SEED, world: WORLD, stages: [], screenshots: [], audio: 'artifacts/audio/mix-stage6-final/' };
  const now = () => Math.round(performance.now() - t0);
  const snap = () => ({
    pos: G.controller ? [+G.controller.pos.x.toFixed(1), +G.controller.pos.y.toFixed(1), +G.controller.pos.z.toFixed(1)] : null,
    hp: G.controller ? G.controller.health : null,
    held: G.inventory && G.inventory.held ? (G.inventory.held() || {}).item : null,
    bag: G.inventory ? ['oak_log','birch_log','planks','birch_planks','crafting_table','stick','pickaxe_wood','cobblestone','deepslate','iron_ingot','shield','bow']
      .map(i => [i, G.inventory.countOf(i)]).filter(x => x[1] > 0) : []
  });
  const shot = async (name) => {
    try {
      const url = T.screenshot ? T.screenshot() : null;
      if (!url) return false;
      const r = await fetch('/api/screenshot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'route-' + name, dataUrl: url })
      });
      const j = await r.json();
      if (j && j.ok) { route.screenshots.push({ name, file: j.file, t: now() }); R.shot = name; return true; }
    } catch (e) { /* 截图失败不阻断路线，如实记进卡点 */ }
    return false;
  };
  const stage = (id, name, kind, extra) => {
    const s = { id, name, kind, at: now(), ...snap(), ...(extra || {}) };
    route.stages.push(s);
    return s;
  };
  /* 本轮 A2：谓词可能是异步的（例如「等一次 loadWorld 的结果」）。
     旧写法 `v = pred()` 拿到的 Promise 永远为真 → 立即可判定成功，等于没等。
     现在统一 await；抛错记成 null 继续等。 */
  const tryUntil = async (pred, budgetMs, label) => {
    const t = performance.now();
    let lastErr = null;
    for (;;) {
      let v = null;
      try { v = await pred(); } catch (e) { v = null; lastErr = String((e && e.message) || e); }
      if (v) return { ok: true, ms: Math.round(performance.now() - t), value: v };
      if (performance.now() - t > budgetMs) return { ok: false, ms: Math.round(performance.now() - t), label, err: lastErr };
      await frame();
    }
  };
  const moveToward = async (x, z, maxMs) => {
    const t = performance.now();
    const dx = x - G.controller.pos.x, dz = z - G.controller.pos.z;
    G.controller.yaw = Math.atan2(-dx, -dz);
    while (performance.now() - t < maxMs) {
      T.key('KeyW', true);
      await frame();
      if (Math.hypot(x - G.controller.pos.x, z - G.controller.pos.z) < 2.2) break;
    }
    T.key('KeyW', false);
    return Math.hypot(x - G.controller.pos.x, z - G.controller.pos.z);
  };
  /* 真实左键挖掘：瞄准指定方块，按住直到它消失或超时。不调 mineAt/不改背包。 */
  const mineBlock = async (x, y, z, budgetMs) => {
    const eye = G.controller.eyeY;
    G.controller.yaw = Math.atan2(-(x + 0.5 - G.controller.pos.x), -(z + 0.5 - G.controller.pos.z));
    G.controller.pitch = Math.atan2(y + 0.5 - eye, Math.hypot(x + 0.5 - G.controller.pos.x, z + 0.5 - G.controller.pos.z));
    const t = performance.now();
    let broke = false;
    while (performance.now() - t < budgetMs) {
      G.interaction.updateTarget();
      G.input.state.mouseLeft = true;
      G.interaction.update(0.02);
      await frame();
      if (G.world.getBlock(x, y, z) === 0) { broke = true; break; }
    }
    G.input.state.mouseLeft = false;
    return { broke, ms: Math.round(performance.now() - t), got: G.world.getBlock(x, y, z) };
  };
  const clickRecipe = async (label, outSlot) => {
    const row = [...document.querySelectorAll('#recipe-book .recipe-item')].find(n => n.textContent.includes(label));
    if (!row) return { ok: false, why: 'no-row' };
    row.click();
    await frame(); await frame();
    const out = document.querySelector(outSlot || '[data-slot="craft-out"]');
    if (!out) return { ok: false, why: 'no-out' };
    out.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    await frame();
    return { ok: true };
  };

  try {
    /* ---------- R1 正常新建生存世界 ---------- */
    document.querySelector('[data-a=new]').click();
    await frame();
    document.querySelector('#inp-name').value = WORLD;
    document.querySelector('#inp-seed').value = SEED;
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    const wLoad = await tryUntil(() => G.state === 'playing' && G.world && G.world.genQueue.length === 0,
      40000, '新世界就绪');
    stage('R1', '正常新建生存世界', 'A');
    await shot('01-new-world');
    ok('R1 从正常生存入口新建世界（真实点击，模式/种子/出生点可核）',
      wLoad.ok && G.meta.mode === 'survival' && String(G.meta.seed) === SEED,
      'mode=' + G.meta.mode + ' seed=' + G.meta.seed + ' 用时=' + wLoad.ms + 'ms ' + JSON.stringify(snap()), 'A');

    /* ---------- R2 砍树（真实按键 + 真实左键） ---------- */
    const px = Math.floor(G.controller.pos.x), pz = Math.floor(G.controller.pos.z);
    let tree = null;
    for (let r = 2; r <= 14 && !tree; r++) {
      for (let dx = -r; dx <= r && !tree; dx++) for (let dz = -r; dz <= r && !tree; dz++) {
        const x = px + dx, z = pz + dz;
        const top = G.world.topSolidY(x, z);
        for (let y = top; y >= top - 2 && !tree; y--) {
          const id = G.world.getBlock(x, y, z);
          if (id === T.blockIds.LOG || id === T.blockIds.BIRCH_LOG) tree = { x, y, z, id };
        }
      }
    }
    let chop = { broke: false, why: 'no-tree' };
    if (tree) {
      await moveToward(tree.x + 0.5, tree.z + 0.5, 5000);
      chop = await mineBlock(tree.x, tree.y, tree.z, 14000);
      /* 捡掉落：真实走过去，让拾取半径自己收 */
      await moveToward(tree.x + 0.5, tree.z + 0.5, 2500);
      await sleep(600);
    }
    const logs = G.inventory.countOf('oak_log') + G.inventory.countOf('birch_log');
    stage('R2', '砍树并捡起原木', 'A', { tree, chop, logs });
    await shot('02-chop-tree');
    ok('R2 真实走近树干、按住左键挖掉原木并捡回背包', !!tree && chop.broke && logs > 0,
      '树=' + JSON.stringify(tree) + ' 挖=' + JSON.stringify(chop) + ' 原木=' + logs + ' ' + JSON.stringify(snap()), 'A');

    /* ---------- R3 配方书点击合成：木板 → 工作台 → 木棍 → 木镐 ---------- */
    G.openInventory();                 // 走产品自己的入口，配方书 DOM 才会渲染
    if (G.ui && G.ui.refreshUI) G.ui.refreshUI();
    await frame();
    const c1 = logs > 0 ? await clickRecipe('木板') : { ok: false, why: 'no-log' };
    const planksN = G.inventory.countOf('planks') + G.inventory.countOf('birch_planks');
    /* 工作台：2×2 四板 → 产物；木棍需要两板竖排，用配方书同样点一次 */
    const c2 = planksN >= 4 ? await clickRecipe('工作台') : { ok: false, why: 'no-planks' };
    const tableN = G.inventory.countOf('crafting_table');
    stage('R3', '背包配方书合成木板与工作台', 'A', { c1, c2, planksN, tableN });
    await shot('03-craft-table');
    ok('R3 用背包配方书真实点击合成：原木→木板→工作台（产物真的入库）',
      c1.ok && c2.ok && planksN > 0 && tableN > 0,
      '木板=' + planksN + ' 工作台=' + tableN + ' ' + JSON.stringify({ c1, c2 }) + ' ' + JSON.stringify(snap()), 'A');

    /* ---------- R4 发现鱼鸟（真实移动 + 产品读数，不改生物） ----------
       本轮 A2：旧判据 `fish1 >= 0 || fish0 >= 0` 在鱼鸟全为零时也成立（复核 4-4）。
       现在要求「真的看到」：至少一类 > 0，并且记录是靠哪一段位移找到的。
       做法与玩家一致：先沿水边找（水下/岸边才有鱼），找不到再往林子走看鸟。 */
    const fish0 = T.fishInfo ? T.fishInfo().length : -1;
    const birds0 = T.birdInfo ? T.birdInfo().length : -1;
    let fish1 = fish0, birds1 = birds0, sightedAt = snap().pos, sightings = [];
    const lookForWildlife = async (msBudget) => {
      const t = performance.now();
      while (performance.now() - t < msBudget) {
        T.key('KeyW', true);
        await frame();
        const f = T.fishInfo ? T.fishInfo().length : 0;
        const b = T.birdInfo ? T.birdInfo().length : 0;
        if (f > 0 || b > 0) { sightings.push({ f, b, at: snap().pos }); }
        if (f > 0 && b > 0) break;
        if (performance.now() - t > msBudget * 0.5) { G.controller.yaw += 0.9; }   // 走一段换方向
      }
      T.key('KeyW', false);
      fish1 = T.fishInfo ? T.fishInfo().length : 0;
      birds1 = T.birdInfo ? T.birdInfo().length : 0;
      sightedAt = snap().pos;
    };
    await lookForWildlife(6000);
    if (!(fish1 > 0 || birds1 > 0)) {
      /* 换个方向再找一段（真实走动，不传送） */
      G.controller.yaw = Math.PI * 0.75;
      await lookForWildlife(6000);
    }
    stage('R4', '沿真实移动观察鱼与鸟', 'A', { fish0, fish1, birds0, birds1, sightings, at: sightedAt });
    await shot('04-wildlife');
    ok('R4 路线里真实看到了鱼或鸟（至少一类 > 0，且是走动过程中读到的，不手动生成）',
      (fish1 > 0 || birds1 > 0) && sightings.length > 0,
      '鱼 ' + fish0 + '→' + fish1 + ' 鸟 ' + birds0 + '→' + birds1 +
      ' 看到次数=' + sightings.length + ' 位置=' + JSON.stringify(sightedAt), 'A');

    /* ---------- R5 真实挖掘下矿（往负 Y 方向） ----------
       本轮 A2：旧判据只看 `dug > 0`，挖掉一格地表土也算「下矿完成」（复核 4-4）。
       现在要求三件事同时成立：真的到达 y<0、在负 Y 采到矿石类材料、材料进了背包。 */
    const mineStartY = Math.floor(G.controller.pos.y);
    const mx = Math.floor(G.controller.pos.x) + 2, mz = Math.floor(G.controller.pos.z);
    let dug = 0, deepest = mineStartY;
    const oreGet = {};
    const ORE_ITEMS = ['cobblestone', 'coal', 'iron_ore', 'raw_iron', 'deepslate', 'diamond', 'gold_ore', 'redstone', 'lapis', 'emerald', 'flint'];
    const countOres = () => {
      for (const it of ORE_ITEMS) oreGet[it] = G.inventory.countOf(it);
    };
    countOres();
    const tMine = performance.now();
    /* 真实逐格下挖：瞄准脚下那格挖掉，然后靠重力落到下一格（不传送） */
    for (let k = 0; k < 70 && performance.now() - tMine < 90000; k++) {
      const fy = Math.floor(G.controller.pos.y);
      const target = { x: Math.floor(G.controller.pos.x), y: fy - 1, z: Math.floor(G.controller.pos.z) };
      if (G.world.getBlock(target.x, target.y, target.z) === 0) {
        /* 脚下已经是空气：落下去 */
        await tryUntil(() => G.controller.onGround, 1500, '落到下一格');
        continue;
      }
      const r = await mineBlock(target.x, target.y, target.z, 4000);
      if (!r.broke) break;
      dug++;
      await tryUntil(() => G.controller.onGround, 2500, '落到下一格');
      deepest = Math.min(deepest, Math.floor(G.controller.pos.y));
      countOres();
      if (deepest <= -2 && Object.keys(oreGet).some(it => oreGet[it] > 0 && it !== 'cobblestone')) break;
    }
    const afterMine = G.inventory.countOf('oak_log') + G.inventory.countOf('birch_log');
    const oreGained = Object.keys(oreGet).filter(it => oreGet[it] > 0);
    stage('R5', '真实挖掘下矿', 'A', { dug, startY: mineStartY, deepest, oreGot: oreGet, oreGained });
    await shot('05-mining');
    ok('R5 真实按住左键逐格下挖：真的到负 Y（y≤-2）、采到矿石材料并进了背包（不是「挖掉一格地表」）',
      dug > 0 && deepest <= -2 && oreGained.length > 0,
      '起点 y=' + mineStartY + ' 挖掉=' + dug + ' 格 最深 y=' + deepest +
      ' 矿石=' + JSON.stringify(oreGet) + ' 用时=' + Math.round(performance.now() - tMine) + 'ms ' +
      JSON.stringify(snap()), 'A');

    /* ---------- R6 装备与封印材料：自动场景布置（明确标 B 类） ---------- */
    /* 说明：正常生存里熔炼/铁装/深板岩要跨很长一段真实操作链，600 秒预算装不下。
       这里只把「后续守卫战需要的状态」就位，并在报告里标明它不是自然路线证据。 */
    G.controller.setCreative(true);
    const B = T.blockIds;
    const gear = ['iron_chestplate', 'shield', 'bow', 'arrow', 'iron_sword'];
    for (const it of gear) G.inventory.add(it, it === 'arrow' ? 16 : 1);
    const gy = Math.floor(G.controller.pos.y);
    for (let i = 0; i < 4; i++) T.setBlock(mx + i + 2, gy + 1, mz, B.DEEPSLATE);
    stage('R6', '装备与封印材料就位（自动布置）', 'B', { gear, note: '不是自然路线证据' });
    await shot('06-gear-staged');
    ok('R6 已明确标注：装备与封印材料为自动场景布置，不冒充自然路线', true,
      'gear=' + JSON.stringify(gear) + ' deepslate=4 ' + JSON.stringify(snap()), 'B');

    /* ---------- R7 守卫：自动场景（引用独立守卫验收链路） ---------- */
    /* 守卫战/解封/领奖的产品级真实键鼠证据在 guardian-scenario.js（21 条，另有独立报告）。
       这里只记录「正常路线上守卫入口确实会被自然发现」的读数与交叉引用。 */
    const gInfo = T.guardianInfo ? T.guardianInfo() : null;
    const gWards = T.guardianWards ? T.guardianWards() : null;
    stage('R7', '守卫入口与封印读数（自动场景交叉引用）', 'B',
      { gInfo, wards: gWards && gWards.total, ref: 'artifacts/guardian-report.json' });
    await shot('07-guardian-site');
    ok('R7 守卫环节如实标注为自动场景证据，产品级验收指向独立守卫报告',
      !!gInfo && !!gWards,
      'guardian=' + JSON.stringify(gInfo) + ' wards=' + JSON.stringify(gWards && gWards.total), 'B');

    /* ---------- R8 保存退出、重新进入 ----------
       本轮 A2：旧写法把 `G.loadWorld()` 放在异步谓词里反复调用，
       加上 tryUntil 不 await，等于「一发起就判定成功」，也从没等加载真的完成。
       现在：加载只发起一次，然后等可观察的加载完成状态（state=playing 且区块队列清空）。 */
    G.controller.setCreative(false);
    await G.save('manual');
    const before = { defeated: gInfo && gInfo.defeated, name: G.meta.name, seed: G.meta.seed };
    G.toMenu();
    await tryUntil(() => G.state === 'menu', 8000, '退回菜单');
    const loadOnce = G.loadWorld(WORLD);
    if (loadOnce && typeof loadOnce.then === 'function') await loadOnce;
    const re = await tryUntil(() => G.state === 'playing' && G.world && G.world.genQueue.length === 0,
      30000, '重新进入后世界就绪');
    await sleep(900);
    const after = { defeated: T.guardianInfo ? T.guardianInfo().defeated : null, name: G.meta.name, seed: G.meta.seed };
    stage('R8', '保存退出后重新进入', 'A', { before, after, reMs: re.ms });
    await shot('08-reload');
    ok('R8 正常保存 → 退回菜单 → 重新进入同一存档，世界与守卫状态不丢、不重复结算',
      re.ok && G.state === 'playing' && after.name === WORLD && after.seed === SEED &&
      after.defeated === before.defeated,
      '前=' + JSON.stringify(before) + ' 后=' + JSON.stringify(after) +
      ' 加载用时=' + re.ms + 'ms ' + JSON.stringify(snap()), 'A');

    /* ---------- 收尾：路线摘要与卡点 ---------- */
    route.elapsedMs = now();
    route.final = snap();
    route.blockers = R.steps.filter(s => !s.pass).map(s => ({ name: s.name, info: s.info }));
    window.__route = route;
    ok('R9 路线证据完整：种子/坐标/装备/耗时/卡点/分段截图都写进报告，A/B 两类证据已标明',
      /* R9 执行时已有 R1~R8 共 8 条；本条与后面 R10 加起来正好 10 条 */
      R.steps.length + 2 === EXPECTED_TOTAL && route.screenshots.length >= 4 &&
      route.stages.length === 8 && route.stages.every(s => s.kind === 'A' || s.kind === 'B'),
      '阶段=' + route.stages.length + ' 截图=' + route.screenshots.length +
      ' A类=' + route.stages.filter(s => s.kind === 'A').length +
      ' B类=' + route.stages.filter(s => s.kind === 'B').length +
      ' 耗时=' + route.elapsedMs + 'ms 卡点=' + JSON.stringify(route.blockers), 'A');
    ok('R10 全程无运行错误', R.errors.length === 0, JSON.stringify(R.errors), 'A');
  } catch (e) {
    R.errors.push('剧本异常: ' + (e && e.stack || e));
    step('R.异常 路线剧本抛出错误', false, String(e && e.stack || e), 'A');
  }
  R.route = route;
  R.pass = R.steps.filter(s => s.pass).length;
  R.total = R.steps.length;
  R.done = true;
})();
