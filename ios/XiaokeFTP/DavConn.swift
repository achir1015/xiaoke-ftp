import Foundation

/// WebDAV／WebDAVS（URLSession；Basic 驗證；可信任自簽憑證）
final class DavConn: NSObject, Conn, URLSessionDataDelegate {
    let site: [String: Any]
    let log: (String) -> Void
    private let secure: Bool, port: Int, base: String, host: String, ignoreCert: Bool, timeout: Double
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.httpMaximumConnectionsPerHost = 4
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()
    private var ok = false
    private var tasks: [Int: (data: (Data) throws -> Void, done: (Error?) -> Void, response: ((HTTPURLResponse) -> Bool)?)] = [:]
    private var progress: [Int: (Int64) -> Void] = [:]
    private let lock = NSLock()
    private var current: URLSessionTask?

    init(site: [String: Any], log: @escaping (String) -> Void) {
        self.site = site; self.log = log
        secure = (site["protocol"] as? String) == "webdavs"
        port = (site["port"] as? Int) ?? Int("\(site["port"] ?? "")") ?? (secure ? 443 : 80)
        base = RPath.norm(site["davRoot"] as? String ?? "/")
        host = site["host"] as? String ?? ""
        ignoreCert = site["ignoreCert"] as? Bool ?? false
        timeout = Double(max(5, (site["timeout"] as? Int) ?? 20))
    }

    var canAppend: Bool { false }
    var connected: Bool { ok }

    func url(_ p: String, dir: Bool = false) -> URL {
        let full = base == "/" ? RPath.norm(p) : RPath.norm(base + "/" + p)
        let enc = full.split(separator: "/").map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#;"))) ?? String($0) }.joined(separator: "/")
        return URL(string: "\(secure ? "https" : "http")://\(host):\(port)/\(enc)\(dir && !enc.isEmpty ? "/" : "")")!
    }

