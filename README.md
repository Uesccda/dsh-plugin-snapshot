# dsh-plugin-snapshot

给 DeepSeek Harness 的插件做**升级前快照、一键回滚和静态体检**。

DSH 官方的 plugin_manager 已经能装、卸、启停插件；本插件只补它没有的那一块：**改动之前先存一份能验身份的恢复点，出问题能退回来，装完之后能看清谁跟谁冲突**。

## 为什么需要它

插件升级失败时最难受的不是报错，而是"清单已经改了、依赖没装完、不知道回到了什么状态"。本插件在每次升级前把 profile 的三份清单（package.json / pnpm-lock.yaml / pnpm-workspace.yaml）存成一份带指纹与哈希的快照，任何时候都能退回去。

## 安装

    dsh plugin add dsh-plugin-snapshot

装好后重启 DSH（或启用 HMR 时自动生效），三个工具随即可用。

## 提供的工具

### plugin_snapshot

快照的创建、列表与恢复。

- action = "create"：把当前 profile 的三份清单存成一份快照，返回快照名
- action = "list"：列出全部快照（时间、依赖数、是否带 manifest）
- action = "restore" + name：恢复到指定快照；恢复前会先自动给现状再存一份

每份快照都带 manifest：profile 指纹、创建时间、每个文件的存在性与 sha256。恢复时会先校验指纹——**别的 profile 的快照会被拒绝**；文件摘要对不上只告警（你可能手工改过清单）。

### plugin_updates

只读的版本检测。

- 以 pnpm-lock.yaml 里解析出来的版本为基准，去 registry 查候选版本
- 输出每个插件的状态：updatable / major / uptodate / prerelease / failed / manual
- 预发布版本不会被建议升级；主版本变更、GitHub 源一律标成需人工确认

### plugin_doctor

静态体检。

- 已声明 vs 已安装 vs 已启用，三者分开列
- 按插件作者声明判定 DSH 版本兼容性：**明确写 incompatible 的判成不兼容，绝不显示成"大概率可用"**
- 重复的 cordis.patch.yml 行 id、缺失的包、无法解析的清单
- 给出"检查优先级"（规则加权，不是崩溃概率）

## 数据放在哪

    ~/.dsh-plugin-snapshot/snapshots/<时间戳>/
    ~/.dsh-plugin-snapshot/logs/

只写这两个目录，以及恢复时写回 profile 的三份清单。不碰 node_modules，不改 bundles 清单，不启动或关闭 DSH。

## 安全边界

- plugin_updates 与 plugin_doctor 是**纯只读**：只读文件、只发 GET 请求
- plugin_snapshot 的 create 只写自己的数据目录；restore 需要显式传 name，且只覆盖三份清单
- 不实现安装/卸载/启停——那是官方 plugin_manager 的职责，避免两套实现互相打架

## 配置

可选，写进 profile 的插件配置：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| profileDir | 自动定位 | 显式指定 profile 目录 |
| registry | registry.npmjs.org | 检测用的源，也可用 DSH_REGISTRY |
| dataDir | ~/.dsh-plugin-snapshot | 快照与日志目录 |
| snapshotsKeep | 7 | 保留份数 |
| concurrency | 8 | 检测并发 |

profile 定位顺序：配置 > 环境变量 DSH_PROFILE_DIR > ~/.dsh/profiles/desktop > 扫描 profiles 目录取最近修改的。

## 已知限制

- 快照只覆盖三份清单，不含 node_modules。恢复之后仍需让包管理器重新安装依赖
- 诊断基于静态扫描与作者声明，不代表运行时验证
- 不做定时任务：插件只在 DSH 运行时存在

## 开发

    npm test        # 5 项自测，用 stub 顶替 @deepseek-ai/dsh-tools

## 许可

MIT

