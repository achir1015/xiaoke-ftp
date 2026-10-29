"""小柯機器人FTP助手 Android 版建置腳本（不用 Gradle）：產生手機版網頁 → aapt2 → javac → d8 → zipalign → apksigner。

需要：Python 3.8+、Node.js（產生手機版網頁）、JDK 17、Android SDK（build-tools、platforms/android-34）。
SDK / JDK 位置依序讀取 local.properties（sdk.dir= / jdk.dir=）、ANDROID_HOME / JAVA_HOME。
網頁（和桌面版同一份程式）由 scripts/build-mobile.mjs 產生到 mobile/www，再打包進 assets/web。
用法：python android/build.py              產生 android/build/XiaokeFTP.apk
      python android/build.py install      另外用 adb 安裝並啟動（環境變數 ANDROID_SERIAL 指定手機）
      python android/build.py debug        允許 chrome://inspect 檢查網頁（測試用，不要發佈）
"""
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(ROOT)
WWW = os.path.join(PROJ, "mobile", "www")
OUT_DIR = os.path.join(ROOT, "build")
# aapt2 不支援路徑裡有中文（例如「FTP Client檔案管理」），這時改在系統暫存資料夾建置，最後再把 APK 複製回來
BUILD = OUT_DIR if ROOT.isascii() else os.path.join(__import__("tempfile").gettempdir(), "xiaoke-ftp-android")
EXE = ".exe" if os.name == "nt" else ""
BAT = ".bat" if os.name == "nt" else ""
PKG = "com.achir.xiaokeftp"
APK_NAME = "XiaokeFTP.apk"
KEYSTORE = os.path.join(ROOT, "xiaokeftp.jks")


def props():
    p = {}
    f = os.path.join(ROOT, "local.properties")
    if os.path.exists(f):
        for line in open(f, encoding="utf-8"):
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                p[k.strip()] = v.strip().replace("\\:", ":").replace("\\\\", "\\")
    return p


P = props()
SDK = P.get("sdk.dir") or os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT") \
    or os.path.join(os.environ.get("LOCALAPPDATA", ""), "Android", "Sdk")
JDK = P.get("jdk.dir") or os.environ.get("JAVA_HOME", "")


def latest(pattern):
    found = sorted(glob.glob(pattern))
    if not found:
        sys.exit("找不到 " + pattern)
    return found[-1]


BT = latest(os.path.join(SDK, "build-tools", "*"))
ANDROID_JAR_SRC = latest(os.path.join(SDK, "platforms", "android-*", "android.jar"))
ANDROID_JAR = os.path.join(BUILD, "android.jar") if not ANDROID_JAR_SRC.isascii() else ANDROID_JAR_SRC
JAVAC = os.path.join(JDK, "bin", "javac" + EXE) if JDK else "javac"
KEYTOOL = os.path.join(JDK, "bin", "keytool" + EXE) if JDK else "keytool"
ADB = os.path.join(SDK, "platform-tools", "adb" + EXE)
if JDK:
    os.environ["JAVA_HOME"] = JDK


def run(*cmd, cwd=ROOT):
    print(">", " ".join(os.path.basename(c) if i == 0 else c for i, c in enumerate(cmd))[:300])
    subprocess.check_call(list(cmd), cwd=cwd)


def sync_version():
    """AndroidManifest 的 versionName 跟著 package.json；versionCode 由版本號換算（1.4.0 → 10400）"""
    ver = json.load(open(os.path.join(PROJ, "package.json"), encoding="utf-8"))["version"]
    a, b, c = (int(x) for x in (ver.split(".") + ["0", "0"])[:3])
    code = a * 10000 + b * 100 + c
    mf = os.path.join(ROOT, "AndroidManifest.xml")
    s = open(mf, encoding="utf-8").read()
    s2 = re.sub(r'android:versionCode="\d+"', f'android:versionCode="{code}"', s)
    s2 = re.sub(r'android:versionName="[^"]*"', f'android:versionName="{ver}"', s2)
    if s2 != s:
        open(mf, "w", encoding="utf-8").write(s2)
    return ver


def strip_method_parameters(data):
    """移除 class 檔方法上的 MethodParameters 屬性（含空名稱時 d8 8.2 會當掉；只影響反射取參數名稱，執行不受影響）"""
    import struct
    if b"MethodParameters" not in data:
        return data
    p = 10
    count = struct.unpack(">H", data[8:10])[0]
    utf8 = {}
    i = 1
    while i < count:
        tag = data[p]
        if tag == 1:
            n = struct.unpack(">H", data[p + 1:p + 3])[0]
            utf8[i] = data[p + 3:p + 3 + n]
            p += 3 + n
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            p += 5
        elif tag in (5, 6):
            p += 9
            i += 1
        elif tag in (7, 8, 16, 19, 20):
            p += 3
        elif tag == 15:
            p += 4
        else:
            raise ValueError("unknown constant tag %d" % tag)
        i += 1
    out = bytearray(data[:p])
    p += 6                      # access, this, super
    nif = struct.unpack(">H", data[p:p + 2])[0]
    p += 2 + 2 * nif
    out += data[len(out):p]

    def members(p, strip):
        n = struct.unpack(">H", data[p:p + 2])[0]
        buf = bytearray(data[p:p + 2])
        p += 2
        for _ in range(n):
            buf += data[p:p + 6]
            p += 6
            na = struct.unpack(">H", data[p:p + 2])[0]
            p += 2
            attrs = []
            for _ in range(na):
                name, ln = struct.unpack(">HI", data[p:p + 6])
                chunk = data[p:p + 6 + ln]
                p += 6 + ln
                if not (strip and utf8.get(name) == b"MethodParameters"):
                    attrs.append(chunk)
            buf += struct.pack(">H", len(attrs)) + b"".join(attrs)
        return p, buf

    p, f = members(p, False)
    out += f
    p, m = members(p, True)
    out += m
    out += data[p:]
    return bytes(out)


