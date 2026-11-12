/**
 * 执行外部命令：定位 pnpm 并用受控参数调用。
 *
 * 注意：本文件是 ESM，不能出现 require（那会在运行时抛错并被 catch 吞掉，
 * 表现为「找不到 pnpm」）。
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 传给 pnpm 子进程的环境变量白名单：剔除 NPM_TOKEN 等凭据 */
const SAFE_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NPM_CONFIG_REGISTRY', 'npm_config_registry',
  'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig', 'NPM_CONFIG_CACHE', 'npm_config_cache', 'COREPACK_HOME'
];

function safeEnv() {
  const out = {};
  for (const k of SAFE_ENV) { if (process.env[k] !== undefined) out[k] = process.env[k]; }
  out.ELECTRON_RUN_AS_NODE = '1';
  return out;
}

/** 定位 pnpm 的 JS 入口：优先 DSH 运行时，其次 profile 自带的 */
export function findPnpm() {
  const cands = [];
  try {
    const base = join(homedir(), '.dsh', 'dsh-runtimes');
    for (const name of readdirSync(base)) {
      cands.push(join(base, name, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'));
    }
  } catch (e) { /* 没有 runtimes 目录 */ }
  cands.push(join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'));
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

/**
 * 从 node_modules/.modules.yaml 读 pnpm 的实际 store 目录。
 * 不传 --store-dir 时 pnpm 会用自己的默认 store，与已装的 node_modules 不匹配，
 * 直接报 ERR_PNPM_UNEXPECTED_STORE —— 这是自动更新全部失败的真实原因。
 */
export function detectStoreDir(profileDir) {
  const BS = String.fromCharCode(92);
  try {
    const f = join(profileDir, 'node_modules', '.modules.yaml');
    const txt = readFileSync(f, 'utf8');
    /* pnpm 8 写 JSON 风格（带引号）；pnpm 9+ 写普通 YAML（不带引号）。两种都要认。 */
    let v = null;
    const m1 = new RegExp(String.fromCharCode(34) + "storeDir" + String.fromCharCode(34) + BS + "s*:" + BS + "s*" + String.fromCharCode(34) + "([^" + String.fromCharCode(34) + "]+)" + String.fromCharCode(34)).exec(txt);
    if (m1) v = m1[1];
    if (!v) {
      const m2 = new RegExp("^storeDir:" + BS + "s*(.+)$", "m").exec(txt);
      if (m2) {
        let raw = m2[1].trim();
        if (raw[0] === String.fromCharCode(34) || raw[0] === String.fromCharCode(39)) raw = raw.slice(1);
        if (raw[raw.length - 1] === String.fromCharCode(34) || raw[raw.length - 1] === String.fromCharCode(39)) raw = raw.slice(0, -1);
        if (raw) v = raw;
      }
    }
    if (v) {
      const out = v.split(BS + BS).join(BS).trim();
      if (out) return out;
    }
  } catch (e) { /* 解析失败 */ }
  /* 解析不出来就返回 null，让 pnpm 用默认 store。
     猜一个路径比不猜更危险：猜错会 ERR_PNPM_UNEXPECTED_STORE，每个包都失败。 */
  return null;
}

/** 跑一次 pnpm，返回 { code, output }，不抛异常 */
export function runPnpm(pnpmCjs, args, cwd, timeoutMs) {
  /* 自动补 --store-dir：让 pnpm 用 node_modules 实际链的那个 store */
  let finalArgs = args;
  try {
    if (args.indexOf('--store-dir') < 0) {
      const store = detectStoreDir(cwd);
      if (store) finalArgs = args.concat(['--store-dir', store]);
    }
  } catch (e) { /* 探测失败就用默认 */ }

  return new Promise((resolve) => {
    execFile(process.execPath, [pnpmCjs].concat(finalArgs), {
      cwd,
      timeout: timeoutMs || 600000,
      maxBuffer: 32 * 1024 * 1024,
      env: safeEnv()
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      /* killed=true 表示被超时杀掉 */
      const timedOut = !!(err && err.killed);
      resolve({ code, timedOut, output: String(stdout || '') + String(stderr || '') });
    });
  });
}

