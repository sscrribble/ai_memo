package io.github.sscrribble.aimemo;

import java.io.BufferedReader;
import java.io.IOException;

/** 서버가 보내는 실시간 알림(Server-Sent Events)을 한 건씩 읽는다. 순수 자바. */
final class SseReader {
    interface Listener {
        void onEvent(String event, String data) throws Exception;
    }

    private SseReader() {}

    /** 연결이 끝날 때까지 읽으며 이벤트마다 listener 를 부른다. */
    static void read(BufferedReader in, Listener listener) throws Exception {
        String event = "message";
        StringBuilder data = new StringBuilder();
        boolean hasData = false;
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isEmpty()) { // 빈 줄 = 이벤트 하나 끝
                if (hasData) listener.onEvent(event, data.toString());
                event = "message";
                data.setLength(0);
                hasData = false;
                continue;
            }
            if (line.startsWith(":")) continue; // 연결 유지용 주석 (ping)
            int colon = line.indexOf(':');
            String field = colon < 0 ? line : line.substring(0, colon);
            String value = colon < 0 ? "" : line.substring(colon + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            if ("event".equals(field)) {
                event = value;
            } else if ("data".equals(field)) {
                if (hasData) data.append('\n');
                data.append(value);
                hasData = true;
            }
        }
        throw new IOException("연결이 끊겼습니다");
    }
}
