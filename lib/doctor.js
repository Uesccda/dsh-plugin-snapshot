/**
 * 诊断：静态扫描已安装插件，给出兼容性、互斥与检查优先级。
 * 只读，不修改任何文件；结论都标注为「静态线索」，不是运行时验证。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readProfile, readLockVersions } from './profile.js';
import { parseSemver, cmpSemver, shortVer } from './util.js';

const MAX_JSON = 4 * 1024 * 1024;

/** 兼容性判定：否定声明优先于肯定声明（incompatible 绝不能被读成兼容） */
export function judgeCompatibility(pkg, dshVersion) {
  const cur = parseSemver(dshVersion);
  const dshField = (pkg && pkg.dsh) || {};
  const rel = (dshField.compatibility && dshField.compatibility.dshReleases) || null;
  const out = { state: 'unknown', label: '未声明', detail: '', declared: [], current: dshVersion };

  if (rel && typeof rel === 'object') {
    const keys = Object.keys(rel);
    out.declared = keys.map((k) => k + ' -> ' + rel[k]);
    let denyKey = null;
    let allowExact = null;
    let allowOpen = false;
    for (const k of keys) {
      const raw = String(k).trim();
      const isOpen = raw.slice(-1) === '+';
      const ver = isOpen ? raw.slice(0, -1) : raw;
      const val = String(rel[k] === undefined ? '' : rel[k]).toLowerCase().trim();
      const isDeny = /^(in|not|no|un|non|unsupported)/.test(val);
      const isPartial = val.indexOf('partial') === 0;
      const isAllow = /compat|^full$|^yes$|^true$|^supported$|^ok$/.test(val);
      if (!isDeny && !isPartial && !isAllow) continue;
      if (!cur) continue;
      const covers = isOpen ? (!!parseSemver(ver) && cmpSemver(dshVersion, ver) >= 0) : (cmpSemver(dshVersion, ver) === 0);
      if (!covers) continue;
      if (isDeny || isPartial) denyKey = raw + ' = ' + rel[k];
      else if (isOpen) allowOpen = true;
      else allowExact = ver;
    }
    if (denyKey) {
      out.state = 'incompatible';
      out.label = '明确不兼容';
      out.detail = '作者显式声明 ' + denyKey + '，当前 DSH ' + dshVersion + ' 不在支持范围';
      return out;
    }
    if (allowExact) { out.state = 'compatible'; out.label = '已验证兼容'; out.detail = '显式声明 ' + allowExact + ' 兼容'; return out; }
    if (allowOpen) { out.state = 'compatible'; out.label = '区间兼容'; out.detail = '当前版本落在声明的开放区间内'; return out; }
    out.state = 'untested';
    out.label = '未验证';
    out.detail = '声明范围不含 ' + (dshVersion || '未知版本') + '；风险未知，建议先在测试环境验证';
    return out;
  }
  if (pkg && pkg.engines && pkg.engines.dsh) {
    out.state = 'engines-only';
    out.label = '仅 engines 约束';
    out.detail = 'engines.dsh = ' + pkg.engines.dsh + '（作者未声明 compatibility）';
    return out;
  }
  out.detail = '插件未声明任何 DSH 版本兼容信息';
  return out;
}

function patchIds(text) {
  const ids = [];
  let inInsert = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*-?\s*insert:\s*$/.test(line)) { inInsert = true; continue; }
    if (!inInsert) continue;
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const m = /^\s*-?\s*id:\s*([^\s#]+)\s*$/.exec(line);
    if (m) { ids.push(m[1]); continue; }
    if (/^\s*-?\s*[a-zA-Z_]+:/.test(line) && !/^\s{4,}/.test(line)) inInsert = false;
  }
  return Array.from(new Set(ids));
}

function hasNative(dir) {
  const walk = (d, depth) => {
    if (depth > 2) return false;
    let items = [];
    try { items = readdirSync(d, { withFileTypes: true }); } catch (e) { return false; }
    for (const e of items) {
      if (e.isFile() && e.name.endsWith('.node')) return true;
      if (e.isDirectory() && /^(build|prebuilds|native)$/.test(e.name) && walk(join(d, e.name), depth + 1)) return true;
    }
    return false;
  };
  return walk(dir, 0);
}

