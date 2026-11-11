import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouteDriver, scenarioBootstrap } from './lib/route-driver.js';
import { PlayerController } from '../renderer/js/player/controller.js';
import { Interaction } from '../renderer/js/player/interaction.js';
import { Inventory } from '../renderer/js/player/inventory.js';
import { VoxelWorld } from '../renderer/js/world/world.js';
import { B, BLOCKS } from '../renderer/js/core/blocks.js';

function fixture({ frozen = false, delayMining = false } = {}) {
  const cells = new Map(), k = (x, y, z) => [x, y, z].join(',');
  const world = {
    minY: -64, layers: 128,
    getBlock(x, y, z) { return cells.has(k(x, y, z)) ? cells.get(k(x, y, z)) : y <= 0 ? B.STONE : 0; },
    getMeta() { return 0; },
    setBlock(x, y, z, id) { cells.set(k(x, y, z), id); },
    isSolidAt(x, y, z) { return !!BLOCKS[this.getBlock(x, y, z)]?.solid; },
    refreshImmediate() {},
    raycast: VoxelWorld.prototype.raycast
  };
  const controller = new PlayerController(world);
  controller.pos = { x: .5, y: 1.0001, z: .5 }; controller.onGround = true;
  const G = {
    world, controller, state: 'playing', openUI: null,
    inventory: new Inventory(), input: { keys: {}, uiMode: false, state: {} },
    ui: {}, closeUI() { this.openUI = null; this.input.uiMode = false; }
  };
  const mapping = { KeyW: ['W', 'keyW'], KeyA: ['A', 'keyA'], KeyS: ['S', 'keyS'], KeyD: ['D', 'keyD'], Space: ['jump', 'jump'] };
  const T = { blockIds: B, key(code, down) { const m = mapping[code]; G.input.keys[m[0]] = down; G.input.state[m[1]] = down; } };
  G.interaction = new Interaction({
    world, controller, inventory: G.inventory, input: G.input, game: G,
    view: { setSelection() {}, setBreakProgress() {} },
    sfx: { play() {} }, particles: { spawnBlock() {} }
  });
  let ms = 0, skipped = false;
  const frame = async () => {
    ms += 1000 / 60;
    if (!frozen) controller.update(1 / 60, G.input.state);
    if (delayMining && G.input.state.mouseLeft && !skipped) { skipped = true; return; }
    G.interaction.enabled = !G.openUI;
    G.interaction.update(1 / 60);
  };
  const R = { diag: [] };
  const driver = createRouteDriver(G, T, { frame, now: () => ms, wall: () => ms + 100000, report: R });
  return { G, T, world, driver, R, ms: () => ms };
}

test('reaches the other side of a two-block wall through a walkable route', async () => {
  const f = fixture();
  for (let z = -2; z <= 2; z++) for (let y = 1; y <= 3; y++) f.world.setBlock(2, y, z, B.STONE);
  const r = await f.driver.walkTo(4.5, .5, 10000, 1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(f.G.controller.pos.x > 4);
  assert.ok(f.driver.events.moves.some(m => m.path.some(p => Math.abs(p.z) >= 3)));
  assert.equal(f.G.input.keys.W, false);
  f.driver.dispose();
});

test('a blocked/unreachable goal and a movement timeout both fail and release keys', async () => {
  const f = fixture();
  for (let y = 1; y <= 5; y++) f.world.setBlock(3, y, 0, B.STONE);
  const r = await f.driver.walkTo(3.5, .5, 1000, 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-path');
  f.driver.dispose();
  const frozen = fixture({ frozen: true });
  const timeout = await frozen.driver.walkTo(2.5, .5, 400, 1);
  assert.equal(timeout.ok, false);
  assert.equal(timeout.reason, 'timeout');
  assert.equal(frozen.G.input.keys.W, false);
  frozen.driver.dispose();
});

test('tree selection rejects canopy-height logs and finds a reachable exposed trunk', () => {
  const f = fixture();
  f.world.setBlock(2, 9, 0, B.LOG);
  f.world.setBlock(4, 1, 0, B.LOG);
  const target = f.driver.findBlock([B.LOG]);
  assert.ok(target);
  assert.equal(target.y, 1);
  f.driver.dispose();
});

test('mining waits past the first empty frame and breaks the actual targeted log', async () => {
  const f = fixture({ delayMining: true });
  f.world.setBlock(2, 1, 0, B.LOG);
  const r = await f.driver.mineWith(2, 1, 0, 8000);
  assert.equal(r.broke, true, JSON.stringify(r));
  assert.equal(f.world.getBlock(2, 1, 0), 0);
  assert.ok(f.driver.events.drops.some(d => d.item === 'oak_log'));
  assert.equal(f.G.input.state.mouseLeft, false);
  f.driver.dispose();
});

test('an out-of-reach target is rejected without holding attack', async () => {
  const f = fixture();
  f.world.setBlock(2, 9, 0, B.LOG);
  const r = await f.driver.mineWith(2, 9, 0, 8000);
  assert.equal(r.broke, false);
  assert.equal(r.why, 'no-reachable-face');
  assert.equal(f.G.input.state.mouseLeft, false);
  assert.equal(f.world.getBlock(2, 9, 0), B.LOG);
  f.driver.dispose();
});

test('scenario bootstrap returns before an async scenario finishes, allowing live polling', async () => {
  const state = {};
  const source = '(async () => { window.started = true; await new Promise(r => setTimeout(r, 15)); window.done = true; })();';
  const result = new Function('window', 'return ' + scenarioBootstrap(source))(state);
  assert.equal(result, true);
  assert.equal(state.started, true);
  assert.equal(state.done, undefined);
  await new Promise(r => setTimeout(r, 25));
  assert.equal(state.done, true);
});
