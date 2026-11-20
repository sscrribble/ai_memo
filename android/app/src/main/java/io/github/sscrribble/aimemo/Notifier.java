package io.github.sscrribble.aimemo;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

/** 알림 채널과 알림 표시. */
final class Notifier {
    static final String CH_REMINDER = "reminders";
    static final String CH_SERVICE = "service";
    static final int SERVICE_ID = 1;
    private static final int REMINDER_ID = 2;

    private Notifier() {}

    static void createChannels(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        NotificationChannel reminders = new NotificationChannel(
                CH_REMINDER, c.getString(R.string.channel_reminders), NotificationManager.IMPORTANCE_HIGH);
        reminders.setDescription(c.getString(R.string.channel_reminders_desc));
        NotificationChannel service = new NotificationChannel(
                CH_SERVICE, c.getString(R.string.channel_service), NotificationManager.IMPORTANCE_MIN);
        service.setDescription(c.getString(R.string.channel_service_desc));
        service.setShowBadge(false);
        nm.createNotificationChannel(reminders);
        nm.createNotificationChannel(service);
    }

    /** 일정 알림을 띄울 수 있는지 (앱 알림과 '일정 알림' 채널이 켜져 있는지). */
    static boolean enabled(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (!nm.areNotificationsEnabled()) return false;
        NotificationChannel ch = nm.getNotificationChannel(CH_REMINDER);
        return ch == null || ch.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private static PendingIntent openApp(Context c) {
        Intent i = new Intent(c, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    /** 일정 알림. 같은 tag 의 알림은 새 것으로 바뀐다 (예: 아침 요약). */
    static void reminder(Context c, String title, String body, String tag) {
        createChannels(c);
        Notification.Builder b = new Notification.Builder(c, CH_REMINDER)
                .setSmallIcon(R.drawable.ic_stat_memo)
                .setColor(c.getColor(R.color.icon_bg))
                .setContentTitle(title)
                .setContentIntent(openApp(c))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER);
        if (body != null && !body.isEmpty()) {
            b.setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body));
        }
        String key = tag == null || tag.isEmpty() ? title : tag;
        c.getSystemService(NotificationManager.class).notify(key, REMINDER_ID, b.build());
    }

    /** 연결을 유지하는 동안 보이는 조용한 알림 (안드로이드 규칙상 필요). */
    static Notification service(Context c) {
        createChannels(c);
        return new Notification.Builder(c, CH_SERVICE)
                .setSmallIcon(R.drawable.ic_stat_memo)
                .setContentTitle(c.getString(R.string.service_title))
                .setContentText(c.getString(R.string.service_text))
                .setContentIntent(openApp(c))
                .setOngoing(true)
                .build();
    }
}
