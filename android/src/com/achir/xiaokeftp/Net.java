package com.achir.xiaokeftp;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 連線與檔案的實際工作（在背景執行緒執行）：遠端連線（cid）、傳輸（tid，含進度與限速）、本機檔案、校驗和。
 * 傳輸佇列本身（排程、續傳判斷、檔案已存在詢問）在網頁的 JavaScript 裡，和桌面版行為一致。
 */
final class Net {
    interface Log { void log(String line); }
    interface Emit { void emit(String name, JSONObject data); }

    /** SSH 主機指紋（第一次連線記住） */
    static final class KnownHosts {
        final SharedPreferences p;
        KnownHosts(Context c) { p = c.getSharedPreferences("known_hosts", Context.MODE_PRIVATE); }
        String get(String h) { return p.getString(h, null); }
        void put(String h, String fp) { p.edit().putString(h, fp).apply(); }
    }

    final Context ctx;
    final Emit emit;
    final KnownHosts known;
    final Map<String, Conn> conns = new ConcurrentHashMap<>();
    final Map<String, Conn> running = new ConcurrentHashMap<>();
    final AtomicInteger seq = new AtomicInteger(1);
    final Bucket down = new Bucket(), up = new Bucket();

    Net(Context ctx, Emit emit) { this.ctx = ctx; this.emit = emit; this.known = new KnownHosts(ctx); }

    // ---------------- 限速（令牌桶，rate 0 = 不限） ----------------
    static final class Bucket {
        volatile long rate;
        double avail; long t = System.currentTimeMillis();
        synchronized long need(int n) {
            long r = rate;
            if (r <= 0) return 0;
            long now = System.currentTimeMillis();
            avail = Math.min(r, avail + (now - t) / 1000.0 * r);
            t = now;
            avail -= n;
            return avail < 0 ? (long) Math.min(5000, -avail / r * 1000) : 0;
        }
        void take(int n) throws IOException {
            long w = need(n);
            if (w > 0) try { Thread.sleep(w); } catch (InterruptedException e) { throw new IOException("已取消"); }
        }
    }

    /** 計數＋限速＋取消的串流包裝 */
    final class Meter {
        final String tid; final Bucket b; volatile long done; volatile boolean stop; long last;
        Meter(String tid, Bucket b, long start) { this.tid = tid; this.b = b; this.done = start; }
        void add(int n) throws IOException {
            if (stop) throw new IOException("已取消");
            done += n;
            b.take(n);
            long now = System.currentTimeMillis();
            if (now - last > 250) { last = now; report(); }
        }
        void report() {
            JSONObject o = new JSONObject();
            try { o.put("tid", tid); o.put("done", done); } catch (Exception ignored) { }
            emit.emit("xfer", o);
        }
        InputStream in(InputStream i) {
            return new FilterInputStream(i) {
                @Override public int read(byte[] buf, int off, int len) throws IOException { int n = super.read(buf, off, Math.min(len, 65536)); if (n > 0) add(n); return n; }
                @Override public int read() throws IOException { int c = super.read(); if (c >= 0) add(1); return c; }
            };
        }
        OutputStream out(OutputStream o) {
            return new FilterOutputStream(o) {
                @Override public void write(byte[] buf, int off, int len) throws IOException { out.write(buf, off, len); add(len); }
                @Override public void write(int c) throws IOException { out.write(c); add(1); }
            };
        }
    }
    final Map<String, Meter> meters = new ConcurrentHashMap<>();

    // ---------------- 遠端 ----------------
    Log logFor(final String label) {
        return line -> {
            JSONObject o = new JSONObject();
            try { o.put("src", label); o.put("line", line); o.put("t", System.currentTimeMillis()); } catch (Exception ignored) { }
            emit.emit("log", o);
        };
    }

    Conn conn(String cid) throws Exception {
        Conn c = conns.get(cid);
        if (c == null) throw new IOException("連線已關閉，請重新連線");
        return c;
    }

    JSONObject open(JSONObject site) throws Exception {
        String label = site.optString("name", site.optString("host"));
        Log log = logFor(label);
        String p = site.optString("protocol", "ftp");
        Conn c = p.startsWith("ftp") ? new FtpConn(site, log) : p.equals("sftp") ? new SftpConn(site, log, known) : new DavConn(site, log);
        String home;
        try { home = c.connect(); } catch (Exception e) { c.close(); log.log("連線失敗：" + Util.friendly(e)); throw e; }
        String cid = "c" + seq.getAndIncrement();
        conns.put(cid, c);
        JSONObject o = new JSONObject();
        o.put("cid", cid); o.put("home", home); o.put("canAppend", c.canAppend());
        return o;
    }

    void rmrf(Conn c, String p, boolean dir) throws Exception {
        if (dir) {
            JSONArray l = c.list(p);
            for (int i = 0; i < l.length(); i++) { JSONObject f = l.getJSONObject(i); rmrf(c, Util.join(p, f.getString("name")), "dir".equals(f.optString("type"))); }
            c.rmdir(p);
        } else c.remove(p);
    }

    void closeConn(String cid) { Conn c = conns.remove(cid); if (c != null) c.close(); }

    // ---------------- 傳輸 ----------------
    void download(String cid, String remote, String local, long startAt, String tid, long mtime) throws Exception {
        Conn c = conn(cid);
        File f = new File(local);
        File parent = f.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("Permission denied：無法建立資料夾 " + parent);
        Meter m = new Meter(tid, down, startAt);
        meters.put(tid, m);
        running.put(tid, c);
        try (OutputStream out = m.out(new FileOutputStream(f, startAt > 0))) {
            c.download(remote, out, startAt);
        } finally { meters.remove(tid); running.remove(tid); m.report(); }
        if (m.stop) throw new IOException("已取消");
        if (mtime > 0) f.setLastModified(mtime);
    }

