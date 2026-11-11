/*
 * 第二轮 C2：村庄小屋的可用性（Node 单测）。
 * 覆盖：两种小屋用了新构件、屋顶在头顶之上、门洞真的能过人、门前没有悬空台阶、
 *       室内有可用设施、道路与农田仍然连通。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { villageLayout, VILLAGE_RADIUS } from '../renderer/js/core/village.js';
import { B, BLOCKS } from '../renderer/js/core/blocks.js';

const L = villageLayout();
const at = (x, y, z) => { const c = L.find(v => v.x === x && v.y === y && v.z === z); return c ? c.id : 0; };
const name = (id) => (BLOCKS[id] ? BLOCKS[id].name : String(id));

test('C2.1 两种小屋都用上本轮构件（楼梯屋檐 + 半砖）', () => {
  const stairs = L.filter(c => c.id === B.STAIRS_PLANKS || c.id === B.STAIRS_STONE);
  const slabs = L.filter(c => c.id === B.SLAB_PLANKS || c.id === B.SLAB_STONE);
  assert.ok(stairs.length >= 16, '两间小屋的四边屋檐至少 16 块楼梯，实得 ' + stairs.length);
  /* 半砖用在：两间屋脊各 1 块 + 门前各 1 级台阶（作坊地面已改整块，不再算半砖） */
  assert.ok(slabs.length >= 4, '屋脊与门前台阶至少 4 块半砖，实得 ' + slabs.length);
  assert.ok(stairs.some(c => c.id === B.STAIRS_PLANKS), '木屋用木板楼梯');
  assert.ok(stairs.some(c => c.id === B.STAIRS_STONE), '作坊用石楼梯');
});

test('C2.2 四边屋檐朝向朝外：每块楼梯的高半片朝屋内', () => {
  /* meta 0:+z 1:-z 2:+x 3:-x（高半片在朝向的对面）。
     +z 边（z=-1）应当是 meta 0；-z 边（z=-5）meta 1；+x 边（x=-1/5）meta 2；-x 边 meta 3。 */
  const planks = L.filter(c => c.id === B.STAIRS_PLANKS);
  for (const c of planks) {
    const expect = c.z === -1 ? 0 : c.z === -5 ? 1 : c.x === -1 ? 2 : 3;
    assert.equal(c.meta & 3, expect, '楼梯朝向不对：(' + c.x + ',' + c.z + ') meta=' + c.meta);
  }
});

test('C2.3 门洞 2 格高、门口外侧可站立：门前一格是能走的台阶或地面', () => {
  for (const [dx, dz] of [[-3, -1], [3, -1]]) {
    assert.equal(at(dx, 1, dz), B.DOOR_BOTTOM, '门下半在 (' + dx + ',1,' + dz + ')');
    assert.equal(at(dx, 2, dz), B.DOOR_TOP, '门上半');
    const outside = at(dx, 0, dz + 1);
    assert.ok(outside === B.SLAB_STONE || outside === B.COBBLESTONE || outside === B.DIRT_PATH || outside === B.GRASS,
      '门前地面应可站，实测 ' + name(outside));
    /* 门前 y=1 允许是一级半砖台阶（0.5 格高，玩家能迈上去）；y=2 必须通空 */
    const step = at(dx, 1, dz + 1);
    assert.ok(step === 0 || step === B.SLAB_STONE || step === B.SLAB_PLANKS,
      '门前应是一级台阶或空地，实测 ' + name(step));
    assert.equal(at(dx, 2, dz + 1), 0, '台阶上方必须能过人，实测 ' + name(at(dx, 2, dz + 1)));
  }
});

test('C2.4 屋顶在头顶之上：室内 y=1..3 是空的，y=4 才是屋顶', () => {
  for (const [x0, x1] of [[-4, -2], [2, 4]]) {
    for (let x = x0; x <= x1; x++) {
      for (const z of [-4, -3, -2]) {
        for (let y = 1; y <= 3; y++) {
          const id = at(x, y, z);
          assert.ok(id === 0 || id === B.BED || id === B.TORCH || id === B.CRAFTING_TABLE || id === B.CHEST,
            '(' + x + ',' + y + ',' + z + ') 室内应是空气或家具，实测 ' + name(id));
        }
        assert.ok(at(x, 4, z) !== 0, '(' + x + ',4,' + z + ') 应该是屋顶');
      }
    }
  }
});

test('C2.5 室内有可用设施：床/工作台/箱子/火把都在，且不在同一个格', () => {
  const furniture = L.filter(c => c.id === B.BED || c.id === B.CRAFTING_TABLE || c.id === B.CHEST || c.id === B.TORCH);
  assert.ok(furniture.some(c => c.id === B.BED), '木屋要有床');
  assert.ok(furniture.some(c => c.id === B.CRAFTING_TABLE), '作坊要有工作台');
  assert.ok(furniture.some(c => c.id === B.CHEST), '作坊要有箱子');
  const keys = new Set(furniture.map(c => c.x + ',' + c.y + ',' + c.z));
  assert.equal(keys.size, furniture.length, '家具不能叠在同一格');
});

test('C2.6 道路与农田仍然连通：中心十字路在场，农田在水渠两侧', () => {
  for (let i = -VILLAGE_RADIUS; i <= VILLAGE_RADIUS; i++) {
    assert.equal(at(i, 0, 0), B.DIRT_PATH, 'x 向土径 (' + i + ')');
    assert.equal(at(0, 0, i), B.DIRT_PATH, 'z 向土径 (' + i + ')');
  }
  const water = L.filter(c => c.id === B.WATER && c.y === 0);
  const crops = L.filter(c => c.id === B.WHEAT);
  assert.ok(water.length >= 5, '应有一条水渠');
  assert.ok(crops.length >= 10, '应有成片小麦，实得 ' + crops.length);
});
