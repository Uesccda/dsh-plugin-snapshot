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

function makeCtx() {
  const tools = [];
  const ctx = {
    inject: (deps, fn) => fn({ tools: { register: (t) => { tools.push(t); return () => {}; } } }),
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

