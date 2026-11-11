/*
 * 阶段 6 第 0 节的针对性验证：不启动 Electron、不重跑验收，只读两次成品自检
 * 留下的证据，确认「主线/守卫各走自己的存档目录、普通存档没被清、两份报告都在」。
 *
 *   node app/tools/verify-acceptance-isolation.mjs
 *
 * 输出 artifacts/acceptance/isolation-check.json；任何一项不满足则退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const ACCEPT = path.join(ROOT, 'artifacts', 'acceptance');
const OUT = path.join(ACCEPT, 'isolation-check.json');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function findRuns(tag) {
  if (!fs.existsSync(ACCEPT)) return [];
  return fs.readdirSync(ACCEPT, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.endsWith('-' + tag))
    .map(d => path.join(ACCEPT, d.name))
    .filter(p => fs.existsSync(path.join(p, 'meta.json')))
    .map(p => ({ dir: p, meta: readJson(path.join(p, 'meta.json')) }))
    .sort((a, b) => String(b.meta.finishedAt).localeCompare(String(a.meta.finishedAt)));
}

function snapshotOf(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => ({ name: e.name, bytes: fs.statSync(path.join(dir, e.name)).size, sha256: sha(path.join(dir, e.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const checks = [];
const check = (name, ok, detail) => checks.push({ name, pass: !!ok, detail });

const mains = findRuns('MAIN');
const guards = findRuns('GUARDIAN');
check('找到一条主线成品自检证据', mains.length >= 1, mains[0] ? mains[0].dir : 'none');
check('找到一条守卫成品自检证据', guards.length >= 1, guards[0] ? guards[0].dir : 'none');

if (mains.length && guards.length) {
  const M = mains[0], G = guards[0];
  const rootFull = path.resolve(ACCEPT) + path.sep;
  const under = (p) => path.resolve(p).toLowerCase().startsWith(rootFull.toLowerCase());

  check('主线与守卫使用不同的验收存档根',
    path.resolve(M.meta.saveRoot) !== path.resolve(G.meta.saveRoot),
    { main: M.meta.saveRoot, guardian: G.meta.saveRoot });
  check('两个验收存档根都在 artifacts/acceptance 下',
    under(M.meta.saveRoot) && under(G.meta.saveRoot),
    { acceptRoot: ACCEPT });
  check('两次运行都不是普通便携 saves 目录',
    !M.meta.saveRoot.toLowerCase().endsWith(path.join('游戏', '方块世界', 'saves').toLowerCase()) &&
    !G.meta.saveRoot.toLowerCase().endsWith(path.join('游戏', '方块世界', 'saves').toLowerCase()),
    { main: M.meta.saveRoot, guardian: G.meta.saveRoot });

  for (const [label, R] of [['主线', M], ['守卫', G]]) {
    check(label + ' 进程退出码为 0', R.meta.exitCode === 0, R.meta.exitCode);
    const rep = path.join(R.dir, 'report.json');
    check(label + ' 报告副本仍存在', fs.existsSync(rep), rep);
    if (fs.existsSync(rep)) {
      const r = readJson(rep);
      check(label + ' 报告全绿且无运行错误',
        r.pass === r.total && r.total > 0 && Array.isArray(r.errors) && r.errors.length === 0,
        { pass: r.pass, total: r.total, errors: (r.errors || []).length });
    }
    check(label + ' 原始报告仍在自己的存档根里',
      fs.existsSync(path.join(R.meta.saveRoot, R.meta.tag === 'GUARDIAN' ? 'guardian-report.json' : 'selftest-report.json')),
      path.join(R.meta.saveRoot, R.meta.tag === 'GUARDIAN' ? 'guardian-report.json' : 'selftest-report.json'));
    const stdout = path.join(R.dir, 'stdout.txt');
    check(label + ' stdout 已保存', fs.existsSync(stdout), stdout);
    if (fs.existsSync(stdout)) {
      const txt = fs.readFileSync(stdout, 'utf8');
      check(label + ' stdout 记录了实际验收存档目录',
        txt.includes(R.meta.saveRoot), R.meta.saveRoot);
    }
    check(label + ' stderr 已保存', fs.existsSync(path.join(R.dir, 'stderr.txt')), path.join(R.dir, 'stderr.txt'));
    check(label + ' 记录了耗时与所测文件哈希',
      typeof R.meta.elapsedMs === 'number' && R.meta.elapsedMs > 0 && Array.isArray(R.meta.hashes) && R.meta.hashes.length >= 5,
      { elapsedMs: R.meta.elapsedMs, hashes: (R.meta.hashes || []).length });
  }

  const mSnap = JSON.stringify((M.meta.normalSnapshot || []).slice().sort((a, b) => a.name.localeCompare(b.name)));
  const gSnap = JSON.stringify((G.meta.normalSnapshot || []).slice().sort((a, b) => a.name.localeCompare(b.name)));
  check('两次运行看到的普通存档快照一致', mSnap === gSnap,
    { mainFiles: (M.meta.normalSnapshot || []).length, guardianFiles: (G.meta.normalSnapshot || []).length });

  const normal = M.meta.normalSaves;
  const now = snapshotOf(normal);
  const before = (M.meta.normalSnapshot || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const missingOrChanged = before.filter(b => {
    const cur = now.find(n => n.name === b.name);
    return !cur || cur.sha256 !== b.sha256 || cur.bytes !== b.bytes;
  });
  check('普通便携存档没有被清空或改写', missingOrChanged.length === 0,
    { before: before.length, now: now.length, changed: missingOrChanged.map(x => x.name) });

  /* 两套剧本与 renderer 必须是同一份包：允许 gitHead 不同（自检之间可能提交），
     但被测文件哈希必须一致，否则「同一 EXE 串行验收」不成立。 */
  const hm = new Map((M.meta.hashes || []).map(h => [h.file, h.sha256]));
  const hg = new Map((G.meta.hashes || []).map(h => [h.file, h.sha256]));
  const mismatched = [...hm.keys()].filter(k => hg.has(k) && hg.get(k) !== hm.get(k));
  check('两次验收测的是同一份成品代码', mismatched.length === 0 && hm.size >= 5,
    { mainHashes: hm.size, guardianHashes: hg.size, mismatched });
}

const pass = checks.filter(c => c.pass).length;
const result = {
  time: new Date().toISOString(),
  pass, total: checks.length, ok: pass === checks.length,
  main: mains[0] ? mains[0].dir : null,
  guardian: guards[0] ? guards[0].dir : null,
  checks
};
fs.mkdirSync(ACCEPT, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
for (const c of checks) process.stdout.write((c.pass ? '  PASS ' : '  FAIL ') + c.name + (c.pass ? '' : '  ' + JSON.stringify(c.detail)) + '\n');
process.stdout.write('隔离验证 ' + pass + '/' + checks.length + ' → ' + OUT + '\n');
process.exit(result.ok ? 0 : 1);
