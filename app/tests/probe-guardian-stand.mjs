/*
 * 守卫站位探针（Node，无 DOM）：用真实的前哨布局 + 真实 VoxelWorld 验证
 * 「守卫不在屋顶/树冠/石座上，且玩家能走到它旁边开打」。
 *
 * 复现的缺陷：game.js 用 topSolidY(站点中心)+1 生成守卫，而荒废前哨中心正好压在
 * 5×5 木板屋顶上 → 守卫站在 y=56、脚下 y=55 是木板屋顶（审计 31）。
 *
 *   node tests/probe-guardian-stand.mjs [--json out.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { VoxelWorld } from '../renderer/js/world/world.js';
import { AIR, B, BLOCKS } from '../renderer/js/core/blocks.js';
import { landmarkLayout, LANDMARK_TYPES } from '../renderer/js/core/landmarks.js';
import {
  chooseGuardianStand, guardianStandColumn, GUARDIAN_STAND_HEADROOM,
  isArtificialStand, GUARDIAN_WARD_OFFSETS
} from '../renderer/js/core/guardian.js';

/* 造一块平地，再按 buildLandmark 的顺序铺 right 类型的 layout（与产品同序） */
function buildSite(type, variant) {
  const w = new VoxelWorld(4242);
  const sx = 8, sz = 8, baseY = 40;
  for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) w.ensureChunk(cx, cz);
  for (let dz = -10; dz <= 10; dz++) for (let dx = -10; dx <= 10; dx++) {
    for (let y = baseY + 1; y <= baseY + 8; y++) w.setBlock(sx + dx, y, sz + dz, AIR);
    w.setBlock(sx + dx, baseY, sz + dz, B.GRASS);
  }
  const layout = landmarkLayout(type, variant);
  for (const c of layout.cells) w.setBlock(sx + c.x, baseY + c.y, sz + c.z, c.id, c.meta);
  /* 石座：与 ensureGuardianPedestals 同一套偏移（黑曜石底座 + 两个空格） */
  for (const [dx, dz] of GUARDIAN_WARD_OFFSETS) {
    const px = sx + dx, pz = sz + dz;
    const by = w.topSolidY(px, pz);
    w.setBlock(px, by, pz, B.OBSIDIAN);
    w.setBlock(px, by + 1, pz, AIR);
    w.setBlock(px, by + 2, pz, AIR);
  }
  return { w, site: { id: 'probe:' + type + variant, type, variant, x: sx, y: baseY, z: sz } };
}

/* 旧实现：中心列最高实心格 + 1 */
function oldStand(w, site) {
  const gy = w.topSolidY(Math.floor(site.x), Math.floor(site.z));
  return { x: site.x, y: gy + 1, z: site.z, gy, ground: w.getBlock(site.x, gy, site.z) };
}

const nameOf = (id) => (BLOCKS[id] ? BLOCKS[id].name : ('#' + id));

const cases = [];
for (const type of ['outpost', 'tower', 'ruin']) {
  for (let variant = 0; variant < 3; variant++) {
    const { w, site } = buildSite(type, variant);
    const old = oldStand(w, site);
    const now = chooseGuardianStand(w, site);
    const col = guardianStandColumn(w, now.x, now.z, site.y);
    /* 玩家站在守卫旁边 3 格处：要能站得住、且与守卫之间没有墙 */
    const dx = Math.sign(now.x - site.x) || 1;
    const px = now.x + dx, pz = now.z;
    const pcol = guardianStandColumn(w, px, pz, site.y);
    cases.push({
      type, variant,
      site: { x: site.x, y: site.y, z: site.z },
      old: { x: old.x, y: old.y, z: old.z, ground: nameOf(old.ground), artificial: isArtificialStand(old.ground) },
      stand: {
        x: now.x, y: now.y, z: now.z, ring: now.ring, fallback: !!now.fallback,
        ground: nameOf(now.ground), artificial: isArtificialStand(now.ground), ok: col.ok
      },
      ringDist: Math.max(Math.abs(now.x - site.x), Math.abs(now.z - site.z)),
      playerCol: { x: px, z: pz, ok: pcol.ok, ground: nameOf(w.getBlock(px, pcol.gy === undefined ? now.y - 1 : pcol.gy, pz)) },
      headroom: (() => {
        let n = 0;
        for (let dy = 1; dy <= GUARDIAN_STAND_HEADROOM; dy++) {
          if (w.isSolidAt(now.x, now.y - 1 + dy, now.z)) break;
          n++;
        }
        return n;
      })()
    });
  }
}

const failures = [];
for (const c of cases) {
  const tag = c.type + '#v' + c.variant;
  if (c.stand.fallback) failures.push(tag + ' 退回了兜底站位（没找到合规地面）');
  if (c.stand.artificial) failures.push(tag + ' 站在人造方块上：' + c.stand.ground);
  if (!c.stand.ok) failures.push(tag + ' 站位不满足地面/净空判据');
  if (c.stand.ring === 0) failures.push(tag + ' 站位没有离开站点中心（ring=0）');
  if (c.headroom < 2) failures.push(tag + ' 头顶净空只有 ' + c.headroom + ' 格，守卫（高 2.35）站不进去');
  if (!c.playerCol.ok) failures.push(tag + ' 玩家在 (' + c.playerCol.x + ',' + c.playerCol.z + ') 站不住，走不过去');
  /* 旧行为对照：如果旧站位是人造方块（屋顶），必须已经不再被选中 */
  if (c.old.artificial && c.stand.x === c.old.x && c.stand.z === c.old.z) failures.push(tag + ' 站位与旧的屋顶站位重合');
}

const out = { at: new Date().toISOString(), cases, failures };
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx > 0) fs.writeFileSync(path.resolve(process.argv[jsonIdx + 1]), JSON.stringify(out, null, 2));

console.log('守卫站位探针：' + cases.length + ' 个地点（前哨/哨塔/废墟 × 3 变体）');
for (const c of cases) {
  console.log('  ' + (c.type + '#v' + c.variant).padEnd(11) +
    ' 旧 (' + c.old.x + ',' + c.old.y + ',' + c.old.z + ') 地面=' + c.old.ground + (c.old.artificial ? ' ← 屋顶/人造' : '') +
    '  →  新 (' + c.stand.x + ',' + c.stand.y + ',' + c.stand.z + ') 环' + c.stand.ring +
    ' 地面=' + c.stand.ground + ' 净空=' + c.headroom + ' 玩家可站=' + (c.playerCol.ok ? '是' : '否'));
}
if (failures.length) {
  console.log('\n失败 ' + failures.length + ' 项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('\n全部地点都选中自然地面 + 足够净空，旧的屋顶站位不再被使用。');
}
