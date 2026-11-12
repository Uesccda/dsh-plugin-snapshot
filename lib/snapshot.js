/**
 * 快照：把 profile 的三份清单备份到插件自己的数据目录，支持列表与恢复。
 * 设计要点（与外部工具版一致，都是踩过坑之后的结论）：
 *  - 一份都没备份到就抛错，不返回空快照；
 *  - 每份写 manifest（profile 指纹、创建时间、每文件摘要）；
 *  - 清理时保护正在使用的快照，按创建时间排序；
 *  - 恢复前校验 profile 身份，摘要不符只告警。
 */
import { renameSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { atomicWrite, sha256, tsStr, isValidSnapName, dataDir, readJson } from './util.js';

const FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const MANIFEST = 'manifest.json';

export function snapRoot(cfg) {
  const base = (cfg && cfg.dataDir) ? cfg.dataDir : dataDir();
  return join(base, 'snapshots');
}

function profileId(dir) {
  return sha256(Buffer.from(String(dir))).slice(0, 16);
}
/** 与目录路径无关的 profile 标识：profile 名 + 排序后的依赖名集合 */
function profileKey(profileDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    const names = Object.keys(pkg.dependencies || {}).sort().join(',');
    return sha256(Buffer.from(String(pkg.name || '') + '|' + names)).slice(0, 16);
  } catch (e) { return null; }
}

const MAX_JSON = 4 * 1024 * 1024;

/** 从现有文件推断缩进，写回时保留原风格 */
function detectIndent(text) {
  const m = /\n([ \t]+)"/.exec(String(text || ''));
  return m ? m[1] : '  ';
}

function uniqueDir(base) {
  const stamp = tsStr();
  let dir = join(base, stamp);
  let i = 2;
  while (existsSync(dir)) { dir = join(base, stamp + '-' + i); i++; }
  return dir;
}

export function createSnapshot(profileDir, cfg, protectExtra) {
  /* protectExtra：本次操作额外需要保留的快照名。
     审查发现：restoreSnapshot 会先 createSnapshot，而 createSnapshot 内部 prune 只保护
     新建的那一份，待恢复的目标若正好是最旧的，会在复制前被删掉（ENOENT）。 */
  const base = snapRoot(cfg);
  mkdirSync(base, { recursive: true });
  const dir = uniqueDir(base);
  mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const f of FILES) {
    const src = join(profileDir, f);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(dir, f));
    saved.push(f);
  }
  if (!saved.length) {
    try { rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    throw new Error('无法创建快照：profile 目录里没有任何清单文件（' + profileDir + '）');
  }
  const files = {};
  for (const f of FILES) {
    const p = join(profileDir, f);
    if (!existsSync(p)) { files[f] = { exists: false }; continue; }
    try { files[f] = { exists: true, size: statSync(p).size, sha256: sha256(readFileSync(p)) }; }
    catch (e) { files[f] = { exists: false }; }
  }
  try {
    atomicWrite(join(dir, MANIFEST), JSON.stringify({
      profileId: profileId(profileDir),
      profileDir,
      createdAt: Date.now(),
      created: tsStr(),
      tool: 'dsh-plugin-snapshot',
      profileKey: profileKey(profileDir),
      files
    }, null, 2));
  } catch (e) { /* manifest 失败不影响恢复，只是少了身份校验 */ }
  prune(cfg, [basename(dir)].concat(Array.isArray(protectExtra) ? protectExtra : []));
  return { name: basename(dir), dir, files: saved };
}

export function prune(cfg, protect) {
  const base = snapRoot(cfg);
  /* 审查发现：Math.max(1, NaN) 仍是 NaN，会让 over 判断永远为 false，prune 失效 */
  const rawKeep = Number(cfg && cfg.snapshotsKeep);
  const keep = Number.isFinite(rawKeep) && rawKeep >= 1 ? Math.floor(rawKeep) : 7;
  const prot = new Set((protect || []).map((x) => basename(String(x))));
  let items = [];
  try { items = readdirSync(base); } catch (e) { return; }
  const timed = [];
  for (const n of items) {
    if (!isValidSnapName(n)) continue;
    let ms = 0;
    try { ms = statSync(join(base, n)).mtimeMs; } catch (e) { ms = 0; }
    timed.push({ n, ms });
  }
  timed.sort((a, b) => a.ms - b.ms);
  const snaps = timed.map((x) => x.n);
  const queue = snaps.filter((n) => !prot.has(n));
  let over = snaps.length - keep;
  while (over > 0 && queue.length) {
    const victim = queue.shift();
    try { rmSync(join(base, victim), { recursive: true, force: true }); over--; } catch (e) { /* 忽略 */ }
  }
}

