/**
 * 自动更新：DSH 启动后检查一次，逐包安装，退出码不可信，失败分层回退。
 *
 * 这一版的执行模型对齐桌面工具 v3.2.6 的升级链路：
 *   - 逐包执行：单包失败不影响其余，天然支持部分成功；
 *   - 退出码四态判定：回读 node_modules 里的真实版本，不信 pnpm 的退出码；
 *   - 瞬时失败重试一次（8 秒），确定性失败不重试；
 *   - 分层回退：部分成功走包级回退，全失败走整体恢复，恢复失败就停手。
 *
 * 插件形态做不到的那一条：EPERM 后关闭 DSH 再重试——关掉 DSH 等于自杀。
 * 这种情况会如实标为 failed 并提示需要手动关闭后重试。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkUpdates } from './updates.js';
import { createSnapshot, restoreSnapshot, revertPackages } from './snapshot.js';
import { parseSemver, atomicWrite, dataDir, tsStr } from './util.js';
import { findPnpm, runPnpm } from './exec.js';
import { partitionByProbe } from './probe.js';

const FILE = 'auto-update.json';

/** 网络类瞬时失败：值得再试一次 */
const TRANSIENT = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Tarball|ERR_PNPM_FETCH(?!_404)/i;
/** 确定性失败：重试不会改变结果，直接放弃 */
const DETERMINISTIC = /Unable to detect compiler type|ERR_PNPM_UNSUPPORTED_ENGINE|ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_FETCH_404|404 Not Found|ERR_PNPM_OUTDATED_LOCKFILE/i;
/** 已知无害的退出码 1：构建脚本被忽略，但文件已到位 */

export function statePath(cfg) {
  const base = (cfg && cfg.dataDir) ? cfg.dataDir : dataDir();
  return join(base, FILE);
}

export function readAutoState(cfg) {
  try { return JSON.parse(readFileSync(statePath(cfg), 'utf8')); }
  catch (e) { return null; }
}

