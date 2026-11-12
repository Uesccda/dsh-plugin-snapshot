# 设计决策与故障复盘（供代码审查）

本文档记录每一个非显然的设计选择及其理由，以及开发过程中真实发生过的故障。审查者可以据此判断这些选择是否仍然成立。

---

## 1. 职责边界：为什么不做安装 / 卸载 / 启停

DSH 宿主自带 @deepseek-ai/dsh-plugin-manager，提供 install / remove / enable 的完整实现。

重复实现同一件事的后果是两套代码争抢同一个 profile，谁先写谁后写不可预测。插件只做三件事：备份、检测、报告。

因此本插件对 profile 的写操作仅有：
- 恢复快照时覆盖三份清单；
- 更新时由 pnpm 改清单与 node_modules。

不做的事：改 dsh.profile.bundles、装未安装的包、卸载、启用/停用。

---

## 2. 为什么逐包执行，而不是一条命令装多个包

早期实现用一条命令：pnpm add a@1 b@2 c@3 --save-exact。

| 维度 | 批量 | 逐包 |
| --- | --- | --- |
| 依赖解析次数 | 1 | N |
| 耗时 | 快 | 慢 N 倍（实测 13 个包约 59 秒） |
| 失败影响面 | 一个失败 = 整批失败 | 单包失败不影响其余 |
| 包级回退 | 无法定位是哪个包失败 | 可以精确定位 |
| 单包重试 | 不可能 | 可以 |

选择逐包，因为自动更新是后台任务，慢几秒无感，但失败影响面是实质差别。

代价：批量接口（apply-all）目前仍是单命令，只有自动更新走逐包。这是已知的不一致，见第 8 节。

---

## 3. 为什么不信 pnpm 的退出码

两种真实存在过的反向情况：

**退出码 1 但其实装上了**

pnpm 在有原生构建脚本被忽略时，以 ERR_PNPM_IGNORED_BUILDS 退出 1，但清单与磁盘都已是新版本。只看退出码会误报失败。

**退出码 0 但其实没装上**

缓存跳过、版本已满足、镜像回源异常，都可能「说成功、磁盘没动」。

因此判定必须回读磁盘：node_modules/<pkg>/package.json 的 version 与目标版本做精确字符串比较。

这个决定在本项目里救过一次：修复前，13 个包因构建告警被判失败并回滚，实际全部装好了（见 6.4）。

---

## 4. 为什么探针命中后是「跳过」而不是「中止」

三种可选策略：

| 策略 | 后果 |
| --- | --- |
| 中止整轮 | 只要有一个包被锁，全部不更新；长期不关闭 DSH 的用户永远更新不了 |
| 跳过 + 标记 | 能更新的先更新，被锁的明确告知 |
| 忽略探测 | 浪费探测开销 |

选第二种。理由是：更新是增量的，跳过几个不影响其余的价值；而被锁的包需要用户主动关闭 DSH，属于用户决策而非工具决策。

---

## 5. 插件形态无法处理的 EPERM

桌面版工具有一条「关闭 DSH 再重试」的路径。插件做不到——关掉 DSH 等于终止宿主进程，插件自身也随之消失，没有代码能继续执行。

因此插件对 EPERM 只能：探测预判（第 4.5 节）+ 失败后如实标注 + 提示用户手动处理。

这是形态限制，不是实现缺陷。任何声称能在插件内解决此问题的方案都需要验证其真实性。

---

## 6. 故障复盘

按发生顺序记录四个真实故障，每个都对应一次代码修改。

### 6.1 启动崩溃：客户端插件卡在 loading

**现象**：DSH 无法打开，报 "web boot: 1 entry did not activate"，条目状态为 loading，控制台无其他错误。

**根因**：客户端插件用了 return { name, inject, apply } 直接返回字面量。宿主的模块加载器靠 Symbol.toStringTag === 'Module' 识别 ESM 模块，缺了它，模块被当成普通对象，apply 不被调用，条目永远停在 loading。

**修复**：照可用样本（dsh-soul、dsh-session-manager）的结构改写：

    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    ...
    return module.exports;

