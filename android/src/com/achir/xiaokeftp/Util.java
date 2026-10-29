package com.achir.xiaokeftp;

import org.json.JSONObject;

import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

/** 遠端路徑（/ 分隔）、檔案資訊、錯誤訊息中文化 */
final class Util {
    private Util() { }

    static String norm(String p) {
        if (p == null || p.isEmpty()) return "/";
        p = p.replace('\\', '/');
        if (!p.startsWith("/")) p = "/" + p;
        String[] parts = p.split("/");
        java.util.ArrayDeque<String> st = new java.util.ArrayDeque<>();
        for (String s : parts) {
            if (s.isEmpty() || s.equals(".")) continue;
            if (s.equals("..")) { if (!st.isEmpty()) st.removeLast(); continue; }
            st.addLast(s);
        }
        StringBuilder b = new StringBuilder();
        for (String s : st) b.append('/').append(s);
        return b.length() == 0 ? "/" : b.toString();
    }
    static String join(String a, String b) { return norm(a + "/" + b); }
    static String dir(String p) { p = norm(p); int i = p.lastIndexOf('/'); return i <= 0 ? "/" : p.substring(0, i); }
    static String base(String p) { p = norm(p); return p.substring(p.lastIndexOf('/') + 1); }

    static String perm(int mode) {
        String t = "rwxrwxrwx";
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < 9; i++) s.append((mode & (1 << (8 - i))) != 0 ? t.charAt(i) : '-');
        return s.toString();
    }

    static JSONObject item(String name, String type, long size, long mtime, String perm, String owner, String target) {
        JSONObject o = new JSONObject();
        try {
            o.put("name", name); o.put("type", type); o.put("size", size); o.put("mtime", mtime);
            o.put("perm", perm == null ? "" : perm); o.put("owner", owner == null ? "" : owner); o.put("target", target == null ? "" : target);
        } catch (Exception ignored) { }
        return o;
    }

    /** 錯誤訊息翻成看得懂的中文（和桌面版 friendlyError 一致） */
    static String friendly(Throwable e) {
        String m = String.valueOf(e.getMessage());
        String all = e.getClass().getSimpleName() + " " + m;
        if (e instanceof UnknownHostException || all.contains("UnknownHost")) return "找不到這台主機，請確認主機名稱或網路";
        if (e instanceof ConnectException || all.contains("ECONNREFUSED") || all.contains("Connection refused")) return "主機拒絕連線，請確認連接埠與伺服器是否開啟";
        if (e instanceof SocketTimeoutException || all.contains("timed out") || all.contains("timeout")) return "連線逾時，請確認網路、防火牆或改用被動模式";
        if (all.contains("Auth fail") || all.contains("530") || all.contains("401") || all.contains("Login")) return "登入失敗：帳號或密碼不正確";
        if (all.contains("HostKey has been changed") || all.contains("主機指紋")) return m;
        if (all.contains("Certificate") || all.contains("certificate") || all.contains("SSLHandshake") || all.contains("CertPath")) return "伺服器憑證無法驗證（可在站台設定勾選「信任自簽憑證」）";
        if (all.contains("550") || all.contains("No such file") || all.contains("404") || all.contains("FileNotFound") || all.contains("ENOENT")) return "檔案或資料夾不存在，或沒有權限";
        if (all.contains("553") || all.contains("Permission denied") || all.contains("403") || all.contains("EACCES")) return "沒有權限執行這個動作";
        if (all.contains("552") || all.contains("ENOSPC") || all.contains("No space") || all.contains("507")) return "空間不足";
        if (all.contains("已取消")) return "已取消";
        if (e instanceof IOException && (all.contains("closed") || all.contains("reset") || all.contains("Broken pipe") || all.contains("EOF"))) return "連線中斷了，請再試一次";
        return m == null || m.equals("null") ? e.getClass().getSimpleName() : m;
    }
}
