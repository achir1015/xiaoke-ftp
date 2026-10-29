import Foundation

/// 一條 TCP 連線（Foundation Stream）：同步讀寫，可在連線中途開啟 TLS（明示 FTPS 的 AUTH TLS）。
/// 讀寫會卡住時由 Watchdog 關閉連線來中斷。
final class Sock {
    let inp: InputStream
    let out: OutputStream
    private var buf = Data()
    private(set) var closed = false

    init(host: String, port: Int, tls: Bool = false, ignoreCert: Bool = false) throws {
        var i: InputStream?, o: OutputStream?
        Stream.getStreamsToHost(withName: host, port: port, inputStream: &i, outputStream: &o)
        guard let i, let o else { throw XKError("找不到這台主機，請確認主機名稱或網路") }
        inp = i; out = o
        if tls { startTLS(host: host, ignoreCert: ignoreCert) }
        inp.open(); out.open()
    }

    func startTLS(host: String, ignoreCert: Bool) {
        let settings: [String: Any] = [kCFStreamSSLPeerName as String: host, kCFStreamSSLValidatesCertificateChain as String: !ignoreCert]
        inp.setProperty(StreamSocketSecurityLevel.negotiatedSSL.rawValue, forKey: .socketSecurityLevelKey)
        out.setProperty(StreamSocketSecurityLevel.negotiatedSSL.rawValue, forKey: .socketSecurityLevelKey)
        CFReadStreamSetProperty(inp as CFReadStream, CFStreamPropertyKey(kCFStreamPropertySSLSettings), settings as CFDictionary)
        CFWriteStreamSetProperty(out as CFWriteStream, CFStreamPropertyKey(kCFStreamPropertySSLSettings), settings as CFDictionary)
    }

    func write(_ d: Data) throws {
        var off = 0
        while off < d.count {
            let n = d.withUnsafeBytes { p in out.write(p.baseAddress!.assumingMemoryBound(to: UInt8.self) + off, maxLength: d.count - off) }
            if n <= 0 { throw out.streamError ?? XKError("連線中斷了") }
            off += n
        }
    }
    func write(_ s: String) throws { try write(Data(s.utf8)) }

    /// 讀一段資料；連線結束回傳 nil
    func read(max: Int = 65536) throws -> Data? {
        if !buf.isEmpty { let d = buf; buf = Data(); return d }
        var tmp = [UInt8](repeating: 0, count: max)
        let n = inp.read(&tmp, maxLength: max)
        if n < 0 { throw inp.streamError ?? XKError("連線中斷了") }
        if n == 0 { return nil }
        return Data(tmp[0..<n])
    }

    func readLine() throws -> String {
        while true {
            if let r = buf.firstIndex(of: 10) {
                var line = buf[buf.startIndex..<r]
                buf = Data(buf[(r + 1)...])
                if line.last == 13 { line = line.dropLast() }
                return String(data: line, encoding: .utf8) ?? String(decoding: line, as: UTF8.self)
            }
            var tmp = [UInt8](repeating: 0, count: 4096)
            let n = inp.read(&tmp, maxLength: 4096)
            if n < 0 { throw inp.streamError ?? XKError("連線中斷了") }
            if n == 0 { throw XKError("連線中斷了") }
            buf.append(contentsOf: tmp[0..<n])
        }
    }

    func close() {
        if closed { return }
        closed = true
        inp.close(); out.close()
    }
}

/// 一段時間沒有動靜就關掉連線（中斷卡住的讀寫）
final class Watchdog {
    private var last = Date()
    private var timer: DispatchSourceTimer?
    private(set) var fired = false
    init(seconds: Double, onFire: @escaping () -> Void) {
        let t = DispatchSource.makeTimerSource(queue: .global())
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, !self.fired else { return }
            if Date().timeIntervalSince(self.last) > seconds { self.fired = true; onFire() }
        }
        t.resume()
        timer = t
    }
    func kick() { last = Date() }
    func stop() { timer?.cancel(); timer = nil }
    deinit { timer?.cancel() }
}

/// FTP／FTPS（明示 TLS、隱含 TLS），自己實作通訊協定
final class FtpConn: Conn {
    let site: [String: Any]
    let log: (String) -> Void
    private var ctrl: Sock?
    private var data: Sock?
    private let lock = NSRecursiveLock()
    private var mlsd = false
    private var epsv = true
    private var aborted = false
    private let proto: String, host: String, port: Int, timeout: Double, ignoreCert: Bool

    init(site: [String: Any], log: @escaping (String) -> Void) {
        self.site = site; self.log = log
        proto = site["protocol"] as? String ?? "ftp"
        host = site["host"] as? String ?? ""
        port = (site["port"] as? Int) ?? Int("\(site["port"] ?? "")") ?? (proto == "ftps-implicit" ? 990 : 21)
        timeout = Double(max(5, (site["timeout"] as? Int) ?? 20))
        ignoreCert = site["ignoreCert"] as? Bool ?? false
    }

