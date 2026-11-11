/*
 * 内容盘点：把项目里"真实存在"的内容导出成机器可读快照，供缺口对照与后续排期使用。
 *   node app/tools/content-audit.mjs
 * 产出：artifacts/content-audit/our-content.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const app = path.join(ROOT, 'app/renderer/js');

const { B, BLOCKS } = await import(pathToFileURL(path.join(app, 'core/blocks.js')).href);
const { ITEMS } = await import(pathToFileURL(path.join(app, 'core/items.js')).href);
const { RECIPES, SMELTING, TAGS } = await import(pathToFileURL(path.join(app, 'core/recipes.js')).href);
const { MOB_TYPES } = await import(pathToFileURL(path.join(app, 'world/mobs.js')).href);
const { BIOME, BIOME_NAMES } = await import(pathToFileURL(path.join(app, 'world/terrain.js')).href);

const blockList = Object.entries(BLOCKS).map(([id, def]) => ({
  id: Number(id), key: Object.keys(B).find(k => B[k] === Number(id)) || null,
  name: def.name, shape: def.shape || (def.plant ? 'plant' : def.liquid ? 'liquid' : 'cube'),
  solid: def.solid !== false, opaque: def.opaque !== false,
  light: def.light || 0, tool: def.tool || null, toolLevel: def.toolLevel || 0,
  hardness: def.hardness === undefined ? null : def.hardness, drops: def.drops || null
}));

const itemList = Object.entries(ITEMS).map(([id, def]) => ({
  id, name: def.name,
  kind: def.toolType ? 'tool' : (def.armorSlot !== undefined || def.slot !== undefined) ? 'armor' : def.food ? 'food' : def.blockId !== undefined ? 'block' : 'material',
  toolType: def.toolType || null, toolLevel: def.toolLevel || null,
  armorSlot: def.armorSlot !== undefined ? def.armorSlot : (def.slot !== undefined ? def.slot : null), armorPoints: def.armorPoints || def.defense || null,
  food: def.food || null, stack: def.stack || 64, blockId: def.blockId === undefined ? null : def.blockId
}));

const summary = {
  generatedAt: new Date().toISOString(),
  blocks: { total: blockList.length, byShape: countBy(blockList, b => b.shape), byTool: countBy(blockList, b => b.tool || 'none') },
  items: { total: itemList.length, byKind: countBy(itemList, i => i.kind), tools: itemList.filter(i => i.kind === 'tool').map(i => i.id), armor: itemList.filter(i => i.kind === 'armor').map(i => i.id), food: itemList.filter(i => i.kind === 'food').map(i => i.id) },
  mobs: Object.entries(MOB_TYPES).map(([type, def]) => ({ type, name: def.name || null, hostile: !def.passive, passive: !!def.passive, hp: def.hp || null, breedable: !!def.breedable, tameable: !!def.tameable, explode: !!def.explode, ranged: !!def.ranged, sound: def.sound || null })),
  biomes: Object.values(BIOME).map((value, index) => ({ id: value, name: BIOME_NAMES[index] })),
  recipes: { crafting: RECIPES.length, smelting: Object.keys(SMELTING).length, tags: Object.keys(TAGS).length },
  mechanics: detectMechanics(),
  blockList,
  itemList
};

function countBy(list, pick) {
  const out = {};
  for (const item of list) { const key = pick(item); out[key] = (out[key] || 0) + 1; }
  return out;
}

/* 机制存在性：以真实代码里出现的关键实现为证据，不靠文档描述。 */
function detectMechanics() {
  const read = rel => { try { return fs.readFileSync(path.join(app, rel), 'utf8'); } catch { return ''; } };
  const all = ['player/game.js', 'player/controller.js', 'player/interaction.js', 'world/mobs.js', 'world/terrain.js', 'world/world.js']
    .map(read).join('\n');
  const has = re => re.test(all);
  return {
    survival: has(/hunger/),
    sprintSneak: has(/sprinting/) && has(/sneaking/),
    armor: has(/armorPoints|applyArmorReduction/),
    shield: has(/shieldCanBlock/),
    ranged: has(/firePlayerArrow/),
    melee: has(/attackMelee/),
    mobAI: has(/wantX|lineOfSightToPlayer/),
    breeding: has(/breed/),
    taming: has(/tameWolf/),
    shearing: has(/shear/),
    villagerTrade: has(/VILLAGER_TRADES/),
    farming: has(/farmland/),
    furnace: has(/Furnace|smelt/),
    containers: has(/containers/),
    beds: has(/trySleep/),
    tnt: has(/igniteTnt/),
    doors: has(/toggleDoor/),
    waterPhysics: has(/inWater/),
    drowning: has(/drown/),
    fallDamage: has(/fallStart/),
    weather: has(/Weather/),
    lightning: has(/lightningDamage/),
    caves: has(/caves|cave/i),
    villages: has(/villageLayout/),
    landmarks: has(/landmarkLayout/),
    boss: has(/guardianArmed/),
    quests: has(/QUEST|quest/),
    achievements: has(/achievement/),
    map: has(/buildMapChunk/),
    creativeMode: has(/creative/),
    saveLoad: has(/serializeEdits/),
    /* 明确没有的：这些关键字在代码里一次都不出现 */
    redstone: has(/redstone/i),
    enchanting: has(/enchant/i),
    brewing: has(/brew|potion/i),
    xpLevels: has(/experience|xpLevel/i),
    nether: has(/nether(?!rack)/i),
    endDimension: has(/end_stone|ender_dragon/i),
    boats: has(/boat/i),
    minecarts: has(/minecart/i),
    fishing: has(/fishingRod|fishRod/i),
    portals: has(/portal/i),
    raids: has(/raid/i)
  };
}

const outDir = path.join(ROOT, 'artifacts/content-audit');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'our-content.json'), JSON.stringify(summary, null, 2));
console.log('blocks', summary.blocks.total, 'items', summary.items.total, 'mobs', summary.mobs.length, 'biomes', summary.biomes.length,
  'recipes', summary.recipes.crafting, 'smelting', summary.recipes.smelting);
console.log('→ artifacts/content-audit/our-content.json');
