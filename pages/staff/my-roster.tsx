import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type ShiftRow = {
  id: number;
  store_id: string;
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes: number;
  week_start: string | null;
};

const dayLabels = ["THU", "FRI", "SAT", "SUN", "MON", "TUE", "WED"] as const;

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

function toISODate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysISO(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function weekRangeText(weekStartISO: string) {
  const start = new Date(weekStartISO + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  return `${fmt(start)} → ${fmt(end)}`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtHeaderDate(d: Date) {
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

function dayIndexFromISO(iso: string) {
  const d = new Date(iso);
  const dow = d.getDay();
  const map: Record<number, number> = { 4: 0, 5: 1, 6: 2, 0: 3, 1: 4, 2: 5, 3: 6 };
  return map[dow];
}

function hoursBetween(startISO: string, endISO: string) {
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  const hrs = ms / 3600000;
  return Math.max(0, hrs);
}

function getThisWeekThuISO() {
  const now = new Date();
  const dow = now.getDay();
  const diffToThu = (dow - 4 + 7) % 7;

  const thisThu = new Date(now);
  thisThu.setHours(0, 0, 0, 0);
  thisThu.setDate(now.getDate() - diffToThu);

  return toISODate(thisThu);
}

function isSameISODate(a: string, b: string) {
  return a === b;
}

export default function MyRosterNextWeek() {
  const [storeId] = useState("MOOROOLBARK");
  const [uid, setUid] = useState<string | null>(null);

  const [weekStart, setWeekStart] = useState(() => getThisWeekThuISO());

  const range = useMemo(() => {
    const start = new Date(weekStart + "T00:00:00");
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end };
  }, [weekStart]);

  const dayDates = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(range.start);
      d.setDate(d.getDate() + i);
      d.setHours(0, 0, 0, 0);
      return d;
    });
  }, [range.start]);

  const [rows, setRows] = useState<ShiftRow[]>([]);
  const [msg, setMsg] = useState("");
  const [isPublished, setIsPublished] = useState(false);
  const [loading, setLoading] = useState(false);

  async function ensureLogin() {
    const { data } = await supabase.auth.getUser();
    const id = data.user?.id ?? null;
    if (!id) {
      window.location.href = "/";
      return;
    }
    setUid(id);
  }

  async function loadPublishedStatus() {
    const r = await supabase
      .from("roster_weeks")
      .select("published")
      .eq("store_id", storeId)
      .eq("week_start", weekStart)
      .maybeSingle();

    if (r.error) {
      console.log(r.error);
      setIsPublished(false);
      return false;
    }

    const pub = !!r.data?.published;
    setIsPublished(pub);
    return pub;
  }

  async function loadMyShifts() {
    if (!uid) return;

    setLoading(true);
    setMsg("");

    try {
      const pub = await loadPublishedStatus();

      if (!pub) {
        setRows([]);
        setMsg("Roster not published yet. Please check later.");
        return;
      }

      const r = await supabase
        .from("shifts")
        .select("id, store_id, staff_id, shift_start, shift_end, break_minutes, week_start")
        .eq("store_id", storeId)
        .eq("staff_id", uid)
        .gte("shift_start", range.start.toISOString())
        .lt("shift_start", range.end.toISOString())
        .order("shift_start", { ascending: true });

      if (r.error) {
        setMsg("❌ Cannot load your roster: " + r.error.message);
        setRows([]);
        return;
      }

      setRows((r.data ?? []) as any);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    ensureLogin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!uid) return;
    loadMyShifts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, weekStart]);

  const grid = useMemo(() => {
    const g: ShiftRow[][] = Array.from({ length: 7 }, () => []);
    rows.forEach((r) => {
      const idx = dayIndexFromISO(r.shift_start);
      g[idx].push(r);
    });
    return g;
  }, [rows]);

  const dailyTotals = useMemo(() => {
    const totals = Array.from({ length: 7 }, () => ({ hours: 0 }));
    for (const r of rows) {
      const idx = dayIndexFromISO(r.shift_start);
      totals[idx].hours += hoursBetween(r.shift_start, r.shift_end);
    }
    return totals;
  }, [rows]);

  const weekTotalHours = dailyTotals.reduce((s, x) => s + x.hours, 0);

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
          color: primary || disabled ? "#fff" : TEXT,
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
          minWidth: 160,
        }}
      >
        <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
        <div style={{ fontWeight: 800, fontSize: 18, color: color || TEXT }}>{value}</div>
      </div>
    );
  }

  function statusBadge(published: boolean) {
    return (
      <span
        style={{
          display: "inline-block",
          padding: "7px 11px",
          borderRadius: 999,
          fontSize: 12,
          fontWeight: 800,
          background: published ? "#DCFCE7" : "#FEF3C7",
          color: published ? "#166534" : "#92400E",
        }}
      >
        {published ? "PUBLISHED" : "DRAFT"}
      </span>
    );
  }

  const todayISO = toISODate(new Date());

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
            <h1 style={{ margin: 0, color: TEXT }}>My Roster</h1>
            <div style={{ marginTop: 6, color: MUTED }}>
              Your shifts for this week (Thu → Wed)
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => (window.location.href = "/staff/home")}
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

            {actionButton("Refresh", loadMyShifts, { disabled: loading })}
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 16,
            background: CARD_BG,
            padding: 18,
            marginBottom: 16,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-end",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Week range</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: TEXT }}>{weekRangeText(weekStart)}</div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {actionButton("← Prev Week", () => setWeekStart((w) => addDaysISO(w, -7)), {
                disabled: loading,
              })}
              {actionButton("This Week", () => setWeekStart(getThisWeekThuISO()), {
                primary: true,
                disabled: loading,
              })}
              {actionButton("Next →", () => setWeekStart((w) => addDaysISO(w, 7)), {
                disabled: loading,
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
            {infoCard("Week start", weekStart)}
            {infoCard("Week total hours", isPublished ? `${weekTotalHours.toFixed(2)}h` : "-")}
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "#F9FAFB",
                border: `1px solid ${BORDER}`,
                minWidth: 160,
              }}
            >
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Roster status</div>
              {statusBadge(isPublished)}
            </div>
          </div>
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
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 14,
          }}
        >
          {dayLabels.map((label, i) => {
            const list = grid[i] ?? [];
            const dateISO = toISODate(dayDates[i]);
            const isToday = isSameISODate(dateISO, todayISO);
            const dayTotal = dailyTotals[i]?.hours ?? 0;

            return (
              <div
                key={label}
                style={{
                  border: `1px solid ${isToday ? WAK_BLUE : BORDER}`,
                  borderRadius: 16,
                  padding: 14,
                  background: isToday ? "#F7FBFF" : "#fff",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "start" }}>
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 16, color: TEXT }}>{label}</div>
                    <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{fmtHeaderDate(dayDates[i])}</div>
                  </div>

                  {isToday && (
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        color: WAK_BLUE,
                        background: "#EAF3FF",
                        borderRadius: 999,
                        padding: "5px 8px",
                      }}
                    >
                      TODAY
                    </div>
                  )}
                </div>

                <div style={{ marginTop: 10, marginBottom: 12, fontSize: 12, color: MUTED }}>
                  Day total: <b style={{ color: TEXT }}>{isPublished ? `${dayTotal.toFixed(2)}h` : "-"}</b>
                </div>

                {!isPublished ? (
                  <div
                    style={{
                      color: "#999",
                      border: "1px dashed #D1D5DB",
                      borderRadius: 12,
                      padding: 12,
                      background: "#FAFAFA",
                      fontSize: 14,
                    }}
                  >
                    Hidden until published
                  </div>
                ) : list.length === 0 ? (
                  <div
                    style={{
                      color: "#999",
                      border: "1px dashed #D1D5DB",
                      borderRadius: 12,
                      padding: 12,
                      background: "#FAFAFA",
                      fontSize: 14,
                    }}
                  >
                    No shifts
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {list.map((r) => {
                      const h = hoursBetween(r.shift_start, r.shift_end);
                      return (
                        <div
                          key={r.id}
                          style={{
                            padding: 12,
                            borderRadius: 12,
                            border: `1px solid ${BORDER}`,
                            background: "#FAFAFA",
                          }}
                        >
                          <div style={{ fontWeight: 900, fontSize: 16, color: TEXT }}>
                            {fmtTime(r.shift_start)}–{fmtTime(r.shift_end)}
                          </div>
                          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                            {h.toFixed(2)}h
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}