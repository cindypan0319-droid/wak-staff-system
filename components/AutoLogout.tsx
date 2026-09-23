import { useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { isAuthSessionMissingError } from "@supabase/supabase-js";
import { supabase } from "../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;
type SessionProfile = {
  role?: Role | null;
  is_active?: boolean | null;
  single_login_token?: string | null;
};

const STAFF_TIMEOUT_MS = 15 * 60 * 1000;
const MANAGER_TIMEOUT_MS = 30 * 60 * 1000;
const OWNER_TIMEOUT_MS = 45 * 60 * 1000;

const PUBLIC_PATHS = ["/", "/auth/callback", "/admin-login"];
const SINGLE_LOGIN_STORAGE_KEY = "wak_single_login_token";
const SINGLE_LOGIN_CHECK_MS = 15000; // 每 15 秒检查一次

function getTimeoutByRole(role: Role) {
  if (role === "STAFF") return STAFF_TIMEOUT_MS;
  if (role === "MANAGER") return MANAGER_TIMEOUT_MS;
  if (role === "OWNER") return OWNER_TIMEOUT_MS;
  return null;
}

export default function AutoLogout() {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const singleLoginIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roleRef = useRef<Role>("ANON");
  const enabledRef = useRef(false);

  function clearLogoutTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function clearSingleLoginInterval() {
    if (singleLoginIntervalRef.current) {
      clearInterval(singleLoginIntervalRef.current);
      singleLoginIntervalRef.current = null;
    }
  }

  function handleConfirmedSignedOut() {
    clearLogoutTimer();
    clearSingleLoginInterval();
    enabledRef.current = false;
    roleRef.current = "ANON";
    localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);

    if (!PUBLIC_PATHS.includes(router.pathname)) {
      window.location.href = "/";
    }
  }

  async function doLogout(scope: "local" | "global") {
    try {
      clearLogoutTimer();
      clearSingleLoginInterval();
      enabledRef.current = false;
      roleRef.current = "ANON";
      localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);
      await supabase.auth.signOut({ scope });
    } catch (e) {
      console.error("Auto logout error:", e);
    } finally {
      window.location.href = "/";
    }
  }

  function startLogoutTimer() {
    clearLogoutTimer();

    if (!enabledRef.current) return;
    if (PUBLIC_PATHS.includes(router.pathname)) return;

    const timeout = getTimeoutByRole(roleRef.current);
    if (!timeout) return;

    timerRef.current = setTimeout(() => {
      doLogout("local");
    }, timeout);
  }

  async function checkSingleLogin(isCurrent: () => boolean) {
    try {
      if (!isCurrent()) return;
      if (PUBLIC_PATHS.includes(router.pathname)) return;
      if (!enabledRef.current) return;

      const localToken = localStorage.getItem(SINGLE_LOGIN_STORAGE_KEY);
      if (!localToken) {
        await doLogout("local");
        return;
      }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (!isCurrent() || !enabledRef.current) return;
      if (userError) {
        if (isAuthSessionMissingError(userError)) {
          handleConfirmedSignedOut();
          return;
        }
        console.warn("AUTOLOGOUT_POLL_READ_ERROR");
        return;
      }
      const uid = userData.user?.id;

      if (!uid) {
        await doLogout("local");
        return;
      }

      const p = await supabase
        .from("profiles")
        .select("single_login_token, is_active")
        .eq("id", uid)
        .maybeSingle();

      if (!isCurrent() || !enabledRef.current) return;
      if (p.error) {
        console.warn("AUTOLOGOUT_POLL_READ_ERROR");
        return;
      }

      const profile = p.data as SessionProfile | null;
      const serverToken = profile?.single_login_token;
      const isActive = profile?.is_active;

      if (isActive === false) {
        await doLogout("global");
        return;
      }

      if (!serverToken || serverToken !== localToken) {
        await doLogout("local");
      }
    } catch {
      console.warn("AUTOLOGOUT_POLL_READ_ERROR");
    }
  }

  function startSingleLoginGuard(requestPollCheck: () => void) {
    clearSingleLoginInterval();

    if (!enabledRef.current) return;
    if (PUBLIC_PATHS.includes(router.pathname)) return;

    singleLoginIntervalRef.current = setInterval(() => {
      requestPollCheck();
    }, SINGLE_LOGIN_CHECK_MS);
  }

  async function loadRoleAndEnable(
    isCurrent: () => boolean,
    requestPollCheck: () => void,
    onReadError: () => void,
    onValidated: () => void
  ) {
    try {
      if (!isCurrent()) return;
      if (PUBLIC_PATHS.includes(router.pathname)) {
        onValidated();
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        clearSingleLoginInterval();
        return;
      }

      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (!isCurrent()) return;
      if (userError) {
        if (isAuthSessionMissingError(userError)) {
          onValidated();
          handleConfirmedSignedOut();
          return;
        }
        console.warn("AUTOLOGOUT_ROLE_READ_ERROR");
        onReadError();
        return;
      }
      const uid = userData.user?.id;

      if (!uid) {
        onValidated();
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        clearSingleLoginInterval();
        return;
      }

      const p = await supabase
        .from("profiles")
        .select("role, is_active, single_login_token")
        .eq("id", uid)
        .maybeSingle();

      if (!isCurrent()) return;
      if (p.error) {
        console.warn("AUTOLOGOUT_ROLE_READ_ERROR");
        onReadError();
        return;
      }

      onValidated();

      const profile = p.data as SessionProfile | null;
      const role = profile?.role;
      const isActive = profile?.is_active;
      const serverToken = profile?.single_login_token;
      const localToken = localStorage.getItem(SINGLE_LOGIN_STORAGE_KEY);

      if (isActive === false) {
        await doLogout("global");
        return;
      }

      if (!role) {
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        clearSingleLoginInterval();
        return;
      }

      // 单设备检查：本机 token 和数据库必须一致
      if (!localToken || !serverToken || localToken !== serverToken) {
        await doLogout("local");
        return;
      }

      const shouldStartLogoutTimer =
        !enabledRef.current || roleRef.current !== role || timerRef.current === null;
      roleRef.current = role;
      enabledRef.current = true;
      if (shouldStartLogoutTimer) startLogoutTimer();
      startSingleLoginGuard(requestPollCheck);
    } catch {
      console.warn("AUTOLOGOUT_ROLE_READ_ERROR");
      if (isCurrent()) onReadError();
    }
  }

  useEffect(() => {
    let active = true;
    let authEpoch = 0;
    let checkRunning = false;
    let roleCheckPending = false;
    let pollCheckPending = false;
    let scheduledCheck: ReturnType<typeof setTimeout> | null = null;
    let roleRetryTimer: ReturnType<typeof setTimeout> | null = null;

    const runChecks = async () => {
      if (checkRunning || !active) return;
      checkRunning = true;
      try {
        while (active && (roleCheckPending || pollCheckPending)) {
          const epoch = authEpoch;
          const isCurrent = () => active && epoch === authEpoch;
          if (roleCheckPending) {
            roleCheckPending = false;
            await loadRoleAndEnable(
              isCurrent,
              requestPollCheck,
              () => scheduleRoleRetry(epoch),
              clearRoleRetry
            );
          } else {
            pollCheckPending = false;
            await checkSingleLogin(isCurrent);
          }
        }
      } finally {
        checkRunning = false;
      }
    };

    const scheduleChecks = () => {
      if (!active || checkRunning || scheduledCheck !== null) return;
      scheduledCheck = setTimeout(() => {
        scheduledCheck = null;
        void runChecks();
      }, 0);
    };

    const requestRoleCheck = () => {
      roleCheckPending = true;
      scheduleChecks();
    };

    const requestPollCheck = () => {
      pollCheckPending = true;
      scheduleChecks();
    };

    const clearRoleRetry = () => {
      if (roleRetryTimer !== null) {
        clearTimeout(roleRetryTimer);
        roleRetryTimer = null;
      }
    };

    const scheduleRoleRetry = (epoch: number) => {
      if (!active || epoch !== authEpoch || roleRetryTimer !== null) return;
      roleRetryTimer = setTimeout(() => {
        roleRetryTimer = null;
        if (active && epoch === authEpoch) requestRoleCheck();
      }, 5000);
    };

    requestRoleCheck();

    const resetTimer = () => {
      if (!enabledRef.current) return;
      startLogoutTimer();
    };

    const events = [
      "mousedown",
      "mousemove",
      "keydown",
      "scroll",
      "touchstart",
      "click",
    ] as const;

    events.forEach((event) => {
      window.addEventListener(event, resetTimer);
    });

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        resetTimer();
        requestPollCheck();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        authEpoch++;
        clearRoleRetry();
        roleCheckPending = false;
        pollCheckPending = false;
        handleConfirmedSignedOut();
        return;
      }

      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        authEpoch++;
        clearRoleRetry();
        requestRoleCheck();
      }
    });

    return () => {
      active = false;
      authEpoch++;
      if (scheduledCheck !== null) clearTimeout(scheduledCheck);
      clearRoleRetry();
      clearLogoutTimer();
      clearSingleLoginInterval();

      events.forEach((event) => {
        window.removeEventListener(event, resetTimer);
      });

      document.removeEventListener("visibilitychange", onVisibilityChange);
      sub.subscription.unsubscribe();
    };
    // Guard listeners and checks are recreated only when the route changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.pathname]);

  return null;
}
