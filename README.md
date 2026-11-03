# ReviewSlate

> **beta / WIP：Codex 0.1.2 仍在开发中。** `beta` 分支用于公开开发进度，暂不合入 `main`；源码公开不代表 Codex 安装包已正式发布。真实 Codex 宿主和整体体验验收尚未完成。稳定下载仍为 [VSIX 1.0.1](https://github.com/To-Re/review-slate/releases/tag/v1.0.1)。

在编辑器里固定一个 Git 基点，分批审阅当前分支与工作区。ReviewSlate 保存已审进度和评论；代码继续变化时，标出需要复审的文件，让你接着上次的内容往下看。

ReviewSlate is a local Git review tool. Review against a fixed commit, keep progress, and leave comments for yourself or an agent. VSIX 1.0.1 is released; Codex 0.1.2 is a work in progress on the beta branch, without an official package release.

| 使用环境 | 当前版本与状态 | 操作入口 |
| --- | --- | --- |
| VS Code / Trae / Trae CN | VSIX 1.0.1 · 已发布，稳定下载 | [安装](#安装)、[使用指南](docs/用户文档/使用指南.md) |
| Codex | 0.1.2 · beta / WIP，安装包未正式发布 | [候选版范围](#codex-候选版)、[Codex 使用指南](docs/用户文档/Codex使用指南.md) |

## 审阅时能做什么

- **保存每轮进度。** 按仓库、分支和固定基点管理审阅记录（CR）。内容未变时，stage 或 commit 不会清空已审标记。
- **完整对比与增量复审。** 查看固定基点到已保存工作区的 Diff，以及“上次审阅后的变化”。VSIX 的完整 Diff 右侧支持普通 UTF-8 文件编辑与保存；Codex 候选版目前只读。
- **把意见留在对应位置。** 支持文件、目录和代码选区评论，在“待处理评论”中集中复核；解决评论和标记文件已审分别操作。
- **按需交给 Agent。** 复制本轮交接说明，由你交给能访问项目的 Agent。回复回来后，仍由你检查修改并决定是否解决评论。

ReviewSlate 本地运行时不联网、不上传代码、无遥测，不需要部署服务、启动 HTTP 服务器或为它另配模型账号。Agent 协作是可选步骤；工具本身不调用模型或发送消息。

## 安装

当前公开版本是 **1.0.1**，以 VSIX 分发。需要可运行 Git 的扩展宿主，以及至少有一个提交的 Git 仓库。仅在受信任的文件系统工作区启用，不支持浏览器版或虚拟工作区。

| 编辑器 | 兼容目标 |
| --- | --- |
| VS Code | 1.107.0 或更高版本的 1.x 系列 |
| Trae / Trae CN | 兼容 VS Code API `^1.107.0` 的桌面版；产品版本号不等于内核版本号 |

1. 从 [1.0.1 Release](https://github.com/To-Re/review-slate/releases/tag/v1.0.1) 下载 `review-slate-1.0.1.vsix`。
2. 在编辑器扩展面板的更多菜单中选择 **Install from VSIX… / 从 VSIX 安装…**，打开下载的文件。
3. 按提示重载窗口，打开受信任的 Git 项目，从活动栏进入 **ReviewSlate**。

安装 VSIX 不需要另装 Node.js；从源码构建见[贡献指南](CONTRIBUTING.md)。扩展 ID 保持为 `to-re.code-review`。

**验证范围：** 1.0.1 在 macOS / Trae CN 3.4.11（内核 1.107.1）实测了安装、窗口重载、审阅设置、新建入口、SHA 输入和 Git 图形菜单显示，尚未完成完整人工审阅流程的 GUI 验收。VS Code、Trae 和 Remote SSH 也未完成本版本实机验收；兼容目标不等于已验证支持。证据见[验证记录](docs/测试/验证记录.md)。

Remote SSH 工作区需要把扩展安装到远端扩展宿主，并让远端能运行 Git。它的文件、Git 操作和数据路径属于远端，不能用本地安装或本地路径替代。

## Codex 候选版

Codex 本地候选版已实现 Git 审阅工作区，支持固定基点、完整及增量 Diff、已审进度、三类评论、草稿接续和固定 Agent 交接。顶部“当前项目 / 切换”可一键打开最近项目，或用系统文件夹窗口选择仓库；手动输入路径折叠备用。独立“设置”提供中文、英文及跟随宿主的语言偏好。包内已加入 ReviewSlate 专属图标。

首个完整包以 **Apple Silicon Mac、macOS 13+** 为目标，捆绑 Node.js 和文件夹选择组件，仍需本机系统 Git；最低系统版本兼容性尚待实测。代码对比目前只读；在编辑器或授权的 Agent 中修改并保存后，再刷新复审。其他系统、架构和远程仓库未列入支持范围。

0.1.2 修复大型仓库中打开单文件 Diff 和保存草稿的等待：两项操作不再扫描全仓，也不等待后台刷新完成。数据目录和格式不变，已有进度与评论无需迁移。合成仓库的[性能验证](docs/测试/验证记录.md#2026-11-03-大型-idl-仓库性能验证)是控制器基准，不代表真实 Codex 面板耗时。

0.1.2 的自动测试、完整包检查及代码与安全审核结果见[验证记录](docs/测试/验证记录.md)；开发环境的本地安装证据见[接入记录](docs/客户端/Codex接入.md)。**真实 Codex 面板尚未完成整体验收，安装包尚未正式发布。** 开发试用的操作与限制见 [Codex 使用指南](docs/用户文档/Codex使用指南.md)，构建入口见[贡献指南](CONTRIBUTING.md#codex-候选版)。

## 完成第一轮审阅

以下为已发布 VSIX 的操作；Codex 候选版请按 [Codex 使用指南](docs/用户文档/Codex使用指南.md)操作。

1. 在“审阅设置”选好仓库，在“审阅记录”点击“新建审阅…”或加号。选择分支时，以它与当前 `HEAD` 的共同祖先为基点；选择提交时，直接以该提交为基点。两种方式都会固定 SHA。
2. 点击变更文件看 Diff：左侧是固定基点，右侧是磁盘上已保存的工作区。先保存编辑，再判断最新内容；暂存区不会作为单独一侧展示。
3. 检查后勾选文件或目录，记录已审进度。有疑问时写文件、目录或代码选区评论；有评论的文件仍需自行决定是否标为已审。
4. 修改后刷新，复审“需复审”的文件，并在“待处理评论”中检查每条意见。需要 Agent 协助时使用“交给 Agent”，收到回复后再做人工复核。
5. 确认本轮变化文件已审、未保存和读取错误已处理、待处理意见已核对后，可归档这条 CR。归档保存资料，便于以后恢复。

同一分支与固定基点会重新打开已有的未归档 CR，保留进度和评论。扩展不会自动切分支、fetch、提交或修改 Git 索引。完整操作与例外见[使用指南](docs/用户文档/使用指南.md)。

## 数据保存在什么地方

**VSIX：已审记录与快照在宿主扩展存储，评论与 Agent 回执在项目的 `.code-review/`。** 完整备份需要同时保留两处；只复制 `.code-review/` 不能恢复已审进度。

首次保存评论或接续已有评论时，扩展会按需向根 `.gitignore` 补充 `/.code-review/`。数据为未加密文件，可能包含代码、评论和路径。交给 Agent 的说明与清单含绝对路径，分享前应检查内容与接收方的访问范围。具体保存内容、备份方式和文件大小等限制见[数据、隐私与故障处理](docs/用户文档/数据与故障处理.md)。

**Codex：审阅资料独立保存在仓库的 `.reviewslate/codex/`，语言和最近项目保存在用户应用数据目录。** 首次启用时按需追加 `/.reviewslate/codex/` 忽略规则。数据同样未加密，详情见 [Codex 数据与故障处理](docs/用户文档/Codex数据与故障处理.md)。各应用不互通进度与评论，没有跨宿主、跨机器或移动路径的自动迁移与同步。

## 项目与参与

当前公开下载产物仍为 VSIX 1.0.1。参与 Codex 开发请基于 `beta` 创建分支，并将 PR 目标设为 `beta`。后续工作见[项目状态](docs/项目状态.md)，实现与验证边界见[项目现状](docs/项目现状.md)。

使用问题和功能建议可提交 [Issue](https://github.com/To-Re/review-slate/issues)。开发方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，专业资料从[文档索引](docs/README.md)进入，安全问题按 [SECURITY.md](SECURITY.md) 报告。

项目由 [To-Re](https://github.com/To-Re) 维护，使用 [MIT License](LICENSE)。感谢 [Incremental Diff](https://github.com/statiolake/vscode-incremental-diff) 对固定基点、内容快照和增量审阅思路的启发。ReviewSlate 独立实现，未复制其源码或测试。
