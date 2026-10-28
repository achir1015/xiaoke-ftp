## 小柯機器人FTP助手 v1.0.0

第一版（Windows 11 為主，macOS 版由自動建置產生、尚未實機測試）。

- 支援 FTP、FTPS（明示／隱含 TLS）、SFTP（密碼或 SSH 金鑰）、WebDAV／WebDAVS
- 左本機、右遠端的雙窗格檔案管理：拖放上傳下載、從 Windows 檔案總管拖進來上傳、多個遠端分頁
- 傳輸佇列：同時多檔、暫停／繼續、斷點續傳、斷線自動重試、上傳下載限速、整個資料夾傳輸
- 檔案已存在時可選覆寫、續傳、略過、自動改名（可整批套用）
- 站台管理（分組、密碼加密保存、匯入匯出）、快速連線（可直接貼上 sftp://帳號@主機 網址）
- 線上編輯：遠端檔案用電腦的程式打開，存檔自動上傳
- 區網分享：手機掃 QR Code 就能下載電腦裡的檔案（可設密碼、可允許上傳）
- 校驗和（MD5／SHA1／SHA256）、遠端權限修改、深色外觀
- 小柯機器人語音導覽說明（14 課，可「指給我看」）、傳輸完成語音提醒
- 自動檢查更新，一鍵下載安裝

**下載哪一個？**
- Windows 安裝版：`XiaokeFTP-版本-win-x64.exe`（會建立桌面捷徑）
- Windows 免安裝版：`XiaokeFTP-版本-win-x64-portable.exe`
- MacBook（Apple 晶片 M1～M5）：`XiaokeFTP-版本-mac-arm64.dmg`；Intel Mac：`XiaokeFTP-版本-mac-x64.dmg`

開發：吳玉柱 先生 與 Claude AI Opus 5.5
