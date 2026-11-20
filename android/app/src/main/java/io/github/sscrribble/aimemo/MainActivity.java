package io.github.sscrribble.aimemo;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** 서버의 메모 화면을 앱으로 보여 준다. 화면과 기능은 서버에서 오므로 서버를 업데이트하면 앱도 같이 바뀐다. */
public class MainActivity extends Activity {
    private static final int REQ_FILE = 1;
    private static final int REQ_NOTIFY = 2;

    private FrameLayout root;
    private WebView web;
    private View errorView;
    private String server;
    private ValueCallback<Uri[]> fileCallback;
    private boolean failed;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        server = Prefs.server(this);
        if (server.isEmpty()) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }
        Notifier.createChannels(this);

        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        Ui.edgeToEdge(this, root);
        applyTheme(Prefs.darkTheme(this));

        setupWebView();
        web.loadUrl(server + "/");
        askNotificationPermission();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // 로그인·오프라인 메모 저장
        s.setSupportMultipleWindows(false);
        s.setAllowFileAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " AIMemoApp/" + BuildConfig.VERSION_NAME);
        web.addJavascriptInterface(new Bridge(), "AIMemoApp");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) ReminderService.start(this); // 알림을 방금 켰다면 여기서 시작
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private void applyTheme(boolean dark) {
        Ui.theme(this, root, dark);
        web.setBackgroundColor(dark ? Ui.DARK_BG : Ui.LIGHT_BG);
    }

    // ---------------------------------------------------------------- 뒤로 가기: 열린 창·메뉴부터 닫는다

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web == null || errorView.getVisibility() == View.VISIBLE) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(window.AIMemoBack && window.AIMemoBack()) ? 'y' : 'n'", result -> {
            if ("\"y\"".equals(result)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    // ---------------------------------------------------------------- 연결 실패 화면

    private View buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        int pad = Ui.dp(this, 28);
        box.setPadding(pad, pad, pad, pad);
        box.setBackgroundColor(Ui.DARK_BG);

        TextView title = new TextView(this);
        title.setText("서버에 연결할 수 없습니다");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(getColor(R.color.text));
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView desc = new TextView(this);
        desc.setText("서버 휴대폰이 켜져 있는지, 같은 Wi-Fi(또는 Tailscale·터널)에 연결되어 있는지 확인해 주세요.\n\n" + server);
        desc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        desc.setTextColor(getColor(R.color.muted));
        desc.setGravity(Gravity.CENTER);
        desc.setLineSpacing(0, 1.25f);
        desc.setPadding(0, Ui.dp(this, 12), 0, Ui.dp(this, 20));
        box.addView(desc);

        Button retry = new Button(this);
        retry.setText("다시 시도");
        retry.setAllCaps(false);
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            web.loadUrl(server + "/");
        });
        box.addView(retry);

        Button change = new Button(this);
        change.setText("서버 주소 바꾸기");
        change.setAllCaps(false);
        change.setOnClickListener(v -> startActivity(new Intent(this, SetupActivity.class)));
        box.addView(change);
        return box;
    }

    // ---------------------------------------------------------------- 알림 권한·배터리

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && !Prefs.flag(this, "asked_notify")) {
            Prefs.setFlag(this, "asked_notify");
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_NOTIFY) ReminderService.start(this);
    }

    private boolean batteryOptimized() {
        PowerManager pm = getSystemService(PowerManager.class);
        return pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    @SuppressLint("BatteryLife") // 직접 설치하는 앱이고, 제때 알림을 받으려면 필요하다
    private void requestBatteryException() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    private void openNotificationSettings() {
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                && shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)) {
            requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFY);
            return;
        }
        startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName()));
    }

    // ---------------------------------------------------------------- 파일 고르기 (가져오기)

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        @SuppressWarnings("deprecation")
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            try {
                startActivityForResult(i, REQ_FILE);
                return true;
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
        }
    }

    // ---------------------------------------------------------------- 페이지 불러오기

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (Urls.sameOrigin(server, request.getUrl().toString())) return false;
            try { // 메모 속 다른 사이트 링크는 브라우저로
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
            } catch (Exception ignored) {
                // 열 앱이 없으면 무시
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (!"GET".equalsIgnoreCase(request.getMethod()) || !Urls.sameOrigin(server, u.toString())) return null;
            String path = u.getPath() == null || u.getPath().isEmpty() ? "/" : u.getPath();
            if (path.startsWith("/api/") || u.getQuery() != null) return null; // 데이터는 웹앱이 직접
            return ShellCache.fetch(MainActivity.this, server, path);
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            failed = false;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) {
                failed = true;
                errorView.setVisibility(View.VISIBLE);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (!failed) errorView.setVisibility(View.GONE);
        }
    }

    // ---------------------------------------------------------------- 웹앱과 주고받기 (window.AIMemoApp)

    private class Bridge {
        @JavascriptInterface
        public void setSession(String token) {
            Prefs.setSession(MainActivity.this, token);
            runOnUiThread(() -> {
                ReminderService.start(MainActivity.this);
                // 처음 한 번: 화면이 꺼져 있어도 알림이 제때 오도록 배터리 사용 제한 해제를 묻는다
                if (Notifier.enabled(MainActivity.this) && MainActivity.this.batteryOptimized()
                        && !Prefs.flag(MainActivity.this, "asked_battery")) {
                    Prefs.setFlag(MainActivity.this, "asked_battery");
                    MainActivity.this.requestBatteryException();
                }
            });
        }

        @JavascriptInterface
        public void clearSession() {
            Prefs.clearSession(MainActivity.this);
            runOnUiThread(() -> ReminderService.stop(MainActivity.this));
        }

        @JavascriptInterface
        public void setTheme(boolean dark) {
            Prefs.setDarkTheme(MainActivity.this, dark);
            runOnUiThread(() -> applyTheme(dark));
        }

        @JavascriptInterface
        public String notificationStatus() {
            return Notifier.enabled(MainActivity.this) ? "on" : "off";
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(MainActivity.this::openNotificationSettings);
        }

        @JavascriptInterface
        public boolean batteryOptimized() {
            return MainActivity.this.batteryOptimized();
        }

        @JavascriptInterface
        public void requestBatteryException() {
            runOnUiThread(MainActivity.this::requestBatteryException);
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> startActivity(new Intent(MainActivity.this, SetupActivity.class)));
        }

        @JavascriptInterface
        public String serverUrl() {
            return server;
        }

        @JavascriptInterface
        public String saveFile(String name, String text) {
            return Ui.saveToDownloads(MainActivity.this, name, text);
        }

        @JavascriptInterface
        public String appVersion() {
            return BuildConfig.VERSION_NAME;
        }
    }
}
