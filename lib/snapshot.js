/**
 * 快照：把 profile 的三份清单备份到插件自己的数据目录，支持列表与恢复。
 * 设计要点（与外部工具版一致，都是踩过坑之后的结论）：
 *  - 一份都没备份到就抛错，不返回空快照；
 *  - 每份写 manifest（profile 指纹、创建时间、每文件摘要）；
 *  - 清理时保护正在使用的快照，按创建时间排序；
 *  - 恢复前校验 profile 身份，摘要不符只告警。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
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

function uniqueDir(base) {
  const stamp = tsStr();
  let dir = join(base, stamp);
  let i = 2;
  while (existsSync(dir)) { dir = join(base, stamp + '-' + i); i++; }
  return dir;
}

export function createSnapshot(profileDir, cfg) {
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
      files
    }, null, 2));
  } catch (e) { /* manifest 失败不影响恢复，只是少了身份校验 */ }
  prune(cfg, [basename(dir)]);
  return { name: basename(dir), dir, files: saved };
}

export function prune(cfg, protect) {
  const base = snapRoot(cfg);
  const keep = Math.max(1, Number((cfg && cfg.snapshotsKeep) || 7));
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
    try { deps = Object.keys(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies || {}).length; }
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
  if (man && man.profileId && man.profileId !== profileId(profileDir)) {
    throw new Error('快照属于另一个 profile（' + String(man.profileDir || '?') + '），已拒绝恢复');
  }
  const warnings = [];
  if (man && man.files) {
    for (const f of present) {
      const meta = man.files[f];
      if (!meta || !meta.exists || !meta.sha256) continue;
      try {
        if (sha256(readFileSync(join(dir, f))) !== meta.sha256) warnings.push('快照文件与创建时摘要不一致: ' + f);
      } catch (e) { /* 忽略 */ }
    }
  }

  createSnapshot(profileDir, cfg);
  const restored = [];
  for (const f of present) {
    copyFileSync(join(dir, f), join(profileDir, f));
    restored.push(f);
  }
  return { restored, warnings, from: basename(dir) };
}

