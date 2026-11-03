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

模块职责见[架构](docs/客户端/本地审阅引擎.md)，评论与回执约定见[数据协议](docs/客户端/数据协议.md)。运行时仅依赖编辑器 API 与 Node.js 内置模块；开发依赖通过锁文件固定，`overrides` 保留已核查的构建依赖版本。更新依赖时，应在干净副本中执行 `npm ci --ignore-scripts`、`npm audit` 和打包，确认安装与安全补丁均生效。包内容由 `package.json` 的 `files` 白名单限定；打包入口为 [`scripts/package.cjs`](scripts/package.cjs)。

[CI 工作流](.github/workflows/ci.yml) 在 Ubuntu 与 macOS 上使用 Node.js 22 执行安装依赖、测试和打包。工作流配置表示自动检查范围，具体提交是否通过以对应 Actions 结果为准。

## 验收矩阵

测试场景、执行证据与覆盖缺口统一从 [QA 测试与验收](docs/测试/README.md)进入，其中维护 [VSIX 验收矩阵](docs/测试/README.md#vsix-101)与 [Codex 目标](docs/测试/README.md#codex-目标)；已执行结果、版本和未覆盖项见[验证记录](docs/测试/验证记录.md)。本文保留该锚点作为稳定入口，不重复维护矩阵。

代码或打包修改交付前运行 `npm test` 与 `npm run package`；定向验证、真实宿主补验和证据记录要求见[验证约定与入口](docs/测试/README.md#验证约定与入口)。Issue / PR 或发布说明引用相应记录，并说明本次版本、实际结果及未覆盖范围；已有测试和历史通过不等于本轮验收通过。

## 提交与发布

尽量让每个 PR 解决一个明确问题。说明触发条件、修改后的行为和实际验证；若改变存储、评论归属或 Agent 交接，说明兼容性及恢复方式。修复缺陷时添加能复现该问题的回归测试；纯文案修正无需制造无意义的测试。

保留稳定的扩展 ID、命令和数据目录。数据格式变化应先讨论；不能通过清空现有状态来回避迁移或损坏问题。行为变化同次更新产品规则、实现或数据说明、用户操作与验收入口；当前能力和验证边界同步[文档索引](docs/README.md)，未来计划维护在[项目状态](docs/项目状态.md)。

发布前核对待公开提交、包内文件、VSIX 与发布文案，检查凭证、个人信息、内部路径和真实审阅内容，并由独立审核者确认披露范围。测试、审核与打包通过后，仍按本次发布授权执行；安装、推送或发布不会由构建命令自动完成。公开版本变化写入 [CHANGELOG.md](CHANGELOG.md)，发布结果以实际 Release 和可下载产物为准。

## 报告问题

请提供扩展版本、编辑器与系统版本、可重复的操作、预期和实际行为。涉及 Git 时，可提供复现用的合成仓库步骤，并说明是否为 Remote SSH、是否有未保存文件。

不要直接上传 `.code-review/`、扩展存储、未经处理的日志或真实项目截图。这些资料可能含代码、评论、绝对路径和分支信息。安全漏洞请按 [SECURITY.md](SECURITY.md) 报告。

## 许可

提交贡献表示你有权提供这些内容，并同意按项目的 [MIT License](LICENSE) 分发。引用外部设计或材料时保留必要署名；引入代码需核对来源和许可证。
