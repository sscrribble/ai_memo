package io.github.sscrribble.aimemo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * 서버에서 일정 알림을 받아 오는 부분. 안드로이드 없이 시험할 수 있게 순수 자바로 둔다.
 * - /api/events 에 연결해 'reminder' 이벤트를 받는다.
 * - 연결될 때마다 /api/reminders 로 끊겼던 동안 보낸 알림을 받아 온다 (최근 12시간).
 * - 같은 알림(key)은 한 번만 넘긴다.
 */
final class ReminderStream {
    interface Store {
        String token();

        String lastSeen();

        void setLastSeen(String value);

        /** 처음 보는 key 면 기록하고 true. */
        boolean markSeen(String key);
    }

    interface Sink {
        void show(String title, String body, String tag);
    }

    /** 비밀번호가 바뀌어 다시 로그인해야 한다. */
    static final class Unauthorized extends IOException {}

    /** 한동안(1분 넘게) 잘 연결되어 있다가 끊겼다. 바로 다시 연결해도 된다. */
    static final class Connected extends IOException {}

    private final String server;
    private final Store store;
    private final Sink sink;
    private volatile HttpURLConnection conn;

    ReminderStream(String server, Store store, Sink sink) {
        this.server = server;
        this.store = store;
        this.sink = sink;
    }

    void disconnect() {
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
    }

    private String withToken(String url) throws IOException {
        String token = store.token();
        if (token == null || token.isEmpty()) return url;
        return url + (url.contains("?") ? "&" : "?") + "token=" + URLEncoder.encode(token, "UTF-8");
    }

    /** 연결해서 끊길 때까지 알림을 받는다. 항상 예외로 끝난다. */
    void listen() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(withToken(server + "/api/events")).openConnection();
        conn = c;
        long started = System.currentTimeMillis();
        try {
            c.setConnectTimeout(15000);
            c.setReadTimeout(75000); // 서버가 20초마다 신호를 보낸다
            c.setRequestProperty("Accept", "text/event-stream");
            int code = c.getResponseCode();
            if (code == 401) throw new Unauthorized();
            if (code != 200) throw new IOException("HTTP " + code);
            BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            SseReader.read(in, (event, data) -> {
                if ("hello".equals(event)) {
                    String now = new JSONObject(data.isEmpty() ? "{}" : data).optString("now");
                    if (store.lastSeen().isEmpty() && !now.isEmpty()) store.setLastSeen(now); // 처음엔 지금부터
                    catchUp();
                } else if ("reminder".equals(event)) {
                    handle(new JSONObject(data));
                }
            });
        } catch (Unauthorized e) {
            throw e;
        } catch (IOException e) {
            if (System.currentTimeMillis() - started > 60000) throw new Connected();
            throw e;
        } finally {
            c.disconnect();
            conn = null;
        }
    }

    /** 끊겼던 동안 보낸 알림을 받아 넘긴다. */
    void catchUp() {
        String last = store.lastSeen();
        if (last.isEmpty()) return;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(withToken(server + "/api/reminders?since=" + URLEncoder.encode(last, "UTF-8")))
                    .openConnection();
            c.setConnectTimeout(10000);
            c.setReadTimeout(15000);
            if (c.getResponseCode() != 200) return;
            JSONArray list = new JSONArray(new String(ShellCache.readAll(c.getInputStream()), StandardCharsets.UTF_8));
            for (int i = 0; i < list.length(); i++) handle(list.getJSONObject(i));
        } catch (Exception ignored) {
            // 다음에 연결될 때 다시
        } finally {
            if (c != null) c.disconnect();
        }
    }

    void handle(JSONObject r) {
        String key = r.optString("key");
        if (!key.isEmpty() && !store.markSeen(key)) return; // 이미 넘긴 알림
        sink.show(r.optString("title", "AI 메모"), r.optString("body"), r.optString("tag"));
        String sentAt = r.optString("sent_at");
        if (!sentAt.isEmpty() && sentAt.compareTo(store.lastSeen()) > 0) store.setLastSeen(sentAt);
    }
}
