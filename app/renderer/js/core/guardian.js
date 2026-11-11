'use strict';
/*
 * 阶段 5 地牢守卫：纯状态逻辑（不依赖 THREE / DOM，可在 Node 里无头单测）。
 *
 * 设计边界：这是本作原创的过渡型小 Boss，不是末影龙复刻。
 * 状态按「地点稳定 ID」持久化，旧档缺字段一律回落「未挑战」。
 * 数值全部是本作设计约定；伤害还得再过一遍 melee 的墙体/距离与盾牌格挡，
 * 这个文件只算「该造成多少」，不负责实际扣血（由调用方结算，便于验收）。
 */
import { B } from './blocks.js';

export const GUARDIAN_HP = 60;
export const GUARDIAN_TRIGGER = 12;       // 玩家进这个半径才唤醒
export const GUARDIAN_LEASH = 26;         // 走更远就回位、恢复满血（可以撤退补给）
export const GUARDIAN_IDLE_SECONDS = 0.55;

/* 战前准备：遗迹四角的封印石座。往每个石座上放一块**深板岩**才算解开封印，
   四块齐了守卫才会醒来。深板岩只出现在 y<0 的深层（阶段 1 的岩层分带），
   所以「备装」这一步天然要把玩家赶去负 Y 矿层 —— 这就是准备材料与深矿的动机链。
   数值是本作设计约定：4 块、石座间距 4 格。 */
export const GUARDIAN_WARDS = 4;
export const GUARDIAN_WARD_OFFSETS = Object.freeze([[4, 0], [-4, 0], [0, 4], [0, -4]]);

/** 石座的世界坐标（按地点中心 + 固定偏移；整数格便于放方块与验证） */
export function guardianWardSpots(x, z) {
  return GUARDIAN_WARD_OFFSETS.map(([dx, dz]) => ({ x: Math.floor(x) + dx, z: Math.floor(z) + dz }));
}

/** 封印是否解开：只有「四座都放了深板岩」才算；缺一块都不行。 */
export function guardianArmed(wardCount) {
  return Number(wardCount) >= GUARDIAN_WARDS;
}

export const GUARDIAN_PHASE = Object.freeze({
  DORMANT: 'dormant',     // 未靠近，站着不动
  IDLE: 'idle',           // 已唤醒，等下一次出招
  TELEGRAPH: 'telegraph', // 前摇：模型抬手 / 音效 / HUD 提示，玩家来得及躲或举盾
  STRIKE: 'strike',       // 出招瞬间（只占一帧，结算在下一条 tick 前完成）
  RECOVER: 'recover',     // 硬直：反击窗口
  DEAD: 'dead'            // 已击败，等领奖
});

export const GUARDIAN_ATTACKS = Object.freeze({
  /* 近身横扫：有前摇、伤害高、可以被盾格挡；受墙体与距离限制 */
  slam: Object.freeze({ id: 'slam', telegraph: 0.85, recover: 1.25, damage: 7, reach: 3.4, blockable: true }),
  /* 远程光弹：前摇更长、伤害低、不能被盾完全挡下（但可以躲进墙后） */
  bolt: Object.freeze({ id: 'bolt', telegraph: 1.15, recover: 1.60, damage: 5, reach: 14, blockable: false })
});
export const GUARDIAN_ATTACK_IDS = Object.freeze(Object.keys(GUARDIAN_ATTACKS));

/* 与负 Y 深矿/装备路线相连的奖励：下矿拿到的东西在这里变成「值得打」的回报。
   全部使用既有物品 ID，不新增物品表条目。 */
export const GUARDIAN_REWARD = Object.freeze([
  { item: 'diamond', count: 2 },
  { item: 'iron_ingot', count: 6 },
  { item: 'emerald', count: 2 },
  { item: 'gold_ingot', count: 3 }
]);

