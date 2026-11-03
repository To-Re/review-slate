# Contributing

欢迎通过 [Issue](https://github.com/To-Re/review-slate/issues) 报告问题、讨论功能，或提交 Pull Request。中文和英文均可。先从[文档索引](docs/README.md)了解当前状态；编码代理还应阅读 [AGENTS.md](AGENTS.md)。

## 本地开发

需要 Node.js 22 或更高版本、npm、Git，以及支持 VS Code API `^1.107.0` 的桌面编辑器。Git 读取实现兼顾 Git 2.39.5；实际兼容性仍需在目标环境验证。

```sh
npm ci --ignore-scripts
npm test
npm run package
```

`npm test` 先编译 TypeScript，再运行 Node.js 测试；`npm run package` 输出 `artifacts/review-slate-1.0.1.vsix`。安装生成的 VSIX 后，使用独立的合成项目进行界面验证。构建和测试命令不会自动启动编辑器或安装扩展。

模块职责见[架构](docs/architecture.md)，评论与回执约定见[数据协议](docs/data.md)。运行时仅依赖编辑器 API 与 Node.js 内置模块；开发依赖通过锁文件固定，`overrides` 保留已核查的构建依赖版本。更新依赖时，应在干净副本中执行 `npm ci --ignore-scripts`、`npm audit` 和打包，确认安装与安全补丁均生效。包内容由 `package.json` 的 `files` 白名单限定；打包入口为 [`scripts/package.cjs`](scripts/package.cjs)。

[CI 工作流](.github/workflows/ci.yml) 在 Ubuntu 与 macOS 上使用 Node.js 22 执行安装依赖、测试和打包。工作流配置表示自动检查范围，具体提交是否通过以对应 Actions 结果为准。

## 验收矩阵

下表连接 1.0.1 的行为与验证入口，**列出覆盖范围，不代表本次执行结果**。产品规则以 [product.md](docs/product.md) 为准。代码或打包修改提交前运行 `npm test` 与 `npm run package`；开发时可先编译，再定向运行有关测试，例如：

```sh
npm run compile
node --test test/comments.test.cjs test/reviews.test.cjs
```

| 验收范围 | 应保持的结果 | 自动化入口 | 真实宿主补验 |
| --- | --- | --- | --- |
| 基点与创建 CR | 分支取共同祖先，提交取自身；默认值不改变已有 CR；任意有效 SHA 可选，取消不创建记录 | [baselines](test/baselines.test.cjs)、[commit-picker](test/commit-picker.test.cjs)、[editor](test/editor.test.cjs) | 安装重载后检查审阅设置、新建入口、SHA 输入和适用的 Git 菜单 |
| 内容与已审状态 | 比较已保存的工作区，stage / commit 不重置相同内容；改动后需复审，未保存不能标已审 | [review](test/review.test.cjs)、[editable](test/editable.test.cjs) | 在真实 Diff 编辑、保存、勾选并打开上次审阅后的变化 |
| 分支、CR 与陈旧页面 | 各轮进度与评论隔离；切分支或 CR 后旧页面不能写入另一轮 | [reviews](test/reviews.test.cjs)、[editor-context](test/editor-context.test.cjs) | 固定旧 Diff 标签，切换 CR 和分支后核对评论归属与提示 |
| 评论与定位 | 文件、目录、选区语义独立；重复片段或内容改变不猜测行号；评论删除可撤销 | [comments](test/comments.test.cjs)、[directories](test/directories.test.cjs)、[panel](test/panel.test.cjs) | 新增、编辑、删除、恢复及跳转；保存失败后草稿仍在 |
| 树与待处理概览 | 目录聚合进度与评论，常规刷新保留展开状态；概览可处理单条意见 | [tree](test/tree.test.cjs)、[panel](test/panel.test.cjs) | 深层目录、长文本、窗口缩窄、键盘操作和目标主题下检查可读性 |
| Agent 文件交接 | 指定 CR 路径稳定，清单可取回全文；回执匹配当前版本才待复核，不自动解决 | [reviews](test/reviews.test.cjs)、[comments](test/comments.test.cjs)、[pending-size](test/pending-size.test.cjs)、[editable](test/editable.test.cjs) | 复制交接说明，在可访问项目的 Agent 中处理，刷新并人工复核回复 |
| 恢复与永久删除 | 重启接续；归档可恢复；永久删除限定目标 CR，失败可重试，陈旧写入不能复活 | [review](test/review.test.cjs)、[reviews](test/reviews.test.cjs)、[purge](test/purge.test.cjs)、[pending-size](test/pending-size.test.cjs) | 重载后核对记录；在合成数据上归档、恢复和永久删除 |
| 文件与存储边界 | 只读 Git；链接不越界；损坏、冲突、限额和并发失败显式报错；忽略规则不破坏原文 | [review](test/review.test.cjs)、[comments](test/comments.test.cjs)、[ignore](test/ignore.test.cjs)、[purge](test/purge.test.cjs) | 按改动复验实际宿主的文件系统与权限错误；Remote SSH 单独验证 |

自动化使用真实 Git 和临时文件系统，同时模拟编辑器 API、执行评论面板脚本，不能证明真实宿主的窗口、菜单、主题、安装或远程行为。界面修改应对受影响流程实机补验；跨宿主支持声明须分别验证。Codex 集成尚未实现，其新增门槛见 [Codex 设计](docs/codex.md) 和[路线图](docs/roadmap.md)。

Codex 的 [AC-01 至 AC-16](docs/product.md) 是下一阶段验收目标，不能将现有 VSIX 测试结果直接记为通过。实现时按下表接续验证，具体产品条件以产品文档为准。

| Codex 产品验收目标 | 可复用的规则与测试基线 | 还需取得的证据 |
| --- | --- | --- |
| AC-01、AC-02、AC-03：对象归属、基点与 CR 接续 | 基点、分支与 CR 测试 | 实际宿主的仓库选择、权限、SHA 输入及重新打开后的接续 |
| AC-04、AC-05、AC-06：变更树、已审与 Diff | 树、内容身份、增量快照测试 | Codex 内完整 Diff、目录状态、修改后复审与交互可用性 |
| AC-07、AC-08、AC-09、AC-10：评论与人工复核 | 评论、锚点、概览和回执测试 | 目录、文件、选区评论到 Agent 处理再到人工复核的实际流程 |
| AC-11、AC-12、AC-13：恢复、导航、隔离与删除 | 持久化、陈旧页面和删除测试 | Codex 存储适配下的重启、导航接续、失败恢复、草稿隔离和删除边界 |
| AC-14、AC-15：宿主独立持久化与运行边界 | 路径、只读 Git 与失败保护测试 | 独立保存进度，不共写其他应用的数据命名空间；在声明权限和轻量运行条件下完成任务 |
| AC-16：Codex 内完整人工审阅任务 | 前述规则的组合 | 在实际 Codex 宿主连续完成完整任务，由产品与界面验收确认 |

验证记录放在本次 Issue / PR 或发布说明中，写明提交及未提交差异、环境、方法、结果与未覆盖范围。涉及编辑器时注明产品名称、产品与内核版本、操作系统、本地或远程宿主；使用“通过 / 失败 / 未执行 / 阻塞 / 不适用”区分结果，不用历史通过覆盖当前变更。当前公开版本的验证边界集中维护在[文档索引](docs/README.md#发布与验证边界)。

## 提交与发布

尽量让每个 PR 解决一个明确问题。说明触发条件、修改后的行为和实际验证；若改变存储、评论归属或 Agent 交接，说明兼容性及恢复方式。修复缺陷时添加能复现该问题的回归测试；纯文案修正无需制造无意义的测试。

保留稳定的扩展 ID、命令和数据目录。数据格式变化应先讨论；不能通过清空现有状态来回避迁移或损坏问题。行为变化同次更新产品规则、实现或数据说明、用户操作与验收入口；当前能力和验证边界同步[文档索引](docs/README.md)，未来计划维护在[路线图](docs/roadmap.md)。

发布前核对待公开提交、包内文件、VSIX 与发布文案，检查凭证、个人信息、内部路径和真实审阅内容，并由独立审核者确认披露范围。测试、审核与打包通过后，仍按本次发布授权执行；安装、推送或发布不会由构建命令自动完成。公开版本变化写入 [CHANGELOG.md](CHANGELOG.md)，发布结果以实际 Release 和可下载产物为准。

## 报告问题

请提供扩展版本、编辑器与系统版本、可重复的操作、预期和实际行为。涉及 Git 时，可提供复现用的合成仓库步骤，并说明是否为 Remote SSH、是否有未保存文件。

不要直接上传 `.code-review/`、扩展存储、未经处理的日志或真实项目截图。这些资料可能含代码、评论、绝对路径和分支信息。安全漏洞请按 [SECURITY.md](SECURITY.md) 报告。

## 许可

提交贡献表示你有权提供这些内容，并同意按项目的 [MIT License](LICENSE) 分发。引用外部设计或材料时保留必要署名；引入代码需核对来源和许可证。
