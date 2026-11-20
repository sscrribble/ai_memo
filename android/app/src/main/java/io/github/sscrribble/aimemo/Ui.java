package io.github.sscrribble.aimemo;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** 화면 모양(상·하단 막대, 색)과 파일 저장 도우미. */
final class Ui {
    static final int DARK_BG = 0xFF0D0D10;
    static final int LIGHT_BG = 0xFFF7F7F9;

    private Ui() {}

    static int dp(Context c, float v) {
        return Math.round(v * c.getResources().getDisplayMetrics().density);
    }

    /** 화면을 상·하단 막대 뒤까지 쓰고, 막대·키보드만큼 안쪽 여백을 준다 (안드로이드 버전마다 같게). */
    @SuppressWarnings("deprecation")
    static void edgeToEdge(Activity a, View root) {
        Window w = a.getWindow();
        w.setStatusBarColor(Color.TRANSPARENT);
        w.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                        insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        root.requestApplyInsets();
    }

    /** 밝은/어두운 화면에 맞춰 배경색과 상·하단 막대 글자색을 바꾼다. */
    @SuppressWarnings("deprecation")
    static void theme(Activity a, View root, boolean dark) {
        root.setBackgroundColor(dark ? DARK_BG : LIGHT_BG);
        Window w = a.getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(dark ? 0 : mask, mask);
            }
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (!dark) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            w.getDecorView().setSystemUiVisibility(flags);
        }
    }

    /** 내보낸 파일을 휴대폰 '다운로드' 폴더에 저장하고, 결과를 알리는 문장을 돌려준다. */
    static String saveToDownloads(Context c, String name, String text) {
        String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        byte[] data = text.getBytes(StandardCharsets.UTF_8);
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver r = c.getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, safe);
                v.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                v.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new IOException("파일을 만들 수 없습니다");
                try (OutputStream out = r.openOutputStream(uri)) {
                    if (out == null) throw new IOException("파일을 열 수 없습니다");
                    out.write(data);
                }
                v.clear();
                v.put(MediaStore.Downloads.IS_PENDING, 0);
                r.update(uri, v, null, null);
                return "다운로드 폴더에 저장했습니다: " + safe;
            }
            File f = new File(c.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), safe);
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(data);
            }
            return "저장했습니다: " + f.getAbsolutePath();
        } catch (Exception e) {
            return "저장하지 못했습니다: " + e.getMessage();
        }
    }
}
