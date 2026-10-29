package com.achir.xiaokeftp;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.MimeTypeMap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 網頁呼叫的 Android 功能（window.XiaokeAndroid）：
 * call(id, method, argsJson) 在背景執行緒執行，結果用 window.__xkDone(id, json) 回傳；事件用 window.__xkEvent(name, json)。
 * 另外有直接呼叫的：文字轉語音、App 資訊。
 */
final class Bridge {
    static final String REPO = "achir1015/xiaoke-ftp";

    final MainActivity a;
    final Net net;
    final ExecutorService pool = Executors.newCachedThreadPool();
    volatile JSONObject updateStatus = st("idle", 0);
    TextToSpeech tts;
    volatile boolean ttsReady = false;
    volatile String ttsVoiceName = "";

    Bridge(MainActivity a) {
        this.a = a;
        this.net = new Net(a.getApplicationContext(), (name, data) -> a.js("window.__xkEvent&&window.__xkEvent(" + JSONObject.quote(name) + "," + data + ")"));
        initTts();
    }

    static JSONObject st(String state, int pct) {
        JSONObject o = new JSONObject();
        try { o.put("state", state); o.put("pct", pct); } catch (Exception ignored) { }
        return o;
    }

    static String version(Context c) {
        try { return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName; } catch (Exception e) { return "0"; }
    }

    @JavascriptInterface
    public String appInfo() {
        JSONObject o = new JSONObject();
        try {
            o.put("name", a.getString(R.string.app_name)); o.put("version", version(a)); o.put("platform", "android");
            o.put("sdk", Build.VERSION.SDK_INT); o.put("model", Build.MODEL);
        } catch (Exception ignored) { }
        return o.toString();
    }

