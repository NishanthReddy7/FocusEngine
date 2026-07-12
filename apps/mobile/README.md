# @focusengine/mobile

The Android app shell for FocusEngine: a thin [Capacitor](https://capacitorjs.com/) wrapper
around the mobile-flavored Next.js static export from `apps/web` (`NEXT_PUBLIC_PLATFORM=mobile`,
`NEXT_OUTPUT=export`). See `docs/V2_ADDENDUM.md` (sections A2, A4, A6) for the full contract.

## What lives here

- `capacitor.config.ts` — app id `com.nishanth.focusengine`, app name `FocusEngine`, HTTPS
  Android scheme. `webDir` points at `../web/out` (the real static export) with a build-time
  existence check that falls back to `../web/out-placeholder` when the export hasn't been
  built yet — see the comment in that file. No manual flip is needed once the export lands.
- `resources/icon.svg`, `resources/splash.svg` — the Session Dial motif (60 tick marks in a
  ring, `docs/DESIGN_SPEC.md` §2/§3) used by `@capacitor/assets` to generate all Android
  icon/splash densities.
- `src/native.ts` — Capacitor plugin wrappers (status bar tint, haptics, system-browser auth,
  deep-link capture). Not yet imported by `apps/web` — see the integration-boundary comment
  at the top of that file for exactly how and where a future pass should wire it in.
- `android/` — the generated Capacitor Android project (committed, **except** build outputs —
  see `.gitignore` in this directory). Contains the `focusengine` custom-scheme deep-link
  intent filter in `android/app/src/main/AndroidManifest.xml` (host `auth`), per A2's mobile
  sign-in flow.

## Local development

```bash
# from repo root (npm workspaces)
npm install

# whenever apps/web/out changes (or to pick it up for the first time)
cd apps/mobile
npx cap sync android

# regenerate icon/splash from the SVG masters after editing them
npx @capacitor/assets generate --android

# open in Android Studio
npx cap open android

# or build a debug APK directly
cd android
JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home" \
ANDROID_HOME="$HOME/Library/Android/sdk" \
  ./gradlew assembleDebug
# APK lands at android/app/build/outputs/apk/debug/app-debug.apk
```

Java 17 is required (Java 25, the current macOS/Homebrew default `java`, is too new for the
Gradle version Capacitor's Android template ships). Install with `brew install openjdk@17`;
it is keg-only so it will not shadow the system `java` — always pass `JAVA_HOME` explicitly
as above rather than relying on `PATH`.

## CI

- `.github/workflows/pages.yml` builds and deploys the web export to GitHub Pages (does not
  touch this package).
- `.github/workflows/android-apk.yml` builds the *mobile-flavored* web export
  (`NEXT_PUBLIC_PLATFORM=mobile`), runs `cap sync android` here, then `gradlew assembleDebug`,
  and uploads/attaches the resulting `focusengine-debug.apk`.

## Known follow-ups for later waves

- `src/native.ts` is not yet imported anywhere in `apps/web` — see its top-of-file comment
  for the exact wiring steps (add a workspace dependency, call `initNative`/`hapticImpact`/
  `openAuthInSystemBrowser`/`onAuthDeepLink` from the right places).
- The repo-root `.gitignore` does not yet have Android/Gradle-specific patterns; this
  package's own `.gitignore` (`android/app/build/`, `android/.gradle/`, etc.) covers it for
  now, but per `docs/V2_ADDENDUM.md` A7 and the V2-E task description, whoever runs the
  publish step should double-check the root `.gitignore` too before the first commit.