/** 地点稳定 ID：同一个地标无论读几次档都是同一个键 */
export function guardianSiteKey(lm) {
  if (!lm) return 'g:unknown';
  return 'g:' + String(lm.id !== undefined ? lm.id : (lm.x + ',' + lm.z));
}

/** 未挑战的默认状态。所有字段都是标量（pedestals 是坐标数组），方便存档 diff 与旧档回落。 */
export function defaultGuardianState(siteKey = 'g:unknown') {
  return {
    siteKey: String(siteKey), hp: GUARDIAN_HP, phase: GUARDIAN_PHASE.DORMANT,
    attack: null, t: 0, defeated: 0, rewardClaimed: 0, attempts: 0,
    pedestals: null      /* 石座坐标一次落盘；旧档为 null，下次扫描时补建 */
  };
}

/** 旧档缺字段 / 脏值一律回落；已击败的档即使缺 hp 也不能复活。 */
export function normalizeGuardianState(raw, siteKey = 'g:unknown') {
  const d = defaultGuardianState(siteKey);
  if (!raw || typeof raw !== 'object') return d;
  const defeated = raw.defeated === 1 || raw.defeated === true ? 1 : 0;
  const hp = Number.isFinite(raw.hp) ? Math.max(0, Math.min(GUARDIAN_HP, raw.hp | 0)) : (defeated ? 0 : d.hp);
  /* 临时相位不跨读档：STRIKE / TELEGRAPH / RECOVER 一律回到 DORMANT，
     由玩家再靠近时重新唤醒。这样「战斗中退出重进」不会凭空挨一发。 */
  const persistent = defeated ? GUARDIAN_PHASE.DEAD : GUARDIAN_PHASE.DORMANT;
  const ped = Array.isArray(raw.pedestals)
    ? raw.pedestals.filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))
      .slice(0, GUARDIAN_WARDS).map(p => ({ x: p.x | 0, y: p.y | 0, z: p.z | 0 }))
    : null;
  return {
    siteKey: typeof raw.siteKey === 'string' && raw.siteKey ? raw.siteKey : d.siteKey,
    hp: defeated ? 0 : hp,
    phase: persistent,
    attack: null, t: 0,
    defeated,
    rewardClaimed: raw.rewardClaimed === 1 || raw.rewardClaimed === true ? 1 : 0,
    attempts: Number.isFinite(raw.attempts) ? Math.max(0, raw.attempts | 0) : 0,
    pedestals: ped && ped.length ? ped : null
  };
}

/** 近了用横扫、远了用光弹；边界带里给一点随机，避免玩家站一个点永只吃同一招。 */
export function pickGuardianAttack(dist, rng = Math.random) {
  const r = Number(rng());
  if (dist <= GUARDIAN_ATTACKS.slam.reach + 0.6) return 'slam';
  if (dist > GUARDIAN_ATTACKS.bolt.reach) return 'slam';
  return r < 0.72 ? 'bolt' : 'slam';
}

/**
 * 一次攻击最终打多少：墙体 > 距离，顺序固定便于单测。
 * **格挡不在这里结算**：横扫用 `melee` 类型交给 controller 的盾牌扇区判定（正面 120° 可完全挡下），
 * 光弹用 `guardian_bolt`（盾挡不住，只能躲墙后）。这里只给「这一招本来该打多少」与它能不能被盾挡，
 * 避免「守卫先扣一次、controller 又扣一次」的双重结算。
 * wallBetween 与 LoS 由调用方用 world 的射线判定后传进来。
 */
export function guardianDamage(attackId, opts = {}) {
  const a = GUARDIAN_ATTACKS[attackId];
  if (!a) return { damage: 0, why: 'unknown-attack', blockable: false };
  const dist = Number(opts.dist);
  if (opts.wallBetween) return { damage: 0, why: 'wall', blockable: a.blockable };
  if (Number.isFinite(dist) && dist > a.reach) return { damage: 0, why: 'range', blockable: a.blockable };
  return { damage: a.damage, why: 'hit', blockable: a.blockable };
}

