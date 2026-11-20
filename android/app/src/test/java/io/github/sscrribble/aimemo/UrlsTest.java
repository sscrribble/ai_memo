package io.github.sscrribble.aimemo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UrlsTest {
    @Test
    public void normalizeAddsSchemeAndDropsSlash() {
        assertEquals("http://192.168.0.23:8000", Urls.normalize("192.168.0.23:8000/"));
        assertEquals("http://192.168.0.23:8000", Urls.normalize("  http://192.168.0.23:8000//  "));
        assertEquals("https://memo.example.com", Urls.normalize("HTTPS://memo.example.com"));
        assertEquals("http://100.101.102.103:8000", Urls.normalize("100.101.102.103:8000"));
        assertEquals("http://localhost:8000/memo", Urls.normalize("localhost:8000/memo/"));
    }

    @Test
    public void normalizeRejectsJunk() {
        assertEquals("", Urls.normalize(""));
        assertEquals("", Urls.normalize("   "));
        assertEquals("", Urls.normalize("http://"));
        assertEquals("", Urls.normalize("http://exa mple.com"));
        assertEquals("", Urls.normalize(null));
    }

    @Test
    public void sameOrigin() {
        assertTrue(Urls.sameOrigin("http://192.168.0.23:8000", "http://192.168.0.23:8000/app.js"));
        assertTrue(Urls.sameOrigin("https://memo.example.com", "https://MEMO.example.com:443/api/notes"));
        assertTrue(Urls.sameOrigin("http://a.com", "http://a.com:80/"));
        assertFalse(Urls.sameOrigin("http://192.168.0.23:8000", "http://192.168.0.23:9000/"));
        assertFalse(Urls.sameOrigin("http://192.168.0.23:8000", "https://192.168.0.23:8000/"));
        assertFalse(Urls.sameOrigin("http://192.168.0.23:8000", "https://example.com/a?id=1"));
        assertFalse(Urls.sameOrigin("", ""));
    }
}
