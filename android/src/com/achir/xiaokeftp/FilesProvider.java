package com.achir.xiaokeftp;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.Locale;

/**
 * 讓其他 App 讀取手機上的檔案（用預設程式開啟、分享）：content://com.achir.xiaokeftp.files/路徑
 * 只能唯讀，而且必須經由本 App 發出的 Intent 暫時授權（exported=false + grantUriPermissions）。
 */
public final class FilesProvider extends ContentProvider {
    static final String AUTH = "com.achir.xiaokeftp.files";

    static Uri uriFor(Context c, File f) { return new Uri.Builder().scheme("content").authority(AUTH).path(f.getAbsolutePath()).build(); }

    File file(Uri u) throws FileNotFoundException {
        File f = new File(u.getPath());
        if (!f.isFile()) throw new FileNotFoundException(u.getPath());
        return f;
    }

    @Override public boolean onCreate() { return true; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(file(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public String getType(Uri uri) {
        String n = new File(uri.getPath()).getName();
        String ext = n.contains(".") ? n.substring(n.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        return m == null ? "application/octet-stream" : m;
    }

    @Override public Cursor query(Uri uri, String[] proj, String sel, String[] args, String sort) {
        File f = new File(uri.getPath());
        MatrixCursor c = new MatrixCursor(new String[]{ OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
        c.addRow(new Object[]{ f.getName(), f.length() });
        return c;
    }

    @Override public Uri insert(Uri uri, ContentValues v) { return null; }
    @Override public int delete(Uri uri, String s, String[] a) { return 0; }
    @Override public int update(Uri uri, ContentValues v, String s, String[] a) { return 0; }
}
