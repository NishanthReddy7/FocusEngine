"use client";

/**
 * Rail account chip (A6) — the avatar when signed in, or a "Local only" glyph
 * when not, linking to Settings. Sits in the rail's bottom cluster so the
 * sign-in state is always visible without leaving the current view.
 */
import Link from "next/link";
import { UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth/provider";

export function AccountChip() {
  const { status, user } = useAuth();
  const authed = status === "authed" && user !== null;
  const label = authed ? `Account — ${user.name}` : "Local only — open settings to sign in";

  return (
    <Link
      href="/settings"
      aria-label={label}
      title={authed ? user.name : "Local only"}
      className="flex h-10 w-10 items-center justify-center rounded-md"
    >
      {authed && user.picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={user.picture}
          alt=""
          referrerPolicy="no-referrer"
          className="h-6 w-6 rounded-full border border-hairline object-cover"
        />
      ) : authed ? (
        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-hairline bg-surface-2 font-display text-[11px] text-ink">
          {(user.name.trim()[0] ?? "?").toUpperCase()}
        </span>
      ) : (
        <span className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-hairline text-muted">
          <UserRound size={13} strokeWidth={1.75} />
        </span>
      )}
    </Link>
  );
}
