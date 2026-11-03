# VSIX 测试与验收

维护责任：QA；状态：现行；最后核查：2026-11-03。适用范围：`main` 上的 VS Code 系编辑器扩展。业务预期见[产品验收条件](../产品/验收条件.md)，实现边界见[客户端](../客户端/README.md)。[验证记录](验证记录.md)保存实际执行结果；本文的测试入口表示覆盖设计，不代表某个候选版本已通过。

## 验证约定与入口

测试使用临时合成 Git 仓库和虚构内容，不修改真实项目数据，不启动编辑器或安装扩展。项目沿用 TypeScript 编译和 Node.js 内置测试：

```sh
npm run compile
node --test test/qa-vsix-performance.test.cjs test/vsix-performance.test.cjs
```

交付代码或打包变化前统一运行一次 `npm test` 和 `npm run package`。定向修复后复验受影响范围；没有新变化，不重复全套检查。开发环境、安装依赖和打包入口见[贡献指南](../../CONTRIBUTING.md#本地开发)。

| 证据类型 | 能支持的判断 | 不能推定 |
| --- | --- | --- |
| 静态检查 | 被检源码、配置、文档和包的内容 | 已运行、已显示或已发布 |
| 单元与模拟测试 | 规则、面板脚本、模拟编辑器事件和命令调度 | 原生控件绘制、实际聚焦、辅助技术与完整宿主生命周期 |
| 真实 Git 和文件系统集成 | 合成仓库扫描、内容核对、落盘、异常恢复和子进程行为 | 编辑器已将结果绘制出来、其他平台性能相同 |
| 真实宿主验收 | 指定编辑器与版本中的可见状态、交互和最终存储结果 | 未测宿主、平台或流程同样通过 |

记录必须定位提交或工作区差异、环境、方法和结果，使用“通过 / 失败 / 未执行 / 阻塞 / 不适用”。模拟宿主与真实 GUI 分开，API 返回与最终落盘分开。失败写明前置条件、步骤、预期、实际和影响；环境不可用单列。QA 结果交设计和产品核对同一版本的实际成品，不代替发布授权。

## VSIX 验收矩阵

| 场景 | 应保持的结果 | 自动化入口 | 真实宿主补验 |
| --- | --- | --- | --- |
| 选择基点、新建和接续 CR | 分支取共同祖先、提交取自身；固定 SHA；取消不创建记录，同组合接续原记录 | [基点](../../test/baselines.test.cjs)、[提交选择](../../test/commit-picker.test.cjs)、[编辑器](../../test/editor.test.cjs) | 初次选基点到文件树可见，输入 SHA、菜单和切回 CR |
| 点击文件与连续切换 | 读取当前已保存内容，保持完整 Diff 和增量 Diff 语义；标签与活动编辑器通知分开发生时，Diff、评论对象和评论使用的内容均对应当前目标；切至外部 Diff 不沿用旧评论目标，旧分支或 CR 页面不能写入另一轮 | [QA 性能与行为](../../test/qa-vsix-performance.test.cjs)、[扩展性能回归](../../test/vsix-performance.test.cjs)、[编辑器上下文](../../test/editor-context.test.cjs) | 实际点击到 Diff 可见、预览切换、修改后刷新并切回既有标签、编辑器自身大文件渲染 |
| 已审与复审 | stage / commit 不重置相同内容；内容改变需复审；未保存不可已审；陈旧勾选或目录新增成员不能被误认已审 | [审阅](../../test/review.test.cjs)、[可编辑目标](../../test/editable.test.cjs)、[QA 性能与行为](../../test/qa-vsix-performance.test.cjs) | Diff 编辑、保存、勾选、查看上次审阅后变化 |
| 保存事件和后台刷新 | 合并冗余刷新但不丢最终状态；旧读取与旧错误不能覆盖更新结果，发生发布竞争时重新读取；点击等待与后台最终空闲分别测量 | [扩展性能回归](../../test/vsix-performance.test.cjs)、[QA 性能与行为](../../test/qa-vsix-performance.test.cjs) | 高频保存、窗口显示切换、后台刷新期间点击 |
| 评论和人工复核 | 文件、目录和选区独立；提交等待时固定目标与锚点，后点文件不改变已提交内容；旧目录、定位或概览晚到不抢回较新选择；Agent 回执、待处理列表及草稿归属正确 | [评论](../../test/comments.test.cjs)、[目录](../../test/directories.test.cjs)、[面板](../../test/panel.test.cjs)、[扩展性能回归](../../test/vsix-performance.test.cjs)、[编辑器](../../test/editor.test.cjs) | 真实选区、主题、窄屏、焦点、键盘与草稿重开 |
| 分支、CR、恢复和删除 | 进度隔离；陈旧页面拒绝写入；重进程恢复；归档可恢复；永久删除失败保留重试能力 | [CR](../../test/reviews.test.cjs)、[审阅](../../test/review.test.cjs)、[删除](../../test/purge.test.cjs) | 重载、切分支、切 CR、异常后恢复和确认文案 |
| 文件和安全边界 | 不读符号链接目标；二进制、子模块、冲突和超限明确处理；只读 Git 不执行过滤器或懒加载 | [审阅](../../test/review.test.cjs)、[可编辑目标](../../test/editable.test.cjs)、[性能回归](../../test/vsix-performance.test.cjs) | 远程文件系统与权限错误的宿主呈现 |
| 容量和损坏恢复 | 单文件 5 MiB、单次差异 80 MiB 限额保持；失败不伪造已审，移除错误输入可恢复 | [审阅](../../test/review.test.cjs)、[QA 预算回归](../../test/qa-vsix-performance.test.cjs)、[大清单](../../test/pending-size.test.cjs) | 代表性大仓和资源压力下的实际响应 |

## 性能比较方法

首要场景是选择基点后的首次文件树，以及点击文件打开 Diff。使用同环境、同生成规则和相同轮次分别测基线与候选，计时不设未经验证的普适毫秒承诺。时间比较报告中位数与最小—最大值，并同时记录 Git 子进程与全仓扫描次数。

[QA 脚本](../../test/qa-vsix-performance.test.cjs)的可选采样默认创建 3 轮独立临时仓，每仓 800 个已跟踪且内容全部改变的文件，每侧约 2 KiB，每目录 40 个文件。通过真实 `ReviewExtension` 的注册命令和保存事件驱动，使用真实 Git、磁盘和 CR 存储；VS Code API 为模拟对象。普通测试不运行大仓采样。

```sh
RUN_VSIX_BENCHMARK=1 \
QA_PERF_LABEL=working-tree \
QA_PERF_OUTPUT=artifacts/vsix-performance/candidate.json \
node --test --test-name-pattern='QA 性能采样' test/qa-vsix-performance.test.cjs
```

基线须先从明确提交导出 `src`、`tsconfig.json` 并独立编译；通过 `QA_PERF_DIST` 指向该副本的 `dist`。可用 `QA_PERF_FILES`、`QA_PERF_CHANGED` 和 `QA_PERF_ROUNDS` 调整规模；`QA_PERF_PRIMARY_ONLY=1` 只测建树、打开和刷新。不同规模结果不能直接混算。报告在被忽略的 `artifacts/vsix-performance/`，不随 checkout 提供；脚本可从仓库复现。报告记录源码编译结果指纹，不含合成仓绝对路径。

| 指标 | 起止与解释 |
| --- | --- |
| `chooseToTree` | 冷对象缓存、无现成 CR，从选择基点命令到队列完成并生成首份树模型；不含人选择菜单的时间和 GUI 绘制 |
| `idleOpen`、`switchOpen` | 已建立 CR 后打开文件及切换另一文件，记录命令入队到 `vscode.diff` 请求；`totalMs` 另计操作及当时队列全部空闲 |
| `openDuringRefresh` | 保存触发的后台扫描真正进入后，再点击文件；拆分排队和处理阶段。操作计数统计到队列空闲，包含剩余刷新及竞争导致的重新读取；不表示所有读取都发生在 Diff 请求之前 |
| `queueWaitMs` | 命令入队到 `open` 处理器开始 |
| `handlerToDiffRequestMs` | 处理器开始到 `vscode.diff`；含内容、归属检查和调用准备 |
| `refresh`、`singleMark`、`directoryMark`、`saveBurst` | 关联回归，目录为 40 文件，保存突发为 8 个事件 |

这里的 `vscode.diff` 立即由模拟对象返回，不包含原生编辑器打开、语法高亮、布局和绘制。文件系统页缓存未清空；“冷”只表示独立仓和扩展对象缓存。初次树耗时、热路径、刷新排队不能互相替代，也不能用 `repo.scan` 的单项结果冒充点击延迟。

## 当前缺口与交接

候选版本的实际结果见[验证记录](验证记录.md)。当前 `be7e00d5` 包通过自动化、性能采样，以及设计独立执行的新 Trae CN 宿主定向复验：顺序和快速切换文件时树、Diff 与评论目标一致，目录和待处理模式在同一 Diff 获焦时保持。预览替换期间评论目标回退的现场缺陷已在该复现路径关闭。

现场观察仅覆盖记录中的环境和操作，没有测量屏幕显示耗时，也没有覆盖完整审阅任务、其他主题、窄侧栏、键盘与辅助技术或其他宿主。安装后的已有进度恢复不等同于本轮重新验证所有保存和恢复路径；后续检查按明确风险补充。
