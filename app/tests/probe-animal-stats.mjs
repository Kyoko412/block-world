/*
 * 阶段 6 取证：家畜截图的机读复核（按**投影坐标**采样，不做颜色分类）。
 *   cd app && npx electron tests/probe-animal-stats.mjs
 *
 * 第一版是靠「颜色像不像猪」去找动物的，结果整片草地被判成猪（pig=93411），
 * 读数完全失真。现在改成：probe-animals.mjs 已经把每只动物的身体中心/头顶投影成
 * 屏幕坐标写进 meta.json，这里只在那些坐标周围取窗口，量的是**这只动物**。
 *
 * 输出三件事：
 *   ① 每只动物在白天/暗处/火把三张里的实测亮度（同机位同目标）；
 *   ② 暗处 / 白天、火把 / 暗处 的亮度比（验证光照真的作用在动物身上）；
 *   ③ 羊头近景窗口的局部对比度与色档（证明不是一块平涂）。
 */
import { app, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, '..', '..', 'artifacts', 'visual', 'animals-stage6');
const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8'));

function load(name) {
  const f = path.join(DIR, name + '.png');
  if (!fs.existsSync(f)) return null;
  const img = nativeImage.createFromPath(f);
  const { width: W, height: H } = img.getSize();
  return { W, H, bmp: img.toBitmap() };
}
const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** 在归一化坐标 (u,v) 周围取 half×half 的窗口，返回亮度统计 */
function windowAt(p, u, v, half = 14) {
  const cx = Math.round(u * p.W), cy = Math.round(v * p.H);
  let n = 0, sum = 0, sum2 = 0, lo = 9, hi = -9;
  const buckets = new Set();
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || y < 0 || x >= p.W || y >= p.H) continue;
      const i = (y * p.W + x) * 4;
      const R = p.bmp[i + 2], G = p.bmp[i + 1], B = p.bmp[i];
      const L = lum(R, G, B);
      sum += L; sum2 += L * L; n++;
      lo = Math.min(lo, L); hi = Math.max(hi, L);
      buckets.add((R >> 4) + ',' + (G >> 4) + ',' + (B >> 4));
    }
  }
  const mean = n ? sum / n : 0;
  return {
    n, mean: +mean.toFixed(4),
    sd: +Math.sqrt(Math.max(0, n ? sum2 / n - mean * mean : 0)).toFixed(4),
    span: +(hi - lo).toFixed(4), buckets: buckets.size
  };
}

/* 每只动物的「预期色」（产品里的底色，用于校准采样点）。
   为什么需要校准：投影坐标是**模型原点**，而动物会站在台面上被物理推到格子中心，
   再加上透视，落点可能差十几像素 —— 直接取窗口会采到兽脚下的草地
   （实测羊的白天读数 0.1326 < 暗处 0.1956，牛头色档只有 1，都是采错点）。
   校准 = 在投影点周围 ±40 像素里找「最接近预期色且连续」的一小簇，取它的质心。 */
const EXPECT = { pig: [233, 154, 154], cow: [74, 59, 50], sheep: [236, 235, 227] };

function locate(p, u, v, expect, radius = 40) {
  const cx = Math.round(u * p.W), cy = Math.round(v * p.H);
  let best = null;
  for (let y = cy - radius; y <= cy + radius; y += 2) {
    for (let x = cx - radius; x <= cx + radius; x += 2) {
      if (x < 2 || y < 2 || x >= p.W - 2 || y >= p.H - 2) continue;
      let score = 0, n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const i = ((y + dy) * p.W + (x + dx)) * 4;
        const R = p.bmp[i + 2], G = p.bmp[i + 1], B = p.bmp[i];
        /* 相对色差：只看色相比例，对明暗不敏感（暗处的猪仍是猪） */
        const sr = (R + 6) / (expect[0] + 6), sg = (G + 6) / (expect[1] + 6), sb = (B + 6) / (expect[2] + 6);
        const spread = Math.max(sr, sg, sb) / Math.max(0.001, Math.min(sr, sg, sb));
        if (spread < 1.35) score++;
        n++;
      }
      if (!best || score > best.score) best = { x, y, score, n, d: Math.hypot(x - cx, y - cy) };
    }
  }
  if (!best) return null;
  if (best.score < best.n * 0.35) return null;
  return { u: best.x / p.W, v: best.y / p.H, score: best.score, hitRate: +(best.score / best.n).toFixed(2), shiftPx: +best.d.toFixed(1) };
}

