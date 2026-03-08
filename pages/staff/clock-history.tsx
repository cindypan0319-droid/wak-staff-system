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

type ProfileRow = {
  full_name: string | null;
  preferred_name: string | null;
  role: Role | null;
  is_active: boolean | null;
};

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

function displayName(profile: ProfileRow | null) {
  if (!profile) return "Unknown";
  const preferred = (profile.preferred_name ?? "").trim();
  const full = (profile.full_name ?? "").trim();
  return preferred || full || "Unknown";
}

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
  return ms / 3600000;
}

export default function StaffClockHistoryPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>("Unknown");
  const [role, setRole] = useState<Role>("ANON");

  const [rows, setRows] = useState<TimeClockRow[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const canView = useMemo(() => {
    return role === "STAFF" || role === "MANAGER" || role === "OWNER";
  }, [role]);

  const openCount = useMemo(() => {
    return rows.filter((r) => !!r.clock_in_at && !r.clock_out_at).length;
  }, [rows]);

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

  async function loadHistory() {
    setLoading(true);
    setMsg("");
    try {
      if (!userId) {
        setMsg("Not logged in.");
        setRows([]);
        return;
      }

      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

      const { data, error } = await supabase
        .from("time_clock")
        .select("id, staff_id, shift_id, clock_in_at, clock_out_at, device_tag, created_at")
        .eq("staff_id", userId)
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
  }, [canView, userId]);

  function actionButton(
    label: string,
    onClick: () => void,
    options?: { primary?: boolean; disabled?: boolean }
  ) {
    const primary = options?.primary;
    const disabled = options?.disabled;

    return (
      <button
        onClick={onClick}
        disabled={disabled}
        style={{
          padding: "12px 16px",
          minHeight: 46,
          borderRadius: 12,
          border: `1px solid ${primary ? WAK_BLUE : BORDER}`,
          background: disabled ? "#D1D5DB" : primary ? WAK_BLUE : "#fff",
          color: "#fff" === (disabled ? "#fff" : primary ? "#fff" : TEXT) ? "#fff" : TEXT,
          fontWeight: 800,
          fontSize: 15,
          cursor: disabled ? "not-allowed" : "pointer",
          boxShadow: primary ? "0 8px 18px rgba(0,0,0,0.10)" : "none",
        }}
      >
        {label}
      </button>
    );
  }

  function infoCard(label: string, value: string, color?: string) {
    return (
      <div
        style={{
          padding: "10px 12px",
          borderRadius: 12,
          background: "#F9FAFB",
          border: `1px solid ${BORDER}`,
          minWidth: 150,
        }}
      >
        <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
        <div style={{ fontWeight: 800, fontSize: 18, color: color || TEXT }}>{value}</div>
      </div>
    );
  }

  function statusBadge(open: boolean) {
    return (
      <span
        style={{
          display: "inline-block",
          padding: "6px 10px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 800,
          background: open ? "#FEF3C7" : "#DCFCE7",
          color: open ? "#92400E" : "#166534",
        }}
      >
        {open ? "OPEN" : "CLOSED"}
      </span>
    );
  }

  if (!userId) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 16,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ marginTop: 0, color: TEXT }}>Clock History</h1>
            <p style={{ color: MUTED }}>Please log in first.</p>
            <Link href="/">
              <button
                style={{
                  padding: "12px 16px",
                  minHeight: 46,
                  borderRadius: 12,
                  border: `1px solid ${BORDER}`,
                  background: "#fff",
                  color: TEXT,
                  fontWeight: 800,
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                Back to Home
              </button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (!canView) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 16,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ marginTop: 0, color: TEXT }}>Clock History</h1>
            <p style={{ color: MUTED }}>You do not have access to this page.</p>
            <Link href="/">
              <button
                style={{
                  padding: "12px 16px",
                  minHeight: 46,
                  borderRadius: 12,
                  border: `1px solid ${BORDER}`,
                  background: "#fff",
                  color: TEXT,
                  fontWeight: 800,
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                Back to Home
              </button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 18,
          }}
        >
          <div>
            <h1 style={{ margin: 0, color: TEXT }}>Clock History</h1>
            <div style={{ marginTop: 6, color: MUTED }}>
              Your clock records from the last 7 days
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <Link href="/staff/home">
              <button
                style={{
                  padding: "12px 16px",
                  minHeight: 46,
                  borderRadius: 12,
                  border: `1px solid ${BORDER}`,
                  background: "#fff",
                  color: TEXT,
                  fontWeight: 800,
                  fontSize: 15,
                  cursor: "pointer",
                }}
              >
                ← Back to Home
              </button>
            </Link>

            {actionButton("Refresh", loadHistory, { disabled: loading })}
          </div>
        </div>

        <div
          style={{
            marginBottom: 16,
            fontSize: 15,
            color: "#333",
            background: "#fff",
            border: `1px solid ${BORDER}`,
            borderRadius: 12,
            padding: "12px 14px",
          }}
        >
          Logged in as: <b>{userName}</b> | Role: <b>{role}</b>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          {infoCard("Total records", String(rows.length))}
          {infoCard("Open shifts", String(openCount), openCount > 0 ? WAK_RED : "#166534")}
        </div>

        {msg && (
          <div
            style={{
              border: `1px solid ${BORDER}`,
              background: "#fff",
              padding: "12px 14px",
              borderRadius: 12,
              marginBottom: 16,
              color: TEXT,
            }}
          >
            {msg}
          </div>
        )}

        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 16,
            background: CARD_BG,
            padding: 18,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ overflowX: "auto" }}>
            <table
              cellPadding={0}
              style={{
                width: "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
                minWidth: 900,
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "14px 12px",
                      borderBottom: `1px solid ${BORDER}`,
                      color: MUTED,
                      fontSize: 13,
                    }}
                  >
                    Clock In
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "14px 12px",
                      borderBottom: `1px solid ${BORDER}`,
                      color: MUTED,
                      fontSize: 13,
                    }}
                  >
                    Clock Out
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "14px 12px",
                      borderBottom: `1px solid ${BORDER}`,
                      color: MUTED,
                      fontSize: 13,
                    }}
                  >
                    Duration (hours)
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "14px 12px",
                      borderBottom: `1px solid ${BORDER}`,
                      color: MUTED,
                      fontSize: 13,
                    }}
                  >
                    Status
                  </th>
                  <th
                    style={{
                      textAlign: "left",
                      padding: "14px 12px",
                      borderBottom: `1px solid ${BORDER}`,
                      color: MUTED,
                      fontSize: 13,
                    }}
                  >
                    Device
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        padding: "18px 12px",
                        color: MUTED,
                        borderBottom: `1px solid ${BORDER}`,
                      }}
                    >
                      No records in last 7 days.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => {
                    const h = hoursBetween(r.clock_in_at, r.clock_out_at);
                    const open = !!r.clock_in_at && !r.clock_out_at;

                    return (
                      <tr key={r.id} style={{ background: open ? "#FFF8E1" : "#fff" }}>
                        <td
                          style={{
                            padding: "14px 12px",
                            borderBottom: `1px solid ${BORDER}`,
                            color: TEXT,
                          }}
                        >
                          {fmt(r.clock_in_at)}
                        </td>
                        <td
                          style={{
                            padding: "14px 12px",
                            borderBottom: `1px solid ${BORDER}`,
                            color: TEXT,
                          }}
                        >
                          {fmt(r.clock_out_at)}
                        </td>
                        <td
                          style={{
                            padding: "14px 12px",
                            borderBottom: `1px solid ${BORDER}`,
                            color: TEXT,
                            fontWeight: 700,
                          }}
                        >
                          {h === null ? "-" : h.toFixed(2)}
                        </td>
                        <td
                          style={{
                            padding: "14px 12px",
                            borderBottom: `1px solid ${BORDER}`,
                          }}
                        >
                          {statusBadge(open)}
                        </td>
                        <td
                          style={{
                            padding: "14px 12px",
                            borderBottom: `1px solid ${BORDER}`,
                            color: TEXT,
                          }}
                        >
                          {r.device_tag ?? "-"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <p style={{ marginTop: 14, fontSize: 12, color: MUTED }}>
            This page only shows your own records.
          </p>
        </div>
      </div>
    </div>
  );
}