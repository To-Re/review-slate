# ReviewSlate

在编辑器里固定一个 Git 基点，持续审阅当前分支和工作区。ReviewSlate 记住看过的内容、文件与目录评论；代码继续变化时，只提醒你复审受影响的文件。

ReviewSlate is a local review and annotation extension for VS Code, Trae, and Trae CN. Review your working tree against a fixed commit, keep progress across sessions, and hand actionable comments to an agent through local files.

## 能做什么

- **接着上次审。** 每个仓库按“分支 × 固定基点”保留独立审阅记录（CR）；只做 stage 或 commit、内容未变时保留已审标记。
- **边看边改。** 使用原生文件树和 Diff，完整 Diff 右侧的普通 UTF-8 文本文件可直接编辑、保存；已审文件变化后显示“需复审”。
- **把意见留在内容旁。** 支持文件、代码选区和目录评论，以及可操作的待处理评论概览。
- **交给你选择的 Agent。** 生成项目内的 Markdown 清单和 JSON 回执约定，复制交接说明后自行交给能访问该项目的 Agent，回复由你复核。

![从固定基点到批注、Agent 处理和人工复核的审阅流程](media/review-flow.png)

扩展运行时不联网、不上传代码、无遥测、无第三方运行依赖，也不需要本地服务器或模型账号。

## 安装

需要可运行 Git 的本地或远程扩展宿主，以及至少有一个提交的 Git 仓库。仅在受信任的文件系统工作区启用；不支持浏览器版或虚拟工作区。

| 编辑器 | 兼容要求 |
| --- | --- |
| VS Code | 1.107.0 或更高版本的 1.x 系列 |
| Trae | 提供 VS Code API 1.107.0 或更高兼容版本的桌面版 |
| Trae CN | 提供 VS Code API 1.107.0 或更高兼容版本的桌面版 |

Trae 与 Trae CN 的产品版本号不等于 VS Code 内核版本号。以上是扩展的兼容目标；不同宿主的菜单和远程安装方式可能不同。1.0.1 已在 macOS 的 Trae CN 3.4.11（内核 1.107.1）验证 VSIX 安装、窗口重载、审阅设置、新建入口、SHA 输入与 Git 图形菜单显示。完整流程由合成仓库自动化回归覆盖；VS Code、Trae 和 Remote SSH 尚未完成本版本实机验证。

1. 从 [GitHub Releases](https://github.com/To-Re/review-slate/releases) 下载 `review-slate-1.0.1.vsix`，或按[贡献指南](CONTRIBUTING.md)从源码打包。
2. 在编辑器扩展面板的更多菜单中选择 **Install from VSIX… / 从 VSIX 安装…**，选择该文件。
3. 按编辑器提示重载窗口，打开一个受信任的 Git 项目，进入活动栏的“ReviewSlate”。

在 Remote SSH 工作区中，应将扩展安装到该远程扩展宿主，并保证远端可运行 Git；仅装在本地不会替代远端安装。安装 VSIX 不需要另装 Node.js，源码开发才需要。

## 开始一轮审阅

1. 在顶部“审阅设置”选择仓库，在“审阅记录”点击“新建审阅…”或加号。选择主分支时，使用它与当前 `HEAD` 的共同祖先；选择提交时，直接使用该提交。两者都会固定为完整 SHA，此后主分支或 `HEAD` 移动不会改变基点。
2. 点击变更文件，查看左侧基点与右侧工作区的 Diff。审阅比较以磁盘上已保存的最终内容为准，包含分支提交和工作区改动，也包括未被 Git 忽略的未跟踪文件；它不单独展示暂存区版本。
3. 勾选文件或目录表示已审。文件再次改变后可右键“查看上次审阅后的变化”。未保存的文件不能标为已审，先保存再检查。
4. 在“审阅评论”中写意见。目录名称打开目录评论；在完整 Diff 中选中代码后，可使用“评论所选内容”。
5. 点击“待处理评论”集中处理本轮意见，或点击“交给 Agent”复制交接说明。Agent 的匹配版本回执显示为“待复核”，由你标记已解决。

提交选择框可直接粘贴完整或至少 7 位短 SHA，不限最近记录。相同分支与基点会打开已有 CR，保留进度和评论。每个分支记住最后使用的 CR；换基点会进入另一轮，原记录仍在“审阅记录”中。打开另一分支的记录时需先自行切分支；扩展不会执行 checkout、fetch、提交或修改 Git 索引。

“交给 Agent”只复制文字，不会调用或启动 Agent。交接说明和生成清单包含**仓库及目标文件的绝对路径**，选区评论还含原代码片段；粘贴到外部服务或分享前，请检查内容及接收方的访问范围。远程工作区中的路径属于远端文件系统。

更多操作见[使用指南](docs/usage.md)，未来的 Codex 与 DeepSeek Harness 集成见[路线图](docs/roadmap.md)。

## 数据与限制

审阅记录、默认基点和内容快照保存在宿主提供的扩展存储中；已保存评论、回执和交接清单保存在仓库根目录 `.code-review/`。首次保存评论或接续已有评论时，扩展会向根 `.gitignore` 补充 `/.code-review/`，保留已有规则。已被 Git 跟踪的文件不会因加入忽略规则而取消跟踪。

备份需要同时保留这两处数据。它们不会自动跨机器或编辑器同步，移动仓库目录也不会自动迁移审阅记录。单条评论“删除”可撤销；CR“归档”可恢复；“永久删除”会清理该 CR 的保存数据，不能恢复。具体布局、备份与恢复边界见[数据与架构](docs/data.md)。

- 单侧变化文件大小上限为 5 MiB；一次扫描中变化文件两侧内容累计上限为 80 MiB。未变化的大文件可校验后跳过。
- 二进制和非 UTF-8 内容显示摘要；符号链接只读取链接文本；子模块需单独打开为仓库审阅。
- 工作区按原始磁盘字节比较，不执行 Git clean、textconv 或 external diff。Git LFS、换行规范化和其他过滤器可能导致与 Git 自身展示的结果不同。
- 存在合并冲突、读取失败或损坏数据时，不会把相关内容标为已审。代码评论无法唯一定位时保留原片段并提示确认；文件改名不会自动迁移评论。

## 参与项目

使用问题与功能建议可提交 [Issue](https://github.com/To-Re/review-slate/issues)。开发、测试与提交要求见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)，其他文档见[文档索引](docs/README.md)。

项目使用 [MIT License](LICENSE)。感谢 [Incremental Diff](https://github.com/statiolake/vscode-incremental-diff) 对固定基点、内容快照和增量审阅思路的启发。ReviewSlate 独立实现，未复制其源码或测试。
