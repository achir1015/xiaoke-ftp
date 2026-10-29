import Foundation
import Citadel
import CryptoKit
import NIOCore
import NIOSSH

/// 在背景執行緒同步等待 async 結果
func blocking<T>(_ op: @escaping () async throws -> T) throws -> T {
    let sem = DispatchSemaphore(value: 0)
    var result: Result<T, Error>!
    Task.detached { do { result = .success(try await op()) } catch { result = .failure(error) }; sem.signal() }
    sem.wait()
    return try result.get()
}

/// SFTP（SSH），使用 Citadel；第一次連線記住主機指紋，之後改變就拒絕（除非使用者確認信任新的）
final class SftpConn: Conn {
    let site: [String: Any]
    let log: (String) -> Void
    private var client: SSHClient?
    private var sftp: SFTPClient?
    private let host: String, port: Int, timeout: Int

    init(site: [String: Any], log: @escaping (String) -> Void) {
        self.site = site; self.log = log
        host = site["host"] as? String ?? ""
        port = (site["port"] as? Int) ?? Int("\(site["port"] ?? "")") ?? 22
        timeout = max(5, (site["timeout"] as? Int) ?? 20)
    }

    var canAppend: Bool { true }
    var connected: Bool { sftp != nil && client?.isConnected == true }

