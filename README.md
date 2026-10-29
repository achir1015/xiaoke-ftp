# 小柯機器人FTP助手
<img width="1919" height="1077" alt="image" src="https://github.com/user-attachments/assets/77e78593-1ae6-46d9-ad4e-7df0e10e6311" />
媒體示範

https://github.com/user-attachments/assets/32699b96-3edc-4047-ae67-24b03e51dae6

<img src="build/icon.png" width="128" align="right" alt="圖示">

一般人也能輕鬆上手的 FTP／SFTP／WebDAV 檔案管理工具。左邊是自己的電腦、右邊是遠端主機，把檔案拖過去就能上傳、拖回來就能下載；還有小柯機器人用語音一步一步教您怎麼用。

**開發：吳玉柱 先生 與 Claude AI Opus 5.5**

## 下載

到 [Releases](https://github.com/achir1015/xiaoke-ftp/releases/latest) 下載：

| 平台 | 檔案 |
|---|---|
| Windows 10／11（安裝版，會建立桌面捷徑） | `XiaokeFTP-版本-win-x64.exe` |
| Windows（免安裝版） | `XiaokeFTP-版本-win-x64-portable.exe` |
| MacBook（Apple 晶片） | `XiaokeFTP-版本-mac-arm64.dmg` |
| Mac（Intel） | `XiaokeFTP-版本-mac-x64.dmg` |
| Android 手機（8 以上） | `XiaokeFTP-版本-android.apk` |
| iPad／iPhone | 用 Safari 開 [安裝頁](https://achir1015.github.io/xiaoke-ftp/ios/)（限已登記的裝置） |

裝好之後程式會自動檢查新版本，按一下就能更新。

**Android**：第一次安裝要允許「安裝不明應用程式」；開啟後請允許「所有檔案存取權」，才能讀寫手機裡的檔案。手機版暫不提供線上編輯與區網分享。

## 功能

- **協定**：FTP、FTPS（明示／隱含 TLS）、SFTP（密碼或 SSH 金鑰）、WebDAV／WebDAVS
- **雙窗格檔案管理**：拖放上傳下載、從 Windows 檔案總管拖進來上傳、多個遠端分頁、排序、篩選、鍵盤快速鍵（F2、Delete、F5、Ctrl+A）
- **傳輸佇列**：多檔同時傳、暫停／繼續、斷點續傳、斷線自動重試、限速、整個資料夾
- **檔案已存在**：覆寫、續傳、略過、自動改名，可整批套用
- **站台管理**：分組、密碼用作業系統加密保存、匯入匯出（不含密碼）、快速連線可貼上 `sftp://帳號@主機:22` 網址
- **線上編輯**：遠端檔案用電腦裡的程式打開，存檔後自動上傳
- **區網分享**：同一個 Wi-Fi 的手機掃 QR Code，瀏覽器就能下載電腦裡的檔案
- **其他**：校驗和（MD5／SHA1／SHA256）、修改遠端權限、深色外觀、SSH 主機指紋檢查
- **語音說明**：14 課語音導覽（自動朗讀、自動下一課、「指給我看」），傳輸完成語音提醒

## 開發

```bash
npm install
npm start          # 執行開發版
npm test           # 單元測試（本機 FTP／FTPS／SFTP／WebDAV 測試伺服器）
npm run e2e        # 介面自動測試
npm run dist:win   # 打包 Windows 安裝檔與免安裝版
python android/build.py           # 打包 Android APK（需要 JDK 17、Android SDK；不用 Gradle）
python android/build.py debug install   # 除錯版裝到手機，可跑 node e2e/phone.mjs 實機測試
```

iPad／iPhone 版在 `ios/`（XcodeGen；Mac 上執行 `bash ios/build-ipa.sh` 產生 Ad Hoc .ipa），連線由 Swift 負責：FTP／FTPS 自行實作、SFTP 用 [Citadel](https://github.com/orlandos-nl/Citadel)（MIT）、WebDAV 用 URLSession。

Android 版的畫面和電腦版是同一份程式（`scripts/build-mobile.mjs` 產生 `mobile/www`），連線由原生 Java 負責：FTP／FTPS 用 [Apache Commons Net](https://commons.apache.org/proper/commons-net/)（Apache 2.0）、SFTP 用 [JSch](https://github.com/mwiede/jsch)（BSD）、WebDAV 自行實作。

發佈新版：修改 `package.json` 的 `version` 推上 `main`，GitHub Actions 會自動建置 Windows、macOS 並建立 Release。

介面設計參考 [FileCentipede](https://github.com/filecxx/FileCentipede) 的檔案瀏覽器理念，程式完全自行撰寫。使用的開放原始碼套件：Electron、basic-ftp、ssh2、qrcode（皆為 MIT 授權）。

## 授權

MIT
