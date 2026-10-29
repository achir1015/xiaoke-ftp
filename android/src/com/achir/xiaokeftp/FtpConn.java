package com.achir.xiaokeftp;

import org.apache.commons.net.ProtocolCommandEvent;
import org.apache.commons.net.ProtocolCommandListener;
import org.apache.commons.net.ftp.FTP;
import org.apache.commons.net.ftp.FTPClient;
import org.apache.commons.net.ftp.FTPConnectionClosedException;
import org.apache.commons.net.ftp.FTPFile;
import org.apache.commons.net.ftp.FTPReply;
import org.apache.commons.net.ftp.FTPSClient;
import org.apache.commons.net.util.TrustManagerUtils;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.time.Duration;

/** FTP／FTPS（明示 TLS、隱含 TLS），使用 Apache Commons Net */
final class FtpConn implements Conn {
    final JSONObject site;
    final Net.Log log;
    FTPClient c;
    volatile boolean aborted;
    boolean mlsd;

    FtpConn(JSONObject site, Net.Log log) { this.site = site; this.log = log; }

    @Override public synchronized String connect() throws Exception {
        String proto = site.optString("protocol", "ftp");
        boolean implicit = proto.equals("ftps-implicit");
        FTPClient cl;
        if (proto.startsWith("ftps")) {
            FTPSClient s = new FTPSClient("TLS", implicit);
            if (site.optBoolean("ignoreCert")) s.setTrustManager(TrustManagerUtils.getAcceptAllTrustManager());
            else s.setTrustManager(TrustManagerUtils.getValidateServerCertificateTrustManager());
            cl = s;
        } else cl = new FTPClient();
        int timeout = Math.max(5, site.optInt("timeout", 20)) * 1000;
        // 指令記錄（和桌面版一樣顯示在「記錄」分頁；密碼不顯示）
        cl.addProtocolCommandListener(new ProtocolCommandListener() {
            @Override public void protocolCommandSent(ProtocolCommandEvent e) { String m = e.getMessage().trim(); log.log("> " + (m.toUpperCase().startsWith("PASS") ? "PASS ******" : m)); }
            @Override public void protocolReplyReceived(ProtocolCommandEvent e) { log.log("< " + e.getMessage().trim()); }
        });
        cl.setControlEncoding("UTF-8");
        cl.setAutodetectUTF8(true);
        cl.setConnectTimeout(timeout);
        cl.setDefaultTimeout(timeout);
        cl.setDataTimeout(Duration.ofMillis(timeout));
        cl.setControlKeepAliveTimeout(Duration.ofSeconds(20));
        String host = site.optString("host");
        int port = site.optInt("port", implicit ? 990 : 21);
        log.log("連線 " + host + ":" + port + "（" + proto.toUpperCase() + "）");
        cl.connect(host, port);
        if (!FTPReply.isPositiveCompletion(cl.getReplyCode())) { cl.disconnect(); throw new IOException("伺服器拒絕連線：" + cl.getReplyString()); }
        if (cl instanceof FTPSClient) { ((FTPSClient) cl).execPBSZ(0); ((FTPSClient) cl).execPROT("P"); }
        String user = site.optString("user", "");
        String pass = site.optString("password", "");
        if (user.isEmpty()) { user = "anonymous"; if (pass.isEmpty()) pass = "guest@"; }
        if (!cl.login(user, pass)) { String r = cl.getReplyString(); cl.disconnect(); throw new IOException("530 Login " + r); }
        cl.enterLocalPassiveMode();
        cl.setFileType(FTP.BINARY_FILE_TYPE);
        try { cl.sendCommand("OPTS UTF8 ON"); } catch (Exception ignored) { }
        try { mlsd = cl.hasFeature("MLST"); } catch (Exception ignored) { }
        c = cl;
        String home;
        try { home = Util.norm(cl.printWorkingDirectory()); } catch (Exception e) { home = "/"; }
        log.log("登入成功，起始資料夾 " + home);
        return home;
    }

    interface Op<T> { T run(FTPClient c) throws Exception; }

    /** 被伺服器閒置踢掉時自動重連一次 */
    synchronized <T> T op(Op<T> fn) throws Exception {
        if (!connected()) connect();
        try { return fn.run(c); } catch (FTPConnectionClosedException | java.net.SocketException e) {
            if (aborted) throw e;
            close();
            connect();
            return fn.run(c);
        }
    }

    void check(FTPClient c, boolean ok) throws IOException {
        if (!ok) throw new IOException(c.getReplyString() == null ? "失敗" : c.getReplyString().trim());
    }

    static String typeOf(FTPFile f) { return f.isDirectory() ? "dir" : f.isSymbolicLink() ? "link" : "file"; }