function writeAutoState(cfg, patch) {
  const next = Object.assign({ updatedAt: Date.now(), updatedAtText: tsStr() }, patch);
  try { atomicWrite(statePath(cfg), JSON.stringify(next, null, 2)); } catch (e) { /* 记录失败不影响主流程 */ }
  return next;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 判定候选版本是否在允许的升级档位内；预发布永不自动安装 */
export function isAllowedLevel(resolved, candidate, scope) {
  const a = parseSemver(resolved);
  const b = parseSemver(candidate);
  if (!a || !b) return false;
  if (b.pre) return false;
  const s = scope || 'patch';
  if (s === 'patch') return a.major === b.major && a.minor === b.minor && b.patch > a.patch;
  if (s === 'minor') {
    if (a.major !== b.major) return false;
    if (b.minor > a.minor) return true;
    return b.minor === a.minor && b.patch > a.patch;
  }
  return b.major > a.major || b.minor > a.minor || b.patch > a.patch;
}

/** 兼容旧名 */
export function isPatchLevel(resolved, candidate) {
  return isAllowedLevel(resolved, candidate, 'patch');
}

/** 回读磁盘上的真实版本——这是「退出码不可信」的落地方式 */
export function verifyInstalled(dir, name, want) {
  try {
    const p = join(dir, 'node_modules', ...String(name).split('/'), 'package.json');
    const v = JSON.parse(readFileSync(p, 'utf8')).version;
    if (String(v) === String(want)) return true;
    /* 忽略 build metadata：pnpm 可能把 1.2.3+build9 规范化成 1.2.3 */
    const a = parseSemver(v);
    const b = parseSemver(want);
    if (!a || !b) return false;
    if (a.major !== b.major || a.minor !== b.minor || a.patch !== b.patch) return false;
    return String(a.pre || '') === String(b.pre || '');
  } catch (e) { return false; }
}

/**
 * 四态判定：把退出码与磁盘版本交叉。
 *   0/到位        → 成功
 *   0/未到位      → 失败（可能被缓存跳过）
 *  ≠0/到位 + 仅构建脚本告警 → 成功 + 警告
 *  ≠0/到位 + 其他错误 → 「安装结果未知」，按失败处理
 *  ≠0/未到位     → 失败
 */
export function classifyResult(exitCode, installed, output) {
  const out = String(output || '');
  if (exitCode === 0 && installed) return { ok: true, kind: "success" };
  if (exitCode === 0 && !installed) return { ok: false, kind: "cache-skip" };
  if (exitCode !== 0 && installed) {
    /* 磁盘版本到位 = 目标达成，这是唯一可信的判据。
       只有「目标包根本没装上」类错误才判失败。
       不要用白名单反向枚举：PEER_DEP_ISSUES、EPERM、超时后输出为空、
       LOCKFILE_BREAKING_CHANGE 都会命中——而那时包其实已经装好了。 */
    if (/ERR_PNPM_NO_MATCHING_VERSION|ERR_PNPM_UNSUPPORTED_ENGINE|ERR_PNPM_FETCH_404|404 Not Found/i.test(out)) {
      return { ok: false, kind: "unverified" };
    }
    return { ok: true, kind: "warn", warning: "退出码非 0，但磁盘版本已到位" };
  }
  return { ok: false, kind: "failed" };
}

/** 输出里是否只有「构建脚本被忽略」这类无害告警 */
export function onlyBenignBuildWarnings(output) {
  const out = String(output || '');
  /* 白名单判定：只认已知无害的 pnpm 错误码，其余一律判失败。
     早期实现是黑名单 + 末行无条件 return true，任何未知错误码都会被吞成成功。 */
  const benign = ["ERR_PNPM_IGNORED_BUILDS", "ERR_PNPM_APPROVE_SCRIPTS", "ERR_PNPM_WARN_ONLY"];
  const codes = out.match(/ERR_PNPM_[A-Z_]+/g) || [];
  if (codes.some((c) => benign.indexOf(c) < 0)) return false;
  /* 没有 pnpm 错误码时，只有明确的「构建脚本被忽略」提示才算无害 */
  if (codes.length === 0) return /Ignored build scripts/i.test(out);
  return true;
}

/** 装一个包：执行 → 校验 → 瞬时失败重试一次 → 四态判定 */
export async function applyOne(dir, pnpmCjs, t, logger) {
  const spec = t.name + '@' + t.candidate;
  const once = async () => {
    const r = await runPnpm(pnpmCjs, ['add', spec, '--save-exact', '--ignore-scripts'], dir, 900000);
    const installed = verifyInstalled(dir, t.name, t.candidate);
    return { code: r.code, output: r.output, installed, timedOut: r.timedOut === true };
  };

  /* 三次退避：registry 抖动往往持续几十秒，单次 8 秒不够 */
  const DELAYS = [8000, 30000, 90000];
  let res = await once();
  let verdict = classifyResult(res.code, res.installed, res.output);

  for (let i = 0; i < DELAYS.length && !verdict.ok; i++) {
    if (!TRANSIENT.test(res.output) || DETERMINISTIC.test(res.output)) break;
    if (logger) logger.warn('[auto] ' + t.name + ' 瞬时失败，' + (DELAYS[i] / 1000) + ' 秒后第 ' + (i + 1) + ' 次重试');
    await sleep(DELAYS[i]);
    res = await once();
    verdict = classifyResult(res.code, res.installed, res.output);
  }

  return Object.assign({}, t, verdict, {
    exitCode: res.code,
    timedOut: res.timedOut === true,
    output: String(res.output).slice(-1200)
  });
}

/**
 * 跑一次自动更新。
 * @returns {Promise<object>} 结果对象，同时写入 auto-update.json
 */
export async function runAutoUpdate(cfg, needProfile, logger) {
  const started = Date.now();
  let dir;
  try {
    dir = needProfile(cfg);
  } catch (e) {
    return writeAutoState(cfg, { outcome: 'error', error: String((e && e.message) || e), durationMs: Date.now() - started });
  }

  let report;
  try {
    report = await checkUpdates(dir, cfg);
  } catch (e) {
    return writeAutoState(cfg, { outcome: 'error', error: String((e && e.message) || e), durationMs: Date.now() - started });
  }

  const exclude = Array.isArray(cfg && cfg.autoExclude) ? cfg.autoExclude : [];
  const targets = (report.items || []).filter((x) => {
    if (exclude.indexOf(x.name) >= 0) return false;
    if (x.state !== 'updatable') return false;
    return isAllowedLevel(x.resolved || x.declared, x.candidate, cfg && cfg.autoUpdateScope);
  });

  if (!targets.length) {
    return writeAutoState(cfg, {
      outcome: 'no-update',
      checked: (report.items || []).length,
      durationMs: Date.now() - started
    });
  }

  const pnpmCjs = findPnpm();
  if (!pnpmCjs) {
    return writeAutoState(cfg, { outcome: 'error', error: '找不到 pnpm', targets: targets.map((t) => t.name) });
  }

  /* 占用探测：把正被 DSH 锁住的包从本轮计划里剔掉，避免装到一半才失败 */
  const probe = partitionByProbe(dir, targets.map((x) => x.name));
  const runnable = targets.filter((x) => probe.runnable.indexOf(x.name) >= 0);
  if (probe.fatal && probe.fatal.length) {
    /* 探针回滚失败：包目录已停留在临时名，本轮必须中止且明确告警 */
    if (logger) logger.error("[auto] 探针回滚失败，已中止本轮: " + JSON.stringify(probe.fatal));
    return writeAutoState(cfg, {
      outcome: "probe-damaged",
      fatal: probe.fatal,
      durationMs: Date.now() - started
    });
  }
  if (!runnable.length) {
    if (logger) logger.warn("[auto] 全部目标都被占用，本次跳过");
    return writeAutoState(cfg, {
      outcome: "locked-abort",
      locked: probe.locked,
      blockedCount: targets.length,
      durationMs: Date.now() - started
    });
  }
  if (probe.locked.length && logger) {
    logger.warn("[auto] 跳过被占用的 " + probe.locked.length + " 个: " + probe.locked.map((x) => x.name).join(", "));
  }

  let snapshot;
  try {
    snapshot = createSnapshot(dir, cfg);
  } catch (e) {
    return writeAutoState(cfg, { outcome: 'error', error: '快照失败，已放弃本次自动更新：' + String((e && e.message) || e) });
  }

  if (logger) logger.info('[auto] 开始逐包更新 ' + runnable.length + ' 个，快照 ' + snapshot.name);

  const results = [];
  for (const t of runnable) {
    try {
      results.push(await applyOne(dir, pnpmCjs, t, logger));
    } catch (e) {
      results.push(Object.assign({}, t, { ok: false, kind: 'threw', error: String((e && e.message) || e) }));
    }
  }

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  /* ---- 分层回退 ---- */
  let recovery = 'none';
  if (failed.length && succeeded.length) {
    /* 部分成功：只把失败包的版本号改回去，成功的保留 */
    const names = failed.map((f) => f.name);
    const reverted = revertPackages(dir, cfg, snapshot.name, names);
    /* 回退数量对不上（例如失败包不在任何依赖节里）时不能声称「已包级回退」 */
    const level = reverted.length === names.length ? 'package-level' : 'package-level-partial';
    if (logger) logger.warn('[auto] 部分成功，包级回退 ' + reverted.length + '/' + names.length + ' 个');
    const inst = await runPnpm(pnpmCjs, ['install', '--no-frozen-lockfile', '--ignore-scripts'], dir, 600000);
    const instOk = inst.code === 0 || onlyBenignBuildWarnings(inst.output);
    recovery = instOk ? level : level + '-install-failed';
  } else if (failed.length && !succeeded.length) {
    /* 全部失败：整体恢复 */
    try {
      restoreSnapshot(dir, cfg, snapshot.name);
      recovery = 'full';
      /* 清单回退了，磁盘也必须回退 —— 否则是「清单旧、node_modules 新」的假回滚 */
      const inst1 = await runPnpm(pnpmCjs, ['install', '--frozen-lockfile', '--ignore-scripts'], dir, 900000);
      if (inst1.code !== 0) {
        const inst2 = await runPnpm(pnpmCjs, ['install', '--no-frozen-lockfile', '--ignore-scripts'], dir, 900000);
        if (inst2.code !== 0) recovery = 'full-manifest-only';
      }
      if (logger) logger.warn('[auto] 全部失败，已整体恢复快照 ' + snapshot.name);
    } catch (e) {
      recovery = 'full-failed';
      if (logger) logger.error('[auto] 整体恢复失败，需人工介入：' + String((e && e.message) || e));
    }
  }

  const outcome = failed.length === 0
    ? 'updated'
    : (succeeded.length > 0 ? 'partial' : (recovery === 'full' ? 'failed-rolled-back' : 'failed-rollback-error'));

  const state = writeAutoState(cfg, {
    outcome,
    snapshot: snapshot.name,
    recovery,
    count: succeeded.length,
    failedCount: failed.length,
    skippedLocked: probe.locked,
    succeeded: succeeded.map((r) => ({ name: r.name, version: r.candidate, kind: r.kind })),
    failed: failed.map((r) => ({ name: r.name, version: r.candidate, kind: r.kind, exitCode: r.exitCode, output: r.output })),
    needRestart: succeeded.length > 0,
    durationMs: Date.now() - started
  });

  if (logger) logger.info('[auto] 结束: ' + outcome + '，成功 ' + succeeded.length + '，失败 ' + failed.length);
  return state;
}

