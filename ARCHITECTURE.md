# 架构说明（供代码审查）

本文档面向不熟悉本项目的外部审查者，说明插件的职责、模块划分、数据流与核心机制。行数随版本变动（不含注释与文档，随版本变化）。

---

## 1. 定位

dsh-plugin-snapshot 是 DeepSeek Harness 的一个插件（cordis bundle），提供两类能力：

| 类别 | 入口 | 说明 |
| --- | --- | --- |
| 工具 | agent 侧三个工具 | plugin_updates / plugin_snapshot / plugin_doctor，供模型调用 |
| 界面 | 设置页一个分区 | 「插件更新 / 快照 / 诊断」三个页签，供人操作 |
| 自动化 | 启动后定时任务 | DSH 启动 45 秒后执行一次自动更新 |

明确不做的事：安装新插件、卸载插件、启用/停用插件。这些属于宿主自带的 plugin_manager。

---

## 2. 模块清单

host 侧（Node，ESM）：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| lib/index.js | ~330 | 插件入口：注册三个工具、挂载 HTTP 路由、安排自动更新 |
| lib/util.js | ~150 | 原子写、sha256、语义化版本解析与比较、包名校验、日志 |
| lib/profile.js | ~110 | 定位 profile 目录、读取清单、解析 pnpm-lock.yaml 的版本 |
| lib/snapshot.js | ~180 | 创建 / 列出 / 恢复快照，包级回退（revertPackages） |
| lib/updates.js | ~120 | 读 lockfile 版本 + 查 npm registry，输出可更新项 |
| lib/doctor.js | ~200 | 静态诊断：安装状态、兼容性判定、patch id 冲突、优先级评分 |
| lib/exec.js | ~70 | 定位 pnpm、探测 store 目录、受控执行 pnpm 命令 |
| lib/probe.js | ~96 | 占用探针：目录 rename 探测 + .node 文件读写探测 |
| lib/auto-update.js | ~280 | 自动更新主流程：检测、探针、逐包安装、四态判定、分层回退 |
| lib/apply-all.js | ~90 | 面板「全部更新」的批量接口（含四态判定） |
| lib/routes.js | ~200 | 八条 HTTP 路由的注册与装配、写守卫 |

client 侧（浏览器，由宿主 __ModuleLoader__ 加载）：

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| client/client.js | ~460 | 设置页面板：三页签、状态渲染、操作按钮、结果提示 |

测试：

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| test/plugin.test.mjs | ~143 | 5 项自测，用 stub 顶替 @deepseek-ai/dsh-tools |

---

## 3. 三条数据流

### 3.1 工具调用（agent 侧）

    模型调用 plugin_updates
      -> lib/index.js 里 defineTool 的 execute(args)
      -> lib/updates.js checkUpdates(profileDir, cfg)
      -> 读 pnpm-lock.yaml + 并发查 registry
      -> 返回 { summary, items[] }
      -> render(args, value) 转成文本给模型阅读

### 3.2 面板请求（浏览器侧）

    浏览器 fetch /dsh-plugin-snapshot/api/xxx
      -> lib/routes.js 注册的 handler
      -> 调用对应模块（updates / doctor / snapshot / auto-update）
      -> JSON 响应

八条路由（4 只读 + 4 写）：

| 方法 | 路径 | 性质 |
| --- | --- | --- |
| GET | /api/updates | 只读 |
| GET | /api/doctor | 只读 |
| GET | /api/snapshots | 只读 |
| GET | /api/auto | 只读（上次自动更新结果） |
| POST | /api/snapshot/create | 写（只写自己的数据目录） |
| POST | /api/snapshot/restore | 写（覆盖 profile 三份清单） |
| POST | /api/apply | 写（装单个包） |
| POST | /api/apply-all | 写（装多个包） |

### 3.3 自动更新（启动后定时）

    DSH 启动 -> 插件 apply()
      -> ctx.effect 注册 45 秒定时器
      -> runAutoUpdate()
           -> checkUpdates() 检测
           -> 过滤（排除名单 + 档位判定）
           -> partitionByProbe() 占用探测，剔除被锁住的包
           -> createSnapshot() 打快照
           -> 逐包 applyOne()：pnpm add -> verifyInstalled -> classifyResult
           -> 部分成功 -> revertPackages() 包级回退 + install
           -> 全部失败 -> restoreSnapshot() 整体恢复
           -> 写 auto-update.json

---

## 4. 核心机制的实现

### 4.1 快照与恢复

快照目录：~/.dsh-plugin-snapshot/snapshots/<YYYYMMDD-HHMMSS>/

每份快照包含三份 profile 清单的副本，外加 manifest.json：

| 字段 | 用途 |
| --- | --- |
| profileId | profileDir 的 sha256 前 16 位，恢复时比对，防止跨环境恢复 |
| createdAt | 创建时间 |
| files[] | 每份文件的名称、是否存在、sha256 |

