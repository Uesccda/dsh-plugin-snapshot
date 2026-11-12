/**
 * 应急恢复：把最新快照的三份清单写回 profile。
 * 不依赖 DSH 运行，也不依赖插件代码——只读文件系统。
 * 被 restore-latest.bat 调用。
 */
import { existsSync, readdirSync, readFileSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SNAP_TS = /^[0-9]{8}-[0-9]{6}(-[0-9]+)?$/;
const FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

/* 1) 定位 profile：优先 desktop，否则取 .dsh/profiles 下第一个有 package.json 的目录 */
const profilesRoot = join(homedir(), '.dsh', 'profiles');
let profileDir = join(profilesRoot, 'desktop');
if (!existsSync(join(profileDir, 'package.json'))) {
  let cands = [];
  try {
    cands = readdirSync(profilesRoot)
      .map((n) => join(profilesRoot, n))
      .filter((p) => existsSync(join(p, 'package.json')));
  } catch (e) { cands = []; }
  if (cands.length) profileDir = cands[0];
}
console.log('profile: ' + profileDir);
if (!existsSync(join(profileDir, 'package.json'))) {
  console.log('未找到任何 profile，已中止');
  process.exit(1);
}

/* 2) 找最新快照 */
const snapRoot = join(homedir(), '.dsh-plugin-snapshot', 'snapshots');
if (!existsSync(snapRoot)) { console.log('没有快照目录'); process.exit(1); }
const snaps = readdirSync(snapRoot)
  .filter((d) => SNAP_TS.test(d))
  .map((d) => ({ d, t: statSync(join(snapRoot, d)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
if (!snaps.length) { console.log('没有可用快照'); process.exit(1); }

const latest = snaps[0].d;
const src = join(snapRoot, latest);
console.log('快照: ' + latest);

/* 3) 逐文件原子替换 */
let n = 0;
for (const f of FILES) {
  const from = join(src, f);
  if (!existsSync(from)) continue;
  const to = join(profileDir, f);
  const tmp = to + '.restore-' + Date.now();
  copyFileSync(from, tmp);
  try {
    const { renameSync } = await import('node:fs');
    renameSync(tmp, to);
  } catch (e) {
    copyFileSync(tmp, to);
  }
  n++;
  console.log('  恢复 ' + f);
}
console.log('完成：' + n + ' 个文件');
if (n === 0) process.exit(1);