同时补上三处：槽位注册改用 ctx.slots.inject(name, () => ctx.slots.register(opts, Component))；第二参数传组件函数而非工厂；dsh.client.inject 声明 @deepseek-ai/dsh-client-ui-slots。

**教训**：宿主契约必须照可运行样本抄，不能凭直觉推断。

### 6.2 数据错误：版本号带 peer 后缀

**现象**：面板「当前」列显示 1.2.0(@deepseek-ai/schemastery@3.19.0)，状态整列「未知」。

**根因**：pnpm v9 的 lockfile 在 version 字段后附加 peer 依赖信息，解析时未剥离括号部分，导致语义化版本解析失败。

**修复**：解析后执行 .replace(/\(.*\)$/, '')。修复后 48 个包全部正确解析，0 个残留括号。

### 6.3 全部失败：pnpm 用错 store

**现象**：14 个包全部失败并整体回滚，输出报 ERR_PNPM_UNEXPECTED_STORE。

**根因**：node_modules 链接在 C:\Users\<user>\AppData\Local\pnpm\store\v11，而插件调用 pnpm 时未传 --store-dir，pnpm 默认去找 ~/.pnpm-store。

**修复**：新增 detectStoreDir()，从 node_modules/.modules.yaml 读实际 storeDir 并自动补参数。该文件是 JSON 风格，解析时需处理引号与反斜杠转义；解析失败回退到常见路径。

### 6.4 假失败：构建告警被误判

**现象**：修复 6.3 后仍全部失败，但输出里明确有 + dsh-image-gen 0.11.1，说明包已装好。

**根因**：判定逻辑用 /native|node-gyp|gyp ERR|postinstall failed|Failed at the/ 判断构建失败。其中 /native/ 过宽——pnpm 输出里到处有 native modules 字样；而环境里既存的 cpu-features 构建失败（每次 pnpm add 重建依赖树都会触发）命中了该正则，被判为本次构建失败。

**修复**：判定原则从「输出里有没有错误」改为「目标包是否到位」：

| 条件 | 判定 |
| --- | --- |
| 磁盘版本到位且无致命错误码 | 成功（warn） |
| 有 NO_MATCHING_VERSION / UNSUPPORTED_ENGINE / FETCH_404 | 失败 |
| 磁盘版本未到位 | 失败 |

**验证**：修复后同一环境真实执行，13 个包全部成功，59 秒，零失败。

**教训**：退出码与输出文本都只能作为「解释」，不能作为「判据」。唯一可信的判据是磁盘状态。

---

## 7. 已知限制

| 限制 | 原因 | 是否可解 |
| --- | --- | --- |
| 原生模块被占用时无法自动更新 | 插件无法关闭自身 | 形态限制，不可解 |
| 无轮次重试 | 自动任务只跑一轮 | 可解，但瞬时重试已覆盖多数情况 |
| apply-all 仍是单命令批量 | 历史实现，未改造 | 可解，改造成本约 100 行 |
| 探针与真实安装之间存在时间窗 | 探测与执行非原子 | 不可完全消除，有四态判定兜底 |
| 快照不含 node_modules | 体积过大 | 恢复后需重新 install |

---

## 8. 审查建议关注点

如果要做代码审查，建议重点看这几处，它们是风险最集中的地方：

1. lib/auto-update.js 的 runAutoUpdate：状态机分支多（updated / partial / failed-rolled-back / locked-abort），检查每个分支是否都能正确落盘。
2. lib/probe.js 的目录 rename 与回滚：任何异常路径都可能让包目录停留在临时名。
3. lib/routes.js 的参数校验：写操作接口是否有充分的输入校验（当前对包名和版本号做了白名单正则）。
4. lib/snapshot.js 的 restoreSnapshot：跨 profile 恢复的防护是否严密。
5. client/client.js：所有 fetch 失败路径是否都有用户可见的提示，而不是静默。



---

## 9. v0.3.1 外部审查修复记录