    static String permOf(FTPFile f) {
        if (!f.hasPermission(FTPFile.USER_ACCESS, FTPFile.READ_PERMISSION) && !f.hasPermission(FTPFile.USER_ACCESS, FTPFile.WRITE_PERMISSION) && f.getRawListing() == null) return "";
        int m = 0;
        int[] acc = { FTPFile.USER_ACCESS, FTPFile.GROUP_ACCESS, FTPFile.WORLD_ACCESS };
        int[] p = { FTPFile.READ_PERMISSION, FTPFile.WRITE_PERMISSION, FTPFile.EXECUTE_PERMISSION };
        for (int i = 0; i < 3; i++) for (int j = 0; j < 3; j++) if (f.hasPermission(acc[i], p[j])) m |= 1 << (8 - (i * 3 + j));
        return Util.perm(m);
    }

    @Override public JSONArray list(String dir) throws Exception {
        final String d = Util.norm(dir);
        // 資料連線失敗時 commons-net 會回傳空陣列：一定要檢查回應碼，否則會被誤當成空資料夾
        FTPFile[] fs = op(cl -> {
            if (mlsd) {
                try { FTPFile[] r = cl.mlistDir(d); if (FTPReply.isPositiveCompletion(cl.getReplyCode())) return r; } catch (Exception ignored) { }
                mlsd = false;
            }
            FTPFile[] r = cl.listFiles(d);
            if (!FTPReply.isPositiveCompletion(cl.getReplyCode())) throw new IOException(cl.getReplyString() == null ? "無法讀取資料夾" : cl.getReplyString().trim());
            return r;
        });
        JSONArray out = new JSONArray();
        for (FTPFile f : fs) {
            if (f == null || f.getName() == null) continue;
            String n = f.getName();
            if (n.contains("/")) n = n.substring(n.lastIndexOf('/') + 1);
            if (n.equals(".") || n.equals("..") || n.isEmpty()) continue;
            long mt = f.getTimestamp() != null ? f.getTimestamp().getTimeInMillis() : 0;
            String owner = ((f.getUser() == null ? "" : f.getUser()) + " " + (f.getGroup() == null ? "" : f.getGroup())).trim();
            out.put(Util.item(n, typeOf(f), Math.max(0, f.getSize()), mt, permOf(f), owner, f.getLink()));
        }
        return out;
    }

    @Override public JSONObject stat(String path) throws Exception {
        String p = Util.norm(path);
        if (p.equals("/")) return Util.item("/", "dir", 0, 0, "", "", "");
        JSONArray l;
        try { l = list(Util.dir(p)); } catch (Exception e) { return null; }
        String b = Util.base(p);
        for (int i = 0; i < l.length(); i++) if (l.getJSONObject(i).optString("name").equals(b)) return l.getJSONObject(i);
        return null;
    }

    @Override public void mkdir(String p) throws Exception { op(cl -> { check(cl, cl.makeDirectory(Util.norm(p))); return null; }); }
    @Override public void remove(String p) throws Exception { op(cl -> { check(cl, cl.deleteFile(Util.norm(p))); return null; }); }
    @Override public void rmdir(String p) throws Exception { op(cl -> { check(cl, cl.removeDirectory(Util.norm(p))); return null; }); }
    @Override public void rename(String a, String b) throws Exception { op(cl -> { check(cl, cl.rename(Util.norm(a), Util.norm(b))); return null; }); }
    @Override public void chmod(String p, int mode) throws Exception { op(cl -> { check(cl, cl.sendSiteCommand("CHMOD " + Integer.toOctalString(mode & 0777) + " " + Util.norm(p))); return null; }); }

    @Override public synchronized void download(String remote, OutputStream out, long startAt) throws Exception {
        if (!connected()) connect();
        c.setRestartOffset(Math.max(0, startAt));
        try { check(c, c.retrieveFile(Util.norm(remote), out)); } finally { c.setRestartOffset(0); }
    }

    @Override public synchronized void upload(InputStream in, String remote, boolean append, long size) throws Exception {
        if (!connected()) connect();
        check(c, append ? c.appendFile(Util.norm(remote), in) : c.storeFile(Util.norm(remote), in));
    }

    @Override public boolean canAppend() { return true; }
    @Override public boolean connected() { return c != null && c.isConnected(); }

    /** 不加鎖：傳輸中的執行緒握著鎖，直接關掉 socket 讓它中斷 */
    @Override public void abort() {
        aborted = true;
        FTPClient cl = c;
        if (cl != null) try { cl.disconnect(); } catch (Exception ignored) { }
    }

    @Override public void close() {
        FTPClient cl = c;
        c = null;
        if (cl != null) { try { if (cl.isConnected()) cl.logout(); } catch (Exception ignored) { } try { cl.disconnect(); } catch (Exception ignored) { } }
    }
}