    /// 主機指紋：第一次記住（UserDefaults），之後不同就拒絕
    final class HostCheck: NIOSSHClientServerAuthenticationDelegate {
        let id: String, trustNew: Bool, log: (String) -> Void
        var changed: String?
        init(id: String, trustNew: Bool, log: @escaping (String) -> Void) { self.id = id; self.trustNew = trustNew; self.log = log }
        func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
            let openssh = String(openSSHPublicKey: hostKey)
            let blob = Data(base64Encoded: String(openssh.split(separator: " ").dropFirst().first ?? "")) ?? Data(openssh.utf8)
            let fp = "SHA256:" + Data(SHA256.hash(data: blob)).base64EncodedString().replacingOccurrences(of: "=", with: "")
            let key = "known_host." + id
            let old = UserDefaults.standard.string(forKey: key)
            if old == nil || old == fp || trustNew {
                if old != fp { UserDefaults.standard.set(fp, forKey: key); log((old == nil ? "第一次連線，已記住主機指紋 " : "已信任新的主機指紋 ") + fp) }
                validationCompletePromise.succeed(())
            } else {
                changed = "主機指紋改變了！上次：\(old!)，這次：\(fp)"
                validationCompletePromise.fail(XKError(changed!))
            }
        }
    }

    func connect() throws -> String {
        close()
        let user = site["user"] as? String ?? ""
        let pass = site["password"] as? String ?? ""
        let keyText = site["privateKey"] as? String ?? ""
        var auth: SSHAuthenticationMethod = .passwordBased(username: user, password: pass)
        if !keyText.isEmpty {
            if keyText.contains("ssh-ed25519") || keyText.contains("OPENSSH PRIVATE KEY"), let k = try? Curve25519.Signing.PrivateKey(sshEd25519: keyText, decryptionKey: (site["passphrase"] as? String).flatMap { $0.isEmpty ? nil : Data($0.utf8) }) {
                auth = .ed25519(username: user, privateKey: k)
            } else if let k = try? Insecure.RSA.PrivateKey(sshRsa: keyText, decryptionKey: (site["passphrase"] as? String).flatMap { $0.isEmpty ? nil : Data($0.utf8) }) {
                auth = .rsa(username: user, privateKey: k)
            } else { throw XKError("私鑰格式看不懂（支援 OpenSSH 格式的 ed25519、RSA）") }
        }
        let check = HostCheck(id: "\(host):\(port)", trustNew: site["trustNewHostKey"] as? Bool ?? false, log: log)
        log("連線 \(host):\(port)（SFTP）")
        let h = host, p = port, t = timeout
        do {
            let c = try blocking {
                try await withThrowingTaskGroup(of: SSHClient.self) { g in
                    g.addTask { try await SSHClient.connect(host: h, port: p, authenticationMethod: auth, hostKeyValidator: .custom(check), reconnect: .never, algorithms: .all) }
                    g.addTask { try await Task.sleep(nanoseconds: UInt64(t) * 1_000_000_000); throw XKError("連線逾時，請確認網路、防火牆或改用被動模式") }
                    let first = try await g.next()!
                    g.cancelAll()
                    return first
                }
            }
            client = c
            sftp = try blocking { try await c.openSFTP() }
        } catch {
            if let m = check.changed { throw XKError(m) }
            throw error
        }
        var home = "/"
        if let s = sftp, let p = try? blocking({ try await s.getRealPath(atPath: ".") }) { home = RPath.norm(p) }
        log("登入成功，起始資料夾 \(home)")
        return home
    }

    private func s() throws -> SFTPClient {
        if !connected { _ = try connect() }
        guard let s = sftp else { throw XKError("連線中斷了") }
        return s
    }

    static func typeOf(_ a: SFTPFileAttributes) -> String {
        guard let p = a.permissions else { return "file" }
        switch p & 0o170000 { case 0o040000: return "dir"; case 0o120000: return "link"; default: return "file" }
    }

    func list(_ dir: String) throws -> [[String: Any]] {
        let d = RPath.norm(dir), c = try s()
        let names = try blocking { try await c.listDirectory(atPath: d) }
        var out: [[String: Any]] = []
        for n in names {
            for comp in n.components {
                if comp.filename == "." || comp.filename == ".." { continue }
                let a = comp.attributes
                let parts = comp.longname.split(separator: " ", omittingEmptySubsequences: true)
                var it = item(comp.filename, Self.typeOf(a), Int64(a.size ?? 0), (a.accessModificationTime?.modificationTime.timeIntervalSince1970 ?? 0) * 1000,
                              perm: a.permissions.map { RPath.perm(Int($0)) } ?? "", owner: parts.count > 4 ? "\(parts[2]) \(parts[3])" : "")
                if it["type"] as? String == "link", let t = try? blocking({ try await c.getAttributes(at: RPath.join(d, comp.filename)) }) {
                    it["linkDir"] = Self.typeOf(t) == "dir"
                    if Self.typeOf(t) != "dir" { it["size"] = Int64(t.size ?? 0) }
                }
                out.append(it)
            }
        }
        return out
    }

    func stat(_ path: String) throws -> [String: Any]? {
        let c = try s(), p = RPath.norm(path)
        guard let a = try? blocking({ try await c.getAttributes(at: p) }) else { return nil }
        return item(RPath.base(p), Self.typeOf(a), Int64(a.size ?? 0), (a.accessModificationTime?.modificationTime.timeIntervalSince1970 ?? 0) * 1000, perm: a.permissions.map { RPath.perm(Int($0)) } ?? "")
    }

    func mkdir(_ p: String) throws { let c = try s(), x = RPath.norm(p); try blocking { try await c.createDirectory(atPath: x) } }
    func remove(_ p: String) throws { let c = try s(), x = RPath.norm(p); try blocking { try await c.remove(at: x) } }
    func rmdir(_ p: String) throws { let c = try s(), x = RPath.norm(p); try blocking { try await c.rmdir(at: x) } }
    func rename(_ a: String, _ b: String) throws { let c = try s(), x = RPath.norm(a), y = RPath.norm(b); try blocking { try await c.rename(at: x, to: y) } }
    func chmod(_ p: String, _ mode: Int) throws {
        let c = try s(), x = RPath.norm(p)
        var attrs = SFTPFileAttributes()
        attrs.permissions = UInt32(mode & 0o777)
        try blocking { try await c.setAttributes(at: x, to: attrs) }
    }

    func download(_ remote: String, startAt: Int64, sink: @escaping (Data) throws -> Void) throws {
        let c = try s(), x = RPath.norm(remote)
        try blocking {
            let f = try await c.openFile(filePath: x, flags: .read)
            do {
                var off = UInt64(max(0, startAt))
                while true {
                    var buf = try await f.read(from: off, length: 32768)
                    let n = buf.readableBytes
                    if n == 0 { break }
                    try sink(Data(buf.readBytes(length: n) ?? []))
                    off += UInt64(n)
                }
                try await f.close()
            } catch { try? await f.close(); throw error }
        }
    }

    func upload(_ remote: String, file: String, offset: Int64, append: Bool, meter: @escaping (Int) throws -> Void) throws {
        let c = try s(), x = RPath.norm(remote)
        guard let fh = FileHandle(forReadingAtPath: file) else { throw XKError("No such file：" + file) }
        defer { try? fh.close() }
        try fh.seek(toOffset: UInt64(offset))
        try blocking {
            let flags: SFTPOpenFileFlags = append ? [.write, .create] : [.write, .create, .truncate]
            let f = try await c.openFile(filePath: x, flags: flags)
            do {
                var off: UInt64 = append ? UInt64(offset) : 0
                while let d = try fh.read(upToCount: 32768), !d.isEmpty {
                    try await f.write(ByteBuffer(data: d), at: off)
                    off += UInt64(d.count)
                    try meter(d.count)
                }
                try await f.close()
            } catch { try? await f.close(); throw error }
        }
    }

    func abort() { close() }

    func close() {
        let c = client
        client = nil; sftp = nil
        if let c { Task.detached { try? await c.close() } }
    }
}
