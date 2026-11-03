# 独立代码评审

维护责任：独立代码审核；最后核查：2026-11-03。状态：本轮大仓 Diff 性能实现、目录按钮热区及复选框失焦补修完成独立源码检查与定向验证，最终 0.1.2 包的 UI 资产已重新绑定。当前未发现高置信代码阻断。CR-01 至 CR-09 的修复结论保留在各自版本范围内。本报告不替代真实宿主、产品、设计、安全或发布验收。

## 大仓 Diff 性能评审（20261103-codex-performance）

本轮基线为 `3dd7e30ff0fa336a21efa32cf4242f7288f645cc` 上已有未提交实现，其中核心差异实际比较本机冻结的 `artifacts/codex-performance/baseline/{git,controller,review}.ts` 与当前源码；`src/review.ts` 在本轮没有变化。UI 原文件尚未跟踪，也没有本轮之前的冻结副本，因此对当前 `web/codex/{model,store,app}.ts` 的调用链与行为进行审核，不把整个未跟踪文件当成本轮新增。

检查范围包括 Diff／saveView 旁路全局队列、关闭等待、无锁 Diff 前后归属核验、saveView 写锁／CAS／回执、只读 refresh、共享 Git 缓存、批读协议与容量边界，以及 UI 刷新、点击、迟到响应、版本更新和树节点复用。未发现需要阻止候选继续打包的高置信代码问题。

核对事实：Diff 不改变共享 ReviewService 视图，活动 CR 的读取前后检查 epoch、仓库、分支、CR 和基点；归档读取结束前复核仍归档且未永久删除。saveView 保持仓库写锁、独立 view revision 和持久化回执，确定的保存前拒绝与 I/O／回执不确定状态分开。对象缓存仅保存不可变 Git blob，重复并发填充不重复计数。UI 用 workspace generation 淘汰被业务操作取代的刷新，用 Diff sequence 与 context revision 避免旧读取覆盖新投影；目标 fingerprint 改变时先保留输入并禁写，最多触发一轮额外刷新。

以下 9 个文件按相对路径排序，以各文件 SHA-256 组成无额外空白的 JSON 对象后再取 SHA-256，集合指纹为 `6798976849f4570b3419c50055072577c6a7425cafb49a8b85025c7b8686bb2d`：`src/git.ts`、`src/review.ts`、`src/codex/controller.ts`、`web/codex/{model,store,app}.ts`、`test/codex/{performance-engine,qa-performance,ui-performance}.test.cjs`。执行前后上述源码指纹一致，关键文件如下。

| 文件 | SHA-256 |
| --- | --- |
| `src/git.ts` | `bf8e688ff273f41f0112b9c84d2fd722449d59b1aa84c5d2e6170ecef2e9656b` |
| `src/codex/controller.ts` | `ce65600f93a0e117ec5b4af356ab454650ea7c5a0133a3be54715b57f4b612c9` |
| `web/codex/model.ts` | `0c6085b3ae2e15e2e6d9a3488a052c72282a804f7f670bf9a1b618e71de614dd` |
| `web/codex/store.ts` | `37b53861e368c7984d25f515b4928768cfadc05bc6bb56cdafa0b66040cc8a05` |
| `web/codex/app.ts` | `ab08436468056237f451bf8e98891d30c3f4e0e2e50acb95df7179972c269cf4` |

审核者在 macOS、Node.js `v23.11.0`、Git `2.55.0` 下实际执行：

| 方法 | 实际结果 |
| --- | --- |
| 当前源码 TypeScript 编译至独立临时目录 | 通过，退出码 0 |
| 临时合成仓库并发探针：close 同时等待在途 Diff 和 saveView、关闭后拒绝新请求；scan 与 32 次同对象读取并发后缓存计数与字节一致 | 2 / 2 通过 |
| 容量与协议探针：两侧合计恰好 80 MiB 可读、超 1 字节在冷暖缓存均拒绝；513 个对象按 512 + 1 分批、截断帧不生成有效文件结果 | 2 / 2 通过 |
| `review.test.cjs` 定向检查叶子／父目录符号链接、clean／textconv／external diff、promisor 缺失对象不懒加载 | 3 / 3 通过；主测试使用临时编译目录，子进程使用的 Git 编译文件与该目录逐字节一致 |
| `node --test test/codex/ui-performance.test.cjs test/codex/ui.test.cjs test/codex/ui-picker.test.cjs` | 52 / 52 通过，0 失败、0 跳过，退出码 0；包含 51,000 文件索引、5,000 行 DOM 节点保留、刷新与迟到 Diff 竞态 |