/** 这一招该用哪种伤害类型结算：能挡的走 melee（吃盾与护甲），不能挡的单独一种（只吃护甲之外的全额）。 */
export function guardianDamageType(attackId) {
  const a = GUARDIAN_ATTACKS[attackId];
  return a && a.blockable ? 'melee' : 'guardian_bolt';
}

/** 奖励按次数结算：每个地点、每次击败只给一次。 */
export function claimGuardianReward(state) {
  if (!state || !state.defeated || state.rewardClaimed) return null;
  return GUARDIAN_REWARD.map(r => ({ item: r.item, count: r.count }));
}

/* ============================================================
 * 阶段 5 / 本轮 A3：守卫站位选择（纯逻辑，只要 world 的只读接口）
 *
 * 旧实现直接取 `topSolidY(中心x, 中心z)+1`。前哨中心正好压在 5×5 木板屋顶上，
 * 于是守卫落在 y=56、脚下 y=55 是木板屋顶 —— 玩家在地面只能仰头看着它，
 * 打不到也走不过去。这里改成「按可站立地面与净空选点」：
 *   · 站立面必须是自然地面（草地/泥土/石/沙…），排除木板、原木、树叶、玻璃、
 *     黑曜石石座、容器火把等人造物 —— 屋顶与树冠因此在判据里就被排除；
 *   · 地面之上要有 headroom 格连续空气（守卫高 2.35，低矮的室内不够它站）；
 *   · 与地点中心同一台面（|Δy| ≤ yTol），避免站到陡壁或树上去；
 *   · 从 ringMin 起步绕开建筑足迹（前哨 5×5，ring≥3 一定在墙外）。
 * 返回 { x, y, z, ok, ring, ground, fallback }，y 是**脚底**所在格（地面 + 1）。
 * ============================================================ */
export const GUARDIAN_STAND_RING_MIN = 3;
export const GUARDIAN_STAND_RING_MAX = 12;
export const GUARDIAN_STAND_HEADROOM = 4;
export const GUARDIAN_STAND_YTOL = 2;

const ARTIFICIAL_STAND = new Set([
  B.PLANKS, B.BIRCH_PLANKS, B.LOG, B.BIRCH_LOG, B.LEAVES, B.BIRCH_LEAVES,
  B.GLASS, B.OBSIDIAN, B.CHEST, B.TORCH, B.CRAFTING_TABLE, B.FURNACE
]);
export function isArtificialStand(id) { return ARTIFICIAL_STAND.has(id); }

/** 单列判定：能不能当守卫的站立点。read 需要 getBlock / topSolidY / isSolidAt。 */
export function guardianStandColumn(read, x, z, refY, opts = {}) {
  const headroom = Number.isFinite(opts.headroom) ? opts.headroom : GUARDIAN_STAND_HEADROOM;
  const yTol = Number.isFinite(opts.yTol) ? opts.yTol : GUARDIAN_STAND_YTOL;
  if (!read || typeof read.topSolidY !== 'function' || typeof read.getBlock !== 'function') {
    return { ok: false, why: 'no-reader' };
  }
  const gy = read.topSolidY(x, z);
  const ground = read.getBlock(x, gy, z);
  if (ground === B.WATER) return { ok: false, why: 'water', y: gy + 1, ground };
  if (isArtificialStand(ground)) return { ok: false, why: 'artificial', y: gy + 1, ground };
  if (Math.abs(gy - refY) > yTol) return { ok: false, why: 'terrace', y: gy + 1, ground, gy };
  /* 净空：守卫身体占 2 格，再加头顶余量。树叶按阻挡算（站在树冠下不算开阔战场）。 */
  for (let dy = 1; dy <= headroom; dy++) {
    const id = read.getBlock(x, gy + dy, z);
    const solid = typeof read.isSolidAt === 'function' ? read.isSolidAt(x, gy + dy, z) : (id !== B.AIR);
    if (solid || id === B.LEAVES || id === B.BIRCH_LEAVES || id === B.WATER) {
      return { ok: false, why: 'headroom', y: gy + 1, ground, blockedAt: dy };
    }
  }
  /* 开阔度（本轮 A3 补）：四个水平邻格在脚下与胸口高度都要空。
     守卫现在真的会追人（A2），站位贴着墙/石座时玩家一贴身就被挤进方块，
     近战射线先撞墙、刀就砍空了。要求一圈空地以后，站位会自然退到遗迹外的空地。 */
  const solidAt = (ax, ay, az) => (typeof read.isSolidAt === 'function'
    ? read.isSolidAt(ax, ay, az) : (read.getBlock(ax, ay, az) !== B.AIR));
  let open = true;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (solidAt(x + dx, gy + 1, z + dz) || solidAt(x + dx, gy + 2, z + dz)) { open = false; break; }
  }
  if (!open && opts.requireOpen !== false) return { ok: false, why: 'tight', y: gy + 1, ground, gy };
  return { ok: true, why: 'ok', x, z, y: gy + 1, gy, ground, open };
}

