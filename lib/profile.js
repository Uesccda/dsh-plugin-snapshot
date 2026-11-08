/**
 * profile 定位与解析。
 * 插件运行在 DSH 进程内，profile 目录按「显式配置 > 环境变量 > 标准路径 > 扫描」的顺序确定，
 * 任一步失败都不会抛异常，只返回 null 让上层给出可读错误。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PROFILE_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

export function profilesRoot() {
  return join(homedir(), '.dsh', 'profiles');
}

/** 定位一个可用的 profile 目录 */
export function resolveProfileDir(cfg) {
  const cands = [];
  if (cfg && typeof cfg.profileDir === 'string' && cfg.profileDir) cands.push(cfg.profileDir);
  for (const k of ['DSH_PROFILE_DIR', 'DSH_PROFILE_PATH', 'DSH_PROFILE']) {
    if (process.env[k]) cands.push(String(process.env[k]));
  }
  cands.push(join(profilesRoot(), 'desktop'));
  try {
    const base = profilesRoot();
    const dirs = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ dir: join(base, e.name), mtime: statSync(join(base, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs) cands.push(d.dir);
  } catch (e) { /* 没有 profiles 目录 */ }
  for (const c of cands) {
    if (c && existsSync(join(c, 'package.json'))) return c;
  }
  return null;
}

/** 读 profile 清单与启用状态 */
export function readProfile(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) throw new Error('找不到 profile 清单: ' + p);
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { throw new Error('profile 清单无法解析: ' + p); }
  const deps = (manifest && manifest.dependencies) || {};
  const bundles = (manifest && manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
  return { path: p, manifest, deps, bundles, name: manifest.name || '' };
}

/** 从 pnpm-lock.yaml 的 importers 段读直接依赖的解析版本 */
export function parseLockVersions(lockText) {
  const out = {};
  const lines = String(lockText || '').split(/\r?\n/);
  let inImporters = false;
  let inDeps = false;
  let depIndent = -1;
  let curName = null;
  for (const raw of lines) {
    if (/^importers:\s*$/.test(raw)) { inImporters = true; continue; }
    if (inImporters && /^[a-zA-Z]/.test(raw)) { inImporters = false; continue; }
    if (!inImporters) continue;
    if (/^\s+dependencies:\s*$/.test(raw)) { inDeps = true; depIndent = raw.indexOf('dependencies:'); curName = null; continue; }
    if (inDeps && /^\s+(devDependencies|optionalDependencies):\s*$/.test(raw)) { inDeps = false; continue; }
    if (!inDeps) continue;
    const indent = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (!t) continue;
    if (indent === depIndent + 2 && /^[^:]+:\s*$/.test(t)) {
      curName = t.slice(0, -1).trim().replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (curName && indent === depIndent + 4) {
      const m = /^version:\s*(.+)$/.exec(t);
      if (m) { out[curName] = m[1].trim().replace(/^['"]|['"]$/g, ''); curName = null; }
    }
  }
  return out;
}

export function readLockVersions(dir) {
  const p = join(dir, 'pnpm-lock.yaml');
  if (!existsSync(p)) return {};
  try { return parseLockVersions(readFileSync(p, 'utf8')); } catch (e) { return {}; }
}

/** 依赖的分类：registry / github / local */
export function specKind(spec) {
  const s = String(spec || '');
  if (/^(github:|git\+https?:|https?:\/\/(codeload\.)?github\.com)/i.test(s)) return 'github';
  if (/^(file:|link:|\.\/|\.\.\/)/.test(s)) return 'local';
  return 'registry';
}

export { PROFILE_FILES };

