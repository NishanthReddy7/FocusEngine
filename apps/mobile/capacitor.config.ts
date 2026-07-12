import type { CapacitorConfig } from '@capacitor/cli';
import { existsSync } from 'fs';
import { join } from 'path';

// --- webDir build-time fallback -------------------------------------------
// The real webDir is the mobile-flavored Next.js static export, built by the
// web workstream with NEXT_PUBLIC_PLATFORM=mobile + NEXT_OUTPUT=export (see
// docs/V2_ADDENDUM.md A4/A6). That export (apps/web/out) does not exist yet
// at scaffold time — this repo is being built by parallel workstreams and the
// web export lands separately. Rather than block on it, we point at the real
// path but fall back to a one-line placeholder (apps/web/out-placeholder) when
// it's absent, so `cap add android`, `cap sync android`, and
// `@capacitor/assets generate` all work today. This check re-evaluates on
// every Capacitor CLI invocation (config is loaded fresh each run), so once
// the real export exists, it is picked up automatically — zero changes
// needed here later.
const REAL_WEB_DIR = '../web/out';
const PLACEHOLDER_WEB_DIR = '../web/out-placeholder';
const webDir = existsSync(join(__dirname, REAL_WEB_DIR)) ? REAL_WEB_DIR : PLACEHOLDER_WEB_DIR;

const config: CapacitorConfig = {
  appId: 'com.nishanth.focusengine',
  appName: 'FocusEngine',
  webDir,
  server: {
    androidScheme: 'https',
  },
};

export default config;