探针使用临时合成仓库和虚构正文，没有编辑实现、提交、安装或操作真实业务仓库。DOM 检查使用只读 Diff stub，不能证明浏览器布局、CodeMirror 或真实 Codex 面板体验。完整回归、性能基准和最终包由 [QA 记录](../测试/验证记录.md)分别提供；审核者未重复整套测试或检查最终安装资产。

### 目录按钮热区补核

用户随后要求扩大目录展开／收起按钮热区。本次只补查 `web/codex/app.ts`、`web/codex/workspace.css` 和 `test/codex/ui-performance.test.cjs` 的相关改动；核心、model 和 store 的已审指纹保持不变。展开按钮、占位和复选框容器均为 32 × 32 px，16 px 复选框位于原生 label 中，移除了手动转发 click。展开按钮、label 和目录名为同一行的独立兄弟控件，行上没有会误触 mark 或 select 的 click 处理；disabled 由原生 input 执行，并同步容器样式。展开后恢复新节点焦点，复选框使用稳定的 `data-focus` 接续刷新焦点。

热区初版由审核者独立执行 UI TypeScript 检查及两项定向 DOM 回归（5,000 行节点保留；目录展开、复选框、目录名的动作隔离与焦点），**2 / 2 通过，退出码 0**。该 DOM 桩当时没有模拟原生 disabled 失焦，不能证明真实浏览器的全部事件和焦点行为；后续实际应用发现及修复见下文。以下指纹绑定包含该修复的最终版本。

| 补核对象 | SHA-256 |
| --- | --- |
| `web/codex/app.ts` | `777b53e77d167340aa31cc3756e99e4e315d8b12d5ee5c0b658e2a01f68521dd` |
| `web/codex/workspace.css` | `02d22d5d608d40e9f301031636513d3e9a8553fa84e3c9a407c164e0f80e5e81` |
| `test/codex/ui-performance.test.cjs` | `438c25b7e7fdf1c97d78f6795877243359149d59c35639e54bc4f6828514cacd` |
| 0.1.2 `build-manifest.json` | `c1474f2999446e3aade0c77c5cbe7f0e34c4f856e41fe1e152289a87ee3880b6` |
| 0.1.2 `ui/workspace.html` | `113019933148c4698af7c2fa4d053d7bb429156e547746e5bbee360623fe7085` |
| `reviewslate-codex-0.1.2-darwin-arm64.zip` | `4f26ab790c4c781d1c65288431c7484f1cde6057e5a1651ea770bbd5ebdc9f3f` |

独立应用的 WKWebView 实测随后发现：按空格勾选时，临时 disabled 会立即让原生复选框失焦到页面根元素，单靠稳定 `data-focus` 无法恢复。UI 负责人已用 `retainCheckboxFocus` 捕获发起控件、仓库／CR／选中目标和活动计数；仅在保存结束后焦点被动丢失、用户未另操作、滚动位置未变、页面可见且未关闭、没有弹窗、归属仍一致时，恢复当前启用的复选框。用户移焦、点击、按键、滚动、切出、隐藏页面或目标变化会放弃恢复，不修改勾选业务和数据边界。

冻结源码和测试的指纹见上表；CSS、核心、model 和 store 保持前述已审版本。审核者在冻结后独立执行 UI 类型检查及热区、原生 disabled 失焦恢复、不抢焦点的 **3 项定向测试，3 / 3 通过，退出码 0**。后两项覆盖保存成功／可重试失败及 9 种后续交互／状态条件，DOM 桩显式模拟 disabled 触发的失焦；没有发现高置信代码阻断。

