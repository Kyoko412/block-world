/*
 * 阶段 6 取证：对已拍好的水面截图做**机读**统计（模型看不了图，就靠数字比 A/B）。
 *   cd app && npx electron tests/probe-water-stats.mjs water-before [water-after ...]
 *
 * 三个指标直接对应任务书里点名的三种毛病：
 *   bandRows    —— 水面区域里「相邻两行平均亮度差 > 0.02」的行数（水平条带）
 *   bandEnergy  —— 这些差值的总和（条带越硬越大）
 *   speckles    —— 比周围 8 邻域亮 > 0.10 的孤立像素数（重复亮点）
 *   flatness    —— 水面区域内亮度的标准差（越小越像一块死板的色块）
 * 只做同机位相对比较，不设绝对审美阈值。
 */
import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(__dirname, '..', '..', 'artifacts', 'visual');
const labels = process.argv.slice(2).filter(a => /^water-/.test(a));
const names = ['w-bank', 'w-surface', 'w-under'];

const lum = (b, g, r) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function stats(img) {
  const { width: W, height: H } = img.getSize();
  const bmp = img.toBitmap();          // BGRA
  /* 只统计中间水面区域：避开天空与 HUD（上 25%、下 15%、左右各 12%） */
  const x0 = Math.floor(W * 0.12), x1 = Math.floor(W * 0.88);
  const y0 = Math.floor(H * 0.28), y1 = Math.floor(H * 0.85);
  const rows = [];
  for (let y = y0; y < y1; y += 2) {
    let sum = 0, n = 0;
    for (let x = x0; x < x1; x += 2) {
      const i = (y * W + x) * 4;
      sum += lum(bmp[i], bmp[i + 1], bmp[i + 2]); n++;
    }
    rows.push(n ? sum / n : 0);
  }
  let bandRows = 0, bandEnergy = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i] - rows[i - 1]);
    if (d > 0.02) { bandRows++; bandEnergy += d; }
  }
  let speckles = 0, n2 = 0, sum = 0, sum2 = 0;
  for (let y = y0 + 2; y < y1 - 2; y += 2) {
    for (let x = x0 + 2; x < x1 - 2; x += 2) {
      const i = (y * W + x) * 4;
      const L = lum(bmp[i], bmp[i + 1], bmp[i + 2]);
      sum += L; sum2 += L * L; n2++;
      let m = 0;
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2]]) {
        const j = ((y + dy) * W + (x + dx)) * 4;
        m += lum(bmp[j], bmp[j + 1], bmp[j + 2]);
      }
      m /= 8;
      if (L - m > 0.10) speckles++;
    }
  }
  const mean = n2 ? sum / n2 : 0;
  return {
    size: W + 'x' + H, bandRows, bandEnergy: +bandEnergy.toFixed(3),
    speckles, speckleRate: +(speckles / Math.max(1, n2) * 1000).toFixed(2),
    mean: +mean.toFixed(4), flatness: +Math.sqrt(Math.max(0, n2 ? sum2 / n2 - mean * mean : 0)).toFixed(4)
  };
}

app.whenReady().then(() => {
  const all = {};
  for (const lab of labels) {
    all[lab] = {};
    for (const n of names) {
      const f = path.join(ART, lab, n + '.png');
      if (!fs.existsSync(f)) { all[lab][n] = { missing: true }; continue; }
      all[lab][n] = stats(nativeImage.createFromPath(f));
      console.log(lab + ' / ' + n + '  ' + JSON.stringify(all[lab][n]));
    }
  }
  fs.writeFileSync(path.join(ART, 'water-stats.json'), JSON.stringify(all, null, 2));
  console.log('→ artifacts/visual/water-stats.json');
  app.exit(0);
});