/**
 * 在地点周围挑一个能走到、能开打的站位。
 * 顺序固定（先按「与站点地面同高」分档，再按环号升序，再按固定方位序），
 * 同种子同地点永远选同一格，取证可复现。
 *
 * 分档理由：废墟的 ring3 正好是断墙线，墙顶是圆石（不是人造方块）；
 * 若只按环号取最近，守卫会站到墙顶上去。所以先要求「脚下地面与站点同高」，
 * 再优先取建筑足迹之外的第一环（ring 4 起）—— 那是真正的空地，玩家绕得过去。
 */
export function chooseGuardianStand(read, site, opts = {}) {
  const ringMin = Number.isFinite(opts.ringMin) ? opts.ringMin : GUARDIAN_STAND_RING_MIN;
  const ringMax = Number.isFinite(opts.ringMax) ? opts.ringMax : GUARDIAN_STAND_RING_MAX;
  const cx = Math.floor(site ? site.x : 0), cz = Math.floor(site ? site.z : 0);
  const refY = Number.isFinite(site && site.y) ? site.y : 0;

  /* 分档：[环起点, 环终点, 允许的 |Δy|, 是否要求四周开阔] */
  const phases = [
    [Math.max(4, ringMin), Math.min(10, ringMax), 0, true],
    [ringMin, ringMax, 0, true],
    [Math.max(4, ringMin), ringMax, 1, true],
    [ringMin, ringMax, 1, true],
    [ringMin, ringMax, GUARDIAN_STAND_YTOL, true],
    [ringMin, ringMax, GUARDIAN_STAND_YTOL, false]     // 最后一档：放宽开阔度，免得退回屋顶
  ];
  let tried = 0;
  for (const [r0, r1, yTol, needOpen] of phases) {
    for (let r = r0; r <= r1; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // 只扫这一环
          const c = guardianStandColumn(read, cx + dx, cz + dz, refY,
            Object.assign({}, opts, { yTol, requireOpen: needOpen }));
          tried++;
          if (c.ok) return Object.assign({ ok: true, fallback: false, ring: r, tried, yTol, open: c.open }, c);
        }
      }
    }
  }
  /* 兜底：保持旧语义（中心最上方实心格 + 1），但把 fallback 标出来，验收能看见「没找到合规站位」。 */
  const gy = (read && typeof read.topSolidY === 'function') ? read.topSolidY(cx, cz) : refY;
  return { ok: true, fallback: true, x: cx, z: cz, y: gy + 1, gy, ground: -1, ring: 0, why: 'fallback', tried };
}

/**
 * 推进一帧，返回 { state, events }。纯函数：不改入参，不碰世界。
 * ctx = { dist, playerAlive, rng, armed, wards }
 *   armed  封印是否解开（默认 true，保持既有单测语义；产品里由 game.js 按石座实况传进来）
 *   wards  已放好的石座数（只用于读数）
 * events 里带 'awaken' / 'telegraph' / 'fire' / 'recover' / 'leash' / 'defeated' / 'reset' / 'locked'。
 */
