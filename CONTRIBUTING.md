# Contributing

欢迎通过 [Issue](https://github.com/To-Re/review-slate/issues) 报告问题、讨论功能，或提交 Pull Request。中文和英文均可。

## 本地开发

需要 Node.js 22 或更高版本、npm、Git，以及支持 VS Code API `^1.107.0` 的桌面编辑器。Git 读取实现兼顾 Git 2.39.5；实际兼容性仍需在目标环境验证。

```sh
npm ci --ignore-scripts
npm test
npm run package
```

`npm test` 先编译 TypeScript，再运行 Node.js 测试；`npm run package` 输出 `artifacts/review-slate-1.0.1.vsix`。安装生成的 VSIX 后，使用独立的合成项目进行界面验证。构建和测试命令不会自动启动编辑器或安装扩展。

源码入口和存储约定见[数据与架构](docs/data.md)。运行时仅依赖编辑器 API 与 Node.js 内置模块；开发依赖通过锁文件固定，`overrides` 保留已核查的构建依赖版本；更新依赖时应在空目录执行 `npm ci --ignore-scripts`、`npm audit` 和打包，确认安装与安全补丁均生效。包内容由 `package.json` 的 `files` 白名单限定；打包入口为 `scripts/package.cjs`。

[CI 工作流](.github/workflows/ci.yml) 在 Ubuntu 与 macOS 上使用 Node.js 22 执行安装依赖、测试和打包。工作流配置表示自动检查范围，具体提交是否通过以对应 Actions 结果为准。

## 提交修改

尽量让每个 PR 解决一个明确问题。说明触发条件、修改后的行为和实际验证；若改变存储、评论归属或 Agent 交接，说明兼容性及恢复方式。修复缺陷时添加能复现该问题的回归测试；纯文案修正无需制造无意义的测试。

代码或打包修改提交前运行 `npm test` 和 `npm run package`。测试使用真实 Git 与临时文件系统，并模拟编辑器 API、执行评论面板脚本；这些测试不等同于真实宿主的界面验收。涉及界面时，请注明实际编辑器名称、产品与内核版本、操作系统，以及验证过的操作和未覆盖范围。

保留稳定的扩展 ID、命令和数据目录。数据格式变化应先讨论；不能通过清空现有状态来回避迁移或损坏问题。功能、安装或限制变化需同步相关文档，未实现的设想写入[路线图](docs/roadmap.md)。

## 报告问题

请提供扩展版本、编辑器与系统版本、可重复的操作、预期和实际行为。涉及 Git 时，可提供复现用的合成仓库步骤，并说明是否为 Remote SSH、是否有未保存文件。

不要直接上传 `.code-review/`、扩展存储、未经处理的日志或真实项目截图。这些资料可能含代码、评论、绝对路径和分支信息。安全漏洞请按 [SECURITY.md](SECURITY.md) 报告。

## 许可

提交贡献表示你有权提供这些内容，并同意按项目的 [MIT License](LICENSE) 分发。引用外部设计或材料时保留必要署名；引入代码需核对来源和许可证。
