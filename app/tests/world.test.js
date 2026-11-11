/* 世界逻辑单元测试（Node 直接运行，不需要浏览器）
 * 覆盖：地形确定性、地层结构、矿石/树木/洞穴存在性、光照、射线、区块边界脏标记、存档 diff 往返 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { VoxelWorld, FRAME_BUDGET, LOAD_SLICE_BUDGET, GEN_LEGACY, GEN_DEEP, GEN_DEEP_CHAMBERS, NEW_WORLD_GEN_VERSION, genVersionFromMeta, DEEP_MIN_Y, DEEP_LAYERS, layoutByGenVersion } from '../renderer/js/world/world.js';
import { PlayerController } from '../renderer/js/player/controller.js';
import { Chunk, CHUNK_SX, CHUNK_SZ, CHUNK_AREA, WORLD_H, SEA_LEVEL, idx, coordKey } from '../renderer/js/world/chunk.js';
import { B, BLOCKS, AIR, breakTime, blockDrops, tileForFace, hasFacing, canTill, canPlantSeed, farmlandShouldRevert, FARMLAND_WET_RADIUS, hurtsOnTouch } from '../renderer/js/core/blocks.js';
import { stepTargetY, STEP_HEIGHT, PUSH_UP_LIMIT, PUSH_SIDE_LIMIT, PHYS } from '../renderer/js/player/controller.js';
import { ITEMS, blockToItem, itemName, CREATIVE_TABS } from '../renderer/js/core/items.js';
import { filterCreativeItems } from '../renderer/js/core/creative.js';
import {
  GUARDIAN_HP, GUARDIAN_TRIGGER, GUARDIAN_LEASH, GUARDIAN_PHASE, GUARDIAN_ATTACKS, GUARDIAN_WARDS,
  GUARDIAN_REWARD, guardianSiteKey, defaultGuardianState, normalizeGuardianState,
  pickGuardianAttack, guardianDamage, guardianDamageType, claimGuardianReward, stepGuardian,
  guardianArmed, guardianWardSpots
} from '../renderer/js/core/guardian.js';
import { findRecipe, smeltResult, isFuel, RECIPES, SMELTING, expandIngredient, TAGS, listRecipes } from '../renderer/js/core/recipes.js';
import { SFX_FILES, SFX_FILE_IDS, SFX_LICENCE_ALLOWLIST, SFX_FILE_DIR, sfxFileFor, sfxFileUrl, validateSfxFile, sfxFilesReport, sfxFilesValid } from '../renderer/js/core/sfxfiles.js';
import { isNight, isDay, advanceToMorning, wrapTime, NIGHT_START, TIME_NOON, TIME_NIGHT, TIME_MORNING } from '../renderer/js/core/time.js';
import { MOB_TYPES, Mob, MobManager, SHEEP_REGROW_SECONDS, BABY_GROW_SECONDS, BREED_COOLDOWN_SECONDS, NIGHT_TYPES, DAY_TYPES, computePose, MOB_ATTACK_POSE_SECONDS, MOB_POSE_LIMITS, hurtTint, AQUATIC_TYPES, FISH_SITE_STEP, FISH_SCHOOL_MIN, FISH_SCHOOL_MAX, FISH_WATER_DEPTH, FISH_AIR_SECONDS, FISH_MAX_ALIVE, fishSchoolOf, stringSeg, bowNockZ, SKELETON_DRAW_SECONDS, SKELETON_STRING_REST_Z, SKELETON_STRING_PULL_Z, SKELETON_BOW_TIP_Y, SKELETON_BOW_TIP_Z, CREEPER_HISS_GAP, AIR_TYPES, FLYING_TYPES, birdFlockOf, birdHoverY, birdPerchY, flightRules, approachYaw, BIRD_SITE_STEP, BIRD_FLOCK_MIN, BIRD_FLOCK_MAX, BIRD_MAX_ALIVE, BIRD_HOVER_MIN, BIRD_HOVER_MAX, BIRD_PERCH_REACH, BIRD_PERCH_FALLBACK, BIRD_PERCH_FLAP, BIRD_PERCH_SETTLE_DIST, BIRD_TURN_RATE, BIRD_FLAP_MAX, BIRD_GLIDE_FLAP, BIRD_FLY_SECONDS, BIRD_PERCH_SECONDS, BIRD_ESCAPE_DIST, BIRD_RANGE_MIN, BIRD_RANGE_MAX, SPAWN_DARK_LIMIT, SPAWN_DAY_LIGHT, UNDERGROUND_MIN_COVER, UNDERGROUND_MAX_DEPTH, UNDERGROUND_TRIES, SPAWN_CAVE_CAP, SPAWN_UNDERGROUND_MIN_DIST } from '../renderer/js/world/mobs.js';
import { blockPainters, itemPainters, mobPainters } from '../renderer/js/gfx/painters.js';
import { mobTexStats } from '../renderer/js/gfx/mobtex.js';
import {
  arrowSpeedFor, arrowDamageFor, stepArrow, arrowHitsBox, canPickupStuck, bowCanFire,
  ARROW_MIN_SPEED, ARROW_MAX_SPEED, ARROW_MIN_DAMAGE, ARROW_MAX_DAMAGE,
  BOW_CHARGE_SECONDS, BOW_MIN_CHARGE, ARROW_GRAVITY
} from '../renderer/js/core/projectile.js';
import { lightChunk } from '../renderer/js/world/lighting.js';
import { runFingerprint } from './layout-fingerprint.mjs';
import { explosionCells, explosionDamage, breakableAt, CREEPER_POWER, CREEPER_MAX_DAMAGE, CREEPER_DAMAGE_RANGE, CREEPER_FUSE_SECONDS, CREEPER_TRIGGER, CREEPER_ESCAPE } from '../renderer/js/core/explosion.js';
import { mulberry32, normalizeSeed } from '../renderer/js/core/rng.js';
import { Inventory } from '../renderer/js/player/inventory.js';
import { armorReduction, applyArmorReduction, ARMOR_DAMAGE_TYPES, ARMOR_MAX_POINTS, ARMOR_MAX_REDUCTION } from '../renderer/js/core/armor.js';
import { inShieldArc, shieldCanBlock, SHIELD_BLOCK_ANGLE, SHIELD_HALF_ANGLE } from '../renderer/js/core/shield.js';
import {
  ACHIEVEMENTS, ACHIEVEMENT_IDS, ACHIEVEMENT_BY_ID, Achievements,
  itemAchievementIds, craftAchievementIds, inferAchievements
} from '../renderer/js/core/achievements.js';
import { Sfx, SOUND_NAMES, SOUND_DEF_NAMES, KEY_SOUNDS, KEY_SFX_GAIN, keyGain } from '../renderer/js/audio/sfx.js';
import { MUSIC_TIMING, timingConfig, pickLeadIn, pickGap, dutyCycle, segmentWaitMs } from '../renderer/js/core/musictiming.js';
import {
  FILE_TRACKS, FILE_TRACK_IDS, LICENCE_ALLOWLIST, MUSIC_FILE_DIR,
  fileTrackFor, fileUrl, parseDuration, validateFileTrack, fileTracksReport, fileTracksValid
} from '../renderer/js/core/musicfiles.js';
import { nightPhase, nightHintText, rectsOverlap, NIGHT_WARNING_LEAD } from '../renderer/js/core/hud.js';
import { describeItem, recipeUseCount } from '../renderer/js/core/iteminfo.js';
import { TRACKS, TRACK_IDS, trackInfo, selectAmbient, AMBIENT_IDS } from '../renderer/js/audio/music.js';
import {
  VILLAGER_TRADES, villageLayout, chooseVillageSite, performTrade, tradeCheck, VILLAGE_RADIUS,
  VILLAGER_PROFESSIONS, VILLAGER_PROFESSION_IDS, VILLAGER_OFFSETS,
  normalizeVillagerProfession, tradesFor, professionName
} from '../renderer/js/core/village.js';
import { chooseCampSite, campLayout, campLoot, campDiamondRoll, CAMP_RADIUS, CAMP_MAX_EXTENT, CAMP_CHESTS } from '../renderer/js/core/camp.js';
import { isRainWeather, isSkyExposed, rainWetsFarmland, cropRainMultiplier, RAIN_GROWTH_MULTIPLIER } from '../renderer/js/core/farmrain.js';
import { regionInfo, candidateFor, nearbyRegions, landmarkLayout, landmarkLoot, LANDMARK_TYPE_IDS } from '../renderer/js/core/landmarks.js';
import { QUESTS, QUEST_IDS, QUEST_BY_ID, QuestChain, suggestRecipes } from '../renderer/js/core/quests.js';
import {
  stepFuse, TNT_FUSE_SECONDS, TNT_POWER, TNT_DAMAGE_RANGE, TNT_MAX_DAMAGE,
  tntBlastSpec, tntSubmerged, TNT_CHAIN_DEPTH, TNT_CHAIN_RADIUS, TNT_CHAIN_MAX, TNT_CHAIN_FUSE
} from '../renderer/js/core/tnt.js';

const seed = 12345;

test('同一颗子两次生成的方块数据完全一致（确定性）', async () => {
  const w1 = new VoxelWorld(seed), w2 = new VoxelWorld(seed);
  for (const w of [w1, w2]) {
    for (let cz = 0; cz < 2; cz++) for (let cx = 0; cx < 2; cx++) w.ensureChunk(cx, cz);
    for (let cz = 0; cz < 2; cz++) for (let cx = 0; cx < 2; cx++) lightChunk(w.chunks.get(coordKey(cx, cz)), w);
  }
  for (let cz = 0; cz < 2; cz++) for (let cx = 0; cx < 2; cx++) {
    const a = w1.chunks.get(coordKey(cx, cz)), b = w2.chunks.get(coordKey(cx, cz));
    assert.deepEqual(Array.from(a.blocks), Array.from(b.blocks), '方块数据不一致 cx=' + cx + ' cz=' + cz);
    assert.deepEqual(Array.from(a.light), Array.from(b.light), '光照不一致');
  }
});

test('地层结构：基岩在最底、石头在表下、地表为草/沙、低洼处有水', async () => {
  const w = new VoxelWorld(seed);
  for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) { w.ensureChunk(cx, cz); lightChunk(w.chunks.get(coordKey(cx, cz)), w); }
  const c = w.chunks.get(coordKey(1, 1));
  let sawGrass = false, sawStone = false, sawDirt = false, sawWater = false, sawSand = false;
  for (let lz = 0; lz < CHUNK_SZ; lz++) {
    for (let lx = 0; lx < CHUNK_SX; lx++) {
      assert.equal(c.blocks[idx(lx, 0, lz)], B.BEDROCK, 'y=0 必须是基岩');
      // 自上而下找地表
      let top = -1;
      for (let y = WORLD_H - 1; y >= 0; y--) { if (c.blocks[idx(lx, y, lz)] !== B.AIR) { top = y; break; } }
      assert.ok(top > 0, '每列必须有方块');
      const surf = c.blocks[idx(lx, top, lz)];
      if (surf === B.GRASS) sawGrass = true;
      if (surf === B.SAND) sawSand = true;
      if (surf === B.WATER) sawWater = true;
      // 地表以下 6 格内应出现石头（排除洞穴）
      for (let y = top - 1; y > Math.max(1, top - 8); y--) {
        const id = c.blocks[idx(lx, y, lz)];
        if (id === B.DIRT) sawDirt = true;
        if (id === B.STONE) { sawStone = true; break; }
      }
    }
  }
  assert.ok(sawGrass, '应生成草方块地表');
  assert.ok(sawStone, '应生成地下石层');
  assert.ok(sawDirt, '草方块下应有泥土');
  // 沙滩/水域与种子有关，扩大到 11×11 区块取样判断
  let sawShore = sawSand || sawWater;
  if (!sawShore) {
    const w2 = new VoxelWorld(seed);
    outer: for (let cz = -5; cz <= 5; cz++) {
      for (let cx = -5; cx <= 5; cx++) {
        const c2 = w2.ensureChunk(cx, cz);
        for (let lz = 0; lz < CHUNK_SZ; lz++) for (let lx = 0; lx < CHUNK_SX; lx++) {
          const h = c2.heightMap[lx + lz * CHUNK_SX];
          const id = c2.blocks[idx(lx, h, lz)];
          if (id === B.SAND || id === B.WATER || id === B.SANDSTONE) { sawShore = true; break outer; }
        }
      }
    }
  }
  assert.ok(sawShore, '应有沙滩或水域');
});

test('世界整体应包含水域（低洼地形被海平面填充）', async () => {
  const w = new VoxelWorld(seed);
  let water = 0;
  for (let cz = -6; cz <= 6; cz++) for (let cx = -6; cx <= 6; cx++) {
    const c = w.ensureChunk(cx, cz);
    for (let i = 0; i < c.blocks.length; i++) if (c.blocks[i] === B.WATER) water++;
  }
  assert.ok(water > 500, '应生成足够多的水，实际 ' + water);
});

test('矿脉、树木、洞穴都实际生成', async () => {
  const w = new VoxelWorld(seed);
  const tally = {};
  let undergroundAir = 0;
  for (let cz = -5; cz <= 5; cz++) for (let cx = -5; cx <= 5; cx++) {
    const c = w.ensureChunk(cx, cz);
    const x0 = c.cx * CHUNK_SX, z0 = c.cz * CHUNK_SZ;
    for (let lz = 0; lz < CHUNK_SZ; lz++) {
      for (let lx = 0; lx < CHUNK_SX; lx++) {
        const h = w.surfaceHeight(x0 + lx, z0 + lz);
        for (let y = 1; y < WORLD_H; y++) {
          const id = c.blocks[idx(lx, y, lz)];
          tally[id] = (tally[id] || 0) + 1;
          if (id === B.AIR && y < h - 2) undergroundAir++;
        }
      }
    }
  }
  assert.ok(tally[B.LOG] > 60, '应有树木（原木 ' + (tally[B.LOG] || 0) + '）');
  assert.ok((tally[B.LOG] || 0) + (tally[B.BIRCH_LOG] || 0) > 60, '应有原木');
  assert.ok((tally[B.LEAVES] || 0) > 100, '应有树叶');
  assert.ok(tally[B.COAL_ORE] > 20, '应有煤矿石 ' + (tally[B.COAL_ORE] || 0));
  assert.ok(tally[B.IRON_ORE] > 10, '应有铁矿石 ' + (tally[B.IRON_ORE] || 0));
  assert.ok((tally[B.DIAMOND_ORE] || 0) >= 1, '应有钻石矿石 ' + (tally[B.DIAMOND_ORE] || 0));
  assert.ok(undergroundAir > 400, '应有洞穴 ' + undergroundAir);
});

test('光照：露天为 15，深处为 0，火把会照亮周围', async () => {
  const w = new VoxelWorld(777);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) lightChunk(w.chunks.get(coordKey(cx, cz)), w);
  const c = w.chunks.get(coordKey(0, 0));
  // 找一个草地列
  let found = false;
  for (let lz = 0; lz < CHUNK_SZ && !found; lz++) {
    for (let lx = 0; lx < CHUNK_SX && !found; lx++) {
      const top = (() => { for (let y = WORLD_H - 1; y >= 0; y--) { const id = c.blocks[idx(lx, y, lz)]; if (id !== B.AIR && id !== B.WATER) return y; } return -1; })();
      if (top < 3) continue;
      assert.equal(c.getSky(lx, top + 1, lz), 15, '露天上方天空光应为 15');
      assert.equal(c.getSky(lx, 2, lz), 0, '深处天空光应为 0');
      // 放置火把：相邻格应获得方块光
      c.set(lx, top + 1, lz, B.TORCH);
      lightChunk(c, w);
      assert.equal(c.getBlockLight(lx, top + 1, lz), 14, '火把自身亮度 14');
      assert.ok(c.getBlockLight(lx, top + 2, lz) >= 13 || c.getBlockLight(Math.min(15, lx + 1), top + 1, lz) >= 13,
        '火把应照亮相邻格');
      found = true;
    }
  }
  assert.ok(found, '应找到测试列');
});

test('射线检测：从空中向下能命中地表，并给出正确法线', () => {
  const w = new VoxelWorld(4242);
  w.ensureChunk(0, 0);
  const h = w.surfaceHeight(8, 8);
  const hit = w.raycast(8.5, WORLD_H - 1, 8.5, 0, -1, 0, WORLD_H);
  assert.ok(hit, '应命中方块');
  assert.equal(hit.y, h, '命中高度应等于地表高度');
  assert.deepEqual(hit.face, [0, 1, 0], '从上往下命中面法线应朝上');
  assert.equal(w.placementTarget(hit).y, h + 1, '放置位置应在命中格上方');
});

test('方块改动：diff 记录、存档往返、区块边界脏标记', () => {
  const w = new VoxelWorld(999);
  for (let cz = 0; cz <= 1; cz++) for (let cx = 0; cx <= 1; cx++) w.ensureChunk(cx, cz);
  // 在区块边界挖掉一格
  const bx = CHUNK_SX, by = w.surfaceHeight(bx, 3), bz = 3;   // cx=1 的 lx=0
  w.setBlock(bx, by, bz, B.AIR);
  assert.ok(w.dirtyMesh.has(coordKey(1, 0)), '自身区块需重网格化');
  assert.ok(w.dirtyMesh.has(coordKey(0, 0)), '相邻区块也应重网格化');
  assert.equal(w.getBlock(bx, by, bz), B.AIR);

  const dump = w.serializeEdits();
  assert.ok(dump[coordKey(1, 0)], '改动应被序列化');

  const w2 = new VoxelWorld(999);
  w2.applySavedData(dump);
  w2.ensureChunk(1, 0);
  assert.equal(w2.getBlock(bx, by, bz), B.AIR, '新世界读取存档后改动应恢复');
  // 未改动的区块仍然由种子生成
  w2.ensureChunk(0, 0);
  assert.notEqual(w2.getBlock(bx, by, bz), undefined);
});

test('挖掘时间与掉落物符合设计', () => {
  const wood = ITEMS.pickaxe_wood, stoneTool = ITEMS.pickaxe_stone;
  assert.ok(breakTime(B.STONE, null) > breakTime(B.STONE, wood), '工具应比徒手快');
  assert.ok(breakTime(B.STONE, wood) > breakTime(B.STONE, stoneTool), '石镐应比木镐快');
  assert.equal(breakTime(B.BEDROCK, stoneTool), Infinity, '基岩不可破坏');
  const drops = blockDrops(B.STONE, 0, () => 0.5);
  assert.equal(drops[0].item, 'cobblestone', '石头掉落圆石');
  assert.equal(blockDrops(B.GRASS, 0, () => 0.5)[0].item, 'dirt', '草方块掉落泥土');
  assert.equal(blockDrops(B.COAL_ORE, 0, () => 0.5)[0].item, 'coal');
  // 需要用对工具才有掉落
  const ironDrops = blockDrops(B.IRON_ORE, 0, () => 0.5);
  assert.equal(ironDrops[0].item, 'iron_ore');
  assert.ok(breakTime(B.DIAMOND_ORE, ITEMS.pickaxe_iron) < breakTime(B.DIAMOND_ORE, ITEMS.pickaxe_wood));
});

test('合成主线可走通：树→木板→工作台/木棍→木镐→圆石→石镐/熔炉→铁镐', () => {
  const g = (rows) => {
    const grid = [['', '', ''], ['', '', ''], ['', '', '']].map(r => r.slice());
    rows.forEach((row, y) => row.forEach((cell, x) => { grid[y][x] = cell || null; }));
    return grid;
  };
  // 原木 -> 木板 x4
  let r = findRecipe([['oak_log']]);
  assert.ok(r && r.result.item === 'planks' && r.result.count === 4, '原木应合成 4 木板');
  // 2x2 木板 -> 工作台
  r = findRecipe(g([['planks', 'planks'], ['planks', 'planks']]));
  assert.ok(r && r.result.item === 'crafting_table', '4 木板应合成工作台');
  // 2 木板竖排 -> 木棍 x4
  r = findRecipe(g([['planks'], ['planks']]));
  assert.ok(r && r.result.item === 'stick' && r.result.count === 4, '两木板应合成 4 木棍');
  // 3x3 木镐
  r = findRecipe(g([['planks', 'planks', 'planks'], [null, 'stick', null], [null, 'stick', null]]));
  assert.ok(r && r.result.item === 'pickaxe_wood', '应合成木镐');
  // 8 圆石 -> 熔炉
  r = findRecipe(g([['cobblestone', 'cobblestone', 'cobblestone'], ['cobblestone', null, 'cobblestone'], ['cobblestone', 'cobblestone', 'cobblestone']]));
  assert.ok(r && r.result.item === 'furnace', '8 圆石应合成熔炉');
  // 石镐
  r = findRecipe(g([['cobblestone', 'cobblestone', 'cobblestone'], [null, 'stick', null], [null, 'stick', null]]));
  assert.ok(r && r.result.item === 'pickaxe_stone', '应合成石镐');
  // 铁镐
  r = findRecipe(g([['iron_ingot', 'iron_ingot', 'iron_ingot'], [null, 'stick', null], [null, 'stick', null]]));
  assert.ok(r && r.result.item === 'pickaxe_iron', '应合成铁镐');
  // 镜像配方（斧）
  r = findRecipe(g([['cobblestone', 'cobblestone'], ['stick', 'cobblestone'], ['stick', null]]));
  assert.ok(r && r.result.item === 'axe_stone', '镜像图案也应识别为石斧');
  // 火把
  r = findRecipe(g([['coal'], ['stick']]));
  assert.ok(r && r.result.item === 'torch', '煤+木棍应合成火把');
});

test('熔炼表与燃料', () => {
  assert.equal(smeltResult('iron_ore').output, 'iron_ingot', '铁矿石应炼出铁锭');
  assert.equal(smeltResult('gold_ore').output, 'gold_ingot');
  assert.equal(smeltResult('sand').output, 'glass', '沙子炼玻璃');
  assert.equal(smeltResult('cobblestone').output, 'stone', '圆石炼石头');
  assert.equal(smeltResult('oak_log').output, 'charcoal', '原木炼木炭');
  assert.ok(isFuel('coal') && isFuel('planks') && isFuel('stick'), '煤/木板/木棍可作燃料');
  assert.ok(!isFuel('iron_ingot'), '铁锭不是燃料');
});

test('每个方块的六个面都能取到合法贴图名，方块物品映射正确', () => {
  const faces = ['top', 'bottom', 'posx', 'negx', 'posz', 'negz'];
  for (let id = 1; id < BLOCKS.length; id++) {
    if (!BLOCKS[id]) continue;
    for (const f of faces) {
      const t = tileForFace(id, 0, f);
      assert.equal(typeof t, 'string', '方块 ' + id + ' 面 ' + f + ' 应有贴图名');
      assert.notEqual(t, undefined);
    }
  }
  assert.equal(blockToItem(B.STONE), 'stone');
  assert.equal(blockToItem(B.GRASS), 'grass_block');
  assert.equal(blockToItem(B.FURNACE), 'furnace');
  // 所有配方产物必须存在于物品表
  for (const rec of RECIPES) {
    assert.ok(ITEMS[rec.result.item], '配方产物缺少物品定义: ' + rec.result.item);
  }
});

/* ================= T1 锄头与独立耕地（本轮新增） ================= */

/* 3x3 空格子，rows 为按行给出的物品名（null/'' 表示空位） */
function grid3(rows) {
  const g = [['', '', ''], ['', '', ''], ['', '', '']].map(r => r.slice());
  rows.forEach((row, y) => row.forEach((cell, x) => { g[y][x] = cell || null; }));
  return g;
}

test('T1 锄头：木/石/铁三档配方与物品定义齐备', () => {
  const cases = [['wood', 'planks'], ['stone', 'cobblestone'], ['iron', 'iron_ingot']];
  for (const [mat, matItem] of cases) {
    const r = findRecipe(grid3([[matItem, matItem], [null, 'stick']]));
    assert.ok(r, mat + '：应能匹配到锄头配方');
    assert.equal(r.result.item, 'hoe_' + mat, mat + '：配方产物应为 hoe_' + mat);
    const it = ITEMS['hoe_' + mat];
    assert.ok(it, '缺少锄头物品定义 hoe_' + mat);
    assert.equal(it.toolType, 'hoe');
    assert.ok(it.durability > 0, '锄头必须有耐久');
    assert.equal(it.stack, 1, '锄头不可堆叠');
  }
  assert.ok(ITEMS.hoe_diamond, '钻石锄也应存在');
});

test('T1 开垦与种植规则：只有草/泥土能被锄头开垦，种子只认耕地', () => {
  assert.equal(canTill(B.GRASS, AIR), true, '草方块可开垦');
  assert.equal(canTill(B.DIRT, AIR), true, '泥土可开垦');
  assert.equal(canTill(B.DIRT, B.TALL_GRASS), true, '上方是杂草也可以（会被清掉）');
  assert.equal(canTill(B.STONE, AIR), false, '石头不能开垦');
  assert.equal(canTill(B.SAND, AIR), false, '沙子不能开垦');
  assert.equal(canTill(B.FARMLAND, AIR), false, '已是耕地不应重复开垦');
  assert.equal(canTill(B.DIRT, B.PLANKS), false, '上方被方块压住不能开垦');
  assert.equal(canPlantSeed(B.FARMLAND), true, '种子只能种耕地');
  assert.equal(canPlantSeed(B.DIRT), false, 'T1 之后种子不能再直接种泥土');
  assert.equal(canPlantSeed(B.GRASS), false, '也不能直接种草方块');
});

test('T1 草方块破坏：始终掉泥土，另有 15% 概率掉小麦种子', () => {
  const low = blockDrops(B.GRASS, 0, () => 0.1);
  assert.equal(low[0].item, 'dirt', '泥土必须排第一位');
  assert.ok(low.some(d => d.item === 'wheat_seeds'), 'rand=0.1 应掉种子');
  const high = blockDrops(B.GRASS, 0, () => 0.5);
  assert.equal(high.length, 1, 'rand=0.5 只掉泥土');
  assert.equal(blockDrops(B.GRASS, 0, () => 0.149).length, 2, '0.149 < 0.15 应掉种子');
  assert.equal(blockDrops(B.GRASS, 0, () => 0.151).length, 1, '0.151 不应掉种子');
});

test('T1 耕地湿润判定：水平 3 格内、纵向 ±1 格内有水即湿润', () => {
  const w = new VoxelWorld(4321);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const x = 8, z = 8;
  const y = w.topSolidY(x, z);
  assert.ok(y > 2, '应找到地表列');
  w.setBlock(x, y, z, B.DIRT, 0);
  const R = FARMLAND_WET_RADIUS;
  // 先把判定范围内的水全部填成石头（含对角线），保证起点是「周围无水」
  for (let yy = y - 2; yy <= y + 2; yy++) {
    for (let dz = -(R + 2); dz <= R + 2; dz++) {
      for (let dx = -(R + 2); dx <= R + 2; dx++) {
        if (w.getBlock(x + dx, yy, z + dz) === B.WATER) w.setBlock(x + dx, yy, z + dz, B.STONE, 0);
      }
    }
  }
  assert.equal(w.isFarmlandWet(x, y, z), false, '周围无水应为干耕地');
  w.setBlock(x + R, y, z, B.WATER, 0);
  assert.equal(w.isFarmlandWet(x, y, z), true, '恰在半径 ' + R + ' 格内 = 湿润');
  w.setBlock(x + R, y, z, B.AIR, 0);
  w.setBlock(x + R + 1, y, z, B.WATER, 0);
  assert.equal(w.isFarmlandWet(x, y, z), false, '半径外一格不算湿润');
  w.setBlock(x + R + 1, y, z, B.AIR, 0);
  w.setBlock(x + 2, y - 1, z, B.WATER, 0);
  assert.equal(w.isFarmlandWet(x, y, z), true, '低一格的近水也算湿润');
});

test('T1 干耕地随机刻：湿润或有作物时不退回泥土', () => {
  assert.equal(farmlandShouldRevert(70, false, false, 60), true, '干涸超过阈值要退回泥土');
  assert.equal(farmlandShouldRevert(59, false, false, 60), false, '未到阈值不退回');
  assert.equal(farmlandShouldRevert(999, true, false, 60), false, '湿润永不退回');
  assert.equal(farmlandShouldRevert(999, false, true, 60), false, '上方有小麦不退回');
  // 默认阈值 60 秒
  assert.equal(farmlandShouldRevert(61, false, false, undefined), true);
  assert.equal(farmlandShouldRevert(59, false, false, undefined), false);
});

test('T1 湿润耕地与小麦生长阶段都有独立贴图名', () => {
  assert.equal(tileForFace(B.FARMLAND, 0, 'top'), 'farmland', '干耕地上面');
  assert.equal(tileForFace(B.FARMLAND, 1, 'top'), 'farmland_wet', '湿润耕地上面');
  assert.equal(tileForFace(B.FARMLAND, 1, 'side'), 'dirt', '侧面仍是泥土，不受湿润位影响');
  assert.equal(tileForFace(B.WHEAT, 0, 'top'), 'wheat_0');
  assert.equal(tileForFace(B.WHEAT, 5, 'top'), 'wheat_1', '中期应有 wheat_1');
  assert.equal(tileForFace(B.WHEAT, 7, 'top'), 'wheat_2', '成熟应有 wheat_2');
});

/* ================= T2 床与自定义重生点（本轮新增） ================= */

test('T2 时间规则：只有夜里能睡，睡觉把时间推到清晨', () => {
  assert.equal(isNight(TIME_NIGHT), true, '午夜是夜晚');
  assert.equal(isNight(0.6), true, '日落之后是夜晚');
  assert.equal(isNight(NIGHT_START), true, '入夜边界算夜晚');
  assert.equal(isNight(NIGHT_START - 0.01), false, '入夜前不算夜晚');
  assert.equal(isNight(TIME_NOON), false, '正午不是夜晚');
  assert.equal(isNight(TIME_MORNING), false, '清晨不是夜晚（白天睡觉要拒绝）');
  assert.equal(isNight(0.0), true, '黎明前的一小段仍算夜晚');
  assert.equal(advanceToMorning(0.7), TIME_MORNING, '睡觉后到达清晨');
  assert.equal(advanceToMorning(0.9), TIME_MORNING);
  assert.ok(Math.abs(wrapTime(-0.2) - 0.8) < 1e-9, '负时间要绕回，实得 ' + wrapTime(-0.2));
  assert.ok(Math.abs(wrapTime(1.3) - 0.3) < 1e-9, '超过 1 的时间要绕回，实得 ' + wrapTime(1.3));
  assert.equal(wrapTime('abc'), 0, '非法值兜底为 0');
  assert.ok(isDay(TIME_NOON) && !isDay(TIME_NIGHT));
});

test('T2 床：配方、方块属性与朝向贴图', () => {
  const r = findRecipe(grid3([['wool', 'wool', 'wool'], ['planks', 'planks', 'planks']]));
  assert.ok(r && r.result.item === 'bed', '3 羊毛 + 3 木板应合成床：' + JSON.stringify(r && r.result));
  assert.ok(ITEMS.bed && ITEMS.bed.blockId === B.BED, '床物品要映射到床方块');
  assert.equal(blockToItem(B.BED), 'bed');
  const b = BLOCKS[B.BED];
  assert.ok(b && b.hardness > 0 && b.hardness < 1, '床应该很快被破坏');
  assert.deepEqual(blockDrops(B.BED, 0, () => 0.5), [{ item: 'bed', count: 1 }], '破坏床掉回床物品');
  assert.equal(hasFacing(B.BED), true, '床有朝向');
  assert.equal(tileForFace(B.BED, 2, 'posx'), 'bed_front', 'meta=2 时 +x 面是床头');
  assert.equal(tileForFace(B.BED, 0, 'posz'), 'bed_front');
  assert.equal(tileForFace(B.BED, 0, 'negx'), 'bed_side');
  assert.equal(tileForFace(B.BED, 0, 'top'), 'bed_top');
});

test('T2 羊毛有来源：羊是可生成的被动生物且掉羊毛', () => {
  const sheep = MOB_TYPES.sheep;
  assert.ok(sheep, '应注册羊');
  assert.equal(sheep.passive, true, '羊是被动物');
  assert.ok(sheep.drop.some(d => d.item === 'wool'), '羊必须掉羊毛');
  assert.ok(ITEMS.wool, '羊毛物品必须存在（否则床配方无原料）');
  assert.ok(typeof sheep.sound === 'string' && sheep.sound === 'sheep');
});

test('T2 每个贴图名与物品图标都有对应画笔（不会出现品红 missing 贴图）', () => {
  const faces = ['top', 'bottom', 'posx', 'negx', 'posz', 'negz'];
  const missingTiles = [];
  for (let id = 1; id < BLOCKS.length; id++) {
    if (!BLOCKS[id]) continue;
    for (let meta = 0; meta <= 7; meta++) {
      for (const f of faces) {
        const t = tileForFace(id, meta, f);
        if (t === 'air') continue;
        if (typeof blockPainters[t] !== 'function') missingTiles.push(BLOCKS[id].name + '/' + t);
      }
    }
  }
  assert.deepEqual(missingTiles, [], '缺少方块贴图画笔：' + missingTiles.slice(0, 8).join(', '));

  const missingIcons = [];
  for (const key of Object.keys(ITEMS)) {
    const it = ITEMS[key];
    const name = it.icon || key;
    if (it.blockId !== undefined && it.blockId !== null) {
      const b = BLOCKS[it.blockId];
      const tile = b && (b.tiles.side || b.tiles.all || b.tiles.top);
      if (tile && tile !== 'air' && typeof blockPainters[tile] !== 'function') missingIcons.push(key + '→' + tile);
      continue;
    }
    if (typeof itemPainters[name] !== 'function') missingIcons.push(key + '(' + name + ')');
  }
  assert.deepEqual(missingIcons, [], '缺少物品图标画笔：' + missingIcons.slice(0, 8).join(', '));
});

test('T3 弹道纯逻辑：蓄力决定初速度与伤害，箭会下坠、撞方块后插住', () => {
  assert.equal(arrowSpeedFor(0), ARROW_MIN_SPEED, '零蓄力为最小速度');
  assert.equal(arrowSpeedFor(1), ARROW_MAX_SPEED, '满蓄力为最大速度');
  assert.equal(arrowSpeedFor(2), ARROW_MAX_SPEED, '超出 1 要钳制');
  assert.ok(arrowSpeedFor(1) > arrowSpeedFor(0.5) && arrowSpeedFor(0.5) > arrowSpeedFor(0.2), '蓄力越久越快');
  assert.equal(arrowDamageFor(0), ARROW_MIN_DAMAGE);
  assert.equal(arrowDamageFor(1), ARROW_MAX_DAMAGE);
  assert.ok(arrowDamageFor(1) > arrowDamageFor(0), '蓄力越久越痛');

  const noSolid = () => false;
  const a = { x: 0.5, y: 40.5, z: 0.5, vx: 20, vy: 0, vz: 0, life: 6 };
  assert.equal(stepArrow(a, 0.1, noSolid), 'flying');
  assert.ok(Math.abs(a.vy + ARROW_GRAVITY * 0.1) < 1e-9, '一帧后竖直速度 = -g*dt');
  assert.ok(a.y < 40.5 && a.x > 0.5, '抛物线：前进且下坠');

  const b = { x: 0.5, y: 40.5, z: 0.5, vx: 30, vy: 0, vz: 0, life: 6 };
  assert.equal(stepArrow(b, 0.02, (x) => x === 1), 'stuck', '撞上方块应插住');
  assert.equal(b.stuck, true);
  assert.equal(b.vx, 0, '插住后不再移动');
  const before = { x: b.x, y: b.y, z: b.z };
  stepArrow(b, 0.2, () => false);
  assert.equal(b.x, before.x, '插住后 x 不再变化');
  assert.equal(b.y, before.y, '插住后 y 不再变化');
  assert.equal(b.z, before.z, '插住后 z 不再变化');

  const c = { x: 0.5, y: 40.5, z: 0.5, vx: 0, vy: 0, vz: 0, life: 0.01, stuck: true };
  assert.equal(stepArrow(c, 0.02, noSolid), 'expired', '插着的箭到期要回收');
});

test('T3 命中与拾回判定', () => {
  const box = { x: 10, y: 40, z: 10, w: 0.6, h: 1.9 };
  assert.equal(arrowHitsBox({ x: 10.1, y: 41, z: 10.05 }, box), true, '射进身体算命中');
  assert.equal(arrowHitsBox({ x: 10.5, y: 41, z: 10 }, box), false, '水平擦边不算');
  assert.equal(arrowHitsBox({ x: 10, y: 44, z: 10 }, box), false, '飞过头顶不算');
  assert.equal(arrowHitsBox({ x: 10, y: 39, z: 10 }, box), false, '钻到脚下不算');
  assert.equal(arrowHitsBox({ x: 10, y: 41, z: 10, stuck: true }, box), false, '插住的箭不再判命中');
  // 调用方必须给全 {x,y,z,w,h}：缺 z 时不能「碰巧命中」（写 mobs.js 时漏传 z 就是这个坑）
  assert.equal(arrowHitsBox({ x: 10.05, y: 41, z: 10.05 }, { x: 10, y: 40, w: 0.6, h: 1.9 }), false, '盒子缺 z 不应命中');
  assert.equal(canPickupStuck({ x: 10, y: 41, z: 10, stuck: true }, 10.5, 40.5, 10.5), true, '走近能捡回');
  assert.equal(canPickupStuck({ x: 10, y: 41, z: 10 }, 10, 40, 10), false, '还在飞的箭不能被拾取');
  assert.equal(canPickupStuck({ x: 10, y: 41, z: 10, stuck: true }, 19, 40, 19), false, '太远捡不到');
  assert.equal(bowCanFire(0.05), false, '蓄力太短不射出');
  assert.equal(bowCanFire(BOW_MIN_CHARGE), true, '达到最小蓄力就能射出');
  assert.equal(bowCanFire(1), true);
  assert.ok(BOW_CHARGE_SECONDS > 0.4 && BOW_CHARGE_SECONDS < 2, '蓄满时间要手感合理');
});

test('T3 弓与箭：材料链羊→羊毛→线→弓 / 燧石+木棍+羽毛→箭', () => {
  let r = findRecipe([['wool']]);
  assert.ok(r && r.result.item === 'string' && r.result.count === 2, '1 羊毛应拆成 2 线：' + JSON.stringify(r && r.result));
  r = findRecipe(grid3([['flint'], ['stick'], ['feather']]));
  assert.ok(r && r.result.item === 'arrow' && r.result.count === 4, '燧石+木棍+羽毛应合成 4 支箭');
  r = findRecipe(grid3([['stick', 'stick', 'string'], ['stick', null, 'string'], [null, null, 'string']]));
  assert.ok(r && r.result.item === 'bow', '3 木棍 + 3 线应合成弓');
  const bow = ITEMS.bow;
  assert.ok(bow && bow.bow === true, '弓要有 bow 标记（交互层靠它切换到蓄力）');
  assert.equal(bow.stack, 1, '弓不可堆叠');
  assert.ok(bow.durability >= 100, '弓要有耐久');
  assert.ok(!bow.toolType, '弓不是工具，不参与挖掘');
  assert.ok(ITEMS.arrow, '箭物品必须存在');
  assert.equal(blockToItem(B.COBBLESTONE), 'cobblestone', '（顺带确认映射没被破坏）');
});

test('T4 台阶高度与接触伤害方块的纯规则', () => {
  assert.equal(STEP_HEIGHT, 1.05, '台阶上限 1.05 格');
  assert.equal(stepTargetY(40), 41, '整格脚底 → 抬到上一格顶面');
  assert.equal(stepTargetY(40.05), 41);
  assert.equal(stepTargetY(40.6), 41, '已经站在半格上也能再上一格');
  assert.equal(stepTargetY(39.999), 40, '脚底差一点点没到 40 → 抬到 40 顶面（抬升 0.001）');
  assert.equal(stepTargetY(40, 0.5), null, '抬升 1.0 超过上限 0.5 要拒绝');
  assert.equal(stepTargetY(40.6, 0.5), 41, '抬升 0.4 在上限内');
  assert.equal(hurtsOnTouch(B.CACTUS), true, '仙人掌接触掉血');
  assert.equal(hurtsOnTouch(B.DIRT), false);
  assert.equal(hurtsOnTouch(B.STONE), false);
  assert.equal(hurtsOnTouch(AIR), false);
  assert.equal(hurtsOnTouch(B.FARMLAND), false, '耕地不伤脚');
});

test('T4 自动上台阶：1 格走上去、潜行不上、2 格挡住、不踩仙人掌', () => {
  const w = new VoxelWorld(31415);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const x = 8, z = 8;
  const gy = w.topSolidY(x, z);
  // 造一条 13 格长的平整走廊：地板统一在 gy，上方全清空，避免自然地形干扰
  for (let d = 0; d <= 12; d++) {
    w.setBlock(x, gy, z - d, B.STONE, 0);
    for (let h = 1; h <= 4; h++) w.setBlock(x, gy + h, z - d, AIR, 0);
  }
  const walk = (ctrl, input, steps) => {
    let maxY = ctrl.pos.y, ups = 0;
    ctrl.on('stepup', () => { ups++; });
    for (let i = 0; i < steps; i++) {
      ctrl.update(0.02, input);
      if (ctrl.pos.y > maxY) maxY = ctrl.pos.y;
    }
    return { maxY, ups, y: ctrl.pos.y, z: ctrl.pos.z };
  };
  const fwd = { keyW: true, keyS: false, keyA: false, keyD: false, jump: false, sprint: false, sneak: false };

  w.setBlock(x, gy + 1, z - 1, B.STONE, 0);            // 1 格高的台阶
  const c = new PlayerController(w);
  c.spawnAt(x + 0.5, gy + 1, z + 0.5);
  c.yaw = 0;
  const r1 = walk(c, fwd, 120);
  assert.ok(r1.maxY >= gy + 1.9, '应被抬上 1 格台阶，最高 y=' + r1.maxY.toFixed(2) + ' 地面=' + (gy + 1));
  assert.ok(r1.ups >= 1, 'stepup 事件要触发，实得 ' + r1.ups);
  assert.ok(r1.z < z - 1.5, '并且走过台阶继续向前，实得 z=' + r1.z.toFixed(2));

  // 潜行时不会自动上台阶
  const c2 = new PlayerController(w);
  c2.spawnAt(x + 0.5, gy + 1, z + 0.5);
  c2.yaw = 0;
  const r2 = walk(c2, { keyW: true, keyS: false, keyA: false, keyD: false, jump: false, sprint: false, sneak: true }, 120);
  assert.ok(r2.maxY < gy + 1.9, '潜行不该自动上台，最高 y=' + r2.maxY.toFixed(2));
  assert.equal(r2.ups, 0, '潜行时不应触发 stepup');

  // 2 格高的墙挡住
  w.setBlock(x, gy + 2, z - 1, B.STONE, 0);
  const c3 = new PlayerController(w);
  c3.spawnAt(x + 0.5, gy + 1, z + 0.5);
  c3.yaw = 0;
  const r3 = walk(c3, fwd, 120);
  assert.ok(r3.z > z - 1, '2 格墙要挡住去路，实得 z=' + r3.z.toFixed(2));
  assert.ok(r3.y < gy + 1.5, '最终仍站在地面层，实得 y=' + r3.y.toFixed(2) + '（地面 ' + (gy + 1) + '）');
  w.setBlock(x, gy + 2, z - 1, AIR, 0);

  // 不允许自动踩到仙人掌上，且贴着仙人掌会掉血
  w.setBlock(x, gy + 1, z - 1, AIR, 0);
  w.setBlock(x, gy + 1, z - 1, B.CACTUS, 0);
  const c4 = new PlayerController(w);
  c4.spawnAt(x + 0.5, gy + 1, z + 0.5);
  c4.yaw = 0;
  const hp0 = c4.health;
  const r4 = walk(c4, fwd, 150);
  assert.ok(r4.z > z - 1, '仙人掌要挡住去路，实得 z=' + r4.z.toFixed(2));
  assert.ok(c4.health < hp0, '持续贴仙人掌要掉血，hp ' + hp0 + '→' + c4.health);
  assert.ok(c4.touchingHazard(), '贴着仙人掌时接触判定要成立');
  c4.spawnAt(x + 0.5, gy + 1, z - 4.5);          // 走廊内、离仙人掌 3.5 格远
  const hpFar = c4.health;
  for (let i = 0; i < 60; i++) c4.update(0.02, { keyW: false, keyS: false, keyA: false, keyD: false, jump: false, sprint: false, sneak: false });
  assert.ok(c4.health >= hpFar, '离开仙人掌后不再掉血（吃饱了会自然回血，所以只要求不降）：' + hpFar + '→' + c4.health);
});

test('T2 旧存档兼容：基线版的方块 diff 格式仍能读入，缺新字段不报错', () => {
  const w = new VoxelWorld(24680);
  w.ensureChunk(0, 0);
  const i = idx(3, 50, 4);                     // 区块内 (3,50,4)
  // 基线（T1/T2 之前）的 diff 就是 [i, id, meta] 扁平数组，且完全没有 farmlands/bed 这些键
  const oldEdits = {};
  oldEdits[coordKey(0, 0)] = [i, B.COBBLESTONE, 0];
  const oldSave = { meta: { version: 1 }, player: { x: 8.5, y: 50, z: 8.5 }, chunks: oldEdits, furnaces: {} };
  assert.equal(oldSave.player.bed, undefined, '旧档确实没有 player.bed');
  assert.equal(oldSave.farmlands, undefined, '旧档确实没有 farmlands');
  w.applySavedData(oldSave.chunks || {});
  assert.equal(w.getBlock(3, 50, 4), B.COBBLESTONE, '旧格式 diff 应照常生效');
  w.applyFurnaces(oldSave.furnaces || {});
  assert.deepEqual(w.serializeFurnaces(), {}, '缺字段时熔炉表应为空而不是抛错');
  assert.deepEqual(w.serializeContainers(), {}, '旧档没有 containers 键时也应返回空表');
});

/* ================= 缺陷排查（D1~D6）：回归断言 ================= */

test('回归：左键攻击生物不能因 Game 上缺 items 属性而抛异常（D1）', () => {
  const w = new VoxelWorld(2233);
  w.ensureChunk(0, 0);
  const controller = {
    pos: { x: 0.5, y: 40, z: 0.5 },
    get eyeY() { return this.pos.y + 1.62; },
    lookDir: () => ({ x: 0, y: 0, z: -1 }),
    hurt() { }
  };
  const ctx = {
    world: w,
    scene: { add() { }, remove() { } },
    sfx: { play() { } },
    particles: { spawn() { } },
    controller,
    inventory: { held: () => ({ item: 'pickaxe_wood', count: 1 }) },
    game: { spawnDrop() { } }          // 与真实 Game 一致：并没有 items 这个属性
  };
  const mm = new MobManager(ctx);
  const pig = mm.spawn('pig', 0.5, 40, -2);
  assert.ok(pig, '应能生成猪');
  const hp0 = pig.hp;
  let target = null;
  assert.doesNotThrow(() => { target = mm.attackMelee(5); }, 'attackMelee 不允许抛异常');
  assert.equal(target, pig, '应命中正前方的猪');
  assert.equal(pig.hp, hp0 - ITEMS.pickaxe_wood.damage, '伤害要按手持工具的 damage 算');
});

test('回归：生物移动方向必须与模型正面一致，不能倒退着走（D3，8 个方向）', () => {
  // 模型正面约定（读 mobs.js 得到，不是套公式）：猪/牛/羊/鸡的 head 与 nose 都摆在 +Z，
  // 而 render() 里是 mesh.rotation.y = yaw。three.js 绕 Y 旋转把局部 +Z 映射到世界 (sin yaw, cos yaw)。
  const modelForward = (yaw) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });

  const w = new VoxelWorld(777);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  // 造一块 11x11 的平地，避免 AI 的「前方无地面就转向」干扰方向判定
  const cx0 = 8, cz0 = 8, fy = 40;
  for (let dz = -5; dz <= 5; dz++) {
    for (let dx = -5; dx <= 5; dx++) {
      w.setBlock(cx0 + dx, fy, cz0 + dz, B.STONE, 0);
      for (let h = 1; h <= 4; h++) w.setBlock(cx0 + dx, fy + h, cz0 + dz, AIR, 0);
    }
  }
  const ctx = {
    world: w,
    scene: { add() { }, remove() { } },
    sfx: { play() { } },
    particles: { spawn() { } },
    controller: { pos: { x: 0.5, y: 40, z: 40 }, health: 20, creative: false, lookDir: () => ({ x: 0, y: 0, z: -1 }) },
    inventory: { held: () => null },
    game: { state: 'playing', spawnDrop() { } }
  };
  const mm = new MobManager(ctx);
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2],
    [-Math.SQRT1_2, Math.SQRT1_2], [-Math.SQRT1_2, -Math.SQRT1_2]
  ];
  for (const [fx, fz] of dirs) {
    const m = mm.spawn('pig', cx0 + 0.5, fy + 1, cz0 + 0.5);
    const yaw = Math.atan2(fx, fz);                 // 让模型正面正好指向 (fx, fz)
    m.yaw = yaw; m.walking = true; m.wanderT = 999;  // 固定航向，排除随机转向
    m.vel.x = 0; m.vel.z = 0; m.vel.y = 0;
    for (let i = 0; i < 12; i++) mm.ai(m, 0.05, 900, 1);
    const sp = Math.hypot(m.vel.x, m.vel.z);
    assert.ok(sp > 0.2, '方向 (' + fx + ',' + fz + ') 上 AI 应产生位移，实得速度=' + sp.toFixed(3));
    const mf = modelForward(m.yaw);
    const dot = (m.vel.x / sp) * mf.x + (m.vel.z / sp) * mf.z;
    assert.ok(dot > 0.99,
      '方向 (' + fx + ',' + fz + ')：位移必须与模型正面同向，实得点积=' + dot.toFixed(3) + '（负值=倒退着走）');
    mm.clear();
  }

  // 敌怪追击：位移与正面都必须指向玩家（另一条 yaw 约定分支，也要有守卫）
  const targets = [[cx0 + 6.5, cz0 + 0.5], [cx0 - 6.5, cz0 + 0.5], [cx0 + 0.5, cz0 + 6.5], [cx0 + 0.5, cz0 - 6.5]];
  for (const [tx, tz] of targets) {
    const z = mm.spawn('zombie', cx0 + 0.5, fy + 1, cz0 + 0.5);
    ctx.controller.pos.x = tx; ctx.controller.pos.z = tz;
    z.vel.x = 0; z.vel.z = 0; z.vel.y = 0;
    const d2 = (tx - cx0 - 0.5) ** 2 + (tz - cz0 - 0.5) ** 2;
    for (let i = 0; i < 10; i++) mm.ai(z, 0.05, d2, 1);
    const sp = Math.hypot(z.vel.x, z.vel.z);
    assert.ok(sp > 0.1, '敌怪应向玩家移动，实得速度=' + sp.toFixed(3));
    const mf = modelForward(z.yaw);
    const dot = (z.vel.x / sp) * mf.x + (z.vel.z / sp) * mf.z;
    assert.ok(dot > 0.99, '敌怪追击时位移要与正面同向，点积=' + dot.toFixed(3));
    const tox = tx - (cx0 + 0.5), toz = tz - (cz0 + 0.5), L = Math.hypot(tox, toz);
    assert.ok(Math.abs(mf.x - tox / L) < 0.02 && Math.abs(mf.z - toz / L) < 0.02,
      '敌怪正面应朝向玩家：正面=(' + mf.x.toFixed(2) + ',' + mf.z.toFixed(2) + ') 期望=(' +
      (tox / L).toFixed(2) + ',' + (toz / L).toFixed(2) + ')');
    mm.clear();
  }
});

test('回归：spawnAt 卡进方块时的顶出最小且有界，不会造成垂直瞬移（D2 嫌疑 2）', () => {
  const w = new VoxelWorld(27182);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const x = 8, z = 8;
  const gy = w.topSolidY(x, z);
  for (let d = 0; d <= 6; d++) {
    w.setBlock(x, gy, z - d, B.STONE, 0);
    for (let h = 1; h <= 14; h++) w.setBlock(x, gy + h, z - d, AIR, 0);
  }
  const idle = { keyW: false, keyS: false, keyA: false, keyD: false, jump: false, sprint: false, sneak: false };

  // A) 空格子上放人：一格都不许顶（否则「站得好好的突然升高」就是玩家看到的瞬移）
  const cA = new PlayerController(w);
  let teleA = 0;
  cA.on('teleport', () => { teleA++; });
  cA.spawnAt(x + 0.5, gy + 1, z + 0.5);
  assert.equal(cA.pos.y, gy + 1, '站在空位不该被上顶，实得 y=' + cA.pos.y + ' 期望 ' + (gy + 1));
  assert.equal(teleA, 1, '一次 spawnAt 只发一次 teleport 事件（监视器靠它豁免刻意传送），实得 ' + teleA);
  for (let i = 0; i < 30; i++) cA.update(0.02, idle);
  assert.ok(Math.abs(cA.pos.y - (gy + 1)) < 0.02,
    '站稳后 y 不许漂移（容差 0.02 格，抓得住任何整格级别的漂移），实得 ' + cA.pos.y);

  // B) 被 3 格实心埋住：只顶到第一个能站下的位置，一格都不许多
  for (let h = 1; h <= 3; h++) w.setBlock(x, gy + h, z, B.STONE, 0);
  const cB = new PlayerController(w);
  cB.spawnAt(x + 0.5, gy + 1, z + 0.5);
  assert.ok(!cB.intersectsSolid(cB.pos.x, cB.pos.y, cB.pos.z), '顶出后必须站在空位，y=' + cB.pos.y);
  assert.ok(cB.intersectsSolid(cB.pos.x, cB.pos.y - 1, cB.pos.z),
    '再低一格就应当卡住（说明没有多顶一格），y=' + cB.pos.y);
  assert.ok(cB.pos.y - (gy + 1) <= 4, '上顶距离不超过埋住格数+1，实得 ' + (cB.pos.y - (gy + 1)).toFixed(2));
  for (let h = 1; h <= 3; h++) w.setBlock(x, gy + h, z, AIR, 0);

  // C) 整列一直塞到世界高度：guard 必须收住（不许死循环，也不许把人顶出世界）
  for (let h = 1; h <= WORLD_H + 2; h++) w.setBlock(x, gy + h, z, B.STONE, 0);
  const cC = new PlayerController(w);
  const t0 = Date.now();
  cC.spawnAt(x + 0.5, gy + 1, z + 0.5);
  const cost = Date.now() - t0;
  assert.ok(cost < 2000, '顶出循环要在 2 秒内返回，实得 ' + cost + 'ms');
  assert.ok(cC.pos.y - (gy + 1) <= WORLD_H + 1,
    '顶出必须有界，实得上移 ' + (cC.pos.y - (gy + 1)).toFixed(2) + ' 上限 ' + (WORLD_H + 1));
});

/* ================= 天气系统（W1~W7）：纯逻辑，可无头测试 ================= */
/* 先红后绿：这些断言在 core/weather.js 还不存在时就该整体报错（import 失败），
   实现完成后必须全绿。切换类型走注入的 rnd，保证测试确定性。 */
test('天气 W1 默认晴天，三种天气的光照因子与名称齐备', async () => {
  const { WEATHER_TYPES, WEATHER_LABEL, weatherLight, Weather } = await import('../renderer/js/core/weather.js');
  assert.deepEqual([...WEATHER_TYPES].sort(), ['clear', 'rain', 'snow']);
  for (const t of WEATHER_TYPES) assert.ok(WEATHER_LABEL[t] && WEATHER_LABEL[t].length >= 1, t + ' 要有中文名');
  assert.equal(weatherLight('clear'), 1, '晴天不额外压暗');
  assert.ok(weatherLight('rain') < weatherLight('snow') && weatherLight('snow') < 1,
    '雨天应比雪天更暗，实得 rain=' + weatherLight('rain') + ' snow=' + weatherLight('snow'));
  const w = new Weather();
  assert.equal(w.type, 'clear', '新建应为晴天');
  assert.equal(w.isWet, false);
});

test('天气 W2 倒计时到点必须切换，且类型永远在集合内', async () => {
  const { WEATHER_TYPES, Weather } = await import('../renderer/js/core/weather.js');
  let seed = 20261013;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const w = new Weather(rnd);
  let switches = 0;
  for (let i = 0; i < 400000; i++) {
    const before = w.type;
    w.update(0.05);
    assert.ok(WEATHER_TYPES.includes(w.type), '非法天气类型: ' + w.type);
    assert.ok(w.timeLeft > 0, 'timeLeft 必须始终为正，实得 ' + w.timeLeft);
    if (w.type !== before) switches++;
    if (switches >= 40) break;
  }
  assert.ok(switches >= 40, '40 万步内应至少切换 40 次，实得 ' + switches);
});

test('天气 W3 同一颗随机种子给出完全相同的切换序列（确定性）', async () => {
  const { Weather } = await import('../renderer/js/core/weather.js');
  const run = () => {
    let s = 777;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const w = new Weather(rnd);
    const seq = [];
    // 推进约 3 小时（45000 × 0.2 秒 = 9000 秒）：天气单段最短也有 45 秒，
    // 只推 12 秒是看不到切换的（第一版就这么错过了，见排查日志）
    for (let i = 0; i < 45000; i++) {
      const b = w.type;
      w.update(0.2);
      if (w.type !== b) seq.push(w.type + ':' + Math.round(w.timeLeft));
    }
    return seq;
  };
  const a = run(), b = run();
  assert.ok(a.length >= 2, '推进 9000 秒内应至少切换 2 次，实得 ' + a.length);
  assert.deepEqual(a, b, '两次同种子的切换序列必须一致');
});

test('天气 W4 强度渐入渐出：刚切换不为 1，8 秒内到 1，结束前落到 0', async () => {
  const { Weather } = await import('../renderer/js/core/weather.js');
  const w = new Weather(() => 0.1);
  w.set('rain', 60);
  assert.ok(w.intensity < 0.2, '刚开始时强度应接近 0，实得 ' + w.intensity);
  for (let i = 0; i < 200; i++) w.update(0.05);          // 10 秒
  assert.ok(w.intensity > 0.95, '10 秒后应下满，实得 ' + w.intensity);
  assert.equal(w.isWet, true, '下雨时 isWet 为真');
  w.timeLeft = 3;                                        // 快到期
  for (let i = 0; i < 80; i++) w.update(0.05);           // 再走 4 秒（含切换后的新阶段）
  assert.ok(w.timeLeft > 0, '到期后必须已进入下一段，timeLeft=' + w.timeLeft);
});

test('天气 W5 存档往返：serialize/deserialize 保持类型与剩余时间', async () => {
  const { Weather } = await import('../renderer/js/core/weather.js');
  const w = new Weather(() => 0.5);
  w.set('snow', 123.456);
  const obj = JSON.parse(JSON.stringify(w.serialize()));
  const w2 = Weather.deserialize(obj);
  assert.equal(w2.type, 'snow');
  assert.ok(Math.abs(w2.timeLeft - 123.456) < 0.01, '实得 ' + w2.timeLeft);
  assert.equal(w2.intensity, w.intensity, '强度也应还原（避免读档后雨突然变大）');
});

test('天气 W6 旧存档兼容：完全没有 weather 字段也必须读成晴天且不抛异常', async () => {
  const { Weather } = await import('../renderer/js/core/weather.js');
  for (const bad of [undefined, null, {}, 0, 'rain', [], { t: 'thunder' }, { t: 'rain' }, { t: 'rain', left: -5 }, { t: 'rain', left: 'x' }]) {
    let w;
    assert.doesNotThrow(() => { w = Weather.deserialize(bad); }, 'deserialize 不许抛异常：' + JSON.stringify(bad));
    assert.ok(['clear', 'rain', 'snow'].includes(w.type), '必须回落到合法值，实得 ' + w.type + ' 输入 ' + JSON.stringify(bad));
    assert.ok(w.timeLeft > 0, 'timeLeft 必须为正，实得 ' + w.timeLeft + ' 输入 ' + JSON.stringify(bad));
  }
  const w = Weather.deserialize({ t: 'rain', left: 20 });
  assert.equal(w.type, 'rain');
  assert.equal(w.isWet, true);
});

test('天气 W7 降水时长按配置范围，且晴天时长明显更长', async () => {
  const { Weather, WEATHER_RANGE, WEATHER_TYPES } = await import('../renderer/js/core/weather.js');
  assert.ok(WEATHER_RANGE && WEATHER_RANGE.clear && WEATHER_RANGE.rain && WEATHER_RANGE.snow, '缺少时长配置');
  const seen = { clear: [], rain: [], snow: [] };
  for (let i = 0; i < 400; i++) {
    let s = i * 7919 + 13;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const w = new Weather(rnd);
    w.roll(WEATHER_TYPES[i % WEATHER_TYPES.length]);      // 三种类型轮流取样
    seen[w.type].push(w.timeLeft);
  }
  for (const t of ['clear', 'rain', 'snow']) {
    assert.ok(seen[t].length > 0, t + ' 一次都没出现过');
    for (const v of seen[t]) {
      assert.ok(v >= WEATHER_RANGE[t][0] - 1e-6 && v <= WEATHER_RANGE[t][1] + 1e-6,
        t + ' 时长越界: ' + v + ' 范围 ' + JSON.stringify(WEATHER_RANGE[t]));
    }
  }
  assert.ok(WEATHER_RANGE.clear[0] > WEATHER_RANGE.rain[1] || WEATHER_RANGE.clear[0] >= 90,
    '晴天应当明显更长，配置=' + JSON.stringify(WEATHER_RANGE.clear));
});

test('天气 W8 自然到点是渐出，显式 set 是立即生效', async () => {
  const { Weather } = await import('../renderer/js/core/weather.js');
  const w = new Weather(() => 0.5);
  w.set('rain', 40);
  for (let i = 0; i < 400; i++) w.update(0.05);        // 20 秒
  assert.ok(w.intensity > 0.95, '20 秒后应下满，实得 ' + w.intensity);
  w.timeLeft = 2.5;                                    // 模拟「还剩 2.5 秒就停」
  for (let i = 0; i < 20; i++) w.update(0.05);         // 再走 1 秒
  assert.ok(w.intensity < 0.8 && w.intensity > 0.05,
    '结束前应当渐出，而不是突然消失或还在满值，实得 ' + w.intensity);
  w.set('clear');
  assert.equal(w.intensity, 0, '显式 set 要立即生效（睡觉放晴这类指令不该还挂着一屏雨滴）');
  assert.equal(w.type, 'clear');
});

/* ================= 剪刀与剪羊毛（S1~S4） ================= */
/* 先红后绿：这一批断言在 shears 物品/配方/剪毛逻辑还不存在时必须报红。 */
test('剪刀 S1 物品、配方与图标画笔齐备（全覆盖单测会盯着图标）', () => {
  assert.ok(ITEMS.shears, 'ITEMS 里没有 shears');
  assert.equal(ITEMS.shears.shears, true, 'shears 要有 shears:true 标记，右键分支靠它');
  assert.equal(ITEMS.shears.stack, 1, '剪刀不可堆叠');
  assert.equal(ITEMS.shears.durability, 64, '剪刀耐久 64（与原版一致）');
  assert.equal(typeof itemPainters.shears, 'function', '缺少剪刀图标画笔');
  const g2 = (rows) => {
    const grid = [['', '', ''], ['', '', ''], ['', '', '']].map(r => r.slice());
    rows.forEach((row, y) => row.forEach((cell, x) => { grid[y][x] = cell || null; }));
    return grid;
  };
  // 2 铁锭斜角 + 2 木棍（本作配方，见 recipes.js 注释）
  const r = findRecipe(g2([['iron_ingot', null], [null, 'iron_ingot'], ['stick', 'stick']]));
  assert.ok(r && r.result && r.result.item === 'shears',
    '铁锭×2 + 木棍×2 应能合成剪刀，实得 ' + JSON.stringify(r && r.result));
});

const sheepCtx = () => {
  const w = new VoxelWorld(4242);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const cx0 = 8, cz0 = 8, fy = 40;
  for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) {
    w.setBlock(cx0 + dx, fy, cz0 + dz, B.STONE, 0);
    for (let h = 1; h <= 4; h++) w.setBlock(cx0 + dx, fy + h, cz0 + dz, AIR, 0);
  }
  const dropped = [];
  const ctx = {
    world: w,
    scene: { add() { }, remove() { } },
    sfx: { play() { } },
    particles: { spawn() { } },
    controller: {
      pos: { x: cx0 + 0.5, y: fy + 1, z: cz0 + 2.5 }, health: 20, creative: false,
      lookDir: () => ({ x: 0, y: -0.1, z: -1 })
    },
    inventory: { held: () => ({ item: 'shears', count: 1 }) },
    game: { state: 'playing', spawnDrop(item, n, x, y, z) { dropped.push({ item, n }); } }
  };
  const mm = new MobManager(ctx);
  return { mm, ctx, dropped, cx0, cz0, fy };
};

test('剪刀 S2 右键剪羊：掉 1~3 羊毛、羊变秃、秃羊不能再剪、到时间会长回来', () => {
  const { mm, dropped, cx0, cz0, fy } = sheepCtx();
  const sheep = mm.spawn('sheep', cx0 + 0.5, fy + 1, cz0 + 0.5);
  assert.ok(sheep, '羊要能生成');
  assert.equal(sheep.sheared, false, '刚生成的羊应是有毛的');
  const got = mm.shear(3.6);
  assert.equal(got, sheep, 'shear() 要返回被剪的那只羊');
  assert.equal(sheep.sheared, true, '剪完应变秃');
  assert.equal(dropped.length, 1, '应产生一次掉落，实得 ' + JSON.stringify(dropped));
  assert.equal(dropped[0].item, 'wool');
  assert.ok(dropped[0].n >= 1 && dropped[0].n <= 3, '羊毛数量应在 1~3，实得 ' + dropped[0].n);
  assert.equal(mm.shear(3.6), null, '秃羊不该被再剪一次');
  assert.equal(dropped.length, 1, '第二次剪不该再掉毛');
  assert.ok(SHEEP_REGROW_SECONDS >= 30 && SHEEP_REGROW_SECONDS <= 600,
    '羊毛再生时长应在 30~600 秒，实得 ' + SHEEP_REGROW_SECONDS);
  mm.maxMobs = 0;                                  // 关掉随机刷怪，避免新的羊干扰剪毛目标
  const home = { x: sheep.pos.x, y: sheep.pos.y, z: sheep.pos.z };
  for (let i = 0; i < SHEEP_REGROW_SECONDS + 2; i++) {
    mm.update(1, 1);
    // 一步 1 秒会把羊的漫游 AI 放大成「走出射程」，这里把它钉回原位，只测再生本身
    sheep.pos.x = home.x; sheep.pos.y = home.y; sheep.pos.z = home.z;
    sheep.vel.x = sheep.vel.y = sheep.vel.z = 0;
  }
  assert.equal(sheep.sheared, false, '到时间后羊毛要长回来（' + SHEEP_REGROW_SECONDS + ' 秒）');
  assert.ok(mm.shear(3.6) === sheep, '长回来之后可以再剪');
});

test('剪刀 S3 剪毛状态活过存档：serialize → applySaved 保留，旧档没有该字段也不崩', () => {
  const { mm, cx0, cz0, fy } = sheepCtx();
  const sheep = mm.spawn('sheep', cx0 + 0.5, fy + 1, cz0 + 0.5);
  mm.shear(3.6);
  assert.equal(sheep.sheared, true);
  const data = mm.serialize();
  const mm2 = new MobManager({
    world: mm.ctx.world, scene: { add() { }, remove() { } }, sfx: { play() { } },
    particles: { spawn() { } }, controller: mm.ctx.controller,
    inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
  });
  mm2.applySaved(JSON.parse(JSON.stringify(data)));
  const back = mm2.list.filter(m => m.type === 'sheep');
  assert.equal(back.length, 1, '读档后羊要还在');
  assert.equal(back[0].sheared, true, '秃的状态必须活过读档');
  // 旧格式（完全没有 sh 字段）
  const old = JSON.parse(JSON.stringify(data));
  for (const s of old) delete s.sh;
  mm2.applySaved(old);
  const back2 = mm2.list.filter(m => m.type === 'sheep');
  assert.equal(back2.length, 1);
  assert.equal(back2[0].sheared, false, '旧档没有 sh 字段时应视为有毛，而不是报错或秃着');
});

test('剪刀 S4 秃羊模型与有毛模型不同，且猪/牛不能被剪', () => {
  const { mm, cx0, cz0, fy } = sheepCtx();
  const sheep = mm.spawn('sheep', cx0 + 0.5, fy + 1, cz0 + 0.5);
  const hairy = sheep.mesh;
  mm.shear(3.6);
  assert.notEqual(sheep.mesh, hairy, '剪毛后要换一套模型（不能只改个数字）');
  const vol = (g) => {
    let v = 0;
    g.traverse(o => {
      if (o.geometry && o.geometry.parameters) {
        const p = o.geometry.parameters;
        v += (p.width || 0) * (p.height || 0) * (p.depth || 0);
      }
    });
    return v;
  };
  assert.ok(vol(sheep.mesh) < vol(hairy) * 0.9,
    '秃羊的身体体积要明显更小：' + vol(sheep.mesh).toFixed(3) + ' vs ' + vol(hairy).toFixed(3));
  const pig = mm.spawn('pig', cx0 + 0.5, fy + 1, cz0 + 1.5);
  assert.ok(pig);
  assert.equal(mm.shear(3.6), null, '猪不能被剪');
});

/* ================= 生物繁殖（B1~B5）：先红后绿 ================= */
const breedCtx = (held) => {
  const w = new VoxelWorld(31337);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const cx0 = 8, cz0 = 8, fy = 40;
  for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
    w.setBlock(cx0 + dx, fy, cz0 + dz, B.STONE, 0);
    for (let h = 1; h <= 5; h++) w.setBlock(cx0 + dx, fy + h, cz0 + dz, AIR, 0);
  }
  const added = [];
  const ctx = {
    world: w, scene: { add() { }, remove() { } }, sfx: { play() { } },
    particles: { spawn() { } },
    controller: {
      pos: { x: cx0 + 0.5, y: fy + 1, z: cz0 + 4.5 }, health: 20, creative: false,
      lookDir: () => ({ x: 0, y: -0.1, z: -1 })
    },
    inventory: { held: () => (held ? { item: held, count: 5 } : null) },
    game: { state: 'playing', spawnDrop() { }, onMobBred: (b) => added.push(b) }
  };
  return { ctx, mm: new MobManager(ctx), cx0, cz0, fy, added };
};

test('繁殖 B1 四种家畜可繁殖、食物都在物品表里、敌怪不可繁殖', async () => {
  const { MOB_TYPES: T } = await import('../renderer/js/world/mobs.js');
  const { ITEMS: IT } = await import('../renderer/js/core/items.js');
  for (const t of ['pig', 'cow', 'sheep', 'chicken']) {
    assert.ok(T[t].breedable, t + ' 应可繁殖');
    assert.ok(Array.isArray(T[t].food) && T[t].food.length >= 1, t + ' 要有食物列表');
    for (const f of T[t].food) assert.ok(IT[f], t + ' 的食物 ' + f + ' 不在物品表里');
  }
  for (const t of ['zombie', 'skeleton']) assert.ok(!T[t].breedable, t + ' 不该能繁殖');
});

test('繁殖 B2 食物不对 / 没有配偶 / 冷却中 都不许成功，且不消耗任何东西', async () => {
  const c1 = breedCtx('wheat');
  const p1 = c1.mm.spawn('pig', c1.cx0 + 0.5, c1.fy + 1, c1.cz0 + 2.5);
  const r1 = c1.mm.feedNearby(3.6);
  assert.ok(r1 && r1.ok === false, '猪不吃小麦，应失败，实得 ' + JSON.stringify(r1 && r1.reason));
  assert.equal(r1.reason, 'no_target', '食物不对应报 no_target，实得 ' + r1.reason);
  assert.equal(p1.breedCd, 0, '失败不许进冷却');

  const c2 = breedCtx('carrot');
  c2.mm.spawn('pig', c2.cx0 + 0.5, c2.fy + 1, c2.cz0 + 2.5);      // 只有一只，没有配偶
  const r2 = c2.mm.feedNearby(3.6);
  assert.ok(r2 && r2.ok === false && r2.reason === 'no_partner', '缺配偶应报 no_partner，实得 ' + JSON.stringify(r2));

  const c3 = breedCtx('carrot');
  const a3 = c3.mm.spawn('pig', c3.cx0 + 0.5, c3.fy + 1, c3.cz0 + 2.5);
  const b3 = c3.mm.spawn('pig', c3.cx0 + 2.5, c3.fy + 1, c3.cz0 + 2.5);
  const r3 = c3.mm.feedNearby(3.6);
  assert.ok(r3 && r3.ok === true, '两只猪 + 胡萝卜应成功，实得 ' + JSON.stringify(r3 && r3.reason));
  const cd = BREED_COOLDOWN_SECONDS;
  assert.ok(a3.breedCd > 0 && b3.breedCd > 0, '成功之后双方都要进冷却');
  const r4 = c3.mm.feedNearby(3.6);
  assert.ok(r4 && r4.ok === false && r4.reason === 'cooldown', '冷却中再喂要报 cooldown，实得 ' + JSON.stringify(r4));
});

test('繁殖 B3 幼崽生在两只之间、体型与碰撞盒都缩小、父母进入冷却', async () => {
  const c = breedCtx('wheat');
  const a = c.mm.spawn('cow', c.cx0 + 0.5, c.fy + 1, c.cz0 + 2.5);
  const b = c.mm.spawn('cow', c.cx0 + 2.5, c.fy + 1, c.cz0 + 2.5);
  const before = c.mm.list.length;
  const r = c.mm.feedNearby(3.6);
  assert.ok(r && r.ok === true && r.baby, '要返回幼崽，实得 ' + JSON.stringify(r));
  assert.equal(c.mm.list.length, before + 1, '只多出一只幼崽');
  const baby = r.baby;
  assert.equal(baby.type, 'cow');
  assert.equal(baby.isBaby, true);
  assert.ok(baby.growT > 0, '幼崽要有成长倒计时');
  const adultH = a.height;
  assert.ok(baby.height < adultH * 0.8 && baby.width < a.width * 0.8,
    '幼崽碰撞盒必须明显更小：' + baby.width.toFixed(2) + '×' + baby.height.toFixed(2) +
    ' vs 成年 ' + a.width.toFixed(2) + '×' + adultH.toFixed(2));
  const mid = { x: (a.pos.x + b.pos.x) / 2, z: (a.pos.z + b.pos.z) / 2 };
  assert.ok(Math.hypot(baby.pos.x - mid.x, baby.pos.z - mid.z) < 1.6,
    '幼崽要生在父母之间，偏差=' + Math.hypot(baby.pos.x - mid.x, baby.pos.z - mid.z).toFixed(2));
  assert.ok(c.added.length === 1, '要通知 game.onMobBred 一次');
});

test('繁殖 B4 幼崽不能繁殖、到时长大；长大后才能再次参与繁殖', async () => {
  const c = breedCtx('wheat');
  const a = c.mm.spawn('cow', c.cx0 + 0.5, c.fy + 1, c.cz0 + 2.5);
  c.mm.spawn('cow', c.cx0 + 2.5, c.fy + 1, c.cz0 + 2.5);
  const r = c.mm.feedNearby(3.6);
  const baby = r.baby;
  const n0 = c.mm.list.length;
  const rb = c.mm.feedNearby(3.6, baby);
  assert.ok(rb && rb.ok === false, '幼崽不该参与繁殖，实得 ' + JSON.stringify(rb));
  assert.equal(c.mm.list.length, n0, '幼崽被喂之后不许再多出生');
  for (let i = 0; i < BABY_GROW_SECONDS * 2 + 4; i++) {
    c.mm.maxMobs = 0;
    c.mm.update(0.5, 1);
  }
  assert.equal(baby.isBaby, false, '到时长成成年（' + BABY_GROW_SECONDS + ' 秒）');
  assert.ok(Math.abs(baby.height - a.height) < 1e-6, '成年之后碰撞盒要恢复成成年尺寸');
});

test('繁殖 B5 存档往返保留幼崽与冷却；旧档没有这些字段一律视为成年、无冷却', async () => {
  const { MobManager: MM } = await import('../renderer/js/world/mobs.js');
  const c = breedCtx('wheat');
  c.mm.spawn('cow', c.cx0 + 0.5, c.fy + 1, c.cz0 + 2.5);
  c.mm.spawn('cow', c.cx0 + 2.5, c.fy + 1, c.cz0 + 2.5);
  const baby = c.mm.feedNearby(3.6).baby;
  const data = JSON.parse(JSON.stringify(c.mm.serialize()));
  const c2 = breedCtx('wheat');
  c2.mm.applySaved(data);
  const back = c2.mm.list.find(m => m.isBaby);
  assert.ok(back, '幼崽状态必须活过读档');
  assert.ok(Math.abs(back.growT - baby.growT) < 1.1, '成长倒计时要大致保留：' + back.growT + ' vs ' + baby.growT);
  const cooled = c2.mm.list.filter(m => !m.isBaby && m.breedCd > 0);
  assert.equal(cooled.length, 2, '父母的冷却要保留，实得 ' + cooled.length);
  // 旧格式：删掉新字段
  const old = JSON.parse(JSON.stringify(data));
  for (const s of old) { delete s.bb; delete s.bc; }
  const c3 = breedCtx('wheat');
  c3.mm.applySaved(old);
  assert.ok(c3.mm.list.every(m => !m.isBaby && m.breedCd === 0), '旧档缺字段要一律视为成年且无冷却');
  assert.ok(c3.mm.list.every(m => m.hp > 0), '读旧档不许把生物读死');
});

/* ================= 生物互相推开（M1~M5）：先红后绿 ================= */
test('分离 M1 两只重叠的生物会被推开，且推完仍能站稳', async () => {
  const { MobManager: MM } = await import('../renderer/js/world/mobs.js');
  assert.equal(typeof MM.prototype.separate, 'function', 'MobManager 要有 separate() 这个分离步骤');
  const c = breedCtx(null);
  const a = c.mm.spawn('pig', c.cx0 + 0.5, c.fy + 1, c.cz0 + 0.5);
  const b = c.mm.spawn('pig', c.cx0 + 0.52, c.fy + 1, c.cz0 + 0.52);
  const d0 = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
  for (let i = 0; i < 40; i++) c.mm.separate(0.05);
  const d1 = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
  assert.ok(d1 > 0.5, '重叠的两只必须被推开：' + d0.toFixed(3) + ' → ' + d1.toFixed(3));
  const need = (a.width + b.width) * 0.5;
  assert.ok(d1 >= need * 0.9, '推开量要按两只的半径来（need=' + need.toFixed(2) + '，实得 ' + d1.toFixed(2) + '）');
  assert.ok(!c.mm.mobAABBBlocked(a, a.pos.x, a.pos.y, a.pos.z) &&
    !c.mm.mobAABBBlocked(b, b.pos.x, b.pos.y, b.pos.z),
    '推完两只都不许卡进方块（AABB 检查）');
});

test('分离 M2 本来就不重叠的两只不会被无端推开', async () => {
  const c = breedCtx(null);
  const a = c.mm.spawn('cow', c.cx0 + 0.5, c.fy + 1, c.cz0 + 0.5);
  const b = c.mm.spawn('cow', c.cx0 + 2.5, c.fy + 1, c.cz0 + 0.5);
  const pa = { x: a.pos.x, z: a.pos.z }, pb = { x: b.pos.x, z: b.pos.z };
  for (let i = 0; i < 40; i++) c.mm.separate(0.05);
  assert.ok(Math.hypot(a.pos.x - pa.x, a.pos.z - pa.z) < 1e-6 &&
    Math.hypot(b.pos.x - pb.x, b.pos.z - pb.z) < 1e-6,
    '不重叠就不该动：A 移了 ' + Math.hypot(a.pos.x - pa.x, a.pos.z - pa.z).toFixed(4) +
    '，B 移了 ' + Math.hypot(b.pos.x - pb.x, b.pos.z - pb.z).toFixed(4));
});

test('分离 M3 背贴墙的一只不会被同伴挤穿墙', async () => {
  const w0 = breedCtx(null);
  const c = w0;
  // 在 x = cx0+2 这一列砌一堵 3 格高的实墙，然后把两只牛塞在墙边重叠
  for (let dz = -3; dz <= 3; dz++) for (let h = 0; h <= 2; h++) {
    c.ctx.world.setBlock(c.cx0 + 2, c.fy + 1 + h, c.cz0 + dz, B.STONE, 0);
  }
  const a = c.mm.spawn('cow', c.cx0 + 1.4, c.fy + 1, c.cz0 + 0.5);
  const b = c.mm.spawn('cow', c.cx0 + 1.45, c.fy + 1, c.cz0 + 0.6);
  for (let i = 0; i < 60; i++) {
    c.mm.separate(0.05);
    for (const [tag, m] of [['A', a], ['B', b]]) {
      assert.ok(!c.mm.mobAABBBlocked(m, m.pos.x, m.pos.y, m.pos.z),
        '第 ' + i + ' 步 ' + tag + ' 不许被挤进方块：pos=' +
        m.pos.x.toFixed(2) + ',' + m.pos.z.toFixed(2));
      assert.ok(m.pos.x < c.cx0 + 2, '第 ' + i + ' 步 ' + tag + ' 不许越过墙面 x=' + (c.cx0 + 2) +
        '，实得 ' + m.pos.x.toFixed(3));
    }
  }
  assert.ok(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) > 0.2,
    '贴着墙也要尽量分开，实得 ' + Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z).toFixed(3));
});

test('分离 M4 推开生物不许动到玩家（玩家与生物仍可互相穿过）', async () => {
  const c = breedCtx(null);
  const a = c.mm.spawn('pig', c.cx0 + 0.5, c.fy + 1, c.cz0 + 0.5);
  const b = c.mm.spawn('pig', c.cx0 + 0.5, c.fy + 1, c.cz0 + 0.55);
  const p0 = { x: c.ctx.controller.pos.x, y: c.ctx.controller.pos.y, z: c.ctx.controller.pos.z };
  for (let i = 0; i < 40; i++) c.mm.separate(0.05);
  assert.equal(c.ctx.controller.pos.x, p0.x, '玩家 x 不许被生物挤动');
  assert.equal(c.ctx.controller.pos.z, p0.z, '玩家 z 不许被生物挤动');
  assert.equal(c.ctx.controller.pos.y, p0.y, '玩家 y 不许被生物挤动');
  assert.ok(a !== b);
});

test('分离 M5 主循环 update() 里确实调用了分离（不是写了没接上）', async () => {
  const c = breedCtx(null);
  c.mm.maxMobs = 0;
  const a = c.mm.spawn('chicken', c.cx0 + 0.5, c.fy + 1, c.cz0 + 0.5);
  const b = c.mm.spawn('chicken', c.cx0 + 0.51, c.fy + 1, c.cz0 + 0.51);
  const d0 = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
  for (let i = 0; i < 20; i++) {
    c.mm.update(0.05, 1);
    // AI 也会移动，所以这里只要求「最终明显分开」，由下面的断言负责
  }
  const d1 = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
  assert.ok(d1 > d0 && d1 > 0.3, 'update() 之后两只鸡应当分开：' + d0.toFixed(3) + ' → ' + d1.toFixed(3));
});

test('分离 M6 生成点遇到相邻列高差时先有界脱嵌', async () => {
  const c = breedCtx(null);
  const x = c.cx0 + 2.5, z = c.cz0 + 0.5;
  c.ctx.world.setBlock(c.cx0 + 2, c.fy + 1, c.cz0, B.STONE, 0);
  c.ctx.world.setBlock(c.cx0 + 2, c.fy + 2, c.cz0, B.STONE, 0);
  const pig = c.mm.spawn('pig', x, c.fy + 1, z);
  assert.equal(pig.pos.x, x, '脱嵌不许改变水平 x');
  assert.equal(pig.pos.z, z, '脱嵌不许改变水平 z');
  assert.equal(pig.pos.y, c.fy + 3, '两格实心柱应向上脱嵌到柱顶');
  assert.equal(pig.mesh.position.y, pig.pos.y, '模型位置要与碰撞位置同步');
  assert.ok(!c.mm.mobAABBBlocked(pig, pig.pos.x, pig.pos.y, pig.pos.z), '生成后 AABB 必须空闲');
});

/* ================= T2 分帧预算（已知问题 #20：读档/批量改方块的秒级长帧） =================
 * 这一段盯三件事：
 *   ① 有可观测量（world.perf / world.pending()），否则「调细预算」无从验证；
 *   ② 预算真的在限流，但预算再小也必须至少推进一个区块（否则机器一慢就永远加载不完）；
 *   ③ 排队顺序必须近处优先 —— 原来的光照是 Set 插入顺序，玩家脚下的区块可能排在远处后面。 */

const frameWorld = (r) => {
  const w = new VoxelWorld(seed, { radius: r });
  w.setCenter(0.5, 0.5);              // 中心区块 = (0,0)
  return w;
};

test('分帧 F1 帧预算必须导出且分片预算明显小于同步灌全世界', () => {
  for (const [k, b] of [['FRAME_BUDGET', FRAME_BUDGET], ['LOAD_SLICE_BUDGET', LOAD_SLICE_BUDGET]]) {
    assert.ok(b && typeof b.total === 'number' && b.total > 0, k + ' 必须带 total');
    for (const s of ['gen', 'light', 'mesh']) {
      assert.ok(typeof b[s] === 'number' && b[s] > 0 && b[s] <= b.total, k + '.' + s + ' 必须是正数且不超过 total，实得 ' + JSON.stringify(b));
    }
  }
  assert.ok(FRAME_BUDGET.total <= 12, '常规帧预算应当压在 12ms 以内（60fps 一帧 16.7ms），实得 ' + FRAME_BUDGET.total);
  assert.ok(LOAD_SLICE_BUDGET.total <= 60, '加载分单单片必须 ≤60ms，否则一帧就是半秒，实得 ' + LOAD_SLICE_BUDGET.total);
});

test('分帧 F2 一次 update 不许把整个世界灌完，并且要留下可观测的耗时', () => {
  const w = frameWorld(5);
  const before = w.genQueue.length;
  assert.ok(before > 40, '前提：半径 5 至少该排 40 个区块，实得 ' + before);
  w.update(0.016, FRAME_BUDGET, null);
  const p = w.pending();
  assert.ok(typeof p.gen === 'number' && typeof p.light === 'number' && typeof p.mesh === 'number',
    'pending() 必须报三段排队数量，实得 ' + JSON.stringify(p));
  assert.ok(p.gen > 0, '一帧之后仍要有区块排队（一次灌完=根本没分帧），剩余 gen=' + p.gen + '/' + before);
  assert.ok(w.perf && Number.isFinite(w.perf.lastCallMs) && w.perf.lastCallMs >= 0,
    'perf.lastCallMs 必须是数字，实得 ' + JSON.stringify(w.perf));
  assert.ok(w.perf.genChunks > 0, '这一帧至少要做点事，实得 genChunks=' + w.perf.genChunks);
});

test('分帧 F3 光照排队近处优先，不是插入顺序', () => {
  const w = frameWorld(3);
  // 远处三个 + 中心一个，故意先插最远的：如果按插入顺序处理，第一个就是 6,6
  for (const [cx, cz] of [[6, 6], [5, 5], [-6, -6], [0, 0]]) w.ensureChunk(cx, cz);
  w.dirtyLight.clear(); w.dirtyMesh.clear(); w.genQueue.length = 0;
  for (const [cx, cz] of [[6, 6], [5, 5], [-6, -6], [0, 0]]) w.dirtyLight.add(coordKey(cx, cz));
  w.update(0.016, LOAD_SLICE_BUDGET, null);
  const order = w.perf.lastLightKeys || [];
  assert.ok(order.length >= 1, '这一帧至少要补一个区块的光，实得 order=' + JSON.stringify(order));
  assert.equal(order[0], coordKey(0, 0), '离玩家最近的区块必须最先补光，实得顺序 ' + JSON.stringify(order));
});

test('分帧 F4 网格排队同样近处优先', () => {
  const w = frameWorld(3);
  for (const [cx, cz] of [[7, 7], [6, 6], [-7, -7], [0, 0]]) { w.ensureChunk(cx, cz); lightChunk(w.chunks.get(coordKey(cx, cz)), w); }
  w.dirtyLight.clear(); w.dirtyMesh.clear(); w.genQueue.length = 0;
  for (const [cx, cz] of [[7, 7], [6, 6], [-7, -7], [0, 0]]) w.dirtyMesh.add(coordKey(cx, cz));
  w.update(0.016, LOAD_SLICE_BUDGET, null);
  const order = w.perf.lastMeshKeys || [];
  assert.ok(order.length >= 1, '这一帧至少要重建一个区块的网格，实得 order=' + JSON.stringify(order));
  assert.equal(order[0], coordKey(0, 0), '最近的区块必须最先重建网格，实得顺序 ' + JSON.stringify(order));
});

test('分帧 F5 预算再小也要有进展（不许「超时就不干活」把加载饿死）', () => {
  const w = frameWorld(4);
  const tiny = { total: 0.0001, gen: 0.0001, light: 0.0001, mesh: 0.0001 };
  const g0 = w.genQueue.length, gen0 = w.stats.generated;
  w.ensureChunk(0, 0);                       // 给光照/网格阶段留一个可做的活
  assert.ok(w.dirtyLight.size >= 1 && w.dirtyMesh.size >= 1, '前提：(0,0) 应当同时等着补光与重建');
  w.update(0.016, tiny, null);
  assert.ok(w.genQueue.length < g0, '极小预算下 gen 阶段仍要至少生成一个区块，实得 ' + g0 + ' → ' + w.genQueue.length);
  assert.ok(w.stats.generated >= gen0, '生成计数不许倒退，实得 ' + gen0 + ' → ' + w.stats.generated);
  const p = w.perf;
  assert.ok(p.genChunks >= 1 && p.lightChunks >= 1 && p.meshChunks >= 1,
    '三段都要至少推进一个区块，实得 ' + JSON.stringify({ gen: p.genChunks, light: p.lightChunks, mesh: p.meshChunks }));
});

/* ================= T3 顶出保护：方块出现在玩家身体里时必须被推到可站立处 =================
 * 只有 spawnAt 会顶出（读档/重生），而「走到将要长树的格子」或「区块在脚下生成」时
 * 身体与实心方块重叠是没人管的 —— 表现是整个人卡进石头/树干里，动都动不了。
 * 这一组盯 pushOutOfSolid() 的四条底线：不无端顶人、顶得最小、顶得有界、
 * 未生成区块的「近似实心」不许当真（否则会被顶到隐形地面上）。 */

const embedWorld = (seedN) => {
  const w = new VoxelWorld(seedN);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  return w;
};

test('顶出 P1 站得好好的不许被无端顶起（空位里 pushOutOfSolid 返回 null 且位置不动）', () => {
  const w = embedWorld(33007);
  const x = 8, z = 8;
  const gy = w.topSolidY(x, z);
  for (let h = 1; h <= 4; h++) w.setBlock(x, gy + h, z, AIR, 0);
  const c = new PlayerController(w);
  c.setPositions(x + 0.5, gy + 1, z + 0.5);
  const p0 = { ...c.pos };
  assert.equal(c.pushOutOfSolid(), null, '没卡住就不许有位移，实得 ' + JSON.stringify(c.pushOutOfSolid()));
  assert.deepEqual({ ...c.pos }, p0, '位置一动都不许动');
});

test('顶出 P2 被 3 格实心埋住：只顶到第一个能站下的位置，低一格就还卡着', () => {
  const w = embedWorld(33007);
  const x = 8, z = 8;
  const gy = w.topSolidY(x, z);
  for (let h = 1; h <= 4; h++) w.setBlock(x, gy + h, z, AIR, 0);
  for (let h = 1; h <= 3; h++) w.setBlock(x, gy + h, z, B.STONE, 0);
  const c = new PlayerController(w);
  c.setPositions(x + 0.5, gy + 1, z + 0.5);
  assert.ok(c.intersectsSolid(c.pos.x, c.pos.y, c.pos.z), '前提：这一格确实被埋住了');
  let tele = 0;
  c.on('teleport', () => { tele++; });
  const mv = c.pushOutOfSolid();
  assert.ok(mv, '被埋住必须顶出，实得 ' + JSON.stringify(mv));
  assert.ok(!c.intersectsSolid(c.pos.x, c.pos.y, c.pos.z), '顶出后仍与方块重叠，y=' + c.pos.y);
  assert.ok(c.intersectsSolid(c.pos.x, c.pos.y - 1, c.pos.z),
    '再低一格就应当还卡着（说明没有多顶），y=' + c.pos.y);
  assert.ok(c.pos.y - (gy + 1) <= PUSH_UP_LIMIT,
    '上顶必须有界（≤ PUSH_UP_LIMIT=' + PUSH_UP_LIMIT + '），实得 ' + (c.pos.y - (gy + 1)).toFixed(2));
  assert.equal(tele, 1, '顶出要发一次 teleport 事件，否则 D2 监视器会把它当成可疑瞬移');
});

test('顶出 P3 整列塞满到世界高度：不许把人顶出世界，也不许硬留在实心里 —— 必须回退或改走水平', () => {
  const w = embedWorld(33007);
  const x = 8, z = 8;
  const gy = w.topSolidY(x, z);
  // 5×5 全塞到世界顶，水平和向上都无路可走
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    for (let h = 1; h <= WORLD_H; h++) w.setBlock(x + dx, gy + h, z + dz, B.STONE, 0);
  }
  const c = new PlayerController(w);
  const y0 = gy + 1;
  c.setPositions(x + 0.5, y0, z + 0.5);
  const t0 = Date.now();
  const mv = c.pushOutOfSolid();
  const cost = Date.now() - t0;
  assert.ok(cost < 2000, '顶出必须有界不卡死，实得 ' + cost + 'ms');
  assert.ok(mv === null || (Number.isFinite(mv.dy) && Math.abs(mv.dy) <= PUSH_UP_LIMIT),
    '不许把人顶飞：位移必须有界，实得 ' + JSON.stringify(mv));
  assert.ok(c.pos.y < WORLD_H + 2, '不许把人送出世界，y=' + c.pos.y);
  assert.ok(Math.hypot(c.pos.x - (x + 0.5), c.pos.z - (z + 0.5)) <= PUSH_SIDE_LIMIT,
    '水平挪动也要有界（≤ ' + PUSH_SIDE_LIMIT + '），实得 ' +
    Math.hypot(c.pos.x - (x + 0.5), c.pos.z - (z + 0.5)).toFixed(2));
});

test('顶出 P4 相邻区块还没生成时的「近似实心」不算被埋（否则会被顶到隐形地面上）', () => {
  const w = new VoxelWorld(33007);
  w.ensureChunk(0, 0);                      // 只生成 (0,0)，(1,0) 还是空的
  const x = 17, z = 8;                       // 落在未生成的区块里
  const gy = w.topSolidY(x, z);
  const c = new PlayerController(w);
  c.setPositions(x + 0.5, gy - 2, z + 0.5);  // 在近似地形「内部」
  assert.ok(c.intersectsSolid(c.pos.x, c.pos.y, c.pos.z), '前提：近似判定这里确实是实心');
  assert.equal(c.chunksAroundReady(), false, '这里的区块还没真正生成，chunksAroundReady 必须报 false');
  const p0 = { ...c.pos };
  assert.equal(c.pushOutOfSolid(), null, '区块没生成完不许顶人，实得 ' + JSON.stringify(c.pushOutOfSolid()));
  assert.deepEqual({ ...c.pos }, p0, '位置一动都不许动（等区块真的生成之后再判）');
});

test('顶出 P5 生成完之后同一处就正常判定（证明 P4 的 null 是闸门而不是瞎了）', () => {
  const w = new VoxelWorld(33007);
  w.ensureChunk(0, 0);
  const x = 17, z = 8;
  w.ensureChunk(1, 0);                       // 把玩家所在的区块真的生成出来
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const c = new PlayerController(w);
  const gy = w.topSolidY(x, z);
  for (let h = 1; h <= 3; h++) w.setBlock(x, gy + h, z, B.STONE, 0);
  c.setPositions(x + 0.5, gy + 1, z + 0.5);
  assert.equal(c.chunksAroundReady(), true, '区块都在了，闸门必须放行');
  assert.ok(c.pushOutOfSolid(), '生成完之后同一处必须能顶出');
  assert.ok(!c.intersectsSolid(c.pos.x, c.pos.y, c.pos.z), '顶出后不该还卡着');
});

/* ================= T4 蜘蛛（敌对生物 + 爬墙 + 掉线，把「线只有羊毛一个来源」这条简化补全） =================
 * 五条底线：① 蜘蛛是真的敌对生物（会咬人、夜里生成、不可繁殖不可剪毛）；
 * ② 爬墙是「贴墙才爬」而不是会飞（僵尸在同一片墙前必须爬不上去）；
 * ③ 掉落走 kill() 的真实链路（掉线），不是硬编码；
 * ④ 4 线 → 羊毛 的原版合成加进来，同时不删既有「羊毛拆线」那条便利（既有断言不动）；
 * ⑤ 碰撞盒是蜘蛛自己的（矮而宽），不是把僵尸换了个名字。 */

const climbCtx = (type) => {
  const w = new VoxelWorld(424242);
  for (let cz = -1; cz <= 2; cz++) for (let cx = -1; cx <= 2; cx++) w.ensureChunk(cx, cz);
  const cx0 = 8, cz0 = 8, fy = 40;
  // 13×13 平整台面 + 一堵从台面往上 8 格的墙（在 x = cx0+2）
  for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) {
    w.setBlock(cx0 + dx, fy, cz0 + dz, B.STONE, 0);
    for (let h = 1; h <= 9; h++) w.setBlock(cx0 + dx, fy + h, cz0 + dz, AIR, 0);
  }
  // 环形墙：|dx|==2 或 |dz|==2 的那一圈垒 8 格高，中间留 3×3 的内院
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
    for (let h = 1; h <= 8; h++) w.setBlock(cx0 + dx, fy + h, cz0 + dz, B.STONE, 0);
  }
  const dropped = [];
  const ctx = {
    world: w, scene: { add() { }, remove() { } }, sfx: { play() { } },
    particles: { spawn() { } },
    // 玩家放在 50 格外：46 格以内敌对生物会转为追击分支，自己改移动方向，
    // 那 K3/K4 里设定的 yaw/walking 就不作数了（这两条要测的正是「贴墙才爬」这条分支）
    controller: { pos: { x: cx0 + 0.5, y: fy + 1, z: cz0 + 50 }, health: 20, creative: false, lookDir: () => ({ x: 0, y: 0, z: 1 }) },
    inventory: { held: () => null },
    game: { state: 'playing', spawnDrop: (item, n, x, y, z) => dropped.push({ item, n, x, y, z }) }
  };
  const mm = new MobManager(ctx);
  mm.maxMobs = 0;                        // 关掉自然刷怪，场景里只有被测的这一只
  return { w, ctx, mm, cx0, cz0, fy, dropped };
};

test('蜘蛛 K1 定义齐备：敌对、会爬墙、掉线、不可繁殖不可剪毛、碰撞盒是蜘蛛自己的', () => {
  const sp = MOB_TYPES.spider;
  assert.ok(sp, 'MOBS 里没有 spider');
  assert.equal(sp.hostile, true, '蜘蛛必须是敌对生物');
  assert.equal(sp.climb, true, '蜘蛛必须能爬墙');
  assert.ok(!sp.burnInDay, '蜘蛛不许在阳光下自燃（僵尸骷髅才有这条）');
  assert.ok(!sp.breedable && !sp.shearable, '蜘蛛不可繁殖也不可剪毛');
  assert.ok(Array.isArray(sp.drop) && sp.drop.some(d => d.item === 'string'), '掉落必须含线：' + JSON.stringify(sp.drop));
  assert.ok(sp.damage > 0 && sp.reach > 0, '要能咬人：damage/reach 必须为正，实得 ' + sp.damage + '/' + sp.reach);
});

test('蜘蛛 K2 碰撞盒矮而宽（不是把僵尸改个名），并且尺寸真的按 def 走', () => {
  const { mm, cx0, cz0, fy } = climbCtx('spider');
  const sp = mm.spawn('spider', cx0 + 0.5, fy + 1, cz0 - 1);
  const zb = mm.spawn('zombie', cx0 + 1.5, fy + 1, cz0 - 1);
  assert.ok(sp.height < zb.height - 0.3, '蜘蛛要比僵尸矮一截：sp=' + sp.height.toFixed(2) + ' zb=' + zb.height.toFixed(2));
  assert.ok(sp.width > zb.width - 0.05, '蜘蛛要比僵尸宽（趴着走的体型）：sp=' + sp.width.toFixed(2) + ' zb=' + zb.width.toFixed(2));
  const sp2 = mm.spawn('spider', cx0 + 2.5, fy + 1, cz0 - 1, { baby: true });
  assert.ok(sp2.height < sp.height, '幼崽（如果有）碰撞盒要更小；实得 ' + sp2.height + ' vs ' + sp.height);
});

test('蜘蛛 K3 贴墙时向上爬：若干帧后必须比墙脚高，且没有穿进方块', () => {
  const { w, mm, cx0, cz0, fy } = climbCtx('spider');
  const m = mm.spawn('spider', cx0 + 0.5, fy + 1, cz0 + 0.5);
  m.yaw = Math.PI / 2;                    // 正面 +X，对着 x=cx0+2 那圈墙
  m.walking = true; m.wanderT = 9999;
  let climbed = false;
  for (let i = 0; i < 400 && !climbed; i++) {
    mm.update(0.05, 1);
    assert.ok(!mm.mobAABBBlocked(m, m.pos.x, m.pos.y, m.pos.z),
      '第 ' + i + ' 帧蜘蛛不许被塞进方块：pos=' + m.pos.x.toFixed(2) + ',' + m.pos.y.toFixed(2) + ',' + m.pos.z.toFixed(2));
    if (m.pos.y > fy + 2.5) climbed = true;
  }
  assert.ok(climbed, '贴墙 400 帧之后仍未爬升，实得 y=' + m.pos.y.toFixed(2) + '（墙脚 y=' + (fy + 1) + '）');
  assert.ok(m.pos.x < cx0 + 2 + 0.9, '爬墙不许穿墙：x=' + m.pos.x.toFixed(2));
  assert.ok(m.pos.y < fy + 9.5, '爬出去也不许被弹射到天上，y=' + m.pos.y.toFixed(2));
  void w;
});

test('蜘蛛 K4 对照：僵尸在同一堵墙前爬不上去（防止「所有生物都会飞」的实现）', () => {
  const { mm, cx0, cz0, fy } = climbCtx('zombie');
  const m = mm.spawn('zombie', cx0 + 0.5, fy + 1, cz0 + 0.5);
  m.yaw = Math.PI / 2; m.walking = true; m.wanderT = 9999;
  for (let i = 0; i < 200; i++) {
    mm.update(0.05, 1);
    assert.ok(!mm.mobAABBBlocked(m, m.pos.x, m.pos.y, m.pos.z), '第 ' + i + ' 帧僵尸不许在方块里');
  }
  assert.ok(m.pos.y < fy + 2.2, '僵尸不该爬上这圈 8 格高的墙（内院四面都是墙，它没有别的出路），实得 y=' + m.pos.y.toFixed(2));
  assert.ok(!m.climbing, '僵尸没有 climb 标记，climbing 必须始终是 false，实得 ' + m.climbing);
});

test('蜘蛛 K5 击杀掉线走 kill() 真实链路；幼崽不掉；夜里生成池里有蜘蛛、白天没有', () => {
  const { mm, cx0, cz0, fy, dropped } = climbCtx('spider');
  const m = mm.spawn('spider', cx0 + 0.5, fy + 1, cz0);
  mm.kill(m, true);
  assert.ok(dropped.length >= 1 && dropped.every(d => d.item === 'string'), '必须掉线，实得 ' + JSON.stringify(dropped));
  assert.ok(dropped[0].n >= 1 && dropped[0].n <= 2, '线的数量应在 1~2，实得 ' + dropped[0].n);
  const b = mm.spawn('spider', cx0 + 1.5, fy + 1, cz0, { baby: true });
  const before = dropped.length;
  mm.kill(b, true);
  assert.equal(dropped.length, before, '幼崽不许掉东西（与繁殖那一轮的口径一致）');
  assert.ok(NIGHT_TYPES.includes('spider'), '夜里生成的敌对池必须包含蜘蛛：' + JSON.stringify(NIGHT_TYPES));
  assert.ok(!DAY_TYPES.includes('spider'), '白天不该刷蜘蛛：' + JSON.stringify(DAY_TYPES));
  assert.ok(NIGHT_TYPES.every(t => MOB_TYPES[t].hostile), '敌对池里只能有敌对生物');
});

test('蜘蛛 K6 4 线 → 1 羊毛（原版链路补全），且旧的「羊毛拆线」便利保持不变', () => {
  const r = findRecipe(grid3([['string', 'string'], ['string', 'string']]));
  assert.ok(r && r.result && r.result.item === 'wool', '4 线应合成 1 羊毛，实得 ' + JSON.stringify(r && r.result));
  assert.equal(r.result.count, 1, '产出应是 1 个羊毛，实得 ' + r.result.count);
  const back = findRecipe([['wool']]);
  assert.ok(back && back.result.item === 'string' && back.result.count === 2,
    '既有「1 羊毛 → 2 线」不许被动（T3 弓的材料链断言依赖它），实得 ' + JSON.stringify(back && back.result));
});

/* ================= T5 苦力怕：爆炸核心（纯逻辑）与充能行为 =================
 * 爆炸要动的东西很多（方块、光照、网格、玩家血量、音效），所以把「炸哪些格子、掉多少血」
 * 抽成 core/explosion.js 的纯函数，在 Node 里就能测；mobs.js 只负责「什么时候该炸」。
 * 六条底线：范围有界、不碰未生成区块、不可破的方块留着、伤害单调衰减、结果可复现、不炸空气。 */

const mkBlastWorld = () => {
  const w = new VoxelWorld(5150);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const gy = 40;
  // 15×15×6 的实心立方体，方便数「挖掉了多少格」
  for (let dz = -7; dz <= 7; dz++) for (let dx = -7; dx <= 7; dx++) for (let h = 0; h <= 5; h++) {
    w.setBlock(dx, gy + h, dz, B.STONE, 0);
  }
  return { w, gy };
};

test('爆炸 E1 范围有界：所有被选中的格子都在半径内，半径外一格都不许动', () => {
  const { w, gy } = mkBlastWorld();
  const cells = explosionCells({ cx: 0, cy: gy + 1, cz: 0, power: CREEPER_POWER, rand: mulberry32(7), canBreak: (x, y, z) => breakableAt(w, x, y, z) });
  assert.ok(cells.length > 8, '立方体中心炸开至少要挖掉几格，实得 ' + cells.length);
  let far = 0;
  for (const c of cells) {
    const d = Math.hypot(c.x - 0, c.y - (gy + 1), c.z - 0);
    if (d > CREEPER_POWER + 1.0) far++;
  }
  assert.equal(far, 0, '超出 power+1 的格子被炸到了，共 ' + far + ' 格');
  const near = cells.filter(c => Math.hypot(c.x, c.y - (gy + 1), c.z) <= CREEPER_POWER);
  assert.ok(near.length >= cells.length * 0.6,
    '「大部分格子落在 power 以内」：外圈抖动带 (power, power+1] 只能是少数，实得 内 ' + near.length + ' / 共 ' + cells.length);
  assert.ok(cells.some(c => c.x === 0 && c.y === gy + 1 && c.z === 0), '爆心那一格必须被挖掉（要能炸出坑）');
  const shell = cells.filter(c => Math.hypot(c.x, c.y - (gy + 1), c.z) > CREEPER_POWER);
  assert.ok(shell.length > 0, '外圈抖动带必须真的参与（否则随机没起作用），实得 ' + shell.length);
});

test('爆炸 E2 不许在未生成的区块上挖洞（那里根本没有真方块）', () => {
  const w = new VoxelWorld(5151);
  w.ensureChunk(0, 0);                       // 只有中心这一块是真的
  const cells = explosionCells({ cx: 8, cy: 41, cz: 8, power: CREEPER_POWER, rand: mulberry32(3), canBreak: (x, y, z) => breakableAt(w, x, y, z) });
  assert.ok(cells.length > 0, '中心区块内生成了就该有格子可挖，实得 ' + cells.length);
  const outside = cells.filter(c => (c.x >> 4) !== 0 || (c.z >> 4) !== 0);
  assert.deepEqual(outside, [], '炸到了未生成区块的格子：' + JSON.stringify(outside.slice(0, 4)));
});

test('爆炸 E3 不可破坏的东西必须留着：基岩、水、熔炉/箱子的格子', () => {
  const w = new VoxelWorld(5152);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const gy = 40;
  for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) w.setBlock(dx, gy, dz, B.STONE, 0);
  w.setBlock(0, gy + 1, 0, B.BEDROCK, 0);
  w.setBlock(1, gy + 1, 0, B.WATER, 0);
  w.setBlock(-1, gy + 1, 0, B.FURNACE, 0);
  const cells = explosionCells({ cx: 0, cy: gy + 1, cz: 0, power: CREEPER_POWER, rand: mulberry32(11), canBreak: (x, y, z) => breakableAt(w, x, y, z) });
  const at = (x, y, z) => cells.some(c => c.x === x && c.y === y && c.z === z);
  assert.equal(at(0, gy + 1, 0), false, '基岩不许被炸掉');
  assert.equal(at(1, gy + 1, 0), false, '水不许被炸掉');
  assert.equal(at(-1, gy + 1, 0), false, '熔炉不许被炸掉（里面有内容，炸了会变成无主状态）');
  assert.equal(w.getBlock(0, gy + 1, 0), B.BEDROCK, '方块数据里基岩必须还在');
});

test('爆炸 E4 伤害按距离单调衰减，且中心等于最大伤害、出范围归零', () => {
  const R = CREEPER_DAMAGE_RANGE;
  assert.equal(explosionDamage({ dist: 0, range: R, maxDamage: CREEPER_MAX_DAMAGE }), CREEPER_MAX_DAMAGE, '贴脸应该是满伤害');
  assert.equal(explosionDamage({ dist: R, range: R, maxDamage: CREEPER_MAX_DAMAGE }), 0, '正好在边界不该掉血');
  assert.equal(explosionDamage({ dist: R * 2, range: R, maxDamage: CREEPER_MAX_DAMAGE }), 0, '超出边界不该掉血');
  let prev = Infinity;
  for (let i = 0; i <= 10; i++) {
    const d = R * i / 10;
    const v = explosionDamage({ dist: d, range: R, maxDamage: CREEPER_MAX_DAMAGE });
    assert.ok(v <= prev + 1e-9, '伤害必须随距离单调不增：d=' + d.toFixed(2) + ' v=' + v);
    prev = v;
  }
  const mid = explosionDamage({ dist: R / 2, range: R, maxDamage: CREEPER_MAX_DAMAGE });
  assert.ok(mid > 0 && mid < CREEPER_MAX_DAMAGE, '半山腰应有中间值，实得 ' + mid);
});

test('爆炸 E5 可复现：同一颗随机种子给出同一批格子（不然线上出问题没法回放）', () => {
  const { w, gy } = mkBlastWorld();
  const once = explosionCells({ cx: 0, cy: gy + 1, cz: 0, power: CREEPER_POWER, rand: mulberry32(99), canBreak: (x, y, z) => breakableAt(w, x, y, z) });
  const again = explosionCells({ cx: 0, cy: gy + 1, cz: 0, power: CREEPER_POWER, rand: mulberry32(99), canBreak: (x, y, z) => breakableAt(w, x, y, z) });
  assert.deepEqual(once, again, '两次结果不一致');
  const other = explosionCells({ cx: 0, cy: gy + 1, cz: 0, power: CREEPER_POWER, rand: mulberry32(100), canBreak: (x, y, z) => breakableAt(w, x, y, z) });
  assert.notDeepEqual(once, other, '换种子必须给出不同的形状（否则 rand 根本没参与，测试是假的）');
});

test('爆炸 E6 只挖实心：空气格不计入结果', () => {
  const w = new VoxelWorld(5153);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const gy = 40;
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) w.setBlock(dx, gy, dz, B.STONE, 0);
  const cells = explosionCells({ cx: 0, cy: gy + 3, cz: 0, power: CREEPER_POWER, rand: mulberry32(5), canBreak: (x, y, z) => breakableAt(w, x, y, z) });
  assert.ok(cells.every(c => w.isSolidAt(c.x, c.y, c.z)), '结果里出现了非实心格子：' + JSON.stringify(cells.filter(c => !w.isSolidAt(c.x, c.y, c.z)).slice(0, 3)));
  assert.ok(cells.every(c => w.getBlock(c.x, c.y, c.z) !== AIR), '空气不该被列进破坏清单');
});

/* ---- 苦力怕的「什么时候炸」：headless MobManager + 回调，不碰渲染 ---- */
const blastCtx = (held) => {
  const w = new VoxelWorld(5170);
  for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) w.ensureChunk(cx, cz);
  const cx0 = 8, cz0 = 8, fy = 40;
  for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
    w.setBlock(cx0 + dx, fy, cz0 + dz, B.STONE, 0);
    for (let h = 1; h <= 8; h++) w.setBlock(cx0 + dx, fy + h, cz0 + dz, AIR, 0);
  }
  const events = [];
  const ctx = {
    world: w, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } },
    controller: { pos: { x: cx0 + 0.5, y: fy + 1, z: cz0 + 6.5 }, health: 20, creative: false, lookDir: () => ({ x: 0, y: 0, z: -1 }), hurt() { } },
    inventory: { held: () => (held ? { item: held, count: 5 } : null) },
    game: {
      state: 'playing', spawnDrop: (item, n) => events.push({ drop: item, n }),
      onCreeperExplode: (m) => events.push({ explode: { x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2) } }),
      onMobBred: () => { }
    }
  };
  const mm = new MobManager(ctx);
  mm.maxMobs = 0;
  return { w, ctx, mm, cx0, cz0, fy, events };
};

const runFrames = (mm, n, dt = 0.05) => { for (let i = 0; i < n; i++) mm.update(dt, 1); };

test('苦力怕 C1 定义：敌对、会爆炸、掉火药、不爬墙、不怕太阳', () => {
  const cr = MOB_TYPES.creeper;
  assert.ok(cr, 'MOBS 里没有 creeper');
  assert.equal(cr.hostile, true);
  assert.equal(cr.explode, true, '必须有 explode 标记，主循环靠它走充能分支');
  assert.ok(!cr.climb && !cr.burnInDay, '苦力怕不爬墙也不晒太阳烧起来');
  assert.ok((cr.drop || []).some(d => d.item === 'gunpowder'), '要掉火药：' + JSON.stringify(cr.drop));
  assert.ok(NIGHT_TYPES.includes('creeper'), '夜里生成池要有苦力怕：' + JSON.stringify(NIGHT_TYPES));
});

test('苦力怕 C2 玩家靠近就充能，到点触发一次且仅一次爆炸，本体随之消失', () => {
  const { mm, ctx, cx0, cz0, fy, events } = blastCtx();
  const m = mm.spawn('creeper', cx0 + 0.5, fy + 1, cz0 + 4.5);
  ctx.controller.pos.z = cz0 + 2.5;             // 2 格内：进入触发距离
  runFrames(mm, 40);                             // 40 × 0.05s = 2s > 充能 1.5s
  const booms = events.filter(e => e.explode);
  assert.equal(booms.length, 1, '必须正好炸一次，实得 ' + booms.length + ' 事件=' + JSON.stringify(events));
  assert.equal(mm.list.includes(m), false, '炸完的苦力怕要消失');
  assert.equal(events.filter(e => e.drop).length, 0, '自爆不留掉落（原版如此，被击杀才掉火药）');
});

test('苦力怕 C3 充能中逃开就取消：跑远了不许在身后炸', () => {
  const { mm, ctx, cx0, cz0, fy, events } = blastCtx();
  mm.spawn('creeper', cx0 + 0.5, fy + 1, cz0 + 4.5);
  ctx.controller.pos.z = cz0 + 2.5;
  runFrames(mm, 10);                             // 先充能 0.5 秒
  ctx.controller.pos.z = cz0 - 20;               // 玩家跑开（远超取消阈值）
  runFrames(mm, 60);
  assert.equal(events.filter(e => e.explode).length, 0, '逃开之后还炸了：' + JSON.stringify(events.filter(e => e.explode)));
});

test('苦力怕 C4 在爆炸前被击杀：掉火药且不引爆', () => {
  const { mm, cx0, cz0, fy, events } = blastCtx();
  const m = mm.spawn('creeper', cx0 + 0.5, fy + 1, cz0 + 4.5);
  mm.ctx.controller.pos.z = cz0 + 3.5;
  runFrames(mm, 6);                              // 让它先开始充能
  mm.hitMob(m, 999, { x: 0, z: 0 });
  runFrames(mm, 20);
  const booms = events.filter(e => e.explode);
  assert.equal(booms.length, 0, '被打死的苦力怕不该引爆：' + JSON.stringify(booms));
  const drops = events.filter(e => e.drop);
  assert.ok(drops.length >= 1 && drops[0].drop === 'gunpowder', '被击杀要掉火药，实得 ' + JSON.stringify(events));
});

test('苦力怕 C5 主循环真的调用了充能逻辑（不是写了没接上），且充能中 fuse 单调减少', () => {
  const { mm, ctx, cx0, cz0, fy, events } = blastCtx();
  const m = mm.spawn('creeper', cx0 + 0.5, fy + 1, cz0 + 4.5);
  ctx.controller.pos.z = cz0 + 2.5;
  runFrames(mm, 4);
  assert.ok(m.charging === true, '贴近玩家后必须进入充能，实得 charging=' + m.charging);
  const f0 = m.fuse;
  runFrames(mm, 4);
  assert.ok(m.fuse < f0, '继续贴近时 fuse 要单调减少：' + f0.toFixed(3) + ' → ' + m.fuse.toFixed(3));
  assert.equal(events.filter(e => e.explode).length, 0, '才 0.4 秒不该就炸');
});

/* ================= 护甲 T1 ================= */
test('护甲 A1 减伤公式：每点 4%、封顶 80%、边界可解释', () => {
  assert.equal(armorReduction(0), 0, '无甲不减伤');
  assert.equal(armorReduction(5), 0.2, '皮革 5 点 = 20%');
  assert.equal(armorReduction(15), 0.6, '铁 15 点 = 60%');
  assert.equal(armorReduction(20), 0.8, '钻石 20 点 = 80%');
  assert.equal(armorReduction(25), 0.8, '超过 20 点封顶 80%');
  assert.equal(armorReduction(-3), 0, '负护甲点不能变成增伤');
  assert.ok(Math.abs(applyArmorReduction(10, 0) - 10) < 1e-9, '无甲 10 伤害还是 10');
  assert.ok(Math.abs(applyArmorReduction(10, 5) - 8) < 1e-9, '皮革 10 → 8');
  assert.ok(Math.abs(applyArmorReduction(3, 15) - 1.2) < 1e-9, '铁 3 → 1.2');
  assert.ok(Math.abs(applyArmorReduction(3, 20) - 0.6) < 1e-9, '钻石 3 → 0.6');
  assert.ok(Math.abs(applyArmorReduction(3, 60) - 0.6) < 1e-9, '封顶后的结果与 20 点一致');
  assert.equal(applyArmorReduction(0, 20), 0, '0 伤害仍是 0');
});

test('护甲 A2 三套 12 件都在物品表里：槽位齐、点数合计 5/15/20、耐久各不相同', () => {
  const sets = { leather: 5, iron: 15, diamond: 20 };
  const pointsBySet = { leather: [1, 2, 1, 1], iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3] };
  let total = 0;
  for (const [mat, expected] of Object.entries(sets)) {
    const kinds = ['helmet', 'chestplate', 'leggings', 'boots'];
    const seen = new Set();
    let sum = 0;
    kinds.forEach((kind, slot) => {
      const id = mat + '_' + kind;
      const it = ITEMS[id];
      assert.ok(it, '缺少物品 ' + id);
      assert.equal(it.armorSlot, slot, id + ' 的槽位不对');
      assert.equal(it.armorPoints, pointsBySet[mat][slot], id + ' 点数不对');
      assert.equal(it.armorSet, mat, id + ' 的套装标记不对');
      assert.ok(it.durability > 0, id + ' 必须有耐久');
      assert.equal(it.stack, 1, id + ' 不可堆叠');
      assert.ok(!seen.has(it.armorSlot), id + ' 槽位重复');
      seen.add(it.armorSlot);
      sum += it.armorPoints;
      total++;
    });
    assert.equal(sum, expected, mat + ' 套装总点数应为 ' + expected);
    assert.equal(seen.size, 4, mat + ' 四个槽位都要有');
  }
  assert.equal(total, 12, '皮革/铁/钻石 × 4 件 = 12 件');
});

test('护甲 A3 三套配方走真实 findRecipe（含工作台 3×3 与背包 2×2 的边界）', () => {
  const grid3 = (rows, key) => {
    const g = [[null, null, null], [null, null, null], [null, null, null]];
    rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch !== ' ') g[y][x] = key[ch]; }));
    return g;
  };
  const patterns = {
    helmet: ['iii', 'i i'],
    chestplate: ['i i', 'iii', 'iii'],
    leggings: ['iii', 'i i', 'i i'],
    boots: ['i i', 'i i']
  };
  const ingot = { leather: 'leather', iron: 'iron_ingot', diamond: 'diamond' };
  for (const mat of ['leather', 'iron', 'diamond']) {
    for (const [kind, rows] of Object.entries(patterns)) {
      const r = findRecipe(grid3(rows, { i: ingot[mat] }));
      assert.ok(r, mat + ' ' + kind + ' 配方没识别');
      assert.equal(r.result.item, mat + '_' + kind, '配方产物不对：' + JSON.stringify(r.result));
      assert.equal(r.result.count, 1);
    }
  }
  const wrong = findRecipe(grid3(patterns.helmet, { i: 'gold_ingot' }));
  assert.ok(!wrong || wrong.result.item !== 'iron_helmet', '金锭不该被当成铁头盔：' + JSON.stringify(wrong && wrong.result));
  // 四件护甲的图案都是 3 列宽（靴子是“i i / i i”），所以全部必须用工作台；
  // 2×2 背包格里摆满 4 个皮革也不许被认成任何一件护甲。
  const r2 = findRecipe([['leather', 'leather'], ['leather', 'leather']]);
  assert.ok(!r2 || !/^(leather|iron|diamond)_(helmet|chestplate|leggings|boots)$/.test(r2.result.item),
    '2×2 背包不该做出护甲：' + JSON.stringify(r2 && r2.result));
});

test('护甲 A4 真实装备/卸下：装备格与 36 格背包互转，非护甲不许塞进装备格', () => {
  const inv = new Inventory();
  inv.add('iron_chestplate', 1);
  const idx = inv.slots.findIndex(s => s && s.item === 'iron_chestplate');
  assert.ok(idx >= 0, '前置：背包里有铁胸甲');
  assert.equal(inv.equipFrom(idx), true, '装备应成功');
  assert.equal(inv.get(idx), null, '装备后原背包格必须清空');
  assert.equal(inv.armor[1] && inv.armor[1].item, 'iron_chestplate', '胸甲应进第 2 个装备格');
  assert.equal(inv.armorPoints(), 6, '铁胸甲 6 点');
  assert.equal(inv.unequip(1), true, '卸下应成功');
  assert.equal(inv.armor[1], null, '卸下后装备格清空');
  assert.equal(inv.countOf('iron_chestplate'), 1, '卸下后回到背包');

  inv.add('diamond', 1);
  const di = inv.slots.findIndex(s => s && s.item === 'diamond');
  assert.equal(inv.equipFrom(di), false, '钻石不是护甲，不能装备');
  assert.equal(inv.get(di) && inv.get(di).item, 'diamond', '失败时物品必须留在原位');

  inv.add('leather_helmet', 1);
  const hi = inv.slots.findIndex(s => s && s.item === 'leather_helmet');
  inv.armor[0] = { item: 'iron_helmet', count: 1, dur: 100 };
  assert.equal(inv.equipFrom(hi), true);
  assert.equal(inv.armor[0].item, 'leather_helmet');
  assert.equal(inv.get(hi) && inv.get(hi).item, 'iron_helmet', '换下来的旧头盔应回到那个背包格');
  assert.equal(inv.armorPoints(), 1, '此时只穿着 1 点的皮革头盔');
});

test('护甲 A5 无甲与有甲吃同一次近战：伤害按 2.4 / 1.2 / 0.6 结算，且护甲只扣一次耐久', () => {
  const mk = (points) => {
    const c = new PlayerController(new VoxelWorld(seed));
    let hits = 0;
    c.health = 20;
    c.armor = { points: () => points, onHit: () => { hits++; return []; } };
    return { c, hits: () => hits };
  };
  const bare = mk(0); bare.c.hurt(3, '被僵尸攻击', 'melee');
  assert.equal(bare.c.health, 17, '无甲 3 点伤害应全额扣血');
  assert.equal(bare.hits(), 0, '无甲不该触发护甲耐久');
  const leather = mk(5); leather.c.hurt(3, '被僵尸攻击', 'melee');
  assert.ok(Math.abs(leather.c.health - 17.6) < 1e-9, '皮革应只受 2.4，实得 ' + leather.c.health);
  assert.equal(leather.hits(), 1, '一次受击只扣一轮护甲耐久');
  const iron = mk(15); iron.c.hurt(3, '被僵尸攻击', 'melee');
  assert.ok(Math.abs(iron.c.health - 18.8) < 1e-9, '铁应只受 1.2，实得 ' + iron.c.health);
  const diamond = mk(20); diamond.c.hurt(3, '被僵尸攻击', 'melee');
  assert.ok(Math.abs(diamond.c.health - 19.4) < 1e-9, '钻石应只受 0.6，实得 ' + diamond.c.health);
  iron.c.hurt(3, '被僵尸攻击', 'melee');
  assert.ok(Math.abs(iron.c.health - 18.8) < 1e-9, '无敌帧内不该再扣血');
  assert.equal(iron.hits(), 1, '无敌帧内不该再扣护甲耐久');
});

test('护甲 A6 非战斗伤害不减免：摔落/仙人掌/溺水/饥饿/中毒都不许被护甲吃掉，也不扣耐久', () => {
  for (const type of ['fall', 'cactus', 'drown', 'starve', 'poison', 'generic']) {
    const c = new PlayerController(new VoxelWorld(seed));
    let hits = 0;
    c.health = 20; c.invulnerable = 0;
    c.armor = { points: () => 20, onHit: () => { hits++; return []; } };
    c.hurt(3, '测试', type);
    assert.equal(c.health, 17, type + ' 应全额扣血');
    assert.equal(hits, 0, type + ' 不该扣护甲耐久');
  }
  for (const type of ['melee', 'arrow', 'explosion']) {
    assert.ok(ARMOR_DAMAGE_TYPES.has(type), '可减免类型必须包含 ' + type);
  }
  const c2 = new PlayerController(new VoxelWorld(seed));
  c2.health = 20; c2.armor = { points: () => 20, onHit: () => [] };
  c2.hurt(3, '被箭射中', 'arrow');
  assert.ok(Math.abs(c2.health - 19.4) < 1e-9, '生物箭矢应被减免');
  const c3 = new PlayerController(new VoxelWorld(seed));
  c3.health = 20; c3.armor = { points: () => 20, onHit: () => [] };
  c3.hurt(10, '被苦力怕炸伤', 'explosion');
  assert.ok(Math.abs(c3.health - 18) < 1e-9, '爆炸应被减免（10 → 2）');
});

test('护甲 A7 耐久：每次受击四件各扣 1，耗尽的那件从装备格消失，其余不受影响', () => {
  const inv = new Inventory();
  for (const id of ['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots']) {
    inv.add(id, 1);
    const i = inv.slots.findIndex(s => s && s.item === id);
    assert.equal(inv.equipFrom(i), true, '装备 ' + id);
  }
  const events = [];
  inv.on('armorBreak', (id) => events.push(id));
  inv.armor[0].dur = 1;
  const broken = inv.damageArmor();
  assert.deepEqual(broken, ['leather_helmet'], '只有头盔该碎：' + JSON.stringify(broken));
  assert.equal(inv.armor[0], null, '碎掉的护甲必须从装备格移除');
  assert.equal(inv.armor[1].dur, ITEMS.leather_chestplate.durability - 1, '胸甲扣 1 点');
  assert.equal(inv.armor[2].dur, ITEMS.leather_leggings.durability - 1, '护腿扣 1 点');
  assert.equal(inv.armor[3].dur, ITEMS.leather_boots.durability - 1, '靴子扣 1 点');
  assert.deepEqual(events, ['leather_helmet'], 'armorBreak 事件只能发一次');
  assert.equal(inv.armorPoints(), 4, '碎掉头盔后只剩 4 点（1+2+1）');
});

test('护甲 A8 存档往返：装备与剩余耐久都保留；旧档缺字段/坏数据安全回落为空装备', () => {
  const inv = new Inventory();
  inv.add('diamond_chestplate', 1);
  const i = inv.slots.findIndex(s => s && s.item === 'diamond_chestplate');
  inv.equipFrom(i);
  inv.armor[1].dur = 77;
  const saved = JSON.parse(JSON.stringify({ armor: inv.serializeArmor() }));
  const inv2 = new Inventory();
  inv2.deserializeArmor(saved.armor);
  assert.equal(inv2.armor[1] && inv2.armor[1].item, 'diamond_chestplate');
  assert.equal(inv2.armor[1].dur, 77, '剩余耐久必须恢复');
  assert.equal(inv2.armor[0], null, '没穿的位置仍是空');

  const inv3 = new Inventory();
  inv3.deserializeArmor(undefined);
  assert.deepEqual(inv3.armor, [null, null, null, null], '旧档没有 armor 字段时默认空装备');

  const inv4 = new Inventory();
  inv4.deserializeArmor([{ i: 'diamond', d: 5 }, { i: 'leather_helmet' }, null, { i: 'iron_boots' }]);
  assert.equal(inv4.armor[0], null, '槽位里不是护甲的物品要被忽略');
  assert.equal(inv4.armor[1], null, '头盔不能塞进胸甲槽');
  assert.equal(inv4.armor[3] && inv4.armor[3].item, 'iron_boots');
  assert.equal(inv4.armor[3].dur, ITEMS.iron_boots.durability, '缺 dur 时补满耐久');
});

/* ================= 盾牌 T2 ================= */
test('盾牌 B1 方向性格挡扇区：正面 120° 内挡、59° 与 61° 的边界、背后不挡', () => {
  const a59 = 59 * Math.PI / 180, a61 = 61 * Math.PI / 180;
  // 视线朝 -Z（yaw=0 的 lookDir）
  const lx = 0, lz = -1;
  assert.equal(inShieldArc(lx, lz, 0, -2), true, '正前方要挡');
  assert.equal(inShieldArc(lx, lz, Math.sin(a59), -Math.cos(a59)), true, '59° 仍在扇区内');
  assert.equal(inShieldArc(lx, lz, Math.sin(a61), -Math.cos(a61)), false, '61° 已出扇区');
  assert.equal(inShieldArc(lx, lz, 0, 1), false, '正后方不挡');
  assert.equal(inShieldArc(lx, lz, 2, 0), false, '正侧方（90°）不挡');
  assert.equal(inShieldArc(0, 0, 0, 1), false, '零长度视线不能算挡');
  assert.equal(inShieldArc(0, -1, 0, 0), false, '零长度来源不能算挡');
  assert.ok(Math.abs(SHIELD_BLOCK_ANGLE - Math.PI * 2 / 3) < 1e-9, '总扇区必须正好 120°');
  assert.equal(shieldCanBlock('melee'), true);
  assert.equal(shieldCanBlock('arrow'), true);
  assert.equal(shieldCanBlock('explosion'), false, '爆炸不能穿盾挡住');
  assert.equal(shieldCanBlock('fall'), false);
});

test('盾牌 B2 物品与配方：6 木板 + 1 铁锭，独立耐久且工作台可识别', () => {
  const it = ITEMS.shield;
  assert.ok(it, 'ITEMS 里没有 shield');
  assert.equal(it.shield, true);
  assert.equal(it.stack, 1, '盾牌不可堆叠');
  assert.ok(it.durability >= 200, '盾牌要有耐久：' + it.durability);
  const grid = [[null, null, null], [null, null, null], [null, null, null]];
  const rows = ['ppp', 'pip', ' p '];
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === 'p') grid[y][x] = 'planks';
    if (ch === 'i') grid[y][x] = 'iron_ingot';
  }));
  const r = findRecipe(grid);
  assert.ok(r && r.result.item === 'shield', '6 木板 + 1 铁锭的图案没识别：' + JSON.stringify(r && r.result));
  assert.equal(r.result.count, 1);
  // 材料不对（全木板）不能出盾牌
  const r2 = findRecipe([['planks', 'planks', 'planks'], ['planks', 'planks', 'planks'], [null, 'planks', null]]);
  assert.ok(!r2 || r2.result.item !== 'shield', '少铁锭不该做出盾牌');
});

test('盾牌 B3 控制器：正面近战/箭矢被挡、背后照吃、爆炸不挡、举盾才有格挡', () => {
  const mk = (blocking) => {
    const c = new PlayerController(new VoxelWorld(seed));
    c.health = 20; c.invulnerable = 0; c.blocking = !!blocking;
    let blocks = 0;
    c.onShieldBlock = () => { blocks++; return { broken: false }; };
    return { c, blocks: () => blocks };
  };
  // 正前方近战
  const front = mk(true);
  const info1 = front.c.hurt(3, '被僵尸攻击', 'melee', { x: front.c.pos.x, z: front.c.pos.z - 2, kind: 'melee' });
  assert.equal(front.c.health, 20, '正面近战应被盾牌完全挡下');
  assert.equal(front.blocks(), 1, '成功格挡要触发一次耐久回调');
  assert.ok(info1 && info1.blocked === true && info1.taken === 0, '伤害明细要写清 blocked：' + JSON.stringify(info1));
  assert.equal(front.c.lastBlock.kind, 'melee');
  // 背后近战
  front.c.invulnerable = 0;
  const info2 = front.c.hurt(3, '被僵尸攻击', 'melee', { x: front.c.pos.x, z: front.c.pos.z + 2, kind: 'melee' });
  assert.equal(front.c.health, 17, '背后攻击必须照吃');
  assert.equal(front.blocks(), 1, '没挡下就不该扣盾牌耐久');
  assert.equal(info2.blocked, false);
  // 正面箭矢
  front.c.invulnerable = 0;
  const info3 = front.c.hurt(2, '被箭射中', 'arrow', { x: front.c.pos.x, z: front.c.pos.z - 3, kind: 'arrow' });
  assert.equal(front.c.health, 17, '正面箭矢应被挡下');
  assert.equal(front.blocks(), 2);
  assert.equal(info3.blocked, true);
  // 爆炸不挡
  front.c.invulnerable = 0;
  front.c.hurt(4, '被苦力怕炸伤', 'explosion', { x: front.c.pos.x, z: front.c.pos.z - 1, kind: 'explosion' });
  assert.equal(front.c.health, 13, '爆炸不该被盾牌挡住');
  assert.equal(front.blocks(), 2, '爆炸不消耗盾牌');
  // 没举盾：正面也不挡
  const down = mk(false);
  down.c.hurt(3, '被僵尸攻击', 'melee', { x: down.c.pos.x, z: down.c.pos.z - 2, kind: 'melee' });
  assert.equal(down.c.health, 17, '没举盾时正面照吃');
  assert.equal(down.blocks(), 0);
});

test('盾牌 B4 只有成功格挡才磨耐久：举盾不挨打不掉，挡到耗尽后盾牌消失', () => {
  const c = new PlayerController(new VoxelWorld(seed));
  const inv = new Inventory();
  inv.set(0, { item: 'shield', count: 1, dur: 2 });
  inv.select(0);
  c.health = 20; c.invulnerable = 0; c.blocking = true;
  c.onShieldBlock = () => ({ broken: inv.damageHeldTool(1) });
  assert.equal(inv.heldDur(), 2, '前置：盾牌耐久 2');
  // 只是举着（没有受击）不掉耐久
  assert.equal(inv.heldDur(), 2, '没受击不该掉耐久');
  c.hurt(3, '被僵尸攻击', 'melee', { x: c.pos.x, z: c.pos.z - 2 });
  assert.equal(inv.heldDur(), 1, '成功挡一次扣 1');
  c.invulnerable = 0;
  c.hurt(3, '被僵尸攻击', 'melee', { x: c.pos.x, z: c.pos.z - 2 });
  assert.equal(inv.get(0), null, '耐久耗尽后盾牌必须消失');
  assert.equal(c.health, 20, '两次都被挡下，不该掉血');
});

test('盾牌 B5 格挡时移动明显变慢（不是只改了一个标志位）', () => {
  const w = new VoxelWorld(2718);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const x = 8, z = 8, gy = w.topSolidY(x, z);
  for (let d = 0; d <= 10; d++) {
    w.setBlock(x, gy, z - d, B.STONE, 0);
    for (let h = 1; h <= 3; h++) w.setBlock(x, gy + h, z - d, AIR, 0);
  }
  const fwd = { keyW: true, keyS: false, keyA: false, keyD: false, jump: false, sprint: false, sneak: false };
  const run = (blocking) => {
    const c = new PlayerController(w);
    c.spawnAt(x + 0.5, gy + 1, z + 0.5);
    c.yaw = 0; c.blocking = blocking;
    for (let i = 0; i < 90; i++) c.update(0.02, fwd);
    return Math.abs(c.pos.z - (z + 0.5));
  };
  const normal = run(false);
  const guarded = run(true);
  assert.ok(normal > 3, '对照：不举盾要能正常走起来，实得 ' + normal.toFixed(2));
  assert.ok(guarded < normal * 0.7, '举盾时必须明显变慢：' + normal.toFixed(2) + ' → ' + guarded.toFixed(2));
  assert.ok(guarded > 0.5, '举盾仍应能移动，不能变成钉在原地：' + guarded.toFixed(2));
});

/* ================= 成就 T3 ================= */
test('成就 C1 正好 8 个、id 唯一、名称/说明齐全（不做排行榜与奖励点数）', () => {
  assert.equal(ACHIEVEMENTS.length, 8, '首批只做 8 个');
  assert.equal(new Set(ACHIEVEMENT_IDS).size, 8, 'id 不能重复');
  const want = ['wood', 'crafting_table', 'cobblestone', 'furnace', 'iron_ingot', 'armor', 'shield', 'diamond'];
  assert.deepEqual(ACHIEVEMENT_IDS.slice().sort(), want.slice().sort());
  for (const a of ACHIEVEMENTS) {
    assert.ok(a.name && a.name.length > 0, a.id + ' 缺名称');
    assert.ok(a.desc && a.desc.length > 0, a.id + ' 缺说明');
    assert.ok(a.toast && a.toast.length > 0, a.id + ' 缺完成提示');
    assert.ok(!a.reward, a.id + ' 不该有奖励点数');
  }
});

test('成就 C2 同一存档只解锁一次；序列化往返保留；未知 id 安全忽略', () => {
  const a = new Achievements();
  assert.equal(a.count(), 0);
  const first = a.unlock('wood');
  assert.ok(first && first.id === 'wood', '第一次解锁应返回定义（用于弹 toast）');
  assert.equal(a.unlock('wood'), null, '重复解锁必须返回 null，不重复弹');
  assert.equal(a.count(), 1);
  a.unlock('diamond');
  const saved = JSON.parse(JSON.stringify(a.serialize()));
  const b = Achievements.deserialize(saved);
  assert.equal(b.count(), 2);
  assert.equal(b.has('wood'), true);
  assert.equal(b.has('diamond'), true);
  assert.equal(b.unlock('wood'), null, '读档后仍不能重复解锁');
  const c = Achievements.deserialize(['wood', 'nope', 'wood']);
  assert.equal(c.count(), 1, '未知 id 与重复 id 都要忽略：' + JSON.stringify(c.serialize()));
  assert.equal(Achievements.deserialize(undefined).count(), 0, '旧档没有字段 → 空成就');
});

test('成就 C3 事件映射：获得物品/制作物品分别触发，不把「捡到工作台」当成制作', () => {
  assert.deepEqual(itemAchievementIds('oak_log'), ['wood']);
  assert.deepEqual(itemAchievementIds('birch_log'), ['wood']);
  assert.deepEqual(itemAchievementIds('cobblestone'), ['cobblestone']);
  assert.deepEqual(itemAchievementIds('iron_ingot'), ['iron_ingot']);
  assert.deepEqual(itemAchievementIds('diamond'), ['diamond']);
  assert.deepEqual(itemAchievementIds('dirt'), []);
  assert.deepEqual(craftAchievementIds('crafting_table'), ['crafting_table']);
  assert.deepEqual(craftAchievementIds('furnace'), ['furnace']);
  assert.deepEqual(craftAchievementIds('shield'), ['shield']);
  assert.deepEqual(craftAchievementIds('oak_log'), [], '原木不是制作成就');
  // 捡到工作台只可能触发物品成就（工作台没有物品成就），绝不会解锁「制作工作台」
  assert.deepEqual(itemAchievementIds('crafting_table'), []);
});

test('成就 C4 旧档按现有状态安全初始化：有的才补，不凭空解锁钻石', () => {
  const ids = inferAchievements({
    items: { oak_log: 3, crafting_table: 1, cobblestone: 12, furnace: 1, iron_ingot: 2, diamond: 0, shield: 1 },
    armorEquipped: true
  });
  for (const id of ['wood', 'crafting_table', 'cobblestone', 'furnace', 'iron_ingot', 'armor', 'shield']) {
    assert.ok(ids.includes(id), '旧档应补上 ' + id + '：' + JSON.stringify(ids));
  }
  assert.ok(!ids.includes('diamond'), '没有钻石不能补钻石成就');
  const empty = inferAchievements({ items: {}, armorEquipped: false });
  assert.deepEqual(empty, [], '空旧档不该凭空解锁');
  const noArmor = inferAchievements({ items: { diamond: 1 }, armorEquipped: false });
  assert.deepEqual(noArmor, ['diamond'], '有钻石但没穿甲：只补钻石');
});

/* ---- T3 战斗反馈：四类声音必须都在音效表里且彼此不同 ---- */
test('反馈 C5 命中/格挡/受伤/护甲碎裂四类音效都存在且名称不同', () => {
  for (const name of ['hit', 'shield_block', 'hurt', 'armor_break']) {
    assert.ok(SOUND_NAMES.includes(name), '音效表缺少 ' + name + '：' + SOUND_NAMES.join(','));
  }
  assert.equal(new Set(['hit', 'shield_block', 'hurt', 'armor_break']).size, 4, '四类反馈音不能共用同一个名字');
  assert.ok(SOUND_NAMES.includes('shield_break'), '盾碎也应有独立音效');
  assert.equal(new Set(SOUND_NAMES).size, SOUND_NAMES.length, '音效名不能重复注册');
});

/* ================= 音乐与环境声 T4 ================= */
test('音乐 M1 三首曲子：白天 72~84 BPM、夜晚 58~66 BPM、洞穴无节拍且都至少 20 秒', () => {
  assert.deepEqual(TRACK_IDS.slice().sort(), ['cave', 'day', 'night']);
  const day = TRACKS.day, night = TRACKS.night, cave = TRACKS.cave;
  assert.ok(day.bpm >= 72 && day.bpm <= 84, '白天 BPM 应在 72~84：' + day.bpm);
  assert.ok(night.bpm >= 58 && night.bpm <= 66, '夜晚 BPM 应在 58~66：' + night.bpm);
  assert.equal(cave.bpm, null, '洞穴没有固定强节拍');
  for (const t of [day, night, cave]) {
    assert.equal(t.bars, 8, t.id + ' 应为 8 小节');
    assert.ok(t.loopSeconds >= 20, t.id + ' 每轮至少 20 秒，实得 ' + t.loopSeconds);
    assert.ok(Array.isArray(t.motif) && t.motif.length >= 4, t.id + ' 要有明确主题动机');
  }
  const info = trackInfo('day');
  assert.equal(info.id, 'day');
  assert.ok(info.loopSeconds >= 20);
});

test('音乐 M2 动机在 8 小节内原样或变化重复（不是纯随机音符）', () => {
  const countSeq = (track) => {
    const seq = track.events.slice().sort((a, b) => a.b - b.b).filter(e => e.n).map(e => e.n);
    let n = 0;
    for (let i = 0; i + track.motif.length <= seq.length; i++) {
      if (seq.slice(i, i + track.motif.length).join('|') === track.motif.join('|')) n++;
    }
    return n;
  };
  assert.ok(countSeq(TRACKS.day) >= 2, '白天动机至少原样出现 2 次，实得 ' + countSeq(TRACKS.day));
  assert.ok(countSeq(TRACKS.night) >= 2, '夜晚动机至少出现 2 次，实得 ' + countSeq(TRACKS.night));
  // 洞穴没有旋律动机，但 drone 段必须重复同一组音高，滴水时刻必须确定
  assert.equal(TRACKS.cave.drones.length, 4);
  assert.equal(TRACKS.cave.drones.filter(d => d.notes.join() === TRACKS.cave.drones[0].notes.join()).length >= 2, true,
    '洞穴 drone 主题应重复');
  const dripTimes = TRACKS.cave.drips.map(d => d.t);
  assert.equal(new Set(dripTimes).size, dripTimes.length, '滴水时刻不能重复叠在同一个采样点');
  assert.deepEqual(dripTimes, [...dripTimes].sort((a, b) => a - b), '滴水时刻应递增');
});

test('音乐 M3 环境床选择：雨>洞穴>夜虫>白天风，屋内下雨退回风', () => {
  assert.equal(selectAmbient({ weather: 'rain', intensity: 1, sheltered: false, underground: false, night: false }), 'rain');
  assert.equal(selectAmbient({ weather: 'snow', intensity: 1, sheltered: false, underground: true, night: true }), 'cave', '地下优先洞穴声，雪不借雨声');
  assert.equal(selectAmbient({ weather: 'rain', intensity: 1, sheltered: true, underground: false, night: false }), 'rain', '屋内保留经遮蔽处理的远雨');
  assert.equal(selectAmbient({ weather: 'clear', intensity: 0, sheltered: false, underground: true, night: false }), 'cave');
  assert.equal(selectAmbient({ weather: 'clear', intensity: 0, sheltered: false, underground: false, night: true }), 'insects');
  assert.equal(selectAmbient({ weather: 'clear', intensity: 0, sheltered: false, underground: false, night: false }), 'wind');
  assert.deepEqual(AMBIENT_IDS.slice().sort(), ['cave', 'insects', 'rain', 'underwater', 'wind']);
});

/* ================= TNT T5 ================= */
test('TNT P1 引信纯逻辑：3 秒、每 0.25 秒闪一次、归零只爆一次', () => {
  assert.ok(Math.abs(TNT_FUSE_SECONDS - 3) < 1e-9, '引信必须是 3 秒：' + TNT_FUSE_SECONDS);
  assert.equal(TNT_POWER, 4);
  assert.equal(TNT_DAMAGE_RANGE, 8);
  assert.equal(TNT_MAX_DAMAGE, 20);
  let f = TNT_FUSE_SECONDS, toggles = 0, boom = 0;
  for (let i = 0; i < 200; i++) {
    const r = stepFuse(f, 0.02);
    if (r.toggle) toggles++;
    if (r.exploded && !r.wasExploded) boom++;
    f = r.fuse;
    if (f <= 0) break;
  }
  assert.equal(boom, 1, '引信归零只能报一次爆炸，实得 ' + boom);
  assert.ok(toggles >= 10 && toggles <= 14, '3 秒内应闪约 12 次（每 0.25s），实得 ' + toggles);
  const again = stepFuse(0, 0.02);
  assert.equal(again.exploded, false, '已经是 0 时不能再次报「刚归零」，否则会重复引爆');
  assert.equal(again.wasExploded, true);
});

test('TNT P2 方块/物品/配方：4 沙 + 5 火药，铁锭 + 燧石做打火石', () => {
  assert.ok(B.TNT > 0, 'BLOCKS 里没有 TNT');
  assert.equal(BLOCKS[B.TNT].name, 'TNT');
  assert.ok(ITEMS.tnt && ITEMS.tnt.blockId === B.TNT, 'tnt 物品必须能放置成 TNT 方块');
  const fs = ITEMS.flint_and_steel;
  assert.ok(fs, '缺少打火石');
  assert.equal(fs.ignites, true);
  assert.ok(fs.durability >= 32, '打火石要有耐久：' + fs.durability);
  assert.equal(fs.stack, 1);
  // 4 沙 + 5 火药（无序，工作台 3×3）
  const grid = [['sand', 'sand', 'sand'], ['sand', 'gunpowder', 'gunpowder'], ['gunpowder', 'gunpowder', 'gunpowder']];
  const r = findRecipe(grid);
  assert.ok(r && r.result.item === 'tnt', '4 沙 + 5 火药没识别：' + JSON.stringify(r && r.result));
  const r2 = findRecipe([['iron_ingot', 'flint'], [null, null]]);
  assert.ok(r2 && r2.result.item === 'flint_and_steel', '铁锭 + 燧石没识别：' + JSON.stringify(r2 && r2.result));
});

test('TNT P3 可被爆炸破坏、掉落自身；水/基岩仍然不可破', () => {
  const w = new VoxelWorld(5150);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const x = 8, y = 40, z = 8;
  w.setBlock(x, y, z, B.TNT, 0);
  assert.equal(breakableAt(w, x, y, z), true, 'TNT 应能被爆炸移除（最小版不做事先探测，只按方块算）');
  w.setBlock(x + 1, y, z, B.BEDROCK, 0);
  assert.equal(breakableAt(w, x + 1, y, z), false);
  w.setBlock(x + 2, y, z, B.WATER, 0);
  assert.equal(breakableAt(w, x + 2, y, z), false);
  const cells = explosionCells({ cx: x, cy: y, cz: z, power: 2, rand: () => 0.5, canBreak: (a, b, c) => breakableAt(w, a, b, c) });
  assert.ok(cells.some(c => c.x === x && c.y === y && c.z === z), 'TNT 自己应在爆炸格子里');
});

test('TNT P4 有限连锁与水中规则参数：干火药 power4/连锁 1 层，湿火药不破方块且伤害减半', () => {
  const dry = tntBlastSpec(false);
  assert.equal(dry.power, 4);
  assert.equal(dry.range, 8);
  assert.equal(dry.maxDamage, 20);
  assert.equal(dry.breaksBlocks, true);
  assert.equal(dry.chains, true);
  const wet = tntBlastSpec(true);
  assert.equal(wet.power, 2);
  assert.equal(wet.range, 4);
  assert.equal(wet.maxDamage, 8);
  assert.equal(wet.breaksBlocks, false);
  assert.equal(wet.chains, false);
  assert.equal(TNT_CHAIN_DEPTH, 1, '连锁只允许向下传 1 层');
  assert.ok(TNT_CHAIN_RADIUS >= 4 && TNT_CHAIN_RADIUS <= 6, '连锁半径应覆盖一次爆炸：' + TNT_CHAIN_RADIUS);
  assert.equal(TNT_CHAIN_MAX, 6);
  assert.ok(TNT_CHAIN_FUSE > 0.2 && TNT_CHAIN_FUSE < 2, '连锁引信要短但可观察：' + TNT_CHAIN_FUSE);
});

test('TNT P5 淹没判定：上方水或同层三面水算湿火药，干燥/两面水不算', () => {
  const mk = (above, sides) => {
    const side = new Set(sides);
    return {
      getBlock(x, y, z) {
        if (y === 1) return above ? B.WATER : 0;
        if (y !== 0) return 0;
        if (x === 1 && z === 0 && side.has('e')) return B.WATER;
        if (x === -1 && z === 0 && side.has('w')) return B.WATER;
        if (x === 0 && z === 1 && side.has('s')) return B.WATER;
        if (x === 0 && z === -1 && side.has('n')) return B.WATER;
        return 0;
      }
    };
  };
  assert.equal(tntSubmerged(mk(true, []), 0, 0, 0), true, '上方有水应算淹没');
  assert.equal(tntSubmerged(mk(false, ['e', 'w', 's']), 0, 0, 0), true, '三面水应算淹没');
  assert.equal(tntSubmerged(mk(false, ['e', 'w']), 0, 0, 0), false, '两面水不算');
  assert.equal(tntSubmerged(mk(false, []), 0, 0, 0), false, '干燥不算');
});

/* ================= 史莱姆 T6 ================= */
test('史莱姆 S1 定义与材料链：夜间敌对池、分裂、不掉自身而掉粘液球，9 球合成粘液块', () => {
  const d = MOB_TYPES.slime;
  assert.ok(d, 'MOBS 里没有 slime');
  assert.equal(d.hostile, true);
  assert.equal(d.slime, true);
  assert.equal(d.split, true);
  assert.ok((d.drop || []).some(x => x.item === 'slime_ball'), '史莱姆应掉粘液球：' + JSON.stringify(d.drop));
  assert.ok(NIGHT_TYPES.includes('slime'), '夜间敌对池要包含史莱姆');
  assert.ok(ITEMS.slime_ball, '缺少 slime_ball 物品');
  assert.equal(BLOCKS[B.SLIME_BLOCK].name, '粘液块');
  const grid = [['slime_ball', 'slime_ball', 'slime_ball'], ['slime_ball', 'slime_ball', 'slime_ball'], ['slime_ball', 'slime_ball', 'slime_ball']];
  const r = findRecipe(grid);
  assert.ok(r && r.result.item === 'slime_block', '9 粘液球没合成粘液块：' + JSON.stringify(r && r.result));
});

test('史莱姆 S2 尺寸/生命/伤害随 size 走；大→中→小分裂，最小才掉粘液球；存档保留尺寸', () => {
  const { mm, cx0, cz0, fy, events } = blastCtx();
  const big = mm.spawn('slime', cx0 + 0.5, fy + 1, cz0 + 0.5, { slimeSize: 4 });
  assert.ok(big, '生成史莱姆失败');
  assert.equal(big.slimeSize, 4);
  assert.equal(big.hp, 16, 'size4 生命应为 16');
  assert.equal(big.damage, 4, 'size4 伤害应为 4');
  assert.ok(Math.abs(big.width - 1.52) < 1e-9, 'size4 碰撞宽应为 1.52，实得 ' + big.width);
  assert.ok(Math.abs(big.mesh.scale.x - 1.44) < 1e-9, '模型缩放应随 size：' + big.mesh.scale.x);
  assert.equal(mm.spawn('slime', cx0 + 2.5, fy + 1, cz0 + 0.5, { slimeSize: 1 }).damage, 0, 'size1 不咬人');

  mm.hitMob(big, 999, { x: 0, z: 0 });
  let mids = mm.list.filter(m => m.type === 'slime' && m.slimeSize === 2);
  assert.ok(mids.length >= 2 && mids.length <= 3, '大史莱姆应分裂成 2~3 只中号，实得 ' + mids.length);
  assert.ok(mids.every(m => m.slimeSize === 2), '分裂后应是 size2：' + JSON.stringify(mids.map(m => m.slimeSize)));
  assert.equal(events.filter(e => e.drop === 'slime_ball').length, 0, '大/中号分裂时不掉粘液球');

  for (const m of mids.slice()) mm.hitMob(m, 999, { x: 0, z: 0 });
  const smalls = mm.list.filter(m => m.type === 'slime');
  assert.ok(smalls.length >= 2 && smalls.every(m => m.slimeSize === 1), '中号应全部拆成 size1：' + JSON.stringify(smalls.map(m => m.slimeSize)));
  const smallDropBefore = events.filter(e => e.drop === 'slime_ball').length;
  mm.hitMob(smalls[0], 999, { x: 0, z: 0 });
  assert.ok(events.filter(e => e.drop === 'slime_ball').length > smallDropBefore, '最小史莱姆击杀应掉粘液球');

  const saved = mm.serialize();
  const one = saved.find(s => s.t === 'slime');
  if (one) { one.sl = 4; one.hp = 16; }
  const mm2 = new MobManager(Object.assign({}, mm.ctx, { scene: { add() { }, remove() { } } }));
  mm2.maxMobs = 0;
  mm2.applySaved(saved.filter(s => s.t === 'slime').slice(0, 1));
  const restored = mm2.list.find(m => m.type === 'slime');
  assert.ok(restored && restored.slimeSize === 4 && restored.hp === 16, '读档应恢复 size4/hp16：' + JSON.stringify(mm2.list.map(m => [m.slimeSize, m.hp])));
});

test('史莱姆 S3 粘液块：玩家从高处落下会弹起且免摔落伤害；潜行不弹', () => {
  const w = new VoxelWorld(8848);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const x = 8, z = 8, gy = w.topSolidY(x, z);
  for (let h = 1; h <= 8; h++) w.setBlock(x, gy + h, z, AIR, 0);
  w.setBlock(x, gy, z, B.SLIME_BLOCK, 0);
  const c = new PlayerController(w);
  let bounced = false;
  c.on('bounce', () => { bounced = true; });
  c.spawnAt(x + 0.5, gy + 6, z + 0.5);
  for (let i = 0; i < 200 && !bounced; i++) c.update(0.02, { keyW: false, keyS: false, keyA: false, keyD: false, jump: false, sprint: false, sneak: false });
  assert.equal(bounced, true, '落到粘液块上应触发 bounce');
  assert.ok(c.vel.y > 5, '弹起速度应明显向上，实得 ' + c.vel.y.toFixed(2));
  assert.equal(c.health, 20, '粘液块应免除这次摔落伤害');

  const c2 = new PlayerController(w);
  let bounced2 = false;
  c2.on('bounce', () => { bounced2 = true; });
  c2.spawnAt(x + 0.5, gy + 6, z + 0.5);
  c2.sneakHeld = true;                     // 模拟按住潜行（空中也保持：不弹）
  for (let i = 0; i < 200 && !c2.onGround; i++) {
    c2.update(0.02, { keyW: false, keyS: false, keyA: false, keyD: false, jump: false, sprint: false, sneak: true });
  }
  assert.equal(bounced2, false, '潜行时不该弹');
  assert.ok(c2.health < 20, '潜行不弹时应正常吃摔落伤害，hp=' + c2.health);
});

/* ================= 狼 T6 ================= */
test('狼 W1 定义与生成池：白天可生成、可驯服、有独立模型/碰撞盒', () => {
  const d = MOB_TYPES.wolf;
  assert.ok(d, 'MOBS 里没有 wolf');
  assert.equal(d.tameable, true);
  assert.equal(d.hostile, false);
  assert.ok(DAY_TYPES.includes('wolf'), '白天生成池应包含狼');
  assert.ok(ITEMS.bone, '骨头必须是可获得的物品');
  const w = new MobManager({ world: new VoxelWorld(1), scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } }, controller: { pos: { x: 0, y: 40, z: 0 } }, game: { state: 'playing' } });
  const m = w.spawn('wolf', 0, 40, 0);
  assert.ok(m && m.width > 0.3 && m.height > 0.6, '狼的碰撞盒不合理：' + (m && [m.width, m.height]));
  assert.equal(m.tamed, false);
  assert.ok(m.collar && m.collar.visible === false, '未驯服时项圈必须隐藏');
});

test('狼 W2 三根骨头驯服、项圈点亮；空手切换坐下/起身；坐下不走', () => {
  const { mm, ctx, cx0, cz0, fy } = blastCtx();
  const wolf = mm.spawn('wolf', cx0 + 0.5, fy + 1, cz0 + 3.5);
  assert.ok(wolf);
  const r1 = mm.tameWolf(wolf);
  assert.equal(r1.tamed, false);
  assert.equal(r1.progress, 1);
  mm.tameWolf(wolf);
  const r3 = mm.tameWolf(wolf);
  assert.equal(r3.tamed, true, '第三根骨头必须驯服');
  assert.equal(wolf.tamed, true);
  assert.ok(wolf.collar && wolf.collar.visible === true, '驯服后项圈要显示');
  assert.equal(mm.toggleWolfSit(wolf), true);
  assert.equal(wolf.sitting, true);
  const before = { x: wolf.pos.x, z: wolf.pos.z };
  ctx.controller.pos.x = cx0 + 0.5; ctx.controller.pos.z = cz0 + 8.5;
  for (let i = 0; i < 60; i++) { mm.ai(wolf, 0.05, 100, 1); mm.physics(wolf, 0.05); }
  assert.ok(Math.hypot(wolf.pos.x - before.x, wolf.pos.z - before.z) < 0.35, '坐下时不该跟着走：' + Math.hypot(wolf.pos.x - before.x, wolf.pos.z - before.z).toFixed(2));
  assert.equal(mm.toggleWolfSit(wolf), false);
  assert.equal(wolf.sitting, false);
});

test('狼 W3 起身后跟随玩家并攻击附近敌对生物；驯服/坐下状态随存档', () => {
  const { mm, ctx, cx0, cz0, fy } = blastCtx();
  mm.clear();
  const wolf = mm.spawn('wolf', cx0 + 0.5, fy + 1, cz0 + 4.5);
  mm.tameWolf(wolf); mm.tameWolf(wolf); mm.tameWolf(wolf);
  ctx.controller.pos.x = cx0 + 0.5; ctx.controller.pos.z = cz0 + 9.5;
  const d0 = Math.hypot(wolf.pos.x - ctx.controller.pos.x, wolf.pos.z - ctx.controller.pos.z);
  for (let i = 0; i < 80; i++) mm.update(0.05, 1);
  const d1 = Math.hypot(wolf.pos.x - ctx.controller.pos.x, wolf.pos.z - ctx.controller.pos.z);
  assert.ok(d1 < d0 - 0.5, '驯服狼应跟随玩家：' + d0.toFixed(2) + ' → ' + d1.toFixed(2));

  const z = mm.spawn('zombie', wolf.pos.x + 1.0, wolf.pos.y, wolf.pos.z);
  const hp0 = z.hp;
  for (let i = 0; i < 50; i++) mm.update(0.05, 1);
  assert.ok(z.hp < hp0 || !mm.list.includes(z), '狼应攻击附近僵尸：hp ' + hp0 + '→' + z.hp);

  wolf.sitting = true;
  const saved = mm.serialize();
  const rec = saved.find(s => s.t === 'wolf');
  assert.ok(rec && rec.tm === 1 && rec.st === 1, '存档要写驯服/坐下：' + JSON.stringify(rec));
  const mm2 = new MobManager(Object.assign({}, mm.ctx, { scene: { add() { }, remove() { } } }));
  mm2.maxMobs = 0;
  mm2.applySaved(saved.filter(s => s.t === 'wolf'));
  const back = mm2.list.find(m => m.type === 'wolf');
  assert.ok(back && back.tamed === true && back.sitting === true, '读档应恢复驯服/坐下');
});

/* ================= 门 T6 ================= */
test('门 D1 方块/物品/配方：两格高、关闭实心/打开非实心、6 木板→3 扇', () => {
  assert.equal(BLOCKS[B.DOOR_BOTTOM].name, '门');
  assert.equal(BLOCKS[B.DOOR_TOP].name, '门');
  assert.equal(BLOCKS[B.DOOR_BOTTOM].solid, true);
  assert.equal(BLOCKS[B.DOOR_TOP].solid, true);
  assert.equal(BLOCKS[B.DOOR_BOTTOM_OPEN].solid, false);
  assert.equal(BLOCKS[B.DOOR_TOP_OPEN].solid, false);
  const it = ITEMS.door;
  assert.ok(it && it.doorItem === true, 'door 物品要有 doorItem 标记');
  const r = findRecipe([['planks', 'planks'], ['planks', 'planks'], ['planks', 'planks']]);
  assert.ok(r && r.result.item === 'door' && r.result.count === 3, '6 木板应合成 3 扇门：' + JSON.stringify(r && r.result));
});

test('门 D2 开合：meta 保留朝向、开合位切换、碰撞随方块 ID 同步、存档 diff 往返', () => {
  const w = new VoxelWorld(6060);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const x = 8, y = 40, z = 8;
  w.setBlock(x, y, z, B.DOOR_BOTTOM, 2);
  w.setBlock(x, y + 1, z, B.DOOR_TOP, 2);
  assert.equal(w.isSolidAt(x, y, z), true, '关闭时下半应实心');
  assert.equal(w.isSolidAt(x, y + 1, z), true, '关闭时上半应实心');
  const opened = w.toggleDoor(x, y + 1, z);            // 从上半点也要能开
  assert.ok(opened && opened.open === true);
  assert.equal(w.getBlock(x, y, z), B.DOOR_BOTTOM_OPEN);
  assert.equal(w.getBlock(x, y + 1, z), B.DOOR_TOP_OPEN);
  assert.equal(w.getMeta(x, y, z) & 3, 2, '开合不应丢掉朝向');
  assert.equal(w.getMeta(x, y, z) & 4, 4, 'open bit 应置位');
  assert.equal(w.isSolidAt(x, y, z), false, '打开后碰撞必须消失');
  assert.equal(w.isSolidAt(x, y + 1, z), false);
  const closed = w.toggleDoor(x, y, z);
  assert.ok(closed && closed.open === false);
  assert.equal(w.getBlock(x, y, z), B.DOOR_BOTTOM);
  assert.equal(w.getMeta(x, y, z) & 3, 2);
  assert.equal(w.isSolidAt(x, y, z), true);

  // 存档 diff：开门状态与朝向都写进 edits，读回仍可继续开合
  w.toggleDoor(x, y, z);
  const edits = JSON.parse(JSON.stringify(w.serializeEdits()));
  const w2 = new VoxelWorld(6060);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w2.ensureChunk(cx, cz);
  w2.applySavedData(edits);
  assert.equal(w2.getBlock(x, y, z), B.DOOR_BOTTOM_OPEN);
  assert.equal(w2.getMeta(x, y, z) & 3, 2);
  assert.equal(w2.isSolidAt(x, y, z), false);
  const re = w2.toggleDoor(x, y, z);
  assert.ok(re && re.open === false && w2.getBlock(x, y, z) === B.DOOR_BOTTOM);
});

/* ================= 村庄 V7（滚动任务 6） ================= */
test('村庄 V1 布局完全确定：房子/门/床/窗、集市工作台与箱子、农田水渠与成熟小麦都在', () => {
  const a = villageLayout(), b = villageLayout();
  assert.deepEqual(a, b, '同一份布局必须每次完全一致');
  assert.ok(a.length > 250, '村庄方块数应足够成村：' + a.length);
  const has = (id) => a.some(c => c.id === id);
  for (const [id, name] of [
    [B.GRASS, '草地'], [B.DIRT_PATH, '土径'], [B.PLANKS, '木板'], [B.LOG, '原木'],
    [B.DOOR_BOTTOM, '门下半'], [B.DOOR_TOP, '门上格'], [B.BED, '床'], [B.TORCH, '火把'],
    [B.GLASS, '玻璃'], [B.CRAFTING_TABLE, '工作台'], [B.CHEST, '箱子'],
    [B.FARMLAND, '耕地'], [B.WATER, '水渠'], [B.WHEAT, '小麦']
  ]) assert.ok(has(id), '布局缺少 ' + name);
  /* 门必须是上下两格在同一列，且朝向合法（低 2 位 0~3） */
  const door = a.find(c => c.id === B.DOOR_BOTTOM);
  assert.ok(a.some(c => c.id === B.DOOR_TOP && c.x === door.x && c.z === door.z && c.y === door.y + 1),
    '门上格必须在门下半的正上方');
  assert.ok((door.meta & 3) >= 0 && (door.meta & 3) <= 3, '门朝向位非法');
  /* 坐标唯一且不超出村庄半径 */
  const seen = new Set();
  for (const c of a) {
    const k = c.x + ',' + c.y + ',' + c.z;
    assert.ok(!seen.has(k), '重复坐标 ' + k);
    seen.add(k);
    assert.ok(Math.abs(c.x) <= VILLAGE_RADIUS && Math.abs(c.z) <= VILLAGE_RADIUS, '超出村庄半径：' + k);
  }
  /* 农田每一格非水即成熟小麦，且水渠只有一条 */
  const water = a.filter(c => c.id === B.WATER);
  assert.equal(water.length, 5, '水渠应是一整条 5 格');
  assert.ok(a.filter(c => c.id === B.WHEAT).every(c => c.meta === 7), '麦子应是成熟阶段');
});

test('村庄 V2 站点选择：优先平坦干地、拒绝起伏过大与贴世界顶的候选，且完全确定', () => {
  const flat = () => 42;
  const s1 = chooseVillageSite(flat, { x: 0, z: 0 }, 32, 64);
  const s2 = chooseVillageSite(flat, { x: 0, z: 0 }, 32, 64);
  assert.deepEqual(s1, s2, '同样输入必须给同样站点');
  assert.equal(s1.y, 42);
  assert.equal(s1.spread, 0);
  /* 第一个候选（+14,0）中间有一根深坑 → 起伏 10 > 6，应被跳过；第二个候选（0,+14）平坦 */
  const mixed = (x, z) => (x === 20 ? 30 : 42);
  const s3 = chooseVillageSite(mixed, { x: 0, z: 0 }, 32, 64);
  assert.ok(s3 && s3.x === 0 && s3.z === 14, '应跳过起伏过大的第一个候选：' + JSON.stringify(s3));
  /* 海面下的候选不选；全是海时至少把台地抬到海平面之上 */
  const ocean = () => 20;
  const s4 = chooseVillageSite(ocean, { x: 0, z: 0 }, 32, 64);
  assert.ok(s4 && s4.y >= 34, '保底站点必须高于海平面：' + JSON.stringify(s4));
  /* 世界顶附近不选 */
  const high = () => 60;
  const s5 = chooseVillageSite(high, { x: 0, z: 0 }, 32, 64);
  assert.ok(s5 && s5.spread === 0, '应当有保底结果：' + JSON.stringify(s5));
});

test('村庄 V3 三条交易真正可完成：小麦→绿宝石→面包→铁锭，缺料时一颗也不扣', () => {
  class MockInv {
    constructor(o) { this.slots = Object.assign({}, o); }
    countOf(i) { return this.slots[i] || 0; }
    remove(i, n) { const t = Math.min(n, this.countOf(i)); this.slots[i] = this.countOf(i) - t; return t; }
    add(i, n) { this.slots[i] = this.countOf(i) + n; return 0; }
  }
  assert.equal(VILLAGER_TRADES.length, 3);
  const inv = new MockInv({ wheat: 10, emerald: 0 });
  let r = performTrade(inv, VILLAGER_TRADES[0]);
  assert.ok(r.ok, '10 小麦应能换绿宝石：' + JSON.stringify(r));
  assert.equal(inv.countOf('wheat'), 0);
  assert.equal(inv.countOf('emerald'), 1);

  r = performTrade(inv, VILLAGER_TRADES[1]);
  assert.ok(r.ok, '1 绿宝石应能换 3 面包：' + JSON.stringify(r));
  assert.equal(inv.countOf('emerald'), 0);
  assert.equal(inv.countOf('bread'), 3);

  const before = JSON.stringify(inv.slots);
  r = performTrade(inv, VILLAGER_TRADES[2]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'materials');
  assert.equal(r.need, 3);
  assert.equal(JSON.stringify(inv.slots), before, '缺料失败不能改动背包');
  assert.equal(tradeCheck(inv, VILLAGER_TRADES[2]).ok, false);

  inv.add('emerald', 3);
  r = performTrade(inv, VILLAGER_TRADES[2]);
  assert.ok(r.ok, '3 绿宝石应能换铁锭：' + JSON.stringify(r));
  assert.equal(inv.countOf('emerald'), 0);
  assert.equal(inv.countOf('iron_ingot'), 1);
  assert.equal(r.leftover, 0);
});

test('村庄 V4 村民：独立模型/职业、不进自然刷怪池、走远会回家、家坐标随存档', () => {
  const def = MOB_TYPES.villager;
  assert.ok(def && def.name === '村民' && def.profession === 'farmer' && def.passive === true);
  assert.ok(NIGHT_TYPES.indexOf('villager') < 0 && DAY_TYPES.indexOf('villager') < 0, '村民不能进自然刷怪池');
  const { mm, cx0, cz0, fy } = blastCtx();
  mm.clear();
  mm.maxMobs = 0;
  const home = { x: cx0 - 6.5, y: fy + 1, z: cz0 - 6.5 };
  const v = mm.spawn('villager', cx0 + 6.5, fy + 1, cz0 + 6.5, { home });
  assert.ok(v && v.home && v.width > 0.3 && v.height > 1.5, '村民碰撞盒应像人');
  /* 玩家在远处 → 村民朝家走（真实 AI + 物理） */
  const d0 = Math.hypot(v.pos.x - home.x, v.pos.z - home.z);
  for (let i = 0; i < 120; i++) mm.update(0.05, 1);
  const d1 = Math.hypot(v.pos.x - home.x, v.pos.z - home.z);
  assert.ok(d1 < d0 - 1, '离家的村民应往回走：' + d0.toFixed(2) + ' → ' + d1.toFixed(2));
  const rec = mm.serialize().find(s => s.t === 'villager');
  assert.ok(rec && Number.isFinite(rec.hx) && Number.isFinite(rec.hz), '存档应带家坐标：' + JSON.stringify(rec));
  const mm2 = new MobManager(Object.assign({}, mm.ctx, { scene: { add() { }, remove() { } } }));
  mm2.maxMobs = 0;
  mm2.applySaved([rec]);
  const back = mm2.list.find(m => m.type === 'villager');
  assert.ok(back && back.home && Math.abs(back.home.x - home.x) < 0.01 && Math.abs(back.home.z - home.z) < 0.01,
    '读档应恢复村民的家');
});

test('村庄 V5 区块卸载不丢改动：远处建好的方块随存档往返（村庄存档的地基）', () => {
  const w = new VoxelWorld(7070);
  w.ensureChunk(0, 0);
  const x = 3, y = 40, z = 3;
  w.setBlock(x, y, z, B.PLANKS, 0);
  w.setCenter(1000, 1000);
  w.unloadFar(null);
  assert.equal(w.chunks.has(coordKey(0, 0)), false, '区块应已卸载');
  const edits = w.serializeEdits();
  assert.ok(Array.isArray(edits[coordKey(0, 0)]) && edits[coordKey(0, 0)].length >= 3,
    '卸载的区块改动必须留在 serializeEdits 里：' + JSON.stringify(Object.keys(edits)));
  const w2 = new VoxelWorld(7070);
  w2.applySavedData(edits);
  w2.ensureChunk(0, 0);
  assert.equal(w2.getBlock(x, y, z), B.PLANKS, '读档重生成区块后改动要回来');
  /* 再卸载一次 → 再保存，改动仍然不能丢 */
  w2.setCenter(1000, 1000);
  w2.unloadFar(null);
  const edits2 = w2.serializeEdits();
  assert.ok(Array.isArray(edits2[coordKey(0, 0)]), '二次卸载后改动仍在存档里');
});

/* ================= 雷暴与闪电 W8/W9（滚动任务 7） ================= */
test('天气 W9 雷暴是雨的加强子状态：标签/光照/雾/存档与旧档兼容，晴天转雷暴可确定复现', async () => {
  const { Weather, weatherLight, weatherFog, weatherLabel, STORM_CHANCE } =
    await import('../renderer/js/core/weather.js');
  const w = new Weather(() => 0.05);
  w.set('rain', 100);
  assert.equal(w.isStorm, false, '普通雨天不是雷暴');
  assert.equal(w.setStorm(true), true);
  assert.equal(w.isStorm, true);
  assert.equal(w.isWet, true, '雷暴仍算湿天气');
  assert.equal(w.label, '雷暴');
  assert.equal(weatherLabel('rain', true), '雷暴');
  assert.ok(weatherLight('rain', true) < weatherLight('rain', false), '雷暴要比普通雨更暗');
  assert.ok(weatherFog('rain', true) > weatherFog('rain', false), '雷暴视距要更短');
  const saved = JSON.parse(JSON.stringify(w.serialize()));
  assert.equal(saved.t, 'rain', '类型仍是 rain（不新增 WEATHER_TYPE）');
  assert.equal(saved.s, 1, '雷暴要写 s 标记');
  const back = Weather.deserialize(saved);
  assert.equal(back.isStorm, true, '读档恢复雷暴');
  /* 旧档：雨但没有 s 字段 → 普通雨 */
  const old = JSON.parse(JSON.stringify(saved));
  delete old.s;
  assert.equal(Weather.deserialize(old).isStorm, false, '旧档缺 s 一律按普通雨处理');
  /* 雪/晴上残留的 s 必须忽略 */
  assert.equal(Weather.deserialize({ t: 'snow', s: 1, left: 50, inten: 1 }).isStorm, false);
  assert.equal(Weather.deserialize({ t: 'clear', s: 1, left: 50, inten: 0 }).isStorm, false);
  /* 自然切换：低随机数进雷暴，高随机数不进；切到晴天雷暴标记自动清掉 */
  const stormRnd = new Weather(() => STORM_CHANCE * 0.5);
  stormRnd.roll('clear');
  stormRnd.rollNext();
  assert.equal(stormRnd.isStorm, true, '低随机数应从晴天转雷暴');
  const noStorm = new Weather(() => 0.9);
  noStorm.roll('clear');
  noStorm.rollNext();
  assert.equal(noStorm.type, 'snow');
  assert.equal(noStorm.isStorm, false);
  w.set('clear');
  assert.equal(w.isStorm, false, '切到晴天必须自动关闭雷暴');
});

test('闪电 W10 纯逻辑：伤害按 6 格平方衰减、落点 6~15 格、间隔与雷声延迟有界', async () => {
  const { lightningDamage, nextStrikeDelay, pickStrikeOffset, thunderDelay,
    LIGHTNING_DAMAGE_RANGE, LIGHTNING_MAX_DAMAGE, LIGHTNING_STRIKE_MIN, LIGHTNING_STRIKE_MAX } =
    await import('../renderer/js/core/lightning.js');
  assert.equal(lightningDamage(0), LIGHTNING_MAX_DAMAGE, '爆心满伤');
  const d2 = lightningDamage(2), d4 = lightningDamage(4);
  assert.ok(d2 > d4 && d4 > 0, '越远伤害越低：' + d2 + ' vs ' + d4);
  assert.equal(lightningDamage(LIGHTNING_DAMAGE_RANGE), 0, '6 格边缘为 0');
  assert.equal(lightningDamage(LIGHTNING_DAMAGE_RANGE + 0.01), 0);
  assert.equal(lightningDamage(-1), 0);
  assert.ok(nextStrikeDelay(() => 0) >= LIGHTNING_STRIKE_MIN - 1e-9);
  assert.ok(nextStrikeDelay(() => 1) <= LIGHTNING_STRIKE_MAX + 1e-9);
  const o0 = pickStrikeOffset(() => 0), o1 = pickStrikeOffset(() => 0.999999);
  assert.ok(o0.dist >= 6 - 1e-6 && o1.dist <= 15 + 1e-6, '落点距离应在 6~15 格');
  assert.ok(Math.abs(Math.hypot(o0.dx, o0.dz) - o0.dist) < 1e-6, 'dx/dz 必须与 dist 一致');
  assert.ok(thunderDelay(() => 0) >= 0.25 - 1e-9 && thunderDelay(() => 1) <= 1.1 + 1e-9);
});

/* ================= 地图与指南针 M8（滚动任务 8） ================= */
test('地图 M1 调色板与区块网格：256 格、草/水/石头可区分，未知方块有兜底', async () => {
  const { mapColorIndex, buildMapChunk, MAP_PALETTE, MAP_CHUNK } = await import('../renderer/js/core/map.js');
  assert.equal(MAP_PALETTE.length, 16);
  assert.equal(mapColorIndex(B.GRASS), 1);
  assert.equal(mapColorIndex(B.WATER), 6);
  assert.equal(mapColorIndex(B.STONE), 3);
  assert.equal(mapColorIndex(255), 15, '未知方块要有兜底色');
  const grid = buildMapChunk((x, z) => ({ id: z === 0 ? B.GRASS : (x === 0 ? B.WATER : B.STONE) }));
  assert.equal(grid.length, MAP_CHUNK * MAP_CHUNK);
  assert.equal(grid.charAt(0), '1', '左上草');
  assert.equal(grid.charAt(1), '1', '第一行草');
  assert.equal(grid.charAt(16), '6', '第二行第一格水');
  assert.equal(grid.charAt(17), '3', '其余石头');
  assert.ok(/^[0-9a-f]{256}$/.test(grid), '网格必须是 256 个十六进制字符');
});

test('指南针 M2 方位相对朝向旋转、八方名称与配方/物品齐备', async () => {
  const { compassDegrees, bearingDegrees, compassDirection } = await import('../renderer/js/core/map.js');
  const { ITEMS } = await import('../renderer/js/core/items.js');
  const { findRecipe } = await import('../renderer/js/core/recipes.js');
  assert.ok(ITEMS.map && ITEMS.map.mapItem === true, '缺少地图物品');
  assert.ok(ITEMS.compass && ITEMS.compass.compassItem === true, '缺少指南针物品');
  const mapR = findRecipe([['leather', 'leather', 'leather'], ['leather', 'stick', 'leather'], ['leather', 'leather', 'leather']]);
  assert.ok(mapR && mapR.result.item === 'map', '8 皮革 + 木棍应合成地图：' + JSON.stringify(mapR && mapR.result));
  const compR = findRecipe([[null, 'iron_ingot', null], ['iron_ingot', 'glass', 'iron_ingot'], [null, 'iron_ingot', null]]);
  assert.ok(compR && compR.result.item === 'compass', '4 铁锭 + 玻璃应合成指南针：' + JSON.stringify(compR && compR.result));

  assert.equal(Math.round(compassDegrees(0, -1, 0)), 0, '目标正北、朝北 → 指针朝上');
  assert.equal(Math.round(compassDegrees(1, 0, 0)), 90, '目标正东、朝北 → 指针朝右');
  assert.equal(Math.round(compassDegrees(1, 0, -Math.PI / 2)), 0, '目标正东、面朝东 → 指针朝上');
  assert.equal(Math.round(bearingDegrees(0, -1)), 0);
  assert.equal(Math.round(bearingDegrees(1, 0)), 90);
  assert.equal(compassDirection(0, -1), '北');
  assert.equal(compassDirection(1, 0), '东');
  assert.equal(compassDirection(0, 1), '南');
  assert.equal(compassDirection(-1, 0), '西');
});

/* ================= V4 近战与受击 ================= */
test('V4 死亡生物不会被再次结算：第二次 hitMob 返回 false，掉落不增加', () => {
  const { mm, cx0, cz0, fy, events } = blastCtx();
  mm.clear();
  const chicken = mm.spawn('chicken', cx0 + 0.5, fy + 1, cz0 + 0.5);
  assert.ok(chicken);
  chicken.hp = 1;
  const dropCount = () => events.filter(e => e.drop).length;
  const d0 = dropCount();
  const k1 = mm.hitMob(chicken, 99, { x: 0, z: 0 });
  const d1 = dropCount();
  const k2 = mm.hitMob(chicken, 99, { x: 0, z: 0 });
  const d2 = dropCount();
  assert.equal(k1, true, '第一次应命中');
  assert.equal(k2, false, '已经死亡后第二次必须返回 false');
  assert.ok(d1 > d0, '第一次击杀必须产生掉落：' + d0 + '→' + d1);
  assert.equal(d2, d1, '掉落不能因为二次结算增加');
  assert.equal(mm.list.includes(chicken), false, '死亡后应移出列表');
  assert.equal(chicken.dead, true, '死亡标记必须置位');
});

/* ================= E1 创造搜索 ================= */
test('E1 创造搜索：中文名/id/大小写/空结果/清空恢复全部', async () => {
  const { filterCreativeItems, creativePool } = await import('../renderer/js/core/creative.js');
  const pool = creativePool();
  assert.ok(pool.length > 100, '创造池应覆盖全部物品：' + pool.length);
  assert.equal(new Set(pool).size, pool.length, '池内不能有重复 id');
  const all = filterCreativeItems('');
  assert.equal(all.mode, 'all');
  assert.equal(all.items.length, pool.length);
  const iron = filterCreativeItems('铁');
  assert.ok(iron.items.includes('iron_ingot'), '中文「铁」应命中铁锭');
  assert.ok(iron.items.includes('pickaxe_iron'), '中文「铁」应命中铁镐');
  assert.ok(iron.items.length < pool.length);
  const comp = filterCreativeItems('compass');
  assert.deepEqual(comp.items, ['compass'], '英文 id 精确包含：' + JSON.stringify(comp.items));
  const upper = filterCreativeItems('  COMPASS ');
  assert.deepEqual(upper.items, ['compass'], '大小写与首尾空白应忽略');
  const none = filterCreativeItems('zzzz-no-such-item');
  assert.equal(none.count, 0);
  assert.equal(none.empty, true);
  assert.equal(filterCreativeItems('').count, pool.length, '清空搜索恢复全部物品');
});

/* ================= E2 三职业村民 ================= */
test('E2 三职业交易表：每职业三条、id 不重复、只用现有物品、旧档职业回落农夫', () => {
  assert.deepEqual([...VILLAGER_PROFESSION_IDS], ['farmer', 'librarian', 'blacksmith']);
  assert.equal(tradesFor('farmer'), VILLAGER_TRADES, '兼容旧导入：默认表仍是农夫三条');
  const ids = new Set();
  for (const p of VILLAGER_PROFESSION_IDS) {
    const prof = VILLAGER_PROFESSIONS[p];
    assert.ok(prof && prof.name && prof.trades.length === 3, p + ' 应有三条交易');
    assert.equal(tradesFor(p), prof.trades);
    for (const t of prof.trades) {
      assert.ok(!ids.has(t.id), '交易 id 不能重复：' + t.id);
      ids.add(t.id);
      assert.ok(ITEMS[t.give.item], t.id + ' 的扣料必须是现有物品：' + t.give.item);
      assert.ok(ITEMS[t.get.item], t.id + ' 的给货必须是现有物品：' + t.get.item);
      assert.ok(t.give.count > 0 && t.get.count > 0, t.id + ' 数量必须为正');
      class Inv {
        constructor(it, n) { this.slots = { [it]: n }; }
        countOf(i) { return this.slots[i] || 0; }
        remove(i, n) { this.slots[i] = this.countOf(i) - Math.min(n, this.countOf(i)); return n; }
        add(i, n) { this.slots[i] = this.countOf(i) + n; return 0; }
      }
      const inv = new Inv(t.give.item, t.give.count);
      const r = performTrade(inv, t);
      assert.ok(r.ok, t.id + ' 应能用指定材料完成：' + JSON.stringify(r));
      assert.equal(inv.countOf(t.give.item), 0, t.id + ' 应扣光材料');
      assert.equal(inv.countOf(t.get.item), t.get.count, t.id + ' 应给足产物');
    }
  }
  assert.equal(tradesFor('nope'), VILLAGER_TRADES, '未知职业回落农夫');
  assert.equal(normalizeVillagerProfession(undefined), 'farmer');
  assert.equal(normalizeVillagerProfession('librarian'), 'librarian');
  assert.equal(professionName('blacksmith'), '铁匠');
  assert.equal(VILLAGER_OFFSETS.length, 3);
  assert.deepEqual([...new Set(VILLAGER_OFFSETS.map(o => o.profession))], ['farmer', 'librarian', 'blacksmith']);
  const farmer = VILLAGER_OFFSETS.find(o => o.profession === 'farmer');
  assert.ok(farmer && farmer.x === 3.5 && farmer.z === -3.5, '农夫保留旧版集市位置');
});

test('E2 村民外观/职业随存档往返：旧档没有 pr 读成戴草帽的农夫', () => {
  const { mm, cx0, cz0, fy } = blastCtx();
  mm.clear(); mm.maxMobs = 0;
  const looks = {};
  for (let i = 0; i < 3; i++) {
    const p = VILLAGER_PROFESSION_IDS[i];
    const hx = cx0 + 2 + i * 3, hz = cz0 + 4, hy = fy + 1;
    const v = mm.spawn('villager', hx, hy, hz, { profession: p, home: { x: hx, y: hy, z: hz } });
    assert.ok(v && v.profession === p, '生成时应保留职业：' + p);
    const parts = v.mesh.userData.parts;
    looks[p] = {
      body: parts.body.material.color.getHex(),
      hat: !!parts.hat, glasses: !!parts.glasses0, apron: !!parts.apron, hammer: !!parts.hammerHead
    };
  }
  assert.equal(looks.farmer.hat, true);
  assert.equal(looks.librarian.glasses, true);
  assert.equal(looks.blacksmith.apron, true);
  assert.equal(looks.blacksmith.hammer, true);
  assert.equal(new Set([looks.farmer.body, looks.librarian.body, looks.blacksmith.body]).size, 3,
    '三种职业身体颜色必须不同');
  const recs = mm.serialize().filter(s => s.t === 'villager');
  assert.equal(recs.length, 3);
  assert.deepEqual(recs.map(r => r.pr).sort(), ['blacksmith', 'farmer', 'librarian']);

  const mk = () => new MobManager(Object.assign({}, mm.ctx, { scene: { add() { }, remove() { } } }));
  const oldRec = { t: 'villager', x: cx0 + 0.5, y: fy + 1, z: cz0 + 0.5, yaw: 0, hp: 20,
    hx: cx0 + 0.5, hy: fy + 1, hz: cz0 + 0.5 };
  const mmOld = mk(); mmOld.maxMobs = 0; mmOld.applySaved([oldRec]);
  const oldV = mmOld.list.find(m => m.type === 'villager');
  assert.ok(oldV && oldV.profession === 'farmer', '旧档没有 pr → 农夫');
  assert.equal(!!oldV.mesh.userData.parts.hat, true);
  assert.equal(!!oldV.mesh.userData.parts.glasses0, false);

  const mmLib = mk(); mmLib.maxMobs = 0;
  mmLib.applySaved([Object.assign({}, oldRec, { pr: 'librarian' })]);
  const lib = mmLib.list.find(m => m.type === 'villager');
  assert.ok(lib && lib.profession === 'librarian', '有 pr 的存档应恢复职业');
  assert.equal(!!lib.mesh.userData.parts.glasses0, true);
  assert.equal(lib.mesh.userData.parts.body.material.color.getHex(), looks.librarian.body,
    '读档后的外观颜色必须与生成时一致');
});

/* ================= E3 废弃矿工营地 ================= */
test('E3 营地布局确定：地面帐篷/工作台/箱子、5 级楼梯、7×7 地下房间与两个箱子', () => {
  const a = campLayout(), b = campLayout();
  assert.deepEqual(a, b, '同一份布局函数必须完全确定');
  const at = (x, y, z) => a.find(c => c.x === x && c.y === y && c.z === z);
  assert.ok(at(-2, 1, 0) && at(-2, 1, 0).id === B.CHEST, '营地地面应有箱子');
  assert.ok(at(2, 1, 0) && at(2, 1, 0).id === B.CRAFTING_TABLE, '营地地面应有工作台');
  assert.ok(at(0, 3, -2) && at(0, 3, -2).id === B.PLANKS, '帐篷顶应用木板');
  for (let i = 0; i <= 4; i++) {
    const step = at(0, -i, 3 + i);
    assert.ok(step && step.id === B.COBBLESTONE, '第 ' + i + ' 级楼梯应是圆石：' + JSON.stringify(step));
  }
  let floor = 0, air = 0, torches = 0;
  const chestKeys = new Set(CAMP_CHESTS.map(c => c.x + ',' + c.y + ',' + c.z));
  let roomChests = 0;
  for (let z = 8; z <= 14; z++) for (let x = -3; x <= 3; x++) {
    assert.equal(at(x, -5, z).id, B.COBBLESTONE, '房间地面应完整');
    floor++;
    for (let y = -4; y <= -2; y++) {
      const c = at(x, y, z);
      if (chestKeys.has(x + ',' + y + ',' + z)) {
        assert.equal(c.id, B.CHEST, '箱子位置应是箱子');
        roomChests++;
        continue;
      }
      assert.ok(c && c.id === B.AIR, '房间内部应为空气：' + x + ',' + y + ',' + z);
      air++;
    }
    assert.ok(at(x, -1, z) && at(x, -1, z).id === B.STONE_BRICKS, '房间顶应封闭');
  }
  assert.equal(floor, 49, '房间地面应 7×7');
  assert.equal(air, 7 * 7 * 3 - roomChests, '房间内部应 7×7×3（箱子占的格子除外）');
  for (const c of a) if (c.id === B.TORCH || c.id === B.GLOWSTONE || c.id === B.PUMPKIN_LAMP) {
    if (c.z >= 8 && c.z <= 14 && c.y <= -2) torches++;
  }
  assert.equal(torches, 0, '地下房间必须保持黑暗（无光源）');
  assert.equal(at(2, -4, 10).id, B.CHEST, '地下应有第二个箱子');
  assert.ok(CAMP_CHESTS.every(c => at(c.x, c.y, c.z) && at(c.x, c.y, c.z).id === B.CHEST),
    'CAMP_CHESTS 与布局中的箱子位置必须一致');
  const ids = new Set(a.map(c => c.id));
  for (const id of ids) assert.ok(id === B.AIR || !!BLOCKS[id], '布局只能使用现有方块 id：' + id);
});

test('E3 营地选址：24~48 格、干燥、避开村庄，失败返回 null', () => {
  const flat = () => 40;
  const spawn = { x: 0, z: 0 };
  const a = chooseCampSite(flat, spawn, 32, 64, { x: 14, z: 0 });
  assert.ok(a, '平地应能找到营地');
  const dist = Math.hypot(a.x, a.z);
  assert.ok(dist >= 24 && dist <= 48, '营地距离出生点应在 24~48：' + dist);
  assert.ok(a.y > 32 && a.spread === 0, '营地地面应高于海且平坦：' + JSON.stringify(a));
  assert.deepEqual(chooseCampSite(flat, spawn, 32, 64, { x: 14, z: 0 }), a, '同一地形与村庄必须选同一点');
  /* 村庄压在首选候选上 → 必须换一个，且不能与村庄的延伸范围重叠 */
  const shifted = chooseCampSite(flat, spawn, 32, 64, { x: 28, z: 0 });
  assert.ok(shifted && !(shifted.x === 28 && shifted.z === 0), '不能把营地叠在村庄上：' + JSON.stringify(shifted));
  assert.ok(Math.hypot(shifted.x - 28, shifted.z - 0) >= CAMP_RADIUS + CAMP_MAX_EXTENT + 4, '必须避开村庄延伸范围');
  /* 水面（低于海平面）→ 拒绝 */
  assert.equal(chooseCampSite(() => 30, spawn, 32, 64, { x: 14, z: 0 }), null);
  /* 起伏过大 → 拒绝 */
  assert.equal(chooseCampSite((x) => 40 + (x % 2 ? 9 : 0), spawn, 32, 64, { x: 14, z: 0 }), null);
  assert.equal(chooseCampSite(null, spawn, 32, 64, null), null);
});

test('E3 固定战利品：同种子同站点完全一致，钻石由确定性哈希决定，物品都是现有物品', () => {
  const site = { x: 28, z: 0 };
  const a = campLoot('acceptance-2026', site), b = campLoot('acceptance-2026', site);
  assert.deepEqual(a, b, '同一种子/站点必须给同一份战利品');
  assert.equal(a.diamond, campDiamondRoll('acceptance-2026', site));
  for (const it of [...a.surface, ...a.underground]) {
    assert.ok(ITEMS[it.item], '战利品必须是现有物品：' + it.item);
    assert.ok(it.count > 0);
  }
  assert.ok(a.surface.some(i => i.item === 'bread') && a.surface.some(i => i.item === 'arrow'));
  assert.ok(a.underground.some(i => i.item === 'iron_ingot') && a.underground.some(i => i.item === 'emerald'));
  let withD = 0, withoutD = 0;
  for (let i = 0; i < 300; i++) {
    const l = campLoot('seed-' + i, { x: 28 + i, z: -i });
    if (l.diamond) { withD++; assert.ok(l.underground.some(x => x.item === 'diamond')); }
    else { withoutD++; assert.ok(!l.underground.some(x => x.item === 'diamond')); }
  }
  assert.ok(withD > 0 && withoutD > 0, '钻石必须是「小概率」而不是必定/必定没有：' + withD + '/' + withoutD);
});

/* ================= E4 雨天耕地与作物 ================= */
test('E4 雨天规则：只有雨会淋湿/加速，雪不算；头顶实心方块算遮蔽；倍率常数 1.5', async () => {
  assert.equal(isRainWeather('rain'), true);
  assert.equal(isRainWeather('snow'), false);
  assert.equal(isRainWeather('clear'), false);
  assert.equal(RAIN_GROWTH_MULTIPLIER, 1.5);
  assert.equal(rainWetsFarmland('rain', true), true);
  assert.equal(rainWetsFarmland('rain', false), false);
  assert.equal(rainWetsFarmland('snow', true), false);
  assert.equal(cropRainMultiplier('rain', true), 1.5);
  assert.equal(cropRainMultiplier('rain', false), 1);
  assert.equal(cropRainMultiplier('snow', true), 1);
  assert.equal(cropRainMultiplier('clear', true), 1);

  const solid = (x, y, z) => y === 50 && x === 3 && z === 4;
  assert.equal(isSkyExposed(solid, 3, 46, 4, 64), false, '头顶 50 格有实心方块 → 遮蔽');
  assert.equal(isSkyExposed(solid, 3, 50, 4, 64), true, '方块自身以上没有遮挡 → 露天');
  assert.equal(isSkyExposed(solid, 9, 46, 9, 64), true, '别的位置没有屋顶 → 露天');
  assert.equal(isSkyExposed(null, 3, 46, 4, 64), false, '采样函数缺失时保守返回 false');

  /* 天气存档格式不能被 E4 改变：普通雨仍只有 t/left/el/inten 四个键 */
  const { Weather } = await import('../renderer/js/core/weather.js');
  const w = new Weather(() => 0.5);
  w.set('rain', 60);
  assert.deepEqual(Object.keys(w.serialize()).sort(), ['el', 'inten', 'left', 't']);
  w.setStorm(true);
  assert.deepEqual(Object.keys(w.serialize()).sort(), ['el', 'inten', 'left', 's', 't'],
    '雷暴仍只在 rain 上加 s，不新增字段');
});

/* ================= R1/R2 探索地点 ================= */
test('R1 地点注册：同种子同地区固定，不同种子/地区会变化，候选排除出生点/村庄/旧地点', () => {
  const a = regionInfo('seed-A', 2, -3), b = regionInfo('seed-A', 2, -3);
  assert.deepEqual(a, b, '同种子同地区必须完全确定');
  assert.ok(LANDMARK_TYPE_IDS.includes(a.type));
  assert.ok(a.variant >= 0 && a.variant <= 2);
  const infos = new Set();
  for (let i = 0; i < 30; i++) infos.add(JSON.stringify(regionInfo('seed-' + i, i % 5, -i)));
  assert.ok(infos.size > 1, '不同种子不能总是同一地点');
  assert.equal(nearbyRegions(0, 0).length, 9);
  assert.equal(new Set(nearbyRegions(0, 0).map(r => r.rx + ',' + r.rz)).size, 9);

  const sample = () => 40;
  const c = candidateFor('seed-A', 0, 0, sample, { spawn: { x: 0, z: 0 }, seaLevel: 32, worldH: 64 });
  assert.ok(c, '平地应有候选：' + JSON.stringify(c));
  assert.ok(c.x >= 34 && c.distSpawn === undefined, '候选必须离出生点至少 34');
  assert.ok(c.minH >= 34 && c.spread <= 3);
  assert.deepEqual(candidateFor('seed-A', 0, 0, sample, { spawn: { x: 0, z: 0 }, seaLevel: 32, worldH: 64 }), c);
  assert.equal(candidateFor('seed-A', 0, 0, sample, { spawn: { x: 0, z: 0 }, seaLevel: 32, worldH: 64, village: { x: c.x, z: c.z } }), null,
    '村庄压住候选时必须拒绝');
  assert.equal(candidateFor('seed-A', 0, 0, sample, { spawn: { x: 0, z: 0 }, seaLevel: 32, worldH: 64, landmarks: [{ x: c.x, z: c.z }] }), null,
    '已建地点太近时必须拒绝');
  assert.equal(candidateFor('seed-A', 0, 0, () => 30, { spawn: { x: 0, z: 0 }, seaLevel: 32, worldH: 64 }), null,
    '海面/低地必须拒绝');
  assert.equal(candidateFor('seed-A', 0, 0, (x) => 40 + (x % 2 ? 8 : 0), { spawn: { x: 0, z: 0 }, seaLevel: 32, worldH: 64 }), null,
    '起伏过大必须拒绝');
});

test('R2 三类布局：各三种微变化、确定、只使用现有方块、箱子坐标在布局内', () => {
  for (const type of LANDMARK_TYPE_IDS) {
    const seen = [];
    for (let v = 0; v < 3; v++) {
      const a = landmarkLayout(type, v), b = landmarkLayout(type, v);
      assert.deepEqual(a, b, type + ' v' + v + ' 必须确定');
      assert.ok(a.cells.length > 20 && a.cells.length < 400, type + ' 布局规模异常：' + a.cells.length);
      assert.ok(a.chests.length >= 1 && a.chests.length <= 2, type + ' 应给 1~2 个箱子');
      for (const ch of a.chests) {
        const cell = a.cells.find(c => c.x === ch.x && c.y === ch.y && c.z === ch.z);
        assert.ok(cell && cell.id === B.CHEST, type + ' 箱子必须在 layout 里登记：' + JSON.stringify(ch));
      }
      for (const cell of a.cells) {
        assert.ok(cell.id === B.AIR || !!BLOCKS[cell.id], type + ' 使用了不存在的方块 id：' + cell.id);
        assert.ok(cell.y > -4 && cell.y < 12, type + ' 布局超出竖直边界：' + cell.y);
      }
      seen.push(JSON.stringify(a.cells));
    }
    assert.equal(new Set(seen).size, 3, type + ' 三种变化不能完全相同');
  }
  /* 三类模板本身不同 */
  const sigs = LANDMARK_TYPE_IDS.map(t => JSON.stringify(landmarkLayout(t, 0).cells));
  assert.equal(new Set(sigs).size, 3, '三类模板不能互相复制');
});

test('R2 固定战利品：同种子/地点一致、包含类别物品、只使用现有物品', () => {
  for (const type of LANDMARK_TYPE_IDS) {
    const lm = { id: '0,0', type, variant: 0 };
    const a = landmarkLoot('seed-A', lm), b = landmarkLoot('seed-A', lm);
    assert.deepEqual(a, b, type + ' 同种子必须同战利品');
    assert.ok(a.length >= 3, type + ' 箱子不能为空');
    for (const it of a) {
      assert.ok(ITEMS[it.item], type + ' 战利品必须是现有物品：' + it.item);
      assert.ok(it.count > 0);
    }
    assert.ok(a.some(it => ['bread', 'iron_ingot', 'emerald'].includes(it.item)), type + ' 至少要有一件有用物资');
  }
});

/* ================= R3：发现提示、地图标记与探索者成就 ================= */

test('R3 地图标记：只标已发现且所在区块已探索，像素坐标按 5×5 网格换算', async () => {
  const { mapLandmarkMarkers, MAP_BLOCK_PX, MAP_CHUNK } = await import('../renderer/js/core/map.js');
  const m = { cx: 2, cz: -1, seen: { '2,-1': '1'.repeat(256), '3,-1': '1'.repeat(256), '1,-1': '1'.repeat(256) } };
  const lms = [
    { id: '0,-1', type: 'ruin', name: '荒野废墟', x: 24, z: -12, discovered: 1 },      // 区块 1,-1 已探索
    { id: '0,0', type: 'tower', name: '废弃哨塔', x: 40, z: 12, discovered: 1 },       // 区块 2,0 未探索 → 不画
    { id: '1,0', type: 'outpost', name: '荒废前哨', x: 90, z: 20, discovered: 0 },     // 未发现 → 不画
    { id: '2,0', type: 'ruin', name: '荒野废墟', x: 300, z: 200, discovered: 1 }       // 区块 18,12 未探索 → 不画
  ];
  const marks = mapLandmarkMarkers(m, lms);
  assert.equal(marks.length, 1, '只有已发现且所在区块已探索的才会变成标记');
  const k = marks[0];
  assert.equal(k.id, '0,-1');
  assert.equal(k.chunk, '1,-1');
  /* 与出生点红叉/玩家箭头同一套换算：((坐标 + 0.5) - 左上区块 * 16) * PX */
  const oCX = m.cx - 2, oCZ = m.cz - 2;
  assert.equal(k.mx, Math.round((k.x + 0.5 - oCX * MAP_CHUNK) * MAP_BLOCK_PX * 10) / 10);
  assert.equal(k.my, Math.round((k.z + 0.5 - oCZ * MAP_CHUNK) * MAP_BLOCK_PX * 10) / 10);
  assert.ok(k.mx >= 0 && k.mx <= 400 && k.my >= 0 && k.my <= 400, '标记必须落在画布内');
  /* 网格边界：同一区块 0 号格与 15 号格相差 15*PX */
  const edge = mapLandmarkMarkers({ cx: 2, cz: -1, seen: { '2,-1': '1'.repeat(256) } },
    [{ id: 'a', x: 32, z: -16, discovered: 1 }, { id: 'b', x: 47, z: -16, discovered: 1 }]);
  assert.equal(edge.length, 2, '同一区块两端都要能画出来');
  assert.equal(Math.round(edge[1].mx - edge[0].mx), (47 - 32) * MAP_BLOCK_PX, '横向每格 5px');
  /* 空输入安全 */
  assert.deepEqual(mapLandmarkMarkers(m, []), []);
  assert.deepEqual(mapLandmarkMarkers(null, lms), [], '没有地图数据时不报错');
});

test('R3 探索者成就：额外成就不改基础 8 条 list/count，但随存档序列化', async () => {
  const { Achievements, ACHIEVEMENTS, EXTRA_ACHIEVEMENTS } = await import('../renderer/js/core/achievements.js');
  assert.equal(ACHIEVEMENTS.length, 8, '基础成就仍是 8 个');
  assert.deepEqual(EXTRA_ACHIEVEMENTS.map(a => a.id), ['explorer'], '额外成就只有探索者');
  for (const a of EXTRA_ACHIEVEMENTS) assert.ok(a.name && a.desc && a.toast, a.id + ' 定义要齐全');

  const a = new Achievements();
  assert.equal(a.count(), 0);
  a.unlock('wood');
  const first = a.unlock('explorer');
  assert.ok(first && first.id === 'explorer', '第一次解锁返回定义（用于弹 toast）');
  assert.equal(a.unlock('explorer'), null, '重复解锁必须返回 null，不重复弹');
  assert.equal(a.count(), 1, '探索者不计入「成就 x/8」');
  assert.equal(a.extraCount(), 1);
  assert.equal(a.list().length, 8, '基础列表长度不变');
  assert.equal(a.list().some(x => x.id === 'explorer'), false, '探索者不混进基础列表');
  assert.equal(a.extras().length, 1);
  assert.equal(a.extras()[0].unlocked, true);

  const saved = JSON.parse(JSON.stringify(a.serialize()));
  assert.deepEqual(saved, ['wood', 'explorer'], '额外成就必须进存档');
  const b = Achievements.deserialize(saved);
  assert.equal(b.count(), 1, '读档后基础计数仍是 1');
  assert.equal(b.extraCount(), 1);
  assert.equal(b.has('explorer'), true);
  assert.equal(b.unlock('explorer'), null, '读档后不再重复解锁');
  /* 旧档没有这个 id：不会凭空解锁 */
  assert.equal(new Achievements(['wood', 'cobblestone']).has('explorer'), false);
  assert.equal(Achievements.deserialize(['explorer', 'nope']).count(), 0, '未知 id 安全忽略');
});

test('R4 站点不压洞穴口：caveAt 命中就拒绝该站点，不传 caveAt 时行为与旧版一致', () => {
  const flat = () => 40;
  const opts = {
    spawn: { x: 0, z: 0 }, village: null, camp: null, landmarks: [],
    seaLevel: 26, worldH: 64, isBlocked: () => false
  };
  const base = candidateFor(20261104, 3, -2, flat, opts);
  assert.ok(base, '平坦地面本来就能出候选');
  /* 完全没有洞穴：加了 caveAt 也照样通过，且站点坐标不变 */
  const noCave = candidateFor(20261104, 3, -2, flat, Object.assign({}, opts, { caveAt: () => false }));
  assert.ok(noCave, '没有洞穴时不该把站点拒掉');
  assert.equal(noCave.x, base.x);
  assert.equal(noCave.z, base.z);
  assert.equal(noCave.type, base.type);
  /* 足迹里只有一格地表下方是洞穴 → 整平会封死洞穴口 → 整个站点不要 */
  let hits = 0;
  const oneCave = candidateFor(20261104, 3, -2, flat, Object.assign({}, opts, {
    caveAt: (x, y, z) => {
      if (y === 39 && x === base.x + 2 && z === base.z) { hits++; return true; }
      return false;
    }
  }));
  assert.equal(oneCave, null, '有一格压在洞穴上就必须拒绝站点');
  assert.equal(hits, 1, '确实检查到了那一格（不是提前返回造成的假绿）');
  /* 洞穴只在更深处（下方 3 格）不影响：整平只碰地表 */
  const deepOnly = candidateFor(20261104, 3, -2, flat, Object.assign({}, opts, {
    caveAt: (x, y, z) => y === 37
  }));
  assert.ok(deepOnly, '地表下方两格以外是洞穴时仍然可以建');
  assert.equal(deepOnly.x, base.x);
  /* 每个类型都要走这条规则（半径不同也不能漏） */
  for (let rz = -6; rz <= 6; rz++) {
    const c = candidateFor(20261104, 2, rz, flat, opts);
    if (!c) continue;
    const blocked = candidateFor(20261104, 2, rz, flat, Object.assign({}, opts, { caveAt: () => true }));
    assert.equal(blocked, null, c.type + ' 站点在洞穴上时必须被拒（region 2,' + rz + '）');
  }
});

/* ================= Q1：目标链与反馈（独立状态，不动成就与配方） ================= */
test('Q1 目标链定义：6 步线性顺序、id 唯一、每步都有提示与达成证据', () => {
  assert.equal(QUESTS.length, 6);
  assert.deepEqual([...QUEST_IDS], ['log', 'table', 'wood_pick', 'cobble', 'furnace', 'iron']);
  assert.equal(new Set(QUEST_IDS).size, 6);
  for (let i = 0; i < QUESTS.length; i++) {
    const q = QUESTS[i];
    assert.equal(q.order, i + 1, q.id + ' order 必须连续');
    assert.ok(q.name && q.hint, q.id + ' 必须有名称与短提示');
    assert.ok(q.items.length > 0 || q.achievements.length > 0, q.id + ' 必须有达成证据');
    assert.equal(QUEST_BY_ID[q.id], q);
  }
});

test('Q1 空背包从「砍树」开始，第一条提示只出现一次', () => {
  const c = new QuestChain();
  assert.equal(c.current.id, 'log');
  const r1 = c.sync({ items: {}, achievementIds: [] });
  assert.equal(r1.hint.id, 'log');
  assert.equal(r1.current, 'log');
  const r2 = c.sync({ items: {}, achievementIds: [] });
  assert.equal(r2.hint, null, '同一目标不能重复提示');
  assert.deepEqual(r2.completedNow, []);
  assert.deepEqual(c.hintLog, ['log']);
});

test('Q1 逐步推进六步：current 与 completedNow 按链前进', () => {
  const c = new QuestChain();
  c.sync({ items: {}, achievementIds: [] });
  const adds = ['oak_log', 'crafting_table', 'pickaxe_wood', 'cobblestone', 'furnace', 'iron_ingot'];
  const expect = ['log', 'table', 'wood_pick', 'cobble', 'furnace', 'iron'];
  const next = ['table', 'wood_pick', 'cobble', 'furnace', 'iron', null];
  const bag = {};
  for (let i = 0; i < adds.length; i++) {
    bag[adds[i]] = 1;
    const r = c.sync({ items: { ...bag }, achievementIds: [] });
    assert.deepEqual(r.completedNow, [expect[i]], '第 ' + (i + 1) + ' 步只应新完成 ' + expect[i]);
    assert.equal(r.current, next[i], '第 ' + (i + 1) + ' 步的当前目标');
    assert.equal(r.hint ? r.hint.id : null, next[i], '第 ' + (i + 1) + ' 步提示的是下一目标');
  }
  assert.equal(c.current, null, '六步走完没有当前目标');
  assert.deepEqual([...c.completed], expect);
});

test('Q1 线性补全与单调性：拿到木镐即认定前三步完成，清空背包也不回退', () => {
  const c = new QuestChain();
  const r = c.sync({ items: { pickaxe_wood: 1, planks: 8 }, achievementIds: [] }, true);
  assert.deepEqual(r.completedNow, ['log', 'table', 'wood_pick']);
  assert.equal(r.current, 'cobble');
  const empty = c.sync({ items: {}, achievementIds: [] }, false);
  assert.deepEqual(empty.completedNow, []);
  assert.equal(empty.current, 'cobble', '物品用完 / 工作台放到地上不能让进度倒退');
  assert.deepEqual([...c.completed], ['log', 'table', 'wood_pick']);
});

test('Q1 旧档缺 quests：静默推断当前进度，不弹任何已完成提示', () => {
  const c = QuestChain.deserialize(undefined);
  assert.equal(c.current.id, 'log');
  const snap = { items: { planks: 8, pickaxe_wood: 1 }, achievementIds: ['wood', 'crafting_table'] };
  const r = c.sync(snap, true);
  assert.equal(r.hint, null, '读档不弹提示');
  assert.deepEqual(r.completedNow, ['log', 'table', 'wood_pick']);
  assert.equal(r.current, 'cobble');
  assert.deepEqual(c.hintLog, [], '读档不能写展示记录');
  assert.ok(c.shown.has('cobble'), '当前目标也要标成已展示，避免读档后补弹');
  const again = c.sync(snap, false);
  assert.equal(again.hint, null, '读档后正常游玩也不能补弹当前目标');
});

test('Q1 序列化往返与坏数据安全回落', () => {
  const c = new QuestChain();
  c.sync({ items: { oak_log: 1 }, achievementIds: ['wood'] }, false);
  c.dismiss();
  const back = QuestChain.deserialize(JSON.parse(JSON.stringify(c.serialize())));
  assert.deepEqual([...back.completed], [...c.completed]);
  assert.deepEqual([...back.shown], [...c.shown]);
  assert.deepEqual(back.hintLog, c.hintLog);
  assert.equal(back.dismissed, true);
  for (const bad of [null, 0, 'x', { completed: 'nope', shown: [{}], hintLog: [1, 'unknown'], dismissed: 'yes' }]) {
    const q = QuestChain.deserialize(bad);
    assert.equal(q.current.id, 'log', '坏数据必须回落到第一步');
    assert.equal(q.hintLog.length, 0);
    assert.equal(q.completed.size, 0);
  }
});

test('Q1 提示可关闭也可重新展开，状态随存档保留', () => {
  const c = new QuestChain();
  c.sync({ items: {}, achievementIds: [] });
  assert.equal(c.dismissed, false);
  c.dismiss();
  assert.equal(c.serialize().dismissed, true);
  c.reopen();
  assert.equal(c.serialize().dismissed, false);
  assert.equal(QuestChain.deserialize(c.serialize()).dismissed, false);
});

test('Q1 下一步建议：当前目标配方优先、可做性其次、有上限且不改原数组', () => {
  const fake = [
    { id: 'log_to_planks', result: { item: 'planks', count: 4 } },
    { id: 'crafting_table', result: { item: 'crafting_table', count: 1 } },
    { id: 'pickaxe_wood', result: { item: 'pickaxe_wood', count: 1 } },
    { id: 'furnace', result: { item: 'furnace', count: 1 } },
    { id: 'junk', result: { item: 'junk', count: 1 } }
  ];
  const before = JSON.stringify(fake);
  const canMake = (r) => r.id === 'crafting_table' || r.id === 'junk';
  const picks = suggestRecipes(fake, canMake, 'log', 3);
  assert.equal(picks.length, 3);
  assert.equal(picks[0].recipe.id, 'log_to_planks', '当前目标配方永远第一');
  assert.equal(picks[0].reason, 'current');
  assert.ok(picks.slice(1).every(p => p.canMake), '其余位置可做的优先');
  assert.equal(JSON.stringify(fake), before, '纯函数不能改传入数组');
  const none = suggestRecipes(fake, () => false, 'iron', 2);
  assert.equal(none.length, 2);
  assert.ok(none.every(p => !p.canMake && p.reason === 'prepare'));
  assert.equal(suggestRecipes([], canMake, 'log', 3).length, 0);
  const real = suggestRecipes(RECIPES, () => true, 'wood_pick', 3);
  assert.ok(real.some(p => p.recipe.id === 'pickaxe_wood'), '真实配方表里能建议木镐');
});

test('Q1 守卫：8 个基础成就的 ids/list/count 与「无前置」语义一字未改', () => {
  assert.equal(ACHIEVEMENTS.length, 8);
  assert.deepEqual(ACHIEVEMENT_IDS,
    ['wood', 'crafting_table', 'cobblestone', 'furnace', 'iron_ingot', 'armor', 'shield', 'diamond']);
  const a = new Achievements(['diamond']);
  assert.equal(a.count(), 1, '成就没有前置：直接解锁钻石仍算 1 个');
  assert.equal(a.list().length, 8);
  assert.deepEqual(inferAchievements({ items: { diamond: 1 } }), ['diamond']);
  const c = new QuestChain();
  c.sync({ items: { iron_ingot: 1 }, achievementIds: [] }, false);
  assert.equal(a.count(), 1, '目标链推进不能碰成就状态');
  assert.equal(new Achievements().count(), 0);
  assert.ok(!('set' in c), 'QuestChain 不复用 Achievements 的 set 字段');
});

test('Q1 守卫：不新增方块/物品，不改任何配方数值与产物', () => {
  const digest = () => RECIPES.map(r => r.id + ':' + r.result.item + ':' + r.result.count).join('|');
  const before = digest();
  const c = new QuestChain();
  c.sync({ items: {}, achievementIds: [] }, false);
  suggestRecipes(RECIPES, () => true, 'log', 3);
  assert.equal(digest(), before, '目标链与建议排序不得改写配方表');
  assert.equal(RECIPES.find(r => r.id === 'log_to_planks').result.count, 4);
  assert.equal(RECIPES.find(r => r.id === 'pickaxe_wood').result.item, 'pickaxe_wood');
});

/* ================= FL：创造飞行随视角 ================= */
function flyTestWorld(seed) {
  const w = new VoxelWorld(seed);
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const x = 8, z = 8;
  const gy = Math.min(WORLD_H - 20, w.topSolidY(x, z) + 6);
  // 清出一块空域，避免自然地形干扰飞行方向判定
  for (let dy = -3; dy <= 12; dy++)
    for (let dz = -10; dz <= 10; dz++)
      for (let dx = -10; dx <= 10; dx++)
        w.setBlock(x + dx, gy + dy, z + dz, AIR, 0);
  return { w, x, z, gy };
}

const FLY_IDLE = { keyW: false, keyS: false, keyA: false, keyD: false, jump: false, sprint: false, sneak: false };

test('FL 创造飞行：平视水平飞、抬头上升、低头下降，位移贴合视线', () => {
  const { w, x, z, gy } = flyTestWorld(424242);
  const fwd = Object.assign({}, FLY_IDLE, { keyW: true });
  const fly = (pitch, input, steps = 40) => {
    const c = new PlayerController(w);
    c.creative = true;
    c.flying = true;
    c.spawnAt(x + 0.5, gy + 2, z + 0.5);
    c.yaw = 0;
    c.pitch = pitch;
    const p0 = { ...c.pos };
    for (let i = 0; i < steps; i++) c.update(0.02, input);
    return { dx: c.pos.x - p0.x, dy: c.pos.y - p0.y, dz: c.pos.z - p0.z };
  };

  const flat = fly(0, fwd);
  assert.ok(Math.abs(flat.dy) < 0.25, '平视 W 必须仍水平飞，实得 dy=' + flat.dy.toFixed(3));
  assert.ok(flat.dz < -2, '平视 W 应朝 -Z 前进，实得 dz=' + flat.dz.toFixed(3));

  const up = fly(0.7, fwd);
  assert.ok(up.dy > 1, '抬头按 W 必须上升，实得 dy=' + up.dy.toFixed(3));
  assert.ok(up.dz < -1, '抬头按 W 仍要向前，实得 dz=' + up.dz.toFixed(3));

  const down = fly(-0.7, fwd);
  assert.ok(down.dy < -1, '低头按 W 必须下降，实得 dy=' + down.dy.toFixed(3));

  // yaw=0、pitch=0.7 时视线=(0, sin, -cos)；位移方向应与它贴合
  const len = Math.hypot(up.dx, up.dy, up.dz);
  const cosSim = (up.dy * Math.sin(0.7) + (-up.dz) * Math.cos(0.7)) / len;
  assert.ok(cosSim > 0.9, '飞行方向应与视线一致，实得余弦=' + cosSim.toFixed(3));
});

test('FL 创造飞行：Space/Shift 仍垂直升降、A/D 仍水平横移、组合输入不超速', () => {
  const { w, x, z, gy } = flyTestWorld(424243);
  const run = (input) => {
    const c = new PlayerController(w);
    c.creative = true;
    c.flying = true;
    c.spawnAt(x + 0.5, gy + 2, z + 0.5);
    c.yaw = 0; c.pitch = 0;
    const p0 = { ...c.pos };
    for (let i = 0; i < 30; i++) c.update(0.02, input);
    return { dx: c.pos.x - p0.x, dy: c.pos.y - p0.y, dz: c.pos.z - p0.z, v: c.vel };
  };
  assert.ok(run(Object.assign({}, FLY_IDLE, { jump: true })).dy > 1, '空格仍要垂直上升');
  assert.ok(run(Object.assign({}, FLY_IDLE, { sneak: true })).dy < -1, 'Shift 仍要垂直下降');
  const right = run(Object.assign({}, FLY_IDLE, { keyD: true }));
  assert.ok(right.dx > 1 && Math.abs(right.dy) < 0.25,
    'A/D 仍是水平横移，实得 dx=' + right.dx.toFixed(3) + ' dy=' + right.dy.toFixed(3));
  const diag = run(Object.assign({}, FLY_IDLE, { keyW: true, keyD: true, jump: true }));
  const sp = Math.hypot(diag.v.x, diag.v.y, diag.v.z);
  assert.ok(sp <= PHYS.flySpeed + 0.5,
    '组合输入不许超速，实得速度=' + sp.toFixed(2) + ' 上限=' + PHYS.flySpeed);
});

test('BUG.1 双击 W 冲刺判定：320ms 内两次才算，首次 / 超时 / 时间倒退都不算', async () => {
  const { isDoubleTap } = await import('../renderer/js/player/input.js');
  assert.equal(isDoubleTap(0, 100), false, '首次按下不能算双击');
  assert.equal(isDoubleTap(100, 300), true, '200ms 内的第二次应算双击');
  assert.equal(isDoubleTap(100, 100), true, '同一毫秒也算（窗口下界含 0）');
  assert.equal(isDoubleTap(100, 420), false, '超过 320ms 不算');
  assert.equal(isDoubleTap(500, 400), false, '时间倒退不算');
  assert.equal(isDoubleTap(100, 200, 50), false, '自定义窗口生效');
});

test('FL 守卫：生存模式移动完全不受 pitch 影响（非飞行分支一字未动）', () => {
  const { w, x, z, gy } = flyTestWorld(424244);
  const fwd = Object.assign({}, FLY_IDLE, { keyW: true });
  const walk = (pitch) => {
    const c = new PlayerController(w);
    c.spawnAt(x + 0.5, gy + 2, z + 0.5);
    c.yaw = 0; c.pitch = pitch;
    const p0 = { ...c.pos };
    for (let i = 0; i < 20; i++) c.update(0.02, fwd);
    return { dy: c.pos.y - p0.y, dz: c.pos.z - p0.z };
  };
  const a = walk(0), b = walk(0.7);
  assert.ok(Math.abs(a.dy - b.dy) < 0.0001, '生存模式 pitch 不得改变垂直运动');
  assert.ok(Math.abs(a.dz - b.dz) < 0.0001, '生存模式 pitch 不得改变水平运动');
});

/* ================= A：生物动作与反馈（姿态） ================= */

test('A1 computePose 是纯函数：同输入同输出、dt 不参与计算、不改动实体、不产出朝向', () => {
  const m = { type: 'zombie', def: { hostile: true }, animAttack: MOB_ATTACK_POSE_SECONDS * 0.5, hurtT: 0, age: 3.2, moving: true, animIdle: 1.1 };
  const snapshot = JSON.stringify(m);
  const a = computePose(m, 0.016);
  const b = computePose(m, 0.5);
  const c = computePose(m, 0.016);
  assert.deepEqual(a, b, '姿态只读当前状态：dt 若参与扣减会与 update 的衰减重复，攻击动画会提前一半结束');
  assert.deepEqual(a, c, '同输入必须同输出');
  assert.equal(JSON.stringify(m), snapshot, 'computePose 不许改动实体字段');
  for (const k of ['arm0', 'arm1', 'headX', 'headY', 'bodyScaleY', 'tiltZ']) {
    assert.equal(typeof a[k], 'number', k + ' 必须是数字');
    assert.ok(Number.isFinite(a[k]), k + ' 出现 NaN/Inf');
  }
  assert.ok(!('yaw' in a) && !('rotY' in a) && !('rotationY' in a) && !('rotation' in a), '姿态不得输出朝向（D3 钉死 rotation.y 只跟 yaw）');
  /* 极端输入也不能溢出：动画字段被外部写成脏值时最多就是幅度封顶 */
  const wild = computePose({ def: { hostile: true }, animAttack: 999, hurtT: 99, age: 1e6, moving: true, animIdle: 7.5 }, 0.016);
  assert.ok(Math.abs(wild.arm0) <= MOB_POSE_LIMITS.arm + 1e-9, 'arm0 越界：' + wild.arm0);
  assert.ok(Math.abs(wild.headX) <= MOB_POSE_LIMITS.head + 1e-9, 'headX 越界：' + wild.headX);
  assert.ok(Math.abs(wild.headY) <= MOB_POSE_LIMITS.headYaw + 1e-9, 'headY 越界：' + wild.headY);
  assert.ok(Math.abs(wild.tiltZ) <= MOB_POSE_LIMITS.tilt + 1e-9, 'tiltZ 越界：' + wild.tiltZ);
  assert.ok(Math.abs(wild.bodyScaleY - 1) <= MOB_POSE_LIMITS.bodyScale + 1e-9, '呼吸幅度越界：' + wild.bodyScaleY);
  /* 没有任何动画字段也不能炸（旧存档读回来的生物就是这种状态） */
  const bare = computePose({ def: { hostile: false } }, 0.016);
  assert.equal(bare.atk, 0); assert.equal(bare.hurt, 0); assert.equal(bare.attackT, 0);
  assert.ok(Number.isFinite(bare.arm0) && Number.isFinite(bare.bodyScaleY), '缺字段时也要给出安全值');
});

test('A2 攻击峰值压手、受击仰头侧倾缩身，且 hitMob 真实打断攻击姿态', () => {
  const { mm, cx0, cz0, fy } = blastCtx();
  const z = mm.spawn('zombie', cx0 + 0.5, fy + 1, cz0 + 0.5);
  assert.ok(z, '生成僵尸失败');
  z.animAttack = 0; z.hurtT = 0;
  const base = computePose(z, 0.016);
  assert.ok(Math.abs(base.arm0 + 1.4) < 1e-9, '敌怪待机手臂必须还是 -1.4：' + base.arm0);
  assert.equal(base.atk, 0);
  /* 峰值：animAttack 剩一半 → sin(π/2) = 1 */
  z.animAttack = MOB_ATTACK_POSE_SECONDS / 2;
  const peak = computePose(z, 0.016);
  assert.ok(peak.arm0 < base.arm0 - 1.0, '攻击峰值手臂必须明显低于基线：' + peak.arm0 + ' vs ' + base.arm0);
  assert.ok(peak.arm1 < base.arm1 - 1.0, '双臂一起挥：' + peak.arm1);
  assert.ok(peak.atkFront > 0.8, '无手臂生物的前扑通道要有值：' + peak.atkFront);
  /* 收尾：animAttack 归零后回到基线，不留残余姿态 */
  z.animAttack = 0.0001;
  const tail = computePose(z, 0.016);
  assert.ok(tail.arm0 < base.arm0 + 0.01 && tail.arm0 > base.arm0 - 0.05, '快结束时要回到基线附近：' + tail.arm0);
  /* 受击：仰头 + 侧倾 + 缩身 */
  z.animAttack = 0; z.hurtT = 0.32;
  const hurt = computePose(z, 0.016);
  assert.ok(hurt.headX > 0.3, '受击要仰头：' + hurt.headX);
  assert.ok(Math.abs(hurt.tiltZ) > 0.1, '受击要侧倾：' + hurt.tiltZ);
  assert.ok(hurt.bodyScaleY < 1, '受击要缩身：' + hurt.bodyScaleY);
  assert.equal(Math.abs(hurt.headY), 0, '受击时不叠加张望，避免头部乱抖');
  /* 真实事件优先级：hitMob 必须把攻击姿态清零（受击压过攻击） */
  z.animAttack = MOB_ATTACK_POSE_SECONDS; z.hurtT = 0;
  mm.hitMob(z, 1, null, { quiet: true });
  assert.equal(z.animAttack, 0, 'hitMob 必须打断攻击姿态');
  assert.equal(z.hurtT, 0.32, '受击计时器照常复用 hurtT');
  const afterHit = computePose(z, 0.016);
  assert.equal(afterHit.atk, 0, '打断后攻击通道必须为 0');
  assert.ok(afterHit.hurt > 0.99, '此刻姿态完全由受击驱动');
  /* 闲置幅度克制：站着不动 10 秒，张望与呼吸都不能超过上限 */
  const pig = mm.spawn('pig', cx0 + 2.5, fy + 1, cz0 + 0.5);
  pig.moving = false;
  let maxHeadY = 0, maxBreath = 0, maxTilt = 0;
  for (let i = 0; i < 200; i++) {
    pig.age += 0.05;
    const p = computePose(pig, 0.016);
    maxHeadY = Math.max(maxHeadY, Math.abs(p.headY));
    maxBreath = Math.max(maxBreath, Math.abs(p.bodyScaleY - 1));
    maxTilt = Math.max(maxTilt, Math.abs(p.tiltZ));
  }
  assert.ok(maxHeadY > 0.05, '闲置必须真的在缓慢张望：' + maxHeadY);
  assert.ok(maxHeadY <= MOB_POSE_LIMITS.headYaw + 1e-9, '张望幅度超限：' + maxHeadY);
  assert.ok(maxBreath > 0.002 && maxBreath <= MOB_POSE_LIMITS.bodyScale + 1e-9, '呼吸幅度异常：' + maxBreath);
  assert.equal(maxTilt, 0, '没受击就不该有侧倾');
});

test('A3 render() 真的应用姿态：部件角度等于计算值，而 rotation.y 仍只等于 yaw、群组缩放与位置不被改写', () => {
  const { mm, cx0, cz0, fy } = blastCtx();
  const z = mm.spawn('zombie', cx0 + 0.5, fy + 1, cz0 + 0.5);
  z.animAttack = MOB_ATTACK_POSE_SECONDS * 0.5;
  mm.update(0.016, 0);                       // 走真实 render 链路；dayFactor=0 免得日晒掉血干扰 hp 断言
  const parts = z.mesh.userData.parts;
  assert.ok(z.pose, 'render 必须留下姿态快照给诊断用');
  assert.ok(Math.abs(parts.arm0.rotation.x - z.pose.arm0) < 1e-9, '手臂角度必须来自 pose');
  assert.ok(Math.abs(parts.arm1.rotation.x - z.pose.arm1) < 1e-9, '另一只手臂同样');
  assert.ok(Math.abs(parts.head.rotation.x - z.pose.headX) < 1e-9, '头部俯仰必须来自 pose');
  assert.ok(Math.abs(parts.head.rotation.y - z.pose.headY) < 1e-9, '头部偏转必须来自 pose');
  assert.ok(Math.abs(parts.body.scale.y - z.pose.bodyScaleY) < 1e-9, '呼吸只动 body 部件自身缩放');
  assert.ok(Math.abs(z.mesh.rotation.z - z.pose.tiltZ) < 1e-9, '侧倾只走 rotation.z');
  assert.ok(z.pose.arm0 < -1.4, '攻击中的手臂要明显低于敌怪基线 -1.4：' + z.pose.arm0);
  assert.equal(z.mesh.rotation.y, z.yaw, 'D3：rotation.y 永远等于 yaw，姿态不得插手');
  assert.ok(Math.abs(z.mesh.scale.x - 1) < 1e-9, '姿态不得改群组缩放：' + z.mesh.scale.x);
  assert.ok(Math.abs(z.mesh.position.x - z.pos.x) < 1e-9 && Math.abs(z.mesh.position.y - z.pos.y) < 1e-9 &&
    Math.abs(z.mesh.position.z - z.pos.z) < 1e-9, '模型位置必须继续等于物理位置');
  assert.equal(z.hp, MOB_TYPES.zombie.hp, '姿态不参与伤害结算');
  assert.equal(z.dead, false);
  /* 无手臂生物（狼）用前腿前扑表达攻击 */
  const w = mm.spawn('wolf', cx0 + 3.5, fy + 1, cz0 + 0.5);
  w.animAttack = MOB_ATTACK_POSE_SECONDS * 0.5;
  w.moving = false; w.age = 0;
  mm.update(0.016, 0);
  const wp = w.mesh.userData.parts;
  assert.ok(!wp.arm0, '狼本来就没有手臂，前扑要落到腿上');
  assert.ok(Math.abs((w.pose.legSwing - wp.leg0.rotation.x) - w.pose.atkFront) < 1e-9,
    '前腿必须等于「步态摆动 - 前扑」：' + wp.leg0.rotation.x + ' vs ' + w.pose.legSwing + '/' + w.pose.atkFront);
  assert.ok(Math.abs((-w.pose.legSwing) - wp.leg1.rotation.x - w.pose.atkFront) < 1e-9, '右前腿同样带前扑：' + wp.leg1.rotation.x);
  assert.ok(Math.abs(wp.leg2.rotation.x + w.pose.legSwing) < 1e-9, '后腿只跟步态，不许被前扑带到：' + wp.leg2.rotation.x);
  assert.ok(wp.leg0.rotation.x < w.pose.legSwing - 0.5, '狼扑必须让前腿比纯走路再前摆 0.5 弧度以上：' + wp.leg0.rotation.x);
  assert.ok(w.pose.atkFront > 0.5, '前扑通道要有值：' + w.pose.atkFront);
  assert.ok(Math.abs(w.mesh.rotation.y - w.yaw) < 1e-9, '狼的朝向同样不受姿态影响');
  /* 史莱姆群组缩放由 size 决定，姿态只能动部件 */
  const s = mm.spawn('slime', cx0 + 5.5, fy + 1, cz0 + 0.5, { slimeSize: 4 });
  mm.update(0.016, 0);
  assert.ok(Math.abs(s.mesh.scale.x - 1.44) < 1e-9, 'size4 的群组缩放必须保持 1.44：' + s.mesh.scale.x);
  assert.ok(Math.abs(s.mesh.userData.parts.body.scale.y - s.pose.bodyScaleY) < 1e-9, '史莱姆呼吸走部件缩放');
});

/* ================== 2026-11-05 阶段 B：声音能被听见且有事件 ================== */

test('B1 音量 setter 在没有 AudioContext 时也要落地（init 就是在这个时刻下发持久化音量）', () => {
  const s = new Sfx();
  assert.equal(s.ctx, null, '前置：Node 环境没有 AudioContext');
  assert.equal(s.ready, false);
  /* 这三个调用必须把数字存进 _vols —— _buildGraph() 之后会照 _vols 建总线，
     否则 game.init() 里下发的持久化音量会被 Sfx 自己的 DEFAULTS 覆盖掉（就是本轮修掉的 bug）。 */
  s.setMasterVolume(0.25); s.setSfxVolume(0.15); s.setMusicVolume(0.6);
  assert.equal(s._vols.master, 0.25, 'master 没落地');
  assert.equal(s._vols.sfx, 0.15, 'sfx 没落地');
  assert.equal(s._vols.music, 0.6, 'music 没落地');
  /* 脏输入不能把总线搞成 NaN（NaN 增益在 WebAudio 里等于静音，且不可恢复） */
  s.setMasterVolume(undefined); assert.equal(s._vols.master, 1, 'undefined 应回落到 1');
  s.setMasterVolume('0.5'); assert.equal(s._vols.master, 1, '字符串不是数字，按缺省处理');
  s.setMusicVolume(9); assert.equal(s._vols.music, 1, '超过 1 必须封顶');
  s.setSfxVolume(-3); assert.equal(s._vols.sfx, 0, '负数必须夹到 0');
  assert.ok(Number.isFinite(s._vols.master + s._vols.sfx + s._vols.music), '音量出现 NaN');
});

test('B2 氛围床与主曲的目标增益：听得见的下限、开关与水下语义、且不可能超过 1', () => {
  const s = new Sfx();
  s._vols = { master: 0.7, sfx: 0.8, music: 0.45 };
  /* 背景音乐开关独立于环境声。暂停使用环境声自己的开关释放。 */
  s._musicWanted = false;
  assert.ok(s._ambientTarget() > 0.1, '关掉音乐仍应保留环境声');
  s._musicWanted = true;
  s._underwater = false; s._dayT = 0.25;                       // 正午
  const noon = s._ambientTarget();
  assert.ok(noon >= s._vols.music * 0.5, '氛围床系数不能再低于音乐音量的 50%，否则又是「听不见的氛围音」：' + noon);
  assert.ok(noon <= 1, '氛围床目标超过 1 会削波：' + noon);
  const musicNoon = s._musicTarget();
  assert.ok(musicNoon > 0.2 && musicNoon <= 1, '主曲目标增益异常：' + musicNoon);
  /* 午夜更安静、水下更闷：相对关系不能反过来 */
  s._dayT = 0.75;
  const midnight = s._musicTarget();
  assert.ok(midnight < musicNoon, '午夜必须比正午安静：' + midnight + ' vs ' + musicNoon);
  assert.ok(Math.abs(midnight - musicNoon * 0.65) < 1e-9, '午夜只该衰减 35%：' + midnight);
  s._dayT = 0.25; s._underwater = true;
  assert.ok(Math.abs(s._ambientTarget() - noon * 0.6) < 1e-9, '水下氛围床衰减 40%');
  assert.ok(Math.abs(s._musicTarget() - musicNoon * 0.55) < 1e-9, '水下主曲衰减 45%');
  /* 极端设置也不能溢出（音量拉满是合法输入） */
  s._vols = { master: 1, sfx: 1, music: 1 }; s._underwater = false; s._dayT = 0.25;
  assert.ok(s._ambientTarget() <= 1 && s._musicTarget() <= 1, '满音量时目标增益不得超 1');
});

test('B3 play() 必须如实记账：没就绪就是被丢掉（主菜单静音的真相），事件音效只用已有音效名', () => {
  const s = new Sfx();
  const st0 = s.stats();
  assert.equal(st0.played, 0); assert.equal(st0.dropped, 0);
  assert.equal(st0.ready, false); assert.equal(st0.ctxState, 'none');
  s.play('click', { volume: 0.26 });
  s.play('levelup');
  const st1 = s.stats();
  assert.equal(st1.played, 0, '没有 AudioContext 时不可能真的发声');
  assert.equal(st1.dropped, 2, '每一次「想放但放不出」都要计入 dropped');
  assert.equal(st1.lastDrop.reason, 'not-ready', '丢掉原因应为 not-ready：' + JSON.stringify(st1.lastDrop));
  assert.deepEqual(st1.byName, {}, 'byName 只统计真的发出去的声音');
  /* 本轮新增的三个事件反馈：一律复用既有音效名，不新增任何音频文件 */
  for (const name of ['click', 'levelup', 'dig_stone']) {
    assert.ok(SOUND_NAMES.includes(name), '事件音效必须用已有音效名：' + name);
  }
  assert.equal(new Set(SOUND_NAMES).size, SOUND_NAMES.length, '音效名表被写重复了');
});

/* ================== 2026-11-05 阶段 C：UI 信息层级（物品用途文案） ================== */

test('阶段4 配乐素材表：三条轨许可齐全、许可都在允许清单、场景与文件互不重复、URL 同源', () => {
  assert.deepEqual(FILE_TRACK_IDS.slice().sort(), ['cave', 'day', 'night'], '外部曲目必须覆盖三个音乐场景');
  assert.equal(fileTracksValid(), true, '登记表自检失败：' + JSON.stringify(fileTracksReport()));
  const files = FILE_TRACK_IDS.map(id => FILE_TRACKS[id].file);
  assert.equal(new Set(files).size, files.length, '三条轨不许共用同一个文件');
  assert.equal(new Set(FILE_TRACK_IDS.map(id => FILE_TRACKS[id].sha256)).size, 3, '三条轨的指纹必须互不相同');
  for (const id of FILE_TRACK_IDS) {
    const e = fileTrackFor(id);
    assert.ok(e, '场景 ' + id + ' 没有文件轨登记');
    assert.equal(e.scene, id);
    const v = validateFileTrack(id);
    assert.ok(v.ok, id + ' 登记不合规：' + v.problems.join(' / '));
    assert.ok(LICENCE_ALLOWLIST.includes(e.licence), id + ' 的许可不在允许清单：' + e.licence);
    assert.equal(e.source, 'local://tools/music-audio/score.mjs', '原创配乐应能追溯到实际乐谱');
    assert.ok(e.sampleSources.length > 0 && e.sampleSources.every(s => s.licence === 'CC0-1.0'), '乐器采样必须有明确许可');
    const url = fileUrl(e);
    assert.equal(url, '/' + MUSIC_FILE_DIR + '/' + e.file);
    assert.ok(!/^[a-z]+:\/\//i.test(url), '曲目 URL 必须同源相对路径，实得 ' + url);
    assert.ok(!/opengameart|cdn|unpkg|jsdelivr/i.test(url), 'URL 不许指向外部站点：' + url);
  }
  /* 兜底路径不许被删掉：合成表仍是这三首（阶段 4 是「换出声源」，不是「删编排」） */
  for (const id of FILE_TRACK_IDS) assert.ok(TRACKS[id], '合成兜底表少了 ' + id);
});

test('阶段4 素材真的随源码交付：每条登记的曲目都在 renderer/media/music 下、字节数与指纹与登记一致', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', MUSIC_FILE_DIR);
  assert.ok(fs.existsSync(dir), '素材目录不存在：' + dir);
  for (const id of FILE_TRACK_IDS) {
    const e = FILE_TRACKS[id];
    const p = path.join(dir, e.file);
    assert.ok(fs.existsSync(p), id + ' 的素材文件不在包里：' + p);
    const st = fs.statSync(p);
    assert.ok(st.size > 100000, id + ' 素材过小（' + st.size + ' 字节），不像完整曲目');
    assert.equal(st.size, e.bytes, id + ' 字节数与登记不符：磁盘 ' + st.size + ' vs 登记 ' + e.bytes);
    const buf = fs.readFileSync(p);
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'RIFF', id + ' 原创配乐应为无损 WAV');
    assert.equal(buf.subarray(8, 12).toString('latin1'), 'WAVE');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    assert.equal(sha, e.sha256, id + ' 指纹与登记不符：实际 ' + sha + ' vs 登记 ' + e.sha256 + '（素材被换过就必须同步更新许可表）');
  }
});

test('阶段4 文件轨的段落与留白：整曲 ≥40 秒、trim 有界、占空比仍在「稀疏」区间，且沿用同一套出场参数', () => {
  for (const id of FILE_TRACK_IDS) {
    const e = FILE_TRACKS[id];
    const declared = parseDuration(e.declaredDuration);
    assert.ok(declared >= 40, id + ' 页面标注时长 ' + e.declaredDuration + '（' + declared + 's）太短，不像正式曲目');
    assert.equal(declared, Math.round(declared));
    assert.ok(e.measuredDuration >= 40, id + ' 解码时长 ' + e.measuredDuration + 's 太短');
    assert.ok(e.measuredDuration + 2 >= declared, id + ' 解码比页面标注还短，疑似截断：' + e.measuredDuration + ' vs ' + declared);
    assert.ok(e.trim > 0 && e.trim <= 1, id + ' 响度对齐系数必须有界：' + e.trim);
    const d = dutyCycle(e.measuredDuration, MUSIC_TIMING);
    assert.ok(d >= 0.3 && d <= 0.9, id + ' 整曲作为一段后的占空比 ' + d.toFixed(3) + ' 出了 [0.3,0.9]：曲目太长/太短都会破坏「稀疏出场」的原设计');
    const dSynth = dutyCycle(TRACKS[id].loopSeconds, MUSIC_TIMING);
    assert.ok(d >= dSynth, id + ' 换整曲之后只会比合成兜底更常出声（' + d.toFixed(3) + ' ≥ ' + dSynth.toFixed(3) + '），不许变得更稀疏');
  }
  /* 合成兜底曲仍是原来那段编排长度，两条路径共用同一套 timing 常量 */
  assert.ok(Math.abs(dutyCycle(TRACKS.day.loopSeconds, MUSIC_TIMING) - dutyCycle(TRACKS.day.loopSeconds)) < 1e-9);
});

test('阶段4 出声优先级：没解码好立刻用合成曲（绝不静音），就绪后交叉换成文件轨，取回来失败也只降级', async () => {
  const param = () => {
    const p = {
      value: 0,
      setValueAtTime(v) { p.value = v; return p; },
      linearRampToValueAtTime(v) { p.value = v; return p; },
      exponentialRampToValueAtTime(v) { p.value = v; return p; },
      cancelScheduledValues() { return p; },
      setTargetAtTime(v) { p.value = v; return p; }
    };
    return p;
  };
  const oscStarts = [];
  const srcStarts = [];
  const node = (extra) => Object.assign({ connect() { }, disconnect() { }, gain: param() }, extra || {});
  const ctx = {
    currentTime: 0, state: 'running', destination: node(),
    createGain: () => node(),
    createOscillator: () => node({ type: 'sine', frequency: param(), detune: param(), start(t) { oscStarts.push(t); }, stop() { } }),
    createBiquadFilter: () => node({ type: 'lowpass', frequency: param(), Q: param() }),
    createStereoPanner: () => node({ pan: param() }),
    createBufferSource: () => node({ buffer: null, loop: false, playbackRate: param(), onended: null, start(t) { srcStarts.push(t); }, stop() { } }),
    decodeAudioData: (ab, ok) => { ok({ duration: 52.5, sampleRate: 48000, numberOfChannels: 2, length: 1 }); }
  };
  const realFetch = globalThis.fetch;
  const urls = [];
  const s = new Sfx();
  try {
    s.ctx = ctx;
    s.master = node(); s.sfxBus = node(); s.musicBus = node(); s.ambientBus = node();
    s.toneFilter = node({ type: 'lowpass', frequency: param() });
    s._leadInDone = true;                       // 跳过「首次进入世界先留白」，这里只验出声源选择

    // 1) 什么都没解码 → 必须立刻是合成曲，而且真的排了音符
    globalThis.fetch = (u) => { urls.push(u); return Promise.reject(new Error('offline in unit test')); };
    s.startMusic('day');
    assert.equal(s._music.source, 'synth', '文件还没解码就必须先放合成曲，不能空着等文件');
    assert.equal(s._music.loopSeconds, TRACKS.day.loopSeconds, '合成轨的一段就该是编排长度');
    assert.ok(oscStarts.length > 0, '合成曲一个音符都没排，等于静音：' + oscStarts.length);
    assert.equal(urls.length, 1, 'startMusic 要顺手把这条场景的素材取回来');
    assert.equal(urls[0], fileUrl(FILE_TRACKS.day), '取的是登记表里的同源 URL，实得 ' + urls[0]);
    await new Promise(r => setImmediate(r));      // 让拒绝的 microtask 落地
    assert.equal(s._fileState.day, 'failed', '取回失败要留下状态，而不是卡在 loading');
    assert.match(String(s._fileLastError), /offline in unit test/, '失败原因要能查出来：' + s._fileLastError);
    assert.equal(s._music.source, 'synth', '失败之后照旧放合成曲，不许静音');

    // 2) 取回并解码成功 → 同场景交叉换成文件轨，段落长度改成整曲时长
    globalThis.fetch = (u) => {
      urls.push(u);
      return Promise.resolve({
        ok: true, headers: { get: () => 'audio/ogg' },
        arrayBuffer: async () => new ArrayBuffer(1234)
      });
    };
    s.ensureFileTrack('night');
    s.setMusicScene('night');
    assert.equal(s._music.source, 'synth', 'night 还没解码完，切换瞬间仍要由合成曲顶着');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.equal(s._fileState.night, 'ready', '解码完应进入 ready：' + JSON.stringify(s._fileStates || s._fileState));
    assert.equal(s._music.source, 'file', '文件就绪后同场景要从合成曲换到曲目（交叉淡化），不能一直放合成');
    assert.equal(s._music.loopSeconds, 52.5, '文件轨的一段必须等于解码时长');
    assert.equal(s._music.track.id, 'night', 'section/trackId 读数仍指向同一场景');
    assert.equal(s._music.trim.gain.value, FILE_TRACKS.night.trim, '响度对齐系数必须来自登记表');
    assert.ok(srcStarts.length >= 1, '文件轨没有真的启动声源：' + JSON.stringify(srcStarts));
    assert.equal(s._fileStats.night.bytes, 1234, '字节数要在 decodeAudioData 之前记下来，不能是 0');
    assert.equal(s.musicInfo().source, 'file');
    assert.equal(s.musicInfo().synthLoopSeconds, +TRACKS.night.loopSeconds.toFixed(3), '编排长度要另开一个口径，不能拿文件时长冒充');

    // 3) 显式关掉文件轨（验收要证明兜底真的能出声）→ 立刻回到合成曲
    const oscBefore = oscStarts.length;
    assert.equal(s.setFileTracksEnabled(false), false);
    assert.equal(s._music.source, 'synth', '关掉文件轨后必须回到合成曲而不是没声');
    assert.ok(oscStarts.length > oscBefore, '兜底合成曲要真的排音符：' + (oscStarts.length - oscBefore));
    assert.equal(s.musicInfo().filesEnabled, false);
    assert.equal(s.musicInfo().source, 'synth');

    // 4) 释放：解码母带是引擎里最大的一块内存，dispose 必须放掉
    s.dispose();
    assert.equal(s._fileBufs.size, 0, 'dispose 后解码缓冲要清空');
    assert.equal(s.musicInfo().activeMusicCount, 0);
    assert.equal(s.musicInfo().trackId, null);
  } finally {
    /* 收尾一定要跑：断言半路抛错时若还留着「下一段」定时器，
       node --test 会等它触发（触发后还会再接排一段 + 留白），整轮测试直接被拖死。 */
    globalThis.fetch = realFetch;
    try { s.dispose(); } catch (e) { /* ignore */ }
  }
});

test('C1 describeItem 只从既有字段推文案：工具/食物/方块/护甲/未知 id 都给出可读结构且不编造数值', () => {
  const pick = describeItem('pickaxe_iron', { dur: 120 });
  assert.equal(pick.name, ITEMS.pickaxe_iron.name, '名字必须来自物品表');
  assert.ok(pick.use.includes('挖掘'), '镐的用途文案应说明挖掘：' + pick.use);
  assert.ok(pick.lines.some(l => l.includes('工具等级 ' + ITEMS.pickaxe_iron.toolLevel)), '等级要来自字段：' + pick.lines);
  assert.ok(pick.lines.some(l => l.includes('攻击 ' + ITEMS.pickaxe_iron.damage)), '伤害要来自字段：' + pick.lines);
  assert.ok(pick.lines.some(l => l.includes('120/251')), '耐久要显示当前/上限：' + pick.lines);
  assert.equal(pick.dur.pct.toFixed(3), (120 / 251).toFixed(3), '耐久百分比算法与槽位耐久条同源');

  const apple = describeItem('apple');
  assert.ok(apple.use.includes('吃'), '食物用途：' + apple.use);
  assert.ok(apple.lines.some(l => l.includes('饥饿 ' + ITEMS.apple.food)), '恢复量来自字段：' + apple.lines);

  const cobble = describeItem('cobblestone');
  assert.ok(cobble.lines.some(l => l.includes('可熔炼') && l.includes(itemName(smeltResult('cobblestone').output))),
    '熔炼产物必须与熔炼表一致：' + cobble.lines);

  const helm = describeItem('iron_helmet');
  assert.ok(helm.lines.some(l => l.includes('护甲 +' + ITEMS.iron_helmet.armorPoints)), '护甲点数来自字段：' + helm.lines);

  const ghost = describeItem('不存在的物品');
  assert.equal(ghost.known, false, '未知 id 不能崩，也不能编内容');
  assert.deepEqual(ghost.lines, []);
  assert.equal(ghost.dur, null);
  /* 不许改动物品表（纯函数） */
  const before = ITEMS.pickaxe_iron.durability;
  describeItem('pickaxe_iron', { dur: 1 });
  assert.equal(ITEMS.pickaxe_iron.durability, before, 'describeItem 不许写回物品表');
});

test('C2 用途文案不许与配方表打架：材料计数、熔炼与燃料都只读现有表', () => {
  const sticks = recipeUseCount('stick');
  let manual = 0;
  for (const r of RECIPES) {
    const inputs = r.type === 'shapeless' ? r.inputs : (r.key ? Object.values(r.key) : []);
    const hit = inputs.some(i => { const l = expandIngredient(i); return l && l.indexOf('stick') >= 0; });
    if (hit) manual++;
  }
  assert.equal(sticks, manual, '木棍的「可用于 N 个配方」必须等于真实配方数：' + sticks + ' vs ' + manual);
  assert.ok(sticks > 10, '前置：木棍应当是常见材料');

  /* 标签必须展开后再数：直接字符串比较会把 logs 标签漏掉 */
  assert.equal(recipeUseCount('birch_log'), recipeUseCount('oak_log'), 'logs 标签下两种原木的材料数应一致');

  const coal = describeItem('coal');
  assert.ok(coal.lines.some(l => l.includes('燃料')), '煤要说明能当燃料：' + coal.lines);
  assert.equal(isFuel('coal'), true, '燃料判定来自 recipes.js，不另立规则');
  assert.equal(isFuel('cobblestone'), false, '圆石不是燃料');
});

test('C3 耐久读数：0/满/超上限/缺字段都必须安全且百分比夹在 0~1', () => {
  const max = ITEMS.sword_iron.durability;
  assert.equal(describeItem('sword_iron', { dur: 0 }).dur.pct, 0, '0 耐久要显示空条而不是负数');
  assert.equal(describeItem('sword_iron', { dur: max }).dur.pct, 1, '满耐久 100%');
  assert.equal(describeItem('sword_iron', { dur: max * 3 }).dur.pct, 1, '脏值超上限要夹住，不能画出 300% 的条');
  assert.equal(describeItem('sword_iron', { dur: -5 }).dur.pct, 0, '负耐久夹到 0');
  assert.equal(describeItem('sword_iron').dur, null, '没有这一堆的耐久时只给上限，不编当前值');
  assert.equal(describeItem('sword_iron').lines.some(l => l.includes('耐久上限 ' + max)), true, '上限仍要说得清');
  assert.equal(describeItem('cobblestone', { dur: 5 }).dur, null, '方块没有耐久，不许凭空造一条');
});

test('P0 近战纯逻辑：rayAABB 正面 / 擦边 / 背后 / 盒内 / 高于盒顶', async () => {
  const { rayAABB } = await import('../renderer/js/core/melee.js');
  const box = { minX: -0.5, maxX: 0.5, minY: 0, maxY: 2, minZ: -2.5, maxZ: -1.5 };
  assert.ok(Math.abs(rayAABB(0, 1, 0, 0, 0, -1, box) - 1.5) < 1e-6, '朝 -Z 应在 1.5 格处命中');
  assert.equal(rayAABB(0, 1, 0, 0, 0, 1, box), null, '背对盒子不能命中');
  assert.equal(rayAABB(2, 1, 0, 0, 0, -1, box), null, '侧向平行射线擦过不能命中');
  assert.equal(rayAABB(0, 1, -2, 0, 0, -1, box), 0, '起点在盒内返回 0');
  assert.equal(rayAABB(0, 3, 0, 0, 0, -1, box), null, '高于盒顶不能命中');
});

test('P0 近战纯逻辑：方块遮挡、最近目标、死亡与距离上限', async () => {
  const { pickAttackTarget, MELEE_REACH } = await import('../renderer/js/core/melee.js');
  const mob = (z, extra = {}) => Object.assign({ pos: { x: 0, y: 0, z }, width: 0.6, height: 2, hp: 10, dead: false }, extra);
  const o = { x: 0, y: 1.6, z: 0 }, d = { x: 0, y: 0, z: -1 };
  const near = mob(-1.5), far = mob(-3);
  assert.equal(pickAttackTarget([far, near], o, d, MELEE_REACH, Infinity).mob, near, '取最近的生物');
  const blocked = pickAttackTarget([far, near], o, d, MELEE_REACH, 0.52);
  assert.equal(blocked.mob, null, '0.52 格处的石墙应挡住后面所有生物');
  assert.equal(blocked.blocked, true, '要能区分「没目标」和「被挡住」');
  assert.equal(pickAttackTarget([mob(-1.5, { dead: true }), far], o, d, MELEE_REACH, Infinity).mob, far,
    '死亡生物不参与命中');
  assert.equal(pickAttackTarget([mob(-8)], o, d, MELEE_REACH, Infinity).mob, null, '超过上限不命中');
  assert.equal(pickAttackTarget([mob(-5)], o, d, 8, Infinity).mob, null, '传入更大的 maxDist 也被 MELEE_REACH 夹住');
});

test('P0 近战纯逻辑：按武器冷却、未满蓄伤害与恢复进度', async () => {
  const { attackCooldownFor, meleeDamageScale, attackCharge } = await import('../renderer/js/core/melee.js');
  const { getItem } = await import('../renderer/js/core/items.js');
  assert.equal(attackCooldownFor(getItem('sword_stone')), 0.625, '石剑 0.625s');
  assert.equal(attackCooldownFor(getItem('axe_iron')), 0.8, '斧更慢');
  assert.equal(attackCooldownFor(getItem('pickaxe_wood')), 0.5, '镐居中');
  assert.equal(attackCooldownFor(null), 0.25, '空手最快');
  assert.equal(meleeDamageScale(0), 0.2, '刚挥完只有 20% 伤害');
  assert.equal(meleeDamageScale(1), 1, '满蓄满额');
  assert.ok(meleeDamageScale(0.5) > 0.2 && meleeDamageScale(0.5) < 1);
  assert.equal(meleeDamageScale(2), 1, 'p 超上限要夹住');
  assert.equal(attackCharge(0.625, 0.625), 0);
  assert.equal(attackCharge(0, 0.625), 1);
  assert.equal(attackCharge(5, 0), 1, 'total 为 0 时不许 NaN');
});

test('P0 按键重复不误触双击 W 冲刺，真实双击仍生效', async () => {
  const hadW = 'window' in globalThis, oldW = globalThis.window;
  const hadD = 'document' in globalThis, oldD = globalThis.document;
  globalThis.window = { addEventListener() {} };
  globalThis.document = { addEventListener() {}, pointerLockElement: null };
  try {
    const { InputManager } = await import('../renderer/js/player/input.js');
    const im = new InputManager({ addEventListener() {}, requestPointerLock() {} }, {});
    const down = (repeat) => im._onKey({ code: 'KeyW', repeat: !!repeat, preventDefault() {} }, true);
    down(false);
    for (let i = 0; i < 4; i++) down(true);   // OS 按键重复，全部落在 320ms 窗口内
    assert.equal(im.sync().sprint, false, 'repeat keydown 不能被当成第二次按下');
    down(false);
    assert.equal(im.sync().sprint, true, '不含 repeat 的真实第二次按下仍要冲刺');
    im._onKey({ code: 'KeyW', repeat: false, preventDefault() {} }, false);
    assert.equal(im.sync().sprint, false, '松开 W 必须解除冲刺');
  } finally {
    if (hadW) globalThis.window = oldW; else delete globalThis.window;
    if (hadD) globalThis.document = oldD; else delete globalThis.document;
  }
});

test('P0 命中盒垂直容差：平视能打中 2 格外的猪，但明显高于盒顶仍打不中，墙后照样不命中', async () => {
  const { pickAttackTarget, MELEE_REACH, HITBOX_MARGIN, HITBOX_TOP_TOLERANCE } = await import('../renderer/js/core/melee.js');
  const eye = { x: 0.5, y: 1.62, z: 0.5 }, dir = { x: 0, y: 0, z: -1 };
  const pig = { pos: { x: 0.5, y: 0, z: -1.5 }, width: 0.6, height: 0.9, hp: 10, dead: false };
  assert.equal(pickAttackTarget([pig], eye, dir, MELEE_REACH, Infinity).mob, pig,
    'P0 之前 pickNearest 用 0.85 三维容差能打中平视的猪，改成严格 AABB 后不能把手感倒退');
  /* 眼睛比盒顶加容差还高 0.6 格（例如站在高处平视脚下的鸡）→ 不该命中 */
  const low = { pos: { x: 0.5, y: -1.2, z: -1.5 }, width: 0.4, height: 0.4, hp: 10, dead: false };
  assert.equal(pickAttackTarget([low], eye, dir, MELEE_REACH, Infinity).mob, null,
    '目标明显在视线下方时不能「隔空」命中');
  /* 垂直容差只放宽上方：横向偏出 0.8 格仍然打不中 */
  const aside = { pos: { x: 1.35, y: 0, z: -1.5 }, width: 0.6, height: 0.9, hp: 10, dead: false };
  assert.equal(pickAttackTarget([aside], eye, dir, MELEE_REACH, Infinity).mob, null, '横向偏出不能命中');
  /* 遮挡优先于容差：同一格墙 + 平视猪 = 打不到 */
  assert.equal(pickAttackTarget([pig], eye, dir, MELEE_REACH, 0.52).mob, null, '墙后目标不能因为放宽垂直容差而恢复可命中');
  assert.ok(HITBOX_TOP_TOLERANCE > 0 && HITBOX_TOP_TOLERANCE < 1, '垂直容差要克制，别变成半格高的空气墙：' + HITBOX_TOP_TOLERANCE);
  assert.equal(HITBOX_MARGIN, 0.35);
});

test('P0 受击叠色：保留生物自身色相与明度，不再是整块纯红剪影', () => {
  const cases = [0xe89a9a, 0x4a3b32, 0x00ff00, 0xffffff, 0x000000, 0x8b5a2b, 0xff4040, 0x2c2a28];
  for (const base of cases) {
    const t = hurtTint(base);
    const r = (t >> 16) & 255, g = (t >> 8) & 255, b = t & 255;
    const br = (base >> 16) & 255, bg = (base >> 8) & 255, bb = base & 255;
    assert.ok(t >= 0 && t <= 0xffffff, '颜色越界：' + t);
    assert.ok(r >= br, '红通道只能往上叠：base=' + base.toString(16) + ' → ' + t.toString(16));
    assert.ok(g <= bg && b <= bb, '绿蓝只能压不能提：' + t.toString(16));
    /* 关键：绿蓝各保留约 78%，不能像旧版那样把整块涂成 0xff4040（绿蓝只剩 25%） */
    if (bg > 60) assert.ok(g >= bg * 0.7, '绿通道被涂没：base=' + base.toString(16) + ' → ' + t.toString(16));
    if (bb > 60) assert.ok(b >= bb * 0.7, '蓝通道被涂没：base=' + base.toString(16) + ' → ' + t.toString(16));
    if (base !== 0xff4040) assert.notEqual(t, 0xff4040, '不能再退化成旧的整块纯红');
  }
  assert.equal(hurtTint(0x000000), 0x610000, '纯黑只被叠上红通道，整体仍是暗色');
  assert.equal(hurtTint(0xffffff), 0xffc7c7, '纯白压成浅粉而不是变红块');
  assert.equal(hurtTint(0xe89a9a), 0xf17878, '猪的粉色：叠红但保留明度层次');
  assert.equal(hurtTint(0x4a3b32), 0x8f2e27, '牛的深棕：仍能认出是深色皮毛');
});

/* ================= T2 光照数据（先于 shader） =================
 * 洞穴「整片发灰、火把没有光池」的第一嫌疑不是着色器，而是数据：
 * seedBorders() 对**未加载邻居**用「y 高于纯函数地表就是天空光 15」近似接缝，
 * 又把近似值/邻居值直接写进接缝的**石头格**，BFS 再从这些格往空气扩散 ——
 * 结果只要洞穴跨区块接缝，室内空气格就拿到 sky=15，等于从天花板灌阳光。
 * 这一条把两个洞都钉住：① 接缝空气格不许有天空光；② 实心格不许存光。
 * 同时钉住反例：屋顶以上真实露天仍然必须是 15（不许为了压暗把天空光整体干掉），
 * 以及火把在干净数据下确实形成 14 → 远端 6 的光池梯度。 */
test('P0 光照数据：跨接缝的封闭石室不许被近似天空光灌满，实心格不许存光', () => {
  const w = new VoxelWorld(4242);
  w.ensureChunk(0, 0);
  w.ensureChunk(1, 0);
  const c0 = w.chunks.get(coordKey(0, 0)), c1 = w.chunks.get(coordKey(1, 0));

  /* 石壳整体抬到「纯函数地表高度」之上：旧近似会认为这里的每一格都露天 */
  const X0 = 6, X1 = 25, Z0 = 4, Z1 = 12;
  let top = 0;
  for (let x = X0; x <= X1; x++) for (let z = Z0; z <= Z1; z++) top = Math.max(top, w.surfaceHeight(x, z));
  const Y0 = top + 3, Y1 = Y0 + 9;
  for (let x = X0; x <= X1; x++) for (let z = Z0; z <= Z1; z++) for (let y = Y0; y <= Y1; y++) w.setBlock(x, y, z, B.STONE);
  const ix0 = X0 + 2, ix1 = X1 - 2, iz0 = Z0 + 2, iz1 = Z1 - 2, iy0 = Y0 + 2, iy1 = Y1 - 2;
  for (let x = ix0; x <= ix1; x++) for (let z = iz0; z <= iz1; z++) for (let y = iy0; y <= iy1; y++) w.setBlock(x, y, z, B.AIR);
  w.setBlock(16, iy0, 8, B.TORCH);

  /* 室内空气必须横跨 cx=0/cx=1 的接缝：x=15 是 c0 的 lx=15，x=16 是 c1 的 lx=0 */
  assert.ok(ix0 <= 15 && ix1 >= 16, '构造失效：室内没压住接缝列');
  assert.equal(c1.state < 2, true, '前提：+X 邻居此时还没点亮，第一趟必须走未加载近似分支');

  lightChunk(c0, w);            // 近似分支
  lightChunk(c1, w);            // 此时 c0 已点亮，走真实值
  lightChunk(c0, w);            // 邻居就绪后补一趟（真实流式加载的顺序）
  lightChunk(c1, w);

  /* ① 室内所有空气格天空光为 0（重点看两条接缝列） */
  for (let y = iy0; y <= iy1; y++) for (let z = iz0; z <= iz1; z++) {
    assert.equal(c0.getSky(15, y, z), 0, '接缝 lx=15 室内空气格被灌了天空光 y=' + y + ' z=' + z);
    assert.equal(c1.getSky(0, y, z), 0, '接缝 lx=0 室内空气格被灌了天空光 y=' + y + ' z=' + z);
  }
  assert.equal(c0.getSky(8, iy0 + 2, 8), 0, '石室深处天空光必须为 0');

  /* ② 实心格不许存光：旧代码把光写进接缝石头格，等于给 BFS 开了穿墙的门 */
  for (let z = Z0; z <= Z1; z++) {
    for (const y of [Y0, Y0 + 1, Y1 - 1, Y1]) {
      assert.equal(c0.light[idx(15, y, z)], 0, '接缝石头格 lx=15 存了光 y=' + y + ' z=' + z);
      assert.equal(c1.light[idx(0, y, z)], 0, '接缝石头格 lx=0 存了光 y=' + y + ' z=' + z);
    }
  }

  /* ③ 干净数据下火把确实是局部光池：14 起、每格衰减 1，远端只剩 6 */
  assert.equal(c1.getBlockLight(0, iy0, 8), 14, '火把自身 14');
  assert.equal(c0.getBlockLight(15, iy0, 8), 13, '接缝空气格的方块光来自火把（不是天空光）');
  assert.equal(c1.getBlockLight(7, iy0, 8), 7, '远端墙 x=23 应衰减到 7');
  assert.equal(c0.getBlockLight(8, iy0, 8), 6, '远端墙 x=8 应衰减到 6');
  assert.ok(c0.getBlockLight(8, iy0, 8) < c0.getBlockLight(15, iy0, 8), '光池必须有梯度');

  /* ④ 反例守卫：屋顶以上真实露天不能被压暗 */
  assert.equal(c0.getSky(15, Y1 + 1, 8), 15, '石壳上方露天仍要 15');
  assert.equal(c0.getSky(8, Y1 + 1, 8), 15, '换一列露天也要 15');
});

/* ================= P1 实体光照（生物采样世界光照） =================
 * 以前生物材质是纯色：洞穴里的猪和太阳底下的猪一样亮，「生物不像活在这个世界里」。
 * 现在实体走 core/entitylight.js，常数与 VOX_FRAG 同源（e2e EL.2 负责核对两边一致）。
 * 这里钉三件事：① 白天露天 = 1 且露天火把不会改变任何东西（blkDom=0）→ 白天不会更暗；
 * ② 方块光主导时走陡曲线（光池），但留了可见度下限，纯黑处仍看得出剪影；
 * ③ 压暗只做明度缩放，不许把颜色压成同一个灰。 */
test('P1 实体亮度：与体素曲线同源、白天不衰减、暗处有可见度下限', async () => {
  const { entityBrightness, ENTITY_LIGHT_FLOOR, CURVE } = await import('../renderer/js/core/entitylight.js');
  const r = (s, b, d) => +entityBrightness(s, b, d).toFixed(4);
  assert.equal(r(15, 0, 1), 1, '白天露天必须仍是满亮（曲线在 lvl=1 处归一）');
  assert.equal(r(15, 14, 1), 1, '白天露天插火把不该改变亮度：blkDom=(0.93-1)/(…)≤0');
  assert.equal(r(0, 0, 1), ENTITY_LIGHT_FLOOR, '全黑处夹在可见度下限，不能纯黑剪影都看不见');
  assert.equal(r(0, 0, 0), ENTITY_LIGHT_FLOOR, '连昼夜都没有时也仍要留下下限');
  assert.equal(r(0, 14, 1), 0.8885, '火把旁（纯方块光）走陡的光池曲线');
  assert.equal(r(0, 8, 1), 0.3530, '离火把 6 格应当明显掉下去（以前近乎线性 → 看着还是灰的）');
  assert.equal(r(15, 0, 0.36), 0.3628, '夜间露天按 uDay=0.36 走平坦曲线（与地形同一系数）');
  assert.equal(r(15, 14, 0.36), 0.9119, '夜间火把旁仍是光池');
  /* 单调：方块光越高越亮，且不高于 1 */
  let prev = -1;
  for (let blk = 0; blk <= 15; blk++) {
    const v = entityBrightness(0, blk, 1);
    assert.ok(v >= prev - 1e-9, '方块光 ' + blk + ' 亮度倒挂：' + v + ' < ' + prev);
    assert.ok(v <= 1 && v >= ENTITY_LIGHT_FLOOR, '亮度越界：' + v);
    prev = v;
  }
  /* 常数本身也钉住：改了这里必须同时改 gfx/view.js 的 VOX_FRAG，否则两边不同源 */
  assert.deepEqual(CURVE, { flatA: 0.065, flatB: 0.935, flatPow: 1.12, poolA: 0.045, poolB: 0.955, poolPow: 1.80 });
  assert.equal(ENTITY_LIGHT_FLOOR, 0.16);
});

test('P1 实体着色：只做明度缩放不改变色相，村民三职业压到最暗仍然分得开', async () => {
  const { shadeColor, colorsDistinguishable, ENTITY_LIGHT_FLOOR } = await import('../renderer/js/core/entitylight.js');
  const ch = (c, s) => (c >> (s * 8)) & 255;
  assert.equal(shadeColor(0xe89a9a, 1), 0xe89a9a, 'k=1 应当原样返回');
  assert.equal(shadeColor(0xe89a9a, 0.3628), 0x543838, '猪的粉色压到夜间露天亮度');
  assert.equal(shadeColor(0x000000, 1), 0, '纯黑压不动');
  assert.equal(shadeColor(0x000000, ENTITY_LIGHT_FLOOR), 0, '纯黑在最暗处仍是纯黑（不会自己发亮）');
  for (const base of [0xe89a9a, 0x4a3b32, 0x00ff00, 0xffffff, 0x123456]) {
    for (const k of [1, 0.6, ENTITY_LIGHT_FLOOR]) {
      const s = shadeColor(base, k);
      assert.ok(s >= 0 && s <= 0xffffff, '颜色越界：' + s);
      for (const sh of [0, 1, 2]) {
        const a = ch(base, sh), b = ch(s, sh);
        assert.ok(b <= a, '压暗不许把通道提亮：base=' + base.toString(16) + ' k=' + k);
        if (a > 8) assert.ok(Math.abs(b / a - k) < 0.02, '各通道必须按同一个系数缩放（否则色相会跑）');
      }
    }
  }
  /* 村民三职业身体色（mobs.js 里的真实调色板）：压到最暗也要还能分辨，否则 E2.1 的「外观区分职业」就废了 */
  const bodies = [0x405a7a, 0x3f3b36, 0x6d4a2f];
  for (const k of [1, 0.36, ENTITY_LIGHT_FLOOR])
    assert.ok(colorsDistinguishable(bodies.map(c => shadeColor(c, k))), 'k=' + k + ' 三职业撞色');
  assert.ok(!colorsDistinguishable([0x405a7a, 0x405a7a]), '相同的两色必须判为分不开');
});

/* 第二条：走引擎自己的节奏。上面那条手工调 lightChunk，这条先用 world.update 把整片点亮，
   再用 setBlock 盖一间封闭石室 —— 建造会把本块和邻块**同时**标脏，先补光的那一块
   如果读邻块还没重算的光数组，就把「这里还是露天时的 sky 15」搬进了新砌的墙里。
   c2 证据场景实测室内 sky=12~14 就是这条路径（补光结束后再没人重算，错值一直留着）。 */
test('P0 光照数据：在已点亮的地上盖封闭石室，引擎补光之后室内天空光必须归 0', () => {
  const w = new VoxelWorld(2025);
  for (let cz = -1; cz <= 2; cz++) for (let cx = -1; cx <= 2; cx++) w.ensureChunk(cx, cz);
  for (let i = 0; i < 3000 && w.dirtyLight.size; i++) w.update(0.05, FRAME_BUDGET, null);
  assert.equal(w.dirtyLight.size, 0, '预置：第一轮补光应当排空');

  /* 室内要压住两条接缝：中心取 19，室内 15..23 正好跨过 15|16（cx=0/cx=1 与 cz=0/cz=1） */
  const CX = 19, CZ = 19;
  const Y0 = Math.max(w.surfaceHeight(CX, CZ), SEA_LEVEL + 6);
  for (let dy = -4; dy <= 6; dy++) for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++)
    w.setBlock(CX + dx, Y0 + dy, CZ + dz, B.STONE);
  for (let dy = 0; dy <= 3; dy++) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++)
    w.setBlock(CX + dx, Y0 + dy, CZ + dz, B.AIR);
  w.setBlock(CX, Y0 + 2, CZ - 4, B.TORCH);

  for (let i = 0; i < 3000 && w.dirtyLight.size; i++) w.update(0.05, FRAME_BUDGET, null);
  assert.equal(w.dirtyLight.size, 0, '补光队列应当排空，实得 ' + w.dirtyLight.size);
  for (const [cx, cz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const c = w.chunks.get(coordKey(cx, cz));
    assert.ok(c && c.state >= 2 && !c.dirtyLight, 'cx=' + cx + ' cz=' + cz + ' 必须已点亮且不欠算');
  }

  /* ① 两条接缝列 + 中心的室内格：天空光必须为 0（读的是真实 light，不是未加载近似） */
  for (const [x, z] of [[15, CZ], [16, CZ], [CX, CZ], [CX, 15], [CX, 16], [23, 23]]) {
    for (let y = Y0; y <= Y0 + 3; y++) {
      assert.equal(w.getLight(x, y, z) >> 4, 0, '室内 (' + x + ',' + y + ',' + z + ') 被灌了天空光');
    }
  }
  /* ② 整个室内都不许有天空光 */
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = 0; dy <= 3; dy++)
    assert.equal(w.getLight(CX + dx, Y0 + dy, CZ + dz) >> 4, 0,
      '室内 (' + dx + ',' + dy + ',' + dz + ') 天空光应为 0');

  /* ③ 火把仍然是唯一光源，并且有梯度 */
  assert.equal(w.getLight(CX, Y0 + 2, CZ - 4) & 15, 14, '火把格自身 14');
  assert.ok((w.getLight(CX, Y0 + 2, CZ) & 15) < 14, '离开火把应当衰减');
  assert.equal(w.getLight(CX, Y0 + 7, CZ) >> 4, 15, '石室上方露天仍要 15');
});

/* ---------------- T4 音乐出场时机与关键音效（纯逻辑，不依赖 AudioContext） ---------------- */

test('T4-M1 出场时机：稀疏 / 缓入 / 曲终留白三条定性约束落成可判定常数', () => {
  const cfg = timingConfig();
  assert.equal(cfg.fadeIn, 6, '缓入要明显长于原来的 2~3 秒交叉淡化');
  assert.equal(cfg.fadeOut, 5, '曲终要有淡出，不能硬切');
  assert.ok(cfg.gapMin >= 60 && cfg.gapMax >= cfg.gapMin, '曲间必须有长留白');
  assert.ok(cfg.leadInMin > 0 && cfg.leadInMax >= cfg.leadInMin, '进世界先安静一阵再出现');
  assert.equal(pickLeadIn(() => 0), cfg.leadInMin);
  assert.equal(pickLeadIn(() => 1), cfg.leadInMax);
  assert.equal(pickGap(() => 0), cfg.gapMin);
  assert.equal(pickGap(() => 1), cfg.gapMax);
  for (const r of [0.13, 0.5, 0.87]) {
    assert.ok(pickGap(() => r) >= cfg.gapMin && pickGap(() => r) <= cfg.gapMax);
    assert.ok(pickLeadIn(() => r) >= cfg.leadInMin && pickLeadIn(() => r) <= cfg.leadInMax);
  }
  /* 官方 "doesn't play constantly" 的可判定落地：播放时长占比必须小于一半 */
  assert.ok(dutyCycle(32, cfg) < 0.5, '32 秒一段也应大部分时间在留白');
  assert.ok(dutyCycle(25, cfg) < 0.5, '25 秒一段也应大部分时间在留白');
  assert.equal(segmentWaitMs(32), 31850, '段尾前 150ms 开始淡出');
  assert.ok(segmentWaitMs(0.001) >= 1200, '极短段也要有下限，避免定时器忙循环');
  assert.ok(Object.isFrozen(MUSIC_TIMING), '常量不许运行时被篡改');
  const copy = timingConfig();
  copy.gapMin = 0;
  assert.equal(MUSIC_TIMING.gapMin, cfg.gapMin, '诊断副本改了不能影响本体');
});

test('T4-M2 音效名字表与配方表双向一致（hiss 漏登记的漂移不许回来）', () => {
  for (const n of SOUND_DEF_NAMES) assert.ok(SOUND_NAMES.includes(n), '配方 ' + n + ' 没登记进 SOUND_NAMES');
  for (const n of SOUND_NAMES) assert.ok(SOUND_DEF_NAMES.includes(n), '名字 ' + n + ' 没有对应的音效配方');
  assert.ok(SOUND_NAMES.includes('hiss'), '苦力怕 / TNT 引信音必须已登记');
  assert.ok(SOUND_NAMES.includes('swing'), '空挥音必须已登记');
  assert.equal(new Set(SOUND_NAMES).size, SOUND_NAMES.length, '音效名不能重复注册');
});

test('T4-M3 八类关键动作音都有配方且统一相对增益，UI 音不受影响', () => {
  const groups = [
    ['step_grass', 'step_stone', 'step_sand', 'step_wood', 'step_snow'],
    ['dig_grass', 'dig_dirt', 'dig_stone', 'dig_wood', 'dig_sand', 'dig_gravel'],
    ['break_grass', 'break_dirt', 'break_stone', 'break_wood', 'break_sand'],
    ['place'], ['swing'], ['hit'], ['shield_block'], ['hiss']
  ];
  for (const g of groups) {
    assert.ok(g.some(n => KEY_SOUNDS.includes(n)), g.join('/') + ' 这一类一个关键音都没进增益表');
    for (const n of g) assert.ok(SOUND_DEF_NAMES.includes(n), n + ' 缺音效配方');
  }
  assert.ok(KEY_SFX_GAIN > 1 && KEY_SFX_GAIN < 2, '只给一档温和的相对增益，不钉绝对 dB');
  assert.equal(keyGain('swing'), KEY_SFX_GAIN);
  assert.equal(keyGain('hit'), KEY_SFX_GAIN);
  assert.equal(keyGain('hiss'), KEY_SFX_GAIN);
  assert.equal(keyGain('click'), 1, 'UI 点击音不该被当成关键动作音放大');
  assert.equal(keyGain('levelup'), 1, '事件提示音也维持原样');
});

/* ---------------- P2 首夜引导与 HUD 几何（纯逻辑） ---------------- */

test('P2-H1 首夜阶段判定：白天安静、入夜前预警、入夜与黎明前都算夜里', () => {
  assert.equal(NIGHT_START, 0.55);
  assert.equal(NIGHT_WARNING_LEAD, 0.06, '600s 制下留 36 秒做准备');
  for (const t of [0.08, 0.25, 0.45, 0.48]) assert.equal(nightPhase(t), null, t + ' 白天不该占 HUD');
  for (const t of [NIGHT_START - NIGHT_WARNING_LEAD, 0.50, 0.52, 0.549])
    assert.equal(nightPhase(t), 'soon', t + ' 该给玩家做准备的时间');
  for (const t of [NIGHT_START, 0.6, 0.75, 0.99, 0, 0.03])
    assert.equal(nightPhase(t), 'night', t + ' 该提示避险');
  assert.equal(nightPhase(0.04), null, '黎明后回到白天');
});

test('P2-H2 首夜提示按玩家准备情况给具体下一步，不混进目标链文案', () => {
  const empty = nightHintText('soon', {});
  assert.ok(empty.includes('火把') && empty.includes('洞') && empty.includes('床'), '空手要给齐三条过夜路线');
  const ready = nightHintText('soon', { torch: true });
  assert.ok(ready.includes('已有火把') && !ready.includes('煤 + 木棍'), '有火把就不该再教做火把');
  assert.ok(nightHintText('soon', { bed: true }).includes('已有火把'));
  const out = nightHintText('night', {});
  assert.ok(out.includes('火把') && out.includes('庇护所'));
  const inside = nightHintText('night', { sheltered: true });
  assert.ok(inside.includes('亮处') && inside !== out, '屋里与露天文案要有区别');
  assert.equal(nightHintText(null, {}), '', '白天不占 HUD');
  for (const s of [empty, ready, out, inside])
    assert.ok(!s.includes('目标'), '首夜提示不该与目标链文案混在一起');
});

test('P2-H3 HUD 遮挡判据：相交 / 贴边 / 分离 / 空值', () => {
  const a = { left: 0, top: 0, width: 100, height: 40 };
  assert.equal(rectsOverlap(a, { left: 50, top: 10, width: 100, height: 40 }), true);
  assert.equal(rectsOverlap(a, { left: 100, top: 0, width: 100, height: 40 }), false, '左右刚好贴边不算侵入');
  assert.equal(rectsOverlap(a, { left: 0, top: 40, width: 100, height: 40 }), false, '上下贴边也不算');
  assert.equal(rectsOverlap(a, { left: 120, top: 0, width: 10, height: 10 }), false);
  assert.equal(rectsOverlap(null, a), false);
  assert.equal(rectsOverlap(a, null), false);
});

/* ================= 阶段 2 · 建材扩充（14 种可放置建材） =================
 * 主线口径：离开出生点后有东西可找、带回来的东西有用。这一组钉三件事：
 * ① 新 ID 全部大于旧存档里可能出现的最大 ID（55）→ 旧档原样加载不会撞号；
 * ② 每种都有中文名 / 贴图画笔 / 图标 / 创造栏可达 / 挖了会掉自己；
 * ③ 每种都有「正常生存能走通」的路径：三种火成岩靠天然分带，其余靠合成或熔炼。 */
const NEW_BUILD = ['GRANITE', 'DIORITE', 'ANDESITE', 'POLISHED_GRANITE', 'POLISHED_DIORITE', 'POLISHED_ANDESITE',
  'SMOOTH_STONE', 'MOSSY_STONE_BRICKS', 'CRACKED_STONE_BRICKS', 'CHISELED_STONE_BRICKS',
  'SMOOTH_SANDSTONE', 'CHISELED_SANDSTONE', 'CUT_SANDSTONE', 'WOOL_BLOCK'];

test('阶段2 建材扩充：14 种新方块 ID 连续且大于旧最大值，中文名/画笔/创造栏/掉落全齐', () => {
  const ids = NEW_BUILD.map(k => B[k]);
  assert.deepEqual(ids, [56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69], '新 ID 必须连续排好，别插进旧号段');
  assert.ok(Math.min(...ids) > 55, '新 ID 必须大于旧存档里可能出现的最大 ID(55)，否则旧档 diff 会错位');
  const build = CREATIVE_TABS.find(t => t.name === '建筑');
  assert.ok(build, '创造栏必须还有「建筑」这一页');
  for (let i = 0; i < NEW_BUILD.length; i++) {
    const key = NEW_BUILD[i], id = ids[i], b = BLOCKS[id];
    assert.ok(b, key + ' 必须有 BLOCKS 定义');
    assert.ok(/[一-龥]/.test(b.name), key + ' 中文名必须是中文：' + b.name);
    assert.equal(b.placeable, true, key + ' 必须可放置');
    assert.ok(b.solid !== false && b.opaque !== false, key + ' 本切片只做全方块（半砖/楼梯另列）');
    const tile = b.tiles && b.tiles.all;
    assert.ok(tile, key + ' 必须有 all 贴图名');
    assert.equal(tile, key.toLowerCase(), key + ' 贴图名要与物品 id 同名，图标才不用另画一套');
    assert.equal(typeof blockPainters[tile], 'function', key + ' 缺贴图画笔，会露出品红 missing');
    const it = blockToItem(id);
    assert.ok(it && ITEMS[it], key + ' 必须有对应方块物品');
    assert.equal(ITEMS[it].blockId, id, key + ' 物品要能放回成同一个方块');
    assert.ok(build.items.includes(it), key + ' 要出现在创造栏「建筑」页');
    assert.ok(b.tool === 'pickaxe' || b.tool === null, key + ' 石材族用镐、羊毛徒手，不该出现别的工具：' + b.tool);
    const drops = blockDrops(id, 0, () => 0.99);
    assert.deepEqual(drops.map(d => d.item), [it], key + ' 挖掘应掉自身物品，实得 ' + JSON.stringify(drops));
    const res = filterCreativeItems(b.name);
    assert.ok(res.items.includes(it), '按中文名「' + b.name + '」搜索必须命中，实得 ' + JSON.stringify(res.items.slice(0, 6)));
  }
});

test('阶段2 建材扩充：三种火成岩天然分带，其余每种都能合成或熔炼出来', () => {
  /* ① 天然生成 + 深度顺序（浅→深：花岗岩 > 闪长岩 > 安山岩） */
  const w = new VoxelWorld(20261107);
  for (let cz = 0; cz < 6; cz++) for (let cx = 0; cx < 6; cx++) w.ensureChunk(cx, cz);
  const seen = { granite: [], diorite: [], andesite: [] };
  for (const c of w.chunks.values()) {
    if (!c || c.state < 1) continue;
    for (let lz = 0; lz < CHUNK_SZ; lz++) for (let lx = 0; lx < CHUNK_SX; lx++) {
      for (let y = 2; y < WORLD_H; y++) {
        const id = c.blocks[idx(lx, y, lz)];
        if (id === B.GRANITE) seen.granite.push(y);
        else if (id === B.DIORITE) seen.diorite.push(y);
        else if (id === B.ANDESITE) seen.andesite.push(y);
      }
    }
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  for (const k of ['granite', 'diorite', 'andesite'])
    assert.ok(seen[k].length >= 30, k + ' 必须在石头里成片天然出现，实得 ' + seen[k].length + ' 格');
  assert.ok(avg(seen.granite) > avg(seen.diorite),
    '花岗岩平均深度应比闪长岩浅：' + avg(seen.granite).toFixed(1) + ' vs ' + avg(seen.diorite).toFixed(1));
  assert.ok(avg(seen.diorite) > avg(seen.andesite),
    '闪长岩平均深度应比安山岩浅：' + avg(seen.diorite).toFixed(1) + ' vs ' + avg(seen.andesite).toFixed(1));

  /* ② 其余 11 种必须有合成或熔炼路径（不能只躺在创造栏里） */
  const craftOut = new Set(RECIPES.map(r => r.result.item));
  const smeltOut = new Set(Object.values(SMELTING).map(v => v && v.output).filter(Boolean));
  const natural = new Set(['granite', 'diorite', 'andesite']);
  const missing = [];
  for (const key of NEW_BUILD) {
    const it = blockToItem(B[key]);
    if (natural.has(it)) continue;
    if (!craftOut.has(it) && !smeltOut.has(it)) missing.push(it);
  }
  assert.deepEqual(missing, [], '这些建材没有任何生存可走通的获取路径：' + missing.join(','));
  /* 熔炼链必须真的接得上：圆石→石头→平滑石头、石砖→裂石砖、沙岩→平滑沙岩 */
  assert.equal((smeltResult('stone') || {}).output, 'smooth_stone');
  assert.equal((smeltResult('stone_bricks') || {}).output, 'cracked_stone_bricks');
  assert.equal((smeltResult('sandstone') || {}).output, 'smooth_sandstone');
  /* ③ 具体网格要真能匹配（形状写错就等于玩家做不出来） */
  const gridG = [['granite', 'granite', ''], ['granite', 'granite', ''], ['', '', '']];
  assert.equal((findRecipe(gridG) || {}).result.item, 'polished_granite', '2×2 花岗岩必须能做出磨制花岗岩');
  const gridW = [['wool', 'wool', ''], ['wool', 'wool', ''], ['', '', '']];
  assert.equal((findRecipe(gridW) || {}).result.item, 'wool_block', '2×2 羊毛必须能做出羊毛块');
  const gridS = [['sandstone', 'sandstone', ''], ['', '', ''], ['', '', '']];
  assert.equal((findRecipe(gridS) || {}).result.item, 'cut_sandstone', '两格沙岩横排必须能切出切制沙岩');
});

/* ================= 阶段 1 · 分段计时总账 =================
 * 目的：把「整程时间花在哪一段」变成可断言、可跨提交对比的数字。
 * 上一轮之所以误判，就是因为只有「最近一帧」的 p.genMs/lightMs/meshMs（每帧被覆盖）
 * 与峰值 max*，而报告 blob 又是同一份 —— 只能靠累计量归因。 */
test('阶段1 分段计时：perf.totals 是整程累计，与每帧字段分开，且只增不减', () => {
  const w = new VoxelWorld(20261108);
  /* 必须走 setCenter 的流式入口：直接 ensureChunk 会把生成做在 update 之外，
     genMs/genChunks 就永远是 0，总账等于没接上。 */
  w.radius = 2;
  w.setCenter(8, 8);
  const t = w.perf.totals;
  assert.ok(t && typeof t.frameMs === 'number', 'perf.totals 必须存在');
  assert.equal(t.calls, 0, '新建世界的累计 calls 必须从 0 开始');
  assert.equal(t.genChunks, 0);
  assert.ok(w.genQueue.length > 4, '前提：setCenter 之后 genQueue 里要有待生成的区块');

  let calls = 0;
  let prevFrame = -1, prevGen = -1, prevLight = -1, prevMesh = -1;
  for (let i = 0; i < 4000 && (w.genQueue.length || w.dirtyLight.size || w.dirtyMesh.size); i++) {
    w.update(0.05, LOAD_SLICE_BUDGET, null);
    calls++;
    /* 单调：任何一段的累计都不许倒退（倒退=被覆盖或忘了累加） */
    assert.ok(t.frameMs >= prevFrame, 'frameMs 累计倒退：' + prevFrame + ' → ' + t.frameMs);
    assert.ok(t.genMs >= prevGen, 'genMs 累计倒退');
    assert.ok(t.lightMs >= prevLight, 'lightMs 累计倒退');
    assert.ok(t.meshMs >= prevMesh, 'meshMs 累计倒退');
    prevFrame = t.frameMs; prevGen = t.genMs; prevLight = t.lightMs; prevMesh = t.meshMs;
  }
  assert.equal(w.genQueue.length, 0, '队列应当排空');
  assert.equal(t.calls, calls, '累计 calls 必须等于真实调用次数，实得 ' + t.calls + ' 期望 ' + calls);
  assert.ok(t.frameMs > 0 && t.genMs > 0 && t.lightMs > 0,
    '帧 / 生成 / 补光的累计都必须 > 0，实得 ' + JSON.stringify(t));
  assert.ok(typeof t.meshMs === 'number' && t.meshMs >= 0,
    '没有 view 时网格段只做记账，但必须是数字且不倒退：' + t.meshMs);
  assert.ok(t.genChunks > 0 && t.lightChunks > 0 && t.meshChunks > 0,
    '三段处理的区块数都要有账，实得 ' + JSON.stringify(t));
  assert.ok(t.genChunks >= w.stats.generated,
    '生成区块累计不应少于世界统计（统计只在 ensureChunk 里加）：' + t.genChunks + ' vs ' + w.stats.generated);
  /* 每帧字段与总账是两回事：p.genMs 会被下一帧清零，totals 不会 */
  const before = t.genMs, beforeCalls = t.calls;
  w.update(0.05, FRAME_BUDGET, null);
  assert.ok(t.genMs >= before && t.calls === beforeCalls + 1, '空转一帧也不许把总账抹掉');
  assert.ok(t.frameMs >= t.genMs + t.lightMs + t.meshMs - 1,
    '三段之和不能超过帧总耗时（超过就是重复计时）：' + JSON.stringify(t));
});

/* 阶段 1 第二刀：生成版本的存读档语义。
 * 现在只接「字段」，不接「布局」—— 布局（负 Y、idx 偏移、岩层）在后面的提交里跟开关一起翻。
 * 这一条的作用是把「标签跑到布局前面」这种最难查的损坏挡在单测里。 */
test('阶段1 生成版本：旧档与脏值一律回落旧布局，新档开关翻之前标签不许提前', () => {
  assert.equal(GEN_LEGACY, 0, '旧布局必须是 0（旧档没有这个字段时按 0 处理）');
  assert.equal(GEN_DEEP, 1);
  /* 构造器：只有显式 GEN_DEEP 才算深地 */
  assert.equal(new VoxelWorld(1).genVersion, GEN_LEGACY, '不传 opts 必须走旧布局');
  assert.equal(new VoxelWorld(1, {}).genVersion, GEN_LEGACY);
  assert.equal(new VoxelWorld(1, { genVersion: GEN_DEEP }).genVersion, GEN_DEEP, '显式新档才走深地布局');
  /* 第二轮 C3 语义变更（原意 → 新行为 → 保留的覆盖）：
     原意「任何非 0/1 的值都算脏值，必须回落旧布局」；
     新行为：2 现在是合法的 GEN_DEEP_CHAMBERS（洞室版），布局与 GEN_DEEP 完全相同，
     只有**无法识别的值**才回落旧布局。保留的覆盖：undefined/null/-1/'1'/true/{}/NaN
     仍然逐个断言回落。 */
  assert.equal(new VoxelWorld(1, { genVersion: GEN_DEEP_CHAMBERS }).genVersion, GEN_DEEP_CHAMBERS,
    '显式洞室版必须被接受');
  assert.deepEqual(layoutByGenVersion(GEN_DEEP_CHAMBERS), layoutByGenVersion(GEN_DEEP),
    '洞室版与深地版共用同一布局（旧档索引不重排）');
  for (const dirty of [undefined, null, -1, '1', true, {}, NaN])
    assert.equal(new VoxelWorld(1, { genVersion: dirty }).genVersion, GEN_LEGACY,
      '脏值 ' + String(dirty) + ' 必须回落旧布局');
  /* meta 规则（game.js 读档用的就是它） */
  assert.equal(genVersionFromMeta({ genVersion: GEN_DEEP }), GEN_DEEP);
  assert.equal(genVersionFromMeta({ genVersion: GEN_DEEP_CHAMBERS }), GEN_DEEP_CHAMBERS,
    'C3：读档要能认出洞室版（否则新区块会按旧规则生成）');
  for (const meta of [null, undefined, {}, { genVersion: undefined }, { genVersion: null },
    { genVersion: '1' }, { genVersion: '2' }, { genVersion: GEN_LEGACY }])
    assert.equal(genVersionFromMeta(meta), GEN_LEGACY,
      'meta=' + JSON.stringify(meta) + ' 必须按旧布局读（旧档原样恢复的底线）');
  /* 总开关与布局必须同源：第 3 刀把负 Y 布局、岩层、矿脉、深洞和这个常量放在同一次提交里翻。
     以前那条「翻之前标签不许提前」的要求，现在换成更强的形式 —— **标签与布局不可能不一致**，
     因为布局只能由 layoutByGenVersion(genVersion) 得到，没有第二个入口。 */
  /* C3：新档总开关从 1 提到 2（洞室版）。布局与 1 完全相同，所以这条仍然在钉
     「总开关与布局同源」，只是版本号前进了。 */
  assert.equal(NEW_WORLD_GEN_VERSION, GEN_DEEP_CHAMBERS,
    '新档总开关必须是洞室版；布局与 GEN_DEEP 相同，旧档不受影响');
  assert.deepEqual(layoutByGenVersion(NEW_WORLD_GEN_VERSION), { minY: DEEP_MIN_Y, layers: DEEP_LAYERS },
    '洞室版也必须给 -64 起、128 格');
  assert.deepEqual(layoutByGenVersion(GEN_DEEP), { minY: DEEP_MIN_Y, layers: DEEP_LAYERS },
    'GEN_DEEP 必须给 -64 起、128 格');
  assert.deepEqual(layoutByGenVersion(GEN_LEGACY), { minY: 0, layers: WORLD_H }, 'GEN_LEGACY 必须仍是 0..63');
  assert.deepEqual(layoutByGenVersion(undefined), { minY: 0, layers: WORLD_H }, '脏标签只能回落旧布局');
  assert.equal(DEEP_MIN_Y, -64);
  assert.equal(DEEP_LAYERS, 128);
  assert.equal(WORLD_H - DEEP_MIN_Y, DEEP_LAYERS, '顶不动（还是 64），只把下界扩 64 格');

  const wDeep = new VoxelWorld(4242, { genVersion: GEN_DEEP });
  const wOld = new VoxelWorld(4242, { genVersion: GEN_LEGACY });
  for (const [w, minY, layers] of [[wDeep, DEEP_MIN_Y, DEEP_LAYERS], [wOld, 0, WORLD_H]]) {
    assert.equal(w.minY, minY);
    assert.equal(w.layers, layers);
    assert.equal(w.topY, WORLD_H, '世界顶不许因为扩高而移动（地表尺度不变）');
    assert.equal(w.terrain.deep, minY < 0, 'terrain 的 deep 标志必须跟布局同步');
    const c = w.ensureChunk(0, 0);
    assert.equal(c.minY, minY, '区块必须真的按布局分配');
    assert.equal(c.layers, layers);
    assert.equal(c.blocks.length, CHUNK_AREA * layers);
    assert.equal(c.light.length, CHUNK_AREA * layers);
  }
  assert.equal(wDeep.getBlock(0, DEEP_MIN_Y - 1, 0), B.BEDROCK, '布局下界以下仍然是基岩，不存在虚空');
  assert.equal(wDeep.setBlock(0, DEEP_MIN_Y - 1, 0, B.STONE), false, '下界以外拒绝写入');
  assert.equal(wDeep.setBlock(0, WORLD_H, 0, B.STONE), false, '上界以外拒绝写入');
  assert.equal(wOld.getBlock(8, -1, 8), B.BEDROCK, '旧档负 Y 一律读成基岩（与改造前一致）');
  /* 显式 layout 只用于测试覆盖，但优先级要写清楚：它压过 genVersion 推出的默认布局 */
  const wOverride = new VoxelWorld(1, { genVersion: GEN_LEGACY, layout: { minY: -8, layers: 72 } });
  assert.equal(wOverride.minY, -8);
  assert.equal(wOverride.layers, 72);
  assert.equal(wOverride.topY, 64);
});

test('阶段1 索引参数化：旧布局指纹逐位不变（旧档地形/光照/接缝的底线常数）', async () => {
  /* 这一条钉的是「旧档原样恢复」的最强证据：6 个种子 × 25 个区块的
     blocks/meta/light/heightMap/biome 全数组 + 网格采样器在整块与四条接缝、
     布局上下各越界 2 格的返回值 + 挖掘放置后的 serializeEdits()，
     压成一个 FNV-1a 哈希。第 2 刀（把 idx/WORLD_H 换成按区块 minY/layers/topY）
     必须逐位不变 —— 手工比对几万格数据不现实，常数才是可复跑的对照。 */
  const LEGACY_FP = '32b60181';
  const legacy = await runFingerprint();
  assert.equal(legacy.warnings.length, 0, '布局外写入必须被拒绝：' + legacy.warnings.join(' / '));
  assert.deepEqual(legacy.layout, { genVersion: 0, minY: 0, topY: WORLD_H, layers: WORLD_H },
    '默认布局必须仍是 0..' + (WORLD_H - 1));
  assert.equal(legacy.hash, LEGACY_FP,
    '旧布局指纹变了 = 旧存档的地形/光照/网格会跟着变。若这是有意的行为改动（例如第 3 刀只动新档），' +
    '先确认 gen="deep" 那条允许变、而这里读的仍是 GEN_LEGACY 路径，再用 ' +
    'node tests/layout-fingerprint.mjs 重新取常数并在提交说明里写清改了哪一段。');

  /* 第 3 刀之后：deep 必须**真的变深**，而 legacy 必须**一字不变**。
     这正是「同一份代码同时容纳新旧两种布局」的可验证形式。 */
  const deep = await runFingerprint(undefined, 'deep');
  assert.deepEqual(deep.layout, { genVersion: 1, minY: DEEP_MIN_Y, topY: WORLD_H, layers: DEEP_LAYERS },
    'deep 指纹必须走 -64..63 共 128 格的布局');
  assert.equal(deep.warnings.length, 0, 'deep 布局外写入也必须被拒绝：' + deep.warnings.join(' / '));
  assert.notEqual(deep.hash, LEGACY_FP,
    'deep 指纹与旧布局相同 = 新档根本没变深（总开关或 terrain 的 deep 分支失效）');
  /* deep 的具体指纹**不钉常数**：阶段 3a/3b/4/5 还会调岩层与矿脉分带，
     钉住只会逼人为了绿而改常数。要回归时看上面这条「等于/不等于」。 */
});

/* ================= 阶段 1 第 3 刀：负 Y 深地布局 ================= */

/* 四根审计柱的 seedText 与取样坐标沿用 3528ea9 的更正记录。
   **必须走 normalizeSeed()**：直接把字符串交给 TerrainGen 会被 `>>> 0` 变成种子 0，
   四根柱子量出来是另一组数字（上一轮就踩过这个坑）。
   legacyDepth 是「改前」实测的地表到第一层基岩格数，这一刀不许把它挪动一格。 */
const AUDIT_COLUMNS = [
  { text: 'visual-audit-2026', x: 2, z: 34, legacyDepth: 28 },
  { text: '12345', x: 4, z: 0, legacyDepth: 45 },
  { text: 'survival-01', x: 4, z: 9, legacyDepth: 29 },
  { text: '深矿', x: -25, z: 13, legacyDepth: 50 }
];

function aroundColumn(w, x, z, r) {
  const cx = x >> 4, cz = z >> 4;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) w.ensureChunk(cx + dx, cz + dz);
  return w;
}
function firstBedrockBelow(w, x, z, fromY, toY) {
  for (let y = fromY; y >= toY; y--) if (w.getBlock(x, y, z) === B.BEDROCK) return y;
  return null;
}

test('阶段1 深地布局：新档四柱都挖得到 80 格以上、三层岩齐全，旧档读数一格都不许变', () => {
  for (const a of AUDIT_COLUMNS) {
    const seed = normalizeSeed(a.text);
    const w = aroundColumn(new VoxelWorld(seed, { genVersion: GEN_DEEP }), a.x, a.z, 1);
    const surf = w.topSolidY(a.x, a.z);
    const bed = firstBedrockBelow(w, a.x, a.z, WORLD_H - 1, DEEP_MIN_Y);
    assert.ok(bed !== null, a.text + ' 一路到底都没摸到基岩带，深地布局没生效');
    assert.ok(bed >= DEEP_MIN_Y && bed <= DEEP_MIN_Y + 3,
      a.text + ' 第一层基岩应在底部 4 格带内（-64..-61），实得 y=' + bed);
    assert.ok(surf - bed >= 80,
      a.text + ' 地表到第一层基岩只有 ' + (surf - bed) + ' 格，任务书要求新档至少 80 格');

    /* 三层岩：石头在上、深板岩在下、基岩贴底。深板岩界是噪声曲面，所以只断言「顺序」而不是平面高度 */
    let stoneMin = 999, stoneMax = -999, dsMin = 999, dsMax = -999, soilSeen = false;
    for (let y = surf - 1; y >= DEEP_MIN_Y; y--) {
      const id = w.getBlock(a.x, y, a.z);
      if (id === B.STONE) { stoneMin = Math.min(stoneMin, y); stoneMax = Math.max(stoneMax, y); }
      else if (id === B.DEEPSLATE) { dsMin = Math.min(dsMin, y); dsMax = Math.max(dsMax, y); }
      else if (id === B.DIRT || id === B.GRASS || id === B.SAND || id === B.SANDSTONE || id === B.GRAVEL) soilSeen = true;
    }
    assert.ok(soilSeen, a.text + ' 地表上层土壤/砂层不见了');
    assert.ok(stoneMax > -999 && dsMax > -999, a.text + ' 石头层或深板岩层缺失（石头 ' + stoneMax + ' 深板岩 ' + dsMax + '）');
    assert.ok(dsMax < stoneMin, a.text + ' 深板岩必须在石头层以下：深板岩最高 ' + dsMax + '，石头最低 ' + stoneMin);
    assert.ok(dsMax < 0, a.text + ' 深板岩层顶应当整体在 y<0，实得 ' + dsMax);
    for (let y = DEEP_MIN_Y + 4; y <= bed + 20; y++)
      assert.notEqual(w.getBlock(a.x, y, a.z), B.BEDROCK,
        a.text + ' 基岩不该出现在底部带以外（y=' + y + '）');

    /* 同一颗子的旧档：地表一格不动、柱深还是改前那个数、永远不会有深板岩 */
    const wl = aroundColumn(new VoxelWorld(seed, { genVersion: GEN_LEGACY }), a.x, a.z, 1);
    assert.equal(wl.topSolidY(a.x, a.z), surf, a.text + ' 扩高把地表也一起改了（旧档地表必须一字不变）');
    const bedL = firstBedrockBelow(wl, a.x, a.z, WORLD_H - 1, 0);
    assert.equal(surf - bedL, a.legacyDepth,
      a.text + ' 旧档柱深从 ' + a.legacyDepth + ' 变成了 ' + (surf - bedL) + '（旧档必须原样）');
    assert.equal(wl.getBlock(a.x, -1, a.z), B.BEDROCK, a.text + ' 旧档负 Y 只能读成基岩');
    for (let y = WORLD_H - 1; y >= 0; y--)
      assert.notEqual(wl.getBlock(a.x, y, a.z), B.DEEPSLATE, a.text + ' 旧档不该长出深板岩（y=' + y + '）');
  }
});

test('阶段1 深地洞穴：新档四根柱子的出生点附近都能找到连片可步行的深洞', () => {
  const air = (w, x, y, z) => w.getBlock(x, y, z) === AIR;
  const standableFloor = (w, x, y, z) => {
    const id = w.getBlock(x, y, z);
    if (id === AIR || id === B.WATER || id === B.BEDROCK) return null;
    if (!air(w, x, y + 1, z) || !air(w, x, y + 2, z)) return null;
    return y;
  };
  /* 「可步行」按玩家实际感受判定：站在洞底，沿 +x 每步允许地板升/降 1 格（本作台阶高度），
     新地板上方始终要有 2 格净空。连续 12 步以上才算「能走进去探索」，而不是一个针孔。 */
  const walkRun = (w, x, y, z, max) => {
    let run = 1, cy = y;
    for (let k = 1; k <= max; k++) {
      const nx = x + k;
      let nf = null;
      for (let d = 1; d >= -1; d--) { if (standableFloor(w, nx, cy + d, z) !== null) { nf = cy + d; break; } }
      if (nf === null) break;
      cy = nf; run++;
    }
    return run;
  };

  for (const a of AUDIT_COLUMNS) {
    const w = new VoxelWorld(normalizeSeed(a.text), { genVersion: GEN_DEEP });
    for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) w.ensureChunk(cx, cz);
    let best = 0, spot = null;
    for (let y = DEEP_MIN_Y + 9; y <= -9; y++) {
      for (let z = -20; z <= 20; z += 2) {
        for (let x = -20; x <= 20; x += 2) {
          if (standableFloor(w, x, y, z) === null) continue;
          const r = walkRun(w, x, y, z, 20);
          if (r > best) { best = r; spot = { x, y, z, floor: w.getBlock(x, y, z) }; }
          if (best >= 21) { y = 99; break; }        // 已经扫到上限，早点收工
        }
        if (best >= 21) break;
      }
    }
    assert.ok(best >= 12, a.text + ' 出生点 ±20 内找不到可步行的深洞（最长连走 ' + best + ' 格，要求 ≥12）');
    assert.ok(spot.y < 0, a.text + ' 深洞地板必须在 y<0，实得 ' + spot.y);
    assert.notEqual(spot.floor, B.BEDROCK, a.text + ' 洞底不许是基岩（否则挖不动也站不住）');
    /* 净空确实有 2 格：头上一格与上两格都是空气 */
    assert.equal(air(w, spot.x, spot.y + 1, spot.z), true);
    assert.equal(air(w, spot.x, spot.y + 2, spot.z), true);

    /* 浅洞带不能因为扩高而消失 */
    let shallowAir = 0;
    for (let y = 4; y <= 44; y += 4) for (let z = -20; z <= 20; z += 4) for (let x = -20; x <= 20; x += 4)
      if (air(w, x, y, z)) shallowAir++;
    assert.ok(shallowAir > 8, a.text + ' 扩高之后浅洞带反而没空气了，实得 ' + shallowAir + ' 个采样点');
  }

  /* 旧布局同一个种子：既不长深板岩，也不会在负 Y 出现任何空气 */
  const wl = new VoxelWorld(normalizeSeed('深矿'), { genVersion: GEN_LEGACY });
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) wl.ensureChunk(cx, cz);
  for (let y = 0; y < WORLD_H; y++) for (let z = -8; z <= 8; z += 2) for (let x = -8; x <= 8; x += 2)
    assert.notEqual(wl.getBlock(x, y, z), B.DEEPSLATE, '旧档长出深板岩（' + x + ',' + y + ',' + z + '）');
  for (let z = -8; z <= 8; z++) for (let x = -8; x <= 8; x++)
    assert.notEqual(wl.getBlock(x, -1, z), AIR, '旧档负 Y 居然有空气（' + x + ',' + z + '）');
});

test('阶段1 深地矿脉分带：钻石金青金集中到 y<0，煤铁浅部照常；旧档矿产一个都不许掉进负 Y', () => {
  const seed = normalizeSeed('深矿');
  const w = new VoxelWorld(seed, { genVersion: GEN_DEEP });
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w.ensureChunk(cx, cz);
  const NAMES = {
    [B.COAL_ORE]: 'coal', [B.IRON_ORE]: 'iron', [B.GOLD_ORE]: 'gold', [B.LAPIS_ORE]: 'lapis',
    [B.DIAMOND_ORE]: 'diamond', [B.EMERALD_ORE]: 'emerald', [B.GRANITE]: 'granite',
    [B.DIORITE]: 'diorite', [B.ANDESITE]: 'andesite'
  };
  const up = {}, down = {};
  for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++) {
    for (let y = WORLD_H - 1; y >= DEEP_MIN_Y; y--) {
      const n = NAMES[w.getBlock(x, y, z)];
      if (!n) continue;
      (y < 0 ? down : up)[n] = ((y < 0 ? down : up)[n] || 0) + 1;
    }
  }
  /* 深部回报：负 Y 必须有钻石/金/青金石，而且它们主要分布在负 Y */
  for (const n of ['diamond', 'gold', 'lapis']) {
    assert.ok((down[n] || 0) > 0, '新档 y<0 找不到 ' + n + '（深部要有挖下去的理由），实得 ' + JSON.stringify(down));
    const d = down[n] || 0, u = up[n] || 0;
    assert.ok(d >= u, n + ' 应当集中在深部：y<0 得 ' + d + '，y>=0 得 ' + u);
  }
  /* 浅部照常：煤与铁在 y>=0 仍然是主力（不能被整体挪到深部） */
  assert.ok((up.coal || 0) > 50, '浅部煤太少，实得 ' + JSON.stringify(up));
  assert.ok((up.iron || 0) > 20, '浅部铁太少，实得 ' + JSON.stringify(up));
  /* 火成岩三道分带的顺序仍然成立（浅→深：花岗岩 > 闪长岩 > 安山岩的中位数高度） */
  const medY = (id) => {
    const ys = [];
    for (let x = -16; x < 32; x += 2) for (let z = -16; z < 32; z += 2)
      for (let y = WORLD_H - 1; y >= DEEP_MIN_Y; y--) if (w.getBlock(x, y, z) === id) ys.push(y);
    ys.sort((a, b) => a - b);
    return ys.length ? ys[Math.floor(ys.length / 2)] : null;
  };
  const [g, d2, a2] = [medY(B.GRANITE), medY(B.DIORITE), medY(B.ANDESITE)];
  assert.ok(g !== null && d2 !== null && a2 !== null, '三种火成岩有一种在新区间里绝迹了');
  assert.ok(g > d2 && d2 > a2, '火成岩分带顺序反了：花岗岩中位 ' + g + ' 闪长岩 ' + d2 + ' 安山岩 ' + a2);

  /* 旧档：矿脉表还是原来那一张，负 Y 一个矿都不该有（旧布局根本没有负 Y） */
  const wl = new VoxelWorld(seed, { genVersion: GEN_LEGACY });
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) wl.ensureChunk(cx, cz);
  let oldDown = 0;
  for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++)
    for (let y = -1; y >= DEEP_MIN_Y; y--) if (NAMES[wl.getBlock(x, y, z)]) oldDown++;
  assert.equal(oldDown, 0, '旧档负 Y 读出了矿产，说明越界判断漏了');
});

test('阶段1 负 Y 生存：掉出世界的判据跟着布局走，深地玩家站在 y=-30 不许当场暴死', () => {
  /* 这一条是取证截图撞出来的真 bug：controller 原来写死 `pos.y < -8` 判「掉出世界」，
     那是旧布局（底部 0 再往下 8 格）的数值。新档底部在 -64，玩家正常挖到 -9 就当场死亡，
     生存模式下深地完全不可玩。判据必须读 world.minY。 */
  const blank = { keyW: false, keyA: false, keyS: false, keyD: false, jump: false, sprint: false, sneak: false };
  const step = (c, n) => { for (let i = 0; i < n; i++) c.update(0.02, blank); };

  const deep = new VoxelWorld(2424, { genVersion: GEN_DEEP });
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) deep.ensureChunk(cx, cz);
  const cd = new PlayerController(deep);
  cd.setCreative(false);
  let cdDeaths = [];
  cd.on('death', (r) => cdDeaths.push(r));
  cd.health = 20;
  cd.pos.x = 8.5; cd.pos.y = -30; cd.pos.z = 8.5; cd.vel.y = -2;
  step(cd, 40);
  assert.equal(cdDeaths.length, 0, '深地玩家在 y=-30 附近不该被判掉出世界');
  assert.equal(cd.health, 20, '血量不该被掉出世界清零');
  cd.pos.y = -70;                            // 还在 minY-8(-72) 之上：不算掉出世界
  step(cd, 2);
  assert.equal(cdDeaths.length, 0, '深地 y=-70（minY-6）还不该死');

  /* 真世界里玩家其实到不了 minY-8：布局以下 getBlock 一律是基岩，会被顶回去。
     所以「阈值跟着布局走」用一整列空气的桩世界来证明 —— 同一个 update() 代码路径。 */
  const airStub = (minY) => ({
    minY, topY: WORLD_H, seaLevel: SEA_LEVEL,
    getBlock: () => AIR, getChunkAt: () => ({ state: 2 }), isSolidAt: () => false
  });
  const cAir = new PlayerController(airStub(DEEP_MIN_Y));
  cAir.setCreative(false);
  const airDeaths = [];
  cAir.on('death', (r) => airDeaths.push(r));
  cAir.health = 20;
  cAir.pos.x = 8.5; cAir.pos.y = -30; cAir.pos.z = 8.5;
  step(cAir, 4);
  assert.equal(airDeaths.length, 0, '深地桩世界：y=-30 自由落体不该死（旧代码在这里已经判死）');
  cAir.pos.y = DEEP_MIN_Y - 9;
  step(cAir, 1);
  assert.equal(airDeaths.length, 1, '掉到 minY-8 以下必须算掉出世界');
  assert.equal(airDeaths[0], '掉出世界');
  /* 同一个桩把 minY 换成 0（旧布局）→ 判据就该回到 -8，证明阈值确实是从布局来的 */
  const cOld = new PlayerController(airStub(0));
  cOld.setCreative(false);
  const oldD = [];
  cOld.on('death', (r) => oldD.push(r));
  cOld.health = 20;
  cOld.pos.x = 8.5; cOld.pos.y = -7; cOld.pos.z = 8.5;
  /* 桩里全是空气，玩家会一路加速，所以「不该死」的探针只走 2 步 ——
     测的是阈值本身，不是「摔得够不够远」。 */
  step(cOld, 2);
  assert.equal(oldD.length, 0, '旧布局桩：y=-7 不该死');
  cOld.pos.y = -9;
  step(cOld, 1);
  assert.equal(oldD.length, 1, '旧布局桩：y=-9 必须照旧判掉出世界（判据仍是 -8）');

  const old = new VoxelWorld(2424, { genVersion: GEN_LEGACY });
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) old.ensureChunk(cx, cz);
  const co = new PlayerController(old);
  co.setCreative(false);
  const coDeaths = [];
  co.on('death', (r) => coDeaths.push(r));
  co.health = 20;
  co.pos.x = 8.5; co.pos.y = -7; co.pos.z = 8.5; co.vel.y = -1;
  step(co, 10);
  assert.equal(coDeaths.length, 0, '旧档 y=-7 不该死（判据仍是 -8，与改造前一致）');
  co.pos.y = -9;
  step(co, 1);                    // 这条判据是「每一步都判」，不是一次性标记，所以只走 1 步
  assert.equal(coDeaths.length, 1, '旧档 y=-9 必须照旧判掉出世界');
});

test('阶段1 深板岩族：新号段 70/71 注册齐全，熔炼是唯一建材路线，硬度确实比石头高一档', () => {
  const ids = [B.DEEPSLATE, B.POLISHED_DEEPSLATE];
  assert.deepEqual(ids, [70, 71], '新 ID 必须紧接阶段 2 的 69 往后排，别插进旧号段');
  assert.ok(Math.min(...ids) > 69, '必须大于既有存档可能出现的最大 ID(69)，否则旧档 diff 键会错位');
  const build = CREATIVE_TABS.find(t => t.name === '建筑');
  for (const [key, id] of [['deepslate', B.DEEPSLATE], ['polished_deepslate', B.POLISHED_DEEPSLATE]]) {
    const b = BLOCKS[id];
    assert.ok(b, key + ' 必须有 BLOCKS 定义');
    assert.ok(/[一-龥]/.test(b.name), key + ' 中文名必须是中文：' + b.name);
    assert.equal(b.placeable, true, key + ' 必须可放置');
    assert.ok(b.solid !== false && b.opaque !== false, key + ' 只做全方块');
    assert.equal(b.tiles.all, key, key + ' 贴图名要与物品 id 同名');
    assert.equal(typeof blockPainters[b.tiles.all], 'function', key + ' 缺贴图画笔会露出品红');
    assert.equal(b.tool, 'pickaxe', key + ' 石材族必须用镐');
    const it = blockToItem(id);
    assert.ok(it && ITEMS[it] && /[一-龥]/.test(ITEMS[it].name), key + ' 要有中文名的方块物品');
    assert.equal(ITEMS[it].blockId, id, key + ' 物品要能放回成同一个方块');
    assert.ok(build.items.includes(it), key + ' 要出现在创造栏「建筑」页');
    assert.deepEqual(blockDrops(id, 0, () => 0.99).map(d => d.item), [it], key + ' 挖掘应掉自身');
    assert.ok(filterCreativeItems(b.name).items.includes(it), '按中文名「' + b.name + '」搜不到');
  }
  /* 熔炼是磨制深板岩的唯一获取路线；磨制出来的不能再烧（不许出现链式产物） */
  assert.equal(smeltResult('deepslate').output, 'polished_deepslate', '深板岩必须能烧成磨制深板岩');
  assert.equal(smeltResult('polished_deepslate'), null, '磨制深板岩不该还能再熔炼');
  /* 硬度比石头高一档：同一把石镐下明显更慢。
     breakTime(id, toolItem, instant) —— 第二个参数是**工具物品定义**，不是 meta（踩过一次）。 */
  const pick = ITEMS['pickaxe_stone'];
  assert.ok(pick && pick.toolType === 'pickaxe', '测试前提：石镐必须是镐');
  const tStone = breakTime(B.STONE, pick), tDeep = breakTime(B.DEEPSLATE, pick);
  assert.ok(tDeep > tStone, '深板岩必须比石头难挖：' + tDeep.toFixed(2) + ' vs ' + tStone.toFixed(2));
  assert.ok(tDeep < Infinity, '木镐等级就能采，不许出现挖不动');
  /* 徒手也能挖掉（掉落门控在 interaction.finishBreak 的 canHarvest 里，与石头同一套规则），
     所以这里只钉「掉落表给的是本体」，不拿 blockDrops 当采集门控（它只有 id/meta/rand 三个参数）。 */
  assert.deepEqual(blockDrops(B.DEEPSLATE, 0, () => 0.99), [{ item: 'deepslate', count: 1 }]);
});

test('阶段1 负 Y 存读档：序列化往返原样恢复，且旧布局读同一份数据必定串位', () => {
  const seed = 4321;
  const cells = [
    [8, -20, 8, AIR],            // 挖空一格深板岩
    [9, -33, 9, B.POLISHED_DEEPSLATE],
    [-25, -60, 13, B.STONE_BRICKS],   // 跨到另一块区块的负 Y
    [0, 40, 0, B.TORCH]
  ];
  const w = new VoxelWorld(seed, { genVersion: GEN_DEEP });
  for (const [x, y, z, id] of cells) {
    aroundColumn(w, x, z, 1);
    assert.equal(w.setBlock(x, y, z, id), true, '负 Y 写入被拒绝：' + [x, y, z]);
  }
  const data = w.serializeEdits();
  /* 键就是新布局下标：x + z*16 + (世界y - (-64))*256。这一条把「diff 键与布局同版本」钉死。 */
  const kDeep = idx(9 - (9 >> 4) * 16, -33, 9 - (9 >> 4) * 16, DEEP_MIN_Y);
  assert.equal(kDeep, 9 + 9 * 16 + 31 * CHUNK_AREA);
  assert.ok(Object.keys(data).length > 0, '改动一条都没序列化出来');

  const w2 = new VoxelWorld(seed, { genVersion: GEN_DEEP });
  w2.applySavedData(data);
  for (const [x, y, z, id] of cells) {
    aroundColumn(w2, x, z, 1);
    assert.equal(w2.getBlock(x, y, z), id, '读档后 (' + x + ',' + y + ',' + z + ') 应为 ' + id + '，实得 ' + w2.getBlock(x, y, z));
  }
  /* 再存一次必须还是同一份数据（往返幂等，否则反复存读会漂移） */
  assert.deepEqual(w2.serializeEdits(), data, '负 Y 改动往返不幂等');

  /* 反面对照：这份数据喂给旧布局的世界会**串到别的格子上** ——
     这正是 meta.genVersion 必须写进存档、读档必须按它选布局的原因。 */
  const wOld = new VoxelWorld(seed, { genVersion: GEN_LEGACY });
  wOld.applySavedData(data);
  aroundColumn(wOld, 9, 9, 1);
  assert.equal(wOld.getBlock(9, -33, 9), B.BEDROCK, '旧布局读深地数据居然落回了同一格');
  const asLegacyY = Math.floor((9 + 9 * 16 + 31 * CHUNK_AREA) / CHUNK_AREA);
  assert.equal(asLegacyY, 31);
});

/* ================= 阶段 3a：成群游动的鱼 ================= */

test('阶段3a 鳕鱼注册：水生、不进取食/夜间刷怪池、生熟鱼与熔炼路线齐全', () => {
  const def = MOB_TYPES.cod;
  assert.ok(def, 'MOBS 里必须有 cod');
  assert.equal(def.aquatic, true, 'cod 必须标成水生（physics/AI 的水生分支全靠这个标志）');
  assert.ok(/[一-龥]/.test(def.name), '中文名必须齐全：' + def.name);
  assert.ok(!def.hostile && def.passive, '鱼是被动的，不许进敌对池');
  assert.equal(DAY_TYPES.includes('cod'), false, 'cod 不许进白天陆上刷怪池（那套选点要求 h > 海平面）');
  assert.equal(NIGHT_TYPES.includes('cod'), false, 'cod 不许进夜间刷怪池');
  assert.deepEqual(AQUATIC_TYPES, ['cod']);
  assert.ok(def.drop && def.drop[0] && def.drop[0].item === 'fish_raw', '第一掉落必须是生鱼');
  const parts = def.parts();
  const names = parts.map(p => p.part);
  assert.ok(names.includes('tail') && names.includes('head'), '必须有独立尾鳍部件，摆尾才不用转身体');
  assert.ok(names.includes('finL') && names.includes('finR'), '两条胸鳍（摆起来才有「游」的样子）');
  /* 头在 +Z：与其余生物同一套正面约定（D3 钉死 mesh.rotation.y 只由 yaw 决定） */
  const head = parts.find(p => p.part === 'head');
  assert.ok(head.pos[2] > 0, '头必须摆在 +Z（正面），否则鱼会倒着游');
  const tail = parts.find(p => p.part === 'tail');
  assert.ok(tail.pos[2] < 0, '尾鳍必须在身体后方');

  assert.ok(ITEMS.fish_raw && ITEMS.fish_cooked, '生鱼/熟鱼物品都要存在');
  assert.ok(/[一-龥]/.test(ITEMS.fish_raw.name) && /[一-龥]/.test(ITEMS.fish_cooked.name), '食物名字要中文');
  assert.equal(ITEMS.fish_raw.smeltTo, 'fish_cooked');
  assert.equal(smeltResult('fish_raw').output, 'fish_cooked', '熔炼路线必须接进 SMELTING 表');
  assert.equal(smeltResult('fish_cooked'), null, '熟鱼不能再熔');
  assert.ok(ITEMS.fish_raw.food > 0 && ITEMS.fish_cooked.food > ITEMS.fish_raw.food, '熟食要比分食管用（与牛排同一套逻辑）');
  const food = CREATIVE_TABS.find(t => t.name === '食物');
  assert.ok(food.items.includes('fish_raw') && food.items.includes('fish_cooked'), '创造栏「食物」页要能拿到');
  assert.equal(typeof itemPainters.fish_raw, 'function', '生鱼缺图标会露出品红');
  assert.equal(typeof itemPainters.fish_cooked, 'function', '熟鱼缺图标会露出品红');

  /* computePose 的新字段：只新增 finSwim，既有输出一字不动；摆幅随 moving 变大 */
  const idle = computePose({ animAttack: 0, hurtT: 0, age: 1.2, moving: false, animIdle: 0.4, def });
  const swim = computePose({ animAttack: 0, hurtT: 0, age: 1.2, moving: true, animIdle: 0.4, def });
  assert.ok(typeof idle.finSwim === 'number' && typeof swim.finSwim === 'number', '必须有 finSwim');
  assert.ok(Math.abs(swim.finSwim) >= Math.abs(idle.finSwim), '游动时摆幅不该比停着小');
  assert.ok(Math.abs(swim.finSwim) <= 0.6, '摆幅要有界（尾巴不许甩成螺旋桨）');
  assert.equal(swim.headYaw === undefined, true, 'D3：姿态不得产出新的朝向字段');
});

test('阶段3a 鱼群站点确定性：同种子同格同结果、条数与落点有界、约四成格子有群', () => {
  const seed = 20261107;
  const a = fishSchoolOf(seed, 3, -2), b = fishSchoolOf(seed, 3, -2);
  assert.deepEqual(a, b, '纯函数：同种子同站点必须一字不差地一样（读档后鱼群才回得来）');
  assert.notDeepEqual(fishSchoolOf(seed, 3, -2), fishSchoolOf(seed + 1, 3, -2), '换种子要真的换布局');
  let sites = 0, total = 0, minCount = 99, maxCount = 0;
  for (let sz = -6; sz <= 6; sz++) for (let sx = -6; sx <= 6; sx++) {
    const s = fishSchoolOf(seed, sx, sz);
    total++;
    if (!s) continue;
    sites++;
    minCount = Math.min(minCount, s.count); maxCount = Math.max(maxCount, s.count);
    assert.ok(s.count >= FISH_SCHOOL_MIN && s.count <= FISH_SCHOOL_MAX, '一群的数量必须在界内：' + s.count);
    assert.ok(s.x >= sx * FISH_SITE_STEP && s.x < (sx + 1) * FISH_SITE_STEP, '站点中心必须落在自己那一格里');
    assert.ok(s.z >= sz * FISH_SITE_STEP && s.z < (sz + 1) * FISH_SITE_STEP, '站点中心必须落在自己那一格里');
  }
  const rate = sites / total;
  assert.ok(rate > 0.25 && rate < 0.6, '有群的格子要适中（实测约 42%），实得 ' + rate.toFixed(3));
  assert.ok(maxCount > minCount, '不同站点的数量要有差异，不然「成群」是写死的');
});

test('阶段3a 自然生成：鱼只出现在深水、成群、全在水里、会游动，离水才窒息', () => {
  const w = new VoxelWorld(20261107, { genVersion: GEN_DEEP });
  /* 找一处真海洋列（地表低于海平面 ≥ 3 格），并把所在区块生成出来 */
  let ocean = null;
  for (let z = -8; z <= 200 && !ocean; z += 4) {
    for (let x = -8; x <= 200; x += 4) {
      const h = w.surfaceHeight(x, z);
      if (w.seaLevel - h >= FISH_WATER_DEPTH + 1) { ocean = { x, z, h }; break; }
    }
  }
  assert.ok(ocean, '这颗子必须能找到海洋列');
  w.ensureChunk(ocean.x >> 4, ocean.z >> 4);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) w.ensureChunk((ocean.x >> 4) + dx, (ocean.z >> 4) + dz);

  const controller = { pos: { x: ocean.x + 0.5, y: w.seaLevel + 1, z: ocean.z + 0.5 } };
  const ctx = {
    world: w, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } },
    controller, inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
  };
  const mm = new MobManager(ctx);

  /* ① 深水判定：海洋列通过，陆上列拒绝 */
  const deep = mm.fishWaterAt(ocean.x + 0.5, ocean.z + 0.5);
  assert.ok(deep, '海洋列必须判为可住鱼');
  assert.ok(deep.y <= w.seaLevel - 1 && deep.y > ocean.h, '游动深度要在水面下一格与河底之上，实得 ' + deep.y);
  let land = null;
  for (let z = 0; z <= 120 && !land; z += 3) for (let x = 0; x <= 120; x += 3) {
    const h = w.surfaceHeight(x, z);
    if (h > w.seaLevel + 2) { land = { x, z }; break; }
  }
  assert.ok(land && mm.fishWaterAt(land.x + 0.5, land.z + 0.5) === null, '岸上/高地必须判为「不住鱼」');

  /* ② 自然生成：不手动 spawn，只让站点扫描干活 */
  const site = fishSchoolOf(w.seed, Math.floor(controller.pos.x / FISH_SITE_STEP), Math.floor(controller.pos.z / FISH_SITE_STEP));
  const made = mm.spawnFishSchools();
  const cods = mm.list.filter(m => m.type === 'cod');
  if (!made || cods.length === 0) {
    // 玩家所在格子的站点可能没鱼：换到已验证的深水列再看一次（站点是纯函数，位置可算）
    const sx = Math.floor((ocean.x + 0.5) / FISH_SITE_STEP), sz = Math.floor((ocean.z + 0.5) / FISH_SITE_STEP);
    const s2 = fishSchoolOf(w.seed, sx, sz);
    assert.ok(s2, '兜底：这一列所在的站点格必须有鱼群站点，否则本用例前提不成立');
    controller.pos.x = s2.x; controller.pos.z = s2.z;
    assert.ok(mm.spawnFishSchools(), '把玩家搬到有站点的深水格上必须刷出一群鱼');
  }
  const fish = mm.list.filter(m => m.type === 'cod');
  assert.ok(fish.length >= FISH_SCHOOL_MIN,
    '必须成群（≥' + FISH_SCHOOL_MIN + ' 条），实得 ' + fish.length + '（站点 ' + JSON.stringify(site) + '）');
  assert.ok(fish.length <= FISH_MAX_ALIVE, '总数不许超过上限');
  for (const f of fish) {
    assert.equal(w.getBlock(Math.floor(f.pos.x), Math.floor(f.pos.y), Math.floor(f.pos.z)), B.WATER,
      '每条鱼都必须生在水里（' + f.pos.x.toFixed(1) + ',' + f.pos.y + ',' + f.pos.z.toFixed(1) + '）');
    assert.ok(Math.hypot(f.pos.x - f.homeX, f.pos.z - f.homeZ) <= 4.5, '不许刷到站点 4.5 格之外');
    assert.ok(f.school, '每条鱼要带站点键（去重用）');
  }

  /* ③ 会游动：推进若干帧，至少有一条真的挪了位置 */
  const before = fish.map(f => ({ x: f.pos.x, y: f.pos.y, z: f.pos.z }));
  for (let i = 0; i < 240; i++) mm.update(1 / 60, 1);
  let moved = 0, stillInWater = 0;
  for (let i = 0; i < fish.length; i++) {
    const f = fish[i];
    if (Math.hypot(f.pos.x - before[i].x, f.pos.z - before[i].z) > 0.15) moved++;
    if (w.getBlock(Math.floor(f.pos.x), Math.floor(f.pos.y), Math.floor(f.pos.z)) === B.WATER) stillInWater++;
  }
  assert.ok(moved >= 1, '240 帧后至少要有一条鱼游动过，实得 ' + moved);
  assert.ok(stillInWater === fish.length, '游动之后仍要全部待在水里（不许上岸散步），实得 ' + stillInWater + '/' + fish.length);

  /* ④ 离水窒息：超过 FISH_AIR_SECONDS 才掉血；同一时间陆上生物不受这条规则影响 */
  const f0 = fish[0];
  f0.inWater = 0; f0.airT = FISH_AIR_SECONDS - 0.5; f0.hp = f0.maxHp;
  const hpA = f0.hp;
  for (let i = 0; i < 60; i++) { f0.inWater = 0; mm.update(1 / 60, 1); }   // 再走 1 秒
  assert.ok(f0.hp < hpA, '离水超过 ' + FISH_AIR_SECONDS + ' 秒必须开始掉血，实得 hp=' + f0.hp.toFixed(2));
  f0.inWater = 1; f0.airT = 0;
  const hpB = f0.hp;
  for (let i = 0; i < 60; i++) { f0.inWater = 1; mm.update(1 / 60, 1); }
  assert.ok(f0.hp >= hpB - 0.02, '回到水里就要停止窒息，实得 ' + f0.hp.toFixed(2) + ' vs ' + hpB.toFixed(2));

  const pig = mm.spawn('pig', ocean.x + 0.5, w.seaLevel + 1, ocean.z + 0.5);
  pig.airT = FISH_AIR_SECONDS + 5;
  const pigHp = pig.hp;
  for (let i = 0; i < 60; i++) mm.update(1 / 60, 1);
  assert.ok(pig.hp >= pigHp - 0.02, '离水窒息只针对水生生物，猪不许被这条规则掉血');
});

test('阶段3a 鱼群身份入库：同站不补第二群、旧档无键按格兜底、maxMobs=0 时自然刷鱼闭嘴', () => {
  const w = new VoxelWorld(20261109, { genVersion: GEN_DEEP });
  const controller = { pos: { x: 0, y: w.seaLevel + 1, z: 0 } };
  const ctx = {
    world: w, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } },
    controller, inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
  };

  /* 找一颗「有站点 + 水深够 + 近身保护不挡路」的格子，把玩家站在同一格的另一个角上。
     玩家必须与站点中心 ≥6 格（spawnFishSchools 有近身保护），否则这用例测的是保护而不是去重。 */
  const cellOf = (x, z) => Math.floor(x / FISH_SITE_STEP);
  let pick = null;
  for (let sz = -2; sz <= 12 && !pick; sz++) {
    for (let sx = -2; sx <= 12 && !pick; sx++) {
      const s = fishSchoolOf(w.seed, sx, sz);
      if (!s) continue;
      const cc = cellOf(s.x), czc = cellOf(s.z);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) w.ensureChunk(cc + dx, czc + dz);
      const water = new MobManager(ctx).fishWaterAt(s.x, s.z);
      if (!water) continue;
      const px = (s.x - sx * FISH_SITE_STEP) < 8 ? sx * FISH_SITE_STEP + 15.4 : sx * FISH_SITE_STEP + 0.6;
      const pz = (s.z - sz * FISH_SITE_STEP) < 8 ? sz * FISH_SITE_STEP + 15.4 : sz * FISH_SITE_STEP + 0.6;
      if (Math.hypot(px - s.x, pz - s.z) < 6) continue;
      pick = { s, water, key: s.key, px, pz };
    }
  }
  assert.ok(pick, '这颗子必须能找到「有站点、水够深、玩家站得下」的站点格');
  controller.pos.x = pick.px; controller.pos.z = pick.pz;
  controller.pos.y = w.seaLevel + 1;

  const keyed = (mgr) => mgr.list.filter(m => m.school === pick.key);
  const mm = new MobManager(ctx);

  /* ① 自然刷群：一群、都带同一个站点键 */
  assert.ok(mm.spawnFishSchools(), '把玩家搬到有站点的深水格旁边必须刷出一群鱼');
  const n0 = keyed(mm).length;
  assert.ok(n0 >= 3 && n0 <= FISH_SCHOOL_MAX, '这一格的站点应刷出 3~' + FISH_SCHOOL_MAX + ' 条，实得 ' + n0);
  assert.equal(keyed(mm).length, mm.list.filter(m => m.def.aquatic).length, '只应刷出这一个站点的一群');

  /* ② 同一站点重复扫描不许补群（这是「成群」而不是「越刷越多」的界线）；
      但邻近的别的站点该各自刷出自己的一群 —— 去重是按站点键，不是「全世界只许一格有鱼」。 */
  for (let i = 0; i < 5; i++) mm.spawnFishSchools();
  assert.equal(keyed(mm).length, n0, '同站点重复扫描不许再补一群，实得 ' + keyed(mm).length + ' vs ' + n0);
  const nAll0 = mm.list.filter(m => m.def.aquatic).length;
  assert.ok(nAll0 > n0, '附近别的站点也应各自刷出一群，实得总数 ' + nAll0 + '（本格 ' + n0 + '）');
  const perKey = new Map();
  for (const m of mm.list) {
    if (!m.def.aquatic) continue;
    perKey.set(m.school, (perKey.get(m.school) || 0) + 1);
  }
  for (const [k, v] of perKey) {
    assert.ok(k && v <= FISH_SCHOOL_MAX, '每个站点键下最多一群（≤' + FISH_SCHOOL_MAX + ' 条），站点 ' + k + ' 实得 ' + v);
  }

  /* ③ 存档往返：站点键与回家点必须一起入库、一起回来 */
  const arr = mm.serialize();
  const savedFish = arr.filter(o => o.t === 'cod');
  assert.equal(savedFish.length, nAll0, '活着的鱼要一条不落进存档');
  for (const o of savedFish) {
    assert.ok(typeof o.sk === 'string' && o.sk, '鱼必须带站点键入库，否则读档后站点认不出它');
    assert.ok(Number.isFinite(o.fx) && Number.isFinite(o.fy) && Number.isFinite(o.fz), '回家点要一起入库');
  }
  assert.ok(arr.every(o => o.sk === undefined || o.t === 'cod'), '只有带站点的鱼会写 sk，别的生物的存档格式保持原样');

  const mm2 = new MobManager(ctx);
  mm2.applySaved(arr);
  const re = keyed(mm2);
  assert.equal(re.length, n0, '读档后这群鱼要还属于同一个站点键');
  assert.equal(mm2.list.filter(m => m.def.aquatic).length, nAll0, '读档后各站点的鱼要一条不少地回来');
  for (const m of re) {
    assert.ok(Math.hypot(m.homeX - m.pos.x, m.homeZ - m.pos.z) < 8, '读档后回家点得跟着它，不许漂走');
    assert.ok(Number.isFinite(m.homeY), '读档后要记得自己该游回去的水深');
  }
  for (let i = 0; i < 5; i++) mm2.spawnFishSchools();
  assert.equal(keyed(mm2).length, n0,
    '读档后站点扫描不许把这一格补成两群（实测一路补到上限会把生物列表灌满、污染别的观察）');
  const perKey2 = new Map();
  for (const m of mm2.list) {
    if (!m.def.aquatic) continue;
    perKey2.set(m.school, (perKey2.get(m.school) || 0) + 1);
  }
  for (const [k, v] of perKey2) {
    assert.ok(k && v <= FISH_SCHOOL_MAX, '读档后再扫描，每个站点键下仍最多一群，站点 ' + k + ' 实得 ' + v);
  }

  /* ④ 旧档读回：没有 sk 的鱼照样认得回来，且不许凭空编出一个键 */
  const legacy = arr.map(o => {
    const c = { ...o };
    delete c.sk; delete c.fx; delete c.fy; delete c.fz;
    return c;
  });
  const mm3 = new MobManager(ctx);
  mm3.applySaved(legacy);
  assert.equal(mm3.list.filter(m => m.def.aquatic).length, nAll0, '旧档鱼照样要一条不少地读得回来');
  assert.ok(mm3.list.every(m => !m.school), '旧档没有 sk → 读出来就是没键，不许瞎编');
  assert.ok(mm3.serialize().every(o => o.sk === undefined), '没键的鱼不许凭空写出 sk');

  /* ④b 兜底判定：无键鱼站在哪一格，那一格就算被占了（精确构造：把一条无键鱼放在站点中心） */
  const mm4 = new MobManager(ctx);
  const stray = mm4.spawn('cod', pick.s.x, pick.water.y, pick.s.z);
  assert.equal(stray.school, null, '手动生成的鱼不该有站点键');
  const stray0 = mm4.list.length;
  for (let i = 0; i < 5; i++) mm4.spawnFishSchools();
  assert.equal(mm4.list.filter(m => m.school === pick.key).length, 0,
    '这一格（键 ' + pick.key + '）已经站着一条无键的鱼，扫描必须按所在格判占用、不许给它补一群' +
    '（实测会一路补到 ' + FISH_MAX_ALIVE + ' 条）；当前列表 ' + mm4.list.length + ' 条，起始 ' + stray0 + ' 条');

  /* ⑤ maxMobs 是整个管理器共用的总量闸：验收脚本用它表达「这一段关掉自然刷怪」，鱼群也得听话 */
  const mm5 = new MobManager(ctx);
  mm5.maxMobs = 0;
  assert.equal(mm5.spawnFishSchools(), false, 'maxMobs=0 时鱼群扫描必须闭嘴');
  assert.equal(mm5.list.length, 0, 'maxMobs=0 时一条鱼都不该冒出来');
  const mm6 = new MobManager(ctx);
  assert.ok(mm6.spawnFishSchools(), '默认上限下照样能自然刷群（这条闸不是把鱼功能关了）');
  assert.ok(keyed(mm6).length >= 3, '默认上限下要刷出成群鱼');
});

/* ---------- 阶段 3b：骷髅与苦力怕重做（贴图注册表 / 转轴 / 先拉后放 / 引信档位） ---------- */

const sceneStub = { add() { }, remove() { } };

/** 把一个生物模型上出现过的贴图名全收集起来（六面件存成 "front:xxx,side:yyy,..."） */
function texNamesOf(type) {
  const probe = new Mob(type, 0, 40, 0, sceneStub);
  const out = new Set();
  probe.mesh.traverse(o => {
    if (!o.userData || !o.userData.tex) return;
    for (const piece of String(o.userData.tex).split(',')) {
      const v = piece.indexOf(':') >= 0 ? piece.split(':')[1] : piece;
      if (v) out.add(v);
    }
  });
  probe.remove(sceneStub);
  return out;
}

test('阶段3b 贴图注册表：模型引用的每个名字都有画笔、两种生物用的不是同一套、没有画了没人用的死图', () => {
  const skTex = texNamesOf('skeleton'), crTex = texNamesOf('creeper');
  assert.ok(skTex.size >= 4, '骷髅至少要 4 张贴图（头正面/头侧面/躯干/四肢），实得 ' + [...skTex].join(','));
  assert.ok(crTex.size >= 2, '苦力怕至少要皮肤+腿两张，实得 ' + [...crTex].join(','));
  for (const n of skTex) {
    assert.equal(typeof mobPainters[n], 'function', '骷髅引用了不存在的画笔：' + n + '（会露品红）');
    assert.equal(mobTexStats(n).hasPainter, true, n + ' 的 stats 也说没有画笔');
    assert.ok(n.indexOf('skeleton_') === 0, '骷髅贴图名字要带前缀：' + n);
  }
  for (const n of crTex) {
    assert.equal(typeof mobPainters[n], 'function', '苦力怕引用了不存在的画笔：' + n);
    assert.ok(n.indexOf('creeper_') === 0, '苦力怕贴图名字要带前缀：' + n);
  }
  const shared = [...skTex].filter(n => crTex.has(n));
  assert.equal(shared.length, 0, '两种生物不许共用同一张贴图（任务书：独立像素贴图）：' + JSON.stringify(shared));
  /* 阶段 3c 把同一套守卫扩到第三种贴图生物：判据本身不变，只是「有人用」的集合多了鸟那几张。
     任何真的没人用的画笔画出来仍会在这里红。 */
  const prTex = texNamesOf('parrot');
  assert.ok(prTex.size >= 3, '鹦鹉至少要身体/翅膀/头三张贴图（任务书：翅膀轮廓 + 材质层次），实得 ' + [...prTex].join(','));
  for (const n of prTex) {
    assert.equal(typeof mobPainters[n], 'function', '鹦鹉引用了不存在的画笔：' + n + '（会露品红）');
    assert.ok(n.indexOf('parrot_') === 0, '鹦鹉贴图名字要带前缀：' + n);
  }
  assert.equal([...prTex].filter(n => skTex.has(n) || crTex.has(n)).length, 0,
    '鹦鹉与骷髅/苦力怕不许共用贴图：' + JSON.stringify([...prTex].filter(n => skTex.has(n) || crTex.has(n))));
  const allUsed = new Set([...skTex, ...crTex, ...prTex]);
  /* 阶段 3c 再扩到第四张贴图生物：鳕鱼（任务书「给鱼和鸟补上材质层次」的鱼那一半）。
     色值必须还在 —— 加贴图不许顺手换色，否则阶段 3a 那批鱼群验收的色调就飘了。 */
  const cdTex = texNamesOf('cod');
  assert.ok(cdTex.size >= 4, '鳕鱼至少要身/头/尾/鳍四张贴图，实得 ' + [...cdTex].join(','));
  for (const n of cdTex) {
    assert.equal(typeof mobPainters[n], 'function', '鳕鱼引用了不存在的画笔：' + n + '（会露品红）');
    assert.equal(mobTexStats(n).hasPainter, true, n + ' 的 stats 也说没有画笔');
    assert.ok(n.indexOf('cod_') === 0, '鳕鱼贴图名字要带前缀：' + n);
  }
  assert.equal([...cdTex].filter(n => skTex.has(n) || crTex.has(n) || prTex.has(n)).length, 0,
    '鳕鱼与另外三种生物不许共用贴图：' + JSON.stringify([...cdTex].filter(n => skTex.has(n) || crTex.has(n) || prTex.has(n))));
  const codParts = MOB_TYPES.cod.parts();
  assert.equal(codParts.filter(p => p.mesh && p.mesh.userData && p.mesh.userData.tex).length, codParts.length,
    '鳕鱼每个部件都要挂上图（不留一块平涂）：' + codParts.map(p => p.part + '=' + (p.mesh && p.mesh.userData ? p.mesh.userData.tex : '?')).join(','));
  /* 无 DOM 时的代表色也必须跟着扩到 cod_*：否则 headless 造出来的鱼会掉进 skeleton 的骨白兜底，
     那时「贴图名字写错」这一类问题就不会在单测里露出来（e2e 里靠 missingRatio 抓品红）。 */
  for (const n of cdTex) assert.notEqual(mobTexStats(n).fallbackColor, undefined, n + ' 没有 headless 代表色');
  for (const n of cdTex) allUsed.add(n);
  /* 阶段 6：常见家畜（猪 / 牛 / 羊）也进了贴图册。判据与前面几种完全一样：
     名字前缀对得上、画笔存在、互不共用、每个部件都挂上了图。 */
  {
    const fam = ['pig', 'cow', 'sheep'];
    const sets = {};
    for (const t of fam) {
      const tex = texNamesOf(t);
      sets[t] = tex;
      assert.ok(tex.size >= 2, t + ' 至少要身体+腿两张贴图，实得 ' + [...tex].join(','));
      for (const n of tex) {
        assert.equal(typeof mobPainters[n], 'function', t + ' 引用了不存在的画笔：' + n + '（会露品红）');
        assert.equal(mobTexStats(n).hasPainter, true, n + ' 的 stats 也说没有画笔');
        assert.ok(n.indexOf(t + '_') === 0, t + ' 贴图名字要带前缀：' + n);
        assert.notEqual(mobTexStats(n).fallbackColor, undefined, n + ' 没有 headless 代表色');
      }
      const parts = MOB_TYPES[t].parts();
      assert.equal(parts.filter(q => q.mesh && q.mesh.userData && q.mesh.userData.tex).length, parts.length,
        t + ' 每个部件都要挂上图（不留一块平涂）：' +
        parts.map(q => q.part + '=' + (q.mesh && q.mesh.userData ? q.mesh.userData.tex : '?')).join(','));
    }
    const allFam = [...sets.pig, ...sets.cow, ...sets.sheep];
    assert.equal(new Set(allFam).size, allFam.length, '猪/牛/羊不许共用同一张贴图');
    assert.equal(allFam.filter(n => skTex.has(n) || crTex.has(n) || prTex.has(n) || cdTex.has(n)).length, 0,
      '家畜与骷髅/苦力怕/鹦鹉/鳕鱼不许共用贴图');
    for (const n of allFam) allUsed.add(n);
  }
  /* 阶段 6 封版：剪过毛的羊身用独立的 sheep_skin，不能复用带口鼻/鼻孔的 sheep_head
     （否则玩家近看会在羊身上看到第二张脸）。同时把这张图计入「注册了有人用」的总账。 */
  {
    const woolParts = MOB_TYPES.sheep.parts();
    const shornParts = MOB_TYPES.sheep.parts(undefined, true);
    const body = shornParts.find(p => p.part === 'body');
    const head = woolParts.find(p => p.part === 'head');
    assert.ok(body && body.mesh && body.mesh.userData, '剪毛羊要有 body 部件');
    assert.ok(head && head.mesh && head.mesh.userData, '羊要有 head 部件');
    assert.equal(body.mesh.userData.tex, 'sheep_skin', '剪毛羊身必须用独立的皮肤贴图');
    assert.notEqual(body.mesh.userData.tex, head.mesh.userData.tex, '剪毛羊身与羊头不许共用贴图');
    assert.equal(typeof mobPainters.sheep_skin, 'function', 'sheep_skin 画笔要存在');
    assert.equal(mobTexStats('sheep_skin').hasPainter, true, 'sheep_skin 的 stats 也要说有画笔');
    assert.notEqual(mobTexStats('sheep_skin').fallbackColor, undefined, 'sheep_skin 要有 headless 代表色');
    for (const p of shornParts) {
      assert.ok(p.mesh && p.mesh.userData && p.mesh.userData.tex,
        '剪毛羊的每个部件都要挂图：' + p.part);
    }
    allUsed.add('sheep_skin');
  }
  /* 本轮 C：僵尸与地牢守卫也进了贴图册（任务书：把两者拉到与骷髅/苦力怕/动物同一完成度）。
     判据与前面几种逐条一致：前缀对得上、画笔存在、互不共用、有 headless 代表色、
     每个部件都挂了图。同时补「玩家自己的小臂」这张：它不属于任何 MOB_TYPES，
     消费方是第一人称的 HeldItemView（浏览器侧，由 tests/shot-scenes-r1.mjs 的持握图核对）。 */
  {
    const pairs = [['zombie', 3], ['guardian', 3]];
    const sets = {};
    for (const [t, min] of pairs) {
      const tex = texNamesOf(t);
      sets[t] = tex;
      assert.ok(tex.size >= min, t + ' 至少要 ' + min + ' 张贴图（本轮 C：材质分区），实得 ' + [...tex].join(','));
      for (const n of tex) {
        assert.equal(typeof mobPainters[n], 'function', t + ' 引用了不存在的画笔：' + n + '（会露品红）');
        assert.equal(mobTexStats(n).hasPainter, true, n + ' 的 stats 也说没有画笔');
        assert.ok(n.indexOf(t + '_') === 0, t + ' 贴图名字要带前缀：' + n);
        assert.notEqual(mobTexStats(n).fallbackColor, undefined, n + ' 没有 headless 代表色');
      }
      const parts = MOB_TYPES[t].parts();
      const textured = parts.filter(q => q.mesh && q.mesh.userData && q.mesh.userData.tex).length;
      assert.equal(textured, parts.length,
        t + ' 每个部件都要挂上图（不留一块平涂）：' +
        parts.map(q => q.part + '=' + (q.mesh && q.mesh.userData ? q.mesh.userData.tex : '?')).join(','));
    }
    const zg = [...sets.zombie, ...sets.guardian];
    assert.equal(new Set(zg).size, zg.length, '僵尸与守卫不许共用同一张贴图');
    assert.equal(zg.filter(n => skTex.has(n) || crTex.has(n) || prTex.has(n) || cdTex.has(n)).length, 0,
      '僵尸/守卫与骷髅/苦力怕/鹦鹉/鳕鱼不许共用贴图');
    for (const n of zg) allUsed.add(n);
    assert.equal(typeof mobPainters.player_arm, 'function', 'player_arm 画笔要存在（第一人称小臂）');
    assert.equal(mobTexStats('player_arm').hasPainter, true, 'player_arm 的 stats 也要说有画笔');
    allUsed.add('player_arm');
  }
  for (const k of Object.keys(mobPainters)) {
    assert.ok(allUsed.has(k), '注册了却没人用的贴图：' + k);
  }
  assert.equal(mobTexStats('不存在的名字').hasPainter, false, '兜底：名字拼错必须被这条守卫抓到');
});

test('阶段3b 转轴：骷髅四肢绕肩/髋、头绕颈，轮廓与旧版逐格相同，眼睛没跟着几何体掉到下巴', () => {
  const probe = new Mob('skeleton', 0, 40, 0, sceneStub);
  const parts = probe.mesh.userData.parts;
  const bb = (o) => { o.geometry.computeBoundingBox(); return o.geometry.boundingBox; };
  const leg = bb(parts.leg0);
  assert.ok(Math.abs(leg.max.y) < 1e-6 && Math.abs(leg.min.y + 0.68) < 1e-6,
    '腿的几何体要挂在髋上（顶端 0、底端 -0.68），实得 ' + leg.max.y + '/' + leg.min.y);
  assert.ok(Math.abs(parts.leg0.position.y - 0.68) < 1e-9, '腿的位置要填髋高度，实得 ' + parts.leg0.position.y);
  // 轮廓逐格相同：旧版是「中心 0.34 ± 0.34」，新版是「髋 0.68 往下 0.68」
  assert.ok(Math.abs(parts.leg0.position.y + leg.min.y) < 1e-6, '脚底仍要在 y=0');
  assert.ok(Math.abs(parts.leg0.position.y + leg.max.y - 0.68) < 1e-6, '大腿根仍要在 0.68');
  const arm = bb(parts.arm0);
  assert.ok(Math.abs(arm.max.y) < 1e-6 && Math.abs(parts.arm0.position.y - 1.32) < 1e-6, '手臂要绕肩（1.32）转');
  assert.ok(Math.abs(parts.arm0.position.y + arm.min.y - 0.80) < 1e-6, '手腕仍要在 0.80（旧版 1.06-0.26）');
  const head = bb(parts.head);
  assert.ok(Math.abs(head.min.y) < 1e-6 && Math.abs(head.max.y - 0.42) < 1e-6, '头的几何体要从颈往上长');
  assert.ok(Math.abs(parts.head.position.y - 1.33) < 1e-9, '头的位置要填颈高');
  const eyes = parts.head.children.filter(o => o.isMesh);
  assert.equal(eyes.length, 2, '骷髅要有两只眼睛');
  for (const e of eyes) {
    assert.ok(Math.abs(e.position.y - (0.06 + 0.21)) < 1e-9,
      '眼睛的局部 Y 要跟着 pivot 补回半格，实得 ' + e.position.y);
    assert.ok(Math.abs(parts.head.position.y + e.position.y - 1.60) < 1e-9,
      '眼睛的世界高度必须与旧版一致（1.54+0.06），实得 ' + (parts.head.position.y + e.position.y));
  }
  const cp = new Mob('creeper', 0, 40, 0, sceneStub);
  const cparts = cp.mesh.userData.parts;
  const zs = ['leg0', 'leg1', 'leg2', 'leg3'].map(k => cparts[k].position.z);
  assert.ok(Math.abs(zs[0]) >= 0.15 && Math.sign(zs[0]) !== Math.sign(zs[2]),
    '四腿要前后分开（斜侧才数得出四条），实得 ' + JSON.stringify(zs));
  for (const k of ['leg0', 'leg1', 'leg2', 'leg3']) {
    const g = bb(cparts[k]);
    assert.ok(Math.abs(g.max.y) < 1e-6 && Math.abs(g.min.y + 0.44) < 1e-6, k + ' 的几何体要挂在髋上');
    assert.ok(Math.abs(cparts[k].position.y - 0.44) < 1e-9, k + ' 的位置要填髋高');
    assert.ok(Math.abs(cparts[k].position.y + g.min.y) < 1e-6, k + ' 的脚底仍要在 y=0');
  }
});

test('阶段3b 附加件不再共享：两只猪各有自己的鼻子、两只骷髅各有自己的弓', () => {
  const a = new Mob('pig', 0, 40, 0, sceneStub), b = new Mob('pig', 1, 40, 1, sceneStub);
  const noseA = a.mesh.children.filter(o => o.userData.extra === 'nose');
  const noseB = b.mesh.children.filter(o => o.userData.extra === 'nose');
  assert.equal(noseA.length, 1, '猪 A 要有一根鼻子');
  assert.equal(noseB.length, 1, '猪 B 也要有一根鼻子（原来两只抢同一个实例）');
  assert.notEqual(noseA[0], noseB[0], '鼻子必须是两个不同对象');
  assert.equal(noseA[0].parent, a.mesh); assert.equal(noseB[0].parent, b.mesh);
  const s1 = new Mob('skeleton', 0, 40, 0, sceneStub), s2 = new Mob('skeleton', 5, 40, 5, sceneStub);
  const bow1 = s1.mesh.userData.parts.bow, bow2 = s2.mesh.userData.parts.bow;
  assert.ok(bow1 && bow2, '每只骷髅都要有自己的弓（注册进 parts 才能被姿态驱动）');
  assert.notEqual(bow1, bow2, '弓不许在两只骷髅之间跳');
  assert.ok(bow1.userData.stringUpper && bow1.userData.stringLower && bow1.userData.arrow,
    '弓要有弓弦两段与一支搭着的箭');
  assert.equal(bow1.userData.arrow.visible, false, '静止时箭不许搭在弦上');
  assert.ok(bow1.children.length >= 5, '弓至少三段弓臂 + 两段弦 + 箭，实得 ' + bow1.children.length);
  const body = s1.mesh.userData.parts.body;
  assert.ok(Array.isArray(body.material) && body.material.length === 6,
    '贴图躯干要用六面材质（正面肋骨、侧面脊柱），实得 ' + (Array.isArray(body.material) ? body.material.length : typeof body.material));
});

test('阶段3b 六面材质能被光照与受击闪色正常驱动（不许因为 material 是数组就崩）', () => {
  const { mm, cx0, cz0, fy } = blastCtx();
  const sk = mm.spawn('skeleton', cx0 + 0.5, fy + 1, cz0 + 6.5);
  runFrames(mm, 2);
  const body = sk.mesh.userData.parts.body;
  const cols = () => body.material.map(m => m.color.getHexString());
  const c1 = cols();
  assert.ok(c1.every(v => v === c1[0]), '六面要同一档压暗色，实得 ' + JSON.stringify(c1));
  sk.hurtT = 0.3; sk._flash = -1; sk._lightT = 0;
  runFrames(mm, 1);
  const c2 = cols();
  assert.ok(c2.every(v => v === c2[0]), '闪红也要六面一致：' + JSON.stringify(c2));
  assert.notEqual(c2[0], c1[0], '受击必须真的改了色');
  /* 受击叠色不许是纯红（P0 那条原则在贴图件上同样成立） */
  const r = parseInt(c2[0].slice(0, 2), 16), g = parseInt(c2[0].slice(2, 4), 16), b = parseInt(c2[0].slice(4, 6), 16);
  assert.ok(r > g && r > b && g > 100 && b > 80, '闪红要保留色相压明度、不许是一团纯红，实得 #' + c2[0]);
  sk.hurtT = 0; sk._shade = 0.4; sk._appliedShade = 1; sk._flash = -1; sk._lightT = 0;
  runFrames(mm, 1);
  const c3 = cols()[0];
  assert.ok(parseInt(c3.slice(0, 2), 16) < parseInt(c1.slice(0, 2), 16),
    '压暗之后红通道要降下来：#' + c1[0] + ' → #' + c3);
});

test('阶段3b 姿态纯函数：bowDraw 只读状态、有界，且不改动 arm0/arm1（A.1 的逐位相等不许被破坏）', () => {
  const base = { def: MOB_TYPES.skeleton, age: 1, moving: false, animAttack: 0, hurtT: 0, animIdle: 0, bowDraw: 0 };
  const p0 = computePose(base);
  const p5 = computePose(Object.assign({}, base, { bowDraw: 0.5 }));
  assert.equal(p0.bowDraw, 0, '不拉弦时 bowDraw = 0');
  assert.equal(p0.nock, false, '不拉弦时箭不许搭着');
  assert.equal(p5.bowDraw, 0.5); assert.equal(p5.nock, true);
  assert.equal(p5.arm0, p0.arm0, '拉弦不许改手臂数值（render 的 applied 与 pose 必须逐位相等）');
  assert.equal(p5.arm1, p0.arm1, '同上');
  assert.equal(computePose(Object.assign({}, base, { bowDraw: 3 })).bowDraw, 1, '要有上界');
  assert.equal(computePose(Object.assign({}, base, { bowDraw: -1 })).bowDraw, 0, '要有下界');
  assert.equal(p0.finSwim, computePose(base).finSwim, '既有输出一字不动');
});

test('阶段3b 弓弦纯函数：stringSeg 摆出两点之间的弦，bowNockZ 从弓腹退到脸颊且有界', () => {
  const s = stringSeg(SKELETON_BOW_TIP_Y, SKELETON_BOW_TIP_Z, 0, SKELETON_STRING_PULL_Z);
  assert.ok(Math.abs(s.y - SKELETON_BOW_TIP_Y / 2) < 1e-9, '中点 Y：' + s.y);
  assert.ok(Math.abs(s.z - (SKELETON_BOW_TIP_Z + SKELETON_STRING_PULL_Z) / 2) < 1e-9, '中点 Z：' + s.z);
  const dy = -SKELETON_BOW_TIP_Y, dz = SKELETON_STRING_PULL_Z - SKELETON_BOW_TIP_Z;
  assert.ok(Math.abs(s.scale - Math.hypot(dy, dz)) < 1e-9, '长度要等于两点距离，实得 ' + s.scale);
  assert.ok(Math.abs(Math.cos(s.rotX) * s.scale - dy) < 1e-6, '朝向要沿连线（Y 分量）：' + s.rotX);
  assert.ok(Math.abs(Math.sin(s.rotX) * s.scale - dz) < 1e-6, '朝向要沿连线（Z 分量）：' + s.rotX);
  assert.equal(bowNockZ(0), SKELETON_STRING_REST_Z, '静止时弦贴着弓腹');
  assert.equal(bowNockZ(1), SKELETON_STRING_PULL_Z, '拉满时弦到脸颊');
  assert.ok(bowNockZ(0.5) < bowNockZ(0.4), '拉得越久弦越靠后');
  assert.equal(bowNockZ(2), SKELETON_STRING_PULL_Z, '超出 1 不许继续往后');
});

test('阶段3b 骷髅先拉后放：0.6 秒内一支箭都没有，弦越拉越开，到点才离弦并进冷却', () => {
  const { mm, ctx, cx0, cz0, fy } = blastCtx();
  const plays = [];
  let simT = 0;
  ctx.sfx.play = (name, o) => plays.push({ name, t: +simT.toFixed(3), rate: (o && o.rate) || 1 });
  const sk = mm.spawn('skeleton', cx0 + 0.5, fy + 1, cz0 + 6.5);
  ctx.controller.pos.z = cz0 + 2.5;                 // 4 格：在 12 格射程内
  const arrows0 = mm.arrows.length;
  for (let i = 0; i < 6; i++) { simT = i * 0.05; mm.update(0.05, 1); }
  assert.equal(sk.drawing, true, '0.3 秒应正在拉弦');
  assert.ok(sk.bowDraw > 0 && sk.bowDraw < 1, '0.3 秒的拉弓进度要在 (0,1)，实得 ' + sk.bowDraw.toFixed(3));
  const d1 = sk.bowDraw;
  assert.equal(mm.arrows.length, arrows0, '拉弦中途不许已经有箭（这就是玩家的反应时间）');
  assert.equal(sk.attackCd, 0, '没放箭之前不许进冷却');
  for (let i = 6; i < 12; i++) { simT = i * 0.05; mm.update(0.05, 1); }
  assert.ok(sk.bowDraw > d1, '弦要越拉越开：' + d1.toFixed(3) + ' → ' + sk.bowDraw.toFixed(3));
  assert.equal(mm.arrows.length, arrows0, '0.6 秒还不许离弦（' + SKELETON_DRAW_SECONDS + ' 秒才放）');
  for (let i = 12; i < 16; i++) { simT = i * 0.05; mm.update(0.05, 1); }
  assert.ok(mm.arrows.length > arrows0, '拉满必须离弦，实得箭数 ' + mm.arrows.length);
  assert.equal(sk.drawing, false, '放完要退出拉弦态');
  assert.equal(sk.bowDraw, 0, '离弦后弦要回到静止位');
  assert.ok(sk.attackCd > 0 && sk.animAttack > 0, '放箭之后才进冷却并抬手');
  assert.ok(plays.some(p => p.name === 'skeleton'), '起手要有一声听觉提示（配合看得见的拉弓）');
});

test('阶段3b 骷髅拉弦中丢目标就取消：不留半张的弓、不白等冷却、也不许凭空放一支箭', () => {
  const { mm, ctx, cx0, cz0, fy } = blastCtx();
  const sk = mm.spawn('skeleton', cx0 + 0.5, fy + 1, cz0 + 6.5);
  ctx.controller.pos.z = cz0 + 2.5;
  runFrames(mm, 4);
  assert.equal(sk.drawing, true, '前提：已经进入拉弦');
  const arrows0 = mm.arrows.length, cd0 = sk.attackCd;
  ctx.controller.pos.z = cz0 + 40;                 // 一下拉到 30+ 格（> reach×1.25）
  runFrames(mm, 2);
  assert.equal(sk.drawing, false, '丢目标要取消蓄力');
  assert.equal(sk.bowDraw, 0, '取消后不许留半张的弓');
  assert.equal(mm.arrows.length, arrows0, '取消的那一次不许放箭');
  assert.equal(sk.attackCd, cd0, '没放箭就不该消耗冷却');
});

/* 阶段 3b 墙体遮挡：原版是「怪物要看得见玩家才攻击」。以前本作只按距离判定，
   隔一堵墙骷髅也照拉照射（箭全插在墙上）、苦力怕也能隔墙直接开始嘶嘶。 */
const wallBetween = (w, cx0, cz0, fy, id) => {
  for (let dx = -3; dx <= 3; dx++) for (let h = 1; h <= 3; h++) w.setBlock(cx0 + dx, fy + h, cz0 + 4, id, 0);
};

test('阶段3b 墙体遮挡：隔一堵墙骷髅不起手拉弓，拉弓途中被挡住立刻取消，墙拆掉恢复射击', () => {
  const { w, mm, ctx, cx0, cz0, fy } = blastCtx();
  const sk = mm.spawn('skeleton', cx0 + 0.5, fy + 1, cz0 + 6.5);
  ctx.controller.pos.z = cz0 + 2.5;                 // 4 格：在射程内，只是中间有墙
  /* 不能只比 mm.arrows.length 的首尾：那是「在场箭」，命中玩家（夹具里 hurt 是空函数）后
     当帧就被消耗掉了。所以每帧记峰值，问的是「这段时间里到底有没有出现过一支箭」。 */
  const runSee = (n) => {
    let peak = mm.arrows.length, drawing = false;
    for (let i = 0; i < n; i++) {
      mm.update(0.05, 1);
      peak = Math.max(peak, mm.arrows.length);
      if (sk.drawing) drawing = true;
    }
    return { peak, drawing };
  };
  wallBetween(w, cx0, cz0, fy, B.STONE);
  const arrows0 = mm.arrows.length;
  const a = runSee(20);
  assert.equal(sk.drawing, false, '隔墙不许起手拉弓');
  assert.equal(a.peak, arrows0, '隔墙期间一支箭也不许有');
  wallBetween(w, cx0, cz0, fy, AIR);
  runSee(4);
  assert.equal(sk.drawing, true, '前提：没墙就要起手');
  wallBetween(w, cx0, cz0, fy, B.STONE);
  const b = runSee(2);
  assert.equal(sk.drawing, false, '拉弓途中失去视线要立刻取消，不能白等 0.7 秒再把箭打进墙里');
  assert.equal(sk.bowDraw, 0, '取消后不留半张的弓');
  assert.equal(b.peak, arrows0, '被挡住的那一次不许放箭');
  wallBetween(w, cx0, cz0, fy, AIR);
  sk.hp = sk.maxHp;                                  // 白天日晒会持续掉血，别让它死在最后一段里
  const c = runSee(24);
  assert.ok(c.drawing, '掩体拆掉后要重新起手拉弓（视线判定不许把远程整个关死）');
  assert.ok(c.peak > arrows0, '重新起手之后要真的放出箭，在场箭峰值=' + c.peak);
});

test('阶段3b 苦力怕隔墙不点火，但已点燃的引信只看距离、不因墙取消（原版点了火就跑不掉）', () => {
  const { w, mm, ctx, cx0, cz0, fy, events } = blastCtx();
  const m = mm.spawn('creeper', cx0 + 0.5, fy + 1, cz0 + 4.5);
  ctx.controller.pos.z = cz0 + 2.5;
  /* 每帧钉回原位：被墙挡住时 AI 会转向漫游，一飘出触发/取消距离判定就变成在测距离而不是测视线。
     只钉位置，不碰 charging / fuse，起手与引信仍完全由产品逻辑决定。 */
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      m.pos.x = cx0 + 0.5; m.pos.z = cz0 + 4.5; m.vel.x = 0; m.vel.z = 0;
      mm.update(0.05, 1);
    }
  };
  const wall = (id) => { for (let dx = -3; dx <= 3; dx++) for (let h = 1; h <= 3; h++) w.setBlock(cx0 + dx, fy + h, cz0 + 3, id, 0); };
  wall(B.STONE);
  run(12);
  assert.equal(m.charging, false, '隔墙不许起手嘶嘶');
  assert.equal(events.filter(e => e.explode).length, 0, '没点火就不该炸');
  wall(AIR);
  run(3);
  assert.equal(m.charging, true, '前提：看得见就要点火');
  const fuseAtIgnite = m.fuse;
  wall(B.STONE);
  run(4);
  assert.equal(m.charging, true, '已经点燃的引信不许因为重新挡上墙就取消');
  assert.ok(m.fuse < fuseAtIgnite, '引信要继续往下走：' + fuseAtIgnite.toFixed(3) + ' → ' + m.fuse.toFixed(3));
  run(34);
  assert.equal(events.filter(e => e.explode).length, 1,
    '点着的火要跑完并正好炸一次：' + JSON.stringify(events));
});

test('阶段3b 苦力怕引信分三档、嘶声越叫越急音调越高，逃开时充能态一起清干净', () => {
  const { mm, ctx, cx0, cz0, fy, events } = blastCtx();
  const plays = [];
  let simT = 0;
  ctx.sfx.play = (name, o) => plays.push({ name, t: +simT.toFixed(3), rate: (o && o.rate) || 1 });
  const m = mm.spawn('creeper', cx0 + 0.5, fy + 1, cz0 + 4.5);
  ctx.controller.pos.z = cz0 + 2.5;
  const stages = [];
  for (let i = 0; i < 34; i++) {
    simT = i * 0.05; mm.update(0.05, 1);
    if (mm.list.includes(m)) stages.push(m.fuseStage); else break;
  }
  assert.ok(stages.includes(0) && stages.includes(1) && stages.includes(2),
    '三档都要走到，实得 ' + JSON.stringify(stages));
  for (let i = 1; i < stages.length; i++) assert.ok(stages[i] >= stages[i - 1], '档位不许回退：' + JSON.stringify(stages));
  const hisses = plays.filter(p => p.name === 'hiss');
  assert.ok(hisses.length >= 3, '1.5 秒里至少起手一声 + 加密两声，实得 ' + hisses.length);
  const gaps = hisses.slice(1).map((p, i) => +(p.t - hisses[i].t).toFixed(2));
  assert.ok(gaps[gaps.length - 1] < gaps[0], '间隔要越叫越短，实得 ' + JSON.stringify(gaps));
  assert.ok(hisses[hisses.length - 1].rate > hisses[0].rate, '音调要越接近爆炸越高：' + JSON.stringify(hisses.map(h => h.rate)));
  assert.equal(gaps[0], CREEPER_HISS_GAP[0], '第一声间隔就是 0 档那一格，实得 ' + gaps[0]);
  assert.equal(events.filter(e => e.explode).length, 1, '跑完引信正好炸一次');
  /* 逃开：充能态、引信、档位、嘶声节拍都要清零 */
  const h2 = blastCtx();
  const m2 = h2.mm.spawn('creeper', h2.cx0 + 0.5, h2.fy + 1, h2.cz0 + 4.5);
  h2.ctx.controller.pos.z = h2.cz0 + 2.5;
  runFrames(h2.mm, 10);
  assert.equal(m2.charging, true, '前提：先充能起来');
  assert.ok(m2.fuseStage >= 1, '0.5 秒后至少走到 1 档，实得 ' + m2.fuseStage);
  h2.ctx.controller.pos.z = h2.cz0 - 20;
  runFrames(h2.mm, 3);
  assert.equal(m2.charging, false, '逃开要停止充能');
  assert.equal(m2.fuseStage, 0, '档位要归零');
  assert.equal(m2.hissT, 0, '嘶声节拍要归零（不许留着半截倒计时）');
  assert.equal(m2.fuse, 1.5, '引信要恢复满');
  runFrames(h2.mm, 40);
  assert.equal(h2.events.filter(e => e.explode).length, 0, '逃开之后不许在身后炸');
});

/* ================== 2026-11-08 阶段 3c：自然飞鸟 + 暗洞敌怪光照筛选 ================== */

/** 只给一个「空气腔 + 实心顶盖 + 可点亮」的假世界：
    洞穴生成判据（可站立 / 局部光照 / 头顶有没有盖）全部只读这几个函数，
    用假世界能把「同一点位插火把前后」做成一次严格的 A/B，而不是靠随机采样去撞。 */
function caveWorld(opts = {}) {
  const airLo = opts.airLo === undefined ? 15 : opts.airLo;
  const airHi = opts.airHi === undefined ? 17 : opts.airHi;
  const surf = opts.surf === undefined ? 30 : opts.surf;
  const lit = !!opts.lit;
  const isAir = (y) => y >= airLo && y <= airHi;
  return {
    seed: opts.seed === undefined ? 7 : opts.seed,
    minY: -64, topY: 320, seaLevel: 62, airLo, airHi, surf,
    isSolidAt: (x, y, z) => !isAir(y),                 // 只有那几层是洞，其余实心（含顶盖与地板）
    getBlock: (x, y, z) => 0,
    surfaceHeight: () => surf,
    topSolidY: () => surf,
    /* P1 之后生物 render 会采样世界光照（getLight 打包成 sky<<4 | block），
       假世界也得提供这一份，否则「长时间跑主循环」那类用例会死在缺函数上 */
    getLight: (x, y, z) => (lit ? ((15 << 4) | 14) : 0),
    brightnessAt: (x, y, z) => lit ? 0.9 : 0.05        // 点亮 = 这一带的局部亮度抬上去
  };
}
function caveCtx(world) {
  return {
    world, scene: sceneStub, sfx: { play() { } }, particles: { spawn() { } },
    controller: {
      pos: { x: 0.5, y: world.surfaceHeight(0, 0) + 1, z: 0.5 }, health: 20, creative: false,
      hurt() { }        // 敌对 AI 会通过 controller.hurt 结算伤害，长跑用例必须有这个入口
    },
    inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
  };
}

test('阶段3c 鹦鹉注册：飞行标记、独立翅膀部件、不进陆上与水域刷怪池', () => {
  const def = MOB_TYPES.parrot;
  assert.ok(def, 'MOBS 里必须有 parrot');
  assert.equal(def.flying, true, '必须标 flying，AI 与重力分支全靠这个标志');
  assert.equal(!!def.aquatic, false, '鸟不是水生');
  assert.equal(!!def.hostile, false, '鸟是被动的');
  assert.ok(/[一-龥]/.test(def.name), '中文名齐全：' + def.name);
  assert.deepEqual(AIR_TYPES, ['parrot']);
  assert.deepEqual(FLYING_TYPES, AIR_TYPES, '两份命名必须同源，不许各写一份清单');
  assert.equal(DAY_TYPES.includes('parrot'), false, 'parrot 不许进白天陆上刷怪池（那套选点会把它刷在地上）');
  assert.equal(NIGHT_TYPES.includes('parrot'), false, 'parrot 不许进夜间刷怪池');
  assert.equal(AQUATIC_TYPES.includes('parrot'), false, 'parrot 不许进鱼群站点扫描');
  const parts = def.parts();
  const names = parts.map(p => p.part);
  assert.ok(names.includes('wingL') && names.includes('wingR'), '必须有两片独立翅膀部件：' + names.join(','));
  assert.ok(names.includes('tail'), '尾羽要独立成部件（方向舵只转尾，不带偏身体朝向）');
  const head = parts.find(p => p.part === 'head');
  assert.ok(head.pos[2] > 0, '头摆在 +Z（与其余生物同一套正面约定，D3 钉死朝向只由 yaw 决定）');
  const wl = parts.find(p => p.part === 'wingL'), wr = parts.find(p => p.part === 'wingR');
  assert.ok(wl.pos[0] < 0 && wr.pos[0] > 0, '左翅在 -x、右翅在 +x');
  assert.equal(wl.mesh.userData.pivot, 'left');
  assert.equal(wr.mesh.userData.pivot, 'right');
  assert.ok(def.drop && def.drop[0].item === 'feather', '第一掉落是羽毛：' + JSON.stringify(def.drop));
  assert.ok(ITEMS.feather, '羽毛物品必须存在');
});

test('阶段3c 翅膀转轴在肩上：几何体偏到身体边缘，绕 Z 抬起时铰链端几乎不动、翼尖大幅划弧', () => {
  const probe = new Mob('parrot', 0, 40, 0, sceneStub);
  const parts = probe.mesh.userData.parts;
  const wing = parts.wingL;
  wing.geometry.computeBoundingBox();
  const bb = wing.geometry.boundingBox;
  assert.ok(Math.abs(bb.max.x) < 1e-6, '左翅几何体的右缘要贴在铰链（局部原点）上，实得 max.x=' + bb.max.x);
  assert.ok(bb.min.x < -0.18, '翼身要往 -x 伸出去，实得 min.x=' + bb.min.x);
  const reach = Math.abs(bb.min.x);
  const theta = 0.6;
  const arr = wing.geometry.attributes.position.array;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  let hingeMove = 0, tipMove = 0;
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i], y = arr[i + 1];
    const nx = x * cos - y * sin, ny = x * sin + y * cos;
    const d = Math.hypot(nx - x, ny - y);
    if (Math.abs(x) < 0.02) hingeMove = Math.max(hingeMove, d);
    else if (Math.abs(x) > reach * 0.7) tipMove = Math.max(tipMove, d);
  }
  assert.ok(hingeMove < 0.02, '绕肩转时铰链端几乎不动，实得位移 ' + hingeMove.toFixed(4));
  assert.ok(tipMove > 0.15, '翼尖要大幅划弧，实得位移 ' + tipMove.toFixed(4));
  const right = parts.wingR;
  right.geometry.computeBoundingBox();
  assert.ok(Math.abs(right.geometry.boundingBox.min.x) < 1e-6, '右翅左缘要贴在铰链上');
  probe.remove(sceneStub);
});

test('阶段3c 姿态纯函数：翅膀拍打有界且随相位走，停栖收拢，非飞行生物三项恒为 0（既有输出不被破坏）', () => {
  const def = MOB_TYPES.parrot;
  const base = { animAttack: 0, hurtT: 0, age: 1.0, animIdle: 0.2, vel: { x: 0, y: 0, z: 0 }, turnRate: 0 };
  const fly = computePose(Object.assign({}, base, { def, phase: 'fly', flapPhase: 1.2, moving: true }));
  const fly2 = computePose(Object.assign({}, base, { def, phase: 'fly', flapPhase: 2.9, moving: true }));
  const rest = computePose(Object.assign({}, base, { def, phase: 'perched', flapPhase: 1.2 }));
  assert.ok(Math.abs(fly.wingFlap) <= BIRD_FLAP_MAX + 1e-9, '拍幅必须有界，实得 ' + fly.wingFlap);
  assert.ok(Math.abs(fly.wingFlap - fly2.wingFlap) > 1e-3, '相位要真的改变翅膀角度（不许是一个常数）');
  assert.equal(fly.wingFold, 0, '飞行时不收拢');
  assert.equal(rest.wingFold, BIRD_GLIDE_FLAP, '停栖时翅膀收拢一档');
  assert.ok(Math.abs(rest.wingFlap) < BIRD_FLAP_MAX, '停栖拍幅要压小');
  assert.ok(Math.abs(fly.rudder) <= 0.45, '尾舵有界：' + fly.rudder);
  const turned = computePose(Object.assign({}, base, { def, phase: 'fly', turnRate: 2.6 }));
  assert.ok(Math.abs(turned.rudder) > Math.abs(fly.rudder), '转得越急尾舵偏得越多');
  for (const t of ['pig', 'creeper', 'skeleton', 'cod', 'chicken']) {
    const p = computePose(Object.assign({}, base, { def: MOB_TYPES[t], moving: true, flapPhase: 1.2, phase: 'fly', turnRate: 2.6 }));
    assert.equal(p.wingFlap, 0, t + ' 不是飞鸟，wingFlap 必须为 0');
    assert.equal(p.wingFold, 0, t + ' wingFold 必须为 0');
    assert.equal(p.rudder, 0, t + ' rudder 必须为 0（鱼的摆尾数值因此完全不变）');
    assert.ok(typeof p.finSwim === 'number' && typeof p.arm0 === 'number' && typeof p.bowDraw === 'number',
      t + ' 的既有姿态字段不能丢');
  }
});

test('阶段3c 停栖轮廓与贴位：停栖拍幅钉在 BIRD_PERCH_FLAP，水平弹簧把离位的鸟贴回栖点列', () => {
  const def = MOB_TYPES.parrot;
  const base = { animAttack: 0, hurtT: 0, age: 1.0, animIdle: 0.2, vel: { x: 0, y: 0, z: 0 }, turnRate: 0 };
  for (let ph = 0; ph < 6.3; ph += 0.7) {
    const rest = computePose(Object.assign({}, base, { def, phase: 'perched', flapPhase: ph }));
    assert.ok(Math.abs(rest.wingFlap) <= BIRD_PERCH_FLAP + 1e-9,
      '停栖只许微颤（收拢轮廓），相位 ' + ph.toFixed(1) + ' 实得 ' + rest.wingFlap);
    assert.equal(rest.wingFold, BIRD_GLIDE_FLAP, '停栖收拢一档不变');
    const hov = computePose(Object.assign({}, base, { def, phase: 'hover', flapPhase: ph }));
    assert.ok(Math.abs(hov.wingFlap) <= BIRD_FLAP_MAX * 0.45 + 1e-9, 'hover 保留半幅慢拍');
  }
  const w = caveWorld({});
  const ctx = caveCtx(w);
  const mm = new MobManager(ctx);
  const m = mm.spawn('parrot', 3.0, birdPerchY(15), 3.0);
  assert.ok(m, '假世界里要能手动放一只鸟做受控实验');
  m.perch = { x: 0.5, y: 15, z: 0.5 };
  m.homeX = 0.5; m.homeY = 15; m.homeZ = 0.5;
  m.phase = 'perched'; m.perchT = 9;
  ctx.controller.pos.x = 100; ctx.controller.pos.z = 100;
  let embedded = 0;
  for (let i = 0; i < 300; i++) {
    mm.flyAI(m, 1 / 60); mm.physics(m, 1 / 60);
    if (!mm.canFlyAt(m.pos.x, m.pos.y, m.pos.z)) embedded++;
  }
  const dHome = Math.hypot(m.pos.x - 0.5, m.pos.z - 0.5);
  assert.ok(dHome <= 0.2, '停栖 5 秒内水平残差要收进 0.2 格（真的站在树冠上），实得 ' + dHome.toFixed(3));
  assert.ok(Math.abs(m.pos.y - birdPerchY(15)) < 0.1, '停栖高度贴在栖点站位，实得 ' + m.pos.y.toFixed(3));
  assert.equal(embedded, 0, '贴位弹簧不许把鸟塞进不通飞的格子');
  assert.equal(m.moving, false, '贴位收敛不算在移动（步态读数不变）');
});

test('阶段3c 落下停栖闸：短飞结束离栖点太远转 hover 再绕，误差在 BIRD_PERCH_SETTLE_DIST 内才停栖', () => {
  const mm = new MobManager(caveCtx(caveWorld({})));
  const far = mm.spawn('parrot', 0.5, 17, 0.5);
  far.phase = 'fly'; far.flyT = 0.001;
  far.flyTo = { x: 8.5, y: 18, z: 8.5, perch: { x: 8.5, y: 15, z: 8.5 } };
  mm.flyAI(far, 1 / 60);
  assert.equal(far.phase, 'hover', '离栖点 ' + Math.hypot(8, 8).toFixed(1) + ' 格就「停栖」会冻在半空，必须转 hover');
  const near = mm.spawn('parrot', 8.0, 15.5, 8.0);
  near.phase = 'fly'; near.flyT = 0.001;
  near.flyTo = { x: 8.5, y: 18, z: 8.5, perch: { x: 8.5, y: 15, z: 8.5 } };
  mm.flyAI(near, 1 / 60);
  assert.equal(near.phase, 'perched', '水平 0.7 格 + 高度 0.45 格都在闸内，要落下停栖');
  assert.equal(near.perch.x, 8.5, '停栖后栖点要换成目标栖点');
  const high = mm.spawn('parrot', 8.0, 17, 8.0);
  high.phase = 'fly'; high.flyT = 0.001;
  high.flyTo = { x: 8.5, y: 18, z: 8.5, perch: { x: 8.5, y: 15, z: 8.5 } };
  mm.flyAI(high, 1 / 60);
  assert.equal(high.phase, 'fly', '水平到位但还偏高 2 格：补下降腿，不许在半空停栖');
  assert.ok(high.flyT > 0 && high.flyTo && high.flyTo.y === birdPerchY(15), '下降腿目标就是栖点站位');
});

test('阶段3c 转向限速：approachYaw 每步不超过 BIRD_TURN_RATE×dt，能走短路边并收敛', () => {
  const maxStep = BIRD_TURN_RATE / 60 + 1e-12;
  let y = 0;
  const target = Math.PI * 0.9;
  for (let i = 0; i < 90; i++) {
    const before = y;
    y = approachYaw(y, target, 1 / 60);
    assert.ok(Math.abs(y - before) <= maxStep, '第 ' + i + ' 步转了 ' + (y - before).toFixed(4) + ' 弧度，超过限速 ' + maxStep.toFixed(4));
  }
  const d = Math.abs(((y - target + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  assert.ok(d < 0.05, '90 帧之后必须基本对准目标方位，残差 ' + d.toFixed(4));
  const step = approachYaw(3.0, -3.0, 1 / 60);
  assert.ok(step > 3.0, '要沿短路边越过 π（前进），实得 ' + step);
  assert.ok(Math.abs(step - 3.0) <= maxStep, '越过 π 也受同样限速');
  assert.equal(approachYaw(1.0, 1.0, 1 / 60), 1.0, '已经对准就不动');
});

test('阶段3c 站点确定性：birdFlockOf 同种子同格同结果、条数在界内、少数格子有鸟而不是满天飞', () => {
  const a = birdFlockOf(20261108, 3, -2), b = birdFlockOf(20261108, 3, -2);
  assert.deepEqual(a, b, '同一颗种子同一格必须算出同一个站点');
  assert.notDeepEqual(birdFlockOf(20261108, 3, -2), birdFlockOf(99, 3, -2), '换种子结果要跟着变（站点是种子决定的）');
  let hit = 0, n = 400;
  for (let sx = -10; sx < 10; sx++) for (let sz = -10; sz < 10; sz++) {
    const s = birdFlockOf(20261108, sx, sz);
    if (!s) continue;
    hit++;
    assert.ok(s.count >= BIRD_FLOCK_MIN && s.count <= BIRD_FLOCK_MAX, '条数在界内，实得 ' + s.count);
    assert.equal(s.key, 'b' + sx + ',' + sz, '站点键要带 b 前缀并与格坐标一一对应：' + s.key);
    assert.ok(Math.abs(s.x - (sx * BIRD_SITE_STEP + 0.5)) < BIRD_SITE_STEP, '落点必须还在这一列里');
    assert.ok(Math.abs(s.z - (sz * BIRD_SITE_STEP + 0.5)) < BIRD_SITE_STEP);
  }
  const rate = hit / n;
  assert.ok(rate > 0.18 && rate < 0.55, '有鸟的格子比例要「偶尔遇见」，实得 ' + rate.toFixed(3));
  const r = flightRules();
  assert.equal(r.siteStep, BIRD_SITE_STEP, '诊断读数必须来自代码里的常量');
  assert.ok(r.maxAlive >= BIRD_FLOCK_MAX, '总量上限至少要容得下一群');
});

test('阶段3c 自然遇见：鸟只出现在能飞的空气格与真实树冠附近，成群、带站点键，受 BIRD_MAX_ALIVE 与 maxMobs 双重有界', () => {
  const w = new VoxelWorld(20261108, { genVersion: GEN_DEEP });
  for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) w.ensureChunk(cx, cz);
  const ctx = {
    world: w, scene: sceneStub, sfx: { play() { } }, particles: { spawn() { } },
    controller: { pos: { x: 0.5, y: w.surfaceHeight(0, 0) + 1, z: 0.5 }, health: 20 },
    inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
  };
  const mm = new MobManager(ctx);
  let found = null;
  for (let sx = -3; sx <= 3 && !found; sx++) for (let sz = -3; sz <= 3 && !found; sz++) {
    const site = birdFlockOf(w.seed, sx, sz);
    if (!site) continue;
    const perch = mm.findPerchAt(site.x, site.z, BIRD_PERCH_REACH);
    if (perch) found = { site, perch };
  }
  assert.ok(found, '这颗种子周围 7×7 列里必须至少有一处能停的林冠（否则本用例前提不成立）');
  const perch = found.perch;
  assert.ok(mm.canFlyAt(perch.x, perch.y, perch.z), '栖点本身必须是空气且不泡水');
  const surfHere = w.surfaceHeight(Math.floor(perch.x), Math.floor(perch.z));
  assert.ok(perch.y > surfHere, '栖点要在地表以上（停在树冠上）：' + perch.y + ' vs ' + surfHere);
  ctx.controller.pos.x = found.site.x; ctx.controller.pos.z = found.site.z;
  assert.equal(mm.spawnBirdFlocks(), true, '把玩家搬到有站点的列上必须刷出一群鸟');
  const birds = mm.list.filter(m => m.type === 'parrot');
  assert.ok(birds.length >= BIRD_FLOCK_MIN, '至少成群 ' + BIRD_FLOCK_MIN + ' 只，实得 ' + birds.length);
  assert.ok(birds.length <= BIRD_FLOCK_MAX, '一群不许超过 ' + BIRD_FLOCK_MAX + ' 只，实得 ' + birds.length);
  const keyset = new Set(birds.map(b => b.birdSite));
  assert.ok([...keyset][0], '每只鸟都要带站点键（去重与读档全靠它）');
  assert.equal(keyset.size, 1, '一次扫描只该刷出一群（同一站点、同一个键），实得 ' + [...keyset].join(','));
  const key = [...keyset][0];
  const km = /^b(-?\d+),(-?\d+)$/.exec(key);
  assert.ok(km, '站点键格式必须是 b<列x>,<列z>：' + key);
  assert.ok(birdFlockOf(w.seed, Number(km[1]), Number(km[2])), key + ' 必须能回溯到这颗种子的一个真实站点');
  for (const b of birds) {
    assert.ok(mm.canFlyAt(b.pos.x, b.pos.y, b.pos.z), '鸟不许生成在实心或水里：' + JSON.stringify(b.pos));
    assert.ok(b.def.flying, '分支标志要在');
    assert.ok(Math.hypot(b.pos.x - b.homeX, b.pos.z - b.homeZ) <= 4,
      '出生在自家栖点 4 格之内：' + Math.hypot(b.pos.x - b.homeX, b.pos.z - b.homeZ).toFixed(2));
    const dd = Math.hypot(b.pos.x - ctx.controller.pos.x, b.pos.z - ctx.controller.pos.z);
    assert.ok(dd <= BIRD_RANGE_MAX, '鸟必须刷在玩家搜索带内：' + dd.toFixed(1) + ' > ' + BIRD_RANGE_MAX);
  }
  let pairMax = 0;
  for (const a of birds) for (const b of birds) pairMax = Math.max(pairMax, Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z));
  assert.ok(pairMax <= 6, '一群鸟要抱团（彼此最远 ≤6 格），实得 ' + pairMax.toFixed(2));
  /* 去重是按站点的：同一个键不许补第二群（换个站点补一群是正常行为） */
  let dup = 0;
  for (let i = 0; i < 30; i++) {
    mm.spawnBirdFlocks();
    for (const b of mm.list.filter(x => x.type === 'parrot' && x.birdSite === key)) {
      if (!birds.includes(b)) dup++;
    }
  }
  assert.equal(dup, 0, '已占用的站点 ' + key + ' 被补了第二群，共 ' + dup + ' 只');
  assert.ok(mm.list.filter(m => m.type === 'parrot').length <= BIRD_MAX_ALIVE, '反复扫描后总数仍受上限约束');
  const mm2 = new MobManager(Object.assign({}, ctx, {
    controller: { pos: { x: found.site.x, y: perch.y, z: found.site.z }, health: 20 }
  }));
  mm2.maxMobs = 0;
  assert.equal(mm2.spawnBirdFlocks(), false, 'maxMobs=0 时鸟群也必须闭嘴（与鱼群、陆上刷怪同一把闸）');
  assert.equal(mm2.list.length, 0);
  const mm3 = new MobManager(ctx);
  for (let i = 0; i < 120; i++) {
    const sx = ((i * 7) % 9) - 4, sz = ((i * 5) % 9) - 4;
    const site = birdFlockOf(w.seed, sx, sz);
    if (!site) continue;
    ctx.controller.pos.x = site.x; ctx.controller.pos.z = site.z;
    mm3.spawnBirdFlocks();
    const n = mm3.list.filter(m => m.type === 'parrot').length;
    assert.ok(n <= BIRD_MAX_ALIVE, '第 ' + i + ' 次扫描后鸟数 ' + n + ' 越过了上限 ' + BIRD_MAX_ALIVE);
  }
});

test('阶段3c 飞行三条避让：不进墙、不进水面、不低于林冠，位置只由速度积分', () => {
  const w = caveWorld({});
  const ctx = caveCtx(w);
  const mm = new MobManager(ctx);
  assert.equal(mm.canFlyAt(0.5, 16, 0.5), true, '空腔里可以飞');
  assert.equal(mm.canFlyAt(0.5, 10, 0.5), false, '实心格里不能飞');
  w.getBlock = (x, y, z) => (y >= 20 && y <= 24 ? B.WATER : 0);
  assert.equal(mm.canFlyAt(0.5, 21, 0.5), false, '水体不能当飞行空间');
  w.getBlock = () => 0;
  const m = mm.spawn('parrot', 0.5, 16, 0.5);
  assert.ok(m, '假世界里要能手动放一只鸟做受控实验');
  m.perch = { x: 0.5, y: 14, z: 0.5 };
  m.homeX = 0.5; m.homeY = 14; m.homeZ = 0.5;
  m.phase = 'hover';
  let minY = 999;
  for (let i = 0; i < 240; i++) { mm.flyAI(m, 1 / 60); mm.physics(m, 1 / 60); minY = Math.min(minY, m.pos.y); }
  assert.ok(minY >= 15 - 1e-6, '悬停高度不许跌破林冠顶 +1（实得最低 ' + minY.toFixed(3) + '）');
  assert.ok(Math.abs(m.vel.y) < 1.3, '垂直速度必须在有界带内：' + m.vel.y);
  const m2 = mm.spawn('parrot', 2.5, 16, 2.5);
  m2.perch = { x: 2.5, y: 15, z: 2.5 };
  m2.homeY = 15; m2.phase = 'perched'; m2.perchT = 5;
  ctx.controller.pos.x = 100; ctx.controller.pos.z = 100;
  for (let i = 0; i < 60; i++) { mm.flyAI(m2, 1 / 60); mm.physics(m2, 1 / 60); }
  assert.ok(Math.abs(m2.pos.y - birdPerchY(15)) < 0.3,
    '停栖高度要贴在栖点上方 ' + BIRD_PERCH_FALLBACK + '，实得 ' + m2.pos.y.toFixed(3) + ' 目标 ' + birdPerchY(15));
  assert.equal(m2.moving, false, '停栖时不算在移动');
  ctx.controller.pos.x = 2.5; ctx.controller.pos.z = 2.5;
  mm.flyAI(m2, 1 / 60);
  assert.notEqual(m2.phase, 'perched', '玩家贴脸时鸟要飞走（不然「能遇见」变成「能抓着」）');
  const m3 = mm.spawn('parrot', 0.5, 16, 0.5);
  m3.homeY = 15; m3.perch = { x: 0.5, y: 15, z: 0.5 }; m3.phase = 'hover'; m3.hoverT = 0.5;
  let embedded = 0;
  for (let i = 0; i < 400; i++) {
    mm.flyAI(m3, 1 / 60); mm.physics(m3, 1 / 60);
    if (!mm.canFlyAt(m3.pos.x, m3.pos.y, m3.pos.z)) embedded++;
  }
  assert.equal(embedded, 0, '400 帧里一次都不许待在不通飞的格子里（避让 + 速度清零要成对生效）');
  assert.ok(m3.pos.y >= 15 - 1e-6 && m3.pos.y <= 18, '高度始终留在空腔带内：' + m3.pos.y.toFixed(2));
});

test('阶段3c 只有鸟多写站点字段：bk/px/py/pz，其它生物存档载荷与旧版逐字节相同', () => {
  const ctx = caveCtx(caveWorld({}));
  const mm = new MobManager(ctx);
  const b = mm.spawn('parrot', 0.5, 16, 0.5);
  b.birdSite = 'b3,-2';
  b.perch = { x: 3.5, y: 15, z: -2.5 };
  const keys = Object.keys(b.serialize()).sort();
  assert.deepEqual(keys, ['bk', 'hp', 'px', 'py', 'pz', 't', 'x', 'y', 'yaw', 'z'],
    '鸟的载荷必须只多这四个字段：' + keys.join(','));
  const o = b.serialize();
  assert.equal(o.bk, 'b3,-2');
  assert.equal(o.px, 3.5); assert.equal(o.py, 15); assert.equal(o.pz, -2.5);
  for (const t of ['pig', 'creeper', 'skeleton', 'cod', 'chicken', 'zombie']) {
    const m = mm.spawn(t, 0.5, 16, 0.5);
    const ks = Object.keys(m.serialize());
    for (const k of ['bk', 'px', 'py', 'pz']) {
      assert.equal(ks.includes(k), false, t + ' 不许写鸟的字段：' + ks.join(','));
    }
    if (t !== 'cod') assert.equal(ks.includes('sk'), false, t + ' 不许写鱼群字段');
  }
});

test('阶段3c 读档去重：带 bk 的鸟读回来从停栖开始，站点扫描不再补第二群；半空动画态一律不入库', () => {
  const world = caveWorld({});
  const ctx = caveCtx(world);
  const mm = new MobManager(ctx);
  const b = mm.spawn('parrot', 0.5, 16, 0.5);
  b.birdSite = 'b0,0';
  b.perch = { x: 0.5, y: 15, z: 0.5 };
  b.phase = 'fly'; b.flyT = 1.9; b.flapPhase = 4.2; b.perchT = 0.7;
  const arr = mm.list.map(m => m.serialize());
  for (const k of ['phase', 'flyT', 'flapPhase', 'perchT']) {
    assert.equal(arr[0][k] === undefined, true, '动画态 ' + k + ' 不许入库（读档不该读到半只翅膀）');
  }
  const mm2 = new MobManager(caveCtx(world));
  mm2.applySaved(arr);
  const back = mm2.list.filter(m => m.type === 'parrot');
  assert.equal(back.length, 1);
  assert.equal(back[0].birdSite, 'b0,0', '站点键要带回来，否则同一列会被补第二群');
  assert.equal(back[0].phase, 'perched', '读回来要先站在栖点上');
  const sx = Math.floor(back[0].pos.x / BIRD_SITE_STEP), sz = Math.floor(back[0].pos.z / BIRD_SITE_STEP);
  const site = birdFlockOf(world.seed, sx, sz);
  if (site) {
    const before = mm2.list.filter(m => m.type === 'parrot').length;
    mm2.spawnBirdFlocks();
    assert.equal(mm2.list.filter(m => m.type === 'parrot').length, before, '带键读档后同一站点不许补第二群');
  }
  const legacy = arr.map(o => { const c = Object.assign({}, o); delete c.bk; delete c.px; delete c.py; delete c.pz; return c; });
  const mm3 = new MobManager(caveCtx(world));
  mm3.applySaved(legacy);
  const before3 = mm3.list.filter(m => m.type === 'parrot').length;
  if (site) mm3.spawnBirdFlocks();
  assert.equal(mm3.list.filter(m => m.type === 'parrot').length, before3, '旧档无键时按「站在哪一列」兜底判占用');
});

test('阶段3c 暗洞敌怪判据：又暗、能站、头顶有盖才通过；同一点位点亮之后立刻被亮度挡掉', () => {
  const dark = caveWorld({ lit: false });
  const lit = caveWorld({ lit: true });
  const mmDark = new MobManager(caveCtx(dark));
  const mmLit = new MobManager(caveCtx(lit));
  const okDark = mmDark.spawnSiteOk(true, 0.5, 15, 0.5, 1);
  assert.equal(okDark.ok, true, '黑暗又站得住的洞格必须通过：' + JSON.stringify(okDark));
  assert.ok(okDark.light <= SPAWN_DARK_LIMIT, '通过时的亮度读数确实贴得上阈值：' + okDark.light);
  const okLit = mmLit.spawnSiteOk(true, 0.5, 15, 0.5, 1);
  assert.equal(okLit.ok, false, '点亮之后同一点位必须被挡住：' + JSON.stringify(okLit));
  assert.equal(okLit.why, 'light', '挡下的原因要写清楚是亮度而不是「站不住」');
  assert.ok(okLit.light > SPAWN_DARK_LIMIT);
  assert.equal(mmDark.spawnSiteOk(true, 0.5, 10, 0.5, 1).why, 'standable', '实心格要判「站不住」');
  const edge = caveWorld({ lit: false });
  edge.brightnessAt = () => SPAWN_DARK_LIMIT;
  assert.equal(new MobManager(caveCtx(edge)).spawnSiteOk(true, 0.5, 15, 0.5, 1).ok, true, '阈值本身算通过（不许写成 < 把界缩掉）');
  const edge2 = caveWorld({ lit: false });
  edge2.brightnessAt = () => SPAWN_DARK_LIMIT + 1e-6;
  assert.equal(new MobManager(caveCtx(edge2)).spawnSiteOk(true, 0.5, 15, 0.5, 1).ok, false, '超过阈值就不许刷');
  assert.equal(mmDark.exposedToSky(0.5, 16, 0.5), false, '空腔里有顶盖 → 不是通透');
  const open = caveWorld({});
  open.isSolidAt = (x, y, z) => y < 30;
  const mmOpen = new MobManager(caveCtx(open));
  assert.equal(mmOpen.exposedToSky(0.5, 16, 0.5), false, 'y=16 上面压着 14 格实心，本来就是被盖住的');
  assert.equal(mmOpen.exposedToSky(0.5, 31, 0.5), true, '地表那一格头顶通透 → 是地表而不是洞穴');
  let foundDark = 0, foundLit = 0, bad = 0, allDeep = true;
  for (let i = 0; i < 400; i++) {
    const p = mmDark.findUndergroundSpawnPoint(1);
    if (p) {
      foundDark++;
      if (p.light === undefined || p.light > SPAWN_DARK_LIMIT) bad++;
      if (p.y >= dark.surfaceHeight(0, 0) - UNDERGROUND_MIN_COVER) allDeep = false;
    }
    if (mmLit.findUndergroundSpawnPoint(1)) foundLit++;
  }
  assert.ok(foundDark > 0, '黑暗洞穴世界里必须能选出地下候选点，实得 ' + foundDark + ' 次');
  assert.equal(bad, 0, '每一个被选中的点都必须通过亮度判据');
  assert.equal(foundLit, 0, '点亮之后同批候选必须一个都不通过，实得 ' + foundLit);
  assert.ok(UNDERGROUND_MAX_DEPTH > UNDERGROUND_MIN_COVER, '候选深度带要合理');
  assert.equal(allDeep, true, '候选点必须埋在 surfaceHeight - MIN_COVER 以下');
  assert.equal(new MobManager(caveCtx(lit)).spawnSiteOk(false, 0.5, 15, 0.5, 1).ok, true,
    '亮处给动物通过（地表那套分档一字未改）');
  assert.equal(mmDark.spawnSiteOk(false, 0.5, 15, 0.5, 1).ok, false, '暗处不给动物刷');
});

test('阶段3c 生态总量：地下通路受 maxMobs 与洞穴上限双重约束，长时间停留不会越刷越多', () => {
  const world = caveWorld({});
  const ctx = caveCtx(world);
  const mm = new MobManager(ctx);
  mm.maxMobs = 0;
  for (let i = 0; i < 30; i++) mm.update(1 / 60, 0.2);
  assert.equal(mm.list.length, 0, 'maxMobs=0 时地下通路也必须闭嘴（验收段全靠这句话）');
  mm.maxMobs = 12;
  for (let i = 0; i < 4000; i++) mm.update(1 / 60, 0.2);
  assert.ok(mm.list.length <= mm.maxMobs, '总生物数不许越过 maxMobs：' + mm.list.length);
  const caveHostiles = mm.list.filter(m => m.def.hostile && m.undergroundSpawn).length;
  assert.ok(caveHostiles <= SPAWN_CAVE_CAP, '地下通路敌怪不许越过自己的上限 ' + SPAWN_CAVE_CAP + '，实得 ' + caveHostiles);
  assert.ok(mm.list.filter(m => m.def.flying).length <= BIRD_MAX_ALIVE, '鸟也不许越过上限');
});

/* ---------- 阶段 3c 第 2 刀：地下候选点的「扫柱子」与四路共用一把闸的公平份额 ----------
   这两条都是**取证逼出来的**（脚本留在 app/tests/probe-underground*.mjs，不进门禁）：
   ① 旧写法（一根柱子只在埋深带里随机取一个 y）实测每 14 次尝试命中 1.5%，
      玩家站在洞里 15 秒平均刷不出 0.2 只 —— 「白天地下有风险」形同不存在；
   ② 实测玩家站在洞里 15 秒，26 格额度被头顶看不见的地表动物占满（total=26、cave=0），
      地下通路一次机会都没拿到 —— 任务书要求「给鱼、鸟、敌怪保留合理机会」。
   两条都只钉新行为，既有阈值、节拍与判据一字未改。 */

/* 分层假世界：地表 surf=80（高于海平面，陆上那一路才会选到点），airLo..airHi 是洞里的空腔，
   surf 以上是露天。亮度按位置给：洞里暗（0.05）、露天亮（0.95），方向与真世界的天光一致。 */
function strataWorld(opts = {}) {
  const surf = opts.surf === undefined ? 80 : opts.surf;
  const airLo = opts.airLo === undefined ? 66 : opts.airLo;
  const airHi = opts.airHi === undefined ? 68 : opts.airHi;
  const lit = !!opts.lit;
  const isAir = (y) => (y >= airLo && y <= airHi) || y >= surf + 1;
  return {
    seed: opts.seed === undefined ? 20261108 : opts.seed,
    minY: -64, topY: 320, seaLevel: 62, surf, airLo, airHi,
    isSolidAt: (x, y, z) => !isAir(y),
    getBlock: (x, y, z) => 0,
    surfaceHeight: () => surf,
    topSolidY: () => surf,
    getLight: (x, y, z) => (isAir(y) ? (lit ? (14 << 4) : 0) : ((15 << 4) | (lit ? 14 : 0))),
    brightnessAt: (x, y, z) => (isAir(y) ? (lit ? 0.9 : 0.05) : 0.95)
  };
}
function strataCtx(world, py) {
  const ctx = caveCtx(world);
  ctx.controller.pos = { x: 0.5, y: py === undefined ? world.airLo : py, z: 0.5 };
  return ctx;
}

test('阶段3c 地下候选点扫整根柱子：埋深带里只有一层站得住的空腔也必须次次选中，点灯之后一个都选不出', () => {
  /* 空腔只做两层（其中只有底层站得住）：旧写法要在 24 格带里连中两次才算命中，
     新写法把整根柱子扫完，只要那一格合格就必须选得到。 */
  const w = strataWorld({ airLo: 66, airHi: 67 });
  const mm = new MobManager(strataCtx(w));
  const band = (w.surf - UNDERGROUND_MIN_COVER) - Math.max(w.minY + 2, w.surf - UNDERGROUND_MAX_DEPTH) + 1;
  assert.ok(band >= 20, '这条埋深带本来就该有 20 格以上，否则本用例前提不成立：' + band);
  let hits = 0, bad = 0;
  for (let i = 0; i < 80; i++) {
    const p = mm.findUndergroundSpawnPoint(1);
    if (!p) continue;
    hits++;
    if (p.y !== 66) bad++;                                  // 只有 66 这层站得住，选到别处就是判据漏了
    if (!Number.isFinite(p.light) || p.light > SPAWN_DARK_LIMIT) bad++;
  }
  assert.equal(hits, 80, '空腔只有一层时也必须 80/80 选中（旧写法实测约 44/80，等于这条通路形同不存在）');
  assert.equal(bad, 0, '每个被选中的点都要在那一层、且通得过亮度判据');
  const lit = new MobManager(strataCtx(strataWorld({ airLo: 66, airHi: 67, lit: true })));
  let litHits = 0;
  for (let i = 0; i < 80; i++) if (lit.findUndergroundSpawnPoint(1)) litHits++;
  assert.equal(litHits, 0, '把同一片空腔点亮之后候选点必须为 0，而不是「运气差没选中」，实得 ' + litHits);
});

test('阶段3c 四路共用一把闸但有公平份额：玩家在地表时额度照旧用满，下洞之后给洞穴与林冠让路', () => {
  const w = strataWorld({});
  const ctx = strataCtx(w, w.surf + 1);                    // 玩家在地表
  const mm = new MobManager(ctx);
  mm.maxMobs = 26;
  assert.equal(mm.landSpawnCap(), 26, '玩家在地表：陆上通路照旧用满 maxMobs（与旧版一字相同）');
  ctx.controller.pos.y = w.airLo;                          // 玩家下到洞里（比该列地表低 14 格）
  assert.ok(ctx.controller.pos.y <= w.surfaceHeight(0, 0) - 2, '前提：这算「不在地表」');
  assert.equal(mm.landSpawnCap(), 26 - SPAWN_CAVE_CAP - BIRD_MAX_ALIVE,
    '下洞之后要让出洞穴与林冠的份，否则头顶看不见的地表动物会把这把共用的闸吃满（取证实测 total=26、cave=0）');
  let over = 0, overTotal = 0, caveMax = 0, peakTotal = 0, landSeen = 0;
  for (let i = 0; i < 1800; i++) {
    mm.update(1 / 60, 1.0);
    const land = mm.list.filter(m => !m.def.hostile && !m.def.aquatic && !m.def.flying).length;
    const cave = mm.list.filter(m => m.def.hostile && m.undergroundSpawn).length;
    if (land > mm.landSpawnCap()) over++;
    if (mm.list.length > mm.maxMobs) overTotal++;
    caveMax = Math.max(caveMax, cave);
    landSeen = Math.max(landSeen, land);
    peakTotal = Math.max(peakTotal, mm.list.length);
  }
  assert.equal(over, 0, '陆上那一路任何时候都不许越过让位后的额度（实得峰值 ' + landSeen + '，界 ' + mm.landSpawnCap() + '）');
  assert.ok(caveMax >= 1, '玩家站在洞里 30 秒，地下通路必须真的刷出过敌怪（峰值 ' + caveMax + ' 只）');
  assert.ok(caveMax <= SPAWN_CAVE_CAP, '洞穴通路仍然只受自己的上限 ' + SPAWN_CAVE_CAP + ' 约束，实得 ' + caveMax);
  assert.equal(overTotal, 0, '总生物数不许越过 maxMobs（峰值 ' + peakTotal + '）');
  ctx.controller.pos.y = w.surf + 1;                       // 回到地表：让位立刻撤销，旧口径回来
  assert.equal(mm.landSpawnCap(), 26, '回到地表，陆上额度当场还回去（用读数而不是「等一等」来钉）');
});

test('阶段3c 总量闸逐条复查：鱼群扫描一次都不许把生物总数顶过 maxMobs', () => {
  /* 取证来历：阶段 3c 的 CV.1/CV.3/CV.4 量到 total=27 > maxMobs=26（鱼 18 = FISH_MAX_ALIVE）。
     根因是 `spawnFishSchools` 只在**函数入口**看一次总量闸，循环里只对自己的上限判 ——
     场上 21/26 时一次扫描仍能把整群（4~6 条）全塞进去，总量就溢了。
     这条用例把闸压到 1 格：旧写法会一次刷出 ≥4 条（FISH_SCHOOL_MIN），新写法必须停在 1 条。 */
  const w = new VoxelWorld(20261107, { genVersion: GEN_DEEP });
  let ocean = null;
  for (let z = -8; z <= 200 && !ocean; z += 4) {
    for (let x = -8; x <= 200; x += 4) {
      const h = w.surfaceHeight(x, z);
      if (w.seaLevel - h >= FISH_WATER_DEPTH + 1) { ocean = { x, z }; break; }
    }
  }
  assert.ok(ocean, '这颗子必须能找到海洋列');
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) w.ensureChunk((ocean.x >> 4) + dx, (ocean.z >> 4) + dz);
  const controller = { pos: { x: ocean.x + 0.5, y: w.seaLevel + 1, z: ocean.z + 0.5 } };
  const mm = new MobManager({
    world: w, scene: { add() { }, remove() { } }, sfx: { play() { } }, particles: { spawn() { } },
    controller, inventory: { held: () => null }, game: { state: 'playing', spawnDrop() { } }
  });
  /* 先把玩家搬到确实有站点的那一格（站点是纯函数，位置算得出来），再压闸 */
  const sx = Math.floor(controller.pos.x / FISH_SITE_STEP), sz = Math.floor(controller.pos.z / FISH_SITE_STEP);
  let spot = null;
  for (let ring = 0; ring <= 4 && !spot; ring++) {
    for (let dz = -ring; dz <= ring && !spot; dz++) for (let dx = -ring; dx <= ring && !spot; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
      const s = fishSchoolOf(w.seed, sx + dx, sz + dz);
      if (s && mm.fishWaterAt(s.x, s.z)) spot = s;
    }
  }
  assert.ok(spot, '这一片海域必须找得到可住鱼的站点，否则本用例前提不成立');
  controller.pos.x = spot.x; controller.pos.z = spot.z;
  mm.maxMobs = 1;                                  // 只留一格：一次扫描不许把总数顶到 2 以上
  const made = mm.spawnFishSchools();
  assert.equal(made, true, '站点扫描在还有额度时必须刷出鱼（不然这条用例是在测「没鱼」）');
  assert.equal(mm.list.length, 1, '总量闸是硬顶：maxMobs=1 时一次扫描只能落 1 条，实得 ' + mm.list.length +
    '（旧写法在这里会一次刷出 ' + mm.list.length + ' 条 ≥ FISH_SCHOOL_MIN=' + FISH_SCHOOL_MIN + '）');
  assert.equal(mm.list.filter(m => m.def.aquatic).length, 1, '水生也不能越过总量闸');
  /* 反过来：闸放开时仍然成群（这条修复不许把鱼群饿死） */
  mm.maxMobs = 26;
  for (let i = 0; i < 8; i++) mm.spawnFishSchools();
  const fish = mm.list.filter(m => m.type === 'cod');
  assert.ok(fish.length >= FISH_SCHOOL_MIN, '闸放开之后必须成群回来，实得 ' + fish.length);
  assert.ok(mm.list.length <= mm.maxMobs, '放开之后总数仍然守闸：' + mm.list.length);
});

test('阶段3c 洞穴留出额度：玩家下到洞里时，水域与林冠两路不许把总量闸吃满，地下的风险不靠运气', () => {
  /* 取证来历：CV.1 第一轮读数 total=27 / caveHostiles=1 —— 玩家在洞里时
     「鱼 18（FISH_MAX_ALIVE）+ 鸟 6」先把 26 格吃满，洞穴通路只剩 2 格机会，
     「白天地下有风险」又变成碰运气。现在地表的三路都听 surfaceSpawnCap()：
     在地表 == maxMobs（阶段 3a/3b 口径一字未改），在地下先替洞穴留出 SPAWN_CAVE_CAP 格。 */
  const w = strataWorld({});
  const ctx = strataCtx(w, w.surf + 1);
  const mm = new MobManager(ctx);
  mm.maxMobs = 26;
  assert.equal(mm.surfaceSpawnCap(), 26, '玩家在地表：水域/林冠照样用满整把闸');
  ctx.controller.pos.y = w.airLo;
  assert.equal(mm.surfaceSpawnCap(), 26 - SPAWN_CAVE_CAP, '下洞之后要给洞穴通路留出额度');
  assert.equal(mm.landSpawnCap(), 26 - SPAWN_CAVE_CAP - BIRD_MAX_ALIVE, '陆上那一路留得更多（它本来就是最忙的一路）');
  assert.ok(mm.surfaceSpawnCap() > mm.landSpawnCap(), '水域/林冠的上限必须不低于陆上，否则这次改造只是在换一路吃满');
  /* 行为层面：把玩家放在洞里跑 1800 帧，四类读数的和必须同时守住两道闸 */
  let bad = 0, caveMax = 0;
  for (let i = 0; i < 1800; i++) {
    mm.update(1 / 60, 1.0);
    const list = mm.list;
    const surface = list.filter(m => !m.undergroundSpawn).length;
    if (list.length > mm.maxMobs || surface > mm.surfaceSpawnCap()) bad++;
    caveMax = Math.max(caveMax, list.filter(m => m.def.hostile && m.undergroundSpawn).length);
  }
  assert.equal(bad, 0, '任何一帧都不许越过 maxMobs 或地表三路的留出额度（实得越界帧数 ' + bad + '）');
  assert.ok(caveMax >= 1, '洞里的确刷得出敌怪（峰值 ' + caveMax + ' 只），而不是被鱼群鸟群挤掉');
});

/* ---------------- 阶段 5 地牢守卫：纯状态逻辑（无头） ---------------- */

test('G1 守卫默认状态：满血、未唤醒、未击败、奖励未领', () => {
  const s = defaultGuardianState('g:2,-1');
  assert.equal(s.siteKey, 'g:2,-1');
  assert.equal(s.hp, GUARDIAN_HP);
  assert.equal(s.phase, GUARDIAN_PHASE.DORMANT);
  assert.equal(s.defeated, 0);
  assert.equal(s.rewardClaimed, 0);
  assert.equal(guardianSiteKey({ id: '2,-1' }), 'g:2,-1');
  assert.equal(guardianSiteKey({ x: 3, z: 4 }), 'g:3,4');
  assert.ok(GUARDIAN_ATTACKS.slam.telegraph > 0);
  assert.ok(GUARDIAN_ATTACKS.bolt.telegraph > GUARDIAN_ATTACKS.slam.telegraph, '远程前摇更长，才来得及躲');
  assert.ok(GUARDIAN_REWARD.length >= 3 && GUARDIAN_REWARD.every(r => typeof r.item === 'string' && r.count > 0));
});

test('G2 守卫存档：缺字段 / 脏值 / 已击败都不复活，临时相位不跨读档', () => {
  assert.deepEqual(normalizeGuardianState(null, 'g:a'), defaultGuardianState('g:a'));
  const dirty = normalizeGuardianState({ hp: 'x', phase: 'nope', defeated: '1', rewardClaimed: true }, 'g:a');
  assert.equal(dirty.hp, GUARDIAN_HP);
  assert.equal(dirty.defeated, 0);
  assert.equal(dirty.phase, GUARDIAN_PHASE.DORMANT);
  const mid = normalizeGuardianState({ hp: 20, phase: 'telegraph', attack: 'slam', t: 0.4, defeated: 0 }, 'g:a');
  assert.equal(mid.phase, GUARDIAN_PHASE.DORMANT, '战斗中退出重进不许凭空挨一发');
  assert.equal(mid.hp, 20, '但血量按保存值恢复');
  assert.equal(mid.attack, null);
  const won = normalizeGuardianState({ defeated: 1, rewardClaimed: 1, hp: 999 }, 'g:a');
  assert.equal(won.phase, GUARDIAN_PHASE.DEAD);
  assert.equal(won.hp, 0);
  assert.equal(won.defeated, 1);
  assert.equal(won.rewardClaimed, 1);
});

test('G3 选招：近身横扫、远距离光弹、超远距离不硬选远程', () => {
  assert.equal(pickGuardianAttack(2, () => 0.9), 'slam');
  assert.equal(pickGuardianAttack(8, () => 0.1), 'bolt');
  assert.equal(pickGuardianAttack(8, () => 0.9), 'slam');
  assert.equal(pickGuardianAttack(30, () => 0.1), 'slam');
});

test('G4 伤害判定：墙体 > 距离；格挡由 controller 的盾牌扇区单独结算（守卫不重复扣血）', () => {
  assert.deepEqual(guardianDamage('slam', { dist: 2, wallBetween: true }), { damage: 0, why: 'wall', blockable: true });
  assert.deepEqual(guardianDamage('slam', { dist: 9 }), { damage: 0, why: 'range', blockable: true });
  /* 这一层只回答「本来该打多少」：横扫 7 点、光弹 5 点，都是全额。
     谁能挡由 `blockable` 与 guardianDamageType 决定 —— 横扫走 melee 吃盾的 120° 扇区，
     光弹走 guardian_bolt（盾挡不住，只能躲到墙后）。旧写法在这里先减 6 点，
     controller 又整发挡下，读数会出现「格挡了但已经掉血」的自相矛盾。 */
  assert.equal(guardianDamage('slam', { dist: 2 }).damage, 7);
  assert.equal(guardianDamage('slam', { dist: 2 }).blockable, true);
  assert.equal(guardianDamage('bolt', { dist: 8 }).damage, 5, '光弹不能被盾完全挡下');
  assert.equal(guardianDamage('bolt', { dist: 8 }).blockable, false);
  assert.equal(guardianDamageType('slam'), 'melee');
  assert.equal(guardianDamageType('bolt'), 'guardian_bolt');
  assert.equal(shieldCanBlock(guardianDamageType('slam')), true, '横扫该被盾挡住');
  assert.equal(shieldCanBlock(guardianDamageType('bolt')), false, '光弹必须躲墙后，不是举盾能挡的');
  assert.equal(guardianDamage('nope', {}).damage, 0);
});

test('G5 状态机完整一轮：唤醒 → 前摇 → 出招 → 硬直 → 再待机', () => {
  let s = defaultGuardianState('g:x');
  const c = { playerAlive: true, rng: () => 0.1 };
  let r = stepGuardian(s, 0.016, Object.assign({ dist: 2 }, c));
  assert.equal(r.state.phase, GUARDIAN_PHASE.IDLE);
  assert.equal(r.events[0].type, 'awaken');
  s = r.state;
  r = stepGuardian(s, 0.6, Object.assign({ dist: 2 }, c));
  assert.equal(r.state.phase, GUARDIAN_PHASE.TELEGRAPH);
  assert.equal(r.events[0].attack, 'slam');
  s = r.state;
  r = stepGuardian(s, GUARDIAN_ATTACKS.slam.telegraph + 0.01, Object.assign({ dist: 2 }, c));
  assert.equal(r.state.phase, GUARDIAN_PHASE.STRIKE);
  assert.equal(r.events[0].type, 'fire');
  s = r.state;
  r = stepGuardian(s, 0.016, Object.assign({ dist: 2 }, c));
  assert.equal(r.state.phase, GUARDIAN_PHASE.RECOVER);
  assert.equal(r.events[0].type, 'recover');
  s = r.state;
  r = stepGuardian(s, GUARDIAN_ATTACKS.slam.recover + 0.01, Object.assign({ dist: 2 }, c));
  assert.equal(r.state.phase, GUARDIAN_PHASE.IDLE);
  assert.equal(r.events[0].type, 'ready');
});

test('G6 走远 / 玩家死亡回位满血可重试，attempts 保留', () => {
  const s = Object.assign(defaultGuardianState('g:x'), { hp: 11, phase: GUARDIAN_PHASE.RECOVER, attempts: 2 });
  const far = stepGuardian(s, 0.016, { dist: GUARDIAN_LEASH + 1, playerAlive: true });
  assert.equal(far.state.phase, GUARDIAN_PHASE.DORMANT);
  assert.equal(far.state.hp, GUARDIAN_HP);
  assert.equal(far.events[0].why, 'leash');
  const dead = stepGuardian(s, 0.016, { dist: 3, playerAlive: false });
  assert.equal(dead.events[0].why, 'player-dead');
  assert.equal(dead.state.hp, GUARDIAN_HP);
  assert.equal(dead.state.attempts, 2);
  assert.equal(s.hp, 11, '纯函数不改入参');
});

test('G7 击败转 DEAD 只触发一次，奖励按次数只发一次', () => {
  const s = Object.assign(defaultGuardianState('g:x'), { hp: 0, phase: GUARDIAN_PHASE.IDLE });
  const r = stepGuardian(s, 0.016, { dist: 3, playerAlive: true });
  assert.equal(r.state.phase, GUARDIAN_PHASE.DEAD);
  assert.equal(r.events.filter(e => e.type === 'defeated').length, 1);
  assert.equal(stepGuardian(r.state, 0.016, { dist: 3, playerAlive: true }).events.length, 0, '已击败不再重复结算');
  const won = Object.assign({}, r.state, { rewardClaimed: 0 });
  assert.equal(claimGuardianReward(won).length, GUARDIAN_REWARD.length);
  assert.equal(claimGuardianReward(Object.assign({}, won, { rewardClaimed: 1 })), null);
  assert.equal(claimGuardianReward(defaultGuardianState('g:x')), null);
});

test('G8 唤醒半径：远处不唤醒，进入半径才触发', () => {
  const s = defaultGuardianState('g:x');
  const far = stepGuardian(s, 1, { dist: GUARDIAN_TRIGGER + 0.1, playerAlive: true });
  assert.equal(far.state.phase, GUARDIAN_PHASE.DORMANT);
  assert.equal(far.events.length, 0);
  const near = stepGuardian(s, 0.016, { dist: GUARDIAN_TRIGGER - 0.1, playerAlive: true });
  assert.equal(near.state.phase, GUARDIAN_PHASE.IDLE);
  assert.equal(s.phase, GUARDIAN_PHASE.DORMANT, '纯函数不改入参');
});

test('G9 封印：四座石座各放一块深板岩才算解开；缺一块靠近也不唤醒（只发 locked），不影响远处的静默', () => {
  assert.equal(GUARDIAN_WARDS, 4);
  assert.equal(guardianArmed(0), false);
  assert.equal(guardianArmed(3), false);
  assert.equal(guardianArmed(4), true);
  assert.equal(guardianArmed(9), true, '多放不多算，但也不该反过来锁死');
  /* 石座是地点中心 + 固定四向偏移，整数格 */
  const spots = guardianWardSpots(24, 48);
  assert.equal(spots.length, 4);
  assert.deepEqual(spots, [{ x: 28, z: 48 }, { x: 20, z: 48 }, { x: 24, z: 52 }, { x: 24, z: 44 }]);
  assert.equal(new Set(spots.map(s => s.x + ',' + s.z)).size, 4, '四个座不重合');
  const s = defaultGuardianState('g:x');
  const locked = stepGuardian(s, 0.5, { dist: 3, playerAlive: true, armed: false, wards: 1 });
  assert.equal(locked.state.phase, GUARDIAN_PHASE.DORMANT, '封印没解开就不许醒');
  assert.equal(locked.events.length, 1);
  assert.equal(locked.events[0].type, 'locked');
  assert.equal(locked.events[0].wards, 1);
  const armed = stepGuardian(s, 0.5, { dist: 3, playerAlive: true, armed: true, wards: 4 });
  assert.equal(armed.state.phase, GUARDIAN_PHASE.IDLE);
  assert.equal(armed.events[0].type, 'awaken');
  /* 默认 armed（不传）保持既有语义：老的单测与工具调 stepGuardian 不用改 */
  assert.equal(stepGuardian(s, 0.5, { dist: 3, playerAlive: true }).state.phase, GUARDIAN_PHASE.IDLE);
});

test('G10 封印石座坐标随存档保留，旧档没有这个字段时回落 null（下次扫描再补建）', () => {
  const raw = { siteKey: 'g:a', hp: 40, pedestals: [{ x: 1, y: 20, z: 2 }, { x: 3, y: 20, z: 4 }] };
  const s = normalizeGuardianState(raw, 'g:a');
  assert.deepEqual(s.pedestals, [{ x: 1, y: 20, z: 2 }, { x: 3, y: 20, z: 4 }]);
  assert.equal(s.hp, 40);
  assert.equal(normalizeGuardianState({ hp: 40 }, 'g:a').pedestals, null);
  assert.equal(normalizeGuardianState({ pedestals: 'x' }, 'g:a').pedestals, null);
  assert.equal(normalizeGuardianState({ pedestals: [{ x: 1 }] }, 'g:a').pedestals, null, '半截坐标不带进世界');
});

/* ================= 阶段 6 封版：随包 CC0 短音效登记 ================= */

test('阶段6 随包 CC0 短音效：登记字段、许可白名单、磁盘字节与指纹、同源 URL、合成兜底都在', () => {
  const base = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.join(base, '..', 'renderer', SFX_FILE_DIR);
  assert.ok(sfxFilesValid(), '登记表静态自检不通过：' + JSON.stringify(sfxFilesReport()));
  assert.ok(fs.existsSync(dir), '素材目录不存在：' + dir);
  const guardianIds = SFX_FILE_IDS.filter(id => id.startsWith('guardian_'));
  assert.deepEqual(guardianIds, ['guardian_awaken', 'guardian_reward']);
  for (const id of guardianIds) {
    const e = sfxFileFor(id);
    assert.ok(e, id + ' 没有登记');
    const v = validateSfxFile(id);
    assert.deepEqual(v.problems, [], id + ' 登记不合规：' + v.problems.join('; '));
    assert.ok(SFX_LICENCE_ALLOWLIST.includes(e.licence), id + ' 许可不在允许清单');
    assert.equal(e.source, 'local://tools/music-audio/score.mjs');
    assert.equal(e.author, '本项目原创编曲');
    assert.ok(e.sampleSources.every(s => s.licence === 'CC0-1.0'));
    const p = path.join(dir, e.file);
    assert.ok(fs.existsSync(p), id + ' 的随包文件不存在：' + p);
    const buf = fs.readFileSync(p);
    assert.equal(buf.length, e.bytes, id + ' 字节数与登记不符：磁盘 ' + buf.length + ' vs 登记 ' + e.bytes);
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'RIFF', id + ' 不是 WAV 容器');
    assert.equal(buf.subarray(8, 12).toString('latin1'), 'WAVE', id + ' 不是 WAV 容器');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    assert.equal(sha, e.sha256, id + ' 指纹与登记不符（换素材必须同步更新许可表）');
    const u = sfxFileUrl(e);
    assert.equal(u, '/' + SFX_FILE_DIR + '/' + e.file);
    assert.ok(!/^[a-z]+:\/\//i.test(u), '音效 URL 必须是同源相对路径，不许外链');
    /* 文件没就绪时不能静音：两个名字都要有同名合成兜底配方 */
    assert.ok(SOUND_NAMES.includes(id), id + ' 没登记进音效名表');
    assert.ok(SOUND_DEF_NAMES.includes(id), id + ' 没有合成兜底配方');
  }
  assert.equal(Object.keys(SFX_FILES).length, SFX_FILE_IDS.length);
  /* 砍树任务提示要把「两种原木各出什么板」说清楚，但 recipeId 仍钉主线第一步 */
  const logQuest = QUEST_BY_ID.log;
  assert.equal(logQuest.recipeId, 'log_to_planks');
  assert.ok(logQuest.hint.includes('橡木') && logQuest.hint.includes('桦木板') && logQuest.hint.includes('工作台'),
    '砍树提示没说清两种原木：' + logQuest.hint);
  assert.deepEqual([...logQuest.items], ['oak_log', 'birch_log']);
  assert.equal(QUESTS[0].id, 'log', '主线顺序不许被新配方改掉');
});

/* ================= 阶段 7：桦木板与生存配方 ================= */

test('阶段7 桦木板：新 ID 不占旧档、两条原木配方输入互斥、通用木板标签覆盖下游、配方书按库存选板', async () => {
  const { CraftingGrid } = await import('../renderer/js/core/machines.js');
  const grid3 = (rows) => {
    const g = [['', '', ''], ['', '', ''], ['', '', '']].map(r => r.slice());
    rows.forEach((row, y) => row.forEach((c, x) => { g[y][x] = c || null; }));
    return g;
  };

  /* 旧 ID 一字不动；新方块用大于所有旧号段的下标，旧存档里的 planks 不会错位 */
  assert.equal(B.PLANKS, 14, '旧木板方块 ID 不许变');
  assert.equal(ITEMS.planks.blockId, B.PLANKS, '旧木板物品 ID 不许变');
  assert.equal(B.BIRCH_PLANKS, 72);
  assert.ok(B.BIRCH_PLANKS > B.POLISHED_DEEPSLATE, '新号段必须大于所有既有 ID');
  assert.equal(BLOCKS[B.BIRCH_PLANKS].name, '桦木板');
  assert.equal(ITEMS.birch_planks.blockId, B.BIRCH_PLANKS);
  assert.equal(blockToItem(B.BIRCH_PLANKS), 'birch_planks');
  assert.equal(typeof blockPainters.birch_planks, 'function', '桦木板贴图画笔缺失会露品红');
  assert.ok(isFuel('birch_planks'), '桦木板要能当燃料');
  assert.ok(CREATIVE_TABS.some(t => t.items.includes('birch_planks')), '创造栏要能拿到桦木板');

  /* log_to_planks 的 ID 与 4 木板产物保留，输入收窄为橡木；白桦走独立 ID */
  const oak = findRecipe([['oak_log']]);
  const birch = findRecipe([['birch_log']]);
  assert.ok(oak && birch, '两种原木都必须有配方');
  assert.equal(oak.id, 'log_to_planks');
  assert.deepEqual({ item: oak.result.item, count: oak.result.count }, { item: 'planks', count: 4 });
  assert.equal(birch.id, 'birch_log_to_birch_planks');
  assert.deepEqual({ item: birch.result.item, count: birch.result.count }, { item: 'birch_planks', count: 4 });
  assert.notEqual(oak.id, birch.id, '两条配方不许共用一个 ID');
  assert.equal(TAGS.logs, undefined, '旧 logs 标签已无配方引用，应撤掉');
  assert.equal(RECIPES.filter(r => r.id === 'log_to_planks').length, 1);
  assert.equal(RECIPES.filter(r => r.id === 'birch_log_to_birch_planks').length, 1);

  /* 通用木板标签：两种板、混着摆都能走完全部下游配方 */
  assert.deepEqual(TAGS.planks, ['planks', 'birch_planks']);
  assert.deepEqual(expandIngredient('planks'), ['planks', 'birch_planks']);
  const bp = 'birch_planks', pl = 'planks';
  assert.equal(findRecipe(grid3([[bp, bp], [bp, bp]])).result.item, 'crafting_table', '桦木板做工作台');
  assert.equal(findRecipe(grid3([[bp], [bp]])).result.item, 'stick', '桦木板做木棍');
  assert.equal(findRecipe(grid3([[bp, bp, bp], [null, 'stick', null], [null, 'stick', null]])).result.item, 'pickaxe_wood', '桦木板做木镐');
  assert.equal(findRecipe(grid3([[bp, bp, null], [bp, 'stick', null], [null, 'stick', null]])).result.item, 'axe_wood', '桦木板做木斧');
  assert.equal(findRecipe(grid3([[bp, bp, bp], [bp, 'iron_ingot', bp], [null, bp, null]])).result.item, 'shield', '桦木板做盾');
  assert.equal(findRecipe(grid3([['wool', 'wool', 'wool'], [bp, bp, bp]])).result.item, 'bed', '桦木板做床');
  assert.equal(findRecipe(grid3([[bp, bp], [bp, bp], [bp, bp]])).result.item, 'door', '桦木板做门');
  assert.equal(findRecipe(grid3([[bp, bp, bp], [bp, null, bp], [bp, bp, bp]])).result.item, 'chest', '桦木板做箱子');
  assert.equal(findRecipe(grid3([[pl, bp], [bp, pl]])).result.item, 'crafting_table', '两种板混着摆也能做工作台');
  assert.equal(findRecipe(grid3([[pl, bp, pl], [null, 'stick', null], [null, 'stick', null]])).result.item, 'pickaxe_wood', '混着摆也能做木镐');

  /* 配方书展示：两条配方都在，输入展开后各自只有一种原木 */
  const shown = listRecipes();
  const sOak = shown.find(r => r.id === 'log_to_planks');
  const sBirch = shown.find(r => r.id === 'birch_log_to_birch_planks');
  assert.deepEqual(sOak.inputs, [['oak_log']]);
  assert.deepEqual(sBirch.inputs, [['birch_log']]);
  assert.ok(shown.filter(r => r.id === 'crafting_table')[0].key.p.includes('birch_planks'), '工作台配方展示要列出桦木板');

  /* 一键填充：背包里只有桦木板时，配方书照样能摆出工作台 */
  const inv = new Inventory();
  inv.add('birch_planks', 8);
  const cg = new CraftingGrid(2);
  assert.equal(cg.fillFrom('crafting_table', inv), true, '只有桦木板时配方书一键填充工作台失败');
  assert.equal(cg.result().item, 'crafting_table');
  assert.ok(cg.slots.filter(Boolean).length === 4 && cg.slots.filter(Boolean).every(s => s.item === 'birch_planks'));
  /* 旧行为不回归：背包里有橡木木板时仍优先用橡木木板 */
  const inv2 = new Inventory();
  inv2.add('planks', 8);
  const cg2 = new CraftingGrid(2);
  assert.equal(cg2.fillFrom('crafting_table', inv2), true);
  assert.ok(cg2.slots.filter(Boolean).every(s => s.item === 'planks'));
});
