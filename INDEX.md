# 包内导航

dsh-plugin-snapshot v0.3.0 —— 供外部代码审查

---

## 建议阅读顺序

| 顺序 | 文件 | 读什么 |
| --- | --- | --- |
| 1 | DECISIONS.md | 先看设计决策与故障复盘，理解「为什么这么做」 |
| 2 | ARCHITECTURE.md | 再看模块划分、数据流、核心机制 |
| 3 | package.json | 插件声明：bundle patch、client 注入、兼容性 |
| 4 | cordis.patch.yml | 如何被挂进宿主的配置树 |
| 5 | lib/index.js | 入口：工具注册、路由挂载、自动更新调度 |
| 6 | lib/auto-update.js | 核心逻辑：逐包安装、四态判定、分层回退 |
| 7 | lib/probe.js | 占用探针 |
| 8 | lib/snapshot.js | 快照与包级回退 |
| 9 | lib/exec.js | pnpm 定位与 store 探测 |
| 10 | lib/routes.js + lib/apply-all.js | HTTP 接口与批量更新 |
| 11 | client/client.js | 设置页面板（宿主模块加载器格式） |
| 12 | test/plugin.test.mjs | 5 项自测 |

---

## 文件清单

    dsh-plugin-snapshot/
      INDEX.md                 本文件
      ARCHITECTURE.md          架构与机制说明
      DECISIONS.md             设计决策与故障复盘
      README.md                用户视角说明（中文）
      README.en.md             用户视角说明（英文）
      RELEASING.md             上架流程记录
      LICENSE                  MIT
      package.json             插件声明
      cordis.patch.yml         宿主挂载声明
      lib/                     host 侧 11 个模块
      client/client.js         浏览器侧面板
      test/plugin.test.mjs     自测
      submission/              插件市场收录材料
      *.bat                    维护脚本（发布、回退、恢复）

---

## 一句话概括

给 DSH 插件做升级前快照、一键回滚、静态体检，以及带占用探针与四态判定的自动更新。

