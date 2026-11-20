package io.github.sscrribble.aimemo;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** 앱 설정: 서버 주소, 로그인 토큰, 마지막으로 받은 알림. */
final class Prefs {
    private static final int SEEN_MAX = 60;

    private Prefs() {}

    private static SharedPreferences sp(Context c) {
        return c.getSharedPreferences("aimemo", Context.MODE_PRIVATE);
    }

    static String server(Context c) {
        return sp(c).getString("server", "");
    }

    static void setServer(Context c, String url) {
        if (!url.equals(server(c))) clearSession(c); // 다른 서버면 로그인·알림 기록을 새로
        sp(c).edit().putString("server", url).apply();
    }

    static boolean hasSession(Context c) {
        return sp(c).getBoolean("session", false);
    }

    static String token(Context c) {
        return sp(c).getString("token", "");
    }

    static void setSession(Context c, String token) {
        sp(c).edit().putBoolean("session", true).putString("token", token == null ? "" : token).apply();
    }

    static void clearSession(Context c) {
        sp(c).edit().remove("session").remove("token").remove("last_seen").remove("seen").apply();
    }

    /** 마지막으로 받은 알림을 보낸 시각 (서버 시각, ISO 형식). */
    static String lastSeen(Context c) {
        return sp(c).getString("last_seen", "");
    }

    static void setLastSeen(Context c, String value) {
        sp(c).edit().putString("last_seen", value).apply();
    }

    /** 처음 보는 알림이면 기록하고 true. 같은 알림을 두 번 띄우지 않기 위해 쓴다. */
    static synchronized boolean markSeen(Context c, String key) {
        List<String> seen = new ArrayList<>(Arrays.asList(sp(c).getString("seen", "").split("\n")));
        if (seen.contains(key)) return false;
        seen.add(key);
        while (seen.size() > SEEN_MAX) seen.remove(0);
        sp(c).edit().putString("seen", String.join("\n", seen)).apply();
        return true;
    }

    static boolean flag(Context c, String name) {
        return sp(c).getBoolean(name, false);
    }

    static void setFlag(Context c, String name) {
        sp(c).edit().putBoolean(name, true).apply();
    }

    static boolean darkTheme(Context c) {
        return sp(c).getBoolean("dark", true);
    }

    static void setDarkTheme(Context c, boolean dark) {
        sp(c).edit().putBoolean("dark", dark).apply();
    }
}
