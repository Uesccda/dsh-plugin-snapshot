/**
 * dsh-plugin-snapshot - 设置页里的「插件更新 / 快照 / 诊断」面板。
 *
 * 契约（照 dsh-soul、dsh-session-manager 两个可用样本）：
 *   __ModuleLoader__ + module.exports + Symbol.toStringTag='Module'；
 *   ctx.slots.inject(slot, () => ctx.slots.register(options, Component))；
 *   Component 是组件函数，不是工厂。
 *
 * 数据全部走同源 HTTP：前端拿不到 host 侧的工具。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-snapshot',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');

    const S = {
      wrap: { padding: '8px 4px' },
      tabs: { display: 'flex', gap: '6px', marginBottom: '12px', borderBottom: '1px solid #e6eaef', paddingBottom: '8px' },
      tab: { padding: '5px 12px', borderRadius: '6px', border: '1px solid transparent', background: 'transparent', cursor: 'pointer', fontSize: '13px', color: '#57606a' },
      tabOn: { padding: '5px 12px', borderRadius: '6px', border: '1px solid #c3ccd8', background: '#fff', cursor: 'pointer', fontSize: '13px', color: '#1f2328', fontWeight: 600 },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' },
      title: { margin: '0', fontSize: '15px', fontWeight: 600 },
      btn: { padding: '4px 10px', borderRadius: '6px', border: '1px solid #c3ccd8', background: '#fff', cursor: 'pointer', fontSize: '12.5px' },
      btnOn: { padding: '4px 10px', borderRadius: '6px', border: '1px solid #2f6bff', background: '#2f6bff', color: '#fff', cursor: 'pointer', fontSize: '12.5px' },
      meta: { fontSize: '12px', color: '#57606a', marginBottom: '10px', lineHeight: '1.7' },
      err: { fontSize: '12px', color: '#cf222e', marginBottom: '10px' },
      ok: { fontSize: '12px', color: '#1a7f37', marginBottom: '10px' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' },
      th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #d8dee6', color: '#57606a', fontWeight: 600, whiteSpace: 'nowrap' },
      td: { padding: '6px 8px', borderBottom: '1px solid #eef1f4', verticalAlign: 'top' },
      mono: { fontFamily: 'Consolas, monospace', fontSize: '12px' },
      empty: { padding: '16px 8px', color: '#57606a', fontSize: '12.5px' }
    };

    function stateColor(state) {
      if (state === 'updatable') return '#1a7f37';
      if (state === 'major') return '#9a6700';
      if (state === 'prerelease') return '#8250df';
      if (state === 'incompatible') return '#cf222e';
      if (state === 'downgrade') return '#8b949e';
      return '#57606a';
    }

    function stateText(state) {
      const m = { updatable: '可更新', major: '主版本变更', prerelease: '预发布', uptodate: '已最新', failed: '查询失败', manual: '需人工确认', unknown: '未知', downgrade: '低于本地', incompatible: '不兼容当前 DSH' };
      return m[state] || state;
    }

    /* 写操作必须带 X-DSH-Snapshot 头 + JSON 内容类型：
       跨源请求带自定义头会触发 CORS preflight，而本服务不应答 preflight，
       浏览器会直接拦下 —— 这是服务端写守卫的前端半边。 */
    function post(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-snapshot': '1' },
        body: JSON.stringify(body || {})
      }).then(function (r) { return r.json(); });
    }

    function get(url) {
      return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) { return r.json(); });
    }

    /* ---------------- 更新 ---------------- */
    function UpdatesTab() {
      const st = React.useState({ loading: true, items: [], summary: null, error: null, note: null, auto: null });
      const d = st[0];
      const setD = st[1];
      const bulkSt = React.useState(false);
      const bulk = bulkSt[0];
      const setBulk = bulkSt[1];

      const busySt = React.useState({});
      const busy = busySt[0];
      const busyMap = busy;
      const setBusy = busySt[1];

      const load = React.useCallback(function () {
        setD(function (p) { return { loading: true, items: p.items, summary: p.summary, error: null, note: null, auto: p.auto }; });
        Promise.all([
          get('/dsh-plugin-snapshot/api/updates'),
          get('/dsh-plugin-snapshot/api/auto').catch(function () { return { ok: false }; })
        ]).then(function (arr) {
          const j = arr[0];
          const au = arr[1];
          if (!j || !j.ok) throw new Error((j && j.error) || '请求失败');
          setD({ loading: false, items: j.items || [], summary: j.summary || null, error: null, note: null, auto: (au && au.ok) ? au.state : null });
        }).catch(function (e) {
          setD({ loading: false, items: [], summary: null, error: String((e && e.message) || e), note: null, auto: null });
        });
      }, []);

      React.useEffect(function () { load(); }, [load]);

      function applyAll(list) {
        setBulk(true);
        setD(function (p) { return Object.assign({}, p, { note: null, error: null }); });
        post('/dsh-plugin-snapshot/api/apply-all', {
          items: list.map(function (x) { return { name: x.name, version: x.candidate }; })
        }).then(function (j) {
          setBulk(false);
          if (j && j.ok) {
            setD(function (p) { return Object.assign({}, p, { note: '已更新 ' + j.count + ' 个插件，快照 ' + j.snapshot + '，重启 DSH 后生效' }); });
            load();
          } else {
            /* 后端在「部分失败」时返回 ok:false 但没有 error 字段，
               直接把这种情况显示成「未知错误」会掩盖真实结果。 */
            const fl = Array.isArray(j && j.failed) ? j.failed : [];
            const detail = (j && j.error)
              ? j.error
              : (function () {
                  const okN = (j && j.count) || 0;
                  const badN = (j && j.failedCount) || fl.length;
                  const names = fl.slice(0, 3).map(function (x) { return x.name; }).join("、");
                  return "成功 " + okN + " 个，失败 " + badN + " 个" + (names ? "（" + names + (fl.length > 3 ? " 等" : "") + "）" : "");
                })();
            setD(function (p) { return Object.assign({}, p, { error: "批量更新：" + detail }); });
          }
        }).catch(function (e) {
          setBulk(false);
          setD(function (p) { return Object.assign({}, p, { error: String((e && e.message) || e) }); });
        });
      }

      function apply(x) {
        if (x.state === 'major') {
          const from = x.resolved || x.declared || '?';
          if (!window.confirm('这是主版本变更：' + from + ' → ' + x.candidate + '，可能有破坏性改动。仍然更新？')) return;
        }
        setBusy(function (p) { const n = Object.assign({}, p); n[x.name] = true; return n; });
        setD(function (p) { return Object.assign({}, p, { note: null }); });
        post('/dsh-plugin-snapshot/api/apply', { name: x.name, version: x.candidate }).then(function (j) {
          setBusy(function (p) { const n = Object.assign({}, p); delete n[x.name]; return n; });
          if (j && j.ok) {
            setD(function (p) { return Object.assign({}, p, { note: '已更新 ' + x.name + ' 到 ' + x.candidate + '，快照 ' + j.snapshot + '，重启 DSH 后生效' }); });
            load();
          } else {
            setD(function (p) { return Object.assign({}, p, { error: '更新失败：' + ((j && j.error) || '未知错误') }); });
          }
        }).catch(function (e) {
          setBusy(function (p) { const n = Object.assign({}, p); delete n[x.name]; return n; });
          setD(function (p) { return Object.assign({}, p, { error: String((e && e.message) || e) }); });
        });
      }

      const s = d.summary || {};
      const rows = (d.items || []).filter(function (x) { return x.state !== 'uptodate'; });

      const applyTargets = (d.items || []).filter(function (x) { return (x.state === 'updatable' || x.state === 'major') && x.candidate; });
      const head = React.createElement('div', { style: S.head }, [
        React.createElement('h3', { key: 't', style: S.title }, '插件更新'),
        React.createElement('div', { key: 'acts', style: { display: 'flex', gap: '8px' } }, [
          applyTargets.length > 0
            ? React.createElement('button', {
                key: 'all',
                style: S.btnOn,
                disabled: bulk,
                onClick: function () {
                  const majors = applyTargets.filter(function (x) { return x.state === 'major'; }).length;
                  const tip = '一次更新 ' + applyTargets.length + ' 个插件'
                    + (majors > 0 ? '（其中 ' + majors + ' 个是主版本变更，可能有破坏性改动）' : '')
                    + '？会先自动打快照。';
                  if (!window.confirm(tip)) return;
                  applyAll(applyTargets);
                }
              }, bulk ? '更新中…' : ('全部更新 (' + applyTargets.length + ')' + (applyTargets.filter(function (y) { return y.state === 'major'; }).length > 0 ? ' · 含大版本' : '')))
            : null,
          React.createElement('button', { key: 'b', style: S.btn, disabled: d.loading, onClick: function () { load(); } },
            d.loading ? '检测中…' : '重新检测')
        ])
      ]);

      const meta = React.createElement('div', { style: S.meta },
        '可更新 ' + (s.updatable || 0) + ' 个 · 主版本 ' + (s.major || 0) + ' 个 · 共检测 ' + (s.total || 0) + ' 个插件');

      let autoLine = null;
      if (d.auto) {
        const a = d.auto;
        const map = {
          'no-update': '没有需要更新的版本',
          updated: '已自动更新 ' + (a.count || 0) + ' 个插件，重启 DSH 后生效',
          partial: '部分成功：成功 ' + (a.count || 0) + ' 个，失败 ' + (a.failedCount || 0) + ' 个，失败项已回退',
          'failed-rolled-back': '全部失败，已整体恢复到快照 ' + (a.snapshot || ''),
          'failed-rollback-error': '全部失败，且回滚未成功，请手动检查',
          'locked-abort': '全部目标都被 DSH 占用，本次未执行（关闭 DSH 后重试）',
          'probe-damaged': '探针改名后无法还原，包目录可能已损坏，本次已中止',
          error: '自动更新出错：' + (a.error || '')
        };
        const text = map[a.outcome] || a.outcome;
        const color = a.outcome === 'updated' ? '#1a7f37' : (a.outcome === 'no-update' || a.outcome === 'locked-abort') ? '#57606a' : (a.outcome === 'partial' ? '#9a6700' : '#cf222e');
        const failedList = Array.isArray(a.failed) ? a.failed : [];
        const children = [
          React.createElement('div', { key: 'm', style: { fontSize: '12px', color: color } },
            '上次自动更新（' + (a.updatedAtText || '') + '）：' + text)
        ];
        const lockedList = Array.isArray(a.skippedLocked) ? a.skippedLocked : (Array.isArray(a.locked) ? a.locked : []);
        const fatalList = Array.isArray(a.fatal) ? a.fatal : [];
        if (fatalList.length > 0) {
          children.push(React.createElement('div', { key: 'fd', style: { fontSize: '12px', color: '#cf222e', marginTop: '4px', fontWeight: 600 } },
            '包目录损坏：' + fatalList.map(function (x) { return x.name + '（临时目录 ' + (x.tmpPath || '?') + '）'; }).join('；')
              + '——请手动把临时目录改名回原名，或从快照恢复'));
        }
        if (lockedList.length > 0) {
          children.push(React.createElement('div', { key: 'l', style: { fontSize: '11.5px', color: '#9a6700', marginTop: '4px' } },
            '跳过（文件被 DSH 占用）：' + lockedList.map(function (x) { return x.name; }).join('、') + '——关闭 DSH 后可手动更新'));
        }
        if (failedList.length > 0) {
          children.push(React.createElement('div', { key: 'f', style: { fontSize: '11.5px', color: '#cf222e', marginTop: '4px' } },
            '失败项：' + failedList.map(function (x) {
              const kindText = {
                'cache-skip': '缓存跳过，磁盘版本未变',
                unverified: '版本到位但安装过程报错',
                failed: '安装失败',
                threw: '执行异常',
                warn: '成功（构建脚本告警）',
                success: '成功'
              }[x.kind] || x.kind;
              const hint = /EPERM|EBUSY|EACCES/i.test(x.output || '') ? '（文件被 DSH 占用，需手动关闭 DSH 后重试）' : '';
              return x.name + '：' + kindText + hint;
            }).join('；')));
        }
        autoLine = React.createElement('div', { style: { marginBottom: '8px' } }, children);
      }

      const notice = d.error
        ? React.createElement('div', { style: S.err }, d.error)
        : (d.note ? React.createElement('div', { style: S.ok }, d.note) : null);

      let body;
      if (d.loading && rows.length === 0 && !d.error) {
        body = React.createElement('div', { style: S.empty }, '正在读取 registry…');
      } else if (rows.length === 0) {
        body = React.createElement('div', { style: S.empty }, d.error ? '暂无数据' : '全部插件都是最新版本');
      } else {
        body = React.createElement('table', { style: S.table }, [
          React.createElement('thead', { key: 'h' }, React.createElement('tr', null, [
            React.createElement('th', { key: 'a', style: S.th }, '插件'),
            React.createElement('th', { key: 'b', style: S.th }, '当前'),
            React.createElement('th', { key: 'c', style: S.th }, '最新'),
            React.createElement('th', { key: 'd', style: S.th }, '状态'),
            React.createElement('th', { key: 'e', style: S.th }, '操作')
          ])),
          React.createElement('tbody', { key: 'b' }, rows.map(function (x) {
            const canApply = (x.state === 'updatable' || x.state === 'major') && x.candidate;
            const isBusy = !!busyMap[x.name];
            return React.createElement('tr', { key: x.name }, [
              React.createElement('td', { key: 'a', style: S.td }, x.name),
              React.createElement('td', { key: 'b', style: Object.assign({}, S.td, S.mono) }, x.resolved || x.declared || '-'),
              React.createElement('td', { key: 'c', style: Object.assign({}, S.td, S.mono) }, x.candidate || '-'),
              React.createElement('td', { key: 'd', style: Object.assign({}, S.td, { color: stateColor(x.state), fontWeight: 600 }) }, stateText(x.state)),
              React.createElement('td', { key: 'e', style: S.td }, canApply
                ? React.createElement('button', { style: isBusy ? S.btn : S.btnOn, disabled: isBusy, onClick: function () { apply(x); } }, isBusy ? '更新中…' : '更新')
                : React.createElement('span', { style: { color: '#8b949e', fontSize: '12px' } }, '—'))
            ]);
          }))
        ]);
      }

      return React.createElement('div', null, [head, meta, autoLine, notice, body]);
    }

    /* ---------------- 快照 ---------------- */
    function SnapshotsTab() {
      const st = React.useState({ loading: true, list: [], error: null, note: null });
      const d = st[0];
      const setD = st[1];

      const load = React.useCallback(function () {
        setD(function (p) { return Object.assign({}, p, { loading: true, error: null }); });
        get('/dsh-plugin-snapshot/api/snapshots').then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || '请求失败');
          setD({ loading: false, list: j.snapshots || [], error: null, note: null });
        }).catch(function (e) {
          setD({ loading: false, list: [], error: String((e && e.message) || e), note: null });
        });
      }, []);

      React.useEffect(function () { load(); }, [load]);

      function create() {
        post('/dsh-plugin-snapshot/api/snapshot/create', {}).then(function (j) {
          if (j && j.ok) { setD(function (p) { return Object.assign({}, p, { note: '已创建快照 ' + j.created, error: null }); }); load(); }
          else setD(function (p) { return Object.assign({}, p, { error: (j && j.error) || '创建失败' }); });
        });
      }

      function restore(name) {
        if (!window.confirm('确定恢复到快照 ' + name + '？会覆盖当前 profile 的三份清单。')) return;
        post('/dsh-plugin-snapshot/api/snapshot/restore', { name: name }).then(function (j) {
          if (j && j.ok) { setD(function (p) { return Object.assign({}, p, { note: '已恢复 ' + j.restored.join(', ') + '（来自 ' + j.from + '），重启 DSH 后生效', error: null }); }); load(); }
          else setD(function (p) { return Object.assign({}, p, { error: (j && j.error) || '恢复失败' }); });
        });
      }

      const head = React.createElement('div', { style: S.head }, [
        React.createElement('h3', { key: 't', style: S.title }, '快照'),
        React.createElement('button', { key: 'b', style: S.btnOn, onClick: create }, '创建快照')
      ]);

      const meta = React.createElement('div', { style: S.meta }, '共 ' + d.list.length + ' 份。每份含 profile 指纹与文件哈希，恢复前会校验身份。');

      let autoLine = null;
      if (d.auto) {
        const a = d.auto;
        const map = {
          'no-update': '没有需要更新的版本',
          updated: '已自动更新 ' + (a.count || 0) + ' 个插件，重启 DSH 后生效',
          partial: '部分成功：成功 ' + (a.count || 0) + ' 个，失败 ' + (a.failedCount || 0) + ' 个，失败项已回退',
          'failed-rolled-back': '全部失败，已整体恢复到快照 ' + (a.snapshot || ''),
          'failed-rollback-error': '全部失败，且回滚未成功，请手动检查',
          'locked-abort': '全部目标都被 DSH 占用，本次未执行（关闭 DSH 后重试）',
          error: '自动更新出错：' + (a.error || '')
        };
        const text = map[a.outcome] || a.outcome;
        const color = a.outcome === 'updated' ? '#1a7f37' : (a.outcome === 'no-update' || a.outcome === 'locked-abort') ? '#57606a' : (a.outcome === 'partial' ? '#9a6700' : '#cf222e');
        const failedList = Array.isArray(a.failed) ? a.failed : [];
        const children = [
          React.createElement('div', { key: 'm', style: { fontSize: '12px', color: color } },
            '上次自动更新（' + (a.updatedAtText || '') + '）：' + text)
        ];
        const lockedList = Array.isArray(a.skippedLocked) ? a.skippedLocked : (Array.isArray(a.locked) ? a.locked : []);
        if (lockedList.length > 0) {
          children.push(React.createElement('div', { key: 'l', style: { fontSize: '11.5px', color: '#9a6700', marginTop: '4px' } },
            '跳过（文件被 DSH 占用）：' + lockedList.map(function (x) { return x.name; }).join('、') + '——关闭 DSH 后可手动更新'));
        }
        if (failedList.length > 0) {
          children.push(React.createElement('div', { key: 'f', style: { fontSize: '11.5px', color: '#cf222e', marginTop: '4px' } },
            '失败项：' + failedList.map(function (x) {
              const kindText = {
                'cache-skip': '缓存跳过，磁盘版本未变',
                unverified: '版本到位但安装过程报错',
                failed: '安装失败',
                threw: '执行异常'
              }[x.kind] || x.kind;
              const hint = /EPERM|EBUSY|EACCES/i.test(x.output || '') ? '（文件被 DSH 占用，需手动关闭 DSH 后重试）' : '';
              return x.name + '：' + kindText + hint;
            }).join('；')));
        }
        autoLine = React.createElement('div', { style: { marginBottom: '8px' } }, children);
      }

      const notice = d.error
        ? React.createElement('div', { style: S.err }, d.error)
        : (d.note ? React.createElement('div', { style: S.ok }, d.note) : null);

      let body;
      if (d.loading && d.list.length === 0) body = React.createElement('div', { style: S.empty }, '读取中…');
      else if (d.list.length === 0) body = React.createElement('div', { style: S.empty }, '还没有快照，点右上角创建一份');
      else body = React.createElement('table', { style: S.table }, [
        React.createElement('thead', { key: 'h' }, React.createElement('tr', null, [
          React.createElement('th', { key: 'a', style: S.th }, '快照'),
          React.createElement('th', { key: 'b', style: S.th }, '创建时间'),
          React.createElement('th', { key: 'c', style: S.th }, '依赖数'),
          React.createElement('th', { key: 'd', style: S.th }, '操作')
        ])),
        React.createElement('tbody', { key: 'b' }, d.list.map(function (s) {
          return React.createElement('tr', { key: s.name }, [
            React.createElement('td', { key: 'a', style: Object.assign({}, S.td, S.mono) }, s.name),
            React.createElement('td', { key: 'b', style: S.td }, new Date(s.createdAt).toLocaleString()),
            React.createElement('td', { key: 'c', style: S.td }, String(s.deps)),
            React.createElement('td', { key: 'd', style: S.td },
              React.createElement('button', { style: S.btn, onClick: function () { restore(s.name); } }, '恢复'))
          ]);
        }))
      ]);

      return React.createElement('div', null, [head, meta, notice, body]);
    }

    /* ---------------- 诊断 ---------------- */
    function DoctorTab() {
      const st = React.useState({ loading: true, data: null, error: null });
      const d = st[0];
      const setD = st[1];

      const load = React.useCallback(function () {
        setD(function (p) { return Object.assign({}, p, { loading: true, error: null }); });
        get('/dsh-plugin-snapshot/api/doctor').then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || '请求失败');
          setD({ loading: false, data: j, error: null });
        }).catch(function (e) {
          setD({ loading: false, data: null, error: String((e && e.message) || e) });
        });
      }, []);

      React.useEffect(function () { load(); }, [load]);

      const head = React.createElement('div', { style: S.head }, [
        React.createElement('h3', { key: 't', style: S.title }, '插件诊断'),
        React.createElement('button', { key: 'b', style: S.btn, disabled: d.loading, onClick: function () { load(); } },
          d.loading ? '扫描中…' : '重新扫描')
      ]);

      if (d.error) return React.createElement('div', null, [head, React.createElement('div', { style: S.err }, d.error)]);
      if (!d.data) return React.createElement('div', null, [head, React.createElement('div', { style: S.empty }, '扫描中…')]);

      const s = d.data.summary || {};
      const meta = React.createElement('div', { style: S.meta },
        '已装 ' + s.installed + ' · 已启用 ' + (s.unknownEnabled > 0 && s.enabled === 0 ? '未知' : s.enabled) + ' · 缺失 ' + s.missing
        + ' · 不兼容 ' + s.incompatible + ' · 未验证 ' + s.untested + ' · 原生 ' + s.native);

      const conflicts = d.data.conflicts || [];
      const conflictBox = conflicts.length === 0
        ? React.createElement('div', { style: S.empty }, '未发现已知冲突')
        : React.createElement('table', { style: S.table }, [
            React.createElement('thead', { key: 'h' }, React.createElement('tr', null, [
              React.createElement('th', { key: 'a', style: S.th }, '级别'),
              React.createElement('th', { key: 'b', style: S.th }, '类型'),
              React.createElement('th', { key: 'c', style: S.th }, '说明')
            ])),
            React.createElement('tbody', { key: 'b' }, conflicts.map(function (c, i) {
              const color = c.severity === 'critical' ? '#cf222e' : c.severity === 'high' ? '#9a6700' : '#57606a';
              return React.createElement('tr', { key: i }, [
                React.createElement('td', { key: 'a', style: Object.assign({}, S.td, { color: color, fontWeight: 600 }) }, c.severity),
                React.createElement('td', { key: 'b', style: S.td }, c.kind),
                React.createElement('td', { key: 'c', style: S.td }, c.message)
              ]);
            }))
          ]);

      return React.createElement('div', null, [head, meta, conflictBox]);
    }

    /* ---------------- 外壳 ---------------- */
    function Panel() {
      const st = React.useState('updates');
      const tab = st[0];
      const setTab = st[1];

      function tabBtn(key, label) {
        return React.createElement('button', {
          key: key,
          style: tab === key ? S.tabOn : S.tab,
          onClick: function () { setTab(key); }
        }, label);
      }

      let body;
      if (tab === 'updates') body = React.createElement(UpdatesTab);
      else if (tab === 'snapshots') body = React.createElement(SnapshotsTab);
      else body = React.createElement(DoctorTab);

      return React.createElement('div', { style: S.wrap }, [
        React.createElement('div', { key: 'tabs', style: S.tabs }, [
          tabBtn('updates', '插件更新'),
          tabBtn('snapshots', '快照'),
          tabBtn('doctor', '诊断')
        ]),
        React.createElement('div', { key: 'body' }, body)
      ]);
    }

    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'plugin-snapshot',
          order: 50,
          label: function () { return '插件更新'; }
        }, Panel);
      });
    }

    exports.name = 'dsh-plugin-snapshot';
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});

