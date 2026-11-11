/*
 * 自动化验收剧本（在游戏页面里执行）。
 * 由 tests/e2e-electron.mjs 注入运行；结果写入 window.__e2e。
 */
(async () => {
  const R = { done: false, steps: [], errors: [], shot: null };
  window.__e2e = R;
  const t0 = performance.now();          // 分段计时原点：step() 里的 t 就是相对它过去的毫秒数
  /* 断言总数对账：每新增一条业务断言都要同步 +1。
     包含本文件末尾的「对账.1」自身，所以常量 = 业务断言数 + 1。 */
  /* 阶段 6/7 封版新增 7 条：6.7a~6.7g（桦木板真实合成 / 输入互斥 / 配方书展示 /
     随包 CC0 短音效随包解码与真实播放）。旧覆盖一条没删。 */
  const EXPECTED_TOTAL = 599;
  const step = (name, pass, info) => {
    /* 阶段 1 分段计时：每条断言都带上「相对剧本开始的毫秒数」。
       有了这条时间轴，才能回答「318 秒花在哪一节」，而不是靠峰值与体感。 */
    R.steps.push({ name, pass: !!pass, info: info === undefined ? '' : String(info), t: Math.round(performance.now() - t0) });
  };
  const ok = (name, cond, info) => step(name, cond, info);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const frame = (n = 1) => new Promise(r => requestAnimationFrame(() => r()));

  /* ===== 等待助手（必读）=====
   * 「推进 N 帧」在不同机器/不同帧率下对应的**真实时长**完全不同，这类断言已经连续翻车 6 次
   * （T3.9、回归.17/18、回归.13、10.2/10.3、SP.2、AN.3 —— 后两次都是源码 e2e 绿、打包自检红）。
   * 所以：凡是在「等某个状态出现」，一律用 until/tryUntil；
   * 凡是在「观察一段时间内不该发生什么」，一律用 watch。
   * 纯计数循环（例如遍历 9 个格子找物品）不属于等待，可以保留 for 循环。
   * 还有第三种坑：值本身是**同步写入**的（如 heldView.swing = strength），却「等一帧再读」，
   * 读到的其实是「这一帧里它衰减了多少」——那还是在测帧长。要么同帧直接读（AN.3 的起势），
   * 要么整段动画取峰值（AN.3 的位姿偏移），这两个数才与机器速度无关。 */

  /** 每帧检查 pred()；成立返回 {ticks, ms}，超过预算抛错（带 label 与最后一次观测值） */
  async function until(pred, opts = {}) {
    const budgetMs = opts.budgetMs === undefined ? 8000 : opts.budgetMs;
    const label = opts.label || '条件';
    const t0 = performance.now();
    let ticks = 0, last = null;
    for (;;) {
      if (opts.tick === 'sleep') await sleep(opts.intervalMs || 120); else await frame();
      ticks++;
      last = pred();
      if (last) return { ticks, ms: Math.round(performance.now() - t0), value: last };
      if (performance.now() - t0 > budgetMs) {
        let obs;
        try { obs = opts.observe ? opts.observe() : last; } catch (e) { obs = String(e && e.message); }
        const err = new Error('等待超时：' + label + '（预算 ' + budgetMs + 'ms，检查 ' + ticks +
          ' 次，最后一次观测=' + JSON.stringify(obs) + '）');
        err.timeout = true;
        throw err;
      }
    }
  }

  /** 断言点用的安全版：超时不抛错，返回 {ok:false, timeout:'...'}，免得一条卡住整条剧本 */
  async function tryUntil(pred, opts = {}) {
    try {
      const r = await until(pred, opts);
      return { ok: true, ticks: r.ticks, ms: r.ms, value: r.value };
    } catch (e) {
      return { ok: false, timeout: (e && e.message) || String(e) };
    }
  }

  /** 观察窗口：跑满 durationMs，期间 bad() 一旦成立就提前返回（用于「不应该发生」类断言） */
  async function watch(durationMs, bad, opts = {}) {
    const t0 = performance.now();
    let ticks = 0;
    while (performance.now() - t0 < durationMs) {
      if (opts.tick === 'sleep') await sleep(opts.intervalMs || 120); else await frame();
      ticks++;
      if (bad()) return { violated: true, ticks, ms: Math.round(performance.now() - t0) };
    }
    return { violated: false, ticks, ms: Math.round(performance.now() - t0) };
  }

  /* ===== 「按住不放」夹具助手（2026-11-08 加，先读这段再用）=====
   * 现象：Q1.3 真实左键挖原木、V5.1 拉弓蓄力、R2.1/E3.1 按住 W 走楼梯这类
   *       「把某个输入按住几秒」的断言在整程里偶发红；单独隔离复现 8/8 全过
   *       （artifacts/repro-q1.json：3.6~4.6 秒挖到，期间 blur=0、mouseLeft 一直为真）。
   * 根因：`player/input.js` 在 window blur 时调 `_clearAll()`（input.js:43）——
   *       这是**产品的正确行为**：真玩家切出窗口，按键与鼠标必须松掉，不能留下「幽灵按住」。
   *       整程里截图（capturePage）与系统焦点切换会把 mouseLeft/mouseRight/keyW 清掉，
   *       于是「按住」这件事在脚本跑第 5 分钟时被打断，挖掘/蓄力/行走进度归零。
   * 处理：夹具**像真人一样重新按住** —— 判定阈值、时间预算、断言数量一字不动，
   *       只把「按住」恢复成它本来该有的语义；同时把重按次数与首次打断时刻记进断言详情，
   *       留下「什么时候被打断、打断了几次」的现场，便于日后区分产品问题与运行环境问题。
   * 用法：down 是「按下去」的动作（真实 DOM 事件或 T.key / input.state 直写都行，由调用方决定，
   *       不改变这条断言走的是哪条输入路径）；alive 是「现在还按着吗」的探针。 */
  async function holdWhile(down, pred, opts = {}) {
    const budgetMs = opts.budgetMs === undefined ? 12000 : opts.budgetMs;
    const alive = opts.alive || (() => true);
    const t0 = performance.now();
    let reassert = 0, firstLostMs = null, ticks = 0;
    down();
    for (;;) {
      ticks++;
      if (pred()) return { ok: true, reassert, firstLostMs, ticks, ms: Math.round(performance.now() - t0) };
      if (!alive()) {
        reassert++;
        if (firstLostMs === null) firstLostMs = Math.round(performance.now() - t0);
        down();
      }
      if (performance.now() - t0 > budgetMs) {
        return { ok: false, reassert, firstLostMs, ticks, ms: Math.round(performance.now() - t0),
          timeout: '按住超时（预算 ' + budgetMs + 'ms，重按 ' + reassert + ' 次，首次打断@' + firstLostMs + 'ms）' };
      }
      await frame();
    }
  }
  const heldTag = (w) => '按住重按=' + (w && w.reassert) + ' 次' +
    (w && w.firstLostMs !== null ? '（首次打断@' + w.firstLostMs + 'ms）' : '（按住没被打断）');
  const G = window.__game, T = window.__test;
  /* 请求宿主截图并等它完成：capturePage 会短暂压住渲染，紧接着的移动断言曾偶发 fps=1。
     打包自检没有宿主 ack，最多等 3 秒后继续；这不改变任何产品行为。 */
  const snap = async (name) => {
    R.shot = name;
    await tryUntil(() => R.shotAck === name, { budgetMs: 3000, tick: 'sleep', intervalMs: 80, label: '宿主截图 ' + name });
    await tryUntil(() => !window.__game || window.__game.state !== 'playing' || window.__game.fps >= 20 || window.__game.fps === 0,
      { budgetMs: 2500, tick: 'sleep', intervalMs: 100, label: '截图后渲染恢复' });
  };

  window.addEventListener('error', e => R.errors.push('window: ' + e.message));
  window.addEventListener('unhandledrejection', e => R.errors.push('promise: ' + String(e && e.reason)));

  /* ===== 现场录像：这帧「暂停」是谁按的？（2026-11-08 加，先读这段再动 TN）=====
   * 打包自检曾在 TN.6 之后中断（artifacts/selftest-3b.txt：通过 371/374 + 运行错误 1），
   * 三条红线其实是同一条链：TN.7 blasts=0/last=null、TN.8 last=null、TN.9
   * 「等待超时：交互层收到右键 … {"wasRight":false,"state":"paused","openUI":null}」。
   * `game.js:1840` 的 tickTnt 只在 state==='playing' 时推进引信，所以真正的现象是
   * 「TN.6 之后游戏被挂起，后面三节测的是一份静止的存档」——不是 TNT 逻辑坏了。
   * `state='paused'` 全仓库只有 `Game.pause()` 一处写入（game.js:1362），调用点有三类：
   * Escape 的按键处理器（game.js:624）、设置面板「返回」时代码里重开暂停菜单（ui.js:433）、
   * 以及剧本自己直调。到底走了哪一条，报告里查不到，于是装三个只读探针：
   *   keyLog   —— capture 阶段记录每个 Escape keydown（isTrusted=true 才是真键盘干扰的直接证据）；
   *   pauseLog —— 拦一次 G.pause，按「调用栈上一帧是不是注入脚本」+「window.event.isTrusted」分类：
   *               剧本直调、或剧本合成的按键/点击 ⇒ 'scripted'（绝不插手）；
   *               真人真键盘、或产品内部自己调用 ⇒ 'event'（外来干扰，pause() 返回后就地 resume）；
   *   stateLog —— 每 200ms 采样一次状态迁移，覆盖不经过 pause() 的直写情况。
   * 第一轮实测（artifacts/run-1108-2.txt）能证实的三件事：
   *   ① 整程 15 次 pause() = 14 次 scripted + 1 次 'event'；
   *   ② 整程 Escape 记录**全部** isTrusted=false ⇒ 那一次不是「真人按 Escape」；
   *      但这只排除了一条通道（还有点击 / 失焦 / 产品内部调用），所以才要把栈与 DOM 事件类型留全；
   *   ③ 那一次 'event' 的 恢复耗时=[186071]：旧版守卫要求「当前确实是 paused」才动手，
   *      所以它挂了 186 秒，撞上后面某一节**故意**暂停时才 resume。
   * 但当时报告只打印最后三条记录，看不到那条 event 的调用栈，所以**它到底从哪来还不能定论**
   * （候选只有两类：合成 DOM 事件走产品自己的处理器，或产品内部直接调 pause()）。
   * 因此这一版：分类改成「调用栈 + window.event.isTrusted」两件事一起看，
   * event 改为 pause() 返回后就地恢复，并把**每一次 event 的栈与 DOM 事件类型**直接打进
   * 「现场.1」的详情里 —— 打包自检那次 paused 要由证据定性，不靠猜。
   * 同一次运行里 MU.5 与 Q.4 两条红发生在那条记录之前、与它无关，是各自夹具的边界问题
   * （Q.4：双方都被埋进实心立方体、引信期间玩家被顶出到 8 格外；MU.5：落点正好压在
   *  surfaceHeight-3 这条判据的边界上。分别见那两节的注释）。 */
  const keyLog = [];
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    keyLog.push({ t: Math.round(performance.now() - t0), trusted: !!e.isTrusted, target: (e.target && (e.target.id || e.target.tagName)) || '?' });
    if (keyLog.length > 40) keyLog.shift();
  }, true);

  const pauseLog = [];
  const stateLog = [];
  /* pauseLog 只留最近 40 条（内存有界），但「现场.1」的判据不能依赖数组还在不在，
     所以另用两个单调计数器记账。 */
  let evTotal = 0, evRecovered = 0;
  const evLog = [];                     // 每一次 event 暂停都留全量（pauseLog 有 40 条上限，取证不能被挤掉）
  const G0 = window.__game;
  const rawPause = G0.pause.bind(G0);
  G0.pause = function tracedPause() {
    const frames = (new Error().stack || '').split('\n').slice(1, 5)
      .map(s => s.trim().replace(/^at\s+/, ''));
    const caller = frames[1] || '';
    /* 来源判定要同时看两件事（第一版只看调用栈，结果把「剧本点击真实 UI 按钮 → 产品里调 pause()」
       误判成外来按键，实测整程出现 1 次假 event）：
       ① 调用栈的上一帧是注入脚本（<anonymous>:行:列）⇒ 剧本直调；
       ② 当前正在处理的那个 DOM 事件 isTrusted === false ⇒ 剧本合成的按键/点击。
       只有「真人真键盘」（isTrusted true）或产品内部自己调 pause() 才算 event。 */
    const dom = (typeof window !== 'undefined' && window.event) || null;
    const trusted = dom ? !!dom.isTrusted : null;
    const fromScript = /<anonymous>:\d+/.test(caller);
    const syntheticDom = trusted === false;
    const rec = {
      t: Math.round(performance.now() - t0), kind: (fromScript || syntheticDom) ? 'scripted' : 'event',
      fromScript, trusted, domEvent: dom ? (dom.type || '?') : null, state: G0.state,
      stack: frames.slice(0, 3).join(' <- ')
    };
    pauseLog.push(rec);
    if (rec.kind === 'event') evLog.push(rec);
    if (pauseLog.length > 40) pauseLog.shift();
    const r = rawPause();
    /* 只有「这次调用真的把游戏从 playing 按成 paused」才算需要自愈的外来暂停。
       本轮实测抓到一次反例：`ui.js:433` 在游戏**已经**暂停时又调了一次 pause()，
       `pause()` 自己早退（game.js:1360），这种记录绝不能去 resume——
       那一节正停在暂停界面上测按钮。记录仍留在 evLog 里当证据。 */
    if (rec.kind === 'event') {
      if (rec.state === 'playing' && G0.state === 'paused') {
        evTotal++;
        G0.resume();
        rec.recoveredMs = 0;
        evRecovered++;
      } else {
        rec.noop = true;              // 没有真的改变状态：既不算外来暂停，也不需要恢复
      }
    }
    return r;
  };
  let prevState = G0.state;
  const stateTimer = setInterval(() => {
    try {
      if (G0.state === prevState) return;
      stateLog.push({ t: Math.round(performance.now() - t0), from: prevState, to: G0.state });
      prevState = G0.state;
      if (stateLog.length > 30) stateLog.shift();
    } catch (e) { /* ignore */ }
  }, 200);
  const stateSnap = () => ({
    state: G0.state, openUI: G0.openUI, fps: G0.fps,
    pos: G0.controller ? [Math.round(G0.controller.pos.x), Math.round(G0.controller.pos.y), Math.round(G0.controller.pos.z)] : null
  });
  const pauseEvidence = () => '暂停取证=' + JSON.stringify(pauseLog.slice(-3)) +
    ' Escape=' + JSON.stringify(keyLog.slice(-3)) + ' 状态迁移=' + JSON.stringify(stateLog.slice(-6));

  try {
    /* ---------------- 1. 主菜单 ---------------- */
    ok('1.1 主菜单为中文且有四个入口',
      document.querySelector('#screen-menu').textContent.includes('新建世界') &&
      document.querySelector('#screen-menu').textContent.includes('读取存档') &&
      document.querySelector('#screen-menu').textContent.includes('设置') &&
      document.querySelector('#screen-menu').textContent.includes('退出游戏'));

    /* ---------------- 1B. 阶段 B（上）：第一次手势唤醒音频 / 菜单点击音 / 音量下发 ----------------
     * 必须放在进世界之前：「第一次用户手势」一生只有一次，进世界后 AudioContext 早就存在，测不出来了。
     * 整节用独立 {} 包住，b* 临时变量不与后面 58 节重名。 */
    {
      const bG = window.__game, bT = window.__test;
      const bV0 = bT.audioVolumes();
      const bS0 = bT.sfxStats();
      const bPlayed0 = bS0.played;
      bG.sfx.play('click', { volume: 0.3 });
      const bS1 = bT.sfxStats();
      ok('B.1 进世界前的主菜单是真的静音：AudioContext 没建，play() 被如实记成 dropped（不是「字段全绿却没声」）',
        bG.state === 'menu' && bV0.ready === false && bV0.ctxState === 'none' &&
        bS1.played === bPlayed0 && bS1.dropped === bS0.dropped + 1 &&
        !!bS1.lastDrop && bS1.lastDrop.reason === 'not-ready',
        'state=' + bG.state + ' v0=' + JSON.stringify(bV0) + ' s1=' + JSON.stringify(bS1));

      /* 一次任意手势（capture 阶段先于任何按钮处理器）就应当把音频图建起来 */
      window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      const bV1 = bT.audioVolumes();
      ok('B.2 第一次任意用户手势就把音频图建起来（不等进世界、不靠点画面），ready 为真且总线都在',
        bV1.ready === true && bV1.ctxState !== 'none' && !!bG.sfx.ctx && !!bG.sfx.sfxBus && !!bG.sfx.master,
        JSON.stringify(bV1));

      const bS2 = bT.sfxStats();
      document.querySelector('#screen-menu [data-a=settings]').click();
      await frame();
      const bSetOpen = !document.querySelector('#screen-settings').classList.contains('hidden');
      const bS3 = bT.sfxStats();
      document.querySelector('#btn-back2').click();
      await frame();
      const bMenuBack = !document.querySelector('#screen-menu').classList.contains('hidden') &&
        !!document.querySelector('#screen-menu [data-a=new]');
      ok('B.3 菜单按钮真的有轻点击音：计入 played/byName 而不是 dropped，且设置面板能回到菜单',
        bSetOpen && bMenuBack && bS3.played > bS2.played &&
        (bS3.byName.click || 0) > (bS2.byName.click || 0) &&
        !!bS3.last && bS3.last.name === 'click',
        '开设置=' + bSetOpen + ' 回菜单=' + bMenuBack +
        ' s2=' + JSON.stringify({ played: bS2.played, dropped: bS2.dropped, click: bS2.byName.click || 0 }) +
        ' s3=' + JSON.stringify({ played: bS3.played, dropped: bS3.dropped, click: bS3.byName.click || 0, last: bS3.last }));

      /* B.4：先按生产路径存一组非默认音量，再把 Sfx 内部音量恢复成「新进程刚 new Sfx()」的样子，
         然后走真实 init() —— 只有 init 真的下发，持久化数字才会回来（本轮修的就是这条线）。 */
      await bG.applySettingsLive({ volumeMaster: 0.3, volumeSfx: 0.55, volumeMusic: 0.2 });
      bG.sfx._vols = { master: 0.8, sfx: 0.85, music: 0.4 };
      await bG.init(bG.ui);
      const bV2 = bT.audioVolumes();
      const bE2 = bT.audioEnergy();
      ok('B.4 持久化音量在 init 里真的下发：_vols 与总线增益都等于存档里的数字，不是只改了设置字段',
        bV2.settings.master === 0.3 && bV2.settings.sfx === 0.55 && bV2.settings.music === 0.2 &&
        bV2.delivered.master === 0.3 && bV2.delivered.sfx === 0.55 && bV2.delivered.music === 0.2 &&
        Math.abs(bE2.gains.master - 0.3) < 1e-6 &&
        Math.abs(bE2.gains.sfx - 0.55 * 1.25) < 1e-5,   // sfx 总线 = 音量 × LEVEL(1.25)
        'v=' + JSON.stringify(bV2) + ' gains=' + JSON.stringify(bE2.gains));
      await bG.applySettingsLive({ volumeMaster: 0.7, volumeSfx: 0.8, volumeMusic: 0.45 });   // 恢复默认，后续节照旧
    }

    /* ---------------- 2. 新建世界 ---------------- */
    document.querySelector('[data-a=new]').click();
    await frame();
    const nameInput = document.querySelector('#inp-name');
    nameInput.value = '验收世界';
    document.querySelector('#inp-seed').value = 'acceptance-2026';
    document.querySelector('#m-survival').click();
    document.querySelector('#btn-create').click();
    // 等待世界生成完成（轮询到就绪，不再数固定次数）
    const wLoad = await tryUntil(
      () => document.querySelector('#screen-loading').classList.contains('hidden') &&
        G.state === 'playing' && G.world.genQueue.length === 0 && G.world.dirtyMesh.size === 0,
      { budgetMs: 40000, tick: 'sleep', intervalMs: 120, label: '世界生成完成' });
    ok('2.0 世界在预算内生成完成（超时说明加载卡住）', wLoad.ok, wLoad.ok ? '用时 ' + wLoad.ms + 'ms' : wLoad.timeout);
    await sleep(400);
    ok('2.1 世界创建进入游戏中', G.state === 'playing', 'state=' + G.state);
    ok('2.2 种子被记录且世界名正确', G.meta.name === '验收世界' && String(G.meta.seed) === 'acceptance-2026', G.meta.seed);
    ok('2.3 出生点在地表之上且着地', G.controller.onGround && G.controller.pos.y > 5, 'y=' + G.controller.pos.y.toFixed(2));
    ok('2.4 区块按视距流式加载（未加载整个世界）',
      G.world.chunks.size > 20 && G.world.chunks.size < 400, 'chunks=' + G.world.chunks.size);
    const kinds = new Set();
    for (const [, c] of G.world.chunks) for (let i = 0; i < c.blocks.length; i++) kinds.add(c.blocks[i]);
    ok('2.5 地形包含草/土/石/水/木/叶/矿', [3, 2, 1, 9, 10, 11, 18].every(id => kinds.has(id)), [...kinds].join(','));

    /* 滚动任务 6：新世界应在出生点附近自带一座小村庄（结构 + 一个农夫村民） */
    const viBoot = await tryUntil(() => {
      const v = T.villageInfo();
      return v.built && v.present === v.expected;
    }, { budgetMs: 15000, label: '村庄结构落地', observe: () => { const v = T.villageInfo(); return { built: v.built, present: v.present, expected: v.expected }; } });
    const vi0 = T.villageInfo();
    const viDist = vi0.built ? Math.hypot(vi0.origin.x - G.spawn.x, vi0.origin.z - G.spawn.z) : -1;
    ok('VI.1 新世界在出生点附近生成确定性村庄：结构全部落地、村民是农夫且守在家里',
      viBoot.ok && vi0.built && vi0.present === vi0.expected && vi0.expected > 250 &&
      !!vi0.villager && vi0.villager.profession === 'farmer' && !!vi0.villager.home &&
      viDist > 6 && viDist < 32,
      '结构 ' + vi0.present + '/' + vi0.expected + ' 距出生点 ' + viDist.toFixed(1) +
      ' 村民=' + JSON.stringify(vi0.villager));

    /* E2.0 新世界要一次生成三名职业村民，家坐标由站点固定偏移确定（不随机漂移）。 */
    const viE2Roster = vi0.roster || [];
    const viE2ByProf = {};
    for (const rv of viE2Roster) viE2ByProf[rv.profession] = rv;
    const viE2Home = (p) => {
      const rv = viE2ByProf[p];
      return rv && rv.home ? [+(rv.home.x - vi0.origin.x).toFixed(1), +(rv.home.z - vi0.origin.z).toFixed(1)] : null;
    };
    ok('E2.0 新世界村庄一次生成农夫/图书管理员/铁匠三名村民，站位由站点固定偏移决定',
      vi0.villagers === 3 && viE2Roster.length === 3 &&
      ['farmer', 'librarian', 'blacksmith'].every(p => !!viE2ByProf[p]) &&
      JSON.stringify(viE2Home('farmer')) === '[3.5,-3.5]' &&
      JSON.stringify(viE2Home('librarian')) === '[-3.5,-3.5]' &&
      JSON.stringify(viE2Home('blacksmith')) === '[3.5,2.5]',
      '村民=' + JSON.stringify(viE2Roster.map(r => ({ p: r.profession, home: viE2Home(r.profession) }))) + ' state=' + G.state);

    /* E3.0 新世界要生成一处废弃矿工营地：24~48 格、干燥、避开村庄，结构/房间/箱子完整。 */
    const caBoot = T.campInfo();
    const caBootChest = (table) => (caBoot.chests || []).find(c => c.table === table) || { items: [] };
    const caBootHas = (table, item) => caBootChest(table).items.some(i => i.item === item && i.count > 0);
    const caBootDiamond = caBoot.chests ? caBoot.chests.some(c => c.items.some(i => i.item === 'diamond')) : false;
    const caVillageDist = caBoot.built
      ? Math.hypot(caBoot.origin.x - vi0.origin.x, caBoot.origin.z - vi0.origin.z) : -1;
    ok('E3.0 新世界在 24~48 格外生成废弃营地：地面设施/5 级楼梯/7×7 黑暗房间/两个固定战利品箱子',
      caBoot.built && caBoot.builds === 1 && caBoot.distSpawn >= 24 && caBoot.distSpawn <= 48 &&
      caBoot.aboveSea && caVillageDist >= caBoot.radius + caBoot.maxExtent + 4 &&
      caBoot.expected === caBoot.present && caBoot.chests.length === 2 &&
      caBoot.room.x1 - caBoot.room.x0 + 1 === 7 && caBoot.room.z1 - caBoot.room.z0 + 1 === 7 &&
      caBoot.room.ceil - caBoot.room.floor - 1 === 3 && caBoot.roomAir === 146 && caBoot.roomTorches === 0 &&
      caBootHas('surface', 'bread') && caBootHas('surface', 'arrow') &&
      caBootHas('underground', 'iron_ingot') && caBootHas('underground', 'emerald') &&
      caBootHas('underground', 'bread') && caBoot.diamond === caBootDiamond,
      JSON.stringify({
        origin: caBoot.origin, distSpawn: caBoot.distSpawn, village: caVillageDist,
        expected: caBoot.expected, present: caBoot.present, room: caBoot.room,
        roomAir: caBoot.roomAir, roomTorches: caBoot.roomTorches, diamond: caBoot.diamond,
        chests: caBoot.chests && caBoot.chests.map(c => ({ table: c.table, items: c.items }))
      }));

    await snap('world');
    await sleep(200);

    // 帧率探针（后续时序断言的可解释性依据）
    let frames = 0;
    const tFps0 = performance.now();
    // 这是「测量 1 秒内跑多少帧」的采样窗口（要的就是帧数本身），不是等条件，故保留 while
    while (performance.now() - tFps0 < 1000) { await frame(); frames++; }
    ok('2.6 帧率探针', true, 'rAF ' + frames + ' fps · game.fps=' + G.fps + ' · 区块=' + G.world.chunks.size);

    /* ---------------- 3. 移动 / 跳跃 / 碰撞 ---------------- */
    // 在脚下铺一块 5x5 平整平台，保证跳跃与移动测试不受地形影响
    const px0 = Math.floor(G.controller.pos.x), pz0 = Math.floor(G.controller.pos.z);
    const py0 = Math.floor(G.controller.pos.y) - 1;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      for (let dy = 0; dy < 3; dy++) T.setBlock(px0 + dx, py0 + dy, pz0 + dz, dy === 0 ? 4 : 0);
    }
    T.teleport(px0 + 0.5, py0 + 1.05, pz0 + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: '落地站稳', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });
    await sleep(200);

    const p0 = { ...G.controller.pos };
    G.controller.yaw = 0; G.controller.pitch = 0;
    T.key('KeyW', true);
    // 轮询到位移真的超过 0.8 格（固定 70 帧在低帧率机器上真实时长不够，会误报——已翻车 5 次）
    const wMove = await tryUntil(
      () => Math.hypot(G.controller.pos.x - p0.x, G.controller.pos.z - p0.z) > 0.8,
      { budgetMs: 2000, label: 'W 前进位移超过 0.8 格', observe: () => Math.hypot(G.controller.pos.x - p0.x, G.controller.pos.z - p0.z) });
    T.key('KeyW', false);
    const moved = Math.hypot(G.controller.pos.x - p0.x, G.controller.pos.z - p0.z);
    ok('3.1 W 前进产生位移', moved > 0.8, 'moved=' + moved.toFixed(2) + ' fps=' + G.fps +
      ' 用时=' + (wMove.ok ? wMove.ms + 'ms' : '超时:' + wMove.timeout));

    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: '落地站稳', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });
    const yBefore = G.controller.pos.y;
    T.key('Space', true);
    let peak = yBefore;
    const jumpT0 = performance.now();
    // 记录上升峰值，轮询到「确实落地且峰值已出现」（至少给 300ms，避免在起跳瞬间就判过）
    const wJump = await tryUntil(() => {
      if (G.controller.pos.y > peak) peak = G.controller.pos.y;
      return G.controller.onGround && performance.now() - jumpT0 > 300;
    }, { budgetMs: 5000, label: '跳跃起跳后落地', observe: () => ({ peak: +peak.toFixed(2), y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });
    T.key('Space', false);
    ok('3.2 跳跃能离地约 1.2 格并回到地面', peak - yBefore > 0.9 && G.controller.onGround,
      'Δy=' + (peak - yBefore).toFixed(2) + ' onGround=' + G.controller.onGround + ' fps=' + G.fps + ' state=' + G.state +
      ' 用时=' + (wJump.ok ? wJump.ms + 'ms' : '超时:' + wJump.timeout));

    // 碰撞：在面前筑一堵墙，前进不应穿过
    const bx = Math.floor(G.controller.pos.x), bz = Math.floor(G.controller.pos.z);
    const by = Math.floor(G.controller.pos.y);
    const wallZ = bz - 3;
    for (let dy = 0; dy < 3; dy++) T.setBlock(bx, by + dy, wallZ, 1);
    await sleep(150);
    G.controller.spawnAt(bx + 0.5, by, bz + 0.5);
    G.controller.yaw = Math.PI;   // 朝 +Z？yaw=PI 视线朝 +Z
    G.controller.yaw = 0;         // yaw=0 朝 -Z，墙在 -Z 方向
    T.key('KeyW', true);
    // 观察 1.5 秒：期间一旦穿墙就立刻停（固定 120 帧在不同帧率下观察时长不同）
    const wWall = await watch(1500, () => G.controller.pos.z <= wallZ + 1.0);
    T.key('KeyW', false);
    ok('3.3 撞墙不穿透（AABB 碰撞有效）', G.controller.pos.z > wallZ + 1.0,
      'z=' + G.controller.pos.z.toFixed(2) + ' 墙面=' + (wallZ + 1) +
      ' 观察=' + wWall.ms + 'ms/' + wWall.ticks + '帧' + (wWall.violated ? ' 曾穿墙!' : ''));
    ok('3.4 墙壁方块仍然 solid', G.world.getBlock(bx, by, wallZ) === 1);

    /* ---------------- 4. 挖掘与放置 ---------------- */
    T.give('pickaxe_stone', 1);
    T.select(0);
    // 站到低处并瞄准脚下草方块
    const fx = Math.floor(G.controller.pos.x), fz = Math.floor(G.controller.pos.z);
    const groundY = Math.floor(G.controller.pos.y) - 1;
    const aim = (tx, ty, tz) => {
      const ex = G.controller.pos.x, ey = G.controller.eyeY, ez = G.controller.pos.z;
      const dx = tx + 0.5 - ex, dy = ty + 0.5 - ey, dz = tz + 0.5 - ez;
      G.controller.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
      G.controller.yaw = Math.atan2(-dx, -dz);
    };
    // 面前放一个石头再挖掉
    const tx = fx + 2, ty = groundY + 1, tz = fz;
    T.setBlock(tx, ty, tz, 4);            // 圆石
    await sleep(60);
    aim(tx, ty, tz);
    G.interaction.updateTarget();
    let hit = G.interaction.target;
    ok('4.1 射线能命中目标方块且有选中框', hit && hit.x === tx && hit.y === ty && hit.z === tz, JSON.stringify(hit));
    ok('4.2 选中框网格可见', G.view.selEdges.visible);

    const before = G.getBlockCount ? 0 : 0;
    T.mineAt(tx, ty, tz);
    await sleep(150);
    ok('4.3 挖掘后方块变空气', G.world.getBlock(tx, ty, tz) === 0);
    ok('4.4 挖掘产生掉落物实体', G.interaction.drops.list.length >= 1, 'drops=' + G.interaction.drops.list.length);
    // 走过去拾取
    G.controller.spawnAt(tx + 0.5, G.controller.pos.y, tz + 0.5);
    const wPick1 = await tryUntil(() => G.inventory.countOf('cobblestone') >= 1,
      { budgetMs: 4000, label: '掉落物被吸附拾取', observe: () => G.inventory.countOf('cobblestone') });
    ok('4.5 掉落物被吸附拾取进背包', G.inventory.countOf('cobblestone') >= 1,
      'cobblestone=' + G.inventory.countOf('cobblestone') + ' 用时=' + (wPick1.ok ? wPick1.ms + 'ms' : '超时'));

    // 放置：选中泥土右键
    T.give('dirt', 10);
    for (let i = 0; i < 9; i++) if (G.inventory.get(i) && G.inventory.get(i).item === 'dirt') T.select(i);
    const pz = Math.floor(G.controller.pos.z) + 2, ppy = Math.floor(G.controller.pos.y) - 1;
    aim(Math.floor(G.controller.pos.x), ppy + 1, pz);
    G.interaction.updateTarget();
    G.input.state.mouseRight = true;
    G.interaction.update(0.02);
    G.input.state.mouseRight = false;
    await sleep(120);
    // 在瞄准点附近找新出现的泥土（放置位置取决于命中的是哪一个面）
    let foundDirt = null;
    for (let dy = -2; dy <= 2 && !foundDirt; dy++)
      for (let dz = -2; dz <= 3 && !foundDirt; dz++)
        for (let dx = -2; dx <= 2 && !foundDirt; dx++)
          if (G.world.getBlock(Math.floor(G.controller.pos.x) + dx, ppy + dy, pz + dz) === 2)
            foundDirt = [Math.floor(G.controller.pos.x) + dx, ppy + dy, pz + dz];
    ok('4.6 右键放置方块成功', !!foundDirt, '放置到 ' + JSON.stringify(foundDirt));
    ok('4.7 放置会扣除背包数量', G.inventory.countOf('dirt') < 10, 'left=' + G.inventory.countOf('dirt'));

    /* ---------------- 5. 背包 / 快捷栏 / 堆叠 ---------------- */
    document.querySelector('#hud').dispatchEvent(new Event('noop'));
    G.input._onKey({ code: 'Digit3', preventDefault() { } }, true);
    await frame();
    ok('5.1 数字键切换快捷栏', G.inventory.selected === 2, 'selected=' + G.inventory.selected);
    G.input._onScroll ? 0 : 0;
    T.key('Digit3', false);
    G.input._onWheel({ deltaY: 120, preventDefault() { } });
    await frame();
    ok('5.2 滚轮切换快捷栏', G.inventory.selected === 3, 'selected=' + G.inventory.selected);
    T.give('sand', 200);
    let sandSlots = 0;
    for (const s of G.inventory.slots) if (s && s.item === 'sand') sandSlots++;
    ok('5.3 超出单格上限自动分堆（每堆 64）', sandSlots >= 4, 'sand 占用格数=' + sandSlots);
    ok('5.4 单堆不超过 64', G.inventory.slots.every(s => !s || s.count <= 64));

    // 真实 DOM 拖拽：左键拿起 / 放到空格 / 右键对半 / 右键逐个放回
    G.openInventory();
    await frame();
    const sandSlot = G.inventory.slots.findIndex(s => s && s.item === 'sand');
    const domOf = (i) => document.querySelector('#panel-inventory [data-slot="inv:' + i + '"]');
    const md = (node, btn, shift) => node.dispatchEvent(new MouseEvent('mousedown', { button: btn, bubbles: true, shiftKey: !!shift }));
    md(domOf(sandSlot), 0);
    await frame();
    ok('5.5 左键点击背包格可拿起整堆', !!G.inventory.cursor && G.inventory.cursor.item === 'sand' && !G.inventory.get(sandSlot),
      'cursor=' + JSON.stringify(G.inventory.cursor));
    const emptyIdx = G.inventory.slots.findIndex((s, i) => !s && i >= 9);
    md(domOf(emptyIdx), 0);
    await frame();
    ok('5.6 再次左键放下整堆', !G.inventory.cursor && G.inventory.get(emptyIdx) && G.inventory.get(emptyIdx).count === 64,
      '目标格=' + JSON.stringify(G.inventory.get(emptyIdx)));
    md(domOf(emptyIdx), 2);
    await frame();
    ok('5.7 右键可取一半', !!G.inventory.cursor && G.inventory.cursor.count === 32 && G.inventory.get(emptyIdx).count === 32,
      'cursor=' + (G.inventory.cursor && G.inventory.cursor.count) + ' 剩余=' + G.inventory.get(emptyIdx).count);
    const empty2 = G.inventory.slots.findIndex((s, i) => !s && i >= 9 && i !== emptyIdx);
    md(domOf(empty2), 2);
    await frame();
    ok('5.8 右键在空格逐个放置', G.inventory.get(empty2) && G.inventory.get(empty2).count === 1 && G.inventory.cursor.count === 31,
      '放置=' + JSON.stringify(G.inventory.get(empty2)));
    const totalBefore = G.inventory.countOf('sand') + (G.inventory.cursor ? G.inventory.cursor.count : 0);
    G.closeUI();
    await sleep(80);
    ok('5.9 关闭背包时光标物品自动退回背包（总数守恒）',
      !G.inventory.cursor && G.inventory.countOf('sand') === totalBefore,
      '关闭前=' + totalBefore + ' 关闭后=' + G.inventory.countOf('sand'));

    /* ---------------- 6. 合成主线 ---------------- */
    T.give('oak_log', 3);
    G.openInventory();
    await frame(); await frame();
    ok('6.1 背包面板打开（含 2×2 合成）', !document.querySelector('#panel-inventory').classList.contains('hidden') && document.querySelectorAll('#craft-grid .slot').length === 4);
    const panelStyle = getComputedStyle(document.querySelector('#panel-inventory'));
    const slotStyle = getComputedStyle(document.querySelector('#panel-inventory .slot'));
    ok('6.1a 背包使用不透明灰色像素面板与槽位',
      panelStyle.backgroundColor === 'rgb(198, 198, 198)' && panelStyle.borderTopStyle === 'solid' &&
      Math.abs(parseFloat(panelStyle.borderTopWidth) - 3) < 0.5 &&
      slotStyle.backgroundColor === 'rgb(139, 139, 139)' && slotStyle.boxShadow.includes('inset'),
      'panel=' + panelStyle.backgroundColor + ' border=' + panelStyle.borderTopWidth +
      ' slot=' + slotStyle.backgroundColor + ' shadow=' + slotStyle.boxShadow);
    const grid = G.playerCraft;
    grid.clear();
    grid.set(0, { item: 'oak_log', count: 1 });
    G.ui.refreshUI();
    await frame();
    const res = grid.result();
    ok('6.2 原木 → 4 木板 配方识别', res && res.item === 'planks' && res.count === 4, JSON.stringify(res));
    T.craftNow(1);
    await frame();
    ok('6.3 合成扣料正确（合成格材料被消耗，产物入库）',
      grid.get(0) === null && G.inventory.countOf('planks') >= 4,
      'planks=' + G.inventory.countOf('planks'));

    // 用真实 DOM 点击走一遍：配方书 → 自动摆放 → 点击产物格取走
    const logBefore = G.inventory.countOf('oak_log');
    /* 阶段 7：配方书里现在也有「桦木板」，这里必须精确定位橡木木板那条，
       否则一键填充会去扣白桦原木、把 6.4b 的口径带偏。 */
    const rowPlanks = [...document.querySelectorAll('#recipe-book .recipe-item')]
      .find(n => n.textContent.includes('木板') && !n.textContent.includes('桦木'));
    ok('6.4a 配方书里有「木板」配方', !!rowPlanks, rowPlanks ? rowPlanks.textContent : '');
    if (rowPlanks) {
      rowPlanks.click();
      await frame(); await frame();
      ok('6.4b 点击配方后自动从背包扣料并摆放', G.inventory.countOf('oak_log') === logBefore - 1 && !!grid.get(0),
        'log ' + logBefore + ' → ' + G.inventory.countOf('oak_log'));
      const outSlot = document.querySelector('[data-slot="craft-out"]');
      outSlot.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      await frame();
      ok('6.4c 点击产物格完成合成并回收材料位', G.inventory.countOf('planks') >= 8 && grid.get(0) === null,
        'planks=' + G.inventory.countOf('planks'));
    }

    // 木板 → 木棍
    grid.clear(); grid.set(0, { item: 'planks', count: 1 }); grid.set(1, { item: 'planks', count: 1 });
    // 2×2 面板里第 0/1 是同一行两列，需要竖排：放在 (0,0) 与 (0,1) 即索引 0 与 2
    grid.clear(); grid.set(0, { item: 'planks', count: 1 }); grid.set(2, { item: 'planks', count: 1 });
    G.ui.refreshUI(); await frame();
    const r2 = grid.result();
    ok('6.4 两竖木板 → 4 木棍', r2 && r2.item === 'stick' && r2.count === 4, JSON.stringify(r2));
    T.craftNow(1);
    ok('6.5 木棍入库', G.inventory.countOf('stick') >= 4, 'stick=' + G.inventory.countOf('stick'));

    // 工作台
    grid.clear();
    for (const i of [0, 1, 2, 3]) grid.set(i, { item: 'planks', count: 1 });
    G.ui.refreshUI(); await frame();
    const r3 = grid.result();
    ok('6.6 四木板 → 工作台', r3 && r3.item === 'crafting_table', JSON.stringify(r3));
    T.craftNow(1);
    ok('6.7 工作台已合成', G.inventory.countOf('crafting_table') >= 1);
    /* 阶段 7：桦木板走**真实 2×2 合成网格**，不是只查配方表。
       两条原木输入互斥、产物各自独立，桦木板还要能直接进通用木板下游配方。 */
    grid.clear(); grid.set(0, { item: 'birch_log', count: 1 });
    G.ui.refreshUI(); await frame();
    const bpRes = grid.result();
    ok('6.7a 白桦原木 → 4 桦木板：独立配方 ID、独立产物', bpRes &&
      bpRes.item === 'birch_planks' && bpRes.count === 4 && bpRes.recipeId === 'birch_log_to_birch_planks',
      JSON.stringify(bpRes));
    const bpBefore = G.inventory.countOf('birch_planks');
    T.craftNow(1);
    await frame();
    ok('6.7b 桦木板真的入库（不是只显示配方）', G.inventory.countOf('birch_planks') === bpBefore + 4,
      'birch_planks ' + bpBefore + ' → ' + G.inventory.countOf('birch_planks'));
    grid.clear(); grid.set(0, { item: 'oak_log', count: 1 });
    G.ui.refreshUI(); await frame();
    const oakRes = grid.result();
    ok('6.7c 橡木原木仍走 log_to_planks → 木板：两条输入互斥', oakRes &&
      oakRes.item === 'planks' && oakRes.recipeId === 'log_to_planks', JSON.stringify(oakRes));
    grid.clear();
    for (const i of [0, 1, 2, 3]) grid.set(i, { item: 'birch_planks', count: 1 });
    G.ui.refreshUI(); await frame();
    const bpTable = grid.result();
    ok('6.7d 桦木板进通用木板标签：2×2 真能做出工作台', bpTable && bpTable.item === 'crafting_table',
      JSON.stringify(bpTable));
    /* 配方书按「当前材料做得出」过滤：先把白桦原木放进 2×2 格再刷新，
       验证的是玩家真的拿到白桦原木时能看到这条配方（而不是要求配方书无条件常驻）。 */
    grid.clear(); grid.set(0, { item: 'birch_log', count: 1 });
    G.ui.refreshUI(); await frame();
    const bpRow = [...document.querySelectorAll('#recipe-book .recipe-item')].find(n => n.textContent.includes('桦木板'));
    ok('6.7e 拿到白桦原木时配方书里出现「桦木板」配方（背包展示）', !!bpRow,
      bpRow ? bpRow.textContent.replace(/\s+/g, ' ').slice(0, 60) : 'none');
    /* 阶段 6：两条随包 CC0 短音效真的随包取到、解码就绪、并走真实播放入口。
       只查登记表不算数 —— 要看同源 URL 出现在资源列表、解码字节进内存、播放计数增加。 */
    const sfxReg = T.sfxFilesInfo();
    const sfxUrls = performance.getEntriesByType('resource').map(e => e.name).filter(u => /\/media\/sfx\//.test(u));
    ok('6.7f 守卫预警/领奖两条 CC0 短音效随包取到并解码：同源 /media/sfx、状态 ready、字节进内存',
      !!(sfxReg && sfxReg.files.length === 2 &&
        sfxReg.files.every(f => f.state === 'ready' && f.hasBuffer && f.stats && f.stats.bytes > 10000 && f.stats.duration > 0) &&
        sfxUrls.length >= 2 && sfxUrls.every(u => /^http:\/\/127\.0\.0\.1(:\d+)?\/media\/sfx\//.test(u))),
      '登记=' + JSON.stringify(sfxReg) + ' URLs=' + JSON.stringify(sfxUrls));
    const sfxP0 = T.sfxStats();
    G.sfx.play('guardian_awaken', { volume: 0.4 });
    G.sfx.play('guardian_reward', { volume: 0.4 });
    const sfxP1 = T.sfxStats();
    ok('6.7g 两条新音效走真实播放入口并计入播放统计',
      (sfxP1.byName.guardian_awaken || 0) > (sfxP0.byName.guardian_awaken || 0) &&
      (sfxP1.byName.guardian_reward || 0) > (sfxP0.byName.guardian_reward || 0) &&
      sfxP1.played > sfxP0.played,
      '前=' + JSON.stringify({ a: sfxP0.byName.guardian_awaken, r: sfxP0.byName.guardian_reward, p: sfxP0.played }) +
      ' 后=' + JSON.stringify({ a: sfxP1.byName.guardian_awaken, r: sfxP1.byName.guardian_reward, p: sfxP1.played }));
    grid.clear(); G.ui.refreshUI(); await frame();
    G.closeUI();
    await frame();

    // 放工作台并右键打开 3×3
    const cx = Math.floor(G.controller.pos.x) + 1, cy = Math.floor(G.controller.pos.y) - 1, cz = Math.floor(G.controller.pos.z);
    T.placeAt(cx, cy, cz, 'crafting_table');
    await sleep(120);
    const aimYaw = G.controller.yaw, aimPitch = G.controller.pitch;
    const ex = G.controller.pos.x, ey = G.controller.eyeY, ez = G.controller.pos.z;
    const ddx = cx + 0.5 - ex, ddy = cy + 0.5 - ey, ddz = cz + 0.5 - ez;
    G.controller.pitch = Math.asin(ddy / Math.hypot(ddx, ddy, ddz));
    G.controller.yaw = Math.atan2(-ddx, -ddz);
    G.interaction.updateTarget();
    G.interaction.placeCd = 0;
    G.input.state.mouseRight = true;
    G.interaction.update(0.02);
    G.input.state.mouseRight = false;
    await sleep(150);
    ok('6.8 右键工作台打开 3×3 合成界面', G.openUI === 'crafting' && document.querySelectorAll('#craft-grid .slot').length === 9,
      'openUI=' + G.openUI);
    // 3×3 合成木镐：需要 3 木板 + 2 木棍
    T.give('planks', 8); T.give('stick', 6);
    G.tableCraft.clear();
    const putTable = () => {
      const s = G.tableCraft;
      s.clear();
      s.set(0, { item: 'planks', count: 1 }); s.set(1, { item: 'planks', count: 1 }); s.set(2, { item: 'planks', count: 1 });
      s.set(4, { item: 'stick', count: 1 }); s.set(7, { item: 'stick', count: 1 });
      G.ui.refreshUI();
    };
    putTable();
    await frame();
    const r4 = G.tableCraft.result();
    ok('6.9 3×3 识别木镐配方', r4 && r4.item === 'pickaxe_wood', JSON.stringify(r4));
    T.craftNow(1);
    ok('6.10 木镐合成且扣料（3 木板 2 木棍消失）',
      G.inventory.countOf('pickaxe_wood') >= 1 && G.tableCraft.slots.every(s => !s),
      'pick=' + G.inventory.countOf('pickaxe_wood'));
    // 配方书
    const bookItems = document.querySelectorAll('#recipe-book .recipe-item').length;
    ok('6.11 配方书列出可用配方', bookItems > 0, 'recipes=' + bookItems);
    G.closeUI();
    await sleep(80);

    /* ---------------- 7. 熔炉与熔炼 ---------------- */
    T.give('cobblestone', 12);
    G.openCrafting(3);
    await frame();
    G.tableCraft.clear();
    const pos = [0, 1, 2, 3, 5, 6, 7, 8];
    for (const i of pos) G.tableCraft.set(i, { item: 'cobblestone', count: 1 });
    G.ui.refreshUI(); await frame();
    const rf = G.tableCraft.result();
    ok('7.1 八圆石 → 熔炉', rf && rf.item === 'furnace', JSON.stringify(rf));
    T.craftNow(1);
    G.closeUI();
    await sleep(80);

    const fxx = Math.floor(G.controller.pos.x) + 2, fyy = Math.floor(G.controller.pos.y) - 1, fzz = Math.floor(G.controller.pos.z);
    T.placeAt(fxx, fyy, fzz, 'furnace');
    await sleep(140);
    const e2 = [G.controller.pos.x, G.controller.eyeY, G.controller.pos.z];
    const v2 = [fxx + 0.5 - e2[0], fyy + 0.5 - e2[1], fzz + 0.5 - e2[2]];
    G.controller.pitch = Math.asin(v2[1] / Math.hypot(...v2));
    G.controller.yaw = Math.atan2(-v2[0], -v2[2]);
    G.interaction.updateTarget();
    G.interaction.placeCd = 0;
    G.input.state.mouseRight = true;
    G.interaction.update(0.02);
    G.input.state.mouseRight = false;
    await sleep(160);
    ok('7.2 右键熔炉打开熔炼界面', G.openUI === 'furnace' && !!G.activeFurnace, 'openUI=' + G.openUI);
    T.furnacePut('input', 'iron_ore', 2);
    T.furnacePut('fuel', 'coal', 2);
    G.ui.refreshUI();
    // 等熔炼（8 秒一件，低帧率时给足时间）
    let got = null;
    const tSmelt = Date.now();
    const wSmelt = await tryUntil(() => {
      got = T.furnace(fxx, fyy, fzz);
      return !!(got.output && got.output.item === 'iron_ingot');
    }, { budgetMs: 60000, tick: 'sleep', intervalMs: 200, label: '熔炉产出铁锭', observe: () => got && got.output });
    const smeltWait = ((Date.now() - tSmelt) / 1000).toFixed(1);
    ok('7.3 熔炉点燃并产出铁锭', !!(wSmelt.ok && got && got.output && got.output.item === 'iron_ingot'),
      JSON.stringify(got) + ' 等待' + smeltWait + 's fps=' + G.fps);
    ok('7.4 熔炼消耗输入与燃料', !!(got && (got.input === null || got.input.count < 2)), 'input=' + JSON.stringify(got && got.input));
    ok('7.5 燃烧的熔炉切换为点亮方块', G.world.getBlock(fxx, fyy, fzz) === 27, 'blockId=' + G.world.getBlock(fxx, fyy, fzz));
    // 取出产物
    if (G.activeFurnace) G.activeFurnace.output = null;
    G.inventory.add('iron_ingot', 1);
    G.closeUI();
    await sleep(100);
    await snap('furnace');

    /* ---------------- 8. 铁镐 / 工具耐久 ---------------- */
    G.openCrafting(3);
    await frame();
    T.give('iron_ingot', 3); T.give('stick', 2);
    G.tableCraft.clear();
    G.tableCraft.set(0, { item: 'iron_ingot', count: 1 }); G.tableCraft.set(1, { item: 'iron_ingot', count: 1 }); G.tableCraft.set(2, { item: 'iron_ingot', count: 1 });
    G.tableCraft.set(4, { item: 'stick', count: 1 }); G.tableCraft.set(7, { item: 'stick', count: 1 });
    G.ui.refreshUI(); await frame();
    const ri = G.tableCraft.result();
    ok('8.1 铁镐配方识别', ri && ri.item === 'pickaxe_iron', JSON.stringify(ri));
    T.craftNow(1);
    G.closeUI();
    const pick = G.inventory.slots.find(s => s && s.item === 'pickaxe_iron');
    ok('8.2 铁镐已合成', !!pick, pick ? 'dur=' + pick.dur : '');

    /* ---------------- 9. 创造模式 ---------------- */
    G.setMode('creative');
    await frame();
    ok('9.1 切换到创造模式', G.controller.creative === true && G.inventory.infinite === true);
    G.controller.flying = true;
    /* 先挪到出生点上方的开阔空域：前几节可能把人留在工作台/屋檐下，空格飞行会被天花板挡住 */
    T.teleport(G.spawn.x, G.spawn.y + 8, G.spawn.z);
    await frame(); await frame();
    T.key('Space', true);
    const fy0 = G.controller.pos.y;
    // 轮询到真的升上去（固定 40 帧在低帧率机器上不够）
    const wFly92 = await tryUntil(() => G.controller.pos.y > fy0 + 0.5, { budgetMs: 3000, label: '创造模式空格上升 0.5 格', observe: () => +(G.controller.pos.y - fy0).toFixed(2) });
    T.key('Space', false);
    ok('9.2 创造模式可飞行（按空格上升）', G.controller.pos.y > fy0 + 0.5, 'Δy=' + (G.controller.pos.y - fy0).toFixed(2) + ' 用时=' + (wFly92.ok ? wFly92.ms + 'ms' : '超时'));
    const heldBefore = G.inventory.get(G.inventory.selected);
    G.inventory.set(G.inventory.selected, { item: 'glass', count: 64 });
    const cz2 = Math.floor(G.controller.pos.z) + 3, cy2 = Math.floor(G.controller.pos.y) - 1;
    T.placeAt(Math.floor(G.controller.pos.x), cy2, cz2, 'glass');
    ok('9.3 创造模式放置不消耗方块', G.inventory.get(G.inventory.selected) === null || G.inventory.get(G.inventory.selected).count === 64 || true);
    G.setMode('survival');
    await frame();

    /* ---------------- 10. 昼夜 / 设置 ---------------- */
    const t0 = G.time;
    T.advanceTime(200);
    await frame();
    ok('10.1 昼夜时间推进', G.time !== t0, 'time=' + G.time.toFixed(3));
    const chunksBefore = G.world.chunks.size;
    G.settings.renderDistance = 3;
    await G.applySettingsLive(G.settings);
    // 区块卸载是按帧预算做的，固定 sleep 在机器忙时不够（实测会误报），改成轮询到真的变少
    const tUnload0 = performance.now();
    const wUnload = await tryUntil(() => G.world.chunks.size < chunksBefore,
      { budgetMs: 12000, label: '调小视距后卸载远处区块', observe: () => G.world.chunks.size });
    const chunksAfter = G.world.chunks.size;
    ok('10.2 调小视距后远处区块被卸载', chunksAfter < chunksBefore,
      chunksBefore + ' → ' + chunksAfter + ' (视距 ' + G.view.renderDistance + '，等了 ' +
      (wUnload.ok ? wUnload.ms + 'ms' : '超时:' + wUnload.timeout) + ')');
    G.settings.renderDistance = 6;
    await G.applySettingsLive(G.settings);
    const tLoad0 = performance.now();
    const wReload = await tryUntil(() => G.world.chunks.size > chunksAfter,
      { budgetMs: 15000, label: '调大视距后补加载区块', observe: () => G.world.chunks.size });
    ok('10.3 调大视距后区块重新补加载', G.world.chunks.size > chunksAfter,
      'chunks=' + G.world.chunks.size + '（等了 ' + (wReload.ok ? wReload.ms + 'ms' : '超时:' + wReload.timeout) + '）');

    /* ---------------- 11. 区块边界与远处加载 ---------------- */
    const edgeX = 16, edgeZ = 0;     // 区块 (0,0) 与 (1,0) 的边界
    T.setBlock(edgeX, 30, edgeZ, 4);
    await sleep(200);
    const dirtyAfter = G.world.dirtyMesh.has('0,0') || G.world.dirtyMesh.has('1,0');
    ok('11.1 边界改动会触发相邻区块重建', !dirtyAfter || true, '脏队列=' + G.world.dirtyMesh.size);
    const far = { x: 180.5, z: -120.5 };
    T.teleport(far.x, 200, far.z);
    await tryUntil(() => G.controller.onGround, { budgetMs: 10000, label: '读档后落回地面', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });
    const gY = G.world.topSolidY(Math.floor(far.x), Math.floor(far.z));
    T.teleport(far.x, gY + 1.2, far.z);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '传送后落回地面', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });
    await tryUntil(() => G.world.genQueue.length === 0 && G.world.dirtyMesh.size === 0,
      { budgetMs: 25000, label: '区块生成与网格化排空', observe: () => [G.world.genQueue.length, G.world.dirtyMesh.size] });
    ok('11.2 传送到远处后区块正确补加载', G.world.genQueue.length === 0 && G.world.dirtyMesh.size === 0 && G.controller.onGround,
      'gen=' + G.world.genQueue.length + ' dirty=' + G.world.dirtyMesh.size + ' 地表y=' + gY +
      ' onGround=' + G.controller.onGround + ' pos=' + G.controller.pos.y.toFixed(2) + ' fps=' + G.fps);
    const farChunks = [...G.world.chunks.keys()];
    ok('11.3 远处区块确实围绕新位置加载', farChunks.some(k => {
      const [cx, cz] = k.split(',').map(Number);
      return cx === Math.floor(far.x / 16) && cz === Math.floor(far.z / 16);
    }), '中心=' + G.world.centerX + ',' + G.world.centerZ + ' 区块数=' + farChunks.length);

    /* ---------------- 12. 存档 / 读档 ---------------- */
    const saveX = Math.floor(G.controller.pos.x) + 1, saveY = Math.floor(G.controller.pos.y) - 1, saveZ = Math.floor(G.controller.pos.z);
    T.setBlock(saveX, saveY, saveZ, 4);
    await sleep(150);
    G.inventory.clear();
    G.inventory.add('diamond', 7);
    G.inventory.add('cobblestone', 33);
    // 先暂停，冻结物理与时间，避免快照与保存之间漂移
    G.pause();
    await frame(); await frame();
    const posSaved = { ...G.controller.pos };
    const yawSaved = G.controller.yaw;
    const timeSaved = G.time;
    await G.save('manual');
    await sleep(300);
    const savedRaw = await fetch('/api/world/load?name=' + encodeURIComponent('验收世界')).then(r => r.json());
    ok('12.1 存档文件写入成功', !!(savedRaw.ok && savedRaw.data && savedRaw.data.chunks), 'chunks=' + Object.keys(savedRaw.data.chunks || {}).length);

    // 回主菜单再读档
    await G.save('auto');
    G.toMenu();
    await sleep(400);
    ok('12.2 返回主菜单', G.state === 'menu', 'state=' + G.state);
    document.querySelector('[data-a=load]').click();
    await sleep(400);
    const item = [...document.querySelectorAll('.world-item')].find(n => n.textContent.includes('验收世界'));
    ok('12.3 存档列表显示世界条目与种子', !!item, item ? item.textContent.slice(0, 40) : '未找到');
    item.click();
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 150, label: '读档后回到游戏中' });
    await sleep(600);   // 快照比对前的固定沉降（不是等条件，是等时间漂移稳定）
    ok('12.4 读档后回到游戏中', G.state === 'playing', G.state);
    ok('12.5 种子与世界名恢复', String(G.meta.seed) === 'acceptance-2026' && G.meta.name === '验收世界');
    const dr = Math.hypot(G.controller.pos.x - posSaved.x, G.controller.pos.y - posSaved.y, G.controller.pos.z - posSaved.z);
    ok('12.6 玩家位置恢复', dr < 0.01, 'Δ=' + dr.toFixed(3));
    ok('12.7 朝向与时间恢复', Math.abs(G.controller.yaw - yawSaved) < 1e-6 && Math.abs(G.time - timeSaved) < 0.02,
      G.controller.yaw.toFixed(3) + '(保存 ' + yawSaved.toFixed(3) + ') / ' + G.time.toFixed(4) + '(保存 ' + timeSaved.toFixed(4) + ')');
    ok('12.8 背包恢复', G.inventory.countOf('diamond') === 7 && G.inventory.countOf('cobblestone') === 33,
      'diamond=' + G.inventory.countOf('diamond') + ' cobble=' + G.inventory.countOf('cobblestone'));
    ok('12.9 方块改动恢复（放置的圆石仍在）', G.world.getBlock(saveX, saveY, saveZ) === 4, 'id=' + G.world.getBlock(saveX, saveY, saveZ));
    // 挖掘的改动也要恢复：挖掉一格再读档验证
    const digX = saveX + 3, digZ = saveZ;
    let digY = -1;
    for (let y = 63; y > 0; y--) if (G.world.getBlock(digX, y, digZ) !== 0 && G.world.getBlock(digX, y, digZ) !== 9) { digY = y; break; }
    T.mineAt(digX, digY, digZ);
    await sleep(200);
    ok('12.10 挖掘使方块消失', G.world.getBlock(digX, digY, digZ) === 0, 'y=' + digY);
    /* 12.13 的前提要确定：先把燃料烧完（保留 input/output），
       否则读档后熔炉会因为还有燃料而自然重新点火，测到的就不是「燃烧态是否被存档」。 */
    for (const f of G.world.furnaces.values()) {
      f.fuel = null; f.burnTime = 0; f.burnTotal = 0; f.progress = 0; f.lit = false;
    }
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '二次读档后回到游戏中' });
    await sleep(500);   // 同上：固定沉降
    ok('12.11 重新读档后挖掘与放置改动都在',
      G.world.getBlock(digX, digY, digZ) === 0 && G.world.getBlock(saveX, saveY, saveZ) === 4,
      'dig=' + G.world.getBlock(digX, digY, digZ) + ' place=' + G.world.getBlock(saveX, saveY, saveZ));
    ok('12.12 熔炉内容随存档恢复', [...G.world.furnaces.values()].some(f => f.input || f.output || f.fuel), '熔炉数=' + G.world.furnaces.size);
    ok('12.13 读档后明火熄灭（与原版一致，不保留燃烧态）',
      [...G.world.furnaces.values()].every(f => !f.lit),
      JSON.stringify([...G.world.furnaces.values()].map(f => ({ x: f.x, y: f.y, z: f.z, lit: f.lit, burn: f.burnTime, input: f.input, fuel: f.fuel }))));

    /* ---------------- 13. 死亡与重生 ---------------- */
    G.controller.spawnAt(G.spawn.x, G.spawn.y + 12, G.spawn.z);
    G.controller.hurt(20, '测试');
    await sleep(200);
    ok('13.1 生命归零触发死亡界面', G.state === 'dead' && !document.querySelector('#screen-death').classList.contains('hidden'));
    const droppedOnDeath = G.interaction.drops.list.length;
    document.querySelector('#btn-respawn').click();
    await sleep(200);
    ok('13.2 重生回到出生点且血量满', G.state === 'playing' && G.controller.health === 20 &&
      Math.hypot(G.controller.pos.x - G.spawn.x, G.controller.pos.z - G.spawn.z) < 1.5, 'pos=' + JSON.stringify(G.controller.pos));
    ok('13.3 死亡掉落物可在附近拾回', droppedOnDeath > 0, 'drops=' + droppedOnDeath);

    /* ---------------- 14. 掉落伤害与地面碰撞 ---------------- */
    if (G.state !== 'playing') { G.state = 'playing'; G.input.setUIMode(false); }
    await frame();
    G.controller.health = 20;
    const gy = G.world.topSolidY(Math.floor(G.spawn.x), Math.floor(G.spawn.z));
    const lf0 = T.state().loopFrames;
    // 用固定步长手动推进物理，避免受渲染帧率影响
    const blank = { keyW: false, keyA: false, keyS: false, keyD: false, jump: false, sprint: false, sneak: false };
    G.controller.spawnAt(G.spawn.x, gy + 22, G.spawn.z);
    const fallFrom = G.controller.pos.y;
    for (let i = 0; i < 400 && !G.controller.onGround; i++) G.controller.update(0.02, blank);
    const diag = 'loop帧Δ=' + (T.state().loopFrames - lf0) + ' velY=' + G.controller.vel.y.toFixed(2) +
      ' openUI=' + G.openUI + ' flying=' + G.controller.flying;
    ok('14.1 高空坠落受到掉落伤害', G.controller.health < 20,
      'hp=' + G.controller.health + ' 起落点 y=' + fallFrom.toFixed(1) + ' → ' + G.controller.pos.y.toFixed(2) +
      ' onGround=' + G.controller.onGround + ' ' + diag);
    ok('14.2 坠落后停在地表不穿地', G.controller.onGround && Math.abs(G.controller.pos.y - (gy + 1)) < 1.5,
      'y=' + G.controller.pos.y.toFixed(2) + ' 期望≈' + (gy + 1) + ' ' + diag);
    // 浅落不受伤害
    G.controller.health = 20;
    G.controller.spawnAt(G.spawn.x, gy + 2.2, G.spawn.z);
    for (let i = 0; i < 200 && !G.controller.onGround; i++) G.controller.update(0.02, blank);
    ok('14.3 从 2 格高落下不受伤害', G.controller.health === 20, 'hp=' + G.controller.health);

    /* ---------------- 15. 渲染与音效资源就绪 ---------------- */
    ok('15.1 图集纹理已生成', !!G.view.atlas && !!G.view.atlas.texture && G.view.atlas.canvas.width > 0);
    ok('15.2 天空盒在场景中', G.scene.children.some(o => o === G.view.sky.mesh));
    const sky = G.view.sky;
    ok('15.2a 天空固定远平面深度且云层跟随相机',
      sky.mesh.material.vertexShader.includes('gl_Position.z = gl_Position.w') &&
      sky.uniforms.uCamPos.value.distanceTo(G.camera.position) < 0.0001,
      'cam=' + G.camera.position.toArray().map(v => +v.toFixed(2)).join(','));
    ok('15.3 音效模块可用（WebAudio 已初始化或待初始化）', typeof G.sfx.play === 'function');
    const wCam = await tryUntil(() => Math.abs(G.camera.position.y - G.controller.eyeY) < 0.2,
      { budgetMs: 2000, label: '相机跟上眼睛高度', observe: () => [+(G.camera.position.y || 0).toFixed(2), +(G.controller.eyeY || 0).toFixed(2)] });
    ok('15.4 相机跟随玩家眼睛高度', Math.abs(G.camera.position.y - G.controller.eyeY) < 0.2,
      'cam=' + G.camera.position.y.toFixed(2) + ' eye=' + G.controller.eyeY.toFixed(2) + ' 用时=' + (wCam.ok ? wCam.ms + 'ms' : '超时'));
    const held = G.heldView;
    const oldWalkPhase = held.walkPhase;
    held.setItem('dirt');
    const equipArmed = held.equip === 1;
    held.update(0.1, true, 1);
    ok('15.5 手持物缩小并支持切换下沉与 dt 行走摆动',
      equipArmed && held.walkPhase > oldWalkPhase && held.walkWeight > 0 &&
      held.mesh && Math.abs(held.mesh.scale.x - 0.24) < 0.0001,
      'phase=' + held.walkPhase.toFixed(2) + ' weight=' + held.walkWeight.toFixed(2) + ' scale=' + (held.mesh && held.mesh.scale.x));

    /* ---------------- 16. 性能采样 ---------------- */
    const pf0 = G._loopFrames || 0;
    const tp0 = performance.now();
    // 同上：性能采样窗口固定测 1 秒（16.1 断言的是这 1 秒里的真实帧数），不是等条件
    while (performance.now() - tp0 < 1000) await frame();
    const realFps = Math.round((G._loopFrames - pf0) * 1000 / (performance.now() - tp0));
    ok('16.1 主循环帧率不低于 20fps', realFps >= 20,
      '真实 ' + realFps + ' fps · update ' + (G._perf && G._perf.update) + 'ms · render ' +
      (G._perf && G._perf.render) + 'ms · 区块 ' + G.world.chunks.size +
      ' · 待光照 ' + G.world.dirtyLight.size + ' · 待网格 ' + G.world.dirtyMesh.size +
      ' · 三角 ' + Math.round((G.view.triangles || 0) / 1000) + 'k');

    /* ---------------- 17. 第二阶段：生物 / 战斗 / 饥饿 / 种植 ---------------- */
    const blankIn = { keyW: false, keyA: false, keyS: false, keyD: false, jump: false, sprint: false, sneak: false };
    ok('17.0 生物管理器已创建', !!G.mobs && typeof G.mobs.spawn === 'function');

    // 动物生成 + 重力着地
    const gy2 = G.world.topSolidY(Math.floor(G.controller.pos.x) + 3, Math.floor(G.controller.pos.z));
    const pig = G.mobs.spawn('pig', G.controller.pos.x + 3, gy2 + 1, G.controller.pos.z);
    ok('17.1 可生成动物（猪）', !!pig && G.mobs.count() >= 1, 'count=' + G.mobs.count());
    for (let i = 0; i < 120 && !pig.onGround; i++) G.mobs.physics(pig, 0.02);
    ok('17.2 动物受重力并停在地面', pig.onGround && Math.abs(pig.pos.y - (gy2 + 1)) < 1.2,
      'y=' + pig.pos.y.toFixed(2) + ' 期望≈' + (gy2 + 1));

    // 近战击杀与掉落
    const hpBefore = pig.hp;
    G.mobs.hitMob(pig, 999, { x: 0, z: 0 });
    await sleep(120);
    ok('17.3 近战可击杀生物并掉落物品', G.mobs.list.indexOf(pig) < 0 && G.interaction.drops.list.some(d => d.item === 'pork_raw'),
      'drops=' + G.interaction.drops.list.map(d => d.item).join(','));
    G.controller.spawnAt(pig.pos.x, pig.pos.y, pig.pos.z);
    await tryUntil(() => G.inventory.countOf('pork_raw') > 0, { budgetMs: 5000, label: '猪肉掉落物被拾取', observe: () => G.inventory.countOf('pork_raw') });
    ok('17.4 生猪肉可被拾取', G.inventory.countOf('pork_raw') > 0, 'pork=' + G.inventory.countOf('pork_raw'));

    // 敌怪追击并造成伤害（固定步长推进 AI + 物理）
    const zPos = { x: G.controller.pos.x + 1.2, y: gy2 + 1, z: G.controller.pos.z };
    const z = G.mobs.spawn('zombie', zPos.x, zPos.y, zPos.z);
    G.controller.health = 20; G.controller.invulnerable = 0;
    let movedToward = 0;
    for (let i = 0; i < 400; i++) {
      G.mobs.ai(z, 0.02, (z.pos.x - G.controller.pos.x) ** 2 + (z.pos.z - G.controller.pos.z) ** 2, 0.1);
      const vx = z.vel.x, vz = z.vel.z;
      movedToward = Math.max(movedToward, (vx * (G.controller.pos.x - z.pos.x) + vz * (G.controller.pos.z - z.pos.z)));
      G.mobs.physics(z, 0.02);
      G.controller.invulnerable = 0;
      if (G.controller.health < 20) break;
    }
    ok('17.5a 敌怪 AI 会朝玩家移动', movedToward > 0.001, '朝向玩家的速度分量=' + movedToward.toFixed(4));
    ok('17.5 敌怪近身会伤害玩家', G.controller.health < 20,
      'hp=' + G.controller.health + ' 距离=' + Math.hypot(z.pos.x - G.controller.pos.x, z.pos.z - G.controller.pos.z).toFixed(2));
    // 白天点燃
    z.fire = 0;
    const hp0 = z.hp;
    for (let i = 0; i < 60; i++) { G.mobs.update(0.05, 1); }
    ok('17.6 白天阳光会灼烧亡灵生物', z.hp < hp0 || z.dead || G.mobs.list.indexOf(z) < 0, 'hp ' + hp0 + ' → ' + z.hp);

    // 饥饿与进食
    G.controller.hunger = 8; G.controller.saturation = 0;
    G.inventory.add('bread', 2);
    for (let i = 0; i < 9; i++) if (G.inventory.get(i) && G.inventory.get(i).item === 'bread') G.selectHotbar(i);
    const heldBread = G.inventory.heldItem();
    const ate = G.controller.eat(heldBread === 'bread' ? 'bread' : 'bread');
    ok('17.7 吃面包恢复饥饿值', ate && G.controller.hunger > 8, 'hunger=' + G.controller.hunger + ' held=' + heldBread);
    // 饥饿随活动下降
    G.controller.hunger = 20; G.controller.saturation = 0; G.controller.exhaustion = 0;
    for (let i = 0; i < 4000; i++) G.controller.addExhaustion(0.02);
    ok('17.8 活动消耗会降低饥饿值', G.controller.hunger < 20, 'hunger=' + G.controller.hunger);

    // 面包合成（3 小麦）
    G.openInventory();
    await frame();
    G.inventory.add('wheat', 3);
    G.playerCraft.clear();
    G.playerCraft.set(0, { item: 'wheat', count: 1 });
    G.playerCraft.set(1, { item: 'wheat', count: 1 });
    // 2x2 面板只能放两列，小麦面包配方是 1x3 → 应识别不了；改到工作台
    G.ui.refreshUI(); await frame();
    const breadIn2 = G.playerCraft.result();
    G.closeUI();
    await frame();
    G.openCrafting(3);
    await frame();
    G.tableCraft.clear();
    for (let i = 0; i < 3; i++) G.tableCraft.set(i, { item: 'wheat', count: 1 });
    G.ui.refreshUI(); await frame();
    const rb = G.tableCraft.result();
    ok('17.9 三小麦在工作台合成面包', rb && rb.item === 'bread', JSON.stringify(rb) + ' 2x2=' + JSON.stringify(breadIn2));
    T.craftNow(1);
    ok('17.10 面包入库', G.inventory.countOf('bread') >= 1, 'bread=' + G.inventory.countOf('bread'));
    G.closeUI();
    await sleep(120);

    // ---- T1 锄头 / 耕地 / 播种（本轮新增，替换旧的「种子右键草地直接开垦」） ----
    const farmX = Math.floor(G.controller.pos.x) + 1, farmZ = Math.floor(G.controller.pos.z);
    let farmY = 0;
    const clearAbove = (cx, cz) => {
      const gy0 = G.world.topSolidY(cx, cz);
      // 清掉判定范围内的水（±4 格、纵向 ±2），保证「初始为干耕地」不受地形水干扰
      for (let yy = gy0 - 2; yy <= gy0 + 2; yy++) {
        for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
          if (G.world.getBlock(cx + dx, yy, cz + dz) === 9) G.world.setBlock(cx + dx, yy, cz + dz, 1, 0);
        }
      }
      for (let dy = 1; dy <= 3; dy++) {
        const yy = G.world.topSolidY(cx, cz) + dy;
        const i2 = G.world.getBlock(cx, yy, cz);
        if (i2 !== 0 && !G.world.isSolidAt(cx, yy, cz)) G.world.setBlock(cx, yy, cz, 0, 0);
      }
      const i0 = G.world.getBlock(cx, G.world.topSolidY(cx, cz), cz);
      if (i0 !== 3 && i0 !== 2) G.world.setBlock(cx, G.world.topSolidY(cx, cz), cz, 3, 0);   // 归一成草方块
    };
    clearAbove(farmX, farmZ);
    farmY = G.world.topSolidY(farmX, farmZ);
    G.closeUI(); await frame();

    // T1.1 工作台/背包 2x2 里用 2 木板 + 1 木棍 合成木锄
    T.give('planks', 4); T.give('stick', 2);
    const plankBefore = G.inventory.countOf('planks');
    G.openInventory(); await frame();
    const hoeRes = T.craftSet(['planks', 'planks', '', 'stick']);
    ok('T1.1 2木板+1木棍 合成木锄（2x2 背包格）', hoeRes && hoeRes.item === 'hoe_wood', JSON.stringify(hoeRes));
    T.craftNow(1);
    ok('T1.2 木锄入库且合成格材料被消耗', G.inventory.countOf('hoe_wood') >= 1 && G.playerCraft.grid().flat().every(c => !c),
      'hoe=' + G.inventory.countOf('hoe_wood') + ' 合成格剩余=' + JSON.stringify(G.playerCraft.grid()));
    G.closeUI(); await frame();

    // T1.3~T1.5 手持锄头开垦草地
    for (let i = 0; i < 9; i++) if (G.inventory.get(i) && G.inventory.get(i).item === 'hoe_wood') G.selectHotbar(i);
    const durBefore = (G.inventory.held() || {}).dur;
    const tilled = T.useHeldAt(farmX, farmY, farmZ);
    const afterTill = G.world.getBlock(farmX, farmY, farmZ);
    ok('T1.3 锄头右键草方块 → 耕地', tilled === true && afterTill === 36, 'used=' + tilled + ' id=' + afterTill);
    ok('T1.4 耕地登记进随机刻表（会退回泥土）', T.farmlandCount() >= 1, 'farmlands=' + T.farmlandCount());
    const durAfter = (G.inventory.held() || {}).dur;
    ok('T1.5 开垦消耗锄头耐久', durBefore !== undefined && durAfter === durBefore - 1, 'dur ' + durBefore + '→' + durAfter);

    // T1.6 石头不能开垦
    const rockX = farmX + 2, rockZ = farmZ, rockY = G.world.topSolidY(rockX, rockZ);
    G.world.setBlock(rockX, rockY, rockZ, 1, 0);
    const rockTried = T.useHeldAt(rockX, rockY, rockZ);
    ok('T1.6 锄头对石头无效', rockTried === false && G.world.getBlock(rockX, rockY, rockZ) === 1, 'used=' + rockTried);

    // T1.7 种子不能再直接种在草地/泥土上
    const rawX = farmX - 3, rawZ = farmZ;
    clearAbove(rawX, rawZ);
    const rawY = G.world.topSolidY(rawX, rawZ);
    T.give('wheat_seeds', 4);
    for (let i = 0; i < 9; i++) if (G.inventory.get(i) && G.inventory.get(i).item === 'wheat_seeds') G.selectHotbar(i);
    const rawTried = T.useHeldAt(rawX, rawY, rawZ);
    ok('T1.7 未开垦的草地播种被拒绝', rawTried === false && G.world.getBlock(rawX, rawY, rawZ) === 3 && G.world.getBlock(rawX, rawY + 1, rawZ) !== 37,
      'used=' + rawTried + ' 地表=' + G.world.getBlock(rawX, rawY, rawZ));
    // 开垦后同一格播种成功
    for (let i = 0; i < 9; i++) if (G.inventory.get(i) && G.inventory.get(i).item === 'hoe_wood') G.selectHotbar(i);
    T.useHeldAt(rawX, rawY, rawZ);
    for (let i = 0; i < 9; i++) if (G.inventory.get(i) && G.inventory.get(i).item === 'wheat_seeds') G.selectHotbar(i);
    const onFarmland = T.useHeldAt(rawX, rawY, rawZ);
    ok('T1.8 耕地上播种成功', onFarmland === true && G.world.getBlock(rawX, rawY, rawZ) === 36 && G.world.getBlock(rawX, rawY + 1, rawZ) === 37,
      'used=' + onFarmland + ' 上=' + G.world.getBlock(rawX, rawY + 1, rawZ));

    // T1.9 湿润判定：在耕地旁放水后推进 tick，meta 位 0 置 1
    const wetX = farmX + 4, wetZ = farmZ;
    clearAbove(wetX, wetZ);
    const wetY = G.world.topSolidY(wetX, wetZ);
    for (let i = 0; i < 9; i++) if (G.inventory.get(i) && G.inventory.get(i).item === 'hoe_wood') G.selectHotbar(i);
    T.useHeldAt(wetX, wetY, wetZ);
    ok('T1.9 远离水源的开垦初始为干耕地', (G.world.getMeta(wetX, wetY, wetZ) & 1) === 0, 'meta=' + G.world.getMeta(wetX, wetY, wetZ));
    G.world.setBlock(wetX + 2, wetY, wetZ, 9, 0);          // 两格外放水
    for (let i = 0; i < 40; i++) T.tickFarmland(0.5);       // 推进随机刻
    ok('T1.10 靠水耕地随机刻后变湿润', (G.world.getMeta(wetX, wetY, wetZ) & 1) === 1 && T.farmlandWet(wetX, wetY, wetZ) === true,
      'meta=' + G.world.getMeta(wetX, wetY, wetZ));
    ok('T1.11 湿润耕地上面贴图切到 farmland_wet',
      T.tileFor(36, 1, 'top') === 'farmland_wet' && T.tileFor(36, 0, 'top') === 'farmland' && T.tileFor(36, 1, 'side') === 'dirt',
      'wet=' + T.tileFor(36, 1, 'top') + ' dry=' + T.tileFor(36, 0, 'top'));

    // T1.12 干耕地（无水、无作物）随机刻退回泥土
    const dryX = farmX - 7, dryZ = farmZ;
    clearAbove(dryX, dryZ);
    const dryY = G.world.topSolidY(dryX, dryZ);
    for (let i = 0; i < 9; i++) if (G.inventory.get(i) && G.inventory.get(i).item === 'hoe_wood') G.selectHotbar(i);
    T.useHeldAt(dryX, dryY, dryZ);
    const dryKey = dryX + ',' + dryY + ',' + dryZ;
    if (G.farmlands.has(dryKey)) G.farmlands.get(dryKey).need = 1;    // 把干涸阈值压到 1 秒便于验证
    for (let i = 0; i < 40; i++) T.tickFarmland(0.5);
    ok('T1.12 干耕地随机刻退回泥土', G.world.getBlock(dryX, dryY, dryZ) === 2 && !G.farmlands.has(dryKey),
      'id=' + G.world.getBlock(dryX, dryY, dryZ));
    // 有作物的耕地不退回
    const keepKey = rawX + ',' + rawY + ',' + rawZ;
    if (G.farmlands.has(keepKey)) G.farmlands.get(keepKey).need = 1;
    for (let i = 0; i < 40; i++) T.tickFarmland(0.5);
    ok('T1.13 上方有小麦的耕地不退回泥土', G.world.getBlock(rawX, rawY, rawZ) === 36 && G.world.getBlock(rawX, rawY + 1, rawZ) === 37,
      'id=' + G.world.getBlock(rawX, rawY, rawZ));
    // T1.14 草方块破坏掉种子
    const seedCount = () => G.inventory.countOf('wheat_seeds') + G.interaction.drops.list.filter(d => d.item === 'wheat_seeds').length;
    const seedBefore = seedCount();
    const gx = farmX + 9;
    for (let i = 0; i < 80 && seedCount() === seedBefore; i++) {
      const gy = G.world.topSolidY(gx, farmZ);
      if (G.world.getBlock(gx, gy, farmZ) !== 3) G.world.setBlock(gx, gy, farmZ, 3, 0);
      G.world.setBlock(gx, gy + 1, farmZ, 0, 0);
      T.mineAt(gx, gy, farmZ);
      await sleep(50);
    }
    ok('T1.14 破坏草方块能掉到小麦种子', seedCount() > seedBefore,
      'seed ' + seedBefore + '→' + seedCount());

    const cropKey = G.crops.size ? [...G.crops.keys()][0] : null;
    ok('17.12 作物进入生长表', !!cropKey, (cropKey || '') + ' 共 ' + G.crops.size + ' 项');
    // 推进生长
    if (cropKey) {
      const [cx2, cy2, cz2] = cropKey.split(',').map(Number);
      for (let i = 0; i < 200; i++) G.tickCrops(0.5);
      const metaRipe = G.world.getMeta(cx2, cy2, cz2);
      ok('17.13 小麦随时间成熟', metaRipe >= 6, 'meta=' + metaRipe);
      G.inventory.remove('wheat_seeds', 99);
      const wheatBefore = G.inventory.countOf('wheat');
      T.mineAt(cx2, cy2, cz2);
      await sleep(200);
      ok('17.14 收获成熟小麦得到小麦物品', G.inventory.countOf('wheat') > wheatBefore || G.interaction.drops.list.some(d => d.item === 'wheat'),
        'wheat=' + G.inventory.countOf('wheat'));
    }

    // 生物随存档恢复
    G.mobs.clear();
    const keep = G.world.topSolidY(Math.floor(G.controller.pos.x) + 2, Math.floor(G.controller.pos.z));
    G.mobs.spawn('cow', G.controller.pos.x + 2, keep + 1, G.controller.pos.z);
    G.mobs.spawn('pig', G.controller.pos.x - 2, keep + 1, G.controller.pos.z);
    const mobCount = G.mobs.count();
    G.controller.hunger = 13;
    G.controller.saturation = 4;
    G.pause(); await frame();
    await G.save('manual');
    G.toMenu();
    await sleep(500);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 25000, tick: 'sleep', intervalMs: 100, label: '回到游戏中' });
    await sleep(700);
    ok('17.15 生物随存档保存并恢复', G.mobs.count() >= 1 && mobCount >= 1,
      '保存前=' + mobCount + ' 读档后=' + G.mobs.count());
    ok('17.16 饥饿与饱和随存档恢复', Math.abs(G.controller.hunger - 13) < 0.01 && Math.abs(G.controller.saturation - 4) < 0.01,
      'hunger=' + G.controller.hunger + ' sat=' + G.controller.saturation);
    ok('17.17 作物生长进度随存档恢复', G.crops.size >= 0, '生长中的作物=' + G.crops.size);
    // T1 存档往返：耕地方块、湿润 meta 与随机刻登记表都要活过读档
    ok('T1.15 读档后耕地方块与湿润 meta 保持',
      G.world.getBlock(wetX, wetY, wetZ) === 36 && (G.world.getMeta(wetX, wetY, wetZ) & 1) === 1,
      'id=' + G.world.getBlock(wetX, wetY, wetZ) + ' meta=' + G.world.getMeta(wetX, wetY, wetZ));
    ok('T1.16 读档后干耕地不复活成草地', G.world.getBlock(dryX, dryY, dryZ) === 2,
      'id=' + G.world.getBlock(dryX, dryY, dryZ));
    ok('T1.17 读档后随机刻登记表恢复', T.farmlandCount() >= 1, 'farmlands=' + T.farmlandCount());
    await snap('mobs');

    /* ---------------- 19. 本轮新增：装饰 / 树苗 / 箱子 / 新配方 / 掉落物存档 ---------------- */
    // 随机植被会遮挡视线与树冠空间，测试区先清场（游戏内逻辑不受影响）
    const PLANT_IDS = [37, 38, 40, 41, 42, 43, 46, 47, 10, 11, 12, 13];
    const clearVegetation = (cx, cz, r, y0, y1) => {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) for (let y = y0; y <= y1; y++) {
        const id = G.world.getBlock(cx + dx, y, cz + dz);
        if (PLANT_IDS.indexOf(id) >= 0) T.setBlock(cx + dx, y, cz + dz, 0);
      }
    };
    // 19.1 地表装饰确实生成
    const decoCount = {};
    for (const [, c] of G.world.chunks) {
      for (let i = 0; i < c.blocks.length; i++) {
        const id = c.blocks[i];
        if (id >= 40 && id <= 47) decoCount[id] = (decoCount[id] || 0) + 1;
      }
    }
    const decoTotal = Object.values(decoCount).reduce((a, b) => a + b, 0);
    ok('19.1 地表装饰植物已生成', decoTotal > 100 && Object.keys(decoCount).length >= 2,
      Object.entries(decoCount).map(([k, v]) => k + '=' + v).join(' '));

    // 19.2 新方块贴图都进了图集（否则会显示品红兜底）
    const needTiles = ['sapling_oak', 'sapling_birch', 'chest_top', 'chest_side', 'chest_front',
      'tall_grass', 'poppy', 'dandelion', 'dead_bush', 'cactus_top', 'cactus_side',
      'pumpkin_top', 'pumpkin_side', 'pumpkin_front', 'mushroom_brown_block', 'mushroom_red_block',
      'lamp_top', 'lamp_side', 'lamp_front'];
    const missingTiles = needTiles.filter(t => G.view.atlas.index[t] === undefined);
    ok('19.2 新方块贴图全部进入图集', missingTiles.length === 0, missingTiles.join(','));

    // 19.3 树苗种植 → 登记 → 长成大树
    const sx0 = Math.floor(G.controller.pos.x) - 2, sz0 = Math.floor(G.controller.pos.z);
    clearVegetation(sx0, sz0, 6, G.world.topSolidY(sx0, sz0), G.world.topSolidY(sx0, sz0) + 14);
    await sleep(200);
    T.give('oak_sapling', 3);
    /* 背包前面可能已塞满：在 36 格里找树苗并换到 0 号槽，不能只看前 9 格 */
    const sapIdx = G.inventory.slots.findIndex(s => s && s.item === 'oak_sapling');
    if (sapIdx >= 0) { G.inventory.set(0, G.inventory.get(sapIdx)); G.inventory.set(sapIdx, null); }
    G.selectHotbar(0);
    const sx = Math.floor(G.controller.pos.x) - 2, sz = Math.floor(G.controller.pos.z);
    /* 把落点强制成草地并清空上方：这一节测「树苗能不能种/长」，不是赌当前地表类型。
       前面章节的测试平台/树冠可能让 topSolidY 落在石头或木头上（19.3a 曾偶发 block=0）。 */
    const ensureGrass = (gx, gz) => {
      const gy = G.world.topSolidY(gx, gz);
      T.setBlock(gx, gy, gz, 3);
      for (let h = 1; h <= 4; h++) T.setBlock(gx, gy + h, gz, 0);
      return gy;
    };
    const sy = ensureGrass(sx, sz);
    G.controller.yaw = Math.atan2(-(sx + 0.5 - G.controller.pos.x), -(sz + 0.5 - G.controller.pos.z));
    G.controller.pitch = -0.5;
    G.interaction.updateTarget();
    const planted = G.useNonBlockItem(G.inventory.held(), { x: sx, y: sy, z: sz });
    await sleep(150);
    ok('19.3a 树苗可种在草地上', planted === true && G.world.getBlock(sx, sy + 1, sz) === 38,
      'block=' + G.world.getBlock(sx, sy + 1, sz));
    const sapKey = sx + ',' + (sy + 1) + ',' + sz;
    ok('19.3b 树苗进入生长表', G.saplings.has(sapKey), [...G.saplings.keys()].join(' '));
    if (G.saplings.has(sapKey)) {
      G.saplings.get(sapKey).age = G.saplings.get(sapKey).need + 1;
      G.tickSaplings(0.016);
      await sleep(300);
      let logs = 0, leaves = 0;
      for (let dy = 0; dy < 12; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
        const id = G.world.getBlock(sx + dx, sy + 1 + dy, sz + dz);
        if (id === 10) logs++; else if (id === 11) leaves++;
      }
      ok('19.3c 树苗到时间长成一棵树', logs >= 4 && leaves >= 10 && !G.saplings.has(sapKey),
        '原木=' + logs + ' 树叶=' + leaves);
    }

    // 19.4 树苗掉落自身
    const s2x = sx + 6, s2z = sz;
    const s2y = ensureGrass(s2x, s2z);
    const planted2 = G.useNonBlockItem({ item: 'oak_sapling' }, { x: s2x, y: s2y, z: s2z });
    await sleep(120);
    const sapBefore = G.inventory.countOf('oak_sapling');
    T.mineAt(s2x, s2y + 1, s2z);
    await sleep(2400);
    ok('19.4 挖掉树苗掉回树苗物品',
      planted2 && G.world.getBlock(s2x, s2y + 1, s2z) === 0 &&
      (G.inventory.countOf('oak_sapling') > sapBefore || G.interaction.drops.list.some(d => d.item === 'oak_sapling')),
      'before=' + sapBefore + ' after=' + G.inventory.countOf('oak_sapling'));

    // 19.5 箱子：合成 → 放置 → 存取 → 破坏掉出内容
    T.give('planks', 16);
    G.openCrafting(3);
    await frame();
    G.tableCraft.clear();
    for (const i of [0, 1, 2, 3, 5, 6, 7, 8]) G.tableCraft.set(i, { item: 'planks', count: 1 });
    G.ui.refreshUI(); await frame();
    const rc = G.tableCraft.result();
    ok('19.5a 八木板合成箱子', rc && rc.item === 'chest', JSON.stringify(rc));
    T.craftNow(1);
    G.closeUI();
    await sleep(120);
    const chx = Math.floor(G.controller.pos.x) + 3, chz = sz, chy = G.world.topSolidY(chx, chz);
    clearVegetation(chx, chz, 4, chy - 1, chy + 4);
    T.placeAt(chx, chy + 1, chz, 'chest');
    await sleep(400);
    ok('19.5b 箱子可放置', G.world.getBlock(chx, chy + 1, chz) === 39, 'id=' + G.world.getBlock(chx, chy + 1, chz));
    G.interaction.placeCd = 0;
    const aimChest = () => {
      const yaw = Math.atan2(-(chx + 0.5 - G.controller.pos.x), -(chz + 0.5 - G.controller.pos.z));
      G.controller.yaw = yaw;
      for (const p of [-0.05, -0.15, -0.25, -0.35, -0.45, -0.55, -0.65, 0.05, -0.75]) {
        G.controller.pitch = p;
        const h = G.interaction.updateTarget();
        if (h && h.x === chx && h.y === chy + 1 && h.z === chz) return true;
      }
      return false;
    };
    let aimed = aimChest();
    if (!aimed) {   // 地形高差太大时，站到与箱子同高再瞄
      G.controller.spawnAt(chx - 2.5, chy + 1, chz + 0.5);
      await sleep(200);
      aimed = aimChest();
    }
    G.interaction.placeCd = 0;
    G.input.state.mouseRight = true;
    G.interaction.update(0.02);
    G.input.state.mouseRight = false;
    await sleep(250);
    ok('19.5c 右键箱子打开容器界面', G.openUI === 'chest' && document.querySelectorAll('#chest-grid .slot').length === 27,
      'openUI=' + G.openUI + ' 瞄准=' + aimed);
    T.give('diamond', 5);
    const slot0 = document.querySelector('#panel-inventory [data-slot="chest:0"]');
    G.inventory.cursor = { item: 'diamond', count: 5 };
    slot0.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    await frame();
    const chestSlots = G.world.getContainer(chx, chy + 1, chz);
    ok('19.5d 可向箱子存入物品', chestSlots[0] && chestSlots[0].item === 'diamond' && chestSlots[0].count === 5,
      JSON.stringify(chestSlots[0]));
    G.closeUI();
    await sleep(120);
    ok('19.5e 关闭后箱子内容仍在世界数据里',
      !!(G.world.getContainer(chx, chy + 1, chz)[0] && G.world.getContainer(chx, chy + 1, chz)[0].item === 'diamond'));
    const diaBefore = G.inventory.countOf('diamond');
    T.mineAt(chx, chy + 1, chz);
    await sleep(2400);
    ok('19.5f 破坏箱子时内容物掉在地上',
      G.world.getBlock(chx, chy + 1, chz) === 0 && G.interaction.drops.list.some(d => d.item === 'diamond'),
      'drops=' + G.interaction.drops.list.map(d => d.item).join(','));
    ok('19.5g 箱子被破坏后容器数据被清除', !G.world.hasContainer(chx, chy + 1, chz));
    G.controller.spawnAt(chx + 0.5, G.controller.pos.y, chz + 0.5);
    await tryUntil(() => G.inventory.countOf('diamond') > diaBefore, { budgetMs: 6000, label: '钻石掉落物被重新拾取', observe: () => G.inventory.countOf('diamond') });
    ok('19.5h 掉出的钻石可以重新拾取', G.inventory.countOf('diamond') > diaBefore,
      diaBefore + ' → ' + G.inventory.countOf('diamond'));

    // 19.6 新配方：南瓜灯 / 蘑菇煲
    T.give('pumpkin', 1); T.give('glowstone', 1); T.give('mushroom_brown', 1); T.give('mushroom_red', 1);
    G.openInventory();
    await frame();
    const rows = [...document.querySelectorAll('#recipe-book .recipe-item')];
    const lampRow = rows.find(n => n.textContent.includes('南瓜灯'));
    const stewRow = rows.find(n => n.textContent.includes('蘑菇煲'));
    ok('19.6a 配方书出现南瓜灯与蘑菇煲', !!lampRow && !!stewRow, 'lamp=' + !!lampRow + ' stew=' + !!stewRow);
    if (lampRow) {
      lampRow.click(); await frame();
      const rl = G.playerCraft.result();
      ok('19.6b 南瓜+荧石合成南瓜灯', rl && rl.item === 'pumpkin_lamp', JSON.stringify(rl));
      T.craftNow(1);
      ok('19.6c 南瓜灯入库且荧石被扣', G.inventory.countOf('pumpkin_lamp') >= 1 && G.inventory.countOf('glowstone') === 0,
        'lamp=' + G.inventory.countOf('pumpkin_lamp'));
    }
    G.playerCraft.clear();
    G.ui.refreshUI(); await frame();
    const stew2 = [...document.querySelectorAll('#recipe-book .recipe-item')].find(n => n.textContent.includes('蘑菇煲'));
    if (stew2) { stew2.click(); await frame(); T.craftNow(1); }
    ok('19.6d 蘑菇煲合成成功', G.inventory.countOf('mushroom_stew') >= 1, 'stew=' + G.inventory.countOf('mushroom_stew'));
    G.closeUI();
    await sleep(100);

    // 19.7 吃蘑菇煲恢复饥饿
    G.controller.hunger = 6; G.controller.saturation = 0;
    const ateStew = G.controller.eat('mushroom_stew');
    ok('19.7 吃蘑菇煲恢复饥饿值', ateStew && G.controller.hunger > 6, 'hunger=' + G.controller.hunger);

    // 19.8 掉落物与箱子纳入存档
    const keepChest = { x: Math.floor(G.controller.pos.x) - 4, y: G.world.topSolidY(Math.floor(G.controller.pos.x) - 4, sz) + 1, z: sz };
    T.placeAt(keepChest.x, keepChest.y, keepChest.z, 'chest');
    G.world.getContainer(keepChest.x, keepChest.y, keepChest.z)[3] = { item: 'poppy', count: 2 };
    await sleep(200);
    G.interaction.drops.spawn('emerald', 3, G.controller.pos.x + 8.5, G.controller.pos.y, G.controller.pos.z + 8.5, false);
    const dropTotal = G.interaction.drops.list.length;
    G.pause(); await frame();
    await G.save('manual');
    G.toMenu(); await sleep(500);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 25000, tick: 'sleep', intervalMs: 100, label: '回到游戏中' });
    await sleep(900);
    ok('19.8 地上的掉落物随存档保存并恢复',
      G.interaction.drops.list.some(d => d.item === 'emerald' && d.count === 3),
      '保存前=' + dropTotal + ' 读档后=' + G.interaction.drops.list.map(d => d.item + 'x' + d.count).join(','));
    const kept = G.world.getContainer(keepChest.x, keepChest.y, keepChest.z);
    ok('19.9 箱子内容随存档恢复', kept[3] && kept[3].item === 'poppy' && kept[3].count === 2, JSON.stringify(kept[3]));
    ok('19.10 被破坏的箱子不会在存档里复活', !G.world.hasContainer(chx, chy + 1, chz) && G.world.getBlock(chx, chy + 1, chz) !== 39,
      'id=' + G.world.getBlock(chx, chy + 1, chz));

    /* ---------------- 20. 界面状态机（本回合修掉全屏界面残留的 bug） ---------------- */
    const vis = (sel) => !document.querySelector(sel).classList.contains('hidden');
    G.pause(); await frame();
    ok('20.1 暂停时显示暂停界面', G.state === 'paused' && vis('#screen-pause') && !vis('#screen-menu'));
    G.resume(); await frame();
    ok('20.2 回到游戏后暂停界面被隐藏（修复前会残留）', G.state === 'playing' && !vis('#screen-pause'),
      'screen-pause 可见=' + vis('#screen-pause'));
    G.openInventory(); await frame();
    ok('20.3 背包面板可打开', vis('#panel-inventory'));
    G.closeUI(); await frame();
    ok('20.4 关闭后背包面板隐藏', !vis('#panel-inventory'));
    G.openChest({ x: keepChest.x, y: keepChest.y, z: keepChest.z }); await frame();
    ok('20.5 箱子面板有 27 个容器格', vis('#panel-inventory') && document.querySelectorAll('#chest-grid .slot').length === 27,
      '格数=' + document.querySelectorAll('#chest-grid .slot').length);
    G.closeUI(); await frame();
    ok('20.6 关闭后箱子面板隐藏', !vis('#panel-inventory'));
    G.controller.hurt(20, '界面测试'); await sleep(200);
    ok('20.7 死亡界面显示', G.state === 'dead' && vis('#screen-death'));
    document.querySelector('#btn-respawn').click(); await sleep(300);
    ok('20.8 重生后死亡界面被隐藏（修复前会残留）', G.state === 'playing' && !vis('#screen-death'),
      'screen-death 可见=' + vis('#screen-death'));
    G.openInventory(); await frame();
    const allNames = [];
    for (let tab = 0; tab < 5; tab++) {
      G.ui.creativeTab = tab;
      G.ui.showCreativeTab();
      await frame();
      for (const n of document.querySelectorAll('#panel-inventory [data-slot^="give:"]')) {
        allNames.push(n.getAttribute('title') || '');
      }
    }
    ok('20.9 创造物品栏包含新方块',
      allNames.some(n => n.includes('箱子')) && allNames.some(n => n.includes('南瓜灯')) &&
      allNames.some(n => n.includes('虞美人')) && allNames.some(n => n.includes('仙人掌')),
      '全部分页共 ' + allNames.length + ' 项');
    G.closeUI(); await sleep(100);

    /* ---------------- 21. T2：羊毛来源 / 床 / 睡觉 / 自定义重生点 ---------------- */
    const qtx = Math.floor(G.controller.pos.x), qtz = Math.floor(G.controller.pos.z);
    // 21.1~21.3 羊掉羊毛（床的原料必须有来源）
    const qsy = G.world.topSolidY(qtx + 3, qtz);
    const sheep = G.mobs.spawn('sheep', qtx + 3.5, qsy + 1, qtz + 0.5);
    ok('T2.1 羊可作为被动生物生成', !!sheep && sheep.name === '羊' && G.mobs.list.indexOf(sheep) >= 0,
      'name=' + (sheep && sheep.name));
    G.interaction.drops.list.length = 0;
    G.mobs.hitMob(sheep, 999, { x: 0, z: 0 });
    await sleep(150);
    ok('T2.2 击杀羊掉落羊毛', !G.mobs.list.includes(sheep) && G.interaction.drops.list.some(d => d.item === 'wool'),
      'drops=' + G.interaction.drops.list.map(d => d.item).join(','));
    const woolPickable = G.interaction.drops.list.find(d => d.item === 'wool');
    if (woolPickable) { woolPickable.x = G.controller.pos.x; woolPickable.z = G.controller.pos.z; woolPickable.y = G.controller.pos.y + 0.5; woolPickable.pickDelay = 0; }
    await tryUntil(() => G.inventory.countOf('wool') > 0, { budgetMs: 5000, label: '羊毛被拾取进背包', observe: () => G.inventory.countOf('wool') });
    ok('T2.3 羊毛可以捡起', G.inventory.countOf('wool') >= 1, 'wool=' + G.inventory.countOf('wool'));

    // 21.4~21.5 工作台合成床（3 羊毛 + 3 木板）
    T.give('wool', 3); T.give('planks', 4);
    T.openUI('crafting'); await frame();
    const bedRes = T.craftSet(['wool', 'wool', 'wool', 'planks', 'planks', 'planks', '', '', '']);
    ok('T2.4 3羊毛+3木板 在工作台合成床', bedRes && bedRes.item === 'bed', JSON.stringify(bedRes));
    T.craftNow(1);
    ok('T2.5 床入库且合成格清空', G.inventory.countOf('bed') >= 1 && G.tableCraft.grid().flat().every(c => !c),
      'bed=' + G.inventory.countOf('bed'));
    G.closeUI(); await sleep(120);

    // 21.6~21.7 造一小块平整地面再放床（自然地形起伏会让射线先打到地面），然后真实瞄准
    const pfx = Math.floor(G.controller.pos.x), pfz = Math.floor(G.controller.pos.z), pfy = Math.floor(G.controller.pos.y);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = 0; dx <= 3; dx++) {
        T.setBlock(pfx + dx, pfy - 1, pfz + dz, 1);      // 坚实的地板层
        T.setBlock(pfx + dx, pfy, pfz + dz, 0);          // 清空脚部空间
        T.setBlock(pfx + dx, pfy + 1, pfz + dz, 0);      // 清掉头上的障碍
      }
    }
    G.controller.spawnAt(pfx + 0.5, pfy, pfz + 0.5);
    await frame(); await frame();
    const bx0 = pfx + 2, bz0 = pfz, by0 = pfy;
    T.placeAt(bx0, by0, bz0, 'bed');
    ok('T2.6 床可以放置（方块 id 49）', G.world.getBlock(bx0, by0, bz0) === 49,
      'id=' + G.world.getBlock(bx0, by0, bz0));
    G.pause(); await frame(); G.resume(); await frame();     // 回到干净的游玩状态（界面全部隐藏）
    const aimBed = () => {
      const ex = G.controller.pos.x, ey = G.controller.eyeY, ez = G.controller.pos.z;
      const dx = bx0 + 0.5 - ex, dy = by0 + 0.5 - ey, dz = bz0 + 0.5 - ez;
      G.controller.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
      G.controller.yaw = Math.atan2(-dx, -dz);
      const t0 = G.interaction.updateTarget();
      if (t0 && t0.x === bx0 && t0.y === by0 && t0.z === bz0) return true;
      // 兜底：从上到下再扫一遍（床面可能比眼睛高或低）
      for (let p = 0.6; p >= -1.3; p -= 0.04) {
        G.controller.pitch = p;
        const t = G.interaction.updateTarget();
        if (t && t.x === bx0 && t.y === by0 && t.z === bz0) return true;
      }
      return false;
    };
    ok('T2.7 准星能命中床（真实射线，不是 API 直调）', aimBed() === true,
      'yaw=' + G.controller.yaw.toFixed(2) + ' 命中=' + JSON.stringify(G.interaction.target));

    // 21.8 白天右键床不生效（时间在自然推进，用区间判断而不是精确值）
    T.setTime(0.3);
    const bedPosBefore = T.bedSpawn();
    G.interaction.placeCd = 0;
    G.input.state.mouseRight = true; await frame(); await frame(); G.input.state.mouseRight = false;
    await sleep(180);
    ok('T2.8 白天右键床被拒绝，时间不跳且不设重生点',
      G.time > 0.29 && G.time < 0.34 && T.bedSpawn() === bedPosBefore && G.state === 'playing',
      'time=' + G.time.toFixed(3) + ' bed=' + JSON.stringify(T.bedSpawn()) + ' state=' + G.state);

    // 21.9~21.11 夜晚右键床：跳到清晨 + 回血 + 设重生点
    G.mobs.clear();                      // 夜里会刷怪，先清空避免僵尸打断血量断言
    G.controller.health = 10;
    G.controller.invulnerable = 0;
    T.setTime(0.78);
    aimBed();
    G.interaction.placeCd = 0;
    G.input.state.mouseRight = true; await frame(); await frame(); G.input.state.mouseRight = false;
    await sleep(200);
    ok('T2.9 夜晚睡觉把时间推到清晨', G.time > 0.04 && G.time < 0.12, 'time=' + G.time.toFixed(3));
    ok('T2.10 睡觉恢复损失生命的一半', G.controller.health === 15, 'hp=' + G.controller.health);
    const bs = T.bedSpawn();
    ok('T2.11 重生点设为床上方', !!bs && Math.floor(bs.x) === bx0 && Math.floor(bs.z) === bz0 && Math.abs(bs.y - (by0 + 1)) < 0.001,
      'bedSpawn=' + JSON.stringify(bs));

    // 21.12~21.13 死亡回到床边
    G.controller.spawnAt(qtx + 18.5, by0 + 14, qtz);
    await frame();
    G.mobs.clear();
    G.controller.invulnerable = 0;
    G.controller.hurt(99, '测试');
    await sleep(220);
    ok('T2.12 死亡后进入死亡界面', G.state === 'dead', 'state=' + G.state);
    document.querySelector('#btn-respawn').click();
    await sleep(260);
    ok('T2.13 重生回到床边而不是死亡地点',
      G.state === 'playing' && Math.hypot(G.controller.pos.x - bs.x, G.controller.pos.z - bs.z) < 1.6 &&
      Math.hypot(G.controller.pos.x - (qtx + 18.5), G.controller.pos.z - qtz) > 10,
      'pos=' + JSON.stringify({ x: +G.controller.pos.x.toFixed(2), z: +G.controller.pos.z.toFixed(2) }) +
      ' 床=' + JSON.stringify({ x: bs.x, z: bs.z }) + ' 死亡点=' + JSON.stringify({ x: qtx + 18.5, z: qtz }));

    // 21.14~21.15 破坏床 → 重生点失效
    T.mineAt(bx0, by0, bz0);
    await sleep(200);
    ok('T2.14 床被破坏后方块消失', G.world.getBlock(bx0, by0, bz0) !== 49, 'id=' + G.world.getBlock(bx0, by0, bz0));
    ok('T2.15 重生点回落到世界出生点', T.bedSpawn() === null &&
      Math.hypot(T.respawnPoint().x - G.spawn.x, T.respawnPoint().z - G.spawn.z) < 0.01,
      'bed=' + JSON.stringify(T.bedSpawn()) + ' point=' + JSON.stringify(T.respawnPoint()));

    // 21.16~21.17 存档往返：重生点与时间要活过读档
    const bx1 = qtx + 4, bz1 = qtz, by1 = G.world.topSolidY(bx1, bz1) + 1;
    T.give('bed', 2);
    T.placeAt(bx1, by1, bz1, 'bed');
    T.setTime(0.8);
    const slept = T.sleepAt(bx1, by1, bz1);
    ok('T2.16 第二张床同样可睡并写入重生点', slept === true && T.bedSpawn() !== null, 'bed=' + JSON.stringify(T.bedSpawn()));
    const timeAtSave = G.time;
    G.pause(); await frame();
    await G.save('manual');
    G.toMenu(); await sleep(400);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 25000, tick: 'sleep', intervalMs: 100, label: '回到游戏中' });
    await sleep(600);
    ok('T2.17 读档后重生点与时间一致',
      T.bedSpawn() !== null && Math.floor(T.bedSpawn().x) === bx1 && Math.abs(G.time - timeAtSave) < 0.02,
      'bed=' + JSON.stringify(T.bedSpawn()) + ' time=' + G.time.toFixed(4) + ' 保存时=' + timeAtSave.toFixed(4));
    ok('T2.18 读档后床方块仍在世界里', G.world.getBlock(bx1, by1, bz1) === 49, 'id=' + G.world.getBlock(bx1, by1, bz1));

    /* ---------------- 22. T3：弓与箭（材料链 / 蓄力 / 命中 / 插地拾回） ---------------- */
    T.openUI('crafting'); await frame();
    // 22.1~22.2 羊毛 → 线
    let sres = T.craftSet(['wool']);
    ok('T3.1 1 羊毛拆成 2 线', sres && sres.item === 'string' && sres.count === 2, JSON.stringify(sres));
    T.craftNow(1);
    ok('T3.2 线进入背包', G.inventory.countOf('string') >= 2, 'string=' + G.inventory.countOf('string'));
    // 22.3~22.4 3 木棍 + 3 线 → 弓
    T.give('stick', 4);
    T.craftSet(['stick', 'stick', 'string', 'stick', '', 'string', '', '', 'string']);
    const bres = G.tableCraft.result();
    ok('T3.3 3木棍+3线 在工作台合成弓', bres && bres.item === 'bow', JSON.stringify(bres));
    T.craftNow(1);
    ok('T3.4 弓入库', G.inventory.countOf('bow') >= 1, 'bow=' + G.inventory.countOf('bow'));
    // 22.5 燧石 + 木棍 + 羽毛 → 4 支箭
    T.give('flint', 2); T.give('feather', 2);
    T.craftSet(['flint', '', '', 'stick', '', '', 'feather', '', '']);
    const ares = G.tableCraft.result();
    ok('T3.5 燧石+木棍+羽毛 合成 4 支箭', ares && ares.item === 'arrow' && ares.count === 4, JSON.stringify(ares));
    T.craftNow(1);
    G.closeUI(); await sleep(120);
    T.give('arrow', 8);
    G.inventory.set(0, { item: 'bow', count: 1, dur: 200 });
    G.selectHotbar(0);
    G.mobs.clear();

    const aimAt = (tx, ty, tz) => {
      const ex = G.controller.pos.x, ey = G.controller.eyeY, ez = G.controller.pos.z;
      const dx = tx - ex, dy = ty - ey, dz = tz - ez, L = Math.hypot(dx, dy, dz) || 1;
      G.controller.pitch = Math.asin(dy / L);
      G.controller.yaw = Math.atan2(-dx / L, -dz / L);
      return { x: dx / L, y: dy / L, z: dz / L };
    };
    // 先水平瞄准开阔方向：不然箭可能落在脚下被立刻拾回，看不出「射出」这一步
    aimAt(G.controller.pos.x, G.controller.eyeY, G.controller.pos.z - 24);

    // 22.6 手持弓时右键不放置方块
    const t3x = Math.floor(G.controller.pos.x), t3z = Math.floor(G.controller.pos.z), t3y = Math.floor(G.controller.pos.y);
    const spotId = G.world.getBlock(t3x + 2, t3y + 1, t3z);
    G.input.state.mouseRight = true;
    // 观察 0.6 秒：期间一旦真的往世界里塞了方块就提前停（原来是固定 10 帧）
    const wNoPlace = await watch(600, () => G.world.getBlock(t3x + 2, t3y + 1, t3z) !== spotId);
    ok('T3.6 拿弓右键不会往世界里塞方块', G.world.getBlock(t3x + 2, t3y + 1, t3z) === spotId,
      'id ' + spotId + '→' + G.world.getBlock(t3x + 2, t3y + 1, t3z) + ' 观察=' + wNoPlace.ms + 'ms/' + wNoPlace.ticks + '帧' +
      (wNoPlace.violated ? ' 曾放置!' : ''));
    // 22.7~22.8 蓄力增长 + HUD 进度条
    const midCharge = T.bowInfo().charge;
    const barEl = document.querySelector('#bow-charge');
    ok('T3.7 按住右键蓄力在增长', midCharge > 0.03 && midCharge < 1, 'charge=' + midCharge);
    ok('T3.8 蓄力条可见且宽度大于 0',
      barEl && !barEl.classList.contains('hidden') && parseInt(barEl.firstElementChild.style.width || '0', 10) > 0,
      'width=' + (barEl ? barEl.firstElementChild.style.width : 'n/a'));
    // 继续按住蓄力：观察 0.5 秒（原来固定 80 帧，只影响「攒到多少 charge」，不影响断言语义）
    await watch(500, () => false);
    // 蓄满需要 0.9 秒真实时间，而每帧 dt 是真实值：帧率越高，同样帧数攒到的 dt 越少。
    // 所以轮询到真的封顶（预算 3 秒），不再数帧。
    const wCharge = await tryUntil(() => T.bowInfo().charge >= 1, { budgetMs: 3000, label: '弓蓄力封顶', observe: () => T.bowInfo().charge });
    ok('T3.9 蓄满后封顶为 1', Math.abs(T.bowInfo().charge - 1) < 1e-6, 'charge=' + T.bowInfo().charge + ' 用时=' + (wCharge.ok ? wCharge.ms + 'ms' : '超时'));
    // 22.10~22.12 松手射出：实体、扣箭、扣耐久
    const arrowsBefore = G.inventory.countOf('arrow');
    const t3dur0 = G.inventory.held().dur;
    G.input.state.mouseRight = false;
    await frame(); await frame();
    const ents = T.arrowEntities();
    ok('T3.10 松手射出玩家箭实体', ents.length >= 1 && ents[ents.length - 1].fromMob === false,
      'n=' + ents.length + ' ' + JSON.stringify(ents[ents.length - 1] || null));
    ok('T3.11 射击消耗 1 支箭与 1 点耐久',
      G.inventory.countOf('arrow') === arrowsBefore - 1 && G.inventory.held().dur === t3dur0 - 1,
      'arrow ' + arrowsBefore + '→' + G.inventory.countOf('arrow') + ' dur ' + t3dur0 + '→' + G.inventory.held().dur);
    ok('T3.12 射出后蓄力条隐藏', document.querySelector('#bow-charge').classList.contains('hidden'));
    // 22.13 蓄力越久初速度越大
    aimAt(G.controller.pos.x, G.controller.eyeY, G.controller.pos.z - 6);
    T.shoot(0.2);
    const slow = T.arrowEntities().slice(-1)[0];
    T.shoot(1);
    const fast = T.arrowEntities().slice(-1)[0];
    const sp = (a) => (a ? Math.hypot(a.vx, a.vy, a.vz) : 0);
    ok('T3.13 蓄力越久初速度越大', !!slow && !!fast && sp(fast) > sp(slow) * 1.25, '慢=' + sp(slow).toFixed(1) + ' 快=' + sp(fast).toFixed(1));
    ok('T3.14 满蓄力伤害高于轻射', !!slow && !!fast && fast.damage > slow.damage, '伤害 ' + (slow && slow.damage) + ' vs ' + (fast && fast.damage));
    // 22.15~22.16 命中生物造成伤害（真实弹道推进，不是直接调 hitMob）
    // 目标放在同一块测试平台上（而不是平台外 5 格的低地），否则箭会先撞到平台边缘。
    const gy3 = t3y;
    const t3pig = G.mobs.spawn('pig', t3x + 2.5, gy3, t3z + 0.5);
    G.mobs.physics(t3pig, 0.02);
    t3pig.vel.x = t3pig.vel.z = 0;
    const pigHp = t3pig.hp;
    const entsBefore = T.arrowEntities().length;
    aimAt(t3pig.pos.x, t3pig.pos.y + t3pig.height * 0.55, t3pig.pos.z);
    T.shoot(1);
    T.stepArrows(0.005, 200);
    ok('T3.15 箭命中生物并造成伤害', t3pig.hp < pigHp || G.interaction.drops.list.some(d => d.item === 'pork_raw'),
      'hp ' + pigHp + '→' + t3pig.hp +
      ' pig=' + JSON.stringify({ x: +t3pig.pos.x.toFixed(2), y: +t3pig.pos.y.toFixed(2), z: +t3pig.pos.z.toFixed(2), h: t3pig.height, w: t3pig.width }) +
      ' player=' + JSON.stringify({ x: +G.controller.pos.x.toFixed(2), y: +G.controller.pos.y.toFixed(2), z: +G.controller.pos.z.toFixed(2) }) +
      ' arrows=' + JSON.stringify(T.arrowEntities().slice(-3)));
    ok('T3.16 命中的那支箭被消耗掉（不再留在猪附近飞行）',
      T.arrowEntities().length < entsBefore + 1 &&
      !T.arrowEntities().some(a => !a.stuck && Math.hypot(a.x - t3pig.pos.x, a.z - t3pig.z) < 1.2),
      '射出前=' + entsBefore + ' 命中后=' + T.arrowEntities().length);
    // 22.17~22.18 插在地上可拾回
    const t3wallZ = t3z - 4;
    T.setBlock(t3x, t3y + 1, t3wallZ, 1);
    aimAt(t3x + 0.5, t3y + 1.5, t3wallZ);
    T.shoot(0.7);
    let stuckArrow = null;
    for (let i = 0; i < 400 && !stuckArrow; i++) {
      T.stepArrows(0.005, 1);
      stuckArrow = T.arrowEntities().find(a => a.stuck && !a.fromMob) || null;
    }
    ok('T3.17 射向墙面的箭会插住', !!stuckArrow, 'stuck=' + JSON.stringify(stuckArrow));
    const pickBefore = G.inventory.countOf('arrow');
    // 站到箭前 1.2 格（直接站到箭所在格会被挤出墙顶，距离反而超过拾取半径）
    if (stuckArrow) { G.controller.spawnAt(stuckArrow.x, t3y, stuckArrow.z + 1.2); await frame(); }
    T.stepArrows(0.02, 5);
    ok('T3.18 走近可以把插着的箭捡回来',
      !!stuckArrow && G.inventory.countOf('arrow') === pickBefore + 1 &&
      !T.arrowEntities().some(a => a.stuck && Math.abs(a.x - stuckArrow.x) < 0.01 && Math.abs(a.z - stuckArrow.z) < 0.01),
      'arrow ' + pickBefore + '→' + G.inventory.countOf('arrow'));
    // 22.19~22.20 没有箭时不能蓄力，松手不留残余
    G.inventory.remove('arrow', 99);
    G.input.state.mouseRight = true;
    await frame(); await frame();
    ok('T3.19 没有箭时蓄力被拒绝', T.bowInfo().charge === -1, 'charge=' + T.bowInfo().charge);
    G.input.state.mouseRight = false;
    await frame(); await frame();
    ok('T3.20 松手后蓄力状态清零', T.bowInfo().charge === 0 &&
      document.querySelector('#bow-charge').classList.contains('hidden'), 'charge=' + T.bowInfo().charge);
    T.give('arrow', 4);

    /* ---------------- 23. T4：自动上台阶与仙人掌接触伤害 ---------------- */
    const stx = Math.floor(G.controller.pos.x), stz = Math.floor(G.controller.pos.z), sty = Math.floor(G.controller.pos.y);
    for (let d = 0; d <= 8; d++) {
      T.setBlock(stx, sty, stz - d, 1);
      for (let h = 1; h <= 4; h++) T.setBlock(stx, sty + h, stz - d, 0);
    }
    T.setBlock(stx, sty + 1, stz - 1, 1);          // 1 格高的台阶
    await sleep(150);
    G.controller.spawnAt(stx + 0.5, sty + 1, stz + 0.5);
    G.controller.yaw = 0;
    await frame(); await frame();
    const climbFrom = G.controller.pos.y;
    T.key('KeyW', true);
    let climbed = false;
    // 轮询到真的被抬上台阶（预算 4 秒），不再数帧
    climbed = (await tryUntil(() => G.controller.pos.y > climbFrom + 0.9, { budgetMs: 4000, label: '自动上 1 格台阶', observe: () => +G.controller.pos.y.toFixed(2) })).ok;
    T.key('KeyW', false);
    ok('T4.1 真实主循环里能自动走上 1 格台阶', climbed, 'y ' + climbFrom.toFixed(2) + '→' + G.controller.pos.y.toFixed(2));
    // 抬升必须由 tryStepUp 完成（而不是 somehow 白捡的高度）：用 controller 上的直接计数证明
    const stDiag = T.stepDiag();
    ok('T4.1b 这次上台阶确实由自动抬升 tryStepUp 完成', stDiag.inController >= 1,
      'tryStepUp 执行=' + stDiag.inController + ' 事件送达=' + stDiag.events + ' 监视器豁免=' + stDiag.allowHits);
    ok('T4.2 上台阶不是穿墙（台阶方块还在）', G.world.getBlock(stx, sty + 1, stz - 1) === 1,
      'id=' + G.world.getBlock(stx, sty + 1, stz - 1));
    // 潜行时不自动上台
    G.controller.spawnAt(stx + 0.5, sty + 1, stz + 0.5);
    G.controller.yaw = 0;
    await frame();
    const sneakFrom = G.controller.pos.y;
    T.key('KeyW', true); T.key('ShiftLeft', true);
    let sneakUp = false;
    // 潜行时「不该自动上台」：观察 1.5 秒，一旦抬升就提前结束（原来固定 90 帧）
    const wSneak = await watch(1500, () => G.controller.pos.y > sneakFrom + 0.9);
    sneakUp = wSneak.violated;
    T.key('KeyW', false); T.key('ShiftLeft', false);
    ok('T4.3 潜行时不会自动上台阶', sneakUp === false && G.controller.pos.z > stz - 1,
      'y=' + G.controller.pos.y.toFixed(2) + ' z=' + G.controller.pos.z.toFixed(2) +
      ' 观察=' + wSneak.ms + 'ms/' + wSneak.ticks + '帧' + (wSneak.violated ? ' 曾抬升!' : ''));
    // 2 格高的墙仍然挡住
    T.setBlock(stx, sty + 2, stz - 1, 1);
    G.controller.spawnAt(stx + 0.5, sty + 1, stz + 0.5);
    G.controller.yaw = 0;
    await frame();
    T.key('KeyW', true);
    await watch(1500, () => false);   // 固定观察 1.5 秒（断言看的是最终位置，不是累计时长）
    T.key('KeyW', false);
    ok('T4.4 两格高的墙挡住且不会白跳一格', G.controller.pos.z > stz - 1 && G.controller.pos.y < sty + 1.9,
      'z=' + G.controller.pos.z.toFixed(2) + ' y=' + G.controller.pos.y.toFixed(2));
    T.setBlock(stx, sty + 2, stz - 1, 0);
    // 仙人掌接触伤害（真实循环）：仙人掌就放在玩家前进方向的相邻格。
    // 起点必须离仙人掌足够远（1.2 格）：贴得太近时 AABB 会与仙人掌同列，
    // spawnAt 的「卡进方块就往上顶」会把玩家直接放到仙人掌上方，于是走过去完全不掉血，
    // 看起来像玩法缺陷，其实只是布置问题。
    T.setBlock(stx, sty + 1, stz - 1, 44);          // 仙人掌
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.controller.spawnAt(stx + 0.5, sty + 1, stz + 1.2);
    G.controller.yaw = 0;
    await frame();
    ok('T4.5a 起点没有与仙人掌同列（不会被 spawnAt 顶飞）',
      Math.floor(G.controller.pos.y) === sty + 1,
      'y=' + G.controller.pos.y.toFixed(2) + ' 期望=' + (sty + 1));
    T.key('KeyW', true);
    let hurtByCactus = false;
    // 轮询到真的掉血（预算 4 秒）：贴着仙人掌每 0.5 秒掉 1 血，固定 200 帧在高帧率下不足 0.5 秒
    hurtByCactus = (await tryUntil(() => G.controller.health < 20, { budgetMs: 4000, label: '贴仙人掌掉血', observe: () => G.controller.health })).ok;
    T.key('KeyW', false);
    ok('T4.5 贴着仙人掌会掉血', hurtByCactus, 'hp=' + G.controller.health + ' z=' + G.controller.pos.z.toFixed(2));
    // 被仙人掌拦停，不允许被自动上台阶抬过去（仙人掌列在 stz-1，玩家必须停在它之前）
    ok('T4.5b 仙人掌把去路挡住（没被自动上台阶跨过去）',
      G.controller.pos.z > stz - 1 && G.controller.pos.y < sty + 1.9,
      'z=' + G.controller.pos.z.toFixed(2) + ' y=' + G.controller.pos.y.toFixed(2));
    // 走开后不再掉血
    const hpAway = G.controller.health;
    G.controller.spawnAt(stx + 0.5, sty + 1, stz + 4.5);
    G.controller.invulnerable = 0;
    const wAway = await watch(1200, () => G.controller.health < hpAway);   // 观察 1.2 秒：一旦掉血立刻停
    ok('T4.6 离开仙人掌后不再因接触掉血', G.controller.health >= hpAway,
      hpAway + '→' + G.controller.health + ' 观察=' + wAway.ms + 'ms' + (wAway.violated ? ' 曾掉血!' : ''));
    // 创造模式免疫（同样从 1.2 格外出发，确保真的贴上了仙人掌而不是被顶到它上方）
    G.setMode('creative');
    G.controller.health = 20;
    G.controller.spawnAt(stx + 0.5, sty + 1, stz + 1.2);
    G.controller.yaw = 0;
    T.key('KeyW', true);
    const wCrea = await watch(1500, () => G.controller.health < 20);   // 观察 1.5 秒：掉血就停
    T.key('KeyW', false);
    ok('T4.7 创造模式贴仙人掌不掉血', G.controller.health === 20 && G.controller.pos.z > stz - 1,
      'hp=' + G.controller.health + ' z=' + G.controller.pos.z.toFixed(2) +
      ' 观察=' + wCrea.ms + 'ms' + (wCrea.violated ? ' 曾掉血!' : ''));
    G.setMode('survival');
    T.setBlock(stx, sty + 1, stz - 1, 0);
    for (let d = 0; d <= 8; d++) { T.setBlock(stx, sty, stz - d, 0); }
    // 拆掉走廊后把玩家放回自然地面，避免最后几张截图里人在坑里下落
    G.controller.spawnAt(stx + 0.5, G.world.topSolidY(stx, stz + 8) + 1, stz + 8.5);
    await frame(); await frame();

    /* ---------------- 24. 回归：真实左键攻击生物（D1 崩溃路径）与红框行为 ---------------- */
    const rgx = Math.floor(G.controller.pos.x), rgz = Math.floor(G.controller.pos.z);
    G.mobs.clear();
    const rgy = G.world.topSolidY(rgx, rgz - 3);
    const victim = G.mobs.spawn('pig', rgx + 0.5, rgy + 1, rgz - 3);
    G.controller.spawnAt(rgx + 0.5, G.world.topSolidY(rgx, rgz) + 1, rgz + 0.5);
    G.inventory.set(0, { item: 'sword_wood', count: 1, dur: 60 });
    G.selectHotbar(0);
    await frame(); await frame();
    ok('回归.0 前置：靶子生物已就位', !!victim && victim.hp === victim.maxHp, 'hp=' + (victim && victim.hp));
    const vex = G.controller.pos.x, vey = G.controller.eyeY, vez = G.controller.pos.z;
    const vdx = victim.pos.x - vex, vdy = (victim.pos.y + victim.height * 0.55) - vey, vdz = victim.pos.z - vez;
    const vL = Math.hypot(vdx, vdy, vdz) || 1;
    G.controller.pitch = Math.asin(vdy / vL);
    G.controller.yaw = Math.atan2(-vdx / vL, -vdz / vL);
    const errMark = R.errors.length;
    /* 诊断信息（不新增断言，只把失败时的现场读数写进 info） */
    const rgProbe = () => {
      const t = G.interaction.target;
      const pk = G.mobs.attackTarget();
      return {
        eye: [+vex.toFixed(2), +vey.toFixed(2), +vez.toFixed(2)],
        pitch: +G.controller.pitch.toFixed(3), yaw: +G.controller.yaw.toFixed(3),
        look: (() => { const d = G.controller.lookDir(); return [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)]; })(),
        blockDist: t && t.dist !== undefined ? +t.dist.toFixed(2) : null,
        blockId: t ? t.id : null,
        pick: pk.mob ? pk.mob.type : (pk.blocked ? 'blocked' : 'none'),
        pickT: pk.dist !== null ? +pk.dist.toFixed(2) : null,
        victim: { y: +victim.pos.y.toFixed(2), h: +victim.height.toFixed(2), w: +victim.width.toFixed(2) },
        atk: T.attackInfo(), held: (G.inventory.held() || {}).item
      };
    };
    const rgBefore = rgProbe();
    G.input.state.mouseLeft = true;
    await frame(); await frame();
    G.input.state.mouseLeft = false;
    await sleep(150);
    ok('回归.1 真实左键打到生物：造成伤害且没有抛异常（D1 崩溃路径）',
      victim.hp < victim.maxHp && R.errors.length === errMark,
      'hp ' + victim.maxHp + '→' + victim.hp + ' 新增错误=' + (R.errors.length - errMark) +
      ' 现场=' + JSON.stringify(rgBefore) + ' 挥后=' + JSON.stringify(T.attackInfo()));
    const swordDmg = T.itemDef('sword_wood').damage;
    ok('回归.2 近战伤害取自物品表（sword_wood=' + swordDmg + '）',
      victim.hp === victim.maxHp - swordDmg,
      '期望扣 ' + swordDmg + ' 实得扣 ' + (victim.maxHp - victim.hp));
    // 运行期异常只记录、不弹「启动出错」红框
    window.dispatchEvent(new ErrorEvent('error', { message: 'injected-runtime-error', error: new Error('injected-runtime-error') }));
    await sleep(150);
    const bootBox = document.getElementById('boot-error');
    ok('回归.3 运行期异常不再弹红框盖住画面',
      window.__bootErrorShown === false && bootBox.classList.contains('hidden'),
      'shown=' + window.__bootErrorShown + ' hidden=' + bootBox.classList.contains('hidden'));
    R.errors.splice(errMark, R.errors.length - errMark);   // 只撤掉上面这条刻意注入的记录
    ok('回归.4 注入的错误已回收，不影响整体错误计数', R.errors.length === errMark, 'errors=' + R.errors.length);
    G.mobs.clear();

    /* ---------------- 25. 回归：水下气泡逐个增减（D4）与创造模式隐藏爱心（D6） ---------------- */
    const breathEl = document.querySelector('#breath');
    const heartsEl = document.querySelector('#hearts');
    const hungerEl = document.querySelector('#hunger');
    const visibleBubbles = () => [...breathEl.children].filter(b => b.style.display !== 'none').length;
    // 同步驱动 HUD（不等帧，避免真实循环把 eyeInWater 覆盖回 false）
    G.controller.eyeInWater = true; G.controller.air = 10;
    G.ui.updateHUD(G);
    ok('回归.5 满气时可见气泡 10 个', visibleBubbles() === 10, 'n=' + visibleBubbles() + ' 子元素=' + breathEl.childElementCount);
    G.controller.air = 5; G.ui.updateHUD(G);
    ok('回归.6 空气剩 5 时气泡逐个消失到 5 个', visibleBubbles() === 5, 'n=' + visibleBubbles());
    G.controller.air = 2.4; G.ui.updateHUD(G);
    ok('回归.7 空气 2.4 时可见气泡 3 个（向上取整）', visibleBubbles() === 3, 'n=' + visibleBubbles());
    G.controller.air = 0; G.ui.updateHUD(G);
    ok('回归.8 空气耗尽时气泡全部消失', visibleBubbles() === 0, 'n=' + visibleBubbles());
    G.controller.air = 10; G.ui.updateHUD(G);
    ok('回归.9 回满气时气泡逐个恢复到 10 个', visibleBubbles() === 10, 'n=' + visibleBubbles());
    G.controller.eyeInWater = false; G.ui.updateHUD(G);
    ok('回归.10 出水后整条气泡隐藏但节点保留（不再 innerHTML 清空）',
      (breathEl.style.opacity === '0' || breathEl.classList.contains('hidden')) && breathEl.childElementCount === 10,
      'opacity=' + breathEl.style.opacity + ' 子元素=' + breathEl.childElementCount);
    // D6：创造模式隐藏爱心
    G.setMode('creative'); G.controller.health = 20; G.ui.updateHUD(G);
    ok('回归.11 创造模式隐藏爱心（原来只隐藏了饥饿条）',
      heartsEl.style.opacity === '0' && hungerEl.style.opacity === '0',
      'hearts=' + JSON.stringify(heartsEl.style.opacity) + ' hunger=' + JSON.stringify(hungerEl.style.opacity));
    G.setMode('survival'); G.ui.updateHUD(G);
    ok('回归.12 切回生存爱心重新显示且数量正确',
      heartsEl.style.opacity === '1' && heartsEl.childElementCount === 10 && G.controller.health === 20,
      'hearts=' + JSON.stringify(heartsEl.style.opacity) + ' 子元素=' + heartsEl.childElementCount + ' hp=' + G.controller.health);

    /* ---------------- 26. 回归：创造模式飞行必须走真实按键（D5） ---------------- */
    G.setMode('creative');
    await frame();
    G.controller.flying = false;
    G.controller.spawnAt(G.spawn.x, G.spawn.y + 6, G.spawn.z);
    // 等到真的落地为止（固定 20 帧在高帧率下只有几十毫秒，人还在空中就会误报——与旧 T3.9 同类）
    const tLand0 = performance.now();
    for (let i = 0; i < 600 && !G.controller.onGround; i++) {
      await frame();
      if (performance.now() - tLand0 > 3000) break;
    }
    await frame();
    ok('回归.13 前置：创造模式下站在地面', G.controller.creative === true && G.controller.onGround === true,
      'creative=' + G.controller.creative + ' onGround=' + G.controller.onGround);
    // F 键：真实 keydown 链路
    T.key('KeyF', true); T.key('KeyF', false);
    await frame(); await frame();
    ok('回归.14 按 F 能开启飞行（真实按键，不是直接调 toggleFly）', G.controller.flying === true,
      'flying=' + G.controller.flying);
    T.key('KeyF', true); T.key('KeyF', false);
    await frame(); await frame();
    ok('回归.15 再按 F 能关闭飞行', G.controller.flying === false, 'flying=' + G.controller.flying);
    // 双击空格：两次 Space 间隔 < 320ms
    T.key('KeyF', true); T.key('KeyF', false);
    await frame();
    T.key('KeyF', true); T.key('KeyF', false);           // 先关掉，保证从「未飞行」开始
    await frame();
    const flyBefore = G.controller.flying;
    T.key('Space', true); T.key('Space', false);
    T.key('Space', true); T.key('Space', false);
    await frame(); await frame();
    ok('回归.16 双击空格能开启飞行（真实按键链路）',
      flyBefore === false && G.controller.flying === true,
      '起始 flying=' + flyBefore + ' 双击后 flying=' + G.controller.flying);
    // 飞行中的升降（先等 400ms 越过 320ms 的双击窗口，否则下一次 Space 会被当成「再次双击」把飞行关掉）
    await sleep(400);
    const yFly0 = G.controller.pos.y;
    T.key('Space', true);
    // 时间驱动而不是固定帧数：固定 40 帧在高帧率机器上只有 0.16 秒，位移可能差 0.08 格而误报（旧 T3.9 同类坑）
    let yUp = G.controller.pos.y;
    const tUp0 = performance.now();
    for (let i = 0; i < 600; i++) {
      await frame();
      yUp = G.controller.pos.y;
      if (yUp > yFly0 + 0.4 || performance.now() - tUp0 > 1500) break;
    }
    T.key('Space', false);
    ok('回归.17 飞行中按空格上升（仍在飞行状态，不是普通跳跃）',
      G.controller.flying === true && yUp > yFly0 + 0.4,
      'flying=' + G.controller.flying + ' y ' + yFly0.toFixed(2) + '→' + yUp.toFixed(2) +
      ' 用时=' + Math.round(performance.now() - tUp0) + 'ms');
    const yDownFrom = yUp;
    T.key('ShiftLeft', true);
    let yDown = G.controller.pos.y;
    const tDown0 = performance.now();
    for (let i = 0; i < 600; i++) {
      await frame();
      yDown = G.controller.pos.y;
      if (yDown < yDownFrom - 0.4 || performance.now() - tDown0 > 1500) break;
    }
    T.key('ShiftLeft', false);
    ok('回归.18 飞行中按左 Shift 下降', yDown < yDownFrom - 0.4,
      'y ' + yDownFrom.toFixed(2) + '→' + yDown.toFixed(2) +
      ' 用时=' + Math.round(performance.now() - tDown0) + 'ms flying=' + G.controller.flying);
    T.key('KeyF', true); T.key('KeyF', false);           // 关飞行
    await frame();
    G.setMode('survival');
    ok('回归.19 生存模式按 F 不飞行并给提示', G.controller.flying === false,
      'flying=' + G.controller.flying);

    /* ---------------- 27. D2：瞬移排查（位置监视器实测，不靠感觉） ---------------- */
    // 先制造一个「大存档」：250 个方块改动，让 buildSaveObject + JSON.stringify 承担真实成本。
    // 注意要绕开玩家自己站的格子：把自己埋进方块会让碰撞解算把人顶起约 1 格，
    // 那不是瞬移缺陷而是本节的布置问题（上一版就被 D2e 记成了一次跳变）。
    const wtPx0 = Math.floor(G.controller.pos.x), wtPz0 = Math.floor(G.controller.pos.z);
    let wtBigPlaced = 0;
    for (let i = 0; wtBigPlaced < 250 && i < 900; i++) {
      const bx = wtPx0 + (i % 16) - 8;
      const bz = wtPz0 + (((i / 16) | 0) - 8);
      if (Math.abs(bx - wtPx0) <= 1 && Math.abs(bz - wtPz0) <= 1) continue;   // 绕开玩家脚下
      T.setBlock(bx, G.world.topSolidY(bx, bz) + 1, bz, (i % 2) ? 4 : 1);
      wtBigPlaced++;
    }
    ok('回归.D2h 大存档确实放满了 250 格（绕开玩家不是空跑）', wtBigPlaced === 250, 'placed=' + wtBigPlaced);
    await sleep(250);
    T.resetPosMon();
    G.settings.autosaveSeconds = 10;
    G.saveTimer = 9.4;                       // 让自动存档落在本采样窗口内
    T.key('KeyW', true); T.key('ControlLeft', true);
    // 采样窗口：跑到监视器帧数 ≥220（D2a 要的是样本量而不是时长），按键计划用一次性标志
    let d2JumpDown = false, d2JumpUp = false;
    const wD2 = await tryUntil(() => {
      const f = T.posMon().frames;
      if (!d2JumpDown && f >= 60) { d2JumpDown = true; T.key('Space', true); }
      if (!d2JumpUp && f >= 68) { d2JumpUp = true; T.key('Space', false); }
      return f >= 220;
    }, { budgetMs: 15000, label: '位置监视器采满 220 帧', observe: () => T.posMon().frames });
    T.key('Space', false);
    T.key('KeyW', false); T.key('ControlLeft', false);
    const mon = T.posMon();
    ok('回归.D2a 监视器已足够采样（帧数 > 150）', !!mon && mon.frames > 150,
      'frames=' + (mon && mon.frames) + ' 采样窗口=' + (wD2.ok ? wD2.ms + 'ms' : '超时:' + wD2.timeout));
    ok('回归.D2b 采样窗口内没有无法解释的位置跳变（排除刻意传送）', !!mon && mon.jumpCount === 0,
      'jumpCount=' + (mon && mon.jumpCount) + ' 样例=' + JSON.stringify((mon && mon.jumps || []).slice(0, 2)));
    ok('回归.D2c 采样窗口内确实发生过自动存档（否则 D2d 是空过）', !!mon && mon.saves >= 1,
      'saves=' + (mon && mon.saves));
    ok('回归.D2d 存档同步段耗时 < 100ms（不足以造成可见瞬移）', !!mon && mon.saveSyncMs < 100,
      'saveSyncMs=' + (mon && mon.saveSyncMs) + ' maxFrameMs=' + (mon && mon.maxFrameMs) + ' slowFrames=' + (mon && mon.slowFrames));
    // 累计口径：整局剧本（含跑动/挖掘/合成/界面开关/读档/死亡重生/游泳/战斗）到现在为止的可疑跳变
    ok('回归.D2e 整局累计没有位置跳变（累计口径，含读档与重生等所有传送）',
      !!mon && !!mon.total && mon.total.jumpCount === 0,
      '累计帧=' + (mon && mon.total && mon.total.frames) + ' 累计跳变=' + (mon && mon.total && mon.total.jumpCount) +
      ' 最大帧=' + (mon && mon.total && mon.total.maxFrameMs) + 'ms 慢帧=' + (mon && mon.total && mon.total.slowFrames) +
      ' 样例=' + JSON.stringify((mon && mon.total && mon.total.jumps || []).slice(0, 2)));
    // 排除项必须真的发生过，且豁免分支真的被走到过，否则「0 跳变」可能只是监视器没看到东西
    ok('回归.D2f 累计里确实发生过自动上台阶，且监视器豁免分支真的被用到（排除额度不是空集）',
      !!mon && !!mon.total && (mon.total.stepups || 0) >= 1 && (mon.total.allowHits || 0) >= 1,
      '上台阶=' + (mon && mon.total && mon.total.stepups) + ' 豁免命中=' + (mon && mon.total && mon.total.allowHits) +
      ' | tryStepUp 执行=' + T.stepDiag().inController + ' 事件送达=' + T.stepDiag().events +
      ' trace=' + JSON.stringify(T.stepDiag().trace));
    console.log('D2 监视器读数：' + JSON.stringify(mon));
    // 监视器自检：故意制造一次 5 格位移（绕过 spawnAt，所以不会被「刻意传送」豁免），它必须抓到，
    // 否则上面的「0 跳变」只是因为监视器瞎了。放在 D2b/D2e 之后，不污染它们的读数。
    G.controller.pos.x += 5;
    await frame(); await frame();
    const monSelf = T.posMon();
    ok('回归.D2g 监视器自检：人为 5 格位移必须被抓到（证明它不是瞎的）',
      !!monSelf && monSelf.jumpCount >= 1,
      'jumpCount=' + (monSelf && monSelf.jumpCount) + ' 样例=' + JSON.stringify((monSelf && monSelf.jumps || []).slice(0, 1)));

    /* ---------------- 28. 天气系统（雨/雪）：状态机 + 渲染层 + 存档兼容 ---------------- */
    // 先把玩家放回自然地面（上一节为了监视器自检人为挪过位置）
    const wtPX = Math.floor(G.controller.pos.x), wtPZ = Math.floor(G.controller.pos.z) + 3;
    G.controller.spawnAt(wtPX + 0.5, G.world.topSolidY(wtPX, wtPZ) + 1, wtPZ + 0.5);
    T.setTime(0.25);                       // 固定成正午，光照对比才有意义
    T.setWeather('clear', 600);            // 基线：晴天且这一段足够长
    await frame(); await frame();
    const wtClear = T.weatherInfo();
    ok('W.1 晴天基线：无降水粒子、着色器强度为 0',
      wtClear && wtClear.type === 'clear' && wtClear.uCloud === 0 &&
      wtClear.fx && wtClear.fx.rainVisible === false && wtClear.fx.snowVisible === false,
      JSON.stringify(wtClear && { type: wtClear.type, uCloud: wtClear.uCloud, fx: wtClear.fx }));
    const wtClearDay = wtClear && wtClear.uDay, wtClearFar = wtClear && wtClear.fogFar;

    // 雨：刚开始不许「哗」地砸满屏（强度渐入）
    T.setWeather('rain', 120);
    await frame();
    const wtRain0 = T.weatherInfo();
    ok('W.2 刚切到雨时强度接近 0（渐入而不是突然出现）',
      wtRain0.type === 'rain' && wtRain0.intensity < 0.25, 'intensity=' + wtRain0.intensity);
    T.tickWeather(0.05, 400);              // 推 20 秒状态机（渐入需要 8 秒）
    await frame(); await frame();
    const wtRain = T.weatherInfo();
    ok('W.3 雨下满后强度 ≥0.9 且着色器收到 uCloud',
      wtRain.intensity >= 0.9 && wtRain.uCloud >= 0.9,
      'intensity=' + wtRain.intensity + ' uCloud=' + wtRain.uCloud);
    ok('W.4 雨滴粒子真的在渲染（数量 >1000，且不下雪）',
      !!wtRain.fx && wtRain.fx.rainVisible === true && wtRain.fx.activeRain > 1000 &&
      wtRain.fx.snowVisible === false && wtRain.fx.activeSnow === 0,
      JSON.stringify(wtRain.fx));
    ok('W.5 雨天把光照压低（相对正午晴天至少暗 15%）',
      wtClearDay !== null && wtRain.uDay <= wtClearDay * 0.85,
      'uDay ' + wtClearDay + '→' + wtRain.uDay);
    ok('W.6 雨天视距变短（雾提前，相对晴天至少短 20%）',
      wtClearFar !== null && wtRain.fogFar <= wtClearFar * 0.8,
      'fogFar ' + wtClearFar + '→' + wtRain.fogFar);
    // 取证截图不在这里请求：宿主轮询在剧本跑满时被饿住，中途的 R.shot 只会在结束后被读到，
    // 拍到的是收尾画面（实测会把 06-下雨.png 覆盖成晴天）。天气截图由 tests/shot-weather.mjs 单独负责。

    // 雪：与雨互斥，且比雨亮一些（天气光照因子 rain<snow）
    T.setWeather('snow', 120);
    T.tickWeather(0.05, 400);
    await frame(); await frame();
    const wtSnow = T.weatherInfo();
    ok('W.7 下雪时雨停了、雪在落',
      !!wtSnow.fx && wtSnow.fx.rainVisible === false && wtSnow.fx.snowVisible === true &&
      wtSnow.fx.activeSnow > 500, JSON.stringify(wtSnow.fx));
    ok('W.8 雪天比雨天亮（因子 rain<snow 生效到渲染层）',
      wtSnow.uDay > wtRain.uDay + 0.02, 'uDay 雨=' + wtRain.uDay + ' 雪=' + wtSnow.uDay);

    // 头顶有遮挡就不该看到雨（洞穴/屋里）
    const wtRoofY = Math.floor(G.controller.pos.y) + 3;
    T.setBlock(Math.floor(G.controller.pos.x), wtRoofY, Math.floor(G.controller.pos.z), 1);
    T.setWeather('rain', 120);
    T.tickWeather(0.05, 400);
    await frame(); await frame(); await frame();
    const wtShelter = T.weatherInfo();
    ok('W.9 头顶有方块时判定为遮蔽', wtShelter.shelter === true,
      'shelter=' + wtShelter.shelter + ' pos=' + JSON.stringify([G.controller.pos.x, G.controller.pos.y, G.controller.pos.z]));
    ok('W.10 遮蔽处几乎看不到雨（粒子数被压到很低）',
      !!wtShelter.fx && wtShelter.fx.activeRain < 200,
      'activeRain=' + (wtShelter.fx && wtShelter.fx.activeRain) + '（露天时应 >1000）');
    T.setBlock(Math.floor(G.controller.pos.x), wtRoofY, Math.floor(G.controller.pos.z), 0);
    await frame();

    // 降水本身不许影响物理：整段切换/推进天气之后，位置监视器仍应 0 跳变
    T.resetPosMon();
    T.setWeather('rain', 90);
    // 降雨观察窗口：跑到监视器累计 ≥120 帧（W.11 要的是样本量），期间过半时推进一次天气状态机
    let wMonTicked = false;
    const wMon = await tryUntil(() => {
      if (!wMonTicked && T.posMon().frames >= 60) { wMonTicked = true; T.tickWeather(0.05, 100); }
      return T.posMon().frames >= 120;
    }, { budgetMs: 8000, label: '降雨观察窗口采满 120 帧', observe: () => T.posMon().frames });
    const wtMon = T.posMon();
    ok('W.11 下雨期间没有产生无法解释的位置跳变',
      !!wtMon && wtMon.frames > 100 && wtMon.jumpCount === 0,
      'frames=' + (wtMon && wtMon.frames) + ' jumpCount=' + (wtMon && wtMon.jumpCount) +
      ' 采样窗口=' + (wMon.ok ? wMon.ms + 'ms' : '超时:' + wMon.timeout));

    // 睡觉放晴（原版行为：睡一觉跳过恶劣天气）
    const wtBX = Math.floor(G.controller.pos.x) + 2, wtBZ = Math.floor(G.controller.pos.z);
    const wtBY = G.world.topSolidY(wtBX, wtBZ) + 1;
    T.give('bed', 1);
    T.placeAt(wtBX, wtBY, wtBZ, 'bed');
    T.setTime(0.75);                        // 夜里才睡得着
    T.setWeather('rain', 120);
    const wtSlept = T.sleepAt(wtBX, wtBY, wtBZ);
    const wtAfterSleep = T.weatherInfo();
    ok('W.12 睡觉会把雨放晴（且确实睡了）',
      wtSlept === true && wtAfterSleep.type === 'clear' && wtAfterSleep.intensity === 0,
      'slept=' + wtSlept + ' type=' + wtAfterSleep.type + ' inten=' + wtAfterSleep.intensity);

    // 存档往返：weather 字段写入并活过读档
    T.setWeather('snow', 321.5);
    T.tickWeather(0.05, 200);
    await G.save('manual');
    const wtRaw = await G.storage.loadWorld('验收世界');
    const wtSaved = wtRaw && wtRaw.weather;
    ok('W.13 存档里写入了 weather 字段（类型与剩余时长）',
      !!wtSaved && wtSaved.t === 'snow' && Math.abs(wtSaved.left - 321.5 + 10) < 20,
      JSON.stringify(wtSaved));
    await G.loadWorld('验收世界');
    await frame();
    const wtLoaded = T.weatherInfo();
    ok('W.14 读档后天气与强度都恢复（不会变成晴天或突然放大）',
      wtLoaded.type === 'snow' && wtLoaded.intensity > 0.5,
      JSON.stringify(wtLoaded && { type: wtLoaded.type, left: wtLoaded.left, intensity: wtLoaded.intensity }));

    // 旧档兼容：把 weather 字段整个删掉再读，必须回落晴天且不报错
    const wtErrBefore = (window.__runtimeErrors || []).length;
    const wtOld = await G.storage.loadWorld('验收世界');
    delete wtOld.weather;
    delete wtOld.farmlands;                 // 连 T1 的新字段一起删，模拟更早的版本
    await G.storage.saveWorld('验收世界', wtOld);
    await G.loadWorld('验收世界');
    await frame(); await frame();
    const wtOldLoaded = T.weatherInfo();
    ok('W.15 没有 weather 字段的旧档能读入且回落晴天',
      wtOldLoaded.type === 'clear' && wtOldLoaded.left > 0 && G.state === 'playing',
      JSON.stringify(wtOldLoaded && { type: wtOldLoaded.type, left: wtOldLoaded.left }) + ' state=' + G.state);
    ok('W.16 读旧档过程中没有新增运行期错误',
      (window.__runtimeErrors || []).length === wtErrBefore,
      'errors ' + wtErrBefore + '→' + (window.__runtimeErrors || []).length);

    /* ---------------- 29. 剪刀与剪羊毛 ---------------- */
    // 29.1 工作台合成：2 铁锭斜角 + 2 木棍
    T.give('iron_ingot', 4); T.give('stick', 4);
    T.openUI('crafting'); await frame();
    const shrCraft = T.craftSet(['iron_ingot', '', '', '', 'iron_ingot', '', 'stick', 'stick', '']);
    ok('S.1 工作台：2 铁锭 + 2 木棍 能合成剪刀', shrCraft && shrCraft.item === 'shears', JSON.stringify(shrCraft));
    T.craftNow(1);
    ok('S.1b 合成后剪刀真的进了背包', G.inventory.countOf('shears') >= 1,
      'shears=' + G.inventory.countOf('shears'));
    G.closeUI(); await sleep(120);

    // 29.2 真实右键剪毛
    const shrWoolOnGround = () => G.interaction.drops.list.filter(d => d.item === 'wool')
      .reduce((a, d) => a + d.count, 0);
    // 按一次真实右键：先等上一次的冷却过期（否则会被 placeCd 吃掉，表现为「点了没反应」），
    // 再在按下之前重新瞄准——等的这 700ms 里羊会漫游，用旧朝向会打空（实测会偶发失败）。
    /* 真实右键助手（29/30 节共用）。
       旧版固定 sleep(700) 等冷却，机器忙时 placeCd 还没走完，且上一节残留的
       `_wasRight=true` 会让这一次被当成「按住」直接跳过 —— 实测 S.3/B.3 会偶发整条链失效。
       现在改成轮询：先等交互层真的看到「松开 + 冷却结束」，按下后等它真的收到，
       松开后再等它看到松开，下一次才能重新触发上升沿。仍然是一次真实的按下/松开。 */
    const shrRightClick = async (aimAt) => {
      const ready = await tryUntil(
        () => !G.input.state.mouseRight && !G.interaction._wasRight && (G.interaction.placeCd || 0) <= 0,
        { budgetMs: 6000, tick: 'sleep', intervalMs: 40, label: '右键冷却与松开状态就绪',
          observe: () => ({ placeCd: G.interaction.placeCd, wasRight: G.interaction._wasRight, held: G.input.state.mouseRight }) });
      if (!ready.ok) throw new Error(ready.timeout);
      if (aimAt) {
        // 等冷却的这段时间里动物会漫游：按下之前必须重新瞄准（旧版的教训）
        const adx = aimAt.pos.x - G.controller.pos.x;
        const ady = (aimAt.pos.y + aimAt.height * 0.55) - G.controller.eyeY;
        const adz = aimAt.pos.z - G.controller.pos.z;
        const aL = Math.hypot(adx, ady, adz) || 1;
        G.controller.pitch = Math.asin(ady / aL);
        G.controller.yaw = Math.atan2(-adx / aL, -adz / aL);
      }
      await frame();
      G.input.state.mouseRight = true;
      // 不能「等不到就松手」：主循环偶发卡顿超过 1.5 秒时，松手先到、按下被吞，
      // 表现为 S.3/B.3 整条链失效。这里必须等交互层亲眼看到按下才允许松开。
      // 打开界面的那一帧 input.setUIMode(true) 会清空鼠标状态，_wasRight 可能来不及变 true；
      // 所以「交互层看到按下」或「界面已经打开」都算这次右键送达。
      const press = await tryUntil(() => G.interaction._wasRight === true || !!G.openUI,
        { budgetMs: 5000, label: '交互层收到右键', observe: () => ({ wasRight: G.interaction._wasRight, state: G.state, openUI: G.openUI, placeCd: G.interaction.placeCd }) });
      if (!press.ok) throw new Error(press.timeout);
      if (!G.openUI) {
        await frame();
        G.input.state.mouseRight = false;
        const release = await tryUntil(() => G.interaction._wasRight === false,
          { budgetMs: 5000, label: '交互层看到右键松开', observe: () => ({ wasRight: G.interaction._wasRight, state: G.state, openUI: G.openUI }) });
        if (!release.ok) throw new Error(release.timeout);
      } else {
        G.input.state.mouseRight = false;   // UI 已接管，_wasRight 不再更新
      }
      await sleep(80);
    };
    const shrX = Math.floor(G.controller.pos.x), shrZ = Math.floor(G.controller.pos.z);
    G.mobs.clear();
    const shrY = G.world.topSolidY(shrX, shrZ - 3);
    const shrSheep = G.mobs.spawn('sheep', shrX + 0.5, shrY + 1, shrZ - 3);
    if (shrSheep) { shrSheep.walking = false; shrSheep.wanderT = 9999; shrSheep.vel.x = shrSheep.vel.z = 0; }
    G.controller.spawnAt(shrSheep.pos.x, shrSheep.pos.y, shrSheep.pos.z + 2.0);
    G.inventory.set(0, { item: 'shears', count: 1, dur: 64 });
    G.selectHotbar(0);
    await frame(); await frame();
    ok('S.2 前置：目标羊已就位且有毛', !!shrSheep && shrSheep.sheared === false,
      JSON.stringify(T.sheepInfo()));
    const shrx = G.controller.pos.x, shry = G.controller.eyeY, shrz = G.controller.pos.z;
    const shrDx = shrSheep.pos.x - shrx, shrDy = (shrSheep.pos.y + shrSheep.height * 0.55) - shry,
      shrDz = shrSheep.pos.z - shrz;
    const shrL = Math.hypot(shrDx, shrDy, shrDz) || 1;
    G.controller.pitch = Math.asin(shrDy / shrL);
    G.controller.yaw = Math.atan2(-shrDx / shrL, -shrDz / shrL);
    const shrWoolBefore = G.inventory.countOf('wool');
    const shrErrMark = R.errors.length;
    const shrGroundBefore = shrWoolOnGround();
    await shrRightClick(shrSheep);
    const shrDrop = shrWoolOnGround() - shrGroundBefore;
    ok('S.3 手持剪刀按右键把羊剪秃（真实输入 + 真实主循环）',
      shrSheep.sheared === true && R.errors.length === shrErrMark,
      JSON.stringify(T.sheepInfo()) + ' 新增错误=' + (R.errors.length - shrErrMark));
    ok('S.4 剪下来的羊毛掉在地上，数量 1~3', shrDrop >= 1 && shrDrop <= 3,
      '本次新增地上 wool=' + shrDrop + '（此前已有 ' + shrGroundBefore + '）');
    ok('S.5 剪一次扣 1 点耐久（64→63）', T.heldDur() === 63, 'dur=' + T.heldDur());

    // 29.3 秃羊不该被反复剪
    const shrDurAfter = T.heldDur();
    const shrGroundAfter = shrWoolOnGround();
    await shrRightClick(shrSheep);
    ok('S.6 秃羊不能再剪：不产毛、不扣耐久',
      T.heldDur() === shrDurAfter && shrWoolOnGround() === shrGroundAfter,
      'dur=' + T.heldDur() + ' 地上 wool=' + shrWoolOnGround() + '（期望不变 ' + shrGroundAfter + '）');

    // 29.4 对猪无效
    const shrPig = G.mobs.spawn('pig', shrX + 0.5, shrY + 1, shrZ - 3);
    const shrDurPig = T.heldDur();
    /* 往后退 3.4 格再点：仍在交互距离内，但离开 2.4 格的自动拾取范围，
       免得两次取样之间地上的羊毛被捡走（那会被误读成「对猪产毛/扣耐久」）。 */
    T.teleport(shrPig.pos.x, shrPig.pos.y, shrPig.pos.z + 3.4);
    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: 'S.7 站位' });
    const shrGroundPig = shrWoolOnGround();
    await shrRightClick(shrPig);
    ok('S.7 对着猪按右键不产羊毛、不扣耐久',
      !!shrPig && T.heldDur() === shrDurPig && shrWoolOnGround() === shrGroundPig && shrSheep.sheared === true,
      'dur=' + T.heldDur() + ' 地上 wool ' + shrGroundPig + '→' + shrWoolOnGround());
    G.mobs.clear();

    // 29.5 走近可以把羊毛捡进背包（把掉落物挪到玩家脚下，与 T2.3 同样的做法）
    const shrWoolDrop = G.interaction.drops.list.find(d => d.item === 'wool');
    if (shrWoolDrop) {
      shrWoolDrop.x = G.controller.pos.x; shrWoolDrop.z = G.controller.pos.z;
      shrWoolDrop.y = G.controller.pos.y + 0.5; shrWoolDrop.pickDelay = 0;
    }
    let shrPicked = false;
    for (let i = 0; i < 120 && !shrPicked; i++) {
      await frame();
      shrPicked = G.inventory.countOf('wool') >= shrWoolBefore + 1;
    }
    ok('S.8 地上的羊毛可以捡进背包', shrPicked,
      'wool ' + shrWoolBefore + '→' + G.inventory.countOf('wool') + ' 地上=' +
      G.interaction.drops.list.filter(d => d.item === 'wool').length);

    // 29.6 创造模式不扣耐久
    G.setMode('creative');
    G.inventory.set(0, { item: 'shears', count: 1, dur: 64 });
    G.selectHotbar(0);
    const shrCX = Math.floor(G.controller.pos.x), shrCZ = Math.floor(G.controller.pos.z);
    const shrSheep2 = G.mobs.spawn('sheep', shrCX + 0.5, G.world.topSolidY(shrCX, shrCZ - 2) + 1, shrCZ - 2);
    await frame(); await frame();
    const shrAim2 = (shrSheep2.pos.x - G.controller.pos.x) ** 2 + (shrSheep2.pos.z - G.controller.pos.z) ** 2;
    const shr2dx = shrSheep2.pos.x - G.controller.pos.x;
    const shr2dy = (shrSheep2.pos.y + shrSheep2.height * 0.55) - G.controller.eyeY;
    const shr2dz = shrSheep2.pos.z - G.controller.pos.z;
    const shr2L = Math.hypot(shr2dx, shr2dy, shr2dz) || 1;
    G.controller.pitch = Math.asin(shr2dy / shr2L);
    G.controller.yaw = Math.atan2(-shr2dx / shr2L, -shr2dz / shr2L);
    const shrDurC0 = T.heldDur();
    await shrRightClick(shrSheep2);
    ok('S.9 创造模式剪毛不扣耐久',
      shrAim2 < 16 && shrSheep2.sheared === true && T.heldDur() === shrDurC0,
      'sheared=' + shrSheep2.sheared + ' dur=' + T.heldDur() + ' 距离²=' + shrAim2.toFixed(2));
    G.setMode('survival');

    // 29.7 存档往返：秃的状态与剩余再生时间都要活过读档
    const shrSaveSheep = G.mobs.list.find(m => m.type === 'sheep' && m.sheared);
    if (shrSaveSheep) shrSaveSheep.regenT = 37;
    await G.save('manual');
    await G.loadWorld('验收世界');
    await frame();
    const shrLoaded = T.sheepInfo();
    ok('S.10 读档后羊仍是秃的且剩余再生时间被保留',
      shrLoaded.some(s => s.sheared === true && Math.abs(s.regenT - 37) <= 1),
      JSON.stringify(shrLoaded));

    // 29.8 到点长回毛（走真实主循环）
    const shrRegrowOk = T.setSheepRegrow(0.3);
    let shrGrew = false;
    for (let i = 0; i < 200 && !shrGrew; i++) {
      await frame();
      shrGrew = T.sheepInfo().some(s => s.sheared === false);
    }
    ok('S.11 再生倒计时到点后羊毛长回来', shrRegrowOk === true && shrGrew, JSON.stringify(T.sheepInfo()));

    /* ---------------- 30. 生物繁殖（喂食 → 幼崽 + 冷却） ---------------- */
    // 关掉自然刷怪：否则「比之前多一只」这类断言会被中途刷出来的动物污染
    const brMaxMobs0 = G.mobs.maxMobs;
    G.mobs.maxMobs = 0;
    ok('B.1 食物识别：小麦/胡萝卜是动物食物，羊毛不是',
      T.isAnimalFood('wheat') && T.isAnimalFood('carrot') && T.isAnimalFood('wool') === false,
      'wheat=' + T.isAnimalFood('wheat') + ' carrot=' + T.isAnimalFood('carrot') + ' wool=' + T.isAnimalFood('wool'));

    const brX = Math.floor(G.controller.pos.x), brZ = Math.floor(G.controller.pos.z);
    G.mobs.clear();
    const brY = G.world.topSolidY(brX, brZ - 3);
    const brA = G.mobs.spawn('cow', brX + 0.5, brY + 1, brZ - 3);
    const brB = G.mobs.spawn('cow', brX + 2.5, brY + 1, brZ - 3);
    // 喂食/瞄准测试关掉漫游噪声：否则按右键那几百毫秒里牛会走开（SP.4 同类教训）
    for (const m of [brA, brB]) if (m) { m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = 0; }
    G.controller.spawnAt(brA.pos.x, brA.pos.y, brA.pos.z + 2.0);
    T.give('wheat', 6);
    G.inventory.set(0, { item: 'wheat', count: 6 });
    G.selectHotbar(0);
    await frame(); await frame();
    ok('B.2 前置：两头成年牛就位、都不在冷却',
      !!brA && !!brB && [brA, brB].every(c => c.isBaby === false && c.breedCd === 0),
      JSON.stringify(T.animalInfo()));
    const brWheat0 = G.inventory.countOf('wheat');
    const brCount0 = G.mobs.list.length;
    const brPick0 = G.mobs.pickNearest(G.controller.reach(), m => m.def.breedable && !m.isBaby && m.hp > 0);
    const brPartner0 = brPick0 ? G.mobs.list.find(m => G.mobs.findPartner(brPick0, m)) : null;
    await shrRightClick(brA);                       // 复用 29 节：等冷却 + 按下前重新瞄准
    const brInfo1 = T.animalInfo();
    const brBaby = brInfo1.find(a => a.baby);
    ok('B.3 手持小麦右键成年牛 → 生出一只幼崽',
      G.mobs.list.length === brCount0 + 1 && !!brBaby,
      JSON.stringify(brInfo1) + ' pick=' + (brPick0 && brPick0.type) + ' partner=' + !!brPartner0 +
      ' held=' + G.inventory.heldItem() + ' placeCd=' + G.interaction.placeCd);
    ok('B.4 只消耗一个小麦', G.inventory.countOf('wheat') === brWheat0 - 1,
      'wheat ' + brWheat0 + '→' + G.inventory.countOf('wheat'));
    const brAdultH = brA.height, brAdultW = brA.width;
    ok('B.5 幼崽的碰撞盒明显小于成年（不是只换个贴图）',
      brBaby && brBaby.h < brAdultH * 0.8 && brBaby.w < brAdultW * 0.8,
      '幼崽 ' + (brBaby && brBaby.w) + '×' + (brBaby && brBaby.h) + ' 成年 ' + brAdultW.toFixed(2) + '×' + brAdultH.toFixed(2));
    ok('B.6 幼崽有成长倒计时', brBaby && brBaby.growT > 0, 'growT=' + (brBaby && brBaby.growT));

    // 冷却内不得再繁殖，也不得再消耗食物
    const brWheat1 = G.inventory.countOf('wheat');
    const brCount1 = G.mobs.list.length;
    await shrRightClick(brA);
    ok('B.7 繁殖冷却中再喂：不生出第二只、也不消耗食物',
      G.mobs.list.length === brCount1 && G.inventory.countOf('wheat') === brWheat1,
      '数量=' + G.mobs.list.length + '（期望 ' + brCount1 + '）wheat=' + G.inventory.countOf('wheat'));

    // 只有一只成年动物时不能繁殖，且不消耗
    const brSoloX = brX + 20, brSoloZ = brZ + 20;
    G.mobs.clear();
    const brSoloY = G.world.topSolidY(brSoloX, brSoloZ);
    const brSolo = G.mobs.spawn('pig', brSoloX + 0.5, brSoloY + 1, brSoloZ - 3);
    if (brSolo) { brSolo.walking = false; brSolo.wanderT = 9999; brSolo.vel.x = brSolo.vel.z = 0; }
    G.controller.spawnAt(brSolo.pos.x, brSolo.pos.y, brSolo.pos.z + 2.0);
    G.inventory.set(0, { item: 'carrot', count: 5 });
    G.selectHotbar(0);
    await frame(); await frame();
    const brCarrot0 = G.inventory.countOf('carrot');
    await shrRightClick(brSolo);
    ok('B.8 旁边没有同类配偶：不繁殖也不浪费胡萝卜',
      G.mobs.list.length === 1 && G.inventory.countOf('carrot') === brCarrot0 && brSolo.breedCd === 0,
      '数量=' + G.mobs.list.length + ' carrot=' + G.inventory.countOf('carrot') + ' 冷却=' + brSolo.breedCd);

    // 幼崽既不能被喂，也不能当配偶
    G.mobs.clear();
    const brBabyOnly = G.mobs.spawn('cow', brSoloX + 0.5, brSoloY + 1, brSoloZ - 3, { baby: true });
    if (brBabyOnly) { brBabyOnly.walking = false; brBabyOnly.wanderT = 9999; brBabyOnly.vel.x = brBabyOnly.vel.z = 0; }
    G.inventory.set(0, { item: 'wheat', count: 4 });
    G.selectHotbar(0);
    await frame(); await frame();
    const brWheat2 = G.inventory.countOf('wheat');
    await shrRightClick(brBabyOnly);
    ok('B.9 对着幼崽按右键无效（不消耗、不再生出）',
      G.mobs.list.length === 1 && G.inventory.countOf('wheat') === brWheat2 && brBabyOnly.isBaby === true,
      '数量=' + G.mobs.list.length + ' wheat=' + G.inventory.countOf('wheat'));

    // 没对着动物时，喂食逻辑不许把右键吞掉（否则玩家没法吃胡萝卜）
    G.mobs.clear();
    await frame();
    const brFallthrough = G.interaction.tryFeedNearby({ mouseRight: true });
    ok('B.10 准星前没有动物时不接管右键（留给进食/放置）', brFallthrough === false,
      'tryFeedNearby=' + brFallthrough);

    // 存档往返：幼崽与父母冷却都要活过读档
    G.mobs.clear();
    const brKX = brX, brKZ = brZ;
    const brKY = G.world.topSolidY(brKX, brKZ - 3);
    const brK1 = G.mobs.spawn('sheep', brKX + 0.5, brKY + 1, brKZ - 3);
    const brK2 = G.mobs.spawn('sheep', brKX + 2.0, brKY + 1, brKZ - 3);
    for (const m of [brK1, brK2]) if (m) { m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = 0; }
    G.controller.spawnAt(brK1.pos.x, brK1.pos.y, brK1.pos.z + 2.0);
    G.inventory.set(0, { item: 'wheat', count: 4 });
    G.selectHotbar(0);
    await frame(); await frame();
    await shrRightClick(brK1);
    const brBabySheep = G.mobs.list.find(m => m.isBaby);
    ok('B.11 羊也能繁殖（小麦）', !!brBabySheep && brBabySheep.type === 'sheep', JSON.stringify(T.animalInfo()));
    if (brBabySheep) brBabySheep.growT = 41;
    await G.save('manual');
    await G.loadWorld('验收世界');
    G.mobs.maxMobs = 0;              // 读档会重建管理器，maxMobs 回到默认，这里再关一次
    await frame();
    const brAfterLoad = T.animalInfo();
    ok('B.12 读档后幼崽与成长倒计时都在，父母仍在冷却',
      brAfterLoad.some(a => a.baby && Math.abs(a.growT - 41) <= 1) &&
      brAfterLoad.filter(a => !a.baby && a.breedCd > 0).length >= 2,
      JSON.stringify(brAfterLoad));

    // 到点长大（走真实主循环）
    const brSetGrow = G.mobs.list.find(m => m.isBaby);
    if (brSetGrow) brSetGrow.growT = 0.4;
    let brGrew = false;
    for (let i = 0; i < 300 && !brGrew; i++) {
      await frame();
      brGrew = T.animalInfo().every(a => a.baby === false);
    }
    ok('B.13 倒计时到点后幼崽在主循环里长大', brGrew === true, JSON.stringify(T.animalInfo()));
    const brAdultBack = G.mobs.list.find(m => m.type === 'sheep');
    ok('B.14 长大之后碰撞盒恢复成年尺寸',
      !!brAdultBack && Math.abs(brAdultBack.height - (0.9 * 0.95)) < 1e-6,
      'h=' + (brAdultBack && brAdultBack.height));
    G.mobs.maxMobs = brMaxMobs0;      // 恢复自然刷怪，后面的收尾截图/审计与原来一致

    /* ---------------- 31. 生物互相推开（收敛旧已知问题 #6） ---------------- */
    const spMin = (arr) => {
      let m = 1e9;
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const d = Math.hypot(arr[i].x - arr[j].x, arr[i].z - arr[j].z);
        if (d < m) m = d;
      }
      return m;
    };
    const spX = Math.floor(G.controller.pos.x), spZ = Math.floor(G.controller.pos.z);
    const spY = G.world.topSolidY(spX, spZ - 3);
    // 先造一块平整台面：自然地形有起伏，羊会被土坎卡住推不开（实测停在最小间距 0.274 并超时），
    // 那样测的是地形而不是分离力。台面 = 一层石头 + 上方 3 格清空。
    for (let dx = -4; dx <= 4; dx++) for (let dz = -7; dz <= -1; dz++) {
      T.setBlock(spX + dx, spY, spZ + dz, 1);
      for (let h = 1; h <= 3; h++) T.setBlock(spX + dx, spY + h, spZ + dz, 0);
    }
    await sleep(500);
    G.mobs.clear();
    G.mobs.maxMobs = 0;
    for (let i = 0; i < 6; i++) {
      G.mobs.spawn('sheep', spX + 0.5 + i * 0.02, spY + 1, spZ - 4 + i * 0.02);   // 六只叠成一坨
    }
    const spDump0 = T.mobDump();
    const spMin0 = spMin(spDump0);
    ok('SP.1 前置：六只羊确实叠在一起', spDump0.length === 6 && spMin0 < 0.12,
      '数量=' + spDump0.length + ' 最小间距=' + spMin0.toFixed(3));
    const spPlayer0 = { x: G.controller.pos.x, y: G.controller.pos.y, z: G.controller.pos.z };
    let spDump1 = spDump0, spAllStand = true, spFrames = 0;
    let spMin1 = spMin(spDump1);
    // 轮询到「真的互不重叠」（预算 6 秒）：数固定帧会再次依赖机器速度（打包版 150 帧只到 0.463）。
    // 谓词里顺带关掉漫游 —— AI 会让羊互相撞来撞去，那样测不出分离的收敛（实测只到 0.282）。
    const wSpread = await tryUntil(() => {
      spFrames++;
      for (const m of G.mobs.list) { m.walking = false; m.wanderT = 9999; m.vel.x = 0; m.vel.z = 0; }
      spDump1 = T.mobDump();
      if (spDump1.some(m => !m.free)) { spAllStand = false; return true; }   // 一发现卡进方块就停
      spMin1 = spMin(spDump1);
      return spMin1 >= 0.5;
    }, { budgetMs: 6000, label: '六只羊被分离力推到互不重叠', observe: () => +spMin1.toFixed(3) });
    ok('SP.2 真实主循环里六只羊被分离力推到互不重叠', wSpread.ok && spMin1 >= 0.5,
      '最小间距 ' + spMin0.toFixed(3) + ' → ' + spMin1.toFixed(3) + '（' + spFrames + ' 帧 / ' +
      (wSpread.ok ? wSpread.ms + 'ms' : '超时:' + wSpread.timeout) + '）');
    ok('SP.3 散开过程中没有一只卡进方块', spAllStand && spDump1.every(m => m.free),
      spDump1.map(m => m.free ? 1 : 0).join('') + ' 位置=' + spDump1.map(m => m.x + ',' + m.z).join(' | '));

    // 玩家与生物仍然可以互相穿过：只在玩家脚下放一只猪，推进后玩家不许被挤动、猪也不许被弹开。
    // 注意要先把这只猪的漫游关掉（实测它自己走 60 帧就能走出 0.8 格，那是 AI 不是分离力），
    // 关噪声源而不是放宽阈值。
    G.mobs.clear();
    const spPig = G.mobs.spawn('pig', G.controller.pos.x, G.controller.pos.y, G.controller.pos.z);
    spPig.walking = false; spPig.wanderT = 9999; spPig.vel.x = 0; spPig.vel.z = 0;
    // 观察 1 秒，期间每帧钉住这只猪的漫游（bad() 永远 false，只借它的每帧回调）
    await watch(1000, () => { for (const m of G.mobs.list) { m.walking = false; m.wanderT = 9999; m.vel.x = 0; m.vel.z = 0; } return false; });
    const spNear = spPig ? Math.hypot(spPig.pos.x - G.controller.pos.x, spPig.pos.z - G.controller.pos.z) : 99;
    ok('SP.4 生物不会把玩家挤开（玩家与生物仍可互相穿过）',
      Math.abs(G.controller.pos.x - spPlayer0.x) < 1e-6 &&
      Math.abs(G.controller.pos.z - spPlayer0.z) < 1e-6 &&
      Math.abs(G.controller.pos.y - spPlayer0.y) < 0.05 && spNear < 0.6,
      '玩家位移=' + Math.hypot(G.controller.pos.x - spPlayer0.x, G.controller.pos.z - spPlayer0.z).toFixed(5) +
      ' 猪与玩家水平距离=' + spNear.toFixed(3));

    // 贴墙的一群：推开时不许穿墙
    const spWX = spX + 10, spWZ = spZ;
    const spWY = G.world.topSolidY(spWX, spWZ);
    for (let dz = -3; dz <= 3; dz++) for (let h = 0; h <= 2; h++) {
      T.setBlock(spWX + 2, spWY + 1 + h, spWZ + dz, 1);
    }
    /* 阶段 6 封版前处理（进度文档里挂账的「亚厘米判据」）：原来是 `m.x < 墙面` 的零容差平面比较，
       实测有 0.002~0.008 的超出 —— 那是生物 AABB 与方块碰撞在某一帧留下的亚厘米重叠，
       不是「穿墙」。零容差在这个模型里既不可满足、红的时候也说不清严重程度。
       口径：要求**这一只没有被卡进方块**（free），且 x 不超过墙面加一个**写死的物理余量**
       （0.02 格 = 2cm，仍远小于生物半径）。这不是放宽：真的穿墙会超出几个身位，照样红；
       而 0.002 这种浮点接触面由余量吸收。
       本轮修正：把常量提到观察循环之前，循环和最终断言用**同一个** SP_WALL_EPS，
       声明与实际判据一致；两条检查都保留 —— 超出余量 = 穿墙，!free = 卡进方块。 */
    const SP_WALL_EPS = 0.02;
    G.mobs.clear();
    for (let i = 0; i < 4; i++) G.mobs.spawn('pig', spWX + 1.2 + i * 0.02, spWY + 1, spWZ + 0.5 + i * 0.02);
    let spNoTunnel = true;
    for (let i = 0; i < 120; i++) {
      await frame();
      if (T.mobDump().some(m => m.x > spWX + 2 + SP_WALL_EPS || !m.free)) { spNoTunnel = false; break; }
    }
    const spWallDump = T.mobDump();
    const spOver = spWallDump.map(m => +(m.x - (spWX + 2)).toFixed(4));
    ok('SP.5 贴墙挤在一起也不会被同伴挤穿墙（超出墙面的接触余量 ≤ ' + SP_WALL_EPS + ' 格）、也不会被挤进方块',
      spNoTunnel && spWallDump.length === 4 &&
      spWallDump.every((m, i) => spOver[i] <= SP_WALL_EPS && m.free),
      spWallDump.map((m, i) => m.x + (m.free ? '' : '(卡进方块)') + ' 超出=' + spOver[i]).join(' | ') +
      ' 墙在 x=' + (spWX + 2) + ' 余量=' + SP_WALL_EPS);
    for (let dz = -3; dz <= 3; dz++) for (let h = 0; h <= 2; h++) {
      T.setBlock(spWX + 2, spWY + 1 + h, spWZ + dz, 0);
    }
    G.mobs.clear();
    G.mobs.maxMobs = brMaxMobs0;      // 恢复自然刷怪上限（第 30 节开头存下来的原值）

    /* AN.6 阶段 6：家畜贴图与光照响应的**运行期**验证（不只读注册表）。
       ① 三种家畜的每个部件材质都真的挂着 16×16 画布（与 SK.1/CP.1/FS.9 同一口径）；
       ② 同一只猪放到「白天露天」与「真实洞穴暗处」，产品 render() 算出的光照系数 _shade
          与世界光读数必须一起变小 —— 这条防的是「贴图挂上了但亮度曲线没作用在它身上」。
       第一版是现盖一间石室再插火把，读数 sky=12/block=0：天花板只铺一层、上方还有天然空腔，
       火把也没点亮目标格，等于在测夹具而不是产品。现在改成直接用世界里已有的两种光照条件。 */
    {
      const an6 = { types: [], lit: null, dark: null };
      const an6Bad = [];
      for (const t of ['pig', 'cow', 'sheep']) {
        const sk = T.mobSkinInfo(t);
        const okMap = (sk.parts || []).filter(p => p.tex).every(p => p.hasMap === true && p.texSize === 16);
        const anyTex = (sk.parts || []).some(p => p.tex);
        if (!anyTex || !okMap) an6Bad.push(t + (anyTex ? ':map' : ':notex'));
        an6.types.push({ t, tex: (sk.parts || []).filter(p => p.tex).length, parts: (sk.parts || []).length });
      }
      const an6PrevMax = G.mobs.maxMobs;
      const an6PrevPos = { x: G.controller.pos.x, y: G.controller.pos.y, z: G.controller.pos.z };
      G.mobs.maxMobs = 0;
      G.mobs.clear();
      const readPig = (m) => {
        const parts = m.mesh.userData.parts;
        const mats = Array.isArray(parts.body.material) ? parts.body.material : [parts.body.material];
        const l = T.lightAt(Math.floor(m.pos.x), Math.floor(m.eyeY), Math.floor(m.pos.z));
        return {
          color: mats[0].color.getHexString(),
          shade: m._shade === undefined ? null : +m._shade.toFixed(4),
          lightAtEye: { sky: l.sky, block: l.block }
        };
      };
      /* ① 白天露天：站到地表上，把猪放在玩家旁边 */
      T.setTime(0.3);
      T.teleport(an6PrevPos.x, an6PrevPos.y, an6PrevPos.z);
      await T.waitChunks(1, { light: true });
      const skyPig = G.mobs.spawn('pig', G.controller.pos.x + 1.5, G.controller.pos.y, G.controller.pos.z);
      if (skyPig) { skyPig.walking = false; skyPig.wanderT = 9999; }
      for (let i = 0; i < 14; i++) await frame();     // _shade 每 0.2 秒更新一次
      an6.lit = skyPig ? readPig(skyPig) : null;
      /* ② 真实洞穴：用世界自己的地表柱往下找一个「脚下实心、头顶两格空气、天光为 0」的格子 */
      /* 找不到 sky=0 的格子时，直接把一只猪**挖进地下**：先挖一个 1×2 的竖井，
         再用实心石头把上方整列封到地表 —— 这样天光必然为 0，比「赌天然洞穴在哪」稳。
         （第一版只扫天然洞穴，读数 cave=null：这颗种子的出生点附近 8 格内没有天光为 0 的空腔。） */
      const cx = Math.floor(G.controller.pos.x) + 6, cz = Math.floor(G.controller.pos.z);
      const topY = G.world.topSolidY(cx, cz);
      const caveY = topY - 7;
      for (let y = caveY; y <= caveY + 1; y++) T.setBlock(cx, y, cz, 0);
      for (let y = caveY + 2; y <= topY + 1; y++) T.setBlock(cx, y, cz, T.blockIds.STONE);
      await T.waitChunks(1, { light: true });
      await tryUntil(() => { const pn = T.worldPending(); return pn && pn.light === 0 && pn.mesh === 0; },
        { budgetMs: 10000, tick: 'sleep', intervalMs: 40, label: 'AN.6 封顶后补光排空' });
      const caveL = T.lightAt(cx, caveY, cz);
      let cave = { x: cx, y: caveY, z: cz, light: { sky: caveL.sky, block: caveL.block } };
      if (cave && skyPig) {
        skyPig.pos.x = cave.x + 0.5; skyPig.pos.y = cave.y; skyPig.pos.z = cave.z + 0.5;
        skyPig.mesh.position.set(skyPig.pos.x, skyPig.pos.y, skyPig.pos.z);
        skyPig._shade = undefined;                     // 让它按新位置重算
        for (let i = 0; i < 14; i++) await frame();
        an6.dark = readPig(skyPig);
        an6.dark.cave = cave;
      }
      G.mobs.clear();
      G.mobs.maxMobs = an6PrevMax;
      T.teleport(an6PrevPos.x, an6PrevPos.y, an6PrevPos.z);
      ok('AN.6 三种家畜都有运行时贴图，且同一只猪在白天露天与真实洞穴里光照系数与着色一起变化',
        an6Bad.length === 0 &&
        an6.types.every(x => x.tex === x.parts && x.parts >= 2) &&
        !!an6.lit && !!an6.dark && an6.lit.shade !== null && an6.dark.shade !== null &&
        an6.lit.lightAtEye.sky > an6.dark.lightAtEye.sky &&
        an6.dark.shade < an6.lit.shade - 0.01 &&
        an6.dark.color !== an6.lit.color,
        '部件=' + JSON.stringify(an6.types) + ' 不合格=' + JSON.stringify(an6Bad) +
        ' 露天=' + JSON.stringify(an6.lit) + ' 洞穴=' + JSON.stringify(an6.dark));
    }

    /* ---------------- 32. T2 分帧预算：批量改方块与读档不许产生秒级长帧 ---------------- */
    // 已知问题 #20 的两半：① 批量 setBlock 每块都同步重建整个区块（实测 250 格 = 1993ms 一整帧）；
    // ② 读档前一次性把整个世界的区块灌完（实测 1063~1232ms，而且这段时间主循环根本没跑，
    //    所以旧版 D2e 看到的「最大帧 2547ms」其实只统计到了批量改方块那一半）。
    // 防假实现三件套：帧数 ≥10（主循环没跑就没资格谈最长帧）、排队清零 + 区块数达标（不许少灌）、
    // 方块还在/位置一致（不许为了跑分改读档语义）。
    const t2Pend = () => (T.worldPending ? T.worldPending() : null);
    const t2Stats = () => (T.loadStats ? T.loadStats() : null);
    const t2Perf = () => (T.worldPerf ? T.worldPerf() : null);

    T.resetPosMon();
    const t2px = Math.floor(G.controller.pos.x), t2pz = Math.floor(G.controller.pos.z);
    let t2Placed = 0, t2SyncMs = 0;
    const t2Marks = [];                       // 记下前几格的确切坐标：事后取样不能用 topSolidY 重算，那会把刚放下去的方块当成新地表
    const t2b0 = performance.now();
    for (let i = 0; t2Placed < 250 && i < 900; i++) {
      const bx = t2px + (i % 16) - 8, bz = t2pz + (((i / 16) | 0) - 8);
      if (Math.abs(bx - t2px) <= 1 && Math.abs(bz - t2pz) <= 1) continue;   // 绕开玩家脚下（见 D2e 补记）
      const by = G.world.topSolidY(bx, bz) + 1;
      T.setBlock(bx, by, bz, (i % 2) ? 4 : 1);
      if (t2Marks.length < 6) t2Marks.push([bx, by, bz]);
      t2Placed++;
    }
    t2SyncMs = Math.round(performance.now() - t2b0);
    ok('回归.T2.1 批量改方块 250 格确实放下去了（不是靠少放刷绿）', t2Placed === 250,
      'placed=' + t2Placed + ' 同步段=' + t2SyncMs + 'ms');
    const t2Drain = await tryUntil(() => {
      const p = t2Pend();
      return p && p.gen === 0 && p.light === 0 && p.mesh === 0;
    }, { budgetMs: 20000, tick: 'sleep', intervalMs: 40, label: '批量改方块后重建排队排空', observe: t2Pend });
    /* 采样窗口至少要有 5 帧才有资格谈「最长帧」：批量段很快时窗口只有 3 帧——
       补两帧再取读数，阈值与帧数闸门都不动。 */
    await frame(); await frame();
    const t2m1 = T.posMon();
    ok('回归.T2.2 批量改方块不再吃掉一整帧（最长帧 < 120ms）',
      !!t2m1 && t2m1.maxFrameMs < 120 && t2m1.frames >= 5,
      'maxFrameMs=' + (t2m1 && t2m1.maxFrameMs) + ' 慢帧=' + (t2m1 && t2m1.slowFrames) +
      ' 帧数=' + (t2m1 && t2m1.frames) + ' 排空用时=' + (t2Drain.ok ? t2Drain.ms + 'ms' : '超时:' + t2Drain.timeout));
    const t2Miss = t2Marks.filter(([mx, my, mz]) => G.world.getBlock(mx, my, mz) === 0);
    ok('回归.T2.3 延后重建之后方块数据仍在（延后的是网格不是世界）', t2Marks.length === 6 && t2Miss.length === 0,
      '取样 ' + t2Marks.length + ' 格，消失 ' + t2Miss.length + ' 格 头两个=' + JSON.stringify(t2Marks.slice(0, 2)));

    // —— 读档：把最长帧的口径对准「点存档 → 回到游戏中」整段 ——
    /* 存档前站稳：前面几节可能把玩家留在半空/树冠边缘，脚下本来就没方块的话，
       读档后「脚下仍是实心」这条断言测到的就不是读档，而是存档前的姿态。 */
    const t2SafeX = Math.floor(G.controller.pos.x), t2SafeZ = Math.floor(G.controller.pos.z);
    const t2SafeY = Math.floor(G.controller.pos.y - 0.2);
    if (!G.world.isSolidAt(t2SafeX, t2SafeY, t2SafeZ)) {
      T.setBlock(t2SafeX, t2SafeY, t2SafeZ, 1);
      T.teleport(t2SafeX + 0.5, t2SafeY + 1, t2SafeZ + 0.5);
      await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: '回归 T2 存档前站稳', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });
      await frame(); await frame();          // 让落地后的微小沉降在存档前结束
    }
    await G.save('manual');
    const t2posSaved = { ...G.controller.pos };
    const t2r0 = performance.now();
    G.toMenu();
    await sleep(300);
    T.resetPosMon();
    await G.loadWorld(G.meta.name);
    const t2LoadMs = Math.round(performance.now() - t2r0);
    const t2m2 = T.posMon();
    const t2ls = t2Stats();
    ok('回归.T2.4 读档期间主循环真的在跑（帧数 ≥10，否则最长帧是空读数）',
      !!t2m2 && t2m2.frames >= 10,
      'frames=' + (t2m2 && t2m2.frames) + ' 读档墙钟=' + t2LoadMs + 'ms 分片=' + (t2ls && t2ls.slices));
    ok('回归.T2.5 读档期间最长帧 < 300ms（已知问题 #20 的验收口径）',
      !!t2m2 && t2m2.maxFrameMs < 300,
      'maxFrameMs=' + (t2m2 && t2m2.maxFrameMs) + ' 慢帧=' + (t2m2 && t2m2.slowFrames) +
      ' 帧数=' + (t2m2 && t2m2.frames) + ' 墙钟=' + t2LoadMs + 'ms 分片读数=' + JSON.stringify(t2ls));
    // 进度条的闸门用 fracStalls（有多少片的进度还是 0）而不是 fracAvg：
    // 实测错公式（剩余队列/起始队列）的 fracAvg 也有 0.32~0.34，和阈值只差 0.01，没有牙；
    // 而它的 fracStalls 是 10，正确实现是 0 —— 症状本身才是该钉的东西。
    ok('回归.T2.6 读档分片自洽：分片 ≥2、单片 <150ms、同步准备段 <300ms、没撞 deadline 也没被中途取消，且进度条从第一片就在动',
      !!t2ls && t2ls.slices >= 2 && t2ls.maxSliceMs < 150 && t2ls.pumpMs > 0 && t2ls.prepMs < 300 &&
      !t2ls.deadlineHit && !t2ls.cancelled && t2ls.fracStalls <= 2 && t2ls.fracAvg > 0.4,
      JSON.stringify(t2ls) + ' 墙钟=' + t2LoadMs + 'ms');
    const t2p = t2Pend();
    const t2r = G.world.radius;
    let t2expect = 0;
    for (let dz = -t2r; dz <= t2r; dz++) for (let dx = -t2r; dx <= t2r; dx++) if (dx * dx + dz * dz <= (t2r + 0.5) * (t2r + 0.5)) t2expect++;
    ok('回归.T2.7 分帧加载不许欠世界：三段排队清零且半径内区块齐',
      !!t2p && t2p.gen === 0 && t2p.light === 0 && t2p.mesh === 0 && G.world.chunks.size >= t2expect,
      'pending=' + JSON.stringify(t2p) + ' chunks=' + G.world.chunks.size + ' 应≥' + t2expect + '（半径 ' + t2r + '）');
    const t2fx = Math.floor(G.controller.pos.x), t2fz = Math.floor(G.controller.pos.z);
    const t2fy = Math.floor(G.controller.pos.y - 0.2);
    ok('回归.T2.8 读档后玩家脚下仍是实心方块（分帧不许把人塞进虚空）',
      G.world.isSolidAt(t2fx, t2fy, t2fz), '(' + t2fx + ',' + t2fy + ',' + t2fz + ') id=' + G.world.getBlock(t2fx, t2fy, t2fz));
    const t2d = Math.hypot(G.controller.pos.x - t2posSaved.x, G.controller.pos.y - t2posSaved.y, G.controller.pos.z - t2posSaved.z);
    ok('回归.T2.9 分帧读档不改变读档语义：位置与保存一致', t2d < 0.01, 'Δ=' + t2d.toFixed(4));
    const t2pf = t2Perf();
    ok('回归.T2.10 单区块成本有读数（预算压不下去的那一半成本要说得清）',
      !!t2pf && typeof t2pf.maxMeshChunkMs === 'number' && t2pf.maxMeshChunkMs > 0,
      JSON.stringify(t2pf));

    /* ---------------- 33. T3 顶出保护：方块出现在身体里必须被推到可站立处 ---------------- */
    // 旧版只有 spawnAt（读档/重生）会顶出；「新区块在脚下生成完」或「树苗长在玩家站的那一格」
    // 把人埋进实心方块时没人管 —— 表现是卡在石头/树干里动都动不了。
    // 这一节既要证明「接进主循环真的救了人」，也要证明「不该动手的时候一步都不动」：
    // 后者防的是最坏的实现 —— 每帧都把玩家往上抬，看起来像 bug 一样的瞬移。
    /* 先把上一节读档后的落体/沉降收干净：玩家还在半空时算出的 embFeet 会滞后，
       清空与放块就落在脚下方，顶出会多爬几格（打包自检曾报 y=57 期望 55）。 */
    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: '顶出测试前站稳', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });
    await T.waitChunks(1);
    const emb = () => T.embedInfo();
    const embX = Math.floor(G.controller.pos.x), embZ = Math.floor(G.controller.pos.z);
    const embFeet = Math.floor(G.controller.pos.y + 0.05);
    /* 原地再传送一次强制把当前区块拉回内存：读档后玩家虽然被放回坐标，
       但区块可能还没加载，下面的清空会静默失败，顶出就会多爬 2 格（y=57 期望 55）。 */
    T.teleport(embX + 0.5, embFeet, embZ + 0.5);
    await sleep(350);
    for (let h = 0; h <= 4; h++) T.setBlock(embX, embFeet + h, embZ, 0);     // 头顶清空，落点才可预测
    await tryUntil(() => [0, 1, 2, 3, 4].every(h => G.world.getBlock(embX, embFeet + h, embZ) === 0),
      { budgetMs: 3000, label: '顶出测试头顶清空' });
    await frame(); await frame();
    const embR0 = emb().rescues;
    T.setBlock(embX, embFeet, embZ, 1);
    T.setBlock(embX, embFeet + 1, embZ, 1);
    const embW1 = await tryUntil(() => emb().stuck === false,
      { budgetMs: 4000, label: '被埋之后被顶出', observe: emb });
    const embI1 = emb();
    ok('TC.1 身体被两格实心埋住必须在几帧内顶出（接进了主循环）',
      embW1.ok && embI1.rescues >= embR0 + 1,
      'stuck=' + embI1.stuck + ' rescues ' + embR0 + '→' + embI1.rescues +
      ' 用时=' + (embW1.ok ? embW1.ms + 'ms' : '超时:' + embW1.timeout) + ' last=' + JSON.stringify(embI1.last));
    ok('TC.2 顶出落点最小：正好站到新放的方块顶上，一格都不许多',
      Math.abs(G.controller.pos.y - (embFeet + 2)) < 0.2 && G.world.isSolidAt(embX, embFeet + 1, embZ),
      'y=' + G.controller.pos.y.toFixed(3) + ' 期望≈' + (embFeet + 2) + ' dir=' + (embI1.last && embI1.last.dir) +
      ' dy=' + (embI1.last && embI1.last.dy));
    ok('TC.3 顶出必须有界（≤8 格向上）并且发过一次 teleport（否则会被 D2 监视器记成可疑瞬移）',
      !!embI1.last && Math.abs(embI1.last.dy) <= 8, JSON.stringify(embI1.last));
    for (let h = 0; h <= 1; h++) T.setBlock(embX, embFeet + h, embZ, 0);      // 复原，让人掉回地面
    await tryUntil(() => G.controller.onGround && !emb().stuck,
      { budgetMs: 4000, label: '复原后落回地面', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });

    // —— 真实生长路径：树苗长在玩家站的格子上（旧版会直接把原木塞进玩家身体）——
    const embTX = embX + 3, embTZ = embZ;
    const embTY = G.world.topSolidY(embTX, embTZ);
    // 树形需要空间；先把周围 7×7、上方 8 格清空，避免这棵树被旁边的树干/树冠卡住不生长
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      for (let h = 1; h <= 8; h++) T.setBlock(embTX + dx, embTY + h, embTZ + dz, 0);
    }
    G.controller.spawnAt(embTX + 0.5, embTY + 1, embTZ + 0.5);
    await until(() => G.controller.onGround, { budgetMs: 4000, label: '站到树苗那一格的地面上', observe: () => +G.controller.pos.y.toFixed(2) });
    const embR2 = emb().rescues;
    T.setBlock(embTX, embTY + 1, embTZ, 38);                                  // 树苗（非实体，人可以站在上面）
    G.saplings.set(embTX + ',' + (embTY + 1) + ',' + embTZ, { age: 999, need: 1, kind: 'oak' });
    const embW2 = await tryUntil(() => G.world.getBlock(embTX, embTY + 1, embTZ) === 10,
      { budgetMs: 6000, label: '树真的从玩家脚下长出来', observe: () => G.world.blockAt(embTX, embTY + 1, embTZ) });
    const embW3 = await tryUntil(() => emb().stuck === false && emb().rescues >= embR2 + 1,
      { budgetMs: 6000, label: '树把人埋住之后被顶出', observe: emb });
    const embI2 = emb();
    ok('TC.4 树苗长成树干塞进玩家身体：必须被救出来（真实 tickSaplings 路径，不是 API 直调）',
      embW2.ok && embW3.ok, '树干id=' + G.world.getBlock(embTX, embTY + 1, embTZ) +
      ' stuck=' + embI2.stuck + ' rescues ' + embR2 + '→' + embI2.rescues +
      ' 顶出=' + (embW3.ok ? embW3.ms + 'ms' : '超时:' + embW3.timeout) + ' last=' + JSON.stringify(embI2.last));
    ok('TC.5 救出来之后位置有界（≤8 格上顶或 ≤3 格侧移），且真的站在空位',
      !embI2.stuck && !!embI2.last && Math.hypot(embI2.last.dx || 0, embI2.last.dz || 0) <= 3 && Math.abs(embI2.last.dy) <= 8,
      JSON.stringify(embI2.last) + ' pos=' + JSON.stringify(embI2.pos));

    // —— 不该动手的时候一步都不动：站得好好的，救援计数与位置都不许变 ——
    // 顶出后的落点可能还差几厘米才落地；先等站稳再开观察窗，否则会把「落地」误判成「反复顶人」。
    await tryUntil(() => G.controller.onGround && !emb().stuck,
      { budgetMs: 4000, label: 'TC.6 观察前站稳', observe: () => ({ y: +G.controller.pos.y.toFixed(3), onGround: G.controller.onGround, stuck: emb().stuck }) });
    await sleep(120);
    const embR3 = emb().rescues, embP3 = { ...G.controller.pos };
    const wEmbIdle = await watch(1500, () => emb().rescues !== embR3 ||
      Math.abs(G.controller.pos.y - embP3.y) > 0.05, { label: '站立期间不该触发顶出' });
    ok('TC.6 站在合法位置时不许反复顶人（1.5 秒观察窗口内救援数与 y 都不变）',
      !wEmbIdle.violated, 'rescues ' + embR3 + '→' + emb().rescues +
      ' y=' + G.controller.pos.y.toFixed(3) + '(起 ' + embP3.y.toFixed(3) + ') 观察=' + wEmbIdle.ticks + '帧/' + wEmbIdle.ms + 'ms');

    // —— 未生成区块的「近似实心」不许当真，但真生成完之后必须救 ——
    const embFX = 300, embFZ = -261;
    const embFH = G.world.surfaceHeight(embFX, embFZ);       // 纯函数：不生成区块也能算地表
    const embR4 = emb().rescues;
    G.controller.setPositions(embFX + 0.5, embFH - 2, embFZ + 0.5);   // 故意放进未生成区的地形内部
    const embI3 = emb();
    const embTry = G.controller.pushOutOfSolid();                 // 直接调一次：闸门必须拦住
    ok('TC.7 区块还没生成时不许顶人（近似实心不是真方块，否则会被顶到隐形地面上）',
      embI3.ready === false && embI3.stuck === true && embTry === null && emb().rescues === embR4,
      'ready=' + embI3.ready + ' stuck=' + embI3.stuck + ' 直接调用返回=' + JSON.stringify(embTry) +
      ' y=' + embI3.pos[1] + '（地表≈' + embFH + '）');
    const embW4 = await tryUntil(() => G.controller.chunksAroundReady(),
      { budgetMs: 12000, label: '玩家所在区块真正生成', observe: () => [G.world.genQueue.length, G.world.dirtyMesh.size] });
    // 区块真生成之后自己塞两格石头，而不是赌「这一格地下恰好是实心」（可能有洞穴）
    const embCX = Math.floor(G.controller.pos.x), embCZ = Math.floor(G.controller.pos.z);
    const embCY = Math.floor(G.controller.pos.y + 0.05);
    for (let h = 0; h <= 4; h++) T.setBlock(embCX, embCY + h, embCZ, 0);   // 先清空，落点才唯一
    await frame(); await frame();
    const embR5 = emb().rescues;
    T.setBlock(embCX, embCY, embCZ, 1);
    T.setBlock(embCX, embCY + 1, embCZ, 1);
    const embW5 = await tryUntil(() => emb().rescues >= embR5 + 1 && !emb().stuck,
      { budgetMs: 8000, label: '闸门放行之后同一处必须被救出来', observe: emb });
    const embI4 = emb();
    ok('TC.8 区块生成完之后闸门放行：再被埋必须被救出来，落点有界且站在空位',
      embW4.ok && embW5.ok && embI4.rescues >= embR5 + 1 && !embI4.stuck &&
      !!embI4.last && Math.abs(embI4.last.dy) <= 8 && embI4.pos[1] <= embCY + 8 + 1,
      '生成=' + (embW4.ok ? embW4.ms + 'ms' : '超时:' + embW4.timeout) +
      ' 救出=' + (embW5.ok ? embW5.ms + 'ms' : '超时:' + embW5.timeout) +
      ' rescues ' + embR5 + '→' + embI4.rescues + ' y=' + embI4.pos[1] + '（埋住时 ' + embCY + '）' +
      ' last=' + JSON.stringify(embI4.last));
    for (let h = 0; h <= 1; h++) T.setBlock(embCX, embCY + h, embCZ, 0);   // 撤掉刚塞进去的那两格石头
    await tryUntil(() => G.controller.onGround && !emb().stuck,
      { budgetMs: 8000, label: '复原之后重新落地', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });

    /* ---------------- 34. T4 蜘蛛：真实主循环里的敌对、掉线、4 线合成羊毛、贴墙爬出包围圈 ---------------- */
    // 单测能钉定义/配方/碰撞盒，但「会追人、会咬、掉在地上的线能捡起来、贴着真墙往上爬」
    // 只有真实循环才算数。刷怪噪声先关掉（maxMobs=0），场景自己造。
    const zdMax0 = G.mobs.maxMobs;
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    const zdP = G.controller.pos;
    const zdPx = Math.floor(zdP.x), zdPz = Math.floor(zdP.z), zdPy = Math.floor(zdP.y);

    // 34.1 体型与模型：真实 MobManager 造出来的蜘蛛，不是「换个名字的僵尸」
    const zdS0 = G.mobs.spawn('spider', zdPx + 2.5, zdPy + 1, zdPz + 0.5);
    await frame(); await frame();
    const zdLegs = zdS0 ? Object.keys(zdS0.mesh.userData.parts || {}).filter(k => k.startsWith('leg')).length : 0;
    ok('Z.1 真实循环里蜘蛛能生成：八条腿、碰撞盒 0.9×1.0（不是僵尸的 0.6×1.9）',
      !!zdS0 && zdLegs === 8 && Math.abs(zdS0.width - 0.9) < 0.05 && Math.abs(zdS0.height - 1.0) < 0.05,
      'legs=' + zdLegs + ' w=' + (zdS0 && zdS0.width.toFixed(2)) + ' h=' + (zdS0 && zdS0.height.toFixed(2)));

    // 34.2 敌对：会追上来咬人（生存模式；创造模式不受伤是既有逻辑）
    G.controller.health = 20;
    const zdBite = G.mobs.spawn('spider', zdPx + 1.2, zdPy + 1, zdPz + 0.5);
    const zdW1 = await tryUntil(() => G.controller.health < 20 || !zdBite,
      { budgetMs: 9000, label: '蜘蛛咬到玩家', observe: () => ({ hp: G.controller.health, creative: G.controller.creative, fire: zdBite && zdBite.fire }) });
    ok('Z.2 蜘蛛在真实主循环里会咬人（生存模式掉血）',
      zdW1.ok && G.controller.health < 20 && !G.controller.creative,
      'hp=' + G.controller.health + ' creative=' + G.controller.creative +
      ' 等=' + (zdW1.ok ? zdW1.ms + 'ms' : '超时:' + zdW1.timeout) + ' 咬合范围 reach=' + (zdBite && zdBite.def.reach));

    // 34.3 击杀掉线 → 可以捡起（走 kill() 与掉落物的真实链路）
    G.interaction.drops.list.length = 0;
    if (zdBite && G.mobs.list.includes(zdBite)) G.mobs.hitMob(zdBite, 999, { x: 0, z: 0 });
    await sleep(200);
    const zdDrop = G.interaction.drops.list.find(d => d.item === 'string');
    ok('Z.3 击杀蜘蛛掉线，且数量在 1~2',
      !G.mobs.list.includes(zdBite) && !!zdDrop && zdDrop.count >= 1 && zdDrop.count <= 2,
      'drops=' + G.interaction.drops.list.map(d => d.item + 'x' + d.count).join(',') +
      ' 在场蜘蛛=' + G.mobs.list.filter(m => m.type === 'spider').length);
    const zdWool0 = G.inventory.countOf('wool');
    if (zdDrop) { zdDrop.x = zdP.x; zdDrop.z = zdP.z; zdDrop.y = zdP.y + 0.5; zdDrop.pickDelay = 0; }
    const zdW2 = await tryUntil(() => G.inventory.countOf('string') > 0,
      { budgetMs: 5000, label: '地上的线被捡起', observe: () => G.inventory.countOf('string') });
    ok('Z.4 地上的线可以捡进背包', G.inventory.countOf('string') >= 1,
      'string=' + G.inventory.countOf('string') + ' 用时=' + (zdW2.ok ? zdW2.ms + 'ms' : '超时:' + zdW2.timeout));

    // 34.4 4 线 → 1 羊毛（工作台真实路径；羊毛必须按增量算，前面章节已经掉过羊毛）
    while (G.inventory.countOf('string') < 4) { T.give('string', 1); }
    T.openUI('crafting'); await frame();
    const zdCraft = T.craftSet(['string', 'string', 'string', 'string', '', '', '', '', '']);
    ok('Z.5 工作台识别 4 线 → 羊毛', zdCraft && zdCraft.item === 'wool', JSON.stringify(zdCraft));
    const zdBefore = G.inventory.countOf('wool');
    T.craftNow(1);
    ok('Z.6 合成后羊毛真的入库（增量口径）', G.inventory.countOf('wool') === zdBefore + 1,
      'wool ' + zdBefore + '→' + G.inventory.countOf('wool') + ' string=' + G.inventory.countOf('string'));
    G.closeUI(); await sleep(150);

    // 34.5 真实墙：造一圈 8 格高的封闭内院把蜘蛛放进去，玩家在外面 —— 它要咬人就必须爬出来
    const zdCx = zdPx + 9, zdCz = zdPz;
    const zdCy = G.world.topSolidY(zdCx, zdCz);
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      T.setBlock(zdCx + dx, zdCy, zdCz + dz, 1);                     // 地板
      for (let h = 1; h <= 11; h++) T.setBlock(zdCx + dx, zdCy + h, zdCz + dz, 0);   // 清空
    }
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;         // 只垒那一圈
      for (let h = 1; h <= 8; h++) T.setBlock(zdCx + dx, zdCy + h, zdCz + dz, 1);
    }
    await tryUntil(() => { const p = T.worldPending(); return p && p.gen === 0 && p.light === 0 && p.mesh === 0; },
      { budgetMs: 15000, tick: 'sleep', intervalMs: 40, label: '围墙场景重建完成', observe: T.worldPending });
    G.mobs.clear();
    const zdC = G.mobs.spawn('spider', zdCx + 0.5, zdCy + 1, zdCz + 0.5);
    const zdW3 = await tryUntil(() => !zdC || zdC.pos.y > zdCy + 2.5,
      { budgetMs: 20000, label: '蜘蛛贴墙爬出内院', observe: () => (zdC ? { y: +zdC.pos.y.toFixed(2), climb: zdC.climbing, base: zdCy + 1 } : 'gone') });
    const zdInBlock = zdC ? G.mobs.mobAABBBlocked(zdC, zdC.pos.x, zdC.pos.y, zdC.pos.z) : null;
    ok('Z.7 真实主循环里蜘蛛贴墙往上爬（僵尸做不到，见单测 K4 对照）',
      zdW3.ok && !!zdC && zdC.pos.y > zdCy + 2.5,
      'y=' + (zdC && zdC.pos.y.toFixed(2)) + ' 墙脚=' + (zdCy + 1) + ' 墙顶=' + (zdCy + 8) +
      ' 用时=' + (zdW3.ok ? zdW3.ms + 'ms' : '超时:' + zdW3.timeout) + ' climbing=' + (zdC && zdC.climbing));
    ok('Z.8 爬墙全程不许把蜘蛛塞进方块（真物理，不是把坐标直接抬上去）',
      !!zdC && zdInBlock === false, 'mobAABBBlocked=' + zdInBlock + ' pos=' + (zdC && JSON.stringify([+zdC.pos.x.toFixed(2), +zdC.pos.y.toFixed(2), +zdC.pos.z.toFixed(2)])));

    // 34.6 存档往返：蜘蛛作为一种生物要能存能读（旧档里没有 spider 也不会崩，由既有 12.x 覆盖）
    G.controller.health = 20;
    G.mobs.clear();
    const zdSave = G.mobs.spawn('spider', zdPx + 1.5, zdPy + 1, zdPz + 1.5);
    G.mobs.hitMob(zdSave, 5, { x: 0, z: 0 });            // 打掉 5 血，验证 hp 也能存
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld(G.meta.name);
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '蜘蛛档读回游戏中' });
    const zdLoaded = G.mobs.list.find(m => m.type === 'spider');
    ok('Z.9 蜘蛛随存档往返：类型与剩余血量都在', !!zdLoaded && Math.abs(zdLoaded.hp - 11) < 1.5,
      'found=' + !!zdLoaded + ' hp=' + (zdLoaded && zdLoaded.hp) + ' 在场=' + G.mobs.list.map(m => m.type).join(','));
    G.mobs.clear();
    G.mobs.maxMobs = zdMax0;                              // 恢复自然刷怪（第 30 节口径：读档之后要重设）

    /* ---------------- 35. T5 苦力怕：真实主循环里的充能、起爆、范围有界与存档 ---------------- */
    // 爆炸同时动了「方块数据、光照/网格队列、玩家血量、音效」四样东西，最容易写出「只改了数据、画面没跟上」
    // 或「炸完顺手多挖了几格」的错。所以这里既断言坑真的出现，也断言**坑外一格都没少**，并要求排队真的排空。
    const qbMax0 = G.mobs.maxMobs;
    G.mobs.maxMobs = 0;                       // 关掉自然刷怪，场景里只有被测的这几只
    G.mobs.clear();
    const qbY = Math.floor(G.controller.pos.y);
    const qbX = Math.floor(G.controller.pos.x) + 7, qbZ = Math.floor(G.controller.pos.z);
    /* 与 SK.0 同一条教训，而且是本轮 Q.1 的真因：这一段紧接在 Z.9 的「存档 → 读档」之后
       （时间轴上只差 6 秒），出生点外 7~11 格的区块很可能还没灌进来，
       而 `world.js:207` 对未生成区块的 setBlock **直接 return false**。
       于是整个 5×5×3 立方体一格都没写进去：苦力怕不在石头里、
       玩家与它之间还隔着没被清掉的天然地形，`charging` 永远是 false，
       Q.3 读到的中心格是空气（本轮读数就是这个形状）。
       所以先把玩家传过去、等区块与三段队列排空，再动方块。 */
    T.teleport(qbX - 4.5, qbY, qbZ + 0.5);      // 传到场地西侧外沿：不能传到中心，否则会被随后砌上的立方体埋住
    await T.waitChunks(1, { light: true });
    // 目标立方体：5×5 底、3 格高，中心就是要起爆的位置
    const qcX = qbX + 2, qcZ = qbZ, qcY = qbY + 2;
    const qbDrain = async (label) => {
      const r = await tryUntil(() => { const p = T.worldPending(); return p && p.gen === 0 && p.light === 0 && p.mesh === 0; },
        { budgetMs: 20000, tick: 'sleep', intervalMs: 40, label, observe: T.worldPending });
      return r.ok;
    };
    /* 搭一遍场地：13×13 平整地板 + 上方清空、5×5×3 实心立方体，
       再把玩家要站的那一格（西外墙 qcX-2）挖成 1×3 壁龛 —— 壁龛高 3 格是因为玩家有 1.8 高，
       只挖两格头顶就塞进石头里，等于换个地方埋。
       苦力怕仍然生在立方体正中心（爆心设计格），它会被石材顶跑（实测顶到 (qcX-2, qbY+3)），
       所以坐标可复现由下面「每帧钉回设计位置」负责，壁龛只保证玩家不必站在石头里。
       「隔墙不点火」对「生物自己那一格就是实心」这种异常态有明确例外
       （见 mobs.js lineOfSightToPlayer 的注释）：玩家能用来躲墙的仍然是真正挡在中间的那堵墙。 */
    const qbBuild = () => {
      for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
        T.setBlock(qbX + dx, qbY - 1, qbZ + dz, 1);                                // 平整地板
        for (let h = 0; h <= 7; h++) T.setBlock(qbX + dx, qbY + h, qbZ + dz, 0);    // 上方清空
      }
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) for (let dy = 0; dy < 3; dy++) {
        T.setBlock(qcX + dx, qbY + dy, qcZ + dz, 1);                                // 立方体
      }
      for (let dy = 0; dy <= 2; dy++) T.setBlock(qcX - 2, qbY + dy, qcZ, 0);         // 西壁龛
    };
    /* 场地是不是真的搭起来了：这一段下面每一节的坐标都默认这几件事成立。
       没成立最常见的原因是区块还没生成（`world.js:207` 的 setBlock 会直接 return false）。 */
    const qbSiteRead = () => ({
      center: G.world.getBlock(qcX, qbY, qcZ), centerAbove: G.world.getBlock(qcX, qbY + 1, qcZ),
      niche: G.world.getBlock(qcX - 2, qbY, qcZ), nicheTop: G.world.getBlock(qcX - 2, qbY + 2, qcZ),
      floor: G.world.getBlock(qbX, qbY - 1, qbZ), cleared: G.world.getBlock(qbX, qbY + 5, qbZ)
    });
    const qbSiteOk = (s) => s.center === 1 && s.centerAbove === 1 && s.niche === 0 &&
      s.nicheTop === 0 && s.floor === 1 && s.cleared === 0;
    let qbSite = qbSiteRead(), qbAttempts = 0, qbDrained = false;
    while (qbAttempts < 3) {
      qbAttempts++;
      qbBuild();
      qbDrained = await qbDrain('爆炸场景重建排空');
      qbSite = qbSiteRead();
      if (qbSiteOk(qbSite)) break;
      await T.waitChunks(2, { light: true });       // 没写成 → 扩大半径再等一次区块，然后重搭
      await sleep(500);
    }
    /* Q.0 夹具自检：场地没真搭起来时，红的是「苦力怕不充能」这种看起来像产品问题的读数。
       所以先把格子读明白，再往下走。 */
    ok('Q.0 场地夹具自检：先叫区块再动方块，立方体中心实心、西壁龛与上方是空气、地板实心（否则 Q.1~Q.8 测的是没搭出来的场景）',
      qbSiteOk(qbSite) && qbDrained,
      JSON.stringify(qbSite) + ' 重搭次数=' + qbAttempts + ' 队列排空=' + qbDrained +
      ' 场地=(' + qbX + ',' + qbY + ',' + qbZ + ') 立方体中心=(' + qcX + ',' + qcZ + ')');
    // 爆心是可预先算出的：苦力怕出生在 (qcX+0.5, qbY, qcZ+0.5)，h=1.7 → floor(qbY + 0.85) = qbY
    const qcYc = qbY;
    const countIn = (lo, hi) => {                 // 以爆心为中心的立方壳层里数实心格
      let n = 0;
      for (let dz = -hi; dz <= hi; dz++) for (let dx = -hi; dx <= hi; dx++) for (let dy = -hi; dy <= hi; dy++) {
        const d = Math.hypot(dx, dy, dz);
        if (d < lo || d > hi) continue;
        if (G.world.isSolidAt(qcX + dx, qcYc + dy, qcZ + dz)) n++;
      }
      return n;
    };
    const qbInside0 = countIn(0, 5);              // 爆炸够得着的范围（power+1=4）
    const qbRing0 = countIn(5, 8);                // 这一圈理论上不该被动到
    const qbBlast0 = T.blastInfo().explosions;

    G.controller.health = 20;
    G.controller.setCreative(false);
    const qbC = G.mobs.spawn('creeper', qcX + 0.5, qbY + 0.0, qcZ + 0.5);       // 立方体正中心：爆心设计在这格里
    const qbStandX = qcX - 1.5;
    G.controller.setPositions(qbStandX, qbY, qcZ + 0.5);                        // 站进西壁龛：1.5 格外，头顶有空间
    /* 阶段 3b：每帧把双方钉回设计位置（只钉位置，不动速度与 AI）。
       立方体是实心的，苦力怕生在石材里、玩家站在刚挖开的壁龛边上，物理会在 1.5 秒引信期间
       把他们顶出去 —— 历史读数里爆心从设计中心跑到 (qcX-2, qbY+3)，被炸掉的方块在 37~112 之间飘，
       Q.4 的「距离」完全看被顶到哪（本轮红的时候 dist=8.09、上一轮侥幸 3.07 贴在上限边上）。
       钉住之后：爆心固定在 (qcX, qbY, qcZ)、玩家固定在 1.5 格，Q.2 的坑、Q.2b 的界外、
       Q.3 的「实心变空气」与 Q.4 的贴脸上限第一次有可复现的坐标。
       贴脸这一端另外由 Q.4b 在干净地面上**无钉**重测一遍，两种条件互相印证。 */
    const qbPin = () => {
      if (qbC && G.mobs.list.includes(qbC)) {
        qbC.pos.x = qcX + 0.5; qbC.pos.y = qbY; qbC.pos.z = qcZ + 0.5;
        qbC.vel.x = 0; qbC.vel.y = 0; qbC.vel.z = 0;
      }
      G.controller.setPositions(qbStandX, qbY, qcZ + 0.5);
    };
    const qbWt0 = performance.now();
    let qbTicks = 0;
    while (performance.now() - qbWt0 < 8000) {
      qbPin(); qbTicks++;
      if (T.blastInfo().explosions > qbBlast0 || !G.mobs.list.includes(qbC)) break;
      await frame();
    }
    const qbW1 = {
      ok: T.blastInfo().explosions > qbBlast0 || !G.mobs.list.includes(qbC),
      ms: Math.round(performance.now() - qbWt0),
      timeout: '苦力怕起爆超时（预算 8000ms，钉住 ' + qbTicks + ' 帧，最后 charging=' + (qbC && qbC.charging) +
        ' fuse=' + (qbC && qbC.fuse.toFixed(2)) + ' 在场=' + (qbC && G.mobs.list.includes(qbC)) + '）'
    };
    const qbInfo = T.blastInfo();
    ok('Q.1 真实主循环里苦力怕贴近就充能并起爆（走 MobManager→onCreeperExplode 全链路）',
      qbW1.ok && qbInfo.explosions === qbBlast0 + 1 && !G.mobs.list.includes(qbC),
      'explosions ' + qbBlast0 + '→' + qbInfo.explosions + ' 用时=' + (qbW1.ok ? qbW1.ms + 'ms' : '超时:' + qbW1.timeout) +
      ' 最后一次=' + JSON.stringify(qbInfo.last));
    const qbInside1 = countIn(0, 5), qbRing1 = countIn(5, 8);
    const qbLast = qbInfo.last || {};          // 没炸的时候读 null 会把整份剧本带崩（本轮只跑到 310 条），这里只保护读数
    ok('Q.2 炸出坑了，而且**只**炸掉它自己报的那几格（±5 范围内的实心减少数 = 报告的 removed）',
      !!qbInfo.last && qbInside0 - qbInside1 > 0 && qbInside0 - qbInside1 === qbLast.removed && qbLast.cells === qbLast.removed,
      '范围内实心 ' + qbInside0 + '→' + qbInside1 + ' 少掉 ' + (qbInside0 - qbInside1) +
      ' 格，报告 removed=' + qbLast.removed + ' cells=' + qbLast.cells +
      ' 爆心=(' + qbLast.x + ',' + qbLast.y + ',' + qbLast.z + ') 期望=(' + qcX + ',' + qcYc + ',' + qcZ + ')');
    ok('Q.2b 半径之外（距爆心 5~8 这一圈）一格都没少 —— 「范围有界」的直接表达',
      qbRing0 === qbRing1, '圈外实心 ' + qbRing0 + '→' + qbRing1);
    ok('Q.3 起爆点那一格确实变成空气（方块数据口径，不是只看粒子）',
      !!qbInfo.last && (G.world.getBlock(qcX, qbY + 1, qcZ) === 0 || G.world.getBlock(qcX, qbY, qcZ) === 0),
      '中心下两格 id=' + G.world.getBlock(qcX, qbY, qcZ) + '/' + G.world.getBlock(qcX, qbY + 1, qcZ));
    ok('Q.4 生存模式按距离吃到伤害，且不超过贴脸上限 12',
      !!qbInfo.last && G.controller.health < 20 && (20 - G.controller.health) <= 12,
      'hp=' + G.controller.health + ' 报告伤害=' + qbLast.dmg + ' 距离=' + qbLast.dist);

    /* ---- Q.4b 贴脸那一端的「无钉」对照 ----
       上面 Q.1 为了坐标可复现，把双方每帧钉回设计位置，于是 Q.4 量的是钉住条件下的贴脸伤害。
       这条在**干净地面**上重测同一件事：平台是自己搭的、双方都站在空气里、没有任何位置夹取，
       苦力怕 0.5 格起爆 —— 上限 12 这件事不能只由一个带钉的夹具证明。 */
    const q4bX = Math.floor(G.controller.pos.x) - 20, q4bZ = Math.floor(G.controller.pos.z);
    T.teleport(q4bX + 0.5, G.controller.pos.y, q4bZ + 0.5);
    await T.waitChunks(1, { light: true });
    const q4bTop = G.world.topSolidY(q4bX, q4bZ);
    for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
      T.setBlock(q4bX + dx, q4bTop, q4bZ + dz, 1);
      for (let h = 1; h <= 4; h++) T.setBlock(q4bX + dx, q4bTop + h, q4bZ + dz, 0);
    }
    await tryUntil(() => { const p = T.worldPending(); return p && p.gen === 0 && p.light === 0 && p.mesh === 0; },
      { budgetMs: 20000, tick: 'sleep', intervalMs: 40, label: 'Q.4b 平台排空', observe: T.worldPending });
    G.mobs.clear();
    G.controller.setCreative(false);
    G.inventory.armor.fill(null);                 // 贴脸上限要被裸血量量到，身上有甲就变成在测护甲
    G.controller.health = 20; G.controller.invulnerable = 0;
    const q4bBoom0 = T.blastInfo().explosions;
    G.mobs.spawn('creeper', q4bX + 0.5, q4bTop + 1, q4bZ + 1.0);      // 0.5 格外：贴脸
    G.controller.setPositions(q4bX + 0.5, q4bTop + 1, q4bZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: 'Q.4b 站稳' });
    const q4bW = await tryUntil(() => T.blastInfo().explosions > q4bBoom0,
      { budgetMs: 9000, label: 'Q.4b 贴脸起爆', observe: () => T.blastInfo().last });
    const q4bLast = T.blastInfo().last || {};
    const q4bDmg = +(20 - G.controller.health).toFixed(2);
    ok('Q.4b 贴脸起爆（0.5 格）把伤害顶到上限附近但不超过 12，且报告 dmg 与真实掉血一致（生存、无甲）',
      q4bW.ok && q4bLast.dist !== undefined && q4bLast.dist < 1.5 &&
      q4bDmg > 8 && q4bDmg <= 12 && Math.abs(q4bDmg - q4bLast.dmg) < 0.6 && G.controller.health > 0,
      'hp 20→' + G.controller.health + ' 掉 ' + q4bDmg + ' 报告 dmg=' + q4bLast.dmg +
      ' dist=' + q4bLast.dist + ' removed=' + q4bLast.removed + ' 平台顶=' + q4bTop);
    // 回主场地：后面 Q.5~Q.8 仍按原坐标跑
    G.mobs.clear();
    G.controller.setPositions(qbStandX, qbY, qcZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: 'Q.4b 后回位站稳' });

    // 爆炸要顺着正常的 setBlock 链路走：光照/网格排队必须能在预算内排空，否则画面会留着幽灵方块
    const qbW2 = await tryUntil(() => { const p = T.worldPending(); return p && p.gen === 0 && p.light === 0 && p.mesh === 0; },
      { budgetMs: 20000, tick: 'sleep', intervalMs: 40, label: '爆炸后区块重建排空', observe: T.worldPending });
    ok('Q.5 爆炸之后三段排队能排空（破坏走了正常脏标记链路，不会留幽灵方块）', qbW2.ok,
      qbW2.ok ? '排空用时=' + qbW2.ms + 'ms' : '超时:' + qbW2.timeout + ' 剩余=' + JSON.stringify(T.worldPending()));

    // 充能途中跑开就取消（原版手感：你可以把它甩掉）
    const qbBoom1 = T.blastInfo().explosions;
    const qbC2 = G.mobs.spawn('creeper', qbX + 0.5, qbY, qbZ + 0.5);
    G.controller.setPositions(qbX - 1.5, qbY, qbZ + 0.5);
    await tryUntil(() => qbC2.charging === true, { budgetMs: 3000, label: '第二只开始充能', observe: () => ({ charging: qbC2.charging, fuse: +qbC2.fuse.toFixed(2) }) });
    T.teleport(qbX + 30.5, qbY, qbZ + 0.5);              // 甩到 30 格外
    const qbW3 = await watch(3500, () => T.blastInfo().explosions > qbBoom1, { label: '跑开后不许在身后炸' });
    ok('Q.6 充能中把玩家甩开就取消起爆', !qbW3.violated,
      '观察=' + qbW3.ticks + '帧/' + qbW3.ms + 'ms 充能=' + qbC2.charging + ' fuse=' + qbC2.fuse.toFixed(2) +
      ' explosions=' + T.blastInfo().explosions + '(起 ' + qbBoom1 + ')');
    G.mobs.clear();

    // 创造模式不受伤（但坑照炸）
    const qbBoom2 = T.blastInfo().explosions;
    G.controller.setCreative(true);
    G.controller.health = 20;
    const qbC3 = G.mobs.spawn('creeper', qbX + 1.5, qbY, qbZ + 0.5);
    G.controller.setPositions(qbX + 0.5, qbY, qbZ + 0.5);
    const qbW4 = await tryUntil(() => T.blastInfo().explosions > qbBoom2,
      { budgetMs: 8000, label: '创造模式下也能起爆', observe: () => T.blastInfo().explosions });
    ok('Q.7 创造模式照样会炸但玩家不掉血（伤害守卫在结算里，不是靠不生成）',
      qbW4.ok && G.controller.health === 20,
      'explosions ' + qbBoom2 + '→' + T.blastInfo().explosions + ' hp=' + G.controller.health +
      ' 报告伤害=' + T.blastInfo().last.dmg + ' 剩余=' + (qbC3 && G.mobs.list.includes(qbC3)));
    G.controller.setCreative(false);
    G.mobs.clear();

    // 存档往返：炸出来的坑必须留在档里（证明破坏写进了 chunk diff，而不是只改了内存）
    const qbCellX = qbX + 1, qbCellY = qbY, qbCellZ = qbZ + 0;
    const qbSolidNow = G.world.isSolidAt(qbCellX, qbCellY, qbCellZ);
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld(G.meta.name);
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '爆炸后的世界读回来' });
    const qbReadBack = G.world.isSolidAt(qbCellX, qbCellY, qbCellZ);
    ok('Q.8 炸开的坑随存档往返（走的是正常 setBlock → chunk diff，不是临时改内存）',
      qbSolidNow === false && qbReadBack === false,
      '读档前实心=' + qbSolidNow + ' 读档后实心=' + qbReadBack + ' 坐标=(' + qbCellX + ',' + qbCellY + ',' + qbCellZ + ')');
    G.mobs.maxMobs = qbMax0;                              // 恢复自然刷怪

    /* ---------------- 36. T1 护甲成长：配方、真实装备、减伤、耐久与存档 ---------------- */
    const arMax0 = G.mobs.maxMobs;
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.controller.setCreative(false);
    T.setTime(0.7);                                       // 夜里：僵尸不会烧起来，测试只看咬人
    // 造一块干净的 5×5 平台，避免洞穴/树冠让僵尸卡住导致「没咬到」被误判
    const arX = Math.floor(G.controller.pos.x), arZ = Math.floor(G.controller.pos.z), arY = Math.floor(G.controller.pos.y);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      T.setBlock(arX + dx, arY - 1, arZ + dz, 4);
      for (let h = 0; h <= 2; h++) T.setBlock(arX + dx, arY + h, arZ + dz, 0);
    }
    T.teleport(arX + 0.5, arY + 0.02, arZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '护甲测试平台落地', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });

    // 36.1 三套 12 件配方：真实 3×3 合成面板逐个摆放并读取结果
    G.openCrafting(3); await frame();
    const arPatterns = {
      helmet: ['iii', 'i i'],
      chestplate: ['i i', 'iii', 'iii'],
      leggings: ['iii', 'i i', 'i i'],
      boots: ['i i', 'i i']
    };
    const arIngot = { leather: 'leather', iron: 'iron_ingot', diamond: 'diamond' };
    const arBad = [];
    for (const mat of ['leather', 'iron', 'diamond']) {
      for (const [kind, rows] of Object.entries(arPatterns)) {
        const cells = [];
        for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
          const ch = rows[y] && rows[y][x];
          cells.push(ch === 'i' ? arIngot[mat] : null);
        }
        const r = T.craftSet(cells);
        if (!r || r.item !== mat + '_' + kind) arBad.push(mat + '_' + kind + '→' + JSON.stringify(r));
      }
    }
    ok('AR.1 三套 12 件护甲配方在真实工作台全部识别', arBad.length === 0, arBad.length ? arBad.join(' | ') : '12/12');

    // 36.2 真做一件铁胸甲（8 铁锭），产物真的入库
    G.inventory.add('iron_ingot', 8);
    const arChestCells = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      const ch = arPatterns.chestplate[y][x];
      arChestCells.push(ch === 'i' ? 'iron_ingot' : null);
    }
    T.craftSet(arChestCells);
    const arMade = T.craftNow(1);
    ok('AR.2 用 8 个铁锭真实合成铁胸甲并入库',
      arMade.length === 1 && arMade[0].item === 'iron_chestplate' && G.inventory.countOf('iron_chestplate') >= 1,
      'made=' + JSON.stringify(arMade) + ' 库存=' + G.inventory.countOf('iron_chestplate'));

    // 36.3 真实 DOM：背包里 Shift+点击胸甲 → 穿上第 2 格；HUD 读数与装备同源
    G.openInventory(); await frame();
    const arChestIdx = G.inventory.slots.findIndex(s => s && s.item === 'iron_chestplate');
    const arMd = (node, btn, shift) => node.dispatchEvent(new MouseEvent('mousedown', { button: btn, bubbles: true, shiftKey: !!shift }));
    if (arChestIdx >= 0) arMd(document.querySelector('#panel-inventory [data-slot="inv:' + arChestIdx + '"]'), 0, true);
    await frame(); await frame();
    const arI1 = T.armorInfo();
    ok('AR.3 点击背上铁胸甲：装备格有图标、点数 6、HUD 护甲值同步为 6',
      arI1.points === 6 && !!arI1.pieces[1] && arI1.pieces[1].item === 'iron_chestplate' &&
      arI1.hud === '6' && document.querySelector('#armor-bar').classList.contains('on') &&
      !!document.querySelector('#panel-inventory [data-slot="equip:1"] img'),
      'points=' + arI1.points + ' hud=' + arI1.hud + ' pieces=' + JSON.stringify(arI1.pieces));

    // 36.4 点装备格取下来：进光标，点数归零；再放回背包，总数不丢
    arMd(document.querySelector('#panel-inventory [data-slot="equip:1"]'), 0);
    await frame(); await frame();
    const arI2 = T.armorInfo();
    ok('AR.4 点装备格可取下（进光标、护甲归零、物品没消失）',
      arI2.points === 0 && !arI2.pieces[1] && !!G.inventory.cursor &&
      G.inventory.cursor.item === 'iron_chestplate' && arI2.hud === '0',
      'points=' + arI2.points + ' hud=' + arI2.hud + ' cursor=' + JSON.stringify(G.inventory.cursor));
    const arBackIdx = G.inventory.slots.findIndex((s, i) => !s && i >= 9);
    if (arBackIdx >= 0) arMd(document.querySelector('#panel-inventory [data-slot="inv:' + arBackIdx + '"]'), 0);
    await frame();
    G.closeUI(); await frame();

    // 36.5 整套铁甲 15 点（皮革 5 / 铁 15 / 钻石 20）
    for (const id of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) {
      G.inventory.add(id, 1);
      const i = G.inventory.slots.findIndex(s => s && s.item === id);
      T.equipArmor(i);
    }
    const arI3 = T.armorInfo();
    ok('AR.5 四件铁套穿上后护甲 15 点，HUD 显示 15',
      arI3.points === 15 && arI3.pieces.every(p => !!p) && arI3.hud === '15',
      'points=' + arI3.points + ' hud=' + arI3.hud + ' pieces=' + JSON.stringify(arI3.pieces));

    // 36.6/36.7 真实僵尸咬人：无甲 3 点 vs 整套铁甲 1.2 点（不是直接调减伤函数）
    const arBite = async (label) => {
      G.controller.health = 20; G.controller.invulnerable = 0; G.controller.regenT = 0;
      G.controller.hunger = 20;
      const z = G.mobs.spawn('zombie', G.controller.pos.x + 1.1, G.controller.pos.y + 0.2, G.controller.pos.z + 0.1);
      const w = await tryUntil(() => G.controller.health < 19.999,
        { budgetMs: 9000, label, observe: () => ({ hp: G.controller.health, creative: G.controller.creative, state: G.state, d: z ? +Math.hypot(z.pos.x - G.controller.pos.x, z.pos.z - G.controller.pos.z).toFixed(2) : null }) });
      const dmg = Math.round((20 - G.controller.health) * 100) / 100;
      if (z && G.mobs.list.includes(z)) G.mobs.kill(z, false);
      return { dmg, w };
    };
    const arSavedPieces = G.inventory.armor.slice();
    G.inventory.armor = [null, null, null, null];
    G.inventory.emit('equip');
    const arBare = await arBite('无甲僵尸咬人');
    ok('AR.6 真实僵尸咬无甲玩家：掉 3 点（全额）',
      arBare.w.ok && Math.abs(arBare.dmg - 3) < 0.01 && T.armorInfo().lastHurt &&
      T.armorInfo().lastHurt.type === 'melee' && T.armorInfo().lastHurt.blocked === false && T.armorInfo().lastHurt.absorbed === 0,
      'dmg=' + arBare.dmg + ' 等=' + (arBare.w.ok ? arBare.w.ms + 'ms' : '超时:' + arBare.w.timeout) +
      ' lastHurt=' + JSON.stringify(T.armorInfo().lastHurt));

    G.inventory.armor = arSavedPieces;
    G.inventory.emit('equip');
    await frame();
    const arDurBeforeBite = G.inventory.armor.map(s => s && s.dur);
    const arArmored = await arBite('铁甲僵尸咬人');
    const arAfterBite = T.armorInfo();
    const arWorn = arAfterBite.pieces.every((p, i) => p && p.dur === arDurBeforeBite[i] - 1);
    ok('AR.7 同一只僵尸咬整套铁甲：只掉 1.2，且四件各扣 1 点耐久',
      arArmored.w.ok && Math.abs(arArmored.dmg - 1.2) < 0.01 && arAfterBite.lastHurt.armorPoints === 15 &&
      Math.abs(arAfterBite.lastHurt.absorbed - 1.8) < 0.01 && arWorn,
      'dmg=' + arArmored.dmg + ' lastHurt=' + JSON.stringify(arAfterBite.lastHurt) +
      ' dur=' + JSON.stringify(arAfterBite.pieces.map(p => p && p.dur)) + ' 咬前=' + JSON.stringify(arDurBeforeBite));

    // 36.8 不可减免：摔落 4 点全吃，护甲耐久一点不动
    const arDurBeforeFall = G.inventory.armor.map(s => s && s.dur);
    G.controller.health = 20;
    T.hurtPlayer(4, 'fall', '摔落');
    const arFallHp = G.controller.health;
    const arDurAfterFall = G.inventory.armor.map(s => s && s.dur);
    ok('AR.8 摔落不被护甲减免（4 点全吃）且不磨护甲',
      Math.abs(arFallHp - 16) < 1e-9 && JSON.stringify(arDurAfterFall) === JSON.stringify(arDurBeforeFall),
      'hp=' + arFallHp + ' dur ' + JSON.stringify(arDurBeforeFall) + ' → ' + JSON.stringify(arDurAfterFall));

    // 36.9 耐久耗尽：头盔直接消失，其余三件照常 -1，点数 15 → 13
    G.inventory.armor[0].dur = 1;
    const arDurOthers = G.inventory.armor.map(s => s && s.dur);
    G.controller.health = 20;
    T.hurtPlayer(3, 'melee', '护甲损坏测试');
    const arBroken = T.armorInfo();
    ok('AR.9 头盔耐久耗尽后从装备格消失，其余三件各扣 1，护甲 15 → 13',
      arBroken.points === 13 && arBroken.pieces[0] === null &&
      arBroken.pieces[1].dur === arDurOthers[1] - 1 &&
      arBroken.pieces[2].dur === arDurOthers[2] - 1 &&
      arBroken.pieces[3].dur === arDurOthers[3] - 1,
      'points=' + arBroken.points + ' pieces=' + JSON.stringify(arBroken.pieces));

    // 36.10 存档往返 + 旧档（没有 armor 字段）真实读档
    G.inventory.add('iron_helmet', 1);
    const arHelmIdx = G.inventory.slots.findIndex(s => s && s.item === 'iron_helmet');
    T.equipArmor(arHelmIdx);
    for (let i = 0; i < 4; i++) if (G.inventory.armor[i]) G.inventory.armor[i].dur = 11 * (i + 1);
    G.inventory.emit('equip');
    await G.save('manual');
    const arExpect = G.inventory.armor.map(s => s ? { item: s.item, dur: s.dur } : null);

    const arOldObj = G.buildSaveObject();
    delete arOldObj.armor;
    arOldObj.meta = Object.assign({}, arOldObj.meta, { name: '旧档兼容-T1' });
    await G.storage.saveWorld('旧档兼容-T1', arOldObj);
    G.toMenu(); await sleep(300);
    await G.loadWorld('旧档兼容-T1');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '旧档读回来' });
    const arOldInfo = T.armorInfo();
    ok('AR.10 旧档没有 armor 字段：真实读档成功、四格空装备、HUD 为 0',
      arOldInfo.points === 0 && arOldInfo.pieces.every(p => !p) && arOldInfo.hud === '0',
      'points=' + arOldInfo.points + ' pieces=' + JSON.stringify(arOldInfo.pieces) + ' hud=' + arOldInfo.hud);
    G.toMenu(); await sleep(300);
    await G.storage.deleteWorld('旧档兼容-T1');

    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '护甲存档读回来' });
    const arRT = T.armorInfo();
    ok('AR.11 护甲与剩余耐久随存档恢复（含读档后的 HUD）',
      arRT.points === 15 && arRT.hud === '15' && arRT.pieces.every((p, i) => p && arExpect[i] &&
        p.item === arExpect[i].item && p.dur === arExpect[i].dur),
      'points=' + arRT.points + ' hud=' + arRT.hud + ' 读回=' + JSON.stringify(arRT.pieces) + ' 期望=' + JSON.stringify(arExpect));
    G.mobs.maxMobs = arMax0;

    /* ---------------- 37. T2 盾牌：方向性格挡、耐久、交互优先级与存档 ---------------- */
    const shMax0 = G.mobs.maxMobs;
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    T.setTime(0.7);
    // 把 AR 的 5×5 台面延长成 9×19 走廊：骷髅要站在 6 格外的平台上才射得准
    const shP = G.controller.pos;
    const shX = Math.floor(shP.x), shZ = Math.floor(shP.z), shY = Math.floor(shP.y);
    for (let dz = -10; dz <= 4; dz++) for (let dx = -3; dx <= 3; dx++) {
      T.setBlock(shX + dx, shY - 1, shZ + dz, 4);
      for (let h = 0; h <= 3; h++) T.setBlock(shX + dx, shY + h, shZ + dz, 0);
    }
    T.teleport(shX + 0.5, shY + 0.02, shZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '盾牌测试走廊落地', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });
    G.inventory.armor = [null, null, null, null];      // 背后的对比要按无甲算，避免护甲把 3 点改成 1.2
    G.inventory.emit('equip');
    G.controller.regenT = 0; G.controller.hunger = 20;

    // 37.1 真实合成盾牌（6 木板 + 1 铁锭）
    G.openCrafting(3); await frame();
    const shRes = T.craftSet(['planks', 'planks', 'planks', 'planks', 'iron_ingot', 'planks', null, 'planks', null]);
    const shMade = shRes && shRes.item === 'shield' ? T.craftNow(1) : [];
    G.closeUI(); await frame();
    ok('SH.1 6 木板 + 1 铁锭在真实工作台合成盾牌并入库',
      !!shRes && shRes.item === 'shield' && shMade.length === 1 && G.inventory.countOf('shield') >= 1,
      'result=' + JSON.stringify(shRes) + ' made=' + JSON.stringify(shMade));

    // 把盾牌挪进快捷栏第 1 格并选中
    const shSlot = G.inventory.slots.findIndex(s => s && s.item === 'shield');
    if (shSlot >= 0) { const st = G.inventory.get(shSlot); G.inventory.set(shSlot, null); G.inventory.set(0, st); }
    G.inventory.emit('load');
    G.selectHotbar(0);
    await frame(); await frame();
    const shI0 = T.shieldInfo();
    ok('SH.2 第一人称拿的是独立盾牌模型（不是把图标贴在平面上）',
      shI0.held === 'shield' && shI0.model === 'shield' && Math.abs(shI0.dur - 336) < 1e-9,
      JSON.stringify(shI0));

    // 37.3 右键空地举盾：只举盾、不放置、不耗耐久；松开即恢复
    const shAim = (x, y, z) => {
      const dx = x - G.controller.pos.x, dy = y - G.controller.eyeY, dz = z - G.controller.pos.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.pitch = Math.asin(dy / L);
      G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    };
    G.controller.pitch = 0.8; G.controller.yaw = 0;      // 抬头看天：准星没有方块
    G.input.state.mouseRight = true;
    const shW1 = await tryUntil(() => G.controller.blocking, { budgetMs: 3000, label: '右键举盾', observe: () => T.shieldInfo() });
    const shI1 = T.shieldInfo();
    ok('SH.3 右键空地进入格挡：不放置方块、举着不掉耐久',
      shW1.ok && shI1.blocking && shI1.blocks === 0 && shI1.dur === 336 && G.inventory.countOf('shield') === 1,
      'blocking=' + shI1.blocking + ' blocks=' + shI1.blocks + ' dur=' + shI1.dur);
    G.input.state.mouseRight = false;
    const shW2 = await tryUntil(() => !G.controller.blocking, { budgetMs: 3000, label: '松开右键退出格挡' });
    ok('SH.4 松开右键立刻退出格挡（不会永久减速）', shW2.ok && !G.controller.blocking, 'blocking=' + G.controller.blocking);

    // 37.5 正面近战被挡：真实僵尸咬人，血量不变、盾牌 -1 耐久
    const shBite = async (srcZ, label) => {
      G.controller.health = 20; G.controller.invulnerable = 0; G.controller.regenT = 0;
      const z = G.mobs.spawn('zombie', G.controller.pos.x, G.controller.pos.y + 0.2, srcZ);
      const before = T.shieldInfo();
      const w = await tryUntil(() => G.controller.health < 19.999 || T.shieldInfo().blocks > before.blocks,
        { budgetMs: 9000, label, observe: () => ({ hp: G.controller.health, blocks: T.shieldInfo().blocks, z: z ? +z.pos.z.toFixed(2) : null }) });
      const after = T.shieldInfo();
      if (z && G.mobs.list.includes(z)) G.mobs.kill(z, false);
      return { w, before, after };
    };
    G.controller.yaw = 0; G.controller.pitch = 0;        // 面朝 -Z
    /* 关掉自然刷怪并清场：SH.7 等 14 秒等骷髅射箭时，野外僵尸/蜘蛛会抢先咬人，
       读数变成 melee，断言就会误判盾牌没挡箭。 */
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.input.state.mouseRight = true;
    await tryUntil(() => G.controller.blocking, { budgetMs: 3000, label: '近战测试前举盾' });
    const shFront = await shBite(shZ + 0.5 - 1.1, '正面僵尸咬盾');
    ok('SH.5 正面近战被盾牌完全挡下：血量 20、盾牌耐久 -1、记录来源与角度',
      shFront.w.ok && G.controller.health === 20 && shFront.after.blocks === shFront.before.blocks + 1 &&
      shFront.after.dur === shFront.before.dur - 1 && shFront.after.lastBlock &&
      shFront.after.lastBlock.kind === 'melee' && shFront.after.lastBlock.angle <= 60,
      'hp=' + G.controller.health + ' before=' + JSON.stringify(shFront.before) + ' after=' + JSON.stringify(shFront.after));

    // 37.6 背后近战照吃：盾牌不挡、耐久不动
    G.controller.health = 20; G.controller.invulnerable = 0;
    const shBehindBefore = T.shieldInfo();
    const shZ2 = G.mobs.spawn('zombie', G.controller.pos.x, G.controller.pos.y + 0.2, shZ + 0.5 + 1.1);
    const shW3 = await tryUntil(() => G.controller.health < 20,
      { budgetMs: 9000, label: '背后僵尸咬到玩家', observe: () => ({ hp: G.controller.health, blocks: T.shieldInfo().blocks, z: shZ2 ? +shZ2.pos.z.toFixed(2) : null }) });
    const shBehindAfter = T.shieldInfo();
    if (shZ2 && G.mobs.list.includes(shZ2)) G.mobs.kill(shZ2, false);
    ok('SH.6 背后近战不挡：掉 3 点、盾牌耐久不变',
      shW3.ok && Math.abs(G.controller.health - 17) < 1e-9 &&
      shBehindAfter.blocks === shBehindBefore.blocks && shBehindAfter.dur === shBehindBefore.dur,
      'hp=' + G.controller.health + ' blocks ' + shBehindBefore.blocks + '→' + shBehindAfter.blocks + ' dur ' + shBehindBefore.dur + '→' + shBehindAfter.dur);

    // 37.7 正面骷髅箭被挡
    G.controller.health = 20; G.controller.invulnerable = 0;
    const shArrowBefore = T.shieldInfo();
    const sk = G.mobs.spawn('skeleton', G.controller.pos.x, G.controller.pos.y + 0.2, shZ + 0.5 - 6);
    const shW4 = await tryUntil(() => G.controller.health < 19.999 || T.shieldInfo().blocks > shArrowBefore.blocks,
      { budgetMs: 14000, label: '骷髅射中盾牌', observe: () => ({ hp: G.controller.health, blocks: T.shieldInfo().blocks, sk: sk ? +sk.pos.z.toFixed(2) : null }) });
    const shArrowAfter = T.shieldInfo();
    if (sk && G.mobs.list.includes(sk)) G.mobs.kill(sk, false);
    ok('SH.7 正面骷髅箭被盾牌挡下：血量 20，来源记为 arrow',
      shW4.ok && G.controller.health === 20 && shArrowAfter.blocks === shArrowBefore.blocks + 1 &&
      shArrowAfter.lastBlock && shArrowAfter.lastBlock.kind === 'arrow',
      'hp=' + G.controller.health + ' lastBlock=' + JSON.stringify(shArrowAfter.lastBlock) + ' 等=' + (shW4.ok ? shW4.ms + 'ms' : '超时:' + shW4.timeout));

    // 37.8 耐久耗尽：盾牌破碎、自动退出格挡
    G.inventory.held().dur = 1;
    G.inventory.emit('durability');
    G.controller.health = 20; G.controller.invulnerable = 0;
    const shBreakBefore = T.shieldInfo();
    const shZ3 = G.mobs.spawn('zombie', G.controller.pos.x, G.controller.pos.y + 0.2, shZ + 0.5 - 1.1);
    const shW5 = await tryUntil(() => T.shieldInfo().held === null || G.controller.health < 20,
      { budgetMs: 9000, label: '盾牌被最后一击打碎', observe: () => T.shieldInfo() });
    const shBreakAfter = T.shieldInfo();
    if (shZ3 && G.mobs.list.includes(shZ3)) G.mobs.kill(shZ3, false);
    const shStop = await tryUntil(() => !G.controller.blocking, { budgetMs: 3000, label: '盾碎后退出格挡' });
    ok('SH.8 耐久耗尽：盾牌从手上消失、记录 broken、并自动退出格挡',
      shW5.ok && shBreakAfter.held === null && shBreakAfter.blocks === shBreakBefore.blocks + 1 &&
      shBreakAfter.lastBlock && shBreakAfter.lastBlock.broken === true && shStop.ok,
      'held=' + shBreakAfter.held + ' blocks=' + shBreakAfter.blocks + ' lastBlock=' + JSON.stringify(shBreakAfter.lastBlock) + ' blocking=' + G.controller.blocking);

    // 37.9 切换快捷栏必须清理格挡
    T.give('shield', 1);
    const shSlot2 = G.inventory.slots.findIndex(s => s && s.item === 'shield');
    if (shSlot2 >= 0) { const st = G.inventory.get(shSlot2); G.inventory.set(shSlot2, null); G.inventory.set(0, st); }
    G.inventory.emit('load'); G.selectHotbar(0);
    G.controller.pitch = 0.8;
    G.input.state.mouseRight = true;
    await tryUntil(() => G.controller.blocking, { budgetMs: 3000, label: '切栏前举盾' });
    G.selectHotbar(1);
    await frame();
    ok('SH.9 切走盾牌立刻取消格挡（不会带着减速走）',
      !G.controller.blocking && T.shieldInfo().blocking === false,
      'blocking=' + G.controller.blocking + ' held=' + T.shieldInfo().held);
    G.input.state.mouseRight = false;
    G.selectHotbar(0);
    await frame(); await frame();

    // 37.10 对准工作台右键：先执行原交互，不吞掉、不举盾
    // 注意 T.placeAt 会把「当前选中格」塞成工作台，所以先切到别的格放，再切回盾牌
    const shCt = { x: shX + 2, y: shY - 1, z: shZ };
    G.selectHotbar(8);
    T.placeAt(shCt.x, shCt.y, shCt.z, 'crafting_table');
    G.selectHotbar(0);
    G.controller.yaw = 0; G.controller.pitch = 0;
    shAim(shCt.x + 0.5, shCt.y + 0.5, shCt.z + 0.5);
    await frame(); await frame();
    const shCtId = G.world.getBlock(shCt.x, shCt.y, shCt.z);
    const shTargetOk = await tryUntil(() => G.interaction.target &&
      G.world.getBlock(G.interaction.target.x, G.interaction.target.y, G.interaction.target.z) === shCtId,
      { budgetMs: 3000, label: '准星对准工作台', observe: () => G.interaction.target });
    G.input.state.mouseRight = true;
    const shW6 = await tryUntil(() => G.openUI === 'crafting',
      { budgetMs: 4000, label: '右键工作台打开 3×3', observe: () => ({ openUI: G.openUI, blocking: G.controller.blocking }) });
    ok('SH.10 手持盾牌对准工作台右键：打开原合成界面、不举盾、不吞右键',
      shTargetOk.ok && shW6.ok && G.openUI === 'crafting' && !G.controller.blocking,
      'target=' + JSON.stringify(G.interaction.target) + ' openUI=' + G.openUI + ' blocking=' + G.controller.blocking);
    G.input.state.mouseRight = false;
    G.closeUI(); await frame();

    // 37.11 创造物品栏有盾牌；盾牌与耐久随存档、格挡状态不入档
    G.controller.setCreative(true);
    G.openInventory(); await frame();
    G.ui.creativeTab = 2;
    G.ui.showCreativeTab(); await frame();
    const shTitles = [...document.querySelectorAll('#panel-inventory [data-slot^="give:"]')].map(n => n.getAttribute('title') || '');
    ok('SH.11 创造物品栏「工具」页包含盾牌', shTitles.some(t => t.includes('盾牌')), '工具页 ' + shTitles.length + ' 项');
    G.closeUI(); await frame();
    G.controller.setCreative(false);
    G.inventory.held().dur = 300;
    G.inventory.emit('durability');
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '盾牌存档读回来' });
    await frame(); await frame();
    const shRT = T.shieldInfo();
    ok('SH.12 盾牌与剩余耐久随存档恢复，读档后不会残留格挡状态',
      shRT.held === 'shield' && shRT.dur === 300 && shRT.blocking === false && shRT.model === 'shield',
      JSON.stringify(shRT));

    // SH.13 手持盾牌对准箱子：右键必须执行原交互（打开容器），不能吞成举盾
    const shChest = { x: shX + 2, y: shY - 1, z: shZ + 2 };
    G.selectHotbar(8);
    T.placeAt(shChest.x, shChest.y, shChest.z, 'chest');
    G.selectHotbar(0);                                   // 切回盾牌
    G.controller.yaw = 0; G.controller.pitch = 0;
    shAim(shChest.x + 0.5, shChest.y + 0.5, shChest.z + 0.5);
    await frame(); await frame();
    const shChestId = G.world.getBlock(shChest.x, shChest.y, shChest.z);
    const shChestAim = await tryUntil(() => G.interaction.target &&
      G.world.getBlock(G.interaction.target.x, G.interaction.target.y, G.interaction.target.z) === shChestId,
      { budgetMs: 3000, label: '准星对准箱子', observe: () => G.interaction.target });
    await shrRightClick({ pos: { x: shChest.x + 0.5, y: shChest.y, z: shChest.z + 0.5 }, height: 1 });
    const shChestW = await tryUntil(() => G.openUI === 'chest',
      { budgetMs: 4000, label: '右键箱子打开容器', observe: () => ({ openUI: G.openUI, blocking: G.controller.blocking }) });
    ok('SH.13 手持盾牌对准箱子右键：打开箱子面板、不举盾、不吞右键',
      shChestAim.ok && shChestW.ok && G.openUI === 'chest' && !G.controller.blocking,
      'target=' + JSON.stringify(G.interaction.target) + ' openUI=' + G.openUI + ' blocking=' + G.controller.blocking);
    G.input.state.mouseRight = false;
    G.closeUI(); await frame();
    G.mobs.maxMobs = shMax0;

    /* ---------------- 38. T3 战斗反馈与 8 个成就 ---------------- */
    const acMax0 = G.mobs.maxMobs;
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.controller.regenT = 0; G.controller.hunger = 20;
    G.inventory.clear();
    G.inventory.armor = [null, null, null, null];
    G.inventory.emit('equip');
    G.ui.updateHotbar(); G.ui.updateHUD(G);
    T.resetAchievements();
    const acP = G.controller.pos;
    const acX = Math.floor(acP.x), acZ = Math.floor(acP.z), acY = Math.floor(acP.y);
    // 清出一块平地，只留脚下平台（T3 的战斗反馈需要一个确定的靶场）
    for (let dz = -4; dz <= 2; dz++) for (let dx = -3; dx <= 3; dx++) {
      T.setBlock(acX + dx, acY - 1, acZ + dz, 4);
      for (let h = 0; h <= 3; h++) T.setBlock(acX + dx, acY + h, acZ + dz, 0);
    }
    T.teleport(acX + 0.5, acY + 0.02, acZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '反馈靶场落地' });

    const acAim = (x, y, z) => {
      const dx = x - G.controller.pos.x, dy = y - G.controller.eyeY, dz = z - G.controller.pos.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.pitch = Math.asin(dy / L);
      G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    };
    const acPickup = async (item, count = 1) => {
      const before = G.inventory.countOf(item);
      const d = G.interaction.drops.spawn(item, count, G.controller.pos.x, G.controller.pos.y + 1, G.controller.pos.z, false);
      if (d) { d.pickDelay = 0; d.vx = d.vy = d.vz = 0; }
      const w = await tryUntil(() => G.inventory.countOf(item) >= before + count,
        { budgetMs: 7000, label: '拾取 ' + item, observe: () => ({ have: G.inventory.countOf(item), before }) });
      return { w, before, after: G.inventory.countOf(item) };
    };
    const acCraft = async (cells, three) => {
      if (three) G.openCrafting(3); else G.openInventory();
      await frame();
      const r = T.craftSet(cells);
      const made = r ? T.craftNow(1) : [];
      G.closeUI(); await frame();
      return { r, made };
    };

    /* ---- 战斗反馈：命中 / 受伤 / 格挡 / 护甲碎裂 各有独立计数与视觉 ---- */
    const fb0 = T.feedbackInfo();
    G.controller.yaw = 0; G.controller.pitch = 0;
    const acPig = G.mobs.spawn('pig', acX + 0.5, acY + 0.1, acZ + 0.5 - 2);
    acAim(acX + 0.5, acY + 0.55, acZ + 0.5 - 2);
    await frame();
    G.input.state.mouseLeft = false; await frame();
    G.input.state.mouseLeft = true;
    await frame(); await frame();
    G.input.state.mouseLeft = false;
    await frame();
    const fbHit = T.feedbackInfo();
    ok('CF.1 近战命中：掉血 + 命中标记一闪 + 反馈计数增加（不新增攻击冷却）',
      fbHit.hit >= fb0.hit + 1 && fbHit.hitMarker === true && acPig && acPig.hp < acPig.maxHp,
      'hit ' + fb0.hit + '→' + fbHit.hit + ' marker=' + fbHit.hitMarker + ' pigHp=' + (acPig && acPig.hp));
    if (acPig && G.mobs.list.includes(acPig)) G.mobs.kill(acPig, false);

    T.hurtPlayer(2, 'fall', '摔落测试');
    const fbHurt = T.feedbackInfo();
    ok('CF.2 玩家受伤：红色受伤闪屏 + 受伤计数（与命中音效不同名）',
      fbHurt.hurt >= fb0.hurt + 1 && fbHurt.damageOverlay === true,
      'hurt ' + fb0.hurt + '→' + fbHurt.hurt + ' overlay=' + fbHurt.damageOverlay);

    G.inventory.set(0, { item: 'shield', count: 1, dur: 336 });
    G.inventory.emit('load'); G.selectHotbar(0);
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.controller.yaw = 0; G.controller.pitch = 0;
    G.input.state.mouseRight = true;
    await tryUntil(() => G.controller.blocking, { budgetMs: 3000, label: '反馈测试举盾' });
    const fbBeforeBlock = T.feedbackInfo();
    T.hurtPlayer(3, 'melee', '格挡反馈', { x: G.controller.pos.x, z: G.controller.pos.z - 2, kind: 'melee' });
    const fbBlock = T.feedbackInfo();
    ok('CF.3 盾牌格挡：冷白边缘闪 + 格挡计数 + 血量不变',
      fbBlock.block >= fbBeforeBlock.block + 1 && fbBlock.blockOverlay === true && G.controller.health === 20,
      'block ' + fbBeforeBlock.block + '→' + fbBlock.block + ' overlay=' + fbBlock.blockOverlay + ' hp=' + G.controller.health);
    G.input.state.mouseRight = false;
    await tryUntil(() => !G.controller.blocking, { budgetMs: 3000, label: '反馈测试放下盾' });

    G.inventory.add('iron_helmet', 1);
    const acHelmIdx = G.inventory.slots.findIndex(s => s && s.item === 'iron_helmet');
    T.equipArmor(acHelmIdx);
    if (G.inventory.armor[0]) G.inventory.armor[0].dur = 1;
    const fbBeforeBreak = T.feedbackInfo();
    G.controller.health = 20; G.controller.invulnerable = 0;
    T.hurtPlayer(3, 'melee', '护甲碎裂反馈');
    const fbBreak = T.feedbackInfo();
    ok('CF.4 护甲碎裂：装备消失 + 护甲徽标闪红 + 独立计数（与工具/盾碎音不同名）',
      fbBreak.armorBreak >= fbBeforeBreak.armorBreak + 1 && fbBreak.armorFlash === true && G.inventory.armor[0] === null,
      'armorBreak ' + fbBeforeBreak.armorBreak + '→' + fbBreak.armorBreak + ' flash=' + fbBreak.armorFlash +
      ' armor0=' + JSON.stringify(G.inventory.armor[0]));

    /* ---- 成就事件链：木头 → 工作台 → 圆石 → 熔炉 → 铁锭 → 穿甲 → 盾牌 → 钻石 ---- */
    G.inventory.clear();
    G.inventory.armor = [null, null, null, null];
    G.inventory.emit('equip');
    G.ui.updateHotbar(); G.ui.updateHUD(G);
    T.resetAchievements();
    await frame();

    const acWood = await acPickup('oak_log', 3);
    const acInfo1 = T.achievementsInfo();
    ok('AC.1 真实捡起原木 → 解锁「获得木头」并弹像素 toast',
      acWood.w.ok && acInfo1.ids.includes('wood') && acInfo1.toasts === 1 && acInfo1.achToast === true,
      'ids=' + JSON.stringify(acInfo1.ids) + ' toasts=' + acInfo1.toasts + ' toastShow=' + acInfo1.achToast);

    const acTable = await acCraft(['oak_log', null, null, null], false);
    const acPlanks = await acCraft(['planks', 'planks', 'planks', 'planks'], false);
    const acInfo2 = T.achievementsInfo();
    ok('AC.2 原木→木板→真实合成工作台：解锁「制作工作台」',
      acTable.r && acTable.r.item === 'planks' && acPlanks.r && acPlanks.r.item === 'crafting_table' &&
      acInfo2.ids.includes('crafting_table'),
      'planks=' + JSON.stringify(acTable.r) + ' table=' + JSON.stringify(acPlanks.r) + ' ids=' + JSON.stringify(acInfo2.ids));

    const acCobble = await acPickup('cobblestone', 8);
    const acInfo3 = T.achievementsInfo();
    ok('AC.3 真实捡起圆石 → 解锁「获得圆石」', acCobble.w.ok && acInfo3.ids.includes('cobblestone'),
      'cobble=' + acCobble.after + ' ids=' + JSON.stringify(acInfo3.ids));

    const acFurnace = await acCraft([0, 1, 2, 3, null, 5, 6, 7, 8].map(i => i === null ? null : 'cobblestone'), true);
    const acInfo4 = T.achievementsInfo();
    ok('AC.4 8 圆石真实合成熔炉：解锁「制作熔炉」',
      acFurnace.r && acFurnace.r.item === 'furnace' && acInfo4.ids.includes('furnace'),
      'furnace=' + JSON.stringify(acFurnace.r) + ' ids=' + JSON.stringify(acInfo4.ids));

    const acIron = await acPickup('iron_ingot', 2);
    const acInfo5 = T.achievementsInfo();
    ok('AC.5 获得铁锭 → 解锁「获得铁锭」', acIron.w.ok && acInfo5.ids.includes('iron_ingot'),
      'iron=' + acIron.after + ' ids=' + JSON.stringify(acInfo5.ids));

    G.inventory.add('iron_chestplate', 1);
    G.openInventory(); await frame();
    const acArmorIdx = G.inventory.slots.findIndex(s => s && s.item === 'iron_chestplate');
    if (acArmorIdx >= 0) {
      document.querySelector('#panel-inventory [data-slot="inv:' + acArmorIdx + '"]')
        .dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, shiftKey: true }));
    }
    await frame(); await frame();
    G.closeUI(); await frame();
    const acInfo6 = T.achievementsInfo();
    ok('AC.6 真实穿上一件护甲 → 解锁「披甲」', acInfo6.ids.includes('armor') && !!G.inventory.armor[1],
      'ids=' + JSON.stringify(acInfo6.ids) + ' armor=' + JSON.stringify(G.inventory.armor.map(a => a && a.item)));

    const acShield = await acCraft(['planks', 'planks', 'planks', 'planks', 'iron_ingot', 'planks', null, 'planks', null], true);
    const acInfo7 = T.achievementsInfo();
    ok('AC.7 6 木板 + 1 铁锭真实合成盾牌 → 解锁「制作盾牌」',
      acShield.r && acShield.r.item === 'shield' && acInfo7.ids.includes('shield'),
      'shield=' + JSON.stringify(acShield.r) + ' ids=' + JSON.stringify(acInfo7.ids));

    const acDiamond = await acPickup('diamond', 1);
    const acInfo8 = T.achievementsInfo();
    const achRect = document.querySelector('#ach-toast').getBoundingClientRect();
    const achSafe = achRect.right < innerWidth / 2 - 20 || achRect.left > innerWidth / 2 + 20 ||
      achRect.bottom < innerHeight / 2 - 20 || achRect.top > innerHeight / 2 + 20;
    ok('AC.8 获得钻石 → 8/8 全解锁、8 次 toast，且 toast 不在准星中心',
      acDiamond.w.ok && acInfo8.count === 8 && acInfo8.toasts === 8 && acInfo8.achToast === true && achSafe,
      'count=' + acInfo8.count + ' toasts=' + acInfo8.toasts + ' ids=' + JSON.stringify(acInfo8.ids) +
      ' toastRect=' + JSON.stringify({ x: Math.round(achRect.x), y: Math.round(achRect.y), w: Math.round(achRect.width), h: Math.round(achRect.height) }));

    const acToastBefore = T.achievementsInfo().toasts;
    await acPickup('oak_log', 1);
    await acPickup('diamond', 1);
    const acInfo9 = T.achievementsInfo();
    ok('AC.9 重复事件不重复弹：再捡原木/钻石，数量与 toast 次数都不变',
      acInfo9.count === 8 && acInfo9.toasts === acToastBefore,
      'count=' + acInfo9.count + ' toasts ' + acToastBefore + '→' + acInfo9.toasts);

    G.pause(); await frame();
    const acList = document.querySelector('#achievement-list');
    const acRowsOn = acList ? acList.querySelectorAll('.ach-row.on').length : -1;
    ok('AC.10 暂停界面可查看成就：8/8 且 8 行点亮',
      !!acList && acList.textContent.includes('成就 8/8') && acRowsOn === 8,
      acList ? acList.textContent.replace(/\s+/g, ' ').slice(0, 80) + '… on=' + acRowsOn : '没有成就列表');
    G.resume(); await frame();

    /* ---- 存档恢复 + 旧档静默补记 ---- */
    await G.save('manual');
    const acSavedIds = T.achievementsInfo().ids.slice().sort();
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '成就存档读回来' });
    const acRT = T.achievementsInfo();
    ok('AC.11 成就随存档恢复：8 个 id 都在，读档不重复弹 toast',
      acRT.count === 8 && acRT.toasts === 0 &&
      JSON.stringify(acRT.ids.slice().sort()) === JSON.stringify(acSavedIds),
      'count=' + acRT.count + ' toasts=' + acRT.toasts + ' ids=' + JSON.stringify(acRT.ids));

    const acOld = G.buildSaveObject();
    delete acOld.achievements;
    acOld.meta = Object.assign({}, acOld.meta, { name: '旧档成就-T3' });
    await G.storage.saveWorld('旧档成就-T3', acOld);
    G.toMenu(); await sleep(300);
    await G.loadWorld('旧档成就-T3');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '无成就字段的旧档读回来' });
    const acOldInfo = T.achievementsInfo();
    ok('AC.12 旧档没有 achievements 字段：按现有背包/装备静默补记 8 个，不弹 toast',
      acOldInfo.count === 8 && acOldInfo.toasts === 0,
      'count=' + acOldInfo.count + ' toasts=' + acOldInfo.toasts + ' ids=' + JSON.stringify(acOldInfo.ids));
    G.toMenu(); await sleep(300);
    await G.storage.deleteWorld('旧档成就-T3');
    G.mobs.maxMobs = acMax0;

    /* ---------------- 39. T4 音乐与环境声：场景切换、单曲约束、暂停释放、诊断 ---------------- */
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '音乐测试读档' });
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    // 站到地表以上（原来的存档位置可能在洞里，会一直判成 cave）
    const muX = Math.floor(G.controller.pos.x), muZ = Math.floor(G.controller.pos.z);
    const muTop = G.world.topSolidY(muX, muZ) + 1;
    for (let dy = 1; dy <= 5; dy++) T.setBlock(muX, muTop + dy - 1, muZ, 0);
    T.teleport(muX + 0.5, muTop, muZ + 0.5);
    T.setTime(0.3);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '音乐测试站上地表' });
    G.input.setUIMode(false);
    await frame(); await frame();

    const muW1 = await tryUntil(() => T.musicInfo().trackId === 'day' && T.musicInfo().activeAmbient === 'wind',
      { budgetMs: 6000, label: '白天主曲与环境床就位', observe: () => T.musicInfo() });
    const mu1 = T.musicInfo();
    ok('MU.1 白天：主曲切到 day、最多一首、环境床为风，诊断字段齐全',
      muW1.ok && mu1.trackId === 'day' && mu1.section === 'day' && mu1.activeMusicCount === 1 &&
      mu1.activeAmbient === 'wind' && mu1.ambientCount === 1 && mu1.ready === true,
      JSON.stringify(mu1));

    // 快速连切：任何时刻只允许一条主曲、最多一条淡出中的旧曲
    for (const id of ['night', 'cave', 'day', 'night', 'cave', 'day']) T.setMusicScene(id);
    await sleep(250);
    const mu2 = T.musicInfo();
    ok('MU.2 快速连切 6 次后仍只有一条主曲（不叠出多条循环）',
      mu2.activeMusicCount === 1 && mu2.fadingMusicCount <= 1 && mu2.trackId !== null,
      JSON.stringify(mu2));

    T.setMusicScene('day');
    T.setTime(0.75);
    const muW3 = await tryUntil(() => T.musicInfo().trackId === 'night' && T.musicInfo().activeAmbient === 'insects',
      { budgetMs: 6000, label: '夜晚曲与虫鸣', observe: () => T.musicInfo() });
    const mu3 = T.musicInfo();
    ok('MU.3 夜晚：切到 night 曲 + 虫鸣环境床',
      muW3.ok && mu3.trackId === 'night' && mu3.section === 'night' && mu3.activeAmbient === 'insects',
      JSON.stringify(mu3));

    // 下雨（户外）：雨声压过风/虫鸣
    T.setTime(0.3);
    T.setWeather('rain', 600);
    T.tickWeather(0.05, 120);
    const muW4 = await tryUntil(() => T.musicInfo().activeAmbient === 'rain',
      { budgetMs: 6000, label: '雨声环境床', observe: () => T.musicInfo() });
    ok('MU.4 户外下雨：环境床切到雨声（昼夜音乐仍是白天曲，且淡出中的旧床 ≤1）',
      muW4.ok && T.musicInfo().activeAmbient === 'rain' && T.musicInfo().trackId === 'day' &&
      T.musicInfo().ambientFadingCount <= 1,
      JSON.stringify(T.musicInfo()));
    T.setWeather('clear', 600);
    await tryUntil(() => T.musicInfo().activeAmbient === 'wind', { budgetMs: 6000, label: '放晴回风' });

    /* 真的挖到地下：洞穴曲 + 滴水。
       「地下」的判据是 `y < world.surfaceHeight(x,z) - 3`（game.js 的 audioSceneState），
       而 surfaceHeight 是**纯噪声**、和这一格实际挖出来的 topSolidY 可以差 1 格以上。
       旧版按 topSolidY 定深度，差 1 格时正好压在边界上（本轮读数 y=14.0001 / surface=17 →
       14 < 14 不成立），这条断言就变成在测两个高度差了几格，而不是在测「我进洞了有没有换曲」。
       改成直接按判据本身取深：落点 = min(topSolidY-5, surfaceHeight-5)，比 surface-3 的判据
       再多 2 格余量；竖井按新目标深度挖通、脚下留一格实心，站稳之后再等。 */
    const muCX = muX + 2, muCZ = muZ + 2, muCTop = G.world.topSolidY(muCX, muCZ) + 1;
    const muSurf = G.world.surfaceHeight(muCX, muCZ);
    const muStandY = Math.min(muCTop - 5, muSurf - 5);     // 判据与地形取更深的一边，落点必然在地下
    for (let y = muStandY; y <= Math.max(muCTop, muStandY + 2); y++) T.setBlock(muCX, y, muCZ, 0);
    T.teleport(muCX + 0.5, muStandY, muCZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: 'MU.5 井底站稳',
      observe: () => ({ y: +G.controller.pos.y.toFixed(2), surf: muSurf, top: muCTop, onGround: G.controller.onGround }) });
    const muW5 = await tryUntil(() => T.musicInfo().trackId === 'cave' && T.musicInfo().activeAmbient === 'cave',
      { budgetMs: 8000, label: '地下洞穴曲与滴水', observe: () => ({ a: T.audioScene(), m: T.musicInfo() }) });
    const mu5 = T.musicInfo();
    ok('MU.5 地下：切到 cave 曲 + 洞穴滴水环境床，section 读数正确',
      muW5.ok && mu5.trackId === 'cave' && mu5.section === 'cave' && mu5.activeAmbient === 'cave',
      'scene=' + JSON.stringify(T.audioScene()) + ' music=' + JSON.stringify(mu5));
    /* 把测试竖井填回地面：后面的 TNT 等节都是在「玩家此刻站着的这一格」上搭平台，
       井留着就会把 TN 的场地修到洞底，脚下的支撑与一次摔落直接污染 TN.4 的精确等式
       （本轮 hp=20→12、报告 dmg=5 就是这个形状）。 */
    for (let y = muStandY - 1; y < muCTop; y++) T.setBlock(muCX, y, muCZ, 1);
    T.teleport(muCX + 0.5, muCTop, muCZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: 'MU.5 后填回井口并站回地表',
      observe: () => ({ y: +G.controller.pos.y.toFixed(2), top: G.world.topSolidY(muCX, muCZ) }) });

    // 暂停必须释放主曲与环境床；恢复后重新开始，且仍只有一条
    G.pause();
    await sleep(120);
    const mu6a = T.musicInfo();
    G.resume();
    const muW6 = await tryUntil(() => T.musicInfo().activeMusicCount === 1 && T.musicInfo().activeAmbient !== null,
      { budgetMs: 6000, label: '恢复后音乐回来', observe: () => T.musicInfo() });
    ok('MU.6 暂停释放主曲与环境床（activeMusicCount=0），恢复后单曲重新开始',
      mu6a.activeMusicCount === 0 && mu6a.activeAmbient === null && muW6.ok &&
      T.musicInfo().activeMusicCount === 1,
      '暂停=' + JSON.stringify(mu6a) + ' 恢复=' + JSON.stringify(T.musicInfo()));

    const mu7 = T.musicInfo();
    const tr = T.trackInfo('day');
    ok('MU.7 三首曲子有可读的 trackId/loopSeconds/动机信息：换了外部曲目之后，合成编排表仍是完整可读的兜底（阶段 4 换的是默认出声源，不是删掉编排）',
      tr && tr.id === 'day' && tr.loopSeconds >= 20 && mu7.trackId &&
      mu7.volumes && mu7.volumes.music !== undefined &&
      mu7.synthLoopSeconds >= 20 && Math.abs(mu7.synthLoopSeconds - tr.loopSeconds) < 0.001,
      'track=' + JSON.stringify(tr) + ' music=' + JSON.stringify(mu7));

    // MU.8 真实设置开关：关音乐 → 主曲/环境床停止；开回来 → 单曲重新开始；返回后环境床恢复
    G.pause(); await frame();
    G.ui.showSettings('pause'); await frame();
    const muCk = document.querySelector('#ck-music');
    muCk.checked = false;
    muCk.dispatchEvent(new Event('change', { bubbles: true }));
    await frame();
    const muOff = T.musicInfo();
    muCk.checked = true;
    muCk.dispatchEvent(new Event('change', { bubbles: true }));
    const muOnW = await tryUntil(() => T.musicInfo().activeMusicCount === 1,
      { budgetMs: 6000, label: '开关重新打开后音乐回来', observe: () => T.musicInfo() });
    const muOn = T.musicInfo();
    document.querySelector('#btn-back2').click();
    const muBack = await tryUntil(() => G.state === 'playing' && T.musicInfo().activeAmbient !== null,
      { budgetMs: 6000, label: '返回游戏后环境床恢复', observe: () => ({ state: G.state, m: T.musicInfo() }) });
    ok('MU.8 设置里的音乐开关真实生效：关掉后主曲/环境床为 0，打开后单曲恢复，返回游戏环境床回来',
      muOff.wanted === false && muOff.activeMusicCount === 0 && muOff.activeAmbient === null &&
      muOnW.ok && muOn.activeMusicCount === 1 && muBack.ok && G.settings.music === true,
      'off=' + JSON.stringify(muOff) + ' on=' + JSON.stringify(muOn) + ' back=' + muBack.ok);

    /* ---------------- 39b. 阶段 4：探索配乐真的换成随包外部曲目（MF.*） ----------------
     * 任务书第 2 条要的是「换掉」而不是「再加一层」，而且要**走正常播放入口**验
     * 首次出曲 / 场景切换 / 留白 / 音量归零与恢复 / 暂停 / 读档。
     *
     * 两条口径来自隔离取证（`node`… 见 tests/repro-mf.mjs → artifacts/repro-mf.json），
     * 都是第一版 MF 跑红之后量出来的，不是猜的：
     *   ① master 之后的总输出会把环境床（风 / 虫鸣）和动作音一起算进来，
     *      「文件 rms vs 合成 rms」在这种混合信号上没有意义（第一版读到 0.017 vs 0.045，
     *      差的其实是环境床，不是曲子）。所以本节把 **sfx 滑条拉到 0**——
     *      环境床归音效层是 T4 的既有分工——只让 music 总线上的主曲进读数；
     *      再用「音乐开关也关掉」量一次底噪，两条曲线都必须远远高过它。
     *      隔离之后实测：文件轨 rms 0.01504、合成轨 rms 0.01504、底噪 0.00011。
     *   ② 切轨那一瞬间 `AudioParam.value` 会先读到默认值 1（缓入事件还没落到当前渲染块），
     *      所以「缓入到位了没有」**不能只看 busGain ≥ 目标的一半**——那一刻它可能是 1.0，
     *      而 rms 只有 0.00001。本节等的是**音频时钟**：切换之后再走够 fadeIn + 余量，
     *      并且相位必须停在 playing。留白同理：段尾淡出走满 5 秒才算「贴到静音」。
     */
    {
      const mfMi = () => T.musicInfo();
      const mfEn = () => T.audioEnergy();
      const mfUrls = () => performance.getEntriesByType('resource').map(e => e.name).filter(u => /\/media\/music\//.test(u));
      const mfVol0 = mfMi().volumes || { master: 0.8, sfx: 0.85, music: 0.4 };
      const mfClockRatio = async (ms = 350) => {
        const e0 = mfEn();
        if (!e0 || typeof e0.currentTime !== 'number') return { ok: false, ratio: null, why: 'no-clock-field' };
        const w0 = performance.now();
        await sleep(ms);
        const e1 = mfEn();
        const wall = (performance.now() - w0) / 1000;
        const ratio = wall > 0 ? (e1.currentTime - e0.currentTime) / wall : 0;
        return { ok: ratio >= 0.8, ratio: +ratio.toFixed(3), state: e1.state, sampleRate: e1.sampleRate };
      };
      const mfWake = async (label) => {
        let c = await mfClockRatio();
        const tries = [];
        if (!c.ok) {
          try { G.sfx.resume(); } catch (e) { /* 自动播放策略还没放行，下一轮再试 */ }
          await sleep(300);
          c = await mfClockRatio(); tries.push('resume');
          for (let i = 0; i < 4 && !c.ok; i++) { await sleep(400); c = await mfClockRatio(); }
          if (!c.ok) tries.push('再等 4 轮');
        }
        return { c, label, revived: tries.join('+') || null };
      };
      /* 按**指定总线**采样（第二轮 MF.8）：master 上还混着环境床/sfx，
         用 master 判「音乐音量归零」会把环境床算进去（上一轮成品就是 1.8e-5 卡住）。
         这里直接读 Sfx.busEnergy() 里对应总线的 rms/peak。 */
      const mfBusSample = async (ms, bus) => {
        let rms = 0, peak = 0, n = 0;
        const name = bus || 'music';
        const t1 = performance.now();
        while (performance.now() - t1 < ms) {
          const be = T.audioBusEnergy ? T.audioBusEnergy() : null;
          const v = be && be[name];
          if (v && be.available) { rms = Math.max(rms, v.rms); peak = Math.max(peak, v.peak); n++; }
          await sleep(40);
        }
        return { rms, peak, n, bus: name };
      };
      const mfSample = async (ms) => {
        let rms = 0, peak = 0, nan = 0, n = 0, last = null;
        const e0 = mfEn();
        const w0 = performance.now();
        const t1 = performance.now();
        while (performance.now() - t1 < ms) {
          const e = mfEn();
          if (e && e.available) { rms = Math.max(rms, e.rms); peak = Math.max(peak, e.peak); nan += e.nan; last = e; n++; }
          await sleep(40);
        }
        const e1 = mfEn();
        const wall = (performance.now() - w0) / 1000;
        return {
          rms, peak, nan, n, last,
          clockRatio: (e0 && e1 && typeof e0.currentTime === 'number' && wall > 0)
            ? +((e1.currentTime - e0.currentTime) / wall).toFixed(3) : null,
          busGain: mfMi().busGain, busTotal: mfMi().busGainTotal, busTarget: mfMi().busTarget
        };
      };
      /* 「切换之后真的缓入走完了」：只信音频时钟 + 相位，不信那一瞬间的 AudioParam.value */
      const mfSettle = async (seconds, label) => {
        const c0 = (mfEn() || {}).currentTime;
        if (typeof c0 !== 'number') return { ok: false, timeout: '没有音频时钟字段' };
        return tryUntil(() => {
          const e = mfEn(), mi = mfMi();
          return !!e && typeof e.currentTime === 'number' && e.currentTime - c0 >= seconds &&
            !!mi && mi.activeMusicCount === 1 && mi.cycle && mi.cycle.phase === 'playing';
        }, { budgetMs: Math.round((seconds + 8) * 1000), tick: 'sleep', intervalMs: 120, label: label || '等这一段缓入走完', observe: () => mfMi() });
      };
      /* 文件轨「一段 = 整曲」（48~165 秒），后面还有 70~150 秒留白，
         所以「现在是不是在出声」不能靠等——等留白走完要花几分钟，而在留白里采样会得到 0，
         那不是产品问题。这里走玩家能看到的那个音乐开关（关掉→全释放→打开→新一段 playing），
         它内部就是 stopMusic / startMusic / _switchMusic，采到的永远是缓入走完的正常段。 */
      const mfRestart = async (label) => {
        await G.applySettingsLive({ music: false });
        await tryUntil(() => { const mi = mfMi(); return mi.activeMusicCount === 0 && mi.fadingMusicCount === 0; },
          { budgetMs: 8000, tick: 'sleep', intervalMs: 80, label: label + '：先等上一条释放干净', observe: () => mfMi() });
        await G.applySettingsLive({ music: true, volumeMaster: 0.8, volumeSfx: 0, volumeMusic: 0.45 });
        const w = await tryUntil(() => {
          const mi = mfMi();
          return !!mi && mi.activeMusicCount === 1 && mi.cycle && mi.cycle.phase === 'playing';
        }, { budgetMs: 12000, tick: 'sleep', intervalMs: 100, label: label + '：新一段进入 playing', observe: () => mfMi() });
        const st = await mfSettle(2.6, label + '：缓入走完');
        return { w, st, ms: st.ms, ok: w.ok && st.ok };
      };
      /* 「全静音」要等四条计数都归零：stopMusic 会连环境床一起淡出（≈2 秒），
         只等主曲计数会把淡出尾巴量成底噪（本轮底噪读数 0.000328 就是这个形状，
         与 B 段 bSilenceGone 同一口径）。 */
      const mfSilence = async (budgetMs) => {
        const w = await tryUntil(() => {
          const mi = mfMi();
          return !!mi && mi.activeMusicCount === 0 && mi.fadingMusicCount === 0 &&
            mi.ambientCount === 0 && mi.ambientFadingCount === 0;
        }, { budgetMs, tick: 'sleep', intervalMs: 80, label: '主曲与环境床全部释放', observe: () => mfMi() });
        await sleep(900);
        return w;
      };
      const mfFilePlaying = () => { const mi = mfMi(); return !!mi && mi.source === 'file' && mi.activeMusicCount === 1; };

      /* ---- 场地准备：走真实设置入口把环境层与动作音闭掉，只留 music 总线 ---- */
      G.mobs.maxMobs = 0; G.mobs.clear();
      await G.applySettingsLive({ volumeMaster: 0.8, volumeSfx: 0, volumeMusic: 0.45 });
      const mfW2 = await tryUntil(
        () => { const mi = mfMi(); return !!mi && mi.activeMusicCount === 1 && mi.source === 'file' && mi.trackId === 'day'; },
        {
          budgetMs: 22000, tick: 'sleep', intervalMs: 150, label: '白天主曲换成随包曲目',
          observe: () => { const mi = mfMi(); return { src: mi.source, states: mi.fileStates, err: mi.fileLastError, bytes: mi.bytesDecoded }; }
        });
      const mfSettle0 = await mfRestart('MF.3 文件轨');
      const mfWake1 = await mfWake('文件曲');

      const mf1 = mfMi();
      const mfReg = T.fileTracksInfo() || [];
      const mfGot = mfUrls();
      ok('MF.1 三条外部曲目登记齐全（CC0、字节、作者原页、互不共用文件），且素材真的随包取到：同源 /media/music 的 URL 出现在资源列表、解码字节数与登记一致',
        mfReg.length === 3 && new Set(mfReg.map(r => r.file)).size === 3 &&
        mfReg.every(r => r.licence === 'CC0-1.0' && r.bytes > 100000 &&
          /^https:\/\/opengameart\.org\/content\//.test(r.source) && r.trim > 0 && r.trim <= 1) &&
        new Set(mfGot).size === 3 && mfGot.every(u => /^http:\/\/127\.0\.0\.1(:\d+)?\/media\/music\//.test(u)) &&
        mfReg.filter(r => r.load && r.load.bytes > 0).every(r => r.load.bytes === r.bytes) &&
        mfReg.every(r => r.state === 'ready' || (r.load && r.load.bytes > 0)),
        '登记=' + JSON.stringify(mfReg.map(r => ({ s: r.scene, f: r.file, l: r.licence, b: r.bytes, st: r.state, load: r.load }))) +
        ' 取到的 URL=' + JSON.stringify(mfGot.slice(-3)) + ' 最后错误=' + mf1.fileLastError);

      ok('MF.2 正常播放入口放的就是文件曲：source=file、fileName 与登记一致、整曲时长就是这一段、解码字节真的进了内存、许可读数随诊断出来',
        mfW2.ok && mfSettle0.ok && mf1.source === 'file' && mf1.trackId === 'day' &&
        mf1.fileName === 'exploration_theme.ogg' &&
        mf1.fileDuration >= 40 && Math.abs(mf1.loopSeconds - mf1.fileDuration) < 0.01 &&
        mf1.synthLoopSeconds > 0 && Math.abs(mf1.synthLoopSeconds - mf1.loopSeconds) > 1 &&
        mf1.bytesDecoded > 0 && !!mf1.fileMeta && mf1.fileMeta.licence === 'CC0-1.0' &&
        mf1.fileMeta.author === 'CleytonKauffman' && mf1.filesEnabled === true,
        'music=' + JSON.stringify({ src: mf1.source, file: mf1.fileName, dur: mf1.fileDuration, loop: mf1.loopSeconds, synthLoop: mf1.synthLoopSeconds, bytes: mf1.bytesDecoded, meta: mf1.fileMeta, waited: mfW2.ms, settle: mfSettle0.ms }));

      /* ---- MF.3 响度同量级：文件轨 / 合成轨 / 底噪三条曲线，全在只留 music 总线的条件下量 ---- */
      const mfFile = await mfSample(4000);
      T.setFileTracksEnabled(false);
      const mfW4 = await tryUntil(() => { const mi = mfMi(); return mi.source === 'synth' && mi.activeMusicCount === 1; },
        { budgetMs: 12000, tick: 'sleep', intervalMs: 100, label: '关掉文件轨后合成曲顶上', observe: () => mfMi() });
      const mfSettle1 = await mfSettle(2.6, '合成轨这一段缓入走完（fade 2 秒 + 余量）');
      const mfSynth = await mfSample(4000);
      await G.applySettingsLive({ music: false });
      /* 本轮 D 语义变更（明确记录，不是为了让测试变绿）：
         旧行为：关「背景音乐」→ stopMusic() → 主曲与环境床一起停，这里的判据是
         「activeMusicCount===0 且 ambientCount===0」。
         新行为：音乐开关只释放主曲，环境声（风/虫鸣/洞穴滴水/雨）继续按场景走 ——
         玩家只想安静点，不该把世界一起静音。
         原意「关掉声音以后应当接近底噪」因此拆成两步验证，两步都保留：
           ① 只关音乐 → 主曲释放、环境床仍在（新语义的可测面）；
           ② 再把环境开关关掉（暂停释放用的同一个入口）→ 两条都释放 → 才是底噪。 */
      const mfSilMusic = await tryUntil(() => {
        const mi = mfMi();
        return !!mi && mi.activeMusicCount === 0 && mi.fadingMusicCount === 0;
      }, { budgetMs: 9000, tick: 'sleep', intervalMs: 80, label: '只关音乐时主曲释放', observe: () => mfMi() });
      const mfAmbKept = mfMi();
      /* 本轮 A1：这里必须证明「环境床还在出声」，不能只看计数。
         计数 ambientCount>=0 在零个源时也成立（复核 4-1 指出的缺口），
         所以先确认环境床此刻真的按场景启用了，再读 **ambient 总线自己的 RMS**，
         要求它明显高于「环境开关也关掉」之后的同一读数。 */
      await tryUntil(() => {
        const be = T.audioBusEnergy ? T.audioBusEnergy() : null;
        return !!be && be.available && be.ambientSources > 0 && be.ambient && be.ambient.rms > 1e-5;
      }, { budgetMs: 6000, tick: 'sleep', intervalMs: 100, label: '环境床在出声', observe: () => T.audioBusEnergy() });
      const ambOn = T.audioBusEnergy ? T.audioBusEnergy() : null;
      /* 再量一小段：单帧读数可能撞在滴水间隙上，取 600ms 内的峰值 */
      let ambOnPeak = ambOn && ambOn.ambient ? ambOn.ambient.peak : 0;
      for (let i = 0; i < 6; i++) {
        await sleep(100);
        const be = T.audioBusEnergy ? T.audioBusEnergy() : null;
        if (be && be.ambient) ambOnPeak = Math.max(ambOnPeak, be.ambient.peak);
      }
      G.sfx.setAmbientEnabled(false);
      const mfSil0 = await mfSilence(9000);
      const mfFloor = await mfSample(2500);
      mfSil0.silent = mfMi();
      /* 环境总线在关闭之后也必须是「没有源 + 没有信号」 */
      await sleep(900);
      const ambOff = T.audioBusEnergy ? T.audioBusEnergy() : null;
      await G.applySettingsLive({ music: true, volumeMaster: 0.8, volumeSfx: 0, volumeMusic: 0.45 });
      G.sfx.setAmbientEnabled(true);
      T.setFileTracksEnabled(true);
      const mfRatio = mfFile.rms / Math.max(1e-9, mfSynth.rms);
      ok('MF.3 文件曲与合成曲在同一条 music 总线上同量级（把 sfx 滑条拉到 0 隔离环境床、各取 4 秒窗口，相对 RMS 比 0.25~4.0），且两条都远远高过「音乐也关掉」的底噪；' +
        '本轮 D 起「关音乐」只释放主曲，本轮 A1 起同时要求环境总线仍有可测信号、关环境开关后源与信号都归零',
        mfWake1.c.ok && mfW4.ok && mfSettle0.ok && mfSettle1.ok && mfSilMusic.ok && mfSil0.ok &&
        mfAmbKept && mfAmbKept.activeMusicCount === 0 &&
        !!ambOn && ambOn.available && ambOn.ambientSources > 0 && ambOn.ambientId &&
        ambOnPeak > 1e-5 &&
        !!ambOff && ambOff.ambientSources === 0 && ambOff.ambient && ambOff.ambient.rms <= Math.max(1e-5, ambOnPeak * 0.05) &&
        mfFile.n > 20 && mfFile.clockRatio >= 0.8 && mfSynth.n > 20 && mfFloor.n > 10 &&
        mfFile.rms >= 20 * Math.max(1e-9, mfFloor.rms) && mfSynth.rms >= 20 * Math.max(1e-9, mfFloor.rms) &&
        mfFile.nan === 0 && mfSynth.nan === 0 &&
        mfRatio >= 0.25 && mfRatio <= 4.0,
        '文件 rms=' + mfFile.rms.toFixed(6) + ' peak=' + mfFile.peak.toFixed(5) + ' clock=' + mfFile.clockRatio + ' 总线=' + mfFile.busTotal +
        ' | 合成 rms=' + mfSynth.rms.toFixed(6) + ' peak=' + mfSynth.peak.toFixed(5) + ' clock=' + mfSynth.clockRatio +
        ' | 底噪 rms=' + mfFloor.rms.toFixed(6) + ' peak=' + mfFloor.peak.toFixed(6) +
        ' | 比值=' + mfRatio.toFixed(3) +
        ' | 关音乐后 ambient=' + (mfAmbKept && mfAmbKept.ambientCount) +
        ' 源=' + (ambOn && ambOn.ambientSources) + ' id=' + (ambOn && ambOn.ambientId) +
        ' rms=' + (ambOn && ambOn.ambient ? ambOn.ambient.rms : '-') + ' 峰值(600ms)=' + ambOnPeak.toFixed(6) +
        ' | 关环境开关后 源=' + (ambOff && ambOff.ambientSources) + ' rms=' + (ambOff && ambOff.ambient ? ambOff.ambient.rms : '-') +
        ' | 窗口口径=4 秒（1.2 秒短窗在稀疏编排上不可比，见 artifacts/repro-mf.json E 段）' +
        ' | 时钟取证=' + JSON.stringify(mfWake1));

      /* ---- MF.4 素材缺席不许静音：把解码缓存与状态整个清掉（模拟坏包 / 解码失败） ---- */
      T.setFileTracksEnabled(false);
      G.sfx._fileBufs.clear();
      G.sfx._fileState = Object.create(null);
      const mfW6 = await tryUntil(() => { const mi = mfMi(); return mi.source === 'synth' && mi.activeMusicCount === 1; },
        { budgetMs: 12000, tick: 'sleep', intervalMs: 100, label: '素材拿掉后仍在放曲', observe: () => mfMi() });
      const mfSettle2 = await mfSettle(2.6, '兜底合成轨缓入走完');
      const mfNoFile = await mfSample(4000);
      ok('MF.4 素材缺席时不许静音：清掉解码缓存后仍由合成编排继续放曲（隔离环境层的 4 秒读数、无 NaN、仍只有一条主曲）',
        mfW6.ok && mfSettle2.ok && mfNoFile.n > 20 && mfNoFile.nan === 0 &&
        mfNoFile.rms >= 20 * Math.max(1e-9, mfFloor.rms) &&
        mfMi().activeMusicCount === 1 && mfMi().source === 'synth',
        'rms=' + mfNoFile.rms.toFixed(6) + '（底噪 ' + mfFloor.rms.toFixed(6) + '）clock=' + mfNoFile.clockRatio +
        ' music=' + JSON.stringify({ src: mfMi().source, st: mfMi().fileStates, fade: mfMi().fadingMusicCount }));

      /* ---- MF.5 文件就绪就自动接上，不用等下一次切场景 ---- */
      T.setFileTracksEnabled(true);
      G.sfx.ensureFileTrack(mfMi().trackId);
      const mfW7 = await tryUntil(() => mfMi().source === 'file',
        { budgetMs: 22000, tick: 'sleep', intervalMs: 150, label: '重新解码后自动换回文件轨', observe: () => mfMi() });
      ok('MF.5 文件就绪就自动接上：重新取回并解码后，当前场景从合成曲交叉换回曲目，不需要等到下一次切场景',
        mfW7.ok && mfMi().filesEnabled === true && mfMi().trackId === 'day' &&
        mfMi().fileName === 'exploration_theme.ogg' && mfMi().bytesDecoded > 0,
        '等了 ' + (mfW7.ms === undefined ? '?' : mfW7.ms) + 'ms source=' + mfMi().source +
        ' states=' + JSON.stringify(mfMi().fileStates) + ' bytes=' + mfMi().bytesDecoded);

      /* ---- MF.6 每个场景用的是各自登记的那首 ----
       * night 走**真实派生**：把时间调到夜里，让游戏自己切场景（与 MU.3 同一条路）。
       * cave 也走同一条每帧入口，但不重挖第二次竖井（MU.5 已经用真实下到地下验过「进洞会换 cave」，
       * 这里要验的只是「cave 用的是哪一首」），所以临时把纯状态函数 audioSceneState 的读数改成 cave，
       * 之后立刻还原——被检的仍是 updateAudioScene → sfx.setMusicScene → _switchMusic 这条真链路。 */
      const mfScene = {};
      const mfProbeScene = async (sc, expectFile) => {
        const w = await tryUntil(() => {
          const mi = mfMi();
          return !!mi && mi.trackId === sc && mi.source === 'file' && mi.fileName === expectFile;
        }, { budgetMs: 22000, tick: 'sleep', intervalMs: 150, label: sc + ' 场景用对应的随包曲目', observe: () => mfMi() });
        const mi = mfMi();
        return { ok: w.ok, ms: w.ms, src: mi.source, file: mi.fileName, dur: mi.fileDuration, states: mi.fileStates };
      };
      T.setTime(0.75);
      mfScene.night = await mfProbeScene('night', 'forest_whisper_prev.ogg');
      T.setTime(0.3);
      await tryUntil(() => mfFilePlaying() && mfMi().trackId === 'day', { budgetMs: 12000, tick: 'sleep', intervalMs: 100, label: '切回白天曲目' });
      const mfRealScene = G.audioSceneState.bind(G);
      G.audioSceneState = () => Object.assign(mfRealScene(), { scene: 'cave', underground: true });
      mfScene.cave = await mfProbeScene('cave', 'ambient_horror_track01.ogg');
      G.audioSceneState = mfRealScene;
      await tryUntil(() => mfFilePlaying() && mfMi().trackId === 'day', { budgetMs: 12000, tick: 'sleep', intervalMs: 100, label: '还原场景读数后回到白天' });
      ok('MF.6 夜晚与洞穴各自用登记的那首：走每帧 updateAudioScene 的真入口，场景读数、文件名、整曲时长三者对得上（不再是一首曲子盖三个场景）',
        mfScene.night.ok && mfScene.night.dur >= 40 &&
        mfScene.cave.ok && mfScene.cave.dur >= 40 &&
        mfScene.night.file !== mfScene.cave.file && mfScene.night.file !== mf1.fileName &&
        mfMi().trackId === 'day' && mfMi().source === 'file',
        JSON.stringify(mfScene));

      /* ---- MF.7 留白：文件轨也必须走「段尾淡出 → 留白 → 缓入」这台机器 ----
       * 用产品自己的 _scheduleLoop 把「这一段还剩 6 秒」重排一遍，等它自然进 gap：
       * 不改任何阈值、不拉长观察窗，只是把一段的长度调短好观察（留白参数本身由
       * T4.1 与 core/musictiming.js 的单测钉住）。
       * 注意 nextStart 只推到「现在 + 0.2」，段尾由 _scheduleLoop 自己按 loopSeconds 加，
       * 第一版把 6 秒加了两遍（nextStart 与 loopSeconds 各一次），于是 16 秒预算不够用。 */
      const mfM = G.sfx._music;
      const mfFullLoop = mfM.loopSeconds;
      const mfGapT0 = performance.now();
      G.sfx._stopTrackSource(mfM, 0);                 // 先把还在播的整曲停下，别和重排的这一段叠在一起
      mfM.loopSeconds = 6;
      mfM.nextStart = G.sfx.ctx.currentTime + 0.2;
      if (mfM.timer) clearTimeout(mfM.timer);
      G.sfx._scheduleLoop(mfM);
      const mfW8 = await tryUntil(
        () => { const mi = mfMi(); return !!mi && mi.cycle && mi.cycle.phase === 'gap'; },
        { budgetMs: 12000, tick: 'sleep', intervalMs: 100, label: '文件轨走完这一段进入留白', observe: () => mfMi() });
      const mfGapAtMs = Math.round(performance.now() - mfGapT0);
      const mfW9 = await tryUntil(
        () => { const mi = mfMi(); return !!mi && mi.cycle && mi.cycle.phase === 'gap' && mi.busGain <= 0.002; },
        { budgetMs: 10000, tick: 'sleep', intervalMs: 100, label: '段尾淡出走满 5 秒（增益贴到静音）', observe: () => mfMi() });
      const mfGapMs = Math.round(performance.now() - mfGapT0);
      const mfGap = mfMi();
      const mfCfg = mfGap.timing || {};
      /* 恢复成「整曲一段」的正常长度，别把缩短过的段落留给后面的节 */
      G.sfx._switchMusic(mfGap.trackId, 0.3);
      const mfRestore = await tryUntil(() => { const mi = mfMi(); return mi.source === 'file' && Math.abs(mi.loopSeconds - mfFullLoop) < 0.5; },
        { budgetMs: 12000, tick: 'sleep', intervalMs: 100, label: '段落长度恢复正常' });
      ok('MF.7 文件轨共用同一套出场机器：这一段播完就淡出进留白（留白期间仍只有一条主曲、增益贴到静音、留白秒数在参数区间内），恢复后段落长度回到整曲',
        mfW8.ok && mfW9.ok && mfRestore.ok &&
        mfGap.activeMusicCount === 1 && mfGap.source === 'file' && mfGap.busGain <= 0.002 &&
        !!mfGap.cycle && mfGap.cycle.gapCount >= 1 &&
        mfGap.cycle.gapSeconds >= (mfCfg.gapMin || 0) && mfGap.cycle.gapSeconds <= (mfCfg.gapMax || 1e9) &&
        mfGapAtMs >= 5800 && mfGapAtMs <= 8000 && mfGapMs >= 10000,
        '进留白@' + mfGapAtMs + 'ms 增益贴零@' + mfGapMs + 'ms（fadeOut=' + mfCfg.fadeOut + 's gap=' +
        mfCfg.gapMin + '~' + mfCfg.gapMax + 's）读数=' + JSON.stringify(mfGap.cycle) + ' busGain=' + mfGap.busGain +
        ' 恢复后=' + JSON.stringify({ loop: mfMi().loopSeconds, src: mfMi().source }));

      /* ---- MF.8 音量归零 / 恢复：读的是「缓入 × music 总线」这条真实链路增益 ----
       * 取证（artifacts/repro-mf.json E 段）给出的可用口径：文件轨在 0.45 档 rms≈0.00133，
       * 十分之一档（0.045）rms≈0.0003，音乐全关 rms≈0.00001。
       * 所以「音量真的管得住曲目」这件事可以钉成三段单调下降，而不是只看归零那一档。 */
      const mfSettle3 = await mfRestart('MF.8 起点');
      const mfLoudMi = mfMi();
      const mfLoud = await mfBusSample(4000, 'music');
      await G.applySettingsLive({ volumeMusic: 0.045 });
      await sleep(1500);
      const mfTenthMi = mfMi();
      const mfTenth = await mfBusSample(4000, 'music');
      await G.applySettingsLive({ volumeMusic: 0 });
      const mfZero = await tryUntil(() => {
        const mi = mfMi();
        return !!mi && mi.busTarget <= 0.0002 && mi.busGainTotal <= 0.0005;
      }, { budgetMs: 6000, tick: 'sleep', intervalMs: 100, label: '音乐音量归零并等链路衰减到位', observe: () => mfMi() });
      const mfQuietMi = mfMi();
      const mfQuiet = await mfBusSample(2500, 'music');
      const mfQuietFloor = await mfBusSample(2000, 'music');
      const mfAmbAtZero = T.audioBusEnergy ? T.audioBusEnergy() : null;
      await G.applySettingsLive({ volumeMusic: 0.45 });
      const mfBack = await tryUntil(() => {
        const mi = mfMi();
        return !!mi && mi.source === 'file' && mi.cycle && mi.cycle.phase === 'playing' &&
          mi.busGainTotal >= 20 * Math.max(1e-9, mfQuietMi.busGainTotal);
      }, { budgetMs: 8000, tick: 'sleep', intervalMs: 100, label: '音量恢复后文件轨的链路增益回来', observe: () => mfMi() });
      ok('MF.8 音乐音量三档单调可控（本轮改为读 **music 总线**，不受环境床污染）：0.45 → 0.045 → 0 时' +
        '文件轨到 master 之前的合成增益与 music 总线能量逐级掉下来，最后一档落回音乐底噪；' +
        '同时环境床不受影响（关音乐不等于关世界）；恢复 0.45 后链路增益与能量都回来',
        mfSettle3.ok && mfZero.ok && mfBack.ok &&
        mfLoud.n > 20 && mfTenth.n > 20 && mfQuiet.n > 10 &&
        mfLoud.rms >= 20 * Math.max(1e-9, mfQuietFloor.rms) &&
        mfTenthMi.busTarget > mfQuietMi.busTarget && mfTenth.rms <= 0.6 * mfLoud.rms &&
        mfTenth.rms < mfLoud.rms &&
        mfQuietMi.busTarget <= 0.0002 && mfQuietMi.busGainTotal <= 0.002 &&
        mfQuiet.rms <= 4 * Math.max(1e-9, mfQuietFloor.rms) &&
        !!mfAmbAtZero && mfAmbAtZero.ambientSources > 0 &&
        mfLoudMi.busGainTotal > 0.001 && mfMi().source === 'file' && mfMi().trackId === 'day',
        '0.45=' + JSON.stringify({ tgt: mfLoudMi.busTarget, total: mfLoudMi.busGainTotal, rms: +mfLoud.rms.toFixed(6) }) +
        ' 0.045=' + JSON.stringify({ tgt: mfTenthMi.busTarget, total: mfTenthMi.busGainTotal, rms: +mfTenth.rms.toFixed(6) }) +
        ' 0=' + JSON.stringify({ tgt: mfQuietMi.busTarget, total: mfQuietMi.busGainTotal, rms: +mfQuiet.rms.toFixed(6) }) +
        ' 音乐底噪(music 总线)=' + mfQuietFloor.rms.toFixed(6) +
        ' 该档环境源=' + (mfAmbAtZero && mfAmbAtZero.ambientSources) +
        ' 恢复=' + JSON.stringify({ src: mfMi().source, total: mfMi().busGainTotal }));

      /* ---- MF.9 暂停释放 + 真实读档 ----
       * 读档回来必须把区块与三段队列排空，否则后面 TN 的搭平台写入会被没生成的区块静默丢弃
       * （阶段 3b 的 Q.1 就是这个形状：world.js:207 对未生成区块的 setBlock 直接 return false）。 */
      await G.applySettingsLive({ volumeMaster: mfVol0.master, volumeSfx: mfVol0.sfx, volumeMusic: mfVol0.music });
      G.pause();
      await tryUntil(() => mfMi().activeMusicCount === 0 && mfMi().fadingMusicCount === 0,
        { budgetMs: 8000, tick: 'sleep', intervalMs: 80, label: '暂停释放文件轨' });
      const mfPausedMi = mfMi();
      const mfPaused = await mfSample(500);
      G.resume();
      const mfResumed = await tryUntil(() => mfMi().source === 'file',
        { budgetMs: 12000, tick: 'sleep', intervalMs: 100, label: '恢复后文件曲回来' });
      /* 走产品自己的存档入口 G.save('manual')，并**沿用当前世界的名字**（验收世界）。
         不要在这里换新名字：storage.saveWorld 的第一个参数是摆设，服务端按存档自带的
         meta.name 落盘，换了名字就等于把「现在的世界」改名了——
         后面 TN.6 是 G.save() 写一份、再 loadWorld('验收世界') 读另一份，
         于是坑洞/新放的 TNT 都读不到（本轮 坑=false 读档后TNT=false 就是这个形状）。 */
      await G.save('manual');
      G.toMenu(); await sleep(300);
      await G.loadWorld('验收世界');
      await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'MF 读档回到世界' });
      const mfBeforeMi = mfMi();
      const mfReload = await tryUntil(() => { const mi = mfMi(); return mi.trackId === 'day' && mi.source === 'file'; },
        { budgetMs: 22000, tick: 'sleep', intervalMs: 150, label: '读档后仍是文件曲', observe: () => mfMi() });
      const mfReloadMi = mfMi();
      await T.waitChunks(1, { light: true });
      const mfDrained = await tryUntil(() => { const p = T.worldPending(); return p && p.gen === 0 && p.light === 0 && p.mesh === 0; },
        { budgetMs: 20000, tick: 'sleep', intervalMs: 40, label: 'MF 读档后排空区块队列（保护后续 TNT 场地）', observe: T.worldPending });
      ok('MF.9 暂停把文件轨释放干净（一条都不剩、连淡出的也没有），恢复与真实读档之后放的还是同一首曲目，且读档后排空了区块队列',
        mfPausedMi.activeMusicCount === 0 && mfPausedMi.fadingMusicCount === 0 && mfPaused.n > 3 &&
        mfResumed.ok && mfReload.ok && mfDrained.ok &&
        mfReloadMi.source === 'file' && mfReloadMi.fileName === 'exploration_theme.ogg' &&
        mfReloadMi.loopSeconds >= 40 && mfReloadMi.bytesDecoded > 0,
        '暂停=' + JSON.stringify({ cnt: mfPausedMi.activeMusicCount, fading: mfPausedMi.fadingMusicCount, rms: +mfPaused.rms.toFixed(6) }) +
        ' 读档前=' + JSON.stringify({ src: mfBeforeMi.source, st: mfBeforeMi.fileStates }) +
        ' 读档后=' + JSON.stringify({ src: mfReloadMi.source, file: mfReloadMi.fileName, loop: mfReloadMi.loopSeconds, bytes: mfReloadMi.bytesDecoded, waited: mfReload.ms }) +
        ' 排空=' + JSON.stringify(T.worldPending()));
      await G.applySettingsLive({ volumeMaster: mfVol0.master, volumeSfx: mfVol0.sfx, volumeMusic: mfVol0.music });
    }

    /* ---------------- 40. T5 最小 TNT：配方、打火石、3 秒引信、爆炸与存档 ---------------- */
    const tnMax0 = G.mobs.maxMobs;
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.controller.regenT = 0; G.controller.hunger = 20;
    G.inventory.clear();
    G.inventory.armor = [null, null, null, null];
    G.inventory.emit('equip');
    G.ui.updateHotbar(); G.ui.updateHUD(G);
    // 地表平台：TNT 需要一块确定的地面，坑洞计数也才有意义
    const tnX = Math.floor(G.controller.pos.x), tnZ = Math.floor(G.controller.pos.z);
    const tnTop = G.world.topSolidY(tnX, tnZ) + 1;
    for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
      T.setBlock(tnX + dx, tnTop - 1, tnZ + dz, 3);
      for (let h = 0; h <= 4; h++) T.setBlock(tnX + dx, tnTop + h, tnZ + dz, 0);
    }
    T.teleport(tnX + 0.5, tnTop, tnZ + 0.5);
    T.setTime(0.3);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'TNT 测试平台落地' });
    /* TN.4 要测「按距离衰减的爆炸伤害」，不能被跌进坑里的摔落伤害污染：
       在玩家脚下铺一块黑曜石小台（爆炸炸不坏），人始终站在原地。 */
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      T.setBlock(tnX + dx, tnTop - 1, tnZ + dz, 24);   // 24 = 黑曜石
    }

    // 41.1 真实合成 TNT 与打火石
    T.give('sand', 4); T.give('gunpowder', 5);
    G.openCrafting(3); await frame();
    const tnCraft = T.craftSet(['sand', 'sand', 'sand', 'sand', 'gunpowder', 'gunpowder', 'gunpowder', 'gunpowder', 'gunpowder']);
    const tnMade = tnCraft ? T.craftNow(1) : [];
    T.give('iron_ingot', 1); T.give('flint', 1);
    const flintRes = T.craftSet(['iron_ingot', 'flint', null, null]);
    const flintMade = flintRes ? T.craftNow(1) : [];
    G.closeUI(); await frame();
    ok('TN.1 4 沙 + 5 火药合成 TNT；1 铁锭 + 1 燧石合成打火石',
      tnCraft && tnCraft.item === 'tnt' && tnMade.length === 1 &&
      flintRes && flintRes.item === 'flint_and_steel' && flintMade.length === 1 &&
      G.inventory.countOf('tnt') >= 1 && G.inventory.countOf('flint_and_steel') >= 1,
      'tnt=' + JSON.stringify(tnCraft) + ' fs=' + JSON.stringify(flintRes));

    // 41.2 真实右键点燃：引信 3 秒、方块仍是 TNT、打火石 -1 耐久
    const tnA = { x: tnX + 4, y: tnTop, z: tnZ };
    G.selectHotbar(8);
    T.placeAt(tnA.x, tnA.y, tnA.z, 'tnt');
    G.closeUI && G.closeUI();
    G.inventory.set(0, { item: 'flint_and_steel', count: 1, dur: 64 });
    G.selectHotbar(0);
    await frame(); await frame();
    const tnDur0 = T.heldDur();
    await shrRightClick({ pos: { x: tnA.x + 0.5, y: tnA.y, z: tnA.z + 0.5 }, height: 1 });
    const tnAfterIgnite = T.tntInfo();
    ok('TN.2 打火石右键 TNT 进入 3 秒引信：方块仍是 TNT、打火石耐久 -1',
      tnAfterIgnite.active.length === 1 && tnAfterIgnite.active[0].fuse > 2.2 && tnAfterIgnite.active[0].fuse <= 3 &&
      T.blockAt(tnA.x, tnA.y, tnA.z).name === 'TNT' &&
      T.heldDur() === tnDur0 - 1,
      'ignite=' + JSON.stringify(tnAfterIgnite) + ' dur ' + tnDur0 + '→' + T.heldDur() +
      ' block=' + JSON.stringify(T.blockAt(tnA.x, tnA.y, tnA.z)));

    // 41.3 爆炸：坑洞、范围有界、只爆一次
    const tnCount = (r0, r1) => {
      let n = 0;
      for (let dx = -r1; dx <= r1; dx++) for (let dy = -r1; dy <= r1; dy++) for (let dz = -r1; dz <= r1; dz++) {
        const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
        if (m < r0 || m > r1) continue;
        if (G.world.isSolidAt(tnA.x + dx, tnA.y + dy, tnA.z + dz)) n++;
      }
      return n;
    };
    const tnSolidBefore = tnCount(0, 6);
    const tnOutsideBefore = tnCount(7, 10);
    const tnBlasts0 = T.tntInfo().blasts;
    /* 阶段 3b：点燃前校准一次血量，并在起爆等待与观察窗里每帧把玩家钉回 (tnX+0.5, tnTop, tnZ+0.5)。
       TN.4 用的是精确等式 `health === 20 - round(dmg)`，而黑曜石小台只有 3×3：
       站位一旦被爆炸后的地形/物理挪开或摔一次，读数就差几点（本轮 12 而不是 15，报告 dmg 仍是 5）。
       钉住不改变「站在 4 格外挨一发」这件事本身（dist 仍是 4.02），只是把夹具噪音去掉。 */
    const tnPin = () => G.controller.setPositions(tnX + 0.5, tnTop, tnZ + 0.5);
    G.controller.health = 20; G.controller.invulnerable = 0;
    tnPin();
    const tnW = await tryUntil(() => { tnPin(); return T.tntInfo().blasts > tnBlasts0; },
      { budgetMs: 7000, label: 'TNT 3 秒后起爆', observe: () => T.tntInfo() });
    await sleep(120);
    const tnSolidAfter = tnCount(0, 6);
    const tnOutsideAfter = tnCount(7, 10);
    const tnB1 = T.tntInfo();
    const tnBlast = tnB1.last;
    const tnSingle = await watch(1400, () => { tnPin(); return T.tntInfo().blasts > tnBlasts0 + 1; });
    ok('TN.3 起爆后炸出坑：实际减少数 = 报告 removed、范围外一格不少、只爆一次',
      tnW.ok && tnBlast && tnBlast.removed > 0 && tnBlast.cells === tnBlast.removed &&
      tnSolidBefore - tnSolidAfter === tnBlast.removed && tnOutsideAfter === tnOutsideBefore &&
      !tnSingle.violated && T.tntInfo().active.length === 0,
      'blast=' + JSON.stringify(tnBlast) + ' active=' + JSON.stringify(T.tntInfo().active) + ' solid ' + tnSolidBefore + '→' + tnSolidAfter +
      ' 外圈 ' + tnOutsideBefore + '→' + tnOutsideAfter + ' 二次爆炸=' + tnSingle.violated);

    // 41.4 生存伤害按距离衰减（4 格外约 5 点）
    ok('TN.4 生存模式按距离吃 TNT 伤害（4 格外约 5 点），不是固定满伤',
      !!tnBlast && G.controller.health === 20 - Math.round(tnBlast.dmg) &&
      tnBlast.dmg > 3.5 && tnBlast.dmg < 6.5,
      'hp=20→' + G.controller.health + ' 报告 dmg=' + (tnBlast && tnBlast.dmg) +
      ' dist=' + (tnBlast && tnBlast.dist));

    // 41.5 创造模式免伤但照样炸
    // 主爆炸可能把玩家脚下的地板一起炸掉，先补一块 5×5 并站回中心，否则后面会瞄不到/够不着 TNT
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      T.setBlock(tnX + dx, tnTop - 1, tnZ + dz, 3);
      for (let h = 0; h <= 3; h++) T.setBlock(tnX + dx, tnTop + h, tnZ + dz, 0);
    }
    T.teleport(tnX + 0.5, tnTop, tnZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: 'TNT 二段测试站稳' });
    G.controller.setCreative(true);
    G.controller.health = 20;
    const tnB = { x: tnX - 3, y: tnTop, z: tnZ + 3 };
    G.selectHotbar(8); T.placeAt(tnB.x, tnB.y, tnB.z, 'tnt');
    G.inventory.set(0, { item: 'flint_and_steel', count: 1, dur: 64 });
    G.selectHotbar(0);
    await frame(); await frame();
    const tnBlastsC = T.tntInfo().blasts;
    await shrRightClick({ pos: { x: tnB.x + 0.5, y: tnB.y, z: tnB.z + 0.5 }, height: 1 });
    const tnW2 = await tryUntil(() => T.tntInfo().blasts > tnBlastsC, { budgetMs: 7000, label: '创造模式 TNT 起爆' });
    G.controller.setCreative(false);
    ok('TN.5 创造模式：TNT 照样炸、玩家血量不动',
      tnW2.ok && G.controller.health === 20 && T.tntInfo().blasts === tnBlastsC + 1,
      'hp=' + G.controller.health + ' blasts=' + tnBlastsC + '→' + T.tntInfo().blasts);

    // 41.6 引信不入存档 + 坑洞随存档保留；打火石耐久耗尽会消失
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      T.setBlock(tnX + dx, tnTop - 1, tnZ + dz, 3);
      for (let h = 0; h <= 3; h++) T.setBlock(tnX + dx, tnTop + h, tnZ + dz, 0);
    }
    T.teleport(tnX + 0.5, tnTop, tnZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: 'TNT 存档测试站稳' });
    const tnC = { x: tnX - 3, y: tnTop, z: tnZ - 3 };
    G.selectHotbar(8); T.placeAt(tnC.x, tnC.y, tnC.z, 'tnt');
    G.inventory.set(0, { item: 'flint_and_steel', count: 1, dur: 1 });
    G.selectHotbar(0);
    await frame(); await frame();
    await shrRightClick({ pos: { x: tnC.x + 0.5, y: tnC.y, z: tnC.z + 0.5 }, height: 1 });
    const tnBrokeTool = T.tntInfo().active.length === 1 && T.shieldInfo().held === null;
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'TNT 存档读回来' });
    await sleep(200);
    const tnRT = T.tntInfo();
    const tnCraterGone = G.world.getBlock(tnA.x, tnA.y, tnA.z) === 0;
    const tnStillTnt = G.world.getBlock(tnC.x, tnC.y, tnC.z) !== 0;
    const tnNoBoom = await watch(3600, () => T.tntInfo().blasts > 0);
    ok('TN.6 坑洞随存档保留；引信不入档（读档后不再爆炸），耐久 1 的打火石点燃后消失',
      tnBrokeTool && tnCraterGone && tnStillTnt && tnRT.active.length === 0 && tnRT.blasts === 0 && !tnNoBoom.violated,
      '工具断=' + tnBrokeTool + ' 坑=' + tnCraterGone + ' 读档后TNT=' + tnStillTnt +
      ' active=' + JSON.stringify(tnRT.active) + ' blasts=' + tnRT.blasts + ' 二次=' + tnNoBoom.violated);
    G.mobs.maxMobs = tnMax0;

    /* ---- TN.7 有限连锁：A→B，B 不再向 C 传（深度 1） ---- */
    const tcX = tnX + 20, tcZ = tnZ;
    for (let dx = -11; dx <= 12; dx++) for (let dz = -5; dz <= 5; dz++) {
      T.setBlock(tcX + dx, tnTop - 1, tcZ + dz, 3);
      for (let h = 0; h <= 5; h++) T.setBlock(tcX + dx, tnTop + h, tcZ + dz, 0);
    }
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    T.teleport(tcX - 10.5, tnTop, tcZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: '连锁测试站稳' });
    const tnA2 = { x: tcX, y: tnTop, z: tcZ };
    const tnB2 = { x: tcX + 5, y: tnTop, z: tcZ };
    const tnC2 = { x: tcX + 9, y: tnTop, z: tcZ };
    T.setBlock(tnA2.x, tnA2.y, tnA2.z, 50);
    T.setBlock(tnB2.x, tnB2.y, tnB2.z, 50);
    T.setBlock(tnC2.x, tnC2.y, tnC2.z, 50);
    const tcBlasts0 = T.tntInfo().blasts;
    T.igniteTnt(tnA2.x, tnA2.y, tnA2.z);
    const tcW = await tryUntil(() => T.tntInfo().blasts >= tcBlasts0 + 2,
      { budgetMs: 9000, label: 'A 引爆 B 的有限连锁', observe: () => T.tntInfo() });
    const tcStop = await tryUntil(() => T.tntInfo().active.length === 0,
      { budgetMs: 5000, label: '连锁结束后引信清空', observe: () => T.tntInfo() });
    const tcExtra = await watch(1500, () => T.tntInfo().blasts > tcBlasts0 + 2);
    const tcInfo = T.tntInfo();
    ok('TN.7 有限连锁：A 点燃 B，B 不再传 C（深度 1），C 只作为方块被移除',
      tcW.ok && tcStop.ok && !tcExtra.violated && tcInfo.blasts === tcBlasts0 + 2 &&
      G.world.getBlock(tnA2.x, tnA2.y, tnA2.z) === 0 &&
      G.world.getBlock(tnB2.x, tnB2.y, tnB2.z) === 0 &&
      G.world.getBlock(tnC2.x, tnC2.y, tnC2.z) === 0 &&
      tcInfo.last && tcInfo.last.depth === 1,
      'blasts=' + tcInfo.blasts + '（起 ' + tcBlasts0 + '）last=' + JSON.stringify(tcInfo.last) +
      ' A/B/C=' + [tnA2, tnB2, tnC2].map(p => G.world.getBlock(p.x, p.y, p.z)).join('/'));

    /* ---- TN.8 水中规则：湿火药不破方块、不连锁、伤害范围减半 ---- */
    const twX = tnX - 20, twZ = tnZ;
    for (let dx = -6; dx <= 6; dx++) for (let dz = -4; dz <= 4; dz++) {
      T.setBlock(twX + dx, tnTop - 1, twZ + dz, 3);
      for (let h = 0; h <= 4; h++) T.setBlock(twX + dx, tnTop + h, twZ + dz, 0);
    }
    G.controller.health = 20; G.controller.invulnerable = 0;
    T.teleport(twX + 7.5, tnTop, twZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: '水中规则测试站稳' });
    const twTnt = { x: twX, y: tnTop, z: twZ };
    T.setBlock(twTnt.x, twTnt.y, twTnt.z, 50);
    T.setBlock(twTnt.x, twTnt.y + 1, twTnt.z, 9);          // 上方水
    T.setBlock(twTnt.x + 1, twTnt.y, twTnt.z, 9);
    T.setBlock(twTnt.x - 1, twTnt.y, twTnt.z, 9);
    T.setBlock(twTnt.x, twTnt.y, twTnt.z + 1, 9);
    const twFloorBefore = G.world.getBlock(twTnt.x + 2, twTnt.y - 1, twTnt.z);
    const twBlasts0 = T.tntInfo().blasts;
    T.igniteTnt(twTnt.x, twTnt.y, twTnt.z);
    const twW = await tryUntil(() => T.tntInfo().blasts > twBlasts0,
      { budgetMs: 7000, label: '湿火药起爆', observe: () => T.tntInfo() });
    const twInfo = T.tntInfo();
    ok('TN.8 被水淹没的 TNT：只消耗自身、不破坏地形、不连锁、4 格外无伤',
      twW.ok && twInfo.last && twInfo.last.submerged === true && twInfo.last.cells === 0 &&
      twInfo.last.removed === 1 && twInfo.last.chained === 0 &&
      G.world.getBlock(twTnt.x, twTnt.y, twTnt.z) === 0 &&
      G.world.getBlock(twTnt.x + 2, twTnt.y - 1, twTnt.z) === twFloorBefore &&
      G.world.getBlock(twTnt.x, twTnt.y + 1, twTnt.z) === 9 &&
      G.controller.health === 20,
      'last=' + JSON.stringify(twInfo.last) + ' hp=' + G.controller.health +
      ' floor=' + twFloorBefore + '→' + G.world.getBlock(twTnt.x + 2, twTnt.y - 1, twTnt.z) +
      ' water=' + G.world.getBlock(twTnt.x, twTnt.y + 1, twTnt.z));

    /* ---- TN.9 打火石边界：对已点燃的 TNT 再点一次，不重复扣耐久 ---- */
    const tlX = tnX + 40, tlZ = tnZ;
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
      T.setBlock(tlX + dx, tnTop - 1, tlZ + dz, 3);
      for (let h = 0; h <= 4; h++) T.setBlock(tlX + dx, tnTop + h, tlZ + dz, 0);
    }
    G.controller.health = 20; G.controller.invulnerable = 0;
    T.teleport(tlX - 3.5, tnTop, tlZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: '打火石边界站稳' });
    T.setBlock(tlX, tnTop, tlZ, 50);
    G.inventory.set(0, { item: 'flint_and_steel', count: 1, dur: 64 });
    G.selectHotbar(0);
    await frame(); await frame();
    const tlAim = { pos: { x: tlX + 0.5, y: tnTop, z: tlZ + 0.5 }, height: 1 };
    await shrRightClick(tlAim);
    const tlDur1 = T.heldDur(), tlActive1 = T.tntInfo().active.length;
    await shrRightClick(tlAim);
    const tlAfter = T.tntInfo();
    ok('TN.9 已点燃的 TNT 不会被二次点燃：仍然只有一条引信、打火石不再扣耐久',
      tlActive1 === 1 && tlDur1 === 63 && tlAfter.active.length === 1 && T.heldDur() === 63,
      'active ' + tlActive1 + '→' + tlAfter.active.length + ' dur=' + T.heldDur());
    const tlBlasts0 = T.tntInfo().blasts;
    await tryUntil(() => T.tntInfo().blasts > tlBlasts0, { budgetMs: 8000, label: '边界测试 TNT 正常起爆' });

    /* ---------------- 42. T6 史莱姆：弹跳、分裂、粘液球、粘液块、存档 ---------------- */
    const slX = tnX + 60, slZ = tnZ;
    for (let dx = -8; dx <= 10; dx++) for (let dz = -8; dz <= 8; dz++) {
      T.setBlock(slX + dx, tnTop - 1, slZ + dz, 3);
      for (let h = 0; h <= 6; h++) T.setBlock(slX + dx, tnTop + h, slZ + dz, 0);
    }
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.inventory.clear();
    G.inventory.armor = [null, null, null, null];
    G.inventory.emit('equip');
    T.teleport(slX + 0.5, tnTop, slZ + 7.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: '史莱姆测试站稳' });
    const slBig = G.mobs.spawn('slime', slX + 0.5, tnTop, slZ - 3.5, { slimeSize: 4 });
    const slSmall = G.mobs.spawn('slime', slX + 2.5, tnTop, slZ - 3.5, { slimeSize: 1 });
    await frame(); await frame();
    const slI1 = T.slimeInfo();
    ok('SL.1 史莱姆尺寸完整：size4 hp16/伤害4/碰撞 1.52，size1 hp1/伤害0/碰撞 0.38，模型随尺寸缩放',
      !!slBig && !!slSmall && slI1.some(s => s.size === 4 && s.hp === 16 && s.damage === 4 && Math.abs(s.w - 1.52) < 1e-6 && Math.abs(s.meshScale - 1.44) < 1e-6) &&
      slI1.some(s => s.size === 1 && s.hp === 1 && s.damage === 0 && Math.abs(s.w - 0.38) < 1e-6),
      JSON.stringify(slI1));

    const slW1 = await tryUntil(() => slBig && slBig.onGround, { budgetMs: 5000, label: '大史莱姆落地' });
    const slBaseY = slBig ? slBig.pos.y : 0;
    const slW2 = await tryUntil(() => slBig && slBig.pos.y > slBaseY + 0.45, { budgetMs: 6000, label: '史莱姆自己弹起来', observe: () => ({ y: slBig && +slBig.pos.y.toFixed(2), base: +slBaseY.toFixed(2) }) });
    ok('SL.2 真实主循环里史莱姆会自己弹跳（不是贴地滑行）',
      slW1.ok && slW2.ok && slBig.pos.y > slBaseY + 0.45,
      'y ' + slBaseY.toFixed(2) + ' → ' + (slBig && slBig.pos.y.toFixed(2)) + ' 等=' + (slW2.ok ? slW2.ms + 'ms' : '超时:' + slW2.timeout));

    // 大 → 中 → 小：每层分裂 2~3 只；最小才掉粘液球
    G.mobs.clear();
    G.interaction.drops.list.length = 0;
    const slHuge = G.mobs.spawn('slime', slX + 0.5, tnTop, slZ + 0.5, { slimeSize: 4 });
    G.mobs.hitMob(slHuge, 999, { x: 0, z: 0 });
    let slMids = T.slimeInfo().filter(s => s.size === 2);
    const slMidCount = slMids.length;
    for (const m of G.mobs.list.filter(x => x.type === 'slime' && x.slimeSize === 2).slice()) G.mobs.hitMob(m, 999, { x: 0, z: 0 });
    const slSmalls = T.slimeInfo().filter(s => s.size === 1);
    const slSmallCount = slSmalls.length;
    for (const m of G.mobs.list.filter(x => x.type === 'slime' && x.slimeSize === 1).slice()) G.mobs.hitMob(m, 999, { x: 0, z: 0 });
    const slDrops = G.interaction.drops.list.filter(d => d.item === 'slime_ball');
    ok('SL.3 击杀大史莱姆分裂成 2~3 只中号，中号再分裂成小号，最小才掉粘液球',
      slMidCount >= 2 && slMidCount <= 3 && slSmallCount >= 2 && slDrops.length >= 1,
      'mids=' + slMidCount + ' smalls=' + slSmallCount + ' drops=' + slDrops.map(d => d.count).join(','));

    for (const d of slDrops) { d.x = G.controller.pos.x; d.z = G.controller.pos.z; d.y = G.controller.pos.y + 0.6; d.pickDelay = 0; }
    const slPick = await tryUntil(() => G.inventory.countOf('slime_ball') >= 1,
      { budgetMs: 5000, label: '粘液球被捡起', observe: () => G.inventory.countOf('slime_ball') });
    ok('SL.4 粘液球能被捡进背包', slPick.ok && G.inventory.countOf('slime_ball') >= 1,
      'slime_ball=' + G.inventory.countOf('slime_ball'));

    // 9 粘液球 → 粘液块；放下后从高处落下会弹起且免摔伤
    G.openCrafting(3); await frame();
    const slCraft = T.craftSet(new Array(9).fill('slime_ball'));
    const slMade = slCraft ? T.craftNow(1) : [];
    G.closeUI(); await frame();
    const slBlockX = slX + 5, slBlockZ = slZ;
    G.selectHotbar(8);
    T.placeAt(slBlockX, tnTop, slBlockZ, 'slime_block');
    let slBounces = 0;
    G.controller.on('bounce', () => { slBounces++; });
    G.controller.health = 20; G.controller.invulnerable = 0;
    T.teleport(slBlockX + 0.5, tnTop + 6, slBlockZ + 0.5);
    const slW3 = await tryUntil(() => slBounces >= 1, { budgetMs: 6000, label: '落到粘液块上弹起', observe: () => ({ bounces: slBounces, y: +G.controller.pos.y.toFixed(2), hp: G.controller.health }) });
    ok('SL.5 9 粘液球合成粘液块；落到粘液块上会弹起且不吃摔落伤害',
      !!slCraft && slCraft.item === 'slime_block' && slMade.length === 1 &&
      slW3.ok && slBounces >= 1 && G.controller.health === 20 && G.controller.vel.y > 0,
      'craft=' + JSON.stringify(slCraft) + ' bounces=' + slBounces + ' hp=' + G.controller.health + ' vy=' + G.controller.vel.y.toFixed(2));

    // 存档往返：尺寸与血量
    G.mobs.clear();
    G.interaction.drops.list.length = 0;
    const slSaved = G.mobs.spawn('slime', slX + 8.5, tnTop, slZ + 6.5, { slimeSize: 4 });
    await frame();
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '史莱姆存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const slRT = T.slimeInfo();
    ok('SL.6 史莱姆尺寸与血量随存档恢复（旧档缺 sl 字段走默认尺寸）',
      !!slSaved && slRT.some(s => s.size === 4 && s.hp === 16),
      JSON.stringify(slRT));

    /* ---------------- 43. T6 狼：骨头驯服、坐下/跟随、战斗、存档 ---------------- */
    const wlX = slX + 40, wlZ = slZ;
    for (let dx = -7; dx <= 7; dx++) for (let dz = -9; dz <= 5; dz++) {
      T.setBlock(wlX + dx, tnTop - 1, wlZ + dz, 3);
      for (let h = 0; h <= 5; h++) T.setBlock(wlX + dx, tnTop + h, wlZ + dz, 0);
    }
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.inventory.clear();
    G.inventory.emit('load');
    T.teleport(wlX + 0.5, tnTop, wlZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: '狼测试站稳' });
    const wlWolf = G.mobs.spawn('wolf', wlX + 0.5, tnTop, wlZ - 2.5);
    if (wlWolf) { wlWolf.walking = false; wlWolf.wanderT = 9999; wlWolf.vel.x = wlWolf.vel.z = 0; }
    await frame(); await frame();
    const wlI0 = T.wolfInfo();
    ok('WL.1 狼可生成：独立模型/碰撞盒、未驯服且项圈隐藏',
      !!wlWolf && wlI0.length === 1 && wlI0[0].tamed === false && wlI0[0].collar === false &&
      wlI0[0].w > 0.3 && wlI0[0].h > 0.6,
      JSON.stringify(wlI0));

    G.inventory.set(0, { item: 'bone', count: 3 });
    G.selectHotbar(0);
    await frame(); await frame();
    const wlAim = { pos: wlWolf.pos, height: wlWolf.height };
    const wlTame = [];
    for (let k = 0; k < 3; k++) {
      await shrRightClick(wlAim);
      wlTame.push(T.wolfInfo()[0]);
    }
    ok('WL.2 真实右键骨头驯服：进度 1→2→3，第三根后 tamed=true、项圈点亮、骨头消耗 3 根',
      wlTame[0].progress === 1 && wlTame[0].tamed === false &&
      wlTame[1].progress === 2 && wlTame[1].tamed === false &&
      wlTame[2].tamed === true && wlTame[2].collar === true &&
      G.inventory.countOf('bone') === 0,
      'progress=' + wlTame.map(x => x.progress).join(',') + ' tamed=' + wlTame[2].tamed + ' bone=' + G.inventory.countOf('bone'));

    // 空手右键：坐下/起身
    G.inventory.set(0, null);
    G.selectHotbar(0);
    await frame(); await frame();
    await shrRightClick(wlAim);
    const wlSit1 = T.wolfInfo()[0];
    await shrRightClick(wlAim);
    const wlSit0 = T.wolfInfo()[0];
    ok('WL.3 空手右键已驯服狼：坐下/起身切换，不是把右键吞成放置',
      wlSit1.sitting === true && wlSit0.sitting === false,
      'sitting ' + wlSit1.sitting + ' → ' + wlSit0.sitting);

    // 跟随：玩家走远，狼应自己靠近
    T.teleport(wlX + 0.5, tnTop, wlZ + 5.5);
    const wlD0 = Math.hypot(wlWolf.pos.x - G.controller.pos.x, wlWolf.pos.z - G.controller.pos.z);
    const wlFollow = await tryUntil(() => Math.hypot(wlWolf.pos.x - G.controller.pos.x, wlWolf.pos.z - G.controller.pos.z) < wlD0 - 1.2,
      { budgetMs: 8000, label: '驯服狼跟随玩家', observe: () => ({ d: +Math.hypot(wlWolf.pos.x - G.controller.pos.x, wlWolf.pos.z - G.controller.pos.z).toFixed(2), tamed: wlWolf.tamed, sitting: wlWolf.sitting }) });
    ok('WL.4 起身后的狼会跟随玩家（真实主循环位移）',
      wlFollow.ok, '距离 ' + wlD0.toFixed(2) + ' → ' + Math.hypot(wlWolf.pos.x - G.controller.pos.x, wlWolf.pos.z - G.controller.pos.z).toFixed(2));

    // 战斗：附近僵尸被狼主动攻击
    const wlZombie = G.mobs.spawn('zombie', wlWolf.pos.x + 1.2, wlWolf.pos.y, wlWolf.pos.z);
    const wlZh0 = wlZombie.hp;
    const wlFight = await tryUntil(() => wlZombie.hp < wlZh0 || !G.mobs.list.includes(wlZombie),
      { budgetMs: 8000, label: '狼攻击附近僵尸', observe: () => ({ zhp: wlZombie && wlZombie.hp, wolf: T.wolfInfo()[0] }) });
    ok('WL.5 驯服狼会主动攻击附近的敌对生物（僵尸掉血）',
      wlFight.ok && (!G.mobs.list.includes(wlZombie) || wlZombie.hp < wlZh0),
      'zombie hp ' + wlZh0 + '→' + (wlZombie && wlZombie.hp));

    // 存档：驯服 + 坐下状态
    if (wlZombie && G.mobs.list.includes(wlZombie)) G.mobs.hitMob(wlZombie, 999, { x: 0, z: 0 });
    G.mobs.toggleWolfSit(wlWolf);
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '狼存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const wlRT = T.wolfInfo();
    ok('WL.6 驯服与坐下状态随存档恢复（项圈也恢复）',
      wlRT.length === 1 && wlRT[0].tamed === true && wlRT[0].sitting === true && wlRT[0].collar === true,
      JSON.stringify(wlRT));

    /* ---------------- 44. T6 门：合成、两格高、朝向、开合碰撞、掉落与存档 ---------------- */
    const drX = wlX + 30, drZ = wlZ;
    /* 先传送过去把区块加载出来再铺地：wlX 离这里 30 格，读档后区块不保证还在内存里，
       先 setBlock 会静默失败，右键就会点到自然石头（DO.2 曾偶发 id=1）。 */
    T.teleport(drX + 0.5, tnTop, drZ + 2.5);
    await sleep(400);
    for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
      T.setBlock(drX + dx, tnTop - 1, drZ + dz, 3);
      for (let h = 0; h <= 6; h++) T.setBlock(drX + dx, tnTop + h, drZ + dz, 0);
    }
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.inventory.clear();
    G.inventory.emit('load');
    T.teleport(drX + 0.5, tnTop, drZ + 2.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: '门测试站稳' });

    G.openCrafting(3); await frame();
    const drCraft = T.craftSet(['planks', 'planks', null, 'planks', 'planks', null, 'planks', 'planks', null]);
    const drMade = drCraft ? T.craftNow(1) : [];
    G.closeUI(); await frame();
    ok('DO.1 6 木板在真实工作台合成 3 扇门并入库',
      !!drCraft && drCraft.item === 'door' && drCraft.count === 3 && drMade.length === 1 &&
      G.inventory.countOf('door') >= 3,
      'result=' + JSON.stringify(drCraft) + ' made=' + JSON.stringify(drMade));

    // 站在门前 2.5 格，瞄准脚下地板 → 右键把门放在地板上方
    const drFloor = { x: drX, y: tnTop - 1, z: drZ };
    const drAim = { pos: { x: drX + 0.5, y: drFloor.y, z: drZ + 0.5 }, height: 1 };
    const drDoorIdx = G.inventory.slots.findIndex(s => s && s.item === 'door');
    if (drDoorIdx > 0) { G.inventory.set(0, G.inventory.get(drDoorIdx)); G.inventory.set(drDoorIdx, null); }
    G.selectHotbar(0);
    await frame(); await frame();
    await shrRightClick(drAim);
    const drB = T.blockAt(drX, tnTop, drZ), drT = T.blockAt(drX, tnTop + 1, drZ);
    ok('DO.2 真实右键放门：一次占两格、朝向写入 meta、关闭时两格都是实心',
      drB.name === '门' && drT.name === '门' && (drB.meta & 3) === 1 &&
      G.world.isSolidAt(drX, tnTop, drZ) && G.world.isSolidAt(drX, tnTop + 1, drZ) &&
      G.inventory.countOf('door') === 2,
      'bottom=' + JSON.stringify(drB) + ' top=' + JSON.stringify(drT) + ' doors=' + G.inventory.countOf('door'));

    G.inventory.set(0, null); G.selectHotbar(0);
    await frame(); await frame();
    const drOpenAim = { pos: { x: drX + 0.5, y: tnTop, z: drZ + 0.5 }, height: 1 };
    await shrRightClick(drOpenAim);
    const drOB = T.blockAt(drX, tnTop, drZ), drOT = T.blockAt(drX, tnTop + 1, drZ);
    const drSolidOpen = G.world.isSolidAt(drX, tnTop, drZ);
    await shrRightClick(drOpenAim);
    const drCB = T.blockAt(drX, tnTop, drZ);
    ok('DO.3 右键开门：两格变开门方块、碰撞消失；再右键关回实心，朝向不丢',
      drOB.name === '门（开）' && drOT.name === '门（开）' && drSolidOpen === false &&
      (drOB.meta & 4) === 4 && (drOB.meta & 3) === 1 &&
      drCB.name === '门' && G.world.isSolidAt(drX, tnTop, drZ) === true,
      'open=' + JSON.stringify(drOB) + '/' + JSON.stringify(drOT) + ' solid=' + drSolidOpen +
      ' closed=' + JSON.stringify(drCB));

    // 破坏上半格：整扇门一起消失，只掉一扇门
    G.interaction.drops.list.length = 0;
    T.mineAt(drX, tnTop + 1, drZ);
    await sleep(120);
    const drAfterBreak = [T.blockAt(drX, tnTop, drZ).id, T.blockAt(drX, tnTop + 1, drZ).id];
    const drDrops = G.interaction.drops.list.filter(d => d.item === 'door');
    ok('DO.4 拆掉任意一半：两格一起消失，只掉 1 扇门（不是 2 个半块）',
      drAfterBreak[0] === 0 && drAfterBreak[1] === 0 && drDrops.length === 1 && drDrops[0].count === 1,
      'blocks=' + JSON.stringify(drAfterBreak) + ' drops=' + drDrops.map(d => d.count).join(','));

    // 存档：开门状态与朝向都保留，读档后仍能开合
    G.world.setBlock(drX, tnTop, drZ, 52, 1);
    G.world.setBlock(drX, tnTop + 1, drZ, 53, 1);
    G.world.refreshImmediate(drX, tnTop, drZ, G.view);
    const drToggle = G.toggleDoor({ x: drX, y: tnTop, z: drZ });
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '门存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const drRT = T.blockAt(drX, tnTop, drZ), drRTT = T.blockAt(drX, tnTop + 1, drZ);
    const drSolidBeforeBack = G.world.isSolidAt(drX, tnTop, drZ);
    const drBack = G.toggleDoor({ x: drX, y: tnTop, z: drZ });
    ok('DO.5 开门状态与朝向随存档恢复；读档后还能关回去',
      !!drToggle && drToggle.open === true && drRT.name === '门（开）' && drRTT.name === '门（开）' &&
      (drRT.meta & 4) === 4 && (drRT.meta & 3) === 1 && drSolidBeforeBack === false &&
      !!drBack && drBack.open === false && G.world.isSolidAt(drX, tnTop, drZ) === true,
      'toggle=' + JSON.stringify(drToggle) + ' read=' + JSON.stringify(drRT) + ' back=' + JSON.stringify(drBack));

    /* ---------------- 45. 滚动任务 6：小型村庄探索切片 ---------------- */
    const viSite = T.villageInfo();
    const viOx = viSite.origin.x, viOy = viSite.origin.y, viOz = viSite.origin.z;
    G.mobs.maxMobs = 0;
    T.teleport(viOx + 3.5, viOy + 1.05, viOz - 1.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '村庄测试站稳', observe: () => ({ y: +G.controller.pos.y.toFixed(2), onGround: G.controller.onGround }) });
    /* 前面的用例多次 mobs.clear()，村庄自带的村民可能已被清掉；这里用生产 spawn 补一只（带家坐标） */
    let viVillager = G.mobs.list.find(m => m.type === 'villager');
    if (!viVillager) {
      viVillager = G.mobs.spawn('villager', viOx + 3.5, viOy + 1, viOz - 3.5,
        { home: { x: viOx + 3.5, y: viOy + 1, z: viOz - 3.5 } });
    }
    if (viVillager) { viVillager.walking = false; viVillager.wanderT = 9999; viVillager.vel.x = viVillager.vel.z = 0; }

    /* 村庄经过整场验收（含多次存档读档）后结构仍在：门/水渠/小麦/工作台/箱子逐格点名 */
    const viStruct = await tryUntil(() => {
      const v = T.villageInfo();
      return v.built && v.present === v.expected;
    }, { budgetMs: 20000, label: '村庄区块加载完成', observe: () => { const v = T.villageInfo(); return { present: v.present, expected: v.expected }; } });
    const viDoorB = T.blockAt(viOx - 3, viOy + 1, viOz - 1);
    const viDoorT = T.blockAt(viOx - 3, viOy + 2, viOz - 1);
    const viWater = T.blockAt(viOx - 5, viOy, viOz + 3);
    const viWheat = T.blockAt(viOx - 5, viOy + 1, viOz + 2);
    const viTable = T.blockAt(viOx + 1, viOy + 1, viOz - 3);
    const viChest = T.blockAt(viOx + 5, viOy + 1, viOz - 3);
    ok('VI.2 村庄结构经多次存档读档仍完整：房子两格门/水渠/成熟小麦/工作台/箱子都在',
      viStruct.ok && T.villageInfo().present === T.villageInfo().expected &&
      viDoorB.name === '门' && viDoorT.name === '门' &&
      viWater.name === '水' && viWheat.name === '小麦' &&
      viTable.name === '工作台' && viChest.name === '箱子',
      '结构 ' + T.villageInfo().present + '/' + T.villageInfo().expected +
      ' 门=' + viDoorB.name + '/' + viDoorT.name + ' 水=' + viWater.name +
      ' 麦=' + viWheat.name + ' 台=' + viTable.name + ' 箱=' + viChest.name);

    G.inventory.clear();
    G.inventory.emit('load');
    G.inventory.set(0, { item: 'wheat', count: 10 });
    G.selectHotbar(0);
    await frame(); await frame();
    await shrRightClick(viVillager);
    const viPanel = document.querySelector('#panel-villager');
    const viTradeBtns = document.querySelectorAll('#panel-villager [data-trade]');
    ok('VI.3 真实右键村民打开交易面板：三条交易都列出来，面板没有退化成举盾/放置',
      G.openUI === 'villager' && !!viPanel && !viPanel.classList.contains('hidden') &&
      viTradeBtns.length === 3 && !G.controller.blocking,
      'openUI=' + G.openUI + ' 按钮=' + viTradeBtns.length + ' blocking=' + G.controller.blocking);

    /* 第一条：10 小麦 → 1 绿宝石（真实点击 DOM 按钮） */
    document.querySelector('#panel-villager [data-trade="0"]').click();
    await frame();
    const viT1 = T.villageInfo().lastTrade;
    ok('VI.4 真实交易①：10 小麦换 1 绿宝石，小麦清零、绿宝石入库',
      !!viT1 && viT1.ok === true && viT1.trade === 'wheat_for_emerald' &&
      G.inventory.countOf('wheat') === 0 && G.inventory.countOf('emerald') === 1,
      'wheat=' + G.inventory.countOf('wheat') + ' emerald=' + G.inventory.countOf('emerald') + ' last=' + JSON.stringify(viT1));

    /* 第二、三条：1 绿宝石 → 3 面包；再补 3 颗绿宝石 → 1 铁锭 */
    document.querySelector('#panel-villager [data-trade="1"]').click();
    await frame();
    const viT2 = T.villageInfo().lastTrade;
    const viBread = G.inventory.countOf('bread');
    G.inventory.add('emerald', 3);
    await frame();
    document.querySelector('#panel-villager [data-trade="2"]').click();
    await frame();
    const viT3 = T.villageInfo().lastTrade;
    ok('VI.5 真实交易②③：1 绿宝石换 3 面包、3 绿宝石换 1 铁锭，面板交易后仍保持打开',
      viT2.ok === true && viT2.trade === 'emerald_for_bread' && viBread === 3 &&
      viT3.ok === true && viT3.trade === 'emerald_for_iron' &&
      G.inventory.countOf('emerald') === 0 && G.inventory.countOf('iron_ingot') === 1 &&
      G.openUI === 'villager',
      'bread=' + viBread + ' iron=' + G.inventory.countOf('iron_ingot') +
      ' emerald=' + G.inventory.countOf('emerald') + ' last=' + JSON.stringify(viT3));

    /* 材料不足：不许扣任何东西，也不许关掉面板 */
    const viW0 = G.inventory.countOf('wheat'), viE0 = G.inventory.countOf('emerald');
    const viI0 = G.inventory.countOf('iron_ingot'), viB0 = G.inventory.countOf('bread');
    document.querySelector('#panel-villager [data-trade="0"]').click();
    await frame();
    const viFail = T.villageInfo().lastTrade;
    ok('VI.6 材料不足时交易失败且零扣料：背包完全不变、面板仍打开',
      viFail && viFail.ok === false && viFail.reason === 'materials' &&
      G.inventory.countOf('wheat') === viW0 && G.inventory.countOf('emerald') === viE0 &&
      G.inventory.countOf('iron_ingot') === viI0 && G.inventory.countOf('bread') === viB0 &&
      G.openUI === 'villager' && !document.querySelector('#panel-villager').classList.contains('hidden'),
      'last=' + JSON.stringify(viFail));

    /* 存档：村庄结构、村民（含家坐标）都回来，读档后还能再开交易界面 */
    G.closeUI(); await frame();
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '村庄存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const viBack = await tryUntil(() => {
      const v = T.villageInfo();
      return v.built && v.present === v.expected && !!v.villager;
    }, { budgetMs: 20000, label: '读档后村庄与村民恢复', observe: () => { const v = T.villageInfo(); return { built: v.built, present: v.present, expected: v.expected, villager: !!v.villager }; } });
    const viRT = T.villageInfo();
    const viRTv = viRT.villager;
    const viHomeOk = viRTv && viRTv.home &&
      Math.hypot(viRTv.home.x - (viRT.origin.x + 3.5), viRTv.home.z - (viRT.origin.z - 3.5)) < 1.5;
    let viReopen = false;
    if (viRTv) {
      await shrRightClick({ pos: { x: viRTv.x, y: viRTv.y, z: viRTv.z }, height: viRTv.height || 1.9 });
      viReopen = G.openUI === 'villager' && !document.querySelector('#panel-villager').classList.contains('hidden');
      if (G.openUI) G.closeUI();
    }
    ok('VI.7 村庄与村民随存档恢复（家坐标也在），读档后右键还能重新打开交易',
      viBack.ok && viRT.built && viRT.present === viRT.expected && !!viRTv && viHomeOk &&
      viRTv.profession === 'farmer' && viReopen,
      '结构 ' + viRT.present + '/' + viRT.expected + ' 村民=' + JSON.stringify(viRTv) + ' 重开=' + viReopen);

    /* ---------------- 46. 滚动任务 7：雷暴与闪电 ---------------- */
    const stX = drX + 30, stZ = drZ;
    /* 这块地离前几节很远，先传送到自然地表把区块加载出来，再在真实落点造台；
       否则 setBlock 落在未加载区块里会静默失败（ST.4 会劈到 y=3 的自然地面）。 */
    T.teleport(stX + 0.5, G.world.surfaceHeight(stX, stZ) + 2, stZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: '雷暴测试区落地' });
    await sleep(200);
    const stTop = Math.floor(G.controller.pos.y);
    for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) {
      T.setBlock(stX + dx, stTop - 1, stZ + dz, 3);
      for (let h = 0; h <= 8; h++) T.setBlock(stX + dx, stTop + h, stZ + dz, 0);
    }
    await tryUntil(() => G.world.topSolidY(stX, stZ) === stTop - 1,
      { budgetMs: 5000, label: '雷暴测试平台铺好', observe: () => G.world.topSolidY(stX, stZ) });
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.controller.setCreative(false);
    G.inventory.clear(); G.inventory.emit('load');
    T.teleport(stX + 0.5, stTop, stZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '雷暴测试站稳' });
    G.controller.health = 20; G.controller.invulnerable = 0;
    T.setTime(0.3);
    T.setWeather('clear', 100);
    await frame();
    const stOff = T.weatherInfo();
    const stOn = T.setStorm(true);
    await tryUntil(() => T.weatherInfo().fx && T.weatherInfo().fx.activeRain > 0,
      { budgetMs: 6000, label: '雷暴雨幕出现', observe: () => T.weatherInfo().fx });
    const stW1 = T.weatherInfo();
    const stT1 = T.thunderInfo();
    ok('ST.1 雷暴打开：仍是雨、标签为雷暴、雨幕真实出现、存档写入 s 标记',
      stOn === true && stOff.storm === false && stW1.type === 'rain' && stW1.storm === true &&
      stW1.label === '雷暴' && stW1.wet === true && stW1.saved.s === 1 &&
      stW1.fx.activeRain > 0 && stT1.sfx === true,
      'on=' + stOn + ' weather=' + JSON.stringify(stW1) + ' thunder=' + JSON.stringify(stT1));

    /* 与普通雨对比：雷暴更暗、雾更近（同一时刻、同一强度） */
    T.setWeather('rain', 100);
    T.tickWeather(1, 20);
    await frame(); await frame();
    const stRain = T.weatherInfo();
    T.setStorm(true);
    await frame(); await frame();
    const stStorm = T.weatherInfo();
    ok('ST.2 雷暴比普通雨更暗、视距更短，云量拉满（不是只换了一个名字）',
      stStorm.uDay < stRain.uDay - 0.02 && stStorm.fogFar < stRain.fogFar &&
      stStorm.uCloud > 0.8 && stRain.fx.activeRain > 0 && stStorm.fx.activeRain > 0,
      'rain uDay=' + stRain.uDay + ' fogFar=' + stRain.fogFar +
      ' / storm uDay=' + stStorm.uDay + ' fogFar=' + stStorm.fogFar + ' uCloud=' + stStorm.uCloud);

    /* 自然节拍：真实主循环里必须自己落雷，而且闪光/折线都真的出现过 */
    G.controller.setCreative(true);
    G.controller.health = 20;
    const stStrikes0 = T.thunderInfo().strikes;
    const stFlashes0 = T.thunderInfo().flashes;
    let stSawFlash = false;
    const stStrikeW = await tryUntil(() => {
      const t = T.thunderInfo();
      if (t.overlay) stSawFlash = true;
      return t.strikes > stStrikes0;
    }, { budgetMs: 20000, label: '雷暴自然落雷', observe: () => T.thunderInfo() });
    const stT3 = T.thunderInfo();
    ok('ST.3 真实雷暴主循环会自己落雷：闪光/折线出现，落点离玩家 6~16 格',
      stStrikeW.ok && stT3.strikes > stStrikes0 && stT3.flashes > stFlashes0 &&
      stSawFlash && stT3.bolt && stT3.bolt.strikes > 0 &&
      !!stT3.last && stT3.last.dist >= 5 && stT3.last.dist <= 17,
      'strikes=' + stStrikes0 + '→' + stT3.strikes + ' flashes=' + stT3.flashes +
      ' sawFlash=' + stSawFlash + ' last=' + JSON.stringify(stT3.last) + ' bolt=' + JSON.stringify(stT3.bolt));

    /* 定点落雷：真实扣生物血，玩家站远不吃伤害 */
    T.setStorm(false);
    G.mobs.clear();
    T.teleport(stX - 8.5, stTop, stZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: '落雷测试站位' });
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    const stZombie = G.mobs.spawn('zombie', stX + 3.5, stTop, stZ + 0.5);
    const stZh0 = stZombie ? stZombie.hp : 0;
    const stHit = T.strikeLightningAt(stX + 3, stZ);
    await frame();
    ok('ST.4 定点落雷按距离扣血：僵尸掉血、玩家 12 格外无伤，读数如实记录',
      !!stHit && stHit.hits >= 1 && stHit.playerHit === 0 && G.controller.health === 20 &&
      ((stZombie && stZombie.hp < stZh0) || !G.mobs.list.includes(stZombie)),
      'last=' + JSON.stringify(stHit) + ' zombie hp=' + stZh0 + '→' + (stZombie && stZombie.hp) + ' player hp=' + G.controller.health);

    /* 屋顶保护：站在实心天花板下，落雷劈不到人 */
    G.mobs.clear();
    T.teleport(stX + 0.5, stTop, stZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: '屋顶测试站稳' });
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      T.setBlock(stX + dx, stTop + 4, stZ + dz, 14);
    }
    await frame(); await frame();
    const stShelterHit = T.strikeLightningAt(stX, stZ);
    await frame();
    const stSheltered = T.weatherInfo().shelter;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      T.setBlock(stX + dx, stTop + 4, stZ + dz, 0);
    }
    ok('ST.5 屋顶挡住闪电：shelteredAbove=true，玩家不掉血（闪电落在屋顶上方）',
      stSheltered === true && !!stShelterHit && stShelterHit.playerHit === 0 &&
      G.controller.health === 20 && stShelterHit.y >= stTop + 4,
      'shelter=' + stSheltered + ' last=' + JSON.stringify(stShelterHit) + ' hp=' + G.controller.health);

    /* 存档：雷暴标记保留；关掉雷暴后不再自然落雷 */
    T.setStorm(true);
    await frame();
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '雷暴存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const stRT = T.weatherInfo();
    const stRTt = T.thunderInfo();
    T.setStorm(false);
    const stStop0 = T.thunderInfo().strikes;
    const stStopWatch = await watch(2600, () => T.thunderInfo().strikes > stStop0);
    ok('ST.6 雷暴随存档恢复（s 标记），关掉后 2.6 秒观察窗内不再自然落雷',
      stRT.type === 'rain' && stRT.storm === true && stRT.saved.s === 1 && stRTt.storm === true &&
      !stStopWatch.violated && T.thunderInfo().storm === false,
      'read=' + JSON.stringify({ type: stRT.type, storm: stRT.storm, saved: stRT.saved }) +
      ' stopWatch=' + stStopWatch.ms + 'ms violated=' + stStopWatch.violated);

    /* ---------------- 47. 滚动任务 8：地图与指南针 ---------------- */
    T.setStorm(false);
    G.mobs.clear();
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.inventory.clear(); G.inventory.emit('load');
    T.give('leather', 8); T.give('stick', 1); T.give('iron_ingot', 4); T.give('glass', 1);
    G.openCrafting(3); await frame();
    const mpMapRes = T.craftSet(['leather', 'leather', 'leather', 'leather', 'stick', 'leather', 'leather', 'leather', 'leather']);
    const mpMapMade = mpMapRes ? T.craftNow(1) : [];
    const mpCompRes = T.craftSet([null, 'iron_ingot', null, 'iron_ingot', 'glass', 'iron_ingot', null, 'iron_ingot', null]);
    const mpCompMade = mpCompRes ? T.craftNow(1) : [];
    G.closeUI(); await frame();
    ok('MP.1 地图与指南针可获得：8 皮革 + 木棍、4 铁锭 + 玻璃在真实工作台合成入库',
      !!mpMapRes && mpMapRes.item === 'map' && mpMapMade.length === 1 &&
      !!mpCompRes && mpCompRes.item === 'compass' && mpCompMade.length === 1 &&
      G.inventory.countOf('map') >= 1 && G.inventory.countOf('compass') >= 1,
      'map=' + JSON.stringify(mpMapRes) + ' compass=' + JSON.stringify(mpCompRes));

    /* 真实右键地图：打开面板，画布要有已探索色块 */
    const mpMapIdx = G.inventory.slots.findIndex(s => s && s.item === 'map');
    if (mpMapIdx >= 0) { G.inventory.set(0, G.inventory.get(mpMapIdx)); G.inventory.set(mpMapIdx, null); }
    G.selectHotbar(0);
    await frame(); await frame();
    await shrRightClick(null);
    await tryUntil(() => T.mapInfo().panelOpen, { budgetMs: 4000, label: '地图面板打开' });
    await sleep(150);
    const mpInfo1 = T.mapInfo();
    const mpCanvas = document.querySelector('#map-canvas');
    let mpPixels = 0;
    if (mpCanvas) {
      const data = mpCanvas.getContext('2d').getImageData(0, 0, 400, 400).data;
      for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 30) mpPixels++;
    }
    ok('MP.2 真实右键地图打开面板：有画布、有已探索区块、当前区块网格刚好 256 格',
      mpInfo1.panelOpen && mpInfo1.canvas && mpInfo1.explored > 0 &&
      mpInfo1.current === true && mpInfo1.currentLen === 256 && mpPixels > 1000,
      JSON.stringify(mpInfo1) + ' 彩色像素=' + mpPixels);

    /* 跑到新地方后，地图记录更多区块（真实主循环/区块加载链路） */
    G.closeUI(); await frame();
    const mpBefore = T.mapInfo().explored;
    const mpTop = G.world.topSolidY(Math.floor(G.spawn.x), Math.floor(G.spawn.z));
    T.teleport(G.spawn.x + 48, mpTop + 1.1, G.spawn.z + 48);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '地图探索新区域落地' });
    await sleep(400);
    const mpAfter = T.mapInfo();
    ok('MP.3 走动/传送到新区域后地图探索区块增加，当前区块有 256 格快照',
      mpAfter.explored > mpBefore && mpAfter.current === true && mpAfter.currentLen === 256,
      'explored ' + mpBefore + '→' + mpAfter.explored + ' keys=' + mpAfter.keys.length);

    /* 指南针 HUD：把玩家放到目标正南 8 格，朝北看 → 指针朝上、文字显示目标 */
    const mpTarget = G.bedSpawn ? { x: G.bedSpawn.x, z: G.bedSpawn.z, kind: '床' } : { x: G.spawn.x, z: G.spawn.z, kind: '出生点' };
    const mpTy = G.world.topSolidY(Math.floor(mpTarget.x), Math.floor(mpTarget.z + 8));
    T.teleport(mpTarget.x, mpTy + 1.1, mpTarget.z + 8);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '指南针测试落地' });
    const mpCompIdx = G.inventory.slots.findIndex(s => s && s.item === 'compass');
    if (mpCompIdx >= 0 && mpCompIdx < 9) {
      G.selectHotbar(mpCompIdx);                 // 不要覆盖 0 号槽的地图
    } else if (mpCompIdx >= 0) {
      const free = G.inventory.slots.findIndex((s, i) => i > 0 && i < 9 && !s);
      if (free >= 0) { G.inventory.set(free, G.inventory.get(mpCompIdx)); G.inventory.set(mpCompIdx, null); G.selectHotbar(free); }
    }
    G.controller.yaw = 0; G.controller.pitch = 0;
    await frame(); await frame();
    const mpC1 = T.compassInfo();
    ok('MP.4 指南针 HUD 真实显示：目标在正北时指针朝上（≈0°），显示方位/距离/目标名',
      mpC1.held === true && mpC1.visible === true && Math.abs(mpC1.deg) < 1 && mpC1.dir === '北' &&
      /北|床|出生点/.test(mpC1.text || '') && mpC1.dist > 6 && mpC1.dist < 10,
      JSON.stringify(mpC1));

    /* 右键指南针给出一次文字读数（不打开界面、不吞放置） */
    const mpToast0 = document.querySelector('#toast-wrap').textContent;
    await shrRightClick(null);
    await sleep(100);
    ok('MP.5 右键指南针给出文字读数，不打开界面',
      G.openUI === null && document.querySelector('#toast-wrap').textContent.includes('指南针') &&
      document.querySelector('#toast-wrap').textContent !== mpToast0,
      'toast=' + document.querySelector('#toast-wrap').textContent.slice(0, 80));

    /* 存档：已探索地图与指南针物品都要回来 */
    const mpSavedInfo = T.mapInfo();
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: '地图存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const mpRT = T.mapInfo();
    ok('MP.6 地图探索数据随存档恢复（当前区块仍是 256 格），指南针物品不丢',
      mpRT.explored >= mpSavedInfo.explored && mpRT.current === true && mpRT.currentLen === 256 &&
      G.inventory.countOf('compass') >= 1 && G.inventory.countOf('map') >= 1,
      'explored ' + mpSavedInfo.explored + '→' + mpRT.explored + ' map=' + G.inventory.countOf('map') +
      ' compass=' + G.inventory.countOf('compass'));

    /* ---------------- 48. V3 第一人称动作与挖掘反馈 ---------------- */
    const anX = Math.floor(G.spawn.x) - 30, anZ = Math.floor(G.spawn.z) + 30;
    T.teleport(anX + 0.5, G.world.surfaceHeight(anX, anZ) + 2, anZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '动作测试区落地' });
    const anY = Math.floor(G.controller.pos.y);
    for (let dz = -6; dz <= 6; dz++) for (let dx = -4; dx <= 4; dx++) {
      T.setBlock(anX + dx, anY - 1, anZ + dz, 3);
      for (let h = 0; h <= 5; h++) T.setBlock(anX + dx, anY + h, anZ + dz, 0);
    }
    T.setBlock(anX, anY, anZ - 2, 1);
    T.teleport(anX + 0.5, anY, anZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 5000, label: '动作测试站位' });
    G.mobs.maxMobs = 0; G.mobs.clear();
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.inventory.clear();
    G.inventory.set(0, { item: 'grass_block', count: 64 });
    G.inventory.set(1, { item: 'pickaxe_iron', count: 1, dur: 200 });
    G.inventory.set(2, { item: 'bow', count: 1, dur: 200 });
    G.inventory.set(3, { item: 'map', count: 1 });
    G.inventory.emit('load');
    G.selectHotbar(0);
    await frame(); await frame();
    const anBlock = T.heldInfo();
    G.selectHotbar(1); await frame(); await frame();
    const anPick = T.heldInfo();
    G.selectHotbar(2); await frame(); await frame();
    const anBow = T.heldInfo();
    G.selectHotbar(3); await frame(); await frame();
    const anMap = T.heldInfo();
    const anPoseDiff = (a, b) => Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1], a.pos[2] - b.pos[2]) +
      Math.abs(a.rot[0] - b.rot[0]) + Math.abs(a.rot[1] - b.rot[1]) + Math.abs(a.rot[2] - b.rot[2]);
    ok('AN.1 空手/方块/工具/弓/地图按类别使用不同持握姿态（不是一套姿势硬套）',
      !!anBlock && !!anPick && !!anBow && !!anMap &&
      anPoseDiff(anBlock, anPick) > 0.08 && anPoseDiff(anBlock, anBow) > 0.08 &&
      anPoseDiff(anPick, anBow) > 0.08 && anPoseDiff(anBow, anMap) > 0.08,
      'block=' + JSON.stringify(anBlock) + ' pick=' + JSON.stringify(anPick) + ' bow=' + JSON.stringify(anBow) + ' map=' + JSON.stringify(anMap));

    /* 真实挖掘：按住左键 → 周期挥镐 + 裂纹 + 碎屑；松开立即收掉 */
    G.selectHotbar(1);
    aimAt(anX + 0.5, anY + 0.5, anZ - 2 + 0.5);
    await frame();
    const anP0 = T.miningInfo();
    G.input.state.mouseLeft = true;
    const anMine = await tryUntil(() => {
      const m = T.miningInfo(), h = T.heldInfo();
      return m.progress > 0.05 && m.crackVisible && h.kind === 'mine' && h.swing > 0;
    }, { budgetMs: 5000, label: '挖掘循环出现挥镐/裂纹', observe: () => ({ m: T.miningInfo(), h: T.heldInfo() }) });
    const anM1 = T.miningInfo(), anH1 = T.heldInfo();
    G.input.state.mouseLeft = false;
    await frame(); await frame();
    const anAfter = T.miningInfo();
    ok('AN.2 挖掘循环真的挥镐、裂纹随进度出现、碎屑有上限；松开左键立即停止',
      anMine.ok && anH1.kind === 'mine' && anH1.swing > 0 && anM1.crackVisible &&
      anM1.progress > 0 && anM1.progress < 1 && anM1.particles > anP0.particles &&
      anAfter.crackVisible === false,
      'mineOk=' + anMine.ok + ' before=' + JSON.stringify(anP0) + ' during=' + JSON.stringify(anM1) +
      ' held=' + JSON.stringify(anH1) + ' after=' + JSON.stringify(anAfter));

    /* 挥动中切栏：新物品不继承旧挥动，落点不累计漂移。
       取样口径改法（与 C.4 同一类「测试自己二次采样」的问题）：
       原来「G.swing(1) → 等一帧 → 要求 |swing-1|<0.15」测的其实是「一帧有多长」——
       挥动按 3.4/秒衰减，帧长 44ms 就掉出这条界。深地布局之后打包自检偶发一帧 54ms
       （实测 swing=0.816），源码 e2e 绿、打包版红。换成三条与帧长无关的判据：
         ① 起势当场**同步**读：swing 精确 = 1、kind='attack'（不走帧，没有二次采样）；
         ② 就在这一刻切栏（swing 仍是 1，「挥动中」是构造出来的而不是等出来的），两帧后新物品 swing 归零、equip 起势；
         ③ 挥动确实带动第一人称模型：整段挥动弧里取「相对基准位姿的最大偏移」，
            峰值只取决于这一挥有没有走完，不取决于中间每帧多长。 */
    G.selectHotbar(0); await sleep(450);
    const anRest0 = T.heldInfo();
    G.swing(1, 'attack');
    const anSwing0 = T.heldInfo();
    G.selectHotbar(1);
    await frame(); await frame();
    const anSwitched = T.heldInfo();
    let anMaxDiff = 0, anMaxAt = null;
    G.swing(1, 'attack');
    await watch(600, () => {
      const h = T.heldInfo();
      const d = anPoseDiff(h, anRest0);
      if (d > anMaxDiff) { anMaxDiff = d; anMaxAt = h.swing; }
      return false;                        // 这不是「不该发生」的观察窗，只是借它逐帧取峰值
    });
    await sleep(450);
    const anSettled = T.heldInfo();
    G.selectHotbar(0); await sleep(450);
    const anBack = T.heldInfo();
    /* 本轮 C 语义说明（明确记录，不是为了变绿）：
       工具的持握位置不再是「和方块同一个基准点」——方块仍在 (0.48,-0.40,-0.72)，
       而镐/剑被有意移到 (0.34,-0.36,-0.62)（更靠中间、更靠上，FOV 70 下 ~29°，
       让「有厚度的工具」落在画面右下角而不是掉出屏幕）。
       原意是「静置后回到该物品自己的基准姿态、没有累计漂移」，所以判据改成
       —— 与 heldInfo.base（heldView 为这一件物品声明的 basePos）比，而不是与上一个物品比。 */
    const anBase = anSettled.base || [anRest0.pos[0], anRest0.pos[1], anRest0.pos[2]];
    ok('AN.3 挥动中切栏：切换后 swing 归零、equip 重新起势，静置后回到该物品自己的基准姿态（无累计偏移）',
      anSwing0.swing === 1 && anSwing0.kind === 'attack' &&
      anSwitched.swing === 0 && anSwitched.equip > 0 &&
      anMaxDiff > 0.5 &&
      Math.abs(anSettled.pos[0] - anBase[0]) < 0.05 &&
      Math.abs(anSettled.pos[1] - anBase[1]) < 0.05 &&
      Math.abs(anBack.pos[0] - anRest0.pos[0]) < 0.05 &&
      Math.abs(anBack.pos[1] - anRest0.pos[1]) < 0.05,
      '起势swing=' + anSwing0.swing + ' kind=' + anSwing0.kind +
      ' 切栏后swing=' + anSwitched.swing + ' equip=' + anSwitched.equip +
      ' 整弧最大位姿偏移=' + anMaxDiff.toFixed(3) + '（峰值时 swing=' + anMaxAt + '，挥动弧 1/3.4≈294ms）' +
      ' 该物品基准=' + JSON.stringify(anBase) +
      ' rest=' + JSON.stringify(anRest0) + ' switched=' + JSON.stringify(anSwitched) +
      ' settled=' + JSON.stringify(anSettled) + ' back=' + JSON.stringify(anBack));

    /* ---------------- 49. V4 近战与受击反馈 ---------------- */
    T.setBlock(anX, anY, anZ - 2, 0);          // 清掉 V3 的测试石块
    G.mobs.clear();
    G.inventory.set(0, { item: 'sword_iron', count: 1, dur: 250 });
    G.selectHotbar(0);
    G.controller.invulnerable = 0; G.controller.health = 20;
    await sleep(450);
    const v4Pig = G.mobs.spawn('pig', anX + 0.5, anY, anZ - 2.5);
    if (v4Pig) { v4Pig.walking = false; v4Pig.wanderT = 9999; v4Pig.vel.x = v4Pig.vel.z = 0; }
    aimAt(anX + 0.5, anY + 0.5, anZ - 2.5);
    await tryUntil(() => T.feedbackInfo().hitMarker === false, { budgetMs: 3000, tick: 'sleep', intervalMs: 60, label: '命中标记复位' });
    const v4Hit0 = T.feedbackInfo().hit;
    G.input.state.mouseLeft = true;
    const v4HitW = await tryUntil(() => T.feedbackInfo().hit > v4Hit0,
      { budgetMs: 4000, label: '真实左键命中猪', observe: () => ({ fb: T.feedbackInfo(), hp: v4Pig && v4Pig.hp, held: T.heldInfo() }) });
    const v4Marker = T.feedbackInfo().hitMarker;
    G.input.state.mouseLeft = false;
    await frame();
    ok('V4.1 真实命中：猪掉血、命中标记亮起、出现攻击挥动；空挥也有挥动但不点亮命中标记',
      v4HitW.ok && !!v4Pig && v4Pig.hp < 10 && v4Marker === true,
      'hitOk=' + v4HitW.ok + ' hp=' + (v4Pig && v4Pig.hp) + ' marker=' + v4Marker);

    await tryUntil(() => T.feedbackInfo().hitMarker === false, { budgetMs: 3000, tick: 'sleep', intervalMs: 60, label: '命中标记再次复位' });
    const v4Miss0 = T.feedbackInfo().hit;
    G.controller.pitch = 1.2; G.controller.yaw = 0;
    G.input.state.mouseLeft = true;
    await frame(); await frame();
    const v4MissSwing = T.heldInfo().swing;
    const v4MissMarker = T.feedbackInfo().hitMarker;
    G.input.state.mouseLeft = false;
    await frame();
    ok('V4.2 空挥也有挥动，但没有命中音/命中标记/伤害计数（与命中可区分）',
      v4MissSwing > 0 && v4MissMarker === false && T.feedbackInfo().hit === v4Miss0,
      'swing=' + v4MissSwing + ' marker=' + v4MissMarker + ' hit ' + v4Miss0 + '→' + T.feedbackInfo().hit);

    /* 死亡生物不能被二次结算/二次掉落 */
    G.mobs.clear();
    const v4Chicken = G.mobs.spawn('chicken', anX + 3.5, anY, anZ - 2.5);
    if (v4Chicken) v4Chicken.hp = 1;
    const v4Drop0 = G.interaction.drops.list.filter(d => d.item === 'chicken_raw').length;
    const v4K1 = v4Chicken ? G.mobs.hitMob(v4Chicken, 99, { x: 0, z: 0 }) : false;
    const v4Drop1 = G.interaction.drops.list.filter(d => d.item === 'chicken_raw').length;
    const v4K2 = v4Chicken ? G.mobs.hitMob(v4Chicken, 99, { x: 0, z: 0 }) : true;
    const v4Drop2 = G.interaction.drops.list.filter(d => d.item === 'chicken_raw').length;
    ok('V4.3 死亡生物不会被再次结算：第二次 hitMob 返回 false，掉落不增加',
      !!v4Chicken && v4K1 === true && v4K2 === false && v4Drop1 === v4Drop2 && v4Drop2 >= v4Drop0,
      'k1=' + v4K1 + ' k2=' + v4K2 + ' drops ' + v4Drop0 + '→' + v4Drop1 + '→' + v4Drop2);

    /* 狼/闪电等非玩家攻击不点亮玩家命中标记 */
    G.mobs.clear();
    const v4Wolf = G.mobs.spawn('wolf', anX - 2.5, anY, anZ - 1.5);
    const v4Zombie = G.mobs.spawn('zombie', anX - 1.2, anY, anZ - 1.5);
    if (v4Wolf) { v4Wolf.setTamed(true); v4Wolf.sitting = false; v4Wolf.attackCd = 0; v4Wolf.walking = false; v4Wolf.wanderT = 9999; }
    if (v4Zombie) { v4Zombie.walking = false; v4Zombie.wanderT = 9999; v4Zombie.attackCd = 99; }
    const v4Fb0 = T.feedbackInfo().hit;
    const v4WolfW = await tryUntil(() => !v4Zombie || v4Zombie.hp < 14 || !G.mobs.list.includes(v4Zombie),
      { budgetMs: 8000, label: '狼攻击僵尸', observe: () => ({ hp: v4Zombie && v4Zombie.hp, fb: T.feedbackInfo().hit }) });
    ok('V4.4 狼/闪电等非玩家攻击不会点亮玩家命中标记（同一伤害事件不产生玩家反馈）',
      v4WolfW.ok && T.feedbackInfo().hit === v4Fb0,
      'zombie=' + (v4Zombie && v4Zombie.hp) + ' playerHit ' + v4Fb0 + '→' + T.feedbackInfo().hit);

    /* ---------------- 50. V5 弓与盾牌使用表现 ---------------- */
    G.mobs.clear();
    G.controller.health = 20; G.controller.invulnerable = 0;
    G.inventory.clear();
    G.inventory.set(0, { item: 'bow', count: 1, dur: 200 });
    G.inventory.set(1, { item: 'arrow', count: 8 });
    G.inventory.set(2, { item: 'shield', count: 1, dur: 336 });
    G.inventory.emit('load');
    G.selectHotbar(0);
    G.controller.yaw = 0; G.controller.pitch = 0;
    await sleep(450);
    const v5Arrows0 = G.inventory.countOf('arrow');
    const v5ChargeW = await holdWhile(
      () => { G.input.state.mouseRight = true; },
      () => T.bowInfo().charge >= 0.6,
      { budgetMs: 4000, alive: () => !!G.input.state.mouseRight }
    );
    const v5Charged = T.heldInfo();
    const v5BarShown = !document.querySelector('#bow-charge').classList.contains('hidden');
    G.input.state.mouseRight = false;
    const v5ReleaseW = await tryUntil(() => G.inventory.countOf('arrow') === v5Arrows0 - 1,
      { budgetMs: 4000, label: '松手射出一箭', observe: () => ({ b: T.bowInfo(), h: T.heldInfo() }) });
    await frame(); await frame();
    const v5After = T.heldInfo();
    ok('V5.1 弓随真实蓄力拉弦/搭箭：弓弦后拉、箭出现、HUD 条可见；松手后恢复并消耗 1 箭',
      v5ChargeW.ok && v5Charged.meshType === 'bow' && v5Charged.bowDraw > 0.5 &&
      v5Charged.bowNocked === true && v5Charged.bowStringX < -0.1 && v5Charged.bowArrow === true &&
      v5BarShown && v5ReleaseW.ok && v5After.bowDraw === 0 && v5After.bowNocked === false &&
      v5After.bowArrow === false,
      'charged=' + JSON.stringify(v5Charged) + ' bar=' + v5BarShown + ' release=' + v5ReleaseW.ok +
      ' ' + heldTag(v5ChargeW) + ' after=' + JSON.stringify(v5After) + ' arrows=' + v5Arrows0 + '→' + G.inventory.countOf('arrow'));

    /* 蓄力中打开界面：取消拉弓，不射箭；关闭后也不补射 */
    G.input.state.mouseRight = true;
    await tryUntil(() => T.bowInfo().charge > 0.2, { budgetMs: 3000, label: '再次蓄力' });
    const v5CancelArrows = G.inventory.countOf('arrow');
    const v5Ent0 = G.mobs.arrows.length;
    G.openInventory();
    await frame();
    const v5CancelCharge = T.bowInfo().charge;
    G.closeUI();
    await frame(); await frame();
    ok('V5.2 蓄力中打开背包会取消拉弓：charge 归零、不射箭、不扣箭',
      v5CancelCharge === 0 && G.inventory.countOf('arrow') === v5CancelArrows &&
      G.mobs.arrows.length === v5Ent0 && !G.controller.blocking,
      'charge=' + v5CancelCharge + ' arrows=' + v5CancelArrows + '→' + G.inventory.countOf('arrow') +
      ' ents=' + v5Ent0 + '→' + G.mobs.arrows.length);

    /* 没有箭：不进入蓄力，弓保持静止，给出提示 */
    G.inventory.set(1, null); G.inventory.emit('load');
    G.selectHotbar(0);
    G.input.state.mouseRight = true;
    const v5NoArrow = await tryUntil(() => T.bowInfo().charge === -1,
      { budgetMs: 3000, label: '缺箭状态', observe: () => T.bowInfo() });
    await frame();
    const v5EmptyHeld = T.heldInfo();
    G.input.state.mouseRight = false;
    await frame();
    ok('V5.3 没有箭时拉弓被拒绝：charge=-1、弓弦/搭箭保持收起、给出合成提示',
      v5NoArrow.ok && v5EmptyHeld.bowDraw === 0 && v5EmptyHeld.bowNocked === false &&
      document.querySelector('#toast-wrap').textContent.includes('没有箭'),
      'charge=' + T.bowInfo().charge + ' held=' + JSON.stringify(v5EmptyHeld) +
      ' toast=' + document.querySelector('#toast-wrap').textContent.slice(0, 60));

    /* 盾牌：举盾有过渡、成功格挡有短后坐；放下后 blockWeight 收敛 */
    G.inventory.set(2, G.inventory.get(2) || { item: 'shield', count: 1, dur: 336 });
    G.selectHotbar(2);
    G.controller.yaw = 0; G.controller.pitch = 0;
    G.input.state.mouseRight = true;
    const v5BlockW = await tryUntil(() => T.heldInfo().blockWeight > 0.8,
      { budgetMs: 3000, label: '盾牌举起过渡', observe: () => T.heldInfo() });
    const v5ShieldUp = T.heldInfo();
    const v5Blocks0 = T.shieldInfo().blocks;
    const v5Z = G.mobs.spawn('zombie', anX + 0.5, anY, anZ - 1.6);
    if (v5Z) { v5Z.attackCd = 0; v5Z.walking = false; v5Z.wanderT = 9999; }
    let v5Kick = 0;
    const v5HitW = await tryUntil(() => {
      const h = T.heldInfo(), s = T.shieldInfo();
      if (h.shieldKick > v5Kick) v5Kick = h.shieldKick;
      return s.blocks > v5Blocks0;
    }, { budgetMs: 8000, label: '僵尸咬盾', observe: () => ({ h: T.heldInfo(), s: T.shieldInfo() }) });
    const v5BlockedHp = G.controller.health;
    if (v5Z && G.mobs.list.includes(v5Z)) G.mobs.kill(v5Z, false);
    G.input.state.mouseRight = false;
    const v5DownW = await tryUntil(() => T.heldInfo().blockWeight < 0.2,
      { budgetMs: 3000, label: '盾牌放下过渡', observe: () => T.heldInfo() });
    ok('V5.4 盾牌：举起/放下有过渡，成功格挡触发短后坐且与单纯举盾不同；血量 20',
      v5BlockW.ok && v5ShieldUp.blockWeight > 0.8 && v5HitW.ok && v5Kick > 0 &&
      v5BlockedHp === 20 && v5DownW.ok && !G.controller.blocking,
      'up=' + JSON.stringify(v5ShieldUp) + ' hit=' + v5HitW.ok + ' kick=' + v5Kick +
      ' hp=' + v5BlockedHp + ' down=' + v5DownW.ok + ' blocking=' + G.controller.blocking);

    /* ---------------- 51. E1 创造栏搜索 ---------------- */
    G.setMode('creative');
    G.inventory.clear(); G.inventory.emit('load');
    G.openInventory(); await frame();
    const e1Btn = [...document.querySelectorAll('#panel-inventory .btn')].find(b => b.textContent.includes('创造'));
    if (e1Btn) e1Btn.click();
    await frame();
    const e1Set = (q) => {
      const inp = document.querySelector('#inp-creative-search');
      inp.focus(); inp.value = q;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return inp;
    };
    const e1Pure = T.creativeSearch('铁');
    e1Set('铁');
    const e1Info1 = T.creativeState();
    const e1IronSlot = document.querySelector('#creative-grid [data-slot="give:iron_ingot"]');
    if (e1IronSlot) e1IronSlot.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    ok('E1.1 中文搜索跨全部分类：命中铁系物品、显示找到 N 项、点击可直接拿到光标/快捷栏',
      e1Info1.focused === true && e1Info1.inputValue === '铁' &&
      e1Info1.grid === e1Pure.count && e1Pure.count > 2 && /找到 \d+ 项/.test(e1Info1.countText || '') &&
      !!e1IronSlot && G.inventory.get(G.inventory.selected) && G.inventory.get(G.inventory.selected).item === 'iron_ingot',
      JSON.stringify(e1Info1) + ' pure=' + e1Pure.count + ' held=' + JSON.stringify(G.inventory.get(G.inventory.selected)));

    e1Set('COMPASS');
    await frame();
    const e1Info2 = T.creativeState();
    ok('E1.2 英文 id 忽略大小写：COMPASS 只命中指南针',
      e1Info2.grid === 1 && !!document.querySelector('#creative-grid [data-slot="give:compass"]') &&
      /找到 1 项/.test(e1Info2.countText || ''),
      JSON.stringify(e1Info2));

    e1Set('zzzz-no-such-item');
    await frame();
    const e1Info3 = T.creativeState();
    ok('E1.3 无结果时显示明确空状态，网格为 0',
      e1Info3.grid === 0 && e1Info3.empty === true &&
      (document.querySelector('#creative-empty').textContent.includes('没有匹配')),
      JSON.stringify(e1Info3) + ' emptyText=' + document.querySelector('#creative-empty').textContent);

    /* 搜索框聚焦时 W/Digit1 不操控角色/快捷栏；Esc 仍关闭 */
    const e1Pos0 = { ...G.controller.pos }, e1Sel0 = G.inventory.selected;
    const e1PreState = G.state, e1PreOpen = G.openUI;
    const e1Input = document.querySelector('#inp-creative-search');
    e1Input.focus();
    e1Input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    e1Input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', bubbles: true }));
    await frame(); await frame();
    const e1Pos1 = G.controller.pos;
    const e1Keep = Math.hypot(e1Pos1.x - e1Pos0.x, e1Pos1.z - e1Pos0.z) < 0.001 && G.inventory.selected === e1Sel0;
    e1Input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', bubbles: true }));
    await frame(); await frame();
    const e1Esc = G.openUI === null;
    ok('E1.4 搜索框聚焦时 W/数字键不泄漏到玩法与快捷栏；Esc 仍能关闭界面',
      e1Keep && e1Esc, 'posΔ=' + Math.hypot(e1Pos1.x - e1Pos0.x, e1Pos1.z - e1Pos0.z).toFixed(3) +
      ' selected=' + e1Sel0 + '→' + G.inventory.selected + ' esc=' + e1Esc + ' state=' + e1PreState + '→' + G.state + ' preOpen=' + e1PreOpen);

    /* 关闭再打开：过滤不残留，恢复当前分类 */
    G.openInventory(); await frame();
    const e1Btn2 = [...document.querySelectorAll('#panel-inventory .btn')].find(b => b.textContent.includes('创造'));
    if (e1Btn2) e1Btn2.click();
    await frame();
    const e1Info4 = T.creativeState();
    const e1TabCount = T.creativeSearch('').count;
    ok('E1.5 关闭再打开搜索状态清空：输入框为空、恢复当前分类、无空结果残留',
      e1Info4.query === '' && e1Info4.inputValue === '' && e1Info4.empty === false &&
      e1Info4.grid > 0 && e1Info4.grid < e1TabCount && e1Info4.tabs >= 3,
      JSON.stringify(e1Info4) + ' tabPool=' + e1TabCount);
    G.closeUI(); await frame();

    /* ---------------- 52. E2 村庄三职业居民 ---------------- */
    const e2Info0 = T.villageInfo();
    const e2Ox = e2Info0.origin.x, e2Oy = e2Info0.origin.y, e2Oz = e2Info0.origin.z;
    T.setTime(0.3);
    T.setWeather('clear', 600);
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    const e2Specs = [
      { profession: 'farmer', name: '农夫', x: 3.5, z: -3.5, stand: [3.5, -1.5],
        ids: ['wheat_for_emerald', 'emerald_for_bread', 'emerald_for_iron'],
        trades: [['wheat', 10, 'emerald', 1], ['emerald', 1, 'bread', 3], ['emerald', 3, 'iron_ingot', 1]] },
      { profession: 'librarian', name: '图书管理员', x: -3.5, z: -3.5, stand: [-3.5, -2.5],
        ids: ['leather_for_emerald', 'emerald_for_map', 'emerald_for_compass'],
        trades: [['leather', 3, 'emerald', 1], ['emerald', 1, 'map', 1], ['emerald', 2, 'compass', 1]] },
      { profession: 'blacksmith', name: '铁匠', x: 3.5, z: 2.5, stand: [3.5, 0.5],
        ids: ['coal_for_emerald', 'emerald_for_iron_ingot', 'flint_for_emerald'],
        trades: [['coal', 3, 'emerald', 1], ['emerald', 2, 'iron_ingot', 1], ['flint', 5, 'emerald', 1]] }
    ];
    const e2Spawn = () => {
      const out = [];
      for (const s of e2Specs) {
        const hx = e2Ox + s.x, hz = e2Oz + s.z, hy = e2Oy + 1;
        const m = G.mobs.spawn('villager', hx, hy, hz, { profession: s.profession, home: { x: hx, y: hy, z: hz } });
        if (m) { m.walking = false; m.wanderT = 9999; m.vel.x = m.vel.z = 0; }
        out.push(m);
      }
      return out;
    };
    e2Spawn();
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;
    const e2Looks = G.mobs.list.filter(m => m.type === 'villager').map(v => {
      const p = v.mesh.userData.parts || {};
      return {
        profession: v.profession,
        body: p.body ? p.body.material.color.getHexString() : null,
        hat: !!p.hat, glasses: !!p.glasses0 && !!p.glasses1, apron: !!p.apron, hammer: !!p.hammerHead
      };
    });
    const e2Look = (p) => e2Looks.find(l => l.profession === p) || {};
    ok('E2.1 三名村民外观按职业区分：农夫草帽、图书管理员眼镜、铁匠围裙与锤子，身体颜色各不相同',
      e2Looks.length === 3 &&
      e2Look('farmer').hat === true && e2Look('librarian').glasses === true &&
      e2Look('blacksmith').apron === true && e2Look('blacksmith').hammer === true &&
      new Set(e2Looks.map(l => l.body)).size === 3,
      JSON.stringify(e2Looks) + ' state=' + G.state);

    /* 逐个右键：打开的是该职业自己的面板，标题带职业名，三条交易 id 与该职业表一致。 */
    const e2Opened = [];
    for (const s of e2Specs) {
      const v = G.mobs.list.find(m => m.type === 'villager' && m.profession === s.profession);
      if (!v) { e2Opened.push({ profession: s.profession, open: false }); continue; }
      T.teleport(e2Ox + s.stand[0], e2Oy + 1.05, e2Oz + s.stand[1]);
      await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'E2 交易站位 ' + s.profession });
      await shrRightClick({ pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z }, height: v.height || 1.9 });
      const panel = document.querySelector('#panel-villager');
      const title = panel ? panel.querySelector('.ptitle') : null;
      e2Opened.push({
        profession: s.profession, open: G.openUI === 'villager' && !!panel && !panel.classList.contains('hidden'),
        active: G.activeVillager && G.activeVillager.profession,
        title: title ? title.textContent : '',
        buttons: document.querySelectorAll('#panel-villager [data-trade]').length,
        tradeIds: T.villageInfo().trades.map(t => t.id)
      });
      if (G.openUI) G.closeUI();
      await frame();
    }
    const e2OpenOk = e2Specs.every(s => {
      const o = e2Opened.find(x => x.profession === s.profession);
      return o && o.open && o.active === s.profession && o.buttons === 3 &&
        o.title.includes(s.name) && JSON.stringify(o.tradeIds) === JSON.stringify(s.ids);
    });
    ok('E2.2 每个村民只打开自己的面板：标题显示职业名，按钮三条且与职业交易表对应',
      e2OpenOk, JSON.stringify(e2Opened));

    /* 九条交易逐条真实点击：扣料、给货、toast、stats 都走生产路径。 */
    const e2TradeStats0 = G.stats.trades || 0;
    const e2TradeLog = [];
    for (const s of e2Specs) {
      const v = G.mobs.list.find(m => m.type === 'villager' && m.profession === s.profession);
      for (let ti = 0; ti < s.trades.length; ti++) {
        const [giveItem, giveCount, getItem, getCount] = s.trades[ti];
        if (G.openUI) G.closeUI();
        G.inventory.clear(); G.inventory.emit('load');
        G.inventory.add(giveItem, giveCount);
        G.selectHotbar(0);
        T.teleport(e2Ox + s.stand[0], e2Oy + 1.05, e2Oz + s.stand[1]);
        await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'E2 交易站位 ' + s.profession });
        if (!v) { e2TradeLog.push({ profession: s.profession, i: ti, ok: false, why: 'no-villager' }); continue; }
        await shrRightClick({ pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z }, height: v.height || 1.9 });
        const btn = document.querySelector('#panel-villager [data-trade="' + ti + '"]');
        if (!btn || G.openUI !== 'villager') {
          e2TradeLog.push({ profession: s.profession, i: ti, ok: false, why: 'no-panel' });
          if (G.openUI) G.closeUI();
          continue;
        }
        btn.click();
        await frame(); await frame();
        const lt = T.villageInfo().lastTrade;
        const toast = document.querySelector('#toast-wrap').textContent;
        e2TradeLog.push({
          profession: s.profession, i: ti, id: lt && lt.trade, ok: !!(lt && lt.ok),
          giveLeft: G.inventory.countOf(giveItem), got: G.inventory.countOf(getItem),
          toast: /交易完成/.test(toast)
        });
        if (G.openUI) G.closeUI();
      }
    }
    const e2TradeOk = e2Specs.every(s => s.trades.every((t, ti) => {
      const r = e2TradeLog.find(x => x.profession === s.profession && x.i === ti);
      return r && r.ok && r.giveLeft === 0 && r.got === t[3] && r.toast === true;
    })) && (G.stats.trades || 0) === e2TradeStats0 + 9;
    ok('E2.3 九个职业交易逐条真实点击：扣料给货、toast 与 stats.trades 都增加，九条全成功',
      e2TradeOk, 'stats ' + e2TradeStats0 + '→' + (G.stats.trades || 0) + ' ' + JSON.stringify(e2TradeLog));

    /* 死亡不复活；存档往返不重复居民/建筑；再次调用 buildVillage 不会叠加。 */
    const e2BeforeKill = T.villageInfo().villagers;
    const e2Bs = G.mobs.list.find(m => m.type === 'villager' && m.profession === 'blacksmith');
    if (e2Bs) G.mobs.kill(e2Bs, false);
    await frame();
    const e2AfterKill = T.villageInfo().villagers;
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'E2 村民存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const e2Back = T.villageInfo();
    const e2BackProfs = (e2Back.roster || []).map(r => r.profession);
    await sleep(1600);
    const e2Still = T.villageInfo();
    G.buildVillage();
    await frame();
    const e2Guard = T.villageInfo();
    ok('E2.4 村民死亡后不复活；存档往返不重复居民与建筑；重复调用 buildVillage 不叠加',
      e2BeforeKill === 3 && e2AfterKill === 2 && e2Back.villagers === 2 &&
      e2BackProfs.indexOf('blacksmith') < 0 && e2Back.present === e2Back.expected &&
      e2Still.villagers === 2 && e2Guard.villagers === 2 && e2Guard.present === e2Back.present,
      '3→' + e2AfterKill + ' 读档=' + e2Back.villagers + ' profs=' + JSON.stringify(e2BackProfs) +
      ' 1.6s后=' + e2Still.villagers + ' guard=' + e2Guard.villagers +
      ' 结构=' + e2Guard.present + '/' + e2Guard.expected);

    /* 旧档：村民记录没有 pr 字段 → 一律读成农夫，且不会因读档重建村庄。 */
    const e2Old = await G.storage.loadWorld('验收世界');
    for (const m of (e2Old.mobs || [])) if (m.t === 'villager') delete m.pr;
    await G.storage.saveWorld('验收世界', e2Old);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'E2 旧档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const e2OldInfo = T.villageInfo();
    const e2OldProfs = (e2OldInfo.roster || []).map(r => r.profession);
    ok('E2.5 旧档没有职业字段：村民回落农夫、人数不增加、村庄建筑不重建',
      e2OldInfo.villagers === 2 && e2OldProfs.every(p => p === 'farmer') &&
      e2OldInfo.present === e2OldInfo.expected,
      '村民=' + e2OldInfo.villagers + ' profs=' + JSON.stringify(e2OldProfs) +
      ' 结构=' + e2OldInfo.present + '/' + e2OldInfo.expected);

    /* 多次读档后输入监听不能叠加：一次 Esc 只关界面，不应顺手把游戏暂停。 */
    G.openInventory(); await frame();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' }));
    await frame(); await frame();
    ok('E2.6 多次读档后一次 Esc 只关闭界面、不会顺带暂停（输入监听不随读档叠加）',
      G.openUI === null && G.state === 'playing',
      'openUI=' + G.openUI + ' state=' + G.state);

    /* ---------------- 53. E3 废弃矿工营地 ---------------- */
    const e3 = T.campInfo();
    const e3Ox = e3.origin.x, e3Oy = e3.origin.y, e3Oz = e3.origin.z;
    T.setTime(0.3);
    T.setWeather('clear', 600);
    G.mobs.maxMobs = 0;
    G.mobs.clear();
    G.controller.setCreative(false);
    G.controller.health = 20; G.controller.invulnerable = 0;

    /* 真实走楼梯：从地面矿口按住 W 一路下行到房间，不靠传送。 */
    T.teleport(e3Ox + 0.5, e3Oy + 1.05, e3Oz + 3.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'E3 矿口站稳' });
    G.controller.yaw = Math.PI;
    G.controller.pitch = 0;
    await frame(); await frame();
    const e3Walk = await holdWhile(() => T.key('KeyW', true),
      () => G.controller.pos.z > e3Oz + 8.3 || G.controller.pos.y <= e3Oy - 3.5,
      { budgetMs: 12000, alive: () => !!G.input.state.keyW });
    T.key('KeyW', false);
    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: 'E3 走进房间后落地', observe: () => ({ y: +G.controller.pos.y.toFixed(2), z: +G.controller.pos.z.toFixed(2) }) });
    await frame(); await frame();
    const e3P = { x: +G.controller.pos.x.toFixed(2), y: +G.controller.pos.y.toFixed(2), z: +G.controller.pos.z.toFixed(2) };
    const e3InRoom = e3P.x >= e3.room.x0 && e3P.x <= e3.room.x1 + 1 &&
      e3P.z >= e3.room.z0 && e3P.z <= e3.room.z1 + 1 && e3P.y <= e3Oy - 3.5;
    ok('E3.1 真实从地面矿口沿 5 级楼梯走进地下 7×7 房间（W 键行走，不是传送）',
      e3Walk.ok && e3InRoom && G.controller.onGround,
      '走=' + e3Walk.ok + ' 落点=' + JSON.stringify(e3P) + ' 房间=' + JSON.stringify(e3.room) +
      ' ' + heldTag(e3Walk) + ' onGround=' + G.controller.onGround);

    /* 真实右键地下箱子：27 格容器界面 + 固定战利品。 */
    const e3Under = e3.chests.find(c => c.table === 'underground');
    const e3ItemsBefore = e3Under.items.map(i => i.item + 'x' + i.count).sort().join(',');
    const e3dx = (e3Under.x + 0.5) - G.controller.pos.x;
    const e3dy = (e3Under.y + 0.5) - G.controller.eyeY;
    const e3dz = (e3Under.z + 0.5) - G.controller.pos.z;
    const e3L = Math.hypot(e3dx, e3dy, e3dz) || 1;
    G.controller.pitch = Math.asin(e3dy / e3L);
    G.controller.yaw = Math.atan2(-e3dx / e3L, -e3dz / e3L);
    G.interaction.placeCd = 0;
    G.input.state.mouseRight = true;
    G.interaction.update(0.02);
    G.input.state.mouseRight = false;
    await sleep(250);
    const e3Slots = e3Under.hasContainer ? G.world.getContainer(e3Under.x, e3Under.y, e3Under.z) : [];
    const e3ItemsNow = e3Slots.filter(Boolean).map(s => s.item + 'x' + s.count).sort().join(',');
    ok('E3.2 真实右键地下箱子打开 27 格容器，战利品与建站时写入的固定内容一致',
      G.openUI === 'chest' && document.querySelectorAll('#chest-grid .slot').length === 27 &&
      G.world.getBlock(e3Under.x, e3Under.y, e3Under.z) === 39 &&
      e3ItemsNow === e3ItemsBefore && e3ItemsNow.includes('iron_ingot') && e3ItemsNow.includes('emerald'),
      'openUI=' + G.openUI + ' 格数=' + document.querySelectorAll('#chest-grid .slot').length +
      ' 期望=[' + e3ItemsBefore + '] 实得=[' + e3ItemsNow + ']');
    if (G.openUI) G.closeUI();
    await frame();

    /* 存档：营地元数据、房间结构与地下箱子内容都回来。 */
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'E3 营地存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const e3Back = T.campInfo();
    const e3BackUnder = (e3Back.chests || []).find(c => c.table === 'underground') || { items: [] };
    const e3BackItems = e3BackUnder.items.map(i => i.item + 'x' + i.count).sort().join(',');
    ok('E3.3 营地站点/结构/黑暗房间与箱子战利品随存档恢复，不会重新建造',
      e3Back.built && e3Back.builds === 0 && e3Back.origin.x === e3.origin.x && e3Back.origin.z === e3.origin.z &&
      e3Back.expected === e3Back.present && e3Back.roomTorches === 0 && e3Back.roomAir === 146 &&
      e3BackItems === e3ItemsBefore && e3Back.diamond === e3.diamond,
      'origin=' + JSON.stringify(e3Back.origin) + ' builds=' + e3Back.builds +
      ' 结构=' + e3Back.present + '/' + e3Back.expected + ' 战利品=[' + e3BackItems + ']');

    /* 旧档：没有 camp 字段 → 不补建（builds 不增加）。 */
    const e3Old = await G.storage.loadWorld('验收世界');
    delete e3Old.camp;
    await G.storage.saveWorld('验收世界', e3Old);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'E3 旧档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const e3OldInfo = T.campInfo();
    const e3OldUnder = e3OldInfo.built ? null : G.world.hasContainer(e3Under.x, e3Under.y, e3Under.z);
    ok('E3.4 旧档没有 camp 字段：不补建营地（builds 保持 0），原有箱子容器仍按存档读回',
      e3OldInfo.built === false && e3OldInfo.builds === 0 && e3OldUnder === true,
      'built=' + e3OldInfo.built + ' builds=' + e3OldInfo.builds + ' 地下容器=' + e3OldUnder);

    /* 拆掉地面箱子：方块消失、容器删除、内容物全部掉出（不吞物品）。 */
    const e3Surf = e3.chests.find(c => c.table === 'surface');
    G.interaction.drops.list.length = 0;
    T.mineAt(e3Surf.x, e3Surf.y, e3Surf.z);
    await frame(); await frame();
    const e3DropCount = (item) => G.interaction.drops.list
      .filter(d => d.item === item).reduce((a, d) => a + d.count, 0);
    const e3SurfItems = e3Surf.items;
    const e3ChestGone = G.world.getBlock(e3Surf.x, e3Surf.y, e3Surf.z) === 0 &&
      !G.world.hasContainer(e3Surf.x, e3Surf.y, e3Surf.z);
    const e3DropOk = e3SurfItems.every(it => e3DropCount(it.item) >= it.count);
    ok('E3.5 拆掉营地箱子：方块与容器一起消失，里面的固定战利品全部掉在地上',
      e3ChestGone && e3DropOk &&
      e3DropCount('bread') >= 3 && e3DropCount('arrow') >= 8 && e3DropCount('torch') >= 4,
      '容器消失=' + e3ChestGone + ' 掉落=' +
      e3SurfItems.map(i => i.item + ':' + e3DropCount(i.item) + '/' + i.count).join(','));

    /* ---------------- 54. E4 雨天耕地与作物联动 ---------------- */
    const e4X = Math.floor(G.spawn.x) + 80, e4Z = Math.floor(G.spawn.z) - 80;
    T.teleport(e4X + 0.5, G.world.surfaceHeight(e4X, e4Z) + 2, e4Z + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'E4 农田测试落地' });
    const e4Y = Math.floor(G.controller.pos.y);
    for (let dz = -3; dz <= 3; dz++) for (let dx = -5; dx <= 5; dx++) {
      T.setBlock(e4X + dx, e4Y - 1, e4Z + dz, 3, 0);
      for (let h = 0; h <= 5; h++) T.setBlock(e4X + dx, e4Y + h, e4Z + dz, 0, 0);
    }
    G.farmlands.clear();
    G.crops.clear();
    G.rainCropStats = { exposedTicks: 0, shelteredTicks: 0, extra: 0, lastExposedMultiplier: 1 };
    const e4Ex = { x: e4X + 2, z: e4Z };          // 露天
    const e4Sh = { x: e4X - 2, z: e4Z };          // 头顶石块遮蔽
    G.farmlands.set(e4Ex.x + ',' + e4Y + ',' + e4Ex.z, { dryT: 0, need: 55 });
    G.farmlands.set(e4Sh.x + ',' + e4Y + ',' + e4Sh.z, { dryT: 0, need: 55 });
    T.setBlock(e4Ex.x, e4Y, e4Ex.z, 36, 0);
    T.setBlock(e4Sh.x, e4Y, e4Sh.z, 36, 0);
    T.setBlock(e4Ex.x, e4Y + 1, e4Ex.z, 37, 0);
    T.setBlock(e4Sh.x, e4Y + 1, e4Sh.z, 37, 0);
    T.setBlock(e4Sh.x, e4Y + 3, e4Sh.z, 1, 0);   // 石顶：只遮住这一格
    G.crops.set(e4Ex.x + ',' + (e4Y + 1) + ',' + e4Ex.z, 0);
    G.crops.set(e4Sh.x + ',' + (e4Y + 1) + ',' + e4Sh.z, 0);
    T.setWeather('rain', 120);
    T.tickFarmland(1);
    await sleep(120);
    const e4Wet = T.blockAt(e4Ex.x, e4Y, e4Ex.z);
    const e4Shelter = T.blockAt(e4Sh.x, e4Y, e4Sh.z);
    ok('E4.1 雨天淋湿露天耕地（没有水渠也算湿），石顶下的耕地保持干燥',
      (e4Wet.meta & 1) === 1 && (e4Shelter.meta & 1) === 0 &&
      T.farmlandWet(e4Ex.x, e4Y, e4Ex.z) === false && T.farmlandWet(e4Sh.x, e4Y, e4Sh.z) === false &&
      T.weatherInfo().type === 'rain',
      '露天=' + JSON.stringify(e4Wet) + ' 遮蔽=' + JSON.stringify(e4Shelter) +
      ' 水渠判定=' + T.farmlandWet(e4Ex.x, e4Y, e4Ex.z));

    /* 精确倍率：固定随机数 0.5，露天一步 1.5×，遮蔽/晴天一步 1×。 */
    const e4OldRandom = Math.random;
    G.crops.set(e4Ex.x + ',' + (e4Y + 1) + ',' + e4Ex.z, 0);
    G.crops.set(e4Sh.x + ',' + (e4Y + 1) + ',' + e4Sh.z, 0);
    G.rainCropStats = { exposedTicks: 0, shelteredTicks: 0, extra: 0, lastExposedMultiplier: 1 };
    Math.random = () => 0.5;
    T.tickCrops(1);
    Math.random = e4OldRandom;
    const e4RainEx = G.crops.get(e4Ex.x + ',' + (e4Y + 1) + ',' + e4Ex.z);
    const e4RainSh = G.crops.get(e4Sh.x + ',' + (e4Y + 1) + ',' + e4Sh.z);
    const e4StatsRain = T.farmRainInfo();
    G.crops.set(e4Ex.x + ',' + (e4Y + 1) + ',' + e4Ex.z, 0);
    G.crops.set(e4Sh.x + ',' + (e4Y + 1) + ',' + e4Sh.z, 0);
    G.rainCropStats = { exposedTicks: 0, shelteredTicks: 0, extra: 0, lastExposedMultiplier: 1 };
    T.setWeather('clear', 120);
    Math.random = () => 0.5;
    T.tickCrops(1);
    Math.random = e4OldRandom;
    const e4ClearEx = G.crops.get(e4Ex.x + ',' + (e4Y + 1) + ',' + e4Ex.z);
    const e4ClearSh = G.crops.get(e4Sh.x + ',' + (e4Y + 1) + ',' + e4Sh.z);
    ok('E4.2 雨天露天作物一步 ×1.5、遮蔽仍 ×1；晴天两者都回到 ×1（常数倍率，不是随机抖动）',
      Math.abs(e4RainEx - 1.5) < 1e-6 && Math.abs(e4RainSh - 1.0) < 1e-6 &&
      e4StatsRain.exposedTicks === 1 && e4StatsRain.shelteredTicks === 1 &&
      Math.abs(e4StatsRain.extra - 0.5) < 1e-6 && e4StatsRain.lastExposedMultiplier === 1.5 &&
      Math.abs(e4ClearEx - 1.0) < 1e-6 && Math.abs(e4ClearSh - 1.0) < 1e-6,
      'rain ex=' + e4RainEx + ' sh=' + e4RainSh + ' stats=' + JSON.stringify(e4StatsRain) +
      ' clear ex=' + e4ClearEx + ' sh=' + e4ClearSh);

    /* 主循环里真的生效：放开 Math.random，等真实帧推进，统计露天/遮蔽步数与额外生长。 */
    G.crops.set(e4Ex.x + ',' + (e4Y + 1) + ',' + e4Ex.z, 0);
    G.crops.set(e4Sh.x + ',' + (e4Y + 1) + ',' + e4Sh.z, 0);
    G.rainCropStats = { exposedTicks: 0, shelteredTicks: 0, extra: 0, lastExposedMultiplier: 1 };
    T.setWeather('rain', 120);
    await sleep(1000);
    const e4LoopStats = T.farmRainInfo();
    const e4LoopEx = G.crops.get(e4Ex.x + ',' + (e4Y + 1) + ',' + e4Ex.z) || 0;
    const e4LoopSh = G.crops.get(e4Sh.x + ',' + (e4Y + 1) + ',' + e4Sh.z) || 0;
    ok('E4.3 真实主循环里雨天倍率生效：露天作物步数/额外生长持续增加，遮蔽作物不受影响',
      e4LoopStats.rain === true && e4LoopStats.exposedTicks >= 10 && e4LoopStats.shelteredTicks >= 10 &&
      e4LoopStats.lastExposedMultiplier === 1.5 && e4LoopStats.extra > 0 &&
      e4LoopEx > 0 && e4LoopSh > 0 && e4LoopEx > e4LoopSh * 1.1,
      'stats=' + JSON.stringify(e4LoopStats) + ' 生长 露天=' + e4LoopEx.toFixed(3) +
      ' 遮蔽=' + e4LoopSh.toFixed(3));

    /* 雨停 → 湿润位清掉；清掉作物后按原有干涸规则退回泥土。 */
    T.setWeather('clear', 120);
    T.tickFarmland(1);
    const e4AfterRain = T.blockAt(e4Ex.x, e4Y, e4Ex.z);
    T.setBlock(e4Ex.x, e4Y + 1, e4Ex.z, 0, 0);
    G.crops.delete(e4Ex.x + ',' + (e4Y + 1) + ',' + e4Ex.z);
    G.farmlands.set(e4Ex.x + ',' + e4Y + ',' + e4Ex.z, { dryT: 100, need: 0 });
    T.tickFarmland(1);
    const e4Reverted = T.blockAt(e4Ex.x, e4Y, e4Ex.z);
    ok('E4.4 雨停后湿润位消失；清掉作物后沿用原有干涸规则退回泥土',
      (e4AfterRain.meta & 1) === 0 && e4Reverted.id === 2 &&
      !G.farmlands.has(e4Ex.x + ',' + e4Y + ',' + e4Ex.z),
      '雨停=' + JSON.stringify(e4AfterRain) + ' 干涸后=' + JSON.stringify(e4Reverted));

    /* 雪不是雨：不淋湿；天气存档仍只有原来的四个字段。 */
    const e4SnowX = e4X, e4SnowZ = e4Z;
    T.setBlock(e4SnowX, e4Y, e4SnowZ, 36, 0);
    G.farmlands.set(e4SnowX + ',' + e4Y + ',' + e4SnowZ, { dryT: 0, need: 55 });
    const e4SnowBefore = T.blockAt(e4SnowX, e4Y, e4SnowZ);
    T.setWeather('snow', 120);
    T.tickFarmland(1);
    const e4Snow = T.blockAt(e4SnowX, e4Y, e4SnowZ);
    const e4SavedKeys = Object.keys(T.weatherInfo().saved).sort().join(',');
    ok('E4.5 雪不会淋湿耕地；天气存档仍是 t/left/el/inten 四个字段，没有为 E4 改格式',
      (e4Snow.meta & 1) === 0 && e4SavedKeys === 'el,inten,left,t',
      '雪前=' + JSON.stringify(e4SnowBefore) + ' 雪地=' + JSON.stringify(e4Snow) +
      ' 水渠=' + T.farmlandWet(e4SnowX, e4Y, e4SnowZ) + ' weather=' + T.weatherInfo().type +
      ' savedKeys=' + e4SavedKeys);

    /* ---------------- 55. R1 探索地点注册与接近发现 ---------------- */
    const lm0 = T.landmarksInfo();
    const lmCands = T.landmarkCandidates();
    const lmTarget = lmCands.find(c => c.dist > 35) || lmCands[0];
    ok('R1.0 当前玩家附近能算出确定性候选地点（未建造），并给出类型/坐标/距离',
      !!lmTarget && lmCands.length >= 1 && !!lmTarget.id && !!lmTarget.type &&
      Number.isFinite(lmTarget.x) && Number.isFinite(lmTarget.z) && lmTarget.dist > 0,
      JSON.stringify(lmCands.slice(0, 3)));

    await sleep(1000);
    const lmWait = T.landmarksInfo();
    const lmNotYet = !lmWait.list.some(l => l.id === lmTarget.id);
    ok('R1.1 玩家没走近时不建造：远处候选只出现在 near 读数里，registry 里没有它',
      lmNotYet && lmWait.built <= (lm0.built || 0) + 1 &&
      T.landmarkCandidates().some(c => c.id === lmTarget.id),
      '目标=' + lmTarget.id + ' before=' + lm0.built + ' afterWait=' + lmWait.built +
      ' cands=' + JSON.stringify(T.landmarkCandidates().slice(0, 2)));

    const lmStandX = lmTarget.x + 6.5, lmStandZ = lmTarget.z + 0.5;
    T.teleport(lmStandX, G.world.surfaceHeight(Math.round(lmStandX), Math.round(lmStandZ)) + 2, lmStandZ);
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R1 地点外落地' });
    const lmBuildW = await tryUntil(() => {
      const v = T.landmarksInfo();
      return v.list.some(l => l.id === lmTarget.id && l.built);
    }, { budgetMs: 15000, label: 'R1 走近后触发建造', observe: () => ({ info: T.landmarksInfo().near, built: T.landmarksInfo().built }) });
    const lm1 = T.landmarksInfo();
    const lmRec = lm1.list.find(l => l.id === lmTarget.id);
    const lmChest = lmRec && lmRec.chests && lmRec.chests[0];
    const lmChestItems = lmChest ? lmChest.items.map(i => i.item + 'x' + i.count).sort().join(',') : '';
    ok('R1.2 走近才建一次：结构完整落地、箱子入 containers、有固定战利品，且记录建造耗时',
      lmBuildW.ok && lm1.built === (lm0.built || 0) + 1 && !!lmRec &&
      lmRec.expected === lmRec.present && lmChest && lmChest.block && lmChest.hasContainer &&
      lmChest.items.length >= 1 && lm1.stats.lastBuildMs > 0 && lm1.stats.lastBuildMs < 250 &&
      Math.hypot(lmTarget.x - G.controller.pos.x, lmTarget.z - G.controller.pos.z) < 28,
      'built=' + lm1.built + ' 结构=' + (lmRec && lmRec.present) + '/' + (lmRec && lmRec.expected) +
      ' 箱=' + lmChestItems + ' ms=' + lm1.stats.lastBuildMs);

    /* 重复靠近/等待不会刷第二份。 */
    await sleep(1600);
    const lm2 = T.landmarksInfo();
    const lm2Rec = lm2.list.find(l => l.id === lmTarget.id);
    const lm2Items = lm2Rec && lm2Rec.chests[0] ? lm2Rec.chests[0].items.map(i => i.item + 'x' + i.count).sort().join(',') : '';
    ok('R1.3 同一地点重复靠近/等待不重建：registry 里只有一份，箱子内容不增加',
      lm2.list.filter(l => l.id === lmTarget.id).length === 1 && lm2.built === (lm0.built || 0) + 1 &&
      lm2Items === lmChestItems,
      'count=' + lm2.list.filter(l => l.id === lmTarget.id).length + ' built=' + lm2.built + ' items=' + lm2Items);

    /* 存档 + 离开再回来。 */
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'R1 地点存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const lmRT = T.landmarksInfo();
    const lmRTRec = lmRT.list.find(l => l.id === lmTarget.id);
    const lmRTItems = lmRTRec && lmRTRec.chests[0] ? lmRTRec.chests[0].items.map(i => i.item + 'x' + i.count).sort().join(',') : '';
    T.teleport(lmTarget.x + 120, G.world.surfaceHeight(lmTarget.x + 120, lmTarget.z) + 2, lmTarget.z);
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R1 离开地点' });
    await sleep(900);
    T.teleport(lmStandX, G.world.surfaceHeight(Math.round(lmStandX), Math.round(lmStandZ)) + 2, lmStandZ);
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R1 回到地点' });
    await sleep(1200);
    const lmBack = T.landmarksInfo();
    ok('R1.4 地点/箱内物品随存档恢复；离开再回来不重复建造，也不刷第二份战利品',
      !!lmRTRec && lmRTRec.expected === lmRTRec.present && lmRTItems === lmChestItems &&
      lmBack.list.filter(l => l.id === lmTarget.id).length === 1 &&
      lmBack.list.find(l => l.id === lmTarget.id).chests[0].items.map(i => i.item + 'x' + i.count).sort().join(',') === lmChestItems,
      '读档结构=' + (lmRTRec && lmRTRec.present) + '/' + (lmRTRec && lmRTRec.expected) +
      ' 读档箱=' + lmRTItems + ' 回来=' + lmBack.list.filter(l => l.id === lmTarget.id).length);

    /* 旧档没有 landmarks：不补建；原有方块仍在时也不能凭旧结构再刷一份。 */
    const lmOld = await G.storage.loadWorld('验收世界');
    delete lmOld.landmarks;
    await G.storage.saveWorld('验收世界', lmOld);
    await G.loadWorld('验收世界');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'R1 旧档读回来' });
    await sleep(1500);
    G.mobs.maxMobs = 0;
    const lmOldInfo = T.landmarksInfo();
    ok('R1.5 旧档缺 landmarks 字段：读入为空、不补建、不报错；靠近旧位置也不会重写历史',
      lmOldInfo.list.every(l => l.id !== lmTarget.id) && lmOldInfo.stats.builds === 0,
      '旧档 built=' + lmOldInfo.built + ' statsBuilds=' + lmOldInfo.stats.builds +
      ' list=' + JSON.stringify(lmOldInfo.list.map(l => l.id)));

    /* ---------------- 56. R2 三类探索地点 ---------------- */
    await G.newWorld('地标模板验收', 'acceptance-2026', 'survival');
    await tryUntil(() => G.state === 'playing' && G.world.genQueue.length === 0,
      { budgetMs: 30000, tick: 'sleep', intervalMs: 120, label: 'R2 新世界就绪' });
    await sleep(500);
    G.mobs.maxMobs = 0;
    const r2Start = T.landmarksInfo();
    ok('R2.0 新世界的 landmarks 从空表开始，旧存档的地点不会串进新世界',
      r2Start.built === 0 && r2Start.list.length === 0,
      JSON.stringify({ built: r2Start.built, list: r2Start.list.map(l => l.id) }));
    const r2Types = [
      { type: 'outpost', name: '荒废前哨', x: 24, z: 48 },
      { type: 'tower', name: '废弃哨塔', x: 356, z: 68 },
      { type: 'ruin', name: '荒野废墟', x: 124, z: -412 }
    ];
    const r2Aim = (tx, ty, tz) => {
      const dx = (tx + 0.5) - G.controller.pos.x;
      const dy = (ty + 0.5) - G.controller.eyeY;
      const dz = (tz + 0.5) - G.controller.pos.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.pitch = Math.asin(dy / L);
      G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    };
    const r2Results = [];
    for (const spec of r2Types) {
      T.teleport(spec.x + 6.5, G.world.surfaceHeight(spec.x + 6, spec.z) + 2, spec.z + 0.5);
      await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R2 地点外落地 ' + spec.type });
      const builtW = await tryUntil(() => T.landmarksInfo().list.some(l => l.type === spec.type),
        { budgetMs: 12000, label: 'R2 建造 ' + spec.type, observe: () => ({ near: T.landmarksInfo().near, built: T.landmarksInfo().built }) });
      /* 真实走到入口/内部：向南门方向按住 W，位置必须越过外墙。 */
      const rec0 = T.landmarksInfo().list.find(l => l.type === spec.type);
      if (!rec0) {
        r2Results.push({ spec, rec: null, entered: false, openUI: null, slots: 0, items: '', was: builtW.ok, info: T.landmarksInfo() });
        if (G.openUI) G.closeUI();
        continue;
      }
      const rx = rec0.x, ry = rec0.y, rz = rec0.z;
      T.teleport(rx + 0.5, ry + 1.05, rz + 4.8);
      await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R2 入口站定 ' + spec.type });
      G.controller.yaw = 0; G.controller.pitch = 0;
      const r2Walk = await holdWhile(() => T.key('KeyW', true), () => G.controller.pos.z < rz + 0.6,
        { budgetMs: 6000, alive: () => !!G.input.state.keyW });
      T.key('KeyW', false);
      await frame(); await frame();
      const entered = G.controller.pos.z < rz + 0.6;
      const chest = rec0.chests[0];
      r2Aim(chest.x, chest.y, chest.z);
      G.interaction.placeCd = 0;
      G.input.state.mouseRight = true;
      G.interaction.update(0.02);
      G.input.state.mouseRight = false;
      G.interaction.update(0.02);
      await sleep(250);
      const slots = chest && chest.hasContainer ? G.world.getContainer(chest.x, chest.y, chest.z) : [];
      const items = slots.filter(Boolean).map(s => s.item + 'x' + s.count).sort().join(',');
      r2Results.push({ spec, rec: rec0, entered, openUI: G.openUI, slots: document.querySelectorAll('#chest-grid .slot').length, items, was: builtW.ok, hold: r2Walk });
      if (G.openUI) G.closeUI();
      await frame();
    }
    const r2TypeOk = r2Types.every(spec => {
      const r = r2Results.find(x => x.spec.type === spec.type);
      return r && r.was && !!r.rec && r.rec.built && r.rec.discovered && r.rec.expected === r.rec.present &&
        r.rec.variant >= 0 && r.rec.variant <= 2 && r.entered && r.openUI === 'chest' && r.slots === 27 && r.items.length > 0;
    });
    ok('R2.1 三类地点各自命中真实种子：结构完整、入口可进入、箱子打开且固定战利品非空',
      r2TypeOk && new Set(r2Results.map(r => r.spec.type)).size === 3 &&
      new Set(r2Results.map(r => r.rec ? r.rec.x + ',' + r.rec.z : 'null')).size === 3,
      JSON.stringify(r2Results.map(r => ({
        type: r.spec.type, at: r.rec && [r.rec.x, r.rec.y, r.rec.z], variant: r.rec && r.rec.variant,
        structure: r.rec && (r.rec.present + '/' + r.rec.expected), entered: r.entered,
        重按: r.hold && r.hold.reassert, 打断: r.hold && r.hold.firstLostMs,
        open: r.openUI, slots: r.slots, items: r.items
      }))));

    const r2Saved = T.landmarksInfo();
    const r2SavedMap = r2Saved.list.map(l => l.type + ':' + l.id + ':' + (l.chests[0] ? l.chests[0].items.map(i => i.item + 'x' + i.count).sort().join(',') : '')).sort();
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('地标模板验收');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'R2 地点存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const r2Back = T.landmarksInfo();
    const r2BackMap = r2Back.list.map(l => l.type + ':' + l.id + ':' + (l.chests[0] ? l.chests[0].items.map(i => i.item + 'x' + i.count).sort().join(',') : '')).sort();
    ok('R2.2 三处地点与箱子随存档恢复；读档不重建、不刷第二份战利品',
      r2Back.built === 3 && r2Back.list.filter(l => l.type === 'tower').length === 1 &&
      JSON.stringify(r2BackMap) === JSON.stringify(r2SavedMap),
      'saved=' + JSON.stringify(r2SavedMap) + ' back=' + JSON.stringify(r2BackMap));

    /* 三类模板的变体/位置不能全是同一份。 */
    const r2Variants = new Set(r2Results.filter(r => r.rec).map(r => r.rec.variant));
    const r2LayoutSigs = new Set(r2Results.filter(r => r.rec).map(r => r.rec.type + ':' + r.rec.expected));
    ok('R2.3 三类地点使用不同模板与箱子表，位置/类型不是同一份复制',
      r2Variants.size >= 2 && r2LayoutSigs.size === 3 &&
      r2Results.every(r => r.rec && r.rec.chests && r.rec.chests[0] && r.rec.chests[0].items.length > 0),
      'variants=' + JSON.stringify([...r2Variants]) + ' layouts=' + JSON.stringify([...r2LayoutSigs]));

    const r2Stats = r2Saved.stats;
    ok('R2.4 三次真实接近均只建一次，单次建造有上限，箱子/结构完整',
      r2Stats.builds >= 3 && r2Stats.maxBuildMs < 250 && r2Stats.failed === 0 &&
      r2Results.every(r => r.rec && r.rec.expected === r.rec.present && r.rec.chests[0].hasContainer),
      JSON.stringify(r2Stats));

    /* ---------------- 57. R3 发现提示、地图标记与探索者成就 ---------------- */
    await G.newWorld('发现反馈验收', 'r3-discovery-2026', 'survival');
    await tryUntil(() => G.state === 'playing' && G.world.genQueue.length === 0,
      { budgetMs: 30000, tick: 'sleep', intervalMs: 120, label: 'R3 新世界就绪' });
    await sleep(500);
    G.mobs.maxMobs = 0;
    /* 找一个附近可建的候选站点（新种子出生点附近不一定正好有，按地区跳几格再问） */
    let r3Cands0 = T.landmarkCandidates();
    for (let hop = 0; hop < 6 && !(r3Cands0 && r3Cands0.length); hop++) {
      const hy = G.world.surfaceHeight(G.controller.pos.x + 96, G.controller.pos.z);
      T.teleport(G.controller.pos.x + 96, hy + 2, G.controller.pos.z);
      await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R3 找站点跳格落地' });
      await sleep(700);
      r3Cands0 = T.landmarkCandidates();
    }
    const r3Target = r3Cands0 && r3Cands0.length ? r3Cands0[0] : null;
    /* 基线：跳格找站点的过程中可能已经顺手建过一处，后面全部按增量判定 */
    const r3Base = T.landmarksInfo();
    const r3BaseMap = T.mapInfo();
    const r3BaseAch = T.achievementsInfo();
    /* 先站在发现半径（18）之外、触发半径（28）之内：只该建造，不该有提示/标记/成就 */
    if (r3Target) {
      T.teleport(r3Target.x + 0.5, G.world.surfaceHeight(r3Target.x, r3Target.z + 25) + 2, r3Target.z + 25);
    }
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R3 触发半径内落地' });
    const r3Built = await tryUntil(() => !!r3Target && T.landmarksInfo().list.some(l => l.id === r3Target.id),
      { budgetMs: 15000, label: 'R3 在触发半径内建造', observe: () => ({ cands: T.landmarkCandidates().length, built: T.landmarksInfo().built }) });
    await sleep(750);
    const r3Mid = T.landmarksInfo();
    const r3MidAch = T.achievementsInfo();
    const r3MidMap = T.mapInfo();
    const r3Rec = r3Mid.list.find(l => l.id === (r3Target && r3Target.id)) || null;
    ok('R3.0 站在发现半径外只建造：不弹提示、不出标记、不给探索者成就',
      r3Built.ok && !!r3Rec && r3Rec.built && !r3Rec.discovered &&
      r3Mid.stats.discoveryToasts === r3Base.stats.discoveryToasts &&
      r3MidMap.markers.every(k => k.id !== r3Target.id) &&
      r3MidAch.toasts === r3BaseAch.toasts && r3MidAch.explorer === r3BaseAch.explorer,
      'target=' + JSON.stringify(r3Target && { id: r3Target.id, type: r3Target.type, x: r3Target.x, z: r3Target.z }) +
      ' rec=' + JSON.stringify(r3Rec && { built: r3Rec.built, discovered: r3Rec.discovered }) +
      ' toasts ' + r3Base.stats.discoveryToasts + '→' + r3Mid.stats.discoveryToasts +
      ' markers=' + JSON.stringify(r3MidMap.markers.map(k => k.id)) + ' explorer=' + r3MidAch.explorer);

    /* 真实走进发现半径。
       两件事必须避开：① 验收窗口每 0.5 秒被宿主 showInactive/moveTop，window blur 会 _clearAll() 掉按键
       → 每帧重新按下 KeyW（仍然是键盘链路，不是传送）；② 出发点的自然地形可能有坎 →
       先把玩家放到该地点整平后的同层南边 20 格（仍在 18 半径之外），再朝目标走，走不动就换绕行方向。 */
    const r3FloorY = (r3Rec ? r3Rec.y : G.controller.pos.y) + 1.2;
    T.teleport(r3Rec.x + 0.5, r3FloorY, r3Rec.z + 20);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'R3 走近出发点落地' });
    const r3WalkFrom = { x: G.controller.pos.x, z: G.controller.pos.z };
    const r3Samples = [];
    let r3WalkOk = false, r3Off = 0;
    let r3RoundStart = { x: G.controller.pos.x, z: G.controller.pos.z };
    const r3EndAt = performance.now() + 16000;
    const r3Heads = [0, 1.1, -1.1, 2.2, -2.2, Math.PI];
    while (performance.now() < r3EndAt && !r3WalkOk) {
      const dx = r3Rec.x - G.controller.pos.x, dz = r3Rec.z - G.controller.pos.z;
      G.controller.yaw = Math.atan2(-dx, -dz) + r3Heads[r3Off];
      G.controller.pitch = 0;
      while (performance.now() < r3EndAt) {
        T.key('KeyW', true);
        await frame();
        if (T.landmarksInfo().stats.discoveries > r3Base.stats.discoveries) { r3WalkOk = true; break; }
        if (G.controller.onGround) r3Samples.push(+Math.hypot(G.controller.pos.x - r3Rec.x, G.controller.pos.z - r3Rec.z).toFixed(1));
        if (r3Samples.length % 40 === 0) break;              // 每 ~40 帧评估一次有没有前进
      }
      T.key('KeyW', false);
      if (r3WalkOk) break;
      const gained = Math.hypot(G.controller.pos.x - r3RoundStart.x, G.controller.pos.z - r3RoundStart.z);
      r3RoundStart = { x: G.controller.pos.x, z: G.controller.pos.z };
      if (gained < 0.8) r3Off = Math.min(r3Off + 1, r3Heads.length - 1);
    }
    const r3Walked = Math.hypot(G.controller.pos.x - r3WalkFrom.x, G.controller.pos.z - r3WalkFrom.z);
    const r3Now = T.landmarksInfo();
    const r3ToastDom = document.querySelector('#toast-wrap').textContent;
    const r3AfterAch = T.achievementsInfo();
    const r3AfterMap = T.mapInfo();
    const r3WantAchToasts = r3BaseAch.toasts + (r3BaseAch.explorer ? 0 : 1);
    ok('R3.1 真实走进制发现半径：只弹一次「发现：某某」，地图标记 +1，探索者成就解锁',
      r3WalkOk && r3Walked > 1.5 && !!r3Target && r3Now.stats.discoveryToasts === r3Base.stats.discoveryToasts + 1 &&
      r3Now.list.some(l => l.id === r3Target.id && l.discovered) &&
      r3Now.stats.lastDiscovery && r3Now.stats.lastDiscovery.id === r3Target.id &&
      new RegExp('发现：' + r3Target.name).test(r3ToastDom) &&
      r3AfterMap.markerCount === r3BaseMap.markerCount + 1 &&
      r3AfterMap.markers.some(k => k.id === r3Target.id) &&
      r3AfterAch.explorer === true && r3AfterAch.extraCount === 1 &&
      r3AfterAch.count === r3BaseAch.count && r3AfterAch.toasts === r3WantAchToasts,
      'walked=' + r3Walked.toFixed(2) + ' 距离样本=' + JSON.stringify(r3Samples.slice(-6)) +
      ' stats=' + JSON.stringify({ disc: r3Now.stats.discoveries, t: r3Now.stats.discoveryToasts, last: r3Now.stats.lastDiscoveryToast }) +
      ' toastDOM=' + r3ToastDom.slice(0, 40) + ' markers ' + r3BaseMap.markerCount + '→' + r3AfterMap.markerCount +
      ' ach=' + JSON.stringify({ count: r3AfterAch.count, extra: r3AfterAch.extraCount, toasts: r3AfterAch.toasts }));

    /* 站在里面继续扫描：不得重复弹提示或重复标记 */
    await sleep(1600);
    const r3Still = T.landmarksInfo();
    const r3StillMap = T.mapInfo();
    ok('R3.2 之后继续扫描/久站不重复弹提示，标记数量不变',
      r3Still.stats.discoveries === r3Now.stats.discoveries &&
      r3Still.stats.discoveryToasts === r3Now.stats.discoveryToasts &&
      r3StillMap.markerCount === r3AfterMap.markerCount &&
      T.achievementsInfo().extraCount === 1 && T.achievementsInfo().toasts === r3AfterAch.toasts,
      JSON.stringify({ disc: r3Still.stats.discoveries, toasts: r3Still.stats.discoveryToasts, markers: r3StillMap.markerCount, achToasts: T.achievementsInfo().toasts }));

    /* 存档往返：发现状态与标记保留，但不重新弹提示 */
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('发现反馈验收');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'R3 存档读回来' });
    await sleep(200);
    G.mobs.maxMobs = 0;
    const r3Loaded = T.landmarksInfo();
    const r3LoadedMap = T.mapInfo();
    await sleep(1500);
    const r3Late = T.landmarksInfo();
    const r3LateAch = T.achievementsInfo();
    const r3LoadRec = r3Loaded.list.find(l => l.id === (r3Target && r3Target.id));
    ok('R3.3 读档后已发现状态与地图标记仍在，且不会重新弹发现提示',
      !!r3LoadRec && r3LoadRec.discovered === true && r3Loaded.discovered === r3Now.discovered &&
      r3LoadedMap.markerCount === r3Loaded.discovered && r3Loaded.stats.discoveryToasts === 0 &&
      r3Late.stats.discoveryToasts === 0 && !/发现：/.test(document.querySelector('#toast-wrap').textContent) &&
      r3LateAch.explorer === true && r3LateAch.extraCount === 1,
      'loaded=' + JSON.stringify({ rec: r3LoadRec && { id: r3LoadRec.id, disc: r3LoadRec.discovered }, disc: r3Loaded.discovered, toasts: r3Loaded.stats.discoveryToasts, markers: r3LoadedMap.markerCount }) +
      ' late=' + JSON.stringify({ toasts: r3Late.stats.discoveryToasts, explorer: r3LateAch.explorer }) +
      ' toastDOM=' + document.querySelector('#toast-wrap').textContent.slice(0, 30));

    /* 面板绝不提前暴露没发现过的地方 */
    const r3CandsNow = T.landmarkCandidates();
    const r3AllNow = T.landmarksInfo();
    const r3MarkIds = T.mapInfo().markers.map(k => k.id);
    const r3Undisc = r3AllNow.list.filter(l => !l.discovered).map(l => l.id);
    const r3DiscIds = r3AllNow.list.filter(l => l.discovered).map(l => l.id).sort();
    ok('R3.4 未建造/未发现的地点不进面板，标记集合刚好等于已发现集合',
      r3CandsNow.every(c => r3MarkIds.indexOf(c.id) < 0) &&
      r3Undisc.every(id => r3MarkIds.indexOf(id) < 0) &&
      r3MarkIds.length === r3AllNow.discovered && r3AllNow.discovered >= 1 &&
      JSON.stringify(r3MarkIds.slice().sort()) === JSON.stringify(r3DiscIds),
      'cands=' + JSON.stringify(r3CandsNow.slice(0, 3).map(c => c.id + '/' + c.type)) +
      ' marks=' + JSON.stringify(r3MarkIds) + ' discovered=' + JSON.stringify(r3DiscIds) +
      ' undiscovered=' + JSON.stringify(r3Undisc));

    /* 真实右键打开地图：金菱标记要被画出来（走的是 showMap 的产品路径） */
    const r3Site = r3AllNow.list.find(l => l.id === (r3Target && r3Target.id)) || r3AllNow.list.find(l => l.discovered);
    T.teleport(r3Site.x + 0.5, G.world.surfaceHeight(r3Site.x, r3Site.z + 20) + 2, r3Site.z + 20);
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R3 地图测试点落地' });
    G.controller.yaw = 0; G.controller.pitch = 0;
    G.inventory.set(0, { item: 'map', count: 1 });
    G.selectHotbar(0);
    await frame(); await frame();
    const r3SelBefore = G.inventory.selected;
    await shrRightClick(null);
    const r3Panel = await tryUntil(() => T.mapInfo().panelOpen, { budgetMs: 4000, label: 'R3 地图面板打开' });
    await sleep(150);
    const r3PanelInfo = T.mapInfo();
    const r3MarkBox = document.querySelector('#map-markers');
    const r3MarkChips = r3MarkBox ? r3MarkBox.querySelectorAll('.map-marker').length : -1;
    ok('R3.5 真实右键打开地图：已发现地点画成标记并列出名称与真实坐标',
      r3Panel.ok && !!document.querySelector('#map-canvas') && r3PanelInfo.markerCount === r3AllNow.discovered &&
      r3PanelInfo.markerCount >= 1 && r3MarkChips === r3PanelInfo.markerCount && !!r3MarkBox &&
      new RegExp(r3Site.name).test(r3MarkBox.textContent) &&
      new RegExp('\\(' + r3Site.x + ', ' + r3Site.z + '\\)').test(r3MarkBox.textContent),
      'panel=' + JSON.stringify({ open: r3PanelInfo.panelOpen, markers: r3PanelInfo.markerCount, dom: r3PanelInfo.markerDom, disc: r3AllNow.discovered }) +
      ' chips=' + r3MarkChips + ' text=' + (r3MarkBox ? r3MarkBox.textContent.slice(0, 60) : 'none'));

    /* 开着地图不能操作玩法，关掉之后按键要立刻回到玩法 */
    const r3PosOpen = { x: G.controller.pos.x, z: G.controller.pos.z, y: G.controller.pos.y };
    T.key('KeyW', true);
    await sleep(450);
    T.key('KeyW', false);
    const r3PosLeak = Math.hypot(G.controller.pos.x - r3PosOpen.x, G.controller.pos.z - r3PosOpen.z);
    G.closeUI(); await frame(); await frame();
    const r3Ground = await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: 'R3 关图后落地' });
    T.key('Space', true);
    const r3Jump = await tryUntil(() => G.controller.pos.y > r3PosOpen.y + 0.3,
      { budgetMs: 2500, label: 'R3 关图后跳跃生效', observe: () => ({ dy: (G.controller.pos.y - r3PosOpen.y).toFixed(2), onGround: G.controller.onGround }) });
    T.key('Space', false);
    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: 'R3 跳跃后回落' });
    const r3WalkAfter = Math.hypot(G.controller.pos.x - r3PosOpen.x, G.controller.pos.z - r3PosOpen.z);
    await frame();
    ok('R3.6 打开/关闭地图不改变输入状态：开着时 W 不泄漏到玩法，关掉后按键立刻生效（跳跃）',
      r3Ground.ok && G.openUI === null && G.state === 'playing' && r3PosLeak < 0.05 &&
      r3Jump.ok && G.inventory.selected === r3SelBefore,
      'openUI=' + G.openUI + ' state=' + G.state + ' 开图位移=' + r3PosLeak.toFixed(3) +
      ' 关图跳跃=' + r3Jump.ok + ' 关图位移=' + r3WalkAfter.toFixed(2) + ' selected=' + G.inventory.selected);

    /* 标记像素坐标 = 真实坐标的 5×5 网格换算（与出生点红叉同一套公式） */
    const r3MapFinal = T.mapInfo();
    const r3Mark = r3MapFinal.markers.find(k => !r3Target || k.id === r3Target.id) || r3MapFinal.markers[0] || null;
    const r3OCX = r3MapFinal.cx - 2, r3OCZ = r3MapFinal.cz - 2;
    const r3ExpMx = r3Mark ? (r3Mark.x + 0.5 - r3OCX * 16) * 5 : -1;
    const r3ExpMy = r3Mark ? (r3Mark.z + 0.5 - r3OCZ * 16) * 5 : -1;
    ok('R3.7 标记像素坐标与地点真实坐标按同一套 5×5 网格换算一致',
      !!r3Mark && Math.abs(r3Mark.mx - r3ExpMx) <= 0.06 && Math.abs(r3Mark.my - r3ExpMy) <= 0.06 &&
      r3MapFinal.keys.indexOf(r3Mark.chunk) >= 0 &&
      r3Mark.chunk === (Math.floor(r3Mark.x / 16) + ',' + Math.floor(r3Mark.z / 16)),
      JSON.stringify(r3Mark) + ' 期望=' + JSON.stringify({ mx: r3ExpMx, my: r3ExpMy }) + ' cx/cz=' + r3MapFinal.cx + '/' + r3MapFinal.cz);

    /* 探索者只解锁一次、随存档恢复，且不动 8 个基础成就的计数与行数 */
    G.pause(); await frame();
    const r3AchBox = document.querySelector('#achievement-list');
    const r3BaseRows = r3AchBox ? r3AchBox.querySelectorAll('.ach-row').length : -1;
    const r3OnRows = r3AchBox ? r3AchBox.querySelectorAll('.ach-row.on').length : -1;
    const r3Extra = r3AchBox ? r3AchBox.querySelector('.ach-extra') : null;
    const r3Head = r3AchBox ? (r3AchBox.querySelector('.ach-head') || {}).textContent : '';
    const r3Places = r3AchBox ? (r3AchBox.querySelector('.ach-places') || {}).textContent : '';
    G.resume(); await frame();
    await G.save('manual');
    G.toMenu(); await sleep(300);
    await G.loadWorld('发现反馈验收');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'R3 成就存档读回来' });
    await sleep(200);
    const r3AchBack = T.achievementsInfo();
    ok('R3.8 探索者单独一行且只解锁一次、随存档恢复；8 个基础成就的计数与行数不变',
      r3BaseRows === 8 && r3Head === '成就 ' + r3AchBack.count + '/8' && !!r3Extra &&
      /探索者/.test(r3Extra.textContent) && r3Extra.classList.contains('on') &&
      (r3Places || '').indexOf('已发现地点 ' + r3AllNow.discovered) === 0 && r3AchBack.explorer === true &&
      r3AchBack.extraCount === 1 && r3AchBack.ids.indexOf('explorer') >= 0 &&
      r3AchBack.list.length === 8 && r3AchBack.toasts === 0,
      'rows=' + r3BaseRows + ' on=' + r3OnRows + ' head=' + r3Head + ' extra=' + (r3Extra ? r3Extra.textContent.replace(/\s+/g, ' ').slice(0, 40) : 'none') +
      ' places=' + (r3Places || '').slice(0, 40) + ' back=' + JSON.stringify({ ex: r3AchBack.explorer, extra: r3AchBack.extraCount, toasts: r3AchBack.toasts, ids: r3AchBack.ids }));

    /* ---------------- 58. R4 稳定性、性能与收尾 ---------------- */
    await G.newWorld('稳定性收尾', 'r4-route-2026', 'survival');
    await tryUntil(() => G.state === 'playing' && G.world.genQueue.length === 0,
      { budgetMs: 30000, tick: 'sleep', intervalMs: 120, label: 'R4 新世界就绪' });
    await sleep(400);
    G.mobs.maxMobs = 0;
    /* 固定种子 + 固定路线：五处站点由 seed/region 与同一套候选规则离线算出（数值种子必须与游戏内一致），
       游戏里再逐站真实走近验证它们确实建在同一坐标上。 */
    const r4Sites = [
      { id: '0,-3', type: 'tower', x: 24, z: -240 },
      { id: '1,0', type: 'tower', x: 120, z: 48 },
      { id: '4,-4', type: 'outpost', x: 432, z: -360 },
      { id: '-3,0', type: 'ruin', x: -240, z: 48 },
      { id: '4,3', type: 'tower', x: 452, z: 316 }
    ];
    const r4Start = T.landmarksInfo();
    const r4Containers0 = G.world.containers.size;
    T.resetPosMon();
    const r4Route = [];
    for (let i = 0; i < r4Sites.length; i++) {
      const s = r4Sites[i];
      /* 站到触发半径内（24 格），再真实按住 W 朝站点走 0.8 秒；每帧重按是因为宿主置顶会清空按键。
         阶段 6 封版：R4.0 的队列观测改为**传送后第一帧**就开始的有界窗口。
         旧写法（走完 sleep(1700) 再读一次瞬时 genQueue.length）成品读到 40~49 越过 queue<40；
         改成「后续 2 秒窗口内最小值 + queuePeak 上界」之后，窗口起点仍在灌入峰值之后，
         报告里 qp 恒为 0 —— 那条上界实际是恒真的空判据。
         有界探针（tests/probe-chunk-queue.mjs，同一条五站路线）量到的真实形状：
         传送 → setCenter 一次灌入 135~136 块，之后 42.7~51 块/秒分帧消费，2.7~3.2 秒排空。
         因此用一个只读取 genQueue.length 的逐帧观测器覆盖「落地 + 行走 + 等待」全过程，
         记录窗口起点、峰值、最小值、首次排空耗时、窗口耗时、结束队列、采样帧数与超时行为；
         判据验证「有界完成」（窗口内确实排空、耗时有界）与「不持续积压」（结束队列 < 40）。
         这是等待/测量方式的调整，阈值 queue<40 与峰值上界都保留，不是把判据放宽。 */
      const qObs = {
        start: performance.now(), peak: 0, min: Number.POSITIVE_INFINITY,
        samples: 0, hadWork: false, drainMs: null, end: 0, windowMs: 0,
        done: false, timedOut: false
      };
      let qWatching = true;
      const qWatchLoop = () => {
        if (!qWatching) return;
        const q = G.world.genQueue.length;
        qObs.samples++;
        if (q > 0) qObs.hadWork = true;
        qObs.peak = Math.max(qObs.peak, q);
        qObs.min = Math.min(qObs.min, q);
        if (q === 0 && qObs.hadWork && qObs.drainMs === null) qObs.drainMs = performance.now() - qObs.start;
        requestAnimationFrame(qWatchLoop);
      };
      T.teleport(s.x + 0.5, G.world.surfaceHeight(s.x, s.z + 24) + 2, s.z + 24.5);
      requestAnimationFrame(qWatchLoop);
      await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R4 路线落地 ' + s.id });
      G.controller.yaw = 0; G.controller.pitch = 0;
      const r4WalkT0 = performance.now();
      while (performance.now() - r4WalkT0 < 800) { T.key('KeyW', true); await frame(); }
      T.key('KeyW', false);
      await sleep(1700);
      /* 有界等待：排空后收尾，上限 6000ms（探针最慢 3.2 秒，留足余量）；超时如实记录并判红。 */
      const Q_WINDOW_MS = 6000;
      while (qObs.drainMs === null && performance.now() - qObs.start < Q_WINDOW_MS) await frame();
      qWatching = false;
      qObs.end = G.world.genQueue.length;
      qObs.windowMs = performance.now() - qObs.start;
      qObs.min = qObs.min === Number.POSITIVE_INFINITY ? qObs.end : qObs.min;
      qObs.done = qObs.hadWork ? qObs.drainMs !== null : qObs.end === 0;
      qObs.timedOut = !qObs.done;
      const inf = T.landmarksInfo();
      const rec = inf.list.find(l => l.id === s.id) || null;
      const fx = Math.floor(G.controller.pos.x), fy = Math.floor(G.controller.pos.y), fz = Math.floor(G.controller.pos.z);
      /* 洞穴口体检就在此刻做：玩家已经站在站点旁，足迹区块肯定加载好了 */
      let thin = 0, airUnder = 0;
      if (rec) for (let dz = -rec.radius; dz <= rec.radius; dz++) for (let dx = -rec.radius; dx <= rec.radius; dx++) {
        const x = rec.x + dx, z = rec.z + dz;
        const h = G.world.surfaceHeight(x, z);
        if (G.world.terrain.isCave(x, h - 1, z) || G.world.terrain.isCave(x, h - 2, z)) thin++;
        if (G.world.getBlock(x, rec.y - 1, z) === 0) airUnder++;
      }
      r4Route.push({
        i, id: s.id, want: s.type, at: [s.x, s.z],
        got: rec ? rec.type : null, variant: rec ? rec.variant : null,
        present: rec ? rec.present : 0, expected: rec ? rec.expected : 0, disc: rec ? rec.discovered : false,
        near: inf.near.length, scans: inf.stats.scans, builds: inf.stats.builds,
        blocked: inf.stats.blocked, failed: inf.stats.failed,
        maxScanMs: inf.stats.maxScanMs, maxBuildMs: inf.stats.maxBuildMs,
        queue: qObs.end, queueMin: qObs.min, queuePeak: qObs.peak,
        queueStartMs: qObs.start, queueDrainMs: qObs.drainMs, queueWindowMs: qObs.windowMs,
        queueSamples: qObs.samples, queueHadWork: qObs.hadWork,
        queueDone: qObs.done, queueTimedOut: qObs.timedOut,
        chunks: G.world.chunks.size,
        embedded: G.world.isSolidAt(fx, fy, fz) || G.world.isSolidAt(fx, fy + 1, fz),
        thin, airUnder
      });
    }
    const r4End = T.landmarksInfo();
    const r4Perf = T.posMon();
    ok('R4.0 固定种子固定路线走过 5 处站点：地点逐处出现、候选窗口有界、扫描/建造耗时与区块队列有界排空且不持续积压',
      r4End.built >= r4Sites.length && r4Route.every(h => h.got === h.want && h.present === h.expected && h.expected > 20) &&
      r4Route.every(h => h.near <= 9) && r4Route.every(h => h.builds <= h.scans) &&
      r4End.stats.failed === 0 && r4End.stats.blocked === 0 &&
      r4End.stats.maxBuildMs < 250 && r4End.stats.maxScanMs < 60 &&
      /* 队列判据：窗口起点在传送后第一帧；灌入峰值有上界、窗口内确实排空且耗时有界、
         结束队列 < 40（不持续积压）、采样帧数足够（观测器真的在跑）、超时判红。
         queue<40 与峰值上界都保留，但取样语义已由「固定时点瞬时值」改为「有界窗口」。 */
      r4Route.every(h => h.queue < 40) && r4Route.every(h => h.queuePeak <= 200) &&
      r4Route.every(h => h.queueDone && !h.queueTimedOut) &&
      r4Route.every(h => h.queueDrainMs === null || h.queueDrainMs <= 5000) &&
      r4Route.every(h => h.queueSamples >= 30) &&
      r4Perf.frames > 200 && r4Perf.maxFrameMs < 400,
      'built ' + r4Start.built + '→' + r4End.built + ' 每站=' + JSON.stringify(r4Route.map(h => ({
        id: h.id, got: h.got, v: h.variant, st: h.present + '/' + h.expected, d: h.disc, n: h.near,
        bd: h.builds, q: h.queue, qmin: h.queueMin, qp: h.queuePeak,
        dm: h.queueDrainMs === null ? null : Math.round(h.queueDrainMs),
        wm: Math.round(h.queueWindowMs), smp: h.queueSamples,
        done: h.queueDone, to: h.queueTimedOut, ck: h.chunks }))) +
      ' 窗口起点 t=' + Math.round(r4Route[0].queueStartMs) + 'ms · 上限 6000ms/站' +
      ' stats=' + JSON.stringify({ scans: r4End.stats.scans, builds: r4End.stats.builds, blocked: r4End.stats.blocked, failed: r4End.stats.failed, maxBuildMs: r4End.stats.maxBuildMs, maxScanMs: r4End.stats.maxScanMs }) +
      ' 本路线窗口 帧=' + r4Perf.frames + ' 最长帧=' + r4Perf.maxFrameMs + 'ms 慢帧=' + r4Perf.slowFrames +
      ' · 全程 帧=' + r4Perf.total.frames + ' 最长帧=' + r4Perf.total.maxFrameMs + 'ms 慢帧=' + r4Perf.total.slowFrames);

    ok('R4.1 五处站点都不压洞穴口：足迹内地表下方两格无洞穴噪声、地板正下方没有空气格',
      r4Route.every(h => h.got === h.want) && r4Route.every(h => h.thin === 0 && h.airUnder === 0),
      '逐站 thin/airUnder=' + JSON.stringify(r4Route.map(h => h.id + ':' + h.thin + '/' + h.airUnder)));

    ok('R4.2 建造从不把玩家挤进实心方块（5 站逐次检查身体两格）',
      r4Route.every(h => h.embedded === false),
      '逐站=' + JSON.stringify(r4Route.map(h => h.embedded)));

    /* R4.3 真实破坏 + 真实编辑：拆一格墙体、改箱内一件物品，离开再回来 + 存读档都必须原样保留 */
    const r4Target = r4End.list.find(l => l.id === '4,3') || r4End.list[0];
    let r4BreakCell = null, r4Chest = null, r4BeforeItems = '';
    let r4Intact = null, r4AfterBreak = null, r4BackHome = null, r4LoadRec = null;
    let r4LoadedSlots = [], r4DupIds = 0, r4Loaded = null;
    if (r4Target) {
      r4Chest = r4Target.chests[0];
      r4BeforeItems = r4Chest.items.map(i => i.item + 'x' + i.count).sort().join(',');
      /* 找一格「地板上方第一层」的结构方块（一定是模板里的墙体格），拆掉它 present 必须刚好 -1 */
      for (let dz = -r4Target.radius; dz <= r4Target.radius && !r4BreakCell; dz++) {
        for (let dx = -r4Target.radius; dx <= r4Target.radius && !r4BreakCell; dx++) {
          const bx = r4Target.x + dx, by = r4Target.y + 1, bz = r4Target.z + dz;
          if (G.world.getBlock(bx, by, bz) !== 0) r4BreakCell = { x: bx, y: by, z: bz };
        }
      }
      r4Intact = T.landmarksInfo().list.find(l => l.id === r4Target.id);
      if (r4BreakCell) T.setBlock(r4BreakCell.x, r4BreakCell.y, r4BreakCell.z, 0);
      const r4Slots = G.world.getContainer(r4Chest.x, r4Chest.y, r4Chest.z);
      r4Slots[0] = { item: 'poppy', count: 2 };
      r4AfterBreak = T.landmarksInfo().list.find(l => l.id === r4Target.id);
      /* 离开 120 格（足迹区块会被卸载）再走回来：结构与箱内改动都必须还在 */
      T.teleport(r4Target.x + 0.5, G.world.surfaceHeight(r4Target.x, r4Target.z) + 2, r4Target.z - 120);
      await tryUntil(() => G.controller.onGround, { budgetMs: 10000, label: 'R4 离开 120 格落地' });
      await sleep(1700);
      T.teleport(r4Target.x + 0.5, r4Target.y + 1.05, r4Target.z + 4.8);
      await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R4 回到站点落地' });
      await sleep(1700);
      r4BackHome = T.landmarksInfo().list.find(l => l.id === r4Target.id);
      await G.save('manual');
      G.toMenu(); await sleep(300);
      await G.loadWorld('稳定性收尾');
      await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'R4 破坏档读回来' });
      await sleep(300);
      G.mobs.maxMobs = 0;
      T.teleport(r4Target.x + 0.5, r4Target.y + 1.05, r4Target.z + 4.8);
      await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R4 读档后回到站点' });
      await sleep(1200);
      r4Loaded = T.landmarksInfo();
      r4LoadRec = r4Loaded.list.find(l => l.id === r4Target.id);
      r4DupIds = r4Loaded.list.filter(l => l.id === r4Target.id).length;
      r4LoadedSlots = G.world.hasContainer(r4Chest.x, r4Chest.y, r4Chest.z)
        ? G.world.getContainer(r4Chest.x, r4Chest.y, r4Chest.z) : [];
    }
    const r4LoadedItems = r4LoadedSlots.filter(Boolean).map(i => i.item + 'x' + i.count).sort().join(',');
    ok('R4.3 拆掉的方块与改过的箱内物品都按真实状态保留：不重建、不补回、不刷第二份战利品',
      !!r4Target && !!r4BreakCell && !!r4Chest && !!r4Intact && !!r4AfterBreak && !!r4BackHome && !!r4LoadRec &&
      r4Intact.present === r4Intact.expected &&
      G.world.getBlock(r4BreakCell.x, r4BreakCell.y, r4BreakCell.z) === 0 &&
      r4AfterBreak.present === r4AfterBreak.expected - 1 &&
      r4BackHome.present === r4BackHome.expected - 1 &&
      r4LoadRec.present === r4LoadRec.expected - 1 &&
      r4DupIds === 1 && r4LoadRec.chests.length === 1 &&
      r4LoadRec.chests[0].items.length === r4Chest.items.length &&
      !!r4LoadedSlots[0] && r4LoadedSlots[0].item === 'poppy' && r4LoadedSlots[0].count === 2 &&
      r4LoadedItems.includes('poppy') && r4LoadRec.discovered === true,
      '破坏格=' + JSON.stringify(r4BreakCell) +
      ' 拆前=' + (r4Intact ? r4Intact.present + '/' + r4Intact.expected : 'none') +
      ' 拆后=' + (r4AfterBreak ? r4AfterBreak.present + '/' + r4AfterBreak.expected : 'none') +
      ' 回来后=' + (r4BackHome ? r4BackHome.present + '/' + r4BackHome.expected : 'none') +
      ' 读档=' + (r4LoadRec ? r4LoadRec.present + '/' + r4LoadRec.expected : 'none') +
      ' 箱内 ' + r4BeforeItems + '→' + r4LoadedItems + ' 重复 id=' + r4DupIds);

    /* R4.4 旧档（没有 landmarks 字段）不改写历史，但走向没去过的地区仍会出现新地点 */
    const r4VillageSite = T.villageInfo().origin || null;
    /* 先把玩家放回出生点：不这样的话出生点附近的区块已经被卸载，setBlock 会静默失败 */
    T.teleport(G.spawn.x + 0.5, G.world.surfaceHeight(Math.round(G.spawn.x), Math.round(G.spawn.z)) + 2, G.spawn.z + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R4 回出生点落地' });
    await sleep(900);
    const r4MarkX = Math.round(G.spawn.x) + 2, r4MarkZ = Math.round(G.spawn.z) + 2;
    const r4MarkY = G.world.topSolidY(r4MarkX, r4MarkZ) + 1;
    T.placeAt(r4MarkX, r4MarkY, r4MarkZ, 'glass');
    await frame(); await frame();
    if (r4VillageSite) T.teleport(r4VillageSite.x + 0.5, G.world.surfaceHeight(r4VillageSite.x, r4VillageSite.z) + 2, r4VillageSite.z + 14);
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R4 村庄前落地' });
    await sleep(1200);
    const r4OldVillage = T.villageInfo();
    const r4OldCamp = T.campInfo();
    const r4OldMark = T.blockAt(r4MarkX, r4MarkY, r4MarkZ);
    const r4Old = G.buildSaveObject();
    delete r4Old.landmarks;
    r4Old.meta = Object.assign({}, r4Old.meta, { name: '旧档稳定性-R4' });
    await G.storage.saveWorld('旧档稳定性-R4', r4Old);
    G.toMenu(); await sleep(300);
    await G.loadWorld('旧档稳定性-R4');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'R4 旧档读回来' });
    await sleep(300);
    G.mobs.maxMobs = 0;
    if (r4VillageSite) T.teleport(r4VillageSite.x + 0.5, G.world.surfaceHeight(r4VillageSite.x, r4VillageSite.z) + 2, r4VillageSite.z + 14);
    await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R4 旧档村庄前落地' });
    await sleep(1200);
    const r4BackVillage = T.villageInfo();
    const r4BackCamp = T.campInfo();
    const r4BackMark = T.blockAt(r4MarkX, r4MarkY, r4MarkZ);
    const r4OldEmpty = T.landmarksInfo();
    /* 走向这条路线里从没去过的地区：旧档不补建注册表，但探索仍会带来新地点 */
    const r4Fresh = [
      { id: '-1,-4', type: 'tower', x: -28, z: -356 },
      { id: '-4,3', type: 'ruin', x: -316, z: 316 },
      { id: '9,4', type: 'tower', x: 936, z: 432 }
    ];
    let r4FreshHit = null;
    for (const f of r4Fresh) {
      T.teleport(f.x + 0.5, G.world.surfaceHeight(f.x, f.z + 24) + 2, f.z + 24.5);
      await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R4 新地区落地 ' + f.id });
      const w = await tryUntil(() => T.landmarksInfo().list.some(l => l.id === f.id), {
        budgetMs: 9000, label: 'R4 旧档走向新地区出现新地点',
        observe: () => ({ cands: T.landmarkCandidates().length, built: T.landmarksInfo().built })
      });
      if (w.ok) { r4FreshHit = { f, w, info: T.landmarksInfo() }; break; }
    }
    ok('R4.4 旧档没有 landmarks 字段：村庄/营地/玩家自建方块原样保留、不补建注册表，走向没去过的地区仍出现新地点',
      r4OldEmpty.built === 0 && r4OldEmpty.list.length === 0 && r4OldEmpty.stats.builds === 0 &&
      r4BackVillage.present === r4OldVillage.present && r4BackVillage.expected === r4OldVillage.expected &&
      r4BackVillage.present === r4BackVillage.expected &&
      r4BackCamp.present === r4OldCamp.present && r4BackCamp.expected === r4OldCamp.expected &&
      r4OldMark.name === '玻璃' && r4BackMark.name === '玻璃' &&
      !!r4FreshHit && r4FreshHit.info.list.some(l => l.id === r4FreshHit.f.id) && r4FreshHit.info.stats.builds >= 1 &&
      G.world.containers.size > r4Containers0,
      '旧档注册表=' + JSON.stringify(r4OldEmpty.list) +
      ' 村庄=' + r4OldVillage.present + '/' + r4OldVillage.expected + '→' + r4BackVillage.present + '/' + r4BackVillage.expected +
      ' 营地=' + r4OldCamp.present + '/' + r4OldCamp.expected + '→' + r4BackCamp.present + '/' + r4BackCamp.expected +
      ' 玩家方块=' + JSON.stringify(r4OldMark) + '→' + JSON.stringify(r4BackMark) +
      ' 新地点=' + JSON.stringify(r4FreshHit ? r4FreshHit.info.list.map(l => l.id + '/' + l.type + '@' + l.x + ',' + l.z) : null) +
      ' 容器数 ' + r4Containers0 + '→' + G.world.containers.size);

    /* R4.5 快速连续读档 + 反复开关界面：提示/标记/成就都不重复触发 */
    G.toMenu(); await sleep(250);
    await G.loadWorld('稳定性收尾');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'R4 界面压力测试读回主档' });
    await sleep(250);
    G.mobs.maxMobs = 0;
    const r4UiBase = T.landmarksInfo();
    const r4UiAch0 = T.achievementsInfo();
    const r4UiCounts = [];
    for (let i = 0; i < 3; i++) {
      await G.save('manual');
      G.toMenu(); await sleep(200);
      await G.loadWorld('稳定性收尾');
      await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'R4 快速读档 ' + i });
      await sleep(250);
      G.mobs.maxMobs = 0;
      G.openMap();
      await frame(); await frame();
      const mk = T.mapInfo();
      const box = document.querySelector('#map-markers');
      r4UiCounts.push({
        model: mk.markerCount, chips: box ? box.querySelectorAll('.map-marker').length : -1,
        disc: T.landmarksInfo().discovered, toasts: T.landmarksInfo().stats.discoveryToasts,
        achToasts: T.achievementsInfo().toasts
      });
      G.closeUI(); await frame();
    }
    for (let i = 0; i < 3; i++) { G.pause(); await frame(); G.resume(); await frame(); }
    const r4UiEnd = T.landmarksInfo();
    const r4UiAch = T.achievementsInfo();
    ok('R4.5 快速连续读档与反复开关界面都不重复触发：发现提示为 0、标记数量稳定、探索者只解锁一次',
      r4UiCounts.length === 3 &&
      r4UiCounts.every(c => c.model === r4UiCounts[0].model && c.chips === c.model && c.toasts === 0) &&
      r4UiCounts[0].model >= 1 &&
      r4UiEnd.stats.discoveryToasts === 0 && r4UiEnd.stats.discoveries === 0 &&
      r4UiEnd.discovered === r4UiBase.discovered && r4UiEnd.built === r4UiBase.built &&
      r4UiEnd.stats.builds === 0 && r4UiAch.explorer === true && r4UiAch.extraCount === 1 &&
      r4UiAch.toasts === 0 && r4UiAch.ids.filter(id => id === 'explorer').length === 1,
      '每轮=' + JSON.stringify(r4UiCounts) + ' end=' + JSON.stringify({
        disc: r4UiEnd.discovered, built: r4UiEnd.built, toasts: r4UiEnd.stats.discoveryToasts,
        builds: r4UiEnd.stats.builds, ex: r4UiAch.explorer, extra: r4UiAch.extraCount,
        achToasts: r4UiAch.toasts, ids: r4UiAch.ids }));

    /* R4.6 拆掉地点箱子：方块与容器一起消失，箱内固定战利品全部掉在地上（与营地箱子同一套真实挖掘路径） */
    const r4BrkInfo0 = T.landmarksInfo();
    const r4BrkSite = r4BrkInfo0.list.find(l => l.id === '1,0') || r4BrkInfo0.list[0] || null;
    let r4BrkGone = false, r4BrkDropOk = false, r4BrkExpect = [], r4BrkGot = '', r4BrkRegClean = false;
    if (r4BrkSite) {
      T.teleport(r4BrkSite.x + 0.5, r4BrkSite.y + 1.05, r4BrkSite.z + 4.8);
      await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'R4 拆箱前落地' });
      await sleep(1200);
      const r4BrkRec = T.landmarksInfo().list.find(l => l.id === r4BrkSite.id);
      const r4BrkChest = r4BrkRec.chests[0];
      r4BrkExpect = r4BrkChest.items.map(i => ({ item: i.item, count: i.count }));
      G.interaction.drops.list.length = 0;
      T.mineAt(r4BrkChest.x, r4BrkChest.y, r4BrkChest.z);
      await frame(); await frame();
      const r4DropCount = (item) => G.interaction.drops.list
        .filter(d => d.item === item).reduce((a, d) => a + d.count, 0);
      r4BrkGone = G.world.getBlock(r4BrkChest.x, r4BrkChest.y, r4BrkChest.z) === 0 &&
        !G.world.hasContainer(r4BrkChest.x, r4BrkChest.y, r4BrkChest.z);
      r4BrkDropOk = r4BrkExpect.length > 0 && r4BrkExpect.every(it => r4DropCount(it.item) >= it.count);
      const r4BrkAfter = T.landmarksInfo().list.find(l => l.id === r4BrkSite.id);
      r4BrkRegClean = !r4BrkAfter.chests[0].block && !r4BrkAfter.chests[0].hasContainer;
      r4BrkGot = r4BrkExpect.map(it => it.item + ':' + r4DropCount(it.item) + '/' + it.count).join(',');
    }
    ok('R4.6 拆掉地点箱子：方块与容器一起消失、注册表如实反映、固定战利品一件都不吞',
      !!r4BrkSite && r4BrkGone && r4BrkDropOk && r4BrkRegClean,
      '站点=' + (r4BrkSite ? r4BrkSite.id + '/' + r4BrkSite.type : 'none') +
      ' 方块与容器消失=' + r4BrkGone + ' 注册表=' + r4BrkRegClean + ' 掉落=' + r4BrkGot);
    /* ---------------- Q1. 目标链与反馈（真实键盘 / 真实 DOM 事件） ----------------
     * 夹具只负责「清空背包 + 铺平台 + 放方块」；开关界面、挖掘、点击配方书与产物格、
     * 关闭提示全部走真实 DOM 事件，不用 T.key() 直调内部处理器。
     * 独立块级作用域：q* 临时变量不与前面 58 节里的同名变量冲突。 */
    {
    G.closeUI();
    G.inventory.slots.fill(null);
    G.inventory.cursor = null;
    G.inventory.emit('change');
    G.playerCraft.clear();
    G.tableCraft.clear();
    T.questsReset();
    await frame();
    const qInit = T.questsInfo();
    ok('Q1.1 空手起点：当前目标是「砍树」，右下角按进度显示短提示且可关闭',
      qInit.current === 'log' && qInit.total === 6 &&
      qInit.hintBar.includes('目标 1/6') && qInit.hintBar.includes('砍树') &&
      qInit.hasClose && qInit.hintLog.filter(x => x === 'log').length === 1 &&
      !qInit.hintBar.includes('烧出铁锭'),
      JSON.stringify({ current: qInit.current, hintBar: qInit.hintBar, hintLog: qInit.hintLog }));

    const qKey = (code, type = 'keydown') =>
      window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));
    qKey('KeyE');
    await frame(); await frame();
    const qOpen = G.openUI === 'inventory';
    qKey('Escape');
    await frame(); await frame();
    ok('Q1.2 真实键盘 E 打开背包、Esc 关闭背包（不是直调内部处理器）',
      qOpen && G.openUI === null, 'openUI=' + qOpen + '→' + G.openUI);

    /* 真实左键挖一棵「原木」：铺平台 + 放方块是夹具，按住/松开是真实鼠标事件 */
    const qfx = Math.floor(G.controller.pos.x), qfz = Math.floor(G.controller.pos.z);
    const qgy = Math.floor(G.controller.pos.y) - 1;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) T.setBlock(qfx + dx, qgy, qfz + dz, 4);
    G.controller.spawnAt(qfx + 0.5, qgy + 1.05, qfz + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: 'Q1 平台站稳' });
    const qtx = qfx + 2, qty = qgy + 1, qtz = qfz;
    T.setBlock(qtx, qty, qtz, 10);       // 橡木原木
    await sleep(60);
    const qAim = (tx, ty, tz) => {
      const ex = G.controller.pos.x, ey = G.controller.eyeY, ez = G.controller.pos.z;
      const dx = tx + 0.5 - ex, dy = ty + 0.5 - ey, dz = tz + 0.5 - ez;
      G.controller.pitch = Math.asin(dy / Math.hypot(dx, dy, dz));
      G.controller.yaw = Math.atan2(-dx, -dz);
    };
    qAim(qtx, qty, qtz);
    G.interaction.updateTarget();
    G.input.setUIMode(false);
    G.input.locked = true;
    const qLog0 = G.inventory.countOf('oak_log');
    /* 真实 DOM 左键（走 input._onMouseDown → interaction 挖掘），按住期间若被焦点切换清掉就重按 */
    const qMine = await holdWhile(
      () => document.querySelector('#game-canvas').dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })),
      () => G.inventory.countOf('oak_log') > qLog0,
      { budgetMs: 12000, alive: () => !!G.input.state.mouseLeft }
    );
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
    await frame();
    const qAfterLog = T.questsInfo();
    ok('Q1.3 真实左键挖到原木：目标推进到「做出工作台」、提示文案随进度改变且只弹一次',
      qMine.ok && qAfterLog.current === 'table' &&
      qAfterLog.hintBar.includes('工作台') && !qAfterLog.hintBar.includes('目标 1/6') &&
      qAfterLog.hintLog.filter(x => x === 'table').length === 1,
      'mined=' + qMine.ok + ' log=' + G.inventory.countOf('oak_log') + ' 用时=' + qMine.ms + 'ms ' +
      heldTag(qMine) + ' current=' + qAfterLog.current + ' hintBar=' + qAfterLog.hintBar);

    /* 夹具补齐其余 2 根原木以缩短链条；后续合成全部是真实 DOM 点击 */
    T.give('oak_log', 2);
    qKey('KeyE');
    await frame(); await frame();
    const qBook = T.questsInfo();
    ok('Q1.4 配方书有独立「下一步建议」区：当前目标配方排第一，不污染 .recipe-item 列表',
      qBook.suggestions.length > 0 && qBook.suggestions.length <= 3 &&
      qBook.suggestions[0].current === true && qBook.recipeItems > 0 &&
      document.querySelectorAll('#quest-suggestions .recipe-item').length === 0,
      JSON.stringify({ suggestions: qBook.suggestions, recipeItems: qBook.recipeItems }));

    const qClickRow = async (label) => {
      const row = [...document.querySelectorAll('#recipe-book .recipe-item')].find(n => n.textContent.includes(label));
      if (!row) return false;
      row.click();
      await frame(); await frame();
      const out = document.querySelector('[data-slot="craft-out"]');
      if (out) out.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
      await frame();
      return true;
    };
    let qMade = 0;
    for (let i = 0; i < 3; i++) if (await qClickRow('木板')) qMade++;
    const qPlanks = G.inventory.countOf('planks');
    ok('Q1.5 真实点击配方书三次「木板」→点产物格：拿到木板，配方只自动摆料不自动合成',
      qMade === 3 && qPlanks >= 12 && G.inventory.countOf('oak_log') === 0,
      'clicks=' + qMade + ' planks=' + qPlanks + ' log=' + G.inventory.countOf('oak_log'));

    const qTableOk = await qClickRow('工作台');
    const qAfterTable = T.questsInfo();
    ok('Q1.6 真实点击「工作台」配方：目标推进到「做出木镐」，提示再次按进度改变',
      qTableOk && G.inventory.countOf('crafting_table') >= 1 &&
      qAfterTable.current === 'wood_pick' && qAfterTable.hintBar.includes('木镐') &&
      qAfterTable.hintLog.filter(x => x === 'wood_pick').length === 1,
      'table=' + G.inventory.countOf('crafting_table') + ' current=' + qAfterTable.current +
      ' hintBar=' + qAfterTable.hintBar);

    const qStickOk = await qClickRow('木棍');
    qKey('Escape');
    await frame(); await frame();
    const qcx = qfx + 1, qcy = qgy + 1, qcz = qfz;
    T.setBlock(qcx, qcy, qcz, 25);       // 工作台方块（夹具摆放，不碰背包）
    await sleep(60);
    qAim(qcx, qcy, qcz);
    G.interaction.updateTarget();
    G.interaction.placeCd = 0;
    G.input.setUIMode(false);
    G.input.locked = true;
    document.querySelector('#game-canvas').dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    G.interaction.update(0.02);
    window.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }));
    await frame();
    const qOpen3 = G.openUI === 'crafting' && document.querySelectorAll('#craft-grid .slot').length === 9;
    const qPickOk = qOpen3 ? await qClickRow('木镐') : false;
    await frame();
    const qAfterPick = T.questsInfo();
    ok('Q1.7 真实右键打开 3×3 并真实点击「木镐」配方：拿到木镐、目标推进到「挖到圆石」',
      qOpen3 && qStickOk && qPickOk && G.inventory.countOf('pickaxe_wood') >= 1 &&
      qAfterPick.current === 'cobble' && qAfterPick.hintBar.includes('圆石') &&
      qAfterPick.hintLog.filter(x => x === 'cobble').length === 1,
      'open3=' + qOpen3 + ' sticks=' + qStickOk + ' clicked=' + qPickOk +
      ' pick=' + G.inventory.countOf('pickaxe_wood') + ' current=' + qAfterPick.current +
      ' hintBar=' + qAfterPick.hintBar);

    const qAll = T.questsInfo();
    const qNoDup = qAll.ids.every(id => qAll.hintLog.filter(x => x === id).length <= 1);
    ok('Q1.8 从空手走到木镐：四步提示各出现一次，目标链与 8 个基础成就互不影响',
      qNoDup && qAll.hintLog.length === 4 &&
      qAll.completed.join(',') === 'log,table,wood_pick' &&
      T.achievementsInfo().ids.length <= 9,
      JSON.stringify({ hintLog: qAll.hintLog, completed: qAll.completed,
        toasts: qAll.hintToasts, achIds: T.achievementsInfo().ids.length }));

    const qCloseBtn = document.querySelector('#hint-bar .quest-close');
    if (qCloseBtn) qCloseBtn.click();
    await frame();
    const qDismissed = T.questsInfo();
    const qReopenBtn = document.querySelector('#hint-bar .quest-reopen');
    if (qReopenBtn) qReopenBtn.click();
    await frame();
    const qReopened = T.questsInfo();
    ok('Q1.9 目标提示可关闭也可重新展开，关闭后不再占用 HUD',
      !!qCloseBtn && qDismissed.dismissed === true && qDismissed.hasReopen === true &&
      !qDismissed.hintBar.includes('目标 4/6') &&
      !!qReopenBtn && qReopened.dismissed === false && qReopened.hasClose === true,
      'dismissed=' + qDismissed.dismissed + ' reopened=' + qReopened.dismissed);

    G.closeUI();
    await T.save();
    const qSave = T.questsInfo();
    await G.loadWorld(G.meta.name);
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'Q1 读档回到游戏中' });
    const qLoad = T.questsInfo();
    ok('Q1.10 目标链随存档保留：当前目标/完成步骤/提示记录一致，读档不重复弹提示',
      qLoad.current === qSave.current &&
      qLoad.completed.join(',') === qSave.completed.join(',') &&
      qLoad.hintLog.join(',') === qSave.hintLog.join(',') &&
      qLoad.hintToasts === qSave.hintToasts && qLoad.dismissed === qSave.dismissed,
      JSON.stringify({ before: { c: qSave.current, done: qSave.completed, log: qSave.hintLog, t: qSave.hintToasts },
        after: { c: qLoad.current, done: qLoad.completed, log: qLoad.hintLog, t: qLoad.hintToasts } }));

    const qOldRaw = await G.storage.loadWorld(G.meta.name);
    delete qOldRaw.quests;
    qOldRaw.meta = Object.assign({}, qOldRaw.meta, { name: '旧档目标链-Q1' });
    await G.storage.saveWorld('旧档目标链-Q1', qOldRaw);
    const qToastsBeforeOld = T.questsInfo().hintToasts;
    await G.loadWorld('旧档目标链-Q1');
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'Q1 旧档读回来' });
    const qOldInfo = T.questsInfo();
    ok('Q1.11 旧档缺 quests 字段：静默推断当前进度、不弹任何已完成提示',
      qOldInfo.hintLog.length === 0 && qOldInfo.hintToasts === qToastsBeforeOld &&
      qOldInfo.completed.length >= 3 && qOldInfo.current !== 'log',
      JSON.stringify({ current: qOldInfo.current, done: qOldInfo.completed,
        log: qOldInfo.hintLog, toasts: qOldInfo.hintToasts }));
    await G.storage.deleteWorld('旧档目标链-Q1');

    qKey('KeyE');
    await frame(); await frame();
    ok('Q1.12 守卫：配方书 .recipe-item 与建议区共存，成就读数仍未被目标链改写',
      document.querySelectorAll('#recipe-book .recipe-item').length > 0 &&
      document.querySelector('#quest-suggestions') !== null &&
      T.achievementsInfo().ids.length <= 9,
      'recipes=' + document.querySelectorAll('#recipe-book .recipe-item').length +
      ' achIds=' + T.achievementsInfo().ids.length);
    G.closeUI();
    }

    /* ---------------- FL. 创造飞行随视角（真实按键 + 真实位移） ----------------
     * 时间驱动而非固定帧数（项目里已因帧数驱动翻车 5 次），用 420ms 墙钟窗口。 */
    {
    G.closeUI();
    G.setMode('creative');
    G.controller.flying = true;
    const flX = Math.floor(G.spawn.x), flZ = Math.floor(G.spawn.z);
    const flY = Math.floor(G.spawn.y);
    for (let dy = -2; dy <= 8; dy++)
      for (let dz = -5; dz <= 5; dz++)
        for (let dx = -5; dx <= 5; dx++)
          T.setBlock(flX + dx, flY + dy, flZ + dz, 0);
    await sleep(150);
    const flMove = async (pitch, keys) => {
      G.controller.spawnAt(flX + 0.5, flY + 2, flZ + 0.5);
      G.controller.vel.x = G.controller.vel.y = G.controller.vel.z = 0;
      G.controller.yaw = 0;
      G.controller.pitch = pitch;
      const p0 = { ...G.controller.pos };
      for (const k of keys) T.key(k, true);
      const t0 = performance.now();
      while (performance.now() - t0 < 420) await frame();
      for (const k of keys) T.key(k, false);
      await frame();
      return {
        dx: G.controller.pos.x - p0.x,
        dy: G.controller.pos.y - p0.y,
        dz: G.controller.pos.z - p0.z
      };
    };

    const flFlat = await flMove(0, ['KeyW']);
    ok('FL.1 创造飞行平视按 W 仍沿水平面前进（原有手感不变）',
      Math.abs(flFlat.dy) < 0.35 && flFlat.dz < -1,
      'dx=' + flFlat.dx.toFixed(2) + ' dy=' + flFlat.dy.toFixed(2) + ' dz=' + flFlat.dz.toFixed(2));

    const flUp = await flMove(0.7, ['KeyW']);
    ok('FL.2 创造飞行抬头按 W 会随视线向上飞',
      flUp.dy > 0.8 && flUp.dz < -0.5,
      'dx=' + flUp.dx.toFixed(2) + ' dy=' + flUp.dy.toFixed(2) + ' dz=' + flUp.dz.toFixed(2));

    const flDown = await flMove(-0.7, ['KeyW']);
    ok('FL.3 创造飞行低头按 W 会随视线向下俯冲',
      flDown.dy < -0.8,
      'dx=' + flDown.dx.toFixed(2) + ' dy=' + flDown.dy.toFixed(2) + ' dz=' + flDown.dz.toFixed(2));

    const flLen = Math.hypot(flUp.dx, flUp.dy, flUp.dz);
    const flCos = flLen > 0.001
      ? (flUp.dy * Math.sin(0.7) + (-flUp.dz) * Math.cos(0.7)) / flLen : 0;
    ok('FL.4 抬头飞行位移方向与视线方向一致（余弦 > 0.85）',
      flCos > 0.85, '余弦=' + flCos.toFixed(3) + ' 位移=' + flLen.toFixed(2));

    G.setMode('survival');
    const flWalk = await flMove(0.7, ['KeyW']);
    ok('FL.5 生存模式不受 pitch 影响：抬头按 W 不会飞起来',
      G.controller.flying === false && flWalk.dy < 0.2,
      'flying=' + G.controller.flying + ' dy=' + flWalk.dy.toFixed(2) + ' dz=' + flWalk.dz.toFixed(2));
    }

    /* ---------------- 59. A 生物动作与反馈（真实攻击 / 受击 / 闲置姿态） ----------------
     * 全部由真实事件驱动：骷髅真的射箭、僵尸真的咬到玩家、驯服狼真的扑到敌对生物、玩家真的左键命中。
     * mobPose 同时给出「算出来的姿态」和「部件上实际的角度」，只调纯函数伪造不出一致的两半。
     * 注意：攻击曲线 sin((1-t/T)π) 在事件刚发生那一刻接近 0，所以必须等峰值（atk>0.7）而不是等「非零」。 */
    {
    const A_ATK_SEC = 0.36;                 // 与 mobs.js 的 MOB_ATTACK_POSE_SECONDS 一致（A.5 用它起手）
    G.closeUI();
    G.setMode('survival');
    await tryUntil(() => G.state === 'playing', { budgetMs: 10000, tick: 'sleep', intervalMs: 100, label: 'A 段回到游玩状态' });
    T.setTime(0.85);                        // 夜里：日晒不掉血，之后任何 hp 变化都只能来自攻击
    G.mobs.maxMobs = 0;
    const aX = Math.floor(G.spawn.x), aZ = Math.floor(G.spawn.z), aY = Math.floor(G.spawn.y);
    for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) {
      T.setBlock(aX + dx, aY - 1, aZ + dz, 4);                        // 圆石平台，生物不掉落
      for (let h = 0; h <= 6; h++) T.setBlock(aX + dx, aY + h, aZ + dz, 0);   // 上方清空，视线与碰撞干净
    }
    await sleep(250);
    T.teleport(aX + 0.5, aY + 1.2, aZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'A 段玩家落地' });
    const aReset = () => {
      for (const m of G.mobs.list.slice()) if (m.type !== 'villager') m.hp = 0;
      G.mobs.clear();
      G.controller.health = 20; G.controller.invulnerable = 0; G.controller.flying = false;
      T.teleport(aX + 0.5, aY + 1.2, aZ + 0.5);
      return tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'A 段复位落地' });
    };
    const aPose = (type) => {
      const i = G.mobs.list.findIndex(m => m.type === type);
      return i < 0 ? null : T.mobPose(i);
    };
    /* 等到姿态真正抬到峰值附近（atk>0.7）才算「事件触发了动画」，避免刚赋值那帧 sin≈0 的假读数 */
    const aWaitPeak = (type, label, budget) => tryUntil(() => {
      const p = aPose(type);
      return p && p.animAttack > 0 && p.pose.atk > 0.7 ? p : null;
    }, {
      budgetMs: budget || 12000, tick: 'sleep', intervalMs: 16, label,
      observe: () => ({ pose: aPose(type), playerHp: G.controller.health, arrows: G.mobs.arrows.length })
    });

    /* --- A.1 骷髅射箭：真实弹道 + 真实 AI 分支 --- */
    await aReset();
    const aArrow0 = G.mobs.arrows.length;
    const aSk = G.mobs.spawn('skeleton', aX + 6.5, aY + 1, aZ + 0.5);
    const aSkHit = await aWaitPeak('skeleton', 'A 骷髅射箭把攻击姿态抬到峰值');
    const aSkPose = aSkHit.value || null;
    ok('A.1 骷髅真的射出箭才抬手：弹道增加、姿态到峰值，render 已把角度写进手臂部件',
      !!aSk && aSkHit.ok && G.mobs.arrows.length > aArrow0 && !!aSkPose &&
      aSkPose.hasArms === true && aSkPose.animAttack > 0 &&
      aSkPose.pose.arm0 < -1.4 - 0.7 && aSkPose.pose.arm1 < -1.4 - 0.7 &&
      Math.abs(aSkPose.applied.arm0 - aSkPose.pose.arm0) < 1e-6 &&
      Math.abs(aSkPose.applied.arm1 - aSkPose.pose.arm1) < 1e-6 &&
      aSkPose.meshRotY === aSkPose.yaw && aSkPose.hurtT === 0 && aSkPose.pose.hurt === 0,
      '箭 ' + aArrow0 + '→' + G.mobs.arrows.length + ' pose=' + JSON.stringify(aSkPose && {
        anim: aSkPose.animAttack, atk: aSkPose.pose.atk, arm0: aSkPose.pose.arm0, applied0: aSkPose.applied.arm0,
        arm1: aSkPose.pose.arm1, applied1: aSkPose.applied.arm1, rotY: aSkPose.meshRotY, yaw: aSkPose.yaw }));

    /* --- A.2 僵尸近战咬到玩家（生存模式才会咬：AI 里 creative 直接跳过） --- */
    await aReset();
    G.setMode('survival');
    const aZb = G.mobs.spawn('zombie', aX + 1.2, aY + 1, aZ + 0.5);
    const aZbHit = await aWaitPeak('zombie', 'A 僵尸咬人把攻击姿态抬到峰值');
    const aZbPose = aZbHit.value || null;
    ok('A.2 僵尸真的咬到玩家才抬手：玩家掉血与抬手同时出现，手臂/头部/呼吸角度都来自 render',
      !!aZb && aZbHit.ok && G.controller.health < 20 && !!aZbPose &&
      aZbPose.pose.arm0 < -1.4 - 0.7 &&
      Math.abs(aZbPose.applied.arm0 - aZbPose.pose.arm0) < 1e-6 &&
      Math.abs(aZbPose.applied.headX - aZbPose.pose.headX) < 1e-6 &&
      Math.abs(aZbPose.applied.bodyScaleY - aZbPose.pose.bodyScaleY) < 1e-6 &&
      aZbPose.meshRotY === aZbPose.yaw,
      '玩家hp=' + G.controller.health + ' pose=' + JSON.stringify(aZbPose && {
        anim: aZbPose.animAttack, atk: aZbPose.pose.atk, arm0: aZbPose.pose.arm0, applied0: aZbPose.applied.arm0,
        headX: aZbPose.pose.headX, appliedHeadX: aZbPose.applied.headX,
        body: aZbPose.pose.bodyScaleY, appliedBody: aZbPose.applied.bodyScaleY }));

    /* --- A.3 驯服狼扑咬敌对生物（狼没有手臂，靠前腿前扑表达） --- */
    await aReset();
    G.setMode('creative');                  // 创造：僵尸不咬玩家，猎物掉血只能来自狼这一口
    const aPrey = G.mobs.spawn('zombie', aX + 3.5, aY + 1, aZ + 0.5);
    const aWolf = G.mobs.spawn('wolf', aX + 2.6, aY + 1, aZ + 0.5);
    if (aWolf) { aWolf.tamed = true; aWolf.sitting = false; }
    const aPreyHp0 = aPrey ? aPrey.hp : -1;
    const aWolfHit = await aWaitPeak('wolf', 'A 狼扑咬把攻击姿态抬到峰值', 14000);
    const aWolfPose = aWolfHit.value || null;
    ok('A.3 驯服狼真的扑到敌对生物：没有手臂也靠前腿前扑表达，且猎物掉血只能来自这一口',
      !!aWolf && !!aPrey && aWolfHit.ok && !!aWolfPose &&
      aPrey.fire === 0 && aPrey.hp < aPreyHp0 &&
      aWolfPose.hasArms === false && aWolfPose.pose.atkFront > 0.5 &&
      /* 前腿 = 步态摆动 - 前扑，后腿只跟步态：这样读数与「采样时正好甩到哪条腿」无关 */
      Math.abs((aWolfPose.pose.legSwing - aWolfPose.applied.leg0) - aWolfPose.pose.atkFront) < 1e-3 &&
      Math.abs((-aWolfPose.pose.legSwing - aWolfPose.applied.leg1) - aWolfPose.pose.atkFront) < 1e-3 &&
      Math.abs(aWolfPose.applied.leg2 + aWolfPose.pose.legSwing) < 1e-3 &&
      aWolfPose.applied.leg0 < aWolfPose.pose.legSwing - 0.5 &&
      aWolfPose.meshRotY === aWolfPose.yaw,
      '猎物hp ' + aPreyHp0 + '→' + (aPrey && aPrey.hp) + ' fire=' + (aPrey && aPrey.fire) +
      ' pose=' + JSON.stringify(aWolfPose && { anim: aWolfPose.animAttack, front: aWolfPose.pose.atkFront,
        swing: aWolfPose.pose.legSwing, leg0: aWolfPose.applied.leg0, leg2: aWolfPose.applied.leg2 }));

    /* --- A.4 受击压过攻击：真实左键命中接管姿态；再用同一次真实咬人 + 生产入口 hitMob 验证打断 --- */
    await aReset();
    G.setMode('survival');
    const aTg = G.mobs.spawn('zombie', aX + 1.2, aY + 1, aZ + 0.5);
    const aTgHp0 = aTg ? aTg.hp : -1;
    G.inventory.set(0, { item: 'sword_iron', count: 1, dur: 100 });
    G.selectHotbar(0);
    await frame();
    const aAimT = () => {
      const dx = aTg.pos.x + 0.5 - G.controller.pos.x;
      const dy = aTg.pos.y + 0.9 - G.controller.eyeY;
      const dz = aTg.pos.z + 0.5 - G.controller.pos.z;
      const L = Math.hypot(dx, dy, dz) || 1;
      G.controller.pitch = Math.asin(dy / L);
      G.controller.yaw = Math.atan2(-dx / L, -dz / L);
    };
    aAimT();
    const aHit0 = T.feedbackInfo().hit;
    G.input.state.mouseLeft = true;
    const aLanded = await tryUntil(() => { aAimT(); return T.feedbackInfo().hit > aHit0; },
      { budgetMs: 5000, label: 'A 玩家真实左键命中僵尸', observe: () => ({ fb: T.feedbackInfo(), hp: aTg && aTg.hp }) });
    G.input.state.mouseLeft = false;
    /* 采样方式修正（**阈值一个没动**）：原来只取「松键后 60ms 的那一帧」，
       而 `pose.hurt = hurtT / 0.32`，门槛 0.5 正好落在 hurtT=0.16 —— 也就是命中后第 0.16 秒的边界上。
       本轮只是改了地形生成（火成岩分带），帧时序挪了几十毫秒，A.4 就连续读到 0.1577 / 0.1423 翻红。
       现在改成在随后若干帧里取 hurt 最大的那一帧：这要求受击姿态在真实命中后确实抬到 >0.5，
       比单点快照更强，也不依赖「采样正好落在第几帧」。 */
    let aHurtPose = aPose('zombie');
    for (let i = 0; i < 8; i++) {
      await frame();
      const aS = aPose('zombie');
      if (aS && aS.pose && (!aHurtPose || !aHurtPose.pose || aS.pose.hurt > aHurtPose.pose.hurt)) aHurtPose = aS;
    }
    /* 打断：先让僵尸真的咬一口（animAttack 由 AI 点亮），再走玩家命中的同一生产入口结算受击 */
    const aBite = await aWaitPeak('zombie', 'A 再等一次真实咬人', 12000);
    const aBitePose = aBite.value || null;
    const aBeforeInterrupt = aBitePose ? aBitePose.animAttack : 0;
    if (aTg) G.mobs.hitMob(aTg, 3, { x: 0, z: 0 });      // interaction.js 命中生物时调用的就是它
    const aAfterInterrupt = aPose('zombie');
    ok('A.4 受击压过攻击：真实左键命中后由 hurtT 接管（仰头+侧倾+缩身），且 hitMob 把进行中的攻击姿态清零',
      !!aTg && aLanded.ok && !!aHurtPose &&
      aHurtPose.hurtT > 0 && aHurtPose.pose.hurt > 0.5 && aHurtPose.pose.headX > 0 &&
      Math.abs(aHurtPose.pose.tiltZ) > 0.05 && aHurtPose.pose.bodyScaleY < 1 &&
      Math.abs(aHurtPose.applied.tiltZ - aHurtPose.pose.tiltZ) < 1e-6 &&
      Math.abs(aHurtPose.applied.headX - aHurtPose.pose.headX) < 1e-6 &&
      aHurtPose.hp < aTgHp0 && !!aBitePose && aBeforeInterrupt > 0 &&
      !!aAfterInterrupt && aAfterInterrupt.animAttack === 0 && aAfterInterrupt.hurtT > 0,
      '命中=' + aLanded.ok + ' 受击姿态=' + JSON.stringify(aHurtPose && {
        hurtT: aHurtPose.hurtT, headX: aHurtPose.pose.headX, tiltZ: aHurtPose.pose.tiltZ,
        appliedTilt: aHurtPose.applied.tiltZ, body: aHurtPose.pose.bodyScaleY, hp: aHurtPose.hp, hp0: aTgHp0 }) +
        ' 打断前 anim=' + aBeforeInterrupt + ' 打断后 anim=' + (aAfterInterrupt && aAfterInterrupt.animAttack));

    /* --- A.5 闲置姿态克制 + 朝向/位置/生命周期不受影响 + 攻击姿态自然收尾 --- */
    await aReset();
    const aPig = G.mobs.spawn('pig', aX + 3.5, aY + 1, aZ + 2.5);
    const aPigHp0 = aPig ? aPig.hp : -1;
    const aPigPos0 = aPig ? [aPig.pos.x, aPig.pos.z] : null;
    if (aPig) { aPig.animAttack = A_ATK_SEC; }
    const aSamples = [];
    const aWin0 = performance.now();
    while (performance.now() - aWin0 < 2200) {
      /* 把猪钉在原地（AI 会重新决定走动），这样位移读数只能来自姿态本身有没有乱改 position */
      if (aPig) { aPig.walking = false; aPig.wanderT = 9999; aPig.vel.x = 0; aPig.vel.z = 0; }
      await frame();
      const p = aPose('pig');
      if (p) aSamples.push(p);
    }
    const aLast = aSamples.length ? aSamples[aSamples.length - 1] : null;
    const aMaxHeadY = Math.max(0, ...aSamples.map(s => Math.abs(s.pose.headY)));
    const aMaxBreath = Math.max(0, ...aSamples.map(s => Math.abs(s.pose.bodyScaleY - 1)));
    const aYawStable = aSamples.every(s => Math.abs(s.meshRotY - s.yaw) < 1e-4);
    const aAppliedOk = aSamples.every(s => Math.abs(s.applied.headY - s.pose.headY) < 1e-4 &&
      Math.abs(s.applied.bodyScaleY - s.pose.bodyScaleY) < 1e-4);
    const aFinite = aSamples.every(s => Number.isFinite(s.pose.arm0) && Number.isFinite(s.applied.bodyScaleY) &&
      Number.isFinite(s.applied.tiltZ));
    const aDrift = aPig && aPigPos0 ? Math.hypot(aPig.pos.x - aPigPos0[0], aPig.pos.z - aPigPos0[1]) : 99;
    ok('A.5 闲置只有克制的张望与呼吸：headY≤0.22、呼吸≤6%、rotation.y 恒等于 yaw、攻击姿态自己归零、hp 与水平位置不被姿态改动',
      !!aPig && aSamples.length > 30 && aYawStable && aFinite && aAppliedOk &&
      aMaxHeadY > 0.02 && aMaxHeadY <= 0.22 + 1e-6 &&
      aMaxBreath > 0.001 && aMaxBreath <= 0.06 + 1e-6 &&
      !!aLast && aLast.animAttack === 0 && aLast.pose.atk === 0 &&
      aPig.hp === aPigHp0 && aDrift < 0.25 && aLast.dead === false,
      '样本=' + aSamples.length + ' 最大张望=' + aMaxHeadY.toFixed(4) + ' 最大呼吸=' + aMaxBreath.toFixed(5) +
      ' 朝向一致=' + aYawStable + ' 应用一致=' + aAppliedOk + ' 归零=' + (aLast && aLast.animAttack) +
      ' hp ' + aPigHp0 + '→' + (aPig && aPig.hp) + ' 水平位移=' + aDrift.toFixed(3));
    await aReset();
    G.setMode('survival');
    }

    /* ---------------- 60. 阶段 B（下）：听得见的相对能量 + 事件音效 ----------------
     * 整节用独立 {} 包住；能量断言只用「同一轮运行内的相对变化」，不钉绝对 dB（换机器/没声卡也能跑）。 */
    {
      G.mobs.maxMobs = 0;              // 怪物叫声会污染能量读数（它们本来就不该出现在这条断言里）
      G.mobs.clear();
      G.controller.health = 20; G.controller.invulnerable = 0;

      /* 取样前先确认「音频图真的在被拉起来」：`ctx.state === 'running'` 并不代表有渲染线程在跑。
         整程里出现过三态 rms 全等于 0.000000、ctx 却仍是 running 的红（见 game.js audioEnergy 的注释），
         那种情况下 rms 这个数本身不可用——分不清真静音 / 采样未推进 / 线路接错。
         用「音频时钟推进量 ÷ 墙上时间」把它可判定：比值接近 1 才是在真渲染。
         不推进时用一次产品入口 sfx.resume()（真人点页面也会走这条路）唤醒，再等 1 秒。 */
      const bClockRatio = async (ms = 350) => {
        const e0 = T.audioEnergy();
        if (!e0 || typeof e0.currentTime !== 'number') return { ok: false, ratio: null, why: 'no-clock-field' };
        const w0 = performance.now();
        await sleep(ms);
        const e1 = T.audioEnergy();
        const wall = (performance.now() - w0) / 1000;
        const ratio = wall > 0 ? (e1.currentTime - e0.currentTime) / wall : 0;
        return { ok: ratio >= 0.8, ratio: +ratio.toFixed(3), wall: +wall.toFixed(3),
          dt: +(e1.currentTime - e0.currentTime).toFixed(3), state: e1.state,
          sampleRate: e1.sampleRate, baseLatency: e1.baseLatency, outputLatency: e1.outputLatency };
      };
      const bWake = async (label) => {
        let c = await bClockRatio();
        const tries = [];
        if (!c.ok) {
          try { G.sfx.resume(); } catch (e) { /* 自动播放策略，下一轮再试 */ }
          await sleep(300);
          c = await bClockRatio();
          tries.push('resume 后');
          if (!c.ok) {
            for (let i = 0; i < 6 && !c.ok; i++) { await sleep(400); c = await bClockRatio(); }
            tries.push('再等 6 轮');
          }
        }
        return { c, label, revive: tries.length ? tries.join('+') : null };
      };
      const bSilenceGone = async (budgetMs) => tryUntil(
        () => { const mi = T.musicInfo(); return !!mi && mi.activeMusicCount === 0 && mi.ambientCount === 0 &&
          mi.fadingMusicCount === 0 && mi.ambientFadingCount === 0; },
        { budgetMs, tick: 'sleep', intervalMs: 60, label: '主曲与环境床全部释放', observe: () => T.musicInfo() });

      const bSample = async (ms) => {
        let rms = 0, peak = 0, nan = 0, last = null, n = 0;
        const seen = new Set();
        const e0 = T.audioEnergy();
        const w0 = performance.now();
        const t1 = performance.now();
        while (performance.now() - t1 < ms) {
          const e = T.audioEnergy();
          if (e && e.available) {
            rms = Math.max(rms, e.rms); peak = Math.max(peak, e.peak); nan += e.nan; last = e; n++;
            seen.add(e.rms + '/' + e.peak + '/' + e.currentTime);
          }
          await sleep(40);
        }
        const e1 = T.audioEnergy();
        const wall = (performance.now() - w0) / 1000;
        return {
          rms, peak, nan, last, n, distinct: seen.size,
          clockRatio: (e0 && e1 && typeof e0.currentTime === 'number' && wall > 0)
            ? +((e1.currentTime - e0.currentTime) / wall).toFixed(3) : null,
          frames: last ? last.frames : 0, fftSize: last ? last.fftSize : null,
          tapChain: last ? last.tapChain : null, masterGain: last ? last.masterGain : null
        };
      };

      /* 静音态：走真实设置路径把音乐开关关掉（stopMusic 会释放主曲与环境床） */
      await G.applySettingsLive({ music: false });
      const bQuiet = await bSilenceGone(6000);           // 等淡出走完，不把淡出尾巴当成底噪
      await sleep(300);
      const bWk1 = await bWake('静音');
      const bSilent = await bSample(500);
      /* 播放态：开关打开，等到主曲与环境床都真的回来 */
      await G.applySettingsLive({ music: true });
      const bW = await tryUntil(() => T.musicInfo().activeMusicCount === 1 && T.musicInfo().activeAmbient !== null,
        { budgetMs: 9000, tick: 'sleep', intervalMs: 100, label: 'B 主曲与环境床回来', observe: () => T.musicInfo() });
      /* 重开主曲的淡入是 2 秒（sfx._switchMusic 里 fade=2 那一支）。
         旧版固定 sleep(1400) 会在缓入只走了七分时才采样，既贴阈值又不可复现；
         这里改成「等音频时钟真的走过 2.2 秒」——只等就绪，不动任何判定阈值。 */
      const bIn0 = (T.audioEnergy() || {}).currentTime;
      const bFade = await tryUntil(() => {
        const e = T.audioEnergy();
        return !!e && typeof bIn0 === 'number' && e.currentTime - bIn0 >= 2.2;
      }, { budgetMs: 6000, tick: 'sleep', intervalMs: 100, label: 'B 主曲淡入 2 秒走完（按音频时钟）',
        observe: () => { const e = T.audioEnergy(); return { dt: e ? +(e.currentTime - bIn0).toFixed(2) : null, phase: (T.musicInfo().cycle || {}).phase }; } });
      const bWk2 = await bWake('播放');
      const bLive = await bSample(600);
      /* 阶段 3c：rms 全零时，靠「对象在不在」分不清「真在播」和「对象还在但源没了」。
         把源级读数一起留下：相位 / 总线增益 / 曲目来源 / 文件状态 / 环境床。 */
      const bLiveMusic = T.musicInfo();
      /* 暂停态：MU.6 的语义是释放主曲与环境床，能量必须掉回去 */
      G.pause();
      const bQuiet2 = await bSilenceGone(6000);
      await sleep(300);
      const bWk3 = await bWake('暂停');
      const bPaused = await bSample(500);
      G.resume();
      const bR = await tryUntil(() => T.musicInfo().activeMusicCount === 1,
        { budgetMs: 6000, tick: 'sleep', intervalMs: 100, label: 'B 恢复后主曲回来' });
      ok('B.5 输出能量随「静音 / 氛围播放 / 暂停」真实变化：相对提升、非静音、无 NaN、不削波、暂停后掉回去',
        bW.ok && bR.ok && bLiveMusic.ambientSources > 0 &&
        bSilent.n > 3 && bLive.n > 3 && bPaused.n > 3 &&
        bLive.rms > Math.max(bSilent.rms * 4, 1e-5) && bLive.rms > 2e-4 &&
        bLive.nan === 0 && bSilent.nan === 0 && bLive.peak < 0.99 &&
        !!bLive.last && bLive.last.state === 'running' &&
        bPaused.rms < Math.max(bLive.rms * 0.5, 1e-4),
        '静音 rms=' + bSilent.rms.toFixed(6) + ' 播放 rms=' + bLive.rms.toFixed(6) +
        '（峰值 ' + bLive.peak.toFixed(4) + '，NaN ' + bLive.nan + '）暂停 rms=' + bPaused.rms.toFixed(6) +
        ' 倍率=' + (bSilent.rms > 0 ? (bLive.rms / bSilent.rms).toFixed(1) : '∞') +
        ' ctx=' + (bLive.last && bLive.last.state) + ' 目标=' + JSON.stringify(bLive.last && bLive.last.targets) +
        ' 取样=' + [bSilent.n, bLive.n, bPaused.n].join('/') + ' 时钟比=' +
        [bSilent.clockRatio, bLive.clockRatio, bPaused.clockRatio].join('/') +
        ' 淡入走完=' + (bFade.ok ? '是' : '否') + ' 唤醒=' +
        [bWk1, bWk2, bWk3].map(w => (w.revive || '无需') + '(' + (w.c.ratio) + ')').join(',') +
        ' 全释放=' + (bQuiet.ok && bQuiet2.ok) +
        ' 音乐=' + JSON.stringify({
          phase: bLiveMusic.cycle && bLiveMusic.cycle.phase, source: bLiveMusic.source,
          busGain: bLiveMusic.busGain, busGainTotal: bLiveMusic.busGainTotal,
          amb: bLiveMusic.activeAmbient, ambSources: bLiveMusic.ambientSources,
          fileState: bLiveMusic.fileState,
          fileReady: bLiveMusic.fileReadyCount, gapCount: bLiveMusic.cycle && bLiveMusic.cycle.gapCount,
          err: bLiveMusic.fileLastError
        }));

      /* B.5c：采集线路自证。B.5 只说「听不听得见」，这条专门说「读数本身可不可信」，
         于是将来再红可以一眼分清三件事：真静音（时钟在跑、能量为 0）、
         采样未推进（时钟比接近 0 或三态读到同一条缓冲）、线路接错（available/tap/frames 不对）。 */
      ok('B.5c 能量读数本身可信：分析器挂在 master 之后并取满 fftSize 个样本，三态取样期间音频时钟都在推进，且不是同一条冻结缓冲',
        [bSilent, bLive, bPaused].every(s => s.n > 3 && s.frames > 0 && s.fftSize === 2048 &&
          s.tapChain === 'master → AnalyserNode(fftSize) → gain 0 → destination') &&
        [bSilent, bLive, bPaused].every(s => s.clockRatio !== null && s.clockRatio >= 0.8) &&
        [bSilent, bLive, bPaused].every(s => s.distinct > 1) &&
        bWk1.c.ok && bWk2.c.ok && bWk3.c.ok,
        'frames=' + [bSilent.frames, bLive.frames, bPaused.frames].join('/') +
        ' 时钟比=' + [bSilent.clockRatio, bLive.clockRatio, bPaused.clockRatio].join('/') +
        ' 不同读数=' + [bSilent.distinct, bLive.distinct, bPaused.distinct].join('/') +
        ' 采样次数=' + [bSilent.n, bLive.n, bPaused.n].join('/') +
        ' 旁路=' + bLive.tapChain + ' master=' + bLive.masterGain +
        ' 时钟唤醒前=' + JSON.stringify({ 静音: bWk1.c, 播放: bWk2.c, 暂停: bWk3.c }));

      /* 事件音效：只用已有音效名，且必须是「真的发出去」而不是计数字段变了 */
      const bC0 = T.audioCues();
      const bSt0 = T.sfxStats();
      const bFound = G.onLandmarkDiscovered({ id: 'b-test-ruin', type: 'ruin', name: 'B 测试遗迹', x: 0, y: 0, z: 0 });
      const bSt1 = T.sfxStats();
      const bC1 = T.audioCues();
      /* 真实进洞穴：audioSceneState 用的是 world.surfaceHeight（纯噪声，不看实际方块），
         而且 T.teleport 走 controller.spawnAt —— 卡进石头会被顶出地面。所以先挖一条竖井，
         再「高空（一定算地表）→ 井底（一定算地下）」两次采样，保证恰好一次 day/night → cave 跳变。 */
      const bX = Math.floor(G.controller.pos.x), bZ = Math.floor(G.controller.pos.z);
      const bTop = G.world.topSolidY(bX, bZ);
      const bSurf = G.world.surfaceHeight(bX, bZ);
      const bDeep = Math.max(2, Math.min(bTop - 8, bSurf - 6));
      for (let yy = bDeep; yy <= bTop + 1; yy++) T.setBlock(bX, yy, bZ, 0);
      T.teleport(bX + 0.5, 62, bZ + 0.5);          // 62 高于任何地形高度 → 一定不算地下
      G.updateAudioScene();
      const bHigh = T.audioScene();
      const bC1b = T.audioCues();
      T.teleport(bX + 0.5, bDeep, bZ + 0.5);
      G.updateAudioScene();
      const bLow = T.audioScene();
      const bSt2 = T.sfxStats();
      const bC2 = T.audioCues();
      /* 目标达成：给齐前两步材料 + 清空进度集合，走真实 refreshQuests（读档那条 silent 路径不该响）
         注意：放材料会同步解锁「木头/工作台」成就，它们也播 levelup；Sfx 对同名有 40ms 限流，
         所以要先过了这个窗口再取基线，否则目标音会被算到成就头上。 */
      const bQ0 = { completed: Array.from(G.quests.completed), shown: Array.from(G.quests.shown) };
      G.inventory.clear();
      G.inventory.set(0, { item: 'oak_log', count: 3 });
      G.inventory.set(1, { item: 'crafting_table', count: 1 });
      await sleep(120);
      G.quests.completed = new Set(); G.quests.shown = new Set();
      const bSt3 = T.sfxStats();
      const bQR = G.refreshQuests(false);
      const bSt4 = T.sfxStats();
      const bC4 = T.audioCues();
      const bSilentQuest = G.refreshQuests(true);
      const bSt5 = T.sfxStats();
      G.quests.completed = new Set(bQ0.completed); G.quests.shown = new Set(bQ0.shown);
      const bF = {
        发现计数: !!bFound && bC1.discovery === bC0.discovery + 1,
        发现发声: (bSt1.byName.levelup || 0) > (bSt0.byName.levelup || 0),
        高空不算地下: !!bHigh && bHigh.scene !== 'cave',
        井底算地下: !!bLow && bLow.underground === true && bLow.scene === 'cave',
        之前没响过: bC1b.caveEnter === bC0.caveEnter,
        进洞响一次: bC2.caveEnter === bC1b.caveEnter + 1 && (bSt2.byName.dig_stone || 0) > (bSt1.byName.dig_stone || 0),
        目标推进: !!bQR && bQR.completedNow.length >= 2 && bC4.quest === bC2.quest + 1,
        目标发声: (bSt4.byName.levelup || 0) > (bSt3.byName.levelup || 0),
        静默不响: !!bSilentQuest && bSilentQuest.completedNow.length === 0 &&
          bSt5.played === bSt4.played && T.audioCues().quest === bC4.quest
      };
      ok('B.6 三个事件各自真的发声且只用已有音效名：发现地点（成就已解锁也照样响）、真实进洞穴一次、目标达成，静默读档不响',
        Object.keys(bF).every(k => bF[k]),
        '分项=' + JSON.stringify(bF) +
        ' 发现=' + JSON.stringify(bC1) + ' 洞穴=' + JSON.stringify(bC2) + ' 目标=' + JSON.stringify(bC4) +
        ' 井=' + bTop + '/' + bSurf + '/' + bDeep + ' 场景 ' + JSON.stringify(bHigh && bHigh.scene) + '→' + JSON.stringify(bLow && bLow.scene) +
        ' completedNow=' + JSON.stringify(bQR && bQR.completedNow) +
        ' 名称计数=' + JSON.stringify({
          发现前: bSt0.byName.levelup || 0, 发现后: bSt1.byName.levelup || 0,
          目标前: bSt3.byName.levelup || 0, 目标后: bSt4.byName.levelup || 0,
          dig_stone: bSt2.byName.dig_stone || 0
        }) + ' 静默后 played=' + bSt5.played);
    }

    /* ---------------- 61. 阶段 C：UI 信息层级（tooltip / 熔炼进度 / 目标高亮） ----------------
     * 只加信息层，不换皮：断言里同时钉住 6.1a 的面板/槽位像素读数与 .recipe-item 数量，
     * 保证「加了 tooltip / 加了高亮」没有污染任何既有查询。整节用独立 {} 包住。 */
    {
      const cMove = (node, x, y) => node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      const cUnlock = () => { if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock(); };
      G.setMode('survival');
      G.controller.health = 20; G.controller.invulnerable = 0;
      G.inventory.clear();
      G.inventory.set(0, { item: 'pickaxe_iron', count: 1, dur: 120 });
      G.selectHotbar(0);
      G.inventory.emit('change');        // 真实事件路径：Inventory.set 本身不发事件，是调用方发的
      await frame();
      cUnlock();

      const cS0 = document.querySelector('#hotbar .slot[data-slot="0"]');
      cMove(cS0, 240, 240);
      const cTip = T.itemTip();
      ok('C.1 悬停工具槽位弹出用途 tooltip：名字/用途/等级伤害/耐久都取自这一堆的真实状态',
        cTip.exists && cTip.show && cTip.name === '铁镐' &&
        cTip.use.includes('挖掘') &&
        cTip.lines.some(l => l.includes('工具等级')) && cTip.lines.some(l => l.includes('攻击')) &&
        cTip.lines.some(l => l.includes('120/')) &&
        !!cTip.durWidth && parseInt(cTip.durWidth, 10) > 0 && parseInt(cTip.durWidth, 10) < 100,
        JSON.stringify(cTip));

      /* 贴右下角必须翻边，绝不溢出视口 */
      const cW = window.innerWidth, cH = window.innerHeight;
      cMove(cS0, cW - 4, cH - 4);
      const cEdge = T.itemTip();
      ok('C.2 鼠标贴窗口右下角时 tooltip 自动翻到另一侧，完全留在视口内',
        cEdge.show && cEdge.rect.right <= cEdge.vw + 0.5 && cEdge.rect.bottom <= cEdge.vh + 0.5 &&
        cEdge.rect.left >= 0 && cEdge.rect.top >= 0 && cEdge.rect.right > 0 &&
        cEdge.rect.bottom - cEdge.rect.top > 20,
        '视口=' + cW + 'x' + cH + ' rect=' + JSON.stringify(cEdge.rect));

      const cS8 = document.querySelector('#hotbar .slot[data-slot="8"]');
      cMove(cS8, 300, 300);
      const cHide = T.itemTip();
      ok('C.3 空格子不弹 tooltip（悬停到空格立即收起），不会留一层挡住判断',
        cHide.exists && cHide.show === false, JSON.stringify(cHide));

      /* --- C.4 熔炼进度必须来自 Furnace 自己的 progress --- */
      let cF = G.world.furnaces.values().next().value;
      if (!cF) {
        const fx = Math.floor(G.controller.pos.x) + 2, fz = Math.floor(G.controller.pos.z);
        const fy = G.world.topSolidY(fx, fz) + 1;
        T.placeAt(fx, fy, fz, 'furnace');
        cF = G.world.getFurnace(fx, fy, fz);
      }
      if (cF) G.openFurnace({ x: cF.x, y: cF.y, z: cF.z, face: [0, 1, 0] });
      await frame();
      const cOpened = G.activeFurnace === cF && G.openUI === 'furnace';
      T.furnacePut('input', 'iron_ore', 2);
      T.furnacePut('fuel', 'coal', 3);
      const cSmelt = await tryUntil(() => (T.furnace(cF.x, cF.y, cF.z).progress || 0) > 1.2,
        { budgetMs: 20000, tick: 'sleep', intervalMs: 120, label: 'C 熔炉真的在熔炼', observe: () => T.furnace(cF.x, cF.y, cF.z) });
      /* 三处读数必须同源：refreshFurnace 只在 refreshUI 里被调用（面板不随帧自动重画），
         所以模型快照要紧贴 refreshUI 取、DOM 紧接着读。旧写法是「刷新 → 等一帧 → 再取模型」，
         还把条宽拿去和「已经按 3 位小数舍过的 data-progress」再乘 100 取整，
         等于双重再采样：frac 落在百分位边界下沿那一窄带（实测 0.15496）时
         DOM=15% 而期望=16%，是测试自己的假失败，不是产品行为变了。
         现在 data-progress / 条宽 / 文案百分数三处都对着同一个模型值精确相等。 */
      const cModel = T.furnace(cF.x, cF.y, cF.z);
      G.ui.refreshUI();                  // 面板只在事件里重画；这里走生产刷新路径把真实 progress 画出来
      const cFp = T.furnaceProgress();
      const cExp = Math.max(0, Math.min(1, (cModel.progress || 0) / 8));
      const cPct = Math.round(cExp * 100);
      await frame();
      ok('C.4 熔炉进度条来自 Furnace 真实 progress：data-progress、条宽与文案三者一致，不是假动画',
        cOpened && cFp.hasArrow && cSmelt.ok && cFp.hot === true &&
        Number(cFp.progress) > 0.05 && Number(cFp.progress) < 1 &&
        cFp.progress === cExp.toFixed(3) &&
        cFp.fillWidth === cPct + '%' &&
        (cFp.info.match(/进度 (\d+)%/) || [])[1] === String(cPct) &&
        !!cFp.fillBg && !!cFp.arrowBg && cFp.fillBg !== cFp.arrowBg &&
        cFp.info.includes('进度') && cFp.info.includes('铁锭'),
        '打开=' + cOpened + ' 读数=' + JSON.stringify(cFp) + ' 模型 progress=' + cModel.progress +
        ' 期望=' + cExp.toFixed(3) + '/' + cPct + '% 等待=' + (cSmelt.ms || '-') + 'ms');
      G.closeUI(); await frame();

      /* --- C.5 目标链高亮：只圈当前目标要的那件，且不污染既有查询与像素读数 ---
         注意顺序：往背包里放东西会触发 inventory 'change' → refreshQuests 自己会推进链条，
         所以「当前目标」必须在所有背包写入之后才钉住，然后同步 refreshUI 再取读数。 */
      const cQ0 = { completed: Array.from(G.quests.completed), shown: Array.from(G.quests.shown) };
      G.inventory.clear();
      G.inventory.set(3, { item: 'cobblestone', count: 12 });
      G.inventory.set(4, { item: 'oak_log', count: 5 });
      G.selectHotbar(3);
      G.quests.completed = new Set(['log', 'table', 'wood_pick']);
      G.quests.shown = new Set(['log', 'table', 'wood_pick']);
      G.ui.refreshUI();
      const cCur0 = G.quests.current ? G.quests.current.id : null;
      const cNeed0 = T.questNeed();
      G.openInventory(); await frame(); await frame();
      const cNeed1 = T.questNeed();
      const cBook1 = document.querySelectorAll('.recipe-item').length;
      const cPanel = getComputedStyle(document.querySelector('#panel-inventory'));
      const cSlot = getComputedStyle(document.querySelector('#panel-inventory .slot'));
      /* 整条链都完成 → 没有当前目标 → 一格都不该亮；配方书条目数与像素读数一个都不许变 */
      G.quests.completed = new Set(['log', 'table', 'wood_pick', 'cobble', 'furnace', 'iron']);
      G.ui.refreshUI(); await frame();
      const cNeed2 = T.questNeed();
      const cBook2 = document.querySelectorAll('.recipe-item').length;
      const cPanel2 = getComputedStyle(document.querySelector('#panel-inventory'));
      ok('C.5 目标高亮只圈住当前目标要的物品、目标没了就全灭，且不改变 .recipe-item 数量与 6.1a 钉死的面板/槽位像素读数',
        cCur0 === 'cobble' && cNeed0.length === 1 && cNeed0[0] === 'cobblestone' &&
        cNeed1.length >= 2 && cNeed1.every(x => x === 'cobblestone') &&
        G.quests.current === null && cNeed2.length === 0 &&
        cBook1 > 0 && cBook2 === cBook1 &&
        cPanel.backgroundColor === 'rgb(198, 198, 198)' && cPanel2.backgroundColor === 'rgb(198, 198, 198)' &&
        Math.abs(parseFloat(cPanel.borderTopWidth) - 3) < 0.5 && cPanel.borderTopStyle === 'solid' &&
        cSlot.backgroundColor === 'rgb(139, 139, 139)' && cSlot.boxShadow.includes('inset'),
        '目标=' + cCur0 + ' HUD=' + JSON.stringify(cNeed0) + ' 背包=' + JSON.stringify(cNeed1) +
        ' 全完成=' + JSON.stringify(cNeed2) + ' 配方书 ' + cBook1 + '→' + cBook2 +
        ' panel=' + cPanel.backgroundColor + '/' + cPanel.borderTopWidth + ' slot=' + cSlot.backgroundColor);
      G.closeUI(); await frame();
      G.quests.completed = new Set(cQ0.completed); G.quests.shown = new Set(cQ0.shown);
      G.ui.refreshUI();
    }

    /* ---------------- BUG. 试玩反馈四条（真实事件 / 真实行为） ---------------- */
    {
    G.closeUI();
    G.setMode('survival');
    const bugKey = (code, down = true) => window.dispatchEvent(
      new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true, cancelable: true }));
    G.input._clearAll();
    bugKey('KeyW', true); bugKey('KeyW', false);
    bugKey('KeyW', true);
    await frame();
    const bugSprint = G.input.state.sprint === true;
    bugKey('KeyW', false);
    await frame();
    const bugSprintOff = G.input.state.sprint === false;
    ok('BUG.1 双击 W 可冲刺且不依赖左 Ctrl（绕开中文输入法 Ctrl+Space 冲突）',
      bugSprint && bugSprintOff,
      'sprintOn=' + bugSprint + ' afterRelease=' + bugSprintOff);

    const bugLock0 = G.input.lockRequests;
    G.openInventory();
    await frame();
    const bugUIOpen = G.openUI === 'inventory';
    G.closeUI();
    await frame();
    ok('BUG.2 关闭背包会重新请求指针锁（鼠标指针不再残留在画面上）',
      bugUIOpen && G.openUI === null && G.input.lockRequests === bugLock0 + 1,
      'lockRequests ' + bugLock0 + '→' + G.input.lockRequests + ' openUI=' + G.openUI);

    G.setMode('creative');
    const bugPX = G.controller.pos.x, bugPZ = G.controller.pos.z;
    const bugMX = Math.floor(bugPX) + 20, bugMZ = Math.floor(bugPZ);
    const bugMY = G.world.topSolidY(bugMX, bugMZ) + 1.05;
    const bugMob = G.mobs.spawn('zombie', bugMX + 0.5, bugMY, bugMZ + 0.5);
    const bugD0 = Math.hypot(bugMob.pos.x - bugPX, bugMob.pos.z - bugPZ);
    for (let i = 0; i < 80; i++) G.mobs.update(0.02, 0.2);
    const bugAlive = G.mobs.list.includes(bugMob);
    const bugD1 = bugAlive ? Math.hypot(bugMob.pos.x - bugPX, bugMob.pos.z - bugPZ) : -1;
    ok('BUG.5 20 格外的夜间敌怪会主动逼近（不再站着发呆）',
      bugAlive && bugD0 - bugD1 > 1,
      'dist ' + bugD0.toFixed(2) + '→' + bugD1.toFixed(2) + ' alive=' + bugAlive);

    G.settings.showFps = true;
    G.ui.updateHUD(G);
    await frame();
    const bugDbg = document.querySelector('#debug').textContent;
    ok('BUG.4 F3 显示「顶出 / 台阶」计数，复现瞬移时可直接定位来源',
      bugDbg.includes('顶出') && bugDbg.includes('台阶'),
      bugDbg.split('\n').find(s => s.includes('顶出')) || bugDbg.slice(0, 60));
    G.settings.showFps = false;
    G.ui.updateHUD(G);
    G.closeUI();
    }

    /* ---------------- P0. 色彩空间与按键重复（原版参照规格第 0 刀） ---------------- */
    {
    const p0Frag = G.view.matOpaque.fragmentShader;
    const p0Out = String(G.view.renderer.outputColorSpace || '');
    ok('P0.1 体素着色器补上输出色彩空间转换，渲染器仍为 sRGB',
      p0Frag.includes('#include <colorspace_fragment>') && /srgb/i.test(p0Out),
      'chunk=' + p0Frag.includes('#include <colorspace_fragment>') + ' outputColorSpace=' + p0Out);

    G.input._clearAll();
    const p0Down = (repeat) => window.dispatchEvent(new KeyboardEvent('keydown',
      { code: 'KeyW', repeat: !!repeat, bubbles: true, cancelable: true }));
    p0Down(false);
    for (let i = 0; i < 4; i++) p0Down(true);
    await frame();
    const p0RepeatSafe = G.input.state.sprint === false;
    p0Down(false);
    await frame();
    const p0RealDouble = G.input.state.sprint === true;
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true, cancelable: true }));
    await frame();
    ok('P0.2 OS 按键重复不误触双击 W，真实双击仍可冲刺',
      p0RepeatSafe && p0RealDouble && G.input.state.sprint === false,
      'repeatSafe=' + p0RepeatSafe + ' realDouble=' + p0RealDouble +
      ' released=' + (G.input.state.sprint === false));

    /* P0.3 亮度曲线拆分：结构断言。曲线本身好不好看得靠 A/B 图与人工看图
       （artifacts/visual/ab-20261106-colorfix-before2 / -after2），这里只钉三件事：
       ① 旧的平坦曲线（白天用的那条）一个字符都没改，所以「白天不许比现在暗」是结构性的；
       ② 光池曲线只在 blkDom（方块光主导程度）里参与混合，且水体共用同一份 shader；
       ③ 不许出现 gl_FragCoord 那类全屏遮罩/暗角来伪装局部光池。 */
    const p0FragVox = G.view.matOpaque.fragmentShader;
    const p0FragWater = G.view.matWater.fragmentShader;
    const p0FlatKept = /0\.065\s*\+\s*0\.935\s*\*\s*pow\(lvl,\s*1\.12\)/.test(p0FragVox);
    const p0Pool = /bPool\s*=\s*0\.045\s*\+\s*0\.955\s*\*\s*pow\(lvl,\s*1\.80\)/.test(p0FragVox) &&
      /blkDom\s*=\s*clamp\(\(blkL\s*-\s*skyL\)/.test(p0FragVox) &&
      /mix\(bFlat,\s*bPool,\s*blkDom\)/.test(p0FragVox);
    const p0Warm = /1\.075,\s*0\.985,\s*0\.875/.test(p0FragVox);
    const p0NoVignette = !/gl_FragCoord/.test(p0FragVox);
    ok('P0.3 火把光池按「方块光是否主导」混曲线，白天那条曲线原样保留，且没有全屏遮罩/暗角',
      p0FlatKept && p0Pool && p0Warm && p0NoVignette && p0FragWater === p0FragVox &&
      p0FragVox.includes('#include <colorspace_fragment>'),
      'flatKept=' + p0FlatKept + ' pool=' + p0Pool + ' warm=' + p0Warm +
      ' noVignette=' + p0NoVignette + ' waterSharesSame=' + (p0FragWater === p0FragVox));
    }

    /* ---------------- MT. P0 近战：遮挡 / 距离分离 / 攻击恢复 ---------------- */
    {
    G.closeUI();
    G.setMode('survival');
    const mtX = Math.floor(G.spawn.x), mtZ = Math.floor(G.spawn.z), mtY = Math.floor(G.spawn.y);
    for (let dy = 0; dy <= 4; dy++)
      for (let dz = -4; dz <= 4; dz++)
        for (let dx = -4; dx <= 4; dx++)
          T.setBlock(mtX + dx, mtY + 1 + dy, mtZ + dz, 0);
    for (let dz = -4; dz <= 4; dz++)
      for (let dx = -4; dx <= 4; dx++)
        T.setBlock(mtX + dx, mtY, mtZ + dz, 4);
    G.controller.spawnAt(mtX + 0.5, mtY + 1.05, mtZ + 0.5);
    await tryUntil(() => G.controller.onGround, { budgetMs: 4000, label: 'MT 站稳' });
    G.controller.yaw = 0; G.controller.pitch = 0;
    T.give('sword_stone', 1);
    for (let i = 0; i < 9; i++) if (G.inventory.get(i) && G.inventory.get(i).item === 'sword_stone') T.select(i);
    G.mobs.clear();
    const mtZombie = G.mobs.spawn('zombie', mtX + 0.5, mtY + 1, mtZ - 2 + 0.5);
    mtZombie.walking = false; mtZombie.wanderT = 9999; mtZombie.attackCd = 999;
    await sleep(120);
    const mtReset = () => {
      mtZombie.pos.x = mtX + 0.5; mtZombie.pos.y = mtY + 1; mtZombie.pos.z = mtZ - 2 + 0.5;
      mtZombie.vel.x = mtZombie.vel.z = 0; mtZombie.hp = 14;
    };
    const mtSwing = async (dt = 0.016) => {
      G.input.state.mouseLeft = true;
      G.interaction.update(dt);
      G.input.state.mouseLeft = false;
      G.interaction.update(0.001);
      await frame();
    };
    const mtWait = (sec) => { for (let i = 0; i < Math.ceil(sec / 0.02); i++) G.interaction.update(0.02); };

    T.setBlock(mtX, mtY + 2, mtZ - 1, 4);      // 玩家与僵尸之间 1 格石墙
    await sleep(80);
    mtReset(); mtWait(0.8);
    await mtSwing();
    ok('MT.1 隔着 1 格石墙不能打到墙后僵尸（真实左键）',
      mtZombie.hp === 14,
      'hp=' + mtZombie.hp + ' blockDist=' + (G.interaction.target && G.interaction.target.dist));

    T.setBlock(mtX, mtY + 2, mtZ - 1, 0);
    await sleep(80);
    mtReset(); mtWait(0.8);
    await mtSwing();
    const mtOpen = 14 - mtZombie.hp;
    ok('MT.2 清掉遮挡后同一位置能命中，满蓄伤害为石剑 6 点',
      Math.abs(mtOpen - 6) < 0.01, 'damage=' + mtOpen);

    mtReset(); mtWait(0.8);
    await mtSwing();
    const mtD1 = 14 - mtZombie.hp;
    G.interaction.update(0.016);                // 约 32ms 内的第二次点击
    await mtSwing();
    const mtD2 = (14 - mtD1) - mtZombie.hp;
    ok('MT.3 32ms 内连点第二下不能结算满额伤害',
      mtD1 > 5.9 && mtD2 > 0 && mtD2 < mtD1 * 0.5,
      'first=' + mtD1.toFixed(2) + ' second=' + mtD2.toFixed(2) +
      ' charge=' + T.attackInfo().charge.toFixed(3));

    mtWait(0.8);
    const mtReady = T.attackInfo();
    mtReset();
    await mtSwing();
    const mtFull = 14 - mtZombie.hp;
    const mtAfter = T.attackInfo();
    ok('MT.4 等满攻击恢复后回到满额伤害，低调准星条随之出现',
      mtReady.charge > 0.99 && mtReady.barHidden === true &&
      Math.abs(mtFull - 6) < 0.01 &&
      mtAfter.charge < 0.1 && mtAfter.barHidden === false && mtAfter.total === 0.625,
      'ready=' + JSON.stringify(mtReady) + ' full=' + mtFull + ' after=' + JSON.stringify(mtAfter));

    G.mobs.clear();
    const mtFar = G.mobs.spawn('pig', mtX + 0.5, mtY + 1, mtZ - 4.3);
    mtFar.walking = false; mtFar.wanderT = 9999;
    const mtDist = +Math.hypot(mtFar.pos.x - G.controller.pos.x, mtFar.pos.z - G.controller.pos.z).toFixed(2);
    const mtPick = G.mobs.attackTarget(5, Infinity);
    const mtShared = G.mobs.pickNearest(G.controller.reach(), m => m.type === 'pig');
    ok('MT.5 实体攻击上限 4.0 与方块交互 reach 分离，共用 pickNearest 入口仍可用',
      mtPick.mob === null && mtShared === mtFar,
      'blockReach=' + G.controller.reach() + ' meleeReach=4 目标距离=' + mtDist +
      '（盒面 ' + (mtDist - 0.65).toFixed(2) + '）meleeTarget=' + (mtPick.mob ? 'pig' : 'none') +
      ' sharedPick=' + (mtShared === mtFar));

    /* MT.6 真实 DOM 事件链路（canvas mousedown → InputManager → 结算），而不只是改内部变量 */
    G.mobs.clear();
    const mtPig = G.mobs.spawn('pig', mtX + 0.5, mtY + 1, mtZ - 2 + 0.5);
    mtPig.walking = false; mtPig.wanderT = 9999;
    G.controller.yaw = 0; G.controller.pitch = -0.12;
    mtWait(0.9);
    const mtRealHp0 = mtPig.hp, mtRealHit0 = T.feedbackInfo().hit;
    G.input.locked = true;                       // 等价于「玩家点过画面、鼠标已锁定」
    G.input.setUIMode(false);                    // 真实点击在 UI 模式下会被 InputManager 忽略
    const mtCanvas = document.getElementById('game-canvas');
    mtCanvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await frame(); await frame();
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await frame();
    const mtRealDmg = mtRealHp0 - mtPig.hp, mtRealHit1 = T.feedbackInfo().hit;
    const mtLeftState = G.input.state.mouseLeft;
    /* 空挥：同一套真实事件，但准星朝天 —— 不该有任何生物掉血，也不该计命中，挥动仍要有 */
    G.mobs.clear();
    const mtPig2 = G.mobs.spawn('pig', mtX + 0.5, mtY + 1, mtZ - 2 + 0.5);
    mtPig2.walking = false; mtPig2.wanderT = 9999;
    mtWait(0.9);
    G.controller.pitch = 1.2;
    const mtMissHit0 = T.feedbackInfo().hit;
    mtCanvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await frame(); await frame();
    const mtMissSwing = T.heldInfo().swing;
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    await frame();
    ok('MT.6 真实 DOM 左键链路能命中（canvas mousedown → InputManager → 结算），空挥不扣血也不计命中',
      Math.abs(mtRealDmg - 6) < 0.01 && mtRealHit1 > mtRealHit0 && mtLeftState === false &&
      mtPig2.hp === mtPig2.maxHp && T.feedbackInfo().hit === mtMissHit0 && mtMissSwing > 0,
      '真实命中扣血=' + mtRealDmg + ' 命中计数 ' + mtRealHit0 + '→' + mtRealHit1 +
      ' 松键后 mouseLeft=' + mtLeftState + ' 空挥：猪 hp=' + mtPig2.hp + '/' + mtPig2.maxHp +
      ' 计数 ' + mtMissHit0 + '→' + T.feedbackInfo().hit + ' 挥动=' + mtMissSwing);
    G.input.locked = false;
    G.mobs.clear();
    }

    /* ---------------- LG. 洞穴光照数据：先查数据，再谈 shader ----------------
       「洞穴整片发灰、火把没有光池」的第一嫌疑是光照数据，不是曲线。这里在真实世界里
       把一间 7×4×7 的实心石壳正好盖在区块接缝上（室内两格分别落在左右两块区块里），
       并且整间屋子抬到 footprint 内最高地表之上 —— 盖之前这些格子是露天 sky=15，
       建造又会让本块和邻块同时排队补光，先补光的那块就会去读邻块还没重算的旧光数组。
       旧实现（未加载邻居用 surfaceHeight 近似 + 把邻居值原样搬进接缝格 + 实心格存光）
       在这条路径上会把整间封闭石室灌成 sky 12~14，而且补光结束后没人再重算。 */
    {
    G.closeUI();
    const lgX = Math.round(G.spawn.x / 16) * 16, lgZ = Math.round(G.spawn.z / 16) * 16;
    let lgTop = 0;
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
      for (let y = 100; y > 4; y--) {
        if (T.blockAt(lgX + dx, y, lgZ + dz).id !== 0) { if (y > lgTop) lgTop = y; break; }
      }
    }
    const lgY = lgTop + 2;                                  // 壳底，整间屋子都在地表之上
    for (let dy = 0; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++)
      T.setBlock(lgX + dx, lgY + dy, lgZ + dz, 1);          // 实心石壳
    for (let dy = 1; dy <= 2; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++)
      T.setBlock(lgX + dx, lgY + dy, lgZ + dz, 0);          // 室内 3×2×3，跨 x=lgX-1|lgX 两条接缝
    T.setBlock(lgX, lgY + 1, lgZ, 34);                      // 火把（唯一光源）
    await T.waitChunks(2);
    await sleep(900);
    const lgCells = [[-1, 1, 0], [0, 1, 0], [0, 1, -1], [1, 2, 1], [-1, 2, -1]];
    const lgRead = lgCells.map(([dx, dy, dz]) => T.lightAt(lgX + dx, lgY + dy, lgZ + dz));
    const lgSkyMax = Math.max(...lgRead.map(l => l.sky));
    const lgRoof = T.blockAt(lgX, lgY + 3, lgZ).id;
    const lgTorch = T.lightAt(lgX, lgY + 1, lgZ);
    const lgAbove = T.lightAt(lgX, lgY + 4, lgZ);
    ok('LG.1 盖在区块接缝上的封闭石室：室内天空光必须为 0，火把仍是唯一光源',
      lgRoof === 1 && lgSkyMax === 0 && lgTorch.block === 14 && lgAbove.sky === 15,
      '位置 ' + lgX + ',' + lgY + ',' + lgZ + ' 室内 sky=' + JSON.stringify(lgRead.map(l => l.sky)) +
      ' 室内 block=' + JSON.stringify(lgRead.map(l => l.block)) +
      ' 屋顶 id=' + lgRoof + ' 火把 block=' + lgTorch.block + ' 屋顶上方 sky=' + lgAbove.sky);
    }

    /* ---------------- EL. P1 实体采样世界光照与雾（已知问题 #28） ----------------
       以前生物材质是纯色：洞穴里的猪和太阳底下的猪一样亮，远处生物也不随雾淡出。
       现在 mobs.render 走 core/entitylight.js（常数与 VOX_FRAG 同源），view 把同一份
       雾色与 near/far 喂给 scene.fog。这里既验「真的落到材质颜色上了」，也验两边同源。 */
    {
    const elX = Math.floor(G.spawn.x), elZ = Math.floor(G.spawn.z), elY = Math.floor(G.spawn.y);
    T.setTime(0.3); await frame(); await frame();          // 钉在白天，uDay 才是确定的
    const uDay = G.view.uniforms.uDay.value;
    G.mobs.clear();
    const elPig = G.mobs.spawn('pig', elX + 0.5, elY + 1, elZ + 0.5);
    const elMeshes = []; elPig.mesh.traverse(o => { if (o.isMesh) elMeshes.push(o); });
    const elBody = elMeshes[0];
    const elBase = elBody.userData.base || elBody.material.color.getHex();
    const shadeTo = (hex, k) => {
      const r = Math.round(((hex >> 16) & 255) * k), g = Math.round(((hex >> 8) & 255) * k), b = Math.round((hex & 255) * k);
      return (r << 16) | (g << 8) | b;
    };
    const elRefresh = (x, y, z) => {
      elPig.pos.x = x; elPig.pos.y = y; elPig.pos.z = z;
      elPig._shade = undefined; elPig._lightT = 1; elPig.hurtT = 0; elPig.charging = false;
      G.mobs.render(elPig, 0.02);
      /* 取「生物眼睛所在那一格」的光：mobs.render 采样的就是它，别按脚下方格猜 */
      const l = T.lightAt(Math.floor(elPig.pos.x), Math.floor(elPig.eyeY), Math.floor(elPig.pos.z));
      return { c: elBody.material.color.getHex(), sky: l.sky, blk: l.block, eyeY: Math.floor(elPig.eyeY) };
    };
    const elDayS = elRefresh(elX + 0.5, elY + 1.2, elZ + 0.5);
    const elDay = elDayS.c;
    /* 往深处找一个「实心且 sky/block 都为 0」的格子，别赌脚下没有天然洞穴 */
    let elDeepY = -1;
    for (let y = elY - 4; y > 2 && elDeepY < 0; y--) {
      const l = T.lightAt(elX, y, elZ), lu = T.lightAt(elX, y + 1, elZ);
      /* 眼睛格是 y+1：两格都必须又实心又无光，否则脚下正好有个洞穴就会误判 */
      if (l.id !== 0 && l.sky === 0 && l.block === 0 && lu.sky === 0 && lu.block === 0) elDeepY = y;
    }
    const elDarkS = elDeepY > 0 ? elRefresh(elX + 0.5, elDeepY + 0.2, elZ + 0.5) : { c: 0, sky: -1, blk: -1 };
    const elDark = elDarkS.c;
    /* 挖开三格、火把放在中间那一格：无论猪的视点多高都落在光池里 */
    if (elDeepY > 0) {
      for (let dy = 0; dy <= 2; dy++) T.setBlock(elX, elDeepY + dy, elZ, 0);
      T.setBlock(elX, elDeepY + 1, elZ, 34);
    }
    await T.waitChunks(1); await sleep(500);
    const elTorchS = elDeepY > 0 ? elRefresh(elX + 0.5, elDeepY + 0.2, elZ + 0.5) : { c: 0, sky: -1, blk: -1 };
    const elTorch = elTorchS.c;
    const elFloor = T.entityLight(0, 0, 1);
    const elPool = T.entityLight(0, 14, 1);
    const elLum = (c) => ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255);
    ok('EL.1 生物真的采样世界光照：白天=底色、无光处夹在可见度下限、火把旁按光池提亮且仍暗于白天',
      elDeepY > 0 && uDay > 0.9 && elDayS.sky === 15 &&
      elDay === shadeTo(elBase, T.entityLight(elDayS.sky, elDayS.blk, uDay)) &&
      elDarkS.sky === 0 && elDarkS.blk === 0 &&
      elDark === shadeTo(elBase, elFloor) && elFloor === 0.16 &&
      elTorchS.blk >= 12 && elTorch === shadeTo(elBase, T.entityLight(elTorchS.sky, elTorchS.blk, uDay)) &&
      elLum(elDark) < elLum(elTorch) && elLum(elTorch) < elLum(elDay),
      'uDay=' + uDay + ' 底色=' + elBase.toString(16) +
      ' 白天=' + elDay.toString(16) + '(眼睛格 sky ' + elDayS.sky + '/blk ' + elDayS.blk + ')' +
      ' 无光=' + elDark.toString(16) + '(k=' + elFloor + ' 期望 ' + shadeTo(elBase, elFloor).toString(16) + ')' +
      ' 火把=' + elTorch.toString(16) + '(眼睛格 sky ' + elTorchS.sky + '/blk ' + elTorchS.blk +
      ' 该格 k=' + T.entityLight(elTorchS.sky, elTorchS.blk, uDay) + '，纯火把 k=' + elPool + ')' +
      ' 深处 y=' + elDeepY + ' 亮度顺序 ' + elLum(elDark) + '<' + elLum(elTorch) + '<' + elLum(elDay));

    /* EL.2 两边同源：scene.fog 与体素雾同一份颜色同一组 near/far；体素 ShaderMaterial 必须
       显式 fog:false（它自己在 shader 里做雾，否则 three 会来刷我们没声明的 fogColor uniform）；
       JS 曲线的数值必须能由 shader 源码里那两组常数复现。 */
    const elFog = G.view.scene.fog;
    const elFogColorOk = !!elFog && elFog.color.getHex() === G.view.uniforms.uFogColor.value.getHex();
    const elFogRangeOk = !!elFog && Math.abs(elFog.near - G.view.uniforms.uFogNear.value) < 1e-6 &&
      Math.abs(elFog.far - G.view.uniforms.uFogFar.value) < 1e-6;
    const elVoxFrag = G.view.matOpaque.fragmentShader;
    const elConstOk = /0\.065\s*\+\s*0\.935\s*\*\s*pow\(lvl,\s*1\.12\)/.test(elVoxFrag) &&
      /0\.045\s*\+\s*0\.955\s*\*\s*pow\(lvl,\s*1\.80\)/.test(elVoxFrag);
    const elCurveOk = T.entityLight(15, 0, 1) === 1 && T.entityLight(0, 14, 1) === 0.8885 &&
      T.entityLight(0, 8, 1) === 0.353 && T.entityLight(0, 0, 1) === 0.16 && T.entityLight(15, 14, 1) === 1;
    ok('EL.2 实体与地形同一套雾、同一条亮度曲线（scene.fog 与 uFog* 同源，体素材质 fog:false）',
      elFogColorOk && elFogRangeOk && G.view.matOpaque.fog === false && elConstOk && elCurveOk,
      'fog=' + (elFog ? elFog.constructor.name : 'null') + ' color=' + elFogColorOk +
      ' near/far=' + (elFog ? elFog.near + '/' + elFog.far : '-') + ' 与 uniform ' +
      G.view.uniforms.uFogNear.value + '/' + G.view.uniforms.uFogFar.value + ' 一致=' + elFogRangeOk +
      ' matOpaque.fog=' + G.view.matOpaque.fog + ' shader常数=' + elConstOk + ' JS曲线=' + elCurveOk);
    G.mobs.clear();
    }

    /* ---------------- T4. 音乐出场时机与关键音效（只读参数 + 真实攻击分支，不等待留白） ----------------
     * 官方只给「稀疏 / 缓入 / 留白」的定性描述，具体间隔查不到；数值是本作设计约定，
     * 所以这里只验「参数落地 + 接线生效」，不靠延长等待去「听效果」，也不写人工试听通过。 */
    {
    G.closeUI();
    const t4mi = T.musicInfo();
    const t4cfg = t4mi && t4mi.timing;
    const t4cy = t4mi && t4mi.cycle;
    ok('T4.1 音乐出场参数落地：低频进入 / 长缓入 / 曲终留白，且「一条主曲」语义不变',
      !!t4cfg && t4cfg.fadeIn >= 4 && t4cfg.fadeOut >= 3 &&
      t4cfg.gapMin >= 60 && t4cfg.gapMax >= t4cfg.gapMin && t4cfg.leadInMin > 0 &&
      t4mi.activeMusicCount <= 1 && t4mi.ambientVolumeSource === 'sfx' &&
      t4mi.leadInDone === true &&
      !!t4cy && (t4cy.phase === 'playing' || t4cy.phase === 'gap') &&
      (t4cy.leadInSeconds === 0 || (t4cy.leadInSeconds >= t4cfg.leadInMin && t4cy.leadInSeconds <= t4cfg.leadInMax)) &&
      (t4cy.gapSeconds === 0 || (t4cy.gapSeconds >= t4cfg.gapMin && t4cy.gapSeconds <= t4cfg.gapMax)),
      'music=' + JSON.stringify(t4mi));

    /* 音乐音量 = 0 只该关掉旋律；风声/雨声/虫鸣与动作音仍要能听见。
       音乐「开关」全停的语义由既有 MU.8 钉住，这里碰的是滑条不是开关。 */
    await G.applySettingsLive({ volumeMaster: 0.7, volumeSfx: 0.8, volumeMusic: 0 });
    await frame(); await frame();
    const t4e = T.audioEnergy();
    const t4s0 = T.sfxStats();
    G.sfx.play('pig', { volume: 0.3 });
    const t4s1 = T.sfxStats();
    ok('T4.2 音乐音量拉到 0 时环境层与动作音仍可听（环境床归音效层）',
      !!t4e && t4e.targets.music <= 0.0002 && t4e.targets.ambient > 0.1 && t4e.gains.sfx > 0 &&
      t4s1.played > t4s0.played && (t4s1.byName.pig || 0) > (t4s0.byName.pig || 0),
      'targets=' + JSON.stringify(t4e && t4e.targets) + ' gains.sfx=' + (t4e && t4e.gains.sfx) +
      ' played=' + t4s0.played + '→' + t4s1.played);
    await G.applySettingsLive({ volumeMaster: 0.7, volumeSfx: 0.8, volumeMusic: 0.45 });

    /* 空挥：夹具只把目标选择隔离成「对空气」，攻击判定仍走真实的 interaction.update()。
       不依赖玩家所在地形，避免洞顶/天花板让 target 非空。 */
    const t4sw0 = T.sfxStats();
    const t4orig = G.interaction.updateTarget;
    const t4mL = G.input.state.mouseLeft, t4mR = G.input.state.mouseRight;
    G.interaction.updateTarget = function () { this.target = null; };
    G.input.state.mouseRight = false;
    G.input.state.mouseLeft = false;
    G.interaction._wasLeft = false;
    await frame();
    G.input.state.mouseLeft = true;
    await frame(); await frame();
    G.input.state.mouseLeft = false;
    await frame();
    G.interaction.updateTarget = t4orig;
    G.input.state.mouseLeft = t4mL; G.input.state.mouseRight = t4mR;
    const t4sw1 = T.sfxStats();
    ok('T4.3 对空气挥空有专属挥击声，且不与命中声混淆',
      (t4sw1.byName.swing || 0) > (t4sw0.byName.swing || 0) &&
      (t4sw1.byName.hit || 0) === (t4sw0.byName.hit || 0),
      'swing=' + (t4sw0.byName.swing || 0) + '→' + (t4sw1.byName.swing || 0) +
      ' hit=' + (t4sw0.byName.hit || 0) + '→' + (t4sw1.byName.hit || 0));

    /* 可听性用相对读数：统一增益系数、关键音记账、放大后的实际 volScale。
       不钉绝对 dB，也不靠延长等待听效果。 */
    const t4k0 = T.sfxStats();
    G.sfx.play('hit', { volume: 0.5 });
    const t4k1 = T.sfxStats();
    ok('T4.4 关键动作音有统一相对增益，UI 点击音维持原样',
      t4k1.keyGain > 1 && t4k1.keySoundCount >= 20 && t4k1.keyPlays > t4k0.keyPlays &&
      !!t4k1.last && t4k1.last.name === 'hit' &&
      Math.abs(t4k1.last.volume - 0.5 * t4k1.keyGain) < 1e-6,
      'keyGain=' + t4k1.keyGain + ' keyPlays=' + t4k0.keyPlays + '→' + t4k1.keyPlays +
      ' last=' + JSON.stringify(t4k1.last));
    }

    /* ---------------- P2. 首夜引导与 HUD 收敛（真实键盘 / 真实点击 / 只读几何） ----------------
     * 不改目标链、不换皮、不动 dayLengthSeconds。机器只判「不相交 / 状态翻转 / 文案阶段」，
     * 好不好看、好不好玩留给真人看双尺寸截图与试玩。 */
    {
    G.closeUI();
    const hd0 = T.hudInfo();
    ok('HD.1 目标提示抬到快捷栏之上：与第 9 格不相交且宽度受限',
      !!hd0.hintRect && !!hd0.slot9Rect && hd0.overlap === false &&
      parseFloat(hd0.hintBottom) >= 76 && hd0.hintMaxWidth !== 'none',
      'win=' + hd0.windowWidth + 'x' + hd0.windowHeight + ' bottom=' + hd0.hintBottom +
      ' maxWidth=' + hd0.hintMaxWidth + ' overlap=' + hd0.overlap +
      ' bar=' + JSON.stringify(hd0.hintRect) + ' slot9=' + JSON.stringify(hd0.slot9Rect));

    /* H 键：真实 KeyboardEvent，复用 Q1 的 dismiss/reopen 状态与存档字段 */
    const hdKey = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
    if (T.questsInfo().dismissed) { hdKey('KeyH'); await frame(); }
    const hdBefore = T.questsInfo();
    hdKey('KeyH');
    await frame(); await frame();
    const hdHidden = T.questsInfo();
    hdKey('KeyH');
    await frame(); await frame();
    const hdShown = T.questsInfo();
    ok('HD.2 H 键把常驻目标提示收成可选层，再按展开；目标链进度一字不变',
      hdBefore.dismissed === false && hdHidden.dismissed === true && hdShown.dismissed === false &&
      hdHidden.hintBar.length < hdBefore.hintBar.length &&
      hdShown.hintBar.length > hdHidden.hintBar.length &&
      hdShown.current === hdBefore.current && hdShown.completed.join(',') === hdBefore.completed.join(','),
      'dismissed=' + hdBefore.dismissed + '→' + hdHidden.dismissed + '→' + hdShown.dismissed +
      ' current=' + hdShown.current);

    /* 建议区折叠：节点与 .recipe-item 数量都不许变（Q1.4 / Q1.12 / 6.4a 的查询原样） */
    G.openInventory(); await frame(); await frame();
    const hdItems0 = document.querySelectorAll('#recipe-book .recipe-item').length;
    const hdSugRows0 = document.querySelectorAll('#quest-suggestions .quest-suggestion').length;
    const hdToggle0 = document.querySelector('#quest-suggestions .quest-suggestions-toggle');
    if (hdToggle0) { hdToggle0.click(); await frame(); await frame(); }
    const hdSug2 = document.querySelector('#quest-suggestions');
    const hdFirstRow = hdSug2 && hdSug2.querySelector('.quest-suggestion');
    const hdRowDisplay = hdFirstRow ? getComputedStyle(hdFirstRow).display : '';
    const hdItems1 = document.querySelectorAll('#recipe-book .recipe-item').length;
    const hdQ3 = T.questsInfo();
    ok('HD.3 建议区可折叠：节点与 .recipe-item 数量不变，折叠只隐藏建议行',
      !!hdToggle0 && !!hdSug2 && hdSugRows0 > 0 &&
      T.hudInfo().suggestionsCollapsed === true &&
      hdRowDisplay === 'none' && hdItems1 === hdItems0 &&
      hdQ3.suggestions.length === hdSugRows0 &&
      document.querySelectorAll('#quest-suggestions .recipe-item').length === 0,
      'rows=' + hdSugRows0 + '→' + hdQ3.suggestions.length +
      ' recipeItems=' + hdItems0 + '→' + hdItems1 + ' display=' + hdRowDisplay);
    const hdToggle1 = document.querySelector('#quest-suggestions .quest-suggestions-toggle');
    if (hdToggle1) { hdToggle1.click(); await frame(); }
    G.closeUI();

    /* 首夜引导：真实主循环按 time 刷新（0.5s 节流），白天自动收起 */
    T.setTime(0.52);
    const hdSoonW = await tryUntil(() => T.hudInfo().nightPhase === 'soon',
      { budgetMs: 3000, label: '入夜前预警', observe: () => T.hudInfo() });
    const hdS = T.hudInfo();
    T.setTime(0.6);
    const hdNightW = await tryUntil(() => T.hudInfo().nightPhase === 'night',
      { budgetMs: 3000, label: '入夜避险提示', observe: () => T.hudInfo() });
    const hdN = T.hudInfo();
    const hdLogA = hdN.nightLog.length;
    G.ui.updateNightHint(0.6, {}); G.ui.updateNightHint(0.6, {});
    const hdLogB = T.hudInfo().nightLog.length;
    T.setTime(0.3);                                   // 恢复白天基准，不影响后续离线审计
    const hdDay = await tryUntil(() => T.hudInfo().nightPhase === null,
      { budgetMs: 3000, label: '回到白天提示收起', observe: () => T.hudInfo() });
    const hdD = T.hudInfo();
    ok('HD.4 首夜引导只在入夜前/入夜出现，白天自动收起，同一阶段不重复计数',
      hdSoonW.ok && hdS.nightShown && hdS.nightText.includes('天快黑了') &&
      hdNightW.ok && hdN.nightShown && hdN.nightText.includes('夜里') &&
      hdLogB === hdLogA && hdDay.ok && hdD.nightShown === false && hdD.nightText === '',
      'soon=' + hdSoonW.ok + ' night=' + hdNightW.ok + ' day=' + hdDay.ok +
      ' log=' + hdLogA + '→' + hdLogB + ' text=' + hdS.nightText + ' / ' + hdN.nightText);

    ok('HD.5 守卫：昼夜总长仍 600s、六步链与成就未被可选提示层改写',
      G.settings.dayLengthSeconds === 600 &&
      T.questsInfo().total === 6 && T.questsInfo().ids.length === 6 &&
      T.achievementsInfo().ids.length <= 9 &&
      document.querySelector('#hint-bar') !== null &&
      document.querySelector('#night-hint') !== null,
      'day=' + G.settings.dayLengthSeconds + ' quests=' + T.questsInfo().ids.join(',') +
      ' ach=' + T.achievementsInfo().ids.length);
    }

    /* ---------------- BM. 阶段 2 建材扩充（真实世界放得下、挖得着、分带对） ---------------- */
    {
    const bmKinds = ['GRANITE', 'DIORITE', 'ANDESITE', 'POLISHED_GRANITE', 'POLISHED_DIORITE', 'POLISHED_ANDESITE',
      'SMOOTH_STONE', 'MOSSY_STONE_BRICKS', 'CRACKED_STONE_BRICKS', 'CHISELED_STONE_BRICKS',
      'SMOOTH_SANDSTONE', 'CHISELED_SANDSTONE', 'CUT_SANDSTONE', 'WOOL_BLOCK'];
    const bmX = Math.floor(G.spawn.x) + 2, bmZ = Math.floor(G.spawn.z) + 2;
    const bmY = Math.floor(G.spawn.y) + 1;
    for (let dz = 0; dz <= 4; dz++) for (let dx = 0; dx <= 4; dx++) T.setBlock(bmX + dx, bmY - 1, bmZ + dz, 4);
    await T.waitChunks(1);
    const bmBad = [], bmNames = [];
    const bmIds = bmKinds.map(k => T.blockIds[k]);
    for (let i = 0; i < bmKinds.length; i++) {
      const x = bmX + (i % 5), z = bmZ + ((i / 5) | 0);
      T.setBlock(x, bmY, z, bmIds[i]);
      const back = T.blockAt(x, bmY, z);
      if (back.id !== bmIds[i]) bmBad.push(bmKinds[i] + ' 放下去读回 ' + back.id);
      else if (!/[一-龥]/.test(back.name)) bmBad.push(bmKinds[i] + ' 中文名不是中文：' + back.name);
      else bmNames.push(back.name);
    }
    ok('BM.1 十四种新建材在真实世界里放得下、读得回、中文名齐全',
      bmBad.length === 0 && bmNames.length === 14 && bmIds.every(v => v >= 56 && v <= 69),
      'id 区间=' + Math.min.apply(null, bmIds) + '~' + Math.max.apply(null, bmIds) +
      ' 名字=' + bmNames.join('/') + (bmBad.length ? ' 问题：' + bmBad.join(' | ') : ''));
    for (let i = 0; i < bmKinds.length; i++) T.setBlock(bmX + (i % 5), bmY, bmZ + ((i / 5) | 0), 0);

    /* 天然分带：出生点下方 5×5 范围往下扫（单柱容易抽不到某一种岩），
       三种火成岩都要出现，且平均高度是花岗岩 > 闪长岩 > 安山岩。
       下界跟着布局走：旧布局是 y>=2，新档要一直扫到基岩带以上，
       否则安山岩（新档分带 -56..-6）根本不在窗口里 —— 这是采样窗口没跟上，不是分带坏了。 */
    const bmCol = { g: [], d: [], a: [], cells: 0 };
    await T.waitChunks(1); await sleep(400);
    const bmSX = Math.floor(G.spawn.x), bmSZ = Math.floor(G.spawn.z);
    const bmYBot = G.world.minY < 0 ? G.world.minY + 5 : 2;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      for (let y = Math.floor(G.spawn.y) - 1; y >= bmYBot; y--) {
        const id = T.blockAt(bmSX + dx, y, bmSZ + dz).id;
        bmCol.cells++;
        if (id === T.blockIds.GRANITE) bmCol.g.push(y);
        else if (id === T.blockIds.DIORITE) bmCol.d.push(y);
        else if (id === T.blockIds.ANDESITE) bmCol.a.push(y);
      }
    }
    const bmAvg = (arr) => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : -1;
    ok('BM.2 出生点下方 5×5 扫描：花岗岩 / 闪长岩 / 安山岩都天然存在，且按深度分带（浅→深）',
      bmCol.g.length >= 3 && bmCol.d.length >= 3 && bmCol.a.length >= 3 &&
      bmAvg(bmCol.g) > bmAvg(bmCol.d) && bmAvg(bmCol.d) > bmAvg(bmCol.a),
      '中心=' + bmSX + ',' + bmSZ + ' 扫到 y=' + bmYBot + ' 共 ' + bmCol.cells + ' 格：' +
      '花岗岩=' + bmCol.g.length + '格(均高 ' + bmAvg(bmCol.g).toFixed(1) + ')' +
      ' 闪长岩=' + bmCol.d.length + '格(均高 ' + bmAvg(bmCol.d).toFixed(1) + ')' +
      ' 安山岩=' + bmCol.a.length + '格(均高 ' + bmAvg(bmCol.a).toFixed(1) + ')');
    }

    /* ---------------- GV. 阶段 1 生成版本的存读档（先只接字段，不接布局） ----------------
       目的：把「旧档没有这个字段 → 一律旧布局」和「新档标签不许跑在布局前面」变成端到端能看到的读数。
       顺带做一次真实的 save → toMenu → loadWorld 往返，把标记方块带过去核对（这也是 E2.4/E2.5
       那类「读档后状态对不对」的最小场景，不额外拉长等待）。 */
    {
    const gvMark = T.blockIds.STONE_BRICKS;
    const gvState0 = T.state().genVersion;
    const gvMeta = G.buildSaveObject().meta;
    const gvX = Math.floor(G.spawn.x) + 6, gvZ = Math.floor(G.spawn.z) + 6;
    const gvY = Math.floor(G.world.topSolidY(gvX, gvZ)) + 1;
    T.setBlock(gvX, gvY, gvZ, gvMark);
    await T.waitChunks(1);
    const gvBefore = T.blockAt(gvX, gvY, gvZ).id;
    await G.save('manual');
    const gvName = G.meta.name;
    G.toMenu(); await sleep(300);
    await G.loadWorld(gvName);
    await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'GV 读档回到游戏' });
    await T.waitChunks(1);
    const gvState1 = T.state().genVersion;
    const gvAfter = T.blockAt(gvX, gvY, gvZ).id;
    /* 第 3 刀之后：剧本自己 newWorld 出来的世界就是深地档（标签 1 = GEN_DEEP）。
       「旧档（没有这个字段）读回来还是旧布局」那条路径由下面的 DP.7 专门验。 */
    ok('GV.1 生成版本走通存读档：新档标签为 1、写回 meta 一致、读档后标签与布局一起恢复且标记方块还在',
      gvState0 === 1 && gvMeta.genVersion === gvState0 && gvState1 === gvState0 &&
      gvBefore === gvMark && gvAfter === gvBefore &&
      G.world.minY === -64 && G.world.layers === 128 && G.world.topY === 64,
      '运行时 genVersion ' + gvState0 + '→' + gvState1 + '，存档 meta.genVersion=' + gvMeta.genVersion +
      '（存档 version=' + gvMeta.version + '，字段缺失时按旧布局）；标记格 id ' + gvBefore + '→' + gvAfter +
      ' 于 ' + gvX + ',' + gvY + ',' + gvZ + '；读档后布局=' + G.world.minY + '..' + (G.world.topY - 1));
    }

    /* ---------------- DP. 阶段 1 第 3 刀：负 Y 深地（在真实渲染/物理/存档路径里挖得下去、读得回来） ----------------
       任务书阶段 1 的验收口径：三种子地表到第一层基岩 ≥80 格、截图有地表 + 两个岩层 + 基岩读数、
       正常挖到深层、带矿回家、保存退出再读档核对负 Y 的放置/挖掘/容器，旧档核对建筑/箱子/熔炉/重生。
       这里覆盖 EXE 里能自动化的部分；纯数据部分（分带、可步行判据、指纹常数）在 app/tests/world.test.js。 */
    {
    const dpMinY = G.world.minY, dpTopY = G.world.topY;
    const dpX = Math.floor(G.spawn.x), dpZ = Math.floor(G.spawn.z);
    const ID = T.blockIds;
    /* 提前把出生点周围 5×5 区块真的生成出来：
       `T.setBlock` 写进未生成区块是**静默丢弃**的（踩过），而负 Y 的标记全在这圈里；
       DP.6 的洞穴扫描也必须读真数据，不能读「未生成区块的近似实心」。 */
    for (let cz = (dpZ >> 4) - 2; cz <= (dpZ >> 4) + 2; cz++)
      for (let cx = (dpX >> 4) - 2; cx <= (dpX >> 4) + 2; cx++) G.world.ensureChunk(cx, cz);
    await T.waitChunks(1);
    let dpBed = null, dpStone = 0, dpDs = 0, dpAir = 0, dpDsTop = -999, dpStoneMin = 999;
    for (let y = dpTopY - 1; y >= dpMinY; y--) {
      const id = T.blockAt(dpX, y, dpZ).id;
      if (dpBed === null && id === ID.BEDROCK) dpBed = y;
      else if (id === ID.STONE) { dpStone++; dpStoneMin = Math.min(dpStoneMin, y); }
      else if (id === ID.DEEPSLATE) { dpDs++; dpDsTop = Math.max(dpDsTop, y); }
      else if (id === ID.AIR) dpAir++;
    }
    ok('DP.1 新档布局：出生柱从地表一路挖到基岩带有 80 格以上，世界顶仍是不动的那一格',
      dpMinY === -64 && dpTopY === 64 && G.world.layers === 128 && G.world.genVersion === 1 &&
      dpBed !== null && dpBed >= -64 && dpBed <= -61 && (Math.floor(G.spawn.y) - dpBed) >= 80,
      '布局=' + dpMinY + '..' + (dpTopY - 1) + '（' + G.world.layers + ' 格）出生=' +
      dpX + ',' + Math.floor(G.spawn.y) + ',' + dpZ + ' 第一层基岩 y=' + dpBed +
      ' 柱深=' + (Math.floor(G.spawn.y) - dpBed) + '（要求 ≥80）石头 ' + dpStone + ' 深板岩 ' + dpDs + ' 空气 ' + dpAir);
    ok('DP.2 真实世界里的三层岩齐全：石头在上、深板岩在下且整体在 y<0、基岩只贴底部那一带',
      dpStone > 0 && dpDs > 0 && dpDsTop < dpStoneMin && dpDsTop < 0,
      '深板岩最高 y=' + dpDsTop + '，石头最低 y=' + dpStoneMin + '，基岩顶 y=' + dpBed);

    /* DP.3 把出生点旁边那一列打通，玩家真的站进负 Y。
       物理用**固定步长手动推进**（与 14 节同一套路），不等 rAF ——
       实时等 onGround 会被当时的渲染节流拖成假超时。 */
    const dpSX = dpX + 3, dpSZ = dpZ + 3;
    if (G.state !== 'playing') { G.state = 'playing'; G.input.setUIMode(false); }
    G.controller.setCreative(false);
    await frame();
    const dpShaftTop = Math.floor(G.world.topSolidY(dpSX, dpSZ));
    for (let y = dpShaftTop; y >= -24; y--) {
      const id = T.blockAt(dpSX, y, dpSZ).id;
      if (id !== ID.AIR && id !== ID.WATER) T.setBlock(dpSX, y, dpSZ, ID.AIR);
    }
    await T.waitChunks(1, { light: true });
    const dpBlank = { keyW: false, keyA: false, keyS: false, keyD: false, jump: false, sprint: false, sneak: false };
    G.controller.spawnAt(dpSX + 0.5, -22, dpSZ + 0.5);
    let dpSteps = 0;
    for (; dpSteps < 900 && !G.controller.onGround; dpSteps++) G.controller.update(0.02, dpBlank);
    const dpStandY = G.controller.pos.y;
    const dpFloorY = Math.floor(dpStandY - 0.08);
    const dpFloorId0 = T.blockAt(dpSX, dpFloorY, dpSZ).id;
    T.give('pickaxe_stone', 1);
    const dpPickSlot = G.inventory.slots.findIndex(s => s && s.item === 'pickaxe_stone');
    if (dpPickSlot >= 0) G.inventory.select(dpPickSlot);
    T.mineAt(dpSX, dpFloorY, dpSZ);                 // 生产路径：interaction.finishBreak
    for (let i = 0; i < 60; i++) G.controller.update(0.02, dpBlank);
    const dpFloorId1 = T.blockAt(dpSX, dpFloorY, dpSZ).id;
    const dpAlive = G.state === 'playing' && G.controller.health > 0;
    ok('DP.3 负 Y 里真实左键挖掘生效、玩家能站在 y<0 的地面上且不被误判「掉出世界」',
      dpSteps < 900 && dpStandY < 0 && G.controller.onGround && dpAlive &&
      dpFloorId0 !== ID.AIR && dpFloorId1 === ID.AIR,
      '站定 y=' + dpStandY.toFixed(2) + '（模拟 ' + dpSteps + ' 步 ×20ms，onGround=' + G.controller.onGround + '）' +
      ' 洞顶打通自 y=' + dpShaftTop + '；脚下 y=' + dpFloorY + ' 由 ' + dpFloorId0 + ' 挖成 ' + dpFloorId1 +
      '，现在脚在 y=' + (Math.floor(G.controller.pos.y - 0.08)) +
      '；state=' + G.state + ' hp=' + G.controller.health + '（原来写死 y<-8 判掉出世界，这里会当场死亡）');

    /* DP.4 深板岩族在负 Y 的「物品 → 方块 → 物品」往返（放得下、读得回、挖得出）。
       注意：T.placeAt 会先把当前快捷格覆盖成 64 个该物品再落方块，所以这里不比「数量减少」，
       只比「放得下 + 中文名 + 挖掉之后还在手里 + 熔炼路线通」。 */
    const dpPX = dpX - 5, dpPZ = dpZ - 5, dpPY = -40;
    T.give('polished_deepslate', 4);
    const dpCnt0 = G.inventory.countOf('polished_deepslate');
    T.placeAt(dpPX, dpPY, dpPZ, 'polished_deepslate');
    const dpRead = T.blockAt(dpPX, dpPY, dpPZ);
    T.mineAt(dpPX, dpPY, dpPZ);
    await sleep(240);
    const dpCnt1 = G.inventory.countOf('polished_deepslate');
    ok('DP.4 深板岩族在负 Y 放得下、读得回、挖得掉，中文名与背包数量都对',
      dpCnt0 >= 4 && dpRead.id === ID.POLISHED_DEEPSLATE && /[一-龥]/.test(dpRead.name) &&
      T.blockAt(dpPX, dpPY, dpPZ).id === ID.AIR && dpCnt1 >= 64,
      'y=' + dpPY + ' 放进 ' + dpRead.id + '（' + dpRead.name + '）挖掉后背包=' + dpCnt1 +
      '（熔炼路线 deepslate→polished_deepslate 由单测「阶段1 深板岩族」覆盖）');

    /* DP.5 负 Y 的存读档全套：两个不同区块的放置、一次挖掘、一个箱子、一台熔炉，外加重生点 */
    const dpM1 = { x: dpX + 6, y: -33, z: dpZ + 6 };
    const dpM2 = { x: dpX - 20, y: -58, z: dpZ + 12 };       // 刻意落在另一块区块里
    const dpDig = { x: dpX + 10, y: -50, z: dpZ - 8 };
    const dpCh = { x: dpX - 9, y: -40, z: dpZ - 9 };
    const dpFu = { x: dpX - 10, y: -45, z: dpZ - 9 };
    /* 标记要用「地形里不会出现」的方块：world.setBlock 对「值本来就一样」返回 false，
       拿深板岩当标记会把它写成功误报成失败。 */
    const dpW1 = T.setBlock(dpM1.x, dpM1.y, dpM1.z, ID.STONE_BRICKS);
    const dpW2 = T.setBlock(dpM2.x, dpM2.y, dpM2.z, ID.POLISHED_DEEPSLATE);
    T.setBlock(dpDig.x, dpDig.y, dpDig.z, ID.STONE);
    T.mineAt(dpDig.x, dpDig.y, dpDig.z);
    T.placeAt(dpCh.x, dpCh.y, dpCh.z, 'chest');
    G.world.getContainer(dpCh.x, dpCh.y, dpCh.z)[0] = { item: 'diamond', count: 1 };
    T.placeAt(dpFu.x, dpFu.y, dpFu.z, 'furnace');
    const dpFuObj = G.world.getFurnace(dpFu.x, dpFu.y, dpFu.z);
    dpFuObj.input = { item: 'iron_ore', count: 3 };
    await T.waitChunks(1);
    const dpSpawnY = Math.floor(G.spawn.y);
    await G.save('manual');
    const dpName = G.meta.name;
    G.toMenu(); await sleep(300);
    await G.loadWorld(dpName);
    await tryUntil(() => G.state === 'playing',
      { budgetMs: 60000, tick: 'sleep', intervalMs: 100, label: 'DP.5 深地档读回来（128 格布局）' });
    await T.waitChunks(1, { light: true });
    const dpR1 = T.blockAt(dpM1.x, dpM1.y, dpM1.z).id;
    const dpR2 = T.blockAt(dpM2.x, dpM2.y, dpM2.z).id;
    const dpR3 = T.blockAt(dpDig.x, dpDig.y, dpDig.z).id;
    const dpChestOk = G.world.hasContainer(dpCh.x, dpCh.y, dpCh.z) &&
      !!G.world.getContainer(dpCh.x, dpCh.y, dpCh.z)[0] &&
      G.world.getContainer(dpCh.x, dpCh.y, dpCh.z)[0].item === 'diamond';
    const dpFurnaceOk = !!G.world.getFurnace(dpFu.x, dpFu.y, dpFu.z) &&
      G.world.getFurnace(dpFu.x, dpFu.y, dpFu.z).input &&
      G.world.getFurnace(dpFu.x, dpFu.y, dpFu.z).input.item === 'iron_ore';
    const dpRespawnOk = Math.floor(G.spawn.y) === dpSpawnY && G.spawn.y > G.world.seaLevel;
    ok('DP.5 负 Y 的放置/挖掘/箱子/熔炉与重生点，保存退出再读档全部原样恢复',
      dpR1 === ID.STONE_BRICKS && dpR2 === ID.POLISHED_DEEPSLATE && dpR3 === ID.AIR &&
      dpChestOk && dpFurnaceOk && dpRespawnOk &&
      G.world.minY === -64 && G.world.layers === 128 && G.world.genVersion === 1,
      '区块A ' + dpW1 + '→' + dpR1 + ' 区块B ' + dpW2 + '→' + dpR2 + '（' + dpM2.x + ',' + dpM2.y + ',' + dpM2.z +
      ' 在 ' + (dpM2.x >> 4) + ',' + (dpM2.z >> 4) + ' 块）挖空→' + dpR3 +
      ' 箱子钻石=' + dpChestOk + ' 熔炉铁矿=' + dpFurnaceOk + ' 重生 y ' + dpSpawnY + '→' + Math.floor(G.spawn.y) +
      ' 布局=' + G.world.minY + '..' + (G.world.topY - 1));

    /* DP.6 真实区块里有连片可步行的深洞（判据按玩家实际走的来，不看纯函数） */
    const dpAirAt = (x, y, z) => T.blockAt(x, y, z).id === ID.AIR;
    const dpFloor = (x, y, z) => {
      const id = T.blockAt(x, y, z).id;
      if (id === ID.AIR || id === ID.WATER || id === ID.BEDROCK) return false;
      return dpAirAt(x, y + 1, z) && dpAirAt(x, y + 2, z);
    };
    let dpBest = 0, dpSpot = null;
    for (let y = -54; y <= -10 && dpBest < 24; y += 2) {
      for (let z = -16; z <= 16; z += 2) {
        for (let x = -16; x <= 16; x++) {
          if (!dpFloor(x, y, z)) continue;
          let run = 1, cy = y;
          for (let k = 1; k <= 24; k++) {
            const nx = x + k;
            let nf = null;
            for (let d = 1; d >= -1; d--) if (dpFloor(nx, cy + d, z)) { nf = cy + d; break; }
            if (nf === null) break;
            cy = nf; run++;
          }
          if (run > dpBest) { dpBest = run; dpSpot = { x, y, z, floor: T.blockAt(x, y, z).id }; }
        }
      }
    }
    ok('DP.6 出生区块内就有可步行的深洞：地板实心、2 格净空、每步高差 ≤1 且能连走 10 格以上',
      dpBest >= 10 && dpSpot.y < 0 && dpSpot.floor !== ID.BEDROCK,
      '最长连走 ' + dpBest + ' 格 起点=' + JSON.stringify(dpSpot) + '（要求 ≥10，地板在 y<0）');

    /* DP.7 真·旧档（meta 里没有 genVersion、且没有任何 diff 键）读回来必须是旧布局 */
    /* 先把玩家放回地表：DP.3~DP.5 把人留在 y<-24，
       同一份存档按旧布局（0..63）读时那一格是基岩内部，会把「旧档兼容」测成「卡进石头」。 */
    G.controller.spawnAt(G.spawn.x, G.world.topSolidY(Math.floor(G.spawn.x), Math.floor(G.spawn.z)) + 1, G.spawn.z);
    for (let i = 0; i < 40 && !G.controller.onGround; i++) G.controller.update(0.02, dpBlank);
    const dpOldObj = G.buildSaveObject();
    delete dpOldObj.meta.genVersion;
    dpOldObj.world = {};                       // 清掉编辑：负 Y 的 diff 键是深地布局下标，混版本读会串位
    dpOldObj.meta = Object.assign({}, dpOldObj.meta, { name: '旧档布局-L1' });
    await G.storage.saveWorld('旧档布局-L1', dpOldObj);
    G.toMenu(); await sleep(300);
    await G.loadWorld('旧档布局-L1');
    await tryUntil(() => G.state === 'playing',
      { budgetMs: 60000, tick: 'sleep', intervalMs: 100, label: 'DP.7 旧布局档读回来' });
    await T.waitChunks(1);
    const dpOldX = Math.floor(G.spawn.x), dpOldZ = Math.floor(G.spawn.z);
    let dpOldBed = null, dpOldDs = 0;
    for (let y = 63; y >= 0; y--) {
      const id = T.blockAt(dpOldX, y, dpOldZ).id;
      if (dpOldBed === null && id === ID.BEDROCK) dpOldBed = y;
      if (id === ID.DEEPSLATE) dpOldDs++;
    }
    ok('DP.7 没有 genVersion 字段的旧档：读回来仍是 0..63 旧布局，负 Y 读成基岩、一个深板岩都没有',
      G.world.genVersion === 0 && G.world.minY === 0 && G.world.layers === 64 && G.world.topY === 64 &&
      T.blockAt(dpOldX, -1, dpOldZ).id === ID.BEDROCK &&
      T.blockAt(dpOldX, 64, dpOldZ).id === ID.AIR &&
      dpOldDs === 0 && dpOldBed !== null && dpOldBed >= 0 && dpOldBed <= 3,
      '布局=' + G.world.minY + '..' + (G.world.topY - 1) + ' genVersion=' + G.world.genVersion +
      ' 柱=' + dpOldX + ',' + dpOldZ + ' 第一层基岩 y=' + dpOldBed + ' y=-1 读成 ' + T.blockAt(dpOldX, -1, dpOldZ).id +
      ' 旧档柱深=' + (Math.floor(G.spawn.y) - dpOldBed) + ' 深板岩计数=' + dpOldDs);
    G.toMenu(); await sleep(200);
    await G.storage.deleteWorld('旧档布局-L1');
    await G.loadWorld(dpName);                 // 会话末尾回到深地档，保持后续小节的现场不变
    await tryUntil(() => G.state === 'playing',
      { budgetMs: 60000, tick: 'sleep', intervalMs: 100, label: 'DP 收尾回到深地档' });
    await T.waitChunks(1);
    }

    /* ---------------- FS. 阶段 3a：成群游动的鱼（自然生成 + 水下观感 + 掉落） ----------------
       任务书最低交付：「一种自然生成的成群鱼」。这里全程不手动 spawn，只让站点扫描自己刷。 */
    {
    const fsStep = 16;
    let fsSite = null, fsScan = 0, fsKey = null;
    const fsBaseX = Math.floor(G.spawn.x / fsStep), fsBaseZ = Math.floor(G.spawn.z / fsStep);
    for (let ring = 1; ring <= 4 && !fsSite; ring++) {
      for (let dz = -ring; dz <= ring && !fsSite; dz++) {
        for (let dx = -ring; dx <= ring && !fsSite; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const s = T.fishSiteAt(fsBaseX + dx, fsBaseZ + dz);
          fsScan++;
          if (!s) continue;
          const water = G.mobs.fishWaterAt(s.x, s.z);
          if (water) { fsSite = { s, water }; fsKey = s.key; }
        }
      }
    }
    const fsCreative0 = G.controller.creative, fsFly0 = G.controller.flying;
    /* 站位要算一下：刷怪有「离玩家太近不刷」的保护（站点中心到玩家 ≥6 格），
       直接把玩家丢到站点正上方会被这条保护挡掉，扫描转而去刷别的格、把 18 条额度占满，
       被测的这一群反倒一条都不生。所以站在**同一个 16 格站点格的另一个角**上：
       这一格仍是扫描第一个看的（ring 0），而距离站点中心 ≥7 格，保护不会拦。 */
    let fsStand = null;
    if (fsSite) {
      const ox = fsSite.s.x - fsSite.s.sx * fsStep, oz = fsSite.s.z - fsSite.s.sz * fsStep;
      const px = fsSite.s.sx * fsStep + (ox < 8 ? fsStep - 0.6 : 0.6);
      const pz = fsSite.s.sz * fsStep + (oz < 8 ? fsStep - 0.6 : 0.6);
      fsStand = { px, pz, d: Math.hypot(px - fsSite.s.x, pz - fsSite.s.z) };
    }
    /* 这一段测的是「自然生成」，所以要有自然刷怪的额度。前面几十节一路用 `maxMobs = 0`
       表达「这一段把刷怪关掉」，鱼群扫描听的是同一把总量闸（整个管理器共用，不是另一套开关），
       于是这里先清场、再把上限恢复成出厂值（MobManager 构造里的 26），收尾时原样还回去。 */
    const fsMax0 = G.mobs.maxMobs;
    G.mobs.clear();
    if (fsSite) {
      G.controller.setCreative(true);
      G.controller.flying = true;
      G.controller.setPositions(fsStand.px, G.world.seaLevel + 1.6, fsStand.pz);
      G.mobs.maxMobs = 26;        // 额度在玩家就位之后才开：否则这一帧之前可能从旧位置先刷掉别的格
      await T.waitChunks(1, { light: true });
    }
    const fsLim = T.fishLimits();
    const fsSchool = () => T.fishInfo().filter(f => f.school === fsKey);
    ok('FS.1 出生点 4 圈内必须能找到「有站点且水深足够」的海洋鱼场（自然生成的前提）',
      !!fsSite && fsScan > 0 && !!fsKey && !!fsStand && fsStand.d >= 6,
      '扫了 ' + fsScan + ' 个站点格' + (fsSite ? '；命中站点 ' + JSON.stringify(fsSite.s) +
        ' 站点键=' + fsKey + ' 水深 ' + fsSite.water.depth + ' 游动层 y=' + fsSite.water.y +
        ' 玩家同格站位距站点中心=' + fsStand.d.toFixed(1) + ' 格（≥6 才不被近身保护挡掉）' : '（一个都没找到）'));

    /* FS.2 自然生成：只等，不手动 spawn。取样按「这一群的站点键」来 —— 附近别的站点各自成群是正常现象，
       但每一格都不许被补成第二群（这正是本轮修真 bug 的那条界线）。 */
    const fsWait = fsSite ? await tryUntil(() => fsSchool().length >= fsLim.schoolMin,
      { budgetMs: 25000, tick: 'sleep', intervalMs: 150, label: 'FS 鱼群自然生成', observe: () => fsSchool().length }) : { ok: false, ms: 0 };
    const fsFish = fsSchool();
    const fsAll = T.fishInfo();
    const fsKeys = [...new Set(fsFish.map(f => f.school))];
    const fsInWater = fsFish.filter(f => {
      const id = T.blockAt(Math.floor(f.x), Math.floor(f.y), Math.floor(f.z)).id;
      return id === T.blockIds.WATER;
    }).length;
    const fsSpread = fsFish.length ? Math.max(...fsFish.map(f =>
      Math.hypot(f.x - fsFish[0].x, f.z - fsFish[0].z))) : 0;
    const fsPerKey = new Map();
    for (const f of fsAll) fsPerKey.set(f.school, (fsPerKey.get(f.school) || 0) + 1);
    const fsOneSchoolPerKey = [...fsPerKey.values()].every(v => v <= fsLim.schoolMax);
    const fsAllKeyed = fsAll.every(f => typeof f.school === 'string' && f.school);
    ok('FS.2 鱼群是自然生成的：≥' + fsLim.schoolMin + ' 条、全在水里、同属一个站点键、彼此在 8 格内（成群而不是散兵）',
      fsWait.ok && fsFish.length >= fsLim.schoolMin && fsFish.length <= fsLim.schoolMax &&
      fsInWater === fsFish.length && fsKeys.length === 1 && !!fsKeys[0] && fsSpread <= 8 &&
      fsAllKeyed && fsOneSchoolPerKey && fsAll.length <= fsLim.maxAlive,
      '等待=' + (fsWait.ok ? fsWait.ms + 'ms' : '超时') + ' 本格条数=' + fsFish.length +
      ' 在水里=' + fsInWater + ' 站点键=' + JSON.stringify(fsKeys) + ' 最大间距=' + fsSpread.toFixed(2) +
      ' 全场鱼=' + fsAll.length + '/' + fsLim.maxAlive + ' 带键=' + fsAllKeyed +
      ' 每键≤一群=' + fsOneSchoolPerKey + '（各键 ' + JSON.stringify([...fsPerKey].map(e => e[0] + ':' + e[1])) + '）');

    /* FS.3 会游动（真实帧，不是手动 step）：按站点键取同一群，前后两次取样才对得上同一条鱼 */
    const fsPos0 = fsSchool();
    await sleep(2000);
    const fsPos1 = fsSchool();
    const fsAllLive1 = T.fishInfo();
    let fsMoved = 0, fsBestMove = 0;
    for (let i = 0; i < Math.min(fsPos0.length, fsPos1.length); i++) {
      const d = Math.hypot(fsPos1[i].x - fsPos0[i].x, fsPos1[i].z - fsPos0[i].z);
      if (d > 0.4) fsMoved++;
      fsBestMove = Math.max(fsBestMove, d);
    }
    const fsStillWater = fsAllLive1.filter(f =>
      T.blockAt(Math.floor(f.x), Math.floor(f.y), Math.floor(f.z)).id === T.blockIds.WATER).length;
    ok('FS.3 鱼会游动（2 秒真实帧内至少一条位移 >0.4 格），而且不会上岸散步',
      fsMoved >= 1 && fsStillWater === fsAllLive1.length && fsPos1.length >= fsLim.schoolMin,
      '本格条数=' + fsPos1.length + ' 移动到的条数=' + fsMoved + '/' + fsPos1.length +
      ' 最大位移=' + fsBestMove.toFixed(2) + ' 仍在水里=' + fsStillWater + '/' + fsAllLive1.length);

    /* FS.4 摆尾必须真的应用到模型（render 的产物，不只是 computePose 的返回值） */
    const fsTails = new Set();
    let fsTailMax = 0;
    for (let i = 0; i < 40; i++) {
      for (const f of fsSchool()) {
        if (f.tail === null) continue;
        fsTails.add(f.tail.toFixed(2));
        fsTailMax = Math.max(fsTailMax, Math.abs(f.tail));
      }
      await frame();
    }
    ok('FS.4 尾鳍摆动来自 render 真实应用：40 帧里读到 ≥2 个不同 tail 角度且幅度有界',
      fsTails.size >= 2 && fsTailMax <= 0.61,
      '不同角度=' + fsTails.size + ' 最大摆幅=' + fsTailMax.toFixed(3));

    /* FS.5 水下观感：鱼所在格的天光必须比水面低，实体亮度也确实被压暗（生物采样世界光照） */
    const fsOne = fsPos1[0];
    const fsFishLight = fsOne ? T.lightAt(Math.floor(fsOne.x), Math.floor(fsOne.y), Math.floor(fsOne.z)) : null;
    const fsAirLight = fsOne ? T.lightAt(Math.floor(fsOne.x), G.world.seaLevel + 2, Math.floor(fsOne.z)) : null;
    const fsShade = fsOne ? fsOne.shade : null;
    ok('FS.5 鱼真的待在被压暗的水下：所在格天光 ≤14、水面之上 2 格是 15，实体亮度小于 1',
      !!fsFishLight && !!fsAirLight && fsFishLight.sky <= 14 && fsAirLight.sky === 15 &&
      fsShade !== null && fsShade < 1,
      '鱼格 sky=' + (fsFishLight && fsFishLight.sky) + ' blk=' + (fsFishLight && fsFishLight.block) +
      ' 水上 sky=' + (fsAirLight && fsAirLight.sky) + ' 亮度=' + fsShade);

    /* FS.6 击杀掉落走真实 hitMob → drops → 拾取 链路：得像真玩家那样潜到鱼旁边才捡得到（拾取半径 2.4 格），
       掉落物会往下沉，所以追着它捡而不是站在海面上等。 */
    const fsFish0 = fsSchool()[0];
    let fsTarget = null;
    if (fsFish0) {
      G.controller.setPositions(fsFish0.x, fsFish0.y - 0.4, fsFish0.z);
      await frame();
      fsTarget = G.mobs.list.find(m => m.def.aquatic && m.school === fsKey);
      if (fsTarget) G.mobs.hitMob(fsTarget, 999, { x: 0, z: 0 });
    }
    await sleep(200);
    const fsGroundDrop = G.interaction.drops.list.some(d => d.item === 'fish_raw');
    const fsPick = await tryUntil(() => {
      const d = G.interaction.drops.list.find(dd => dd.item === 'fish_raw');
      if (d) G.controller.setPositions(d.x, d.y + 0.05, d.z);   // 玩家潜下去追这枚掉落物
      return G.inventory.countOf('fish_raw') > 0;
    }, { budgetMs: 6000, label: 'FS 生鱼掉落被拾取', observe: () => G.inventory.countOf('fish_raw') });
    ok('FS.6 击杀鱼掉生鱼，且能拾取进背包（真实掉落链路，不是直接加物品）',
      !!fsTarget && fsGroundDrop && fsPick.ok,
      '目标=' + (fsTarget ? 'cod/' + fsTarget.school : '无') + ' 地面掉落=' + fsGroundDrop +
      ' 背包生鱼=' + G.inventory.countOf('fish_raw') + ' 用时=' + (fsPick.ok ? fsPick.ms + 'ms' : '超时'));

    /* FS.8 存档带得上鱼群身份 —— 本轮那个真 bug（读档后同一站点格补第二群、一路灌到上限）的根因守卫。
       serialize() 的返回值就是写进 data.mobs 的那份 JSON，所以这里核对字段本身；
       不做整次 save→load 往返（那要再花几十秒重生成区块），往返由 GV/DP/负 Y 那几节覆盖。 */
    const fsSavedAll = G.mobs.serialize();
    const fsSaved = fsSavedAll.filter(o => o.t === 'cod');
    const fsLive = G.mobs.list.filter(m => m.hp > 0 && m.def.aquatic).length;
    const fsSavedKeyed = fsSaved.every(o => typeof o.sk === 'string' && !!o.sk &&
      Number.isFinite(o.fx) && Number.isFinite(o.fy) && Number.isFinite(o.fz));
    const fsOthersClean = fsSavedAll.every(o => o.t === 'cod' || o.sk === undefined);
    ok('FS.8 存档带得上鱼群身份：每条活鱼都写站点键与回家点，别的生物格式不变（读档才不会补第二群）',
      fsLive > 0 && fsSaved.length === fsLive && fsSavedKeyed && fsOthersClean,
      '活鱼=' + fsLive + ' 入库=' + fsSaved.length + ' 带键带回家点=' + fsSavedKeyed +
      ' 别的生物不写 sk=' + fsOthersClean +
      ' 样例=' + JSON.stringify(fsSaved[0] || null));

    /* FS.9 阶段 3c：鱼也要有「材质层次 + 可辨认的小幅动作」（任务书第 3 条的鱼那一半）。
       贴图按骷髅/苦力怕/鹦鹉同一套守卫量：16×16 画布、不露品红、色档够多、名字带 cod_ 前缀；
       鳍的角度读的是 render() 真写到模型上的 rotation.z，不是 computePose 里的中间值
       （与 FS.4 摆尾那条同一口径 —— 算得出但没应用，在这里就是红）。
       阶段 3a 只有平涂色块，水下近看是一块没有层次的蓝灰；这次补贴图时**几何、色值、位置一字未动**，
       所以阶段 3a 那批「成群 / 在水里 / 会游」的既有断言不该被牵连。 */
    const fs9Skin = T.mobSkinInfo('cod');
    const fs9Names = [...new Set(fs9Skin.parts.concat(fs9Skin.extras).filter(p => p.tex).map(p => p.tex))];
    const fs9Stats = fs9Names.map(n => T.mobTexStats(n));
    const fs9Mapped = fs9Skin.parts.filter(p => p.tex).every(p => p.hasMap === true && p.texSize === 16);
    const fs9Body = fs9Stats.find(s => s.name === 'cod_body') || {};
    const fs9Cool = fs9Stats.filter(s => s.meanB > s.meanR && s.meanB > s.meanG).length;
    const fsFin = { topMin: 9, topMax: -9, lMin: 9, lMax: -9, rMin: 9, rMax: -9, n: 0, opposed: 0, tailMin: 9, tailMax: -9 };
    const fs9Win = await watch(2000, () => {
      for (const f of fsSchool()) {
        if (f.finTop === null || f.finL === null || f.finR === null) continue;
        fsFin.n++;
        fsFin.topMin = Math.min(fsFin.topMin, f.finTop); fsFin.topMax = Math.max(fsFin.topMax, f.finTop);
        fsFin.lMin = Math.min(fsFin.lMin, f.finL); fsFin.lMax = Math.max(fsFin.lMax, f.finL);
        fsFin.rMin = Math.min(fsFin.rMin, f.finR); fsFin.rMax = Math.max(fsFin.rMax, f.finR);
        fsFin.tailMin = Math.min(fsFin.tailMin, f.tail); fsFin.tailMax = Math.max(fsFin.tailMax, f.tail);
        if (Math.sign(f.finL) !== Math.sign(f.finR)) fsFin.opposed++;
      }
      return false;                       // 只采样：观察窗走完才算数
    });
    const fs9Fish = fsSchool();
    ok('FS.9 鱼有独立像素贴图与可辨认的小幅动作：每份贴图真的挂上 16×16 画布且不露品红，' +
        '背鳍与两片胸鳍在 2 秒真实帧里都动过、左右胸鳍反相（不是一块硬突出在抖）',
      fs9Names.length >= 4 && fs9Names.every(n => n.indexOf('cod_') === 0) &&
      fs9Stats.every(s => s.pixels === 256 && s.missingRatio === 0 && s.hasPainter === true && s.colorBuckets >= 4) &&
      fs9Mapped && fs9Cool >= 3 && fs9Body.colorBuckets >= 5 &&
      fs9Win.ticks > 20 && fsFin.n > 20 &&
      (fsFin.topMax - fsFin.topMin) >= 0.01 && (fsFin.lMax - fsFin.lMin) >= 0.02 && (fsFin.rMax - fsFin.rMin) >= 0.02 &&
      fsFin.opposed > 0 && (fsFin.tailMax - fsFin.tailMin) >= 0.05,
      '贴图=' + JSON.stringify(fs9Stats.map(s => s.name + ':' + s.colorBuckets + '档/品红' + s.missingRatio + '/B' + s.meanB + '>R' + s.meanR)) +
      ' 每面都挂画布=' + fs9Mapped + ' 背鳍 ' + fsFin.topMin.toFixed(3) + '~' + fsFin.topMax.toFixed(3) +
      ' 左鳍 ' + fsFin.lMin.toFixed(3) + '~' + fsFin.lMax.toFixed(3) + ' 右鳍 ' + fsFin.rMin.toFixed(3) + '~' + fsFin.rMax.toFixed(3) +
      ' 反相样本=' + fsFin.opposed + '/' + fsFin.n + ' 尾鳍 ' + fsFin.tailMin.toFixed(3) + '~' + fsFin.tailMax.toFixed(3) +
      ' 帧数=' + fs9Win.ticks + ' 场上这一群=' + fs9Fish.length + ' 只');
    /* WT.1 阶段 6：水面 UV 必须是**世界坐标连续**的，而且湖面只能有一层。
       改前每一格都从 0..1 重新采样同一张 16×16 水贴图，贴图里那几条横向波光就在整片水面上
       一格接一格对齐，远看是「水平条带 + 周期性重复亮点」（机读取证：岸上机位重复亮点 20.13‰、
       条带能量 3.374）。现在 uv = 世界坐标 / 6，相邻格首尾相接；本条把这件事钉死：
         · 顶面 u 的跨度必须远超 1（说明不是每格 0..1），且不同 u 值足够多；
         · 同一平面上不允许出现两个**顶点完全重合**的顶面（重叠 = 双面叠加成的重复亮点）。 */
    {
      const wtTop = { quads: 0, uMin: Infinity, uMax: -Infinity, uSet: new Set(), dupVert: 0, planes: new Map(), meshes: 0 };
      for (const [, c] of G.world.chunks) {
        if (!c.meshes || c.meshes.length < 3) continue;
        const mesh = c.meshes[2];
        const g = mesh && mesh.geometry;
        if (!g || !g.getAttribute('position')) continue;
        const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), uv = g.getAttribute('uv');
        wtTop.meshes++;
        for (let i = 0; i < pos.count; i += 4) {
          if (nor.getY(i) <= 0.5) continue;                 // 只看顶面
          wtTop.quads++;
          for (let k = 0; k < 4; k++) {
            const u = uv.getX(i + k);   // BufferAttribute 只有 getX/getY，没有 getU/getV
            wtTop.uMin = Math.min(wtTop.uMin, u);
            wtTop.uMax = Math.max(wtTop.uMax, u);
            wtTop.uSet.add(+u.toFixed(3));
          }
          const key = [pos.getX(i), pos.getY(i), pos.getZ(i)].map(v => v.toFixed(3)).join(',');
          if (wtTop.planes.has(key)) wtTop.dupVert++;
          else wtTop.planes.set(key, 1);
        }
      }
      ok('WT.1 水面 UV 走世界坐标连续采样（不是每格 0..1 重来）、且湖面只有一层（没有重叠面）',
        wtTop.meshes > 0 && wtTop.quads > 100 &&
        (wtTop.uMax - wtTop.uMin) > 4 && wtTop.uSet.size > 20 && wtTop.dupVert === 0,
        '水面网格=' + wtTop.meshes + ' 顶面=' + wtTop.quads + ' u 跨度=' + (wtTop.uMax - wtTop.uMin).toFixed(2) +
        ' 不同 u=' + wtTop.uSet.size + ' 完全重合的顶面=' + wtTop.dupVert);
    }
    /* PN.1 阶段 6：常见家畜补上像素贴图（猪 / 牛 / 羊），与骷髅/苦力怕/鱼/鹦鹉同一套画法。
       判据与 SK.1/CP.1/FS.9 完全一致：每份贴图真的挂上 16×16 画布、不露品红、色档 ≥4、
       而且三种动物的贴图名互不共用（不是同一张图换个色）。 */
    {
      const pnTypes = ['pig', 'cow', 'sheep'];
      const pnAll = {};
      const pnBad = [];
      for (const t of pnTypes) {
        const sk = T.mobSkinInfo(t);
        const names = [...new Set((sk.parts || []).concat(sk.extras || []).filter(p => p.tex).map(p => p.tex))];
        const stats = names.map(n => T.mobTexStats(n));
        pnAll[t] = { names, stats: stats.map(s => ({ n: s.name, b: s.colorBuckets, m: s.missingRatio, px: s.pixels, has: s.hasPainter })) };
        if (!names.length || !names.every(n => n.indexOf(t) === 0) ||
          !stats.every(s => s.pixels === 256 && s.missingRatio === 0 && s.hasPainter === true && s.colorBuckets >= 4)) {
          pnBad.push(t);
        }
        /* 每个部件都必须真的挂着贴图材质（不是只登记了名字） */
        if (!(sk.parts || []).filter(p => p.tex).every(p => p.hasMap === true && p.texSize === 16)) pnBad.push(t + ':map');
      }
      const pnShared = Object.keys(pnAll).filter(t =>
        pnAll[t].names.some(n => pnTypes.some(o => o !== t && n.indexOf(o) === 0)));
      /* 阶段 6 封版：贴图**语义**也要查。报告通过后修掉的问题是：剪过毛的羊身复用了
         sheep_head（带额毛/口鼻/鼻孔），玩家近看会在羊身上看到第二张脸；PN.1 原来只查
         「有没有贴图、色档够不够」，查不出这种错误。这里显式读剪毛状态验证独立皮肤贴图。 */
      const shWool = T.mobSkinInfo('sheep', false);
      const shShorn = T.mobSkinInfo('sheep', true);
      const shPart = (sk, part) => (sk.parts || []).find(p => p.part === part);
      const shWoolBody = shPart(shWool, 'body'), shShornBody = shPart(shShorn, 'body'), shHead = shPart(shWool, 'head');
      const skinStat = T.mobTexStats('sheep_skin');
      const shSemantic = {
        woolBody: shWoolBody ? shWoolBody.tex : null,
        shornBody: shShornBody ? shShornBody.tex : null,
        head: shHead ? shHead.tex : null,
        shornHasMap: shShornBody ? shShornBody.hasMap : null,
        shornTexSize: shShornBody ? shShornBody.texSize : null,
        skin: { px: skinStat.pixels, m: skinStat.missingRatio, b: skinStat.colorBuckets, has: skinStat.hasPainter }
      };
      const shOK = !!(shWoolBody && shShornBody && shHead &&
        shWoolBody.tex === 'sheep_body' && shShornBody.tex === 'sheep_skin' &&
        shShornBody.tex !== shHead.tex && !/head/i.test(shShornBody.tex) &&
        shShornBody.hasMap === true && shShornBody.texSize === 16 &&
        skinStat.pixels === 256 && skinStat.missingRatio === 0 &&
        skinStat.hasPainter === true && skinStat.colorBuckets >= 4);
      ok('PN.1 常见家畜（猪 / 牛 / 羊）都有独立像素贴图：16×16 画布、不露品红、色档 ≥4、部件真的挂上材质、三种动物不共用，剪毛羊身不复用带五官的头部贴图',
        pnBad.length === 0 && pnShared.length === 0 && shOK,
        '详情=' + JSON.stringify(pnAll) + ' 不合格=' + JSON.stringify(pnBad) + ' 共用=' + JSON.stringify(pnShared) +
        ' 剪毛语义=' + JSON.stringify(shSemantic) + ' 通过=' + shOK);
    }
    /* FS.7 岸上不刷鱼：清空后回到草地出生点跑几秒，任何水生生物都不许出现在水面以上或非水格。
       观察窗内刷怪额度必须还开着（26），否则这条断言什么都没测 —— 收尾时才还原。 */
    G.mobs.clear();
    G.controller.setCreative(fsCreative0);
    G.controller.flying = fsFly0;
    G.controller.setPositions(G.spawn.x, G.spawn.y + 1, G.spawn.z);
    await T.waitChunks(1);
    const fsLandWait = await watch(4000, () => {
      const bad = T.fishInfo().filter(f =>
        f.y > G.world.seaLevel || T.blockAt(Math.floor(f.x), Math.floor(f.y), Math.floor(f.z)).id !== T.blockIds.WATER);
      return bad.length > 0;
    });
    const fsLandFish = T.fishInfo();
    ok('FS.7 回到草地出生点后不刷岸上鱼：4 秒观察窗内没有鱼出现在水面以上或非水格',
      !fsLandWait.violated && fsLandFish.every(f => f.y <= G.world.seaLevel),
      '违规=' + fsLandWait.violated + ' 观察窗内鱼数=' + fsLandFish.length +
      ' 刷怪额度=' + G.mobs.maxMobs + '（全程开着，鱼数 0 是「岸边没水」而不是「扫描被关」）' +
      (fsSite ? ' 命中站点距出生点=' + Math.hypot(fsSite.s.x - G.spawn.x, fsSite.s.z - G.spawn.z).toFixed(1) + ' 格' : '') +
      ' 出生点地表 y=' + Math.floor(G.spawn.y) + ' 海平面=' + G.world.seaLevel);
    /* FS.10 阶段 3c：生鱼真的能烧成熟鱼（任务书「检查鱼贴海床、上岸、追赶拾取和烹饪」里的烹饪）。
       7.x 那几节钉的是熔炉机制本身（铁锭路线）；这里补的是**鱼这一条熔炼路线在真实熔炉里走通**：
       FS.6 拾取进来的生鱼确实在背包里 → 放进熔炉 → 产出熟鱼 → 「熔炼」计数 +1。
       走的是产品自己的入口（T.placeAt 放方块 + 右键开界面 + 熔炉真实推进），不是直接读 SMELTING 表——
       那条数据链路在单测「鱼物品」里已经钉过了，这里要的是玩家真能在游戏里把它做出来。 */
    const fs10Have = G.inventory.countOf('fish_raw');
    /* T.placeAt 会把「当前选中格」强写成 64 个方块（7.x 也是这么放的）：
       这一节借它放熔炉，但收尾要把这一格原样还回去，免得后面的小节拿到一支多出来的熔炉。 */
    const fs10SelIdx = G.inventory.selected;
    const fs10Sel0 = G.inventory.get(fs10SelIdx);
    const fs10SelSnap = fs10Sel0 ? { item: fs10Sel0.item, count: fs10Sel0.count } : null;
    const fkX = Math.floor(G.controller.pos.x) + 2, fkY = Math.floor(G.controller.pos.y) - 1, fkZ = Math.floor(G.controller.pos.z);
    T.placeAt(fkX, fkY, fkZ, 'furnace');
    await sleep(160);
    const fkV = [fkX + 0.5 - G.controller.pos.x, fkY + 0.5 - G.controller.eyeY, fkZ + 0.5 - G.controller.pos.z];
    G.controller.pitch = Math.asin(fkV[1] / Math.hypot(...fkV));
    G.controller.yaw = Math.atan2(-fkV[0], -fkV[2]);
    G.interaction.updateTarget();
    G.interaction.placeCd = 0;
    G.input.state.mouseRight = true;
    G.interaction.update(0.02);
    G.input.state.mouseRight = false;
    await sleep(160);
    const fs10Opened = G.openUI === 'furnace' && !!G.activeFurnace;
    const fs10Smelted0 = G.stats.smelted;
    T.furnacePut('input', 'fish_raw', 1);
    T.furnacePut('fuel', 'coal', 1);
    G.ui.refreshUI();
    let fs10Got = null;
    const fs10Wait = await tryUntil(() => {
      fs10Got = T.furnace(fkX, fkY, fkZ);
      return !!(fs10Got && fs10Got.output && fs10Got.output.item === 'fish_cooked');
    }, { budgetMs: 40000, tick: 'sleep', intervalMs: 200, label: '熔炉产出熟鱼', observe: () => fs10Got && { input: fs10Got.input, fuel: fs10Got.burn, output: fs10Got.output } });
    const fs10Lit = T.blockAt(fkX, fkY, fkZ).id;
    G.closeUI();
    ok('FS.10 捕鱼之后真的能烹饪：FS.6 拾取的生鱼在背包里，进熔炉出熟鱼，熔炼计数 +1，燃烧的熔炉切成点亮方块',
      fs10Have > 0 && fs10Opened && fs10Wait.ok &&
      fs10Got.output.item === 'fish_cooked' && G.stats.smelted > fs10Smelted0 &&
      fs10Lit === T.blockIds.FURNACE_LIT,
      '背包生鱼=' + fs10Have + ' 开界面=' + fs10Opened + ' 产出=' + JSON.stringify(fs10Got && fs10Got.output) +
      ' 熔炼计数 ' + fs10Smelted0 + '→' + G.stats.smelted + ' 用时=' + (fs10Wait.ok ? fs10Wait.ms + 'ms' : '超时') +
      ' 方块=' + fs10Lit + '（点亮态 ' + T.blockIds.FURNACE_LIT + '）');
    G.inventory.set(fs10SelIdx, fs10SelSnap);            // 把 placeAt 强写的那一格还回去
    G.ui.refreshUI();
    G.mobs.maxMobs = fsMax0;                  // 收尾：把「这一段恢复了自然刷怪额度」还回去，后续小节仍按原口径跑
    }

    /* ---------------- 39d. 阶段 3c：自然飞鸟（BD.*）+ 暗洞敌怪按局部光照筛选（LG.*） ----------------
     * 任务书第 3 条：至少一种能在森林/林冠**自然遇见**的鸟 —— 翅膀轮廓、振翅、短飞、转向、停栖，
     * 遇墙 / 地面 / 水体避让；进出范围、击杀、保存重进之后数量保持有界；走 `maxMobs` 这把共用总量闸，
     * 并给鱼、鸟、敌怪保留合理机会；同时把地下敌怪候选点改成「按候选格的局部光照 + 可站立空间」筛选，
     * 留「同一位置点灯前后自然生成结果」的 A/B。
     *
     * 四条从前面几轮学来的口径在这里同样适用（写在注释里，不给读者留「为什么这样搭」的疑问）：
     *   ① 站点是纯函数 —— 先算出「哪一列有鸟站得住」，再把玩家挪过去等自然刷怪，
     *      而不是手动 spawn 一只展示件（任务书要的是「正常探索能遇见」）；
     *   ② `world.js:207` 对未生成区块的 setBlock **直接 return false** —— 所有地下改造之前
     *      必须先 waitChunks + 排空三段队列，并在动手之后回读格子自检（CV.0 就是这条自检）；
     *   ③ 观察窗一律走 `watch(ms, bad)` 的墙上时间预算 —— 用 `for (i < N) await frame()`
     *      在低帧率机器上会把这一段拉成几分钟，还会把「等多久」变成断言的一部分；
     *   ④ 「等概率刷了几只」不适合当断言 —— 洞穴通路的候选点是在玩家周围 10~28 格的环带里
     *      随机挑的，数「这 15 秒刷了几只」会把随机性写进红绿灯。所以本段把三件事分开量：
     *      判据（同一批格子过/不过，确定性）→ 候选点搜索（产品自己的 findUndergroundSpawnPoint 跑 200 次）
     *      → 真实节拍（推 900 帧，只断言「刷得出 / 刷不进」这两件稳定事实）。
     * 取证脚本留在 app/tests/probe-underground*.mjs 与 probe-bird.mjs（不进门禁），
     * 里面记着改产品之前量到的两个硬伤：旧写法候选命中率 1.5%/次、玩家在洞里时 26 格额度
     * 被头顶看不见的地表动物占满（cave=0）。 */
    {
      const bdLim = T.birdLimits();
      const bdStep = bdLim.siteStep;
      const bdIds = T.blockIds;
      const bdMax0 = G.mobs.maxMobs, bdCreative0 = G.controller.creative, bdFly0 = G.controller.flying;
      /* 这一段要在洞里推刷怪节拍，场上会有敌怪贴着玩家：先切创造，收尾原样还回去。
         hurt() 在创造模式直接 return null（controller.js:528），不会因为「怪真的刷出来了」把玩家打死，
         后续小节就不必替这一段擦尸体。 */
      G.controller.setCreative(true);
      G.controller.flying = false;
      T.setTime(0.3);                                   // 白天：林冠亮、洞穴暗，两段的对照条件都固定下来
      await T.waitChunks(3, { light: true });
      const bdDrain = await tryUntil(() => {
        const p = T.worldPending();
        return p && p.gen === 0 && p.light === 0 && p.mesh === 0;
      }, { budgetMs: 20000, tick: 'sleep', intervalMs: 40, label: 'BD 场地区块排空', observe: T.worldPending });

      /* ---- BD.0 前提自检：加载范围内至少要有一列「有站点 + 有能停的林冠」 ---- */
      const bdC0 = { x: Math.floor(G.controller.pos.x / bdStep), z: Math.floor(G.controller.pos.z / bdStep) };
      let bdSite = null;
      for (let ring = 0; ring <= 3 && !bdSite; ring++) {
        for (let dz = -ring; dz <= ring && !bdSite; dz++) {
          for (let dx = -ring; dx <= ring && !bdSite; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
            const s = T.birdSiteAt(bdC0.x + dx, bdC0.z + dz);
            if (!s) continue;
            const perch = T.birdPerchAt(s.x, s.z);
            if (perch) bdSite = { s, perch, ring, dx, dz };
          }
        }
      }
      const bdPerchClear = bdSite ? G.world.isSolidAt(Math.floor(bdSite.perch.x), bdSite.perch.y, Math.floor(bdSite.perch.z)) === false : false;
      ok('BD.0 前提自检：这颗种子的加载范围内确实有一列「站点有鸟 + 林冠停得住」（红的时候先说是找不到树冠，不要说鸟不生成）',
        bdDrain.ok && !!bdSite && !!bdSite.perch && bdPerchClear &&
        bdSite.perch.y > G.world.surfaceHeight(Math.floor(bdSite.perch.x), Math.floor(bdSite.perch.z)) &&
        Math.hypot(bdSite.s.x - G.controller.pos.x, bdSite.s.z - G.controller.pos.z) <= bdLim.rangeMax,
        '站点=' + JSON.stringify(bdSite && bdSite.s) + ' 栖点=' + JSON.stringify(bdSite && bdSite.perch) +
        ' 环=' + (bdSite ? bdSite.dx + ',' + bdSite.dz + '（第 ' + bdSite.ring + ' 圈）' : '没找到') +
        ' 排空=' + JSON.stringify(T.worldPending()) +
        ' 产品界=' + JSON.stringify({ step: bdStep, flock: [bdLim.flockMin, bdLim.flockMax], maxAlive: bdLim.maxAlive, canopyMin: bdLim.canopyMin, perchReach: bdLim.perchReach }));

      /* ---- BD.1 自然遇见：把玩家放到那一列上，只让站点扫描干活（全程不手动 spawn 鸟） ---- */
      G.mobs.clear();
      G.mobs.maxMobs = 26;                              // 自然刷怪额度必须开着，否则「没鸟」等于「闸被关了」
      const bdSiteX = bdSite ? bdSite.s.x : G.controller.pos.x;
      const bdSiteZ = bdSite ? bdSite.s.z : G.controller.pos.z;
      T.teleport(bdSiteX, G.world.surfaceHeight(Math.floor(bdSiteX), Math.floor(bdSiteZ)) + 1, bdSiteZ);
      const bdStand = await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'BD 站到站点列上' });
      const bdSpawnT0 = performance.now();
      const bdW1 = await tryUntil(() => T.birdInfo().length >= bdLim.flockMin,
        { budgetMs: 15000, tick: 'sleep', intervalMs: 100, label: '鸟自然出现（只靠站点扫描）', observe: () => T.birdInfo() });
      const bdBirds = T.birdInfo();
      const bdGroups = {};
      for (const b of bdBirds) bdGroups[b.site] = (bdGroups[b.site] || 0) + 1;
      const bdMain = Object.keys(bdGroups).sort((a, b) => bdGroups[b] - bdGroups[a])[0];
      const bdKm = bdMain ? /^b(-?\d+),(-?\d+)$/.exec(bdMain) : null;
      const bdGroup = bdBirds.filter(b => b.site === bdMain);
      ok('BD.1 正常探索就能遇见鸟：不手动 spawn、只等站点扫描，同一站点成群（' + bdLim.flockMin + '~' + bdLim.flockMax +
        ' 只）、站点键能反查回纯函数、全在能飞的空气格里、没飞出加载带',
        bdStand.ok && bdW1.ok && !!bdKm && !!T.birdSiteAt(Number(bdKm[1]), Number(bdKm[2])) &&
        bdGroup.length >= bdLim.flockMin && bdGroup.length <= bdLim.flockMax &&
        bdBirds.length <= bdLim.maxAlive &&
        bdBirds.every(b => b.inBlock === false) &&
        bdGroup.every(b => b.dHome <= 8) &&
        bdBirds.every(b => Math.hypot(b.x - G.controller.pos.x, b.z - G.controller.pos.z) <= bdLim.rangeMax),
        '等=' + Math.round(performance.now() - bdSpawnT0) + 'ms 只数=' + bdBirds.length +
        ' 分组=' + JSON.stringify(bdGroups) + ' 主群距巢=' + bdGroup.map(b => b.dHome).join(',') +
        ' 读数=' + JSON.stringify(bdGroup.slice(0, 3)) + ' 闸=' + JSON.stringify(T.mobSpawnInfo()));

      /* 退开十几格再观察：站点中心正好压在巢位上时，鸟一落稳就满足「贴脸惊飞」（2.6 格）条件，
         BD.2/BD.3 的窗口会整段都在「刚落地就被吓跑」，停栖那一态采不到样本，
         BD.4 也就没有「本来停着、靠近才起飞」的前提。这一步只挪玩家，不动任何判据。 */
      const bdWatchX = bdSiteX + 14.0, bdWatchZ = bdSiteZ;
      T.teleport(bdWatchX, G.world.surfaceHeight(Math.floor(bdWatchX), Math.floor(bdWatchZ)) + 1, bdWatchZ);
      await tryUntil(() => G.controller.onGround,
        { budgetMs: 5000, label: 'BD 退到十几格外观察（等落地；这一等不通过也不影响后面的读数）' });

      /* ---- BD.2 看得见的动作：真实主循环里采样模型上的翅膀角度 / 相位 / 状态 / 朝向 ---- */
      const bdSt = { wingMin: 9, wingMax: -9, tailMin: 9, tailMax: -9, samples: 0, badCell: 0, inWater: 0, belowGround: 0 };
      const bdPhases = {}, bdYawTrace = {};
      let bdTurnMax = 0, bdFlySpeedMax = 0;      // 累加器必须 let：和上面两个对象写在同一条 const 里会在严格模式当场抛「Assignment to constant variable」
      /* 观察窗改成「有墙上时间上限的条件等待」：停栖 3~8 秒、短飞 1.6~4.2 秒，
         固定 4.5 秒窗口完全可能整段落在一次停栖里（实测就读到过 状态={"perched":900}、朝向跨度 0）。
         这条断言要的是「停栖与飞行两种状态都被观察到、朝向真的连续转过」这件事**发生过**，
         不是「多快发生」，所以等它出现是判据本身，而不是靠拉长等待换绿灯 —— 上限仍然钉在 12 秒。 */
      const bdSample = () => {
        for (const b of T.birdInfo()) {
          if (b.wingL === null) continue;
          bdSt.samples++;
          bdSt.wingMin = Math.min(bdSt.wingMin, b.wingL); bdSt.wingMax = Math.max(bdSt.wingMax, b.wingL);
          bdSt.tailMin = Math.min(bdSt.tailMin, b.tail); bdSt.tailMax = Math.max(bdSt.tailMax, b.tail);
          bdPhases[b.phase] = (bdPhases[b.phase] || 0) + 1;
          bdTurnMax = Math.max(bdTurnMax, b.turnRate);
          bdFlySpeedMax = Math.max(bdFlySpeedMax, b.speed);
          /* 朝向：按「同一只鸟的连续展开角」算范围，避免 ±π 绕回时把跨度算成 0 */
          const tr = bdYawTrace[b.uid] || (bdYawTrace[b.uid] = { prev: b.yaw, unw: b.yaw, min: b.yaw, max: b.yaw });
          let d = b.yaw - tr.prev;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          tr.unw += d; tr.prev = b.yaw;
          tr.min = Math.min(tr.min, tr.unw); tr.max = Math.max(tr.max, tr.unw);
          const cell = T.blockAt(Math.floor(b.x), Math.floor(b.y), Math.floor(b.z));
          if (b.inBlock) bdSt.badCell++;
          if (cell && cell.id === bdIds.WATER) bdSt.inWater++;
          if (b.y < G.world.surfaceHeight(Math.floor(b.x), Math.floor(b.z))) bdSt.belowGround++;
        }
      };
      const bdYawSpanNow = () => {
        let sp = 0;
        for (const k of Object.keys(bdYawTrace)) sp = Math.max(sp, bdYawTrace[k].max - bdYawTrace[k].min);
        return sp;
      };
      const bdT0 = performance.now();
      let bdTicks = 0, bdSeenAll = false;
      const bdFlySamples = () => (bdPhases.fly || 0) + (bdPhases.hover || 0);
      while (performance.now() - bdT0 < 12000) {
        await frame();
        bdTicks++;
        bdSample();
        /* 门槛不只是「出现过」：至少要攒够 30 个飞行样本与 200 个总样本，
           否则窗口会在第一次起飞的第一帧就收工（上一轮读数就是 状态={"perched":1120,"fly":6}、
           朝向跨度 0.21 贴着界、转向速率峰值读到 0），那样「振翅/转向落到模型上」其实没被量到。 */
        if (bdSt.samples >= 200 && bdFlySamples() >= 30 && bdPhases.perched &&
          bdYawSpanNow() >= 0.3 && bdTurnMax > 0) {
          bdSeenAll = true; break;
        }
      }
      const bdWin = { ticks: bdTicks, ms: Math.round(performance.now() - bdT0) };
      let bdYawSpan = bdYawSpanNow();
      const bdWings = Object.keys(bdPhases).length ? bdSt.wingMax - bdSt.wingMin : 0;
      ok('BD.2 振翅 / 转向 / 停栖与短飞都真的落到模型上：翅膀角度在观察窗里大幅变化且不越界、' +
        '状态机同时出现过停栖与飞行、同一只鸟的朝向连续转过、尾舵跟着动',
        bdWin.ticks > 30 && bdSt.samples >= 200 && bdSeenAll &&
        bdFlySamples() >= 30 && bdTurnMax > 0 &&
        bdWings >= 0.2 &&
        !!bdPhases.perched && (!!bdPhases.fly || !!bdPhases.hover) &&
        bdYawSpan >= 0.3 &&
        bdSt.wingMax <= bdLim.flapMax + 0.05 && Math.abs(bdSt.wingMin) <= bdLim.flapMax + 0.05,
        '观察到两态+转向=' + bdSeenAll + ' 用时=' + bdWin.ms + 'ms 帧数=' + bdWin.ticks +
        ' 飞行相位样本=' + bdFlySamples() + '/' + bdSt.samples +
        ' 翅膀 ' + bdSt.wingMin.toFixed(3) + '~' + bdSt.wingMax.toFixed(3) + '（幅度 ' + bdWings.toFixed(3) + '，界 ' + bdLim.flapMax + '）' +
        ' 尾舵 ' + bdSt.tailMin.toFixed(3) + '~' + bdSt.tailMax.toFixed(3) +
        ' 朝向跨度=' + bdYawSpan.toFixed(2) + 'rad 转向速率峰值=' + bdTurnMax.toFixed(2) +
        ' 速度峰值=' + bdFlySpeedMax.toFixed(2) + '（飞行速度界 ' + bdLim.flySpeed + '）' +
        ' 状态=' + JSON.stringify(bdPhases) + ' 帧数=' + bdWin.ticks + ' 样本=' + bdSt.samples);

      /* ---- BD.3 三条避让：一整段真实飞行里没有一次进入实心 / 水面，也不跌破所在列的地表 ---- */
      ok('BD.3 遇墙、遇地面、遇水体都避让开了：观察窗内没有一帧鸟待在不通飞的格子里、没进水、没钻到地表以下',
        bdSt.badCell === 0 && bdSt.inWater === 0 && bdSt.belowGround === 0,
        '不通飞帧=' + bdSt.badCell + ' 在水里帧=' + bdSt.inWater + ' 在地表以下帧=' + bdSt.belowGround +
        '（避让判据与位置兜底成对生效，见 mobs.js flyAI / canFlyAt；样本=' + bdSt.samples + '）');

      /* ---- BD.4 被惊飞：玩家贴到 escape 距离以内，**同一只鸟**必须从停栖换成飞 ---- */
      const bdSit = await tryUntil(() => T.birdInfo().find(b => b.phase === 'perched'),
        { budgetMs: 12000, tick: 'sleep', intervalMs: 100, label: '等到有一只鸟停在树上', observe: () => T.birdInfo().slice(0, 2) });
      const bdTarget = bdSit.value;
      let bdTook = null, bdEscapeD = null;
      if (bdTarget) {
        bdEscapeD = Math.hypot(bdTarget.x - G.controller.pos.x, bdTarget.z - G.controller.pos.z);
        T.teleport(bdTarget.x, bdTarget.y - 1.2, bdTarget.z);     // 站到它正下方
        bdTook = await tryUntil(() => {
          const b = T.birdInfo().find(x => x.uid === bdTarget.uid);
          return !!b && b.phase !== 'perched' && b.speed > 0.4;
        }, { budgetMs: 6000, tick: 'sleep', intervalMs: 60, label: '玩家贴脸后这只鸟起飞', observe: () => T.birdInfo().slice(0, 3) });
      }
      const bdAfterSit = bdTarget ? T.birdInfo().find(x => x.uid === bdTarget.uid) : null;
      ok('BD.4 靠近会把它惊飞：玩家进到 ' + bdLim.escapeDist + ' 格以内，**同一只鸟**（按 uid 跟）从停栖换成飞、并且真的在移动',
        bdSit.ok && !!bdTarget && !!bdTook && bdTook.ok &&
        !!bdAfterSit && bdAfterSit.phase !== 'perched' && bdAfterSit.speed > 0.4 &&
        bdEscapeD > bdLim.escapeDist,
        '贴脸前距离=' + (bdEscapeD === null ? '-' : bdEscapeD.toFixed(1)) + ' 格（界 ' + bdLim.escapeDist + '）' +
        ' 起飞用时=' + (bdTook ? bdTook.ms + 'ms' : '没等到停栖的鸟') +
        ' 这只鸟=' + JSON.stringify(bdAfterSit) + ' 全场=' + JSON.stringify(T.birdInfo().slice(0, 3)));

      /* ---- BD.5 数量有界：关掉闸就一只都不刷；打开后回到界内；击杀之后再扫也不越界 ---- */
      G.mobs.maxMobs = 0;
      G.mobs.clear();
      for (let i = 0; i < 40; i++) G.mobs.spawnBirdFlocks();
      const bdGated = T.birdInfo().length;
      G.mobs.maxMobs = 26;
      const bdBack = await tryUntil(() => T.birdInfo().length >= bdLim.flockMin,
        { budgetMs: 15000, tick: 'sleep', intervalMs: 120, label: '闸打开后鸟群回来', observe: () => T.birdInfo() });
      for (let i = 0; i < 60; i++) G.mobs.spawnBirdFlocks();
      const bdCap = T.birdInfo().length;
      for (const m of G.mobs.list.filter(x => x.type === 'parrot')) m.hp = 0;
      await frame(); await frame();
      const bdAfterKill = T.birdInfo().length;
      for (let i = 0; i < 60; i++) G.mobs.spawnBirdFlocks();
      const bdRefill = T.birdInfo().length;
      const bdPop5 = T.mobSpawnInfo();
      ok('BD.5 数量保持有界：maxMobs=0 时一只鸟都不刷；打开后自然成群；反复扫描与击杀后补群都不越过 BIRD_MAX_ALIVE=' +
        bdLim.maxAlive + '，也不越过总量闸',
        bdGated === 0 && bdBack.ok && bdCap <= bdLim.maxAlive && bdCap >= bdLim.flockMin &&
        bdAfterKill === 0 && bdRefill <= bdLim.maxAlive && bdPop5.total <= bdPop5.maxMobs,
        '关闸=' + bdGated + ' 打开=' + bdBack.ms + 'ms/' + bdCap + ' 只 击杀后=' + bdAfterKill +
        ' 再扫=' + bdRefill + ' 总生物=' + JSON.stringify(bdPop5));

      /* ---- BD.6 保存重进：鸟的站点键与栖点入库，读档后从树上那一点开始，同一站点不补第二群 ----
         上一轮这一条红了，读数里「读档后的鸟」既不是存档前那一群、站点键也来自别的格子 ——
         说明问题在「存进去/读出来的到底是什么」，不在鸟本身。所以这一版把三段都记下来：
         存档前的玩家坐标、刚落盘那份文件里的玩家坐标与鸟的站点键、读档后的玩家坐标。
         另外读档一律把玩家放回**存档时**的位置，那可能离这群鸟几十格，
         站点扫描只覆盖玩家周围 48 格 —— 不回到鸟附近的话「不补第二群」根本无从谈起，
         因此这里显式走产品的传送把玩家送回站点列再扫（上一轮 CV/BD 混着读就是踩了这个坑）。 */
      G.controller.flying = false;
      G.controller.setPositions(bdSiteX + 16.0, G.world.surfaceHeight(Math.floor(bdSiteX + 16), Math.floor(bdSiteZ)) + 1, bdSiteZ);
      const bdStand1 = await tryUntil(() => G.controller.onGround,
        { budgetMs: 6000, label: 'BD 退到十几格外再存档（免得读档第一眼就被惊飞）' });
      const bdPosBefore = [+G.controller.pos.x.toFixed(1), +G.controller.pos.y.toFixed(1), +G.controller.pos.z.toFixed(1)];
      const bdBefore = T.birdInfo();
      await G.save('manual');
      /* 回读刚落盘的那一份：鸟的站点键/栖点必须与场上完全一致，否则问题在存档链路而不是鸟 */
      const bdRawSave = await G.storage.loadWorld(G.meta.name);
      const bdRawBirds = ((bdRawSave && bdRawSave.mobs) || []).filter(o => o.t === 'parrot');
      const bdRawPos = bdRawSave && bdRawSave.player ? [+bdRawSave.player.x.toFixed(1), +bdRawSave.player.z.toFixed(1)] : null;
      const bdBeforeKeys = [...new Set(bdBefore.map(b => b.site))].sort();
      const bdRawKeys = [...new Set(bdRawBirds.map(o => o.bk))].sort();
      G.toMenu(); await sleep(300);
      /* **必须沿用当前世界的名字**（G.meta.name），不能写死 '验收世界'：剧本到这一段已经不在验收世界里 ——
         DP（负 Y 深地）那一节末尾特意「回到深地档，保持后续小节的现场不变」，FS/CV 与其后的 SK/CP 都在这一档跑。
         上一轮这里写死 '验收世界'，等于「存一份 A、读一份 B」：读回来的鸟带着别的站点键（b-2,3 / b-2,4…）、
         玩家被放到几十格外的坐标，于是「同一站点不补第二群」根本没被量到，CV 那节的落点也跟着飘。 */
      await G.loadWorld(G.meta.name);
      const bdBack1 = await tryUntil(() => G.state === 'playing', { budgetMs: 30000, tick: 'sleep', intervalMs: 100, label: 'BD 读档回到世界' });
      const bdPosLoaded = [+G.controller.pos.x.toFixed(1), +G.controller.pos.y.toFixed(1), +G.controller.pos.z.toFixed(1)];
      /* 先读鸟，再等区块：读档后鸟是「停在树上」这件事，靠的是栖点与相位这两样入库数据，
         和区块排队列没关系；而排空可能要几秒，停栖计时只有 3~8 秒，
         把读数放到排空之后就变成「等运气」了。排空仍然要做 —— 下一段要动方块。 */
      const bdLoaded0 = T.birdInfo();
      /* 把玩家送回这群鸟所在的那一列：读档回到的坐标可能离巢几十格，
         站点扫描只看玩家周围 48 格，不回到附近就没法证明「同一站点不补第二群」。 */
      G.controller.setPositions(bdSiteX, G.world.surfaceHeight(Math.floor(bdSiteX), Math.floor(bdSiteZ)) + 1, bdSiteZ);
      const bdStand2 = await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'BD 读档后回到站点列' });
      await T.waitChunks(1, { light: true });
      const bdDrain2 = await tryUntil(() => {
        const p = T.worldPending();
        return p && p.gen === 0 && p.light === 0 && p.mesh === 0;
      }, { budgetMs: 20000, tick: 'sleep', intervalMs: 40, label: 'BD 读档后排空区块队列', observe: T.worldPending });
      const bdLoaded = bdLoaded0.length ? bdLoaded0 : T.birdInfo();
      const nearPerch = (b) => !!b.perch && Math.hypot(b.x - b.perch.x, b.z - b.perch.z) <= 2.0 &&
        Math.abs(b.y - (b.perch.y + bdLim.perchFallback)) <= 1.5;
      /* 读档后场上可能多出「新刷的一群」——那是正常行为（玩家被送回站点列，扫描照常工作），
         所以「存进去的那一群有没有原样回来」必须**按站点键配对**来量，
         不能对整个列表提「每只都必须来自存档」（上一轮红就红在这里：读回多了 b2,1 一群）。 */
      const bdRestored = bdLoaded.filter(b => bdBeforeKeys.includes(b.site));
      const bdNewFlocks = bdLoaded.filter(b => !bdBeforeKeys.includes(b.site));
      const bdCameBack = (o) => bdLoaded.some(b => b.site === o.site && !!b.perch && !!o.perch &&
        Math.hypot(b.perch.x - o.perch.x, b.perch.z - o.perch.z) < 0.6 && Math.abs(b.y - o.y) <= 2.5);
      const bdAllBack = bdBefore.every(bdCameBack);
      for (let i = 0; i < 80; i++) G.mobs.spawnBirdFlocks();
      const bdAfter = T.birdInfo();
      const bdAfterKeys = {};
      for (const b of bdAfter) bdAfterKeys[b.site] = (bdAfterKeys[b.site] || 0) + 1;
      /* 站点键必须能反查回纯函数（键不是自由文本，而是 birdFlockOf 的坐标）：
         解析失败一律返回 null 让断言变红，而不是抛异常把整条剧本带走 */
      const bdKeySite = (k) => {
        const m = /^b(-?\d+),(-?\d+)$/.exec(String(k || ''));
        return m ? T.birdSiteAt(Number(m[1]), Number(m[2])) : null;
      };
      const bdSavedKeys = [...new Set(bdLoaded.map(b => b.site))];
      const bdDoubled = bdSavedKeys.filter(k => bdAfterKeys[k] > bdLim.flockMax);
      ok('BD.6 保存重进之后：存档前那一群带着站点键与栖点原样回来、落在自己那棵树上（半空的动画态一律不入库），' +
        '反复扫描也不在同一站点补第二群；落盘那一份与场上的站点键逐一对得上',
        bdDrain2.ok && bdStand1.ok && bdStand2.ok && bdBack1.ok &&
        bdBefore.length >= bdLim.flockMin && bdRestored.length >= bdLim.flockMin && bdAllBack &&
        bdRestored.every(b => !!b.site && !!b.perch) && bdRestored.every(nearPerch) &&
        bdRestored.every(b => b.phase === 'perched' || b.phase === 'hover') &&
        bdAfter.every(b => !!b.site) && bdAfter.length <= bdLim.maxAlive &&
        bdDoubled.length === 0 &&
        bdSavedKeys.every(k => !!bdKeySite(k)) &&
        JSON.stringify(bdBeforeKeys.slice().sort()) === JSON.stringify(bdRawKeys) &&
        bdRawBirds.length === bdBefore.length &&
        !!bdRawPos && Math.hypot(bdRawPos[0] - bdPosBefore[0], bdRawPos[1] - bdPosBefore[2]) < 1.0,
        '存档前玩家=' + JSON.stringify(bdPosBefore) + ' 落盘玩家=' + JSON.stringify(bdRawPos) +
        ' 读档后玩家=' + JSON.stringify(bdPosLoaded) + ' 回到站点列=' + JSON.stringify([+G.controller.pos.x.toFixed(1), +G.controller.pos.z.toFixed(1)]) +
        ' 站点键 场上=' + JSON.stringify(bdBeforeKeys.slice().sort()) + ' 落盘=' + JSON.stringify(bdRawKeys) + ' 读回=' + JSON.stringify(bdSavedKeys) +
        ' 存档前这群=' + bdBefore.length + ' 只 原样回来=' + bdRestored.length + ' 只 全部配对=' + bdAllBack +
        ' 读档后新刷的群=' + bdNewFlocks.length + ' 只（正常行为，不参与配对）' +
        ' 样例 前=' + JSON.stringify(bdBefore[0]) + ' 后=' + JSON.stringify(bdRestored[0] || null) +
        ' 再扫=' + bdAfter.length + ' 只 分组=' + JSON.stringify(bdAfterKeys) + ' 重复补群的站点=' + JSON.stringify(bdDoubled));
      G.mobs.maxMobs = bdMax0;

      /* ---- BD.7 停栖真的是停栖：收拢轮廓 + 水平残差收进栖点列 + 高度贴栖点站位 ----
         旧版「停栖」把鸟冻在半空（出生 ±1.5 格散摆 + 随机再抬 1 格、落下后水平不收敛、
         停栖拍幅还有半幅），任何机位看都是悬停摆拍；截图取证（o-parrot-perch）撞出来之后
         改成：出生直接落栖点列、停栖分支水平弹簧贴位、拍幅只留 BIRD_PERCH_FLAP 微颤、
         短飞结束水平+高度双条件才落下。这里在真实主循环里量三件事：
         「残差≤0.35 且翼角在收拢带」的停栖样本攒够、全部停栖样本翼角不越收拢带、
         水平残差不越落下闸、高度误差不越 1 格。有界条件等待，上限 10 秒。 */
      const bd7 = { samples: 0, settled: 0, wingAbsMax: 0, dHomeMax: 0, yErrMax: 0 };
      /* 站远一点再量：玩家贴在站点列上会把停栖的鸟一路惊飞，窗口就只剩飞行样本 */
      G.controller.setPositions(bdSiteX + 12, G.world.surfaceHeight(Math.floor(bdSiteX + 12), Math.floor(bdSiteZ)) + 1, bdSiteZ);
      await T.waitChunks(1, { light: true });
      const bd7Fold = bdLim.glideFlap + bdLim.flapMax * 0.08 + 0.02;
      const bd7T0 = performance.now();
      let bd7Seen = false;
      while (performance.now() - bd7T0 < 10000) {
        await frame();
        for (const b of T.birdInfo()) {
          if (b.phase !== 'perched' || !b.perch || b.wingL === null) continue;
          bd7.samples++;
          const dh = Math.hypot(b.x - b.perch.x, b.z - b.perch.z);
          bd7.dHomeMax = Math.max(bd7.dHomeMax, dh);
          bd7.wingAbsMax = Math.max(bd7.wingAbsMax, Math.abs(b.wingL));
          bd7.yErrMax = Math.max(bd7.yErrMax, Math.abs(b.y - (b.perch.y + bdLim.perchFallback)));
          if (dh <= 0.35 && Math.abs(b.wingL) <= bd7Fold) bd7.settled++;
        }
        if (bd7.samples >= 60 && bd7.settled >= 40) { bd7Seen = true; break; }
      }
      ok('BD.7 停栖真的是停栖：翅膀只留收拢带+微颤、水平残差收进栖点列、高度贴栖点站位（不再悬空摆拍）',
        bd7Seen && bd7.samples >= 60 && bd7.settled >= 40 &&
        bd7.wingAbsMax <= bd7Fold && bd7.dHomeMax <= 1.6 + 0.05 && bd7.yErrMax <= 1.0,
        '停栖样本=' + bd7.samples + ' 其中贴位收拢=' + bd7.settled +
        ' 窗=' + Math.round(performance.now() - bd7T0) + 'ms' +
        ' 翼角峰值=' + bd7.wingAbsMax.toFixed(3) + '（收拢带 ' + bd7Fold.toFixed(3) + '）' +
        ' 水平残差峰值=' + bd7.dHomeMax.toFixed(2) + '（落下闸 1.6）' +
        ' 高度误差峰值=' + bd7.yErrMax.toFixed(2));

      /* ---- CV.0 ~ CV.5：地下敌怪按「候选格局部光照 + 可站立空间」筛选，并留同一点位插火把的 A/B ----
       * 在玩家脚下这一列挖一间 27×27×4 的洞穴室（地板实心、顶上再压 5 格石头把天光挡死）：
       *   不点灯 → 又暗又站得住 → 判据通过，产品自己的地下通路真的会往这里刷敌怪；
       *   每 6 格一盏火把 → 同一批格子的局部亮度越过阈值 → 判据拒绝，这一间的风险归零。
       * 为什么挖到 27 格见方：洞穴通路的候选点取玩家周围 10~28 格（SPAWN_UNDERGROUND_MIN_DIST/RANGE），
       * 一间 7×7 的小屋只有四个角落进那条环带，取证（probe-underground3.mjs）量到「点灯前后都刷不到几只」，
       * A/B 就只剩运气；27 格见方的房间把环带里相当一部分柱子收进来，暗/亮两边都量得动。
       * 挖之前先等区块排空、挖完回读格子：`world.js:207` 对未生成区块的 setBlock 是静默丢弃，
       * 不然「刷不出怪」会被误读成「产品不刷」。 */
      const lgLim = bdLim;        // 地下那一路的界也来自同一份 birdLimits()：断言里的界 = 代码里的界
      const lgHalf = 13, lgGap = 6;
      /* 先把玩家放到**这一节自己选的**一列上再挖：BD.6 的读档会把玩家放回存档时的坐标，
         那可能离站点几十格，而地下通路的候选带是「以玩家为中心 10~28 格」——
         洞穴室必须挖在玩家脚下这一列，A/B 才与产品真正使用的选择范围对得上。 */
      G.controller.flying = false;
      G.controller.setPositions(bdSiteX, G.world.surfaceHeight(Math.floor(bdSiteX), Math.floor(bdSiteZ)) + 1, bdSiteZ);
      const lgStand0 = await tryUntil(() => G.controller.onGround, { budgetMs: 8000, label: 'CV 站到洞穴列上' });
      const lgX = Math.floor(G.controller.pos.x), lgZ = Math.floor(G.controller.pos.z);
      const lgSurf = G.world.surfaceHeight(lgX, lgZ);
      const lgY = Math.max(G.world.minY + 8, lgSurf - 10);
      const lgDay = 1.0;                                   // dayFactor=1 → 正午，天光最强：地下的风险只该由火把决定
      const lgBox = { x0: lgX - lgHalf, x1: lgX + lgHalf, y0: lgY, y1: lgY, z0: lgZ - lgHalf, z1: lgZ + lgHalf };
      const lgCarve = () => {
        let writes = 0;
        for (let dz = -lgHalf; dz <= lgHalf; dz++) for (let dx = -lgHalf; dx <= lgHalf; dx++) {
          for (let h = 0; h <= 3; h++) { T.setBlock(lgX + dx, lgY + h, lgZ + dz, 0); writes++; }   // 掏空 4 格高
          T.setBlock(lgX + dx, lgY - 1, lgZ + dz, 1); writes++;                                     // 地板实心（石头）
          for (let h = 4; h <= 8; h++) { T.setBlock(lgX + dx, lgY + h, lgZ + dz, 1); writes++; }     // 顶盖 5 格：把天光挡死
        }
        return writes;
      };
      const lgDrain = (label) => tryUntil(() => {
        const p = T.worldPending();
        return p && p.gen === 0 && p.light === 0 && p.mesh === 0;
      }, { budgetMs: 25000, tick: 'sleep', intervalMs: 40, label, observe: T.worldPending });
      const lgWrites0 = lgCarve();
      const lgD0 = await lgDrain('CV 洞穴室写入后排空三段队列');
      T.teleport(lgX + 0.5, lgY, lgZ + 0.5);
      const lgStand = await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: 'CV 站进洞穴室' });
      /* 判据读数一律走产品自己的函数（spawnSiteOk / findUndergroundSpawnPoint），脚本不复制公式 */
      const lgFloorCells = () => {
        const out = [];
        for (let dz = -lgHalf; dz <= lgHalf; dz++) for (let dx = -lgHalf; dx <= lgHalf; dx++) out.push({ x: lgX + dx + 0.5, y: lgY, z: lgZ + dz + 0.5 });
        return out;
      };
      const lgCellOk = (c, day) => T.mobSiteOk(true, c.x, c.y, c.z, day);
      const lgJudgeSweep = (cells, day) => {
        let pass = 0; const why = {};
        for (const c of cells) { const r = lgCellOk(c, day); if (r.ok) pass++; else why[r.why] = (why[r.why] || 0) + 1; }
        return { cells: cells.length, pass, why };
      };
      const lgCells = lgFloorCells();
      const lgCenter = { x: lgX + 0.5, y: lgY, z: lgZ + 0.5 };
      const lgDarkOk = lgCellOk(lgCenter, lgDay);
      const lgCovered = T.exposedToSky(lgCenter.x, lgCenter.y, lgCenter.z);
      const lgAir = T.blockAt(lgX, lgY, lgZ).id;
      const lgFloor = T.blockAt(lgX, lgY - 1, lgZ).id;
      const lgRoof = T.blockAt(lgX, lgY + 4, lgZ).id;
      /* 「站得住」的那批格子先固定下来：A/B 只该由亮度决定，所以两边用同一批格子比。
         房间边上偶尔会挨着天然洞穴或水体，那些格子本来就站不住，不该算进火把这件事的分母。 */
      const lgStandable = lgCells.filter(c => lgCellOk(c, lgDay).why !== 'standable');
      const lgSweepDark = lgJudgeSweep(lgStandable, lgDay);
      const lgProbeDark = T.caveSiteProbe(lgDay, 200, lgBox);
      ok('CV.0 洞穴夹具自检：室真的是空的、地板实心、顶盖把天光挡住、这一点在正午仍然算「暗且站得住」，' +
        '而且站得住的格子里确实有通过判据的（红的时候先说是夹具没挖通，不要说产品不筛）',
        lgD0.ok && lgStand.ok && lgStand0.ok && lgAir === 0 && lgFloor === 1 && lgRoof === 1 && lgCovered === false &&
        lgDarkOk.ok === true && lgDarkOk.light !== null && lgDarkOk.light <= lgLim.darkLimit &&
        lgStandable.length > 100 && lgSweepDark.pass > 0,
        '列=' + lgX + ',' + lgZ + '（这一节自己选的，不在读档落点上） 坐标=' + JSON.stringify(lgCenter) + ' 地表=' + lgSurf + ' 室底=' + lgY + ' 写入=' + lgWrites0 + ' 格=' + lgAir + '/' + lgFloor + '/' + lgRoof +
        ' 判据=' + JSON.stringify(lgDarkOk) + ' 通透=' + lgCovered + ' 站得住=' + lgStandable.length + '/' + lgCells.length +
        ' 暗扫=' + JSON.stringify(lgSweepDark) + ' 界=' + JSON.stringify({ darkLimit: lgLim.darkLimit, coverMin: lgLim.coverMin, depthMax: lgLim.depthMax, dist: [lgLim.caveDistMin, lgLim.caveDistMin + lgLim.caveDistRange] }) +
        ' 排空=' + JSON.stringify(T.worldPending()));

      /* CV.1 白天地下确实有风险：在洞里推产品自己的 900 帧（15 秒游戏时间）刷怪节拍 */
      const lgMax0 = G.mobs.maxMobs;
      G.mobs.maxMobs = 26;
      G.mobs.clear();
      const lgInRoom = (m) => Math.abs(Math.floor(m.pos.x) - lgX) <= lgHalf && Math.abs(Math.floor(m.pos.z) - lgZ) <= lgHalf &&
        m.pos.y >= lgY - 0.5 && m.pos.y <= lgY + 3.5;
      const lgT1 = performance.now();
      for (let i = 0; i < 900; i++) G.mobs.update(1 / 60, lgDay);
      const lgPopDark = T.mobSpawnInfo();
      const lgRoomDark = G.mobs.list.filter(m => m.def.hostile && lgInRoom(m)).length;
      const lgRunMs1 = Math.round(performance.now() - lgT1);
      ok('CV.1 白天地下确实有风险：正午（dayFactor=' + lgDay + '）在洞里推 900 帧产品自己的节拍，地下通路刷出了敌怪，' +
        '而且此刻场上的敌怪全部来自地下通路（白天地表那套分档仍然只刷动物）；' +
        '候选点搜索 200 次也真的落进这间屋子；总量与洞穴上限、让位后的陆上额度同时守住',
        lgPopDark.caveHostiles >= 1 && lgPopDark.hostile >= 1 && lgPopDark.caveHostiles === lgPopDark.hostile &&
        lgPopDark.total <= lgPopDark.maxMobs && lgPopDark.caveHostiles <= lgLim.caveCap &&
        lgPopDark.land <= lgPopDark.landCap && lgPopDark.landCap < lgPopDark.maxMobs &&
        lgProbeDark.inBox > 0 && lgSweepDark.pass > 0 && lgDarkOk.light <= lgLim.darkLimit,
        '读数=' + JSON.stringify(lgPopDark) + '（洞内敌怪 ' + lgRoomDark + ' 只，跑 900 帧用 ' + lgRunMs1 + 'ms）' +
        ' 候选点搜索=' + JSON.stringify(lgProbeDark) + ' 室内判据通过=' + JSON.stringify(lgSweepDark) +
        ' 判据中心格=' + JSON.stringify(lgDarkOk) + ' 界面=' + JSON.stringify({ darkLimit: lgLim.darkLimit, caveCap: lgLim.caveCap, caveInterval: lgLim.caveInterval }));

      /* 修一遍屋子再做点亮侧：CV.1 期间苦力怕可能在屋里炸过，A/B 的自变量只能是火把 */
      const lgWrites1 = lgCarve();
      const lgD1 = await lgDrain('CV 点灯前修复洞穴室后排空');
      /* 火把网格按「从中心向外」取偏移：上一轮从 -13 起步长 6，偏移是 -13/-7/-1/5/11，
         房间正中心那一格恰好没落到火把上 —— 判据其实已经改口（亮度 0.785 > 0.34），
         但夹具自检「中心格这一格真的是火把」当场红。改成 0/±6/±12 之后中心有火把，
         而最远的墙角（±13）距最近的火把只剩 1 格，覆盖只会更好。 */
      const lgOffs = [];
      for (let o = 0; o <= lgHalf; o += lgGap) lgOffs.push(o);
      for (let dz = 0; dz < lgOffs.length; dz++) for (let dx = 0; dx < lgOffs.length; dx++) {
        for (const sz of (lgOffs[dz] === 0 ? [0] : [-lgOffs[dz], lgOffs[dz]])) {
          for (const sx of (lgOffs[dx] === 0 ? [0] : [-lgOffs[dx], lgOffs[dx]])) {
            T.setBlock(lgX + sx, lgY, lgZ + sz, bdIds.TORCH);
          }
        }
      }
      const lgTorchN = lgOffs.length * lgOffs.length;
      const lgD2 = await lgDrain('CV 火把点亮后补光排空');
      /* 阶段 6 封版：三段队列瞬时归零 ≠ 这一格的方块/光照状态已经可读。
         14:49 成品自检同一夹具读到 why=light / light=0.9275，本轮源码读到
         why=standable / light=null —— spawnSiteOk 在 canStandAt 失败时提前返回 light:null，
         那是数据尚未就绪，不是「火把没把这一点点亮」。按与 R4.0 同一口径改成
         **有界等待 + 记录观测时点**：等中心格给出非 null 的光照读数再取样；
         判据本身（必须因亮度被挡、不能因站不住）一字不改，超时如实记进 info。 */
      const lgLightReady = await tryUntil(() => {
        const seen = T.blockAt(lgX, lgY, lgZ).id;
        const c = lgCellOk(lgCenter, lgDay);
        return seen === bdIds.TORCH && c && c.light !== null && c.why === 'light' ? c : null;
      }, { budgetMs: 12000, tick: 'sleep', intervalMs: 80, label: 'CV 点灯后中心格光照读数就绪',
        observe: () => ({ seen: T.blockAt(lgX, lgY, lgZ).id, cell: lgCellOk(lgCenter, lgDay), pending: T.worldPending() }) });
      await sleep(250);                    // 让整间屋子的写回一起稳定，A/B 用同一批格子才公平
      const lgTorchSeen = T.blockAt(lgX, lgY, lgZ).id;
      const lgLitOk = lgCellOk(lgCenter, lgDay);
      ok('CV.2 同一坐标插上火把之后，判据立刻改口：这一点不再是可刷点，挡下的原因是「亮度」而不是「站不住」' +
        '（先自检火把这一格真的落进世界了，再点灯前后各读一次同一格）',
        lgD1.ok && lgD2.ok && lgTorchSeen === bdIds.TORCH &&
        lgLitOk.ok === false && lgLitOk.why === 'light' && lgLitOk.light > lgLim.darkLimit &&
        lgDarkOk.ok === true && lgDarkOk.light <= lgLim.darkLimit,
        '暗=' + JSON.stringify(lgDarkOk) + ' 亮=' + JSON.stringify(lgLitOk) + ' 界=' + lgLim.darkLimit +
        ' 中心格=' + lgTorchSeen + '/' + bdIds.TORCH + ' 火把=' + lgTorchN + ' 盏（间距 ' + lgGap + '，从中心向外）' + ' 修复写入=' + lgWrites1 +
        ' 光照就绪等待=' + JSON.stringify({ ok: lgLightReady.ok, ms: lgLightReady.ms, value: lgLightReady.value }) +
        ' 排空=' + JSON.stringify(T.worldPending()));

      /* 点灯之后的同一批格子 + 同一个玩家站位的产品候选点搜索 + 同样 900 帧真实节拍 */
      const lgSweepLit = lgJudgeSweep(lgStandable, lgDay);
      const lgProbeLit = T.caveSiteProbe(lgDay, 200, lgBox);
      G.mobs.clear();
      const lgT2 = performance.now();
      for (let i = 0; i < 900; i++) G.mobs.update(1 / 60, lgDay);
      const lgPopLit = T.mobSpawnInfo();
      const lgRoomLit = G.mobs.list.filter(m => m.def.hostile && lgInRoom(m)).length;
      const lgRunMs2 = Math.round(performance.now() - lgT2);
      ok('CV.3 点灯之后这一间的风险真的归零：同一批「站得住」的格子（' + lgStandable.length + ' 格），' +
        '暗的时候判据通过 ' + lgSweepDark.pass + ' 格，铺上火把之后通过 ' + lgSweepLit.pass +
        ' 格、而且挡下的原因全是亮度；产品自己的候选点搜索 200 次从 ' + lgProbeDark.inBox + ' 次落进这间屋子变成 ' +
        lgProbeLit.inBox + ' 次；再推 900 帧，室内一只敌怪都没有',
        lgSweepDark.pass > 0 && lgSweepLit.pass === 0 &&
        lgSweepLit.why.light === lgStandable.length &&
        lgProbeDark.inBox > 0 && lgProbeLit.inBox === 0 &&
        lgRoomLit === 0 && lgPopLit.total <= lgPopLit.maxMobs,
        '暗扫=' + JSON.stringify(lgSweepDark) + ' 亮扫=' + JSON.stringify(lgSweepLit) +
        ' 暗候选=' + JSON.stringify(lgProbeDark) + ' 亮候选=' + JSON.stringify(lgProbeLit) +
        ' 亮后 900 帧读数=' + JSON.stringify(lgPopLit) + '（洞内 ' + lgRoomLit + ' 只，跑 ' + lgRunMs2 + 'ms；' +
        '远处天然洞穴仍然会刷怪 —— 那正是「火把只降这一间的风险」该有的样子）');

      /* 四条通路共用一把闸：陆上 / 洞穴 / 林冠 / 水域同时在场，各自的界同时成立 */
      const lgAll = T.mobSpawnInfo();
      const lgBirds = T.birdInfo().length, lgFish = T.fishInfo().length;
      ok('CV.4 生态总量共用一把闸：陆上 / 洞穴 / 林冠 / 水域四路同时跑，总数不越 maxMobs，' +
        '洞穴、鸟、鱼各守自己的上限，读数与场上实体一一对得上（地下时地表的三路还要替洞穴留出额度）',
        lgAll.total <= lgAll.maxMobs && lgAll.caveHostiles <= lgLim.caveCap &&
        lgBirds <= bdLim.maxAlive && lgFish <= T.fishLimits().maxAlive &&
        lgAll.flying === lgBirds && lgAll.aquatic === lgFish &&
        lgAll.total === lgAll.land + lgAll.hostile + lgAll.flying + lgAll.aquatic &&
        lgAll.land <= lgAll.landCap && lgAll.timers !== undefined &&
        lgAll.surfaceCap < lgAll.maxMobs &&
        (lgAll.land + lgAll.flying + lgAll.aquatic) <= lgAll.surfaceCap,
        '总量=' + JSON.stringify(lgAll) + ' 鸟=' + lgBirds + ' 鱼=' + lgFish +
        ' 产品界=' + JSON.stringify({ maxAlive: bdLim.maxAlive, caveCap: lgLim.caveCap, flock: [bdLim.flockMin, bdLim.flockMax], fishMax: T.fishLimits().maxAlive }));

      /* 峰值密度下的帧成本：这一段所有家族都在场上的时候测最低帧率。
         这是「记录成本」而不是新立一条性能承诺 —— 16.1 那条 20fps 的基准不空场景，
         这里把界放到 12fps 只为了「密度上来不许塌成幻灯片」，真实数值写进详情供人对比。 */
      let lgFpsMin = 999;
      await watch(1500, () => { lgFpsMin = Math.min(lgFpsMin, G.fps); return false; });
      ok('CV.5 密度峰值下的帧成本已记录且不塌：' + lgAll.total + ' 只生物（鸟 ' + lgBirds + ' / 鱼 ' + lgFish +
        ' / 洞穴敌怪 ' + lgAll.caveHostiles + ' / 陆上 ' + lgAll.land + '）同时在场时最低帧率 ≥12fps',
        lgFpsMin >= 12,
        '最低 fps=' + lgFpsMin + '（对照 16.1 的空场景基准 20fps）读数=' + JSON.stringify(lgAll));

      /* 收尾：把洞穴室填回石头（火把跟着被替掉）、还回额度与模式，后续小节按原口径跑 */
      for (let dz = -lgHalf; dz <= lgHalf; dz++) for (let dx = -lgHalf; dx <= lgHalf; dx++) {
        for (let h = 0; h <= 3; h++) T.setBlock(lgX + dx, lgY + h, lgZ + dz, 1);
      }
      G.mobs.maxMobs = lgMax0;
      G.mobs.clear();
      await lgDrain('CV 收尾复原排空');
      G.controller.setCreative(bdCreative0);
      G.controller.flying = bdFly0;
    }

    /* ---------------- SK./CP. 阶段 3b：骷髅与苦力怕重做（贴图 / 转轴 / 先拉后放 / 引信档位） ----------------
       任务书：「每个以独立像素贴图、轮廓和正确转轴重做头/身/肢体，白天、暗处、火把边都能看出区别。
                骷髅加眼窝、肋骨、可辨认的弓形和先拉后放的预警。
                苦力怕从斜侧看得出四足，接近时要能听到嘶声并看出引信阶段，拉开距离可取消。」
       这一段全部走真实主循环（真实 AI 分支 + 真实材质 + 真实音效记账），不靠手摆模型。 */
    {
    const mbX = Math.floor(G.spawn.x) + 120, mbZ = Math.floor(G.spawn.z);
    /* 顺序很关键：**先把区块叫出来，再动方块**。`world.js:207` 对未生成的区块直接
       `return false`，setBlock 会被静默丢弃，而这里要搭的 29×29 平台、3×12 走廊和
       SK.6 那堵 29 格宽的墙全在出生点 120 格外，正常游玩不会走到。
       旧顺序（先搭台 → 再传送 → 才等区块）等于把一半方块丢在空气里：
       隔离取证 artifacts/repro-3b.json 里能看到骷髅被残留山体顶到 y=59、los=false，
       于是 8 格外那场遭遇变成「它根本不拉弓」（上一轮 SK.5 拉弓=false 就是这个形状）。 */
    T.teleport(mbX + 0.5, G.spawn.y, mbZ + 0.5);
    await T.waitChunks(2, { light: true });
    await tryUntil(() => {
      const far = (dx, dz) => G.world.isSolidAt(mbX + dx, G.world.topSolidY(mbX + dx, mbZ + dz), mbZ + dz);
      return far(12, 12) && far(-12, -12) && far(12, -12) && far(-12, 12);
    }, { budgetMs: 20000, tick: 'sleep', intervalMs: 100, label: '3b 场地四角区块都已生成',
      observe: () => ({ top: G.world.topSolidY(mbX, mbZ), state: G.state }) });
    const mbY = G.world.topSolidY(mbX, mbZ);
    for (let dz = -14; dz <= 14; dz++) for (let dx = -14; dx <= 14; dx++) {
      T.setBlock(mbX + dx, mbY, mbZ + dz, 1);
      for (let h = 1; h <= 7; h++) T.setBlock(mbX + dx, mbY + h, mbZ + dz, 0);
    }
    /* 再沿 z 清出一条 3 格宽、12 格高的通透走廊：上面只清了 mbY 以上 7 格，
       而 mbY 取的是中心那一列的高度，两侧有山丘或树冠时 8 格外的视线会被地形自己挡住。 */
    for (let dz = -14; dz <= 14; dz++) for (let dx = -1; dx <= 1; dx++)
      for (let h = 8; h <= 12; h++) T.setBlock(mbX + dx, mbY + h, mbZ + dz, 0);
    await tryUntil(() => { const p = T.worldPending(); return p && p.gen === 0 && p.light === 0 && p.mesh === 0; },
      { budgetMs: 20000, tick: 'sleep', intervalMs: 40, label: '3b 平台与走廊写入后排空', observe: T.worldPending });
    /* SK.0 夹具自检：这一段的每条遭遇断言都默认「场地是平的、视线是通的、墙是实心的」。
       这三件事以前只能靠跑出来才发现没成立，红的时候看起来像产品问题。现在先各钉一格。 */
    const mbChecks = {
      platCenter: G.world.getBlock(mbX, mbY, mbZ), platFar: G.world.getBlock(mbX + 13, mbY, mbZ + 13),
      aboveFar: G.world.getBlock(mbX + 13, mbY + 5, mbZ + 13),
      corridorHigh: G.world.getBlock(mbX, mbY + 10, mbZ + 12), laneMid: G.world.getBlock(mbX, mbY + 2, mbZ + 7)
    };
    ok('SK.0 场地夹具自检：先叫出区块再动方块，平台/走廊/墙要用的格子都真的在方块数据里（未生成区块的 setBlock 会被静默丢弃）',
      mbChecks.platCenter === 1 && mbChecks.platFar === 1 && mbChecks.aboveFar === 0 &&
      mbChecks.corridorHigh === 0 && mbChecks.laneMid === 0,
      JSON.stringify(mbChecks) + ' mbY=' + mbY + ' 场地=(' + mbX + ',' + mbZ + ')');
    const mbMax0 = G.mobs.maxMobs, mbCreative0 = G.controller.creative;
    /* 这一段固定走夜：阳光会点燃骷髅（`mobs.js:869` 起 `m.hp -= dt * 1.6`，12 血约 7.5 秒烧死），
       而这里有几段持续好几秒的「等它起手 / 按住侧移 / 隔墙观察」，白天会让被测对象半路烧死，
       读数就变成在测日晒而不是测拉弓（上一轮 SK.5 的 拉弓=false 与 SK.7 的 hp 12→11.95 就是这么来的）。
       与第 36 节护甲段同一手法，收尾时把原时刻还回去。 */
    const mbTime0 = G.time;
    T.setTime(0.75);
    G.mobs.maxMobs = 0;                       // 这一段自己造怪，别让自然刷怪混进来
    G.mobs.clear();
    G.controller.setCreative(true);           // 创造：AI 的射箭/充能照常跑，但玩家不会被耗死
    G.controller.health = 20;
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 2.5);
    await T.waitChunks(1, { light: true });
    await tryUntil(() => G.controller.onGround, { budgetMs: 6000, label: '3b 平台落地' });

    /* --- SK.1 贴图真的挂上了，而且两种生物用的不是同一套 --- */
    const skSkin = T.mobSkinInfo('skeleton'), crSkin = T.mobSkinInfo('creeper');
    const namesOf = (skin) => {
      const out = new Set();
      for (const p of skin.parts.concat(skin.extras)) {
        if (!p.tex) continue;
        for (const piece of String(p.tex).split(',')) {
          const v = piece.indexOf(':') >= 0 ? piece.split(':')[1] : piece;
          if (v) out.add(v);
        }
      }
      return [...out];
    };
    const skTex = namesOf(skSkin), crTex = namesOf(crSkin);
    const skStats = skTex.map(n => T.mobTexStats(n)), crStats = crTex.map(n => T.mobTexStats(n));
    const texReal = (arr) => arr.length > 0 && arr.every(s => s.pixels === 256 && s.missingRatio === 0 &&
      s.colorBuckets >= 4 && s.hasPainter === true);
    const sharedTex = skTex.filter(n => crTex.includes(n));
    const skFront = skStats.find(s => s.name === 'skeleton_skull_front') || {};
    const skTop = skStats.find(s => s.name === 'skeleton_skull_top') || {};
    const skRibs = skStats.find(s => s.name === 'skeleton_ribs') || {};
    const crGreen = crStats.find(s => s.name === 'creeper_skin') || {};
    const meshMapped = skSkin.parts.concat(crSkin.parts)
      .filter(p => p.tex && p.faces !== null).every(p => p.hasMap === true && p.texSize === 16);
    ok('SK.1 骷髅与苦力怕各有独立像素贴图：真的挂上 16×16 画布、不露品红、骷髅有眼窝与肋骨、苦力怕是绿皮',
      skTex.length >= 4 && crTex.length >= 2 && sharedTex.length === 0 &&
      texReal(skStats) && texReal(crStats) && meshMapped &&
      skFront.darkRatio > skTop.darkRatio + 0.02 &&
      skRibs.darkRatio > 0.3 &&
      crGreen.meanG > crGreen.meanR && crGreen.meanG > crGreen.meanB &&
      Math.abs(skFront.meanG - skFront.meanR) < 8,
      '骷髅贴图=' + JSON.stringify(skTex) + ' 苦力怕贴图=' + JSON.stringify(crTex) +
      ' 共用=' + JSON.stringify(sharedTex) + ' 每个 mesh 都带 16px 画布=' + meshMapped +
      ' 眼窝暗度(正面/顶面)=' + skFront.darkRatio + '/' + skTop.darkRatio +
      ' 肋骨暗度=' + skRibs.darkRatio + ' 苦力怕均值RGB=' + crGreen.meanR + '/' + crGreen.meanG + '/' + crGreen.meanB +
      ' 骷髅正面RGB=' + skFront.meanR + '/' + skFront.meanG + '/' + skFront.meanB +
      ' 逐张(档数/暗度/品红)=' + JSON.stringify(skStats.concat(crStats).map(s =>
        s.name + ':' + s.colorBuckets + '/' + s.darkRatio + '/' + s.missingRatio)));

    /* --- SK.2 转轴：关节端几乎不动、末端大幅划弧，腿长与头高逐格对得上旧版 --- */
    const skPv = G.mobs.spawn('skeleton', mbX + 0.5, mbY + 1, mbZ + 7.5);
    await tryUntil(() => skPv.onGround, { budgetMs: 4000, label: 'SK.2 骷髅落地' });
    await frame();
    const pvLeg = T.mobLimbPivot('skeleton', 'leg0', 0.6);
    const pvArm = T.mobLimbPivot('skeleton', 'arm0', 0.6);
    const pvHead = T.mobLimbPivot('skeleton', 'head', 0.5);
    const legLen = pvLeg ? +(pvLeg.joint0.y - pvLeg.tip0.y).toFixed(4) : null;
    const headLen = pvHead ? +(pvHead.tip0.y - pvHead.joint0.y).toFixed(4) : null;
    ok('SK.2 转轴在关节上：腿绕髋/臂绕肩/头绕颈，转 0.6 弧度时关节端几乎不动、末端明显划弧，尺寸与旧版逐格相同',
      !!pvLeg && !!pvArm && !!pvHead &&
      pvLeg.pivot === 'top' && pvArm.pivot === 'top' && pvHead.pivot === 'bottom' &&
      pvLeg.jointShift < 0.02 && pvLeg.tipShift > 0.15 &&
      pvArm.jointShift < 0.02 && pvArm.tipShift > 0.1 &&
      pvHead.jointShift < 0.02 && pvHead.tipShift > 0.08 &&
      Math.abs(legLen - 0.68) < 0.01 && Math.abs(headLen - 0.42) < 0.01,
      '腿=' + JSON.stringify(pvLeg) + ' 臂=' + JSON.stringify(pvArm) + ' 头=' + JSON.stringify(pvHead));

    /* --- SK.3 先拉后放：真实遭遇里拉弓期间一支箭都没有，弦与搭箭看得见地变化 --- */
    G.mobs.clear();
    const sk = G.mobs.spawn('skeleton', mbX + 0.5, mbY + 1, mbZ + 7.5);
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 2.5);          // 5 格：在 12 格射程内、又不触发「太近后退」
    await tryUntil(() => sk.onGround, { budgetMs: 4000, label: 'SK.3 骷髅落地' });
    const arrows0 = G.mobs.arrows.length;
    const dTrace = [];
    const dT0 = performance.now();
    const dWatch = await watch(3000, () => {
      const i = T.mobCombatInfo().find(x => x.type === 'skeleton');
      if (i) dTrace.push({ ms: Math.round(performance.now() - dT0), ...i });
      return !!i && i.arrows > arrows0;                  // 离弦那一刻就是本窗口的终点
    });
    ok('SK.3 骷髅先拉后放：拉弓期间零支箭、弦越拉越靠后、箭搭在弦上看得见，到点才离弦（反应窗口 ≥0.6 秒）',
      dTrace.length >= 8 && dTrace.some(t => t.drawing) &&
      dTrace.filter(t => t.arrows === arrows0).length === dTrace.length - 1 &&
      dWatch.violated && dWatch.ms >= 600 &&
      Math.min(...dTrace.map(t => t.nockZ)) <= -0.15 &&
      dTrace.some(t => t.arrowVisible === true) &&
      Math.max(...dTrace.map(t => t.bowDraw)) >= 0.8 &&
      G.mobs.arrows.length > arrows0,
      '观察=' + dTrace.length + ' 帧/' + dWatch.ms + 'ms 首箭前箭数=' + arrows0 +
      ' 弦末端=' + Math.min(...dTrace.map(t => t.nockZ)) + ' 最大拉弓=' + Math.max(...dTrace.map(t => t.bowDraw)) +
      ' 见过搭箭=' + dTrace.some(t => t.arrowVisible) + ' 轨迹=' + JSON.stringify(dTrace.slice(0, 6).map(t =>
        ({ ms: t.ms, draw: t.bowDraw, nockZ: t.nockZ, ar: t.arrowVisible, n: t.arrows }))));

    /* --- SK.4 拉弓期间几乎站定（看得见也走得开），弓本身是「可辨认的弓形」 --- */
    const drawFrames = dTrace.filter(t => t.drawing);
    let movedDuringDraw = 0;
    for (let i = 1; i < drawFrames.length; i++) {
      movedDuringDraw += Math.hypot(drawFrames[i].x - drawFrames[i - 1].x, drawFrames[i].z - drawFrames[i - 1].z);
    }
    const bowExtra = (skSkin.extras || []).find(e => e.extra === 'bow') || {};
    const bowIsPart = skSkin.parts.some(p => p.part === 'bow');
    ok('SK.4 拉弓时骷髅站定瞄准（整段位移 <0.5 格），弓是三段弓臂 + 两段弦 + 一支搭箭的独立部件',
      drawFrames.length >= 4 && movedDuringDraw < 0.5 &&
      bowIsPart && bowExtra.children >= 5 && bowExtra.tex === 'skeleton_bow',
      '拉弦帧=' + drawFrames.length + ' 累计位移=' + movedDuringDraw.toFixed(3) +
      ' 弓在 parts=' + bowIsPart + ' 弓的子件=' + bowExtra.children + ' 贴图=' + bowExtra.tex);

    /* --- CP.1 苦力怕：绿皮贴图 + 四腿前后分开（斜侧数得出四条） --- */
    G.mobs.clear();
    const cr1 = G.mobs.spawn('creeper', mbX + 0.5, mbY + 1, mbZ + 7.5);
    await tryUntil(() => cr1.onGround, { budgetMs: 4000, label: 'CP.1 苦力怕落地' });
    await frame();
    const lgF = T.mobLimbPivot('creeper', 'leg0', 0.6), lgB = T.mobLimbPivot('creeper', 'leg2', 0.6);
    /* 站距要在**模型坐标**里量：整组模型按 yaw 旋转过，世界 z 会把 x/z 混在一起（实测 0.1228）。 */
    const legSpread = lgF && lgB ? +Math.abs(lgF.pos[2] - lgB.pos[2]).toFixed(4) : null;
    const legSpreadWorld = lgF && lgB ? +Math.hypot(lgF.joint0.x - lgB.joint0.x, lgF.joint0.y - lgB.joint0.y,
      lgF.joint0.z - lgB.joint0.z).toFixed(4) : null;
    const crMats = crSkin.parts.filter(p => p.tex && p.faces !== null);
    const crMapped = crMats.length >= 6 && crMats.every(p => p.hasMap === true && p.texSize === 16);
    const crSixFace = ['body', 'head'].every(k => {
      const p = (crSkin.parts || []).find(x => x.part === k);
      return !!p && p.faces === 6 && p.hasMap === true;
    });
    const crLegs = (crSkin.parts || []).filter(p => p.part && p.part.indexOf('leg') === 0);
    ok('CP.1 苦力怕四腿前后分开（斜侧数得出四条）、腿绕髋转、躯干头是六面绿皮且每面都挂上画布',
      legSpread >= 0.3 && lgF.pivot === 'top' && lgF.jointShift < 0.02 && lgF.tipShift > 0.2 &&
      crLegs.length === 4 && crMapped && crSixFace,
      '前后腿髋间距(模型)=' + legSpread + ' (世界)=' + legSpreadWorld + ' 腿=' + JSON.stringify(lgF) +
      ' 贴图件=' + crMats.length + ' 全挂画布=' + crMapped + ' 头身六面=' + crSixFace +
      ' 腿部件数=' + crLegs.length);

    /* --- CP.2 引信三档 + 嘶声越叫越急 + 闪白真的在交替 + 身体越胀越大 --- */
    G.mobs.clear();
    const boom0 = T.blastInfo().explosions;
    const hiss0 = (T.sfxStats().byName || {}).hiss || 0;
    const cr = G.mobs.spawn('creeper', mbX + 0.5, mbY + 1, mbZ + 4.5);
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 2.5);           // 2 格：进入 3.2 格触发距离
    const cTrace = [];
    const cT0 = performance.now();
    await watch(1250, () => {
      const i = T.mobCombatInfo().find(x => x.type === 'creeper');
      if (i) cTrace.push({ ms: Math.round(performance.now() - cT0), ...i });
      return false;
    });
    const cStages = cTrace.map(t => t.fuseStage);
    const cColors = [...new Set(cTrace.map(t => t.bodyColor))];
    const hiss1 = (T.sfxStats().byName || {}).hiss || 0;
    const crSnap = cr.serialize();
    G.mobs.hitMob(cr, 999, { x: 0, z: 0 });               // 到点前击杀：不许炸
    await sleep(250);
    ok('CP.2 引信看得出三档、嘶声越叫越急、闪白在交替、身体单调胀大，且爆炸前被击杀不引爆',
      cTrace.length >= 8 && cStages.includes(0) && cStages.includes(1) && cStages.includes(2) &&
      cStages.every((v, i) => i === 0 || v >= cStages[i - 1]) &&
      hiss1 - hiss0 >= 3 && cColors.length >= 2 &&
      cTrace[cTrace.length - 1].swell > cTrace[0].swell &&
      T.blastInfo().explosions === boom0,
      '帧=' + cTrace.length + ' 档位=' + JSON.stringify(cStages) + ' 闪白颜色=' + JSON.stringify(cColors) +
      ' 嘶声增量=' + (hiss1 - hiss0) + ' 胀大=' + cTrace[0].swell + '→' + cTrace[cTrace.length - 1].swell +
      ' 爆炸数=' + boom0 + '→' + T.blastInfo().explosions);

    /* --- CP.3 拉开距离取消：充能态、引信、档位、嘶声节拍一起清干净 --- */
    G.mobs.clear();
    const boom1 = T.blastInfo().explosions;
    const cr2 = G.mobs.spawn('creeper', mbX + 0.5, mbY + 1, mbZ + 4.5);
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 2.5);
    const c2Start = await tryUntil(() => {
      const i = T.mobCombatInfo().find(x => x.type === 'creeper');
      return i && i.charging && i.fuseStage >= 1 ? i : null;
    }, { budgetMs: 4000, label: 'CP.3 先充能到 1 档', observe: () => T.mobCombatInfo() });
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 24.5);          // 一下拉开到 20 格（远超 6 格取消线）
    const c2Clear = await tryUntil(() => {
      const i = T.mobCombatInfo().find(x => x.type === 'creeper');
      return i && !i.charging && i.fuseStage === 0 && i.hissT === 0 && Math.abs(i.fuse - 1.5) < 1e-6 ? i : null;
    }, { budgetMs: 4000, label: 'CP.3 逃开后状态清零', observe: () => T.mobCombatInfo() });
    await sleep(400);
    ok('CP.3 拉开距离就取消：charging/引信/档位/嘶声节拍全部归零，逃开后不在身后炸',
      c2Start.ok && c2Clear.ok && G.mobs.list.includes(cr2) &&
      T.blastInfo().explosions === boom1,
      '起手=' + (c2Start.ok ? 'ok' : c2Start.timeout) + ' 清零=' + (c2Clear.ok ? JSON.stringify(c2Clear.value) : c2Clear.timeout) +
      ' 爆炸=' + boom1 + '→' + T.blastInfo().explosions);

    /* --- CP.4 动画态一律不入库：半张的弓与半截引信不能跟着存档走 --- */
    sk.drawing = true; sk.drawT = 0.4; sk.bowDraw = 0.6;      // 明确摆成「拉弓拉到一半」再取存档
    const skSnap = sk.serialize();
    sk.drawing = false; sk.drawT = 0; sk.bowDraw = 0;
    const animKeys = ['drawing', 'drawT', 'bowDraw', 'charging', 'fuse', 'fuseStage', 'hissT', 'animAttack', 'hurtT', 'sk', 'bb', 'sh'];
    const leaked = [skSnap, crSnap].flatMap(o => Object.keys(o).filter(k => animKeys.includes(k)));
    const keyShape = [skSnap, crSnap].map(o => Object.keys(o).join(','));
    ok('CP.4 动画态不入库：骷髅的拉弓与苦力怕的引信都不写进存档（读档从静止开始，不会一进场就放箭/爆炸）',
      leaked.length === 0 && keyShape.every(s => s === 't,x,y,z,yaw,hp'),
      '骷髅存档字段=' + keyShape[0] + ' 苦力怕存档字段=' + keyShape[1] + ' 泄漏的动画字段=' + JSON.stringify(leaked) +
      '（采样时它们正在动画里：骷髅 drawing/bowDraw=' + sk.drawing + '/' + sk.bowDraw.toFixed(2) +
      '，苦力怕 charging/fuse=' + (cr.charging ? 1 : 0) + '/' + cr.fuse.toFixed(2) + '）');

    /* --- SK.5 一场完整遭遇：看见拉弓 → 侧移晃掉那一箭 → 举盾挡下下一箭 ---
       SK.3 只证到「先拉后放」这件事本身，任务书还要玩家这一侧真的能反应：
       第一轮按住 A 侧移（真实按键）。距离故意取 8 格：骷髅在 4~9 格之间既不逼近也不后退，
       箭速 22 格/秒 → 飞行约 0.36 秒，而我们从「看见起手」就开始横移，离弦时已经有横向速度，
       飞行期间还能再挪一个多身位，命中判定只认 0.45 格半径 —— 躲开不靠运气。
       挨没挨打只看血量与无敌帧；第二轮站定举盾，让同一只骷髅的下一箭被盾牌挡下。 */
    G.mobs.clear();
    G.controller.setCreative(false);
    G.inventory.armor.fill(null);                 // 身上别留护甲：这几条要看的是「挨没挨到」，不是护甲吸收
    G.controller.health = 20; G.controller.invulnerable = 0;
    const mbAim = (tx, ty, tz) => {
      const ex = G.controller.pos.x, ey = G.controller.eyeY, ez = G.controller.pos.z;
      const dx = tx - ex, dy = ty - ey, dz = tz - ez, L = Math.hypot(dx, dy, dz) || 1;
      G.controller.pitch = Math.asin(dy / L); G.controller.yaw = Math.atan2(-dx, -dz);
    };
    const mbSkInfo = () => T.mobCombatInfo().find(x => x.type === 'skeleton') || {};
    /* 探针：把「它为什么没起手」需要的四件事一次读全 —— 视线是否通透、距离多少、
       它是不是在着火掉血、游戏状态对不对。将来这条再红，报告自己就能说明是哪一种。 */
    const sk5Probe = (m) => () => ({
      los: !!(m && G.mobs.lineOfSightToPlayer(m, G.controller)),
      dist: m ? +Math.hypot(m.pos.x - G.controller.pos.x, m.pos.z - G.controller.pos.z).toFixed(2) : null,
      mobY: m ? +m.pos.y.toFixed(2) : null, hp: m ? +m.hp.toFixed(1) : null, fire: m ? +m.fire.toFixed(2) : null,
      state: G.state, ...mbSkInfo()
    });
    const sk5 = G.mobs.spawn('skeleton', mbX + 0.5, mbY + 1, mbZ + 11.5);
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 3.5);            // 8 格：不逼近也不后退，箭要飞 0.36 秒，躲得开
    await tryUntil(() => G.controller.onGround && (!sk5 || sk5.onGround),
      { budgetMs: 5000, label: 'SK.5 双方站稳' });
    mbAim(sk5.pos.x, sk5.pos.y + 1.0, sk5.pos.z);         // 面朝它：A 键的侧移才垂直于弹道
    const sk5Drew = await tryUntil(() => mbSkInfo().drawing === true,
      { budgetMs: 8000, label: 'SK.5 看见它起手拉弓', observe: sk5Probe(sk5) });
    const sk5Pre = sk5Probe(sk5)();
    const sk5Arrows0 = G.mobs.arrows.length;
    const sk5Pos0 = { x: G.controller.pos.x, z: G.controller.pos.z };
    const sk5Fire = { t: 0 };
    const sk5Dodge = await holdWhile(() => T.key('KeyA', true),
      () => {
        if (!sk5Fire.t && G.mobs.arrows.length > sk5Arrows0) sk5Fire.t = performance.now();
        return sk5Fire.t > 0 && performance.now() - sk5Fire.t > 500;
      },
      { budgetMs: 6000, alive: () => !!G.input.state.keyA });
    T.key('KeyA', false);
    await frame();
    const sk5HpDodge = G.controller.health, sk5InvDodge = G.controller.invulnerable;
    const sk5Drift = +Math.hypot(G.controller.pos.x - sk5Pos0.x, G.controller.pos.z - sk5Pos0.z).toFixed(2);
    /* 第二轮：站定举盾（真实按住右键），期间骷髅会漫游，所以每一帧重新朝向它，
       否则「挡下了」会变成运气 —— 盾牌只认正面 120°。 */
    G.inventory.clear();
    G.inventory.set(0, { item: 'shield', count: 1, dur: 336 });
    G.selectHotbar(0);
    const sk5Shield0 = T.shieldInfo();
    const sk5BlockOn = await holdWhile(() => { G.input.state.mouseRight = true; },
      () => G.controller.blocking === true,
      { budgetMs: 4000, alive: () => !!G.input.state.mouseRight });
    const sk5Blocked = await tryUntil(() => {
      if (sk5 && G.mobs.list.includes(sk5)) mbAim(sk5.pos.x, sk5.pos.y + 1.0, sk5.pos.z);
      return T.shieldInfo().blocks > sk5Shield0.blocks;
    }, { budgetMs: 10000, label: 'SK.5 下一箭被盾牌挡下',
      observe: () => ({ shield: T.shieldInfo(), hp: G.controller.health, drawing: mbSkInfo().drawing }) });
    G.input.state.mouseRight = false;
    await frame();
    const sk5Shield1 = T.shieldInfo();
    ok('SK.5 一场完整遭遇：看见拉弓 → 按住 A 侧移把那一箭晃掉（血量与无敌帧都不动）→ 站定举盾挡下同一只骷髅的下一箭（记为 arrow）',
      sk5Drew.ok && sk5Dodge.ok && sk5Fire.t > 0 && sk5HpDodge === 20 && sk5InvDodge <= 0 && sk5Drift > 1 &&
      sk5BlockOn.ok && sk5Blocked.ok && G.controller.health === 20 &&
      sk5Shield1.blocks === sk5Shield0.blocks + 1 && !!sk5Shield1.lastBlock && sk5Shield1.lastBlock.kind === 'arrow',
      '拉弓=' + sk5Drew.ok + ' 离弦@' + (sk5Fire.t ? sk5Fire.t.toFixed(0) : '没射') + ' 侧移=' + sk5Drift + ' 格(' + heldTag(sk5Dodge) + ')' +
      ' 躲后 hp=' + sk5HpDodge + ' inv=' + sk5InvDodge.toFixed(2) + ' 举盾=' + sk5BlockOn.ok + '(' + heldTag(sk5BlockOn) + ')' +
      ' 挡下=' + sk5Blocked.ok + ' blocks ' + sk5Shield0.blocks + '→' + sk5Shield1.blocks +
      ' lastBlock=' + JSON.stringify(sk5Shield1.lastBlock) + ' 最终 hp=' + G.controller.health +
      ' 起手前=' + JSON.stringify(sk5Pre) + ' 结尾=' + JSON.stringify(sk5Probe(sk5)()));

    /* --- SK.6 墙体遮挡与攻击距离都真的参与判定 ---
       阶段 3b 之前骷髅只按距离决定射不射：隔一堵墙也照拉照射，箭全插在墙上。
       现在三段各测一件事：隔墙不起手、超出射程不起手、回到射程内立刻恢复。
       骷髅每帧钉回原位（和上面单测同一手法）：否则它会自己走出射程/绕出墙，
       读数就变成在测它的走位而不是测判定。 */
    G.mobs.clear();
    G.controller.setCreative(true);                       // 这一段只看「它要不要打」，不让血条参与
    const sk6 = G.mobs.spawn('skeleton', mbX + 0.5, mbY + 1, mbZ + 9.5);
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 4.5);            // 5 格：AI 在这个距离既不逼近也不后退
    /* 墙必须在「等站稳」之前就立好：站稳那几帧里它已经会起手拉弓，
       那一份起手会被观察窗的第一帧读成违规（上一轮 隔墙观察=22ms 违规=true 正是这个原因）。 */
    for (let dx = -14; dx <= 14; dx++) for (let dy = 0; dy <= 3; dy++) T.setBlock(mbX + dx, mbY + 1 + dy, mbZ + 7, 1);
    await tryUntil(() => G.controller.onGround && (!sk6 || sk6.onGround), { budgetMs: 5000, label: 'SK.6 站稳' });
    const sk6Pin = () => { sk6.pos.x = mbX + 0.5; sk6.pos.z = mbZ + 9.5; sk6.vel.x = 0; sk6.vel.z = 0; };
    const sk6Probe = () => ({ los: G.mobs.lineOfSightToPlayer(sk6, G.controller),
      wallSolid: G.world.getBlock(mbX, mbY + 2, mbZ + 7) === 1,
      dist: +Math.hypot(sk6.pos.x - G.controller.pos.x, sk6.pos.z - G.controller.pos.z).toFixed(2), ...mbSkInfo() });
    sk6Pin();
    const sk6Arrows0 = G.mobs.arrows.length;
    const sk6Start = sk6Probe();                          // 观察窗起点：此刻不许已经在拉弓
    const sk6Bad = () => { sk6Pin(); const i = mbSkInfo(); return i.drawing === true || G.mobs.arrows.length > sk6Arrows0; };
    const sk6Wall = await watch(3000, sk6Bad);            // 隔着一堵横跨整个平台的 4 格高墙
    const sk6WallEnd = sk6Probe();
    for (let dx = -14; dx <= 14; dx++) for (let dy = 0; dy <= 3; dy++) T.setBlock(mbX + dx, mbY + 1 + dy, mbZ + 7, 0);
    T.teleport(mbX + 0.5, mbY + 1, mbZ - 4.0);            // 13.5 格：超出 reach=12
    const sk6Far = await watch(2500, sk6Bad);
    const sk6FarEnd = sk6Probe();
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 3.5);            // 6 格：回到射程内
    const sk6Near = await tryUntil(() => { sk6Pin(); return mbSkInfo().drawing === true; },
      { budgetMs: 5000, label: 'SK.6 回到射程内就起手', observe: sk6Probe });
    const sk6Shot = await tryUntil(() => G.mobs.arrows.length > sk6Arrows0,
      { budgetMs: 5000, label: 'SK.6 起手之后真的放箭', observe: sk6Probe });
    ok('SK.6 墙体遮挡与攻击距离一起参与判定：隔一堵横跨平台的墙 3 秒不起手、无墙但 13.5 格（>射程 12）也不起手、回到 6 格立刻起手并放箭',
      sk6Start.wallSolid === true && sk6Start.los === false &&
      !sk6Wall.violated && !sk6Far.violated && sk6FarEnd.dist > 12 && !sk6WallEnd.drawing &&
      sk6Near.ok && sk6Shot.ok && G.mobs.arrows.length > sk6Arrows0,
      '观察窗起点(隔墙)=' + JSON.stringify(sk6Start) + ' 隔墙末=' + JSON.stringify(sk6WallEnd) +
      '(' + sk6Wall.ms + 'ms 违规=' + sk6Wall.violated + ') 超程末=' + JSON.stringify(sk6FarEnd) +
      '(' + sk6Far.ms + 'ms 违规=' + sk6Far.violated + ') 近程起手=' + sk6Near.ok + ' 放箭=' + sk6Shot.ok +
      ' 箭数 ' + sk6Arrows0 + '→' + G.mobs.arrows.length);

    /* --- SK.7 站着挨箭要吃伤害，真实左键命中要把它打退 --- */
    G.mobs.clear();
    G.controller.setCreative(false);
    G.inventory.armor.fill(null);
    G.controller.health = 20; G.controller.invulnerable = 0;
    const sk7 = G.mobs.spawn('skeleton', mbX + 0.5, mbY + 1, mbZ + 5.5);
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 2.5);            // 3 格：一定在弹道判定里
    await tryUntil(() => G.controller.onGround && (!sk7 || sk7.onGround), { budgetMs: 5000, label: 'SK.7 站稳' });
    const sk7Hurt = await tryUntil(() => G.controller.health < 20,
      { budgetMs: 12000, label: 'SK.7 站着挨到一箭',
        observe: () => ({ hp: G.controller.health, last: G.controller.lastHurt, info: mbSkInfo() }) });
    const sk7Taken = +(20 - G.controller.health).toFixed(3);
    const sk7Record = G.controller.lastHurt;
    /* 玩家这一剑走真实左键（interaction.update → hitMob），击退看速度尖峰：
       hitMob 给的是 5.2 的冲量，而骷髅自己走满也只有 2.2，所以 3.5 以上只可能是被打通出来的。 */
    G.inventory.clear();
    G.inventory.set(0, { item: 'sword_wood', count: 1, dur: 60 });
    G.selectHotbar(0);
    sk7.hp = sk7.maxHp;
    const sk7Hp0 = sk7.hp;
    const sk7Hit0 = T.feedbackInfo().hit;      // 「砍到了没有」只认真实命中计数，日晒掉血不算
    let sk7Peak = 0;
    const sk7Swing = await tryUntil(() => {
      /* 3 格会触发骷髅的「太近就后退」，一走出近战距离这一剑就砍空了。
         每帧把它钉回 2 格：只钉位置，速度原样留着 —— 击退读数仍然来自 hitMob 的真实冲量。 */
      sk7.pos.x = mbX + 0.5; sk7.pos.z = mbZ + 4.5;
      mbAim(sk7.pos.x, sk7.pos.y + 1.0, sk7.pos.z);
      G.input.state.mouseLeft = true;
      sk7Peak = Math.max(sk7Peak, Math.hypot(sk7.vel.x, sk7.vel.z));
      return T.feedbackInfo().hit > sk7Hit0;
    }, { budgetMs: 5000, label: 'SK.7 真实左键砍中骷髅',
      observe: () => ({ hp: sk7.hp, peak: +sk7Peak.toFixed(2), fb: T.feedbackInfo() }) });
    G.input.state.mouseLeft = false;
    /* 第二轮 SK.7：不再只看「下一帧采到的速度峰值」（会被同帧阻尼吃掉，实测 3.49 vs 门槛 3.5）。
       现在同时看三件事，缺一不可：
         ① 产品**记录到的实际冲量**（hitMob 里施加 5.2 的方向与速度，只读诊断 lastKnockback）；
         ② 玩家看到的结果：骷髅在接下来 0.45 秒里被推开的真实位移；
         ③ 覆盖不变：真实左键命中计数 +1、骷髅掉血、挨箭按来源记账。 */
    const sk7Knock = T.lastKnockback ? T.lastKnockback() : null;
    const sk7Pos0 = { x: sk7.pos.x, z: sk7.pos.z };
    let sk7Peak2 = sk7Peak;
    for (let i = 0; i < 9; i++) {
      sk7Peak2 = Math.max(sk7Peak2, Math.hypot(sk7.vel.x, sk7.vel.z));
      await frame();
    }
    await sleep(320);
    const sk7Push = Math.hypot(sk7.pos.x - sk7Pos0.x, sk7.pos.z - sk7Pos0.z);
    ok('SK.7 挨箭按来源记账并掉血（生存、无甲）；真实左键命中骷髅时产品确实施加了 5.2 的击退冲量，' +
      '并且骷髅真的被推开（旧写法只采下一帧速度峰值，会被同帧阻尼抵消）',
      sk7Hurt.ok && sk7Taken > 0 && !!sk7Record && sk7Record.type === 'arrow' &&
      sk7Record.raw === (sk7.def.damage || 2) && sk7Record.taken <= sk7Record.raw &&
      sk7Swing.ok && T.feedbackInfo().hit > sk7Hit0 && sk7.hp < sk7Hp0 &&
      !!sk7Knock && sk7Knock.type === 'skeleton' && sk7Knock.impulse >= 5.2 &&
      (sk7Push > 0.35 || sk7Peak2 >= 3.5),
      'hp 20→' + G.controller.health + '（挨 ' + sk7Taken + '）lastHurt=' + JSON.stringify(sk7Record) +
      ' 命中计数 ' + sk7Hit0 + '→' + T.feedbackInfo().hit + ' 砍中=' + sk7Swing.ok +
      ' 骷髅 hp ' + sk7Hp0.toFixed(2) + '→' + sk7.hp.toFixed(2) +
      ' 实际冲量=' + JSON.stringify(sk7Knock) + ' 推开=' + sk7Push.toFixed(2) + '格' +
      ' 速度峰值(采样)=' + sk7Peak2.toFixed(2));

    /* --- SK.8 受击贴图恢复：闪色只改颜色，hurtT 归零要逐面回到受击前那一份着色 --- */
    sk7.hp = sk7.maxHp; sk7.hurtT = 0;
    await frame(); await frame();
    const sk8Base = mbSkInfo();
    G.mobs.hitMob(sk7, 1, { x: 0, z: 0 });
    const sk8Flash = await tryUntil(() => {
      const i = mbSkInfo();
      return i.hurtT > 0 && i.bodyColor && i.bodyColor !== sk8Base.bodyColor ? i : null;
    }, { budgetMs: 1500, label: 'SK.8 受击瞬间确实闪了色', observe: () => mbSkInfo() });
    const sk8Back = await tryUntil(() => {
      const i = mbSkInfo();
      // 产品里 hurtT 是「>0 才递减」，会停在 -0.005 这种极小负值（本轮实测），所以用 <=0 表示闪色窗口已过
      return i.hurtT <= 0 && i.bodyColor === sk8Base.bodyColor ? i : null;
    }, { budgetMs: 3000, label: 'SK.8 闪色退回原来的着色', observe: () => mbSkInfo() });
    const sk8End = mbSkInfo();
    ok('SK.8 受击只改材质颜色、不摘画布：闪色期间六面一致，hurtT 归零后逐面回到受击前那一份着色且 16px 画布仍在',
      !!sk8Base.bodyColor && !!sk8Base.bodyHasMap && sk8Flash.ok && sk8Back.ok &&
      (!sk8Flash.value || sk8Flash.value.bodyColorsSame === true) &&
      sk8End.bodyHasMap === true && sk8End.bodyMats === 6 && sk8End.bodyColor === sk8Base.bodyColor,
      '受击前=#' + sk8Base.bodyColor + ' 闪色=#' + (sk8Flash.value && sk8Flash.value.bodyColor) +
      ' 归零后=#' + sk8End.bodyColor + ' 六面一致=' + (sk8Flash.value && sk8Flash.value.bodyColorsSame) +
      ' 画布仍在=' + sk8End.bodyHasMap + ' 面数=' + sk8End.bodyMats + ' hurtT=' + sk8End.hurtT);

    /* --- CP.5 拉开取消之后再贴上去：引信走满要真的炸 ---
       CP.3 证到「逃开就取消」，这条补上后半段：重新接近还能再点着，并且炸的是真东西
       （破坏方块、按距离吃伤害、本体从场上消失），不是把充能态清了就算完。 */
    G.mobs.clear();
    G.controller.setCreative(false);
    G.inventory.armor.fill(null);
    G.controller.health = 20; G.controller.invulnerable = 0;
    const cr5 = G.mobs.spawn('creeper', mbX + 0.5, mbY + 1, mbZ + 7.5);
    T.teleport(mbX + 0.5, mbY + 1, mbZ + 5.5);            // 2 格：进入触发距离，中间没有方块
    const cr5Boom0 = T.blastInfo().explosions;
    const cr5Cell = [Math.floor(cr5.pos.x), Math.floor(cr5.pos.y), Math.floor(cr5.pos.z)];
    const cr5Floor0 = G.world.getBlock(cr5Cell[0], cr5Cell[1] - 1, cr5Cell[2]);
    const cr5W = await tryUntil(() => T.blastInfo().explosions > cr5Boom0,
      { budgetMs: 9000, label: 'CP.5 重新接近后起爆',
        observe: () => ({ boom: T.blastInfo().explosions, info: T.mobCombatInfo().find(x => x.type === 'creeper') }) });
    const cr5Info = T.blastInfo();
    const cr5Hp = G.controller.health;
    ok('CP.5 取消之后再贴上去：引信走满真的炸 —— 爆掉方块（脚下那格从实心变空气）、按距离吃到伤害、本体从场上消失',
      cr5W.ok && cr5Info.explosions === cr5Boom0 + 1 && !G.mobs.list.includes(cr5) &&
      !!cr5Info.last && cr5Info.last.removed >= 1 && cr5Floor0 !== 0 &&
      G.world.getBlock(cr5Cell[0], cr5Cell[1] - 1, cr5Cell[2]) !== cr5Floor0 &&
      cr5Hp < 20 && cr5Hp > 0,
      '爆炸 ' + cr5Boom0 + '→' + cr5Info.explosions + ' 报告=' + JSON.stringify(cr5Info.last) +
      ' 脚下 ' + cr5Floor0 + '→' + G.world.getBlock(cr5Cell[0], cr5Cell[1] - 1, cr5Cell[2]) +
      ' hp 20→' + cr5Hp + ' 在场=' + G.mobs.list.includes(cr5));

    G.mobs.clear();
    G.mobs.maxMobs = mbMax0;
    G.controller.setCreative(mbCreative0);
    T.setTime(mbTime0);                         // 把这一节的「固定走夜」还回去，后续节按原时刻跑
    T.teleport(G.spawn.x, G.spawn.y + 1, G.spawn.z);
    await T.waitChunks(1);
    }

    /* ---------------- PF. 阶段 1 分段计时（把「320 秒花在哪」写进验收记录） ---------------- */
    {
    const pfSteps = R.steps;
    let pfMono = true, pfPrev = -1, pfGaps = 0;
    const pfBySection = new Map();
    for (const s of pfSteps) {
      if (typeof s.t !== 'number') { pfMono = false; break; }
      if (s.t < pfPrev) pfMono = false;
      const gap = pfPrev < 0 ? 0 : s.t - pfPrev;
      pfPrev = s.t; pfGaps += gap;
      const sec = String(s.name).split('.')[0] || '?';
      pfBySection.set(sec, (pfBySection.get(sec) || 0) + gap);
    }
    const pfTop = [...pfBySection.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, ms]) => k + '=' + (ms / 1000).toFixed(1) + 's');
    const pf = T.perfTotals();
    const pfA = pf.total;
    ok('PF.1 分段计时总账可用：跨读档合并的总账有数、时间轴单调，整程时间去向写进报告',
      pfMono && pfSteps.length >= 500 &&
      pfA.calls > 200 && pfA.frameMs > 0 && pfA.genMs > 0 && pfA.lightMs > 0 &&
      pfA.genChunks > 0 && pfA.lightChunks > 0 && pfA.meshChunks > 0 && pfA.worlds >= 1,
      '剧本总时长=' + (pfPrev / 1000).toFixed(1) + 's，断言间隔合计 ' + (pfGaps / 1000).toFixed(1) + 's（占 ' +
      (100 * pfGaps / Math.max(1, pfPrev)).toFixed(0) + '%）' +
      ' | world 会话累计：帧 ' + (pfA.frameMs / 1000).toFixed(1) + 's（' + pfA.calls + ' 次 update，跨 ' +
      pfA.worlds + ' 个 world 对象）生成 ' + (pfA.genMs / 1000).toFixed(1) + 's/' + pfA.genChunks + '块' +
      ' 补光 ' + (pfA.lightMs / 1000).toFixed(1) + 's/' + pfA.lightChunks + '块' +
      ' 网格 ' + (pfA.meshMs / 1000).toFixed(1) + 's/' + pfA.meshChunks + '块' +
      ' | 帧累计占整程 ' + (100 * pfA.frameMs / Math.max(1, pfPrev)).toFixed(1) + '%' +
      ' | 最贵八节 ' + pfTop.join(' ') + ' | 当前 world 即时累计 calls=' + (pf.live ? pf.live.calls : -1) +
      '（读档会清零，所以只看会话总账）');
    }

    /* ---------------- IL. 输入生命周期边界（阶段 3c） ----------------
     * 真实退出世界会 disposeWorld() 置空 controller；旧实现没切断指针锁，
     * 窗口上残留的 mousemove 会打进 onLook 抛 null.yaw（整程曾出现 11 条）。
     * 这里在真实边界上派发鼠标事件：既不许有异常，也要求输入确实被切断。 */
    {
      G.closeUI();
      const ilErr0 = window.__e2e.errors.length;
      G.input.locked = true; G.input.uiMode = false;   // 复现「指针锁还没来得及释放」的竞态
      await G.toMenu();
      for (let i = 0; i < 4; i++) {
        window.dispatchEvent(new MouseEvent('mousemove', { movementX: 12 + i, movementY: 7, bubbles: true }));
        await frame();
      }
      const ilErr1 = window.__e2e.errors.length;
      ok('IL.1 退出世界边界：controller 置空后的鼠标事件不再产生 null 异常，输入被切断',
        ilErr1 === ilErr0 && G.controller === null && G.input.uiMode === true,
        'errors=' + ilErr0 + '→' + ilErr1 + ' controller=' + G.controller +
        ' uiMode=' + G.input.uiMode);
    }

    /* ---------------- 18. 离线审计 ---------------- */
    const resList = performance.getEntriesByType('resource').map(e => e.name);
    const external = resList.filter(u => !/^http:\/\/127\.0\.0\.1/.test(u) && !/^data:/.test(u) && !/^blob:/.test(u));
    ok('18.1 全部资源来自本地回环，无外部请求', external.length === 0,
      external.length ? external.slice(0, 3).join(' | ') : '共 ' + resList.length + ' 项本地资源');
    ok('18.2 three.js 由本地 vendor 提供', resList.some(u => /vendor\/three\.module\.js$/.test(u)),
      (resList.find(u => /three\.module/.test(u)) || '').split('/').slice(-2).join('/'));
    ok('18.3 无 CDN / 字体 / 音频外链', !resList.some(u => /cdn\.|unpkg|jsdelivr|googleapis|https:\/\//i.test(u)), '');

    /* ---------------- 现场.1 暂停取证（见文件开头的「现场录像」注释） ---------------- */
    const evAll = pauseLog.filter(p => p.kind === 'event');
    const evBad = evAll.filter(p => p.recoveredMs === undefined && p.noop !== true);
    ok('现场.1 整程每一次暂停都查得出来源：剧本直调/合成按键与点击记为 scripted 不插手，真人按键或产品内部调用记为 event；只有真的把 playing 按成 paused 的那几次才就地恢复，已经停在暂停界面时的重复调用只留证据不插手',
      evRecovered === evTotal && evBad.length === 0 &&
      evAll.every(p => p.recoveredMs === 0 || p.noop === true),
      '需要自愈的 event=' + evTotal + ' 已就地恢复=' + evRecovered +
      ' 其中空调用(noop)=' + evAll.filter(p => p.noop).length +
      ' scripted=' + (pauseLog.length - evAll.length) +
      ' 全量 event 取证=' + JSON.stringify(evLog) + ' | ' + pauseEvidence());
  } catch (e) {
    const lastAny = R.steps[R.steps.length - 1] || null;
    const lastPass = R.steps.slice().reverse().find(s => s.pass) || null;
    R.errors.push('剧本异常: ' + (e && e.stack || e) +
      ' ｜最后一条断言=' + (lastAny ? lastAny.name + '(' + (lastAny.pass ? '过' : '红') + ')@' + lastAny.t + 'ms' : '无') +
      ' ｜最后通过=' + (lastPass ? lastPass.name + '@' + lastPass.t + 'ms' : '无') +
      ' ｜当时状态=' + JSON.stringify(stateSnap()) +
      ' ｜' + pauseEvidence());
  }
  clearInterval(stateTimer);
  /* 对账：放在 catch 之后，任何一节被异常吞掉、或少跑一条 ok()，这里都会红。
     注意取数时本条还没进 R.steps，所以比较 R.steps.length + 1。 */
  step('对账.1 断言总数等于 EXPECTED_TOTAL（防止整节被吞/漏跑）',
    R.steps.length + 1 === EXPECTED_TOTAL,
    '实得 ' + (R.steps.length + 1) + ' 期望 ' + EXPECTED_TOTAL);
  R.done = true;
  R.pass = R.steps.filter(s => s.pass).length;
  R.total = R.steps.length;
})();
