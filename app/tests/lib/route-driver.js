export function scenarioBootstrap(source) {
  return '(() => {\n' + source + '\nreturn true;\n})()';
}

/* Test-only controls. All movement/mining uses the normal input and physics.
 * Keep this factory self-contained: the Electron runner serializes it into the
 * page, so no test code or private HTTP endpoint is added to the product.
 */
export function createRouteDriver(G, T, options = {}) {
  const frame = options.frame || (() => new Promise(r => requestAnimationFrame(r)));
  const now = options.now || (() => performance.now());
  const wall = options.wall || (() => Date.now());
  const R = options.report || { diag: [] };
  const ids = T.blockIds;
  const events = { drops: [], pickups: [], moves: [], mines: [] };
  const keyState = {};
  const keyFields = { KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D', Space: 'jump' };
  const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
  const keyOf = p => p.x + ',' + p.y + ',' + p.z;
  const note = (at, extra) => { if (R.diag) R.diag.push({ at, ...extra }); };
  const progress = detail => {
    R.progressAt = wall(); R.progress = detail;
    if (R.act) R.act.detail = detail;
  };
  const action = (name, detail) => {
    if (options.action) options.action(name, detail);
    else R.act = { name, detail, at: wall() };
  };
  const key = (code, down) => {
    const actual = G.input.keys ? !!G.input.keys[keyFields[code]] : !!keyState[code];
    if (actual !== down) T.key(code, down);
    keyState[code] = down;
  };
  const release = () => {
    for (const code of Object.keys(keyFields)) key(code, false);
    G.input.state.mouseLeft = G.input.state.mouseRight = false;
  };
  const ready = async () => {
    release();
    if (G.openUI) G.closeUI();
    await frame(); await frame();
    for (let i = 0; i < 12 && Math.hypot(G.controller.vel.x, G.controller.vel.z) > .05; i++) await frame();
    return G.state === 'playing' && !G.openUI && !G.input.uiMode && G.controller.health > 0;
  };
  const solid = (x, y, z) => G.world.isSolidAt(x, y, z);
  const standable = (x, y, z) => {
    const min = G.world.minY === undefined ? -64 : G.world.minY;
    const top = min + (G.world.layers || 128);
    return y > min && y + 2 <= top && solid(x, y - 1, z) &&
      !solid(x, y, z) && !solid(x, y + 1, z) &&
      G.world.getBlock(x, y, z) !== ids.WATER;
  };
  /* Walkable surfaces, not topSolidY (which may be a canopy or roof). Edges
   * permit one-block steps, check headroom, and reject cliffs/water/walls. */
  const graph = (radius = 18, blocked = new Set()) => {
    const c = G.controller, sx = Math.floor(c.pos.x), sz = Math.floor(c.pos.z);
    const sy = Math.round(c.pos.y);
    let start = null;
    for (const dy of [0, -1, 1]) if (standable(sx, sy + dy, sz)) {
      start = { x: sx, y: sy + dy, z: sz, depth: 0, parent: null }; break;
    }
    if (!start) return { nodes: [], map: new Map() };
    const nodes = [start], map = new Map([[keyOf(start), start]]);
    for (let i = 0; i < nodes.length && nodes.length < 7000; i++) {
      const p = nodes[i];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = p.x + dx, z = p.z + dz;
        if (Math.abs(x - sx) > radius || Math.abs(z - sz) > radius) continue;
        for (const dy of [0, 1, -1]) {
          const y = p.y + dy;
          if (Math.abs(y - sy) > radius || !standable(x, y, z)) continue;
          if (dy === 1 && solid(p.x, p.y + 2, p.z)) continue;
          if (dy === -1 && solid(x, p.y + 1, z)) continue;
          const n = { x, y, z, depth: p.depth + 1, parent: p };
          if (map.has(keyOf(n)) || blocked.has(keyOf(p) + '>' + keyOf(n))) continue;
          map.set(keyOf(n), n); nodes.push(n);
        }
      }
    }
    return { nodes, map };
  };
  const pathTo = node => {
    const path = [];
    for (let p = node; p; p = p.parent) path.push({ x: p.x, y: p.y, z: p.z });
    return path.reverse();
  };
  const points = b => [
    [b.x + .5, b.y + .5, b.z + .5], [b.x + .5, b.y + .98, b.z + .5],
    [b.x + .02, b.y + .5, b.z + .5], [b.x + .98, b.y + .5, b.z + .5],
    [b.x + .5, b.y + .5, b.z + .02], [b.x + .5, b.y + .5, b.z + .98]
  ];
  const visiblePoint = (b, from) => {
    const c = G.controller, origin = from || { x: c.pos.x, y: c.eyeY, z: c.pos.z };
    for (const p of points(b)) {
      const dx = p[0] - origin.x, dy = p[1] - origin.y, dz = p[2] - origin.z;
      const hit = G.world.raycast(origin.x, origin.y, origin.z, dx, dy, dz, c.reach());
      if (same(hit, b)) return p;
    }
    return null;
  };
  const walkTo = async (x, z, budgetMs = 12000, goalY) => {
    if (!await ready()) return { ok: false, reason: 'not-playing' };
    action('walk', '计划可站立路径 → ' + x.toFixed(1) + ',' + z.toFixed(1));
    const end = now() + budgetMs, blocked = new Set();
    let reason = 'no-path';
    try {
      for (let attempt = 0; attempt < 3 && now() < end; attempt++) {
        const radius = Math.min(28, Math.max(8, Math.ceil(Math.hypot(x - G.controller.pos.x, z - G.controller.pos.z)) + 4));
        const g = graph(radius, blocked);
        const goals = g.nodes.filter(p => p.x === Math.floor(x) && p.z === Math.floor(z) &&
          (goalY === undefined || Math.abs(p.y - goalY) < .4));
        goals.sort((a, b) => a.depth - b.depth);
        if (!goals.length) { reason = 'no-path'; break; }
        const path = pathTo(goals[0]);
        events.moves.push({ target: [x, goalY, z], path, attempt });
        let stalled = false;
        for (let i = 0; i < path.length && now() < end; i++) {
          const p = path[i], c = G.controller;
          let best = Infinity, advancedAt = now();
          for (;;) {
            const dx = p.x + .5 - c.pos.x, dz = p.z + .5 - c.pos.z;
            const d = Math.hypot(dx, dz, p.y - c.pos.y);
            if (Math.hypot(dx, dz) < .23 && Math.abs(c.pos.y - p.y) < .25) break;
            if (G.state !== 'playing' || G.openUI || now() >= end) { reason = 'timeout-or-ui'; stalled = true; break; }
            if (d < best - .08) { best = d; advancedAt = now(); progress('路径 ' + i + '/' + path.length + '，余 ' + d.toFixed(2)); }
            if (now() - advancedAt > 1100) {
              reason = 'blocked'; stalled = true;
              if (i) blocked.add(keyOf(path[i - 1]) + '>' + keyOf(p));
              note('walk-blocked', { target: p, pos: { ...c.pos } });
              break;
            }
            c.yaw = Math.atan2(-dx, -dz);
            key('KeyW', true);
            key('Space', p.y > c.pos.y + .45 && c.onGround);
            await frame();
          }
          release();
          if (stalled) break;
        }
        release();
        await frame(); await frame();
        const c = G.controller;
        if (!stalled && Math.hypot(x - c.pos.x, z - c.pos.z) < .8 &&
          (goalY === undefined || Math.abs(c.pos.y - goalY) < .4)) {
          progress('到达路径终点'); return { ok: true, reason: 'arrived', pos: { ...c.pos } };
        }
      }
      return { ok: false, reason: now() >= end ? 'timeout' : reason, pos: { ...G.controller.pos } };
    } finally { release(); }
  };
  const findBlock = (wanted, excluded = new Set(), radius = 18, specific = null) => {
    const g = graph(radius), want = new Set(wanted);
    let best = null, score = Infinity;
    for (const n of g.nodes) {
      if (n.depth > score + 1) break;
      const origin = { x: n.x + .5, y: n.y + 1.62, z: n.z + .5 };
      for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -1; dy <= 3; dy++) {
        const b = { x: n.x + dx, y: n.y + dy, z: n.z + dz };
        if (specific && !same(b, specific)) continue;
        if (excluded.has(keyOf(b)) || !want.has(G.world.getBlock(b.x, b.y, b.z))) continue;
        const s = n.depth + .3 * Math.hypot(dx, dz) + .2 * Math.abs(dy - 1);
        if (s >= score || !visiblePoint(b, origin)) continue;
        score = s; best = { ...b, stand: { x: n.x, y: n.y, z: n.z }, score };
      }
    }
    return best;
  };
  const aimAtBlock = async (x, y, z) => {
    release();
    const b = { x, y, z }, p = visiblePoint(b);
    if (!p) { note('aim-unreachable', { target: b, pos: { ...G.controller.pos } }); return null; }
    const c = G.controller, dx = p[0] - c.pos.x, dz = p[2] - c.pos.z;
    c.yaw = Math.atan2(-dx, -dz);
    c.pitch = Math.atan2(p[1] - c.eyeY, Math.hypot(dx, dz));
    for (let i = 0; i < 4; i++) {
      await frame();
      if (same(G.interaction.target, b)) return G.interaction.target;
    }
    return null;
  };
  const mineWith = async (x, y, z, budgetMs = 12000) => {
    const b = { x, y, z }, started = now();
    if (!await ready()) return { broke: false, why: 'not-playing' };
    if (!visiblePoint(b)) {
      const candidate = findBlock([G.world.getBlock(x, y, z)], new Set(), 18, b);
      if (!candidate) return { broke: false, why: 'no-reachable-face' };
      const s = candidate.stand;
      const move = await walkTo(s.x + .5, s.z + .5, Math.min(12000, budgetMs), s.y);
      if (!move.ok) return { broke: false, why: move.reason };
    }
    const target = await aimAtBlock(x, y, z);
    if (!target) return { broke: false, why: 'not-aimed' };
    action('mine', '实际命中 (' + x + ',' + y + ',' + z + ')');
    const held = G.inventory.held(), heldBefore = held ? held.item : null;
    let best = 0, changedAt = now(), why = 'timeout', broke = false;
    try {
      while (now() - started < budgetMs) {
        if (!same(G.interaction.target, b)) { why = 'lost-target'; break; }
        G.input.state.mouseLeft = true;
        await frame();
        if (G.world.getBlock(x, y, z) === 0) { broke = true; why = 'broken'; progress('方块已破坏'); break; }
        if (G.openUI || G.state !== 'playing') { why = 'not-playing'; break; }
        const m = G.interaction.mining;
        if (m && same(m.hit, b) && m.progress > best + .005) {
          best = m.progress; changedAt = now(); progress('挖掘 ' + Math.round(best * 100) + '%');
        }
        // A first rAF callback may run before the gameplay callback. Wait for
        // actual progress instead of treating one empty mining.hit as failure.
        if (now() - changedAt > 1000) { why = same(G.interaction.target, b) ? 'no-mining-progress' : 'lost-target'; break; }
      }
    } finally { release(); await frame(); }
    const result = { broke, why, ms: Math.round(now() - started), heldBefore, progress: best };
    events.mines.push({ target: b, ...result });
    if (!broke) note('mine-stopped', { target: b, ...result });
    return result;
  };
  const collectDrops = async (budgetMs = 4500) => {
    const start = now(), pickup0 = events.pickups.length;
    await ready();
    while (now() - start < budgetMs) {
      if (events.pickups.length > pickup0) return true;
      const drops = G.interaction.drops.list;
      if (!drops.length) return events.pickups.length > pickup0;
      const c = G.controller;
      const d = [...drops].sort((a, b) => Math.hypot(a.x - c.pos.x, a.z - c.pos.z) - Math.hypot(b.x - c.pos.x, b.z - c.pos.z))[0];
      if (Math.hypot(d.x - c.pos.x, d.y - c.pos.y - .9, d.z - c.pos.z) > 2.1) {
        const g = graph(10);
        const candidates = g.nodes.filter(n => Math.hypot(n.x + .5 - d.x, n.z + .5 - d.z) < 1.5 && Math.abs(n.y + .9 - d.y) < 2.8);
        candidates.sort((a, b) => a.depth - b.depth);
        if (candidates.length) {
          const n = candidates[0]; await walkTo(n.x + .5, n.z + .5, Math.max(200, budgetMs - (now() - start)), n.y);
        }
      }
      await frame();
    }
    release(); return events.pickups.length > pickup0;
  };
  const findPlacementBase = () => {
    const c = G.controller, px = Math.floor(c.pos.x), py = Math.floor(c.pos.y), pz = Math.floor(c.pos.z);
    for (let r = 1; r <= 3; r++) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      for (const dy of [-1, -2, 0]) {
        const b = { x: px + dx, y: py + dy, z: pz + dz };
        if (solid(b.x, b.y, b.z) && !solid(b.x, b.y + 1, b.z) &&
          G.world.getBlock(b.x, b.y + 1, b.z) === 0 && visiblePoint(b)) return b;
      }
    }
    return null;
  };
  const dm = G.interaction.drops, spawn = dm.spawn, pickup = G.onPickup;
  dm.spawn = function (...args) {
    const d = spawn.apply(this, args);
    if (d) events.drops.push({ item: d.item, n: d.count, x: d.x, y: d.y, z: d.z, at: wall() });
    return d;
  };
  G.onPickup = function (item, count, ...args) {
    events.pickups.push({ item, count, at: wall() }); progress('拾取 ' + item + ' ×' + count);
    if (pickup) return pickup.call(this, item, count, ...args);
  };
  return { graph, findBlock, walkTo, aimAtBlock, mineWith, collectDrops, findPlacementBase, events, release,
    dispose() { release(); dm.spawn = spawn; G.onPickup = pickup; } };
}
