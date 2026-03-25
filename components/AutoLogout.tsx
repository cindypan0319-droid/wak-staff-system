import { useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;

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

  async function doLogout() {
    try {
      clearLogoutTimer();
      clearSingleLoginInterval();
      enabledRef.current = false;
      roleRef.current = "ANON";
      localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);
      await supabase.auth.signOut();
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
      doLogout();
    }, timeout);
  }

  async function checkSingleLogin() {
    try {
      if (PUBLIC_PATHS.includes(router.pathname)) return;
      if (!enabledRef.current) return;

      const localToken = localStorage.getItem(SINGLE_LOGIN_STORAGE_KEY);
      if (!localToken) {
        await doLogout();
        return;
      }

      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;

      if (!uid) {
        await doLogout();
        return;
      }

      const p = await supabase
        .from("profiles")
        .select("single_login_token, is_active")
        .eq("id", uid)
        .maybeSingle();

      const serverToken = (p.data as any)?.single_login_token;
      const isActive = (p.data as any)?.is_active;

      if (isActive === false) {
        await doLogout();
        return;
      }

      if (!serverToken || serverToken !== localToken) {
        await doLogout();
      }
    } catch (e) {
      console.error("Single login check error:", e);
    }
  }

  function startSingleLoginGuard() {
    clearSingleLoginInterval();

    if (!enabledRef.current) return;
    if (PUBLIC_PATHS.includes(router.pathname)) return;

    singleLoginIntervalRef.current = setInterval(() => {
      checkSingleLogin();
    }, SINGLE_LOGIN_CHECK_MS);
  }

  async function loadRoleAndEnable() {
    try {
      if (PUBLIC_PATHS.includes(router.pathname)) {
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        clearSingleLoginInterval();
        return;
      }

      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;

      if (!uid) {
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

      const role = (p.data as any)?.role as Role | undefined;
      const isActive = (p.data as any)?.is_active;
      const serverToken = (p.data as any)?.single_login_token;
      const localToken = localStorage.getItem(SINGLE_LOGIN_STORAGE_KEY);

      if (!role || isActive === false) {
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        clearSingleLoginInterval();
        return;
      }

      // 单设备检查：本机 token 和数据库必须一致
      if (!localToken || !serverToken || localToken !== serverToken) {
        await doLogout();
        return;
      }

      roleRef.current = role;
      enabledRef.current = true;
      startLogoutTimer();
      startSingleLoginGuard();
    } catch (e) {
      console.error("AutoLogout init error:", e);
      enabledRef.current = false;
      roleRef.current = "ANON";
      clearLogoutTimer();
      clearSingleLoginInterval();
    }
  }

  useEffect(() => {
    loadRoleAndEnable();

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
        checkSingleLogin();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    const { data: sub } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_OUT") {
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        clearSingleLoginInterval();
        localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);
        return;
      }

      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        await loadRoleAndEnable();
      }
    });

    return () => {
      clearLogoutTimer();
      clearSingleLoginInterval();

      events.forEach((event) => {
        window.removeEventListener(event, resetTimer);
      });

      document.removeEventListener("visibilitychange", onVisibilityChange);
      sub.subscription.unsubscribe();
    };
  }, [router.pathname]);

  return null;
}