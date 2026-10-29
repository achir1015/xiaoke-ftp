import Foundation
import UIKit
import AVFoundation
import CryptoKit
import Security
import QuickLook
import PhotosUI
import UniformTypeIdentifiers

/// 網頁呼叫的原生功能（和 Android 版 Bridge.java 相同的方法名稱）：
/// 網頁 postMessage({ id, method, args }) → 背景執行 → window.__xkDone(id, { ok, data | error })；事件用 window.__xkEvent(name, data)
final class Native: NSObject {
    static let shared = Native()
    weak var web: Web?

    private var conns: [String: Conn] = [:]
    private var running: [String: Conn] = [:]
    private var meters: [String: Meter] = [:]
    private let lock = NSLock()
    private var seq = 1
    let down = Bucket(), up = Bucket()

    // MARK: 回覆網頁
    func emit(_ name: String, _ data: Any) {
        guard let json = try? JSONSerialization.data(withJSONObject: data), let s = String(data: json, encoding: .utf8) else { return }
        web?.js("window.__xkEvent&&window.__xkEvent(\(Self.quote(name)),\(s))")
    }
    static func quote(_ s: String) -> String {
        let d = try! JSONSerialization.data(withJSONObject: [s])
        return String(String(data: d, encoding: .utf8)!.dropFirst().dropLast())
    }
    private func done(_ id: String, _ r: [String: Any]) {
        let json = (try? JSONSerialization.data(withJSONObject: r)).flatMap { String(data: $0, encoding: .utf8) } ?? #"{"ok":false,"error":"回傳資料格式錯誤"}"#
        web?.js("window.__xkDone&&window.__xkDone(\(Self.quote(id)),\(json))")
    }

