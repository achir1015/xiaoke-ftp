#!/bin/bash
# App Store 版：封存後打開 Xcode Organizer，按「Distribute App」→「App Store Connect」上傳
# （指令列 exportArchive 上傳常卡在「session expired」，用 Organizer 最穩）。
# 要在 Mac 的登入畫面裡（終端機 App）執行：
#   osascript ios/run-in-terminal.applescript "bash ~/Developer/xiaoke-ftp/ios/build-appstore.sh"
# 進度寫在 ios/build/store.log，完成會留下 ios/build/store.done（內容 ok 或 fail）
cd "$(dirname "$0")"
mkdir -p build
rm -f build/store.done
exec > >(tee build/store.log) 2>&1
set -o pipefail
fail() { echo "fail" > build/store.done; exit 1; }
bash sync.sh || fail
rm -rf build/XiaokeFTP-store.xcarchive
xcodebuild -project XiaokeFTP.xcodeproj -scheme XiaokeFTP -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/XiaokeFTP-store.xcarchive \
  -allowProvisioningUpdates archive | grep -E 'error|warning: .*sign|ARCHIVE' || fail
ls build/XiaokeFTP-store.xcarchive/Products/Applications/XiaokeFTP.app/PrivacyInfo.xcprivacy || fail
open build/XiaokeFTP-store.xcarchive
echo "ok" > build/store.done
