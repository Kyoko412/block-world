/*
 * 阶段 6 取证：家畜的**同像素**明暗响应（消除定位误差）。
 *   cd app && npx electron tests/probe-animal-ratio.mjs
 *
 * 为什么换成这种做法：按投影坐标开窗口总会掺进背景（草地/天空），
 * 而三张图的机位、朝向、动物位置都由同一个函数重置，**同一像素对应同一个世界点**。
 * 于是「暗处 ÷ 白天」「火把 ÷ 暗处」逐像素比，只有真正被光照改变的地方会偏离 1：
 *   ① 动物身上的像素：暗处明显变暗、火把明显变亮；
 *   ② 天空/远景像素：几乎不变（不受方块光照影响）。
 * 再按「变化幅度」聚类，就能把动物从背景里切出来，同时给出它们的真实亮度响应。
 */
import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', '..', 'artifacts', 'visual', 'animals-stage6');

function load(name) {
  const f = path.join(DIR, name + '.png');
  if (!fs.existsSync(f)) return null;
  const img = nativeImage.createFromPath(f);
  const { width: W, height: H } = img.getSize();
  return { W, H, bmp: img.toBitmap() };
}
const lumAt = (p, x, y) => {
  const i = (y * p.W + x) * 4;
  return (0.2126 * p.bmp[i + 2] + 0.7152 * p.bmp[i + 1] + 0.0722 * p.bmp[i]) / 255;
};
const rgbAt = (p, x, y) => {
  const i = (y * p.W + x) * 4;
  return [p.bmp[i + 2], p.bmp[i + 1], p.bmp[i]];
};

app.whenReady().then(() => {
  const day = load('p-animals-day'), dark = load('p-animals-dark'), torch = load('p-animals-torch');
  if (!day || !dark || !torch) { console.log('缺图'); app.exit(1); return; }
  if (day.W !== dark.W || day.W !== torch.W || day.H !== dark.H || day.H !== torch.H) {
    console.log('三张尺寸不一致，无法逐像素比较'); app.exit(1); return;
  }
  const W = day.W, H = day.H;

  /* 只看中间画面区域，避开 HUD 与边角 */
  const x0 = Math.floor(W * 0.10), x1 = Math.floor(W * 0.90);
  const y0 = Math.floor(H * 0.20), y1 = Math.floor(H * 0.88);

  /* 逐像素：暗/白 与 火/暗 */
  const rows = [];
  let changed = 0, total = 0;
  const darkSum = { n: 0, lum: 0 }, torchSum = { n: 0, lum: 0 }, daySum = { n: 0, lum: 0 };
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const Ld = lumAt(day, x, y), Lk = lumAt(dark, x, y), Lt = lumAt(torch, x, y);
      total++;
      /* 「被光照改变」的定义：暗处比白天暗 15% 以上，且火把比暗处亮 15% 以上 */
      const darkRatio = Lk / Math.max(1e-4, Ld);
      const torchRatio = Lt / Math.max(1e-4, Lk);
      if (Math.abs(darkRatio - 1) > 0.15 && Math.abs(torchRatio - 1) > 0.15) {
        changed++;
        daySum.n++; daySum.lum += Ld;
        darkSum.n++; darkSum.lum += Lk;
        torchSum.n++; torchSum.lum += Lt;
        if (rows.length < 6) rows.push({ x, y, rgb: rgbAt(day, x, y), darkRatio: +darkRatio.toFixed(3), torchRatio: +torchRatio.toFixed(3) });
      }
    }
  }

  /* 背景对照样本（画面顶部角落 = 天空/远景） */
  let bgDay = 0, bgDark = 0, bgN = 0;
  for (let y = Math.floor(H * 0.12); y < Math.floor(H * 0.2); y += 2) {
    for (let x = Math.floor(W * 0.05); x < Math.floor(W * 0.15); x += 2) {
      bgDay += lumAt(day, x, y); bgDark += lumAt(dark, x, y); bgN++;
    }
  }

  const out = {
    image: { W, H }, scanned: total,
    litPixels: changed, litShare: +(changed / Math.max(1, total) * 100).toFixed(2),
    animals: {
      dayMean: +(daySum.lum / Math.max(1, daySum.n)).toFixed(4),
      darkMean: +(darkSum.lum / Math.max(1, darkSum.n)).toFixed(4),
      torchMean: +(torchSum.lum / Math.max(1, torchSum.n)).toFixed(4),
      darkOverDay: +((darkSum.lum / Math.max(1, darkSum.n)) / Math.max(1e-6, daySum.lum / Math.max(1, daySum.n))).toFixed(3),
      torchOverDark: +((torchSum.lum / Math.max(1, torchSum.n)) / Math.max(1e-6, darkSum.lum / Math.max(1, darkSum.n))).toFixed(3)
    },
    background: {
      dayMean: +(bgDay / Math.max(1, bgN)).toFixed(4),
      darkMean: +(bgDark / Math.max(1, bgN)).toFixed(4),
      ratio: +((bgDark / Math.max(1, bgN)) / Math.max(1e-6, bgDay / Math.max(1, bgN))).toFixed(3)
    },
    samples: rows
  };
  out.relation = {
    animalsGetDark: out.animals.darkOverDay < 0.9,
    animalsGetTorchLit: out.animals.torchOverDark > 1.1,
    backgroundStable: Math.abs(out.background.ratio - 1) < 0.25,
    litRegionFound: changed > total * 0.002
  };

  console.log('=== 被光照改变的像素 ===');
  console.log(' 占比=' + out.litShare + '%  (' + changed + '/' + total + ')');
  console.log('=== 这些像素的亮度 ===');
  console.log(' 白天=' + out.animals.dayMean + ' 暗处=' + out.animals.darkMean + ' 火把=' + out.animals.torchMean);
  console.log(' 暗/白=' + out.animals.darkOverDay + ' 火/暗=' + out.animals.torchOverDark);
  console.log('=== 背景对照 ===');
  console.log(' 白天=' + out.background.dayMean + ' 暗处=' + out.background.darkMean + ' 比值=' + out.background.ratio);
  console.log('=== 关系 ===');
  console.log(JSON.stringify(out.relation));
  console.log('样例=' + JSON.stringify(out.samples));
  fs.writeFileSync(path.join(DIR, 'ratio-stats.json'), JSON.stringify(out, null, 2));
  console.log('→ ' + path.join(DIR, 'ratio-stats.json'));
  app.exit(0);
});