已重新核对最终 manifest 中本轮源码指纹；按构建脚本的相同选项在内存重建完整 UI，与包目录逐字节相同；ZIP 内 manifest 和 UI 也与目录逐字节相同，ZIP 大小为 37,657,153 字节。焦点补修的源码及包绑定待办解除，代码侧没有阻止该候选继续本地安装验收的问题。包的其余资产和安全结论由独立安全审核负责，真实 Codex GUI 仍未验收；本次未执行安装或发布。

## 候选项目打开失败的补充复验（CR-09）

QA 在实际界面发现：已有项目中选择非 Git 目录，候选打开失败经 `Store.request()` 写入全局 `error/stale`，关闭弹窗后原项目也被禁写。审核者核对了该调用链，并独立发现同一失败流程会提前增加 `generation`，废弃原项目正在读取的 Diff；原读取成功返回后，`loadingDiff` 仍为 true，显示停留在读取中。这两项均属于候选失败不应破坏当前项目状态的问题，合并为 CR-09（P2）。

修复将候选打开的确定拒绝留在弹窗：仅非初始化、不同根路径、明确 `rejected`、不要求重连且没有 unknown 的失败被局部处理。`app.ts` 从该次抛出的 `RequestFailure` 显示错误，不读写当前项目原有错误。原草稿 flush 仍先执行；重开当前根、初始化、partial／unknown、通信超时、重连失败及成功切换后的 Diff 失败继续走既有全局保护。只有成功采用新项目时才失效旧 Diff；候选失败保留原在途读取及其真实成功或失败结果。

本次基线仍为 `3dd7e30ff0fa336a21efa32cf4242f7288f645cc` 加未提交工作区。三处修复文件的集合 SHA-256（算法同下）为 `ab95a12ad12d1cfe7bca47ad2f03a1941bbdc213f511004a895f71a4a488d2e9`：

| 文件 | SHA-256 |
| --- | --- |
| `web/codex/store.ts` | `f2cd4a23319d96ac2b590d25c863763457b50a1e1f6c7917f87ec9c2feceacb4` |
| `web/codex/app.ts` | `12ff839b978952922f6e625214af27c3ee7bf8b236f4608d2a654cbbb261c776` |
| `test/codex/ui.test.cjs` | `18703a2935d4e7780a84c88dfd8e7fd7aefe69e2ac93bb09c28c9010fa827df0` |

审核者在最终源码上独立执行 UI 类型检查及 `ui.test.cjs`，**30 / 30 通过，0 失败、0 跳过，退出码 0**。本次还独立执行了：

- 原延迟 Diff 探针：非 Git 候选被拒绝后，原 Diff 被接收、读取状态清除，当前项目仍可写。
- 实际 app 打开闭包：弹窗显示本次局部错误，同时保留原全局错误对象。
- 实际 Bridge 超时：原 `openWorkspace` 操作 ID 保留为 unknown，当前写入仍受保护。
- 当前源码 bundle 的真实 Store、Controller 与临时合成 Git：候选被拒绝后，当前视图、最近项目和可写状态保持；分别回读失败前旧草稿与失败后新增正文，均已持久化。

新增测试还覆盖已有全局错误、旧草稿保存失败、partial／unknown、重连拒绝、重开当前根、初始化失败，以及成功进入无选中文件的新项目后旧 Diff 不得回写。检查期间及上述探针结束后，三处修复文件均未变化。CR-09 的源码阻断解除。

前轮 18 文件集合现为 `7d5f7fa1694c45400af2c66d65045495eee3a2fbf86c6a378432b0650c968486`。除上述三处外，`native/codex-folder-picker/main.m` 将“最后窗口关闭后退出”改为 false，避免系统“前往文件夹”浮层关闭时提前结束选择；超时、取消、父进程检测及面板完成仍负责退出。`scripts/codex-test-host/main.swift` 将独立测试宿主外层 CSP 的图片源放开为 `data:`，与包内品牌图片一致。审核者补查了这两处源码变化，没有启动 GUI；它们的新指纹分别为 `ce1b5b33980c2217938ffb4d7f8bc3283c53d3cc7ee6a5fa0d3bbd49f113043e`、`7502db172e4117bb523b6ba2aecd7e25bd4d9996d5ff10488cb788177ddbcd01`。其余 13 文件与下列前轮范围一致；本次没有重复 native 或全量测试。

