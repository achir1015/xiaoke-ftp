import SwiftUI
import AppKit
import WebKit

/// 小柯機器人FTP助手 — Mac 版（Mac App Store）
/// 和 iPhone／iPad 版共用 FTP／SFTP／WebDAV 與檔案程式（Native），畫面是電腦版版面（mobile/xk-native.js 的 desktop 模式）。
@main
struct XiaokeFTPMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    init() {
        Native.restoreGrants()
        LocalServer.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            WebContainer()
                .frame(minWidth: 980, minHeight: 620)
                .background(Color(red: 0.933, green: 0.953, blue: 0.984))
        }
        .defaultSize(width: 1280, height: 820)
        .commands { CommandGroup(replacing: .newItem) {} }   // 只有一個視窗
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ n: Notification) { Native.shared.shutdown() }
}

struct WebContainer: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { Web.shared.view }
    func updateNSView(_ v: WKWebView, context: Context) {}
}

/// 從 Finder 拖檔案進視窗：網頁只拿得到檔名，所以拖進來時先把完整路徑交給網頁（window.__xkDropPaths），
/// 放開後網頁用檔名對回路徑再上傳（沙盒會讓 App 讀取使用者拖進來的檔案）
final class DropWebView: WKWebView {
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation {
        let urls = s.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        if let d = try? JSONSerialization.data(withJSONObject: urls.map { $0.path }), let j = String(data: d, encoding: .utf8) {
            evaluateJavaScript("window.__xkDropPaths = \(j)", completionHandler: nil)
        }
        return super.draggingEntered(s)
    }
}

final class Web: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    static let shared = Web()
    let view: WKWebView

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        // desktop：用電腦版版面；store：App Store 版（不顯示「更新」）
        let shim = WKUserScript(source: """
            window.XiaokeIOS = { info: { platform: 'mac', version: '\(ver)', model: 'Mac', store: true, desktop: true } };
            (function () {
              function send(k, a) { try { window.webkit.messageHandlers.xkf.postMessage({ id: '', method: 'log', args: [k, Array.prototype.map.call(a, function (x) { return x && x.stack ? x.stack : String(x); }).join(' ')] }); } catch (e) {} }
              var ce = console.error.bind(console);
              console.error = function () { send('error', arguments); ce.apply(null, arguments); };
              window.addEventListener('error', function (e) { send('pageerror', [e.message + ' @' + e.filename + ':' + e.lineno]); });
              window.addEventListener('unhandledrejection', function (e) { send('rejection', [e.reason]); });
            })();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        cfg.userContentController.addUserScript(shim)
        // 自動測試：XK_SELFTEST='{...}' 啟動時，網頁載入後執行 js/selftest.js
        if let t = ProcessInfo.processInfo.environment["XK_SELFTEST"], !t.isEmpty {
            cfg.userContentController.addUserScript(WKUserScript(source: "window.__XK_SELFTEST = \(t); var s = document.createElement('script'); s.src = 'js/selftest.js'; document.head.appendChild(s);", injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        view = DropWebView(frame: .zero, configuration: cfg)
        super.init()
        cfg.userContentController.add(self, name: "xkf")
        Native.shared.web = self
        view.navigationDelegate = self
        view.uiDelegate = self
        view.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { view.isInspectable = true }
        view.load(URLRequest(url: LocalServer.shared.url))
    }

    func js(_ code: String) { DispatchQueue.main.async { self.view.evaluateJavaScript(code, completionHandler: nil) } }

    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let method = body["method"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        if method == "log" { Self.log("[web \(args.first ?? "")] \(args.count > 1 ? args[1] : "")"); return }
        Native.shared.call(id: body["id"] as? String ?? "", method: method, args: args)
    }

    // 外部連結用預設瀏覽器開
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.host != "127.0.0.1", u.scheme?.hasPrefix("http") == true, a.targetFrame?.isMainFrame != false {
            NSWorkspace.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { NSWorkspace.shared.open(u) }
        return nil
    }
    // 網頁的 confirm()／alert()（例如主機指紋改變時詢問）
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = msg
        a.addButton(withTitle: "信任")
        a.addButton(withTitle: "取消")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = msg
        a.addButton(withTitle: "好")
        a.runModal()
        completionHandler()
    }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { Self.log("網頁程序結束，重新載入"); w.reload() }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { Self.log("網頁載入完成 \(w.url?.absoluteString ?? "")") }
    func webView(_ w: WKWebView, didFailProvisionalNavigation n: WKNavigation!, withError e: Error) { Self.log("網頁載入失敗：\(e)") }

    /// 記錄：系統記錄＋App 容器 tmp/web.log（沙盒裡，遠端除錯用）
    static func log(_ s: String) {
        NSLog("%@", s)
        let u = FileManager.default.temporaryDirectory.appendingPathComponent("web.log")
        let line = Data("\(Date()) \(s)\n".utf8)
        if let h = try? FileHandle(forWritingTo: u) { h.seekToEndOfFile(); h.write(line); try? h.close() } else { try? line.write(to: u) }
    }
}