    var secure: Bool { proto.hasPrefix("ftps") }
    var canAppend: Bool { true }
    var connected: Bool { ctrl != nil && !(ctrl!.closed) }

    // MARK: 控制連線
    private func reply() throws -> (Int, String) {
        guard let c = ctrl else { throw XKError("連線中斷了") }
        var line = try c.readLine()
        log("< " + line)
        guard line.count >= 3, let code = Int(line.prefix(3)) else { throw XKError("伺服器回應看不懂：" + line) }
        var text = line
        if line.dropFirst(3).first == "-" {
            repeat { line = try c.readLine(); log("< " + line); text += "\n" + line } while !line.hasPrefix("\(code) ")
        }
        return (code, text)
    }

    @discardableResult
    private func cmd(_ s: String) throws -> (Int, String) {
        guard let c = ctrl else { throw XKError("連線中斷了") }
        log("> " + (s.uppercased().hasPrefix("PASS ") ? "PASS ******" : s))
        try c.write(s + "\r\n")
        return try reply()
    }

    private func expect(_ s: String, _ ok: (Int) -> Bool) throws -> String {
        let (code, text) = try cmd(s)
        if !ok(code) { throw XKError(text) }
        return text
    }

    /// 有逾時保護地執行（卡住就關掉連線）
    private func guarded<T>(_ fn: () throws -> T) throws -> T {
        let dog = Watchdog(seconds: timeout) { [weak self] in self?.ctrl?.close(); self?.data?.close() }
        defer { dog.stop() }
        do { return try fn() } catch {
            if dog.fired { throw XKError("連線逾時，請確認網路、防火牆或改用被動模式") }
            throw error
        }
    }

    func connect() throws -> String {
        lock.lock(); defer { lock.unlock() }
        close()
        aborted = false
        log("連線 \(host):\(port)（\(proto.uppercased())）")
        return try guarded {
            ctrl = try Sock(host: host, port: port, tls: proto == "ftps-implicit", ignoreCert: ignoreCert)
            let (code, text) = try reply()
            if code != 220 { throw XKError("伺服器拒絕連線：" + text) }
            if proto == "ftps" {
                _ = try expect("AUTH TLS") { $0 == 234 }
                ctrl!.startTLS(host: host, ignoreCert: ignoreCert)
            }
            var user = site["user"] as? String ?? ""
            var pass = site["password"] as? String ?? ""
            if user.isEmpty { user = "anonymous"; if pass.isEmpty { pass = "guest@" } }
            let (u, ut) = try cmd("USER \(user)")
            if u == 331 { _ = try expect("PASS \(pass)") { $0 == 230 || $0 == 202 } } else if u != 230 { throw XKError("530 " + ut) }
            if secure { try cmd("PBSZ 0"); _ = try expect("PROT P") { $0 / 100 == 2 } }
            _ = try expect("TYPE I") { $0 / 100 == 2 }
            try? cmd("OPTS UTF8 ON")
            if let f = try? cmd("FEAT"), f.0 == 211 { mlsd = f.1.uppercased().contains("MLST") }
            var home = "/"
            if let p = try? expect("PWD", { $0 == 257 }), let a = p.firstIndex(of: "\""), let b = p[p.index(after: a)...].firstIndex(of: "\"") {
                home = RPath.norm(String(p[p.index(after: a)..<b]))
            }
            log("登入成功，起始資料夾 \(home)")
            return home
        }
    }

    /// 一般指令：被伺服器閒置踢掉時自動重連一次
    private func op<T>(_ fn: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        if !connected { _ = try connect() }
        do { return try guarded(fn) } catch {
            if aborted || connected { throw error }
            _ = try connect()
            return try guarded(fn)
        }
    }

    // MARK: 資料連線（被動模式：EPSV 優先，不行再 PASV）
    private func openData() throws -> Sock {
        var dhost = host, dport = 0
        if epsv, let (code, text) = try? cmd("EPSV"), code == 229, let a = text.firstIndex(of: "("), let b = text.firstIndex(of: ")") {
            let inner = text[text.index(after: a)..<b].split(separator: "|", omittingEmptySubsequences: true)
            dport = Int(inner.last ?? "") ?? 0
        } else {
            epsv = false
            let text = try expect("PASV") { $0 == 227 }
            let nums = text.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
            guard nums.count >= 7 else { throw XKError("伺服器的被動模式回應看不懂") }
            let n = Array(nums.suffix(6))
            let ip = "\(n[0]).\(n[1]).\(n[2]).\(n[3])"
            dport = n[4] * 256 + n[5]
            // 伺服器在 NAT 後面回報內網位址時，改用連線時的主機（和 FileZilla 相同）
            dhost = (Self.unroutable(ip) && !Self.unroutable(host)) ? host : ip
        }
        guard dport > 0 else { throw XKError("無法建立資料連線") }
        let s = try Sock(host: dhost, port: dport)
        if secure { s.startTLS(host: host, ignoreCert: ignoreCert) }
        data = s
        return s
    }