    private func req(_ method: String, _ path: String, dir: Bool = false, headers: [String: String] = [:], body: Data? = nil) -> URLRequest {
        var r = URLRequest(url: url(path, dir: dir))
        r.httpMethod = method
        r.setValue("XiaokeFTP-iOS", forHTTPHeaderField: "User-Agent")
        let user = site["user"] as? String ?? ""
        if !user.isEmpty { r.setValue("Basic " + Data("\(user):\(site["password"] as? String ?? "")".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization") }
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        r.httpBody = body
        return r
    }

    /// 送出請求並等待完整回應
    private func send(_ r: URLRequest, expect: [Int]) throws -> (Int, Data) {
        let sem = DispatchSemaphore(value: 0)
        var out: (Int, Data, Error?) = (0, Data(), nil)
        let t = session.dataTask(with: r) { d, resp, e in out = ((resp as? HTTPURLResponse)?.statusCode ?? 0, d ?? Data(), e); sem.signal() }
        t.resume()
        sem.wait()
        if let e = out.2 { throw e }
        if !expect.contains(out.0) { throw XKError("\(out.0) \(HTTPURLResponse.localizedString(forStatusCode: out.0))") }
        return (out.0, out.1)
    }

    func propfind(_ p: String, depth: Int) throws -> [[String: Any]] {
        let body = Data(#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#.utf8)
        let (_, data) = try send(req("PROPFIND", p, headers: ["Depth": "\(depth)", "Content-Type": "application/xml; charset=utf-8"], body: body), expect: [207, 200])
        let xml = String(data: data, encoding: .utf8) ?? ""
        let respRe = try! NSRegularExpression(pattern: #"<(?:[\w-]+:)?response(?:\s[^>]*)?>([\s\S]*?)</(?:[\w-]+:)?response>"#, options: .caseInsensitive)
        func tag(_ x: String, _ n: String) -> String? {
            let re = try! NSRegularExpression(pattern: "<(?:[\\w-]+:)?\(n)(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?\(n)>", options: .caseInsensitive)
            let ns = x as NSString
            guard let m = re.firstMatch(in: x, range: NSRange(location: 0, length: ns.length)) else { return nil }
            return ns.substring(with: m.range(at: 1))
        }
        let df = DateFormatter(); df.locale = Locale(identifier: "en_US_POSIX"); df.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        var out: [[String: Any]] = []
        let ns = xml as NSString
        for m in respRe.matches(in: xml, range: NSRange(location: 0, length: ns.length)) {
            let x = ns.substring(with: m.range(at: 1))
            var href = (tag(x, "href") ?? "").replacingOccurrences(of: "&amp;", with: "&")
            if let u = URL(string: href), u.host != nil { href = u.path } else { href = href.removingPercentEncoding ?? href }
            href = href.removingPercentEncoding ?? href
            var rel = RPath.norm(href)
            if base != "/" && (rel == base || rel.hasPrefix(base + "/")) { rel = RPath.norm(String(rel.dropFirst(base.count))) }
            let dir = (tag(x, "resourcetype") ?? "").range(of: #"<(?:[\w-]+:)?collection\b"#, options: [.regularExpression, .caseInsensitive]) != nil
            let size = Int64((tag(x, "getcontentlength") ?? "").trimmingCharacters(in: .whitespaces)) ?? 0
            let mt = (df.date(from: (tag(x, "getlastmodified") ?? "").trimmingCharacters(in: .whitespaces))?.timeIntervalSince1970 ?? 0) * 1000
            var it = item(RPath.base(rel), dir ? "dir" : "file", size, mt)
            it["path"] = rel
            out.append(it)
        }
        return out
    }

    func connect() throws -> String {
        _ = try propfind("/", depth: 0)
        ok = true
        log("連線成功（\((site["protocol"] as? String ?? "").uppercased()) \(host):\(port)\(base)）")
        return "/"
    }

    func list(_ dir: String) throws -> [[String: Any]] {
        let d = RPath.norm(dir)
        return try propfind(d, depth: 1).filter { ($0["path"] as? String) != d }.map { var x = $0; x.removeValue(forKey: "path"); return x }
    }

    func stat(_ path: String) throws -> [String: Any]? {
        do {
            guard var x = try propfind(RPath.norm(path), depth: 0).first else { return nil }
            x.removeValue(forKey: "path"); x["name"] = RPath.base(path)
            return x
        } catch let e as XKError where e.message.hasPrefix("404") { return nil }
    }

    func mkdir(_ p: String) throws { _ = try send(req("MKCOL", p, dir: true), expect: [200, 201]) }
    func remove(_ p: String) throws { _ = try send(req("DELETE", p), expect: [200, 204]) }
    func rmdir(_ p: String) throws { _ = try send(req("DELETE", p, dir: true), expect: [200, 204]) }
    func rename(_ a: String, _ b: String) throws { _ = try send(req("MOVE", a, headers: ["Destination": url(b).absoluteString, "Overwrite": "T"]), expect: [200, 201, 204]) }
    func chmod(_ p: String, _ mode: Int) throws { throw XKError("WebDAV 不支援修改權限") }

    func download(_ remote: String, startAt: Int64, sink: @escaping (Data) throws -> Void) throws {
        var r = req("GET", remote)
        if startAt > 0 { r.setValue("bytes=\(startAt)-", forHTTPHeaderField: "Range") }
        let sem = DispatchSemaphore(value: 0)
        var err: Error?
        let t = session.dataTask(with: r)
        lock.lock()
        tasks[t.taskIdentifier] = (sink, { e in err = e; sem.signal() }, { resp in
            if startAt > 0 && resp.statusCode != 206 { err = XKError("伺服器不支援續傳"); return false }
            if ![200, 206].contains(resp.statusCode) { err = XKError("\(resp.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: resp.statusCode))"); return false }
            return true
        })
        lock.unlock()
        current = t
        t.resume()
        sem.wait()
        current = nil
        if let err { throw err }
    }

    func upload(_ remote: String, file: String, offset: Int64, append: Bool, meter: @escaping (Int) throws -> Void) throws {
        if append { throw XKError("WebDAV 不支援接續上傳") }
        let sem = DispatchSemaphore(value: 0)
        var out: (Int, Error?) = (0, nil)
        var r = req("PUT", remote)
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let t = session.uploadTask(with: r, fromFile: URL(fileURLWithPath: file)) { _, resp, e in out = ((resp as? HTTPURLResponse)?.statusCode ?? 0, e); sem.signal() }
        var sent: Int64 = 0
        lock.lock()
        progress[t.taskIdentifier] = { total in
            let n = Int(total - sent); sent = total
            if n > 0 { do { try meter(n) } catch { t.cancel() } }
        }
        lock.unlock()
        current = t
        t.resume()
        sem.wait()
        current = nil
        if let e = out.1 { throw e }
        if ![200, 201, 204].contains(out.0) { throw XKError("\(out.0) \(HTTPURLResponse.localizedString(forStatusCode: out.0))") }
    }

    // MARK: URLSession 代理
    func urlSession(_ s: URLSession, didReceive ch: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if ch.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, ignoreCert, let trust = ch.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: trust)); return
        }
        completionHandler(.performDefaultHandling, nil)
    }
    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock(); let h = tasks[dataTask.taskIdentifier]; lock.unlock()
        if let h, let r = response as? HTTPURLResponse, let check = h.response, !check(r) { completionHandler(.cancel); return }
        completionHandler(.allow)
    }
    func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); let h = tasks[dataTask.taskIdentifier]; lock.unlock()
        guard let h else { return }
        do { try h.data(data) } catch { lock.lock(); tasks.removeValue(forKey: dataTask.taskIdentifier); lock.unlock(); dataTask.cancel(); h.done(error) }
    }
    func urlSession(_ s: URLSession, task: URLSessionTask, didSendBodyData b: Int64, totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        lock.lock(); let p = progress[task.taskIdentifier]; lock.unlock()
        p?(totalBytesSent)
    }
    func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let h = tasks.removeValue(forKey: task.taskIdentifier)
        progress.removeValue(forKey: task.taskIdentifier)
        lock.unlock()
        h?.done(error)
    }

    func abort() { current?.cancel() }
    func close() { abort(); ok = false; session.invalidateAndCancel() }
}