    // ---------------- 非同步呼叫 ----------------
    @JavascriptInterface
    public void call(final String id, final String method, final String argsJson) {
        pool.execute(() -> {
            JSONObject r = new JSONObject();
            try {
                Object v = dispatch(method, new JSONArray(argsJson == null ? "[]" : argsJson));
                r.put("ok", true);
                r.put("data", v == null ? JSONObject.NULL : v);
            } catch (Throwable e) {
                try { r.put("ok", false); r.put("error", Util.friendly(e)); r.put("raw", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
            }
            a.js("window.__xkDone&&window.__xkDone(" + JSONObject.quote(id) + "," + r + ")");
        });
    }

    Object dispatch(String m, JSONArray x) throws Exception {
        switch (m) {
            // 遠端
            case "r.open": return net.open(x.getJSONObject(0));
            case "r.list": { JSONObject o = new JSONObject(); String p = Util.norm(x.getString(1)); o.put("path", p); o.put("items", net.conn(x.getString(0)).list(p)); return o; }
            case "r.stat": return net.conn(x.getString(0)).stat(x.getString(1));
            case "r.mkdir": net.conn(x.getString(0)).mkdir(x.getString(1)); return true;
            case "r.remove": net.conn(x.getString(0)).remove(x.getString(1)); return true;
            case "r.rmdir": net.conn(x.getString(0)).rmdir(x.getString(1)); return true;
            case "r.rename": net.conn(x.getString(0)).rename(x.getString(1), x.getString(2)); return true;
            case "r.chmod": net.conn(x.getString(0)).chmod(x.getString(1), x.getInt(2)); return true;
            case "r.delete": {
                Conn c = net.conn(x.getString(0));
                JSONArray items = x.getJSONArray(1);
                for (int i = 0; i < items.length(); i++) { JSONObject it = items.getJSONObject(i); net.rmrf(c, it.getString("path"), "dir".equals(it.optString("type"))); }
                return true;
            }
            case "r.newFile": net.conn(x.getString(0)).upload(new java.io.ByteArrayInputStream(new byte[0]), x.getString(1), false, 0); return true;
            case "r.close": net.closeConn(x.getString(0)); return true;
            // 傳輸
            case "x.down": net.download(x.getString(0), x.getString(1), x.getString(2), x.getLong(3), x.getString(4), x.optLong(5)); return true;
            case "x.up": net.upload(x.getString(0), x.getString(1), x.getString(2), x.getLong(3), x.getString(4)); return true;
            case "x.abort": net.abort(x.getString(0)); return true;
            case "x.limits": net.down.rate = Math.max(0, x.getLong(0)) * 1024; net.up.rate = Math.max(0, x.getLong(1)) * 1024; return true;
            // 本機
            case "l.list": return net.listLocal(x.getString(0));
            case "l.stat": { File f = new File(x.getString(0)); return f.exists() ? Net.localItem(f) : null; }
            case "l.mkdir": { File f = new File(x.getString(0)); if (!f.mkdir()) throw new java.io.IOException("Permission denied：無法建立資料夾"); return true; }
            case "l.mkdirs": new File(x.getString(0)).mkdirs(); return true;
            case "l.newFile": { File f = new File(x.getString(0)); if (f.exists()) throw new java.io.IOException("已經有同名的檔案"); if (!f.createNewFile()) throw new java.io.IOException("Permission denied"); return true; }
            case "l.rename": if (!new File(x.getString(0)).renameTo(new File(x.getString(1)))) throw new java.io.IOException("Permission denied：無法重新命名"); return true;
            case "l.delete": { JSONArray p = x.getJSONArray(0); for (int i = 0; i < p.length(); i++) Net.deleteRec(new File(p.getString(i))); return true; }
            case "l.walk": return net.walk(x.getString(0));
            case "l.places": return net.places();
            case "l.open": openFile(x.getString(0), false); return true;
            case "l.share": openFile(x.getString(0), true); return true;
            case "l.readText": { File f = new File(x.getString(0)); if (f.length() > 1 << 20) throw new java.io.IOException("檔案太大"); return new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }
            case "l.writeText": { File f = new File(x.getString(0)); f.getParentFile().mkdirs(); try (FileOutputStream o = new FileOutputStream(f)) { o.write(x.getString(1).getBytes(StandardCharsets.UTF_8)); } return f.getAbsolutePath(); }
            case "hash": return net.hash(x.getString(0));
            // 權限
            case "perm.status": return hasAllFiles();
            case "perm.request": requestAllFiles(); return true;
            // 密碼加密
            case "secret.enc": return encrypt(x.getString(0));
            case "secret.dec": return decrypt(x.getString(0));
            // 其他
            case "keepAwake": { final boolean on = x.getBoolean(0); a.runOnUiThread(() -> { if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); }); return true; }
            case "openUrl": return openUrl(x.getString(0));
            case "update.check": return checkUpdate();
            case "update.install": return installUpdate(x.getString(0), x.getString(1));
            case "update.status": return updateStatus;
            default: throw new Exception("未知的功能：" + m);
        }
    }

    // ---------------- 所有檔案存取權（瀏覽手機裡的檔案） ----------------
    static boolean hasAllFiles() { return Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager(); }

    void requestAllFiles() {
        a.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 30) {
                try { a.startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + a.getPackageName()))); }
                catch (Exception e) { a.startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)); }
            } else a.requestPermissions(new String[]{ android.Manifest.permission.READ_EXTERNAL_STORAGE, android.Manifest.permission.WRITE_EXTERNAL_STORAGE }, 9);
        });
    }

    // ---------------- 用其他 App 開啟／分享檔案 ----------------
    void openFile(String path, boolean share) throws Exception {
        File f = new File(path);
        if (!f.isFile()) throw new java.io.IOException("No such file");
        Uri uri = FilesProvider.uriFor(a, f);
        String ext = MimeTypeMap.getFileExtensionFromUrl(Uri.encode(f.getName())).toLowerCase(Locale.ROOT);
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (mime == null) mime = "*/*";
        Intent i;
        if (share) i = new Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri);
        else i = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        final Intent chooser = Intent.createChooser(i, share ? "分享到…" : "用哪個 App 開啟？");
        a.runOnUiThread(() -> { try { a.startActivity(chooser); } catch (Exception ignored) { } });
    }

    // ---------------- 密碼加密（Android Keystore，AES-GCM） ----------------
    SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias("xiaoke-ftp")) return ((KeyStore.SecretKeyEntry) ks.getEntry("xiaoke-ftp", null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder("xiaoke-ftp", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return g.generateKey();
    }
    String encrypt(String s) throws Exception {
        if (s == null || s.isEmpty()) return "";
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV(), enc = c.doFinal(s.getBytes(StandardCharsets.UTF_8));
        return "ks:" + Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(enc, Base64.NO_WRAP);
    }
    String decrypt(String s) {
        try {
            if (s == null || !s.startsWith("ks:")) return "";
            String[] p = s.split(":");
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(p[1], Base64.NO_WRAP)));
            return new String(c.doFinal(Base64.decode(p[2], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) { return ""; }
    }

    // ---------------- 語音說明（Android WebView 沒有網頁語音，改用系統文字轉語音） ----------------
    void initTts() {
        tts = new TextToSpeech(a.getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS) return;
            Locale[] prefer = { Locale.TAIWAN, new Locale("zh", "TW"), Locale.TRADITIONAL_CHINESE, new Locale("yue", "HK"), Locale.CHINESE, Locale.SIMPLIFIED_CHINESE };
            for (Locale l : prefer) {
                if (tts.isLanguageAvailable(l) >= TextToSpeech.LANG_AVAILABLE) { tts.setLanguage(l); ttsReady = true; break; }
            }
            try { Voice v = tts.getVoice(); if (v != null) ttsVoiceName = v.getName() + "（" + v.getLocale().toLanguageTag() + "）"; } catch (Exception ignored) { }
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { ttsDone(id); }
                @Override public void onError(String id) { ttsDone(id); }
                @Override public void onStop(String id, boolean interrupted) { ttsDone(id); }
            });
        });
    }
    void ttsDone(String id) { a.js("window.__xkTtsDone&&window.__xkTtsDone(" + JSONObject.quote(id) + ")"); }

    @JavascriptInterface public boolean ttsAvailable() { return ttsReady; }
    @JavascriptInterface public String ttsVoice() { return ttsVoiceName.isEmpty() ? "手機語音" : ttsVoiceName; }
    @JavascriptInterface public void ttsSpeak(String text, double rate, String id) {
        if (!ttsReady) { ttsDone(id); return; }
        tts.setSpeechRate((float) Math.max(0.5, Math.min(2.0, rate)));
        Bundle p = new Bundle();
        p.putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, id);
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, p, id);
    }
    @JavascriptInterface public void ttsStop() { if (tts != null) tts.stop(); }

    void shutdown() {
        try { if (tts != null) { tts.stop(); tts.shutdown(); } } catch (Exception ignored) { }
        net.shutdown();
        pool.shutdownNow();
    }

    /** 只允許開啟本專案的網址 */
    boolean openUrl(String url) {
        if (!(url.startsWith("https://github.com/achir1015/") || url.startsWith("https://achir1015.github.io/"))) return false;
        a.runOnUiThread(() -> { try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { } });
        return true;
    }

    // ---------------- 版本更新：GitHub Releases 最新版的 .apk ----------------
    static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(15000);
        c.setRequestProperty("Accept", "application/vnd.github+json");
        c.setRequestProperty("User-Agent", "XiaokeFTP-Android");
        try (InputStream in = c.getInputStream()) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            return new String(bo.toByteArray(), "UTF-8");
        } finally { c.disconnect(); }
    }

    static String latestTag() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("https://github.com/" + REPO + "/releases/latest").openConnection();
        c.setInstanceFollowRedirects(false);
        c.setConnectTimeout(10000);
        c.setRequestProperty("User-Agent", "XiaokeFTP-Android");
        try {
            String loc = c.getHeaderField("Location");
            if (loc == null || !loc.contains("/releases/tag/")) throw new Exception("查詢失敗（" + c.getResponseCode() + "）");
            return loc.substring(loc.lastIndexOf('/') + 1);
        } finally { c.disconnect(); }
    }

    JSONObject checkUpdate() throws Exception {
        String tag, apk = "", page, notes = "";
        try {
            JSONObject o = new JSONObject(get("https://api.github.com/repos/" + REPO + "/releases/latest"));
            tag = o.optString("tag_name");
            page = o.optString("html_url");
            notes = o.optString("body", "");
            JSONArray as = o.optJSONArray("assets");
            for (int i = 0; as != null && i < as.length(); i++) {
                JSONObject x = as.getJSONObject(i);
                if (x.optString("name").toLowerCase().endsWith(".apk")) apk = x.getString("browser_download_url");
            }
        } catch (Exception e) {
            tag = latestTag();
            page = "https://github.com/" + REPO + "/releases/tag/" + tag;
            apk = "https://github.com/" + REPO + "/releases/download/" + tag + "/XiaokeFTP-" + tag.replaceAll("^[vV]", "") + "-android.apk";
        }
        JSONObject r = new JSONObject();
        r.put("current", version(a)); r.put("latest", tag.replaceAll("^[vV]", "")); r.put("url", apk); r.put("page", page); r.put("notes", notes);
        return r;
    }

    JSONObject installUpdate(final String url, final String ver) throws Exception {
        if (!url.startsWith("https://github.com/" + REPO + "/releases/download/")) throw new Exception("bad url");
        if (!a.getPackageManager().canRequestPackageInstalls()) {
            a.runOnUiThread(() -> { try { a.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName()))); } catch (Exception ignored) { } });
            updateStatus = st("permission", 0);
            return updateStatus;
        }
        final DownloadManager dm = (DownloadManager) a.getSystemService(Context.DOWNLOAD_SERVICE);
        String file = "XiaokeFTP-" + ver + ".apk";
        File old = new File(a.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), file);
        if (old.exists()) old.delete();
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url))
                .setTitle(a.getString(R.string.app_name) + " v" + ver)
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalFilesDir(a, Environment.DIRECTORY_DOWNLOADS, file);
        final long id = dm.enqueue(req);
        updateStatus = st("downloading", 0);
        final Context app = a.getApplicationContext();
        BroadcastReceiver done = new BroadcastReceiver() {
            public void onReceive(Context c, Intent i) {
                if (i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
                try { app.unregisterReceiver(this); } catch (Exception ignored) { }
                Uri uri = dm.getUriForDownloadedFile(id);
                if (uri == null) { updateStatus = st("error", 0); return; }
                updateStatus = st("launching", 100);
                Intent v = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                try { app.startActivity(v); } catch (Exception e) { updateStatus = st("error", 0); }
            }
        };
        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(done, f, Context.RECEIVER_EXPORTED);
        else app.registerReceiver(done, f);
        pool.execute(() -> {
            while ("downloading".equals(updateStatus.optString("state"))) {
                try (Cursor cur = dm.query(new DownloadManager.Query().setFilterById(id))) {
                    if (cur != null && cur.moveToFirst()) {
                        long got = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                        long all = cur.getLong(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                        int s = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                        if (s == DownloadManager.STATUS_FAILED) { updateStatus = st("error", 0); break; }
                        if (all > 0) updateStatus = st("downloading", (int) (got * 100 / all));
                    }
                } catch (Exception ignored) { }
                try { Thread.sleep(500); } catch (InterruptedException e) { break; }
            }
        });
        return updateStatus;
    }
}
