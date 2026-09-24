import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";
import { theme } from "../../lib/theme";
import { readCurrentUser } from "../../lib/authGuard";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;
type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "read_error";

type TimeClockRow = {
  id: number;
  staff_id: string;
  shift_id: number | null;
  clock_in_at: string;
  clock_out_at: string | null;
  device_tag: string | null;
  created_at: string;
};

type ProfileRow = {
  full_name: string | null;
  preferred_name: string | null;
  role: Role | null;
  is_active: boolean | null;
};

function displayName(profile: ProfileRow | null) {
  if (!profile) return "Unknown";
  const preferred = (profile.preferred_name ?? "").trim();
  const full = (profile.full_name ?? "").trim();
  return preferred || full || "Unknown";
}

export default function StaffClockPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("Unknown");
  const [role, setRole] = useState<Role>("ANON");
  const [msg, setMsg] = useState<string>("");
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [authError, setAuthError] = useState("");
  const [authRetryKey, setAuthRetryKey] = useState(0);

  const [openShift, setOpenShift] = useState<TimeClockRow | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const [storeAccessLoading, setStoreAccessLoading] = useState(true);
  const [isStoreDevice, setIsStoreDevice] = useState(false);

  const canUseClock = useMemo(() => {
    return role === "STAFF" || role === "MANAGER" || role === "OWNER";
  }, [role]);

  const canOperateClock = canUseClock && isStoreDevice;

  useEffect(() => {
    async function checkStoreAccess() {
      try {
        const { data: sessionData, error } = await supabase.auth.getSession();
        if (error) throw error;
        const token = sessionData.session?.access_token;
        if (!token) {
          window.location.href = "/staff/home";
          return;
        }
        const res = await fetch("/api/check-store-access", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const accessData = await res.json();

        if (!accessData.allowed) {
          window.location.href = "/staff/home";
        }
      } catch (error) {
        console.log("check store access error:", error);
        window.location.href = "/staff/home";
      }
    }

    checkStoreAccess();
  }, []);

  useEffect(() => {
    let active = true;
    let authEpoch = 0;
    let checkRunning = false;
    let checkPending = false;
    let scheduledCheck: ReturnType<typeof setTimeout> | null = null;

    const verifyAuth = async (epoch: number) => {
      const isCurrent = () => active && epoch === authEpoch;

      try {
        const userResult = await readCurrentUser();
        if (!isCurrent()) return;

        if (userResult.status === "read_error") {
          setAuthStatus("read_error");
          setAuthError("Could not verify your session. Please retry.");
          return;
        }

        if (userResult.status === "unauthenticated") {
          setUserId(null);
          setUserName("Unknown");
          setRole("ANON");
          setAuthStatus("unauthenticated");
          setAuthError("");
          return;
        }

        const uid = userResult.user.id;
        const { data, error } = await supabase
          .from("profiles")
          .select("full_name, preferred_name, role, is_active")
          .eq("id", uid)
          .maybeSingle();

        if (!isCurrent()) return;
        if (error) {
          setAuthStatus("read_error");
          setAuthError("Could not verify your employee profile. Please retry.");
          return;
        }

        const profile = (data as ProfileRow | null) ?? null;
        setUserId(uid);
        setUserName(displayName(profile));
        setRole(!profile?.is_active ? "INACTIVE" : (profile.role as Role) ?? "ANON");
        setAuthStatus("authenticated");
        setAuthError("");
      } catch {
        if (isCurrent()) {
          setAuthStatus("read_error");
          setAuthError("Could not verify your session or employee profile. Please retry.");
        }
      }
    };

    const runChecks = async () => {
      if (checkRunning || !active) return;
      checkRunning = true;
      try {
        while (active && checkPending) {
          checkPending = false;
          await verifyAuth(authEpoch);
        }
      } finally {
        checkRunning = false;
      }
    };

    const requestCheck = () => {
      checkPending = true;
      if (!active || checkRunning || scheduledCheck !== null) return;
      scheduledCheck = setTimeout(() => {
        scheduledCheck = null;
        void runChecks();
      }, 0);
    };

    requestCheck();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      authEpoch++;
      setMsg("");
      setAuthError("");

      if (!session?.user) {
        checkPending = false;
        setUserId(null);
        setUserName("Unknown");
        setRole("ANON");
        setAuthStatus("unauthenticated");
        return;
      }

      setAuthStatus("loading");
      requestCheck();
    });

    return () => {
      active = false;
      authEpoch++;
      if (scheduledCheck !== null) clearTimeout(scheduledCheck);
      sub.subscription.unsubscribe();
    };
  }, [authRetryKey]);

  useEffect(() => {
    async function checkStoreAccess() {
      setStoreAccessLoading(true);
      try {
        const { data: sessionData, error: sessionError } =
          await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        const token = sessionData.session?.access_token;
        if (!token) {
          setIsStoreDevice(false);
          return;
        }
        const res = await fetch("/api/check-store-access", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const accessData = await res.json();
        setIsStoreDevice(!!accessData.allowed);
      } catch (error) {
        console.log("check store access error:", error);
        setIsStoreDevice(false);
      } finally {
        setStoreAccessLoading(false);
      }
    }

    checkStoreAccess();
  }, []);

  async function refresh(options?: { clearMessage?: boolean }) {
    if (options?.clearMessage !== false) setMsg("");
    setLoading(true);
    try {
      if (!userId) {
        setOpenShift(null);
        setMsg("Not logged in.");
        return;
      }

      const { data, error } = await supabase
        .from("time_clock")
        .select("*")
        .eq("staff_id", userId)
        .is("clock_out_at", null)
        .order("clock_in_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.log("refresh error:", error);
        setOpenShift(null);
        setMsg("Cannot load status: " + error.message);
        return;
      }

      setOpenShift((data as TimeClockRow | null) ?? null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canUseClock) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseClock, userId]);

  async function getAccessToken() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session?.access_token ?? null;
  }

  async function clockIn() {
    setMsg("");
    setLoading(true);
    try {
      if (!userId) {
        setMsg("Not logged in.");
        return;
      }

      if (!canOperateClock) {
        setMsg("Clock in is only available on the store device / store network.");
        return;
      }

      if (openShift) {
        setMsg("You are already clocked in.");
        return;
      }

      const token = await getAccessToken();
      if (!token) {
        setMsg("Your session could not be verified. Please sign in again.");
        return;
      }

      const response = await fetch("/api/time-clock/clock-in", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        if (result.reason === "ALREADY_CLOCKED_IN") {
          setMsg("You are already clocked in. Current status has been refreshed.");
          await refresh({ clearMessage: false });
          return;
        }
        if (result.reason === "STORE_NETWORK_REQUIRED") {
          setMsg("Clock in is only available on the store device / store network.");
          return;
        }
        setMsg("Clock in failed. Please try again.");
        return;
      }

      setMsg("Clocked in.");
      await refresh({ clearMessage: false });
    } catch {
      setMsg("Clock in failed. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  async function clockOut() {
    setMsg("");
    setLoading(true);
    try {
      if (!canOperateClock) {
        setMsg("Clock out is only available on the store device / store network.");
        return;
      }

      if (!openShift) {
        setMsg("No open shift found.");
        return;
      }

      const token = await getAccessToken();
      if (!token) {
        setMsg("Your session could not be verified. Please sign in again.");
        return;
      }

      const response = await fetch("/api/time-clock/clock-out", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expected_clock_id: openShift.id }),
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        if (result.reason === "OPEN_CLOCK_NOT_FOUND" || result.reason === "CLOCK_STATE_CHANGED") {
          setMsg("Your clock status changed. Latest status has been refreshed.");
          await refresh({ clearMessage: false });
          return;
        }
        if (result.reason === "STORE_NETWORK_REQUIRED") {
          setMsg("Clock out is only available on the store device / store network.");
          return;
        }
        setMsg("Clock out failed. Please try again.");
        return;
      }

      setMsg("Clocked out.");
      await refresh({ clearMessage: false });
    } catch {
      setMsg("Clock out failed. Please check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  if (authStatus === "loading") {
    return (
      <div style={{ padding: 20 }}>
        <h1>Time Clock</h1>
        <p>Checking your session…</p>
      </div>
    );
  }

  if (authStatus === "read_error") {
    return (
      <div style={{ padding: 20 }}>
        <h1>Time Clock</h1>
        <p>{authError}</p>
        <button onClick={() => setAuthRetryKey((value) => value + 1)}>Retry</button>
      </div>
    );
  }

  if (authStatus === "unauthenticated" || !userId) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Time Clock</h1>
        <p>Please log in first.</p>
        <Link href="/">Back to Home</Link>
      </div>
    );
  }

  const statusLabel = openShift ? "ON SHIFT" : "OFF SHIFT";

  return (
    <div style={{ padding: 20, background: theme.colors.background, minHeight: "100vh" }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{ marginBottom: 10 }}>Time Clock</h1>

        <div
          style={{
            marginBottom: 14,
            fontSize: 15,
            color: "#333",
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 10,
            padding: "12px 14px",
          }}
        >
          Logged in as: <b>{userName}</b> | Role: <b>{role}</b>
        </div>

        <div
          style={{
            marginBottom: 14,
            fontSize: 15,
            color: "#333",
            background: isStoreDevice ? "#ecfdf5" : "#fff7ed",
            border: `1px solid ${isStoreDevice ? "#bbf7d0" : "#fed7aa"}`,
            borderRadius: 10,
            padding: "12px 14px",
          }}
        >
        </div>

        <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
          <Link href="/staff/home">
            <button
              style={{
                padding: "10px 16px",
                borderRadius: 8,
                border: "1px solid #d1d5db",
                background: "#fff",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Back to Home
            </button>
          </Link>
        </div>

        <div
          style={{
            maxWidth: 560,
            border: "1px solid #e5e7eb",
            borderRadius: 16,
            padding: 22,
            background: "#ffffff",
            boxShadow: "0 8px 24px rgba(0,0,0,0.06)",
          }}
        >
          <div
            style={{
              marginBottom: 18,
              fontSize: 18,
              fontWeight: 700,
            }}
          >
            Status:{" "}
            <span
              style={{
                color: openShift ? "#15803d" : "#6b7280",
              }}
            >
              {statusLabel}
            </span>
          </div>

          {!canUseClock ? (
            <p style={{ margin: 0 }}>You do not have access to Time Clock.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <button
                onClick={clockIn}
                disabled={loading || !!openShift || !canOperateClock || storeAccessLoading}
                style={{
                  width: "100%",
                  padding: "18px 20px",
                  fontSize: 22,
                  fontWeight: 800,
                  borderRadius: 14,
                  border: "none",
                  background:
                    loading || !!openShift || !canOperateClock || storeAccessLoading
                      ? "#93c5fd"
                      : theme.colors.primary,
                  color: "#fff",
                  cursor:
                    loading || !!openShift || !canOperateClock || storeAccessLoading
                      ? "not-allowed"
                      : "pointer",
                  boxShadow: "0 6px 16px rgba(37,99,235,0.25)",
                }}
              >
                {loading && !openShift ? "Processing..." : "CLOCK IN"}
              </button>

              <button
                onClick={clockOut}
                disabled={loading || !openShift || !canOperateClock || storeAccessLoading}
                style={{
                  width: "100%",
                  padding: "18px 20px",
                  fontSize: 22,
                  fontWeight: 800,
                  borderRadius: 14,
                  border: "none",
                  background:
                    loading || !openShift || !canOperateClock || storeAccessLoading
                      ? "#fca5a5"
                      : theme.colors.danger,
                  color: "#fff",
                  cursor:
                    loading || !openShift || !canOperateClock || storeAccessLoading
                      ? "not-allowed"
                      : "pointer",
                  boxShadow: "0 6px 16px rgba(220,38,38,0.22)",
                }}
              >
                {loading && !!openShift ? "Processing..." : "CLOCK OUT"}
              </button>

              {!storeAccessLoading && !isStoreDevice && (
                <div
                  style={{
                    marginTop: 4,
                    padding: "12px 14px",
                    borderRadius: 10,
                    background: "#fff7ed",
                    border: "1px solid #fed7aa",
                    color: "#9a3412",
                    fontSize: 14,
                    lineHeight: 1.5,
                  }}
                >
                  You can view this page anywhere, but time clock actions are locked outside the store network.
                </div>
              )}
            </div>
          )}
        </div>

        {msg && (
          <div
            style={{
              marginTop: 14,
              maxWidth: 560,
              padding: "12px 14px",
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: 10,
              color: "#333",
            }}
          >
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}