本补充结论仅覆盖源码、针对性测试与合成仓库数据链，尚不绑定重建后的最终包。最终包及 GUI 的非 Git 目录、弹窗关闭后继续审阅和真实宿主验收仍由 QA／主负责人另行核对。

## 系统文件夹选择器评审（CR-06 至 CR-08）

本轮基线仍为 `3dd7e30ff0fa336a21efa32cf4242f7288f645cc`，审核对象为 0.1.1 候选的未提交工作区。范围是启动、轮询、取消、跨窗口归属、进程退出、UI 迟到结果与草稿保护，以及 native helper 打包和测试宿主工具白名单；没有重新审核全部既有业务实现。

以下 18 个文件在独立编译和定向测试前后指纹一致：`src/codex/{folder-picker,controller,contract,validation,server}.ts`、`web/codex/{store,model,app,bridge}.ts`、`native/codex-folder-picker/{main.m,Info.plist,build.cjs}`、`scripts/{build-codex,check-codex-package}.cjs`、`scripts/codex-test-host/main.swift`、`test/codex/{folder-picker,ui-picker,ui}.test.cjs`。按相对路径排序，以各文件 SHA-256 组成无额外空白的 JSON 对象，再取 SHA-256，集合指纹为：

`b6a4d054cbc2f75e34f5632d622e69665e3745da21e1434699a6208a037ece78`

| 关键文件 | SHA-256 |
| --- | --- |
| `src/codex/folder-picker.ts` | `cbeff288c63208a6009740bb3417d193891508056fa5e43c8cf7ee98d163026b` |
| `src/codex/controller.ts` | `ecda994b7f3ee70350b67183190e0a10ed300d1724550aab7a0c9e13f1bb4ecf` |
| `web/codex/app.ts` | `d20b2cd2b58079f859886509bff48de537d18222036049afb9cd8babfc4d1c00` |
| `web/codex/model.ts` | `c5815301d9e315876618b79552e8326c60f29c4e207f9441c27d6a633ef0446e` |
| `native/codex-folder-picker/main.m` | `5b47beafc039a26b3aad5e43b687bfe93b57bfd9f201ff9020dccdd28e60038b` |

### 本轮发现及修复复核

| 发现 | 触发、影响与独立证据 | 修复及复验结果 |
| --- | --- | --- |
| CR-06，P2：目录校验期间提前发布失败，取消被迟到结果覆盖 | 原 `folder-picker.ts` 的子进程 close 回调先写 `failed/invalid-result`，再等待目录 `stat`。独立合成子进程及延迟 I/O 探针实测：校验期间 poll 返回失败，随后 cancel 却返回 selected；前端会停止轮询，合法选择丢失。校验不返回还会拖住取消与连接关闭 | 选择阶段只校验有界结果协议和绝对路径，不再读取默认或选中目录。目录及 Git 校验统一交给既有 `openWorkspace`。当前回调同步收束；用户卷 `stat` 永不完成的注入下，实际调用次数为 0，选择及关闭均完成；虚假文件路径仍由 `openWorkspace` 拒绝，最近项目保持。通过 |
| CR-07，P2：其他窗口长操作阻塞选择器续租 | 原 `controller.dispatch()` 把 picker 三动作也排入业务队列。独立两窗口探针暂停偏好写入 2.5 秒，将租约缩为 1.2 秒；活跃窗口立即发出的 poll 等待 2.57 秒后返回 cancelled。默认配置对应业务请求超过 15 秒时误取消 | 仅三个 picker 动作在认证后旁路业务队列，普通读写继续串行。原探针复验：业务仍阻塞期间 13 次 poll 全为 pending，最长 6 ms；取消 12 ms 完成。通过 |
| CR-08，P2：系统选中路径被 trim 后指向其他目录 | 原 `app.ts` 的公共打开函数对系统选择、最近项目和手输路径统一 `trim()`；合法目录名末尾空格被删除，可能打开相邻仓库 | 公共函数原样传递路径，手输按钮单独规范化。审核者提取实际 app 打开闭包，经 TypeScript 转换后执行，确认含末尾空格的合成路径原样送入 `Store.open`；并核对 Git 根解析不 trim 空格。源码通过；真实系统面板相邻目录交互由 QA 补验 |

