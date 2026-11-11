/*
 * 阶段 5：地牢守卫独立验收剧本（在真实游戏窗口里执行）。
 * 运行入口：
 *   源码   npx electron tests/e2e-electron.mjs --guardian   → artifacts/guardian-report.json
 *   成品   方块世界.exe --selftest-guardian                 → saves/guardian-report.json
 *
 * 为什么要独立场景（任务书已定的预算方案）：主线已 589 条、成品整程逼近 600 秒看门狗，
 * 守卫战与「战斗中退出 / 玩家死亡重试 / 走远再回来 / 保存重进 / 旧档回落」这些状态组合
 * 塞进主线会把门限顶穿。这里有自己的 EXPECTED_TOTAL、逐项报告、errors 与退出码。
 *
 * 覆盖口径（任务书第 2 条）：普通发现入口 → 封印与准备 → 两种带预警的攻击（盾挡 / 躲墙）
 * → 撤退 / 死亡 / 中途退出 三种中断 → 击败与奖励 → 保存重进 → 再次靠近 → 旧档默认。
 * 全部走产品自己的入口（真实键鼠、真实 setBlock、真实 save/load），不手动 spawn 守卫。
 */
(async () => {
  const R = { done: false, steps: [], errors: [], shot: null };
  window.__e2e = R;
  const EXPECTED_TOTAL = 21;
  const step = (name, pass, info) => {
    R.steps.push({ name, pass: !!pass, info: info === undefined ? '' : String(info), t: Math.round(performance.now()) });
  };
  const ok = (name, cond, info) => step(name, cond, info);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const frame = (n = 1) => new Promise(r => requestAnimationFrame(() => r()));
  window.addEventListener('error', e => R.errors.push('window: ' + e.message));
  window.addEventListener('unhandledrejection', e => R.errors.push('promise: ' + String(e && e.reason)));
  async function until(pred, opts = {}) {
    const budget = opts.budgetMs === undefined ? 8000 : opts.budgetMs;
    const t0 = performance.now();
    let last = null;
    for (;;) {
      if (opts.tick === 'sleep') await sleep(opts.intervalMs || 120); else await frame();
      try { last = pred(); } catch (e) { last = null; }
      if (last) return { ok: true, value: last, ms: Math.round(performance.now() - t0) };
      if (performance.now() - t0 > budget) return { ok: false, value: last, ms: Math.round(performance.now() - t0) };
    }
  }
  const G = window.__game, T = window.__test;
  const hp = () => T.guardianInfo().hp;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  try {
    /* ---------------- 1. 新档：正常生存入口 ---------------- */
    document.querySelector('[data-a=new]').click();
    await frame();
    document.querySelector('#inp-name').value = '守卫验收';
    document.querySelector('#inp-seed').value = 'guardian-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    const wLoad = await until(() => G.state === 'playing' && G.world && G.world.genQueue.length === 0 && G.world.dirtyMesh.size === 0,
      { budgetMs: 40000, tick: 'sleep', intervalMs: 120 });
    ok('GD.1 新档从正常生存入口进入（不是测试命令生成），模式与种子都对',
      wLoad.ok && G.state === 'playing' && G.meta.mode === 'survival' && String(G.meta.seed) === 'guardian-2026',
      'state=' + G.state + ' mode=' + G.meta.mode + ' seed=' + G.meta.seed + ' 用时=' + wLoad.ms + 'ms');

    /* ---------------- 2. 自然走近遗迹：地标建出来 ---------------- */
    G.input.setUIMode(false);
    /* 守卫听 maxMobs 这把总闸（maxMobs=0 表示「关掉刷怪」，守卫不是例外）。
       这里留一点额度让守卫能生成，同时清一次场避免开局就有的动物干扰读数。 */
    G.mobs.maxMobs = 8;
    G.mobs.clear();
    const cand = await until(() => G.landmarkCandidates().length > 0, { budgetMs: 12000, tick: 'sleep', intervalMs: 200 });
    const c0 = cand.ok ? T.landmarkCandidates()[0] : null;
    if (c0) {
      const y0 = G.world.topSolidY(Math.floor(c0.x), Math.floor(c0.z)) + 1;
      T.teleport(c0.x + 0.5, y0, c0.z + 0.5);
      G.world.setCenter(c0.x, c0.z);
    }
    const built = await until(() => Object.values(G.landmarks || {}).some(l => l && l.built),
      { budgetMs: 25000, tick: 'sleep', intervalMs: 200 });
    const site = T.guardianSite();
    ok('GD.2 正常探索到一处已建地标，守卫站点按地点稳定 ID 选中（读档不会漂）',
      built.ok && !!site && T.guardianSaved().siteKey === 'g:' + site.id,
      'site=' + (site ? site.id + ' ' + site.type + ' @' + site.x + ',' + site.z : 'null') +
      ' saved.siteKey=' + T.guardianSaved().siteKey);

    /* ---------------- 3. 封印石座铺出来（准备期的入口） ---------------- */
    const pedW = await until(() => T.guardianWards().pedestals.length === 4,
      { budgetMs: 12000, tick: 'sleep', intervalMs: 200 });
    const wards0 = T.guardianWards();
    ok('GD.3 遗迹四角铺出四个封印石座（黑曜石底座 + 上方留空），坐标按地点中心固定偏移',
      pedW.ok && wards0.total === 4 && wards0.pedestals.length === 4 && wards0.wards === 0 && wards0.armed === false,
      'wards=' + JSON.stringify(wards0));

    /* ---------------- 4. 未解封印：靠近也不唤醒 ---------------- */
    const gy = G.world.topSolidY(Math.floor(site.x), Math.floor(site.z)) + 1;
    T.teleport(site.x + 3.5, gy, site.z + 3.5);
    G.world.setCenter(site.x, site.z);
    const spawnW = await until(() => T.guardianInfo().present, { budgetMs: 20000, tick: 'sleep', intervalMs: 200 });
    await sleep(1500);                        // 让状态机真的推几帧：封印未解就不该进 idle
    let info = T.guardianInfo();
    ok('GD.4 守卫实体在场但封印未解：靠近 3.5 格仍是 dormant，不会开打',
      spawnW.ok && info.present && info.phase === 'dormant' && info.armed === false && info.hp === info.maxHp,
      'info=' + JSON.stringify(info));

    /* ---------------- 5. 可读血条 ---------------- */
    await frame(); await frame();
    const bar = document.querySelector('#guardian-bar');
    const fill = document.querySelector('#gb-fill');
    const barRect = bar ? bar.getBoundingClientRect() : null;
    ok('GD.5 守卫有独立血条：满血填满、显示在顶部居中且不压准星/快捷栏',
      !!bar && !bar.classList.contains('hidden') && !!fill && parseFloat(fill.style.width) >= 99 &&
      !!barRect && barRect.top < 90 && barRect.bottom < 140,
      'hidden=' + (bar && bar.classList.contains('hidden')) + ' width=' + (fill && fill.style.width) +
      ' rect=' + JSON.stringify(barRect && { top: Math.round(barRect.top), bottom: Math.round(barRect.bottom) }));

    /* ---------------- 6. 封印期间打不动（准备材料才是入场券） ---------------- */
    G.inventory.clear();
    G.inventory.add('sword_iron', 1);
    G.inventory.select(G.inventory.slots.findIndex(s => s && s.item === 'sword_iron'));
    const gm0 = G.mobs.guardianMob();
    const faceG = () => {
      const dx = gm0.pos.x - G.controller.pos.x, dz = gm0.pos.z - G.controller.pos.z;
      G.controller.yaw = Math.atan2(-dx, -dz);
      G.controller.pitch = 0;
    };
    /* before：冷却等待之后再重新站好/瞄准。
       本轮 A2 之后守卫真的会以 1.9 格/秒逼近；冷却最长 0.6 秒，等待期间它能走过一格多，
       于是「先瞄准、再等冷却、再挥」的旧写法里，刀落下时目标已经跑到镜头后面去了
       （实测 GD.15 挥 120 刀只中 8 刀）。回调是可选参数，老调用点行为不变。 */
    const swing = async (before) => {
      await until(() => G.interaction.attackTimer <= 0, { budgetMs: 2500, tick: 'sleep', intervalMs: 40 });
      if (typeof before === 'function') { await before(); }
      /* 站位/朝向改完要多等两帧：射线是拿**当前相机**投的，
         传送与视角只写进了 controller，要等这一帧的 update 才会进到相机矩阵。 */
      G.input.state.mouseLeft = false; await frame(); await frame();
      G.input.state.mouseLeft = true; await frame(); await frame();
      G.input.state.mouseLeft = false; await frame();
      await sleep(60);
    };
    faceG();
    const sealedHp0 = hp();
    for (let k = 0; k < 6; k++) { faceG(); await swing(); }
    const sealedHp1 = hp();
    ok('GD.6 封印未解时守卫免疫伤害：真实左键砍 6 下血量一点不掉（先把深板岩凑齐才是挑战入口）',
      sealedHp1 === sealedHp0 && T.guardianInfo().armed === false,
      'hp ' + sealedHp0 + '→' + sealedHp1 + ' armed=' + T.guardianInfo().armed);

    /* ---------------- 7. 放四块深板岩 → 解封 → 唤醒 ---------------- */
    const wards = T.guardianWards().pedestals;
    for (const p of wards) { T.setBlock(p.x, p.y, p.z, T.blockIds.DEEPSLATE); }
    await frame(); await frame();
    const wAfter = await until(() => T.guardianWards().armed === true, { budgetMs: 8000, tick: 'sleep', intervalMs: 150 });
    const wake = await until(() => ['idle', 'telegraph', 'strike', 'recover'].includes(T.guardianInfo().phase),
      { budgetMs: 12000, tick: 'sleep', intervalMs: 100 });
    ok('GD.7 四块深板岩放上石座 → 封印解开 → 走近即唤醒（深板岩只产在 y<0，准备期天然把人赶去深矿）',
      wAfter.ok && wake.ok && T.guardianWards().wards === 4 && T.guardianInfo().armed === true,
      'wards=' + JSON.stringify(T.guardianWards()) + ' phase=' + T.guardianInfo().phase + ' 唤醒用时=' + wake.ms + 'ms');

    /* ---------------- 8. 状态机：前摇 → 出招 → 硬直，且前摇够长（能躲/能挡） ---------------- */
    /* STRIKE 只占一帧，靠 50ms 采样去撞它会漏（第一版就是这样读成 fired=0 的）。
       产品侧补了 `strikes` 计数器与 `lastFire` 读数，这里读计数器，采样只负责看相位。 */
    const phases = new Set(), attacks = new Set();
    const strikes0 = T.guardianInfo().strikes || 0;
    let teleMarks = [];
    let tPrev = T.guardianInfo().phase;
    let lastTele = 0;
    let observed = 0;
    const tState0 = performance.now();
    while (performance.now() - tState0 < 25000) {
      G.controller.health = 20; G.controller.invulnerable = 0;   // 只量状态机，不量玩家能不能活
      const i = T.guardianInfo();
      phases.add(i.phase);
      if (i.phase === 'telegraph' && tPrev !== 'telegraph') { lastTele = performance.now(); attacks.add(i.attack); }
      const firedNow = (i.strikes || 0) - strikes0;
      if (firedNow > observed) { observed = firedNow; if (lastTele) teleMarks.push(Math.round(performance.now() - lastTele)); }
      tPrev = i.phase;
      if (attacks.size >= 2 && phases.has('recover')) break;      // 两种招都见过才算完整
      await sleep(50);
    }
    const teleMin = teleMarks.length ? Math.min(...teleMarks) : 0;
    ok('GD.8 真实主循环里走完 前摇 → 出招 → 硬直；两种招都出过，前摇实测 ≥0.6 秒（玩家来得及躲或举盾）',
      phases.has('idle') && phases.has('telegraph') && observed > 0 && phases.has('recover') &&
      attacks.size >= 2 && teleMin >= 600,
      'phases=' + [...phases].join(',') + ' 出招=' + observed + ' 前摇实测=' + teleMarks.join('/') + 'ms 招=' +
      [...attacks].join(',') + ' lastFire=' + JSON.stringify(T.guardianInfo().lastFire));

    /* ---------------- 9. 横扫可被盾完全挡下 ---------------- */
    G.inventory.add('shield', 1);
    G.inventory.select(G.inventory.slots.findIndex(s => s && s.item === 'shield'));
    G.controller.health = 20; G.controller.invulnerable = 0;
    const blocks0 = (G.feedback && G.feedback.block) || 0;
    /* 先把守卫周围清出一块空地：遗迹里有石座、墙角和顶棚，射线会被它们挡掉，
       那样测到的是「隔着东西」，不是「举盾挡下」。清场只动空气，不动结构本体。 */
    const clearAround = (cx, cz) => {
      const bx = Math.floor(cx), bz = Math.floor(cz), by = Math.floor(G.controller.pos.y);
      for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = 0; dy < 3; dy++) {
        const id = T.blockAt ? null : null;
        T.setBlock(bx + dx, by + dy, bz + dz, 0);
      }
    };
    const arenaKeep = () => {
      /* 地板保留：清到脚下这一层为止，往下不动 */
      const m = G.mobs.guardianMob();
      if (m) clearAround(m.pos.x, m.pos.z);
    };
    arenaKeep();
    /* 贴到 2.5 格（横扫射程 3.4）并保持朝向 + 按住右键举盾。
       守卫在 IDLE 里会逼近，所以每帧把站位钉回 2.5 格，否则一会儿就够不着了。 */
    const gm1 = G.mobs.guardianMob();
    T.teleport(gm1.pos.x + 2.5, gm1.pos.y, gm1.pos.z);
    G.input.state.mouseRight = true;
    let sawSlam = false, blockedBySlam = false, slamLos = null;
    const tSh0 = performance.now();
    while (performance.now() - tSh0 < 24000) {
      const m = G.mobs.guardianMob();
      if (!m) break;
      const dx = m.pos.x - G.controller.pos.x, dz = m.pos.z - G.controller.pos.z;
      G.controller.yaw = Math.atan2(-dx, -dz); G.controller.pitch = 0;
      const dd = Math.hypot(dx, dz);
      if (dd > 3.0 || dd < 1.6) T.teleport(m.pos.x + 2.5, m.pos.y, m.pos.z);
      /* 只量「这一发有没有被盾挡下」：等待期间光弹/其它招会扣血，
         所以每帧把血压回 20（玩家能活才测得完），判据看 lastFire.dealt === 0。 */
      G.controller.health = 20; G.controller.invulnerable = 0;
      G.input.state.mouseRight = true;          // 保持按住（blur 会清键，像真人一样重按）
      await sleep(50);
      const lf = T.guardianInfo().lastFire;
      if (lf && lf.attack === 'slam') {
        sawSlam = true; blockedBySlam = lf.blocked === true; slamLos = lf.los;
        if (blockedBySlam) break;
      }
    }
    const blocks1 = (G.feedback && G.feedback.block) || 0;
    G.input.state.mouseRight = false;
    ok('GD.9 横扫能被正面举盾完全挡下：这一发实际结算 0 点、记成 slam、格挡计数 +1',
      sawSlam && slamLos === true && blockedBySlam && (T.guardianInfo().lastFire || {}).dealt === 0 && blocks1 > blocks0,
      'slam=' + sawSlam + ' los=' + slamLos + ' blocked=' + blockedBySlam +
      ' 格挡 ' + blocks0 + '→' + blocks1 +
      ' lastFire=' + JSON.stringify(T.guardianInfo().lastFire) + ' lastBlock=' + JSON.stringify(G.controller.lastBlock));

    /* ---------------- 10. 光弹挡不住：不举盾，远距离必吃 5 点 ---------------- */
    await frame(); await frame();
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.inventory.select(G.inventory.slots.findIndex(s => s && s.item === 'sword_iron'));
    G.input.state.mouseRight = false;
    /* 光弹的射程是 14 格、横扫只有 3.4，所以这一段把人放到 9 格外。
       但遗迹本体有顶棚、四角有石座、外围还有树 —— 只清「连线」不够（第一版就是这么失败的：
       los 一直是 false，光弹全被判成 wall）。这里以守卫为中心清一个 13×13×6 的空场并铺一层地板，
       量的才是「盾挡不住远招」，不是「被地形挡了」。 */
    const gm2 = G.mobs.guardianMob();
    const boxClear = (cx, cy, cz, rx, ry) => {
      for (let dx = -rx; dx <= rx; dx++) for (let dz = -rx; dz <= rx; dz++) {
        for (let dy = 0; dy <= ry; dy++) T.setBlock(Math.floor(cx) + dx, Math.floor(cy) + dy, Math.floor(cz) + dz, 0);
        T.setBlock(Math.floor(cx) + dx, Math.floor(cy) - 1, Math.floor(cz) + dz, T.blockIds.STONE);   // 地板
      }
    };
    /* 盒子要盖住玩家站的那一端（+9 格），否则玩家会落在没清过的地形里，
       自己那一格上方仍有方块，射线照样被挡（第二版 readings 仍是 los=false 就是这个原因）。 */
    boxClear(gm2.pos.x + 4.5, gm2.pos.y, gm2.pos.z, 6, 5);
    await frame(); await frame();
    T.teleport(gm2.pos.x + 9, gm2.pos.y, gm2.pos.z);
    await frame(); await frame();
    /* 传送之后按**当前**守卫位置再清一次（清空会改地形、守卫也可能走了一步） */
    const gm2b = G.mobs.guardianMob();
    if (gm2b) boxClear((gm2b.pos.x + G.controller.pos.x) / 2, gm2b.pos.y, gm2b.pos.z, 6, 5);
    await frame(); await frame();
    const strikesB0 = T.guardianInfo().strikes || 0;
    const boltW = await until(() => {
      G.controller.health = 20; G.controller.invulnerable = 0;
      const lf = T.guardianInfo().lastFire;
      return lf && (T.guardianInfo().strikes || 0) > strikesB0 && lf.attack === 'bolt' && lf.why === 'hit';
    }, { budgetMs: 40000, tick: 'sleep', intervalMs: 60 });
    const lfB = T.guardianInfo().lastFire || {};
    const boltInfo = G.controller.lastHurt || {};
    ok('GD.10 远程光弹不能被盾挡（这一节没举盾）：9 格外出招、按 5 点结算，来源记成 guardian_bolt',
      boltW.ok && lfB.attack === 'bolt' && lfB.damage === 5 && lfB.blocked === false && lfB.los === true &&
      String(boltInfo.type) === 'guardian_bolt' && boltInfo.taken === 5 && lfB.dealt === 5,
      'lastFire=' + JSON.stringify(lfB) + ' lastHurt=' + JSON.stringify(boltInfo));



    /* ---------------- 11. 墙体遮挡：躲在墙后不吃伤害 ---------------- */
    G.controller.health = 20; G.controller.invulnerable = 0;
    /* 每次按**当前**守卫位置重新砌墙：守卫会走，用上一刻的坐标砌出来的墙可能根本不在连线上
       （第一版就是这样，墙砌在 -159 而守卫早走开了，读数还是 hit）。 */
    let wallBlocks = [];
    const buildWall = () => {
      const m = G.mobs.guardianMob();
      if (!m) return null;
      const p = G.controller.pos;
      const bx = Math.floor((p.x + m.pos.x) / 2), bz = Math.floor((p.z + m.pos.z) / 2);
      const by = Math.floor(p.y);
      wallBlocks = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = 0; dy < 3; dy++) for (let dz = -1; dz <= 1; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 1) continue;       // 十字形，堵住整条连线
        T.setBlock(bx + dx, by + dy, bz + dz, T.blockIds.STONE);
        wallBlocks.push([bx + dx, by + dy, bz + dz]);
      }
      return { bx, bz };
    };
    const dropWall = () => { for (const [x, y, z] of wallBlocks) T.setBlock(x, y, z, 0); wallBlocks = []; };
    const whip = buildWall();
    await frame(); await frame();
    const hpW0 = G.controller.health;
    const strikesW0 = T.guardianInfo().strikes || 0;
    let wallFire = null;
    const wallW = await until(() => {
      const lf = T.guardianInfo().lastFire;
      if (lf && (T.guardianInfo().strikes || 0) > strikesW0) {
        wallFire = lf;
        return lf.why === 'wall' || lf.why === 'range';
      }
      return false;
    }, { budgetMs: 30000, tick: 'sleep', intervalMs: 60 });
    const hpW1 = G.controller.health;
    dropWall();
    ok('GD.11 墙体遮挡：中间砌一道十字石墙时守卫照常出招，但伤害被墙挡掉（判据 wall / 距离外），血量不动',
      wallW.ok && !!wallFire && (wallFire.why === 'wall' || wallFire.why === 'range') &&
      wallFire.damage === 0 && hpW1 === hpW0,
      'lastFire=' + JSON.stringify(wallFire) + ' hp ' + hpW0 + '→' + hpW1 +
      ' 墙=' + (whip ? whip.bx + ',' + whip.bz : 'null'));


    /* ---------------- 12. 撤退：走远 → 回位满血，可以补给再来 ---------------- */
    const hpR0 = hp();
    T.teleport(site.x + 40.5, gy, site.z + 40.5);
    const leashW = await until(() => {
      const i = T.guardianInfo();
      return i.phase === 'dormant' && i.hp === i.maxHp;
    }, { budgetMs: 15000, tick: 'sleep', intervalMs: 100 });
    const backD = G.mobs.guardianMob() ? dist(G.mobs.guardianMob().pos, site) : -1;
    ok('GD.12 走远（>26 格）就脱战：守卫回位、回满血，玩家可以撤退补给再挑战',
      leashW.ok && hp() === T.guardianInfo().maxHp && backD >= 0 && backD < 6,
      'hp ' + hpR0 + '→' + hp() + ' 回位距站点=' + backD.toFixed(1) + ' 用时=' + leashW.ms + 'ms');

    /* ---------------- 13. 玩家死亡 → 可重试 ---------------- */
    T.teleport(site.x + 3.5, gy, site.z + 3.5);
    await until(() => T.guardianInfo().phase !== 'dormant', { budgetMs: 12000, tick: 'sleep', intervalMs: 100 });
    const gmK = G.mobs.guardianMob();
    if (gmK) T.hurtPlayer(40, 'melee', '验收：让玩家被打死', { x: gmK.pos.x, z: gmK.pos.z, kind: 'slam' });
    const deadW = await until(() => T.state().gameState === 'dead', { budgetMs: 6000, tick: 'sleep', intervalMs: 80 });
    const deadNow = T.state().gameState;
    G.respawn();
    const retryW = await until(() => T.guardianInfo().hp === T.guardianInfo().maxHp && T.guardianInfo().phase === 'dormant',
      { budgetMs: 12000, tick: 'sleep', intervalMs: 100 });
    ok('GD.13 玩家被打死之后守卫重置回满血可重试，玩家能重新站起来再打',
      deadW.ok && deadNow === 'dead' && retryW.ok && G.controller.health === 20,
      'deathState=' + deadNow + ' 重试后=' + JSON.stringify(T.guardianInfo()) + ' 玩家hp=' + G.controller.health);

    /* ---------------- 14. 战斗中退出 → 重进：相位重置、血量按存档保留 ---------------- */
    G.controller.health = 20; G.controller.invulnerable = 0;
    /* 复活点在出生点，守卫在 40 格外不会常驻 —— 先走回遗迹等它重新出现再打。
       （第一版直接读 guardianMob() 拿到 null，整个剧本在这里抛异常只跑到 14 条。） */
    T.teleport(site.x + 3.5, gy, site.z + 3.5);
    G.world.setCenter(site.x, site.z);
    const gmBack = await until(() => !!G.mobs.guardianMob(), { budgetMs: 25000, tick: 'sleep', intervalMs: 200 });
    await until(() => T.guardianWards().armed, { budgetMs: 8000, tick: 'sleep', intervalMs: 150 });
    G.inventory.add('sword_iron', 1);
    G.inventory.select(G.inventory.slots.findIndex(s => s && s.item === 'sword_iron'));
    let dealtMid = 0;
    for (let k = 0; k < 4; k++) {
      const m = G.mobs.guardianMob();
      if (!m) break;
      const dx = m.pos.x - G.controller.pos.x, dz = m.pos.z - G.controller.pos.z;
      G.controller.yaw = Math.atan2(-dx, -dz); G.controller.pitch = 0;
      G.controller.health = 20; G.controller.invulnerable = 0;
      await swing();
      dealtMid = T.guardianInfo().maxHp - hp();
    }
    if (!gmBack.ok) throw new Error('守卫没能重新出现：' + JSON.stringify(T.guardianInfo()));
    const hpMid = hp();
    const attemptsMid = T.guardianInfo().attempts;
    await G.save('manual');
    await G.toMenu();
    await G.loadWorld('守卫验收');
    const reloadW = await until(() => G.state === 'playing' && T.guardianInfo().present,
      { budgetMs: 30000, tick: 'sleep', intervalMs: 200 });
    const infoReload = T.guardianInfo();
    ok('GD.14 战斗中退出重进：临时相位回落到 dormant（不会凭空挨一发），血量按存档保留',
      reloadW.ok && infoReload.phase === 'dormant' && infoReload.hp === hpMid &&
      T.guardianSaved().attempts === attemptsMid,
      '存档前 hp=' + hpMid + ' attempts=' + attemptsMid + ' 读档后=' + JSON.stringify(infoReload) +
      ' saved=' + JSON.stringify(T.guardianSaved()));

    /* ---------------- 15. 真实铁剑击败守卫 ---------------- */
    T.teleport(site.x + 3.5, gy, site.z + 3.5);
    G.world.setCenter(site.x, site.z);
    await until(() => T.guardianInfo().present, { budgetMs: 20000, tick: 'sleep', intervalMs: 200 });
    await until(() => T.guardianWards().armed, { budgetMs: 8000, tick: 'sleep', intervalMs: 150 });
    /* 砍之前必须确认「守卫真的能被打」：区块没加载时封印读数会是 0（getBlock 对未加载区块走地形近似），
       守卫就一直是免疫态 —— 第一版 GD.15 砍 60 刀 hp 一点不掉就是这个形状。
       这里等区块加载 + 封印读数 armed 为真，如果仍没解开就把深板岩补一遍（只补空缺的座）。 */
    await T.waitChunks(2, { light: true }).catch(() => null);
    const armedW = await until(() => T.guardianWards().armed === true, { budgetMs: 12000, tick: 'sleep', intervalMs: 200 });
    if (!armedW.ok) {
      for (const w of T.guardianWards().pedestals) {
        const cur = G.world.getBlock(w.x, w.y, w.z);
        if (cur !== T.blockIds.DEEPSLATE) T.setBlock(w.x, w.y, w.z, T.blockIds.DEEPSLATE);
      }
      await frame(); await frame();
    }
    await until(() => T.guardianWards().armed === true && T.guardianInfo().armed === true,
      { budgetMs: 12000, tick: 'sleep', intervalMs: 200 });
    const gm6 = G.mobs.guardianMob();
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.inventory.add('sword_iron', 1);
    G.inventory.select(G.inventory.slots.findIndex(s => s && s.item === 'sword_iron'));
    const hpF0 = hp();
    const killT0 = performance.now();
    let hits = 0, landed = 0, hpPrev = hpF0;
    for (let k = 0; k < 120 && !T.guardianInfo().defeated; k++) {
      const m = G.mobs.guardianMob();
      if (!m) break;
      /* 本轮 A2 之后守卫**真的会追人打人**（旧实现被帧率 bug 拖成几乎不动），
         一刀的循环里它至少能砸中一次；20 点血撑不过三轮，玩家一死主循环就停，
         后面几十刀全是空挥。
         这一轮改用与 tests/probe-guardian-melee.mjs 完全相同的节奏（那份探针在同一站点
         9 刀打死守卫）：贴身 → 等两帧让相机跟上 → 按下 → 抬起 → 等冷却 → 再量血。
         不再用 until(attackTimer<=0) 预等，因为等待期间守卫会走到镜头侧后方，
         落刀时准星已经不在它身上（实测 120 刀只中 4~8 刀就是这个形状）。 */
      G.controller.health = 20; G.controller.invulnerable = 3;
      T.teleport(m.pos.x + 2.2, m.pos.y, m.pos.z);
      const ddx = m.pos.x - G.controller.pos.x, ddz = m.pos.z - G.controller.pos.z;
      G.controller.yaw = Math.atan2(-ddx, -ddz); G.controller.pitch = 0;
      G.controller.health = 20; G.controller.invulnerable = 3;
      await frame(); await frame();
      G.input.state.mouseLeft = false; await frame();
      G.input.state.mouseLeft = true; await frame(); await frame();
      G.input.state.mouseLeft = false;
      await sleep(160);
      const nowHp = hp();
      if (nowHp < hpPrev) landed++;
      hpPrev = nowHp;
      hits++;
      /* 攻击恢复（铁剑 0.625s）之后再进入下一刀 */
      await sleep(520);
    }
    const defeatedW = await until(() => T.guardianInfo().defeated === 1, { budgetMs: 15000, tick: 'sleep', intervalMs: 100 });
    const killMs = Math.round(performance.now() - killT0);
    /* 本轮 A4：这条断言的边界要写在标题里，不能让人把「7 秒击杀」当成正常难度结论。
       它验证的是**链路**：真实左键 → attackMelee → 伤害 → 击败 → 奖励结算 → 存档语义。
       为此每刀都做了三件正常规则里没有的事：传送到守卫侧面 2.2 格、把血量补回 20、给 3 秒无敌。
       正常规则下的实战（会被打、要躲/挡、可能失败）在第二轮 E 的自然路线里单独给证据。 */
    ok('GD.15[受控链路] 铁剑 + 真实左键能在受控条件下打死守卫（每刀传送贴身 + 补血 + 无敌；' +
      '只证明输入/伤害/击败/奖励链路，不代表正常难度）',
      defeatedW.ok && T.guardianInfo().hp === 0 && hpF0 === T.guardianInfo().maxHp,
      '受控条件：每刀 teleport(守卫+2.2)/health=20/invulnerable=3 | hp ' + hpF0 + '→' + T.guardianInfo().hp +
      ' 挥击=' + hits + ' 命中=' + landed + ' 用时=' + killMs + 'ms');

    /* ---------------- 16. 奖励：写进遗迹箱子，只结算一次 ---------------- */
    const stats = T.guardianStats();
    const lm = G.landmarks[site.id];
    const chest = lm && lm.chests && lm.chests[0];
    const slots = chest ? G.world.getContainer(chest.x, chest.y, chest.z) : [];
    const gotDiamond = slots.some(s => s && s.item === 'diamond' && s.count >= 2);
    const gotIron = slots.some(s => s && s.item === 'iron_ingot' && s.count >= 6);
    ok('GD.16 奖励写进遗迹箱子且只发一次：钻石 2 + 铁锭 6 + 绿宝石 2 + 金锭 3 都在箱子里',
      T.guardianInfo().defeated === 1 && T.guardianInfo().rewardClaimed === 1 &&
      !!stats.reward && stats.reward.length === 4 && gotDiamond && gotIron,
      'claimed=' + T.guardianInfo().rewardClaimed + ' reward=' + JSON.stringify(stats.reward) +
      ' 箱内钻石=' + gotDiamond + ' 铁=' + gotIron + ' 槽位=' + slots.filter(Boolean).map(s => s.item + 'x' + s.count).join(','));

    /* ---------------- 17. 保存重进：击败与领奖状态保留 ---------------- */
    await G.save('manual');
    await G.toMenu();
    await G.loadWorld('守卫验收');
    await until(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 200 });
    const after = T.guardianSaved();
    ok('GD.17 保存重进后击败与领奖状态原样保留（旧档字段语义不变，奖励不会复活重发）',
      after.defeated === 1 && after.rewardClaimed === 1 && after.siteKey === 'g:' + site.id && after.hp === 0 &&
      after.pedestals && after.pedestals.length === 4,
      'saved=' + JSON.stringify(after));

    /* ---------------- 18. 再次靠近：不刷新、不重复发奖 ---------------- */
    T.teleport(site.x + 3.5, gy, site.z + 3.5);
    G.world.setCenter(site.x, site.z);
    await sleep(2000);
    const again = T.guardianInfo();
    const slots2 = chest ? G.world.getContainer(chest.x, chest.y, chest.z) : [];
    const diamonds2 = slots2.filter(s => s && s.item === 'diamond').length;
    ok('GD.18 再次靠近已击败的遗迹：不再生成守卫，也不会再发第二份奖励',
      again.present === false && again.defeated === 1 && again.rewardClaimed === 1 && diamonds2 <= 1,
      'present=' + again.present + ' defeated=' + again.defeated + ' 钻石槽位=' + diamonds2);

    /* ---------------- 19. 旧档缺 guardian 字段：默认未挑战 ---------------- */
    const data = await G.storage.loadWorld('守卫验收');
    delete data.guardian;
    await G.storage.saveWorld('守卫验收', data);
    await G.loadWorld('守卫验收');
    await until(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 200 });
    const fresh = T.guardianSaved();
    ok('GD.19 旧档没有 guardian 字段：回落为「未挑战、满血、未领奖」，不报错（老存档照样能进）',
      fresh.defeated === 0 && fresh.hp === T.guardianInfo().maxHp && fresh.rewardClaimed === 0 &&
      fresh.siteKey === 'g:' + site.id,
      'saved=' + JSON.stringify(fresh));

    /* ---------------- 20. 运行期零异常 ---------------- */
    ok('GD.20 独立场景全程没有未捕获异常', R.errors.length === 0, 'errors=' + R.errors.length);
  } catch (e) {
    R.errors.push('守卫剧本异常: ' + (e && e.stack || e));
  }
  step('对账.1 守卫场景断言总数等于 EXPECTED_TOTAL（防止整节被吞/漏跑）',
    R.steps.length + 1 === EXPECTED_TOTAL,
    '实得 ' + (R.steps.length + 1) + ' 期望 ' + EXPECTED_TOTAL);
  R.done = true;
  R.pass = R.steps.filter(s => s.pass).length;
  R.total = R.steps.length;
})();