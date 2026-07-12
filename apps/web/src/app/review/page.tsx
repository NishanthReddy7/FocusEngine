"use client";

import { useEffect } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { ReviewDashboard } from "@/components/review/ReviewDashboard";
import { startSyncEngine } from "@/lib/sync/engine";

/** Review view (DESIGN_SPEC §5/§8): instrument-card dashboard + evening
 *  check-in, under the app shell (no sidebar). */
export default function ReviewPage() {
  useEffect(() => startSyncEngine(), []);

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-6 md:py-10">
        <ReviewDashboard />
      </div>
    </AppShell>
  );
}
