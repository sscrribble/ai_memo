package io.github.sscrribble.aimemo;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * 앱 화면을 닫아도 서버와 연결을 유지하면서 일정·마감 알림을 받아 띄운다 (실제 통신은 ReminderStream).
 * 연결이 끊기면 3초부터 최대 1분 간격으로 다시 연결한다.
 */
public class ReminderService extends Service {
    private volatile boolean running;
    private volatile ReminderStream stream;
    private Thread worker;

    /** 로그인되어 있고 알림이 켜져 있으면 시작한다. */
    static void start(Context c) {
        if (!Prefs.hasSession(c) || Prefs.server(c).isEmpty() || !Notifier.enabled(c)) return;
        try {
            c.startForegroundService(new Intent(c, ReminderService.class));
        } catch (RuntimeException e) {
            // 백그라운드에서는 시작이 막힐 수 있다. 다음에 앱을 열 때 다시 시작한다.
        }
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, ReminderService.class));
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(Notifier.SERVICE_ID, Notifier.service(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(Notifier.SERVICE_ID, Notifier.service(this));
        }
        if (worker == null || !worker.isAlive()) {
            running = true;
            worker = new Thread(this::loop, "reminders");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        ReminderStream s = stream;
        if (s != null) s.disconnect();
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private final ReminderStream.Store store = new ReminderStream.Store() {
        @Override
        public String token() {
            return Prefs.token(ReminderService.this);
        }

        @Override
        public String lastSeen() {
            return Prefs.lastSeen(ReminderService.this);
        }

        @Override
        public void setLastSeen(String value) {
            Prefs.setLastSeen(ReminderService.this, value);
        }

        @Override
        public boolean markSeen(String key) {
            return Prefs.markSeen(ReminderService.this, key);
        }
    };

    private void loop() {
        long backoff = 3000;
        while (running) {
            String server = Prefs.server(this);
            if (server.isEmpty() || !Prefs.hasSession(this) || !Notifier.enabled(this)) break;
            stream = new ReminderStream(server, store, (title, body, tag) -> Notifier.reminder(this, title, body, tag));
            try {
                stream.listen();
            } catch (ReminderStream.Unauthorized e) {
                Prefs.clearSession(this); // 비밀번호가 바뀌었다 → 앱을 열어 다시 로그인하면 재개
                break;
            } catch (ReminderStream.Connected e) {
                backoff = 3000;
            } catch (Exception e) {
                // 서버 꺼짐·Wi-Fi 끊김 등 → 잠시 뒤 다시 연결
            }
            if (!running) break;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                break;
            }
            backoff = Math.min(backoff * 2, 60000);
        }
        stopSelf();
    }
}