    func call(id: String, method: String, args: [Any]) {
        // 需要等使用者操作（匯入、語音）的在主執行緒處理，其他放背景
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let v = try self.dispatch(method, args)
                self.done(id, ["ok": true, "data": v ?? NSNull()])
            } catch {
                self.done(id, ["ok": false, "error": friendly(error), "raw": "\(error)"])
            }
        }
    }

    // MARK: 限速與計量
    final class Bucket {
        var rate: Double = 0
        private var avail: Double = 0, t = Date()
        private let l = NSLock()
        func take(_ n: Int) {
            l.lock()
            guard rate > 0 else { l.unlock(); return }
            let now = Date()
            avail = min(rate, avail + now.timeIntervalSince(t) * rate)
            t = now
            avail -= Double(n)
            let wait = avail < 0 ? min(5, -avail / rate) : 0
            l.unlock()
            if wait > 0 { Thread.sleep(forTimeInterval: wait) }
        }
    }
    final class Meter {
        let tid: String; let bucket: Bucket; var done: Int64; var stop = false; var last = Date.distantPast
        let report: (String, Int64) -> Void
        init(tid: String, bucket: Bucket, start: Int64, report: @escaping (String, Int64) -> Void) { self.tid = tid; self.bucket = bucket; done = start; self.report = report }
        func add(_ n: Int) throws {
            if stop { throw XKError("已取消") }
            done += Int64(n)
            bucket.take(n)
            if Date().timeIntervalSince(last) > 0.25 { last = Date(); report(tid, done) }
        }
    }

    func conn(_ cid: String) throws -> Conn {
        lock.lock(); defer { lock.unlock() }
        guard let c = conns[cid] else { throw XKError("連線已關閉，請重新連線") }
        return c
    }

    func logFor(_ label: String) -> (String) -> Void {
        return { [weak self] line in self?.emit("log", ["src": label, "line": line, "t": Date().timeIntervalSince1970 * 1000]) }
    }

    // MARK: 本機檔案（App 的「文件」資料夾，在「檔案」App 裡看得到）
    static let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

    static func localItem(_ url: URL) -> [String: Any]? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path) else { return nil }
        let dir = (a[.type] as? FileAttributeType) == .typeDirectory
        return item(url.lastPathComponent, dir ? "dir" : "file", dir ? 0 : (a[.size] as? Int64 ?? Int64(a[.size] as? Int ?? 0)), ((a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000)
    }

    func walk(_ url: URL, _ files: inout [[String: Any]], _ dirs: inout [String]) {
        dirs.append(url.path)
        for u in (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? [] {
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir)
            if isDir.boolValue { walk(u, &files, &dirs) }
            else if let it = Self.localItem(u) { files.append(["path": u.path, "size": it["size"]!, "mtime": it["mtime"]!]) }
        }
    }

    // MARK: 分派
    func dispatch(_ m: String, _ a: [Any]) throws -> Any? {
        let s = { (i: Int) -> String in a.count > i ? "\(a[i])" : "" }
        let n = { (i: Int) -> Int64 in a.count > i ? ((a[i] as? NSNumber)?.int64Value ?? Int64("\(a[i])") ?? 0) : 0 }
        let fm = FileManager.default
        switch m {
        // 遠端
        case "r.open":
            guard let site = a.first as? [String: Any] else { throw XKError("站台資料錯誤") }
            let label = (site["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? (site["host"] as? String ?? "")
            let p = site["protocol"] as? String ?? "ftp"
            let log = logFor(label)
            let c: Conn = p.hasPrefix("ftp") ? FtpConn(site: site, log: log) as Conn : p == "sftp" ? SftpConn(site: site, log: log) as Conn : DavConn(site: site, log: log) as Conn
            let home: String
            do { home = try c.connect() } catch { c.close(); log("連線失敗：" + friendly(error)); throw error }
            lock.lock(); let cid = "c\(seq)"; seq += 1; conns[cid] = c; lock.unlock()
            return ["cid": cid, "home": home, "canAppend": c.canAppend]
        case "r.list": let p = RPath.norm(s(1)); return ["path": p, "items": try conn(s(0)).list(p)]
        case "r.stat": return try conn(s(0)).stat(s(1))
        case "r.mkdir": try conn(s(0)).mkdir(s(1)); return true
        case "r.remove": try conn(s(0)).remove(s(1)); return true
        case "r.rmdir": try conn(s(0)).rmdir(s(1)); return true
        case "r.rename": try conn(s(0)).rename(s(1), s(2)); return true
        case "r.chmod": try conn(s(0)).chmod(s(1), Int(n(2))); return true
        case "r.delete":
            let c = try conn(s(0))
            func rmrf(_ p: String, _ dir: Bool) throws {
                if dir { for f in try c.list(p) { try rmrf(RPath.join(p, f["name"] as! String), (f["type"] as? String) == "dir") }; try c.rmdir(p) } else { try c.remove(p) }
            }
            for it in (a.count > 1 ? a[1] as? [[String: Any]] : nil) ?? [] { try rmrf(it["path"] as? String ?? "", (it["type"] as? String) == "dir") }
            return true
        case "r.newFile":
            let tmp = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            fm.createFile(atPath: tmp.path, contents: Data())
            defer { try? fm.removeItem(at: tmp) }
            try conn(s(0)).upload(s(1), file: tmp.path, offset: 0, append: false) { _ in }
            return true
        case "r.close":
            lock.lock(); let c = conns.removeValue(forKey: s(0)); lock.unlock()
            c?.close(); return true
        // 傳輸
        case "x.down":
            let c = try conn(s(0)), tid = s(4), start = n(3), mtime = n(5)
            let url = URL(fileURLWithPath: s(2))
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if start == 0 || !fm.fileExists(atPath: url.path) { fm.createFile(atPath: url.path, contents: nil) }
            guard let fh = FileHandle(forWritingAtPath: url.path) else { throw XKError("沒有權限寫入檔案") }
            if start > 0 { try fh.seek(toOffset: UInt64(start)) } else { try fh.truncate(atOffset: 0) }
            let meter = Meter(tid: tid, bucket: down, start: start) { [weak self] t, d in self?.emit("xfer", ["tid": t, "done": d]) }
            lock.lock(); meters[tid] = meter; running[tid] = c; lock.unlock()
            defer { try? fh.close(); lock.lock(); meters.removeValue(forKey: tid); running.removeValue(forKey: tid); lock.unlock(); emit("xfer", ["tid": tid, "done": meter.done]) }
            try c.download(s(1), startAt: start) { d in try fh.write(contentsOf: d); try meter.add(d.count) }
            if meter.stop { throw XKError("已取消") }
            if mtime > 0 { try? fm.setAttributes([.modificationDate: Date(timeIntervalSince1970: Double(mtime) / 1000)], ofItemAtPath: url.path) }
            return true
        case "x.up":
            let c = try conn(s(0)), tid = s(4), start = n(3)
            let meter = Meter(tid: tid, bucket: up, start: start) { [weak self] t, d in self?.emit("xfer", ["tid": t, "done": d]) }
            lock.lock(); meters[tid] = meter; running[tid] = c; lock.unlock()
            defer { lock.lock(); meters.removeValue(forKey: tid); running.removeValue(forKey: tid); lock.unlock(); emit("xfer", ["tid": tid, "done": meter.done]) }
            try c.upload(s(2), file: s(1), offset: start, append: start > 0) { k in try meter.add(k) }
            if meter.stop { throw XKError("已取消") }
            return true
        case "x.abort":
            lock.lock(); let mt = meters[s(0)], c = running[s(0)]; lock.unlock()
            mt?.stop = true; c?.abort(); return true
        case "x.limits": down.rate = Double(n(0)) * 1024; up.rate = Double(n(1)) * 1024; return true
        // 本機
        case "l.list":
            let url = URL(fileURLWithPath: s(0))
            let items = try fm.contentsOfDirectory(at: url, includingPropertiesForKeys: nil).compactMap { Self.localItem($0) }
            return ["path": url.path, "items": items]
        case "l.stat": return Self.localItem(URL(fileURLWithPath: s(0)))
        case "l.mkdir": try fm.createDirectory(atPath: s(0), withIntermediateDirectories: false); return true
        case "l.mkdirs": try fm.createDirectory(atPath: s(0), withIntermediateDirectories: true); return true
        case "l.newFile": if fm.fileExists(atPath: s(0)) { throw XKError("已經有同名的檔案") }; fm.createFile(atPath: s(0), contents: Data()); return true
        case "l.rename": try fm.moveItem(atPath: s(0), toPath: s(1)); return true
        case "l.delete": for p in (a.first as? [String]) ?? [] { try fm.removeItem(atPath: p) }; return true
        case "l.walk":
            var files: [[String: Any]] = [], dirs: [String] = []
            walk(URL(fileURLWithPath: s(0)), &files, &dirs)
            return ["files": files, "dirs": dirs]
        case "l.places":
            let dl = Self.docs.appendingPathComponent("下載")
            try? fm.createDirectory(at: dl, withIntermediateDirectories: true)
            return ["places": [["name": "我的檔案", "path": Self.docs.path, "icon": "home"], ["name": "下載", "path": dl.path, "icon": "down"]],
                    "drives": [] as [Any], "home": Self.docs.path, "root": ["name": "我的檔案", "path": Self.docs.path]]
        case "l.open": try onMain { self.preview(URL(fileURLWithPath: s(0))) }; return true
        case "l.share": try onMain { self.share(URL(fileURLWithPath: s(0))) }; return true
        case "l.import": return try importFiles(into: s(0), photos: s(1) == "photos")
        case "l.readText": return try String(contentsOfFile: s(0), encoding: .utf8)
        case "l.writeText": try s(1).write(toFile: s(0), atomically: true, encoding: .utf8); return s(0)
        case "hash":
            let url = URL(fileURLWithPath: s(0))
            guard let fh = FileHandle(forReadingAtPath: url.path) else { throw XKError("No such file") }
            defer { try? fh.close() }
            let total = (Self.localItem(url)?["size"] as? Int64) ?? 0
            var md5 = Insecure.MD5(), sha1 = Insecure.SHA1(), sha256 = SHA256()
            var got: Int64 = 0, last = Date.distantPast
            while let d = try fh.read(upToCount: 1 << 20), !d.isEmpty {
                md5.update(data: d); sha1.update(data: d); sha256.update(data: d)
                got += Int64(d.count)
                if Date().timeIntervalSince(last) > 0.15 { last = Date(); emit("hash", ["file": s(0), "got": got, "total": total]) }
            }
            let hex = { (d: any Sequence<UInt8>) in d.map { String(format: "%02x", $0) }.joined() }
            return ["file": s(0), "size": total, "md5": hex(md5.finalize()), "sha1": hex(sha1.finalize()), "sha256": hex(sha256.finalize())]
        // 權限（iOS 的 App 資料夾不需要另外允許）
        case "perm.status": return true
        case "perm.request": return true
        // 密碼：存在鑰匙圈
        case "secret.enc": return try Keychain.store(s(0))
        case "secret.dec": return Keychain.load(s(0))
        // 其他
        case "keepAwake": let on = (a.first as? Bool) ?? false; DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }; return true
        case "openUrl":
            guard let u = URL(string: s(0)), ["github.com", "achir1015.github.io"].contains(u.host ?? "") else { return false }
            DispatchQueue.main.async { UIApplication.shared.open(u) }
            return true
        case "update.check": return try checkUpdate()
        case "update.install":
            DispatchQueue.main.async { UIApplication.shared.open(URL(string: "https://achir1015.github.io/xiaoke-ftp/ios/")!) }
            return ["state": "launching", "pct": 100]
        case "update.status": return ["state": "launching", "pct": 100]
        case "tts.speak": return try Speech.shared.speak(s(0), rate: (a.count > 1 ? (a[1] as? NSNumber)?.doubleValue : nil) ?? 1)
        case "tts.stop": Speech.shared.stop(); return true
        default: throw XKError("未知的功能：" + m)
        }
    }

    func shutdown() {
        lock.lock(); let all = Array(conns.values) + Array(running.values); conns.removeAll(); lock.unlock()
        for c in all { c.close() }
    }

    // MARK: 主執行緒的 UI 動作
    private func onMain(_ fn: @escaping () -> Void) throws { DispatchQueue.main.async(execute: fn) }

    private var previewURL: URL?
    func preview(_ url: URL) {
        previewURL = url
        let q = QLPreviewController()
        q.dataSource = self
        web?.present(q)
    }
    func share(_ url: URL) {
        let vc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        web?.present(vc)
    }

    // 從「檔案」或「照片」匯入到目前的資料夾
    private var importDone: (([URL]) -> Void)?
    private var importDir = docs
    func importFiles(into dir: String, photos: Bool) throws -> Int {
        let sem = DispatchSemaphore(value: 0)
        var count = 0
        importDir = URL(fileURLWithPath: dir)
        DispatchQueue.main.async {
            self.importDone = { urls in count = urls.count; sem.signal() }
            if photos {
                var cfg = PHPickerConfiguration(photoLibrary: .shared())
                cfg.selectionLimit = 0
                cfg.preferredAssetRepresentationMode = .current
                let p = PHPickerViewController(configuration: cfg)
                p.delegate = self
                self.web?.present(p)
            } else {
                let p = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
                p.allowsMultipleSelection = true
                p.delegate = self
                self.web?.present(p)
            }
        }
        sem.wait()
        return count
    }
    fileprivate func copyIn(_ src: URL, name: String? = nil) -> URL? {
        let fm = FileManager.default
        var dst = importDir.appendingPathComponent(name ?? src.lastPathComponent)
        var k = 2
        while fm.fileExists(atPath: dst.path) {
            let base = (dst.lastPathComponent as NSString).deletingPathExtension, ext = (dst.lastPathComponent as NSString).pathExtension
            dst = importDir.appendingPathComponent("\(base.replacingOccurrences(of: " (\(k - 1))", with: "")) (\(k))" + (ext.isEmpty ? "" : ".\(ext)"))
            k += 1
        }
        do { try fm.copyItem(at: src, to: dst); return dst } catch { return nil }
    }

    // MARK: 版本更新：GitHub 最新版（iPad／iPhone 從安裝頁面更新）
    func checkUpdate() throws -> [String: Any] {
        let cur = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        var r = URLRequest(url: URL(string: "https://github.com/achir1015/xiaoke-ftp/releases/latest")!)
        r.httpMethod = "HEAD"
        let sem = DispatchSemaphore(value: 0)
        var final: URL?
        URLSession.shared.dataTask(with: r) { _, resp, _ in final = resp?.url; sem.signal() }.resume()
        sem.wait()
        guard let u = final, let i = u.path.range(of: "/releases/tag/") else { throw XKError("查詢失敗，請稍後再試") }
        let tag = String(u.path[i.upperBound...])
        return ["current": cur, "latest": tag.replacingOccurrences(of: "v", with: ""), "url": "https://achir1015.github.io/xiaoke-ftp/ios/", "page": "https://achir1015.github.io/xiaoke-ftp/ios/", "notes": ""]
    }
}

extension Native: QLPreviewControllerDataSource {
    func numberOfPreviewItems(in c: QLPreviewController) -> Int { previewURL == nil ? 0 : 1 }
    func previewController(_ c: QLPreviewController, previewItemAt i: Int) -> QLPreviewItem { previewURL! as NSURL }
}

extension Native: UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let out = urls.compactMap { copyIn($0) }
        importDone?(out); importDone = nil
    }
    func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) { importDone?([]); importDone = nil }
    func picker(_ p: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        p.dismiss(animated: true)
        let group = DispatchGroup()
        var out: [URL] = []
        let l = NSLock()
        for r in results {
            let prov = r.itemProvider
            guard let type = prov.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .movie) == true || UTType($0)?.conforms(to: .image) == true }) ?? prov.registeredTypeIdentifiers.first else { continue }
            group.enter()
            prov.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                if let url, let d = self.copyIn(url, name: url.lastPathComponent) { l.lock(); out.append(d); l.unlock() }
                group.leave()
            }
        }
        group.notify(queue: .global()) { self.importDone?(out); self.importDone = nil }
    }
}

