# 上架步骤（照着做，总共约 20 分钟 + 1 天等待期）

插件本体已经做完并验证：3 个工具、5 项自测通过、npm 打包 11 个文件 / 16 KB。
下面三步需要你的账号，我替不了：**建仓库、发 npm、提 PR**。

---

## 第 0 步：先放一天（这是硬性要求）

收录规则写明：**仓库创建满 1 天**才收（没有提交数门槛，只卡天数）。
所以今天建完仓库，最快明天再提 PR。其余步骤今天都能做完。

---

## 第 1 步：建仓库并推送

在 GitHub 新建一个 **public** 仓库，名字必须叫 dsh-plugin-snapshot
（因为 npm 包名、cordis.patch.yml 里的 name、收录条目的 name 要对得上）。

    cd C:\Users\17321\dsh-plugin-snapshot
    git init
    git add -A
    git commit -m "feat: snapshots, rollback and diagnostics for DSH profile plugins"
    git branch -M main
    git remote add origin https://github.com/Uesccda/dsh-plugin-snapshot.git
    git push -u origin main

推完把下面两处占位符改成你的账号（仓库里的 package.json 加上 repository/homepage 更好看，但不是收录必需）：

    https://github.com/Uesccda/dsh-plugin-snapshot

---

## 第 2 步：发布到 npm

收录要求插件必须能被 dsh plugin add 安装，而它拉的是 npm 包。

    cd C:\Users\17321\dsh-plugin-snapshot
    npm login                      # 浏览器登录一次
    npm publish --access public

安装包名是 dsh-plugin-snapshot（我查过，npm 上目前没人占用）。
发布后验证：

    npm view dsh-plugin-snapshot version

如果报 403，通常是没登录或邮箱未验证；报 402 是包名被占用，告诉我，我换名字。

---

## 第 3 步：给 awesome-dsh-plugin 提 PR

那个仓库是市场的数据源。**一个 PR 只加一个文件**，不要改 README（README 是脚本生成的，改了会冲突）。

Fork https://github.com/awesome-dsh-plugin/awesome-dsh-plugin，然后新增：

    data/plugins/Uesccda__dsh-plugin-snapshot.yml

内容（把 Uesccda 换掉即可）：

    url: https://github.com/Uesccda/dsh-plugin-snapshot
    name: Uesccda/dsh-plugin-snapshot
    category: tools
    description:
      en: 'Pre-upgrade snapshots, one-step rollback and static diagnostics for DeepSeek Harness profile plugins.'
      zh: '为 DeepSeek Harness 插件提供升级前快照、一键回滚与静态体检。'
    icon: https://raw.githubusercontent.com/Uesccda/dsh-plugin-snapshot/main/assets/icon-180.png

注意两点：

- 英文描述里有冒号加空格就必须加引号（上面已经加了）
- icon 那行如果还没做图标，直接删掉这一行；不写会回退到你的 GitHub 头像

PR 标题随便写，正文写一句就够：

    新增 dsh-plugin-snapshot：为 DSH 插件提供升级前快照、回滚与静态诊断。

---

## 第 4 步：等合并

维护者合并后，站点和所有装了市场插件的 DSH 会自动收录，**通常 24 小时内生效**。
之后在插件市场搜 snapshot 就能看到。

---

## 被拒怎么办

按贡献指南，最常见的原因是「只声明了 dsh.client，无法安装」。本插件已经声明了 dsh.bundle + cordis.patch.yml，
这一条不会踩。其余可能原因与应对：

| 可能原因 | 应对 |
| --- | --- |
| 仓库不满 1 天 | 等满再提 |
| 描述没写英文 | 已写 |
| 描述里冒号没加引号 | 已加 |
| 包名在 npm 上装不到 | 先跑 npm view dsh-plugin-snapshot version 确认 |
| 被判定为占位仓库 | 仓库里已有 6 个实现文件和 5 项测试，不是空壳 |

