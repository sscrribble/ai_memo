package io.github.sscrribble.aimemo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 실제 서버(server/app.py)에 붙여 알림을 받는지 확인한다. 서버를 띄우고 주소를 알려 줄 때만 돈다:
 *   AIMEMO_TEST_SERVER=http://127.0.0.1:8000 AIMEMO_TEST_PASSWORD=비밀번호 ./gradlew testDebugUnitTest
 */
public class ReminderStreamServerTest {
    private static final String SERVER = System.getenv("AIMEMO_TEST_SERVER");
    private static final String PASSWORD = System.getenv("AIMEMO_TEST_PASSWORD");

    static final class MemoryStore implements ReminderStream.Store {
        volatile String token = "";
        volatile String lastSeen = "";
        final Set<String> seen = Collections.synchronizedSet(new HashSet<>());

        @Override public String token() { return token; }
        @Override public String lastSeen() { return lastSeen; }
        @Override public void setLastSeen(String value) { lastSeen = value; }
        @Override public boolean markSeen(String key) { return seen.add(key); }
    }

    private static String call(String method, String path, String token, String body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(SERVER + path).openConnection();
        c.setRequestMethod(method);
        c.setRequestProperty("Content-Type", "application/json");
        if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        if (body != null) {
            c.setDoOutput(true);
            try (OutputStream out = c.getOutputStream()) {
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
        }
        int code = c.getResponseCode();
        if (code >= 400) throw new AssertionError(method + " " + path + " → " + code);
        return new String(ShellCache.readAll(c.getInputStream()), StandardCharsets.UTF_8);
    }

    /** 20분 뒤 일정을 만든다 (날짜·시간을 글에 넣어 분류가 정하게) → '30분 전 알림'이 30초 안에 나간다. */
    private static void noteDueSoon(String token, String title) throws Exception {
        ZonedDateTime due = ZonedDateTime.now(ZoneId.of("Asia/Seoul")).plusMinutes(20);
        String content = title + " " + due.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"));
        call("POST", "/api/notes", token, new JSONObject().put("content", content).toString());
    }

    private static void waitFor(java.util.function.BooleanSupplier ok, int seconds) throws InterruptedException {
        for (int i = 0; i < seconds * 4 && !ok.getAsBoolean(); i++) Thread.sleep(250);
    }

    private static Thread run(ReminderStream s) {
        Thread t = new Thread(() -> {
            try {
                s.listen();
            } catch (Exception ignored) {
                // disconnect() 로 끝냄
            }
        });
        t.start();
        return t;
    }

    @Test
    public void receivesLiveAndMissedReminders() throws Exception {
        assumeTrue("AIMEMO_TEST_SERVER 가 없으면 건너뜀", SERVER != null && !SERVER.isEmpty());
        MemoryStore store = new MemoryStore();
        if (PASSWORD != null && !PASSWORD.isEmpty()) {
            store.token = new JSONObject(call("POST", "/api/login", null,
                    new JSONObject().put("password", PASSWORD).toString())).getString("token");
        }
        List<String> shown = Collections.synchronizedList(new ArrayList<>());
        ReminderStream.Sink sink = (title, body, tag) -> shown.add(title + " | " + body + " | " + tag);

        // 1) 연결된 동안 보낸 알림을 바로 받는다
        ReminderStream live = new ReminderStream(SERVER, store, sink);
        Thread t1 = run(live);
        waitFor(() -> !store.lastSeen.isEmpty(), 10); // hello 로 기준 시각을 받음
        assertTrue("서버 연결 인사(hello)를 받아야 함", !store.lastSeen.isEmpty());
        noteDueSoon(store.token, "앱 알림 시험 1");
        waitFor(() -> shown.size() >= 1, 45);
        live.disconnect();
        t1.join(5000);
        assertEquals(1, shown.size());
        assertTrue(shown.get(0), shown.get(0).contains("앱 알림 시험 1"));

        // 2) 끊겨 있는 동안 보낸 알림은 다시 연결될 때 받는다 (이미 받은 알림은 다시 안 띄움)
        noteDueSoon(store.token, "앱 알림 시험 2");
        waitFor(() -> {
            try {
                return new JSONArray(call("GET", "/api/reminders", store.token, null)).length() >= 2;
            } catch (Exception e) {
                return false;
            }
        }, 45);
        ReminderStream again = new ReminderStream(SERVER, store, sink);
        Thread t2 = run(again);
        waitFor(() -> shown.size() >= 2, 15);
        Thread.sleep(1500); // 중복이 오는지 잠깐 더 본다
        again.disconnect();
        t2.join(5000);
        assertEquals(shown.toString(), 2, shown.size());
        assertTrue(shown.get(1), shown.get(1).contains("앱 알림 시험 2"));
    }

    @Test(expected = ReminderStream.Unauthorized.class)
    public void wrongTokenIsUnauthorized() throws Exception {
        assumeTrue(SERVER != null && !SERVER.isEmpty() && PASSWORD != null && !PASSWORD.isEmpty());
        MemoryStore store = new MemoryStore();
        store.token = "wrong-token";
        new ReminderStream(SERVER, store, (a, b, c) -> { }).listen();
    }
}
