'use strict';
/*
 * 游戏主控：串联渲染、世界、玩家、交互、UI、存档与音效。
 * 也负责自动化验收需要的 window.__game / window.__test 接口。
 */
import * as THREE from '../../vendor/three.module.js';
import { VoxelWorld, SAVE_VERSION, GEN_DEEP, GEN_LEGACY, NEW_WORLD_GEN_VERSION, genVersionFromMeta, FRAME_BUDGET, LOAD_SLICE_BUDGET } from '../world/world.js';
import { SEA_LEVEL, WORLD_H, coordKey, CHUNK_SX, CHUNK_SZ } from '../world/chunk.js';
import { WorldView } from '../gfx/view.js';
import { Particles, HeldItemView } from '../gfx/entities.js';
import { WeatherFX } from '../gfx/weatherfx.js';
import { LightningFX } from '../gfx/lightning.js';
import { Weather } from '../core/weather.js';
import { lightningDamage, nextStrikeDelay, pickStrikeOffset, thunderDelay } from '../core/lightning.js';
import { hurtSoundPlan } from '../core/hurtsounds.js';
import { createEatSession, tickEatSession } from '../core/eating.js';
import {
  VILLAGER_TRADES, VILLAGER_OFFSETS, villageLayout, chooseVillageSite, performTrade,
  tradesFor, professionName, VILLAGE_RADIUS
} from '../core/village.js';
import { CAMP_RADIUS, CAMP_MAX_EXTENT, CAMP_CHESTS, chooseCampSite, campLayout, campLoot } from '../core/camp.js';
import { buildMapChunk, compassDegrees, compassDirection, mapLandmarkMarkers } from '../core/map.js';
import { filterCreativeItems } from '../core/creative.js';
import { isSkyExposed, rainWetsFarmland, cropRainMultiplier, RAIN_GROWTH_MULTIPLIER } from '../core/farmrain.js';
import { guardianSiteKey, normalizeGuardianState, claimGuardianReward, guardianArmed, guardianWardSpots, chooseGuardianStand, GUARDIAN_WARDS, GUARDIAN_HP, GUARDIAN_LEASH } from '../core/guardian.js';
import { rectsOverlap } from '../core/hud.js';
import {
  LANDMARK_TYPES, LANDMARK_TRIGGER_RADIUS, LANDMARK_DISCOVER_RADIUS, LANDMARK_SCAN_SECONDS,
  candidateFor, nearbyRegions, landmarkLayout, landmarkLoot
} from '../core/landmarks.js';
import { explosionCells, explosionDamage, breakableAt, CREEPER_POWER, CREEPER_DAMAGE_RANGE, CREEPER_MAX_DAMAGE } from '../core/explosion.js';
import {
  stepFuse, TNT_FUSE_SECONDS, TNT_POWER, TNT_DAMAGE_RANGE, TNT_MAX_DAMAGE,
  tntBlastSpec, tntSubmerged, TNT_CHAIN_RADIUS, TNT_CHAIN_DEPTH, TNT_CHAIN_FUSE, TNT_CHAIN_MAX
} from '../core/tnt.js';
import { PlayerController, PHYS } from './controller.js';
import { InputManager } from './input.js';
import { Interaction } from './interaction.js';
import { Inventory, HOTBAR_SIZE } from './inventory.js';
import { MobManager, computePose, fishSchoolOf, mobSkinReadout, limbPivotRead, FISH_SITE_STEP, FISH_SCHOOL_MIN, FISH_SCHOOL_MAX, FISH_WATER_DEPTH, FISH_AIR_SECONDS, FISH_MAX_ALIVE, birdFlockOf, flightRules, AIR_TYPES, SPAWN_DARK_LIMIT, SPAWN_DAY_LIGHT, SPAWN_CAVE_CAP, SPAWN_CAVE_INTERVAL, SPAWN_UNDERGROUND_MIN_DIST, SPAWN_UNDERGROUND_RANGE, UNDERGROUND_MIN_COVER, UNDERGROUND_MAX_DEPTH } from '../world/mobs.js';
import { mobTexStats } from '../gfx/mobtex.js';
import { Furnace, CraftingGrid, SMELT_BASE_SECONDS } from '../core/machines.js';
import { B, BLOCKS, AIR, blockName, isPlant, isSolid, canTill, canPlantSeed, farmlandShouldRevert, tileForFace } from '../core/blocks.js';
import { getItem, ITEMS } from '../core/items.js';
import { Achievements, itemAchievementIds, craftAchievementIds } from '../core/achievements.js';
import { QuestChain, QUESTS } from '../core/quests.js';
import { entityBrightness } from '../core/entitylight.js';
import { isNight, advanceToMorning } from '../core/time.js';
import { normalizeSeed } from '../core/rng.js';
import { Sfx, SOUND_NAMES } from '../audio/sfx.js';
import { Storage } from '../save/storage.js';

export const DEFAULT_SETTINGS = {
  volumeMaster: 0.7, volumeMusic: 0.45, volumeSfx: 0.8,
  sensitivity: 0.0022, fov: 70, renderDistance: 6, brightness: 1.0, renderScale: 1.0,
  autosaveSeconds: 45, dayLengthSeconds: 600, showFps: false, particles: true, bobbing: true,
  music: true
};

