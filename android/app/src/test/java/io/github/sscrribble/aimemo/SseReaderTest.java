package io.github.sscrribble.aimemo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;

import org.junit.Test;

public class SseReaderTest {
    private static List<String> parse(String stream) throws Exception {
        List<String> out = new ArrayList<>();
        try {
            SseReader.read(new BufferedReader(new StringReader(stream)), (event, data) -> out.add(event + "|" + data));
        } catch (IOException end) {
            out.add("END");
        }
        return out;
    }

    @Test
    public void readsServerEvents() throws Exception {
        String stream = "event: hello\ndata: {\"now\": \"2026-11-20T09:00:00+09:00\"}\n\n"
                + ": ping\n\n"
                + "event: reminder\ndata: {\"title\": \"30분 뒤 · 치과\", \"key\": \"item:1\"}\n\n"
                + "event: note\ndata: {\"id\": 3}\n\n";
        assertEquals(List.of(
                "hello|{\"now\": \"2026-11-20T09:00:00+09:00\"}",
                "reminder|{\"title\": \"30분 뒤 · 치과\", \"key\": \"item:1\"}",
                "note|{\"id\": 3}",
                "END"), parse(stream));
    }

    @Test
    public void joinsMultilineDataAndHandlesCrLfFreeEdgeCases() throws Exception {
        List<String> out = parse("data: a\ndata: b\n\nevent: x\ndata:no-space\n\ndata\n\n");
        assertEquals("message|a\nb", out.get(0));
        assertEquals("x|no-space", out.get(1));
        assertEquals("message|", out.get(2));
    }

    @Test
    public void incompleteEventAtEndIsNotDelivered() throws Exception {
        List<String> out = parse("event: reminder\ndata: {\"title\": \"반쯤\"}");
        assertEquals(List.of("END"), out);
        assertTrue(out.size() == 1);
    }
}
