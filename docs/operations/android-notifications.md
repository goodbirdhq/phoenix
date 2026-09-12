# Android notification development

> For maintainers. Using Phoenix? See [mobile notifications](../user/mobile-notifications.md).

Remote notification delivery is unavailable. The managed service, device registration,
and its deployment and push-watcher scripts were removed. Direct pairing does not
register a device for push. Configuring Firebase alone does not enable delivery or
make the notification settings available.

The native notification implementation is retained for development, including alert
presentation, ongoing activity cards, expiry, and notification-tap navigation. The
[Android module](../../apps/mobile/modules/t3-agent-notifications/android/) owns native
presentation. Reusable [FCM](../../apps/server/src/notifications/FcmClient.ts) and
[APNs](../../apps/server/src/notifications/ApnsClient.ts) clients, activity aggregation,
and payload logic remain in the server; shared payload types live in
[notification contracts](../../packages/contracts/src/notifications.ts). These are
components, not an operating delivery service. iOS retains its
[Live Activity widget](../../apps/mobile/src/widgets/AgentActivity.tsx).

## Native checks

The app's minimum is Android 7.0 (API 24), declared in
[app.config.ts](../../apps/mobile/app.config.ts). Notification channels begin at API 26;
the notification permission prompt begins at API 33. Live Update promotion requires
API 36 and remains subject to system settings and device support.

The native tests cover presentation and expiry across Android versions using
Robolectric. From a generated `apps/mobile/android` project, with JDK 21 available:

```sh
./gradlew :t3-agent-notifications:testDebugUnitTest :t3-agent-notifications:lintRelease -Pandroid.lint.useK2Uast=false
```

Robolectric's API 36 runtime requires JDK 21; module compilation uses Expo's Java 17
toolchain. The lint command uses the K1 frontend because AGP's K2 frontend crashes
while analyzing Worklets 0.10's Gradle Kotlin scripts. It does not disable lint checks.
These checks need no Firebase or signing credentials and do not verify remote delivery.

To focus on the presentation regression tests:

```sh
./gradlew :t3-agent-notifications:testDebugUnitTest --tests expo.modules.t3agentnotifications.AgentNotificationsTest
```

Live Update eligibility still requires device verification: Robolectric's API 36
image implements older promotion rules that require colorization, while shipped
Live Updates require uncolorized notifications.

## Firebase configuration for native development

When a native test requires Firebase, register the Android application identifier
for the chosen variant: `com.goodbird.phoenix.dev`, `com.goodbird.phoenix.preview`, or
`com.goodbird.phoenix`. Download its `google-services.json` and set
`T3CODE_ANDROID_GOOGLE_SERVICES_FILE` to the file's absolute path. Its package entry
must match the variant used for both prebuild and bundling.

For a local development build, from `apps/mobile`:

```sh
APP_VARIANT=development \
T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/absolute/path/google-services.json \
vp run android:dev
```

For EAS builds, provide the file through the selected build environment using an
EAS file variable named `T3CODE_ANDROID_GOOGLE_SERVICES_FILE`. Make it available to
fingerprint generation as well as the native build. Server-side FCM service-account
credentials do not belong in the app bundle or its build environment.

Set `T3CODE_MOBILE_UPDATES_ENABLED=0` before prebuild and bundling a private binary to
disable the repository's configured Expo OTA update source. A debug development-client
APK requires Metro. Native module or Firebase configuration changes require a new
binary; a JavaScript-only update cannot install them.

Use the development package to keep a private build separate from an official
installation. A locally signed production-package build cannot update an official
installation signed by the maintainer or coexist with it; uninstalling that official
app also removes its app-local data.