export function scanPlugins(profileDir, dshVersion) {
  const prof = readProfile(profileDir);
  const lock = readLockVersions(profileDir);
  const nm = join(profileDir, 'node_modules');
  const items = [];
  for (const name of Object.keys(prof.deps)) {
    const dir = join(nm, ...name.split('/'));
    const enabled = prof.bundles.indexOf(name) >= 0;
    const pkgFile = join(dir, 'package.json');
    if (!existsSync(pkgFile)) {
      items.push({ name, enabled, installed: false, error: '已声明但未安装（node_modules 缺失）', declared: String(prof.deps[name]) });
      continue;
    }
    let pkg = {};
    let error = '';
    try {
      if (statSync(pkgFile).size > MAX_JSON) error = 'package.json 过大，已跳过解析';
      else pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    } catch (e) { error = 'package.json 无法解析'; }
    const patchFile = join(dir, 'cordis.patch.yml');
    let ids = [];
    let hasPatch = false;
    if (existsSync(patchFile)) {
      hasPatch = true;
      try { ids = patchIds(readFileSync(patchFile, 'utf8')); } catch (e) { /* 忽略 */ }
    }
    const rawInject = (pkg.dsh && pkg.dsh.client && pkg.dsh.client.inject);
    items.push({
      name,
      enabled,
      installed: true,
      version: pkg.version || '?',
      declared: String(prof.deps[name]),
      resolved: lock[name] || '',
      hasPatch,
      patchIds: ids,
      hasNative: hasNative(dir),
      clientInject: Array.isArray(rawInject) ? rawInject.filter((x) => typeof x === 'string') : [],
      compatibility: judgeCompatibility(pkg, dshVersion),
      error: error || undefined
    });
  }
  return { items, profile: prof.name };
}

export function detectConflicts(items) {
  const conflicts = [];
  const byPatch = new Map();
  for (const it of items) {
    for (const id of it.patchIds || []) {
      if (!byPatch.has(id)) byPatch.set(id, []);
      byPatch.get(id).push(it.name);
    }
  }
  for (const [id, owners] of byPatch) {
    if (owners.length > 1) conflicts.push({ severity: 'critical', kind: 'patch-id', message: 'patch 行标识 ' + id + ' 被 ' + owners.length + ' 个插件占用', plugins: owners });
  }
  for (const it of items) {
    const c = it.compatibility || {};
    if (c.state === 'incompatible') conflicts.push({ severity: 'critical', kind: 'compat', message: it.name + '：' + c.detail, plugins: [it.name] });
    else if (c.state === 'untested') conflicts.push({ severity: 'high', kind: 'compat', message: it.name + '：' + c.detail, plugins: [it.name] });
    if (it.installed === false) conflicts.push({ severity: 'high', kind: 'missing', message: it.name + '：' + it.error, plugins: [it.name] });
    if (it.error) conflicts.push({ severity: 'medium', kind: 'manifest', message: it.name + '：' + it.error, plugins: [it.name] });
  }
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  conflicts.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (a.kind < b.kind ? -1 : 1));
  return conflicts;
}

/** 检查优先级（规则加权，不是崩溃概率） */
export function priorityOf(item, conflicts) {
  let score = 0;
  const factors = [];
  const mine = conflicts.filter((c) => c.plugins.indexOf(item.name) >= 0);
  for (const c of mine) {
    if (c.severity === 'critical') { score += 45; factors.push('严重：' + c.kind); }
    else if (c.severity === 'high') { score += 25; factors.push('高：' + c.kind); }
    else { score += 12; factors.push('中：' + c.kind); }
  }
  if (item.hasNative) { score += 8; factors.push('含原生模块'); }
  score = Math.max(0, Math.min(100, score));
  const level = score >= 60 ? '高' : score >= 30 ? '中' : score >= 10 ? '低' : '未发现已知风险';
  return { score, level, factors };
}

