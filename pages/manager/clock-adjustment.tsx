import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Range = { startISO: string; endISO: string };

type ShiftStatus =
  | "SCHEDULED"
  | "WORKED"
  | "ABSENT"
  | "SICK"
  | "CANCELLED"
  | "COVERED";

type Shift = {
  id: number;
  store_id?: string | null;
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes?: number | null;
  hourly_rate?: number | null;
  shift_status?: ShiftStatus | null;
  shift_status_note?: string | null;
  shift_status_updated_by?: string | null;
  shift_status_updated_at?: string | null;
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
  preferred_name?: string | null;
  role?: string | null;
  is_active?: boolean | null;
};

type StaffPayRate = {
  staff_id: string;
  weekday_rate: number | null;
  saturday_rate: number | null;
  sunday_rate: number | null;
  holiday_rate: number | null;
};

type LeaveRecord = {
  id: number;
  staff_id: string;
  start_at: string;
  end_at: string;
  reason: string | null;
};

type PayClass =
  | "WEEKDAY"
  | "SATURDAY"
  | "SUNDAY"
  | "PUBLIC_HOLIDAY"
  | "SICK_LEAVE"
  | "ANNUAL_LEAVE"
  | "ABSENT"
  | "CANCELLED"
  | "COVERED";

const STORE_ID = "MOOROOLBARK";

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const GRID = "#F1F3F5";
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

function toISODate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

