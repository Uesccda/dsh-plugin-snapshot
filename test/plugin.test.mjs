/**
 * 插件自测：用 stub 顶替 @deepseek-ai/dsh-tools，在纯 Node 下验证
 *  - apply() 注册了三个工具；
 *  - 快照 create/list/restore 能真的跑通；
 *  - 诊断在缺少 node_modules 时给出可读结论而不是崩溃；
 *  - 版本检测在 mock registry 下按 lock 版本正确判定。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/* ---- 安装 stub：只在测试期存在 ---- */
const stubDir = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools');
mkdirSync(stubDir, { recursive: true });
writeFileSync(join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js' }), 'utf8');
writeFileSync(join(stubDir, 'index.js'), "export function defineTool(o) { return { ...o, __tool: true }; }\n", 'utf8');

const { apply } = await import('../lib/index.js');

function makeProfile() {
  const dir = mkdtempSync(join(tmpdir(), 'snap-prof-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { 'alpha-plugin': '1.0.0', 'beta-plugin': '^2.0.0' },
    dsh: { profile: { bundles: ['alpha-plugin'] } }
  }, null, 2), 'utf8');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'importers:\n  .:\n    dependencies:\n      alpha-plugin:\n        version: 1.0.0\n      beta-plugin:\n        version: 2.1.0\n', 'utf8');
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'allowBuilds:\n', 'utf8');
  const nm = join(dir, 'node_modules', 'alpha-plugin');
  mkdirSync(nm, { recursive: true });
  writeFileSync(join(nm, 'package.json'), JSON.stringify({
    name: 'alpha-plugin', version: '1.0.0',
    dsh: { compatibility: { dshReleases: { '0.2.2-rc.1': 'incompatible' } } }
  }), 'utf8');
  writeFileSync(join(nm, 'cordis.patch.yml'), '- insert:\n    - id: alpha-row\n      name: alpha-plugin\n', 'utf8');
  return dir;
}

import { validateInstallTargets } from '../lib/install-guard.js';
import { partitionByProbe } from '../lib/probe.js';
import { createSnapshot, restoreSnapshot, listSnapshots } from '../lib/snapshot.js';
import { mountRoutes } from '../lib/routes.js';
import { registerApplyAll } from '../lib/apply-all.js';
import { classifyResult } from '../lib/auto-update.js';
import { detectStoreDir } from '../lib/exec.js';

function makeCtx() {
  const tools = [];
  const ctx = {
    inject: (deps, fn) => fn({ tools: { register: (t) => { tools.push(t); return () => {}; } } }),
    /* effect 是 cordis 的副作用注册接口；桩里立即执行取到的清理函数，避免真实定时器 */
    effect: (fn) => { const dispose = typeof fn === 'function' ? fn() : null; return () => { if (typeof dispose === 'function') dispose(); }; },
    logger: { info: () => {} }
  };
  return { ctx, tools };
}

test('apply 注册三个工具', () => {
  const profile = makeProfile();
  const { ctx, tools } = makeCtx();
  apply(ctx, { profileDir: profile, dataDir: mkdtempSync(join(tmpdir(), 'snap-data-')) });
  assert.equal(tools.length, 3);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['plugin_doctor', 'plugin_snapshot', 'plugin_updates']);
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 20, t.name + ' 需要可读描述');
    assert.ok(t.parameters, t.name + ' 需要参数 schema');
    assert.equal(typeof t.execute, 'function');
  }
});

test('快照 create -> list -> restore', async () => {
  const profile = makeProfile();
  const dataDir = mkdtempSync(join(tmpdir(), 'snap-data-'));
  const { ctx, tools } = makeCtx();
  apply(ctx, { profileDir: profile, dataDir });
  const snap = tools.find((t) => t.name === 'plugin_snapshot');

  const created = await snap.execute({ action: 'create' });
  assert.ok(created.created);
  assert.ok(existsSync(join(dataDir, 'snapshots', created.created, 'package.json')));

  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'x', dependencies: {} }), 'utf8');

  const listed = await snap.execute({ action: 'list' });
  assert.equal(listed.snapshots.length, 1);
  assert.equal(listed.snapshots[0].hasManifest, true);

  const restored = await snap.execute({ action: 'restore', name: created.created });
  assert.ok(restored.restored.indexOf('package.json') >= 0);
  const back = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  assert.equal(back.name, 'dsh-profile-desktop');
  assert.deepEqual(restored.warnings, []);
});

