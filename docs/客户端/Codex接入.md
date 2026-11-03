# Codex 接入

维护责任：客户端研发；最后核查：2026-11-03。适用范围：宿主契约、接入实现、运行时与交付门槛。状态：0.1.2 已通过官方 CLI 更新本地安装并启用，缓存资产与最终审核包一致。真实 Codex 完整面板、深色与窄窗未覆盖，候选未公开发布。来源：`3dd7e30` 加本轮源码、包清单、正式工具发现，以及集成负责人交接的安装与验证结果。

正式入口 `mcp__reviewslate__reviewslate_open` 已在当前工具列表中发现；旧探针已卸载。当前实现使用真实 Git 和独立持久化数据，独立测试应用运行包内 UI 与 stdio；工具发现及独立应用结果均不等于真实 Codex 完整面板验收。公开产品仍为 VSIX 1.0.1。本页维护宿主和包门槛，[客户端方案](Codex客户端方案.md)维护实现，[测试](../测试/README.md)维护证据；其他角色的实机结果按交接注明，不记作本文作者独立操作。

## 目标与当前范围

Codex 目标是在同一应用中持续完成 Git 人工审阅，并接续 CR、已审内容、评论和导航。各应用独立保存数据，跨应用同步或迁移不在首版范围。完整用户流程及验收规则由[产品](../产品/README.md)维护，工作区布局及交互由[设计](../设计/README.md)维护，不在此另定一套产品规则。

当前实现已包含系统文件夹选择／手动输入／最近记录、真实树／完整只读 Diff、CR 生命周期、已审、三类意见、固定 Agent 批次、导航／草稿恢复、中英偏好及断连操作核对。源码保存未启用；H1／H2／H3 与 E1 的状态分别记录。

## 公开契约与目标宿主证据

| 契约 | 已核实内容 | 本项目使用边界 |
| --- | --- | --- |
| 打包与本地安装 | 官方支持 Skills 与可选 MCP 配置，推荐根 `plugin.json`，兼容 `.codex-plugin/plugin.json`，提供 marketplace 安装 | 正式 Codex 包使用根 `plugin.json`／`mcp.json`；VSIX 保持独立产物 |
| UI 资源与入口 | `_meta.ui.resourceUri` 关联 MCP App；`_meta["openai/ui"].entrypoints` 的 `global` 与 `thread` 对应侧栏与会话面板入口 | 官方扩展页面以 ChatGPT 为说明对象；目标 Codex 的实际入口仍须验证，不等于替换原生侧栏 |
| 页面桥接 | MCP Apps 使用父窗口 `postMessage` JSON-RPC，支持初始化、`tools/call` 与工具结果通知 | 已有公开可实现协议，无需猜测内置插件 API；不自动证明每个宿主支持全部能力 |
| 本地执行 | 官方桌面插件支持 stdio 子进程 | 当前选择本地 stdio；不引入 HTTP 监听、常驻服务或远端部署 |
| 官方目录分发 | 本地 MCP 提交要求 approved partner 资格及组织放行 | 本地安装成功不等于可以上架；当前不承诺目录发布时间 |

