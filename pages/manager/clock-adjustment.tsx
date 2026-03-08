import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Range = { startISO: string; endISO: string };

type Shift = {
  id: number;
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes?: number | null;
  hourly_rate?: number | null;
};

type TimeClock = {
  id: number;
  shift_id: number | null;
  staff_id: string;
  clock_in_at: string | null;
  clock_out_at: string | null;

  adjusted_clock_in_at?: string | null;
  adjusted_clock_out_at?: string | null;
  adjusted_reason?: string | null;
  adjusted_by?: string | null;
  adjusted_at?: string | null;
};

type Profile = {
  id: string;
  full_name: string | null;
  role?: string | null;
  is_active?: boolean | null;
};

type StaffPayRate = {
  id?: any;
  staff_id: string;
  weekday_rate?: number | null;
  saturday_rate?: number | null;
  sunday_rate?: number | null;
  store_id?: string | null;
};

type DayType = "WEEKDAY" | "SATURDAY" | "SUNDAY";

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

function fmtAU(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);

  const date = d.toLocaleDateString("en-AU", {
    timeZone: "Australia/Melbourne",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const time = d.toLocaleTimeString("en-AU", {
    timeZone: "Australia/Melbourne",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return `${date}, ${time}`;
}

function money(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function minutesBetween(aISO: string | null | undefined, bISO: string | null | undefined) {
  if (!aISO || !bISO) return null;
  const a = new Date(aISO).getTime();
  const b = new Date(bISO).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 60000));
}

function addDays(dateStr: string, days: number) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function buildRange(fromDate: string, toDate: string): Range {
  const startISO = new Date(`${fromDate}T00:00:00`).toISOString();
  const endISO = addDays(toDate, 1);
  return { startISO, endISO };
}

function todayDateInputValue() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getDayTypeByISO(iso: string): DayType {
  const d = new Date(iso);
  const day = d.getDay();
  if (day === 0) return "SUNDAY";
  if (day === 6) return "SATURDAY";
  return "WEEKDAY";
}

function toLocalInputValue(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

function actionButton(
  label: string,
  onClick: () => void,
  options?: { primary?: boolean; danger?: boolean; disabled?: boolean }
) {
  const primary = options?.primary;
  const danger = options?.danger;
  const disabled = options?.disabled;

  let bg = "#fff";
  let borderColor = BORDER;
  let textColor = TEXT;

  if (primary) {
    bg = WAK_BLUE;
    borderColor = WAK_BLUE;
    textColor = "#fff";
  }

  if (danger) {
    bg = WAK_RED;
    borderColor = WAK_RED;
    textColor = "#fff";
  }

  if (disabled) {
    bg = "#D1D5DB";
    borderColor = "#D1D5DB";
    textColor = "#fff";
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "12px 16px",
        minHeight: 46,
        borderRadius: 12,
        border: `1px solid ${borderColor}`,
        background: bg,
        color: textColor,
        fontWeight: 800,
        fontSize: 15,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: primary || danger ? "0 8px 18px rgba(0,0,0,0.10)" : "none",
        whiteSpace: "nowrap",
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

function badge(label: string, options?: { kind?: "blue" | "green" | "yellow" | "gray" | "red" }) {
  const kind = options?.kind ?? "gray";

  const styles: Record<string, { bg: string; color: string }> = {
    blue: { bg: "#EAF3FF", color: WAK_BLUE },
    green: { bg: "#DCFCE7", color: "#166534" },
    yellow: { bg: "#FEF3C7", color: "#92400E" },
    gray: { bg: "#F3F4F6", color: "#374151" },
    red: { bg: "#FEE2E2", color: "#991B1B" },
  };

  return (
    <span
      style={{
        display: "inline-block",
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        background: styles[kind].bg,
        color: styles[kind].color,
      }}
    >
      {label}
    </span>
  );
}

function inputStyle(width?: number | string) {
  return {
    width: width ?? "100%",
    maxWidth: "100%",
    boxSizing: "border-box" as const,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #D1D5DB",
    fontSize: 14,
    background: "#fff",
    color: TEXT,
  };
}

function getRowBackground(alerts: { label: string; kind: "red" | "yellow" | "blue" | "gray" }[]) {
  const labels = alerts.map((a) => a.label);

  if (labels.includes("OPEN CLOCK")) {
    return "#FEF2F2"; // light red
  }

  if (labels.includes("CROSSES MIDNIGHT") || labels.includes("LONG SHIFT")) {
    return "#FFFBEA"; // light yellow
  }

  if (labels.includes("POSSIBLE COVER SHIFT")) {
    return "#EFF6FF"; // light blue
  }

  return "#FFFFFF";
}

export default function ClockAdjustmentPage() {
  const [authLoading, setAuthLoading] = useState(true);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const isManagerOrOwner = viewerRole === "OWNER" || viewerRole === "MANAGER";

  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const topInnerRef = useRef<HTMLDivElement | null>(null);
  const syncingRef = useRef(false);

  async function loadPermission() {
    setAuthLoading(true);
    const { data } = await supabase.auth.getUser();
    const user = data?.user;

    if (!user) {
      window.location.href = "/";
      return;
    }

    setViewerId(user.id);

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    if (error) {
      setViewerRole(null);
      setAuthLoading(false);
      return;
    }

    setViewerRole((profile as any)?.role ?? null);
    setAuthLoading(false);
  }

  useEffect(() => {
    loadPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [fromDate, setFromDate] = useState<string>(todayDateInputValue());
  const [toDate, setToDate] = useState<string>(todayDateInputValue());
  const [selectedStaffId, setSelectedStaffId] = useState<string>("ALL");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [clocks, setClocks] = useState<TimeClock[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [payRates, setPayRates] = useState<StaffPayRate[]>([]);

  const [editIn, setEditIn] = useState<Record<number, string>>({});
  const [editOut, setEditOut] = useState<Record<number, string>>({});
  const [editReason, setEditReason] = useState<Record<number, string>>({});

  const nameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of profiles) {
      if (p?.id) map[p.id] = p.full_name ?? p.id;
    }
    return map;
  }, [profiles]);

  function staffLabel(staffId: string) {
    return nameById[staffId] ?? staffId;
  }

  const payRateByStaffId = useMemo(() => {
    const map: Record<string, StaffPayRate> = {};
    for (const r of payRates) {
      if (r?.staff_id) map[r.staff_id] = r;
    }
    return map;
  }, [payRates]);

  function rateFor(staffId: string, dayType: DayType): number | null {
    const r = payRateByStaffId[staffId];
    if (!r) return null;
    if (dayType === "SATURDAY") return (r.saturday_rate ?? null) as any;
    if (dayType === "SUNDAY") return (r.sunday_rate ?? null) as any;
    return (r.weekday_rate ?? null) as any;
  }

  async function fetchData() {
    if (!isManagerOrOwner) return;

    setLoading(true);
    setMsg("");

    try {
      const { startISO, endISO } = buildRange(fromDate, toDate);

      const clockWindowStart = new Date(new Date(startISO).getTime() - 6 * 60 * 60 * 1000).toISOString();
      const clockWindowEnd = new Date(new Date(endISO).getTime() + 6 * 60 * 60 * 1000).toISOString();

      const [shiftRes, clockRes, profileRes, payRes] = await Promise.all([
        supabase
          .from("shifts")
          .select("*")
          .gte("shift_start", startISO)
          .lt("shift_start", endISO)
          .order("shift_start", { ascending: true })
          .limit(1000),

        supabase
          .from("time_clock")
          .select("*")
          .gte("clock_in_at", clockWindowStart)
          .lt("clock_in_at", clockWindowEnd)
          .order("clock_in_at", { ascending: true })
          .limit(3000),

        supabase
          .from("profiles")
          .select("*")
          .order("full_name", { ascending: true }),

        supabase.from("staff_pay_rates").select("*"),
      ]);

      if (shiftRes.error) return setMsg("Error fetching shifts: " + shiftRes.error.message);
      if (clockRes.error) return setMsg("Error fetching time_clock: " + clockRes.error.message);
      if (profileRes.error) return setMsg("Error fetching profiles: " + profileRes.error.message);
      if (payRes.error) return setMsg("Error fetching staff_pay_rates: " + payRes.error.message);

      setShifts((shiftRes.data ?? []) as any);
      setClocks((clockRes.data ?? []) as any);
      setProfiles((profileRes.data ?? []) as any);
      setPayRates((payRes.data ?? []) as any);
    } catch (e: any) {
      setMsg("Error: " + (e?.message ?? String(e)));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!authLoading && isManagerOrOwner) fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, viewerRole]);

  function findClockForShift(shift: Shift) {
    const byId = clocks.find((c) => c.shift_id === shift.id);
    if (byId) return byId;

    const sStart = new Date(shift.shift_start).getTime();
    const sEnd = new Date(shift.shift_end).getTime();
    if (Number.isNaN(sStart) || Number.isNaN(sEnd)) return null;

    const windowStart = sStart - 6 * 60 * 60 * 1000;
    const windowEnd = sEnd + 6 * 60 * 60 * 1000;

    const candidates = clocks
      .filter((c) => c.staff_id === shift.staff_id && c.clock_in_at)
      .filter((c) => {
        const t = new Date(c.clock_in_at as string).getTime();
        return t >= windowStart && t <= windowEnd;
      });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const ta = new Date(a.clock_in_at as string).getTime();
      const tb = new Date(b.clock_in_at as string).getTime();
      return Math.abs(ta - sStart) - Math.abs(tb - sStart);
    });

    return candidates[0];
  }

function findCoverClockForShift(shift: Shift) {
  const sStart = new Date(shift.shift_start).getTime();
  const sEnd = new Date(shift.shift_end).getTime();
  if (Number.isNaN(sStart) || Number.isNaN(sEnd)) return null;

  const windowStart = sStart - 3 * 60 * 60 * 1000;
  const windowEnd = sEnd + 3 * 60 * 60 * 1000;

  const candidates = clocks
    .filter((c) => c.staff_id !== shift.staff_id)
    .filter((c) => c.clock_in_at)
    .filter((c) => {
      const t = new Date(c.clock_in_at as string).getTime();
      return t >= windowStart && t <= windowEnd;
    });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const ta = new Date(a.clock_in_at as string).getTime();
    const tb = new Date(b.clock_in_at as string).getTime();
    return Math.abs(ta - sStart) - Math.abs(tb - sStart);
  });

  return candidates[0];
}

  async function createClockForShift(shift: Shift) {
    setLoading(true);
    setMsg("");
    try {
      const payload: any = {
        shift_id: shift.id,
        staff_id: shift.staff_id,
        clock_in_at: shift.shift_start,
        clock_out_at: shift.shift_end,
        device_tag: "MANUAL_CREATE",
      };

      const { error } = await supabase.from("time_clock").insert(payload);
      if (error) {
        setMsg("Create clock failed: " + error.message);
        return;
      }

      setMsg("Clock record created.");
      await fetchData();
    } finally {
      setLoading(false);
    }
  }

  async function saveAdjustment(clockId: number) {
    setLoading(true);
    setMsg("");
    try {
      const inLocal = editIn[clockId] ?? "";
      const outLocal = editOut[clockId] ?? "";
      const reason = (editReason[clockId] ?? "").trim();

      const adjustedInISO = inLocal ? new Date(inLocal).toISOString() : null;
      const adjustedOutISO = outLocal ? new Date(outLocal).toISOString() : null;

      if (!adjustedInISO || !adjustedOutISO) {
        setMsg("Please select both adjusted Clock In and Clock Out.");
        return;
      }

      const payload: any = {
        adjusted_clock_in_at: adjustedInISO,
        adjusted_clock_out_at: adjustedOutISO,
        adjusted_reason: reason || null,
        adjusted_by: viewerId,
        adjusted_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("time_clock").update(payload).eq("id", clockId);
      if (error) {
        setMsg("Save failed: " + error.message);
        return;
      }

      setMsg("Adjustment saved.");
      await fetchData();
    } finally {
      setLoading(false);
    }
  }

  function setToRoster(clockId: number, shift: Shift) {
    const inVal = new Date(shift.shift_start);
    const outVal = new Date(shift.shift_end);

    const toLocal = (d: Date) => {
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
        d.getMinutes()
      )}`;
    };

    setEditIn((p) => ({ ...p, [clockId]: toLocal(inVal) }));
    setEditOut((p) => ({ ...p, [clockId]: toLocal(outVal) }));
  }

  function getPayrollMinutes(shift: Shift, clock: TimeClock | null) {
    const breakMin = shift.break_minutes ?? 0;

    const rosterMin = minutesBetween(shift.shift_start, shift.shift_end);
    const rawMin = clock ? minutesBetween(clock.clock_in_at, clock.clock_out_at) : null;

    const adjIn = clock?.adjusted_clock_in_at ?? null;
    const adjOut = clock?.adjusted_clock_out_at ?? null;
    const adjMin = adjIn && adjOut ? minutesBetween(adjIn, adjOut) : null;

    const rosterWorkMin = rosterMin !== null ? Math.max(0, rosterMin - breakMin) : null;
    const rawWorkMin = rawMin !== null ? Math.max(0, rawMin - breakMin) : null;
    const adjWorkMin = adjMin !== null ? Math.max(0, adjMin - breakMin) : null;

    const payrollWorkMin = adjWorkMin ?? rawWorkMin ?? rosterWorkMin;
    const source =
      adjWorkMin !== null ? "ADJUSTED" : rawWorkMin !== null ? "RAW" : rosterWorkMin !== null ? "ROSTER" : "NONE";

    return { breakMin, rosterWorkMin, rawWorkMin, adjWorkMin, payrollWorkMin, source, rawMin, adjMin };
  }

  function getAlerts(shift: Shift, clock: TimeClock | null, coverClock: TimeClock | null) {
    const alerts: { label: string; kind: "red" | "yellow" | "blue" | "gray" }[] = [];

    if (!clock) {
      if (coverClock) {
        alerts.push({ label: "POSSIBLE COVER SHIFT", kind: "blue" });
      } else {
        alerts.push({ label: "NO CLOCK", kind: "gray" });
      }
      return alerts;
    }

    if (clock.clock_in_at && !clock.clock_out_at) {
      alerts.push({ label: "OPEN CLOCK", kind: "red" });
    }

    if (clock.clock_in_at && clock.clock_out_at) {
      const inDate = new Date(clock.clock_in_at);
      const outDate = new Date(clock.clock_out_at);

      if (
        inDate.getFullYear() !== outDate.getFullYear() ||
        inDate.getMonth() !== outDate.getMonth() ||
        inDate.getDate() !== outDate.getDate()
      ) {
        alerts.push({ label: "CROSSES MIDNIGHT", kind: "yellow" });
      }

      const rawMin = minutesBetween(clock.clock_in_at, clock.clock_out_at);
      if (rawMin !== null && rawMin > 12 * 60) {
        alerts.push({ label: "LONG SHIFT", kind: "yellow" });
      }
    }

    if (clock.adjusted_clock_in_at && clock.adjusted_clock_out_at) {
      const inDate = new Date(clock.adjusted_clock_in_at);
      const outDate = new Date(clock.adjusted_clock_out_at);

      if (
        inDate.getFullYear() !== outDate.getFullYear() ||
        inDate.getMonth() !== outDate.getMonth() ||
        inDate.getDate() !== outDate.getDate()
      ) {
        alerts.push({ label: "ADJUSTED CROSSES MIDNIGHT", kind: "blue" });
      }
    }

    return alerts;
  }

  const filteredShifts = useMemo(() => {
    if (selectedStaffId === "ALL") return shifts;
    return shifts.filter((s) => s.staff_id === selectedStaffId);
  }, [shifts, selectedStaffId]);

  const rows = useMemo(() => {
    return filteredShifts.map((shift) => {
      const clock = findClockForShift(shift);
      const coverClock = !clock ? findCoverClockForShift(shift) : null;
      const payroll = getPayrollMinutes(shift, clock);
      const alerts = getAlerts(shift, clock, coverClock);

      const dayType = getDayTypeByISO(shift.shift_start);
      const rate = rateFor(shift.staff_id, dayType);

      const payrollHours = payroll.payrollWorkMin !== null ? round2(payroll.payrollWorkMin / 60) : null;
      const pay = payrollHours !== null && rate !== null ? round2(payrollHours * rate) : null;

      return { shift, clock, coverClock, payroll, dayType, rate, payrollHours, pay, alerts };
    });
  }, [filteredShifts, clocks, payRateByStaffId]);

  const overallSummary = useMemo(() => {
    let totalMin = 0;
    let totalPay = 0;

    for (const r of rows) {
      if (r.payroll.payrollWorkMin !== null) totalMin += r.payroll.payrollWorkMin;
      if (r.pay !== null) totalPay += r.pay;
    }

    return {
      totalHours: round2(totalMin / 60),
      totalPay: round2(totalPay),
    };
  }, [rows]);

  const staffOptions = useMemo(() => {
    const list = profiles
      .filter((p) => p?.id && (p.is_active === undefined || p.is_active === null || p.is_active === true))
      .map((p) => ({ id: p.id, name: p.full_name ?? p.id }));

    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [profiles]);


  if (authLoading) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ margin: 0, color: TEXT }}>Roster & Time Clock Adjustment</h1>
            <div style={{ marginTop: 10, color: MUTED }}>Loading permission...</div>
          </div>
        </div>
      </div>
    );
  }

  if (!isManagerOrOwner) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <div style={{ marginBottom: 12 }}>
            {actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}
          </div>

          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ marginTop: 0, color: TEXT }}>Roster & Time Clock Adjustment</h1>
            <div
              style={{
                padding: 14,
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                background: "#fff",
                color: TEXT,
              }}
            >
              <b>Access denied.</b> This page is only for <b>Owner / Manager</b>.
              <br />
              Your role: <b>{viewerRole ?? "UNKNOWN"}</b>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ marginBottom: 12 }}>
          {actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}
        </div>

        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: CARD_BG,
            padding: 20,
            marginBottom: 16,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <h1 style={{ margin: 0, color: TEXT }}>Roster & Time Clock Adjustment</h1>
          <div style={{ marginTop: 6, color: MUTED }}>
            Review roster, raw clock records, adjustments and payroll hours
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: CARD_BG,
            padding: 18,
            marginBottom: 16,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Filters</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
              Select a date range and optional staff filter, then apply.
            </div>
          </div>

          <div
            style={{
              display: "flex",
              gap: 14,
              alignItems: "end",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>From</div>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                disabled={loading}
                style={inputStyle(170)}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>To (inclusive)</div>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                disabled={loading}
                style={inputStyle(170)}
              />
            </div>

            <div style={{ minWidth: 240 }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Staff</div>
              <select
                value={selectedStaffId}
                onChange={(e) => setSelectedStaffId(e.target.value)}
                disabled={loading}
                style={inputStyle("100%")}
              >
                <option value="ALL">All staff</option>
                {staffOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            {actionButton("Apply", fetchData, { primary: true, disabled: loading })}
            {actionButton(
              "Reset",
              () => {
                const t = todayDateInputValue();
                setFromDate(t);
                setToDate(t);
                setSelectedStaffId("ALL");
              },
              { disabled: loading }
            )}

            {loading && <span style={{ color: MUTED, fontWeight: 700 }}>Loading...</span>}
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
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: CARD_BG,
            padding: 18,
            marginBottom: 16,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Summary</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
              Payroll time rule: <b>Adjusted</b> → <b>Raw clock</b> → <b>Roster</b>.
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {infoCard("Total hours", `${overallSummary.totalHours.toFixed(2)}h`, WAK_BLUE)}
            {infoCard("Total pay", money(overallSummary.totalPay), WAK_RED)}
            {infoCard("Rows", String(rows.length))}
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: CARD_BG,
            padding: 18,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Adjustment Table</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
              Each row represents one roster shift. Raw clock is matched to that shift.
            </div>
          </div>


          <div
            ref={tableScrollRef}
            style={{
              overflowX: "auto",
              border: `1px solid ${BORDER}`,
              borderRadius: 14,
              maxHeight: "70vh",
            }}
          >
            <table
              style={{
                width: "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
                minWidth: 1180,
              }}
            >
              <thead>
                <tr>
                  {["Staff", "Shift", "Raw Clock", "Adjustment", "Payroll", "Alert", "Actions"].map((head) => (
                    <th
                      key={head}
                      style={{
                        textAlign: "left",
                        padding: "14px 12px",
                        borderBottom: `1px solid ${BORDER}`,
                        color: MUTED,
                        fontSize: 13,
                        background: "#FAFAFA",
                        whiteSpace: "nowrap",
                        position: "sticky",
                        top: 0,
                        zIndex: 2,
                      }}
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {rows.map((r) => {
                  const shift = r.shift;
                  const clock = r.clock;
                  const hasClock = !!clock;
                  const clockId = clock?.id ?? -1;

                  const adjustedInValue = clockId !== -1 && editIn[clockId] !== undefined ? editIn[clockId] : "";
                  const adjustedOutValue = clockId !== -1 && editOut[clockId] !== undefined ? editOut[clockId] : "";
                  const reasonValue =
                    clockId !== -1 && editReason[clockId] !== undefined ? editReason[clockId] : clock?.adjusted_reason ?? "";

                  const hoursText = r.payrollHours === null ? "-" : `${r.payrollHours.toFixed(2)}h`;

                  const dayBadge =
                    r.dayType === "WEEKDAY"
                      ? badge("Weekday", { kind: "blue" })
                      : r.dayType === "SATURDAY"
                      ? badge("Saturday", { kind: "yellow" })
                      : badge("Sunday", { kind: "red" });

                  const sourceBadge =
                    r.payroll.source === "ADJUSTED"
                      ? badge("ADJUSTED", { kind: "green" })
                      : r.payroll.source === "RAW"
                      ? badge("RAW", { kind: "blue" })
                      : r.payroll.source === "ROSTER"
                      ? badge("ROSTER", { kind: "yellow" })
                      : badge("NONE", { kind: "gray" });

                  return (
                    <tr
                      key={shift.id}
                      style={{
                        background: getRowBackground(r.alerts),
                        boxShadow: r.alerts.some((a) => a.label === "OPEN CLOCK")
                          ? "inset 4px 0 0 #DC2626"
                          : r.alerts.some((a) => a.label === "CROSSES MIDNIGHT" || a.label === "LONG SHIFT")
                          ? "inset 4px 0 0 #D97706"
                          : r.alerts.some((a) => a.label === "POSSIBLE COVER SHIFT")
                          ? "inset 4px 0 0 #2563EB"
                          : "none",
                      }}
                    >
                      <td
                        style={{
                          padding: "14px 12px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "top",
                          minWidth: 120,
                        }}
                      >
                        <div style={{ fontWeight: 800, color: TEXT }}>{staffLabel(shift.staff_id)}</div>
                      </td>

                      <td
                        style={{
                          padding: "14px 12px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "top",
                          minWidth: 220,
                        }}
                      >
                        <div style={{ marginBottom: 8 }}>{dayBadge}</div>
                        <div style={{ color: TEXT, fontWeight: 700 }}>{fmtAU(shift.shift_start)}</div>
                        <div style={{ color: MUTED, marginTop: 6 }}>{fmtAU(shift.shift_end)}</div>
                      </td>

                      <td
                        style={{
                          padding: "14px 12px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "top",
                          minWidth: 210,
                        }}
                      >
                        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>In</div>
                        <div style={{ color: TEXT, fontWeight: 700, marginBottom: 10 }}>
                          {fmtAU(clock?.clock_in_at ?? null)}
                        </div>

                        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Out</div>
                        <div style={{ color: TEXT }}>{fmtAU(clock?.clock_out_at ?? null)}</div>
                      </td>

                      <td
                        style={{
                          padding: "14px 12px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "top",
                          minWidth: 250,
                        }}
                      >
                        {!hasClock ? (
                          <div style={{ color: "#9CA3AF", fontSize: 13 }}>No clock record</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <div>
                              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Adjusted In</div>
                              <input
                                type="datetime-local"
                                value={adjustedInValue || toLocalInputValue(clock?.adjusted_clock_in_at)}
                                onChange={(e) => setEditIn((p) => ({ ...p, [clockId]: e.target.value }))}
                                style={inputStyle("100%")}
                              />
                            </div>

                            <div>
                              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Adjusted Out</div>
                              <input
                                type="datetime-local"
                                value={adjustedOutValue || toLocalInputValue(clock?.adjusted_clock_out_at)}
                                onChange={(e) => setEditOut((p) => ({ ...p, [clockId]: e.target.value }))}
                                style={inputStyle("100%")}
                              />
                            </div>

                            <div>
                              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Reason (optional)</div>
                              <input
                                placeholder="Optional note"
                                value={reasonValue}
                                onChange={(e) => setEditReason((p) => ({ ...p, [clockId]: e.target.value }))}
                                style={inputStyle("100%")}
                              />
                            </div>
                          </div>
                        )}
                      </td>

                      <td
                        style={{
                          padding: "14px 12px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "top",
                          minWidth: 150,
                        }}
                      >
                        <div style={{ marginBottom: 10 }}>{sourceBadge}</div>

                        <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>Hours</div>
                        <div style={{ fontWeight: 800, color: TEXT }}>{hoursText}</div>
                      </td>

                      <td
                        style={{
                          padding: "14px 12px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "top",
                          minWidth: 170,
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {r.alerts.length === 0 ? (
                            badge("OK", { kind: "green" })
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                              {r.alerts.map((a, idx) => (
                                <div key={idx}>{badge(a.label, { kind: a.kind })}</div>
                              ))}

                              {r.coverClock && (
                                <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.4 }}>
                                  Clock nearby: <b style={{ color: TEXT }}>{staffLabel(r.coverClock.staff_id)}</b>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </td>

                      <td
                        style={{
                          padding: "14px 12px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "top",
                          minWidth: 150,
                        }}
                      >
                        {!hasClock ? (
                          actionButton("Create clock", () => createClockForShift(shift), {
                            disabled: loading,
                          })
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {actionButton("Set to roster", () => setToRoster(clockId, shift), {
                              disabled: loading,
                            })}
                            {actionButton("Save", () => saveAdjustment(clockId), {
                              primary: true,
                              disabled: loading,
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}

                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      style={{
                        padding: 16,
                        color: "#9CA3AF",
                        borderBottom: `1px solid ${BORDER}`,
                      }}
                    >
                      No shifts found in this date range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 16, fontSize: 12, color: MUTED }}>
            Staff Summary (hours & pay) is now available in the Owner page.
          </div>
        </div>
      </div>
    </div>
  );
}