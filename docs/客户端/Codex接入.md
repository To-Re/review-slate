# Codex 接入

维护责任：客户端与 Codex 接入研发；最后核查：2026-11-03。适用范围：宿主契约、接入实现、开发方法与进入正式客户端的条件。状态：接入能力验证中；完整 Git 审阅客户端未实现、未验收。来源：本文链接的公开一手资料、`689de24` 的核心代码、本地忽略的探针 0.0.2，以及集成负责人交接的目标宿主工具调用结果。

本地探针已安装且工具可调用，独立测试应用已验证合成数据读写；目标 Codex 中的 iframe 显示、点击与关闭重开尚未确认。正式产品仍为 VS Code 系扩展 1.0.1。本文维护接入决定和开发入口，[测试](../测试/README.md)维护版本、方法、产物指纹与结果；集成负责人交接的实机结果不记作本文作者独立验收。

## 目标与当前范围

Codex 目标是在同一应用中持续完成 Git 人工审阅，并接续 CR、已审内容、评论和导航。各应用独立保存数据，跨应用同步或迁移不在首版范围。完整用户流程及验收规则由[产品](../产品/README.md)维护，工作区布局及交互由[设计](../设计/README.md)维护，不在此另定一套产品规则。

当前探针只提供一个合成已审 checkbox、一段评论和持久化 revision。它不包含仓库选择、文件树、Diff、CR、真实项目评论或 Agent 处理入口；checkbox 保存成功不能解释为文件已审能力已实现。

## 公开契约与目标宿主证据

| 契约 | 已核实内容 | 本项目使用边界 |
| --- | --- | --- |
| 打包与本地安装 | 官方支持 Skills 与可选 MCP 配置，推荐根 `plugin.json`，兼容 `.codex-plugin/plugin.json`，提供 marketplace 安装 | 当前探针使用兼容格式；正式 VSIX 不直接变成 Codex 插件 |
| UI 资源与入口 | `_meta.ui.resourceUri` 关联 MCP App；`_meta["openai/ui"].entrypoints` 的 `global` 与 `thread` 对应侧栏与会话面板入口 | 官方扩展页面以 ChatGPT 为说明对象；目标 Codex 的实际入口仍须验证，不等于替换原生侧栏 |
| 页面桥接 | MCP Apps 使用父窗口 `postMessage` JSON-RPC，支持初始化、`tools/call` 与工具结果通知 | 已有公开可实现协议，无需猜测内置插件 API；不自动证明每个宿主支持全部能力 |
| 本地执行 | 官方桌面插件支持 stdio 子进程 | 当前选择本地 stdio；不引入 HTTP 监听、常驻服务或远端部署 |
| 官方目录分发 | 本地 MCP 提交要求 approved partner 资格及组织放行 | 本地安装成功不等于可以上架；当前不承诺目录发布时间 |