依据：[官方打包说明](https://developers.openai.com/plugins/build/plugins)、[Plugin Extensions](https://developers.openai.com/plugins/build/extensions)、[MCP Apps UI 示例](https://developers.openai.com/plugins/build/app-quickstart)及[桌面插件提交说明](https://developers.openai.com/plugins/deploy/desktop-only)。

当前工具发现只证明正式入口已注册；app-only 权限、组件专用 `_meta` 隔离和关闭重开仍需目标宿主证据。真实宿主的完整链路按文末 H1／H2／H3 分别验证，不把待验项写成平台不支持。

## 消息与独立测试应用

正式页面经父窗口 `postMessage` 发起 `ui/initialize`、`tools/call`，只接收父窗口有效回执。模型可见入口为 `reviewslate_open`；其余业务工具为 app-only，代码、路径、意见及凭据放在组件专用 `_meta.reviewslate`。协议、结果分类与持久化归属直接见[客户端方案](Codex客户端方案.md#三内部工具契约)，不沿用旧探针的三工具或合成 revision 协议。

[自有 AppKit／WKWebView 测试应用](../../scripts/codex-test-host/)加载实际候选包的 UI，并经 stdio 调用同包服务和运行时。它不含 Codex 代码、资产、账户或配置，没有复制、改名或重签 Codex，也没有 HTTP 监听。测试使用隔离应用数据和合成 Git 仓库，结果不能代替真实宿主的权限、入口、生命周期或兼容性。

验证分三层：自动测试检查真实 Git／持久化与模拟页面状态；最终包检查可搬移启动、资源及运行时，独立应用检查真实渲染和操作；真实 Codex 检查合法入口、iframe、工具往返和关闭重开。源文件变化后须重新打包并核对缓存，不能假定已运行会话自动采用新版本。旧探针只保留历史证据，不再作为当前开发、安装或调用入口。

## 正式包与运行时方案

源码与构建入口见[客户端方案](Codex客户端方案.md#一源码与组件边界)。以下布局已由构建器实现，当前候选版本 0.1.2，首个目标为 macOS arm64 本地仓库；其他架构、系统、远程工作区不从 VSIX 继承支持。原生选择组件编译目标为 macOS 13+；整体最低系统版本仍须结合捆绑 Node 和最终候选实测，不能只由此参数推断。

```text
reviewslate-codex/
  plugin.json
  mcp.json
  bin/launch.sh
  runtime/darwin-arm64/node
  server/index.cjs
  ui/workspace.html
  native/ReviewSlate Folder Picker.app/
    Contents/Info.plist
    Contents/MacOS/ReviewSlateFolderPicker
    Contents/_CodeSignature/CodeResources
  LICENSE
  licenses/                  # 对应确切 Node 与 UI／协议依赖版本
  build-manifest.json        # 版本、平台、依赖、文件哈希和包体测量
```

实际源包采用根 `plugin.json`、`mcp.json` 和 Agent Plugins schema，不用 Skill 代替 UI，也不靠 lifecycle hook 修改用户配置。stdio 配置如下；标准包已通过 CLI 解析及本地安装核对，真实面板另验：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "reviewslate": {
      "type": "stdio",
      "command": "./bin/launch.sh",
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

官方示例说明 `${PLUGIN_ROOT}` 用于配置内的包位置。[官方本地启动说明](https://developers.openai.com/plugins/deploy/desktop-only#configure-a-local-mcp-server) 本轮集成实测进一步确认：目标 CLI 的 Agent Plugins 解析拒绝绝对 `/bin/sh` command，采用包内相对 `./bin/launch.sh` 才能正确注册服务器；脚本通过自身位置解析 Node 和 server，不依赖开发机 Node 路径。保持根标准配置，没有回退到旧兼容目录。

launcher 检查 Darwin、包内文件和系统 Git，再 exec 包内 Node，不驻留二级进程、不做运行时下载、npm install、自动更新或登录。不能以 uname -m 判断 Apple Silicon 可用性：调用方经 Rosetta 运行时可返回 x86_64；实际架构由捆绑 Mach-O 执行约束。集成负责人固定 Node 22.23.4 arm64 并核对官方校验，来源见 scripts/codex-runtime.json，构建写 build manifest。开发机测试与捆绑运行时／最终包检查分开记录。

0.1.2 最终候选已通过 Codex 全套 102 项、VSIX 全套 112 项、UI 类型检查、两种包构建、搬移检查及[独立代码审核](../代码评审/README.md)、[本地安装前安全审核](../安全/README.md)。集成负责人通过官方 CLI `plugin add` 更新本地安装，`plugin list` 确认版本 0.1.2、installed／enabled 均为 true；缓存 35 个文件（34 项资产及 manifest）与最终清单逐项一致。

最终安装包的 manifest SHA-256 为 `c1474f2999446e3aade0c77c5cbe7f0e34c4f856e41fe1e152289a87ee3880b6`，ZIP SHA-256 为 `4f26ab790c4c781d1c65288431c7484f1cde6057e5a1651ea770bbd5ebdc9f3f`。这些指纹绑定本轮本地安装，不代表公开发布。

自有 AppKit／WKWebView 应用中，集成负责人验证了切文件再返回后的已审、评论和草稿保持；设计在最终包复验 Space 勾选回执后回焦、再次 Space 撤回，以及主动 Tab 移走后不抢回焦点。独立 32 × 32 px 箭头／checkbox 热区此前已通过边缘点击检查，最终 CSS 未变；验收后已恢复原 1/4、两条评论和合成草稿。真实 Codex 完整 GUI、深色与窄窗未覆盖，不能由独立应用通过推导完成。

运行中的旧面板不保证自动重载包。用户应等页面确认本地保存后，完全退出并重开 Codex；本轮安装未代替用户重启宿主，不删除或重置审阅数据。

### 自有系统文件夹选择组件

用户明确要求访达式文件夹选择后，新增 [Objective-C 源码](../../native/codex-folder-picker/main.m)、[Info.plist](../../native/codex-folder-picker/Info.plist) 和[构建脚本](../../native/codex-folder-picker/build.cjs)。使用系统 [NSOpenPanel](https://developer.apple.com/documentation/appkit/nsopenpanel) 的单目录选择和 [beginWithCompletionHandler](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/UsingtheOpenandSavePanels/UsingtheOpenandSavePanels.html) 异步完成回调；当前／最近记录仅作为 directoryURL 初始位置，实际目录与 Git 根仍由 openWorkspace 校验。系统 [activate](https://developer.apple.com/documentation/appkit/nsapplication/activate()) 是激活请求，不保证宿主环境一定将窗口置前，须实测。

运行 `node native/codex-folder-picker/build.cjs` 只编译并对自有组件做 ad-hoc 签名，不启动或安装应用。输出为 `artifacts/codex-native/ReviewSlate Folder Picker.app`，bundle ID `org.reviewslate.folderpicker`，版本取当前插件 manifest；arm64 可执行文件约 92 KiB，仅链接系统 AppKit，无第三方 native 依赖。源码沿用项目 MIT；系统框架不随包复制。编译使用相对源路径及 prefix-map，包构建复制完整签名目录并绑定源码／产物哈希。ad-hoc 签名不等于 Developer ID 或公证，最终安装位置和系统隔离行为另验。

运行时默认从包内 `native/ReviewSlate Folder Picker.app/Contents/MacOS/ReviewSlateFolderPicker` 启动固定程序；开发可显式指定 `REVIEW_SLATE_FOLDER_PICKER`，页面无法改变该路径。启动不经过 shell，不接受任意命令，清理继承环境，只回传有界 JSON 到组件专用 `_meta`。start／poll／cancel 经认证后旁路业务串行队列，慢 Git 操作不阻塞取消或续租。组件退出后立即回收，选择结果不落盘；超时、租约、父进程与 EOF 收尾见[客户端方案](Codex客户端方案.md#二仓库cr-与页面如何绑定)。

关闭系统“前往文件夹”辅助窗口后，主选择面板必须继续存在。组件的 `applicationShouldTerminateAfterLastWindowClosed` 返回 NO，只由选择完成、显式取消、超时或父进程退出结束本次请求。系统选择、取消及 GoTo 的既有独立应用证据见[验证记录](../测试/验证记录.md)。0.1.2 的 native 源码与构建器未变，版本更新后的签名和包一致性已由安全审核核对；真实 Codex 的宿主权限与生命周期仍待验证。开发包缺少 helper 时，界面说明不可用并保留手动路径入口。

Git 仍是本机前置条件，macOS 首个候选使用已核验的系统 Git 路径并检查可执行版本，缺失时说明安装条件，插件不触发系统安装器。Git 参数和只读白名单继续由引擎控制，server 不从页面接收任意命令。进程环境应清理不需要的 `NODE_OPTIONS`、加载器与调试注入变量，不在 stdout 输出诊断；stderr 仅保留错误分类与请求关联 ID，不记录代码、评论或完整个人路径。

捆绑 Node 可消除用户安装 Node 与 GUI PATH 差异，但增加下载／解压体积、平台分包、更新及签名兼容成本。最终 ZIP 为 37,657,153 字节，清单所列文件总量为 115,692,842 字节；Node 为 113,002,944 字节，UI 为 848,273 字节，server 为 1,526,718 字节。包冷启动和峰值内存尚未测量，不宣称与现有 VSIX 同等体积。Node 分发包含自己的 MIT 条款及多项第三方通知，必须保留该二进制对应的完整许可文本，不能只保留项目 MIT。构建同时收集实际协议／编辑器依赖的许可及来源。[Node 上游许可](https://github.com/nodejs/node/blob/v22.x/LICENSE)

可移植性测试必须使用最终解压和宿主缓存安装路径：含空格／非 ASCII 路径、最小 PATH、不在开发仓库中启动、搬移重装、升级后保留数据。核对 command、args、cwd、server/UI/manifest 同版，运行时可执行位、系统隔离与宿主安全策略均需实际检查。若目标 Codex 不支持根标准配置，记录具体安装／展开失败并交回决定，不能继续发布带个人绝对路径的包。插件支持本地安装与官方目录资格分开，当前没有上架授权或资格结论。

## 正式实现的验证门槛

未知能力收敛到下表；内部状态、草稿与数据设计已经选定，不再等待宿主替我们提供编辑器状态。每个 gate 都有明确证据和失败后的处理。

| Gate | 需取得的实际证据 | 当前状态与影响 |
| --- | --- | --- |
| H1 真实 UI 与本地通道 | 普通合法插件入口挂载 iframe；页面调用 app-only 工具；合成内容保存后重开；组件专用 `_meta` 不变成模型可见正文 | **未执行完整链路**。已安装和工具调用证据保留；独立壳不代签。失败则完整 Codex 工作区仍阻塞 |
| H2 仓库范围与隔离 | 用户在工作区选定合成仓库；本地 stdio 经宿主权限访问其 Git 与本应用目录；越界路径、链接、拒绝权限有可识别结果 | **未完成完整宿主验证**。已有本地合成仓库与独立应用结果，真实 Codex 的权限和异常矩阵仍待补证 |
| H3 最终包与进程生命周期 | 根标准配置在实际缓存路径正确展开、包内运行时启动；面板／会话／插件／宿主关闭分别核验；退出后无 HTTP 监听和孤儿工具进程 | **部分证据**。正式入口可发现，0.1.2 最终搬移检查、本地安装／启用和 35 个缓存文件一致性均通过；真实 Codex 各级生命周期仍待验 |
| E1 工作区编辑保存 | 候选保存器保持编码／权限／路径边界；外部竞争版本不静默丢失；保存中断和回执丢失可判定，真实 iframe 恢复缓冲并显式保存 | **未实施／未执行**。按[编辑方案](Codex客户端方案.md#六直接编辑的候选实现与门槛)验证；不通过交产品确定 AC-06，不能擅自降级并宣称完整交付 |

H1 的合法补证由主负责人协调宿主允许的插件专用入口或实际操作。当前对 Codex 主应用的自动控制已有拒绝，不能复制、改名、重签目标应用，也不能换一种自动化工具绕过。没有可用的合法 UI 接口时明确保留未执行，不阻止设计、独立原型和合成仓库验证继续。

这些 gate 通过后，仍须完成产品的整轮合成仓库任务、故障恢复和同一候选包的 QA／设计／产品验收。技术探针的 schema 不进入正式审阅协议，工具调用成功、模型能读到结果与真实人工审阅可用是不同层次的结论。
