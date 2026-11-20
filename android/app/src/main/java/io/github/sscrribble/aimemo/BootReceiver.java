package io.github.sscrribble.aimemo;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** 휴대폰을 켜거나 앱이 업데이트되면 알림 받기를 다시 시작한다. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            ReminderService.start(context);
        }
    }
}