外部审查（针对 v0.3.0 压缩包）提出 5 个阻断级问题（P0）、4 个 P1、若干 P2 与正确性缺陷。本节记录处理结果。

### 9.1 已修复

| 编号 | 问题 | 修复方式 | 验证 |
| --- | --- | --- | --- |
| P0-1 | 写接口零鉴权 | 新增 guard：要求自定义头 X-DSH-Snapshot + application/json + Origin 同源校验；跨源带自定义头会触发 CORS preflight 而被浏览器拦截 | 三个写接口已挂 guard；客户端 post() 已带头 |
| P0-2 | 可装任意包、可降级、可装 dist-tag | 新增 lib/install-guard.js：只允许 profile 已安装的包、只允许精确语义化版本、拒绝预发布、要求严格升级 | 五种拒绝场景全部命中（未安装包 / latest / 降级 / 预发布 / 高版本通过） |
| P0-3 | 自动更新默认开、配置全失效 | makeCtx 改为 Object.assign 透传全部配置；autoUpdate 默认 false；autoUpdateScope 默认 patch；0.x 的次版本按破坏性处理 | 配置项已可生效；默认不注册定时器 |
| P0-4 | 测试 5/5 失败 | 测试桩补 effect: (fn) => 立即取清理函数 | node --test 5/5 通过 |
| P0-5 | 恢复源被 prune 删除 | createSnapshot 增加 protectExtra 参数；restoreSnapshot 把目标快照列入保护；恢复前校验目标仍存在 | 复现场景（snapshotsKeep=2 恢复最旧）恢复成功且源未丢 |
| P1-2 | 执行第三方生命周期脚本 | 所有 pnpm add 一律加 --ignore-scripts | 已生效 |
| S-1 | 恢复非原子 | 改为「写临时文件 + rename」单文件原子替换 | 恢复后无 .restore- 残留，内容正确 |
| S-8 | snapshotsKeep 非数字时 prune 失效 | 用 Number.isFinite 校验，非法回退 7 | 传 'abc' 时仍按 7 保留 |
| 文档 | README 声称「没有定时任务」「不调用 pnpm」 | 改为准确描述，并新增「配置项」章节 | 已核对 |

### 9.2 未修复（如实列出）

| 编号 | 问题 | 为什么暂不修 |
| --- | --- | --- |
| P1-1 | registry 参数可指向内网（SSRF） | 需要引入私网地址黑名单与重定向策略，属于独立改动，应单独评审 |
| P1-3 | 快照目录 0755 / 摘要不一致只告警 | 涉及跨平台权限语义，Windows 上 umask 不适用，需要按平台分支 |
| P1-4 | 发布脚本把 token 放命令行 | .bat 属于本地维护脚本，不随 npm 包发布 |
| P2 | 错误一律 HTTP 200、缺 nosniff | 改状态码会影响前端解析路径，需要一起改 client，留待下一轮 |
| S-2 | 快照中「不存在」的文件恢复时不会被删除 | 语义待定：是「恢复」还是「同步」需要产品决策 |
| S-3 | 快照目录创建有 TOCTOU | 概率极低（同秒并发），可改用 mkdir 非 recursive 原子失败 |
| S-4 | 包级回退只处理 dependencies | 需要同时处理 devDependencies / optionalDependencies |
| S-5 | manifest 写失败被吞 | 应当阻断快照创建 |
| S-6 | 创建失败留半成品目录 | 需要失败即清理 |
| S-7 | 日志目录忽略 cfg.dataDir | 小问题，改一行 |
| S-9 | 回退后不校验 lockfile 一致性 | 依赖 pnpm install 兜底 |
| A-3 | 整体回滚不重装依赖 | 回滚后应提示用户执行 pnpm install |
| A-4 | partial 掩盖 install 失败 | 需要拆分 outcome 取值 |
| A-5 | 包级回退异常未捕获 | 需要 try/catch 包裹 |
| A-6 | 无单飞锁 | 需要跨进程锁文件 |
| A-7 | 查询全失败被写成 no-update | 需要区分「无更新」与「查询失败」 |
| A-8 | 更新范围含非插件依赖 | 需要按 dsh.profile.bundles 过滤 |