function buildISOFromDateAndTime(dateISO: string, hhmm: string) {
  const [hh, mm] = (hhmm || "00:00").split(":").map((x) => Number(x));
  const d = new Date(`${dateISO}T00:00:00`);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

function easterSunday(year: number) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function nthWeekdayOfMonth(year: number, month0: number, weekday: number, nth: number) {
  const d = new Date(year, month0, 1);
  const diff = (weekday - d.getDay() + 7) % 7;
  d.setDate(1 + diff + (nth - 1) * 7);
  return d;
}

function firstWeekdayOfMonth(year: number, month0: number, weekday: number) {
  return nthWeekdayOfMonth(year, month0, weekday, 1);
}

function addDaysDate(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function victoriaPublicHolidays(year: number) {
  const easter = easterSunday(year);
  const holidays: { date: string; label: string }[] = [];

  holidays.push({ date: toISODate(new Date(year, 0, 1)), label: "New Year's Day" });
  holidays.push({ date: toISODate(new Date(year, 0, 26)), label: "Australia Day" });
  holidays.push({ date: toISODate(nthWeekdayOfMonth(year, 2, 1, 2)), label: "Labour Day" });
  holidays.push({ date: toISODate(addDaysDate(easter, -2)), label: "Good Friday" });
  holidays.push({ date: toISODate(addDaysDate(easter, -1)), label: "Saturday before Easter Sunday" });
  holidays.push({ date: toISODate(easter), label: "Easter Sunday" });
  holidays.push({ date: toISODate(addDaysDate(easter, 1)), label: "Easter Monday" });
  holidays.push({ date: toISODate(new Date(year, 3, 25)), label: "ANZAC Day" });
  holidays.push({ date: toISODate(nthWeekdayOfMonth(year, 5, 1, 2)), label: "King's Birthday" });
  holidays.push({ date: toISODate(firstWeekdayOfMonth(year, 10, 2)), label: "Melbourne Cup" });
  holidays.push({ date: toISODate(new Date(year, 11, 25)), label: "Christmas Day" });
  holidays.push({ date: toISODate(new Date(year, 11, 26)), label: "Boxing Day" });

  const aflGrandFinalEveOverrides: Record<number, string> = {
    2025: "2025-09-26",
    // 2026: "2026-09-25",
  };

  if (aflGrandFinalEveOverrides[year]) {
    holidays.push({
      date: aflGrandFinalEveOverrides[year],
      label: "Friday before AFL Grand Final",
    });
  }

  return holidays.sort((a, b) => a.date.localeCompare(b.date));
}

function isVictoriaPublicHolidayISO(dateISO: string) {
  const d = new Date(dateISO);
  const list = victoriaPublicHolidays(d.getFullYear());
  const dayOnly = toISODate(d);
  return list.some((h) => h.date === dayOnly);
}

function getDayTypeByISO(iso: string): "WEEKDAY" | "SATURDAY" | "SUNDAY" {
  const d = new Date(iso);
  const day = d.getDay();
  if (day === 0) return "SUNDAY";
  if (day === 6) return "SATURDAY";
  return "WEEKDAY";
}

function normalizeShiftStatus(v: any): ShiftStatus {
  const s = String(v ?? "SCHEDULED").toUpperCase();
  if (s === "WORKED" || s === "ABSENT" || s === "SICK" || s === "CANCELLED" || s === "COVERED") {
    return s as ShiftStatus;
  }
  return "SCHEDULED";
}

function overlaps(aStartISO: string, aEndISO: string, bStartISO: string, bEndISO: string) {
  const aStart = new Date(aStartISO).getTime();
  const aEnd = new Date(aEndISO).getTime();
  const bStart = new Date(bStartISO).getTime();
  const bEnd = new Date(bEndISO).getTime();
  return aStart < bEnd && bStart < aEnd;
}

function isNoPayStatus(status: ShiftStatus | null | undefined) {
  return status === "ABSENT" || status === "SICK" || status === "CANCELLED" || status === "COVERED";
}

function getLeaveCategory(reason: string | null): "ANNUAL_LEAVE" | "SICK_LEAVE" | null {
  const text = (reason ?? "").toLowerCase();
  if (text.includes("annual leave")) return "ANNUAL_LEAVE";
  if (text.includes("sick leave")) return "SICK_LEAVE";
  return null;
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
  let borderColor = "#D1D5DB";
  let textColor = TEXT;

  if (primary) {
    bg = "#EEF5FF";
    borderColor = "#C8DBF7";
    textColor = WAK_BLUE;
  }

  if (danger) {
    bg = "#FFF5F5";
    borderColor = "#F3CDCD";
    textColor = "#9A3E3E";
  }

  if (disabled) {
    bg = "#F3F4F6";
    borderColor = "#E5E7EB";
    textColor = "#9CA3AF";
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "6px 10px",
        minHeight: 32,
        borderRadius: 8,
        border: `1px solid ${borderColor}`,
        background: bg,
        color: textColor,
        fontWeight: 700,
        fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
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
        padding: "8px 10px",
        borderRadius: 10,
        background: "#F9FAFB",
        border: `1px solid ${BORDER}`,
        minWidth: 80,
      }}
    >
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontWeight: 800, fontSize: 16, color: color || TEXT }}>{value}</div>
    </div>
  );
}

function badge(
  label: string,
  options?: { kind?: "blue" | "green" | "yellow" | "gray" | "red" | "purple" }
) {
  const kind = options?.kind ?? "gray";

  const styles: Record<string, { bg: string; color: string }> = {
    blue: { bg: "#EEF5FF", color: "#2D5F93" },
    green: { bg: "#EDF7EF", color: "#2E6B3C" },
    yellow: { bg: "#FFF8EA", color: "#8A6B22" },
    gray: { bg: "#F3F4F6", color: "#4B5563" },
    red: { bg: "#FFF1F1", color: "#9B4A4A" },
    purple: { bg: "#F5F3FF", color: "#6D4BC4" },
  };

  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 8px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
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
    padding: "6px 9px",
    borderRadius: 8,
    border: "1px solid #D1D5DB",
    fontSize: 12,
    background: "#fff",
    color: TEXT,
  };
}

function statusBadge(status: ShiftStatus | null | undefined) {
  const s = normalizeShiftStatus(status);

  if (s === "WORKED") return badge("WORKED", { kind: "green" });
  if (s === "ABSENT") return badge("ABSENT", { kind: "red" });
  if (s === "SICK") return badge("SICK", { kind: "purple" });
  if (s === "CANCELLED") return badge("CANCELLED", { kind: "gray" });
  if (s === "COVERED") return badge("COVERED", { kind: "yellow" });
  return badge("SCHEDULED", { kind: "gray" });
}

