package io.github.sscrribble.aimemo;

import java.net.URI;
import java.util.Locale;

/** 서버 주소 다루기. 안드로이드 없이 시험할 수 있게 순수 자바로 둔다. */
final class Urls {
    private Urls() {}

    /** 입력한 주소를 정리한다. "192.168.0.23:8000/" → "http://192.168.0.23:8000". 쓸 수 없으면 "". */
    static String normalize(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) return "";
        if (!s.toLowerCase(Locale.ROOT).matches("^https?://.*")) s = "http://" + s;
        try {
            URI u = new URI(s);
            String host = u.getHost();
            if (host == null || host.isEmpty()) return "";
            String path = u.getRawPath() == null ? "" : u.getRawPath();
            while (path.endsWith("/")) path = path.substring(0, path.length() - 1);
            return u.getScheme().toLowerCase(Locale.ROOT) + "://" + host
                    + (u.getPort() > 0 ? ":" + u.getPort() : "") + path;
        } catch (Exception e) {
            return "";
        }
    }

    /** scheme://host[:port] (기본 포트는 뺀다). 알 수 없으면 "". */
    static String origin(String url) {
        try {
            URI u = new URI(url);
            if (u.getScheme() == null || u.getHost() == null) return "";
            String scheme = u.getScheme().toLowerCase(Locale.ROOT);
            int port = u.getPort();
            if (("http".equals(scheme) && port == 80) || ("https".equals(scheme) && port == 443)) port = -1;
            return scheme + "://" + u.getHost().toLowerCase(Locale.ROOT) + (port > 0 ? ":" + port : "");
        } catch (Exception e) {
            return "";
        }
    }

    /** 같은 서버(scheme·host·port)의 주소인지. */
    static boolean sameOrigin(String a, String b) {
        String oa = origin(a);
        return !oa.isEmpty() && oa.equals(origin(b));
    }
}
