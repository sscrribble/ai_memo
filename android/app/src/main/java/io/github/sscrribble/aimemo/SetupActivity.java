package io.github.sscrribble.aimemo;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** 서버 주소 입력 화면. 처음 실행할 때와 '서버 주소 바꾸기'에서 열린다. */
public class SetupActivity extends Activity {
    private EditText input;
    private TextView error;
    private Button connect;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        int pad = Ui.dp(this, 24);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(pad, Ui.dp(this, 48), pad, pad);

        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher);
        box.addView(logo, new LinearLayout.LayoutParams(Ui.dp(this, 64), Ui.dp(this, 64)));

        TextView title = text("AI 메모", 26, R.color.text);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setPadding(0, Ui.dp(this, 16), 0, Ui.dp(this, 8));
        box.addView(title);

        box.addView(text("서버 주소를 입력하세요.\n서버 휴대폰에서 서버를 시작하면 나오는 주소입니다.", 15, R.color.muted));

        input = new EditText(this);
        input.setHint("예) http://192.168.0.23:8000");
        input.setText(Prefs.server(this));
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setImeOptions(EditorInfo.IME_ACTION_GO);
        input.setTextColor(getColor(R.color.text));
        input.setHintTextColor(getColor(R.color.muted));
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        GradientDrawable field = new GradientDrawable();
        field.setColor(getColor(R.color.surface));
        field.setCornerRadius(Ui.dp(this, 12));
        input.setBackground(field);
        input.setPadding(Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14), Ui.dp(this, 14));
        input.setOnEditorActionListener((v, actionId, event) -> {
            tryConnect();
            return true;
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Ui.dp(this, 20);
        box.addView(input, lp);

        error = text("", 14, R.color.danger);
        error.setPadding(0, Ui.dp(this, 10), 0, 0);
        box.addView(error);

        connect = new Button(this);
        connect.setText("연결");
        connect.setAllCaps(false);
        connect.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        connect.setTextColor(getColor(R.color.bg));
        GradientDrawable btn = new GradientDrawable();
        btn.setColor(getColor(R.color.accent));
        btn.setCornerRadius(Ui.dp(this, 12));
        connect.setBackground(btn);
        connect.setOnClickListener(v -> tryConnect());
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, Ui.dp(this, 52));
        bp.topMargin = Ui.dp(this, 16);
        box.addView(connect, bp);

        TextView help = text("같은 Wi-Fi 에서는 http://192.168.… 주소를, 밖에서도 쓰려면 Tailscale 주소(100.…)나 "
                + "Cloudflare 터널 주소(https://…)를 넣으세요.", 13, R.color.muted);
        help.setPadding(0, Ui.dp(this, 20), 0, 0);
        box.addView(help);

        ScrollView root = new ScrollView(this);
        root.setFillViewport(true);
        root.addView(box);
        setContentView(root);
        Ui.edgeToEdge(this, root);
        Ui.theme(this, root, true);
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(getColor(color));
        t.setGravity(Gravity.START);
        t.setLineSpacing(0, 1.25f);
        return t;
    }

    private void tryConnect() {
        String url = Urls.normalize(input.getText().toString());
        if (url.isEmpty()) {
            error.setText("주소를 확인해 주세요. 예) http://192.168.0.23:8000");
            return;
        }
        connect.setEnabled(false);
        connect.setText("연결하는 중…");
        error.setText("");
        new Thread(() -> {
            String problem = check(url);
            runOnUiThread(() -> {
                connect.setEnabled(true);
                connect.setText("연결");
                if (problem != null) {
                    error.setText(problem);
                    return;
                }
                Prefs.setServer(this, url);
                startActivity(new Intent(this, MainActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
                finish();
            });
        }).start();
    }

    /** 서버에 닿는지, AI 메모 서버가 맞는지 확인한다. 괜찮으면 null. */
    private static String check(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url + "/api/config").openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            int code = c.getResponseCode();
            if (code != 200) return "응답은 왔지만 AI 메모 서버가 아닌 것 같습니다 (" + code + ")";
            JSONObject j = new JSONObject(new String(ShellCache.readAll(c.getInputStream()), StandardCharsets.UTF_8));
            return j.has("categories") ? null : "AI 메모 서버가 아닌 것 같습니다";
        } catch (Exception e) {
            return "연결할 수 없습니다. 서버가 켜져 있는지, 주소와 Wi-Fi 가 맞는지 확인해 주세요.";
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
