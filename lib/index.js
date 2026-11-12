/**
 * dsh-plugin-snapshot — 插件快照、回滚与诊断。
 *
 * 设计边界（刻意保持窄）：
 *  - 只做三件事：检测可更新项、快照/回滚 profile 清单、静态诊断；
 *  - 不安装、不卸载、不启停插件——那是官方 plugin_manager 的职责，不重复实现；
 *  - 所有写操作只发生在自己的数据目录与 profile 的三份清单文件上。
 */
/*
 * defineTool 由宿主提供。这里做成「优先官方、缺失时降级」：
 * 一旦解析不到就整插件加载失败，代价远大于少一层参数校验。
 * 降级后工具仍按同一契约注册（name/description/parameters/output/execute），
 * 只是不再享受官方 schema 校验；正常情况下走的一定是官方实现。
 */
let defineTool;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch (e) {
  defineTool = null;
}
if (typeof defineTool !== 'function') {
  /* 宿主未提供 @deepseek-ai/dsh-tools 时降级为恒等函数：工具仍会注册，但不做 schema 校验。至少留一条日志。 */
  console.warn('[dsh-plugin-snapshot] 未加载到 @deepseek-ai/dsh-tools，工具定义降级为恒等映射（无 schema 校验）');
  defineTool = (options) => options;
}
import { resolveProfileDir, readProfile } from './profile.js';
import { createSnapshot, listSnapshots, restoreSnapshot } from './snapshot.js';
import { checkUpdates } from './updates.js';
import { scanPlugins, detectConflicts, priorityOf } from './doctor.js';
import { mountRoutes } from './routes.js';
import { runAutoUpdate } from './auto-update.js';
import { Logger, dataDir } from './util.js';

export const name = 'dsh-plugin-snapshot';

export const inject = ['tools'];

const TOOL = {
  updates: 'plugin_updates',
  snapshot: 'plugin_snapshot',
  doctor: 'plugin_doctor'
};

function makeCtx(config) {
  const cfg = config || {};
  /* 透传用户的全部配置，再对已知字段做归一化。
     审查发现：早期实现只挑 6 个字段复制，导致 autoExclude / autoUpdateScope 全部丢失，
     用户在配置里写什么都无效。 */
  return Object.assign({}, cfg, {
    profileDir: cfg.profileDir || '',
    registry: cfg.registry || '',
    dataDir: cfg.dataDir || dataDir(),
    snapshotsKeep: Number(cfg.snapshotsKeep) > 0 ? Number(cfg.snapshotsKeep) : 7,
    concurrency: Number(cfg.concurrency) > 0 ? Number(cfg.concurrency) : 8,
    /* 默认关闭：安装本插件不应静默修改整个 profile 的依赖树 */
    /* 配置可能来自 JSON5/YAML，写成字符串 "true" 时也应生效 */
    autoUpdate: cfg.autoUpdate === true || String(cfg.autoUpdate).toLowerCase() === 'true',
    autoUpdateScope: cfg.autoUpdateScope || 'patch',
    autoExclude: Array.isArray(cfg.autoExclude) ? cfg.autoExclude : [],
    logger: new Logger()
  });
}

function needProfile(cfg) {
  const dir = resolveProfileDir(cfg);
  if (!dir) {
    throw new Error('没能定位 DSH profile 目录。可在插件配置里指定 profileDir，或设置 DSH_PROFILE_DIR 环境变量。');
  }
  return dir;
}

function renderLines(title, lines) {
  return [{ type: 'text', text: title + '\n' + lines.join('\n') }];
}