const DAY_TICKS = 1.0;

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.state = 'menu';           // menu | playing | paused | dead
    this.settings = Object.assign({}, DEFAULT_SETTINGS);
    this.sfx = new Sfx();
    this.storage = new Storage();
    this.view = null;
    this.world = null;
    this.controller = null;
    this.inventory = null;
    this.interaction = null;
    this.particles = null;
    this.weather = null;             // 天气状态（core/weather.js）
    this.weatherFX = null;           // 降水粒子层（gfx/weatherfx.js）
    this.lightningFX = null;         // 雷暴闪电折线（gfx/lightning.js）
    this.lightning = null;           // {timer,strikes,flashes,flashT,last}
    this.input = null;
    this.time = 0.08;              // 0..1，0=日出
    this.elapsed = 0;
    this.saveTimer = 0;
    this.lastSaveAt = 0;
    this.meta = null;              // {name, seed, mode}
    this.spawn = { x: 0.5, y: 40, z: 0.5 };
    this.bedSpawn = null;        /* T2 床重生点（{x,y,z} 站在床上方），null 表示未设置 */
    this.openUI = null;            // 'inventory' | 'crafting' | 'furnace' | 'settings' | 'chest'
    this.playerCraft = new CraftingGrid(2);
    this.tableCraft = new CraftingGrid(3);
    this.activeCraft = this.playerCraft;
    this.activeFurnace = null;
    this.ui = null;
    this.fps = 0; this._frames = 0; this._fpsT = 0;
    this.pickupToastTimer = 0;
    this.heldSwingPhase = 0;
    this._boundLoop = this.loop.bind(this);
    this._raf = 0;
    this._lastTime = 0;
    this.hunger = 20;              // 第二阶段启用，这里先占位并保持满值
    this.deathReason = '';
    this.stats = { mined: 0, placed: 0, crafted: 0, smelted: 0, walked: 0, trades: 0 };
    /* T3 成就与战斗反馈计数（后者是验收读数：命中/格挡/受伤/护甲碎裂各自走了几次） */
    this.achievements = new Achievements();
    this.achievementToasts = 0;
    /* Q1：目标链是独立状态，不进成就系统（8 条 / count / list / ids 一律不动） */
    this.quests = new QuestChain();
    this.feedback = { hit: 0, block: 0, hurt: 0, armorBreak: 0 };
    /* T5 TNT：引信状态只存在内存（不入存档），方块本身走正常 setBlock/diff */
    this.tnt = new Map();
    this.tntBlasts = 0;
    this._lastTntBlast = null;
    /* 滚动任务 6：村庄站点元数据（方块本身走 world diff 存档） */
    this.village = null;
    this.activeVillager = null;
    this._lastTrade = null;
    /* E3：废弃矿工营地元数据（方块/箱子走 world diff 与 containers 存档） */
    this.camp = null;
    this.campBuilds = 0;
    /* 滚动任务 8：地图探索数据（openWorld 会按存档重建） */
    this.mapSeen = {};
    this._mapChunkKey = null;
    /* R1：探索地点注册表（方块走 diff，箱子走 containers，这里只记元数据/发现状态） */
    this.landmarks = Object.create(null);
    this.landmarkStats = { scans: 0, builds: 0, discoveries: 0, discoveryToasts: 0, blocked: 0, failed: 0, lastBuildMs: 0, maxBuildMs: 0, lastScanMs: 0, maxScanMs: 0, last: null, lastDiscovery: null, lastDiscoveryToast: null };
    this._landmarkScanT = 0;
    this._landmarkSkip = Object.create(null);
    this._nearLandmarks = [];
    /* B：事件音效计数（只在内存里，不入存档）。用来钉「事件真的响了」而不是只改了字段 */
    this.audioCues = { discovery: 0, caveEnter: 0, quest: 0, last: null };
    this._audioScenePrev = null;
  }

  /* ================== 启动 ================== */
  async init(ui) {
    this.ui = ui;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.storage.loadSettings());
    /* B：以前这里只把设置读进 this.settings，从没下发给 Sfx ——
       于是设置里的三个音量滑条只有在「动过一下」之后才生效，新开游戏时 Sfx 用的还是它自己的 DEFAULTS。 */
    this.applyAudioVolumes();
    // 视图在开始游戏时才创建，避免主菜单占 GPU；但为了背景动画先建一个轻量视图
    return this;
  }

  /** B：音量下发的唯一入口（init 与设置面板都走这里，避免再出现「字段改了但没接线」） */
  applyAudioVolumes() {
    const s = this.settings;
    if (!this.sfx) return false;
    this.sfx.setMasterVolume(s.volumeMaster);
    this.sfx.setSfxVolume(s.volumeSfx);
    this.sfx.setMusicVolume(s.volumeMusic);
    return true;
  }

  /* ================== 世界 ================== */
  async newWorld(name, seedInput, mode) {
    const seedStr = (seedInput === '' || seedInput === null || seedInput === undefined)
      ? String(Math.floor(Math.random() * 1e9)) : String(seedInput);
    const seed = normalizeSeed(seedStr);
    return this.openWorld({
      meta: { name: name || '新的世界', seed: seedStr, numericSeed: seed, mode: mode || 'survival', version: SAVE_VERSION, genVersion: NEW_WORLD_GEN_VERSION, createdAt: Date.now() },
      player: null, inventory: null, time: 0.08, chunks: {}, furnaces: {}
    }, true);
  }

  async loadWorld(name) {
    const data = await this.storage.loadWorld(name);
    if (!data) throw new Error('存档不存在：' + name);
    return this.openWorld(data, false);
  }

  async openWorld(data, isNew) {
    const tEnter = performance.now();
    this.disposeWorld();
    const meta = data.meta;
    const seed = meta.numericSeed !== undefined ? meta.numericSeed : normalizeSeed(meta.seed);
    this.meta = Object.assign({ numericSeed: seed }, meta);

    /* 阶段 1：生成版本从存档 meta 里取（旧档缺字段一律旧布局，规则在 genVersionFromMeta 里单测） */
    this.world = new VoxelWorld(seed, { genVersion: genVersionFromMeta(meta) });
    this.world.furnaceFactory = (coords) => new Furnace(coords);
    this.view = new WorldView(this.canvas, {
      renderDistance: this.settings.renderDistance, fov: this.settings.fov,
      brightness: this.settings.brightness, world: this.world
    });
    this.view.setWorld(this.world);
    this.scene = this.view.scene;
    this.camera = this.view.camera;
    this.scene.add(this.camera);              // 手持物品挂在相机下
    this.tnt = new Map();
    this.tntBlasts = 0;
    this._lastTntBlast = null;
    this.village = null;
    this.activeVillager = null;
    this._lastTrade = null;
    this.camp = null;
    this.campBuilds = 0;
    this.mapSeen = {};
    this._mapChunkKey = null;
    this.landmarks = Object.create(null);
    this.landmarkStats = { scans: 0, builds: 0, discoveries: 0, discoveryToasts: 0, blocked: 0, failed: 0, lastBuildMs: 0, maxBuildMs: 0, lastScanMs: 0, maxScanMs: 0, last: null, lastDiscovery: null, lastDiscoveryToast: null };
    this._landmarkScanT = 0;
    this._landmarkSkip = Object.create(null);
    this._nearLandmarks = [];
    /* B：事件音效计数按「每个世界会话」归零（不入存档，读档不会继承上一个世界的数字） */
    this.audioCues = { discovery: 0, caveEnter: 0, quest: 0, last: null };
    this._audioScenePrev = null;
    this.particles = new Particles(this.scene);
    // 天气：纯逻辑状态（core/weather.js）+ 跟着相机的降水粒子层
    this.weather = new Weather();
    this.weatherFX = new WeatherFX(this.scene);
    this.lightningFX = new LightningFX(this.scene);
    this.lightning = { timer: 3.2, strikes: 0, flashes: 0, flashT: 0, last: null };

    this.controller = new PlayerController(this.world);
    this.controller.creative = meta.mode === 'creative';
    this.inventory = new Inventory();
    this.inventory.infinite = meta.mode === 'creative';
    // T1：护甲挂钩 —— 控制器只管「这次扣多少」，点数与耐久由背包回答
    this.controller.armor = {
      points: () => this.inventory.armorPoints(),
      onHit: () => this.inventory.damageArmor(1)
    };

    this.interaction = new Interaction({
      world: this.world, view: this.view, controller: this.controller,
      inventory: this.inventory, sfx: this.sfx, game: this, particles: this.particles,
      input: { state: {} }, heldSwing: (strength, kind) => this.swing(strength, kind)
    });

    this._setupInput();
    this.heldView = new HeldItemView(this.camera, this.scene);
    this.mobs = new MobManager({
      world: this.world, scene: this.scene, game: this, sfx: this.sfx,
      controller: this.controller, inventory: this.inventory, particles: this.particles
    });
    this.crops = new Map();          // "x,y,z" -> 已生长秒数
    this.saplings = new Map();       // "x,y,z" -> {age, kind}
    this.farmlands = new Map();      // T1 "x,y,z" -> {dryT} 干耕地累计秒数（用于随机刻退回泥土）
    /* E4：雨天联动诊断（不存档；exposed/sheltered 是真实作物步数，extra 是雨水实际多给的生长秒数） */
    this.rainCropStats = { exposedTicks: 0, shelteredTicks: 0, extra: 0, lastExposedMultiplier: 1 };
    if (data.saplings) for (const k of Object.keys(data.saplings)) this.saplings.set(k, data.saplings[k]);
    this.interaction.ctx.mobs = this.mobs;
    this._wireEvents();

    // 数据
    this.world.applySavedData(data.chunks || {});
    this.world.applyFurnaces(data.furnaces || {});
    this.world.applyContainers(data.containers || {});
    this.time = typeof data.time === 'number' ? data.time : 0.08;
    if (data.inventory) this.inventory.deserialize(data.inventory);
    // T1 装备：旧存档没有 armor 字段 → deserializeArmor 保持四个空位
    this.inventory.deserializeArmor(data.armor);
    /* T3 成就：读档恢复；旧档没有 achievements 字段时按现有背包/装备静默补记（不弹 toast） */
    this.achievements = Achievements.deserialize(data.achievements);
    this.achievementToasts = 0;
    this.achievements.absorbInferred(this.achievementState());
    /* Q1：目标链独立恢复。旧档没有 quests 字段 → 空状态 + 静默推断当前进度，
       绝不弹「你已完成 X」；新世界不在这里推断，等 onWorldReady 后弹第一步提示。 */
    this.quests = QuestChain.deserialize(data.quests);
    if (!isNew) this.quests.sync(this.questSnapshot(), true);
    if (data.crafting) { this.playerCraft.deserialize(data.crafting.player); this.tableCraft.deserialize(data.crafting.table); }

    // 出生点
    const spawn = data.player && data.player.spawn ? data.player.spawn : null;
    if (spawn) this.spawn = spawn;
    else {
      const s = this.world.terrain.findSpawn();
      this.spawn = { x: s.x, y: s.y, z: s.z };
    }
    // T2 床重生点（旧档无 player.bed → null）
    const bed = data.player && data.player.bed ? data.player.bed : null;
    this.bedSpawn = bed && Number.isFinite(bed.x) ? { x: bed.x, y: bed.y, z: bed.z } : null;

    this.resize();
    // 先围绕出生点准备好区块，再生成网格。
    // T2（已知问题 #20）：这一段原本是「一次性同步灌完整个地图」，实测 1.7 秒冻结，
    // 而且这期间主循环还没启动，位置监视器连一帧都看不到（旧版 e2e 的 frames=1 就是这个）。
    // 现在先把循环跑起来（state='loading' 只做环境与渲染，不做物理与交互），再分片灌区块。
    this.world.setCenter(this.spawn.x, this.spawn.z);
    const myWorld = this.world;             // 用来识别「这次加载已经被下一次读档顶掉了」
    const prepMs = Math.max(0, Math.round(performance.now() - tEnter));
    this.state = 'loading';
    this._loadingWorld = true;              // 监视器：这段时间不做位移判定（见 monitorPosition）
    this._lastTime = performance.now();
    this._lastRaf = performance.now();      // 帧间隔从「开始灌区块」算起，不含回主菜单后的空闲
    this.startLoop();
    await this.pumpWorldLoading({ prepMs, isNew });
    // openWorld 现在中途会让出主线程，所以「回主菜单 / 又点了一次读档」可能插进来：
    // world 被换掉就说明这次已经作废，继续走下去会拿上一次的存档数据去摆弄下一次刚建好的世界。
    if (this.world !== myWorld) { this._loadingWorld = false; return this; }

    if (data.player) {
      this.controller.setPositions(data.player.x, data.player.y, data.player.z);
      this.controller.yaw = data.player.yaw || 0;
      this.controller.pitch = data.player.pitch || 0;
      this.controller.health = data.player.health === undefined ? 20 : data.player.health;
      this.controller.hunger = data.player.hunger === undefined ? 20 : data.player.hunger;
      this.controller.saturation = data.player.saturation === undefined ? 5 : data.player.saturation;
      if (data.player.flying !== undefined) this.controller.flying = !!data.player.flying && this.controller.creative;
    } else {
      this.controller.spawnAt(this.spawn.x, this.spawn.y, this.spawn.z);
      this.controller.health = 20;
      if (isNew && meta.mode === 'survival') this.inventory.giveStartingItems([]);
    }
    this._loadingWorld = false;           // 玩家已经站在存档位置上了，从下一帧起恢复位移判定
    if (data.selected !== undefined) this.inventory.select(data.selected);
    // 天气：旧存档完全没有 weather 字段也必须能读（一律回落晴天）
    this.weather = Weather.deserialize(data.weather);
    if (this.lightning) this.lightning.timer = this.weather.isStorm ? 2.2 : 3.2;
    /* 试听/验收世界可以在 meta 里声明 noSpawn：不再自然刷怪。
       · 只有 noSpawn：顺带清掉存档里已经跑进来的生物（听脚步/挖放的安静环境）；
       · noSpawn + mobsFixed：保留存档里手工摆好的怪（战斗试听场），只是不再补新的。
       缺字段时行为与旧档完全一致。 */
    if (meta.noSpawn) {
      this.mobs.maxMobs = 0;
      if (meta.mobsFixed) this.mobs.applySaved(data.mobs);
      else this.mobs.clear();
    } else {
      this.mobs.applySaved(data.mobs);
    }
    /* 滚动任务 6：新世界在出生点附近生成一座小村庄；旧存档没有 village 字段就保持原样（不硬塞建筑）。
       村庄方块本身走 world diff 存档，这里只记站点坐标供诊断/验收。 */
    this.village = data.village && data.village.built ? data.village : null;
    if (!this.village && isNew) this.buildVillage();
    /* E3：旧存档没有 camp 字段 → 不补建；只有新世界才尝试建一次（选址失败就跳过，不写半结构）。 */
    this.camp = data.camp && data.camp.built ? data.camp : null;
    if (!this.camp && isNew) this.buildCamp();
    /* R1：探索地点注册表；旧档没有 landmarks 字段 → 空表，不补建任何历史地点。 */
    this.landmarks = Object.create(null);
    if (data.landmarks && typeof data.landmarks === 'object') {
      for (const id of Object.keys(data.landmarks)) {
        const lm = data.landmarks[id];
        if (!lm || typeof lm !== 'object' || !lm.built) continue;
        this.landmarks[id] = Object.assign({}, lm, { discovered: !!lm.discovered });
      }
    }
    /* 阶段 5：守卫状态按地点稳定 ID 读回；旧档缺 guardian 字段 → 未挑战、满血、未领奖。 */
    this.guardian = normalizeGuardianState(data.guardian, guardianSiteKey(this.guardianSite()));
    this.guardianStats = null;
    /* 滚动任务 8：旧档没有 mapSeen → 空地图；地图数据只影响面板，不碰方块/存档格式 */
    this.mapSeen = (data.mapSeen && typeof data.mapSeen === 'object') ? data.mapSeen : {};
    this._mapChunkKey = null;
    if (data.crops) for (const k of Object.keys(data.crops)) this.crops.set(k, data.crops[k]);
    if (data.farmlands) for (const k of Object.keys(data.farmlands)) this.farmlands.set(k, data.farmlands[k]);

    // 创造模式给一背包方块便于建造（不与生存混用）
    if (meta.mode === 'creative' && !data.inventory) this.fillCreativeHotbar();

    // 恢复地上的掉落物（给一点拾取延迟）
    if (Array.isArray(data.drops)) {
      for (const d of data.drops) {
        if (!d || !getItem(d.i)) continue;
        const drop = this.interaction.drops.spawn(d.i, Math.max(1, d.c | 0), d.x, d.y, d.z, false);
        if (drop) { drop.pickDelay = 2; drop.vx = drop.vy = drop.vz = 0; }
      }
    }

    this.state = 'playing';
    this.saveTimer = 0;
    this._lastTime = performance.now();
    // 主循环在 pumpWorldLoading 之前就已经启动了（state='loading'），这里只切换状态，不能再 startLoop 一次
    this.ui.onWorldReady(this);
    /* Q1：新世界在这里弹第一步目标提示；读档时已在 openWorld 静默推断过，不会重复弹 */
    this.refreshQuests(false);
    this.sfx.resume();
    const a = this.audioSceneState();
    this.sfx.setAmbientEnabled(true);
    if (this.settings.music) this.sfx.startMusic(a.scene);
    this.sfx.updateAmbient(a);
    return this;
  }

  fillCreativeHotbar() {
    const preset = ['grass_block', 'dirt', 'stone', 'cobblestone', 'planks', 'oak_log', 'glass', 'torch', 'crafting_table'];
    preset.forEach((it, i) => { this.inventory.set(i, { item: it, count: 64 }); });
    this.inventory.emit('load');
  }

  /**
   * 滚动任务 6：在出生点附近生成小村庄。
   * 先按地形高度整平 13×13 的台地（树木与草花一并清掉），再铺 villageLayout 的方块，
   * 最后按固定偏移放农夫/图书管理员/铁匠三名村民。方块全部走 world.setBlock → 自动进 diff 存档。
   */
  buildVillage() {
    if (!this.world || !this.mobs) return null;
    /* E2：重复调用只返回已有村庄，绝不重复铺建筑或刷居民（旧档/多次初始化都安全）。 */
    if (this.village && this.village.built) return this.village;
    const site = chooseVillageSite(
      (x, z) => this.world.surfaceHeight(x, z),
      this.spawn, this.world.seaLevel, WORLD_H
    );
    if (!site) return null;
    const baseY = Math.max(site.y, this.world.seaLevel + 2);
    const R = VILLAGE_RADIUS;
    const yTop = Math.min(WORLD_H - 1, baseY + 12);
    /* 1) 整平：先记下每列原始地形高度（用纯地形函数，避免树冠把台地抬高） */
    const heights = new Map();
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = site.x + dx, z = site.z + dz;
        heights.set(dx + ',' + dz, this.world.surfaceHeight(x, z));
      }
    }
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = site.x + dx, z = site.z + dz;
        const h = heights.get(dx + ',' + dz);
        for (let y = baseY + 1; y <= yTop; y++) this.world.setBlock(x, y, z, AIR, 0);
        for (let y = h + 1; y < baseY; y++) this.world.setBlock(x, y, z, B.DIRT, 0);
        this.world.setBlock(x, baseY, z, B.GRASS, 0);
      }
    }
    /* 2) 建筑与农田（确定性布局；y 相对台地顶面） */
    const cells = villageLayout();
    let placed = 0;
    for (const c of cells) {
      if (this.world.setBlock(site.x + c.x, baseY + c.y, site.z + c.z, c.id, c.meta)) placed++;
    }
    /* 3) 三名职业村民：位置相对站点固定，职业由 VILLAGER_OFFSETS 决定；家在原地。 */
    const spawned = [];
    for (const o of VILLAGER_OFFSETS) {
      const vx = site.x + o.x, vz = site.z + o.z, vy = baseY + 1;
      const v = this.mobs.spawn('villager', vx, vy, vz, {
        profession: o.profession, home: { x: vx, y: vy, z: vz }
      });
      if (v) spawned.push(o.profession);
    }
    this.village = {
      x: site.x, y: baseY, z: site.z, built: true,
      spread: site.spread, blocks: cells.length, placed,
      villager: spawned.length > 0, villagers: spawned
    };
    return this.village;
  }

  /**
   * E3：在出生点 24~48 格外建一座废弃矿工营地。
   * 先做纯逻辑选址与布局校验，确认所有目标区块已加载、所有方块在世界高度内，再开始写；
   * 站点不合格直接返回 null（不写半截结构）。箱子内容在建站时一次性写入 world.containers。
   */
  buildCamp() {
    if (!this.world || !this.mobs) return null;
    if (this.camp && this.camp.built) return this.camp;
    const site = chooseCampSite(
      (x, z) => this.world.surfaceHeight(x, z),
      this.spawn, this.world.seaLevel, WORLD_H, this.village
    );
    if (!site) return null;
    const baseY = site.y;
    const cells = campLayout();
    for (const c of cells) {
      if (baseY + c.y < 1 || baseY + c.y >= WORLD_H) return null;
    }
    /* 先把营地/楼梯/房间覆盖到的区块生成好，否则 setBlock 会静默失败（半结构）。 */
    const cx0 = Math.floor((site.x - 6) / 16), cx1 = Math.floor((site.x + 6) / 16);
    const cz0 = Math.floor((site.z - 6) / 16), cz1 = Math.floor((site.z + 17) / 16);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) this.world.ensureChunk(cx, cz);
    }
    /* 整平：营地 9×9 + 南侧楼梯/地下房间占地。地下房间顶只比地面低 1 格，
       不把房间上方也整平的话，坡地上的石砖顶会从地表戳出来（实测会出现悬空石板）。 */
    const flatten = (x, z) => {
      const h = this.world.surfaceHeight(x, z);
      for (let y = baseY + 1; y <= baseY + 8; y++) this.world.setBlock(x, y, z, AIR, 0);
      for (let y = h + 1; y < baseY; y++) this.world.setBlock(x, y, z, B.DIRT, 0);
      this.world.setBlock(x, baseY, z, B.GRASS, 0);
    };
    for (let dz = -CAMP_RADIUS; dz <= CAMP_RADIUS; dz++) {
      for (let dx = -CAMP_RADIUS; dx <= CAMP_RADIUS; dx++) flatten(site.x + dx, site.z + dz);
    }
    for (let dz = CAMP_RADIUS + 1; dz <= CAMP_RADIUS + 12; dz++) {
      for (let dx = -4; dx <= 4; dx++) flatten(site.x + dx, site.z + dz);
    }
    let placed = 0;
    for (const c of cells) {
      if (this.world.setBlock(site.x + c.x, baseY + c.y, site.z + c.z, c.id, c.meta)) placed++;
    }
    /* 固定战利品：同一颗种子 + 同一站点 → 同一份内容；写入容器而不是开箱随机。 */
    const loot = campLoot(this.meta ? this.meta.seed : '', site);
    const chests = [];
    for (const c of CAMP_CHESTS) {
      const ax = site.x + c.x, ay = baseY + c.y, az = site.z + c.z;
      if (this.world.getBlock(ax, ay, az) !== B.CHEST) return null;
      const slots = this.world.getContainer(ax, ay, az);
      const items = loot[c.table] || [];
      items.forEach((it, i) => { slots[i] = { item: it.item, count: it.count }; });
      chests.push({ x: ax, y: ay, z: az, table: c.table, items: items.map(it => ({ ...it })) });
    }
    this.campBuilds = (this.campBuilds || 0) + 1;
    this.camp = {
      x: site.x, y: baseY, z: site.z, built: true,
      spread: site.spread, blocks: cells.length, placed,
      chests, diamond: !!loot.diamond,
      room: { x0: site.x - 3, x1: site.x + 3, z0: site.z + 8, z1: site.z + 14, floor: baseY - 5, ceil: baseY - 1 },
      stairs: { x: site.x, z0: site.z + 3, z1: site.z + 7, top: baseY, bottom: baseY - 4 }
    };
    return this.camp;
  }

  /* T2：分片准备世界。每片只做 LOAD_SLICE_BUDGET 那么多活，然后让出主循环，
     这样读档期间画面照常推进、位置监视器也在记账，不会再出现「一帧两秒」。
     片间让帧优先等 RAF；RAF 万一被节流（隐藏窗口）就用 50ms 定时器兜底，保证加载能推进。 */
  async pumpWorldLoading(opts = {}) {
    const deadlineMs = opts.deadlineMs === undefined ? 20000 : opts.deadlineMs;
    this._loadSeq = (this._loadSeq || 0) + 1;
    const seq = this._loadSeq;
    const st = this._loadStats = {
      isNew: !!opts.isNew, prepMs: opts.prepMs || 0, slices: 0, maxSliceMs: 0,
      pumpMs: 0, totalMs: 0, pendingStart: 0, pendingEnd: 0, deadlineHit: false, cancelled: false,
      maxMeshChunkMs: 0, fps: 0, fracAvg: 0, fracSum: 0, fracStalls: 0
    };
    if (!this.world) { st.cancelled = true; return st; }
    const t0 = performance.now();
    const sum = (p) => p.gen + p.light + p.mesh;
    st.pendingStart = sum(this.world.pending());
    // 进度的分母用「本次要网格化的区块数」，分子用「已经网格化了多少」：
    // 直接用剩余队列长度不行 —— 生成一个区块会额外产生两项待办，队列中途会比起点更大。
    const mesh0 = this.world.stats.meshed;
    const meshTotal = Math.max(1, st.pendingStart);
    this.reportLoadProgress(0);
    for (; ;) {
      // 每片之前先看一眼世界还在不在、还是不是这次加载（中途回主菜单 / 又点了一次读档就要收手）
      if (!this.world || seq !== this._loadSeq) { st.cancelled = true; break; }
      const s0 = performance.now();
      this.world.update(0.016, LOAD_SLICE_BUDGET, this.view);
      const sliceMs = performance.now() - s0;
      st.slices++;
      if (sliceMs > st.maxSliceMs) st.maxSliceMs = sliceMs;
      const left = sum(this.world.pending());
      const frac = Math.max(0, Math.min(1, (this.world.stats.meshed - mesh0) / meshTotal));
      st.fracSum += frac;
      if (frac === 0) st.fracStalls++;      // 这一片进度还是 0：连续几片如此就等于进度条贴在原地
      this.reportLoadProgress(frac);
      if (!left) break;
      if (performance.now() - t0 > deadlineMs) { st.deadlineHit = true; break; }
      await this.yieldFrame();
    }
    st.maxSliceMs = Math.round(st.maxSliceMs * 10) / 10;
    st.pendingEnd = this.world ? sum(this.world.pending()) : 0;
    st.maxMeshChunkMs = this.world ? Math.round(this.world.perf.maxMeshChunkMs * 10) / 10 : 0;
    st.fracAvg = Math.round(st.fracSum / Math.max(1, st.slices) * 100) / 100;   // 平均分片进度：进度条真的在动的话应该在 0.5 附近
    st.pumpMs = Math.round(performance.now() - t0);
    st.totalMs = st.pumpMs + st.prepMs;
    st.fps = this.fps;
    return st;
  }

  /* 让出主循环一次：RAF 优先，定时器兜底（两个谁先到算谁，只 resolve 一次） */
  yieldFrame() {
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (done) return; done = true; res(); };
      try { requestAnimationFrame(fin); } catch (e) { setTimeout(fin, 16); }
      setTimeout(fin, 50);
    });
  }

  /* 加载进度（0~1）：给进度条与「共 N 项待办」提示用；界面没这个方法也不许拖垮加载 */
  reportLoadProgress(frac) {
    if (!this.ui || typeof this.ui.setLoadingProgress !== 'function') return;
    const done = Math.max(0, Math.min(1, frac));
    this.ui.setLoadingProgress(done, this._loadStats ? this._loadStats.pendingStart : 0);
  }

  disposeWorld() {
    this.cancelBlocking();
    this.cancelEating();
    /* 阶段 1 分段计时：world 对象每次 openWorld 都会被换掉，per-world 的 totals 一读档就归零，
       回答不了「整程 320 秒花在哪」。所以在这里把它并进会话级的总账（跨读档累计）。 */
    if (!this.perfTotals) {
      this.perfTotals = { frameMs: 0, genMs: 0, lightMs: 0, meshMs: 0, calls: 0,
        genChunks: 0, lightChunks: 0, meshChunks: 0, worlds: 0 };
    }
    if (this.world && this.world.perf && this.world.perf.totals) {
      const src = this.world.perf.totals, acc = this.perfTotals;
      acc.frameMs += src.frameMs; acc.genMs += src.genMs; acc.lightMs += src.lightMs; acc.meshMs += src.meshMs;
      acc.calls += src.calls; acc.genChunks += src.genChunks; acc.lightChunks += src.lightChunks;
      acc.meshChunks += src.meshChunks; acc.worlds++;
    }
    this.clearTnt();
    this._loadSeq = (this._loadSeq || 0) + 1;   // 让在飞的分片加载下一片就收手
    this._loadingWorld = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.stopLoop = true;
    if (this.mobs) this.mobs.clear();
    if (this.interaction && this.interaction.drops) this.interaction.drops.clear();
    this.crops = new Map();
    this.saplings = new Map();
    this.farmlands = new Map();
    this.rainCropStats = { exposedTicks: 0, shelteredTicks: 0, extra: 0, lastExposedMultiplier: 1 };
    this.activeChest = null;
    if (this.particles) this.particles.dispose(this.scene);
    if (this.weatherFX) this.weatherFX.dispose(this.scene);
    if (this.lightningFX) this.lightningFX.dispose();
    if (this.view) this.view.dispose();
    this.world = null; this.view = null; this.controller = null;
    this.inventory = null; this.interaction = null; this.particles = null;
    this.weather = null; this.weatherFX = null; this.lightningFX = null; this.lightning = null;
    this.scene = null; this.camera = null;
    this.activeFurnace = null; this.openUI = null;
    this.sfx.stopMusic();
    this.sfx.stopAmbient();
    /* 阶段 3c：同步输入生命周期 —— controller 已置空，就切断指针锁与玩法输入，
       让退出 / 切世界 / 读档边界上的 mousemove 不再转发到 onLook。
       openWorld() 末尾的 _setupInput() 会 setUIMode(false) 把它恢复。 */
    if (this.input) this.input.setUIMode(true);
  }

  /* ================== 输入 ================== */
  _setupInput() {
    /* 读档会重新创建 world/controller/interaction，但 canvas 与 Game 实例没变。
       旧实现每次都 new InputManager，窗口上的 keydown 监听随之叠加：
       读档 N 次后一次 Esc 会被处理 N 次（关界面之后又把游戏暂停）。
       这里复用唯一实例，只把输入状态清干净并重新指向新的交互层。 */
    if (this.input) {
      this.input.setUIMode(false);
      this.input._clearAll();
      if (this.interaction) this.interaction.ctx.input = this.input;
      return this.input;
    }
    this.input = new InputManager(this.canvas, {
      getSensitivity: () => this.settings.sensitivity,
      onLook: (dx, dy, sens) => {
        /* 阶段 3c：退出世界 / 切世界 / 读档期间 disposeWorld() 会把 controller 置空，
           但指针锁可能还没释放，mousemove 仍会转发进来。转向回调必须与当前状态一致：
           没有控制器就不改朝向（不是把异常吞进日志），正常游玩时的角度限制一字不变。 */
        const c = this.controller;
        if (!c || this.state !== 'playing') return;
        c.yaw -= dx * sens;
        c.pitch -= dy * sens;
        const lim = Math.PI / 2 - 0.001;
        c.pitch = Math.max(-lim, Math.min(lim, c.pitch));
      },
      onSelectSlot: (i) => this.selectHotbar(i),
      onScroll: (d) => { if (this.state === 'playing' && !this.openUI) this.selectHotbar(this.inventory.selected + d); },
      onDoubleJump: () => { const c = this.controller; if (c && this.state === 'playing' && c.creative) { const f = c.toggleFly(); this.ui.toast(f ? '飞行：开' : '飞行：关'); } },
      onLockChanged: (locked) => { this.ui.setPointerLocked(locked); },
      onCanvasClick: () => { this.sfx.resume(); },
      onKey: (code, e) => this.onKeyCode(code, e)
    });
    this.interaction.ctx.input = this.input;
  }

  onKeyCode(code, e) {
    const ui = this.ui;
    if (code === 'Escape') {
      if (this.openUI) { this.closeUI(); e.preventDefault(); return; }
      if (this.state === 'playing') { this.pause(); e.preventDefault(); }
      return;
    }
    if (this.openUI && code !== 'KeyE' && code !== 'KeyI') return;
    if (code === 'KeyE' || code === 'KeyI') {
      if (this.openUI === 'inventory' || this.openUI === 'crafting') this.closeUI();
      else if (this.state === 'playing') this.openInventory();
      e.preventDefault(); return;
    }
    if (code === 'F5') { this.requestManualSave(); e.preventDefault(); return; }
    if (code === 'F12') { ui.saveScreenshot(); e.preventDefault(); return; }
    if (code === 'F3') { this.settings.showFps = !this.settings.showFps; ui.applySettings(this.settings); ui.saveSettings(this.settings); return; }
    if (code === 'F1') { ui.toggleHud(); return; }
    /* P2：H 把常驻目标提示收成可选层（复用 Q1 的 dismiss/reopen，存档字段不变） */
    if (code === 'KeyH') {
      if (this.state === 'playing' && ui.toggleQuestHint) {
        const hidden = ui.toggleQuestHint();
        ui.toast(hidden ? '目标提示已收起 · H 展开' : '目标提示已展开', false, 1600);
      }
      e.preventDefault(); return;
    }
    if (code === 'KeyG') { this.dropHeld(); return; }
    if (code === 'KeyQ') { this.dropHeld(); return; }
    if (code === 'KeyF') {
      if (this.controller.creative) { const f = this.controller.toggleFly(); ui.toast('飞行：' + (f ? '开' : '关')); }
      else ui.toast('只有创造模式可以飞行');
      return;
    }
    if (/^Digit[1-9]$/.test(code)) { this.selectHotbar(parseInt(code.slice(5), 10) - 1); return; }
  }

  _wireEvents() {
    const c = this.controller;
    c.on('death', (reason) => this.onPlayerDeath(reason));
    c.on('hurt', (amount, reason, info) => {
      this.feedback.hurt = (this.feedback.hurt || 0) + 1;
      this.playHurtFeedback(info, amount);
      this.ui.damageFlash && this.ui.damageFlash(amount, reason);
    });
    c.on('heal', () => this.ui.updateHUD && this.ui.updateHUD(this));
    /* 本轮 D：起跳不再借 UI 的 click（听起来像点了按钮），换成身体/布料的一下 */
    c.on('jump', () => this.sfx.play('jump', { volume: 0.3, rate: 0.95 + Math.random() * 0.1 }));
    c.on('bounce', () => this.sfx.play('slime', { volume: 0.55, rate: 1.1 }));
    c.on('footstep', (blockId) => {
      this.sfx.play(this.interaction.stepSoundName(blockId), {
        rate: 0.97 + Math.random() * 0.06,
        volume: c.sneaking ? 0.2 : (c.sprinting ? 0.56 : 0.4)
      });
      this.stats.walked += 1;
    });
    c.on('land', (blockId, impact) => {
      const strength = Math.max(0, Math.min(1, (impact.speed - 3) / 13));
      this.sfx.play(this.interaction.movementSoundName(blockId, 'land'), {
        volume: (0.42 + strength * 0.26) * (c.sneaking ? 0.65 : 1),
        rate: 0.98 + Math.random() * 0.04
      });
    });
    c.on('modeChanged', () => { this.ui.updateHotbar(); this.ui.updateHUD(this); });
    // D2：刻意传送（出生点顶出、读档、重生）不算「瞬移 bug」，让监视器跳过两帧
    c.on('teleport', () => {
      this._teleportEv = (this._teleportEv || 0) + 1;
      this._teleportFrame = this._loopFrames || 0;
      if (this._posMon) this._posMon.paused = 2;
    });
    // D2：T4 的自动上台阶是一次性抬升，属于设计行为，监视器要给它单独的豁免额度。
    // 计数必须在「事件发生处」完成并作为唯一真相：旧写法只置一个跨帧旗标，
    // 实测会整批漏记（tryStepUp 执行=1、事件送达=1、监视器记账=0）。
    c.on('stepup', () => {
      this._stepupEv = (this._stepupEv || 0) + 1;
      if (!this._stepupTrace) this._stepupTrace = [];
      if (this._stepupTrace.length < 8) {
        this._stepupTrace.push({ ev: this._stepupEv, hasMon: !!this._posMon, loopFrames: this._loopFrames || 0 });
      }
    });
    /* 本轮 D：工具断裂有独立身份（旧实现借受伤的 hurt，玩家分不清「我被打」还是「工具坏了」） */
    this.inventory.on('toolBreak', (id) => {
      if (getItem(id)?.shield) return;  // 盾碎由成功格挡入口单独反馈，避免叠普通工具坏音。
      this.sfx.play('tool_break', { volume: 0.6 }); this.ui.toast('工具坏了');
    });
    this.inventory.on('change', () => {
      this.ui.updateHotbar();
      this.checkItemAchievements();       // T3：事件驱动，不在主循环里每帧扫背包
      /* Q1：只在真正游玩时推进目标链。加载期间的背包反序列化不能误弹目标提示。 */
      if (this.state === 'playing') this.refreshQuests(false);
    });
    // T1：护甲碎裂/装备变更要立刻反映到 HUD 与面板（不等下一帧）
    this.inventory.on('armorBreak', (id) => {
      this.feedback.armorBreak = (this.feedback.armorBreak || 0) + 1;
      this.sfx.play('armor_break' + (this.feedback.armorBreak % 2 === 0 ? '_b' : ''), { volume: 0.70, rate: 0.98 + Math.random() * 0.04 });
      if (this.particles && this.controller) {
        this.particles.spawn(this.controller.pos.x, this.controller.eyeY - 0.2, this.controller.pos.z, [0.82, 0.86, 0.9], 7, 0.35, 1.6);
      }
      if (this.ui && this.ui.armorBreakFlash) this.ui.armorBreakFlash();
      this.ui.toast((getItem(id) ? getItem(id).name : id) + '碎了');
    });
    this.inventory.on('equip', () => {
      this.ui.updateHotbar();
      this.ui.updateHUD && this.ui.updateHUD(this);
      // T3：穿上任意护甲（含读档后事件）解锁；已经解锁过会返回 null，不重复弹
      if (this.state === 'playing' && this.inventory.armor.some(Boolean)) this.unlockAchievement('armor');
    });

    /* T2 盾牌成功格挡：才在这里扣耐久、播专属音、出火星与轻反馈。
       举盾没挨打不会走到这里；创造模式不磨损；盾牌碎了立刻切换回空手。 */
    c.onShieldBlock = (info) => {
      const inv = this.inventory, held = inv ? inv.held() : null;
      const it = held ? getItem(held.item) : null;
      if (!it || !it.shield) return {};
      let broken = false;
      if (!c.creative) broken = inv.damageHeldTool(1);
      this.shieldBlocks = (this.shieldBlocks || 0) + 1;
      this.feedback.block = (this.feedback.block || 0) + 1;
      if (this.heldView) this.heldView.shieldKick = 1;   // V5：成功格挡的短后坐（与单纯举盾区分）
      this.sfx.play('shield_block' + (this.shieldBlocks % 2 === 0 ? '_b' : ''), { volume: 0.76, rate: 0.98 + Math.random() * 0.04 });
      const d = c.lookDir();
      if (this.particles) this.particles.spawn(c.pos.x + d.x * 0.55, c.eyeY - 0.18, c.pos.z + d.z * 0.55, [0.86, 0.92, 1], 8, 0.3, 1.5);
      if (this.ui && this.ui.blockFlash) this.ui.blockFlash();
      if (broken) {
        this._shieldBreakVar = (this._shieldBreakVar || 0) + 1;
        this.sfx.play('shield_break' + (this._shieldBreakVar % 2 === 0 ? '_b' : ''), { volume: 0.76 });
        this.ui.toast('盾牌碎了');
      }
      const dur = broken ? 0 : (inv.held() && inv.held().dur !== undefined ? inv.held().dur : null);
      return { broken, dur };
    };
  }

  /* 本轮 E2：受伤按真实原因分身份（映射规则在 core/hurtsounds.js，可单测）。
     · 摔落不叠第二个撞击（落地声由移动那一包负责），只留一个短、低、无冲击的闷哼；
     · 溺水用独立水下录音，和近战受击区分开；
     · 护甲**真正吸收**了伤害才叠一层金属接触，没穿甲不会凭空响；
     · 饥饿/中毒这类持续伤害更轻，避免与战斗受击抢耳。 */
  playHurtFeedback(info) {
    this._hurtVar = (this._hurtVar || 0) + 1;
    for (const cue of hurtSoundPlan(info, this._hurtVar)) {
      this.sfx.play(cue.name, {
        volume: cue.volume,
        rate: cue.rate + (Math.random() - 0.5) * 0.04
      });
    }
  }

  /** 立即清掉格挡（开界面 / 暂停 / 死亡 / 切物品 / 回菜单） */
  cancelBlocking() {    if (this.interaction) this.interaction.cancelBlocking();
    if (this.controller) this.controller.blocking = false;
  }

  /* ================== T3 成就 ================== */
  /** 当前背包 + 装备（供旧档补记与事件判定；不是每帧调用） */
  achievementState() {
    const items = Object.create(null);
    if (this.inventory) {
      for (const s of this.inventory.slots) if (s) items[s.item] = (items[s.item] || 0) + s.count;
    }
    return { items, armorEquipped: !!(this.inventory && this.inventory.armor.some(Boolean)) };
  }

  /* ================== Q1 目标链 ================== */
  /** 只读快照：当前背包物品 + 已解锁成就。不改任何状态，可无头单测。 */
  questSnapshot() {
    const items = Object.create(null);
    if (this.inventory) {
      for (const s of this.inventory.slots) if (s) items[s.item] = (items[s.item] || 0) + s.count;
    }
    return {
      items,
      achievementIds: this.achievements ? this.achievements.serialize() : []
    };
  }

  /**
   * 推进目标链并把「当前目标 / 一次性提示」交给 UI。
   * silent=true 用于读档：只推进状态，不产生任何提示。
   */
  refreshQuests(silent = false) {
    if (!this.quests) return null;
    const r = this.quests.sync(this.questSnapshot(), silent);
    /* 目标达成用短进展提示；读档静默推断不响，保持原创音符的音高。 */
    if (!silent && r && r.completedNow && r.completedNow.length && this.sfx) {
      this.sfx.play('levelup', { volume: 0.45 });
      this.markAudioCue('quest', r.completedNow.join(','));
    }
    if (this.ui && this.ui.updateQuestHint) {
      this.ui.updateQuestHint(this.quests.current, r.hint, this.quests.dismissed);
    }
    return r;
  }

  /** 只在背包内容变化（拾取/合成/熔炉/箱子/光标）时调用，不靠每帧穷举 */
  checkItemAchievements() {
    if (this.state !== 'playing' || !this.inventory) return;
    const items = this.achievementState().items;
    for (const item of Object.keys(items)) {
      if (items[item] <= 0) continue;
      for (const id of itemAchievementIds(item)) this.unlockAchievement(id);
    }
  }

  /** 合成产物触发制作类成就（只有真的 craft() 过才会调用） */
  onItemCrafted(item, count = 1) {
    if (this.state !== 'playing') return;
    for (const id of craftAchievementIds(item)) this.unlockAchievement(id);
    this.checkItemAchievements();
    /* Q1：合成产物可能不经过 inventory 'change' 的时序，这里补一次幂等推进 */
    this.refreshQuests(false);
  }

  /** @returns {object|null} 新解锁的成就定义 */
  unlockAchievement(id) {
    if (!this.achievements) return null;
    const def = this.achievements.unlock(id);
    if (!def) return null;
    this.achievementToasts = (this.achievementToasts || 0) + 1;
    if (this.ui && this.ui.achievementToast) this.ui.achievementToast(def);
    this.sfx.play('levelup', { volume: 0.4 });
    return def;
  }

  /* 近战/箭矢命中生物的反馈（由 MobManager.hitMob 调用；不改变伤害数值） */
  onMobHit(mob, damage) {
    this.feedback.hit = (this.feedback.hit || 0) + 1;
    if (this.ui && this.ui.hitMarker) this.ui.hitMarker();
  }

  selectHotbar(i) {
    // T2：切走手持物必须立刻取消格挡（否则会带着减速走，直到下一帧交互层反应）
    if (i !== this.inventory.selected) { this.cancelBlocking(); this.cancelEating(); }
    if (this.inventory.select(i)) { this.ui.updateHotbar(); this.swing(0.4, 'use'); }
  }

  swing(strength = 1, kind = 'attack') {
    if (this.heldView) { this.heldView.swing = strength; this.heldView.trigger(kind); }
  }

  dropHeld() {
    const stack = this.inventory.dropSelected(this.inventory.get(this.inventory.selected) ? 1 : 0);
    if (!stack) return;
    const d = this.controller.lookDir();
    const drop = this.interaction.drops.spawn(stack.item, stack.count,
      this.controller.pos.x + d.x * 0.6, this.controller.eyeY - 0.2, this.controller.pos.z + d.z * 0.6, false);
    if (drop) { drop.vx = d.x * 4; drop.vy = 1.4; drop.vz = d.z * 4; drop.pickDelay = 1.2; }
  }

  /* ================== UI 面板 ================== */
  openInventory() {
    this.cancelBlocking();
    this.cancelEating();
    this.openUI = 'inventory';
    this.activeCraft = this.playerCraft;
    this.input.setUIMode(true);
    this.ui.showInventory();
    this.sfx.play('open_ui', { volume: 0.4 });
  }

  openCrafting(size) {
    this.cancelBlocking();
    this.cancelEating();
    this.openUI = 'crafting';
    this.activeCraft = size === 3 ? this.tableCraft : this.playerCraft;
    this.input.setUIMode(true);
    this.ui.showCrafting(size);
    this.sfx.play('open_ui', { volume: 0.4 });
  }

  openFurnace(hit) {
    this.cancelBlocking();
    this.cancelEating();
    this.openUI = 'furnace';
    this.activeFurnace = this.world.getFurnace(hit.x, hit.y, hit.z);
    this.input.setUIMode(true);
    this.ui.showFurnace();
    this.sfx.play('open_ui', { volume: 0.4 });
  }

  openChest(hit) {
    this.cancelBlocking();
    this.cancelEating();
    this.openUI = 'chest';
    this.activeChest = { x: hit.x, y: hit.y, z: hit.z, slots: this.world.getContainer(hit.x, hit.y, hit.z) };
    this.input.setUIMode(true);
    this.ui.showChest();
    this.sfx.play('open_ui', { volume: 0.4 });
  }

  /* 滚动任务 6：右键村民 → 交易面板。面板上的三条交易都是真实扣料/给货。 */
  openVillager(villager) {
    if (!villager || villager.hp <= 0) return false;
    this.cancelBlocking();
    this.cancelEating();
    this.openUI = 'villager';
    this.activeVillager = villager;
    this.input.setUIMode(true);
    this.ui.showVillager();
    this.sfx.play('open_ui', { volume: 0.4 });
    return true;
  }

  /**
   * 执行第 i 条村民交易（0~2）。材料不足时什么都不扣，返回 reason='materials'。
   * 背包放不下的余量丢在玩家脚下，绝不吞物品。
   */
  tradeWithVillager(i) {
    if (this.openUI !== 'villager') return { ok: false, reason: 'closed' };
    const trades = tradesFor(this.activeVillager && this.activeVillager.profession);
    const trade = trades[i];
    if (!trade) return { ok: false, reason: 'bad_trade' };
    const res = performTrade(this.inventory, trade);
    if (!res.ok) {
      this.sfx.play('click', { volume: 0.35 });
      if (this.ui && this.ui.toast) {
        this.ui.toast('材料不够：' + (getItem(trade.give.item) ? getItem(trade.give.item).name : trade.give.item) +
          ' ×' + trade.give.count + '（你有 ' + res.have + '）', true);
      }
      this._lastTrade = Object.assign({ id: trade.id, at: Date.now() }, res);
      return res;
    }
    if (res.leftover > 0) {
      this.spawnDrop(trade.get.item, res.leftover,
        this.controller.pos.x, this.controller.pos.y + 0.6, this.controller.pos.z);
    }
    this.stats.trades = (this.stats.trades || 0) + 1;
    if (this.sfx) { this.sfx.play('craft', { volume: 0.55 }); this.sfx.play('pickup', { volume: 0.5 }); }
    if (this.ui && this.ui.toast) {
      const gn = getItem(trade.get.item) ? getItem(trade.get.item).name : trade.get.item;
      const gv = getItem(trade.give.item) ? getItem(trade.give.item).name : trade.give.item;
      this.ui.toast('交易完成：' + gv + ' ×' + trade.give.count + ' → ' + gn + ' ×' + trade.get.count);
    }
    this._lastTrade = Object.assign({ id: trade.id, at: Date.now() }, res);
    this.ui.showVillager();            // 重建面板，按钮上的“背包拥有数”立刻更新
    return res;
  }

  /* ================== E3：废弃矿工营地诊断 ================== */
  campInfo() {
    const builds = this.campBuilds || 0;
    if (!this.camp || !this.camp.built) return { built: false, builds };
    const c = this.camp;
    const cells = campLayout();
    let expected = 0, present = 0;
    for (const cell of cells) {
      if (cell.id === AIR) continue;
      expected++;
      if (this.world.getBlock(c.x + cell.x, c.y + cell.y, c.z + cell.z) === cell.id) present++;
    }
    const chests = (c.chests || []).map(ch => {
      const has = this.world.hasContainer(ch.x, ch.y, ch.z);
      const slots = has ? this.world.getContainer(ch.x, ch.y, ch.z) : [];
      return {
        x: ch.x, y: ch.y, z: ch.z, table: ch.table,
        block: this.world.getBlock(ch.x, ch.y, ch.z) === B.CHEST,
        hasContainer: has,
        items: slots.filter(Boolean).map(s => ({ item: s.item, count: s.count }))
      };
    });
    const room = c.room;
    let roomAir = 0, roomTorches = 0;
    for (let y = room.floor + 1; y <= room.ceil - 1; y++) {
      for (let z = room.z0; z <= room.z1; z++) {
        for (let x = room.x0; x <= room.x1; x++) {
          const id = this.world.getBlock(x, y, z);
          if (id === AIR) roomAir++;
          if (id === B.TORCH || id === B.GLOWSTONE || id === B.PUMPKIN_LAMP) roomTorches++;
        }
      }
    }
    return {
      built: true, builds,
      origin: { x: c.x, y: c.y, z: c.z },
      distSpawn: Math.hypot(c.x - this.spawn.x, c.z - this.spawn.z),
      radius: CAMP_RADIUS, maxExtent: CAMP_MAX_EXTENT,
      aboveSea: c.y > this.world.seaLevel,
      spread: c.spread, blocks: c.blocks, expected, present,
      room, stairs: c.stairs, chests, diamond: !!c.diamond,
      roomAir, roomTorches
    };
  }

  /* ================== R1/R2：出生点之外的探索地点 ================== */
  _landmarkOptions() {
    return {
      spawn: this.spawn,
      village: this.village ? { x: this.village.x, z: this.village.z } : null,
      camp: this.camp ? { x: this.camp.x, z: this.camp.z } : null,
      landmarks: Object.values(this.landmarks || {}).filter(l => l && l.built),
      isBlocked: (x, z, r) => this._landmarkBlocked(x, z, r),
      /* R4：用与地形生成同一份噪声判断「地表下方是不是洞穴」，让站点不会压在洞穴口上。 */
      caveAt: (x, y, z) => !!(this.world && this.world.terrain && this.world.terrain.isCave(x, y, z)),
      seaLevel: this.world ? this.world.seaLevel : SEA_LEVEL,
      worldH: WORLD_H
    };
  }

  _landmarkBlocked(x, z, r) {
    const inside = (k) => {
      const p = k.split(',').map(Number);
      return Math.abs(p[0] - x) <= r && Math.abs(p[2] - z) <= r;
    };
    for (const k of this.world.containers.keys()) if (inside(k)) return true;
    for (const k of this.world.furnaces.keys()) if (inside(k)) return true;
    return false;
  }

  _ensureLandmarkChunks(x, z, r) {
    const cx0 = Math.floor((x - r) / 16), cx1 = Math.floor((x + r) / 16);
    const cz0 = Math.floor((z - r) / 16), cz1 = Math.floor((z + r) / 16);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) this.world.ensureChunk(cx, cz);
    }
  }

  /** 区块已生成后检查足迹内有没有玩家/旧结构改动或容器；有就拒绝，避免重写历史。 */
  _landmarkAreaClean(x, z, r) {
    const x0 = x - r, x1 = x + r, z0 = z - r, z1 = z + r;
    const cx0 = Math.floor(x0 / CHUNK_SX), cx1 = Math.floor(x1 / CHUNK_SX);
    const cz0 = Math.floor(z0 / CHUNK_SZ), cz1 = Math.floor(z1 / CHUNK_SZ);
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.world.chunks.get(coordKey(cx, cz));
        if (!c || c.state < 1) return false;
        for (const i of c.edits.keys()) {
          const lx = i % CHUNK_SX, t = Math.floor(i / CHUNK_SX);
          const lz = t % CHUNK_SZ;
          const wx = cx * CHUNK_SX + lx, wz = cz * CHUNK_SZ + lz;
          if (wx >= x0 && wx <= x1 && wz >= z0 && wz <= z1) return false;
        }
      }
    }
    for (const k of this.world.containers.keys()) {
      const p = k.split(',').map(Number);
      if (p[0] >= x0 && p[0] <= x1 && p[2] >= z0 && p[2] <= z1) return false;
    }
    for (const k of this.world.furnaces.keys()) {
      const p = k.split(',').map(Number);
      if (p[0] >= x0 && p[0] <= x1 && p[2] >= z0 && p[2] <= z1) return false;
    }
    return true;
  }

  /** 真正建一处地点：预检在写任何方块之前完成；失败返回 null，不留半结构。 */
  buildLandmark(candidate) {
    if (!candidate || !this.world) return null;
    const t0 = performance.now();
    const layout = landmarkLayout(candidate.type, candidate.variant);
    const baseY = candidate.y;
    const r = layout.radius || 4;
    for (const cell of layout.cells) {
      if (baseY + cell.y < 1 || baseY + cell.y >= WORLD_H) { this.landmarkStats.failed++; return null; }
    }
    for (const ch of layout.chests) {
      if (baseY + ch.y < 1 || baseY + ch.y >= WORLD_H) { this.landmarkStats.failed++; return null; }
    }
    this._ensureLandmarkChunks(candidate.x, candidate.z, r + 3);
    if (!this._landmarkAreaClean(candidate.x, candidate.z, r + 1)) {
      this.landmarkStats.blocked++;
      this._landmarkSkip[candidate.id] = performance.now() + 4000;
      return null;
    }
    /* 只整平足迹，不推平整座山。 */
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = candidate.x + dx, z = candidate.z + dz;
        const h = this.world.surfaceHeight(x, z);
        for (let y = baseY + 1; y <= baseY + 8; y++) this.world.setBlock(x, y, z, AIR, 0);
        for (let y = h + 1; y < baseY; y++) this.world.setBlock(x, y, z, B.DIRT, 0);
        this.world.setBlock(x, baseY, z, B.GRASS, 0);
      }
    }
    let placed = 0;
    for (const cell of layout.cells) {
      if (this.world.setBlock(candidate.x + cell.x, baseY + cell.y, candidate.z + cell.z, cell.id, cell.meta)) placed++;
    }
    const loot = landmarkLoot(this.meta ? this.meta.seed : '', candidate);
    const chests = [];
    for (const ch of layout.chests) {
      const ax = candidate.x + ch.x, ay = baseY + ch.y, az = candidate.z + ch.z;
      if (this.world.getBlock(ax, ay, az) !== B.CHEST) { this.landmarkStats.failed++; return null; }
      const slots = this.world.getContainer(ax, ay, az);
      loot.forEach((it, i) => { slots[i] = { item: it.item, count: it.count }; });
      chests.push({ x: ax, y: ay, z: az, table: ch.table, items: loot.map(it => ({ ...it })) });
    }
    const ms = performance.now() - t0;
    const rec = {
      id: candidate.id, type: candidate.type, name: candidate.name, variant: candidate.variant,
      x: candidate.x, y: baseY, z: candidate.z, built: 1, discovered: 0, chests,
      region: candidate.region
    };
    this.landmarks[candidate.id] = rec;
    this.landmarkStats.builds++;
    this.landmarkStats.lastBuildMs = Math.round(ms * 100) / 100;
    this.landmarkStats.maxBuildMs = Math.max(this.landmarkStats.maxBuildMs, this.landmarkStats.lastBuildMs);
    this.landmarkStats.last = { id: rec.id, type: rec.type, x: rec.x, y: rec.y, z: rec.z, placed, ms: this.landmarkStats.lastBuildMs };
    return rec;
  }

  /** 主循环每 0.6 秒扫描附近 3×3 地区；一次最多建一处，不阻塞。 */
  updateLandmarks(dt) {
    if (!this.world || !this.controller || !this.meta) return;
    this._landmarkScanT = (this._landmarkScanT || 0) + dt;
    if (this._landmarkScanT < LANDMARK_SCAN_SECONDS) return;
    this._landmarkScanT = 0;
    const t0 = performance.now();
    const now = t0;
    const seed = this.meta.numericSeed;
    const opts = this._landmarkOptions();
    const sample = (x, z) => this.world.surfaceHeight(x, z);
    const regions = nearbyRegions(this.controller.pos.x, this.controller.pos.z);
    const list = [];
    for (const reg of regions) {
      const id = reg.rx + ',' + reg.rz;
      if (this.landmarks[id] && this.landmarks[id].built) continue;
      if (this._landmarkSkip[id] && now < this._landmarkSkip[id]) continue;
      const c = candidateFor(seed, reg.rx, reg.rz, sample, opts);
      if (!c) continue;
      c.distSpawn = Math.hypot(c.x - this.spawn.x, c.z - this.spawn.z);
      c.dist = Math.hypot(c.x - this.controller.pos.x, c.z - this.controller.pos.z);
      list.push(c);
    }
    list.sort((a, b) => a.dist - b.dist);
    this._nearLandmarks = list.map(c => ({
      id: c.id, type: c.type, name: c.name, x: c.x, y: c.y, z: c.z, dist: +c.dist.toFixed(1)
    }));
    for (const c of list) {
      if (c.dist <= LANDMARK_TRIGGER_RADIUS) {
        this.buildLandmark(c);
        break;                                  // 一次扫描最多建一处
      }
    }
    /* 已建地点走近才标记发现；发现状态只写一次。 */
    for (const lm of Object.values(this.landmarks)) {
      if (!lm || !lm.built || lm.discovered) continue;
      const d = Math.hypot(lm.x - this.controller.pos.x, lm.z - this.controller.pos.z);
      if (d <= LANDMARK_DISCOVER_RADIUS) this.onLandmarkDiscovered(lm);
    }
    const scanMs = performance.now() - t0;
    this.landmarkStats.scans++;
    this.landmarkStats.lastScanMs = Math.round(scanMs * 100) / 100;
    this.landmarkStats.maxScanMs = Math.max(this.landmarkStats.maxScanMs, this.landmarkStats.lastScanMs);
    this.updateGuardian();
  }

  /* ---------------- 阶段 5：地牢守卫（地标 → 状态 → 奖励） ---------------- */

  /** 同一存档只认一个守卫站点：按 id 稳定排序选第一处已建地点，读档后也不会漂。 */
  guardianSite() {
    const lms = Object.values(this.landmarks || {}).filter(l => l && l.built);
    if (!lms.length) return null;
    lms.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return lms[0];
  }

  /** 每 0.6 秒随地标扫描推进一次：补齐封印石座 → 数封印 → 靠近生成 / 恢复守卫，并刷新血条。 */
  updateGuardian() {
    if (!this.world || !this.mobs || !this.controller) return;
    const site = this.guardianSite();
    if (!site) {
      if (this.ui && this.ui.setGuardianBar) this.ui.setGuardianBar(null);
      return;
    }
    const key = guardianSiteKey(site);
    /* 站点键要在「地标真的建出来」之后才定得下来：读档时 landmarks 可能还是空表，
       那一刻 normalizeGuardianState 会给出 'g:unknown'。地标出现后把键换成真的地点 ID，
       血量 / 击败 / 领奖这些持久字段原样搬过去（不能因为换键把进度丢掉）。 */
    if (!this.guardian || this.guardian.siteKey !== key) {
      const prev = this.guardian || {};
      this.guardian = normalizeGuardianState(
        Object.assign({}, prev, { siteKey: key }), key);
      /* 击败过的档换键后仍是击败（normalize 会保住 defeated / rewardClaimed） */
    }
    if (!this.mobs.guardianState || this.mobs.guardianState.siteKey !== key) {
      this.mobs.setGuardian(site, this.guardian);
    }
    /* 石座是「可放置的深板岩」：位置一次落盘（pedestals），方块状态每次现读，
       所以「放上去 → 退出 → 重进 → 还在」与「挖掉一块 → 封印重新锁死」都是同一套判据。 */
    this.ensureGuardianPedestals(site);
    const wards = this.countGuardianWards();
    this.mobs._guardianWards = wards;
    this.mobs._guardianArmed = guardianArmed(wards);
    if (this.ui && this.ui.setGuardianBar) this.ui.setGuardianBar(this.mobs.guardianInfo());
    if (this.guardian.defeated) return;
    const d = Math.hypot(this.controller.pos.x - site.x, this.controller.pos.z - site.z);
    /* 脱战必须在**实体不在场时也生效**：实体被卸载/清场之后 guardianAI 不再跑，
       状态会冻在 telegraph/strike 上（实测：玩家死后重进读到 phase=strike，一进场就挨招）。
       这里按距离与玩家存活独立复位，血量与领奖进度保留。 */
    const live = this.mobs.guardianState;
    if (live && (this.controller.health <= 0 || d > GUARDIAN_LEASH)) {
      if (live.phase !== 'dormant' || live.hp !== GUARDIAN_HP || live.attack) {
        live.phase = 'dormant'; live.attack = null; live.t = 0; live.hp = GUARDIAN_HP;
        const m = this.mobs.guardianMob();
        if (m) m.hp = GUARDIAN_HP;
      }
    }
    if (d > 42 && !this.mobs.guardianMob()) return;
    /* 阶段 6：守卫从「不在场」变成「出现」时给一次战斗预警（随包 CC0 短音效，
       取不到就用同名合成配方）。每 0.6 秒的扫描里只有这一次会满足 had=false，
       不会在站桩时反复刷同一声。 */
    const gHad = !!this.mobs.guardianMob();
    /* 本轮 A3：站位按「可站立地面 + 净空」选，不再拿建筑中心的最高实心格当战斗地面。
       选出来的格一次算好就记住（写进运行时字段，不落盘）：守卫随位置复位时回到同一格，
       而存档语义（站点键 / 封印 / 击败 / 领奖）一字不动。 */
    if (!this._guardianStand || this._guardianStand.key !== key) {
      const stand = chooseGuardianStand(this.world, site);
      this._guardianStand = Object.assign({ key }, stand);
      this.mobs.setGuardianStand(stand);
    }
    const stand = this._guardianStand;
    this.mobs.spawnGuardianAt(site, stand.x + 0.5, stand.y, stand.z + 0.5, this.guardian);
    if (!gHad && this.sfx) this.sfx.play('guardian_awaken', { volume: 0.45 });
  }

  /** 首次靠近时在遗迹四角铺石座（黑曜石底座 + 空槽），坐标写进 guardian.pedestals。 */
  ensureGuardianPedestals(site) {
    if (!this.world || !site) return null;
    if (this.guardian.pedestals && this.guardian.pedestals.length === GUARDIAN_WARDS) return this.guardian.pedestals;
    const spots = guardianWardSpots(site.x, site.z);
    const ped = [];
    for (const s of spots) {
      const baseY = this.world.topSolidY(s.x, s.z);
      /* 底座换成黑曜石（既有方块，能一眼看出「这里要放东西」），上面那格清空留给深板岩 */
      this.world.setBlock(s.x, baseY, s.z, B.OBSIDIAN);
      this.world.setBlock(s.x, baseY + 1, s.z, AIR);
      this.world.setBlock(s.x, baseY + 2, s.z, AIR);
      ped.push({ x: s.x, y: baseY + 1, z: s.z });
    }
    this.guardian.pedestals = ped;
    return ped;
  }

  /** 数一数几个石座上真的放着深板岩（放磨制深板岩也算，它同样是 y<0 的产物）。
   *  只在石座所在区块**真的加载**时才把这一格算成「空」——`getBlock` 对未加载区块走地形纯函数近似，
   *  于是远在出生点读遗迹石座会恒得 0（第一版就是这样：读档后玩家还在出生点，封印被判成 wards=0、
   *  armed=false，守卫免疫伤害、怎么砍都不掉血）。没加载就沿用上一次的读数，并报 `unknown` 计数。 */
  countGuardianWards() {
    const ped = this.guardian && this.guardian.pedestals;
    if (!ped || !this.world) return 0;
    let n = 0, unknown = 0;
    for (const p of ped) {
      const ck = coordKey(p.x >> 4, p.z >> 4);
      const chunk = this.world.chunks.get(ck);
      if (!chunk || chunk.state < 1) { unknown++; continue; }
      const id = this.world.getBlock(p.x, p.y, p.z);
      if (id === B.DEEPSLATE || id === B.POLISHED_DEEPSLATE) n++;
    }
    this._guardianWardsUnknown = unknown;
    if (unknown && n === 0 && this._guardianWardsLast !== undefined) return this._guardianWardsLast;
    this._guardianWardsLast = n;
    return n;
  }

  /** 封印状态读数（供 HUD、提示与验收共用） */
  guardianWardInfo() {
    const ped = (this.guardian && this.guardian.pedestals) || [];
    const wards = this.countGuardianWards();
    return {
      total: GUARDIAN_WARDS, wards, armed: guardianArmed(wards),
      pedestals: ped.map(p => ({ x: p.x, y: p.y, z: p.z, block: this.world ? this.world.getBlock(p.x, p.y, p.z) : 0 }))
    };
  }

  /** 写档前把运行时的血量 / 击败 / 领奖状态收回地点状态。 */
  syncGuardianState() {
    const live = this.mobs && this.mobs.guardianState;
    if (!this.guardian || !live) return;
    this.guardian.hp = live.hp;
    this.guardian.defeated = live.defeated;
    this.guardian.rewardClaimed = live.rewardClaimed;
    this.guardian.phase = live.phase;
    this.guardian.attempts = live.attempts;
  }

  /** 击败结算：奖励一次、写进该地标的箱子，玩家从正常开箱动作领奖。 */
  onGuardianDefeated(site) {
    if (!this.guardian || this.guardian.rewardClaimed) return null;
    this.guardian.defeated = 1;
    this.guardian.phase = 'dead';
    const reward = claimGuardianReward(this.guardian);
    if (!reward) return null;
    this.guardian.rewardClaimed = 1;
    if (this.mobs && this.mobs.guardianState) this.mobs.guardianState.rewardClaimed = 1;
    const lm = site && this.landmarks ? this.landmarks[site.id] : null;
    if (lm && lm.chests && lm.chests.length && this.world) {
      const ch = lm.chests[0];
      const slots = this.world.getContainer(ch.x, ch.y, ch.z);
      for (const r of reward) {
        const i = slots.findIndex(s => !s);
        if (i < 0) break;
        slots[i] = { item: r.item, count: r.count };
      }
      this.ui.toast('守卫倒下了 · 战利品已放进遗迹箱子', false, 3600);
    } else {
      this.ui.toast('守卫倒下了', false, 3000);
    }
    /* 本轮 D：领奖只留一条声音身份。
       旧写法同时播 levelup（成就/升级专用）与 guardian_reward —— 两个上行音叠在一起，
       既听不出「这是守卫奖励」，也把 levelup 这条提示音的身份稀释掉了。
       现在只播 guardian_reward（随包 CC0，文件没就绪时自动走同名合成兜底）。 */
    this.sfx.play('guardian_reward', { volume: 0.7 });
    this.guardianStats = {
      defeats: (this.guardianStats && this.guardianStats.defeats ? this.guardianStats.defeats : 0) + 1,
      reward: reward.slice(), at: Date.now(), siteKey: this.guardian.siteKey
    };
    return reward;
  }

  /**
   * R3：玩家第一次真实走近一处已建地点。发现状态只写一次，
   * 因此「发现：某某」像素 toast 与「探索者」成就都只会在同一存档里各触发一次；
   * 读档后 lm.discovered 已经是 1，这条路径不会再被走到（不会重复弹）。
   */
  onLandmarkDiscovered(lm) {
    if (!lm || lm.discovered) return null;
    lm.discovered = 1;
    this.landmarkStats.discoveries++;
    const text = '发现：' + (lm.name || '荒野地点');
    this.landmarkStats.lastDiscovery = { id: lm.id, type: lm.type, name: lm.name, x: lm.x, z: lm.z, at: Date.now() };
    this.landmarkStats.discoveryToasts = (this.landmarkStats.discoveryToasts || 0) + 1;
    this.landmarkStats.lastDiscoveryToast = { id: lm.id, text, name: lm.name };
    if (this.ui && this.ui.toast) this.ui.toast(text, false, 3200);   // 与成就 toast 同时长，走路时也来得及看清
    /* 阶段 5：守卫站点第一次发现时给一条可读挑战提示，不新建任务系统 */
    const gs = this.guardianSite();
    if (gs && gs.id === lm.id && !(this.guardian && this.guardian.defeated)) {
      /* 本轮 C：两条说明原来是同时弹的，加上「发现地点」与「守卫沉睡中」一共四块横幅，
         把守卫和场地整个挡住了。现在合成一条：先说怎么打，再说怎么解封；
         优先级给 1（高于普通提示、低于危险），配合 ui.toast 的「最多 2 条」上限。 */
      this.ui.toast('石碑刻着挑战：备好铁装、盾或弓再靠近；四角石座要 4 块深板岩（挖到 y<0）', false, 5200, { priority: 1 });
    }
    /* B：发现本身就该有声音。以前只有「第一次解锁探索者成就」才会响一声，
       同一存档里再发现第二、第三个地点就完全没反馈了。成就的 levelup 与这里同名，
       40ms 限流会自动合并成一声，不会双响。 */
    this.sfx.play('levelup', { volume: 0.42, rate: 1.0 });
    this.markAudioCue('discovery', lm.type || lm.id);
    this.unlockAchievement('explorer');          // 复用现有成就 toast / 存档链路
    return this.landmarkStats.lastDiscovery;
  }

  /** 测试/诊断：当前附近候选（不建造，纯函数）。 */
  landmarkCandidates() {
    if (!this.world || !this.meta) return [];
    const opts = this._landmarkOptions();
    const sample = (x, z) => this.world.surfaceHeight(x, z);
    const out = [];
    for (const reg of nearbyRegions(this.controller.pos.x, this.controller.pos.z)) {
      const id = reg.rx + ',' + reg.rz;
      if (this.landmarks[id] && this.landmarks[id].built) continue;
      const c = candidateFor(this.meta.numericSeed, reg.rx, reg.rz, sample, opts);
      if (!c) continue;
      c.dist = Math.hypot(c.x - this.controller.pos.x, c.z - this.controller.pos.z);
      out.push(c);
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  /** R3：已发现地点的轻量清单（给暂停界面用，不重算结构覆盖率）。 */
  discoveredLandmarks() {
    return Object.values(this.landmarks || {})
      .filter(lm => lm && lm.built && lm.discovered)
      .map(lm => ({ id: lm.id, type: lm.type, name: lm.name, x: lm.x, y: lm.y, z: lm.z }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  landmarksInfo() {
    const list = Object.values(this.landmarks || {}).map(lm => {
      const layout = landmarkLayout(lm.type, lm.variant);
      let expected = 0, present = 0;
      for (const c of layout.cells) {
        if (c.id === AIR) continue;
        expected++;
        if (this.world.getBlock(lm.x + c.x, lm.y + c.y, lm.z + c.z) === c.id) present++;
      }
      return {
        id: lm.id, type: lm.type, name: lm.name, variant: lm.variant,
        x: lm.x, y: lm.y, z: lm.z, built: !!lm.built, discovered: !!lm.discovered,
        radius: layout.radius || 4,
        expected, present,
        chests: (lm.chests || []).map(ch => {
          const has = this.world.hasContainer(ch.x, ch.y, ch.z);
          const slots = has ? this.world.getContainer(ch.x, ch.y, ch.z) : [];
          return {
            x: ch.x, y: ch.y, z: ch.z, table: ch.table,
            block: this.world.getBlock(ch.x, ch.y, ch.z) === B.CHEST,
            hasContainer: has,
            items: slots.filter(Boolean).map(s => ({ item: s.item, count: s.count }))
          };
        })
      };
    });
    return {
      count: list.length,
      built: list.filter(l => l.built).length,
      discovered: list.filter(l => l.discovered).length,
      list, near: this._nearLandmarks,
      stats: Object.assign({}, this.landmarkStats)
    };
  }

  /* 滚动任务 6：村庄诊断读数（站点、布局方块落地数、村民坐标、交易记录） */
  villageInfo() {
    if (!this.village || !this.village.built) {
      return { built: false, trades: VILLAGER_TRADES.map((t, i) => Object.assign({ index: i }, t)),
        panelOpen: this.openUI === 'villager', lastTrade: this._lastTrade };
    }
    const cells = villageLayout();
    let present = 0;
    for (const c of cells) {
      if (this.world.getBlock(this.village.x + c.x, this.village.y + c.y, this.village.z + c.z) === c.id) present++;
    }
    const villagers = this.mobs ? this.mobs.list.filter(m => m.type === 'villager') : [];
    const describe = (v) => v ? {
      x: +v.pos.x.toFixed(2), y: +v.pos.y.toFixed(2), z: +v.pos.z.toFixed(2),
      profession: v.profession || v.def.profession || 'farmer', hp: v.hp, height: v.height,
      home: v.home ? { x: v.home.x, y: v.home.y, z: v.home.z } : null
    } : null;
    const v = this.openUI === 'villager' && this.activeVillager ? this.activeVillager : villagers[0];
    const vtrades = tradesFor(v && (v.profession || v.def.profession));
    return {
      built: true,
      origin: { x: this.village.x, y: this.village.y, z: this.village.z },
      expected: cells.length,
      present,
      blocks: this.village.blocks,
      placed: this.village.placed,
      villagers: villagers.length,
      villager: describe(v),
      roster: villagers.map(describe),
      activeProfession: this.openUI === 'villager' && this.activeVillager
        ? (this.activeVillager.profession || 'farmer') : null,
      trades: vtrades.map((t, i) => Object.assign({ index: i }, t)),
      panelOpen: this.openUI === 'villager',
      lastTrade: this._lastTrade
    };
  }

  /* ================== 滚动任务 8：地图与指南针 ================== */
  /** 记录一个已加载区块的顶层色块；返回 256 字符网格或 null（未加载不伪造） */
  recordMapChunk(cx, cz) {
    if (!this.world) return null;
    const key = coordKey(cx, cz);
    const chunk = this.world.chunks.get(key);
    if (!chunk || chunk.state < 1) return null;
    const grid = buildMapChunk((lx, lz) => {
      const x = cx * 16 + lx, z = cz * 16 + lz;
      const y = this.world.topSolidY(x, z);
      /* topSolidY 跳过水；水面以下一格也会被画成沙/石。这里优先把水面画成蓝色。 */
      const above = this.world.getBlock(x, y + 1, z);
      return { id: above === B.WATER ? B.WATER : this.world.getBlock(x, y, z), meta: this.world.getMeta(x, y, z) };
    });
    this.mapSeen[key] = grid;
    return grid;
  }

  /** 地图面板需要的快照：5×5 区块（以玩家所在区块为中心）+ 玩家/出生点位置 */
  mapModel() {
    if (!this.world || !this.controller) {
      return { seen: {}, cx: 0, cz: 0, px: 0, pz: 0, spawn: this.spawn, explored: 0, landmarks: [] };
    }
    const p = this.controller.pos;
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) this.recordMapChunk(cx + dx, cz + dz);
    this._mapChunkKey = coordKey(cx, cz);
    const out = {
      seen: this.mapSeen, cx, cz,
      px: p.x, pz: p.z, yaw: this.controller.yaw, spawn: this.spawn,
      explored: Object.keys(this.mapSeen).length
    };
    /* R3：只有「玩家真的发现过」且「所在区块已探索」的地点才会变成标记。 */
    out.landmarks = mapLandmarkMarkers(out, Object.values(this.landmarks || {}));
    return out;
  }

  /** 指南针目标：优先床重生点，否则世界出生点 */
  compassTarget() {
    if (this.bedSpawn) return { x: this.bedSpawn.x, z: this.bedSpawn.z, kind: '床' };
    return { x: this.spawn.x, z: this.spawn.z, kind: '出生点' };
  }

  compassState() {
    const inv = this.inventory, c = this.controller;
    const held = inv ? inv.held() : null;
    const it = held ? getItem(held.item) : null;
    if (!it || !it.compassItem || !c) return { held: false };
    const t = this.compassTarget();
    const dx = t.x - c.pos.x, dz = t.z - c.pos.z;
    return {
      held: true,
      deg: compassDegrees(dx, dz, c.yaw),
      dir: compassDirection(dx, dz),
      dist: Math.hypot(dx, dz),
      target: t.kind
    };
  }

  /** 右键指南针的读数（HUD 常驻；这里给一次明确文字反馈） */
  readCompass() {
    const s = this.compassState();
    if (!s.held) return false;
    if (this.ui && this.ui.toast) {
      this.ui.toast('指南针：' + s.target + '在' + s.dir + '方 ' + Math.round(s.dist) + ' 格');
    }
    if (this.sfx) this.sfx.play('click', { volume: 0.3 });
    return true;
  }

  openMap() {
    if (!this.world) return false;
    this.cancelBlocking();
    this.cancelEating();
    this.openUI = 'map';
    this.input.setUIMode(true);
    this.ui.showMap();
    this.sfx.play('open_ui', { volume: 0.4 });
    return true;
  }

  closeUI() {
    if (!this.openUI) return;
    // 退回合成格里的材料
    for (const g of [this.playerCraft, this.tableCraft]) {
      const left = g.drain(this.inventory);
      if (left) this.interaction.drops.spawn(left.item, left.count, this.controller.pos.x, this.controller.pos.y, this.controller.pos.z, false);
    }
    // 光标上还拿着物品：放回背包，装不下就丢在脚下
    if (this.inventory.cursor) {
      const rest = this.inventory.addStack(this.inventory.cursor);
      this.inventory.cursor = null;
      if (rest) this.interaction.drops.spawn(rest.item, rest.count, this.controller.pos.x, this.controller.pos.y, this.controller.pos.z, false);
    }
    this.openUI = null;
    this.activeCraft = this.playerCraft;
    this.activeChest = null;
    this.activeVillager = null;
    this.input.setUIMode(false);
    /* BUG.2：setUIMode(true) 会 releaseLock，关闭面板后要主动把指针锁要回来，
       否则鼠标会一直露在画面上、还要玩家再点一下画面才能转视角。
       requestLock 内部对未获授权的情况有 catch 兜底，不会抛异常。 */
    if (this.state === 'playing') this.input.requestLock();
    this.ui.hidePanels();
    this.sfx.play('close_ui', { volume: 0.35 });
  }

  /* ================== 生命周期 ================== */
  pause() {
    if (this.state !== 'playing') return;
    this.cancelBlocking();
    this.cancelEating();
    this.state = 'paused';
    this.input.setUIMode(true);
    this.sfx.stopMusic(1.2);                 // T4：暂停时主曲与环境床都释放
    this.sfx.setAmbientEnabled(false);       // 环境床也一起释放（恢复时再打开，见 resume）
    this.ui.showPause();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.input.setUIMode(false);
    this.ui.hideOverlays();
    this._lastTime = performance.now();
    /* 暂停时主曲与环境床都被释放（既有规则）；恢复时音乐按开关决定，
       但环境床一定要回来 —— 否则「音乐关掉的人」暂停一次以后世界就永久静音了。 */
    if (this.settings.music) this.sfx.startMusic();
    this.sfx.setAmbientEnabled(true);
    this.sfx.updateAmbient(this.audioSceneState());
  }

  startLoop() {
    this.stopLoop = false;
    const step = (t) => {
      if (this.stopLoop) return;
      this._raf = requestAnimationFrame(step);
      this.loop(t);
    };
    this._raf = requestAnimationFrame(step);
  }

  /* T5：苦力怕自爆的结算。
     方块破坏走 world.setBlock 的正常链路（标脏 → 由 T2 的分帧预算重算光照与网格），
     所以炸完不需要手动刷新，也不会绕过存档 diff。伤害按到爆心的距离衰减，创造模式不受伤。 */
  onCreeperExplode(m) {
    if (!this.world || this.state !== 'playing') return null;
    const bx = Math.floor(m.pos.x), by = Math.floor(m.pos.y + m.height / 2), bz = Math.floor(m.pos.z);
    const cells = explosionCells({
      cx: bx, cy: by, cz: bz, power: CREEPER_POWER,
      rand: Math.random, canBreak: (x, y, z) => breakableAt(this.world, x, y, z)
    });
    let removed = 0;
    for (const c of cells) if (this.world.setBlock(c.x, c.y, c.z, AIR, 0)) removed++;
    const dist = Math.hypot(
      this.controller.pos.x - m.pos.x,
      (this.controller.pos.y + 0.9) - (m.pos.y + m.height / 2),
      this.controller.pos.z - m.pos.z);
    const dmg = explosionDamage({ dist, range: CREEPER_DAMAGE_RANGE, maxDamage: CREEPER_MAX_DAMAGE });
    if (dmg > 0 && !this.controller.creative) this.controller.hurt(Math.max(1, Math.round(dmg)), '被苦力怕炸伤', 'explosion');
    this.explosions = (this.explosions || 0) + 1;
    this._lastBlast = {
      at: this._loopFrames, x: bx, y: by, z: bz,
      cells: cells.length, removed, dmg: Math.round(dmg * 10) / 10, dist: Math.round(dist * 100) / 100
    };
    this.sfx.play('explode', { volume: 0.9 });
    if (this.particles) this.particles.spawn(m.pos.x, m.pos.y + 0.7, m.pos.z, [0.75, 0.72, 0.55], 26, 3.0, 1.2);
    return this._lastBlast;
  }

  /* T4 音乐/环境声的场景判定：地下 → 洞穴曲，夜里 → 夜晚曲，否则白天曲；
     环境声按水下、地下、降雨、昼夜选择；雪天是轻风，屋顶只改变遮蔽混音。 */
  audioSceneState() {
    const c = this.controller, w = this.world;
    const x = c ? Math.floor(c.pos.x) : 0, z = c ? Math.floor(c.pos.z) : 0;
    const surface = w ? w.surfaceHeight(x, z) : 0;
    const underground = !!w && !!c && c.pos.y < surface - 3;
    const night = isNight(this.time);
    return {
      scene: underground ? 'cave' : (night ? 'night' : 'day'),
      underground, night,
      weather: this.weather ? this.weather.type : 'clear',
      intensity: this.weather ? this.weather.intensity : 0,
      sheltered: this.shelteredAbove(),
      dayT: this.time,
      underwater: !!(c && c.eyeInWater),
      y: c ? c.pos.y : 0,
      surface
    };
  }

  updateAudioScene() {
    if (!this.sfx) return;
    /* 本轮 D：每个音频帧把「听者」（相机位置 + 朝向）交给 Sfx。
       playWorld 用它算方向与距离；不注册的话生物/守卫的声音仍然只是「有个声音在响」。 */
    if (this.sfx.setListener) {
      this.sfx.setListener(() => ({
        x: this.controller ? this.controller.pos.x : 0,
        y: this.controller ? this.controller.pos.y : 0,
        z: this.controller ? this.controller.pos.z : 0,
        yaw: this.controller ? this.controller.yaw : 0
      }));
    }
    const s = this.audioSceneState();
    /* 只在实际进入洞穴时记录一次事件。空间变化由真实环境录音承接，
       不再借用低速挖石声；首次读档不误记为新进入。 */
    const prev = this._audioScenePrev;
    if (prev !== null && prev !== s.scene && s.scene === 'cave') {
      this.markAudioCue('caveEnter', Math.round(s.y));
    }
    this._audioScenePrev = s.scene;
    /* 本轮 D：音乐开关只影响主曲；环境床与场景切换照常推进 */
    if (this.settings.music) this.sfx.setMusicScene(s.scene);
    this.sfx.updateAmbient(s);
  }

  /** B：事件音效计数（只读诊断用，不入存档） */
  markAudioCue(kind, detail) {
    if (!this.audioCues) this.audioCues = { discovery: 0, caveEnter: 0, quest: 0, last: null };
    const c = this.audioCues;
    c[kind] = (c[kind] || 0) + 1;
    c.last = { kind, detail: detail === undefined ? null : detail, at: Date.now() };
    return c[kind];
  }

  /* ================== T6 门 ================== */
  toggleDoor(hit) {
    if (!this.world || !hit) return null;
    const res = this.world.toggleDoor(hit.x, hit.y, hit.z);
    if (!res) return null;
    this.world.refreshImmediate(res.x, res.y, res.z, this.view);
    this.world.refreshImmediate(res.x, res.y + 1, res.z, this.view);
    this.sfx.play('door', { volume: 0.6, rate: res.open ? 1.08 : 0.92 });
    return res;
  }

  /* ================== 进食过程（本轮 E3） ================== */
  isEating() { return !!this.eatingItem; }

  /** 开始一次进食：只在真正能吃的条件下建立过程，返回是否开始。 */
  startEating(held) {
    const it = held ? getItem(held.item) : null;
    if (!it || !it.food) return false;
    if (this.eatingItem) return false;                       // 已经在吃，别叠第二次
    const c = this.controller;
    if (c.hunger >= 20 && !it.poison) { this.ui.toast('你已经吃饱了'); return false; }
    this.eatVariants ||= Object.create(null);
    this.eatingItem = createEatSession({ id: held.item, food: it.food }, this.eatVariants);
    if (this.interaction) this.interaction.placeCd = 0.25;
    return true;
  }

  /** 立刻中断：之后的咬/嚼/吞排程全部取消，不扣物品也不加饱食。 */
  cancelEating() {
    if (!this.eatingItem) return false;
    this.eatingItem = null;
    return true;
  }

  /** 吞下：加饱食/回血/中毒与扣物品必须发生在同一刻。 */
  finishEating() {
    const e = this.eatingItem;
    if (!e) return false;
    this.eatingItem = null;
    const c = this.controller;
    if (!c.eat(e.item)) return false;
    if (!c.creative) this.inventory.consumeHeld(1);
    this.ui.updateHUD(this);
    return true;
  }

  /** 每帧推进：按住右键继续，松手/切物品/开界面/离开游玩状态立刻停。 */
  tickEating(dt) {
    const session = this.eatingItem;
    if (!session) return;
    if (this.state !== 'playing' || this.openUI) { this.cancelEating(); return; }
    const st = this.input ? this.input.sync() : {};
    if (!st.mouseRight) { this.cancelEating(); return; }
    const held = this.inventory.held();
    if (!held || held.item !== session.item) { this.cancelEating(); return; }

    const { cues, swallow } = tickEatSession(session, dt);
    for (const cue of cues) {
      this.sfx.play(cue.name, { volume: cue.volume, rate: 0.97 + Math.random() * 0.06 });
      if (cue.kind === 'bite' && this.heldView) this.swing(0.3, 'use');
    }
    if (swallow) this.finishEating();
  }

  /* ================== T5 最小 TNT ================== */
  /** 点燃 (x,y,z) 的 TNT；已点燃/不是 TNT 返回 false。默认 3 秒引信，不入存档。
   *  opts.fuse / opts.depth 供有限连锁使用（连锁引信 0.7 秒，depth 最多 1）。 */
  igniteTnt(x, y, z, opts = {}) {
    if (!this.world || this.state !== 'playing') return false;
    if (this.world.getBlock(x, y, z) !== B.TNT) return false;
    const key = x + ',' + y + ',' + z;
    if (this.tnt.has(key)) return false;
    const fuse = opts.fuse === undefined ? TNT_FUSE_SECONDS : Math.max(0.1, opts.fuse);
    const mesh = this._makeTntFlash(x, y, z);
    this.tnt.set(key, { x, y, z, fuse, flashOn: true, mesh, depth: opts.depth || 0 });
    this.sfx.playWorld ? this.sfx.playWorld('hiss', { x: x + 0.5, y: y + 0.5, z: z + 0.5 }, { volume: 0.55, rate: opts.depth ? 1.35 : 1.2 })
      : this.sfx.play('hiss', { volume: 0.55, rate: opts.depth ? 1.35 : 1.2 });
    if (this.particles) this.particles.spawn(x + 0.5, y + 1.05, z + 0.5, [0.95, 0.85, 0.45], 6, 0.25, 1.2);
    return true;
  }

  _makeTntFlash(x, y, z) {
    if (!this.scene || typeof THREE === 'undefined') return null;
    try {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.04, 1.04, 1.04),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false })
      );
      mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
      mesh.renderOrder = 4;
      this.scene.add(mesh);
      return mesh;
    } catch (e) { return null; }
  }

  _removeTntFlash(entry) {
    if (!entry || !entry.mesh) return;
    try { this.scene.remove(entry.mesh); } catch (e) { /* ignore */ }
    try { entry.mesh.geometry.dispose(); entry.mesh.material.dispose(); } catch (e) { /* ignore */ }
    entry.mesh = null;
  }

  /** 主循环每帧推进引信；闪白只做在覆盖 mesh 上，不污染方块/存档 */
  tickTnt(dt) {
    if (!this.tnt || !this.tnt.size) return;
    for (const [key, e] of Array.from(this.tnt)) {
      if (!this.world || this.world.getBlock(e.x, e.y, e.z) !== B.TNT) {
        this.tnt.delete(key); this._removeTntFlash(e); continue;   // 被挖走/替换：取消，不炸
      }
      const r = stepFuse(e.fuse, dt);
      e.fuse = r.fuse;
      if (r.toggle) {
        e.flashOn = !e.flashOn;
        if (e.mesh) e.mesh.visible = e.flashOn;
        if (this.particles && e.flashOn) this.particles.spawn(e.x + 0.5, e.y + 1.0, e.z + 0.5, [0.85, 0.8, 0.75], 1, 0.2, 0.8);
      }
      if (r.exploded) {
        this.tnt.delete(key);
        this._removeTntFlash(e);
        this.explodeTnt(e);
      }
    }
  }

  /** TNT 结算：破坏走 world.setBlock；伤害按距离衰减。
   *  有限连锁：只向下一层点燃 5 格内最多 6 个 TNT；被水淹没时湿火药不破方块、不连锁、伤害减半。 */
  explodeTnt(e) {
    if (!this.world || this.state !== 'playing') return null;
    if (this.world.getBlock(e.x, e.y, e.z) !== B.TNT) return null;
    const depth = e.depth || 0;
    const submerged = tntSubmerged(this.world, e.x, e.y, e.z);
    const spec = tntBlastSpec(submerged);

    /* 先挑出要连锁的 TNT：只挑未点燃的，按距离取前 N 个；这些格子本次不破坏，留给它们自己的引信 */
    const chain = [];
    if (spec.chains && depth < TNT_CHAIN_DEPTH) {
      for (let dx = -TNT_CHAIN_RADIUS; dx <= TNT_CHAIN_RADIUS; dx++) {
        for (let dy = -TNT_CHAIN_RADIUS; dy <= TNT_CHAIN_RADIUS; dy++) {
          for (let dz = -TNT_CHAIN_RADIUS; dz <= TNT_CHAIN_RADIUS; dz++) {
            const d = Math.hypot(dx, dy, dz);
            if (d > TNT_CHAIN_RADIUS || d < 1e-6) continue;
            const x = e.x + dx, y = e.y + dy, z = e.z + dz;
            if (this.world.getBlock(x, y, z) !== B.TNT) continue;
            const key = x + ',' + y + ',' + z;
            if (this.tnt.has(key)) continue;
            chain.push({ x, y, z, d });
          }
        }
      }
      chain.sort((a, b) => a.d - b.d);
      chain.length = Math.min(chain.length, TNT_CHAIN_MAX);
    }
    const chainKeys = new Set(chain.map(c => c.x + ',' + c.y + ',' + c.z));

    const cells = spec.breaksBlocks ? explosionCells({
      cx: e.x, cy: e.y, cz: e.z, power: spec.power,
      rand: Math.random,
      canBreak: (x, y, z) => {
        if (!breakableAt(this.world, x, y, z)) return false;
        // 本次要连锁的 TNT 不删，交给 igniteTnt 的短引信
        if (chainKeys.has(x + ',' + y + ',' + z)) return false;
        return true;
      }
    }) : [];
    let removed = 0;
    for (const c of cells) if (this.world.setBlock(c.x, c.y, c.z, AIR, 0)) removed++;
    if (!spec.breaksBlocks) {
      // 湿火药：只消耗 TNT 自身，不碰周围地形
      if (this.world.setBlock(e.x, e.y, e.z, AIR, 0)) removed = 1;
    }

    const cx = e.x + 0.5, cy = e.y + 0.5, cz = e.z + 0.5;
    const dist = Math.hypot(
      this.controller.pos.x - cx,
      (this.controller.pos.y + 0.9) - cy,
      this.controller.pos.z - cz);
    const dmg = explosionDamage({ dist, range: spec.range, maxDamage: spec.maxDamage });
    if (dmg > 0 && !this.controller.creative) {
      this.controller.hurt(Math.max(1, Math.round(dmg)), '被 TNT 炸伤', 'explosion', { x: cx, z: cz, kind: 'explosion' });
    }
    this.tntBlasts = (this.tntBlasts || 0) + 1;
    this._lastTntBlast = {
      at: this._loopFrames, x: e.x, y: e.y, z: e.z,
      cells: cells.length, removed, dmg: Math.round(dmg * 10) / 10, dist: Math.round(dist * 100) / 100,
      submerged, chained: chain.length, depth, power: spec.power
    };
    if (submerged) {
      this.sfx.play('explode', { volume: 0.4, rate: 0.72 });
      this.sfx.play('splash', { volume: 0.8, rate: 0.9 });
      if (this.particles) this.particles.spawn(cx, cy + 0.3, cz, [0.85, 0.93, 1], 24, 2.2, 1.8);
    } else {
      this.sfx.play('explode', { volume: 0.9 });
      if (this.particles) this.particles.spawn(cx, cy + 0.2, cz, [0.9, 0.75, 0.5], 30, 3.2, 1.4);
      for (const c of chain) {
        this.igniteTnt(c.x, c.y, c.z, { fuse: TNT_CHAIN_FUSE, depth: depth + 1 });
      }
    }
    return this._lastTntBlast;
  }

  clearTnt() {
    if (this.tnt) {
      for (const e of this.tnt.values()) this._removeTntFlash(e);
      this.tnt.clear();
    }
  }

  /* 天气：头顶 16 格内是否有实心方块。在洞里或屋子里时把降水强度压到几乎为 0，
     否则玩家站在洞穴里也会看到「下雨」，很出戏。 */
  shelteredAbove() {
    if (!this.world || !this.controller) return false;
    const x = Math.floor(this.controller.pos.x), z = Math.floor(this.controller.pos.z);
    const y0 = Math.floor(this.controller.pos.y + 0.2);
    for (let k = 1; k <= 16; k++) {
      const y = y0 + k;
      if (y > WORLD_H) break;
      if (isSolid(this.world.getBlock(x, y, z))) return true;
    }
    return false;
  }

  /* ================== 滚动任务 7：雷暴与闪电 ================== */
  /** 调试/剧情入口：打开或关闭雷暴（只对雨天生效；打开时立即进入满强度，便于观察） */
  setStorm(on) {
    if (!this.weather) return false;
    if (on && this.weather.type !== 'rain') {
      this.weather.set('rain', 120);
      this.weather.elapsed = 10;
      this.weather.intensity = 1;
    }
    const now = this.weather.setStorm(on);
    if (now) {
      this.weather.elapsed = Math.max(this.weather.elapsed, 10);
      this.weather.intensity = Math.max(this.weather.intensity, 1);
    }
    if (this.lightning) this.lightning.timer = now ? 0.8 : 3.2;
    return now;
  }

  /** 自然雷暴的节拍：每隔 3.5~8.5 秒在玩家周围 6~15 格处落一道雷 */
  updateLightning(dt) {
    const L = this.lightning;
    if (!L) return;
    if (L.flashT > 0) L.flashT = Math.max(0, L.flashT - dt);
    const storm = !!(this.weather && this.weather.isStorm && this.weather.intensity > 0.35);
    if (!storm) { L.timer = 2.4; return; }
    L.timer -= dt;
    if (L.timer > 0) return;
    L.timer = nextStrikeDelay();
    if (!this.controller) return;
    const off = pickStrikeOffset();
    this.strikeLightningAt(this.controller.pos.x + off.dx, this.controller.pos.z + off.dz);
  }

  /**
   * 在 (bx,bz) 落一道闪电：折线 + 全屏闪 + 延迟雷声 + 半径 6 格伤害。
   * 树冠/屋顶会挡住玩家（shelteredAbove），洞里不会被隔空劈中。
   * @returns {object|null} 本次落雷读数（x/y/z、命中生物数、玩家伤害）
   */
  strikeLightningAt(bx, bz) {
    if (!this.world || !this.lightning || !this.controller) return null;
    const x = Math.floor(bx), z = Math.floor(bz);
    const top = this.world.topSolidY(x, z);
    if (!(top > 0) || top >= WORLD_H - 3) return null;
    const L = this.lightning;
    L.strikes++;
    L.flashes++;
    L.flashT = 0.22;
    if (this.lightningFX) this.lightningFX.strike(x, top, z);
    if (this.ui && this.ui.lightningFlash) this.ui.lightningFlash(320);

    let hits = 0;
    if (this.mobs) {
      for (const m of this.mobs.list) {
        if (!m || m.hp <= 0) continue;
        if (m.pos.y < top - 2 || m.pos.y > top + 4) continue;   // 地下的生物不被地表落雷隔空劈中
        const dist = Math.hypot(m.pos.x - (x + 0.5), m.pos.z - (z + 0.5));
        const dmg = lightningDamage(dist);
        if (dmg <= 0) continue;
        this.mobs.hitMob(m, dmg, { x: 0, z: 0 }, { marker: false, quiet: true });
        hits++;
      }
    }
    let playerHit = 0;
    if (!this.controller.creative && this.controller.health > 0 && !this.shelteredAbove()) {
      const dist = Math.hypot(this.controller.pos.x - (x + 0.5), this.controller.pos.z - (z + 0.5));
      const dmg = lightningDamage(dist);
      if (dmg > 0) {
        this.controller.hurt(dmg, '被闪电击中', 'explosion', { kind: 'lightning' });
        playerHit = dmg;
      }
    }
    /* 雷声比闪光晚 0.25~1.1 秒，营造距离感；场景已销毁时 sfx 自己会静默 */
    const delay = thunderDelay();
    setTimeout(() => {
      if (this.sfx && this.state === 'playing') this.sfx.play('thunder', { volume: 0.9 });
    }, Math.round(delay * 1000));
    L.last = {
      x, y: top, z, at: Date.now(), hits, playerHit,
      dist: +Math.hypot(this.controller.pos.x - (x + 0.5), this.controller.pos.z - (z + 0.5)).toFixed(2)
    };
    return L.last;
  }

  /* D2：位置监视器。记录「单帧位移超过当前速度能解释的范围」的可疑跳变，
     以及帧耗时（>100ms 记一次慢帧）与自动存档的同步耗时。刻意传送（spawnAt/setPositions）后 2 帧不计。
     _posMon 是当前窗口（可被测试清零），posMonTotal 是整个进程累计（永不清零），后者才是「有没有瞬移」的结论依据。 */
  monitorPosition(dt, frameMs) {
    const m = this._posMon || (this._posMon = {
      frames: 0, jumps: [], paused: 0, last: null,
      maxFrameMs: 0, slowFrames: 0, saveSyncMs: 0, saves: 0,
      ev: this._stepupEv || 0, pendingAllow: false
    });
    const tot = this.posMonTotal || (this.posMonTotal = {
      frames: 0, jumpCount: 0, jumps: [], maxFrameMs: 0, slowFrames: 0, allowHits: 0
    });
    m.frames++; tot.frames++;
    if (frameMs > m.maxFrameMs) m.maxFrameMs = frameMs;
    if (frameMs > tot.maxFrameMs) tot.maxFrameMs = frameMs;
    if (frameMs > 100) { m.slowFrames++; tot.slowFrames++; }
    if (!this.controller) return;
    const p = this.controller.pos;
    // T2：分片加载期间 controller 是刚 new 出来的（还在默认位置），玩家要等区块灌完才会被放到存档坐标上。
    //     这段只记帧耗时、不记位移，否则每次读档都会被算成一次 200 格「瞬移」（实测 5 次）。
    //     出加载态的第一帧只重设基线（last=null），不会误报也不会漏报之后的真位移。
    if (this._loadingWorld) { m.last = null; m.pTime = this.controller.physicsTime || 0; return; }
    // 自动上台阶发生在「本帧物理」里（监视器在物理之前跑），所以它的位移要在下一次监视时才可见：
    // 用事件计数器的增量来给那一帧单独的豁免额度，比跨帧旗标可靠（旗标会被暂停帧或监视器重置吞掉）。
    const ev = this._stepupEv || 0;
    if (ev > (m.ev || 0)) m.pendingAllow = true;
    m.ev = ev;
    if (m.paused > 0) { m.paused--; m.last = { x: p.x, y: p.y, z: p.z }; m.pTime = this.controller.physicsTime || 0; return; }
    // 用物理推进的时间差来算「这一帧最多能走多远」：手动定步长推物理的测试帧不会被误判
    const pdt = Math.max(dt, (this.controller.physicsTime || 0) - (m.pTime || 0));
    if (m.last) {
      const d = Math.hypot(p.x - m.last.x, p.y - m.last.y, p.z - m.last.z);
      const v = this.controller.vel;
      const vMax = Math.hypot(v.x, v.y, v.z);
      // T4 的自动上台阶是「设计上就会一次抬升 ≤1.05 格」，给它单独的额度
      const allow = m.pendingAllow ? 1.15 : 0;
      if (m.pendingAllow) { tot.allowHits = (tot.allowHits || 0) + 1; m.pendingAllow = false; }
      const limit = Math.max(0.6, vMax * pdt * 1.6 + 0.35 + allow);
      if (d > limit) {
        const dxp = p.x - m.last.x, dyp = p.y - m.last.y, dzp = p.z - m.last.z;
        m.jumps.push({
          f: m.frames, d: +d.toFixed(2), limit: +limit.toFixed(2), dt: +pdt.toFixed(3),
          dx: +dxp.toFixed(2), dy: +dyp.toFixed(2), dz: +dzp.toFixed(2),
          frameMs: Math.round(frameMs), pos: [+p.x.toFixed(1), +p.y.toFixed(1), +p.z.toFixed(1)],
          v: +vMax.toFixed(1), onGround: !!this.controller.onGround, flying: !!this.controller.flying,
          inWater: !!this.controller.inWater, state: this.state, openUI: this.openUI || null,
          sinceTele: (this._loopFrames || 0) - (this._teleportFrame === undefined ? -1e9 : this._teleportFrame),
          teleEv: this._teleportEv || 0, stepEv: this._stepupEv || 0, loop: this._loopFrames || 0,
          stuckInSolid: this.controller.intersectsSolid(p.x, p.y, p.z)
        });
        tot.jumpCount++;
        if (tot.jumps.length < 10) tot.jumps.push(m.jumps[m.jumps.length - 1]);
      }
    }
    m.last = { x: p.x, y: p.y, z: p.z };
    m.pTime = this.controller.physicsTime || 0;
  }

  loop(t) {
    let dt = (t - this._lastTime) / 1000;
    if (!Number.isFinite(dt) || dt < 0) dt = 0.016;
    dt = Math.min(dt, 0.1);
    this._lastTime = t;
    this._loopFrames = (this._loopFrames || 0) + 1;
    // RAF 回调的 t 是「这一帧的开始」，分片加载时它可能早于上一次记账时刻（实测 -20ms），夹到 0 以上
    const frameMs = Math.max(0, t - (this._lastRaf || t));
    this._lastRaf = t;
    this.monitorPosition(dt, frameMs);
    this.elapsed += dt;
    this._frames++;
    const nowW = performance.now();
    if (!this._fpsWall) this._fpsWall = nowW;
    if (nowW - this._fpsWall > 500) {
      this.fps = Math.round(this._frames * 1000 / (nowW - this._fpsWall));
      this._frames = 0; this._fpsWall = nowW;
    }

    const playing = this.state === 'playing' && !this.openUI;
    if (!playing) this.cancelEating();
    if (!this._perf) this._perf = { update: 0, render: 0, phys: 0, frames: 0, _u: 0, _r: 0, _p: 0 };
    // 天气：只在正常游玩时推进（暂停界面、死亡界面都冻结，和昼夜一致）
    if (this.weather && playing) this.weather.update(dt);
    // 环境先算，供本帧手持物品与 HUD 使用
    let env = { dayFactor: 1 };
    if (this.view && this.camera) {
      env = this.view.updateEnvironment(this.time, this.elapsed, this.camera.position,
        this.controller && this.controller.eyeInWater, this.weather) || env;
      this._dayFactor = env.dayFactor;
    }
    if (this.weatherFX && this.camera) {
      const w = this.weather;
      this.weatherFX.update(dt, this.camera.position, w ? w.type : 'clear',
        w ? w.intensity : 0, this.shelteredAbove());
    }
    if (this.lightningFX) this.lightningFX.update(dt);
    if (playing) this.updateLightning(dt);
    // T4：音乐场景与环境床跟随真实昼夜/高度/天气；不每帧重建，只在场景或床变化时切
    if (this.state === 'playing' && this.controller) this.updateAudioScene();
    /* P2 首夜引导：只读 time 与背包，0.5 秒刷一次即可（不每帧碰 DOM）。
       不改昼夜总长、不改目标链、不入存档 —— 调节奏须先优化等昼夜的 e2e，见 原版参照规格.md。 */
    if (this.state === 'playing' && this.ui && this.ui.updateNightHint) {
      const nowMs = performance.now();
      if (!this._nightHintAt || nowMs - this._nightHintAt > 500) {
        this._nightHintAt = nowMs;
        let sheltered = false;
        try { sheltered = !!(this.world && this.controller && this.audioSceneState().sheltered); } catch (e) { /* ignore */ }
        this.ui.updateNightHint(this.time, {
          torch: this.inventory.countOf('torch') > 0,
          bed: this.inventory.countOf('bed') > 0,
          sheltered
        });
      }
    }
    if (this.state === 'playing' || this.state === 'dead') {
      // 时间流动（暂停界面时冻结）
      if (this.state === 'playing') {
        this.time = (this.time + dt / Math.max(30, this.settings.dayLengthSeconds)) % 1;
      }
      const input = this.input ? this.input.sync() : {};
      if (playing) {
        this.controller.update(dt, input);
        this.interaction.enabled = true;
        this.interaction.update(dt);
        this.tickEating(dt);
      } else {
        this.interaction.enabled = false;
        this.interaction.updateTarget && this.interaction.updateTarget();
        this.interaction.drops.update(dt);
      }
      this.tickFurnaces(dt);
      if (this.state === 'playing') this.tickTnt(dt);   // T5：引信只在正常游玩时推进
      if (this.state === 'playing') {
        this.mobs.update(dt, env.dayFactor);
        this.tickCrops(dt);
        this.tickSaplings(dt);
        this.tickFarmland(dt);
        this.updateLandmarks(dt);
      }
      this.controller.applyCamera(this.camera);
      /* 天空球按当前相机位置跟随：applyCamera 在环境更新之后执行，
         这里补一次同步，避免天空/云比相机慢一帧（e2e 15.2a 会量这个距离）。 */
      if (this.view && this.view.sky) this.view.sky.uniforms.uCamPos.value.copy(this.camera.position);
      if (this.ui && this.ui.updateCompass) this.ui.updateCompass(this.compassState());
      if (this.heldView) {
        this.heldView.setItem(this.inventory.heldItem());
        const light = this.world.brightnessAt(
          Math.floor(this.controller.pos.x), Math.floor(this.controller.eyeY), Math.floor(this.controller.pos.z),
          env.dayFactor);
        const bowCharge = this.interaction && this.interaction.bowCharge > 0 ? this.interaction.bowCharge : 0;
        this.heldView.update(dt, this.settings.bobbing && playing &&
          Math.hypot(this.controller.vel.x, this.controller.vel.z) > 0.5 && this.controller.onGround, light,
          !!this.controller.blocking, bowCharge);
      }
      this.particles.update(dt, this.world);

      const cw = Math.floor(this.controller.pos.x / 16), cz = Math.floor(this.controller.pos.z / 16);
      if (cw !== this.world.centerX || cz !== this.world.centerZ) this.world.setCenter(this.controller.pos.x, this.controller.pos.z);
      this.world.setRadius(this.settings.renderDistance);
      const _tu0 = performance.now();
      this.world.update(dt, FRAME_BUDGET, this.view);
      const _tu1 = performance.now();
      this._perf._u = _tu1 - _tu0;
      this._perf.update = Math.round((this._perf.update * 0.9 + this._perf._u * 0.1) * 100) / 100;
      /* 滚动任务 8：跨区块时记录一张地图快照（地图只记已真正加载过的区块） */
      const mcx = Math.floor(this.controller.pos.x / 16), mcz = Math.floor(this.controller.pos.z / 16);
      const mkey = coordKey(mcx, mcz);
      if (mkey !== this._mapChunkKey) {
        this._mapChunkKey = mkey;
        this.recordMapChunk(mcx, mcz);
      }

      // T3：区块在这一帧补完 / 树长在玩家站的那一格之后，身体若与实心方块重叠，顶到最近的可站立处。
      // 放在 world.update 之后是刻意的：这次补上的方块必须当场算进去，否则玩家会卡一帧动不了。
      const _rescue = this.controller.pushOutOfSolid();
      if (_rescue) {
        this.embedRescues = (this.embedRescues || 0) + 1;
        this._lastRescue = Object.assign({ at: this._loopFrames, y: +this.controller.pos.y.toFixed(2),
          pos: [+this.controller.pos.x.toFixed(2), +this.controller.pos.z.toFixed(2)] }, _rescue);
      }

      // 自动保存
      this.saveTimer += dt;
      if (this.saveTimer >= Math.max(10, this.settings.autosaveSeconds)) {
        this.saveTimer = 0;
        const _s0 = performance.now();
        this.save('auto');
        if (this._posMon) {
          // 只统计同步段（buildSaveObject + JSON.stringify）：这一段会真的卡住主循环
          this._posMon.saveSyncMs = Math.max(this._posMon.saveSyncMs, performance.now() - _s0);
          this._posMon.saves++;
        }
      }
      this.ui.updateHUD(this);
    }

    // T2：加载中的画面被半透明遮罩盖着，每 3 帧渲染 1 帧就够（省下的时间既是更小的帧间隔，也是更快的读档）
    this._renderTick = (this._renderTick || 0) + 1;
    const skipRender = this.state === 'loading' && (this._renderTick % 3) !== 0;
    if (this.view && !skipRender) {
      const _r0 = performance.now();
      this.view.render();
      const _r1 = performance.now();
      if (this._perf) this._perf.render = Math.round((this._perf.render * 0.9 + (_r1 - _r0) * 0.1) * 100) / 100;
    }
  }

  /* ---------- 掉落物 / 作物 / 物品使用 ---------- */
  spawnDrop(item, count, x, y, z) {
    if (!this.interaction) return null;
    return this.interaction.drops.spawn(item, count, x, y, z, true);
  }

  tickCrops(dt) {
    if (!this.crops.size) return;
    const GROW = 42;             // 完全成熟所需秒数
    const raining = !!(this.weather && this.weather.type === 'rain');
    for (const k of [...this.crops.keys()]) {
      const [x, y, z] = k.split(',').map(Number);
      const id = this.world.getBlock(x, y, z);
      if (id !== B.WHEAT) { this.crops.delete(k); continue; }
      let base = dt * (0.7 + Math.random() * 0.6);
      if (raining) {
        const exposed = isSkyExposed((xx, yy, zz) => this.world.isSolidAt(xx, yy, zz), x, y, z, WORLD_H);
        const mul = cropRainMultiplier(this.weather.type, exposed);
        if (mul > 1) {
          this.rainCropStats.exposedTicks++;
          this.rainCropStats.extra += base * (RAIN_GROWTH_MULTIPLIER - 1);
          this.rainCropStats.lastExposedMultiplier = mul;
        } else {
          this.rainCropStats.shelteredTicks++;
        }
        base *= mul;
      }
      let t = this.crops.get(k) + base;
      const meta = Math.min(7, Math.floor(t / GROW * 8));
      const cur = this.world.getMeta(x, y, z);
      if (meta !== cur) this.world.setBlock(x, y, z, B.WHEAT, meta, { record: true });
      // T2：一块成熟的麦子原本要同步重建整格区块，一整片田同时成熟就是几十次；改成排队等分帧预算
      if (meta >= 7) this.crops.delete(k);
      else this.crops.set(k, t);
    }
  }

  tickSaplings(dt) {
    if (!this.saplings.size) return;
    for (const k of [...this.saplings.keys()]) {
      const s = this.saplings.get(k);
      const [x, y, z] = k.split(',').map(Number);
      if (this.world.getBlock(x, y, z) !== B.SAPLING) { this.saplings.delete(k); continue; }
      s.age += dt;
      if (s.age < s.need) continue;
      if (this.growTreeAt(x, y, z, s.kind)) {
        this.saplings.delete(k);
        this.sfx.play('levelup', { volume: 0.35 });
      } else s.age = s.need - 4;      // 空间不够，稍后再试
    }
  }

  /* T1 耕地随机刻：刷新湿润位；干耕地累计干涸到阈值后退回泥土（有作物则不退回） */
  tickFarmland(dt) {
    if (!this.farmlands || !this.farmlands.size) return;
    this._farmT = (this._farmT || 0) + dt;
    if (this._farmT < 0.5) return;                 // 每 0.5 秒评估一批，模拟随机刻节奏
    const elapsed = this._farmT;
    this._farmT = 0;
    let budget = 16;                               // 单批上限，避免大量耕地时卡顿
    for (const k of [...this.farmlands.keys()]) {
      if (budget-- <= 0) break;
      const [x, y, z] = k.split(',').map(Number);
      if (this.world.getBlock(x, y, z) !== B.FARMLAND) { this.farmlands.delete(k); continue; }
      const f = this.farmlands.get(k);
      const exposed = this.weather && this.weather.type === 'rain'
        ? isSkyExposed((xx, yy, zz) => this.world.isSolidAt(xx, yy, zz), x, y, z, WORLD_H) : false;
      const wet = this.world.isFarmlandWet(x, y, z) ||
        rainWetsFarmland(this.weather && this.weather.type, exposed);
      const meta = this.world.getMeta(x, y, z);
      if ((meta & 1) !== (wet ? 1 : 0)) this.world.setBlock(x, y, z, B.FARMLAND, (meta & ~1) | (wet ? 1 : 0));
      // T2：同上，耕地湿润位刷新一批最多 16 格，不逐格同步重建
      if (wet) { f.dryT = 0; continue; }
      f.dryT += elapsed;
      const hasCrop = this.world.getBlock(x, y + 1, z) === B.WHEAT;
      if (farmlandShouldRevert(f.dryT, wet, hasCrop, f.need)) {
        this.world.setBlock(x, y, z, B.DIRT, 0);
        this.farmlands.delete(k);
      }
    }
  }

  /* 把 (x,y,z) 处的树苗长成一棵树；返回是否成功 */
  growTreeAt(x, y, z, kind) {
    const t = this.world.terrain;
    const trunk = kind === 'birch' ? 5 + (Math.abs(x * 7 + z * 13) % 3) : 4 + (Math.abs(x * 11 + z * 5) % 4);
    const tree = { kind: kind || 'oak', base: y, trunk, seed: ((x * 73856093) ^ (z * 19349663)) >>> 0 };
    const list = t.treeBlocks(tree, x, z);
    const canOverwrite = (id) => id === AIR || id === B.WATER || isPlant(id) ||
      id === B.LEAVES || id === B.BIRCH_LEAVES;
    // 先检查空间：只允许覆盖空气/水/植物/树叶，原木等实心方块会阻止生长
    for (const [dx, dy, dz, id] of list) {
      const wy = tree.base + dy;
      if (wy < 1 || wy >= WORLD_H) return false;
      if (!canOverwrite(this.world.getBlock(x + dx, wy, z + dz))) return false;
    }
    for (const [dx, dy, dz, id] of list) {
      const wy = tree.base + dy;
      const cur = this.world.getBlock(x + dx, wy, z + dz);
      if (canOverwrite(cur)) this.world.setBlock(x + dx, wy, z + dz, id, 0);
    }
    // 让周围区块重算光照与网格（setBlock 已标脏，这里立即刷新脚下区块保证观感）
    this.world.refreshImmediate(x, tree.base, z, this.view);
    return true;
  }

  /* 右键使用非方块物品（食物 / 种子 / 树苗） */
  useNonBlockItem(held, hit) {
    const it = getItem(held.item);
    if (!it) return false;
    const c = this.controller;
    // 准星命中的是装饰植物时，真正的地面在它下面一格
    const ground = (h) => {
      if (!h) return null;
      const id = this.world.getBlock(h.x, h.y, h.z);
      return isPlant(id) ? { x: h.x, y: h.y - 1, z: h.z } : { x: h.x, y: h.y, z: h.z };
    };
    if (it.food) {
      if (c.hunger >= 20 && !it.poison) { this.ui.toast('你已经吃饱了'); return false; }
      /* 本轮 E3：不再是「点一下立刻吃完」。按住右键开始进食过程，
         每一口有咬与咀嚼，吞咽那一刻才加饱食并扣物品；松手/换物品/开界面立刻停。 */
      return this.startEating(held);
    }
    // T1：锄头开垦 → 耕地（湿润位写进 meta，随方块 diff 自动进存档）
    if (it.toolType === 'hoe') {
      if (!hit) return false;
      const g = ground(hit);
      const below = this.world.getBlock(g.x, g.y, g.z);
      const above = this.world.getBlock(g.x, g.y + 1, g.z);
      if (!canTill(below, above)) { this.ui.toast('锄头只能开垦草方块或泥土'); return false; }
      const wet = this.world.isFarmlandWet(g.x, g.y, g.z) ? 1 : 0;
      if (isPlant(above)) this.world.setBlock(g.x, g.y + 1, g.z, AIR, 0);
      this.world.setBlock(g.x, g.y, g.z, B.FARMLAND, wet);
      this.world.refreshImmediate(g.x, g.y, g.z, this.view);
      this.farmlands.set(g.x + ',' + g.y + ',' + g.z, { dryT: 0, need: 55 + Math.random() * 30 });
      if (!c.creative) this.inventory.damageHeldTool(1);
      this.sfx.play('dig_dirt', { volume: 0.7, rate: 0.9 + Math.random() * 0.2 });
      this.sfx.play('place', { volume: 0.5, rate: 0.9 });
      this.particles.spawnBlock(g.x + 0.5, g.y + 1.1, g.z + 0.5, below, 8);
      this.ui.toast(wet ? '开垦了耕地（靠水，湿润）' : '开垦了耕地');
      return true;
    }
    if (it.seedFor === B.WHEAT || held.item === 'wheat_seeds') {
      if (!hit) return false;
      const g = ground(hit);
      const groundId = this.world.getBlock(g.x, g.y, g.z);
      if (!canPlantSeed(groundId)) {
        this.ui.toast('先用锄头开垦耕地，再播种');
        return false;
      }
      const p = { x: g.x, y: g.y + 1, z: g.z };
      const cur = this.world.getBlock(p.x, p.y, p.z);
      if (cur !== AIR && !isPlant(cur)) return false;
      this.world.setBlock(p.x, p.y, p.z, B.WHEAT, 0);
      this.world.refreshImmediate(p.x, p.y, p.z, this.view);
      this.crops.set(p.x + ',' + p.y + ',' + p.z, 0);
      const fk = g.x + ',' + g.y + ',' + g.z;
      if (!this.farmlands.has(fk)) this.farmlands.set(fk, { dryT: 0 });
      if (!c.creative) this.inventory.consumeHeld(1);
      this.sfx.play('place', { volume: 0.5 });
      this.ui.toast('种下了小麦');
      return true;
    }
    if (it.saplingMeta !== undefined) {
      if (!hit) return false;
      const g = ground(hit);
      const groundId = this.world.getBlock(g.x, g.y, g.z);
      if (groundId !== B.DIRT && groundId !== B.GRASS && groundId !== B.FARMLAND) {
        this.ui.toast('树苗只能种在泥土或草地上');
        return false;
      }
      const p = { x: g.x, y: g.y + 1, z: g.z };
      const cur = this.world.getBlock(p.x, p.y, p.z);
      if (cur !== AIR && !isPlant(cur)) return false;
      this.world.setBlock(p.x, p.y, p.z, B.SAPLING, it.saplingMeta);
      this.world.refreshImmediate(p.x, p.y, p.z, this.view);
      this.saplings.set(p.x + ',' + p.y + ',' + p.z, {
        age: 0, kind: (it.saplingMeta & 1) ? 'birch' : 'oak', need: 45 + Math.random() * 25
      });
      if (!c.creative) this.inventory.consumeHeld(1);
      this.sfx.play('place', { volume: 0.5 });
      this.ui.toast('种下了树苗，等待它长成一棵树');
      return true;
    }
    return false;
  }

  /* ---------- 熔炉 ---------- */
  tickFurnaces(dt) {
    const changed = new Set();
    for (const [k, f] of this.world.furnaces) {
      const id = this.world.getBlock(f.x, f.y, f.z);
      if (id !== B.FURNACE && id !== B.FURNACE_LIT) continue;
      const ev = f.tick(dt);
      if (ev.litChanged) changed.add(k);
      if (ev.smelted) {
        this.stats.smelted++;
        if (this.openUI === 'furnace' && this.activeFurnace === f) this.sfx.play('furnace_crack', { volume: 0.4 });
      }
    }
    for (const k of changed) {
      const f = this.world.furnaces.get(k);
      const [x, y, z] = k.split(',').map(Number);
      const want = f.lit ? B.FURNACE_LIT : B.FURNACE;
      if (this.world.getBlock(x, y, z) !== want) {
        this.world.setBlock(x, y, z, want, this.world.getMeta(x, y, z));
        this.world.refreshImmediate(x, y, z, this.view);
      }
    }
  }

  /* ================== 死亡与重生 ================== */
  onPlayerDeath(reason) {
    this.deathReason = reason || '死亡';
    this.cancelBlocking();
    this.state = 'dead';
    this.input.setUIMode(true);
    // 掉落全部物品（可立刻捡回）；T1：穿在身上的护甲同样掉落，不能白嫖免丢
    for (let i = 0; i < this.inventory.size; i++) {
      const s = this.inventory.get(i);
      if (!s) continue;
      this.interaction.drops.spawn(s.item, s.count, this.controller.pos.x, this.controller.pos.y + 0.4, this.controller.pos.z, true);
      this.inventory.set(i, null);
    }
    for (let i = 0; i < this.inventory.armor.length; i++) {
      const s = this.inventory.armor[i];
      if (!s) continue;
      this.interaction.drops.spawn(s.item, s.count, this.controller.pos.x, this.controller.pos.y + 0.4, this.controller.pos.z, true);
      this.inventory.armor[i] = null;
    }
    this.inventory.emit('equip');
    this.inventory.cursor = null;
    this.sfx.play('death', { volume: 0.55 });
    this.ui.showDeath(reason);
  }

  /* T2：床还在就回床，否则回世界出生点 */
  respawnPoint() {
    const b = this.bedSpawn;
    if (b && this.world) {
      const bx = Math.floor(b.x), by = Math.floor(b.y) - 1, bz = Math.floor(b.z);
      if (this.world.getBlock(bx, by, bz) === B.BED) return b;
    }
    return this.spawn;
  }

  /* T2 睡觉：只在夜晚生效。把时间推到清晨、恢复损失生命的一半，并把重生点设为这张床。
     饥饿不按“睡眠时长”扣减（跳过夜晚不消耗体力，与原版“睡觉不饿”的表现一致）。 */
  trySleep(hit) {
    if (!hit || !this.world) return false;
    if (this.world.getBlock(hit.x, hit.y, hit.z) !== B.BED) return false;
    if (!isNight(this.time)) {
      this.ui.toast('天还亮着，睡不着。等到夜里再来');
      return false;
    }
    const c = this.controller;
    const healed = c.creative ? 0 : Math.ceil((c.maxHealth - c.health) * 0.5);
    if (healed > 0) c.health = Math.min(c.maxHealth, c.health + healed);
    this.time = advanceToMorning(this.time);
    this.bedSpawn = { x: hit.x + 0.5, y: hit.y + 1, z: hit.z + 0.5 };
    if (this.stats) this.stats.slept = (this.stats.slept || 0) + 1;
    // 与原版一致：睡一觉会跳过恶劣天气
    const rained = !!(this.weather && this.weather.type !== 'clear');
    if (rained) this.weather.set('clear');
    this.sfx.play('levelup', { volume: 0.5 });
    this.ui.toast((healed > 0 ? '睡了一觉，天亮了，体力和重生点都回来了' : '睡了一觉，天亮了。重生点已设在这张床') +
      (rained ? '（雨停了）' : ''));
    this.ui.updateHUD(this);
    return true;
  }

  /* T2：床被破坏 → 该重生点失效，回落到世界出生点 */
  onBedBroken(hit) {
    const b = this.bedSpawn;
    if (!b) return false;
    if (Math.floor(b.x) === hit.x && Math.floor(b.y) - 1 === hit.y && Math.floor(b.z) === hit.z) {
      this.bedSpawn = null;
      this.ui.toast('床被破坏了，重生点回到世界出生点');
      return true;
    }
    return false;
  }

  respawn() {
    this.controller.respawn(this.respawnPoint());
    this.state = 'playing';
    this.input.setUIMode(false);
    this.ui.hideOverlays();
    this._lastTime = performance.now();
    this.saveTimer = 0;
  }

  /* ================== 存档 ================== */
  buildSaveObject() {
    this.syncGuardianState();     /* 阶段 5：写档前把运行时的血量/击败/领奖收回 */
    return {
      meta: {
        name: this.meta.name, seed: this.meta.seed, numericSeed: this.meta.numericSeed,
        mode: this.meta.mode, version: SAVE_VERSION,
        genVersion: this.world ? this.world.genVersion : GEN_LEGACY,   /* 写回生成版本；读档时缺字段一律按旧布局 */
        createdAt: this.meta.createdAt || Date.now()
      },
      player: {
        x: this.controller.pos.x, y: this.controller.pos.y, z: this.controller.pos.z,
        yaw: this.controller.yaw, pitch: this.controller.pitch,
        health: this.controller.health, flying: this.controller.flying,
        hunger: this.controller.hunger, saturation: this.controller.saturation,
        spawn: this.spawn,
        bed: this.bedSpawn || null      /* T2 重生点；旧存档没有这个字段 → null，读档时自动回落到出生点 */
      },
      inventory: this.inventory.serialize(),
      armor: this.inventory.serializeArmor(),      /* T1 四件装备与剩余耐久；旧档缺字段时读档回落为空装备 */
      selected: this.inventory.selected,
      achievements: this.achievements.serialize(),   /* T3：旧档缺字段 → 读档后按现有状态补记 */
      quests: this.quests ? this.quests.serialize() : null,  /* Q1：独立目标链；旧档缺字段 → 静默推断 */
      crafting: { player: this.playerCraft.serialize(), table: this.tableCraft.serialize() },
      time: this.time,
      weather: this.weather ? this.weather.serialize() : { t: 'clear', left: 300, el: 0, inten: 0 },
      stats: this.stats,
      chunks: this.world.serializeEdits(),
      furnaces: this.world.serializeFurnaces(),
      containers: this.world.serializeContainers(),
      mobs: this.mobs ? this.mobs.serialize() : [],
      village: this.village || null,      /* 滚动任务 6：站点元数据；旧档没有该字段 → null（不补建村庄） */
      camp: this.camp || null,            /* E3：营地元数据；旧档没有该字段 → null（不补建营地） */
      landmarks: this.landmarks || {},    /* R1：探索地点注册表；旧档缺字段 → 空表 */
      guardian: this.guardian || null,    /* 阶段 5：守卫按地点稳定 ID 的状态；旧档缺字段 → 未挑战 */
      mapSeen: this.mapSeen || {},        /* 滚动任务 8：已探索区块的 256 格色块地图；旧档缺字段 → 空地图 */
      crops: Object.fromEntries(this.crops || []),
      saplings: Object.fromEntries(this.saplings || []),
      farmlands: Object.fromEntries(this.farmlands || []),
      drops: this.interaction ? this.interaction.drops.list.map(d => ({
        i: d.item, c: d.count, x: +d.x.toFixed(2), y: +d.y.toFixed(2), z: +d.z.toFixed(2)
      })) : []
    };
  }

  async save(kind) {
    if (!this.meta) return false;
    try {
      const obj = this.buildSaveObject();
      await this.storage.saveWorld(this.meta.name, obj);
      this.lastSaveAt = Date.now();
      this.saveTimer = 0;
      if (kind === 'manual') this.ui.toast('已保存');
      else this.ui.flashSaved && this.ui.flashSaved();
      this.ui.updateSaveIndicator(this.lastSaveAt);
      return true;
    } catch (e) {
      console.error('保存失败', e);
      this.ui.toast('保存失败：' + e.message, true);
      return false;
    }
  }

  requestManualSave() {
    // T2：分片加载期间（state='loading'）区块还没灌完，这时候存盘会把没生成的区块当成「无改动」落盘
    if (this.state === 'menu' || this.state === 'loading') return;
    return this.save('manual');
  }

  showMenu() {
    if (this.state === 'loading') return;      // T2：加载中不响应「回主菜单」，否则会把半个世界写进存档
    if (this.state !== 'menu') {
      this.save('auto').then(() => this.toMenu());
    }
  }

  async toMenu() {
    this.disposeWorld();
    this.state = 'menu';
    this.ui.showMenu();
  }

  quitGame() {
    const done = () => this.storage.quit();
    if (this.meta && this.state !== 'menu') this.save('auto').then(done, done);
    else done();
  }

  /* ================== 其它 ================== */
  async applySettingsLive(s) {
    Object.assign(this.settings, s);
    await this.storage.saveSettings(this.settings);
    this.applyAudioVolumes();
    /* 本轮 D：「背景音乐」开关只关主曲，环境床（风/虫鸣/洞穴滴水/雨）继续按场景走。
       旧行为是 s.music === false → stopMusic() → 连环境床一起停，玩家只想安静点，
       世界却整体静音了。暂停时的释放规则不变（pause 里仍会 stopMusic + setAmbientEnabled(false)）。 */
    if (s.music === false) this.sfx.setMusicEnabled(false);
    else if (this.world && this.state === 'playing') this.sfx.setMusicEnabled(true);
    if (this.view) {
      this.view.applySettings({
        renderDistance: s.renderDistance, fov: s.fov,
        brightness: s.brightness, renderScale: s.renderScale
      });
      if (this.world) { this.world.setRadius(s.renderDistance); this.world.setCenter(this.controller.pos.x, this.controller.pos.z); }
    }
  }

  setMode(mode) {
    if (!this.meta) return;
    this.meta.mode = mode;
    this.controller.setCreative(mode === 'creative');
    this.inventory.infinite = mode === 'creative';
    if (mode === 'creative' && !this.inventory.held()) this.fillCreativeHotbar();
    this.ui.updateHotbar();
    this.ui.toast('游戏模式：' + (mode === 'creative' ? '创造' : '生存'));
  }

  pickBlockForCreative(blockId) {
    const it = Object.keys(ITEMS).find(k => ITEMS[k].blockId === blockId);
    if (!it) return;
    if (this.controller.creative) {
      this.inventory.set(this.inventory.selected, { item: it, count: 64 });
      this.inventory.emit('load');
      this.ui.updateHotbar();
    }
  }

  onBlockBroken(id, hit) { this.stats.mined++; }
  onBlockPlaced() { this.stats.placed++; }
  onPickup(item, n) {
    this.pickupToastTimer = 0.4;
    if (this.settings.showFps) this.ui.toast('+' + n + ' ' + (getItem(item) ? getItem(item).name : item), false, 0.6);
  }

  resize() {
    if (!this.view) return;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.view.resize(w, h);
  }

  /* 自动化测试入口 */
  testApi() {
    const self = this;
    return {
      state: () => ({
        gameState: self.state, mode: self.meta && self.meta.mode, seed: self.meta && self.meta.seed,
        genVersion: self.world ? self.world.genVersion : -1,
        pos: { ...self.controller.pos }, onGround: self.controller.onGround, flying: self.controller.flying,
        health: self.controller.health, time: self.time, held: self.inventory.held(),
        selected: self.inventory.selected, inventory: self.inventory.serialize(),
        stats: self.stats, chunks: self.world.chunks.size, fps: self.fps,
        loopFrames: self._loopFrames || 0, stopLoop: !!self.stopLoop, openUI: self.openUI,
        target: self.interaction.target, loadedCenter: [self.world.centerX, self.world.centerZ]
      }),
      look: (yaw, pitch) => { self.controller.yaw = yaw; self.controller.pitch = pitch; },
      key: (code, down) => { self.input._onKey({ code, preventDefault() { }, shiftKey: false }, !!down); },
      give: (item, count = 1) => self.inventory.add(item, count),
      select: (i) => self.selectHotbar(i),
      teleport: (x, y, z) => { self.controller.spawnAt(x, y, z); },
      blockAt: (x, y, z) => ({ id: self.world.getBlock(x, y, z), name: blockName(self.world.getBlock(x, y, z)), meta: self.world.getMeta(x, y, z) }),
      /* P0 色彩审计用：把某个格子的天空光/方块光原始等级读出来（0~15）。
         洞穴「发灰」到底是光照数据问题还是着色器曲线问题，先看这个再动手。 */
      lightAt: (x, y, z) => {
        const l = self.world.getLight(x, y, z);
        return {
          sky: l >> 4, block: l & 15, raw: l,
          id: self.world.getBlock(x, y, z),
          brightDay: +self.world.brightnessAt(x, y, z, 1).toFixed(4),
          brightNight: +self.world.brightnessAt(x, y, z, 0.05).toFixed(4)
        };
      },
      /* P1 实体光照曲线读数：EL.2 用它核对「JS 侧曲线」与「VOX_FRAG 里的常数」同源 */
      entityLight: (sky, block, day) => +entityBrightness(sky, block, day).toFixed(4),
      /* 阶段 2 建材：按名字取方块数字 ID，验收脚本不再硬写数字 */
      blockIds: B,
      /* 阶段 1 分段计时：会话级总账（跨读档累计）+ 当前 world 的即时累计。
         只读 live 那一份会在读档后被清零，看不出整程花在哪。 */
      perfTotals: () => {
        const acc = Object.assign({ frameMs: 0, genMs: 0, lightMs: 0, meshMs: 0, calls: 0,
          genChunks: 0, lightChunks: 0, meshChunks: 0, worlds: 0 }, self.perfTotals || {});
        const live = self.world && self.world.perf ? self.world.perf.totals : null;
        /* 当前 world 还没 dispose，它的累计不在 acc 里 → 给一份合并后的 total */
        const total = Object.assign({}, acc);
        if (live) {
          total.frameMs += live.frameMs; total.genMs += live.genMs; total.lightMs += live.lightMs;
          total.meshMs += live.meshMs; total.calls += live.calls; total.genChunks += live.genChunks;
          total.lightChunks += live.lightChunks; total.meshChunks += live.meshChunks; total.worlds++;
        }
        return { acc, live, total, genVersion: self.world ? self.world.genVersion : -1 };
      },
      /* T2：测试里的批量建造只标脏，把网格重建交给 world.update 的分帧预算；
         玩家真实挖掘 / 放置（interaction.js）仍然同步刷新那一格，手感不受影响。 */
      setBlock: (x, y, z, id) => !!self.world.setBlock(x, y, z, id, 0),
      mineAt: (x, y, z) => { self.interaction.finishBreak({ x, y, z }); },
      placeAt: (x, y, z, item) => {
        self.inventory.set(self.inventory.selected, { item, count: 64 });
        const bid = getItem(item).blockId;
        self.world.setBlock(x, y, z, bid, 0);
        self.world.refreshImmediate(x, y, z, self.view);
      },
      /* T1：走与右键完全相同的生产代码路径（useNonBlockItem），只是命中点由测试给定 */
      useHeldAt: (x, y, z) => {
        const h = self.inventory.held();
        if (!h) return false;
        return !!self.useNonBlockItem(h, { x, y, z, face: 'top' });
      },
      farmlandWet: (x, y, z) => self.world.isFarmlandWet(x, y, z),
      tileFor: (id, meta, face) => tileForFace(id, meta, face),
      itemDef: (id) => (getItem(id) ? { id, damage: getItem(id).damage || 0, toolType: getItem(id).toolType || null,
        blockId: getItem(id).blockId === undefined ? null : getItem(id).blockId } : null),
      /* E1 创造搜索：纯函数读数 + 当前面板 DOM 状态 */
      creativeSearch: (q) => filterCreativeItems(q),
      creativeState: () => ({
        query: self.ui ? self.ui.creativeQuery : '',
        focused: document.activeElement && document.activeElement.id === 'inp-creative-search',
        inputValue: document.querySelector('#inp-creative-search') ? document.querySelector('#inp-creative-search').value : null,
        countText: document.querySelector('#creative-count') ? document.querySelector('#creative-count').textContent : null,
        grid: document.querySelectorAll('#creative-grid .slot').length,
        empty: document.querySelector('#creative-empty') ? document.querySelector('#creative-empty').classList.contains('on') : null,
        tabs: document.querySelectorAll('#panel-inventory .tab').length
      }),
      farmlandCount: () => (self.farmlands ? self.farmlands.size : 0),
      tickFarmland: (dt) => self.tickFarmland(dt),
      /* E4：直接推进作物一步（测试确定随机数时用来读精确倍率）与雨天计数 */
      tickCrops: (dt) => self.tickCrops(dt),
      farmRainInfo: () => Object.assign({}, self.rainCropStats || {},
        { rain: !!(self.weather && self.weather.type === 'rain') }),
      /* T2 床：睡觉、重生点与破坏回落（都走生产代码路径） */
      sleepAt: (x, y, z) => !!self.trySleep({ x, y, z }),
      bedSpawn: () => (self.bedSpawn ? { ...self.bedSpawn } : null),
      respawnPoint: () => ({ ...self.respawnPoint() }),
      setTime: (t) => { self.time = t; },
      /* T5 爆炸读数：explosions=自爆结算过几次，last=最近一次的格子数/真正移除数/伤害 */
      blastInfo: () => ({
        explosions: self.explosions || 0, last: self._lastBlast || null,
        creeperAlive: self.mobs ? self.mobs.list.some(x => x.type === 'creeper') : false,
        pending: self.world ? self.world.pending() : null
      }),
      /* T3 顶出保护读数：rescues=主循环真的救过人的次数（证明接上了，不是写了没调用） */
      embedInfo: () => (self.controller ? {
        rescues: self.embedRescues || 0,
        last: self._lastRescue || null,
        stuck: self.controller.intersectsSolid(self.controller.pos.x, self.controller.pos.y, self.controller.pos.z),
        ready: self.controller.chunksAroundReady(),
        pos: [+self.controller.pos.x.toFixed(3), +self.controller.pos.y.toFixed(3), +self.controller.pos.z.toFixed(3)]
      } : null),
      /* T2 分帧预算读数 */
      loadStats: () => (self._loadStats ? Object.assign({}, self._loadStats) : null),
      worldPending: () => (self.world ? self.world.pending() : null),
      worldPerf: () => (self.world ? {
        calls: self.world.perf.calls,
        lastCallMs: Math.round(self.world.perf.lastCallMs * 10) / 10,
        maxCallMs: Math.round(self.world.perf.maxCallMs * 10) / 10,
        maxGenChunkMs: Math.round(self.world.perf.maxGenChunkMs * 10) / 10,
        maxLightChunkMs: Math.round(self.world.perf.maxLightChunkMs * 10) / 10,
        maxMeshChunkMs: Math.round(self.world.perf.maxMeshChunkMs * 10) / 10
      } : null),
      /* D2 位置监视器读数（window = 本采样窗口，total = 整个进程累计） */
      posMon: () => (self._posMon ? {
        frames: self._posMon.frames, jumps: self._posMon.jumps.slice(0, 12), jumpCount: self._posMon.jumps.length,
        maxFrameMs: Math.round(self._posMon.maxFrameMs), slowFrames: self._posMon.slowFrames,
        saveSyncMs: Math.round(self._posMon.saveSyncMs), saves: self._posMon.saves,
        total: self.posMonTotal ? {
          frames: self.posMonTotal.frames, jumpCount: self.posMonTotal.jumpCount,
          jumps: self.posMonTotal.jumps.slice(0, 6), maxFrameMs: Math.round(self.posMonTotal.maxFrameMs),
          slowFrames: self.posMonTotal.slowFrames, stepups: self._stepupEv || 0,
          allowHits: self.posMonTotal.allowHits || 0
        } : null
      } : null),
      resetPosMon: () => { self._posMon = null; self.monitorPosition(0.016, 0); return true; },
      /* D2 诊断：上台阶链路的三级计数（tryStepUp 实际执行 / 事件送达 Game / 监视器豁免真的用过） */
      stepDiag: () => ({
        inController: self.controller ? (self.controller.stepups || 0) : -1,
        events: self._stepupEv || 0,
        allowHits: self.posMonTotal ? (self.posMonTotal.allowHits || 0) : -1,
        trace: (self._stepupTrace || []).slice()
      }),
      /* C：UI 信息层级的只读诊断——读的是真实 DOM，不是函数返回值，
         这样「tooltip 不溢出窗口」「高亮落在哪一格」「熔炼进度条有多长」都骗不了人 */
      itemTip: () => {
        const t = document.getElementById('item-tip');
        if (!t) return { exists: false, show: false, vw: window.innerWidth, vh: window.innerHeight };
        const r = t.getBoundingClientRect();
        const txt = (sel) => { const n = t.querySelector(sel); return n ? n.textContent : ''; };
        return {
          exists: true, show: t.classList.contains('show'),
          name: txt('.tname'), use: txt('.tuse'), lines: [...t.querySelectorAll('.tline')].map(n => n.textContent),
          durWidth: t.querySelector('.tdur i') ? t.querySelector('.tdur i').style.width : null,
          rect: { left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1) },
          vw: window.innerWidth, vh: window.innerHeight
        };
      },
      questNeed: () => [...document.querySelectorAll('.slot.quest-need')].map(s => (s.dataset && s.dataset.item) || ''),
      furnaceProgress: () => {
        const a = document.getElementById('furnace-arrow');
        const info = document.getElementById('furnace-info');
        const fill = a ? a.querySelector('.fill') : null;
        const cs = (n) => (n ? getComputedStyle(n).backgroundColor : null);
        return {
          hasArrow: !!a, progress: a ? a.dataset.progress : null,
          fillWidth: fill ? fill.style.width : null,
          fillBg: cs(fill), arrowBg: cs(a),
          hot: !!(a && a.classList.contains('hot')),
          info: info ? info.textContent : ''
        };
      },
      /* A：生物姿态只读诊断。同时给出「算出来的姿态」和「部件上真实的角度」，
         这样 e2e 必须走真实攻击/受击才能过，只调用纯函数是伪造不出来的。 */
      mobPose: (i = 0) => {
        const m = self.mobs && self.mobs.list[i];
        if (!m) return null;
        const p = m.pose || computePose(m, 0);
        const parts = (m.mesh && m.mesh.userData.parts) || {};
        const rx = (o) => (o ? +o.rotation.x.toFixed(4) : null);
        const ry = (o) => (o ? +o.rotation.y.toFixed(4) : null);
        return {
          type: m.type, hostile: !!(m.def && m.def.hostile), hasArms: !!parts.arm0,
          moving: !!m.moving, age: +m.age.toFixed(3),
          animAttack: +(m.animAttack || 0).toFixed(4), hurtT: +(m.hurtT || 0).toFixed(4),
          pose: {
            arm0: +p.arm0.toFixed(4), arm1: +p.arm1.toFixed(4),
            headX: +p.headX.toFixed(4), headY: +p.headY.toFixed(4),
            bodyScaleY: +p.bodyScaleY.toFixed(4), tiltZ: +p.tiltZ.toFixed(4),
            atkFront: +p.atkFront.toFixed(4), atk: +p.atk.toFixed(4), hurt: +p.hurt.toFixed(4),
            legSwing: +p.legSwing.toFixed(4)
          },
          applied: {
            arm0: rx(parts.arm0), arm1: rx(parts.arm1), leg0: rx(parts.leg0), leg1: rx(parts.leg1),
            leg2: rx(parts.leg2), leg3: rx(parts.leg3),
            headX: rx(parts.head), headY: ry(parts.head),
            bodyScaleY: parts.body ? +parts.body.scale.y.toFixed(4) : null,
            tiltZ: m.mesh ? +m.mesh.rotation.z.toFixed(4) : null
          },
          yaw: +m.yaw.toFixed(4), meshRotY: +m.mesh.rotation.y.toFixed(4),
          hp: m.hp, dead: !!m.dead,
          pos: [+m.pos.x.toFixed(3), +m.pos.y.toFixed(3), +m.pos.z.toFixed(3)]
        };
      },
      mobDump: () => (self.mobs ? self.mobs.list.map(m => ({
        t: m.type, x: +m.pos.x.toFixed(3), y: +m.pos.y.toFixed(3), z: +m.pos.z.toFixed(3),
        w: +m.width.toFixed(3),
        free: !self.mobs.mobAABBBlocked(m, m.pos.x, m.pos.y, m.pos.z), ground: !!m.onGround
      })) : []),
      /* 阶段 3a：鱼群站点是纯函数，验收脚本要能自己算出「哪一格有一群」再走过去，
         而不是靠运气等刷怪；fishInfo 把 tail 部件的真实旋转读出来，
         证明摆尾是 render() 应用到模型上的（与 A1「姿态纯函数 + render 真实应用」同一口径）。 */
      fishSiteAt: (sx, sz) => fishSchoolOf(self.world ? self.world.seed : 0, sx, sz),
      fishInfo: () => (self.mobs ? self.mobs.list.filter(m => m.def.aquatic).map(m => ({
        x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2),
        school: m.school, homeY: m.homeY, inWater: !!m.inWater, airT: +(m.airT || 0).toFixed(2),
        tail: (m.mesh && m.mesh.userData.parts && m.mesh.userData.parts.tail)
          ? +m.mesh.userData.parts.tail.rotation.y.toFixed(3) : null,
        /* 阶段 3c：胸鳍与背鳍的真实角度 —— 「鱼有可辨认的小幅动作」要能在模型上读到，
           而不只是 computePose 里算了一个数（与 FS.4 摆尾同一口径） */
        finL: (m.mesh && m.mesh.userData.parts && m.mesh.userData.parts.finL)
          ? +m.mesh.userData.parts.finL.rotation.z.toFixed(3) : null,
        finR: (m.mesh && m.mesh.userData.parts && m.mesh.userData.parts.finR)
          ? +m.mesh.userData.parts.finR.rotation.z.toFixed(3) : null,
        finTop: (m.mesh && m.mesh.userData.parts && m.mesh.userData.parts.finTop)
          ? +m.mesh.userData.parts.finTop.rotation.z.toFixed(3) : null,
        shade: m._shade === undefined ? null : +m._shade.toFixed(3)
      })) : []),
      /* 阶段 3a：把鱼群的产品参数原样交给验收脚本，断言里的界就是代码里的界 */
      fishLimits: () => ({
        siteStep: FISH_SITE_STEP, schoolMin: FISH_SCHOOL_MIN, schoolMax: FISH_SCHOOL_MAX,
        waterDepth: FISH_WATER_DEPTH, airSeconds: FISH_AIR_SECONDS, maxAlive: FISH_MAX_ALIVE
      }),
      /* 阶段 3c：飞鸟与地下刷怪判据的只读入口。
         站点是纯函数（与 fishSiteAt 同一套做法），验收脚本能自己算出「哪一列有鸟、
         那一列有没有能停的树冠」，再自然走过去等刷怪 —— 不靠运气、也不手动 spawn。 */
      birdSiteAt: (sx, sz) => birdFlockOf(self.world ? self.world.seed : 0, sx, sz),
      birdPerchAt: (x, z) => (self.mobs ? self.mobs.findPerchAt(x, z) : null),
      birdInfo: () => (self.mobs ? self.mobs.list.filter(m => m.def.flying).map(m => {
        const parts = m.mesh && m.mesh.userData ? m.mesh.userData.parts : null;
        return {
          uid: m.uid,
          x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2),
          site: m.birdSite, phase: m.phase, moving: !!m.moving,
          home: { x: +(m.homeX || 0).toFixed(2), y: +(m.homeY || 0).toFixed(2), z: +(m.homeZ || 0).toFixed(2) },
          dHome: +Math.hypot(m.pos.x - (m.homeX || 0), m.pos.z - (m.homeZ || 0)).toFixed(2),
          aboveCanopy: +(m.pos.y - (m.homeY === undefined ? m.pos.y : m.homeY)).toFixed(2),
          speed: +Math.hypot(m.vel.x, m.vel.y, m.vel.z).toFixed(3),
          yaw: +m.yaw.toFixed(3), turnRate: +(m.turnRate || 0).toFixed(3),
          flap: +(m.flapPhase || 0).toFixed(3),
          wingL: parts && parts.wingL ? +parts.wingL.rotation.z.toFixed(3) : null,
          wingR: parts && parts.wingR ? +parts.wingR.rotation.z.toFixed(3) : null,
          tail: parts && parts.tail ? +parts.tail.rotation.y.toFixed(3) : null,
          perch: m.perch ? { x: +m.perch.x.toFixed(2), y: +m.perch.y.toFixed(2), z: +m.perch.z.toFixed(2) } : null,
          inBlock: self.mobs ? !self.mobs.canFlyAt(m.pos.x, m.pos.y, m.pos.z) : null
        };
      }) : []),
      /* 注意 `flightRules()` 是 Object.freeze 过的（纯函数返回值共享同一份），
         直接把它当 Object.assign 的目标会抛「object is not extensible」——必须写进新对象。 */
      birdLimits: () => Object.assign({}, flightRules(), {
        types: AIR_TYPES.slice(), darkLimit: SPAWN_DARK_LIMIT, dayLight: SPAWN_DAY_LIGHT,
        /* 地下通路的那几个数也一并交出去：LG.* 的断言里的界必须是代码里的界 */
        caveCap: SPAWN_CAVE_CAP, caveInterval: SPAWN_CAVE_INTERVAL,
        caveDistMin: SPAWN_UNDERGROUND_MIN_DIST, caveDistRange: SPAWN_UNDERGROUND_RANGE,
        coverMin: UNDERGROUND_MIN_COVER, depthMax: UNDERGROUND_MAX_DEPTH
      }),
      /* 生态总量读数：四条通路（陆上 / 水域 / 洞穴 / 林冠）共用同一把 maxMobs 闸，
         验收要能一眼看出「谁刷了多少、闸还剩多少」，而不是只看总数。 */
      mobSpawnInfo: () => {
        if (!self.mobs) return null;
        const list = self.mobs.list;
        return {
          total: list.length,
          maxMobs: self.mobs.maxMobs,
          /* 阶段 3c：陆上那一路当前能用的额度（玩家在地表时 == maxMobs，下洞之后让出洞穴与林冠的份） */
          landCap: self.mobs.landSpawnCap(),
          surfaceCap: self.mobs.surfaceSpawnCap(),
          hostile: list.filter(m => m.def.hostile).length,
          land: list.filter(m => !m.def.hostile && !m.def.aquatic && !m.def.flying).length,
          caveHostiles: list.filter(m => m.def.hostile && m.undergroundSpawn).length,
          aquatic: list.filter(m => m.def.aquatic).length,
          flying: list.filter(m => m.def.flying).length,
          flyingWithSite: list.filter(m => m.def.flying && m.birdSite).length,
          timers: {
            spawn: +self.mobs.spawnTimer.toFixed(2), fish: +self.mobs.fishTimer.toFixed(2),
            cave: +self.mobs.caveTimer.toFixed(2), bird: +self.mobs.birdTimer.toFixed(2)
          }
        };
      },
      /* 阶段 3c：地下刷怪判据的只读入口——同一坐标、同一天光，只改「这一点有没有被点亮」。 */
      mobSiteOk: (hostile, x, y, z, day) => (self.mobs ? self.mobs.spawnSiteOk(hostile, x, y, z, day) : null),
      exposedToSky: (x, y, z) => (self.mobs ? self.mobs.exposedToSky(x, y, z) : null),
      /* 把产品自己的 findUndergroundSpawnPoint 跑 N 次的采样计数，A/B 才能反复量。
         box 是可选的长方体筛选（方块坐标闭区间）：验收要在**同一个玩家站位**上量
         「候选点搜索落不落在这一间洞里」，点灯前后各跑一次才是「风险下降」的读数。 */
      caveSiteProbe: (day, tries, box) => {
        if (!self.mobs) return null;
        const n = Math.max(1, Math.min(400, tries || 60));
        let hits = 0, inBox = 0;
        const lights = [], points = [];
        const inB = (p) => !!box && Math.floor(p.x) >= box.x0 && Math.floor(p.x) <= box.x1 &&
          Math.floor(p.y) >= box.y0 && Math.floor(p.y) <= box.y1 &&
          Math.floor(p.z) >= box.z0 && Math.floor(p.z) <= box.z1;
        for (let i = 0; i < n; i++) {
          const p = self.mobs.findUndergroundSpawnPoint(day === undefined ? 1 : day);
          if (!p) continue;
          hits++;
          if (inB(p)) inBox++;
          lights.push(+Number(p.light).toFixed(3));
          if (points.length < 6) points.push([+p.x.toFixed(1), p.y, +p.z.toFixed(1)]);
        }
        return { tries: n, hits, inBox, lights: lights.slice(0, 6), points };
      },
      /* 阶段 3b：骷髅/苦力怕重做的四组只读读数（贴图、转轴、拉弓、引信档位）。
         全部走 mobs.js / mobtex.js 里的同一份实现，验收脚本不自己复制公式。 */
      mobTexStats: (name) => mobTexStats(name),
      mobSkinInfo: (type, sheared) => mobSkinReadout(type, !!sheared),
      mobLimbPivot: (type, part, rotX) => {
        const m = self.mobs ? self.mobs.list.find(x => x.type === type) : null;
        return m ? limbPivotRead(m, part, rotX === undefined ? 0.6 : rotX) : null;
      },
      mobCombatInfo: () => (self.mobs ? self.mobs.list
        .filter(m => m.def.ranged || m.def.explode)
        .map(m => {
          const parts = (m.mesh && m.mesh.userData.parts) || {};
          const bow = parts.bow, ud = (bow && bow.userData) || {};
          const body = parts.body;
          const mats = body ? (Array.isArray(body.material) ? body.material : [body.material]) : [];
          return {
            type: m.type,
            x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2),
            hp: +m.hp.toFixed(2),
            drawing: !!m.drawing, bowDraw: +(m.bowDraw || 0).toFixed(3),
            drawT: +(m.drawT || 0).toFixed(3), attackCd: +(m.attackCd || 0).toFixed(3),
            animAttack: +(m.animAttack || 0).toFixed(3),
            arrows: self.mobs.arrows.length,
            nockZ: ud.nockZ === undefined ? null : +ud.nockZ.toFixed(4),
            stringMidZ: ud.stringUpper ? +ud.stringUpper.position.z.toFixed(4) : null,
            stringScale: ud.stringUpper ? +ud.stringUpper.scale.y.toFixed(4) : null,
            stringRotX: ud.stringUpper ? +ud.stringUpper.rotation.x.toFixed(4) : null,
            arrowVisible: ud.arrow ? !!ud.arrow.visible : null,
            bowRotX: bow ? +bow.rotation.x.toFixed(4) : null,
            charging: !!m.charging, fuse: +(m.fuse || 0).toFixed(3), fuseStage: m.fuseStage || 0,
            hissT: +(m.hissT || 0).toFixed(3),
            hurtT: +(m.hurtT || 0).toFixed(3),
            bodyColor: mats.length ? mats[0].color.getHexString() : null,
            bodyColorsSame: mats.length > 0 && mats.every(mm => mm.color.getHexString() === mats[0].color.getHexString()),
            /* 阶段 3b：受击闪色是改 material.color，不许把六面画布换掉或摘掉 */
            bodyHasMap: mats.length > 0 && mats.every(mm => !!(mm.map && mm.map.image)),
            bodyMats: mats.length,
            swell: +m.mesh.scale.x.toFixed(4)
          };
        }) : []),
      wolfInfo: () => (self.mobs ? self.mobs.list.filter(m => m.type === 'wolf').map(m => ({
        hp: m.hp, maxHp: m.maxHp, tamed: !!m.tamed, sitting: !!m.sitting,
        progress: m.tameProgress || 0, collar: !!(m.collar && m.collar.visible),
        w: +m.width.toFixed(3), h: +m.height.toFixed(3),
        x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2)
      })) : []),
      /* 滚动任务 6：村庄与村民交易读数（结构落地数、村民坐标/职业、最近一次交易） */
      villageInfo: () => self.villageInfo(),
      campInfo: () => self.campInfo(),
      landmarksInfo: () => self.landmarksInfo(),
      landmarkCandidates: () => self.landmarkCandidates(),
      discoveredLandmarks: () => self.discoveredLandmarks(),
      /* 阶段 5：守卫只读诊断。独立验收场景与主线都读同一份，不复制公式。 */
      guardianInfo: () => (self.mobs ? self.mobs.guardianInfo() : null),
      /* 第二轮 D：场上光弹的只读读数（证明「看得见飞行过程」而不是发射即扣血） */
      guardianBolts: () => (self.mobs && self.mobs.guardianBoltInfo ? self.mobs.guardianBoltInfo() : []),
      /* SK.7：产品实际施加的击退冲量（与 guardianLastFire 同一类只读诊断） */
      lastKnockback: () => (self.mobs ? (self.mobs.lastKnockback || null) : null),
      /* 光弹结束原因（命中/撞墙/超程/寿命）：验收用它证明墙真的吸收了 */
      guardianBoltEnd: () => (self.mobs ? (self.mobs.guardianLastBoltEnd || null) : null),
      guardianSaved: () => Object.assign({}, self.guardian || {}),
      guardianSite: () => self.guardianSite(),
      guardianStats: () => Object.assign({}, self.guardianStats || {}),
      guardianWards: () => self.guardianWardInfo(),
      tradeAt: (i) => self.tradeWithVillager(i),
      /* 滚动任务 8：地图与指南针读数（真实 mapSeen / HUD DOM） */
      mapInfo: () => {
        const m = self.mapModel();
        const key = coordKey(m.cx, m.cz);
        const overlay = document.querySelector('#map-markers');
        return {
          explored: m.explored, cx: m.cx, cz: m.cz,
          px: +m.px.toFixed(2), pz: +m.pz.toFixed(2),
          current: !!m.seen[key], currentLen: m.seen[key] ? m.seen[key].length : 0,
          keys: Object.keys(m.seen),
          panelOpen: self.openUI === 'map',
          canvas: !!document.querySelector('#map-canvas'),
          /* R3：已发现地点的标记（真实坐标 → 5×5 网格像素），未探索/未发现都不出现 */
          markers: (m.landmarks || []).map(k => ({
            id: k.id, name: k.name, type: k.type, x: k.x, z: k.z, chunk: k.chunk, mx: k.mx, my: k.my
          })),
          markerCount: (m.landmarks || []).length,
          markerDom: overlay ? overlay.childElementCount : null,
          markerText: overlay ? overlay.textContent.replace(/\s+/g, ' ').trim() : ''
        };
      },
      compassInfo: () => {
        const s = self.compassState();
        const hud = document.querySelector('#compass-hud');
        const needle = document.querySelector('#compass-needle');
        return Object.assign({}, s, {
          visible: !!hud && !hud.classList.contains('hidden'),
          rot: needle ? needle.style.transform : null,
          text: document.querySelector('#compass-dist') ? document.querySelector('#compass-dist').textContent : null
        });
      },
      recordMapChunk: (cx, cz) => !!self.recordMapChunk(cx, cz),
      slimeInfo: () => (self.mobs ? self.mobs.list.filter(m => m.type === 'slime').map(m => ({
        size: m.slimeSize, hp: m.hp, maxHp: m.maxHp, damage: m.damage,
        w: +m.width.toFixed(3), h: +m.height.toFixed(3),
        x: +m.pos.x.toFixed(2), y: +m.pos.y.toFixed(2), z: +m.pos.z.toFixed(2),
        meshScale: +m.mesh.scale.x.toFixed(3)
      })) : []),
      animalInfo: () => (self.mobs ? self.mobs.list.filter(m => m.def.breedable)
        .map(m => ({
          t: m.type, baby: !!m.isBaby, growT: +m.growT.toFixed(1), breedCd: +m.breedCd.toFixed(1),
          w: +m.width.toFixed(3), h: +m.height.toFixed(3)
        })) : []),
      isAnimalFood: (item) => !!(self.mobs && self.mobs.isAnimalFood(item)),
      /* 剪刀与剪羊毛：状态读数 + 再生倒计时（走真实 MobManager） */
      sheepInfo: () => (self.mobs ? self.mobs.list.filter(m => m.type === 'sheep')
        .map(m => ({ sheared: !!m.sheared, regenT: +m.regenT.toFixed(2), hp: m.hp })) : []),
      setSheepRegrow: (t) => {
        const s = self.mobs ? self.mobs.list.find(m => m.type === 'sheep' && m.sheared) : null;
        if (!s) return false;
        s.regenT = t;
        return true;
      },
      heldDur: () => {
        const h = self.inventory.held();
        return h ? (h.dur === undefined ? null : h.dur) : null;
      },
      /* T1 护甲读数 / 真实装备路径 / 显式伤害类型（e2e 仍必须让真实生物咬人） */
      armorInfo: () => ({
        points: self.inventory.armorPoints(),
        pieces: self.inventory.armor.map((s, slot) => s ? {
          slot, item: s.item, dur: s.dur,
          maxDur: getItem(s.item) ? getItem(s.item).durability : null
        } : null),
        lastHurt: self.controller.lastHurt ? Object.assign({}, self.controller.lastHurt) : null,
        hud: document.querySelector('#armor-value') ? document.querySelector('#armor-value').textContent : null
      }),
      equipArmor: (index) => self.inventory.equipFrom(index),
      unequipArmor: (slot) => self.inventory.unequip(slot),
      hurtPlayer: (amount, type = 'generic', reason = '测试伤害', src = null) => {
        self.controller.invulnerable = 0;
        return self.controller.hurt(amount, reason, type, src);
      },
      /* T5 TNT：点燃走生产入口；读数供验收核对引信/爆炸次数/坑洞 */
      igniteTnt: (x, y, z) => !!self.igniteTnt(x, y, z),
      tntInfo: () => ({
        active: self.tnt ? Array.from(self.tnt.values()).map(e => ({
          x: e.x, y: e.y, z: e.z, fuse: Math.round(e.fuse * 100) / 100, flashOn: !!e.flashOn
        })) : [],
        blasts: self.tntBlasts || 0,
        last: self._lastTntBlast || null
      }),
      /* P2 HUD 只读诊断：窄窗口遮挡几何、折叠态、首夜提示。机器只判「不相交」，不判好不好看。 */
      hudInfo: () => {
        const bar = document.querySelector('#hint-bar');
        const slot = document.querySelectorAll('#hotbar .slot')[8];
        const night = document.querySelector('#night-hint');
        const sug = document.querySelector('#quest-suggestions');
        const r = (n) => {
          if (!n) return null;
          const b = n.getBoundingClientRect();
          return { left: b.left, top: b.top, width: b.width, height: b.height };
        };
        const a = r(bar), b = r(slot);
        return {
          hintBar: bar ? bar.textContent : '',
          hintRect: a, slot9Rect: b, overlap: rectsOverlap(a, b),
          hintBottom: bar ? getComputedStyle(bar).bottom : null,
          hintMaxWidth: bar ? getComputedStyle(bar).maxWidth : null,
          windowWidth: window.innerWidth, windowHeight: window.innerHeight,
          dismissed: self.quests ? self.quests.dismissed : null,
          suggestionsCollapsed: sug ? sug.dataset.collapsed === '1' : null,
          nightPhase: night ? night.dataset.phase || null : null,
          nightText: night ? night.textContent : '',
          nightShown: night ? night.classList.contains('show') : false,
          nightLog: self.ui && self.ui._nightHintLog ? self.ui._nightHintLog.slice() : [],
          time: self.time
        };
      },
      /* T4 音乐/环境声只读诊断：trackId / activeMusicCount / activeAmbient / section */
      musicInfo: () => (self.sfx ? self.sfx.musicInfo() : null),
      setMusicScene: (id) => (self.sfx ? self.sfx.setMusicScene(id) : false),
      audioScene: () => (self.world && self.controller ? self.audioSceneState() : null),
      trackInfo: (id) => (self.sfx ? self.sfx.trackInfo(id) : null),
      /* 阶段 4：外部曲目登记表（许可/来源/字节/加载状态）与「只允许合成曲」的兜底开关 */
      fileTracksInfo: () => (self.sfx ? self.sfx.fileTracksInfo() : null),
      setFileTracksEnabled: (on) => (self.sfx ? self.sfx.setFileTracksEnabled(on) : false),
      /* B：声音可听性只读诊断。audioVolumes 用来钉「设置里的数字真的下发到了 Sfx」，
         audioEnergy 走 master 之后的静音分析旁路，拿到的是真实输出能量而不是字段值 */
      audioVolumes: () => ({
        settings: { master: self.settings.volumeMaster, sfx: self.settings.volumeSfx, music: self.settings.volumeMusic },
        delivered: self.sfx ? { master: self.sfx._vols.master, sfx: self.sfx._vols.sfx, music: self.sfx._vols.music } : null,
        ready: !!(self.sfx && self.sfx.ready),
        ctxState: (self.sfx && self.sfx.ctx) ? self.sfx.ctx.state : 'none',
        musicSwitch: self.settings.music === true
      }),
      sfxStats: () => (self.sfx ? self.sfx.stats() : null),
      /* 阶段 6：随包 CC0 短音效的加载状态（文件 / 合成兜底要能对账） */
      sfxFilesInfo: () => (self.sfx ? self.sfx.sfxFilesInfo() : null),
      /* 2026-11-08：B.5 出现过整程「静音/播放/暂停三态 rms 全等于 0.000000，可 ctx.state 仍是 running」
         的偶发红（artifacts/run-3b-*.txt 里有 3 条）。只看 rms 分不出三种情况：真静音、
         音频图根本没被拉起来（时钟不推进）、采集线路接错。所以在**测试读数**上再补三样只读证据：
         音频时钟、旁路挂在哪条总线、取样帧数。只加字段，产品链路与听感一字不动。 */
      /* 本轮 A1：分总线能量（master/sfx/music/ambient 各一条 0 增益旁路分析）。
         验收要证明「关掉音乐后环境床仍在出声」时，必须读 ambient 总线自己的信号，
         不能用 master、也不能只看 ambientCount 这个计数。 */
      audioBusEnergy: () => (self.sfx && self.sfx.busEnergy ? self.sfx.busEnergy() : null),
      audioEnergy: () => {
        if (!self.sfx) return null;
        const e = self.sfx.energyInfo();
        const ctx = self.sfx.ctx;
        if (ctx) {
          e.currentTime = +ctx.currentTime.toFixed(6);
          e.sampleRate = ctx.sampleRate;
          e.baseLatency = typeof ctx.baseLatency === 'number' ? +ctx.baseLatency.toFixed(6) : null;
          e.outputLatency = typeof ctx.outputLatency === 'number' ? +ctx.outputLatency.toFixed(6) : null;
        }
        e.masterGain = self.sfx.master ? +self.sfx.master.gain.value.toFixed(6) : null;
        e.tapCreated = !!self.sfx._tap;
        e.tapChain = self.sfx._tap ? 'master → AnalyserNode(fftSize) → gain 0 → destination' : null;
        e.fftSize = self.sfx._tap ? self.sfx._tap.a.fftSize : null;
        return e;
      },
      audioCues: () => Object.assign({}, self.audioCues || {}),
      /* T3 成就 / 反馈读数（事件驱动；toasts 用来钉「重复事件不重复弹」） */
      achievementsInfo: () => ({
        count: self.achievements ? self.achievements.count() : 0,
        ids: self.achievements ? self.achievements.serialize() : [],
        toasts: self.achievementToasts || 0,
        achToast: document.querySelector('#ach-toast') ? document.querySelector('#ach-toast').classList.contains('show') : null,
        toastText: document.querySelector('#ach-toast') ? document.querySelector('#ach-toast').textContent : '',
        list: self.achievements ? self.achievements.list() : [],
        /* R3：额外成就（探索者）单独读数，不参与「成就 x/8」计数 */
        extras: self.achievements ? self.achievements.extras() : [],
        extraCount: self.achievements ? self.achievements.extraCount() : 0,
        explorer: !!(self.achievements && self.achievements.has('explorer'))
      }),
      resetAchievements: () => {
        self.achievements = new Achievements();
        self.achievementToasts = 0;
        return true;
      },
      /* Q1：目标链只读诊断。hintLog 用来钉「同一提示只出现一次」；
         suggestions 读的是独立 class，绝不混进 #recipe-book .recipe-item。 */
      questsInfo: () => {
        const info = self.quests ? self.quests.info() : null;
        const bar = document.querySelector('#hint-bar');
        const box = document.querySelector('#quest-suggestions');
        return Object.assign({}, info || { current: null, completed: [], shown: [], hintLog: [], dismissed: false }, {
          total: QUESTS.length,
          ids: QUESTS.map(q => q.id),
          hintBar: bar ? bar.textContent.replace(/\s+/g, ' ').trim() : '',
          hintBarHtml: bar ? bar.innerHTML : '',
          hasClose: !!(bar && bar.querySelector('.quest-close')),
          hasReopen: !!(bar && bar.querySelector('.quest-reopen')),
          suggestions: box ? [...box.querySelectorAll('.quest-suggestion')].map(n => ({
            text: n.textContent.replace(/\s+/g, ' ').trim(),
            current: n.classList.contains('current'),
            ready: !n.classList.contains('not-ready')
          })) : [],
          recipeItems: document.querySelectorAll('#recipe-book .recipe-item').length,
          hintToasts: self.ui ? (self.ui.questHintToasts || 0) : 0
        });
      },
      questsRefresh: (silent = false) => self.refreshQuests(silent),
      /* 仅验收用：把目标链重置为「空手」起点（不碰成就、不碰存档文件） */
      questsReset: () => {
        self.quests = new QuestChain();
        if (self.ui) self.ui.questHintToasts = 0;
        return self.refreshQuests(false);
      },
      /* P0：攻击恢复读数，供 e2e 区分「连点 / 等恢复 / 空挥」。 */
      attackInfo: () => {
        const it = self.interaction;
        const total = it ? it.attackTotal : 0.25;
        const remain = it ? it.attackTimer : 0;
        const bar = document.querySelector('#attack-charge');
        return {
          charge: total > 0 ? Math.max(0, Math.min(1, 1 - remain / total)) : 1,
          remain: +remain.toFixed(3), total,
          barHidden: bar ? bar.classList.contains('hidden') : null,
          barWidth: bar && bar.firstElementChild ? bar.firstElementChild.style.width : null
        };
      },
      feedbackInfo: () => Object.assign({}, self.feedback, {
        blockOverlay: document.querySelector('#block-overlay') ? document.querySelector('#block-overlay').classList.contains('flash') : null,
        hitMarker: document.querySelector('#hit-marker') ? document.querySelector('#hit-marker').classList.contains('show') : null,
        damageOverlay: document.querySelector('#damage-overlay') ? document.querySelector('#damage-overlay').classList.contains('flash') : null,
        armorFlash: document.querySelector('#armor-bar') ? document.querySelector('#armor-bar').classList.contains('break') : null,
        achToast: document.querySelector('#ach-toast') ? document.querySelector('#ach-toast').classList.contains('show') : null
      }),
      /* V3：第一人称动作与挖掘状态（真实 HeldItemView / Interaction 读数） */
      heldInfo: () => (self.heldView ? {
        item: self.heldView.itemId,
        swing: +self.heldView.swing.toFixed(3),
        kind: self.heldView.swingKind || null,
        equip: +self.heldView.equip.toFixed(3),
        walkPhase: +self.heldView.walkPhase.toFixed(3),
        walkWeight: +self.heldView.walkWeight.toFixed(3),
        blockWeight: +self.heldView.blockWeight.toFixed(3),
        bowDraw: +self.heldView.bowDraw.toFixed(3),
        bowNocked: !!self.heldView.bowNocked,
        bowStringX: self.heldView.bowString ? +self.heldView.bowString.geometry.attributes.position.getX(1).toFixed(3) : null,
        bowArrow: !!(self.heldView.bowArrow && self.heldView.bowArrow.visible),
        shieldKick: +self.heldView.shieldKick.toFixed(3),
        /* 本轮 C：这一件物品**自己声明的**基准位姿。工具与方块的基准点不同（工具更靠中间），
           验收「静置无漂移」必须跟这一项比，不能跨物品比。 */
        base: self.heldView.basePos ? self.heldView.basePos.toArray().map(v => +v.toFixed(3)) : null,
        pos: self.heldView.group.position.toArray().map(v => +v.toFixed(3)),
        rot: [self.heldView.group.rotation.x, self.heldView.group.rotation.y, self.heldView.group.rotation.z].map(v => +v.toFixed(3)),
        meshType: self.heldView.mesh ? (self.heldView.mesh.userData.isShield ? 'shield' : (self.heldView.mesh.userData.isBow ? 'bow' : (self.heldView.mesh.type || 'mesh'))) : null
      } : null),
      miningInfo: () => ({
        hit: self.interaction && self.interaction.mining ? self.interaction.mining.hit : null,
        progress: self.interaction && self.interaction.mining ? +self.interaction.mining.progress.toFixed(3) : 0,
        mineSwingT: self.interaction ? +self.interaction.mineSwingT.toFixed(3) : 0,
        crackVisible: !!(self.view && self.view.crackMesh && self.view.crackMesh.visible),
        crackOffset: self.view && self.view.atlas ? +self.view.atlas.crackTexture.offset.x.toFixed(3) : null,
        particles: self.particles ? self.particles.count : null
      }),
      /* T2 盾牌读数：held/dur/blocking/blocks/lastBlock/model（model='shield' 证明是第一人称独立模型） */
      shieldInfo: () => {
        const held = self.inventory.held();
        const it = held ? getItem(held.item) : null;
        return {
          held: held ? held.item : null,
          dur: held && held.dur !== undefined ? held.dur : null,
          blocking: !!self.controller.blocking,
          blocks: self.shieldBlocks || 0,
          lastBlock: self.controller.lastBlock ? Object.assign({}, self.controller.lastBlock) : null,
          model: self.heldView && self.heldView.mesh && self.heldView.mesh.userData && self.heldView.mesh.userData.isShield
            ? 'shield' : null,
          lastHurt: self.controller.lastHurt ? Object.assign({}, self.controller.lastHurt) : null
        };
      },
      /* 天气：设置 / 读数 / 手动推进（都走真实的 Weather 状态机与渲染层） */
      setWeather: (type, seconds = 0) => {
        if (!self.weather) return null;
        self.weather.set(type, seconds);
        return self.weather.type;
      },
      tickWeather: (dt = 1, times = 1) => {
        if (!self.weather) return null;
        for (let i = 0; i < times; i++) self.weather.update(dt);
        return self.weather.type;
      },
      weatherInfo: () => (self.weather ? {
        type: self.weather.type,
        storm: !!self.weather.isStorm,
        label: self.weather.label,
        left: +self.weather.timeLeft.toFixed(2),
        intensity: +self.weather.intensity.toFixed(3),
        wet: !!self.weather.isWet,
        shelter: self.shelteredAbove(),
        fx: self.weatherFX ? self.weatherFX.info() : null,
        uCloud: self.view && self.view.sky ? +self.view.sky.uniforms.uCloud.value.toFixed(3) : null,
        uDay: self.view ? +self.view.uniforms.uDay.value.toFixed(4) : null,
        fogNear: self.view ? +self.view.uniforms.uFogNear.value.toFixed(1) : null,
        fogFar: self.view ? +self.view.uniforms.uFogFar.value.toFixed(1) : null,
        saved: self.buildSaveObject().weather
      } : null),
      /* 滚动任务 7：雷暴开关 / 定点落雷 / 只读读数 */
      setStorm: (on) => (self.weather ? self.setStorm(!!on) : false),
      strikeLightningAt: (x, z) => self.strikeLightningAt(x, z),
      thunderInfo: () => ({
        storm: !!(self.weather && self.weather.isStorm),
        strikes: self.lightning ? self.lightning.strikes : 0,
        flashes: self.lightning ? self.lightning.flashes : 0,
        timer: self.lightning ? +self.lightning.timer.toFixed(2) : null,
        flashT: self.lightning ? +self.lightning.flashT.toFixed(3) : 0,
        last: self.lightning ? self.lightning.last : null,
        bolt: self.lightningFX ? self.lightningFX.info() : null,
        overlay: document.querySelector('#lightning-flash')
          ? document.querySelector('#lightning-flash').classList.contains('flash') : null,
        sfx: SOUND_NAMES.indexOf('thunder') >= 0
      }),
      /* T3 弓：直接射出 / 读取箭实体 / 手动推进箭的物理 */
      shoot: (power = 1) => !!self.interaction.fireBow(power),
      bowInfo: () => ({
        charge: self.interaction.bowCharge, last: self.interaction.bowLast,
        arrows: self.inventory.countOf('arrow'), held: self.inventory.heldItem()
      }),
      arrowEntities: () => self.mobs.arrows.map(a => ({
        x: a.x, y: a.y, z: a.z, vx: a.vx, vy: a.vy, vz: a.vz,
        stuck: !!a.stuck, fromMob: !!a.fromMob, damage: a.damage, life: a.life
      })),
      stepArrows: (dt = 0.02, times = 1) => { for (let i = 0; i < times; i++) self.mobs.updateArrows(dt); return self.mobs.arrows.length; },
      openUI: (name) => name === 'inventory' ? self.openInventory() : self.openCrafting(3),
      closeUI: () => self.closeUI(),
      craftSet: (cells) => {
        const size = self.activeCraft.size;
        self.activeCraft.clear();
        cells.forEach((it, i) => { if (it) self.activeCraft.set(i, { item: it, count: 1 }); });
        self.ui.refreshUI();
        return self.activeCraft.result();
      },
      craftNow: (n = 1) => {
        const made = self.activeCraft.craft(n);
        for (const m of made) {
          self.inventory.add(m.item, m.count);
          self.onItemCrafted(m.item, m.count);
        }
        self.stats.crafted += made.length;
        self.ui.refreshUI();
        return made;
      },
      furnace: (x, y, z) => {
        const f = self.world.getFurnace(x, y, z);
        return { input: f.input, fuel: f.fuel, output: f.output, lit: f.lit, progress: f.progress };
      },
      furnacePut: (slot, item, count = 1) => {
        const f = self.activeFurnace || self.world.furnaces.values().next().value;
        if (!f) return null;
        f[slot] = { item, count };
        return true;
      },
      tick: (dt = 0.016, times = 1) => { for (let i = 0; i < times; i++) self.loop(performance.now() + i * dt * 1000); },
      advanceTime: (sec) => { self.time = (self.time + sec / self.settings.dayLengthSeconds) % 1; },
      save: () => self.save('manual'),
      screenshot: () => self.view ? self.view.screenshot() : null,
      /* 就绪等待：默认只看 genQueue + dirtyMesh（与既有 500+ 条断言用的同一判据）。
         opts.light=true 时额外等 dirtyLight 排空 —— 深地布局把每块区块的补光量翻倍，
         需要「光照也落地」的场景（例如跨区块光池读数）应当显式等，而不是补一条固定 sleep。 */
      waitChunks: (n = 1, opts = {}) => new Promise(res => {
        const check = () => {
          const ready = self.world.genQueue.length === 0 && self.world.dirtyMesh.size === 0 &&
            (!opts.light || self.world.dirtyLight.size === 0);
          if (ready) res(true); else setTimeout(check, 60);
        };
        setTimeout(check, 120);
      })
    };
  }
}