test('诊断：明确不兼容必须判成 incompatible', async () => {
  const profile = makeProfile();
  const { ctx, tools } = makeCtx();
  apply(ctx, { profileDir: profile, dataDir: mkdtempSync(join(tmpdir(), 'snap-data-')) });
  const doc = tools.find((t) => t.name === 'plugin_doctor');
  const r = await doc.execute({ dshVersion: '0.2.2-rc.1' });
  assert.equal(r.summary.incompatible, 1);
  assert.equal(r.summary.missing, 1);           // beta-plugin 已声明但没装
  assert.ok(r.conflicts.some((c) => c.kind === 'compat' && c.severity === 'critical'));
  assert.ok(r.conflicts.some((c) => c.kind === 'missing'));
});

test('版本检测：按 lock 版本判定，预发布不自动跟进', async () => {
  const profile = makeProfile();
  const { ctx, tools } = makeCtx();
  apply(ctx, { profileDir: profile, dataDir: mkdtempSync(join(tmpdir(), 'snap-data-')) });
  const up = tools.find((t) => t.name === 'plugin_updates');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const name = String(url).split('/').slice(-2)[0];
    const table = {
      'alpha-plugin': '1.0.1',
      'beta-plugin': '3.0.0-beta.1'
    };
    const v = table[name];
    if (!v) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ version: v }) };
  };
  try {
    const r = await up.execute({});
    const alpha = r.items.find((x) => x.name === 'alpha-plugin');
    const beta = r.items.find((x) => x.name === 'beta-plugin');
    assert.equal(alpha.state, 'updatable');
    assert.equal(alpha.resolved, '1.0.0');
    assert.equal(alpha.candidate, '1.0.1');
    assert.equal(beta.state, 'prerelease');
    assert.equal(r.summary.updatable, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('非法快照名被拒绝', async () => {
  const profile = makeProfile();
  const { ctx, tools } = makeCtx();
  apply(ctx, { profileDir: profile, dataDir: mkdtempSync(join(tmpdir(), 'snap-data-')) });
  const snap = tools.find((t) => t.name === 'plugin_snapshot');
  await assert.rejects(() => snap.execute({ action: 'restore', name: '../escape' }), /快照名|非法/);
});


test('安装校验：拒绝未安装包、dist-tag、降级与预发布', () => {
  const profile = makeProfile();
  const r = validateInstallTargets(profile, [
    { name: 'not-installed-pkg', version: '1.0.0' },
    { name: 'alpha-plugin', version: 'latest' },
    { name: 'alpha-plugin', version: '0.0.1' },
    { name: 'alpha-plugin', version: '9.9.9-beta.1' }
  ]);
  assert.equal(r.approved.length, 0);
  assert.equal(r.rejected.length, 4);
});

test('安装校验：允许严格升级', () => {
  const profile = makeProfile();
  const r = validateInstallTargets(profile, [{ name: 'alpha-plugin', version: '9.9.9' }]);
  assert.equal(r.approved.length, 1);
  assert.equal(r.approved[0].name, 'alpha-plugin');
});

test('探针：返回 locked/fatal/runnable/skipped 四段结构', () => {
  const profile = makeProfile();
  const r = partitionByProbe(profile, ['alpha-plugin']);
  assert.ok(Array.isArray(r.locked));
  assert.ok(Array.isArray(r.fatal));
  assert.ok(Array.isArray(r.runnable));
  assert.ok(Array.isArray(r.skipped));
});

test('快照：恢复最旧一份时不因保留策略被删除', async () => {
  const profile = makeProfile();
  const cfg = { dataDir: mkdtempSync(join(tmpdir(), 'snap-keep-')), snapshotsKeep: 2 };
  const first = createSnapshot(profile, cfg);
  await new Promise((r) => setTimeout(r, 1050));
  createSnapshot(profile, cfg);
  const res = restoreSnapshot(profile, cfg, first.name);
  assert.ok(res.restored.length > 0);
  assert.ok(listSnapshots(cfg).some((x) => x.name === first.name));
});

test('路由：所有 handler 可调用，不抛 ReferenceError', async () => {
  const profile = makeProfile();
  const dataDir = mkdtempSync(join(tmpdir(), 'snap-rt-'));
  const handlers = new Map();
  const hostCtx = { webServer: { register: (o) => { handlers.set(o.path, o.handler); return () => {}; } } };
  const cfg = { dataDir, snapshotsKeep: 7, profileDir: profile };
  mountRoutes(hostCtx, cfg, () => profile);
  registerApplyAll({
    reg: (p, h) => handlers.set(p, h),
    cfg,
    needProfile: () => profile,
    send: (res, code, payload) => { res._payload = payload; },
    readBody: async () => ({}),
    createSnapshot: () => ({ name: 'test-snap' }),
    findPnpm: () => null
  });

  assert.ok(handlers.size >= 8, '路由数量应 >= 8，实际 ' + handlers.size);

  /* 用桩顶替网络，避免真连 registry */
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ version: '1.0.0' }) });
  const failures = [];
  try {
    for (const [path, handler] of handlers) {
      /* 只覆盖写接口：它们会写盘/装包，是崩溃代价最高的路径；只读接口会真查 registry，不适合单测 */
      if (!/apply|snapshot\//.test(path)) continue;
      const res = { headers: {}, statusCode: 0, setHeader() {}, end() {}, writableEnded: false, destroyed: false };
      /* readBody 靠 data/end 事件组装请求体：mock 必须真的触发 end，否则 Promise 永不 resolve */
      const req = {
        method: 'POST',
        headers: { 'x-dsh-snapshot': '1', 'content-type': 'application/json' },
        on(ev, cb) { if (ev === 'end') queueMicrotask(cb); },
        destroy() {}
      };
      try {
        await handler(req, res);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/is not defined|Cannot access .* before initialization/.test(msg)) {
          failures.push(path + ' -> ' + msg);
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(failures, [], '以下路由抛出未定义/未初始化错误：' + failures.join('; '));
});

test('判定：已装好时非致命错误码一律判成功（防误判回滚）', () => {
  const outputs = [
    'ERR_PNPM_IGNORED_BUILDS Ignored build scripts',
    'ERR_PNPM_PEER_DEP_ISSUES Unmet peer dependencies',
    'ERR_PNPM_UNEXPECTED_STORE',
    'ERR_PNPM_LOCKFILE_BREAKING_CHANGE',
    'EPERM: operation not permitted',
    ''
  ];
  for (const out of outputs) {
    const r = classifyResult(1, true, out);
    assert.equal(r.ok, true, '磁盘已到位却判失败: ' + out);
  }
});

test('判定：三个致命码即使磁盘到位也判失败', () => {
  for (const out of ['ERR_PNPM_NO_MATCHING_VERSION', 'ERR_PNPM_UNSUPPORTED_ENGINE', 'ERR_PNPM_FETCH_404']) {
    assert.equal(classifyResult(1, true, out).ok, false, out);
  }
});

test('判定：未装上时无论退出码都判失败', () => {
  assert.equal(classifyResult(0, false, '').ok, false);
  assert.equal(classifyResult(1, false, '').ok, false);
});

test('store 探测：带引号与无引号两种格式都能解析', () => {
  const BS = String.fromCharCode(92);
  const Q = String.fromCharCode(34);
  const mk = (content) => {
    const d = mkdtempSync(join(tmpdir(), 'store-'));
    mkdirSync(join(d, 'node_modules'), { recursive: true });
    writeFileSync(join(d, 'node_modules', '.modules.yaml'), content, 'utf8');
    return d;
  };
  const want = 'C:' + BS + 'u' + BS + 'store';
  const quoted = 'x: 1' + String.fromCharCode(10) + '  ' + Q + 'storeDir' + Q + ': ' + Q + 'C:' + BS + BS + 'u' + BS + BS + 'store' + Q + ',';
  const plain = 'storeDir: C:' + BS + 'u' + BS + 'store';
  assert.equal(detectStoreDir(mk(quoted)), want);
  assert.equal(detectStoreDir(mk(plain)), want);
  assert.equal(detectStoreDir(mk('other: 1')), null);
});
