package com.achir.xiaokeftp;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 小柯機器人FTP助手 — Android 版
 * 畫面用 WebView 開啟和桌面版同一份程式（assets/web），FTP／SFTP／WebDAV 與檔案讀寫由 Bridge／Net 的原生程式負責。
 * 網頁從 https://appassets.androidplatform.net/ 載入（安全來源），由 shouldInterceptRequest 回傳 assets 裡的檔案。
 * 離開 App 時所有連線與傳輸一併停止。
 */
public class MainActivity extends Activity {
    static final String TAG = "XiaokeFTP";
    static final String ORIGIN = "https://appassets.androidplatform.net";
    static final int REQ_FILES = 1;

    WebView web;
    Bridge bridge;
    ValueCallback<Uri[]> fileCallback;
    long lastBack = 0;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        web = new WebView(this);
        web.setBackgroundColor(0xFFEEF3FB);
        setContentView(web);
        WebView.setWebContentsDebuggingEnabled(BuildFlags.DEBUG);   // python build.py debug 才開（給 chrome://inspect 測試用）

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setUserAgentString(s.getUserAgentString() + " XiaokeFTPAndroid/" + Bridge.version(this));

        bridge = new Bridge(this);
        web.addJavascriptInterface(bridge, "XiaokeAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return null;
                return serve(u.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            /** 匯入站台清單：開啟系統的檔案選擇器 */
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                try { startActivityForResult(i, REQ_FILES); } catch (Exception e) { fileCallback = null; return false; }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });

        web.loadUrl(ORIGIN + "/index.html");
    }

    /** 回傳 assets/web 裡的檔案 */
    WebResourceResponse serve(String path) {
        try {
            if (path == null || path.equals("/")) path = "/index.html";
            String m = mime(path);
            Map<String, String> h = new HashMap<>();
            h.put("Cache-Control", "no-store");
            InputStream in = getAssets().open("web" + Uri.decode(path));
            return new WebResourceResponse(m, m.startsWith("text") || m.endsWith("json") || m.endsWith("svg+xml") ? "utf-8" : null, 200, "OK", h, in);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", null, null);
        }
    }

    static String mime(String p) {
        p = p.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILES && fileCallback != null) {
            Uri[] out = null;
            if (res == RESULT_OK && data != null && data.getData() != null) out = new Uri[]{ data.getData() };
            fileCallback.onReceiveValue(out);
            fileCallback = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    /** 返回鍵：交給網頁處理（關對話框、回上一層資料夾）；不能再退時按兩次才離開 */
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(function(){try{return !!(window.__xkBack&&window.__xkBack())}catch(e){return false}})()", v -> {
            if ("true".equals(v)) return;
            long now = System.currentTimeMillis();
            if (now - lastBack < 2000) { finish(); return; }
            lastBack = now;
            Toast.makeText(this, "再按一次返回鍵離開", Toast.LENGTH_SHORT).show();
        });
    }

    /** 從設定畫面回來時（例如剛允許「所有檔案存取權」），通知網頁重新整理 */
    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        js("window.__xkResume&&window.__xkResume()");
    }

    @Override
    protected void onPause() { super.onPause(); web.onPause(); }

    void js(final String code) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(code, null); });
    }

    @Override
    protected void onDestroy() {
        bridge.shutdown();
        web.removeJavascriptInterface("XiaokeAndroid");
        web.loadUrl("about:blank");
        web.destroy();
        web = null;
        super.onDestroy();
    }
}
