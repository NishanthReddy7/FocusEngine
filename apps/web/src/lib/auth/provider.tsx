"use client";

/**
 * Auth provider — V2-C (A2/A3). Owns the sign-in session lifecycle and is the
 * single writer of the in-memory JWT (`lib/auth/token.ts`): it restores
 * `_meta.auth` on load, drives the Google credential exchange, and handles the
 * three local-data scenarios from A3 —
 *
 *   1. first sign-in (no prior owner)   → claim-local-data, then push
 *   2. same owner re-signing in         → resume (local edits push as-is)
 *   3. a DIFFERENT user signing in      → "Replace local data?" → wipe+bootstrap, or cancel
 *
 * Signed out, the app stays fully functional and local-first; the sync engine
 * idles (no token). A 401 anywhere (surfaced as the `auth.expired` bus event)
 * ends the session and asks the user to sign in again.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AuthResponse, MeResponse, User } from "@focusengine/schemas/auth";
import {
  clearStoredAuth,
  getDataOwner,
  getStoredAuth,
  setDataOwner,
  setStoredAuth,
  wipeLocalData,
} from "@/lib/db/repository";
import { authHeader, setAuthToken } from "@/lib/auth/token";
import { claimLocalData } from "@/lib/auth/claim";
import { exchangeGoogleCredential, GoogleAuthUnavailableError, isGoogleConfigured } from "@/lib/auth/google";
import { applyServerSettings } from "@/lib/settings";
import { bus } from "@/lib/events/bus";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export type AuthStatus = "loading" | "local-only" | "authed";

/** The new user waiting on a "Replace local data?" decision (A3 scenario 3). */
interface PendingReplace {
  user: User;
  token: string;
}

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** True when a Google client id is configured — gates the sign-in button vs.
   *  the local-only notice (A2 acceptance). */
  configured: boolean;
  /** A transient notice to show the user (session expired, sign-in unavailable,
   *  a failure). Cleared with {@link clearMessage}. */
  message: string | null;
  /** Feed the Google ID token from a GIS credential callback (button or the
   *  `/auth/mobile` page). Resolves once the session is settled (or a
   *  "Replace local data?" prompt is pending). */
  signInWithCredential: (googleIdToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  clearMessage: () => void;
  /** Non-null while a different-user sign-in awaits the wipe/cancel decision. */
  pendingReplace: PendingReplace | null;
  resolveReplace: (replace: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | null>(null);

  const clearMessage = useCallback(() => setMessage(null), []);

  /** Session-fatal path (sign-out / 401): drop the token+user, KEEP local data
   *  and `data_owner` (A3). */
  const endSession = useCallback(async (nextMessage: string | null) => {
    await clearStoredAuth();
    setAuthToken(null);
    setUser(null);
    setStatus("local-only");
    setMessage(nextMessage);
  }, []);

  /** Commit a validated session: cache it, adopt server settings, and set the
   *  token (which wakes the sync engine — WS + immediate sync). Any claim/wipe
   *  must already have run before this so the engine pushes/bootstraps the
   *  right state. */
  const activateSession = useCallback(async (auth: AuthResponse, owner: boolean) => {
    await setStoredAuth({ token: auth.token, user: auth.user });
    if (owner) await setDataOwner(auth.user.id);
    await applyServerSettings(auth.user.settings ?? {});
    setUser(auth.user);
    setStatus("authed");
    setMessage(null);
    setAuthToken(auth.token);
  }, []);

  // Restore a cached session on load, best-effort refreshing it from GET /me.
  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await getStoredAuth();
      if (!active) return;
      if (!stored) {
        setAuthToken(null);
        setStatus("local-only");
        return;
      }
      // Optimistically resume from cache so the app is usable offline…
      setAuthToken(stored.token);
      setUser(stored.user);
      setStatus("authed");
      // …then validate/refresh against the server when reachable.
      try {
        const res = await fetch(`${API_BASE}/me`, { headers: { ...authHeader() } });
        if (!active) return;
        if (res.status === 401) {
          await endSession("Session expired — sign in");
          return;
        }
        if (res.ok) {
          const me = (await res.json()) as MeResponse;
          await setStoredAuth({ token: stored.token, user: me });
          await applyServerSettings(me.settings ?? {});
          if (active) setUser(me);
        }
      } catch {
        // Offline — keep the cached session; it revalidates on the next load.
      }
    })();
    return () => {
      active = false;
    };
  }, [endSession]);

  // A 401 anywhere in the app (sync engine, focus timer) lands here.
  const endSessionRef = useRef(endSession);
  endSessionRef.current = endSession;
  useEffect(() => {
    return bus.on("auth.expired", (payload) => {
      void endSessionRef.current(payload.message);
    });
  }, []);

  const signInWithCredential = useCallback(
    async (googleIdToken: string) => {
      setMessage(null);
      let auth: AuthResponse;
      try {
        auth = await exchangeGoogleCredential(googleIdToken);
      } catch (err) {
        if (err instanceof GoogleAuthUnavailableError) {
          // Server has no Google client (503) — stay local-only, explain why.
          setStatus("local-only");
          setMessage(err.message);
          return;
        }
        setMessage(err instanceof Error ? err.message : "Sign-in failed. Try again.");
        return;
      }

      const owner = await getDataOwner();
      if (owner !== null && owner !== auth.user.id) {
        // A3 scenario 3: a different user — defer to the "Replace local data?" prompt.
        setPendingReplace({ user: auth.user, token: auth.token });
        return;
      }
      if (owner === null) {
        // A3 scenario 1: first sign-in — stage local rows to push to this account.
        await claimLocalData();
      }
      await activateSession(auth, true);
    },
    [activateSession],
  );

  const resolveReplace = useCallback(
    async (replace: boolean) => {
      const pending = pendingReplace;
      setPendingReplace(null);
      if (!pending) return;
      if (!replace) return; // cancel — stay signed out, local data untouched
      // Replace: wipe local data, adopt the new user, let the engine bootstrap.
      await wipeLocalData();
      await activateSession({ token: pending.token, user: pending.user }, true);
    },
    [pendingReplace, activateSession],
  );

  const signOut = useCallback(async () => {
    await endSession(null);
  }, [endSession]);

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        configured: isGoogleConfigured,
        message,
        signInWithCredential,
        signOut,
        clearMessage,
        pendingReplace,
        resolveReplace,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
