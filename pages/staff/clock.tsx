import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";
import { theme } from "../../lib/theme";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;

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

  const [openShift, setOpenShift] = useState<TimeClockRow | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const canUseClock = useMemo(() => {
    return role === "STAFF" || role === "MANAGER" || role === "OWNER";
  }, [role]);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUserId(session?.user?.id ?? null);
      setMsg("");
    });

    supabase.auth.getSession().then(({ data }) => {
      setUserId(data.session?.user?.id ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function loadProfile() {
      if (!userId) {
        setRole("ANON");
        setUserName("Unknown");
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("full_name, preferred_name, role, is_active")
        .eq("id", userId)
        .maybeSingle();

      if (error) {
        console.log("profiles load error:", error);
        setRole("ANON");
        setUserName("Unknown");
        return;
      }

      const profile = (data as ProfileRow | null) ?? null;

      setUserName(displayName(profile));

      if (!profile?.is_active) {
        setRole("INACTIVE");
        return;
      }

      setRole((profile?.role as Role) ?? "ANON");
    }

    loadProfile();
  }, [userId]);

  async function refresh() {
    setMsg("");
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

  async function clockIn() {
    setMsg("");
    setLoading(true);
    try {
      if (!userId) {
        setMsg("Not logged in.");
        return;
      }

      if (openShift) {
        setMsg("You are already clocked in.");
        return;
      }

      const payload = {
        staff_id: userId,
        shift_id: null as any,
        clock_in_at: new Date().toISOString(),
        clock_out_at: null,
        device_tag: "web",
      };

      const { error } = await supabase
        .from("time_clock")
        .insert([payload], { returning: "minimal" } as any);

      if (error) {
        setMsg("Clock in failed: " + error.message);
        return;
      }

      setMsg("Clocked in.");
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  async function clockOut() {
    setMsg("");
    setLoading(true);
    try {
      if (!openShift) {
        setMsg("No open shift found.");
        return;
      }

      const { error } = await supabase
        .from("time_clock")
        .update({ clock_out_at: new Date().toISOString() })
        .eq("id", openShift.id);

      if (error) {
        setMsg("Clock out failed: " + error.message);
        return;
      }

      setMsg("Clocked out.");
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  if (!userId) {
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
                disabled={loading || !!openShift}
                style={{
                  width: "100%",
                  padding: "18px 20px",
                  fontSize: 22,
                  fontWeight: 800,
                  borderRadius: 14,
                  border: "none",
                  background: loading || !!openShift ? "#93c5fd" : theme.colors.primary,
                  color: "#fff",
                  cursor: loading || !!openShift ? "not-allowed" : "pointer",
                  boxShadow: "0 6px 16px rgba(37,99,235,0.25)",
                }}
              >
                {loading && !openShift ? "Processing..." : "CLOCK IN"}
              </button>

              <button
                onClick={clockOut}
                disabled={loading || !openShift}
                style={{
                  width: "100%",
                  padding: "18px 20px",
                  fontSize: 22,
                  fontWeight: 800,
                  borderRadius: 14,
                  border: "none",
                  background: loading || !openShift ? "#fca5a5" : theme.colors.danger,
                  color: "#fff",
                  cursor: loading || !openShift ? "not-allowed" : "pointer",
                  boxShadow: "0 6px 16px rgba(220,38,38,0.22)",
                }}
              >
                {loading && !!openShift ? "Processing..." : "CLOCK OUT"}
              </button>
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