依据：[官方打包说明](https://developers.openai.com/plugins/build/plugins)、[Plugin Extensions](https://developers.openai.com/plugins/build/extensions)、[MCP Apps UI 示例](https://developers.openai.com/plugins/build/app-quickstart)及[桌面插件提交说明](https://developers.openai.com/plugins/deploy/desktop-only)。

探针 0.0.2 已经官方 CLI 从本地 marketplace 安装，集成负责人在目标开发会话发现工具并调用 `reviewslate_probe_open`，得到 revision 0 的合成状态。这证明了该安装环境下的工具发现与本地读取，没有证明 iframe 已被挂载。包版本是 0.0.2，当前页面和 server 的内部版本仍为 0.0.1；具体环境与验证记录见[测试](../测试/README.md)。

尚待确认的第一层组合是：普通插件入口挂载该页面，页面动作往返本地工具，关闭重开后读取相同数据。第二层是获准仓库访问、Git 视图、CR、评论与导航的完整实现。公开标准、工具调用和独立宿主结果都不能跨层代替证据；当前也不能据此断言目标宿主一定不支持该组合。

## 本地实现与消息边界

本地产物位于 `artifacts/codex-probe/`，被 Git 忽略。它们不属于 `689de24`，不进入 VSIX，普通克隆不会带有这些源码和应用；当前没有可由正式仓库版本独立复现的 Codex 产品包。

| 本地产物 | 职责 |
| --- | --- |
| `plugins/reviewslate-probe/ui.html` | 原生 HTML/CSS/JS 合成数据页面，显示草稿、连接状态、已保存摘要及 revision |
| `plugins/reviewslate-probe/server.cjs` | stdio MCP 工具；固定目录内读写合成状态，检查预期 revision 与读取失败 |
| `plugins/reviewslate-probe/ui.test.cjs` | 模拟 DOM 与父窗口消息的客户端回归 |
| `plugins/reviewslate-probe/.codex-plugin/plugin.json`、`.mcp.json` | 当前本地兼容包及固定启动配置 |
| `test-host/main.swift`、`shell.html`、`Info.plist`、`build-host.sh` | 自有 AppKit + WKWebView 应用，复用原 UI/server，标注“独立测试宿主 · 非 Codex” |

页面以 `2026-01-26` 协议发起 `ui/initialize`，成功后通知 `ui/notifications/initialized`；只接受父窗口消息。调用工具使用 `tools/call`，模型发起的工具结果通过 `ui/notifications/tool-result` 接收。工具限定为 `reviewslate_probe_open`、`reviewslate_probe_read` 和 `reviewslate_probe_save`，写操作携带 `expectedRevision`；字段实现以本地 `server.cjs` 为准，不是正式 Git 审阅 API。

有效工具回执才更新已保存摘要。保存期间重复点击被阻止，断线、超时、冲突和无效回执保留当前面板草稿；冲突后先重新读取。迟到响应不能伪装本次成功，重新读取不覆盖未保存输入。草稿只在当前面板存活，关闭后的草稿恢复尚未实现。

```mermaid
flowchart LR
    UI[同一份探针 UI] -->|父窗口 JSON-RPC| Host[目标宿主桥接或独立测试壳]
    Host -->|stdio| Server[同一份合成数据工具]
    Server --> Data[该宿主独立测试目录]
    Data --> Server
    Server -->|保留请求对应关系| Host
    Host -->|有效回执| UI
```

独立测试壳用 WKWebView 本地 URL scheme 提供 iframe，原生端只转发三个工具，Node 路径、server 路径与 `test-host/data` 由宿主固定构造，不接受页面传任意命令或文件路径。Node 完成 MCP 初始化后才加载 UI，随应用退出回收；没有 HTTP 监听。插件探针使用另一份 `artifacts/codex-probe/data`，两份合成状态不能互作恢复证据。

独立应用不含 Codex 代码、资产、账户或配置，也没有复制、改名或重签 Codex。它仅证明自有页面与 stdio 链路，不能证明真实宿主的权限、入口、生命周期或兼容性。

## 开发与安装验证

在保留本地产物的开发机上可运行：

```sh
node --test artifacts/codex-probe/plugins/reviewslate-probe/ui.test.cjs
bash artifacts/codex-probe/test-host/build-host.sh
```

构建使用系统 Swift，当前目标为 macOS arm64、macOS 13+，输出 `test-host/ReviewSlate Test Host.app` 并对自有 bundle 做本地 ad-hoc 签名，不自动启动应用。运行依赖开发机固定位置的 Node，尚未把运行时打进可分发包；不能把本机编译成功宣传为免依赖安装。

验证分三层推进，详细场景与结果由[测试](../测试/README.md)维护：

1. **页面与 stdio。** 用模拟消息和独立测试应用检查真实保存、revision 冲突、失败草稿、键盘操作及子进程回收，始终复用原 UI/server，缺少的宿主能力明确不提供。
2. **已安装产物。** 在隔离测试配置中安装本地 marketplace，核对缓存版本、资源和解析后的 command、cwd、环境与运行时；用最小 PATH、搬移及关闭场景验证实际启动配置。当前可搬移产物测试尚未完成。源变更后重新打包／安装，再用新会话验证，不能假定已运行的桌面会话重载了工具。
3. **目标桌面宿主。** 打开真实入口，检查 iframe、输入、工具调用、保存与关闭重开。自动化不可用时保留未执行项，通过获准的实际操作补证；不能拿独立应用截图或工具日志替代。

当前兼容 `.mcp.json` 使用本机绝对路径，只解决了这台开发机的启动。路径解析不能跨格式推断：官方根 `mcp.json` 的 stdio 示例支持 `${PLUGIN_ROOT}`，Callstack 则明确其兼容格式不展开该变量。正式适配器必须测试安装后解析出的实际命令和工作目录，并提供可复现的运行时；不把个人绝对路径写入可发布配置。[官方本地配置](https://developers.openai.com/plugins/deploy/desktop-only#configure-a-local-mcp-server)与[Callstack 开发说明](https://github.com/callstackincubator/codex-mobile-dev-plugin/blob/main/CONTRIBUTING.md#build-and-package)分别说明了这些环境。

开发方法参考 MCP Apps 的[测试指南](https://apps.extensions.modelcontextprotocol.io/api/documents/testing-mcp-apps.html)：参考宿主用于本地迭代，兼容宿主用于真实环境检查。其 HTTP 服务和隧道示例不符合本项目约束，本项目使用 stdio。Callstack 的[共享 UI/server、独立 Mac 应用与安装测试](https://github.com/callstackincubator/codex-mobile-dev-plugin/blob/main/CONTRIBUTING.md)提供同类工程参照；21st 的[本地测试说明](https://github.com/21st-dev/codex-plugin/blob/main/README.md#local-testing)强调缓存安装、源变更重装和新会话验证，并说明离线检查不证明 iframe。这些是方法依据，不是 ReviewSlate 的验收记录。

## 进入正式客户端的条件

接入门槛仍是先在目标宿主打开合成页面、点击保存并核对落盘，再关闭重开读取同一记录，同时确认没有 HTTP 监听或残留工具进程。已取得的安装和工具调用证据继续有效，尚缺的 UI 交互证据要补齐；不能把当前状态整体写成未开始，也不能写成 Codex 客户端已完成。

门槛通过后，使用临时合成 Git 仓库实现纵向流程：选择仓库与固定基点，读取真实变更树和 Diff，保存文件评论及已审状态，重开接续，再检查内容变化和切分支恢复。后续完整范围由[产品](../产品/README.md)定义，QA 验证由[测试](../测试/README.md)维护，避免把合成探针的 schema 沿用成正式审阅数据模型。

正式适配的职责划分如下：

| 边界 | 客户端必须保留的约束 | 协作方向 |
| --- | --- | --- |
| 核心复用 | 复用 Git、内容身份、CR、锚点和持久化，不绕过现有服务层；`extension.ts` 的脏文件和陈旧 Diff 检查也需有对应实现 | [本地审阅引擎](../客户端/本地审阅引擎.md) |
| 可序列化接口 | 明确定义请求身份、版本与错误语义；现有 `ReviewService` 的 Buffer、Map 和异常字符串不是稳定 RPC 契约 | 客户端研发确定字段，代码作为真源 |
| 数据隔离 | 正式 Codex 数据拟使用仓库内 `.reviewslate/codex/`，尚未实施；不读写现有 `.code-review/` 或其他编辑器存储 | [数据协议](../客户端/数据协议.md)负责格式、迁移、原子写与恢复设计 |
| 编辑与保存 | 直接编辑须有可靠的保存和脏状态接口；无法保证时提供只读 Diff 与保存后刷新，不虚构可编辑工作区 | 产品、设计确认体验，客户端实现 |
| 并发与归属 | 路径、分支、CR、内容指纹与评论 revision 都重新校验；旧页面、双窗口和中断重试不能写错对象 | 核心提供写入 guard，客户端绑定展示身份 |
| Agent 接续 | 查看只取当前所需数据；用户发起处理后读取指定 CR，回执与人工复核分开，不替用户解决评论 | 产品与核心定义交接语义，客户端提供入口 |

运行时、可搬移打包、声明能力、正式源码位置及真实宿主交互仍需闭环。若目标桥接验证失败，应记录具体缺失能力并暂停完整交互版选择；不自动改成云服务、localhost 网站或仅 Skill 交接，也不以新增跨应用同步绕开问题。
