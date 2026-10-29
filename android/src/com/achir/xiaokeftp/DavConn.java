package com.achir.xiaokeftp;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * WebDAV／WebDAVS。Android 的 HttpURLConnection 不允許 PROPFIND、MKCOL、MOVE 這些方法，
 * 所以這裡直接用 Socket 送 HTTP/1.1（每個請求一條連線，簡單可靠）。
 */
final class DavConn implements Conn {
    final JSONObject site;
    final Net.Log log;
    final boolean secure;
    final int port;
    final String base;
    volatile Socket current;
    boolean ok;

    DavConn(JSONObject site, Net.Log log) {
        this.site = site; this.log = log;
        secure = site.optString("protocol").equals("webdavs");
        port = site.optInt("port", secure ? 443 : 80);
        base = Util.norm(site.optString("davRoot", "/"));
    }

    static final class Resp {
        int status; String reason; Map<String, String> headers = new HashMap<>(); InputStream body; Socket sock;
        String text() throws IOException {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[16384]; int n;
            while ((n = body.read(b)) > 0) bo.write(b, 0, n);
            close();
            return new String(bo.toByteArray(), "UTF-8");
        }
        void close() { try { sock.close(); } catch (Exception ignored) { } }
    }

    String url(String p) {
        String full = base.equals("/") ? Util.norm(p) : Util.norm(base + "/" + p);
        StringBuilder b = new StringBuilder();
        for (String s : full.split("/")) {
            if (s.isEmpty()) continue;
            try { b.append('/').append(URLEncoder.encode(s, "UTF-8").replace("+", "%20")); } catch (Exception e) { b.append('/').append(s); }
        }
        return b.length() == 0 ? "/" : b.toString();
    }