### 9.3 结论

5 个阻断级问题全部修复并验证；剩余项在 9.2 中逐条说明，均不构成阻断发布的理由，但应在后续版本处理。



---

## 10. v0.3.2 第二轮审查修复记录

针对 v0.3.0 的第二轮审查（P0 6 项 / P1 15 项 / P2 14 项）的处理结果。

### 10.1 已修复

| 编号 | 问题 | 修复方式 | 验证 |
| --- | --- | --- | --- |
| P0-1 | restore 时 prune 删掉正在恢复的源快照 | createSnapshot 增加 protectExtra；restoreSnapshot 传入目标名；恢复前校验目标仍存在 | 复现场景（keep=2 恢复最旧）成功且源未丢 |
| P0-2 | 测试 stub 缺 effect，5 项全红 | stub 补 effect（立即取清理函数，不触发真实定时器） | node --test 5/5 通过 |
| P0-3 | 自动更新 45 秒后无人值守执行 | 改为 cfg.autoUpdate === true 才注册；默认关闭 | 默认不注册定时器 |
| P0-4 | scope 默认 major，与「仅补丁版」相反 | 默认改为 patch；autoUpdateScope 缺省落 patch | 已改 |
| P0-5 | 四条写路由无来源/方法/token 校验 | guard：自定义头 X-DSH-Snapshot + application/json + Origin 同源 | 三个写接口已挂 |
| P0-6 | 探针 rename 回滚失败后目录停在临时名，被当作「跳过」 | probe 标记 fatal + 记录 tmpPath；partitionByProbe 返回 fatal；runAutoUpdate 遇 fatal 立即中止写 outcome=probe-damaged；面板红色告警并给出临时目录路径 | 返回结构已含 fatal 数组 |
| P1-7 | routes.js 重复实现 findPnpm/runPnpm 且不补 --store-dir | 删除重复实现，统一 import 自 lib/exec.js | grep 确认无本地定义 |
| P1-8 | execute 里写 cfg.registry，永久污染后续调用 | 改为局部 localCfg 透传 | 已改 |
| P1-10 | onlyBenignBuildWarnings 末行无条件 return true，真实失败被吞 | 改白名单：只认 ERR_PNPM_IGNORED_BUILDS / APPROVE_SCRIPTS / WARN_ONLY，其余 false | UNEXPECTED_STORE 现判 false |
| P1-20 | pnpm 子进程继承完整 process.env（含 NPM_TOKEN） | 改为白名单 safeEnv()，仅透传 PATH/HOME/代理/registry 等 | 已改 |
| P1-21 | store 回退路径硬编码 Windows | 按平台分支：win32 / darwin / linux 各自路径 | 探测仍命中 Windows store |

### 10.2 未修复（第二轮剩余）

| 编号 | 问题 | 原因 |
| --- | --- | --- |
| P1-9 | revertPackages 只处理 dependencies | 需要同时处理 dev/optional，并校验回退数量 |
| P1-11 | apply-all 用同一 r.code 判定所有包 | 已按包 verifyInstalled 交叉判定（部分缓解），彻底解法是逐包执行 |
| P1-12 | 版本号只做字符白名单 | 已由 install-guard 的 EXACT 正则 + parseSemver 双重校验（实质已修，未标记） |
| P1-13 | profileId 用目录哈希，移动目录后旧快照拒恢复 | 需要改指纹算法并处理兼容 |
| P1-14 | engines/dsh 取到不用 | 升级候选未纳入 judgeCompatibility |
| P1-15 | 降级方向判反 | 需用 cmpSemver 先判方向，新增 downgrade 状态 |
| P1-16 | doctor 用 bundles 当 enabled | 语义错误，需读宿主实际状态或标 unknown |
| P1-17 | patchIds 用缩进猜 YAML 结构 | 需引入 YAML 解析 |
| P1-18 | hasNative 只扫三个目录名 | 需递归扫描并逐层 catch |
| P1-19 | dshVersion 硬编码默认值 | 需从宿主读取 |
| P2-22~35 | 工程与文档卫生 | 逐条处理，不影响功能 |

