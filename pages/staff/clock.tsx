import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

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

export default function StaffClockPage() {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("ANON");
  const [msg, setMsg] = useState<string>("");

  const [openShift, setOpenShift] = useState<TimeClockRow | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  const canUseClock = useMemo(() => {
    return role === "STAFF" || role === "MANAGER" || role === "OWNER";
  }, [role]);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUserEmail(session?.user?.email ?? null);
      setMsg("");
    });

    supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user?.email ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function loadRole() {
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData.session?.user?.id;
      if (!uid) {
        setRole("ANON");
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("role, is_active")
        .eq("id", uid)
        .maybeSingle();

      if (error) {
        console.log("profiles load error:", error);
        setRole("ANON");
        return;
      }

      if (!data?.is_active) {
        setRole("INACTIVE");
        return;
      }

      setRole((data?.role as Role) ?? "ANON");
    }

    loadRole();
  }, [userEmail]);

  async function refresh() {
    setMsg("");
    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData.session?.user?.id;
      if (!uid) {
        setOpenShift(null);
        setMsg("Not logged in.");
        return;
      }

      // ✅ Find current open shift (clock_out_at is null) for this user
      const { data, error } = await supabase
        .from("time_clock")
        .select("*")
        .eq("staff_id", uid)
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

      setOpenShift((data as any) ?? null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canUseClock) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canUseClock]);

  async function clockIn() {
    setMsg("");
    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData.session?.user?.id;
      if (!uid) {
        setMsg("Not logged in.");
        return;
      }

      // prevent double clock-in if already on shift
      if (openShift) {
        setMsg("You are already clocked in.");
        return;
      }

      const payload = {
        staff_id: uid,
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

  if (!userEmail) {
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
    <div style={{ padding: 20 }}>
      <h1>Time Clock</h1>

      <div style={{ marginBottom: 8 }}>
        Logged in as: <b>{userEmail}</b> | Role: <b>{role}</b>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <Link href="/staff/home">
          <button>Back to Home</button>
        </Link>
        <button onClick={refresh} disabled={loading || !canUseClock}>
          Refresh <Link href="/staff/clock-history">
                    <button>My Clock History</button>
                  </Link>
        </button>
      </div>

      <hr style={{ margin: "16px 0" }} />

      {!canUseClock ? (
        <p>You do not have access to Time Clock.</p>
      ) : (
        <div style={{ maxWidth: 520 }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 16, background: "#fafafa" }}>
            <div style={{ marginBottom: 12 }}>
              Status: <b style={{ color: openShift ? "#0a0" : "#888" }}>{statusLabel}</b>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={clockIn} disabled={loading || !!openShift}>
                Clock In
              </button>
              <button onClick={clockOut} disabled={loading || !openShift}>
                Clock Out
              </button>
            </div>
          </div>
        </div>
      )}

      {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
    </div>
  );
}