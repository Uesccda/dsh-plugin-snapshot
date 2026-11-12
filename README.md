# dsh-plugin-snapshot

**给 DeepSeek Harness 的插件做升级前快照、一键回滚和静态体检。**

一个插件，三个工具。

- npm: https://www.npmjs.com/package/dsh-plugin-snapshot
- 仓库: https://github.com/Uesccda/dsh-plugin-snapshot
- 兼容: DSH 0.2.0 及以上（已在 0.2.2-rc.1 实测）

---

## 它解决什么问题

| 你会遇到的麻烦 | 这个插件怎么处理 |
| --- | --- |
| 升级插件失败，清单已经改了、依赖没装完，不知道回到了什么状态 | 升级前先存一份带指纹和哈希的快照，任何时候都能退回去 |
| 装了几十个插件，不知道谁跟谁冲突、谁的兼容声明已经过期 | 一次扫描给出：已装/已启用/缺失/不兼容/未验证，以及检查优先级 |
| 不知道哪些插件有新版本，又怕自动升到测试版 | 列出可更新项，预发布版本单独标注、不混进"可升级"里 |

它**默认不做**安装、卸载、启停——那是 DSH 自带的 plugin_manager 的事。两套实现打架是插件市场里最常见的坑，这里直接避开。

---

## 三个工具

| 工具 | 做什么 | 会不会写文件 |
| --- | --- | --- |
| plugin_snapshot | 创建快照 / 列出快照 / 恢复到某个快照 | 只写自己的数据目录，恢复时覆盖 profile 的三份清单 |
| plugin_doctor | 静态体检：安装状态、作者声明的兼容性、patch id 冲突、缺失的包 | 纯只读 |
| plugin_updates | 以 lockfile 解析出的版本为基准，查 registry 有没有新版本 | 纯只读 |

---

## 怎么用（对话示例）

你不用记命令，直接跟模型说：

- **"升级插件前先给我打个快照"** → 调用 plugin_snapshot 的 create，返回快照名
- **"看看我这些插件有没有问题"** → 调用 plugin_doctor，给出 48 个插件的体检结果
- **"哪些插件可以升级"** → 调用 plugin_updates，列出可更新项
- **"刚才那次升级失败了，退回到升级前"** → 调用 plugin_snapshot 的 restore

---

## 安装

    dsh plugin add dsh-plugin-snapshot

装完重启 DSH（启用 HMR 时自动生效），三个工具随即可用。

卸载：

    dsh plugin remove dsh-plugin-snapshot

---

## 兼容性

本插件声明支持 DSH 0.2.0 及以上，并在 0.2.2-rc.1 实测通过：

    0.2.2-rc.1  compatible
    0.2.1       compatible
    0.2.0+      compatible

如果你在别的 DSH 版本上使用，plugin_doctor 会如实显示为「未验证」而不是假装兼容。

---

## 快照里存了什么

profile 目录下的三份清单：

    package.json
    pnpm-lock.yaml
    pnpm-workspace.yaml

每份快照额外带一个 manifest.json，记录：profile 指纹、创建时间、每个文件是否存在、每个文件的 sha256。

恢复时会先比对 profile 指纹——**别的 profile 的快照会被拒绝**，避免把 A 环境的清单写进 B。文件摘要对不上只告警，因为你可能手工改过清单。

⚠️ 快照**不包含 node_modules**。恢复之后需要让包管理器重新安装依赖。

---

## 数据放在哪

    ~/.dsh-plugin-snapshot/snapshots/<时间戳>/
    ~/.dsh-plugin-snapshot/logs/

只写这两个目录，以及恢复时写回 profile 的三份清单。不碰 node_modules、不改 bundles 清单、不启动或关闭 DSH。

---

## 安全边界

- plugin_doctor 与 plugin_updates 是**纯只读**：只读文件、只发 GET 请求
- plugin_snapshot 的 create 只写自己的数据目录；restore 必须显式传 name
- 两个只读工具（plugin_updates、plugin_doctor）只读文件、只发 GET 请求
- 写操作（快照恢复、更新）会执行 pnpm，但只作用于 profile 中**已安装**的包，
  只允许升到更高版本，拒绝降级与 dist-tag，并一律带 --ignore-scripts
- 不结束任何进程

---

## 配置项

在插件配置里可写：

    {
      "profileDir": "指定 profile 目录（留空则自动定位）",
      "snapshotsKeep": 7,
      "concurrency": 8,
      "autoUpdate": false,
      "autoUpdateScope": "patch",
      "autoExclude": ["某个不想被自动更新的包"]
    }

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| autoUpdate | false | 是否在 DSH 启动 45 秒后自动检查并更新 |
| autoUpdateScope | patch | 升级档位：patch 仅补丁版 / minor 含次版本 / major 含主版本 |
| autoExclude | [] | 永不参与自动更新的包名列表 |
| snapshotsKeep | 7 | 保留的快照份数 |
| concurrency | 8 | 查询 registry 的并发数 |

## 已知限制

- 快照只覆盖三份清单，不含 node_modules
- 诊断基于静态扫描与作者声明，不代表运行时验证
- 自动更新**默认关闭**：需在插件配置里显式写 autoUpdate: true 才会启用
- 插件只在 DSH 运行时存在，DSH 关闭期间不做任何事

---

## 开发

    npm test      # 5 项自测，用 stub 顶替 @deepseek-ai/dsh-tools

---

## 许可

MIT

