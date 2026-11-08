# 上架状态与剩余步骤

更新时间：2026-11-08

## 当前状态

| 步骤 | 状态 | 说明 |
| --- | --- | --- |
| 插件本体 | 已完成 | 3 个工具、6 个模块、5 项自测通过 |
| GitHub 仓库 | 已完成 | https://github.com/Uesccda/dsh-plugin-snapshot （public，默认分支 main） |
| npm 发布 | **待办** | 本机未登录 npm，需要你执行一次 npm login |
| 收录 PR 分支 | 已完成 | fork 的 add-dsh-plugin-snapshot 分支已就绪，只差开 PR |
| 收录 PR | **待办** | 规则要求仓库创建满 1 天，最早 2026-11-09 20:00 之后提交 |

## 剩余动作一：发布到 npm

      cd C:\Users\17321\dsh-plugin-snapshot
      npm login
      npm publish --access public
      npm view dsh-plugin-snapshot version

npm login 会打开浏览器让你确认，完成后回来执行 publish 即可。包名 dsh-plugin-snapshot 目前无人占用。

## 剩余动作二：开 PR（明天）

分支和文件都已经推好了，只需要开一个 PR：

      gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
        --head Uesccda:add-dsh-plugin-snapshot \
        --base main \
        --title "Add dsh-plugin-snapshot" \
        --body-file submission/PR-BODY.md

或者直接点这个地址，GitHub 会自动带好对比范围：

      https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...Uesccda:add-dsh-plugin-snapshot

PR 里只包含一个新增文件 data/plugins/Uesccda__dsh-plugin-snapshot.yml，没有改动生成的 README，不会与别人冲突。

## 为什么不能今天就提

contributing.md 写明：仓库创建满 1 天才收。本仓库创建于 2026-11-08 19:47（UTC+8），提前提交会被维护者直接关闭。
没有提交数门槛，所以不需要为凑数量补提交。

## 合并后

维护者合并后，站点与市场会在一天内自动收录。之后在 DSH 插件市场搜 snapshot 即可看到。