### 实际验证与限制

环境为 macOS、Node.js `v23.11.0`。审核者独立执行 TypeScript 编译到临时 `dist`，复制上述三个测试入口至隔离目录，使 require 和真实 stdio server 子进程均使用此次编译结果；UI 模块从当前源码 bundle。实际 **44 / 44 通过，0 失败、0 跳过，退出码 0，13.34 秒**。另外执行了上表的独立慢业务队列探针和 app 路径闭包探针。没有依赖仓库已有 `dist` 的新旧状态。

检查覆盖同 ID 重试、跨窗口拒绝窃取／取消、取消先于迟到启动、超时、失联租约、主动关闭及 stdio EOF 回收、异常输出、选择不产生业务回执或最近项目、选中子目录经既有打开流程取得 Git 根，以及前端取消、关闭、手动导航和断连后的迟到结果抑制。UI facade 不刷新业务错误或 unknown 状态；只有 selected 才进入已有 `Store.open()`，先保留原草稿，打开失败不 apply 新视图。源码回读同时确认 pagehide 清理、native 父进程退出检查、helper 打包路径和 app-only 工具声明。

本轮全部运行验证只用合成数据与临时仓库。真实子进程和 stdio 已执行，但 helper 为合成程序；审核者未启动 AppKit 面板或 Codex／ChatGPT 主应用，未安装、发布或修改实现。原生窗口、物理父进程崩溃、最终 ZIP／搬移包、视觉布局与真实宿主集成未在本轮独立执行。全量测试和最终包证据由 [QA](../测试/验证记录.md)及主负责人维护；源码通过不能表述为最终包或真实宿主已验收。后续上述文件变化须补查受影响范围。

## 前轮恢复审核的版本与范围

基线为 `3dd7e30ff0fa336a21efa32cf4242f7288f645cc` 加该轮未提交改动。首次评审覆盖 Codex 源码、UI、测试、插件与构建及四个共享核心文件，共 30 个文件，集合 SHA-256 为 `197141a681e8314b47a69c3713514622f5379730c97ed99dd95159293a974009`；首次发现和该轮结果如下表。

前次四项修复复验覆盖 22 个文件，集合指纹为 `759615aa4abdd908445506f3774b9ef3801c688c80a7560a96ae02ab6eddba88`。其中 app 接线核查绑定 `web/codex/app.ts` 的 SHA-256 `fd25a36a53a722706ec3606c4c4f14dd29d15ac074b7b04443a895d16a7d797f`；后续视觉改动不自动继承该结论。

该轮 CR-05 复验绑定 19 个文件：`src/codex/*.ts`、`web/codex/{store,model,bridge}.ts`、`src/{comments,git,ignore,review,model,filesystem,state,anchors}.ts`、`test/codex/{recovery,ui}.test.cjs`。按相对路径排序，将各文件 SHA-256 组成 JSON 对象后再计算 SHA-256，集合指纹为：

`40d1e21a27d53b63f543cf51113c8eec6258429e7be11ca9875ce812e134e93e`

这 19 个文件在该轮编译、原探针和定向测试执行前后指纹均未变化；正在改动的 app／CSS 及最终包不在该轮冻结范围。关键源码与回归指纹：

| 文件 | SHA-256 |
| --- | --- |
| `src/codex/storage.ts` | `71e26aa3496b57a7718c0a1322094f7964f3eb4ca632b706e8270f70006db2c6` |
| `src/codex/controller.ts` | `7a481badddb0ee902208c89bfe8dbd5d751d3f26b0948661e7db6a736d687599` |
| `web/codex/store.ts` | `70398af311ea3a80792461eb69166c5ae47e4eeb1a5be179c2594001f13c2ce3` |
| `web/codex/model.ts` | `bcc5b1fa91149167554bd8a0290a24e7881a1af3f6343d7682feaf9f9ff06222` |
| `test/codex/recovery.test.cjs` | `2c63cb15840220b575eb85ff541fc6112d44e89fbc56331a7fad3af43962f3f4` |
| `test/codex/ui.test.cjs` | `765440a71e2540f6d5d4face2a5b1761f4fa4e11b098dbc372d141e0a75e0a01` |

