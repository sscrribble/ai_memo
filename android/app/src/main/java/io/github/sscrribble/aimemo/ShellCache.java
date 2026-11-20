package io.github.sscrribble.aimemo;

import android.content.Context;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 화면 파일(HTML·JS·CSS·아이콘)을 받을 때마다 저장해 두었다가, 서버에 닿지 않으면 저장한 것을 보여 준다.
 * 그래서 서버 휴대폰이 꺼져 있거나 밖에 있어도 앱이 열리고, 마지막으로 본 메모가 보인다.
 * (http:// 주소에서는 브라우저의 오프라인 기능(서비스 워커)이 동작하지 않아 앱이 대신 한다.)
 */
final class ShellCache {
    private ShellCache() {}

    static WebResourceResponse fetch(Context c, String server, String path) {
        File dir = new File(c.getCacheDir(), "shell");
        String name = "/".equals(path) ? "index.html" : path.replaceAll("[^A-Za-z0-9._-]", "_");
        File body = new File(dir, name);
        File type = new File(dir, name + ".type");
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(server + path).openConnection();
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(10000);
            conn.setUseCaches(false);
            int code = conn.getResponseCode();
            if (code == 200) {
                byte[] data = readAll(conn.getInputStream());
                String contentType = conn.getContentType();
                if (dir.isDirectory() || dir.mkdirs()) {
                    write(body, data);
                    write(type, (contentType == null ? "" : contentType).getBytes(StandardCharsets.UTF_8));
                }
                return response(contentType, data);
            }
            if (code >= 400 && code < 500) return null; // 없는 파일은 WebView 가 직접 처리
        } catch (IOException e) {
            // 연결 실패 → 아래에서 저장해 둔 파일로
        } finally {
            if (conn != null) conn.disconnect();
        }
        try {
            if (body.isFile()) {
                String contentType = type.isFile()
                        ? new String(readAll(new FileInputStream(type)), StandardCharsets.UTF_8) : null;
                return response(contentType, readAll(new FileInputStream(body)));
            }
        } catch (IOException ignored) {
            // 저장한 파일도 못 읽으면 WebView 가 직접 처리
        }
        return null;
    }

    private static WebResourceResponse response(String contentType, byte[] data) {
        String mime = "application/octet-stream";
        String charset = null;
        if (contentType != null && !contentType.isEmpty()) {
            String[] parts = contentType.split(";");
            mime = parts[0].trim();
            for (int i = 1; i < parts.length; i++) {
                String p = parts[i].trim();
                if (p.toLowerCase(Locale.ROOT).startsWith("charset=")) charset = p.substring(8).trim();
            }
        }
        if (charset == null && (mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json"))) {
            charset = "utf-8";
        }
        WebResourceResponse r = new WebResourceResponse(mime, charset, new ByteArrayInputStream(data));
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        r.setResponseHeaders(headers);
        return r;
    }

    static byte[] readAll(InputStream in) throws IOException {
        try (InputStream input = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = input.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static void write(File f, byte[] data) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
        }
        if (!tmp.renameTo(f)) throw new IOException("저장 실패: " + f);
    }
}
