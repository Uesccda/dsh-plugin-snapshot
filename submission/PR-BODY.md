## 新增插件

**dsh-plugin-snapshot** — 为 DeepSeek Harness 的 profile 插件提供升级前快照、一键回滚与静态体检。

- npm: https://www.npmjs.com/package/dsh-plugin-snapshot
- repo: https://github.com/Uesccda/dsh-plugin-snapshot

### 为什么值得收录

官方 plugin_manager 负责装/卸/启停，但没有恢复点。这个插件补的正是缺口：
每次升级前把 profile 的三份清单存成带指纹与哈希的快照，出问题能退回去；
另外提供只读的版本检测与静态诊断（作者声明 incompatible 时明确判为不兼容）。

### 核对项

- [x] package.json 声明了 dsh.bundle.patch
- [x] 仓库根有 cordis.patch.yml
- [x] 有真实可运行的代码（6 个模块 + 5 项自测，npm test 通过）
- [x] 无占位内容
- [x] 仅新增一个 data/plugins/*.yml 文件，未改动生成的 README