    static func unroutable(_ ip: String) -> Bool {
        let p = ip.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4 else { return false }
        return p[0] == 10 || p[0] == 127 || p[0] == 0 || (p[0] == 192 && p[1] == 168) || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 169 && p[1] == 254)
    }

    private func readAll(_ s: Sock) throws -> Data {
        var all = Data()
        while let d = try s.read() { all.append(d) }
        return all
    }

    // MARK: 列目錄
    func list(_ dir: String) throws -> [[String: Any]] {
        let d = RPath.norm(dir)
        return try op {
            var raw = Data(), useM = mlsd
            for attempt in 0..<2 {
                let ds = try openData()
                let (code, text) = try cmd((useM ? "MLSD " : "LIST -a ") + d)
                if code != 150 && code != 125 {
                    ds.close(); data = nil
                    if useM && attempt == 0 { useM = false; mlsd = false; continue }
                    throw XKError(text)
                }
                raw = try readAll(ds)
                ds.close(); data = nil
                let (c2, t2) = try reply()
                if c2 / 100 != 2 { throw XKError(t2) }
                break
            }
            let text = String(data: raw, encoding: .utf8) ?? String(decoding: raw, as: UTF8.self)
            // Swift 把 "\r\n" 當成「一個」字元，一定要用 isNewline 判斷，否則整份清單會黏成一行
            return text.split(whereSeparator: { $0.isNewline }).compactMap { useM ? Self.parseMLSD(String($0)) : Self.parseLIST(String($0)) }
                .filter { ($0["name"] as? String).map { $0 != "." && $0 != ".." && !$0.isEmpty } ?? false }
        }
    }

    static func parseMLSD(_ line: String) -> [String: Any]? {
        guard let sp = line.firstIndex(of: " ") else { return nil }
        let name = String(line[line.index(after: sp)...])
        var facts: [String: String] = [:]
        for f in line[..<sp].split(separator: ";") { let kv = f.split(separator: "=", maxSplits: 1); if kv.count == 2 { facts[kv[0].lowercased()] = String(kv[1]) } }
        let t = (facts["type"] ?? "file").lowercased()
        if t == "cdir" || t == "pdir" { return nil }
        let type = t == "dir" ? "dir" : t.hasPrefix("os.unix=symlink") || t.hasPrefix("os.unix=slink") ? "link" : "file"
        var mtime = 0.0
        if let m = facts["modify"] { mtime = parseStamp(m) }
        var perm = ""
        if let mode = facts["unix.mode"], let v = Int(mode, radix: 8) { perm = RPath.perm(v) }
        let owner = [facts["unix.owner"], facts["unix.group"]].compactMap { $0 }.joined(separator: " ")
        return item(name, type, Int64(facts["size"] ?? "0") ?? 0, mtime, perm: perm, owner: owner)
    }

    static func parseStamp(_ s: String) -> Double {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMddHHmmss"
        return (f.date(from: String(s.prefix(14)))?.timeIntervalSince1970 ?? 0) * 1000
    }

    static let unixRe = try! NSRegularExpression(pattern: #"^([\-dlbcps])([rwxsStT\-]{9})\S*\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s+(.+)$"#)
    static let dosRe = try! NSRegularExpression(pattern: #"^(\d{2}-\d{2}-\d{2,4})\s+(\d{1,2}:\d{2}\s*[AaPp][Mm])\s+(<DIR>|\d+)\s+(.+)$"#)

    static func parseLIST(_ line: String) -> [String: Any]? {
        let ns = line as NSString
        if let m = unixRe.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
            let g = { (i: Int) in ns.substring(with: m.range(at: i)) }
            let kind = g(1)
            var name = g(7), target = ""
            if kind == "l", let r = name.range(of: " -> ") { target = String(name[r.upperBound...]); name = String(name[..<r.lowerBound]) }
            let bits = Array(g(2))
            var mode = 0
            for (i, c) in bits.enumerated() where c != "-" && !(c == "S" || c == "T") { mode |= 1 << (8 - i) }
            return item(name, kind == "d" ? "dir" : kind == "l" ? "link" : "file", Int64(g(5)) ?? 0, unixDate(g(6)), perm: RPath.perm(mode), owner: "\(g(3)) \(g(4))", target: target)
        }
        if let m = dosRe.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
            let g = { (i: Int) in ns.substring(with: m.range(at: i)) }
            let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = g(1).count > 8 ? "MM-dd-yyyy hh:mma" : "MM-dd-yy hh:mma"
            let t = (f.date(from: g(1) + " " + g(2).replacingOccurrences(of: " ", with: "").uppercased())?.timeIntervalSince1970 ?? 0) * 1000
            let dir = g(3) == "<DIR>"
            return item(g(4), dir ? "dir" : "file", dir ? 0 : Int64(g(3)) ?? 0, t)
        }
        return nil
    }

    static func unixDate(_ s: String) -> Double {
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
        let parts = s.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count == 3 else { return 0 }
        if parts[2].contains(":") {
            let y = Calendar.current.component(.year, from: Date())
            f.dateFormat = "MMM d yyyy HH:mm"
            var d = f.date(from: "\(parts[0]) \(parts[1]) \(y) \(parts[2])")
            if let x = d, x > Date().addingTimeInterval(86400 * 2) { d = f.date(from: "\(parts[0]) \(parts[1]) \(y - 1) \(parts[2])") }
            return (d?.timeIntervalSince1970 ?? 0) * 1000
        }
        f.dateFormat = "MMM d yyyy"
        return (f.date(from: "\(parts[0]) \(parts[1]) \(parts[2])")?.timeIntervalSince1970 ?? 0) * 1000
    }

    func stat(_ path: String) throws -> [String: Any]? {
        let p = RPath.norm(path)
        if p == "/" { return item("/", "dir", 0, 0) }
        guard let l = try? list(RPath.dir(p)) else { return nil }
        return l.first { ($0["name"] as? String) == RPath.base(p) }
    }

    func mkdir(_ p: String) throws { try op { _ = try expect("MKD \(RPath.norm(p))") { $0 / 100 == 2 } } }
    func remove(_ p: String) throws { try op { _ = try expect("DELE \(RPath.norm(p))") { $0 / 100 == 2 } } }
    func rmdir(_ p: String) throws { try op { _ = try expect("RMD \(RPath.norm(p))") { $0 / 100 == 2 } } }
    func rename(_ a: String, _ b: String) throws {
        try op { _ = try expect("RNFR \(RPath.norm(a))") { $0 == 350 }; _ = try expect("RNTO \(RPath.norm(b))") { $0 / 100 == 2 } }
    }
    func chmod(_ p: String, _ mode: Int) throws { try op { _ = try expect("SITE CHMOD \(String(mode & 0o777, radix: 8)) \(RPath.norm(p))") { $0 / 100 == 2 } } }

    // MARK: 傳輸（不自動重試：資料已經讀寫了一半）
    private func transfer(_ body: (Watchdog) throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        if !connected { _ = try connect() }
        let dog = Watchdog(seconds: timeout) { [weak self] in self?.ctrl?.close(); self?.data?.close() }
        defer { dog.stop(); data = nil }
        do { try body(dog) } catch {
            if aborted { throw XKError("已取消") }
            if dog.fired { throw XKError("連線逾時，請確認網路、防火牆或改用被動模式") }
            throw error
        }
    }

    func download(_ remote: String, startAt: Int64, sink: @escaping (Data) throws -> Void) throws {
        try transfer { dog in
            if startAt > 0 { _ = try expect("REST \(startAt)") { $0 == 350 } }
            let ds = try openData()
            let (code, text) = try cmd("RETR \(RPath.norm(remote))")
            if code != 150 && code != 125 { ds.close(); throw XKError(text) }
            while let d = try ds.read() { dog.kick(); try sink(d) }
            ds.close()
            let (c2, t2) = try reply()
            if c2 / 100 != 2 { throw XKError(t2) }
        }
    }

    func upload(_ remote: String, file: String, offset: Int64, append: Bool, meter: @escaping (Int) throws -> Void) throws {
        guard let fh = FileHandle(forReadingAtPath: file) else { throw XKError("No such file：" + file) }
        defer { try? fh.close() }
        try fh.seek(toOffset: UInt64(offset))
        try transfer { dog in
            let ds = try openData()
            let (code, text) = try cmd((append ? "APPE " : "STOR ") + RPath.norm(remote))
            if code != 150 && code != 125 { ds.close(); throw XKError(text) }
            while let d = try fh.read(upToCount: 65536), !d.isEmpty { try ds.write(d); dog.kick(); try meter(d.count) }
            ds.close()
            let (c2, t2) = try reply()
            if c2 / 100 != 2 { throw XKError(t2) }
        }
    }

    /// 不加鎖：傳輸中的執行緒握著鎖，直接關掉連線讓它中斷
    func abort() { aborted = true; data?.close(); ctrl?.close() }

    func close() {
        if let c = ctrl, !c.closed { try? c.write("QUIT\r\n") }
        ctrl?.close(); data?.close()
        ctrl = nil; data = nil
    }
}