function getRowBackground(
  alerts: { label: string; kind: "red" | "yellow" | "blue" | "gray" | "purple" }[],
  shiftStatus?: ShiftStatus | null
) {
  const status = normalizeShiftStatus(shiftStatus);

  if (status === "ABSENT") return "#FFF6F6";
  if (status === "SICK") return "#F8F5FF";
  if (status === "CANCELLED") return "#FAFAFA";
  if (status === "COVERED") return "#FFFDF5";

  const labels = alerts.map((a) => a.label);
  if (labels.includes("OPEN CLOCK")) return "#FFF6F6";
  if (labels.includes("PUBLIC HOLIDAY")) return "#FFFDF5";
  if (labels.includes("ANNUAL LEAVE")) return "#F8F5FF";
  if (labels.includes("SICK LEAVE")) return "#F8F5FF";
  if (labels.includes("POSSIBLE COVER SHIFT")) return "#F5F9FF";
  return "#FFFFFF";
}

function payClassLabel(c: PayClass) {
  if (c === "PUBLIC_HOLIDAY") return "Public Holiday";
  if (c === "ANNUAL_LEAVE") return "Annual Leave";
  if (c === "SICK_LEAVE") return "Sick Leave";
  if (c === "SATURDAY") return "Saturday";
  if (c === "SUNDAY") return "Sunday";
  if (c === "WEEKDAY") return "Weekday";
  if (c === "ABSENT") return "Absent";
  if (c === "CANCELLED") return "Cancelled";
  return "Covered";
}

