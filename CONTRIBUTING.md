# Contributing

欢迎通过 [Issue](https://github.com/To-Re/review-slate/issues) 报告问题、讨论功能，或提交 Pull Request。中文和英文均可。`main` 维护 VS Code 系 VSIX，兼容目标包括 Trae / Trae CN；其他客户端的分支入口见[项目首页](README.md)。

## 开始一项改动

先读[项目现状](docs/项目现状.md)、[在途状态](docs/项目状态.md)和 [AGENTS.md](AGENTS.md)，检查当前分支与工作区差异，保留其他贡献者的改动。每项任务明确要解决的问题、允许修改的文件和完成条件；发现跨目录或共享契约需要调整时，先协调写入责任。

项目按专业角色维护资料。产品负责范围、规则和验收条件；设计负责流程、状态和界面；客户端负责实现与数据协议；QA 负责实际验证；代码与安全审核提供独立结论；写作维护用户说明，编辑检查文稿。主负责人维护总入口、现状、在途状态和协作规则，整合交付。各领域的唯一入口与责任见[文档索引](docs/README.md)和[协作规范](docs/协作规范.md)。

行为变化时，同次更新所属领域正文和受影响的用户说明、验收入口。字段级契约以源码为准，文档通过链接说明语义，不另抄一份 schema。直接替换过期内容并修复引用，不保留兼容页或旧稿副本；历史通过 Git 追溯。

## 本地开发

使用 Node.js 22、npm、Git，以及支持 VS Code API `^1.107.0` 的桌面编辑器。安装依赖后运行：

```sh
npm ci --ignore-scripts
npm test
npm run package
```

`npm test` 先编译 TypeScript，再运行 Node.js 内置测试。打包脚本读取 `package.json` 的版本，输出 `artifacts/review-slate-<version>.vsix`；当前源码版本为 1.0.3，打包路径为 `artifacts/review-slate-1.0.3.vsix`，正式安装包入口为 [1.0.3 Release](https://github.com/To-Re/review-slate/releases/tag/v1.0.3)。构建和测试不会安装扩展或启动编辑器；真实界面验证需另行安装，重载所有相关编辑器窗口后，在独立的合成项目中进行。

模块职责与定向命令见[客户端入口](docs/客户端/README.md)，Git 扫描和调度见[本地审阅引擎](docs/客户端/本地审阅引擎.md)，存储、Agent 回执与恢复见[数据协议](docs/客户端/数据协议.md)。运行时沿用 VS Code API 与 Node.js 内置模块；包内容由 `package.json` 的 `files` 白名单限定，入口为 [`scripts/package.cjs`](scripts/package.cjs)。

依赖变更需更新锁文件，在干净副本中检查 `npm ci --ignore-scripts`、`npm audit` 和打包结果，并核对已有 `overrides` 的作用。[CI](.github/workflows/ci.yml) 在 Ubuntu 和 macOS 使用 Node.js 22 执行依赖安装、测试与打包；配置存在不代表某个提交已经通过，结果以对应 Actions 为准。

## 实现与验证

保留扩展 ID `to-re.code-review`、`codeReview.*` 命令、URI scheme 和既有数据目录。数据格式变化需说明迁移与恢复方案；不能通过清空进度解决性能或损坏问题。Git 保持只读，扩展运行时不联网、不上传代码、无遥测；具体边界见 [AGENTS.md](AGENTS.md) 和[客户端文档](docs/客户端/README.md)。

代码或打包变化交付前运行 `npm test` 和 `npm run package`。修复缺陷应提供能暴露该问题的回归证据；纯文案改动核对事实、链接和披露内容即可。测试使用临时合成仓库和虚构资料，不用真实项目制造状态，不隐式安装或启动编辑器。

[产品验收条件](docs/产品/验收条件.md)定义 `VSIX-AC-*` 的预期结果，[测试入口](docs/测试/README.md)定义场景与证据层级，[验证记录](docs/测试/验证记录.md)记录实际执行。实质性代码改动需独立代码审核；涉及产品或界面行为时，在 QA 后由相应角色核对同一实际版本。

性能检查分别测量首次选择基点到树模型完成、点击到 Diff 请求，以及刷新期间的排队。合成仓库、模拟 VS Code API 和真实 GUI 是不同证据，不能把 `vscode.diff` 调用完成写成屏幕已经显示，也不能把测量值承诺为所有仓库的耗时。性能方法和结果只在测试资料维护。

## 提交与交付

每个 PR 围绕明确问题，说明触发条件、修改后的行为、实际验证和未覆盖范围。改变存储、评论归属或 Agent 交接时，补充兼容与恢复影响。维护当前正文，不把开发流水账加入用户指南。

提交、推送、安装和发布分别执行已有授权。推送或发布前，由独立安全审核者核对真正要公开的提交、历史增量、包与文案，检查凭证、个人路径、账号和真实审阅内容；审核后变更补查受影响范围。审核与构建通过不等于已经安装或发布。

面向用户的变化写入 [CHANGELOG.md](CHANGELOG.md)，未发布候选与公开版本分开。只有实际 Release 和可下载产物才能证明发布结果。

## 报告问题

请提供扩展版本、编辑器与系统版本、是否使用 Remote SSH、可重复的操作、预期与实际行为。涉及 Git 或性能时，优先提供合成仓库的生成步骤，并说明文件数量、变更规模和有无未保存文件。

不要直接上传 `.code-review/`、扩展存储、原始日志或真实项目截图；其中可能包含代码、评论、绝对路径与分支信息。请提供脱敏后的错误文本，安全漏洞按 [SECURITY.md](SECURITY.md) 报告。

提交贡献表示你有权提供这些内容，并同意按项目的 [MIT License](LICENSE) 分发。引用外部材料保留必要署名，引入代码需核对来源和许可证。