app.whenReady().then(() => {
  const out = { scenes: {}, animals: {} };
  for (const sc of meta.scenes) {
    const p = load(sc.name);
    if (!p) { out.scenes[sc.name] = { missing: true }; continue; }
    if (sc.name === 'p-sheep-closeup') {
      const head = windowAt(p, sc.head.u, sc.head.v, 26);
      /* 近景额外量「头」和「身体」两块，看层次是否有差别 */
      out.scenes[sc.name] = { head, body: windowAt(p, sc.head.u, sc.head.v + 0.16, 26) };
      continue;
    }
    const row = {};
    for (const a of (sc.list || [])) {
      const loc = locate(p, a.body.u, a.body.v, EXPECT[a.t] || [128, 128, 128]);
      const bu = loc ? loc.u : a.body.u, bv = loc ? loc.v : a.body.v;
      /* 窗口按截图高度给：16px 在 994 高的截图里只有 1.6%，会落在动物脚边。
         half = 截图高度 × 2.5%（≈25px）覆盖身体中段；头部用 1.5%。 */
      const halfBody = Math.max(10, Math.round(p.H * 0.025));
      const halfHead = Math.max(6, Math.round(p.H * 0.015));
      const b = windowAt(p, bu, bv, halfBody);
      const h = windowAt(p, a.head.u, a.head.v, halfHead);
      const cx0 = Math.round(a.body.u * p.W), cy0 = Math.round(a.body.v * p.H);
      const i0 = (cy0 * p.W + cx0) * 4;
      row[a.t] = { body: b, head: h, locate: loc, atProjected: [p.bmp[i0 + 2], p.bmp[i0 + 1], p.bmp[i0]] };
      const key = sc.name.replace('p-animals-', '');
      out.animals[a.t] = out.animals[a.t] || {};
      out.animals[a.t][key] = {
        bodyMean: b.mean, headMean: h.mean, bodySpan: b.span, bodyBuckets: b.buckets,
        headBuckets: h.buckets, hitRate: loc ? loc.hitRate : 0, shiftPx: loc ? loc.shiftPx : null
      };
    }
    out.scenes[sc.name] = row;
  }

  console.log('=== 每只动物的实测亮度（按投影坐标采样）===');
  for (const t of Object.keys(out.animals)) {
    const a = out.animals[t];
    console.log(' ' + t.padEnd(6), '白天=' + (a.day && a.day.bodyMean), '暗处=' + (a.dark && a.dark.bodyMean),
      '火把=' + (a.torch && a.torch.bodyMean),
      '暗/白=' + (a.day && a.dark ? (a.dark.bodyMean / a.day.bodyMean).toFixed(3) : '-'),
      '火/暗=' + (a.dark && a.torch ? (a.torch.bodyMean / a.dark.bodyMean).toFixed(3) : '-'),
      '暗处头部色档=' + (a.dark && a.dark.headBuckets));
  }
  const close = out.scenes['p-sheep-closeup'] || {};
  console.log('=== 羊头近景 ===');
  console.log(' head=' + JSON.stringify(close.head) + ' body=' + JSON.stringify(close.body));

  /* 判据（同机位相对关系，不设审美阈值） */
  const all = Object.values(out.animals);
  out.relation = {
    everyAnimalDarkerAtDark: all.every(a => a.day && a.dark && a.dark.bodyMean < a.day.bodyMean),
    everyAnimalBrighterAtTorch: all.every(a => a.dark && a.torch && a.torch.bodyMean > a.dark.bodyMean),
    darkFloorVisible: all.every(a => a.dark && a.dark.bodyMean > 0.02),
    headHasLayers: all.every(a => a.dark && a.dark.headBuckets >= 3),
    closeupHasContrast: !!(close.head && close.head.span > 0.05 && close.head.buckets >= 4)
  };
  console.log('=== 关系 ===');
  console.log(JSON.stringify(out.relation));
  fs.writeFileSync(path.join(DIR, 'pixel-stats.json'), JSON.stringify(out, null, 2));
  console.log('→ ' + path.join(DIR, 'pixel-stats.json'));
  app.exit(0);
});