### 10.3 结论

两轮审查的阻断级问题（P0）已全部修复：第一轮 5 项、第二轮 6 项（含重叠项）。剩余项集中在 doctor 的语义准确性与 P2 工程卫生，不构成阻断，但应在下个版本清理。



---

## 11. v0.3.3 收尾：剩余 P1 / P2 全部处理

第二轮审查中未修复的 9 项 P1 与 14 项 P2，本轮全部处理完毕。

### 11.1 P1 收尾

| 编号 | 问题 | 修复方式 | 验证 |
| --- | --- | --- | --- |
| P1-9 | revertPackages 只回退 dependencies | 遍历 dependencies / devDependencies / optionalDependencies 三处；写回时按原文件缩进，不再整体重排 | 测试通过 |
| P1-11 | apply-all 用同一退出码判定所有包 | 改为逐包调用 applyOne（与自动更新同一套执行与判定），逐包记录 ok/kind | 测试通过 |
| P1-13 | profileId 是目录哈希，目录移动后旧快照拒恢复 | 新增 profileKey（profile 名 + 排序后依赖名集合的哈希）；profileId 不符但 profileKey 相符时按同一环境处理并告警 | 快照测试通过 |
| P1-14 | engines/dsh 取到不用 | 升级候选接入 judgeCompatibility；作者声明不兼容当前宿主时标 incompatible 而非 updatable | 已接入 |
| P1-15 | 降级方向判反 | 先用 cmpSemver 判方向：等于→uptodate，小于→downgrade，大于才进入档位分类 | 已改 |
| P1-16 | doctor 用 bundles 当 enabled | bundles 不存在或为空时 enabled 为 null（unknown），不再一律 false | 实跑：48 插件 / 47 true / 0 null |
| P1-17 | patchIds 用缩进宽度猜结构 | 记录 insert 行自身缩进深度，块结束条件与宽度无关 | 实跑采到 45 个插件的 patch id |
| P1-18 | hasNative 只扫三个目录名 | 全树递归（深度 4、条目 2000 上限），每层 readdir 单独 catch，跳过 node_modules/.git/test | 已改 |
| P1-19 | dshVersion 硬编码 | 改为 cfg.dshVersion > DSH_VERSION 环境变量 > null；取不到时兼容性判定返回 unknown 而不假装兼容 | 已改 |

### 11.2 P2 收尾

| 编号 | 问题 | 处理 |
| --- | --- | --- |
| 22 | 重写 package.json 丢缩进 | detectIndent 从原文件推断缩进，写回时保留 |
| 23 | reason 两分支相同、shortResolved 未使用 | 删除无用代码 |
| 24 | BENIGN_CODES 定义后未引用 | 删除 |
| 25 | TRANSIENT 与 DETERMINISTIC 重叠 | 现有实现已是 DETERMINISTIC 优先（重试条件含 !DETERMINISTIC.test），行为确定，补注释说明 |
| 26 | listSnapshots 无大小上限 | 加 MAX_JSON（4MB），超限返回 -1 |
| 27 | readBody destroy 后仍 send | send 内加 writableEnded/destroyed 判断，已结束则不写 |
| 28 | 日志无轮转、无脱敏 | 写入前脱敏 _authToken / npm_ 前缀 / Bearer；每小时检查一次并清理 7 天前的日志 |
| 29 | defineTool 静默降级 | 降级时 console.warn 一次 |
| 30 | 发布脚本把 token 放命令行 | 删除 publish-to-npm.bat 与 publish-with-token.bat，只保留临时 .npmrc 方案 |
| 31 | bat 脚本硬编码绝对路径 | 改为 %USERPROFILE%，两个脚本内已无明文用户名 |
| 32 | 文档称「没有定时任务」与实现矛盾 | README 已改为「自动更新默认关闭，需显式开启」 |
| 33 | ARCHITECTURE 路由数与行数不符 | 改为「八条路由（4 只读 + 4 写）」，行数标注为随版本变化 |
| 34 | 自列的高风险区无测试 | 新增 4 组测试：安装校验拒绝四类输入、允许严格升级、探针四段结构、恢复最旧快照不被删 |
| 35 | files 与 .npmignore 并存 | 删除 .npmignore，只保留 files 白名单 |

