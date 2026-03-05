import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type ShiftRow = {
  id: number;
  store_id: string;
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes: number; // keep (DB has it), but we do not show/use it
  week_start: string | null;
};

const dayLabels = ["THU", "FRI", "SAT", "SUN", "MON", "TUE", "WED"] as const;

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
  // ✅ 24-hour
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtHeaderDate(d: Date) {
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

function dayIndexFromISO(iso: string) {
  const d = new Date(iso);
  const dow = d.getDay(); // 0 Sun ... 4 Thu
  const map: Record<number, number> = { 4: 0, 5: 1, 6: 2, 0: 3, 1: 4, 2: 5, 3: 6 };
  return map[dow];
}

// ✅ paid break: do NOT subtract break minutes
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

function getNextWeekThuISO() {
  const now = new Date();
  const dow = now.getDay();
  const diffToThu = (dow - 4 + 7) % 7;
  const thisThu = new Date(now);
  thisThu.setHours(0, 0, 0, 0);
  thisThu.setDate(now.getDate() - diffToThu);
  const nextThu = new Date(thisThu);
  nextThu.setDate(thisThu.getDate() + 7);
  return toISODate(nextThu);
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
    setMsg("");

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

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 12 }}>
        <button onClick={() => (window.location.href = "/staff/home")}>← Back to Home</button>
      </div>

      <h1>My Roster — Next Week (Thu → Wed)</h1>

      <div style={{ marginBottom: 10 }}>
        Week (Thu→Wed):{" "}
        <button onClick={() => setWeekStart((w) => addDaysISO(w, -7))}>← Prev Week</button>
        <button onClick={() => setWeekStart(getThisWeekThuISO())} style={{ marginLeft: 8 }}>
          This Week
        </button>
        <button onClick={() => setWeekStart((w) => addDaysISO(w, 7))} style={{ marginLeft: 8 }}>
          Next →
        </button>

        <input type="date" value={weekStart} readOnly style={{ marginLeft: 8 }} />

        <span style={{ marginLeft: 12, color: "#666", fontWeight: 700 }}>{weekRangeText(weekStart)}</span>

        <button onClick={loadMyShifts} style={{ marginLeft: 8 }}>
          Refresh
        </button>

        <span style={{ marginLeft: 12, fontWeight: 800 }}>Status: {isPublished ? "PUBLISHED" : "DRAFT"}</span>
      </div>

      {msg && <div style={{ marginBottom: 10 }}>{msg}</div>}

      {isPublished && (
        <div style={{ marginBottom: 10, color: "#666" }}>
          Week total hours: <b>{weekTotalHours.toFixed(2)}h</b>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        {dayLabels.map((label, i) => {
          const list = grid[i] ?? [];
          return (
            <div key={label} style={{ border: "1px solid #ddd", borderRadius: 14, padding: 12 }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>{label}</div>
              <div style={{ fontSize: 12, color: "#444", marginTop: 2 }}>{fmtHeaderDate(dayDates[i])}</div>



              <div style={{ marginTop: 10 }}>
                {!isPublished ? (
                  <div style={{ color: "#999" }}>Hidden until published</div>
                ) : list.length === 0 ? (
                  <div style={{ color: "#999" }}>No shifts</div>
                ) : (
                  list.map((r) => {
                    const h = hoursBetween(r.shift_start, r.shift_end);
                    return (
                      <div key={r.id} style={{ padding: "10px 0", borderTop: "1px dashed #eee" }}>
                        <div style={{ fontWeight: 900 }}>
                          {fmtTime(r.shift_start)}–{fmtTime(r.shift_end)}
                        </div>
                        <div style={{ fontSize: 12, color: "#666" }}>{h.toFixed(2)}h</div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}