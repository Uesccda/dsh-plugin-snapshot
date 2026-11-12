/**
 * 通用工具：原子写、摘要、语义化版本、路径与日志。
 * 本文件不依赖 Electron / DSH 内部包，可在纯 Node 下被单测直接覆盖。
 */
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** 原子写：tmp -> fsync -> rename，中途失败不会留下半个文件 */
export function atomicWrite(file, text) {
  const tmp = file + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  let fd = null;
  try {
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(tmp, 'w');
    writeFileSync(fd, text, 'utf8');
    try { fsyncSync(fd); } catch (e) { /* 部分文件系统不支持 */ }
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
    return true;
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch (err) { /* 忽略 */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch (err) { /* 忽略 */ }
    throw e;
  }
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function todayStr(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
}

export function tsStr(d) {
  const x = d || new Date();
  return String(x.getFullYear()) + pad(x.getMonth() + 1) + pad(x.getDate()) + '-' + pad(x.getHours()) + pad(x.getMinutes()) + pad(x.getSeconds());
}

export function pad(n) { return String(n).padStart(2, '0'); }

/** 合法的 npm 包名：可带 @scope/，只允许字母数字与 . _ - */
export function isValidPkgName(n) {
  if (typeof n !== 'string') return false;
  const s = n.trim();
  if (!s || s.length > 214) return false;
  if (s.startsWith('.') || s.startsWith('-')) return false;
  if (s.indexOf('..') >= 0 || s.indexOf(String.fromCharCode(92)) >= 0 || s.indexOf('/') === s.length - 1) return false;
  if (/[\s\u0000]/.test(s)) return false;
  return /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s);
}

export function isValidSnapName(n) {
  return typeof n === 'string' && /^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/.test(n);
}

/** 解析 spec 里的语义化版本（支持 ^ ~ >= 前缀、v 前缀、prerelease、build、四段） */
export function parseSpec(spec) {
  if (typeof spec !== 'string') return null;
  const m = /^([\^~>=<*\s]*?)v?(\d+)\.(\d+)\.(\d+)(?:\.\d+)?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(spec.trim());
  if (!m) return null;
  return { prefix: m[1] || '', major: +m[2], minor: +m[3], patch: +m[4], pre: m[5] || null, base: m[2] + '.' + m[3] + '.' + m[4] + (m[5] ? '-' + m[5] : '') };
}

export function parseSemver(v) {
  const s = parseSpec(v);
  return s ? { major: s.major, minor: s.minor, patch: s.patch, pre: s.pre, raw: s.base } : null;
}

export function cmpSemver(a, b) {
  const A = parseSemver(a), B = parseSemver(b);
  if (!A || !B) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (A[k] !== B[k]) return A[k] < B[k] ? -1 : 1;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  const pa = A.pre.split('.'), pb = B.pre.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { if (+x !== +y) return +x < +y ? -1 : 1; }
    else if (xn) return -1;
    else if (yn) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function shortVer(spec) {
  return String(spec == null ? '' : spec).replace(/^[\^~>=<\s]+/, '');
}

/** 数据目录：只写用户目录下的独立子目录，不碰 profile */
export function dataDir() {
  return join(homedir(), '.dsh-plugin-snapshot');
}

/** 极简日志器：写本插件自己的目录，失败不抛 */
export class Logger {
  constructor(dir) {
    this.dir = dir || join(dataDir(), 'logs');
    this.file = join(this.dir, 'snapshot-' + todayStr() + '.log');
    this.lines = [];
  }
  write(level, msg) {
    /* 写入前脱敏：日志可能包含 pnpm 输出的 registry 地址与凭据 */
    const safe = String(msg)
      .replace(/(_authToken[=:]\s*)\S+/gi, '$1***')
      .replace(/\bnpm_[A-Za-z0-9]{16,}\b/g, 'npm_***')
      .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, '$1***');
    const line = '[' + new Date().toISOString() + '] [' + level + '] ' + safe;
    this.pruneOld();
    this.lines.push(line);
    if (this.lines.length > 200) this.lines.shift();
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.file, line + '\n', 'utf8');
    } catch (e) { /* 只影响日志，不影响功能 */ }
  }
  /** 只保留最近 7 天的日志 */
  pruneOld() {
    const now = Date.now();
    const SEVEN = 7 * 24 * 3600 * 1000;
    if (this._pruned && now - this._pruned < 3600000) return;
    this._pruned = now;
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.startsWith('snapshot-') || !f.endsWith('.log')) continue;
        const p = join(this.dir, f);
        try { if (now - statSync(p).mtimeMs > SEVEN) rmSync(p, { force: true }); } catch (e) { /* 忽略单个文件 */ }
      }
    } catch (e) { /* 目录不存在时忽略 */ }
  }

  info(m) { this.write('info', m); }
  warn(m) { this.write('warn', m); }
  error(m) { this.write('error', m); }
  tail(n) { return this.lines.slice(-(n || 20)); }
}

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return null; }
}

