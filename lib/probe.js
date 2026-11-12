/**
 * 占用探针：判断待更新的包是否正被运行中的 DSH 锁住。
 *
 * 为什么要探：Windows 上 pnpm 替换包的实际动作是「整目录 rename」，
 * 只要树内任意一个文件被「无删除共享」打开（已加载的 .node、被写开的数据文件），
 * 整树 rename 就会失败。逐包更新时一旦撞上，前面的包已经写盘，后面的还没动，
 * 只能整轮回退——探针的价值是提前把这几个包从计划里剔掉，避免白跑。
 *
 * 两种探测组合使用：
 *   1) 目录级：把包目录 rename 到临时名再改回。最接近 pnpm 的真实动作。
 *   2) 文件级：对 .node 做 open('r+')。捕获「目录可改名但原生模块被加载」的情况。
 *
 * 安全约定：目录 rename 成功后必须回滚；回滚失败会重试一次，
 * 仍然失败则记 RESTORE_FAILED 并以只读方式报警（此时包目录停留在临时名）。
 */
import { existsSync, readdirSync, renameSync, openSync, closeSync, statSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';

const MAX_DEPTH = 3;
const MAX_FILES = 200;

function findNodeFiles(dir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let items = [];
  try { items = readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of items) {
    if (out.length >= MAX_FILES) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.bin') continue;
      findNodeFiles(p, depth + 1, out);
    } else if (e.isFile() && e.name.endsWith('.node')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 探测一组包是否被占用。
 * @param {string} profileDir profile 目录
 * @param {string[]} names 要探测的包名
 * @returns {{name:string, code:string, at:string}[]} 被占用的条目
 */
export function probeLocked(profileDir, names) {
  const locked = [];
  const stamp = Date.now().toString(36);

  for (const name of names) {
    const pkgDir = join(profileDir, 'node_modules', ...String(name).split('/'));
    if (!existsSync(pkgDir)) continue;
    /* pnpm 下 scoped 包常是 symlink：对它 rename 在部分平台会 EPERM，造成误报占用。
       这种情况跳过目录级探测，只做 .node 文件级探测。 */
    let isLink = false;
    try { isLink = lstatSync(pkgDir).isSymbolicLink(); } catch (e) { isLink = false; }
    if (isLink) {
      const nodes2 = findNodeFiles(pkgDir, 0, []);
      for (const f of nodes2) {
        try { const fd = openSync(f, 'r+'); closeSync(fd); }
        catch (e) { locked.push({ name, code: e.code || 'OPEN_FAILED', at: 'node:' + basename(f) }); break; }
      }
      continue;
    }

    /* ---- 1) 目录级 rename 探测 ---- */
    const tmp = pkgDir + '.__probe_' + stamp;
    let renamed = false;
    try {
      renameSync(pkgDir, tmp);
      renamed = true;
    } catch (e) {
      locked.push({ name, code: e.code || 'RENAME_FAILED', at: 'dir' });
      continue;
    }

    /* 必须还原：还原失败重试一次，再失败就记下来 */
    try {
      renameSync(tmp, pkgDir);
    } catch (e) {
      try {
        renameSync(tmp, pkgDir);
      } catch (e2) {
        /* 目录停在临时名 = 包已损坏，必须让上层中止本轮并告警，不能当成「跳过」 */
        locked.push({ name, code: 'RESTORE_FAILED', at: 'dir', fatal: true, tmpPath: tmp });
        continue;
      }
    }
    if (!renamed) continue;

    /* ---- 2) .node 文件读写探测 ---- */
    const nodes = findNodeFiles(pkgDir, 0, []);
    for (const f of nodes) {
      try {
        const fd = openSync(f, 'r+');
        closeSync(fd);
      } catch (e) {
        locked.push({ name, code: e.code || 'OPEN_FAILED', at: 'node:' + basename(f) });
        break;
      }
    }
  }

  return locked;
}

/** 探测并返回可执行 / 需跳过的两个集合 */
export function partitionByProbe(profileDir, names) {
  const locked = probeLocked(profileDir, names);
  const fatal = locked.filter((x) => x.fatal === true);
  const blocked = new Set(locked.map((x) => x.name));
  return {
    locked,
    fatal,
    runnable: names.filter((n) => !blocked.has(n)),
    skipped: names.filter((n) => blocked.has(n))
  };
}

