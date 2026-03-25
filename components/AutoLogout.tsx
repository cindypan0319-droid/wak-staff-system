import { useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;

// 正式时间
const STAFF_TIMEOUT_MS = 15 * 60 * 1000; // 15 min
const MANAGER_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
const OWNER_TIMEOUT_MS = 45 * 60 * 1000; // 30 min

// 测试时可以临时改成：
// const STAFF_TIMEOUT_MS = 20 * 1000;
// const MANAGER_TIMEOUT_MS = 30 * 1000;
// const OWNER_TIMEOUT_MS = 30 * 1000;

const PUBLIC_PATHS = ["/", "/auth/callback", "/admin-login"];

function getTimeoutByRole(role: Role) {
  if (role === "STAFF") return STAFF_TIMEOUT_MS;
  if (role === "MANAGER") return MANAGER_TIMEOUT_MS;
  if (role === "OWNER") return OWNER_TIMEOUT_MS;
  return null;
}

export default function AutoLogout() {
  const router = useRouter();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roleRef = useRef<Role>("ANON");
  const enabledRef = useRef(false);

  function clearLogoutTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  async function doLogout() {
    try {
      clearLogoutTimer();
      enabledRef.current = false;
      roleRef.current = "ANON";
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

  async function loadRoleAndEnable() {
    try {
      if (PUBLIC_PATHS.includes(router.pathname)) {
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        return;
      }

      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;

      if (!uid) {
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        return;
      }

      const p = await supabase
        .from("profiles")
        .select("role, is_active")
        .eq("id", uid)
        .maybeSingle();

      const role = (p.data as any)?.role as Role | undefined;
      const isActive = (p.data as any)?.is_active;

      if (!role || isActive === false) {
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        return;
      }

      roleRef.current = role;
      enabledRef.current = true;
      startLogoutTimer();
    } catch (e) {
      console.error("AutoLogout init error:", e);
      enabledRef.current = false;
      roleRef.current = "ANON";
      clearLogoutTimer();
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
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);

    const { data: sub } = supabase.auth.onAuthStateChange(async (event) => {
      if (event === "SIGNED_OUT") {
        enabledRef.current = false;
        roleRef.current = "ANON";
        clearLogoutTimer();
        return;
      }

      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") {
        await loadRoleAndEnable();
      }
    });

    return () => {
      clearLogoutTimer();

      events.forEach((event) => {
        window.removeEventListener(event, resetTimer);
      });

      document.removeEventListener("visibilitychange", onVisibilityChange);
      sub.subscription.unsubscribe();
    };
  }, [router.pathname]);

  return null;
}