export function listSnapshots(cfg) {
  const base = snapRoot(cfg);
  let items = [];
  try { items = readdirSync(base); } catch (e) { return []; }
  const out = [];
  for (const name of items) {
    if (!isValidSnapName(name)) continue;
    const dir = join(base, name);
    const man = readJson(join(dir, MANIFEST));
    let mtime = 0;
    try { mtime = statSync(dir).mtimeMs; } catch (e) { /* 忽略 */ }
    if (man && man.createdAt) mtime = man.createdAt;
    let deps = 0;
    try {
      const pf = join(dir, 'package.json');
      deps = statSync(pf).size > MAX_JSON ? -1 : Object.keys(JSON.parse(readFileSync(pf, 'utf8')).dependencies || {}).length;
    }
    catch (e) { /* 忽略 */ }
    out.push({ name, dir, mtime, deps, hasManifest: !!man, files: FILES.filter((f) => existsSync(join(dir, f))) });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function resolveSnap(cfg, name) {
  const base = basename(String(name || ''));
  if (!isValidSnapName(base)) throw new Error('非法的快照名: ' + (base || '(空)'));
  return join(snapRoot(cfg), base);
}

export function restoreSnapshot(profileDir, cfg, name) {
  const dir = resolveSnap(cfg, name);
  if (!existsSync(dir)) throw new Error('快照不存在: ' + dir);
  const present = FILES.filter((f) => existsSync(join(dir, f)));
  if (!present.length) throw new Error('快照目录内没有可恢复的文件: ' + dir);

  const man = readJson(join(dir, MANIFEST));
  const warnings = [];
  /* 注意：warnings 必须在任何 push 之前声明（TDZ） */
  if (man && man.profileId && man.profileId !== profileId(profileDir)) {
    /* 目录可能只是被移动/改名：用与路径无关的 profileKey 再判一次 */
    const sameEnv = man.profileKey && man.profileKey === profileKey(profileDir);
    if (!sameEnv) {
      throw new Error("快照属于另一个 profile（" + String(man.profileDir || "?") + "），已拒绝恢复");
    }
    warnings.push("profile 目录路径与快照记录不同，按同一环境处理：" + String(man.profileDir || "?"));
  }
  if (man && man.files) {
    for (const f of present) {
      const meta = man.files[f];
      if (!meta || !meta.exists || !meta.sha256) continue;
      try {
        if (sha256(readFileSync(join(dir, f))) !== meta.sha256) warnings.push('快照文件与创建时摘要不一致: ' + f);
      } catch (e) { /* 忽略 */ }
    }
  }

  /* 恢复前再拍一份「当前状态」，但必须把待恢复的目标列入保护名单，否则它可能被 prune 删除 */
  createSnapshot(profileDir, cfg, [basename(dir)]);
  if (!existsSync(dir)) throw new Error('待恢复的快照已不存在（可能被保留策略清理）：' + basename(dir));
  const restored = [];
  for (const f of present) {
    /* 先在目标目录写临时文件再 rename：单文件原子替换，
       避免恢复中途崩溃留下「新旧混合」的 profile */
    const target = join(profileDir, f);
    const tmp = target + '.restore-' + process.pid + '-' + Date.now();
    copyFileSync(join(dir, f), tmp);
    renameSync(tmp, target);
    restored.push(f);
  }
  return { restored, warnings, from: basename(dir) };
}


/**
 * 包级回退：只把指定包的版本号改回快照里的值，其余包的更新保留。
 * 这是分层回退的第一层——部分成功时用它，避免让成功的包陪葬。
 * @returns {string[]} 实际回退的包（name -> version 描述）
 */
export function revertPackages(profileDir, cfg, snapName, names) {
  const dir = resolveSnap(cfg, snapName);
  const curPath = join(profileDir, 'package.json');
  const rawCur = readFileSync(curPath, 'utf8');
  const snapPkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const cur = JSON.parse(rawCur);
  /* dependencies / devDependencies / optionalDependencies 三处都回退 */
  const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
  const done = [];
  for (const n of names) {
    for (const sec of SECTIONS) {
      const snapSec = snapPkg[sec] || {};
      if (!Object.prototype.hasOwnProperty.call(snapSec, n)) continue;
      if (!cur[sec]) cur[sec] = {};
      cur[sec][n] = snapSec[n];
      done.push(n + ' -> ' + snapSec[n]);
      break;
    }
  }
  if (done.length) {
    const indent = detectIndent(rawCur);
    atomicWrite(curPath, JSON.stringify(cur, null, indent) + String.fromCharCode(10));
  }
  return done;
}
