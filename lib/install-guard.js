/**
 * 安装目标校验。
 *
 * 审查发现的问题：写接口只校验包名/版本号格式，因此可以安装任意 npm 包、
 * 可以降级、可以装 dist-tag（latest / next），与「不做安装」的边界声明矛盾。
 *
 * 这里收紧为：
 *   1) 包必须已在 profile.dependencies 中（拒绝新增依赖）；
 *   2) 版本必须是精确的语义化版本（拒绝 latest / next 等 dist-tag）；
 *   3) 拒绝预发布版本；
 *   4) 目标版本必须严格高于当前版本（拒绝降级与重复安装）。
 */
import { readProfile, readLockVersions } from './profile.js';
import { parseSemver, cmpSemver, isValidPkgName } from './util.js';

/** 精确版本：1.2.3 / 1.2.3-beta.1 / 1.2.3+build */
const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function validateInstallTargets(profileDir, items) {
  const approved = [];
  const rejected = [];

  let deps = {};
  let lock = {};
  try { deps = readProfile(profileDir).deps || {}; } catch (e) { deps = {}; }
  try { lock = readLockVersions(profileDir) || {}; } catch (e) { lock = {}; }

  for (const it of items || []) {
    const name = String((it && it.name) || '');
    const version = String((it && it.version) || '');
    const push = (reason) => rejected.push({ name, version, reason });

    if (!isValidPkgName(name)) { push('非法包名'); continue; }
    if (!EXACT.test(version)) { push('版本号必须是精确语义化版本，不接受 dist-tag'); continue; }
    if (!Object.prototype.hasOwnProperty.call(deps, name)) { push('该包不在 profile 依赖中，拒绝新增'); continue; }

    const curStr = String(lock[name] || deps[name]);
    const next = parseSemver(version);
    if (!next) { push('目标版本 ' + version + ' 无法解析'); continue; }
    if (!parseSemver(curStr)) { push('当前声明 ' + curStr + ' 无法解析，无法判定升级方向'); continue; }
    if (next.pre) { push('拒绝预发布版本'); continue; }
    const cmp = cmpSemver(version, curStr);
    if (cmp === null) { push('版本号无法解析'); continue; }
    if (cmp <= 0) { push('目标版本不高于当前安装版本，拒绝降级/重复安装'); continue; }

    approved.push({ name, version });
  }

  return { approved, rejected };
}