    Socket open() throws Exception {
        int timeout = Math.max(5, site.optInt("timeout", 20)) * 1000;
        String host = site.optString("host");
        Socket s;
        if (secure) {
            SSLSocketFactory f;
            if (site.optBoolean("ignoreCert")) {
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, new TrustManager[]{ new X509TrustManager() {
                    public void checkClientTrusted(X509Certificate[] c, String a) { }
                    public void checkServerTrusted(X509Certificate[] c, String a) { }
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                } }, new SecureRandom());
                f = ctx.getSocketFactory();
            } else f = (SSLSocketFactory) SSLSocketFactory.getDefault();
            Socket raw = new Socket();
            raw.connect(new InetSocketAddress(host, port), timeout);
            SSLSocket ss = (SSLSocket) f.createSocket(raw, host, port, true);
            ss.startHandshake();
            if (!site.optBoolean("ignoreCert") && !HttpsURLConnection.getDefaultHostnameVerifier().verify(host, ss.getSession())) { ss.close(); throw new IOException("Certificate 主機名稱不符"); }
            s = ss;
        } else {
            s = new Socket();
            s.connect(new InetSocketAddress(host, port), timeout);
        }
        s.setSoTimeout(timeout);
        return s;
    }

    /** 送出請求；body 可以是 byte[]（小）或 InputStream（上傳，需給 length） */
    Resp request(String method, String path, Map<String, String> headers, Object body, long length) throws Exception {
        Socket s = open();
        current = s;
        String host = site.optString("host");
        StringBuilder h = new StringBuilder();
        h.append(method).append(' ').append(url(path)).append(path.endsWith("/") && !url(path).endsWith("/") ? "/" : "").append(" HTTP/1.1\r\n");
        h.append("Host: ").append(host).append((secure && port == 443) || (!secure && port == 80) ? "" : ":" + port).append("\r\n");
        h.append("User-Agent: XiaokeFTP-Android\r\nConnection: close\r\n");
        String user = site.optString("user", "");
        if (!user.isEmpty()) h.append("Authorization: Basic ").append(Base64.encodeToString((user + ":" + site.optString("password", "")).getBytes("UTF-8"), Base64.NO_WRAP)).append("\r\n");
        if (headers != null) for (Map.Entry<String, String> e : headers.entrySet()) h.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        long len = body instanceof byte[] ? ((byte[]) body).length : body == null ? 0 : length;
        if (body != null || method.equals("PUT")) h.append("Content-Length: ").append(len).append("\r\n");
        h.append("\r\n");
        OutputStream out = s.getOutputStream();
        out.write(h.toString().getBytes("UTF-8"));
        if (body instanceof byte[]) out.write((byte[]) body);
        else if (body instanceof InputStream) {
            byte[] b = new byte[65536]; int n;
            InputStream in = (InputStream) body;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
        }
        out.flush();
        InputStream in = new BufferedInputStream(s.getInputStream(), 65536);
        Resp r = new Resp();
        r.sock = s;
        String status = readLine(in);
        if (status == null) throw new IOException("連線中斷了");
        String[] sp = status.split(" ", 3);
        r.status = Integer.parseInt(sp[1]);
        r.reason = sp.length > 2 ? sp[2] : "";
        for (String line; (line = readLine(in)) != null && !line.isEmpty(); ) {
            int i = line.indexOf(':');
            if (i > 0) r.headers.put(line.substring(0, i).trim().toLowerCase(Locale.ROOT), line.substring(i + 1).trim());
        }
        if ("chunked".equalsIgnoreCase(r.headers.get("transfer-encoding"))) r.body = new Chunked(in);
        else if (r.headers.containsKey("content-length")) r.body = new Limited(in, Long.parseLong(r.headers.get("content-length")));
        else r.body = in;
        return r;
    }

    Resp expect(Resp r, int... codes) throws Exception {
        for (int c : codes) if (r.status == c) return r;
        r.close();
        throw new IOException(r.status + " " + r.reason);
    }

    static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) >= 0) { if (c == '\n') break; if (c != '\r') b.write(c); }
        if (c < 0 && b.size() == 0) return null;
        return new String(b.toByteArray(), "UTF-8");
    }

    static final class Limited extends InputStream {
        final InputStream in; long left;
        Limited(InputStream in, long n) { this.in = in; left = n; }
        public int read() throws IOException { if (left <= 0) return -1; int c = in.read(); if (c >= 0) left--; return c; }
        public int read(byte[] b, int o, int l) throws IOException { if (left <= 0) return -1; int n = in.read(b, o, (int) Math.min(l, left)); if (n > 0) left -= n; return n; }
    }

    static final class Chunked extends InputStream {
        final InputStream in; long left = 0; boolean eof;
        Chunked(InputStream in) { this.in = in; }
        boolean next() throws IOException {
            if (eof) return false;
            if (left > 0) return true;
            String line = readLine(in);
            if (line != null && line.isEmpty()) line = readLine(in);
            if (line == null) { eof = true; return false; }
            int semi = line.indexOf(';');
            left = Long.parseLong((semi >= 0 ? line.substring(0, semi) : line).trim(), 16);
            if (left == 0) { eof = true; return false; }
            return true;
        }
        public int read() throws IOException { byte[] b = new byte[1]; int n = read(b, 0, 1); return n < 0 ? -1 : b[0] & 0xff; }
        public int read(byte[] b, int o, int l) throws IOException {
            if (!next()) return -1;
            int n = in.read(b, o, (int) Math.min(l, left));
            if (n > 0) left -= n;
            return n;
        }
    }

    static final Pattern RESP = Pattern.compile("<(?:[\\w-]+:)?response(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?response>", Pattern.CASE_INSENSITIVE);
    static String tag(String x, String name) {
        Matcher m = Pattern.compile("<(?:[\\w-]+:)?" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?" + name + ">", Pattern.CASE_INSENSITIVE).matcher(x);
        return m.find() ? m.group(1) : null;
    }
    static String unxml(String s) {
        return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
    }

    JSONArray propfind(String p, int depth) throws Exception {
        byte[] body = "<?xml version=\"1.0\" encoding=\"utf-8\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>".getBytes("UTF-8");
        Map<String, String> h = new HashMap<>();
        h.put("Depth", String.valueOf(depth));
        h.put("Content-Type", "application/xml; charset=utf-8");
        String xml = expect(request("PROPFIND", p, h, body, 0), 207, 200).text();
        JSONArray out = new JSONArray();
        Matcher m = RESP.matcher(xml);
        SimpleDateFormat df = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US);
        while (m.find()) {
            String x = m.group(1);
            String href = unxml(tag(x, "href") == null ? "" : tag(x, "href"));
            try { href = new java.net.URI(href.startsWith("http") ? href : "http://h" + (href.startsWith("/") ? "" : "/") + href.replace(" ", "%20")).getRawPath(); } catch (Exception ignored) { }
            href = URLDecoder.decode(href.replace("+", "%2B"), "UTF-8");
            String rel = Util.norm(href);
            if (!base.equals("/") && (rel.equals(base) || rel.startsWith(base + "/"))) rel = Util.norm(rel.substring(base.length()));
            String rt = tag(x, "resourcetype");
            boolean dir = rt != null && Pattern.compile("<(?:[\\w-]+:)?collection\\b", Pattern.CASE_INSENSITIVE).matcher(rt).find();
            long size = 0, mt = 0;
            try { size = Long.parseLong(tag(x, "getcontentlength").trim()); } catch (Exception ignored) { }
            try { mt = df.parse(tag(x, "getlastmodified").trim()).getTime(); } catch (Exception ignored) { }
            JSONObject it = Util.item(Util.base(rel), dir ? "dir" : "file", size, mt, "", "", "");
            it.put("path", rel);
            out.put(it);
        }
        return out;
    }

    @Override public String connect() throws Exception {
        propfind("/", 0);
        ok = true;
        log.log("連線成功（" + site.optString("protocol").toUpperCase() + " " + site.optString("host") + ":" + port + base + "）");
        return "/";
    }

    @Override public JSONArray list(String dir) throws Exception {
        String d = Util.norm(dir);
        JSONArray all = propfind(d, 1), out = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject o = all.getJSONObject(i);
            if (o.optString("path").equals(d)) continue;
            o.remove("path");
            out.put(o);
        }
        return out;
    }

    @Override public JSONObject stat(String path) throws Exception {
        try {
            JSONArray a = propfind(Util.norm(path), 0);
            if (a.length() == 0) return null;
            JSONObject o = a.getJSONObject(0);
            o.remove("path");
            o.put("name", Util.base(path));
            return o;
        } catch (IOException e) {
            if (String.valueOf(e.getMessage()).startsWith("404")) return null;
            throw e;
        }
    }

    @Override public void mkdir(String p) throws Exception { expect(request("MKCOL", Util.norm(p) + "/", null, null, 0), 200, 201).close(); }
    @Override public void remove(String p) throws Exception { expect(request("DELETE", Util.norm(p), null, null, 0), 200, 204).close(); }
    @Override public void rmdir(String p) throws Exception { expect(request("DELETE", Util.norm(p) + "/", null, null, 0), 200, 204).close(); }
    @Override public void rename(String a, String b) throws Exception {
        Map<String, String> h = new HashMap<>();
        h.put("Destination", (secure ? "https://" : "http://") + site.optString("host") + ":" + port + url(b));
        h.put("Overwrite", "T");
        expect(request("MOVE", Util.norm(a), h, null, 0), 200, 201, 204).close();
    }
    @Override public void chmod(String p, int mode) throws Exception { throw new IOException("WebDAV 不支援修改權限"); }

    @Override public void download(String remote, OutputStream out, long startAt) throws Exception {
        Map<String, String> h = new HashMap<>();
        if (startAt > 0) h.put("Range", "bytes=" + startAt + "-");
        Resp r = expect(request("GET", Util.norm(remote), h, null, 0), 200, 206);
        if (startAt > 0 && r.status != 206) { r.close(); throw new IOException("伺服器不支援續傳"); }
        try {
            byte[] b = new byte[65536]; int n;
            while ((n = r.body.read(b)) > 0) out.write(b, 0, n);
        } finally { r.close(); }
    }

    @Override public void upload(InputStream in, String remote, boolean append, long size) throws Exception {
        if (append) throw new IOException("WebDAV 不支援接續上傳");
        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/octet-stream");
        expect(request("PUT", Util.norm(remote), h, in, size), 200, 201, 204).close();
    }

    @Override public boolean canAppend() { return false; }
    @Override public boolean connected() { return ok; }
    @Override public void abort() { Socket s = current; if (s != null) try { s.close(); } catch (Exception ignored) { } }
    @Override public void close() { abort(); ok = false; }
}
