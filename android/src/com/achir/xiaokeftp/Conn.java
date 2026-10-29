package com.achir.xiaokeftp;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;

/** 遠端連線的共同介面（FTP／FTPS、SFTP、WebDAV），和桌面版 src/main/drivers 相同的動作 */
interface Conn {
    /** 連線並登入，回傳起始資料夾 */
    String connect() throws Exception;
    /** 列出資料夾：[{ name, type:'dir'|'file'|'link', size, mtime, perm, owner, target, linkDir }] */
    JSONArray list(String dir) throws Exception;
    /** 不存在時回傳 null */
    JSONObject stat(String path) throws Exception;
    void mkdir(String path) throws Exception;
    void remove(String path) throws Exception;
    void rmdir(String path) throws Exception;
    void rename(String from, String to) throws Exception;
    void chmod(String path, int mode) throws Exception;
    /** 下載到串流；startAt > 0 時從中間續傳 */
    void download(String remote, OutputStream out, long startAt) throws Exception;
    /** 上傳串流；append 時接在遠端檔案後面 */
    void upload(InputStream in, String remote, boolean append, long size) throws Exception;
    boolean canAppend();
    /** 傳輸中途取消：直接關掉連線 */
    void abort();
    void close();
    boolean connected();
}
