import AppKit
import WebKit
import Foundation
import Darwin

// Independent test harness for our own HTML + stdio server. No Codex code or configuration.
struct LocalPaths {
    let root = Bundle.main.bundleURL.deletingLastPathComponent().standardizedFileURL
    var data: URL { root.appendingPathComponent("data", isDirectory: true) }
    var plugin: URL { root.deletingLastPathComponent().appendingPathComponent("codex-build/reviewslate", isDirectory: true) }
    var server: URL { plugin.appendingPathComponent("server/index.cjs") }
    var ui: URL { plugin.appendingPathComponent("ui/workspace.html") }
    var node: URL { plugin.appendingPathComponent("runtime/darwin-arm64/node") }
    var shell: URL { Bundle.main.resourceURL!.appendingPathComponent("shell.html") }

    func validate() throws {
        let fm = FileManager.default
        for file in [server, ui, shell, node] {
            guard file.standardizedFileURL == file.resolvingSymlinksInPath(), fm.isReadableFile(atPath: file.path) else {
                throw HostError.message("测试文件不存在、不可读或包含符号链接。请在原目录重新构建。")
            }
        }
        if !fm.fileExists(atPath: data.path) {
            try fm.createDirectory(at: data, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        let values = try data.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isDirectory == true, values.isSymbolicLink != true,
              data.standardizedFileURL == data.resolvingSymlinksInPath() else {
            throw HostError.message("独立测试数据目录不安全；未启动工具。")
        }
    }
}

enum HostError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

final class StdioBridge {
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private var buffer = Data()
    private let readerQueue = DispatchQueue(label: "org.reviewslate.codextesthost.stdout")
    private var sequence = 0
    private var stopped = false
    private var started = false
    private struct Pending { let timer: Timer; let completion: ([String: Any]) -> Void }
    private var pending: [Int: Pending] = [:]
    var onFailure: ((String) -> Void)?
    private(set) var ready = false

    func start(paths: LocalPaths, completion: @escaping (Bool) -> Void) {
        guard !started else { completion(false); return }
        started = true
        process.executableURL = paths.node
        process.arguments = [paths.server.path]
        process.currentDirectoryURL = paths.plugin
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "REVIEW_SLATE_DATA_DIR": paths.data.path]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { handle.readabilityHandler = nil; return }
            guard let self else { return }
            self.readerQueue.async { self.consume(chunk) }
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { handle.readabilityHandler = nil; return }
            // Do not surface raw process environment or payloads in diagnostics.
            DispatchQueue.main.async { self?.onFailure?("本地 stdio 工具输出了错误，请检查独立测试目录与工具状态。") }
        }
        process.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            DispatchQueue.main.async {
                guard let self, !self.stopped else { return }
                self.fail("本地 stdio 工具已退出（状态 \(status)）；当前页面草稿保留，请关闭并重新打开独立测试宿主。")
            }
        }
        do {
            try process.run()
            request(method: "initialize", params: [
                "protocolVersion": "2025-06-18", "capabilities": [:],
                "clientInfo": ["name": "reviewslate-independent-test-host", "version": "0.0.1"]
            ]) { [weak self] message in
                guard let self, message["error"] == nil, message["result"] is [String: Any] else {
                    completion(false); return
                }
                do {
                    try self.write(["jsonrpc": "2.0", "method": "notifications/initialized"])
                    self.ready = true
                    completion(true)
                } catch {
                    self.fail("MCP 初始化确认失败。")
                    completion(false)
                }
            }
        } catch {
            fail("无法启动包内 Node。请先运行 package:codex 并检查安装包。")
            completion(false)
        }
    }

    func request(method: String, params: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        sequence += 1
        let id = sequence
        guard process.isRunning, !stopped else {
            completion(["error": ["code": -32000, "message": "本地 stdio 工具未运行。"]]); return
        }
        let timer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { [weak self] _ in
            guard let operation = self?.pending.removeValue(forKey: id) else { return }
            operation.completion(["error": ["code": -32001, "message": "stdio 响应超时；保存结果未知，请重新读取确认。"]])
        }
        pending[id] = Pending(timer: timer, completion: completion)
        do { try write(["jsonrpc": "2.0", "id": id, "method": method, "params": params]) }
        catch { fail("无法写入本地工具的 stdin；保存结果需重新读取确认。") }
    }

    private func write(_ message: [String: Any]) throws {
        var bytes = try JSONSerialization.data(withJSONObject: message)
        bytes.append(0x0a)
        try input.fileHandleForWriting.write(contentsOf: bytes)
    }

    private func consume(_ chunk: Data) {
        buffer.append(chunk)
        guard buffer.count <= 16777216 else {
            buffer.removeAll()
            DispatchQueue.main.async { [weak self] in self?.fail("工具响应超过测试宿主限制。") }
            return
        }
        while let end = buffer.firstIndex(of: 0x0a) {
            let line = Data(buffer[..<end])
            buffer.removeSubrange(...end)
            guard !line.isEmpty else { continue }
            do {
                guard let message = try JSONSerialization.jsonObject(with: line) as? [String: Any],
                      message["jsonrpc"] as? String == "2.0" else { throw HostError.message("Invalid JSON-RPC") }
                DispatchQueue.main.async { [weak self] in
                    guard let self, let id = message["id"] as? Int,
                          let operation = self.pending.removeValue(forKey: id) else { return }
                    operation.timer.invalidate()
                    operation.completion(message)
                }
            } catch {
                DispatchQueue.main.async { [weak self] in self?.fail("工具返回了无效 JSON-RPC；未确认任何保存结果。") }
            }
        }
    }

    private func fail(_ text: String) {
        ready = false
        let operations = pending.values
        pending.removeAll()
        for operation in operations {
            operation.timer.invalidate()
            operation.completion(["error": ["code": -32000, "message": text]])
        }
        onFailure?(text)
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        ready = false
        for operation in pending.values { operation.timer.invalidate() }
        pending.removeAll()
        output.fileHandleForReading.readabilityHandler = nil
        errors.fileHandleForReading.readabilityHandler = nil
        try? input.fileHandleForWriting.close()
        if process.isRunning {
            process.terminate()
            for _ in 0..<40 { if !process.isRunning { break }; usleep(10000) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
        try? output.fileHandleForReading.close()
        try? errors.fileHandleForReading.close()
    }
    deinit { stop() }
}

// An in-process URL scheme serves exactly two local files, with no HTTP listener.
final class LocalScheme: NSObject, WKURLSchemeHandler {
    let paths: LocalPaths
    init(paths: LocalPaths) { self.paths = paths }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.scheme == "reviewslate-test", url.host == "host",
              task.request.httpMethod == nil || task.request.httpMethod == "GET",
              ["/shell.html", "/ui.html"].contains(url.path), url.query == nil else {
            task.didFailWithError(HostError.message("测试宿主拒绝了未允许的资源。")); return
        }
        do {
            let file = url.path == "/shell.html" ? paths.shell : paths.ui
            let content = try Data(contentsOf: file)
            let headers = ["Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src reviewslate-test:; connect-src 'none'; img-src data:; base-uri 'none'; form-action 'none'"]
            task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
            task.didReceive(content)
            task.didFinish()
        } catch { task.didFailWithError(HostError.message("无法读取本地测试页面。")) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private let paths = LocalPaths()
    private let bridge = StdioBridge()
    private var window: NSWindow!
    private var webView: WKWebView!
    private let status = NSTextField(wrappingLabelWithString: "正在启动独立 stdio 工具…")
    private let allowedTools: Set<String> = ["reviewslate_open", "reviewslate_bootstrap", "reviewslate_workspace_open", "reviewslate_preferences", "reviewslate_read", "reviewslate_review_change", "reviewslate_review_purge", "reviewslate_mark", "reviewslate_comment_change", "reviewslate_view_save", "reviewslate_handoff_prepare", "reviewslate_folder_pick"]

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenus()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.setURLSchemeHandler(LocalScheme(paths: paths), forURLScheme: "reviewslate-test")
        configuration.userContentController.add(self, name: "reviewSlateBridge")
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.setAccessibilityLabel("ReviewSlate 独立测试页面，非 Codex")
        createWindow()
        do { try paths.validate() }
        catch { showStatus(error.localizedDescription, error: true); return }
        bridge.onFailure = { [weak self] text in self?.showStatus(text, error: true) }
        bridge.start(paths: paths) { [weak self] success in
            guard let self else { return }
            if success {
                self.showStatus("stdio 已就绪 · 实际客户端 · 仅选测试仓库 · 未验证 Codex 集成")
                self.webView.load(URLRequest(url: URL(string: "reviewslate-test://host/shell.html")!))
            } else { self.showStatus("stdio 初始化失败，页面未开放。关闭后检查本地文件再重开。", error: true) }
        }
    }

    private func createWindow() {
        let visible = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1024, height: 768)
        let size = NSSize(width: min(1440, visible.width - 50), height: min(900, visible.height - 70))
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "ReviewSlate Client Test Host — 独立测试宿主 · 非 Codex"
        window.setAccessibilityTitle("ReviewSlate Client Test Host，独立测试宿主，非 Codex")
        window.minSize = NSSize(width: 440, height: 500)
        let container = NSView()
        window.contentView = container
        let title = NSTextField(labelWithString: "独立测试宿主 · 非 Codex")
        title.font = .boldSystemFont(ofSize: 16)
        title.textColor = .systemPurple
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        for view in [title, status, webView!] {
            view.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(view)
        }
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: container.topAnchor, constant: 14),
            title.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
            title.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -18),
            status.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 5),
            status.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            status.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -18),
            status.heightAnchor.constraint(greaterThanOrEqualToConstant: 30),
            webView.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 10),
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private func showStatus(_ text: String, error: Bool = false) {
        status.stringValue = text
        status.textColor = error ? .systemRed : .secondaryLabelColor
        status.setAccessibilityValue(text)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "reviewSlateBridge", message.frameInfo.isMainFrame,
              message.frameInfo.request.url?.scheme == "reviewslate-test",
              message.frameInfo.request.url?.host == "host",
              message.frameInfo.request.url?.path == "/shell.html",
              let body = message.body as? [String: Any], body["jsonrpc"] as? String == "2.0",
              let method = body["method"] as? String else { return }
        if method == "ui/notifications/initialized" { return }
        guard let id = body["id"], id is NSNumber || id is String else { return }
        guard bridge.ready else { replyError(id, "stdio 工具未连接。请关闭并重开独立测试宿主。"); return }
        let params = body["params"] as? [String: Any] ?? [:]
        if method == "ui/initialize" {
            guard params["protocolVersion"] as? String == "2026-01-26" else { replyError(id, "不支持的 UI 协议版本。"); return }
            deliver(["jsonrpc": "2.0", "id": id, "result": [
                "protocolVersion": "2026-01-26", "hostCapabilities": ["serverTools": [:]],
                "hostInfo": ["name": "ReviewSlate Independent Test Host (not Codex)", "version": "0.0.1"],
                "hostContext": ["displayMode": "fullscreen", "theme": "light", "locale": "zh-CN"]
            ]])
            return
        }
        guard method == "tools/call", let name = params["name"] as? String, allowedTools.contains(name),
              let arguments = params["arguments"] as? [String: Any] else {
            replyError(id, "独立测试宿主只允许既定的 ReviewSlate 工具。"); return
        }
        guard let encoded = try? JSONSerialization.data(withJSONObject: arguments), encoded.count <= 2097152 else {
            replyError(id, "工具参数超过测试限制。"); return
        }
        bridge.request(method: "tools/call", params: ["name": name, "arguments": arguments]) { [weak self] response in
            var forwarded = response
            forwarded["jsonrpc"] = "2.0"
            forwarded["id"] = id
            self?.deliver(forwarded)
        }
    }

    private func replyError(_ id: Any, _ text: String) {
        deliver(["jsonrpc": "2.0", "id": id, "error": ["code": -32600, "message": text]])
    }

    private func deliver(_ message: [String: Any]) {
        webView.callAsyncJavaScript("window.reviewSlateTestHost.receive(message);", arguments: ["message": message], in: nil, in: .page) { [weak self] result in
            if case .failure = result { self?.showStatus("无法把工具响应交回测试页面；保存结果需重新读取确认。", error: true) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url
        let local = url?.scheme == "reviewslate-test" && url?.host == "host" && ["/shell.html", "/ui.html"].contains(url?.path ?? "")
        let empty = url?.absoluteString == "about:blank" && action.targetFrame?.isMainFrame == false
        decisionHandler(local || empty ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showStatus("本地测试页面加载失败：" + error.localizedDescription, error: true)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showStatus("测试页面进程已退出。关闭前未保存的页面草稿无法恢复；已保存数据仍在独立目录。", error: true)
    }

    private func installMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "ReviewSlate Client Test Host")
        appMenu.addItem(withTitle: "隐藏 ReviewSlate Client Test Host", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 ReviewSlate Client Test Host", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let edit = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        for (title, action, key) in [("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        edit.submenu = editMenu
        menu.addItem(edit)
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApplication.shared.mainMenu = menu
        NSApplication.shared.windowsMenu = windowMenu
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "reviewSlateBridge")
        bridge.stop()
    }
}

signal(SIGPIPE, SIG_IGN)
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = AppDelegate()
application.delegate = delegate
application.run()
