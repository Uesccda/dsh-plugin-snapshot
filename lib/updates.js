/**
 * 版本检测：以 lockfile 的解析版本为准，去 registry 查候选版本。
 * 只读操作，不写 profile、不安装任何东西。
 */
import { readProfile, readLockVersions, specKind } from './profile.js';
import { parseSpec, parseSemver, cmpSemver, shortVer, isValidPkgName, Logger } from './util.js';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

function registryOf(cfg) {
  const r = String((cfg && cfg.registry) || process.env.DSH_REGISTRY || '').trim();
  return (r || DEFAULT_REGISTRY).replace(/[/]+$/, '');
}

async function fetchLatest(name, cfg) {
  if (!isValidPkgName(name)) return { ok: false, reason: '非法包名' };
  const base = registryOf(cfg);
  if (!/^https?:[/][/]/.test(base)) return { ok: false, reason: '非法的 registry 地址' };
  try {
    const res = await fetch(base + '/' + name + '/latest', {
      signal: AbortSignal.timeout(Math.max(5000, Number((cfg && cfg.timeoutMs) || 20000))),
      headers: { accept: 'application/json' }
    });
    if (res.status === 404) return { ok: false, reason: 'HTTP 404（包不存在）' };
    if (!res.ok) return { ok: false, reason: 'HTTP ' + res.status };
    const j = await res.json();
    if (!j || !j.version) return { ok: false, reason: '响应缺少 version' };
    return { ok: true, latest: j.version, engines: j.engines || null, dsh: j.dsh || null };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(limit || 1, items.length))).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

export async function checkUpdates(profileDir, cfg) {
  const prof = readProfile(profileDir);
  const lock = readLockVersions(profileDir);
  const names = Object.keys(prof.deps);
  const targets = [];
  const skipped = [];
  for (const name of names) {
    if (!isValidPkgName(name)) { skipped.push({ name, reason: '非法包名' }); continue; }
    const kind = specKind(prof.deps[name]);
    if (kind === 'local') { skipped.push({ name, reason: '本地依赖，不参与升级' }); continue; }
    targets.push({ name, kind, declared: String(prof.deps[name]), resolved: lock[name] || '' });
  }

  const results = await mapLimit(targets, Math.max(1, Math.min(Number((cfg && cfg.concurrency) || 8), 16)), async (t) => {
    if (t.kind === 'github') {
      return { ...t, state: 'manual', reason: 'GitHub 源需人工确认，本工具不自动判定' };
    }
    const r = await fetchLatest(t.name, cfg);
    if (!r.ok) return { ...t, state: 'failed', reason: r.reason };
    const cur = parseSpec(t.resolved || t.declared);
    const lat = parseSemver(r.latest);
    if (!cur || !lat) return { ...t, state: 'unknown', reason: '版本号无法解析', candidate: r.latest };
    if (lat.pre) return { ...t, state: 'prerelease', reason: '候选是预发布版本', candidate: r.latest };
    if (cur.major !== lat.major) return { ...t, state: 'major', reason: '主版本变更，需人工确认', candidate: r.latest };
    const c = cmpSemver(cur.base, r.latest);
    return {
      ...t,
      candidate: r.latest,
      state: (c !== null && c < 0) ? 'updatable' : 'uptodate',
      reason: (c !== null && c < 0) ? '' : '',
      shortResolved: shortVer(t.resolved || t.declared)
    };
  });

  const summary = {
    total: results.length,
    updatable: results.filter((x) => x.state === 'updatable').length,
    major: results.filter((x) => x.state === 'major').length,
    uptodate: results.filter((x) => x.state === 'uptodate').length,
    failed: results.filter((x) => x.state === 'failed').length,
    skipped: skipped.length
  };
  return { items: results, skipped, summary, profile: prof.name, registry: registryOf(cfg) };
}

