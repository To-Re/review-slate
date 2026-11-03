# ReviewSlate

在编辑器里固定一个 Git 基点，分批审阅当前分支与工作区。ReviewSlate 保存已审进度和评论；代码继续变化时，标出需要复审的文件，让你接着上次的内容往下看。

ReviewSlate is a local Git review extension for VS Code-compatible desktop editors. Review against a fixed commit, keep progress, and leave comments for yourself or an agent.

## 安装

ReviewSlate 以 VSIX 分发，面向 VS Code、Trae 和 Trae CN 桌面编辑器。本仓库 `main` 维护这一扩展。

当前正式版为 **1.0.2**（2026-11-03），从 [1.0.2 Release](https://github.com/To-Re/review-slate/releases/tag/v1.0.2) 下载 `review-slate-1.0.2.vsix`。本版优化首次生成变更树和打开 Diff，并修复连续切换文件时评论对象回退的问题，完整改动见 [CHANGELOG](CHANGELOG.md)。

需要支持 VS Code API `^1.107.0` 的编辑器、可运行 Git 的扩展宿主，以及至少有一个提交的 Git 仓库。Trae / Trae CN 的产品版本号不等于内核版本号。扩展仅在受信任的文件系统工作区启用，不支持浏览器版和虚拟工作区。

1. 下载公开版 VSIX，在扩展面板的更多菜单中选择 **Install from VSIX… / 从 VSIX 安装…**，打开下载的文件。
2. 保存代码与需要保留的评论，重载所有正在使用 ReviewSlate 的编辑器窗口，再打开受信任的 Git 项目。升级只安装 VSIX 还不够，已运行的扩展宿主需要重载才能加载新版。
3. 从活动栏进入 **ReviewSlate**，在“审阅设置”确认当前仓库。

安装 VSIX 不需要另装 Node.js。扩展 ID 保持为 `to-re.code-review`；从源码构建见[贡献指南](CONTRIBUTING.md)。Remote SSH 工作区需要把扩展安装到远端扩展宿主，并让远端能运行 Git；文件、审阅数据和 Agent 交接路径均属于远端。

1.0.2 的实现已在 macOS / Trae CN 3.4.11（内核 1.107.1）定向验证：连续与快速切换文件时，树、Diff 和评论对象一致，目录与待处理模式保持，已有进度可接续。完整人工审阅流程、VS Code、Trae 和 Remote SSH 尚未完成实机验收；合成仓库的性能测量不包含真实编辑器渲染。具体构建与覆盖范围见[验证记录](docs/测试/验证记录.md)。

## 完成第一轮审阅

1. 在“审阅记录”点击“新建审阅…”或加号，选择比较的起点。选分支时，以它与当前 `HEAD` 的共同祖先为基点；选提交时，以该提交本身为基点。选定后固定完整 SHA。
2. 点击变更文件打开原生 Diff。左侧是固定基点，右侧是磁盘上已保存的工作区；普通 UTF-8 文件可以在右侧编辑、保存。
3. 检查后勾选文件或目录，记录已审内容。有疑问时写文件、目录或代码选区评论。标记已审与解决评论分别操作。
4. 代码继续变化后，检查“需复审”的文件，按需打开“上次审阅后的变化”。内容没变时，stage 或 commit 不会清空已审标记。
5. 在“待处理评论”核对意见，复审修改结果。确认文件进度、未保存内容和读取错误都已处理后，可以归档本轮，保留资料供以后恢复。

每轮记录称为 CR。同一仓库、分支和固定基点会接续已有的未归档 CR，保留进度与评论。扩展不会自动 fetch、切分支、提交或修改 Git 索引。基点选择、评论、复审和归档的完整操作见[使用指南](docs/用户文档/使用指南.md)。

需要 Agent 协助时，点击“交给 Agent”复制本轮说明，再自行交给能访问项目的 Agent。按钮不发送消息、不启动 Agent、不调用模型；回复回来后，由你检查代码与验证结果，并决定是否解决评论。人工审阅可以完全不使用 Agent。

## 保存与备份

**CR、已审记录和快照在宿主扩展存储，评论与 Agent 回执在项目的 `.code-review/`。** 完整备份需要保留两处，只复制 `.code-review/` 不能恢复已审进度。不同编辑器、机器或仓库路径之间没有自动迁移与同步。

扩展运行时不联网、不上传代码、无遥测，无需部署服务或配置模型账号。保存评论或接续已有评论时，会按需向根 `.gitignore` 补充 `/.code-review/`。数据是未加密的本地文件，可能含代码、评论和路径；分享给 Agent、报告问题或另存备份时，应按代码资料保管。

数据目录确认、完整备份、恢复和容量限制见[数据与故障处理](docs/用户文档/数据与故障处理.md)。

## 参与项目

使用问题和功能建议可提交 [Issue](https://github.com/To-Re/review-slate/issues)。开发步骤见 [CONTRIBUTING.md](CONTRIBUTING.md)，各角色维护的产品、设计、客户端和验证资料见[文档索引](docs/README.md)，安全问题按 [SECURITY.md](SECURITY.md) 报告。其他客户端的工作保留在 [beta 分支](https://github.com/To-Re/review-slate/tree/beta)。

项目由 [To-Re](https://github.com/To-Re) 维护，使用 [MIT License](LICENSE)。感谢 [Incremental Diff](https://github.com/statiolake/vscode-incremental-diff) 对固定基点、内容快照和增量审阅思路的启发。ReviewSlate 独立实现，未复制其源码或测试。