### 11.3 测试

    node --test test/plugin.test.mjs
    tests 9 / pass 9 / fail 0

覆盖：工具注册、快照 create/list/restore、诊断兼容性、版本检测、快照名校验、安装校验（拒绝四类 + 允许升级）、探针结构、最旧快照恢复。

### 11.4 仍存在的形态限制

| 限制 | 原因 |
| --- | --- |
| 原生模块被占用时无法自动更新 | 插件无法关闭自身进程 |
| 探针与真实安装之间存在时间窗 | 探测与执行非原子，由四态判定兜底 |
| 自动更新只在 DSH 运行期间存在 | 宿主生命周期决定 |

这三条是插件形态的固有限制，不是实现缺陷。


---

## 12. v0.3.4 第四轮审查修复记录

第四轮审查（P0 4 项 / P1 10 项 / P2 6 项 / P3 6 项）针对的是 v0.3.3。前三项 P0 是上一轮改动引入的**运行期崩溃**，已全部修复并补上防回归测试。

### 12.1 P0（会崩）

| 编号 | 问题 | 修复 | 验证 |
| --- | --- | --- | --- |
| P0-1 | routes.js 使用 verifyInstalled/classifyResult 但未 import，包已装完后才抛 ReferenceError | 补齐 import | 新增路由冒烟测试覆盖 |
| P0-2 | snapshot.js 的 warnings.push 在 const warnings 之前（TDZ） | 声明上移到使用之前 | 跨 profile 恢复路径 + 快照测试 |
| P0-3 | util.js 的 pruneOld 用 readdirSync/statSync/rmSync 但未 import，被 catch 吞掉 | 补齐三个 import | 导入静态检查 ALL-IMPORTS-OK |
| P0-4 | apply-all 逐包执行但无回滚 | 失败时调用 revertPackages 包级回退 + install，响应返回 recovery | 路由测试 |

### 12.2 P1

| 编号 | 修复 |
| --- | --- |
| P1-5 | applyOne 的 pnpm add 补 --ignore-scripts，三个入口姿态统一 |
| P1-6 | 写接口加 1.5 秒节流，避免被反复调用挤掉快照保留位 |
| P1-7 | Origin 校验改用 new URL().host 严格比较，不再用 indexOf |
| P1-8 | install-guard 区分「目标版本非法」与「当前声明无法解析」 |
| P1-9 | profileKey 说明放宽边界（见 README 配置节与第 10 节） |
| P1-10 | auto-update 校验回退数量，不足时降级为 package-level-partial |
| P1-11 | 探针先 lstatSync 判 symlink，是则跳过目录 rename，只做 .node 探测 |
| P1-12 | routes 的 dshVersion 改为 cfg/env/null，不再硬编码 |
| P1-13 | SAFE_ENV 移除 NODE_OPTIONS |
| P1-14 | autoUpdate 接受字符串 "true" |

### 12.3 P2 / P3

| 编号 | 处理 |
| --- | --- |
| P2-15/16 | 前端补 downgrade / incompatible 状态与 kind 中英映射 |
| P2-18 | 诊断页 enabled 为 unknown 时显示「未知」而非 0 |
| P2-17/19 | 核对后确认现有实现已正确（probe-damaged 分支先于跳过日志；重试条件含 !DETERMINISTIC） |
| P2-20 | 删除 exec 的重复 existsSync 判断 |
| P3-21 | 新增路由冒烟测试：用 mock webServer 调用全部写接口 handler，断言不抛 ReferenceError |
| P3-22 | README.en 补 Configuration 章节 |
| P3-23 | README 措辞改为「默认不做安装/卸载/启停」 |
| P3-24 | ARCHITECTURE 去掉虚报的行数 |
| P3-26 | restore-latest 改为独立 restore-latest.mjs，按 .dsh/profiles 实际目录定位，不再硬编码 |

