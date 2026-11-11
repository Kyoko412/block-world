/*
 * 第二轮 C1：建筑构件的碰撞与可行走性（Node 单测，不依赖浏览器）。
 * 覆盖：半砖/楼梯的碰撞盒、玩家站得上、走得过一格台阶、上半砖不挡下半格、
 *       旧档 ID 不受影响（既有 ID 值一字不动）以及配方产出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelWorld } from '../renderer/js/world/world.js';
import { PlayerController } from '../renderer/js/player/controller.js';
import { B, BLOCKS, AIR, blockBoxes, blockFullFootprint, isSolid } from '../renderer/js/core/blocks.js';
import { findRecipe, allocateForCraft } from '../renderer/js/core/recipes.js';
import { buildChunkGeometry } from '../renderer/js/world/mesher.js';
import { lightChunk } from '../renderer/js/world/lighting.js';
import { coordKey } from '../renderer/js/world/chunk.js';

function flat(seed = 2026) {
  const w = new VoxelWorld(seed);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  for (let z = -8; z <= 8; z++) for (let x = -8; x <= 8; x++) {
    w.setBlock(x, 40, z, B.STONE, 0);
    for (let y = 41; y <= 45; y++) w.setBlock(x, y, z, AIR, 0);
  }
  return w;
}

test('C1.1 新 ID 追加在末尾，旧方块 ID 不变', () => {
  assert.equal(B.BIRCH_PLANKS, 72, '旧档 birch_planks 仍是 72');
  assert.equal(B.PLANKS, 14, '旧档 planks 仍是 14');
  assert.equal(B.SLAB_PLANKS, 73);
  assert.equal(B.SLAB_STONE, 74);
  assert.equal(B.STAIRS_PLANKS, 75);
  assert.equal(B.STAIRS_STONE, 76);
  for (const id of [B.SLAB_PLANKS, B.SLAB_STONE, B.STAIRS_PLANKS, B.STAIRS_STONE]) {
    assert.ok(BLOCKS[id], '新方块已注册：' + id);
    assert.equal(isSolid(id), true, '构件必须参与碰撞：' + id);
    assert.ok(BLOCKS[id].shape, '构件要声明 shape：' + id);
  }
});

test('C1.2 碰撞盒：下半砖 / 上半砖 / 楼梯的朝向', () => {
  assert.deepEqual(blockBoxes(B.SLAB_PLANKS, 0), [[0, 0, 0, 1, 0.5, 1]], '下半砖只占 0~0.5');
  assert.deepEqual(blockBoxes(B.SLAB_PLANKS, 8), [[0, 0.5, 0, 1, 1, 1]], '上半砖占 0.5~1');
  const s0 = blockBoxes(B.STAIRS_PLANKS, 0);
  assert.equal(s0.length, 2, '楼梯两段：下半整片 + 上半半片');
  assert.deepEqual(s0[0], [0, 0, 0, 1, 0.5, 1], '楼梯下半是整片');
  assert.deepEqual(s0[1], [0, 0.5, 0, 1, 1, 0.5], '朝 +z 的高半片在 -z 侧');
  assert.deepEqual(blockBoxes(B.STAIRS_STONE, 3)[1], [0.5, 0.5, 0, 1, 1, 1], '朝 -x 的高半片在 +x 侧');
  assert.equal(blockFullFootprint(B.SLAB_STONE), false, '半砖在 x/z 上仍占满一格');
  assert.equal(blockFullFootprint(B.STONE), true, '整块方块占满');
});

test('C1.3 玩家能站上下半砖（脚停在 +0.5，而不是被弹到 +1）', async () => {
  const w = flat();
  const c = new PlayerController(w);
  w.setBlock(2, 41, 2, B.SLAB_PLANKS, 0);
  c.spawnAt(2.5, 44, 2.5);
  for (let i = 0; i < 90; i++) { c.vel.y -= 24 * (1 / 60); c.update(1 / 60, { keyW: false, keyA: false, keyS: false, keyD: false, jump: false }); }
  assert.ok(Math.abs(c.pos.y - 41.5) < 0.02, '应站在半砖顶面 41.5，实得 ' + c.pos.y.toFixed(3));
  assert.equal(c.onGround, true, '落地后 onGround 为真');
});

test('C1.4 半砖的上下半各有实际效果：站在下半砖顶面不重叠，上半砖会挡住身体', () => {
  const w = flat();
  const c = new PlayerController(w);
  w.setBlock(2, 41, 2, B.SLAB_PLANKS, 0);          // 下半砖：41~41.5
  c.spawnAt(2.5, 41.5, 2.5);                       // 站在它的顶面上
  assert.equal(c.intersectsSolid(2.5, 41.5, 2.5), false, '站在下半砖顶面（41.5）不应与它重叠');
  w.setBlock(3, 41, 2, B.SLAB_PLANKS, 8);          // 上半砖：41.5~42
  assert.equal(c.intersectsSolid(3.5, 41.5, 2.5), true, '上半砖会挡住站在同一层的身体');
  assert.equal(c.intersectsSolid(3.5, 42.1, 2.5), false, '站到上半砖顶面之上就不再相交');
});

test('C1.5 楼梯可以走上去：一格台阶自动抬升后落在楼梯上', async () => {
  const w = flat();
  const c = new PlayerController(w);
  /* 一格高的台阶用楼梯补：朝向 +x，高半片在 -x 侧，玩家从 -x 方向走上来 */
  w.setBlock(2, 41, 2, B.STAIRS_PLANKS, 3);
  c.spawnAt(0.5, 41, 2.5);
  c.yaw = -Math.PI / 2;                             // 朝 +x
  let maxY = c.pos.y;
  for (let i = 0; i < 240; i++) {
    c.update(1 / 60, { keyW: true, keyA: false, keyS: false, keyD: false, jump: false });
    maxY = Math.max(maxY, c.pos.y);
    if (c.pos.x > 2.6) break;
  }
  assert.ok(c.pos.x > 1.6, '玩家应被楼梯抬升并继续前进，实得 x=' + c.pos.x.toFixed(2));
  assert.ok(maxY <= 42.01, '抬升不超过一格（不会跳到半空），实得最高 ' + maxY.toFixed(2));
});

test('C1.6 配方：半砖 3 进 6 出、楼梯 6 进 4 出，木板标签通吃两种板', () => {
  const slab = findRecipe([['planks', 'planks', 'planks'], [null, null, null], [null, null, null]]);
  assert.ok(slab && slab.result.item === 'slab_planks' && slab.result.count === 6, '三块板应出 6 块半砖');
  const stairs = findRecipe([['birch_planks', null, null], ['birch_planks', 'birch_planks', null],
    ['birch_planks', 'birch_planks', 'birch_planks']]);
  assert.ok(stairs && stairs.result.item === 'stairs_planks' && stairs.result.count === 4, '桦木板也能做楼梯，6 进 4 出');
  const inv = { planks: 3, birch_planks: 3 };
  const alloc = allocateForCraft(findRecipe([['planks', 'planks', 'planks'], [null, null, null], [null, null, null]]),
    (id) => inv[id] || 0);
  assert.equal(alloc.ok, true, '一键填充能按标签取料');
});
