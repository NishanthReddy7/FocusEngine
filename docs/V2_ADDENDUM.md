# FocusEngine v2 — Binding Contract Addendum

**Status:** v2.0 · Authored by the project architect. Extends (never replaces) `ARCHITECTURE.md`, `SYNC_STRATEGY.md`, `DESIGN_SPEC.md`. Where this doc speaks, it wins for v2 scope.

## A1. Product goals (from the user)

Multi-user FocusEngine: Google sign-in; web app hosted on GitHub Pages; FastAPI backend hosted on Render (Postgres); Android APK (Capacitor) for a friend; near-realtime cross-device sync (web ⇄ phone ~1s via WS push, 3s foreground polling fallback on mobile); personal onboarding/settings; **single-author repo policy: all commits authored by the project owner, no third-party attribution trailers**.

## A2. Identity & Auth

- `users` table: `id` String(36) PK, `google_sub` unique indexed, `email`, `name`, `picture`, `settings` JSON default `{}`, `created_at`.
- `POST /auth/google {id_token}` → verify Google ID token (lib `google-auth`, audience = env `FE_GOOGLE_CLIENT_ID`) → upsert user by `google_sub` → return `{token, user}` where `token` is our JWT (pyjwt HS256, secret `FE_JWT_SECRET`, `sub`=user_id, 30-day exp).
- Every route except `/health` and `/auth/google` requires `Authorization: Bearer <jwt>` (FastAPI dependency `get_current_user`). WebSockets take `?token=`. 401 on missing/invalid.
- `GET /me` → user + settings; `PATCH /me/settings {settings}` → merged JSON (client caches in Dexie `_meta.settings`).
- **Web sign-in:** Google Identity Services button (client id from `NEXT_PUBLIC_GOOGLE_CLIENT_ID`).
- **Mobile sign-in (WebView-safe):** Google blocks OAuth inside WebViews, so the APK opens the HOSTED web app's `/auth/mobile` page in the system browser (`@capacitor/browser`); that page runs GIS, exchanges for our JWT, then redirects to `focusengine://auth#token=<jwt>&user=<b64 json>`; the app's deep-link listener (`@capacitor/app`) captures it. Custom scheme `focusengine` registered in AndroidManifest.
- **Local-only mode:** signed-out app is fully functional (local-first); sync engine idles. First sign-in triggers **claim-local-data**: all local rows get `user_id` stamped and the oplog replays to the server (existing push path).

## A3. Multi-user data scoping

