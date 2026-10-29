// 在 Mac 上直接測試 iPad／iPhone 版的 FTP 程式（不用模擬器）
// 用法：swiftc -o /tmp/xkftp-cli ios/XiaokeFTP/Conn.swift ios/XiaokeFTP/FtpConn.swift ios/cli/main.swift && /tmp/xkftp-cli 127.0.0.1 埠 帳號 密碼 [ftp|ftps]
import Foundation

let a = CommandLine.arguments
let site: [String: Any] = ["protocol": a.count > 5 ? a[5] : "ftp", "host": a[1], "port": Int(a[2])!, "user": a[3], "password": a[4], "ignoreCert": true]
var pass = 0, fail = 0
func ok(_ c: Bool, _ m: String) { if c { pass += 1; print("  ✔ " + m) } else { fail += 1; print("  ✘ " + m) } }
let c = FtpConn(site: site, log: { _ in })
do {
    let home = try c.connect()
    ok(true, "連線（起始資料夾 \(home)）")
    try? c.mkdir("/cli測試")
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("上傳.txt")
    let body = String(repeating: "小柯 FTP iOS 測試\n", count: 5000)
    try body.write(to: tmp, atomically: true, encoding: .utf8)
    var sent = 0
    try c.upload("/cli測試/上傳 檔案.txt", file: tmp.path, offset: 0, append: false) { sent += $0 }
    for n in ["甲.txt", "乙 丙.txt", "丁.txt"] { try c.upload("/cli測試/\(n)", file: tmp.path, offset: 0, append: false) { _ in } }
    let l = try c.list("/cli測試")
    let names = l.compactMap { $0["name"] as? String }.sorted()
    print("    清單：\(names)")
    ok(names == ["丁.txt", "上傳 檔案.txt", "乙 丙.txt", "甲.txt"], "列表每一行都正確切開（4 個檔案、名稱正確）")
    ok((l.first { ($0["name"] as? String) == "甲.txt" }?["size"] as? Int64) == Int64(body.utf8.count), "大小正確")
    var got = Data()
    try c.download("/cli測試/上傳 檔案.txt", startAt: 0) { got.append($0) }
    ok(got.count == body.utf8.count, "下載大小正確")
    var part = Data()
    try c.download("/cli測試/上傳 檔案.txt", startAt: 1000) { part.append($0) }
    ok(part.count == body.utf8.count - 1000, "從中間續傳")
    try c.rename("/cli測試/甲.txt", "/cli測試/改名.txt")
    ok(try c.list("/cli測試").contains { ($0["name"] as? String) == "改名.txt" }, "改名")
    for n in ["上傳 檔案.txt", "乙 丙.txt", "丁.txt", "改名.txt"] { try c.remove("/cli測試/\(n)") }
    try c.rmdir("/cli測試")
    ok(try !c.list("/").contains { ($0["name"] as? String) == "cli測試" }, "刪除")
    // 各種伺服器的清單格式
    let m = FtpConn.parseMLSD("modify=20230907052352;type=dir;unique=FD02U5EA000E;size=4096;UNIX.mode=0777;UNIX.owner=root;UNIX.group=root; 長期照護")
    ok((m?["name"] as? String) == "長期照護" && (m?["type"] as? String) == "dir" && (m?["perm"] as? String) == "rwxrwxrwx", "Synology 的 MLSD 格式")
    let u = FtpConn.parseLIST("drwxr-xr-x    3 1026     100          4096 Oct 29 01:45 web 網站")
    ok((u?["name"] as? String) == "web 網站" && (u?["type"] as? String) == "dir", "Unix 的 LIST 格式（名稱有空白）")
    let d = FtpConn.parseLIST("10-29-26  01:45PM       <DIR>          資料夾")
    ok((d?["name"] as? String) == "資料夾" && (d?["type"] as? String) == "dir", "Windows IIS 的 LIST 格式")
    c.close()
} catch { ok(false, "例外：\(friendly(error)) \(error)") }
print("通過 \(pass)，失敗 \(fail)")
exit(fail == 0 ? 0 : 1)
