# AI 메모 안드로이드 앱

서버의 메모 화면을 보여 주는 앱입니다. 화면과 기능은 서버에서 불러오고, 앱은 아래만 맡습니다.

- 서버 주소 입력·저장 (`SetupActivity`)
- 서버 화면 표시, 파일 가져오기·내보내기, 뒤로 가기, 밝은/어두운 막대 색 (`MainActivity`)
- 서버가 꺼져 있어도 열리도록 화면 파일 저장 (`ShellCache`)
- 앱을 닫아도 일정 알림 받기: 서버의 `/api/events` 에 연결을 유지하고, 다시 연결될 때 `/api/reminders` 로 놓친 알림을 받는다 (`ReminderService`, `ReminderStream`)

웹앱과는 `window.AIMemoApp` 으로 주고받습니다 (`web/app.js` 의 `native(...)`).

## 빌드

필요한 것: JDK 17 이상, Android SDK (platform 35, build-tools 34.0.0).

```bash
export ANDROID_HOME=~/android-sdk
```
```bash
./gradlew testDebugUnitTest assembleRelease
```

서명해서 만들려면 키 파일을 환경변수로 알려 줍니다 (키는 저장소에 넣지 않습니다).

```bash
AIMEMO_KEYSTORE=/경로/ai-memo-release.jks AIMEMO_KEYSTORE_PASSWORD=비밀번호 ./gradlew assembleRelease
```

결과: `app/build/outputs/apk/release/app-release.apk`. 같은 키로 서명해야 기존 앱 위에 업데이트됩니다. 키가 바뀌면 앱을 지우고 다시 설치하세요 (메모는 서버에 있어 그대로입니다).

## 시험

`./gradlew testDebugUnitTest` 는 주소 처리·실시간 알림 읽기를 확인합니다. 서버를 띄우고 주소를 알려 주면 실제 서버에서 알림을 받는지(놓친 알림 포함)도 확인합니다.

```bash
AIMEMO_TEST_SERVER=http://127.0.0.1:8000 AIMEMO_TEST_PASSWORD=비밀번호 ./gradlew testDebugUnitTest
```
