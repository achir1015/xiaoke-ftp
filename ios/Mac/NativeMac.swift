import AppKit
import UniformTypeIdentifiers

/// Mac 版（Mac App Store，沙盒）才有的原生功能。
/// 沙盒裡只能讀寫「下載」資料夾和使用者在開啟視窗選過的資料夾／檔案；
/// 選過的位置用 security-scoped bookmark 記在 UserDefaults，下次開 App 自動恢復授權。
extension Native {
    // MARK: 授權過的資料夾
    private static let bookmarkKey = "grantedBookmarks"
    private static var granted: [URL] = []

    /// App 啟動時恢復上次授權的資料夾與檔案
    static func restoreGrants() {
        var keep: [Data] = []
        for d in UserDefaults.standard.array(forKey: bookmarkKey) as? [Data] ?? [] {
            var stale = false
            guard let u = try? URL(resolvingBookmarkData: d, options: .withSecurityScope, relativeTo: nil, bookmarkDataIsStale: &stale),
                  u.startAccessingSecurityScopedResource() else { continue }
            granted.append(u)
            keep.append(stale ? ((try? u.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)) ?? d) : d)
        }
        UserDefaults.standard.set(keep, forKey: bookmarkKey)
    }
    private static func remember(_ u: URL) {
        guard !granted.contains(where: { $0.path == u.path }),
              let d = try? u.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil) else { return }
        _ = u.startAccessingSecurityScopedResource()
        granted.append(u)
        var all = UserDefaults.standard.array(forKey: bookmarkKey) as? [Data] ?? []
        all.append(d)
        UserDefaults.standard.set(all, forKey: bookmarkKey)
    }

    /// 真正的「下載」資料夾（沙盒裡的 home 是 App 容器，要用使用者帳號的家目錄）
    static var downloads: URL {
        let home = getpwuid(getuid()).flatMap { String(validatingUTF8: $0.pointee.pw_dir) } ?? NSHomeDirectory()
        return URL(fileURLWithPath: home).appendingPathComponent("Downloads")
    }

    func places() -> [String: Any] {
        var list: [[String: Any]] = [["name": "下載", "path": Self.downloads.path, "icon": "down"]]
        for u in Self.granted {
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir), isDir.boolValue, u.path != Self.downloads.path {
                list.append(["name": u.lastPathComponent, "path": u.path, "icon": "open"])
            }
        }
        list.append(["name": "加入其他資料夾…", "path": "", "icon": "plus", "grant": true])
        return ["places": list, "drives": [] as [Any], "home": Self.downloads.path, "root": ["name": "下載", "path": Self.downloads.path]]
    }

    /// 刪除：放到垃圾桶（和桌面版一樣可以復原）
    func deleteLocal(_ paths: [String]) throws {
        for p in paths {
            do { try FileManager.default.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: nil) }
            catch { try FileManager.default.removeItem(atPath: p) }
        }
    }

    private static var activity: NSObjectProtocol?
    func keepAwake(_ on: Bool) {
        if on, Self.activity == nil { Self.activity = ProcessInfo.processInfo.beginActivity(options: [.idleSystemSleepDisabled, .userInitiated], reason: "傳輸檔案") }
        if !on, let a = Self.activity { ProcessInfo.processInfo.endActivity(a); Self.activity = nil }
    }
    func openExternal(_ u: URL) { DispatchQueue.main.async { NSWorkspace.shared.open(u) } }
    func preview(_ url: URL) { NSWorkspace.shared.open(url) }                                   // 用預設的 App 開啟
    func share(_ url: URL) { NSWorkspace.shared.activateFileViewerSelecting([url]) }           // 在 Finder 中顯示
    func importFiles(into dir: String, photos: Bool) throws -> Int { 0 }

    /// 系統的開啟視窗：選資料夾或檔案，並記住授權
    func pickPaths(title: String, folders: Bool) throws -> Any? {
        let sem = DispatchSemaphore(value: 0)
        var out: [String] = []
        DispatchQueue.main.async {
            let p = NSOpenPanel()
            p.message = title
            p.prompt = folders ? "選擇資料夾" : "選擇"
            p.canChooseDirectories = folders
            p.canChooseFiles = !folders
            p.canCreateDirectories = folders
            p.allowsMultipleSelection = false
            p.showsHiddenFiles = !folders   // 私鑰常放在 ~/.ssh
            p.directoryURL = Self.downloads
            let done = { (r: NSApplication.ModalResponse) in
                if r == .OK { for u in p.urls { Self.remember(u); out.append(u.path) } }
                sem.signal()
            }
            if let w = NSApp.keyWindow ?? NSApp.windows.first { p.beginSheetModal(for: w, completionHandler: done) } else { done(p.runModal()) }
        }
        sem.wait()
        return folders ? (out.first as Any? ?? NSNull()) : out
    }
}