/// 密碼存在鑰匙圈（只存在這台裝置）
enum Keychain {
    static func store(_ secret: String) throws -> String {
        if secret.isEmpty { return "" }
        let id = UUID().uuidString
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "xiaoke-ftp", kSecAttrAccount as String: id,
                                kSecValueData as String: Data(secret.utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let st = SecItemAdd(q as CFDictionary, nil)
        if st != errSecSuccess { throw XKError("無法儲存密碼（\(st)）") }
        return "kc:" + id
    }
    static func load(_ ref: String) -> String {
        guard ref.hasPrefix("kc:") else { return "" }
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "xiaoke-ftp", kSecAttrAccount as String: String(ref.dropFirst(3)), kSecReturnData as String: true]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return "" }
        return String(data: d, encoding: .utf8) ?? ""
    }
}

/// 中文語音（說明朗讀）：說完才回覆網頁
final class Speech: NSObject, AVSpeechSynthesizerDelegate {
    static let shared = Speech()
    private let syn = AVSpeechSynthesizer()
    private var waiting: [ObjectIdentifier: DispatchSemaphore] = [:]
    private let l = NSLock()
    override init() { super.init(); syn.delegate = self }

    func speak(_ text: String, rate: Double) throws -> Bool {
        let u = AVSpeechUtterance(string: text)
        u.voice = AVSpeechSynthesisVoice(language: "zh-TW") ?? AVSpeechSynthesisVoice(language: "zh-HK") ?? AVSpeechSynthesisVoice(language: "zh-CN")
        u.rate = Float(max(0.3, min(0.65, 0.5 * rate)))
        let sem = DispatchSemaphore(value: 0)
        l.lock(); waiting[ObjectIdentifier(u)] = sem; l.unlock()
        DispatchQueue.main.async {
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            self.syn.speak(u)
        }
        _ = sem.wait(timeout: .now() + 60)
        return true
    }
    func stop() { DispatchQueue.main.async { self.syn.stopSpeaking(at: .immediate) } }
    private func finish(_ u: AVSpeechUtterance) { l.lock(); let s = waiting.removeValue(forKey: ObjectIdentifier(u)); l.unlock(); s?.signal() }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { finish(u) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { finish(u) }
}