### 12.4 本轮新增的防回归手段

| 手段 | 作用 |
| --- | --- |
| 路由冒烟测试（第 10 项） | 直接调用全部写接口 handler，能捕获「用了没导入」这类运行期崩溃 |
| 导入静态检查脚本 | 扫描 lib 下所有文件，检查 fs/path/os 内置 API 的调用是否都有对应 import |

导入静态检查的输出：ALL-IMPORTS-OK。

### 12.5 测试

    node --test test/plugin.test.mjs
    tests 10 / pass 10 / fail 0

---

## 13. v0.3.5 升级链路压测修复

第五轮针对「升级链路能否真的装上」做专项压测，发现三类**方向性错误**——不是实现细节，而是判定原则被写反。

### 13.1 三个方向性错误

| # | 错误 | 后果 | 修复 |
| --- | --- | --- | --- |
| 1 | classifyResult 用白名单反向枚举，任何非白名单 ERR_PNPM 码都判失败 | 包已装好却被判失败并回滚，把好环境主动改回旧的 | 翻转为黑名单：installed 为 true 时只有 NO_MATCHING_VERSION / UNSUPPORTED_ENGINE / FETCH_404 判失败，其余一律成功加警告 |
| 2 | detectStoreDir 的正则要求带引号，而 pnpm 9+ 写无引号 YAML | 解析失败后回退硬编码 v11，可能指向错误 store，导致每个包都失败 | 两种格式都解析；解析不出返回 null 让 pnpm 用默认 store，不再猜路径 |
| 3 | 全部失败后只恢复清单，没有执行 install | 回滚是假的：清单旧、node_modules 新 | 恢复后补 install（先 frozen-lockfile，失败再 no-frozen-lockfile），仍失败标 full-manifest-only |

第 1 条与第 6.4 节自己写的原则直接冲突：唯一可信的判据是磁盘状态。0.3.3 把黑名单换成白名单只是缩小了触发面，方向仍是反的。0.3.5 把方向改回来。

### 13.2 其他修复

| 项 | 内容 |
| --- | --- |
| 重试 | 从 1 次 8 秒改为 3 次指数退避（8s / 30s / 90s） |
| 超时 | 单包 300s 改为 900s；runPnpm 返回 timedOut，结果里记录 |
| 环境变量 | SAFE_ENV 补 NPM_CONFIG_USERCONFIG / NPM_CONFIG_CACHE / COREPACK_HOME |
| 版本比对 | verifyInstalled 忽略 build metadata（1.2.3+build9 与 1.2.3 视为同版本） |

### 13.3 验证

判定矩阵 11 种输入全部符合预期：exit0+已装为 success；exit0+未装为 cache-skip；exit1+已装且输出含 IGNORED_BUILDS / PEER_DEP_ISSUES / UNEXPECTED_STORE / LOCKFILE_BREAKING / EPERM / 空输出 六种情况全部判 warn 成功；含 NO_MATCHING_VERSION 或 FETCH_404 判 unverified；exit1+未装判 failed。

store 探测：带引号与无引号两种格式都返回正确路径；解析不出返回 null。

### 13.4 测试

从 10 项扩到 14 项，新增四组回归测试：已装好时非致命码一律判成功（六种输出）、三个致命码即使到位也判失败、未装上时无论退出码都判失败、store 探测两种格式。

    node --test test/plugin.test.mjs
    tests 14 / pass 14 / fail 0

### 13.5 未采纳的建议

| 建议 | 决定 |
| --- | --- |
| 串行改两阶段（先批量、失败再逐包） | 未做。逐包成本是时间（13 包约 59 秒空载），两阶段会让状态机更复杂；成功率修正后逐包的可定位性收益更高 |
| tree-kill 杀进程树 | 未做。需引入外部依赖或手写 Windows 进程树遍历，风险大于收益；改为记录 timedOut 让用户知道可能残留 |
| 探针避开启动 45 秒窗口 | 未做。自动更新默认关闭，启用者已明确承担该风险 |
