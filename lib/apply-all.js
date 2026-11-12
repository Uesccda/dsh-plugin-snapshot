/**
 * 批量更新：一次 pnpm add 装多个包。
 *
 * 为什么不是「循环调单包接口」：
 *  - 每个包一次 pnpm add 会把依赖树重解 N 次，慢且容易在中间态失败；
 *  - 一次装多个只有一次解析、一次写 lock，失败也是整体失败，配合快照更好收场。
 */
import { applyOne } from './auto-update.js';
import { validateInstallTargets } from './install-guard.js';
import { revertPackages } from './snapshot.js';

export function registerApplyAll(deps) {
  const { reg, cfg, needProfile, send, readBody, createSnapshot, findPnpm } = deps;

  reg('/dsh-plugin-snapshot/api/apply-all', async (request, response) => {
    try {
      const body = await readBody(request);
      const list = Array.isArray(body && body.items) ? body.items.slice(0, 60) : [];
      if (!list.length) return send(response, 200, { ok: false, error: '没有可更新的目标' });

      const dir = needProfile(cfg);
      const check = validateInstallTargets(dir, list.map((it) => ({ name: String((it && it.name) || ""), version: String((it && it.version) || "") })));
      if (!check.approved.length) {
        return send(response, 200, { ok: false, error: '目标全部未通过校验', rejected: check.rejected });
      }

      const pnpmCjs = findPnpm();
      if (!pnpmCjs) return send(response, 200, { ok: false, error: '找不到 pnpm' });

      const snapshot = createSnapshot(dir, cfg);
      /* 逐包执行：单个包失败不影响其余，且能精确定位失败项 */
      const results = [];
      for (const it of check.approved) {
        try {
          const r = await applyOne(dir, pnpmCjs, { name: it.name, candidate: it.version, resolved: it.version }, cfg.logger);
          results.push({ name: it.name, version: it.version, ok: r.ok, kind: r.kind });
        } catch (e) {
          results.push({ name: it.name, version: it.version, ok: false, kind: "threw", error: String((e && e.message) || e) });
        }
      }

      const okList = results.filter((x) => x.ok);
      const badList = results.filter((x) => !x.ok);

      /* 部分失败：只把失败包的版本号改回快照值，成功的保留（与自动更新同一套分层回退） */
      let recovery = 'none';
      if (badList.length) {
        try {
          const reverted = revertPackages(dir, cfg, snapshot.name, badList.map((x) => x.name));
          if (reverted.length === badList.length) {
            recovery = 'package-level';
          } else {
            recovery = 'package-level-partial';
          }
          const inst = await runPnpm(pnpmCjs, ['install', '--no-frozen-lockfile', '--ignore-scripts'], dir, 600000);
          if (inst.code !== 0) recovery += '-install-failed';
        } catch (e) {
          recovery = 'package-level-error';
        }
      }
      send(response, 200, {
        ok: badList.length === 0,
        count: okList.length,
        failedCount: badList.length,
        failed: badList,
        rejected: check.rejected,
        snapshot: snapshot.name,
        recovery,
        needRestart: okList.length > 0
      });
    } catch (e) { send(response, 200, { ok: false, error: String((e && e.message) || e) }); }
  }, { write: true });
}