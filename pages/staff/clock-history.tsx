import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;

type TimeClockRow = {
  id: number;
  staff_id: string;
  shift_id?: number | null;
  clock_in_at: string | null;
  clock_out_at: string | null;
  device_tag?: string | null;
  created_at?: string | null;
};

function fmt(dt: string | null) {
  if (!dt) return "-";
  const d = new Date(dt);
  if (isNaN(d.getTime())) return dt;
  return d.toLocaleString();
}

function hoursBetween(a: string | null, b: string | null) {
  if (!a) return null;
  const t1 = new Date(a).getTime();
  const t2 = b ? new Date(b).getTime() : Date.now();
  if (!isFinite(t1) || !isFinite(t2)) return null;
  const ms = Math.max(0, t2 - t1);
  const h = ms / 3600000;
  return h;
}

export default function StaffClockHistoryPage() {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("ANON");

  const [rows, setRows] = useState<TimeClockRow[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const canView = useMemo(() => {
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

  async function loadHistory() {
    setLoading(true);
    setMsg("");
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData.session?.user?.id;
      if (!uid) {
        setMsg("Not logged in.");
        setRows([]);
        return;
      }

      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

      // NOTE: 只按 staff_id + 最近 7 天查询
      // 这里不假设你一定有 store_id 这列（你之前报错就是缺这个列）
      const { data, error } = await supabase
        .from("time_clock")
        .select("id, staff_id, shift_id, clock_in_at, clock_out_at, device_tag, created_at")
        .eq("staff_id", uid)
        .gte("clock_in_at", since)
        .order("clock_in_at", { ascending: false });

      if (error) {
        console.log("loadHistory error:", error);
        setMsg("Cannot load history: " + error.message);
        setRows([]);
        return;
      }

      setRows(((data as any) ?? []) as TimeClockRow[]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (canView) loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);

  if (!userEmail) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Clock History</h1>
        <p>Please log in first.</p>
        <Link href="/">Back to Home</Link>
      </div>
    );
  }

  if (!canView) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Clock History</h1>
        <p>You do not have access to this page.</p>
        <Link href="/">Back to Home</Link>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Staff — Clock History (Last 7 Days)</h1>

      <div style={{ marginBottom: 8 }}>
        Logged in as: <b>{userEmail}</b> | Role: <b>{role}</b>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
        <Link href="/staff/clock">
          <button>Back to Time Clock</button>
        </Link>
        <button onClick={loadHistory} disabled={loading}>
          Refresh
        </button>
      </div>

      {msg && (
        <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>
          {msg}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table cellPadding={8} style={{ borderCollapse: "collapse", minWidth: 920 }}>
          <thead>
            <tr>
              <th style={{ border: "1px solid #ccc" }}>Clock In</th>
              <th style={{ border: "1px solid #ccc" }}>Clock Out</th>
              <th style={{ border: "1px solid #ccc" }}>Duration (hours)</th>
              <th style={{ border: "1px solid #ccc" }}>Status</th>
              <th style={{ border: "1px solid #ccc" }}>Device</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ border: "1px solid #ccc", color: "#666" }}>
                  No records in last 7 days.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const h = hoursBetween(r.clock_in_at, r.clock_out_at);
                const open = !!r.clock_in_at && !r.clock_out_at;
                return (
                  <tr key={r.id} style={{ background: open ? "#fff8e1" : undefined }}>
                    <td style={{ border: "1px solid #ccc" }}>{fmt(r.clock_in_at)}</td>
                    <td style={{ border: "1px solid #ccc" }}>{fmt(r.clock_out_at)}</td>
                    <td style={{ border: "1px solid #ccc" }}>
                      {h === null ? "-" : h.toFixed(2)}
                    </td>
                    <td style={{ border: "1px solid #ccc", fontWeight: 800 }}>
                      {open ? "OPEN" : "CLOSED"}
                    </td>
                    <td style={{ border: "1px solid #ccc" }}>{r.device_tag ?? "-"}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
        This page only shows your own records.
      </p>
    </div>
  );
}