export default function ClockAdjustmentPage() {
  const [authLoading, setAuthLoading] = useState(true);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const isManagerOrOwner = viewerRole === "OWNER" || viewerRole === "MANAGER";

  const [fromDate, setFromDate] = useState<string>(todayDateInputValue());
  const [toDate, setToDate] = useState<string>(todayDateInputValue());
  const [selectedStaffId, setSelectedStaffId] = useState<string>("ALL");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [clocks, setClocks] = useState<TimeClock[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [payRates, setPayRates] = useState<StaffPayRate[]>([]);
  const [leaveRows, setLeaveRows] = useState<LeaveRecord[]>([]);

  const [editIn, setEditIn] = useState<Record<number, string>>({});
  const [editOut, setEditOut] = useState<Record<number, string>>({});

  const [createOpen, setCreateOpen] = useState(false);
  const [createStaffId, setCreateStaffId] = useState<string>("");
  const [createDate, setCreateDate] = useState<string>(todayDateInputValue());
  const [createStartTime, setCreateStartTime] = useState<string>("17:00");
  const [createEndTime, setCreateEndTime] = useState<string>("21:00");

  async function loadPermission() {
    setAuthLoading(true);
    const { data } = await supabase.auth.getUser();
    const user = data?.user;

    if (!user) {
      window.location.href = "/";
      return;
    }

    setViewerId(user.id);

    const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", user.id).single();

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
  }, []);

  const nameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of profiles) {
      if (p?.id) {
        const preferred = (p.preferred_name ?? "").trim();
        const full = (p.full_name ?? "").trim();
        map[p.id] = preferred || full || p.id;
      }
    }
    return map;
  }, [profiles]);

  const weekdayRateByStaff = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of payRates) {
      map[r.staff_id] = Number(r.weekday_rate ?? 0);
    }
    return map;
  }, [payRates]);

  function staffLabel(staffId: string) {
    return nameById[staffId] ?? staffId;
  }

  async function fetchData() {
    if (!isManagerOrOwner) return;

    setLoading(true);
    setMsg("");

    try {
      const { startISO, endISO } = buildRange(fromDate, toDate);

      const clockWindowStart = new Date(new Date(startISO).getTime() - 6 * 60 * 60 * 1000).toISOString();
      const clockWindowEnd = new Date(new Date(endISO).getTime() + 6 * 60 * 60 * 1000).toISOString();

      const [shiftRes, clockRes, profileRes, rateRes, leaveRes] = await Promise.all([
        supabase
          .from("shifts")
          .select("*")
          .eq("store_id", STORE_ID)
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

        supabase.from("profiles").select("*").order("full_name", { ascending: true }),

        supabase
          .from("staff_pay_rates")
          .select("staff_id, weekday_rate, saturday_rate, sunday_rate, holiday_rate")
          .eq("store_id", STORE_ID),

        supabase
          .from("staff_unavailability")
          .select("id, staff_id, start_at, end_at, reason")
          .eq("store_id", STORE_ID)
          .lt("start_at", endISO)
          .gt("end_at", startISO)
          .order("start_at", { ascending: true }),
      ]);

      if (shiftRes.error) return setMsg("Error fetching shifts: " + shiftRes.error.message);
      if (clockRes.error) return setMsg("Error fetching time_clock: " + clockRes.error.message);
      if (profileRes.error) return setMsg("Error fetching profiles: " + profileRes.error.message);
      if (rateRes.error) return setMsg("Error fetching pay rates: " + rateRes.error.message);
      if (leaveRes.error) return setMsg("Error fetching leave: " + leaveRes.error.message);

      setShifts((shiftRes.data ?? []) as any);
      setClocks((clockRes.data ?? []) as any);
      setProfiles((profileRes.data ?? []) as any);
      setPayRates((rateRes.data ?? []) as any);
      setLeaveRows((leaveRes.data ?? []) as any);
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

  function findLeaveForShift(shift: Shift) {
    const matches = leaveRows.filter(
      (l) =>
        l.staff_id === shift.staff_id &&
        overlaps(l.start_at, l.end_at, shift.shift_start, shift.shift_end) &&
        getLeaveCategory(l.reason) !== null
    );

    if (matches.length === 0) return null;
    return matches[0];
  }

  async function getHourlyRateForShift(staffId: string, shiftStartISO: string): Promise<number> {
    const row = payRates.find((r) => r.staff_id === staffId);
    if (!row) {
      throw new Error("Could not find pay rate for this staff member.");
    }

    if (isVictoriaPublicHolidayISO(shiftStartISO)) {
      return Number(row.holiday_rate ?? 0);
    }

    const day = new Date(shiftStartISO).getDay();
    if (day === 6) return Number(row.saturday_rate ?? 0);
    if (day === 0) return Number(row.sunday_rate ?? 0);
    return Number(row.weekday_rate ?? 0);
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

      const adjustedInISO = inLocal ? new Date(inLocal).toISOString() : null;
      const adjustedOutISO = outLocal ? new Date(outLocal).toISOString() : null;

      if (!adjustedInISO || !adjustedOutISO) {
        setMsg("Please select both adjusted Clock In and Clock Out.");
        return;
      }

      const payload: any = {
        adjusted_clock_in_at: adjustedInISO,
        adjusted_clock_out_at: adjustedOutISO,
        adjusted_reason: null,
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

  async function updateShiftStatus(shiftId: number, status: ShiftStatus) {
    setLoading(true);
    setMsg("");

    try {
      const payload: any = {
        shift_status: status,
        shift_status_note: null,
        shift_status_updated_by: viewerId,
        shift_status_updated_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("shifts").update(payload).eq("id", shiftId);

      if (error) {
        setMsg("Update shift status failed: " + error.message);
        return;
      }

      setMsg(`Shift marked as ${status}.`);
      await fetchData();
    } finally {
      setLoading(false);
    }
  }

  async function deleteShift(shiftId: number) {
    if (!confirm("Delete this shift completely? This cannot be undone.")) return;

    setLoading(true);
    setMsg("");

    try {
      const linkedClock = clocks.find((c) => c.shift_id === shiftId);

      if (linkedClock) {
        setMsg("Cannot delete this shift because it already has a linked clock record. Use status instead.");
        return;
      }

      const { error } = await supabase.from("shifts").delete().eq("id", shiftId);

      if (error) {
        setMsg("Delete shift failed: " + error.message);
        return;
      }

      setMsg("Shift deleted.");
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

  async function createShiftNow() {
    setLoading(true);
    setMsg("");

    try {
      if (!createStaffId) {
        setMsg("Please select staff.");
        return;
      }
      if (!createDate || !createStartTime || !createEndTime) {
        setMsg("Please fill date, start and end time.");
        return;
      }

      const startISO = buildISOFromDateAndTime(createDate, createStartTime);
      let endISO = buildISOFromDateAndTime(createDate, createEndTime);

      if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
        const end = new Date(endISO);
        end.setDate(end.getDate() + 1);
        endISO = end.toISOString();
      }

      const hourlyRate = await getHourlyRateForShift(createStaffId, startISO);

      const payload: any = {
        store_id: STORE_ID,
        staff_id: createStaffId,
        shift_start: startISO,
        shift_end: endISO,
        break_minutes: 0,
        hourly_rate: hourlyRate,
        shift_status: "SCHEDULED",
        created_by: viewerId,
      };

      const { error } = await supabase.from("shifts").insert(payload);
      if (error) {
        setMsg("Create shift failed: " + error.message);
        return;
      }

      setMsg("Shift created.");
      setCreateOpen(false);
      setCreateStaffId("");
      setCreateDate(todayDateInputValue());
      setCreateStartTime("17:00");
      setCreateEndTime("21:00");
      await fetchData();
    } catch (e: any) {
      setMsg("Create shift failed: " + (e?.message ?? "Unknown error"));
    } finally {
      setLoading(false);
    }
  }

  function getPayrollResult(shift: Shift, clock: TimeClock | null, leave: LeaveRecord | null) {
    const status = normalizeShiftStatus(shift.shift_status);
    const breakMin = shift.break_minutes ?? 0;

    const rosterMin = minutesBetween(shift.shift_start, shift.shift_end);
    const rawMin = clock ? minutesBetween(clock.clock_in_at, clock.clock_out_at) : null;

    const adjIn = clock?.adjusted_clock_in_at ?? null;
    const adjOut = clock?.adjusted_clock_out_at ?? null;
    const adjMin = adjIn && adjOut ? minutesBetween(adjIn, adjOut) : null;

    const rosterWorkMin = rosterMin !== null ? Math.max(0, rosterMin - breakMin) : 0;
    const rawWorkMin = rawMin !== null ? Math.max(0, rawMin - breakMin) : null;
    const adjWorkMin = adjMin !== null ? Math.max(0, adjMin - breakMin) : null;

    if (leave) {
      const leaveType = getLeaveCategory(leave.reason);
      const rate = Number(weekdayRateByStaff[shift.staff_id] ?? 0);
      const payClass: PayClass = leaveType === "ANNUAL_LEAVE" ? "ANNUAL_LEAVE" : "SICK_LEAVE";
      const hours = round2(rosterWorkMin / 60);
      return {
        payClass,
        source: "LEAVE",
        hours,
        pay: round2(hours * rate),
      };
    }

    if (status === "SICK") {
      return {
        payClass: "SICK_LEAVE" as PayClass,
        source: "STATUS",
        hours: 0,
        pay: 0,
      };
    }

    if (isNoPayStatus(status)) {
      return {
        payClass: status as PayClass,
        source: status,
        hours: 0,
        pay: 0,
      };
    }

    const payrollWorkMin = adjWorkMin ?? rawWorkMin ?? rosterWorkMin;
    const source =
      adjWorkMin !== null ? "ADJUSTED" : rawWorkMin !== null ? "RAW" : rosterWorkMin !== null ? "ROSTER" : "NONE";

    const hours = round2((payrollWorkMin ?? 0) / 60);

    if (isVictoriaPublicHolidayISO(shift.shift_start)) {
      return {
        payClass: "PUBLIC_HOLIDAY" as PayClass,
        source,
        hours,
        pay: round2(hours * Number(shift.hourly_rate ?? 0)),
      };
    }

    const baseType = getDayTypeByISO(shift.shift_start);
    return {
      payClass: baseType as PayClass,
      source,
      hours,
      pay: round2(hours * Number(shift.hourly_rate ?? 0)),
    };
  }

  function getAlerts(
    shift: Shift,
    clock: TimeClock | null,
    coverClock: TimeClock | null,
    leave: LeaveRecord | null
  ) {
    const alerts: { label: string; kind: "red" | "yellow" | "blue" | "gray" | "purple" }[] = [];

    if (leave) {
      const leaveType = getLeaveCategory(leave.reason);
      alerts.push({
        label: leaveType === "ANNUAL_LEAVE" ? "ANNUAL LEAVE" : "SICK LEAVE",
        kind: "purple",
      });
    }

    if (isVictoriaPublicHolidayISO(shift.shift_start)) {
      alerts.push({ label: "PUBLIC HOLIDAY", kind: "yellow" });
    }

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
      const leave = findLeaveForShift(shift);
      const payroll = getPayrollResult(shift, clock, leave);
      const alerts = getAlerts(shift, clock, coverClock, leave);
      const status = normalizeShiftStatus(shift.shift_status);

      return {
        shift,
        clock,
        coverClock,
        leave,
        payroll,
        status,
        alerts,
      };
    });
  }, [filteredShifts, clocks, leaveRows, weekdayRateByStaff]);

  const overallSummary = useMemo(() => {
    let totalHours = 0;
    let totalPay = 0;

    for (const r of rows) {
      totalHours += Number(r.payroll.hours ?? 0);
      totalPay += Number(r.payroll.pay ?? 0);
    }

    return {
      totalHours: round2(totalHours),
      totalPay: round2(totalPay),
    };
  }, [rows]);

  const staffOptions = useMemo(() => {
    const list = profiles
      .filter((p) => p?.id && (p.is_active === undefined || p.is_active === null || p.is_active === true))
      .map((p) => ({
        id: p.id,
        name: ((p.preferred_name ?? "").trim() || (p.full_name ?? "").trim() || p.id) as string,
      }));

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
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 16,
                flexWrap: "wrap",
              }}
            >
              <div>
                <h1 style={{ marginTop: 0, color: TEXT }}>Roster & Time Clock Adjustment</h1>
              </div>
              <div>{actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}</div>
            </div>

            <div
              style={{
                padding: 14,
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                background: "#fff",
                color: TEXT,
                marginTop: 8,
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
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1 style={{ margin: 0, color: TEXT }}>Roster & Time Clock Adjustment</h1>
              <div style={{ marginTop: 6, color: MUTED }}>
                Review roster, raw clock records, adjustments and payroll hours
              </div>
            </div>

            <div>{actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}</div>
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
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 16,
              flexWrap: "wrap",
              marginBottom: 14,
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Filters</h2>
              <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
                Select a date range and optional staff filter, then apply.
              </div>
            </div>

            <div>{actionButton("＋ Create Shift", () => setCreateOpen(true), { primary: true, disabled: loading })}</div>
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

            <div style={{ minWidth: 150 }}>
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

        {createOpen && (
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
              <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Create Shift</h2>
              <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
                Use this when someone comes in to cover a shift but was not rostered.
              </div>
            </div>

            <div style={{ display: "flex", gap: 14, alignItems: "end", flexWrap: "wrap" }}>
              <div style={{ minWidth: 150 }}>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Staff</div>
                <select
                  value={createStaffId}
                  onChange={(e) => setCreateStaffId(e.target.value)}
                  style={inputStyle("100%")}
                  disabled={loading}
                >
                  <option value="">Select staff</option>
                  {staffOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Date</div>
                <input
                  type="date"
                  value={createDate}
                  onChange={(e) => setCreateDate(e.target.value)}
                  style={inputStyle(160)}
                  disabled={loading}
                />
              </div>

              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Start</div>
                <input
                  type="time"
                  value={createStartTime}
                  onChange={(e) => setCreateStartTime(e.target.value)}
                  style={inputStyle(120)}
                  disabled={loading}
                />
              </div>

              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>End</div>
                <input
                  type="time"
                  value={createEndTime}
                  onChange={(e) => setCreateEndTime(e.target.value)}
                  style={inputStyle(120)}
                  disabled={loading}
                />
              </div>

              {actionButton("Save Shift", createShiftNow, { primary: true, disabled: loading })}
              {actionButton(
                "Cancel",
                () => {
                  setCreateOpen(false);
                  setCreateStaffId("");
                  setCreateDate(todayDateInputValue());
                  setCreateStartTime("17:00");
                  setCreateEndTime("21:00");
                },
                { disabled: loading }
              )}
            </div>
          </div>
        )}

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
              Payroll time rule: <b>Status</b> → <b>Leave</b> → <b>Adjusted</b> → <b>Raw clock</b> → <b>Roster</b>.
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
              Each row represents one shift. Raw clock is matched to that shift.
            </div>
          </div>

          <div
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
                minWidth: 10,
              }}
            >
              <thead>
                <tr>
                  {["Staff", "Shift", "Status", "Raw Clock", "Adjustment", "Hour", "Alert", "Actions"].map((head, idx, arr) => (
                    <th
                      key={head}
                      style={{
                        textAlign: "left",
                        padding: "8px 8px",
                        borderBottom: `1px solid ${BORDER}`,
                        borderRight: idx < arr.length - 1 ? `1px solid ${GRID}` : undefined,
                        color: MUTED,
                        fontSize: 12,
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
                  const clockId = clock?.id ?? null;
                  const hasClock = !!clockId;

                  const adjustedInValue = clock
                    ? editIn[clockId!] ?? toLocalInputValue(clock.adjusted_clock_in_at ?? clock.clock_in_at)
                    : "";
                  const adjustedOutValue = clock
                    ? editOut[clockId!] ?? toLocalInputValue(clock.adjusted_clock_out_at ?? clock.clock_out_at)
                    : "";

                  const sourceBadge =
                    r.payroll.source === "ADJUSTED"
                      ? badge("ADJUSTED", { kind: "blue" })
                      : r.payroll.source === "RAW"
                      ? badge("RAW", { kind: "green" })
                      : r.payroll.source === "ROSTER"
                      ? badge("ROSTER", { kind: "gray" })
                      : r.payroll.source === "LEAVE"
                      ? badge("LEAVE", { kind: "purple" })
                      : r.payroll.source === "STATUS"
                      ? badge("STATUS", { kind: "purple" })
                      : badge(String(r.payroll.source), { kind: "gray" });

                  return (
                    <tr
                      key={shift.id}
                      style={{
                        background: getRowBackground(r.alerts, shift.shift_status),
                      }}
                    >
                      <td
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${BORDER}`,
                          borderRight: `1px solid ${GRID}`,
                          verticalAlign: "top",
                          minWidth: 80,
                        }}
                      >
                        <div style={{ fontWeight: 700, color: TEXT }}>{staffLabel(shift.staff_id)}</div>
                        <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                          {payClassLabel(r.payroll.payClass)}
                        </div>
                      </td>

                      <td
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${BORDER}`,
                          borderRight: `1px solid ${GRID}`,
                          verticalAlign: "top",
                          minWidth: 150,
                        }}
                      >
                        <div style={{ fontWeight: 700, color: TEXT }}>{fmtAU(shift.shift_start)}</div>
                        <div style={{ fontSize: 12, color: TEXT, marginTop: 6, fontWeight: 700 }}>To</div>
                        <div style={{ fontWeight: 700, color: TEXT, marginTop: 6 }}>{fmtAU(shift.shift_end)}</div>
                      </td>

                      <td
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${BORDER}`,
                          borderRight: `1px solid ${GRID}`,
                          verticalAlign: "top",
                          minWidth: 110,
                        }}
                      >
                        <div style={{ marginBottom: 8 }}>{statusBadge(shift.shift_status)}</div>

                        <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>Change</div>
                        <select
                          value={normalizeShiftStatus(shift.shift_status)}
                          onChange={(e) => updateShiftStatus(shift.id, e.target.value as ShiftStatus)}
                          disabled={loading}
                          style={inputStyle("100%")}
                        >
                          <option value="SCHEDULED">Scheduled</option>
                          <option value="WORKED">Worked</option>
                          <option value="ABSENT">Absent</option>
                          <option value="SICK">Sick</option>
                          <option value="COVERED">Covered</option>
                          <option value="CANCELLED">Cancelled</option>
                        </select>
                      </td>

                      <td
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${BORDER}`,
                          borderRight: `1px solid ${GRID}`,
                          verticalAlign: "top",
                          minWidth: 150,
                        }}
                      >
                        {!clock ? (
                          <div style={{ color: MUTED, fontSize: 12 }}>No matched clock</div>
                        ) : (
                          <>
                            <div style={{ color: TEXT, fontWeight: 700 }}>{fmtAU(clock.clock_in_at)}</div>
                            <div style={{ fontSize: 12, color: TEXT, marginTop: 6, fontWeight: 700 }}>Out</div>
                            <div style={{ color: TEXT, fontWeight: 700, marginTop: 6 }}>{fmtAU(clock.clock_out_at)}</div>
                          </>
                        )}
                      </td>

                      <td
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${BORDER}`,
                          borderRight: `1px solid ${GRID}`,
                          verticalAlign: "top",
                          minWidth: 190,
                        }}
                      >
                        {!hasClock ? (
                          <div style={{ color: MUTED, fontSize: 12 }}>Create a manual clock first if needed.</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <div>
                              <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>Adjusted In</div>
                              <input
                                type="datetime-local"
                                value={adjustedInValue}
                                onChange={(e) => setEditIn((p) => ({ ...p, [clockId!]: e.target.value }))}
                                style={inputStyle("100%")}
                              />
                            </div>

                            <div>
                              <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>Adjusted Out</div>
                              <input
                                type="datetime-local"
                                value={adjustedOutValue}
                                onChange={(e) => setEditOut((p) => ({ ...p, [clockId!]: e.target.value }))}
                                style={inputStyle("100%")}
                              />
                            </div>
                          </div>
                        )}
                      </td>

                      <td
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${BORDER}`,
                          borderRight: `1px solid ${GRID}`,
                          verticalAlign: "top",
                          minWidth: 50,
                        }}
                      >
                        <div style={{ marginBottom: 8 }}>{sourceBadge}</div>

                        <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>Hours</div>
                        <div style={{ fontWeight: 800, color: TEXT }}>{r.payroll.hours.toFixed(2)}h</div>
                      </td>

                      <td
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${BORDER}`,
                          borderRight: `1px solid ${GRID}`,
                          verticalAlign: "top",
                          minWidth: 90,
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {r.alerts.length === 0 ? (
                            badge("OK", { kind: "green" })
                          ) : (
                            <>
                              {r.alerts.map((a, idx) => (
                                <div key={idx}>{badge(a.label, { kind: a.kind })}</div>
                              ))}

                              {r.coverClock && (
                                <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.4 }}>
                                  Clock nearby: <b style={{ color: TEXT }}>{staffLabel(r.coverClock.staff_id)}</b>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </td>

                      <td
                        style={{
                          padding: "8px 8px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "top",
                          minWidth: 150,
                        }}
                      >
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {!hasClock ? (
                            actionButton("Create Clock", () => createClockForShift(shift), {
                              disabled: loading,
                            })
                          ) : (
                            actionButton("Save Time", () => saveAdjustment(clockId!), {
                              primary: true,
                              disabled: loading,
                            })
                          )}

                          {actionButton("Set to roster", () => setToRoster(clockId!, shift), {
                            disabled: loading || !hasClock,
                          })}

                          {actionButton("Delete shift", () => deleteShift(shift.id), {
                            danger: true,
                            disabled: loading,
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={8}
                      style={{
                        padding: 14,
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
            Use <b>Create Shift</b> first when someone covers a shift but was not rostered, then create or adjust their clock here.
          </div>
        </div>
      </div>
    </div>
  );
}