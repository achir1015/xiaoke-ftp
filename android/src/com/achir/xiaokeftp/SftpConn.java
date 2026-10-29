package com.achir.xiaokeftp;

import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.SftpATTRS;
import com.jcraft.jsch.SftpException;
import com.jcraft.jsch.UserInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.Vector;

/** SFTP（SSH），使用 JSch；第一次連線記住主機指紋，之後改變就拒絕（除非使用者確認信任新的） */
final class SftpConn implements Conn {
    final JSONObject site;
    final Net.Log log;
    final Net.KnownHosts known;
    Session session;
    ChannelSftp sftp;

    SftpConn(JSONObject site, Net.Log log, Net.KnownHosts known) { this.site = site; this.log = log; this.known = known; }

    static String fingerprint(byte[] key) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(key);
        return "SHA256:" + android.util.Base64.encodeToString(d, android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
    }

    @Override public synchronized String connect() throws Exception {
        final String host = site.optString("host");
        final int port = site.optInt("port", 22);
        final String id = host + ":" + port;
        final boolean trustNew = site.optBoolean("trustNewHostKey");
        JSch j = new JSch();
        String key = site.optString("privateKey", "");
        if (!key.isEmpty()) {
            String pp = site.optString("passphrase", "");
            j.addIdentity("key", key.getBytes("UTF-8"), null, pp.isEmpty() ? null : pp.getBytes("UTF-8"));
        }
        final String[] changed = { null };
        j.setHostKeyRepository(new HostKeyRepository() {
            @Override public int check(String h, byte[] k) {
                try {
                    String fp = fingerprint(k);
                    String old = known.get(id);
                    if (old == null || old.equals(fp) || trustNew) {
                        if (!fp.equals(old)) { known.put(id, fp); log.log((old == null ? "第一次連線，已記住主機指紋 " : "已信任新的主機指紋 ") + fp); }
                        return OK;
                    }
                    changed[0] = "主機指紋改變了！上次：" + old + "，這次：" + fp;
                    return CHANGED;
                } catch (Exception e) { return NOT_INCLUDED; }
            }
            @Override public void add(HostKey hk, UserInfo ui) { }
            @Override public void remove(String h, String t) { }
            @Override public void remove(String h, String t, byte[] k) { }
            @Override public String getKnownHostsRepositoryID() { return "xiaoke"; }
            @Override public HostKey[] getHostKey() { return new HostKey[0]; }
            @Override public HostKey[] getHostKey(String h, String t) { return new HostKey[0]; }
        });
        Session s = j.getSession(site.optString("user", ""), host, port);
        String pass = site.optString("password", "");
        if (!pass.isEmpty()) s.setPassword(pass);
        s.setConfig("StrictHostKeyChecking", "yes");
        s.setConfig("PreferredAuthentications", key.isEmpty() ? "password,keyboard-interactive" : "publickey,password,keyboard-interactive");
        s.setUserInfo(new UserInfo() {
            public String getPassphrase() { return null; }
            public String getPassword() { return site.optString("password", ""); }
            public boolean promptPassword(String m) { return !site.optString("password", "").isEmpty(); }
            public boolean promptPassphrase(String m) { return false; }
            public boolean promptYesNo(String m) { return false; }
            public void showMessage(String m) { }
        });
        s.setServerAliveInterval(20000);
        int timeout = Math.max(5, site.optInt("timeout", 20)) * 1000;
        log.log("連線 " + host + ":" + port + "（SFTP）");
        try { s.connect(timeout); } catch (Exception e) {
            if (changed[0] != null) throw new Exception(changed[0]);
            throw e;
        }
        ChannelSftp ch = (ChannelSftp) s.openChannel("sftp");
        ch.connect(timeout);
        try { ch.setFilenameEncoding("UTF-8"); } catch (Exception ignored) { }
        session = s;
        sftp = ch;
        String home;
        try { home = Util.norm(ch.pwd()); } catch (Exception e) { home = "/"; }
        log.log("登入成功，起始資料夾 " + home);
        return home;
    }

    synchronized ChannelSftp ch() throws Exception {
        if (!connected()) connect();
        return sftp;
    }

    static String typeOf(SftpATTRS a) { return a.isDir() ? "dir" : a.isLink() ? "link" : "file"; }

    @Override public JSONArray list(String dir) throws Exception {
        String d = Util.norm(dir);
        ChannelSftp c = ch();
        Vector<?> v;
        synchronized (this) { v = c.ls(d); }
        JSONArray out = new JSONArray();
        for (Object o : v) {
            ChannelSftp.LsEntry e = (ChannelSftp.LsEntry) o;
            String n = e.getFilename();
            if (n.equals(".") || n.equals("..")) continue;
            SftpATTRS a = e.getAttrs();
            String[] parts = e.getLongname() == null ? new String[0] : e.getLongname().trim().split("\\s+");
            String owner = parts.length > 4 ? parts[2] + " " + parts[3] : "";
            JSONObject it = Util.item(n, typeOf(a), a.getSize(), a.getMTime() * 1000L, Util.perm(a.getPermissions()), owner, "");
            if (a.isLink()) {
                try {
                    SftpATTRS t;
                    synchronized (this) { t = c.stat(Util.join(d, n)); }
                    it.put("linkDir", t.isDir());
                    if (!t.isDir()) it.put("size", t.getSize());
                } catch (Exception ignored) { }
            }
            out.put(it);
        }
        return out;
    }

    @Override public JSONObject stat(String path) throws Exception {
        ChannelSftp c = ch();
        try {
            SftpATTRS a;
            synchronized (this) { a = c.stat(Util.norm(path)); }
            return Util.item(Util.base(path), typeOf(a), a.getSize(), a.getMTime() * 1000L, Util.perm(a.getPermissions()), "", "");
        } catch (SftpException e) {
            if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) return null;
            throw e;
        }
    }

    @Override public synchronized void mkdir(String p) throws Exception { ch().mkdir(Util.norm(p)); }
    @Override public synchronized void remove(String p) throws Exception { ch().rm(Util.norm(p)); }
    @Override public synchronized void rmdir(String p) throws Exception { ch().rmdir(Util.norm(p)); }
    @Override public synchronized void rename(String a, String b) throws Exception { ch().rename(Util.norm(a), Util.norm(b)); }
    @Override public synchronized void chmod(String p, int mode) throws Exception { ch().chmod(mode & 0777, Util.norm(p)); }

    @Override public void download(String remote, OutputStream out, long startAt) throws Exception {
        ChannelSftp c = ch();
        // RESUME 模式從 skip 的位置開始讀
        c.get(Util.norm(remote), out, null, startAt > 0 ? ChannelSftp.RESUME : ChannelSftp.OVERWRITE, Math.max(0, startAt));
    }

    @Override public void upload(InputStream in, String remote, boolean append, long size) throws Exception {
        ChannelSftp c = ch();
        c.put(in, Util.norm(remote), append ? ChannelSftp.APPEND : ChannelSftp.OVERWRITE);
    }

    @Override public boolean canAppend() { return true; }
    @Override public boolean connected() { return sftp != null && sftp.isConnected() && session != null && session.isConnected(); }

    @Override public void abort() { close(); }

    @Override public void close() {
        ChannelSftp c = sftp; Session s = session;
        sftp = null; session = null;
        try { if (c != null) c.disconnect(); } catch (Exception ignored) { }
        try { if (s != null) s.disconnect(); } catch (Exception ignored) { }
    }
}