恢复前会比对 profileId；摘要不一致只告警不阻断（用户可能手工改过清单）。恢复前还会给「当前状态」再拍一份快照，避免回滚本身不可逆。

### 4.2 更新检测

数据源：pnpm-lock.yaml 的 importers 段。

    importers:
      .:
        dependencies:
          '@scope/pkg':
            specifier: 1.2.0
            version: 1.2.0(peer@3.19.0)     <- 带 peer 后缀

必须剥掉版本后的括号部分，否则所有带 peer 依赖的包都会被判成无法解析。这是本项目修过的一个真实 bug（见 DECISIONS.md 6.2）。

registry 查询用 https://registry.npmjs.org/<pkg>，取 dist-tags.latest，并发上限 8。

### 4.3 四态判定（核心）

pnpm 的退出码不可信，必须与磁盘真实版本交叉：

| 退出码 | 磁盘版本 | 判定 | 理由 |
| --- | --- | --- | --- |
| 0 | 到位 | success | 正常 |
| 0 | 未到位 | cache-skip（失败） | 可能被缓存跳过，界面不能谎报成功 |
| ≠0 | 到位 | warn（成功） | 通常是构建脚本被忽略，文件其实已装好 |
| ≠0 | 到位 + 致命错误码 | unverified（失败） | 如 NO_MATCHING_VERSION、UNSUPPORTED_ENGINE、FETCH_404 |
| ≠0 | 未到位 | failed（失败） | 明确失败 |

磁盘版本用精确字符串比较，不用 indexOf，避免 1.2.10 被误判为 1.2.1。

### 4.4 分层回退

| 层级 | 触发条件 | 动作 |
| --- | --- | --- |
| 包级 | 部分成功（succeeded 非空且 failed 非空） | 只把失败包的版本号写回快照值，再执行 pnpm install |
| 整体 | 全部失败 | 从快照恢复三份清单 |
| 停止 | 整体恢复本身失败 | 立即停止，不再尝试安装，如实记录 |

「停止」是刻意设计：在已知不一致的基础上继续写盘，事后无法判断哪一步出错。

### 4.5 占用探针

Windows 上 pnpm 替换包的动作是整目录 rename。只要树内任一文件被无删除共享打开（已加载的 .node），整树 rename 就失败。

两级探测：

1. 目录级：把包目录 rename 到临时名再改回。最接近 pnpm 的真实动作。
2. 文件级：对 .node 做 open('r+')。捕获「目录可改名但原生模块被加载」。

安全约定：目录 rename 成功后必须回滚；回滚失败重试一次，仍失败则记 RESTORE_FAILED。探测失败（被锁）的包从本轮计划中剔除，其余照装。

### 4.6 store 目录探测

pnpm 有多个 store 候选位置。若执行时用的 store 与 node_modules 实际链接的 store 不一致，pnpm 直接报 ERR_PNPM_UNEXPECTED_STORE。

做法：从 node_modules/.modules.yaml 读实际 storeDir，自动补 --store-dir。该文件是 JSON 风格（带引号与反斜杠转义），解析失败时回退到 %LOCALAPPDATA%\pnpm\store\v11。

---

## 5. 数据文件

| 路径 | 内容 |
| --- | --- |
| ~/.dsh-plugin-snapshot/snapshots/<时间戳>/ | 快照（三份清单 + manifest.json） |
| ~/.dsh-plugin-snapshot/auto-update.json | 上次自动更新的结果 |
| ~/.dsh-plugin-snapshot/logs/snapshot-<日期>.log | 操作日志 |

插件只写上述目录，以及恢复时写回 profile 的三份清单。不写 node_modules，不改 bundles 清单。

---

## 6. 与 DSH 宿主的契约

### 6.1 插件声明（package.json 的 dsh 字段）

    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },
      "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] },
      "compatibility": { "dshReleases": { "0.2.2-rc.1": "compatible", "0.2.0+": "compatible" } }
    }

### 6.2 host 侧入口

    export const name = 'dsh-plugin-snapshot';
    export const inject = ['tools'];
    export function apply(ctx, config) { ... }

### 6.3 client 侧入口

必须用宿主的模块加载器，且导出 module.exports 并打上 Symbol.toStringTag：

    window.__ModuleLoader__.load({
      id: 'dsh-plugin-snapshot',
      factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        const React = require('react');
        ...
        exports.name = ...;
        exports.inject = ['slots'];
        exports.apply = function (ctx) {
          ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Panel));
        };
        return module.exports;
      }
    });

缺了 Symbol.toStringTag，宿主会把该模块当成普通对象，条目停在 loading，启动审计报 "1 entry did not activate"。这是踩过的坑（见 DECISIONS.md 6.1）。

