import Foundation

/// 遠端連線的共同介面（FTP／FTPS、SFTP、WebDAV），和桌面版 src/main/drivers、Android 版 Conn.java 相同的動作。
/// 每個方法都在背景執行緒同步執行（呼叫端已經在背景）。
protocol Conn: AnyObject {
    func connect() throws -> String
    func list(_ dir: String) throws -> [[String: Any]]
    func stat(_ path: String) throws -> [String: Any]?
    func mkdir(_ path: String) throws
    func remove(_ path: String) throws
    func rmdir(_ path: String) throws
    func rename(_ from: String, _ to: String) throws
    func chmod(_ path: String, _ mode: Int) throws
    /// 下載：每收到一段資料就呼叫 sink（sink 丟出錯誤表示要中止）
    func download(_ remote: String, startAt: Int64, sink: @escaping (Data) throws -> Void) throws
    /// 上傳本機檔案（從 offset 開始；append 時接在遠端檔案後面），每送出一段就呼叫 meter
    func upload(_ remote: String, file: String, offset: Int64, append: Bool, meter: @escaping (Int) throws -> Void) throws
    var canAppend: Bool { get }
    var connected: Bool { get }
    func abort()
    func close()
}

struct XKError: LocalizedError {
    let message: String
    init(_ m: String) { message = m }
    var errorDescription: String? { message }
}

enum RPath {
    static func norm(_ p: String) -> String {
        var out: [Substring] = []
        for s in p.replacingOccurrences(of: "\\", with: "/").split(separator: "/") {
            if s == "." || s.isEmpty { continue }
            if s == ".." { if !out.isEmpty { out.removeLast() }; continue }
            out.append(s)
        }
        return "/" + out.joined(separator: "/")
    }
    static func join(_ a: String, _ b: String) -> String { norm(a + "/" + b) }
    static func dir(_ p: String) -> String { let n = norm(p); guard let i = n.lastIndex(of: "/"), i != n.startIndex else { return "/" }; return String(n[..<i]) }
    static func base(_ p: String) -> String { String(norm(p).split(separator: "/").last ?? "") }
    static func perm(_ mode: Int) -> String {
        let t = Array("rwxrwxrwx")
        return String((0..<9).map { (mode & (1 << (8 - $0))) != 0 ? t[$0] : "-" })
    }
}

func item(_ name: String, _ type: String, _ size: Int64, _ mtime: Double, perm: String = "", owner: String = "", target: String = "") -> [String: Any] {
    ["name": name, "type": type, "size": size, "mtime": mtime, "perm": perm, "owner": owner, "target": target]
}

/// 錯誤訊息翻成看得懂的中文（和桌面版 friendlyError 一致）
func friendly(_ e: Error) -> String {
    if let x = e as? XKError { return translate(x.message) }
    let ns = e as NSError
    if ns.domain == NSURLErrorDomain {
        switch ns.code {
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: return "找不到這台主機，請確認主機名稱或網路"
        case NSURLErrorCannotConnectToHost: return "主機拒絕連線，請確認連接埠與伺服器是否開啟"
        case NSURLErrorTimedOut: return "連線逾時，請確認網路、防火牆或改用被動模式"
        case NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorSecureConnectionFailed: return "伺服器憑證無法驗證（可在站台設定勾選「信任自簽憑證」）"
        case NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet: return "連線中斷了，請再試一次"
        case NSURLErrorCancelled: return "已取消"
        default: break
        }
    }
    return translate("\(e.localizedDescription) \(e)")
}

func translate(_ m: String) -> String {
    let checks: [(String, String)] = [
        ("Connection refused", "主機拒絕連線，請確認連接埠與伺服器是否開啟"),
        ("refused", "主機拒絕連線，請確認連接埠與伺服器是否開啟"),
        ("nodename nor servname", "找不到這台主機，請確認主機名稱或網路"),
        ("逾時", "連線逾時，請確認網路、防火牆或改用被動模式"),
        ("timed out", "連線逾時，請確認網路、防火牆或改用被動模式"),
        ("530", "登入失敗：帳號或密碼不正確"),
        ("authentication", "登入失敗：帳號或密碼不正確"),
        ("allAuthenticationOptionsFailed", "登入失敗：帳號或密碼不正確"),
        ("401", "登入失敗：帳號或密碼不正確"),
        ("certificate", "伺服器憑證無法驗證（可在站台設定勾選「信任自簽憑證」）"),
        ("550", "檔案或資料夾不存在，或沒有權限"),
        ("No such file", "檔案或資料夾不存在，或沒有權限"),
        ("noSuchFile", "檔案或資料夾不存在，或沒有權限"),
        ("404", "檔案或資料夾不存在，或沒有權限"),
        ("553", "沒有權限執行這個動作"),
        ("Permission denied", "沒有權限執行這個動作"),
        ("permissionDenied", "沒有權限執行這個動作"),
        ("403", "沒有權限執行這個動作"),
        ("552", "空間不足"),
        ("507", "空間不足"),
    ]
    if m.contains("主機指紋") || m.contains("已取消") || m.contains("不支援") { return m.trimmingCharacters(in: .whitespaces) }
    for (k, v) in checks where m.localizedCaseInsensitiveContains(k) { return v }
    return m.trimmingCharacters(in: .whitespaces)
}