export function apply(ctx, config) {
  const cfg = makeCtx(config);

  ctx.inject(['tools'], (sctx) => {
    sctx.tools.register(defineTool({
      name: TOOL.updates,
      description: 'List DeepSeek Harness profile plugins that have a newer npm version. Read-only: compares the version resolved in pnpm-lock.yaml with the registry, and never installs anything. Returns per-plugin state (updatable / major / uptodate / prerelease / failed) plus a summary.',
      parameters: {
        registry: { type: 'string', description: 'npm registry to query. Defaults to the plugin config, DSH_REGISTRY, or registry.npmjs.org.' },
        onlyUpdatable: { type: 'boolean', description: 'When true, return only items that have a newer version.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            profile: { type: 'string' },
            registry: { type: 'string' },
            summary: {
              type: 'object',
              additionalProperties: false,
              properties: {
                total: { type: 'number' },
                updatable: { type: 'number' },
                major: { type: 'number' },
                uptodate: { type: 'number' },
                failed: { type: 'number' },
                skipped: { type: 'number' }
              }
            },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  declared: { type: 'string' },
                  resolved: { type: 'string' },
                  candidate: { type: 'string' },
                  state: { type: 'string' },
                  reason: { type: 'string' }
                }
              }
            }
          }
        },
        render(args, value) {
          const s = value.summary || {};
          const rows = (value.items || []).map((x) => '- ' + x.name + '  ' + (x.resolved || x.declared || '?') + ' -> ' + (x.candidate || '-') + '  [' + x.state + ']' + (x.reason ? ' ' + x.reason : ''));
          return renderLines('Plugin updates (profile: ' + value.profile + ', registry: ' + value.registry + ')', [
            'total ' + s.total + ' | updatable ' + s.updatable + ' | major ' + s.major + ' | uptodate ' + s.uptodate + ' | failed ' + s.failed,
            ...(rows.length ? rows : ['- nothing to show'])
          ]);
        }
      },
      async execute(args) {
        const a = args || {};
        /* 不改 cfg：registry 是单次调用的参数，写回会永久污染后续调用与自动更新 */
        const localCfg = a.registry ? Object.assign({}, cfg, { registry: String(a.registry) }) : cfg;
        const dir = needProfile(localCfg);
        localCfg.logger.info('check updates in ' + dir);
        const r = await checkUpdates(dir, localCfg);
        const items = a.onlyUpdatable ? r.items.filter((x) => x.state === 'updatable') : r.items;
        return { profile: r.profile, registry: r.registry, summary: r.summary, items: items.map((x) => ({
          name: x.name, declared: x.declared, resolved: x.resolved || '', candidate: x.candidate || '', state: x.state, reason: x.reason || ''
        })) };
      }
    }));

    sctx.tools.register(defineTool({
      name: TOOL.snapshot,
      description: 'Create, list or restore a snapshot of the current DSH profile manifests (package.json, pnpm-lock.yaml, pnpm-workspace.yaml). Snapshots live in the plugin data directory, carry an identity fingerprint and per-file hashes, and are the recovery point to use before upgrading plugins. Actions: create / list / restore.',
      parameters: {
        action: { type: 'string', enum: ['create', 'list', 'restore'], description: 'create a snapshot, list existing ones, or restore a named one.' },
        name: { type: 'string', description: 'Snapshot name for action=restore, as returned by action=list.' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string' },
            created: { type: 'string' },
            restored: { type: 'array', items: { type: 'string' } },
            warnings: { type: 'array', items: { type: 'string' } },
            snapshots: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  createdAt: { type: 'string' },
                  deps: { type: 'number' },
                  hasManifest: { type: 'boolean' }
                }
              }
            }
          }
        },
        render(args, value) {
          if (value.action === 'list') {
            const rows = (value.snapshots || []).map((s) => '- ' + s.name + '  ' + s.createdAt + '  deps ' + s.deps + (s.hasManifest ? '' : '  (无 manifest)'));
            return renderLines('Snapshots', rows.length ? rows : ['- 还没有快照']);
          }
          if (value.action === 'restore') {
            return renderLines('Restored from ' + value.created, [
              'files: ' + (value.restored || []).join(', '),
              ...(value.warnings || []).map((w) => 'warning: ' + w)
            ]);
          }
          return renderLines('Snapshot created: ' + value.created, ['先记下这个名字，回滚时用它。']);
        }
      },
      async execute(args) {
        const a = args || {};
        const dir = needProfile(cfg);
        const action = String(a.action || 'list');
        if (action === 'list') {
          const list = listSnapshots(cfg).map((s) => ({
            name: s.name,
            createdAt: new Date(s.mtime).toISOString(),
            deps: s.deps,
            hasManifest: !!s.hasManifest
          }));
          return { action: 'list', snapshots: list };
        }
        if (action === 'create') {
          const s = createSnapshot(dir, cfg);
          cfg.logger.info('snapshot created: ' + s.name);
          return { action: 'create', created: s.name };
        }
        if (action === 'restore') {
          const nm = String(a.name || '').trim();
          if (!nm) throw new Error('action=restore 需要提供 name（先执行 action=list 查看）');
          const r = restoreSnapshot(dir, cfg, nm);
          cfg.logger.warn('snapshot restored: ' + nm);
          return { action: 'restore', created: r.from, restored: r.restored, warnings: r.warnings };
        }
        throw new Error('未知 action: ' + action + '（可用 create / list / restore）');
      }
    }));

    sctx.tools.register(defineTool({
      name: TOOL.doctor,
      description: 'Static diagnostic of installed DeepSeek Harness plugins: declared vs installed vs enabled state, DSH version compatibility as declared by the author (explicit incompatible is reported as incompatible, never as compatible), duplicate cordis.patch.yml ids, native modules and unparseable manifests. Read-only; findings are static evidence, not runtime verification.',
      parameters: {
        dshVersion: { type: 'string', description: 'DSH version to judge compatibility against. Defaults to DSH_VERSION env or unknown.' },
        limit: { type: 'number', description: 'Max conflicts to return (default 30).' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            profile: { type: 'string' },
            dshVersion: { type: 'string' },
            summary: {
              type: 'object',
              additionalProperties: false,
              properties: {
                installed: { type: 'number' },
                enabled: { type: 'number' },
                missing: { type: 'number' },
                incompatible: { type: 'number' },
                untested: { type: 'number' },
                native: { type: 'number' }
              }
            },
            conflicts: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  severity: { type: 'string' },
                  kind: { type: 'string' },
                  message: { type: 'string' }
                }
              }
            },
            topPriority: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  score: { type: 'number' },
                  level: { type: 'string' }
                }
              }
            }
          }
        },
        render(args, value) {
          const s = value.summary || {};
          const head = 'installed ' + s.installed + ' | enabled ' + s.enabled + ' | missing ' + s.missing + ' | incompatible ' + s.incompatible + ' | untested ' + s.untested + ' | native ' + s.native;
          const rows = (value.conflicts || []).map((c) => '- [' + c.severity + '] ' + c.kind + ': ' + c.message);
          return renderLines('Plugin diagnostic (profile: ' + value.profile + ', DSH ' + value.dshVersion + ')', [head, ...(rows.length ? rows : ['- 未发现已知冲突'])]);
        }
      },
      async execute(args) {
        const a = args || {};
        const dir = needProfile(cfg);
        const dshVersion = String(a.dshVersion || process.env.DSH_VERSION || 'unknown');
        const scan = scanPlugins(dir, dshVersion);
        const conflicts = detectConflicts(scan.items);
        const prior = scan.items
          .map((it) => ({ name: it.name, ...priorityOf(it, conflicts) }))
          .sort((x, y) => y.score - x.score)
          .slice(0, 5)
          .map((x) => ({ name: x.name, score: x.score, level: x.level }));
        const limit = Math.max(1, Math.min(Number(a.limit) || 30, 200));
        const summary = {
          installed: scan.items.filter((x) => x.installed !== false).length,
          enabled: scan.items.filter((x) => x.enabled).length,
          missing: scan.items.filter((x) => x.installed === false).length,
          incompatible: scan.items.filter((x) => (x.compatibility || {}).state === 'incompatible').length,
          untested: scan.items.filter((x) => (x.compatibility || {}).state === 'untested').length,
          native: scan.items.filter((x) => x.hasNative).length
        };
        return {
          profile: scan.profile,
          dshVersion,
          summary,
          conflicts: conflicts.slice(0, limit).map((c) => ({ severity: c.severity, kind: c.kind, message: c.message })),
          topPriority: prior
        };
      }
    }));

        /* 设置页 UI 通过同源 HTTP 取数据：客户端不能直接调工具，只能走路由 */
    ctx.inject(['webServer'], (hostCtx) => {
      try {
        mountRoutes(hostCtx, cfg, needProfile);
        ctx.logger?.info?.('[dsh-plugin-snapshot] panel routes mounted');
      } catch (e) {
        ctx.logger?.warn?.('[dsh-plugin-snapshot] panel routes failed: ' + String((e && e.message) || e));
      }
    });
    /* 自动更新默认不启用。只有配置里显式写 autoUpdate: true 才会注册定时器，
       避免「装一个快照工具，45 秒后它静默改了整个依赖树」。
       启用后的策略：默认仅补丁版、不自动重启、失败回滚到更新前的快照。 */
    if (cfg.autoUpdate === true) {
      ctx.effect(() => {
        const autoTimer = setTimeout(() => {
          runAutoUpdate(cfg, needProfile, cfg.logger).catch(() => {});
        }, 45000);
        return () => clearTimeout(autoTimer);
      }, 'dsh-plugin-snapshot: auto update');
      ctx.logger?.info?.('[dsh-plugin-snapshot] 自动更新已启用，scope=' + cfg.autoUpdateScope);
    } else {
      ctx.logger?.info?.('[dsh-plugin-snapshot] 自动更新未启用（配置 autoUpdate: true 可开启）');
    }

ctx.logger?.info?.('[dsh-plugin-snapshot] tools registered on ' + needProfileSafe(cfg));
  });

  function needProfileSafe(c) {
    try { return resolveProfileDir(c) || '(未定位)'; } catch (e) { return '(未定位)'; }
  }
}