    void upload(String cid, String local, String remote, long startAt, String tid) throws Exception {
        Conn c = conn(cid);
        File f = new File(local);
        Meter m = new Meter(tid, up, startAt);
        meters.put(tid, m);
        running.put(tid, c);
        try (InputStream in = new FileInputStream(f)) {
            long skipped = 0;
            while (skipped < startAt) { long k = in.skip(startAt - skipped); if (k <= 0) break; skipped += k; }
            c.upload(m.in(in), remote, startAt > 0, f.length() - startAt);
        } finally { meters.remove(tid); running.remove(tid); m.report(); }
        if (m.stop) throw new IOException("已取消");
    }

    /** 暫停／取消：中斷這個傳輸用的連線（佇列會丟掉這條連線） */
    void abort(String tid) {
        Meter m = meters.get(tid);
        if (m != null) m.stop = true;
        Conn c = running.get(tid);
        if (c != null) c.abort();
    }

    // ---------------- 本機檔案 ----------------
    static JSONObject localItem(File f) {
        boolean dir = f.isDirectory();
        JSONObject o = Util.item(f.getName(), dir ? "dir" : "file", dir ? 0 : f.length(), f.lastModified(), "", "", "");
        return o;
    }

    JSONObject listLocal(String path) throws Exception {
        File d = new File(path);
        File[] fs = d.listFiles();
        if (fs == null) {
            if (!d.exists()) throw new IOException("No such file：" + path);
            throw new IOException("Permission denied：沒有權限讀取這個資料夾（請在設定允許「所有檔案存取權」）");
        }
        JSONArray a = new JSONArray();
        for (File f : fs) a.put(localItem(f));
        JSONObject o = new JSONObject();
        o.put("path", d.getAbsolutePath());
        o.put("items", a);
        return o;
    }

    /** 整個資料夾的檔案清單（上傳資料夾用）：files 與（空）資料夾 */
    JSONObject walk(String root) throws Exception {
        JSONArray files = new JSONArray(), dirs = new JSONArray();
        walk(new File(root), files, dirs);
        JSONObject o = new JSONObject();
        o.put("files", files); o.put("dirs", dirs);
        return o;
    }
    void walk(File d, JSONArray files, JSONArray dirs) throws Exception {
        dirs.put(d.getAbsolutePath());
        File[] fs = d.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            if (f.isDirectory()) walk(f, files, dirs);
            else { JSONObject o = new JSONObject(); o.put("path", f.getAbsolutePath()); o.put("size", f.length()); o.put("mtime", f.lastModified()); files.put(o); }
        }
    }

    static void deleteRec(File f) throws IOException {
        File[] k = f.listFiles();
        if (k != null) for (File x : k) deleteRec(x);
        if (!f.delete() && f.exists()) throw new IOException("Permission denied：無法刪除 " + f.getName());
    }

    JSONObject places() throws Exception {
        File root = Environment.getExternalStorageDirectory();
        JSONArray p = new JSONArray(), d = new JSONArray();
        String[][] list = {
                { "下載", Environment.DIRECTORY_DOWNLOADS, "down" }, { "文件", Environment.DIRECTORY_DOCUMENTS, "doc" },
                { "相機照片", Environment.DIRECTORY_DCIM, "pic" }, { "圖片", Environment.DIRECTORY_PICTURES, "pic" },
                { "影片", Environment.DIRECTORY_MOVIES, "pic" }, { "音樂", Environment.DIRECTORY_MUSIC, "pic" },
        };
        for (String[] x : list) {
            JSONObject o = new JSONObject();
            o.put("name", x[0]); o.put("path", new File(root, x[1]).getAbsolutePath()); o.put("icon", x[2]);
            p.put(o);
        }
        JSONObject r = new JSONObject();
        r.put("name", "手機儲存空間"); r.put("path", root.getAbsolutePath()); r.put("icon", "drive");
        d.put(r);
        JSONObject a = new JSONObject();
        a.put("name", "App 專用資料夾"); a.put("path", ctx.getExternalFilesDir(null).getAbsolutePath()); a.put("icon", "drive");
        d.put(a);
        JSONObject o = new JSONObject();
        o.put("places", p); o.put("drives", d);
        o.put("home", new File(root, Environment.DIRECTORY_DOWNLOADS).getAbsolutePath());
        JSONObject rt = new JSONObject();
        rt.put("name", "手機"); rt.put("path", root.getAbsolutePath());
        o.put("root", rt);
        return o;
    }

    JSONObject hash(String path) throws Exception {
        File f = new File(path);
        MessageDigest md5 = MessageDigest.getInstance("MD5"), sha1 = MessageDigest.getInstance("SHA-1"), sha256 = MessageDigest.getInstance("SHA-256");
        long total = f.length(), got = 0, last = 0;
        try (InputStream in = new FileInputStream(f)) {
            byte[] b = new byte[1 << 20]; int n;
            while ((n = in.read(b)) > 0) {
                md5.update(b, 0, n); sha1.update(b, 0, n); sha256.update(b, 0, n);
                got += n;
                long now = System.currentTimeMillis();
                if (now - last > 150) { last = now; JSONObject o = new JSONObject(); o.put("file", path); o.put("got", got); o.put("total", total); emit.emit("hash", o); }
            }
        }
        JSONObject o = new JSONObject();
        o.put("file", path); o.put("size", total); o.put("md5", hex(md5.digest())); o.put("sha1", hex(sha1.digest())); o.put("sha256", hex(sha256.digest()));
        return o;
    }
    static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }

    void shutdown() {
        for (String tid : running.keySet()) abort(tid);
        for (Conn c : conns.values()) c.close();
        conns.clear();
    }
}
