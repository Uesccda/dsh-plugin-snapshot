/**
 * 设置页面板的数据与操作接口。
 *
 * 设计约束：
 *  - 只读接口（updates / doctor / snapshots）随时可调；
 *  - 写操作（snapshot.create / snapshot.restore / apply）都要求显式 body，
 *    并且只动 profile 的三份清单或单个包的安装，不做批量猜测；
 *  - 所有异常都转成 { ok:false, error } 返回，不让路由 500 把前端打崩。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { checkUpdates } from './updates.js';
import { scanPlugins, detectConflicts, priorityOf } from './doctor.js';
import { createSnapshot, listSnapshots, restoreSnapshot } from './snapshot.js';
import { registerApplyAll } from './apply-all.js';
import { readAutoState, verifyInstalled, classifyResult } from './auto-update.js';
import { validateInstallTargets } from './install-guard.js';
import { findPnpm, runPnpm } from './exec.js';

function send(response, code, payload) {
  /* 请求体超限时调用方会 destroy socket，此时不能再写响应 */
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = code;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(payload));
}

function readBody(request, limit) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on('data', (c) => {
      size += c.length;
      if (size > (limit || 65536)) { request.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    request.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { resolve(null); }
    });
    request.on('error', () => resolve(null));
  });
}

export function mountRoutes(hostCtx, cfg, needProfile) {
  const offs = [];

  /* 写接口守卫。
     跨站写防护靠三件事叠加：
       1) 要求自定义头 X-DSH-Snapshot —— 跨源带自定义头会触发 CORS preflight，
          而本服务不应答 preflight，浏览器会直接拦下请求；
       2) 要求 application/json —— 跨源的 text/plain 简单请求不会被误接受；
       3) 若带 Origin，必须与 Host 同源，且拒绝 Origin: null。 */
  const guard = (request, response, opts) => {
    const o = opts || {};
    if (o.method && String(request.method || '').toUpperCase() !== o.method) {
      send(response, 405, { ok: false, error: '方法不允许，需要 ' + o.method });
      return false;
    }
    if (!o.write) return true;
    if (String(request.headers['x-dsh-snapshot'] || '') !== '1') {
      send(response, 403, { ok: false, error: '缺少 X-DSH-Snapshot 头，写操作被拒绝' });
      return false;
    }
    const ct = String(request.headers['content-type'] || '');
    if (ct.indexOf('application/json') < 0) {
      send(response, 415, { ok: false, error: '写操作只接受 application/json' });
      return false;
    }
    const origin = request.headers.origin;
    if (origin) {
      const host = request.headers.host;
      let sameOrigin = false;
      if (host && origin !== 'null') {
        try { sameOrigin = new URL(origin).host === host; } catch (e) { sameOrigin = false; }
      }
      if (!sameOrigin) {
        send(response, 403, { ok: false, error: '跨源写操作被拒绝' });
        return false;
      }
    }
    return true;
  };

  /* 写操作节流：同接口 1.5 秒内只接受一次，避免被反复调用把快照保留位挤掉 */
  const writeTimes = new Map();
  const THROTTLE_MS = 1500;

  const reg = (path, handler, opts) => {
    const off = hostCtx.webServer.register({
      kind: 'exact',
      path,
      handler: (request, response) => {
        const o = Object.assign({}, opts, { path });
        if (!guard(request, response, o)) return;
        if (o.write) {
          const now = Date.now();
          const prev = writeTimes.get(path) || 0;
          if (now - prev < THROTTLE_MS) {
            send(response, 429, { ok: false, error: '写操作过于频繁，请稍后再试' });
            return;
          }
          writeTimes.set(path, now);
        }
        return handler(request, response);
      }
    });
    offs.push(typeof off === 'function' ? off : () => {});
  };

  /* 只读：更新检测 */
  reg('/dsh-plugin-snapshot/api/updates', async (request, response) => {
    try {
      const dir = needProfile(cfg);
      const r = await checkUpdates(dir, cfg);
      send(response, 200, {
        ok: true,
        profile: r.profile,
        registry: r.registry,
        summary: r.summary,
        items: r.items.map((x) => ({
          name: x.name,
          declared: x.declared,
          resolved: x.resolved || '',
          candidate: x.candidate || '',
          state: x.state,
          reason: x.reason || ''
        }))
      });
    } catch (e) { send(response, 200, { ok: false, error: String((e && e.message) || e) }); }
  });

  /* 只读：诊断 */
  reg('/dsh-plugin-snapshot/api/doctor', async (request, response) => {
    try {
      const dir = needProfile(cfg);
      /* 宿主版本取不到就传 null，让兼容性判定返回 unknown，而不是用一个过期默认值假装兼容 */
      const dshVersion = String((cfg && cfg.dshVersion) || process.env.DSH_VERSION || '').trim() || null;
      const scan = scanPlugins(dir, dshVersion);
      const conflicts = detectConflicts(scan.items);
      const priority = scan.items
        .map((it) => Object.assign({ name: it.name }, priorityOf(it, conflicts)))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((x) => ({ name: x.name, score: x.score, level: x.level, factors: x.factors }));
      send(response, 200, {
        ok: true,
        profile: scan.profile,
        dshVersion,
        summary: {
          installed: scan.items.filter((x) => x.installed !== false).length,
          enabled: scan.items.filter((x) => x.enabled === true).length,
          unknownEnabled: scan.items.filter((x) => x.enabled === null).length,
          missing: scan.items.filter((x) => x.installed === false).length,
          incompatible: scan.items.filter((x) => (x.compatibility || {}).state === 'incompatible').length,
          untested: scan.items.filter((x) => (x.compatibility || {}).state === 'untested').length,
          native: scan.items.filter((x) => x.hasNative).length
        },
        conflicts: conflicts.slice(0, 40).map((c) => ({ severity: c.severity, kind: c.kind, message: c.message })),
        priority
      });
    } catch (e) { send(response, 200, { ok: false, error: String((e && e.message) || e) }); }
  });

  /* 只读：快照列表 */
  reg('/dsh-plugin-snapshot/api/snapshots', async (request, response) => {
    try {
      const list = listSnapshots(cfg).map((s) => ({
        name: s.name,
        createdAt: new Date(s.mtime).toISOString(),
        deps: s.deps,
        hasManifest: !!s.hasManifest
      }));
      send(response, 200, { ok: true, snapshots: list });
    } catch (e) { send(response, 200, { ok: false, error: String((e && e.message) || e) }); }
  });

  /* 写：创建快照 */
  reg('/dsh-plugin-snapshot/api/snapshot/create', async (request, response) => {
    try {
      const dir = needProfile(cfg);
      const s = createSnapshot(dir, cfg);
      send(response, 200, { ok: true, created: s.name, files: s.files });
    } catch (e) { send(response, 200, { ok: false, error: String((e && e.message) || e) }); }
  }, { write: true });

  /* 写：恢复快照 */
  reg('/dsh-plugin-snapshot/api/snapshot/restore', async (request, response) => {
    try {
      const body = await readBody(request);
      if (!body || !body.name) return send(response, 200, { ok: false, error: '缺少快照名' });
      const dir = needProfile(cfg);
      const r = restoreSnapshot(dir, cfg, String(body.name));
      send(response, 200, { ok: true, from: r.from, restored: r.restored, warnings: r.warnings });
    } catch (e) { send(response, 200, { ok: false, error: String((e && e.message) || e) }); }
  }, { write: true });

  /* 写：更新单个包 */
  reg('/dsh-plugin-snapshot/api/apply', async (request, response) => {
    try {
      const body = await readBody(request);
      if (!body || !body.name || !body.version) return send(response, 200, { ok: false, error: '缺少 name 或 version' });
      const dir = needProfile(cfg);
      /* 只允许：已安装的包 + 精确版本 + 严格升级 + 非预发布 */
      const check = validateInstallTargets(dir, [{ name: body.name, version: body.version }]);
      if (!check.approved.length) {
        const reason = (check.rejected[0] && check.rejected[0].reason) || "目标被拒绝";
        return send(response, 200, { ok: false, error: reason, rejected: check.rejected });
      }
      const target = check.approved[0];
      const pnpmCjs = findPnpm();
      if (!pnpmCjs) return send(response, 200, { ok: false, error: '找不到 pnpm，无法执行更新' });
      const snapshot = createSnapshot(dir, cfg);
      /* --ignore-scripts：不执行第三方包的生命周期脚本 */
      const r = await runPnpm(pnpmCjs, ['add', target.name + '@' + target.version, '--save-exact', '--ignore-scripts'], dir, 600000);
      const installed = verifyInstalled(dir, target.name, target.version);
      const v = classifyResult(r.code, installed, r.output);
      send(response, 200, {
        ok: v.ok,
        kind: v.kind,
        code: r.code,
        snapshot: snapshot.name,
        output: r.output.slice(-4000),
        needRestart: v.ok
      });
    } catch (e) { send(response, 200, { ok: false, error: String((e && e.message) || e) }); }
  }, { write: true });

  /* 只读：上次自动更新的结果 */
  reg('/dsh-plugin-snapshot/api/auto', async (request, response) => {
    try {
      send(response, 200, { ok: true, state: readAutoState(cfg) });
    } catch (e) { send(response, 200, { ok: false, error: String((e && e.message) || e) }); }
  });

  registerApplyAll({ reg, cfg, needProfile, send, readBody, createSnapshot, findPnpm, runPnpm });

  return () => { for (const off of offs) { try { off(); } catch (e) { /* 忽略 */ } } };
}