## CR-05 修复复核

### 进程重启后确认 pending 保存，后来输入仍用旧 epoch（P2，已修复）

原问题：草稿正文已落盘，但 committed 回执连续两次 I/O 失败；用户继续输入并重建 controller 后，查询 pending 会在仓库重绑前返回。原操作重试成功后，页面仍用旧 epoch 自动保存后来输入，得到 `STALE_CONTEXT`。此前已用真实 Store、两代 controller 和合成 Git 独立复现。

修复入口：[store.ts:238](../../web/codex/store.ts#L238) 与 [store.ts:302](../../web/codex/store.ts#L302)。重试确认原操作后先重新取得仓库视图，核对 workspace、CR、基点、分支和可写 context，归属匹配后才采用新 epoch 并保存后来输入。不能只修改请求里的 epoch 而跳过归属确认。

审核者将原重启探针重新编译到独立临时目录，保留两次回执 EIO、后来输入、关闭旧 controller／新建 controller、pending 查询与明确重试的触发链。结果为：无错误、unknown 清除、stale=false、savedSequence 等于 sequence、context 采用新 epoch；并直接读取新 view.json，确认后来输入已经持久化，原问题不再复现。

新增定向回归还覆盖重启后切分支与切活动 CR：自动继续被 `STALE_CONTEXT` 拒绝，旧归属与输入保留，不生成错误的新 view；明确执行保留动作后，后来输入写回原 CR，随后才进入当前分支／CR。相同 CR 的回归同时确认旧 view 保留原输入、新 view 保存后来输入、原 operation 为 committed。三种场景均通过，CR-05 的源码阻断解除。

上述验证使用真实 Store 与两代 controller 直接调用，不经过 stdio transport，不代表完整 GUI 或物理进程故障验收。

## 首轮发现的修复复核

| 发现 | 原触发及影响 | 该轮修复与实际复验 | 当前状态 |
| --- | --- | --- | --- |
| CR-01，P1：pending 重试覆盖原 viewId | 正文已落盘、两次 committed 回执失败；新连接覆盖应用索引 viewId，永久查不到旧槽正文 | `Registry.record()` 保留已有 intent 路由字段。两次 EIO 后跨 controller 重试成功，返回原 viewId／正文，索引 committed，新 view 槽未被错误创建 | 复验通过；CR-05 的继续保存链路也已通过 |
| CR-02，P1：dirty 草稿在外部切分支后无恢复入口 | refresh、reconnect、open 都先尝试失效 context 的 flush，正文只能留在内存 | 新显式动作 `retainAndRefresh()` 通过 `retainInactive` 把草稿留在原 CR 后进入当前分支。验证外部切分支、另一 controller 切 CR、切回恢复，以及旧 CR 归档拒绝保存且输入仍保留。UI 提供完整归属与草稿的手工导出，不把复制当保存成功 | 代码／真实 Store 链路复验通过；导出交互未做 GUI 验收 |
| CR-03，P2：标已审后增量 Diff 保留旧快照 | 当前 fingerprint 不变，左侧已审快照和 reason 改变，但旧缓存 key 不变 | `diffRenderKey()` 包含左右 hash、side、reason。另一 controller 标已审后，后端 reason 为 unchanged，新 key 与旧 key 不同；回读 app 确认渲染实际使用该函数 | 代码／数据链路复验通过；实际重绘由 GUI 补验 |
| CR-04，P2：指定提交默认基点不回填 | 默认值已存，但对话框总是 branch，commit 输入为空 | `defaultBaseSelection()` 返回 kind／ref；app 设置 select、输入值及显隐。短 SHA 保存为完整 SHA，当前 CR 不变，重新打开后仍初始化为该 commit | 代码／数据链路复验通过；实际对话框由 GUI 补验 |

CR-02 的放宽仅用于显式保留原 CR 草稿；后端仍核对仓库、epoch、reviewId、基点、原分支及未归档／未清理状态，不放宽评论或已审操作。未把新增操作当作切分支权限。

## 共享核心与 VSIX 边界

四个共享文件的该轮改动是可选参数与独立读取入口：Git 扫描排除项／可执行文件位置，评论目录／owner／忽略规则，以及 ReviewService 是否在刷新时发布派生文件。VSIX 继续使用原构造默认值与 `.code-review/`；Codex controller 注入自己的目录和规则。当前 CR、指纹、评论与存储仍有共同业务核心，因此核心变更需要两端回归；宿主 UI、连接和恢复实现没有互相依赖。

审核者用 esbuild 检查四个入口的传递依赖，实际仅包含 `comments`、`filesystem`、`git`、`ignore`、`model`、`review`、`state` 七个本地模块及 Node 内置 API，没有 Codex、DOM、CodeMirror、MCP、`vscode` 或第三方运行时模块。静态检查未发现 window／document／HTMLElement／EditorView 引入。适配边界与[本地审阅引擎](../客户端/本地审阅引擎.md#codex-核心适配决定与实施边界)说明一致。

前次边界核查的 `vsce ls --no-dependencies` 实际输出 25 个文件，包含 `dist/extension.js`，不包含 `dist/codex/`、`web/codex/` 或 `plugins/codex/`；`package.json` 的 `dist/*.js` 白名单与 `--no-dependencies` 保持这一界限。构建工具链与锁文件仍由同仓库维护，不将此结论表述为两个项目完全没有共同依赖或回归责任。该结果绑定前次 22 文件版本；此次未重新验收包选取清单或后续最终 VSIX／Codex 包。

代码编辑仍为 `editCode: false`，两侧 CodeMirror 只读，界面明确未启用；未把 E1 未完成列为缺陷。MCP 相对启动命令与不再按 Rosetta 的 uname-m 拒绝启动已回读；目标宿主工具发现结果由主负责人维护，本审核者未重复真实 CLI／GUI 发现。

## 实际验证与接续

环境：macOS、Node.js `v23.11.0`、Git `2.55.0`。该轮由审核者重新执行 TypeScript 编译到独立临时 dist，通过 require 重定向让 recovery 测试使用该目录，Store／model 另从当前源码 bundle，没有使用仓库旧 dist。

| 独立执行 | 实际结果 |
| --- | --- |
| 原 CR-05 重启探针及持久化检查 | 通过，退出码 0；原错误消失，后来输入在新 view.json 中可读 |
| recovery 与 UI 定向回归 | **34 / 34 通过、0 失败，退出码 0，43.0 秒**；包含两代 controller 的同 CR、换分支、换活动 CR 三种新场景 |
| 执行前后源码指纹核对 | 19 个被检文件无变化 |

前次 31 / 31 回归以及 CR-05 的失败复现只证明当时版本；当前结论依据以上重新执行结果。定向测试同时保留 operation 父目录符号链接拒绝检查，完整安全结论仍由独立安全角色维护。

所有验证仅使用临时合成仓库、隔离应用目录与虚构正文，未操作真实审阅仓库或安装配置。探针和原始输出已交主负责人；运行时代码、测试、CSS 与共享契约均未由审核者改动。

该轮未运行全量 `npm test`、VSIX／Codex 最终打包、真实 GUI、clipboard 或实际断电。其他结果由 [QA 记录](../测试/验证记录.md)与主负责人分别维护。恢复源码阻断已解除；下一步由 QA 验证最新界面与同版本最终包，特别是 CR-02／03／04 的实际交互。后续 app、核心或包装变化仍按实际差异复核，不能把该轮源码结论扩展为最终包交付完成。

此前 `20261103-docs` 的文档契约发现（永久删除失败阶段、退出不取消在途动作）已修正复核，仅属于旧文档轮次，不作为本候选通过依据。
