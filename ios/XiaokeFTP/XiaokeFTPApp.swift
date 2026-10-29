import SwiftUI
import UIKit
import WebKit

/// 小柯機器人FTP助手 — iPhone／iPad 版
/// WKWebView 開啟 App 內建的手機版網頁（和 Android 版同一份畫面程式），由 LocalServer 在 127.0.0.1 提供；
/// FTP／SFTP／WebDAV 與檔案讀寫由 Native 負責。本機檔案放在 App 的「文件」資料夾，「檔案」App 裡看得到。
@main
struct XiaokeFTPApp: App {
    @Environment(\.scenePhase) private var phase
    init() { LocalServer.shared.start() }

    var body: some Scene {
        WindowGroup {
            WebContainer()
                .background(Color(red: 0.933, green: 0.953, blue: 0.984))
                .ignoresSafeArea(.container, edges: .bottom)
        }
        .onChange(of: phase) { _, p in
            // 切到背景時向系統多要一點時間，讓傳輸中的檔案有機會傳完
            if p == .background { Web.shared.beginBackground() } else if p == .active { Web.shared.endBackground() }
        }
    }
}

struct WebContainer: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { Web.shared.view }
    func updateUIView(_ v: WKWebView, context: Context) {}
}

final class Web: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    static let shared = Web()
    let view: WKWebView
    private var bgTask: UIBackgroundTaskIdentifier = .invalid

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        let ver = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let model = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        // 讓網頁知道自己在 iPhone／iPad App 裡（mobile/xk-native.js 會改用原生功能）；錯誤訊息轉到系統記錄
        let shim = WKUserScript(source: """
            window.XiaokeIOS = { info: { platform: 'ios', version: '\(ver)', model: '\(model)' } };
            (function () {
              function send(k, a) { try { window.webkit.messageHandlers.xkf.postMessage({ id: '', method: 'log', args: [k, Array.prototype.map.call(a, function (x) { return x && x.stack ? x.stack : String(x); }).join(' ')] }); } catch (e) {} }
              var ce = console.error.bind(console);
              console.error = function () { send('error', arguments); ce.apply(null, arguments); };
              window.addEventListener('error', function (e) { send('pageerror', [e.message + ' @' + e.filename + ':' + e.lineno]); });
              window.addEventListener('unhandledrejection', function (e) { send('rejection', [e.reason]); });
            })();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        cfg.userContentController.addUserScript(shim)
        view = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        cfg.userContentController.add(self, name: "xkf")
        Native.shared.web = self
        view.navigationDelegate = self
        view.uiDelegate = self
        view.isOpaque = false
        view.backgroundColor = UIColor(red: 0.933, green: 0.953, blue: 0.984, alpha: 1)
        view.scrollView.backgroundColor = view.backgroundColor
        view.scrollView.bounces = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) { view.isInspectable = true }
        view.load(URLRequest(url: LocalServer.shared.url))
    }

    func js(_ code: String) { DispatchQueue.main.async { self.view.evaluateJavaScript(code, completionHandler: nil) } }

    func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let body = m.body as? [String: Any], let method = body["method"] as? String else { return }
        let args = body["args"] as? [Any] ?? []
        if method == "log" { NSLog("[web %@] %@", "\(args.first ?? "")", "\(args.count > 1 ? args[1] : "")"); return }
        Native.shared.call(id: body["id"] as? String ?? "", method: method, args: args)
    }

    // 外部連結用 Safari 開
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.host != "127.0.0.1", u.scheme?.hasPrefix("http") == true, a.targetFrame?.isMainFrame != false {
            UIApplication.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { UIApplication.shared.open(u) }
        return nil
    }
    // 網頁的 confirm()（主機指紋改變時詢問）
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: msg, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "信任", style: .destructive) { _ in completionHandler(true) })
        present(a, fallback: { completionHandler(false) })
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage msg: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: msg, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(a, fallback: completionHandler)
    }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }

    func present(_ vc: UIViewController, fallback: (() -> Void)? = nil) {
        DispatchQueue.main.async {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            var top = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
            while let p = top?.presentedViewController { top = p }
            if let p = vc.popoverPresentationController {   // iPad：從畫面中央彈出
                p.sourceView = self.view
                p.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 1, height: 1)
                p.permittedArrowDirections = []
            }
            if let top { top.present(vc, animated: true) } else { fallback?() }
        }
    }

    func beginBackground() {
        guard bgTask == .invalid else { return }
        bgTask = UIApplication.shared.beginBackgroundTask(withName: "transfer") { [weak self] in self?.endBackground() }
    }
    func endBackground() {
        if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
    }
}