export function stepGuardian(state, dt, ctx = {}) {
  const s = Object.assign({}, state || defaultGuardianState());
  const events = [];
  const d = Math.max(0, Number(dt) || 0);
  const dist = Number.isFinite(ctx.dist) ? ctx.dist : Infinity;
  const rng = typeof ctx.rng === 'function' ? ctx.rng : Math.random;
  const armed = ctx.armed === undefined ? true : !!ctx.armed;

  if (s.defeated || s.phase === GUARDIAN_PHASE.DEAD) {
    return { state: Object.assign(s, { hp: 0, phase: GUARDIAN_PHASE.DEAD, defeated: 1, attack: null, t: 0 }), events };
  }
  /* 玩家死亡或走远：回位、满血、可重试（attempts 不减，留作验收读数） */
  if (ctx.playerAlive === false || dist > GUARDIAN_LEASH) {
    const why = ctx.playerAlive === false ? 'player-dead' : 'leash';
    return {
      state: Object.assign(s, { hp: GUARDIAN_HP, phase: GUARDIAN_PHASE.DORMANT, attack: null, t: 0 }),
      events: [{ type: 'reset', why }]
    };
  }
  if (s.hp <= 0) {
    return {
      state: Object.assign(s, { hp: 0, phase: GUARDIAN_PHASE.DEAD, defeated: 1, attack: null, t: 0 }),
      events: [{ type: 'defeated' }]
    };
  }
  if (s.phase === GUARDIAN_PHASE.DORMANT) {
    if (dist > GUARDIAN_TRIGGER) return { state: s, events };
    /* 封印没解开：靠近也不醒来。锁定的提示去重放在 MobManager 的运行时字段里，
       不往 state 里写临时标记（state 是要落盘的）。 */
    if (!armed) return { state: s, events: [{ type: 'locked', wards: Number(ctx.wards) || 0 }] };
    return { state: Object.assign(s, { phase: GUARDIAN_PHASE.IDLE, t: 0 }), events: [{ type: 'awaken' }] };
  }
  if (s.phase === GUARDIAN_PHASE.IDLE) {
    const t = s.t + d;
    if (t < GUARDIAN_IDLE_SECONDS) return { state: Object.assign(s, { t }), events };
    const attack = pickGuardianAttack(dist, rng);
    return {
      state: Object.assign(s, { phase: GUARDIAN_PHASE.TELEGRAPH, attack, t: 0 }),
      events: [{ type: 'telegraph', attack }]
    };
  }
  if (s.phase === GUARDIAN_PHASE.TELEGRAPH) {
    const a = GUARDIAN_ATTACKS[s.attack] || GUARDIAN_ATTACKS.slam;
    const t = s.t + d;
    if (t < a.telegraph) return { state: Object.assign(s, { t }), events };
    return {
      state: Object.assign(s, { phase: GUARDIAN_PHASE.STRIKE, t: 0 }),
      events: [{ type: 'fire', attack: s.attack }]
    };
  }
  if (s.phase === GUARDIAN_PHASE.STRIKE) {
    const a = GUARDIAN_ATTACKS[s.attack] || GUARDIAN_ATTACKS.slam;
    return { state: Object.assign(s, { phase: GUARDIAN_PHASE.RECOVER, t: 0 }), events: [{ type: 'recover', duration: a.recover }] };
  }
  if (s.phase === GUARDIAN_PHASE.RECOVER) {
    const a = GUARDIAN_ATTACKS[s.attack] || GUARDIAN_ATTACKS.slam;
    const t = s.t + d;
    if (t < a.recover) return { state: Object.assign(s, { t }), events };
    return { state: Object.assign(s, { phase: GUARDIAN_PHASE.IDLE, attack: null, t: 0 }), events: [{ type: 'ready' }] };
  }
  return { state: s, events };
}