- `user_id` String(36) NOT NULL + indexed on all 7 entity tables, `server_oplog`, and new `sync_cursors` (`user_id`, `device_id`, `last_seq`, `updated_at`; PK (user_id, device_id)).
- Every router/service call scopes by `current_user.id`; sync push/pull/bootstrap filter oplog + snapshots by user. Cross-user access is impossible by construction (WHERE user_id = :uid everywhere; verify in tests).
- `FocusSessionManager` → per-user registry (`dict[user_id, FocusController]`, one active session per user). Focus WS also per-user.
- Client: Dexie rows KEEP no user_id (a device's DB belongs to whoever is signed in); `_meta.auth = {token, user}`; sign-out keeps local data, sign-in as a DIFFERENT user prompts "Replace local data?" (bootstrap wipe+load) vs cancel.

## A4. Storage & deployment topology

- SQLAlchemy URL from env `FE_DATABASE_URL` (default `sqlite+aiosqlite:///./focusengine.db` for dev; Render injects `postgresql+asyncpg://...`). Add `asyncpg` dep. JSON columns stay `sa.JSON` (works on both). `create_all` on startup remains (Alembic still deferred — greenfield DB).
- `apps/api/Dockerfile` (python:3.12-slim, uvicorn, port from `$PORT`).
- `render.yaml` blueprint at repo root: web service (`apps/api`, Docker), free Postgres, env: `FE_DATABASE_URL` fromDatabase, `FE_JWT_SECRET` generateValue, `FE_GOOGLE_CLIENT_ID` sync:false (user pastes), `FE_CORS_ORIGINS=https://nishanthreddy7.github.io`.
- **GitHub Pages:** Next.js static export (`output: "export"` gated by env `NEXT_OUTPUT=export`, `basePath`/`assetPrefix` from `NEXT_PUBLIC_BASE_PATH=/FocusEngine`, `images.unoptimized`). Workflow `.github/workflows/pages.yml` builds with repo variables (`NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`) → `actions/deploy-pages`. Site: `https://nishanthreddy7.github.io/FocusEngine/`.
- **APK CI:** `.github/workflows/android-apk.yml` — on `workflow_dispatch` + push to main: node build (mobile flavor) → `cap sync android` → `gradlew assembleDebug` (setup-java 17) → upload artifact `focusengine-debug.apk` + attach to a rolling `latest-apk` release. Local build path (best-effort): `ANDROID_HOME=~/Library/Android/sdk`, `JAVA_HOME` pinned to a 17/21 JDK if installed (Java 25 is too new for Gradle).

## A5. Realtime sync

- New WS `/ws/sync?token=` per user: server pushes `{"server_seq": N}` after any oplog append for that user (hook in `services/sync.py` + server-originated writers). Client, on message where N > local cursor → immediate `syncOnce()`.
- Polling cadence (fallback + baseline): web 5s visible / 60s hidden; mobile flavor 3s foregrounded (user requirement) / paused backgrounded (Capacitor App state events).
- Push path unchanged; latency target web→phone ≈ WS hop + one pull (<1.5s typical).

## A6. Mobile experience spec (M-spec — extends DESIGN_SPEC; "go insane" bar)

- Build flavor `NEXT_PUBLIC_PLATFORM=mobile`: bottom tab bar ALWAYS (Capture / Focus / Review / Settings), 44px+ touch targets, no hover-gated affordances (TaskRow actions become swipe-free explicit buttons/long-press sheet), safe-area insets (`env(safe-area-inset-*)`), status bar tinted to `--bg` per theme (`@capacitor/status-bar`).
- Haptics (`@capacitor/haptics`): light impact on session start/complete/cycle change; nothing elsewhere (instrument restraint).
- The Session Dial is the mobile hero: full-bleed focus screen, dial scales to ~86vw, controls as a thumb-reachable bottom cluster.
- Onboarding (first launch, both platforms; mobile-polished): 3 screens — welcome/thesis, theme pick (live Studio/Neon preview), default preset + week-start + display-name; writes to `_meta.settings` and (signed-in) `PATCH /me/settings`. Settings screen mirrors these + blocklist editor + sign in/out.
- App icon + splash: the 60-tick dial ring motif on `--bg` (generate via `@capacitor/assets` from an SVG master committed at `apps/mobile/resources/`).
- Keep DESIGN_SPEC tokens/typography/voice verbatim; Neon glow rules unchanged.

## A7. Repo & authorship (hard requirements)

- New public repo `NishanthReddy7/FocusEngine` (public = free Pages). Default branch `main`.
- Repo-local git identity = the USER (fetched from GitHub): `user.name "NISHANTH REDDY KURAKU"`, `user.email "nishanthreddy7904@gmail.com"`. **No attribution trailers; the repository presents a single author.** Conventional-commit style messages.
- Never commit: `.venv`, `node_modules`, `.next`, `out`, `*.db`, `__pycache__`, `android/app/build`, `.gradle`, local caches, any `.env*` (commit `.env.example` only). Secrets live in Render env + GitHub repo variables/secrets only.
- `docs/` (specs/plans incl. this file) ARE committed — they read as normal project docs (written as project documentation).

## A8. Owner-action checklist (external accounts)

1. **Google OAuth client** (~5 min): console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID (Web application) → Authorized JavaScript origins: `https://nishanthreddy7.github.io`, `http://localhost:3000` → copy Client ID → paste into GitHub repo variable `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and Render env `FE_GOOGLE_CLIENT_ID`.
2. **Render**: dashboard → New → Blueprint → select `NishanthReddy7/FocusEngine` → deploy; then copy the service URL into GitHub repo variable `NEXT_PUBLIC_API_BASE_URL` and re-run the Pages workflow.
3. **Friend's phone**: download `focusengine-debug.apk` from the repo's Releases → allow "install unknown apps" → install → sign in with Google.
