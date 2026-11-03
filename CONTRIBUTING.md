# Contributing

欢迎通过 [Issue](https://github.com/To-Re/review-slate/issues) 报告问题、讨论功能，或提交 Pull Request。中文和英文均可。先从[文档索引](docs/README.md)了解当前状态；编码代理还应阅读 [AGENTS.md](AGENTS.md)。

**Codex 0.1.2 为 beta / WIP，开发仍在进行中。** Codex 贡献请基于 `beta` 创建分支，并将 PR 目标设为 `beta`，暂不合入 `main`。`beta` 源码公开不代表 Codex 安装包正式发布；稳定下载仍为 [VSIX 1.0.1](https://github.com/To-Re/review-slate/releases/tag/v1.0.1)。

## 本地开发

源码开发需要 Node.js 22 或更高版本、npm 和 Git。VSIX 界面验证另需支持 VS Code API `^1.107.0` 的桌面编辑器；Codex 完整候选包当前面向 macOS arm64，构建还需要 macOS SDK 与可用的 `xcrun`。Git 读取实现兼顾 Git 2.39.5；实际兼容性仍需在目标环境验证。

### VSIX

```sh
npm ci --ignore-scripts
npm test
npm run package
```

`npm test` 先编译 TypeScript，再运行 Node.js 测试；`npm run package` 输出 `artifacts/review-slate-1.0.1.vsix`。安装生成的 VSIX 后，使用独立的合成项目进行界面验证。构建和测试命令不会自动启动编辑器或安装扩展。

模块职责见[架构](docs/客户端/本地审阅引擎.md)，评论与回执约定见[数据协议](docs/客户端/数据协议.md)。VSIX 运行时依赖编辑器 API 与 Node.js 内置模块；包内容由 `package.json` 的 `files` 白名单限定，打包入口为 [`scripts/package.cjs`](scripts/package.cjs)。

### Codex 候选版

当前源码版本为 0.1.2 开发候选，真实 Codex 宿主与整体体验验收尚未完成，安装包尚未正式发布。源码分别在 [`src/codex/`](src/codex/)、[`web/codex/`](web/codex/) 和 [`plugins/codex/`](plugins/codex/)，系统文件夹选择组件在 [`native/codex-folder-picker/`](native/codex-folder-picker/)。沿用 TypeScript、原生 DOM 与项目 CSS，使用 CodeMirror 展示只读 Diff，通过本地 MCP stdio 访问共享审阅引擎。文件夹选择组件使用 Objective-C 与系统 AppKit，只在选择期间运行。产品操作见 [Codex 使用指南](docs/用户文档/Codex使用指南.md)，契约与存储边界见[客户端方案](docs/客户端/Codex客户端方案.md)。

安装依赖后，检查 Codex 实现并构建包含运行时的候选包：

```sh
npm run typecheck:codex-ui
npm run test:codex
npm run prepare:codex-runtime
npm run package:codex
npm run check:codex-package
```

`prepare:codex-runtime` 下载并校验 [`scripts/codex-runtime.json`](scripts/codex-runtime.json) 固定的官方 Node.js 发行文件；完整包运行时不会下载依赖、执行 npm 安装或要求用户另装 Node.js。生成目录为 `artifacts/codex-build/reviewslate/`，压缩包为 `artifacts/reviewslate-codex-0.1.2-darwin-arm64.zip`。包内 `build-manifest.json` 记录源码、依赖和产物指纹，并附带所捆绑依赖的许可文件。

`package:codex` 会编译并捆绑文件夹选择组件；单独构建该组件可运行 `node native/codex-folder-picker/build.cjs`。该命令使用 macOS SDK 与 `xcrun`，输出 `artifacts/codex-native/ReviewSlate Folder Picker.app`，目标为 arm64、macOS 13+，完成本地 ad-hoc 签名但不启动或安装。该目标不等于整个包已在最低系统版本通过实测；Developer ID、公证及下载隔离行为也尚未验证，不能据此声称已满足公开分发条件。

`npm run build:codex` 只构建 server 与内联 UI，**不包含 Node.js 运行时或文件夹选择组件**；它和 `package:codex` 使用同一个输出目录，每次都会重建该目录。运行过开发构建后，需重新 `package:codex` 才能检查或交付完整包。构建不会安装插件；直接打开源码 HTML 也不是可独立使用的应用。

`check:codex-package` 核对包内文件指纹，将完整目录复制到临时的含空格路径，再以包内 Node.js 和最小 PATH 启动；在临时合成 Git 仓库检查 CR、评论、已审状态、英文偏好及进程重开恢复，结束后清理临时资料。该命令不安装插件或打开应用，也不操作系统文件夹窗口。每次构建后的实际结果见[验证记录](docs/测试/验证记录.md)，不能沿用先前同版本包的通过结论。

本地安装使用官方 Codex marketplace CLI，具体配置和开发环境的安装证据见[接入记录](docs/客户端/Codex接入.md)。测试、包检查及代码与安全审核的实际范围见[验证记录](docs/测试/验证记录.md)，这些结果不能替代真实 Codex 的界面、剪贴板、输入法和生命周期验收。若已安装旧候选包，需自行更新安装，确认草稿已在本地保留后完全退出并重开 Codex，详见[使用指南](docs/用户文档/Codex使用指南.md#使用前准备)。源码更新和构建命令不会自动安装插件；本地安装与安装包正式发布分别确认。

0.1.2 的单文件 Diff 和草稿保存不再触发全仓扫描，也不等待后台刷新；分支、CR 归属和真实目标内容仍需校验。性能结果与正确性回归见[大型仓库验证](docs/测试/验证记录.md#2026-11-03-大型-idl-仓库性能验证)。该记录使用合成仓库直接调用控制器，不包含真实 Codex 面板的渲染与桥接耗时。

测试使用合成仓库和隔离应用数据；`REVIEW_SLATE_DATA_DIR` 可指定测试用应用数据目录。Codex 资料位于仓库的 `.reviewslate/codex/`，不共写 VSIX 的 `.code-review/` 或扩展存储。不要为调试绕过归属检查、清空旧数据或操作真实业务仓库。当前没有代码编辑保存能力，`editCode: false`；后续启用需完成独立的保存可靠性验证，不能把只读 Diff 计作编辑功能已交付。

### 依赖与自动化范围

构建依赖通过锁文件固定，`overrides` 保留已核查的版本。更新依赖时，应在干净副本中执行 `npm ci --ignore-scripts`、`npm audit` 和受影响的打包检查，确认安装与安全补丁均生效。Codex 的协议和 UI 依赖会进入独立 bundle，未加入 VSIX 资源白名单。

[CI 工作流](.github/workflows/ci.yml) 在推送到 `main` 或 `beta` 时运行，也检查 PR：在 Ubuntu 与 macOS 上使用 Node.js 22 执行依赖安装、VSIX 测试和打包，以及 Codex UI 类型检查与测试。Codex 完整包仍需 macOS arm64 与原生组件构建，不在该 CI 范围内；CI 也不包含真实宿主 GUI 验收。具体提交是否通过以对应 Actions 结果为准。

## 验收矩阵

测试场景、执行证据与覆盖缺口统一从 [QA 测试与验收](docs/测试/README.md)进入，其中维护 [VSIX 验收矩阵](docs/测试/README.md#vsix-101)与 [Codex 目标](docs/测试/README.md#codex-目标)；已执行结果、版本和未覆盖项见[验证记录](docs/测试/验证记录.md)。本文保留该锚点作为稳定入口，不重复维护矩阵。

代码或打包修改交付前运行 `npm test` 与 `npm run package`；Codex 变更还需运行上文对应的类型检查、测试、完整打包与包检查。定向验证、真实宿主补验和证据记录要求见[验证约定与入口](docs/测试/README.md#验证约定与入口)。Issue / PR 或发布说明引用相应记录，并说明本次版本、实际结果及未覆盖范围；已有测试和历史通过不等于本轮验收通过。

## 提交与发布

尽量让每个 PR 解决一个明确问题。说明触发条件、修改后的行为和实际验证；若改变存储、评论归属或 Agent 交接，说明兼容性及恢复方式。修复缺陷时添加能复现该问题的回归测试；纯文案修正无需制造无意义的测试。

保留稳定的扩展 ID、命令和数据目录。数据格式变化应先讨论；不能通过清空现有状态来回避迁移或损坏问题。行为变化同次更新产品规则、实现或数据说明、用户操作与验收入口；当前能力和验证边界同步[文档索引](docs/README.md)，未来计划维护在[项目状态](docs/项目状态.md)。

发布前核对待公开提交、最终 VSIX 或 Codex 包、依赖许可及发布文案，检查凭证、个人信息、内部路径和真实审阅内容，并由独立审核者确认披露范围。测试、审核与打包通过后，仍按本次发布授权执行；安装、推送或发布不会由构建命令自动完成。公开版本变化写入 [CHANGELOG.md](CHANGELOG.md)，发布结果以实际 Release 和可下载产物为准。

## 报告问题

请提供所用版本与类型（VSIX 或 Codex）、宿主与系统版本、可重复的操作、预期和实际行为。涉及 Git 时，可提供复现用的合成仓库步骤，并说明是否为远程工作区、是否有外部编辑器未保存的文件。Codex 问题还需区分源码运行、完整包、独立测试宿主与真实 Codex。

不要直接上传 `.code-review/`、`.reviewslate/codex/`、用户应用数据、扩展存储、未经处理的日志或真实项目截图。这些资料可能含代码、评论、草稿、绝对路径和分支信息。安全漏洞请按 [SECURITY.md](SECURITY.md) 报告。

## 许可

提交贡献表示你有权提供这些内容，并同意按项目的 [MIT License](LICENSE) 分发。引用外部设计或材料时保留必要署名；引入代码需核对来源和许可证。