def main():
    debug = "debug" in sys.argv[1:]
    ver = sync_version()
    # 0. 手機版網頁
    run("node", os.path.join(PROJ, "scripts", "build-mobile.mjs"), cwd=PROJ)
    shutil.rmtree(BUILD, ignore_errors=True)
    for d in ("gen", "classes", "dex"):
        os.makedirs(os.path.join(BUILD, d))
    if ANDROID_JAR != ANDROID_JAR_SRC:
        shutil.copyfile(ANDROID_JAR_SRC, ANDROID_JAR)
    assets = os.path.join(BUILD, "assets")
    shutil.copytree(WWW, os.path.join(assets, "web"))
    gen_pkg = os.path.join(BUILD, "gen", *PKG.split("."))
    os.makedirs(gen_pkg, exist_ok=True)
    open(os.path.join(gen_pkg, "BuildFlags.java"), "w", encoding="utf-8").write(
        f"package {PKG};\nfinal class BuildFlags {{ static final boolean DEBUG = {'true' if debug else 'false'}; }}\n")

    # 1. 資源
    run(os.path.join(BT, "aapt2" + EXE), "compile", "--dir", "res", "-o", os.path.join(BUILD, "res.zip"))
    unsigned = os.path.join(BUILD, "unsigned.apk")
    run(os.path.join(BT, "aapt2" + EXE), "link", "-o", unsigned,
        "-I", ANDROID_JAR, "--manifest", "AndroidManifest.xml",
        "--java", os.path.join(BUILD, "gen"), "--auto-add-overlay",
        "-A", assets, "-0", "png",
        os.path.join(BUILD, "res.zip"))

    # 2. Java
    # 原始碼先複製到建置資料夾（javac 用系統編碼讀檔案清單，路徑有中文會讀錯）
    shutil.copytree(os.path.join(ROOT, "src"), os.path.join(BUILD, "src"))
    sources = glob.glob(os.path.join(BUILD, "src", "**", "*.java"), recursive=True)
    sources += glob.glob(os.path.join(BUILD, "gen", "**", "*.java"), recursive=True)
    argfile = os.path.join(BUILD, "sources.txt")
    with open(argfile, "w", encoding="utf-8") as f:
        f.write("\n".join('"%s"' % s.replace("\\", "/") for s in sources))
    # 函式庫（Apache Commons Net：FTP／FTPS；JSch：SFTP）：去掉 Java 9+ 的多版本類別，d8 才不會重複
    libs = []
    os.makedirs(os.path.join(BUILD, "libs"), exist_ok=True)
    for src in sorted(glob.glob(os.path.join(ROOT, "libs", "*.jar"))):
        dst = os.path.join(BUILD, "libs", os.path.basename(src))
        with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zo:
            for n in zi.namelist():
                if n.endswith(".class") and not n.startswith("META-INF/"):
                    zo.writestr(n, strip_method_parameters(zi.read(n)))
        libs.append(dst)
    run(JAVAC, "-encoding", "UTF-8", "--release", "8", "-nowarn", "-Xlint:-options",
        "-classpath", os.pathsep.join([ANDROID_JAR] + libs), "-d", os.path.join(BUILD, "classes"), "@" + argfile)

    # 3. dex（先打包成 jar，避免 d8.bat 命令列太長）
    jar = os.path.join(BUILD, "classes.jar")
    cdir = os.path.join(BUILD, "classes")
    with zipfile.ZipFile(jar, "w") as z:
        for f in glob.glob(os.path.join(cdir, "**", "*.class"), recursive=True):
            z.write(f, os.path.relpath(f, cdir).replace(os.sep, "/"))
    run(os.path.join(BT, "d8" + BAT), "--release", "--min-api", "26", "--lib", ANDROID_JAR,
        "--output", os.path.join(BUILD, "dex"), jar, *libs)
    with zipfile.ZipFile(unsigned, "a") as z:
        for dex in sorted(glob.glob(os.path.join(BUILD, "dex", "*.dex"))):
            z.write(dex, os.path.basename(dex))

    # 4. 對齊 + 簽章（金鑰只在本機與 GitHub Secret，不放進 git；之後的版本必須用同一把金鑰，才能覆蓋安裝）
    aligned = os.path.join(BUILD, "aligned.apk")
    run(os.path.join(BT, "zipalign" + EXE), "-f", "-p", "4", unsigned, aligned)
    if not os.path.exists(KEYSTORE):
        run(KEYTOOL, "-genkeypair", "-keystore", KEYSTORE, "-storepass", "android", "-keypass", "android",
            "-alias", "xiaokeftp", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
            "-dname", "CN=XiaokeFTP, O=achir1015")
    out = os.path.join(BUILD, APK_NAME)
    run(os.path.join(BT, "apksigner" + BAT), "sign", "--ks", KEYSTORE, "--ks-pass", "pass:android",
        "--out", out, aligned)
    if BUILD != OUT_DIR:
        os.makedirs(OUT_DIR, exist_ok=True)
        shutil.copyfile(out, os.path.join(OUT_DIR, APK_NAME))
        out = os.path.join(OUT_DIR, APK_NAME)
    print("完成：", out, "v" + ver, "%.1f MB" % (os.path.getsize(out) / 1048576), "（除錯版）" if debug else "")

    if "install" in sys.argv[1:]:
        run(ADB, "install", "-r", out)
        run(ADB, "shell", "am", "start", "-n", PKG + "/.MainActivity")


if __name__ == "__main__":
    main()
