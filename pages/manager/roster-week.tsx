import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Profile = {
  id: string;
  full_name: string | null;
  preferred_name: string | null;
};

type ShiftStatus = "SCHEDULED" | "WORKED" | "ABSENT" | "SICK" | "COVERED" | "CANCELLED";

type ShiftCostRow = {
  shift_id: number;
  store_id: string;
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes: number;
  hours_worked: number;
  applied_rate: number | null;
  estimated_wage: number | null;
  shift_status?: ShiftStatus | null;
  covered_by_staff_id?: string | null;
  parent_shift_id?: number | null;
  cover_note?: string | null;
};

type RawShiftRow = {
  id: number;
  store_id: string;
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes: number | null;
  hourly_rate: number | null;
};

type UnavailOneOffRow = {
  id: number;
  staff_id: string;
  store_id: string;
  start_at: string;
  end_at: string;
  reason: string | null;
};

type UnavailRecurringRule = {
  id: number;
  staff_id: string;
  store_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  reason: string | null;
};

type RecurringOverride = {
  id: number;
  rule_id: number;
  week_start: string;
  store_id: string;
};

type EventCategory = "ANNUAL_LEAVE" | "SICK_LEAVE" | "LEAVE" | "UNAVAILABLE";

type UnavailOccurrence = {
  kind: "oneoff" | "recurring";
  id: number;
  staff_id: string;
  store_id: string;
  start_at: string;
  end_at: string;
  reason: string | null;
  rule?: UnavailRecurringRule;
  isSkippedThisWeek?: boolean;
};

type StaffPayRateRow = {
  staff_id: string;
  weekday_rate: number;
  saturday_rate: number;
  sunday_rate: number;
  holiday_rate: number;
};

const dayLabels = ["THU", "FRI", "SAT", "SUN", "MON", "TUE", "WED"] as const;

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

const SHIFT_BG = "#F7FBFF";
const SHIFT_BORDER = "#D9E6F7";

const HOLIDAY_BG = "#FFFBEF";
const HOLIDAY_BORDER = "#F3E2A7";
const HOLIDAY_TEXT = "#8A5A00";

const LEAVE_BG = "#F5F3FF";
const LEAVE_BORDER = "#D8B4FE";
const LEAVE_TEXT = "#7C3AED";

const UNAV_BG = "#FFF6F6";
const UNAV_BORDER = "#F4B4B4";
const UNAV_TEXT = "#991B1B";

function toISODate(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function getThisWeekThuISO() {
  const now = new Date();
  const dow = now.getDay();
  const diffToThu = (dow - 4 + 7) % 7;
  const thu = new Date(now);
  thu.setHours(0, 0, 0, 0);
  thu.setDate(now.getDate() - diffToThu);
  return toISODate(thu);
}

function addDaysISO(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

function shiftISOByDays(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function weekRangeText(weekStartISO: string) {
  const start = new Date(weekStartISO + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString([], {
      weekday: "short",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  return `${fmt(start)} → ${fmt(end)}`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function dayIndexFromISO(iso: string) {
  const d = new Date(iso);
  const dow = d.getDay();
  const map: Record<number, number> = { 4: 0, 5: 1, 6: 2, 0: 3, 1: 4, 2: 5, 3: 6 };
  return map[dow];
}

function overlaps(aStartISO: string, aEndISO: string, bStartISO: string, bEndISO: string) {
  const aStart = new Date(aStartISO).getTime();
  const aEnd = new Date(aEndISO).getTime();
  const bStart = new Date(bStartISO).getTime();
  const bEnd = new Date(bEndISO).getTime();
  return aStart < bEnd && bStart < aEnd;
}

function hhmmss_to_hhmm(t: string) {
  return (t || "").slice(0, 5);
}

function fmtHeaderDate(d: Date) {
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toTimeInputHHMM(iso: string) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function buildISOFromDayAndTime(dayDate: Date, hhmm: string) {
  const [hh, mm] = (hhmm || "00:00").split(":").map((x) => Number(x));
  const d = new Date(dayDate);
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

function minutesBetween(startISO: string, endISO: string) {
  const ms = new Date(endISO).getTime() - new Date(startISO).getTime();
  return Math.max(0, Math.round(ms / 60000));
}

function hoursBetween(startISO: string, endISO: string) {
  return minutesBetween(startISO, endISO) / 60;
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
        minHeight: 44,
        borderRadius: 12,
        border: `1px solid ${borderColor}`,
        background: bg,
        color: textColor,
        fontWeight: 800,
        fontSize: 14,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: primary || danger ? "0 8px 18px rgba(0,0,0,0.08)" : "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function subtleButton(
  label: string,
  onClick: () => void,
  options?: { disabled?: boolean; active?: boolean }
) {
  const disabled = options?.disabled;
  const active = options?.active;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 14px",
        minHeight: 38,
        borderRadius: 10,
        border: `1px solid ${active ? WAK_BLUE : BORDER}`,
        background: active ? "#EEF5FF" : "#fff",
        color: active ? WAK_BLUE : TEXT,
        fontWeight: 700,
        fontSize: 13,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function badge(label: string, kind: "green" | "yellow" | "blue" | "gray" | "red" | "purple" = "gray") {
  const styles: Record<string, { bg: string; color: string }> = {
    green: { bg: "#DCFCE7", color: "#166534" },
    yellow: { bg: "#FEF3C7", color: "#92400E" },
    blue: { bg: "#EAF3FF", color: WAK_BLUE },
    gray: { bg: "#F3F4F6", color: "#374151" },
    red: { bg: "#FEE2E2", color: "#991B1B" },
    purple: { bg: "#F5F3FF", color: "#7C3AED" },
  };

  return (
    <span
      style={{
        display: "inline-block",
        padding: "5px 9px",
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

function statCard(label: string, value: string, color?: string, extra?: React.ReactNode) {
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
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}</div>
      {extra ? extra : <div style={{ fontWeight: 800, fontSize: 18, color: color || TEXT }}>{value}</div>}
    </div>
  );
}

function downloadCSV(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* Victoria public holidays */
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

  const newYear = new Date(year, 0, 1);
  if (newYear.getDay() === 6 || newYear.getDay() === 0) {
    holidays.push({
      date: toISODate(nthWeekdayOfMonth(year, 0, 1, 1)),
      label: "Additional New Year's Day holiday",
    });
  }

  const australiaDay = new Date(year, 0, 26);
  if (australiaDay.getDay() === 6 || australiaDay.getDay() === 0) {
    const sub = new Date(australiaDay);
    sub.setDate(australiaDay.getDate() + ((8 - australiaDay.getDay()) % 7));
    holidays.push({ date: toISODate(sub), label: "Australia Day (substitute holiday)" });
  }

  const christmas = new Date(year, 11, 25);
  if (christmas.getDay() === 6 || christmas.getDay() === 0) {
    const sub = new Date(christmas);
    sub.setDate(christmas.getDate() + ((8 - christmas.getDay()) % 7));
    holidays.push({ date: toISODate(sub), label: "Christmas Day (additional holiday)" });
  }

  const boxingDay = new Date(year, 11, 26);
  if (boxingDay.getDay() === 6 || boxingDay.getDay() === 0) {
    const sub = new Date(boxingDay);
    sub.setDate(boxingDay.getDate() + ((8 - boxingDay.getDay()) % 7));
    holidays.push({ date: toISODate(sub), label: "Boxing Day (additional holiday)" });
  }

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
  const dayOnly = toISODate(d);
  const list = victoriaPublicHolidays(d.getFullYear());
  return list.some((h) => h.date === dayOnly);
}

function getEventCategory(reason: string | null, kind: "oneoff" | "recurring"): EventCategory {
  if (kind === "recurring") return "UNAVAILABLE";

  const text = (reason ?? "").toLowerCase();
  if (text.includes("annual leave")) return "ANNUAL_LEAVE";
  if (text.includes("sick leave")) return "SICK_LEAVE";
  if (text.includes("leave")) return "LEAVE";
  return "UNAVAILABLE";
}

function isPaidLeaveCategory(cat: EventCategory) {
  return cat === "ANNUAL_LEAVE" || cat === "SICK_LEAVE";
}

function normalizeShiftStatus(v: string | null | undefined): ShiftStatus {
  const s = String(v ?? "SCHEDULED").toUpperCase();
  if (s === "WORKED") return "WORKED";
  if (s === "ABSENT") return "ABSENT";
  if (s === "SICK") return "SICK";
  if (s === "COVERED") return "COVERED";
  if (s === "CANCELLED") return "CANCELLED";
  return "SCHEDULED";
}

function shouldCountShiftInTotals(r: ShiftCostRow) {
  const status = normalizeShiftStatus(r.shift_status);
  if (status === "CANCELLED") return false;
  if (status === "COVERED") return false;
  if (status === "ABSENT") return false;
  if (status === "SICK") return false;
  return true;
}

function getShiftVisual(r: ShiftCostRow) {
  const status = normalizeShiftStatus(r.shift_status);

  if (r.parent_shift_id) {
    return {
      bg: "#ECFDF5",
      border: "#A7F3D0",
      title: "#065F46",
      meta: "#047857",
      label: "COVERING",
    };
  }

  if (status === "ABSENT") {
    return {
      bg: "#FEF2F2",
      border: "#FECACA",
      title: "#991B1B",
      meta: "#B91C1C",
      label: "ABSENT",
    };
  }

  if (status === "SICK") {
    return {
      bg: "#F5F3FF",
      border: "#DDD6FE",
      title: "#6D28D9",
      meta: "#7C3AED",
      label: "SICK",
    };
  }

  if (status === "COVERED") {
    return {
      bg: "#FFF7ED",
      border: "#FED7AA",
      title: "#9A3412",
      meta: "#C2410C",
      label: "COVERED",
    };
  }

  if (status === "CANCELLED") {
    return {
      bg: "#F3F4F6",
      border: "#D1D5DB",
      title: "#4B5563",
      meta: "#6B7280",
      label: "CANCELLED",
    };
  }

  if (status === "WORKED") {
    return {
      bg: "#ECFDF5",
      border: "#A7F3D0",
      title: "#065F46",
      meta: "#047857",
      label: "WORKED",
    };
  }

  return {
    bg: SHIFT_BG,
    border: SHIFT_BORDER,
    title: WAK_BLUE,
    meta: MUTED,
    label: "",
  };
}

export default function RosterWeek() {
  const [storeId] = useState("MOOROOLBARK");
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

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [rows, setRows] = useState<ShiftCostRow[]>([]);
  const [oneOff, setOneOff] = useState<UnavailOneOffRow[]>([]);
  const [recRules, setRecRules] = useState<UnavailRecurringRule[]>([]);
  const [recOverrides, setRecOverrides] = useState<RecurringOverride[]>([]);
  const [payRates, setPayRates] = useState<StaffPayRateRow[]>([]);
  const [msg, setMsg] = useState("");

  const [isPublished, setIsPublished] = useState<boolean>(false);
  const [pubLoading, setPubLoading] = useState<boolean>(false);
  const [copyLoading, setCopyLoading] = useState<boolean>(false);
  const [ratesLoading, setRatesLoading] = useState<boolean>(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"shift" | "unavail" | "leave">("shift");
  const [drawerMode, setDrawerMode] = useState<"add" | "edit">("add");
  const [drawerStaffId, setDrawerStaffId] = useState<string>("");
  const [drawerDayIdx, setDrawerDayIdx] = useState<number>(0);
  const [drawerShiftId, setDrawerShiftId] = useState<number | null>(null);

  const [drawerStartTime, setDrawerStartTime] = useState<string>("17:00");
  const [drawerEndTime, setDrawerEndTime] = useState<string>("21:00");

  const [unStartTime, setUnStartTime] = useState("17:00");
  const [unEndTime, setUnEndTime] = useState("21:00");
  const [unReason, setUnReason] = useState("");
  const [leaveType, setLeaveType] = useState<"ANNUAL_LEAVE" | "SICK_LEAVE">("ANNUAL_LEAVE");

  function staffName(id: string) {
    const p = profiles.find((x) => x.id === id);
    const preferred = p?.preferred_name?.trim() ?? "";
    const full = p?.full_name?.trim() ?? "";
    return preferred || full || id.slice(0, 8);
  }

  async function getHourlyRateForShift(staffId: string, shiftStartISO: string): Promise<number> {
    const { data, error } = await supabase
      .from("staff_pay_rates")
      .select("weekday_rate, saturday_rate, sunday_rate, holiday_rate")
      .eq("staff_id", staffId)
      .eq("store_id", storeId)
      .single();

    if (error || !data) {
      throw new Error("Could not find pay rate for this staff member.");
    }

    if (isVictoriaPublicHolidayISO(shiftStartISO)) {
      return Number(data.holiday_rate ?? 0);
    }

    const day = new Date(shiftStartISO).getDay();
    if (day === 6) return Number(data.saturday_rate ?? 0);
    if (day === 0) return Number(data.sunday_rate ?? 0);
    return Number(data.weekday_rate ?? 0);
  }

  async function loadProfiles() {
    const p = await supabase.from("profiles").select("id, full_name, preferred_name");
    if (p.error) {
      console.log(p.error);
      setProfiles([]);
      return;
    }
    setProfiles((p.data ?? []) as any);
  }

  async function loadPayRates() {
    const r = await supabase
      .from("staff_pay_rates")
      .select("staff_id, weekday_rate, saturday_rate, sunday_rate, holiday_rate")
      .eq("store_id", storeId);

    if (r.error) {
      console.log(r.error);
      setPayRates([]);
      return;
    }

    setPayRates(
      (r.data ?? []).map((x: any) => ({
        staff_id: x.staff_id,
        weekday_rate: Number(x.weekday_rate ?? 0),
        saturday_rate: Number(x.saturday_rate ?? 0),
        sunday_rate: Number(x.sunday_rate ?? 0),
        holiday_rate: Number(x.holiday_rate ?? 0),
      }))
    );
  }

  async function loadShiftCosts() {
    setMsg("");

    const r = await supabase
      .from("shift_costs")
      .select("*")
      .eq("store_id", storeId)
      .gte("shift_start", range.start.toISOString())
      .lt("shift_start", range.end.toISOString())
      .order("shift_start", { ascending: true });

    if (r.error) {
      setMsg("❌ Cannot load shifts: " + r.error.message);
      setRows([]);
      return;
    }

    const metaRes = await supabase
      .from("shifts")
      .select("id, shift_status, covered_by_staff_id, parent_shift_id, cover_note")
      .eq("store_id", storeId)
      .gte("shift_start", range.start.toISOString())
      .lt("shift_start", range.end.toISOString());

    if (metaRes.error) {
      setMsg("❌ Cannot load shift status: " + metaRes.error.message);
      setRows([]);
      return;
    }

    const metaById: Record<
      number,
      {
        shift_status: ShiftStatus | null;
        covered_by_staff_id: string | null;
        parent_shift_id: number | null;
        cover_note: string | null;
      }
    > = {};

    for (const s of metaRes.data ?? []) {
      metaById[(s as any).id] = {
        shift_status: normalizeShiftStatus((s as any).shift_status),
        covered_by_staff_id: (s as any).covered_by_staff_id ?? null,
        parent_shift_id: (s as any).parent_shift_id ?? null,
        cover_note: (s as any).cover_note ?? null,
      };
    }

    const toNum = (v: any) => (v === null || v === undefined ? 0 : Number(v));

    setRows(
      (r.data ?? []).map((x: any) => {
        const meta = metaById[x.shift_id] ?? {
          shift_status: "SCHEDULED" as ShiftStatus,
          covered_by_staff_id: null,
          parent_shift_id: null,
          cover_note: null,
        };

        return {
          shift_id: x.shift_id,
          store_id: x.store_id,
          staff_id: x.staff_id,
          shift_start: x.shift_start,
          shift_end: x.shift_end,
          break_minutes: toNum(x.break_minutes),
          hours_worked: toNum(x.hours_worked),
          applied_rate: x.applied_rate === null ? null : Number(x.applied_rate),
          estimated_wage: x.estimated_wage === null ? null : Number(x.estimated_wage),
          shift_status: meta.shift_status,
          covered_by_staff_id: meta.covered_by_staff_id,
          parent_shift_id: meta.parent_shift_id,
          cover_note: meta.cover_note,
        };
      })
    );
  }

  async function loadOneOffUnavailability() {
    const r = await supabase
      .from("staff_unavailability")
      .select("id, staff_id, store_id, start_at, end_at, reason")
      .eq("store_id", storeId)
      .lt("start_at", range.end.toISOString())
      .gt("end_at", range.start.toISOString())
      .order("start_at", { ascending: true });

    if (r.error) {
      setMsg("❌ Cannot load one-off unavailable: " + r.error.message);
      setOneOff([]);
      return;
    }
    setOneOff((r.data ?? []) as any);
  }

  async function loadRecurringRules() {
    const r = await supabase
      .from("staff_unavailability_recurring")
      .select("id, staff_id, store_id, day_of_week, start_time, end_time, reason")
      .eq("store_id", storeId)
      .order("staff_id", { ascending: true });

    if (r.error) {
      setMsg("❌ Cannot load weekly unavailable rules: " + r.error.message);
      setRecRules([]);
      return;
    }
    setRecRules((r.data ?? []) as any);
  }

  async function loadRecurringOverrides() {
    const r = await supabase
      .from("staff_unavailability_recurring_overrides")
      .select("id, rule_id, week_start, store_id")
      .eq("store_id", storeId)
      .eq("week_start", weekStart);

    if (r.error) {
      setMsg("❌ Cannot load weekly overrides: " + r.error.message);
      setRecOverrides([]);
      return;
    }
    setRecOverrides((r.data ?? []) as any);
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
      return;
    }
    setIsPublished(!!r.data?.published);
  }

  async function loadAll() {
    await loadProfiles();
    await loadPayRates();
    await loadShiftCosts();
    await loadOneOffUnavailability();
    await loadRecurringRules();
    await loadRecurringOverrides();
    await loadPublishedStatus();
  }

  function getWeekBounds(weekStartISO: string) {
    const start = new Date(weekStartISO + "T00:00:00");
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { startISO: start.toISOString(), endISO: end.toISOString() };
  }

  async function getRawShiftsForWeek(weekStartISO: string): Promise<RawShiftRow[]> {
    const { startISO, endISO } = getWeekBounds(weekStartISO);

    const r = await supabase
      .from("shifts")
      .select("id, store_id, staff_id, shift_start, shift_end, break_minutes, hourly_rate")
      .eq("store_id", storeId)
      .gte("shift_start", startISO)
      .lt("shift_start", endISO)
      .order("shift_start", { ascending: true });

    if (r.error) throw r.error;
    return (r.data ?? []) as RawShiftRow[];
  }

  async function weekHasAnyShifts(weekStartISO: string): Promise<boolean> {
    const { startISO, endISO } = getWeekBounds(weekStartISO);

    const r = await supabase
      .from("shifts")
      .select("id")
      .eq("store_id", storeId)
      .gte("shift_start", startISO)
      .lt("shift_start", endISO)
      .limit(1);

    if (r.error) throw r.error;
    return (r.data ?? []).length > 0;
  }

  async function copyWeekShifts(sourceWeekStartISO: string, targetWeekStartISO: string) {
    const targetHas = await weekHasAnyShifts(targetWeekStartISO);
    if (targetHas) {
      return { ok: false, reason: "TARGET_NOT_EMPTY" as const };
    }

    const sourceShifts = await getRawShiftsForWeek(sourceWeekStartISO);
    if (sourceShifts.length === 0) {
      return { ok: false, reason: "SOURCE_EMPTY" as const };
    }

    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;

    const sourceDate = new Date(sourceWeekStartISO + "T00:00:00");
    const targetDate = new Date(targetWeekStartISO + "T00:00:00");
    const diffDays = Math.round((targetDate.getTime() - sourceDate.getTime()) / (1000 * 60 * 60 * 24));

    const insertRows = sourceShifts.map((s) => ({
      store_id: s.store_id,
      staff_id: s.staff_id,
      shift_start: shiftISOByDays(s.shift_start, diffDays),
      shift_end: shiftISOByDays(s.shift_end, diffDays),
      break_minutes: s.break_minutes ?? 0,
      hourly_rate: s.hourly_rate ?? 0,
      created_by: uid,
    }));

    const ins = await supabase.from("shifts").insert(insertRows, { returning: "minimal" } as any);
    if (ins.error) throw ins.error;

    return { ok: true, count: insertRows.length };
  }

  async function applyLatestRatesForWeek() {
    try {
      setRatesLoading(true);
      setMsg("");

      const sourceShifts = await getRawShiftsForWeek(weekStart);

      if (sourceShifts.length === 0) {
        setMsg("ℹ️ This week has no shifts.");
        return;
      }

      const uniqueStaffIds = Array.from(new Set(sourceShifts.map((s) => s.staff_id)));

      const rateRes = await supabase
        .from("staff_pay_rates")
        .select("staff_id, weekday_rate, saturday_rate, sunday_rate, holiday_rate")
        .eq("store_id", storeId)
        .in("staff_id", uniqueStaffIds);

      if (rateRes.error) {
        setMsg("❌ Failed to load latest rates: " + rateRes.error.message);
        return;
      }

      const rateByStaff: Record<
        string,
        { weekday_rate: number; saturday_rate: number; sunday_rate: number; holiday_rate: number }
      > = {};

      for (const r of rateRes.data ?? []) {
        rateByStaff[(r as any).staff_id] = {
          weekday_rate: Number((r as any).weekday_rate ?? 0),
          saturday_rate: Number((r as any).saturday_rate ?? 0),
          sunday_rate: Number((r as any).sunday_rate ?? 0),
          holiday_rate: Number((r as any).holiday_rate ?? 0),
        };
      }

      const updates: { id: number; hourly_rate: number }[] = [];

      for (const s of sourceShifts as any[]) {
        const rateRow = rateByStaff[s.staff_id];
        if (!rateRow) continue;

        let nextRate = rateRow.weekday_rate;

        if (isVictoriaPublicHolidayISO(s.shift_start)) {
          nextRate = rateRow.holiday_rate;
        } else {
          const day = new Date(s.shift_start).getDay();
          if (day === 6) nextRate = rateRow.saturday_rate;
          if (day === 0) nextRate = rateRow.sunday_rate;
        }

        const currentRate = Number(s.hourly_rate ?? 0);
        const latestRate = Number(nextRate ?? 0);

        if (currentRate !== latestRate) {
          updates.push({
            id: s.id,
            hourly_rate: latestRate,
          });
        }
      }

      if (updates.length === 0) {
        setMsg("ℹ️ All shifts in this week already use the latest rates.");
        return;
      }

      for (const u of updates) {
        const up = await supabase
          .from("shifts")
          .update({ hourly_rate: u.hourly_rate })
          .eq("id", u.id);

        if (up.error) {
          setMsg("❌ Failed to update some shifts: " + up.error.message);
          return;
        }
      }

      setMsg(`✅ Applied latest rates to ${updates.length} shift(s).`);
      await loadShiftCosts();
    } catch (e: any) {
      setMsg("❌ Failed to apply latest rates: " + (e?.message ?? "Unknown error"));
    } finally {
      setRatesLoading(false);
    }
  }

  async function handleNextWeek() {
    try {
      setCopyLoading(true);
      const nextWeek = addDaysISO(weekStart, 7);

      const nextHas = await weekHasAnyShifts(nextWeek);
      if (!nextHas) {
        const result = await copyWeekShifts(weekStart, nextWeek);

        if (result.ok) {
          setMsg(`✅ Copied ${result.count} shift(s) to next week.`);
        } else if (result.reason === "SOURCE_EMPTY") {
          setMsg("ℹ️ Current week has no shifts, so next week stays empty.");
        }
      }

      setWeekStart(nextWeek);
    } catch (e: any) {
      setMsg("❌ Failed to open next week: " + (e?.message ?? "Unknown error"));
    } finally {
      setCopyLoading(false);
    }
  }

  async function handleCopyFromPreviousWeek() {
    try {
      setCopyLoading(true);
      setMsg("");

      const currentHas = await weekHasAnyShifts(weekStart);
      if (currentHas) {
        setMsg("ℹ️ This week already has shifts, so nothing was copied.");
        return;
      }

      const prevWeek = addDaysISO(weekStart, -7);
      const result = await copyWeekShifts(prevWeek, weekStart);

      if (result.ok) {
        setMsg(`✅ Copied ${result.count} shift(s) from previous week.`);
        await loadShiftCosts();
      } else if (result.reason === "SOURCE_EMPTY") {
        setMsg("ℹ️ Previous week has no shifts to copy.");
      } else if (result.reason === "TARGET_NOT_EMPTY") {
        setMsg("ℹ️ This week already has shifts, so nothing was copied.");
      }
    } catch (e: any) {
      setMsg("❌ Copy failed: " + (e?.message ?? "Unknown error"));
    } finally {
      setCopyLoading(false);
    }
  }

  async function publishWeek() {
    setMsg("");
    setPubLoading(true);

    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;

    const up = await supabase.from("roster_weeks").upsert(
      [
        {
          store_id: storeId,
          week_start: weekStart,
          published: true,
          published_at: new Date().toISOString(),
          published_by: uid,
        },
      ],
      { onConflict: "store_id,week_start" }
    );

    setPubLoading(false);

    if (up.error) {
      setMsg("❌ Publish failed: " + up.error.message);
      return;
    }

    setMsg("✅ Published! Staff can now see this week.");
    await loadPublishedStatus();
  }

  async function unpublishWeek() {
    setMsg("");
    setPubLoading(true);

    const up = await supabase
      .from("roster_weeks")
      .update({ published: false, published_at: null, published_by: null })
      .eq("store_id", storeId)
      .eq("week_start", weekStart);

    setPubLoading(false);

    if (up.error) {
      setMsg("❌ Unpublish failed: " + up.error.message);
      return;
    }

    setMsg("✅ Unpublished. Staff can NOT see this week now.");
    await loadPublishedStatus();
  }

  useEffect(() => {
    loadProfiles();
    loadPayRates();
  }, []);

  useEffect(() => {
    loadShiftCosts();
    loadOneOffUnavailability();
    loadRecurringRules();
    loadRecurringOverrides();
    loadPublishedStatus();
    loadPayRates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  const payRateByStaff = useMemo(() => {
    const map: Record<string, StaffPayRateRow> = {};
    for (const r of payRates) map[r.staff_id] = r;
    return map;
  }, [payRates]);

  const staffIds = useMemo(() => {
    const set = new Set<string>();
    profiles.forEach((p) => set.add(p.id));
    rows.forEach((r) => set.add(r.staff_id));
    oneOff.forEach((u) => set.add(u.staff_id));
    recRules.forEach((u) => set.add(u.staff_id));
    return Array.from(set).sort((a, b) => staffName(a).localeCompare(staffName(b)));
  }, [profiles, rows, oneOff, recRules]);

  const grid = useMemo(() => {
    const g: Record<string, ShiftCostRow[][]> = {};
    staffIds.forEach((sid) => (g[sid] = Array.from({ length: 7 }, () => [])));
    rows.forEach((r) => {
      const idx = dayIndexFromISO(r.shift_start);
      g[r.staff_id] ??= Array.from({ length: 7 }, () => []);
      g[r.staff_id][idx].push(r);
    });
    return g;
  }, [rows, staffIds]);

  const skippedRuleIds = useMemo(() => new Set<number>(recOverrides.map((x) => x.rule_id)), [recOverrides]);

  function cellDayIdxToJsDow(dayIdx: number) {
    return [4, 5, 6, 0, 1, 2, 3][dayIdx];
  }

  const recurringOccurrences = useMemo(() => {
    const occ: UnavailOccurrence[] = [];

    for (const rule of recRules) {
      const isSkipped = skippedRuleIds.has(rule.id);

      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const jsDow = cellDayIdxToJsDow(dayIdx);
        if (rule.day_of_week !== jsDow) continue;

        const dayDate = new Date(range.start);
        dayDate.setDate(dayDate.getDate() + dayIdx);
        dayDate.setHours(0, 0, 0, 0);

        const [sh, sm] = hhmmss_to_hhmm(rule.start_time).split(":").map(Number);
        const [eh, em] = hhmmss_to_hhmm(rule.end_time).split(":").map(Number);

        const start = new Date(dayDate);
        start.setHours(sh, sm, 0, 0);

        const end = new Date(dayDate);
        end.setHours(eh, em, 0, 0);

        if (end.getTime() <= start.getTime()) end.setDate(end.getDate() + 1);

        occ.push({
          kind: "recurring",
          id: rule.id,
          staff_id: rule.staff_id,
          store_id: rule.store_id,
          start_at: start.toISOString(),
          end_at: end.toISOString(),
          reason: rule.reason ?? null,
          rule,
          isSkippedThisWeek: isSkipped,
        });
      }
    }

    return occ;
  }, [recRules, range.start, skippedRuleIds]);

  const allEvents = useMemo(() => {
    const one = oneOff.map((u) => ({
      kind: "oneoff" as const,
      id: u.id,
      staff_id: u.staff_id,
      store_id: u.store_id,
      start_at: u.start_at,
      end_at: u.end_at,
      reason: u.reason ?? null,
    }));
    return [...one, ...recurringOccurrences];
  }, [oneOff, recurringOccurrences]);

  const eventGrid = useMemo(() => {
    const g: Record<string, UnavailOccurrence[][]> = {};
    staffIds.forEach((sid) => (g[sid] = Array.from({ length: 7 }, () => [])));

    allEvents.forEach((u) => {
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const dayStart = new Date(range.start);
        dayStart.setDate(dayStart.getDate() + dayIdx);
        dayStart.setHours(0, 0, 0, 0);

        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        if (overlaps(u.start_at, u.end_at, dayStart.toISOString(), dayEnd.toISOString())) {
          g[u.staff_id] ??= Array.from({ length: 7 }, () => []);
          g[u.staff_id][dayIdx].push(u);
        }
      }
    });

    return g;
  }, [allEvents, staffIds, range.start]);

  function getRateForDate(staffId: string, dateISO: string) {
    const rateRow = payRateByStaff[staffId];
    if (!rateRow) return 0;

    if (isVictoriaPublicHolidayISO(dateISO)) {
      return Number(rateRow.holiday_rate ?? rateRow.weekday_rate ?? 0);
    }

    const day = new Date(dateISO + "T00:00:00").getDay();
    if (day === 6) return Number(rateRow.saturday_rate ?? rateRow.weekday_rate ?? 0);
    if (day === 0) return Number(rateRow.sunday_rate ?? rateRow.weekday_rate ?? 0);
    return Number(rateRow.weekday_rate ?? 0);
  }

  const countedRows = useMemo(() => rows.filter(shouldCountShiftInTotals), [rows]);

  const paidLeaveEvents = useMemo(() => {
    return allEvents.filter((e) => {
      const cat = getEventCategory(e.reason, e.kind);
      if (e.kind === "recurring" && e.isSkippedThisWeek) return false;
      return isPaidLeaveCategory(cat);
    });
  }, [allEvents]);

  const storeTotalHours = useMemo(() => {
    const shiftHours = countedRows.reduce((sum, r) => sum + r.hours_worked, 0);
    const leaveHours = paidLeaveEvents.reduce((sum, e) => sum + hoursBetween(e.start_at, e.end_at), 0);
    return shiftHours + leaveHours;
  }, [countedRows, paidLeaveEvents]);

  const storeTotalWage = useMemo(() => {
    const shiftWage = countedRows.reduce((sum, r) => sum + (r.estimated_wage ?? 0), 0);
    const leaveWage = paidLeaveEvents.reduce((sum, e) => {
      const dateISO = toISODate(new Date(e.start_at));
      return sum + hoursBetween(e.start_at, e.end_at) * getRateForDate(e.staff_id, dateISO);
    }, 0);
    return shiftWage + leaveWage;
  }, [countedRows, paidLeaveEvents, payRateByStaff]);

  const dailyTotals = useMemo(() => {
    const totals = Array.from({ length: 7 }, () => ({ hours: 0, wage: 0 }));

    for (const r of countedRows) {
      const idx = dayIndexFromISO(r.shift_start);
      totals[idx].hours += r.hours_worked;
      totals[idx].wage += r.estimated_wage ?? 0;
    }

    for (const e of paidLeaveEvents) {
      const idx = dayIndexFromISO(e.start_at);
      const hrs = hoursBetween(e.start_at, e.end_at);
      const dateISO = toISODate(new Date(e.start_at));
      const rate = getRateForDate(e.staff_id, dateISO);
      totals[idx].hours += hrs;
      totals[idx].wage += hrs * rate;
    }

    return totals;
  }, [countedRows, paidLeaveEvents, payRateByStaff]);

  const weeklySummaryByStaff = useMemo(() => {
    const out: Record<string, { totalHours: number; wage: number }> = {};
    for (const sid of staffIds) {
      out[sid] = { totalHours: 0, wage: 0 };
    }

    for (const r of countedRows) {
      out[r.staff_id] ??= { totalHours: 0, wage: 0 };
      out[r.staff_id].totalHours += Number(r.hours_worked ?? 0);
      out[r.staff_id].wage += Number(r.estimated_wage ?? 0);
    }

    for (const e of paidLeaveEvents) {
      const hrs = hoursBetween(e.start_at, e.end_at);
      const dateISO = toISODate(new Date(e.start_at));
      const rate = getRateForDate(e.staff_id, dateISO);
      out[e.staff_id] ??= { totalHours: 0, wage: 0 };
      out[e.staff_id].totalHours += hrs;
      out[e.staff_id].wage += hrs * rate;
    }

    return out;
  }, [staffIds, countedRows, paidLeaveEvents, payRateByStaff]);

  const todayISO = toISODate(new Date());

  const holidayMap = useMemo(() => {
    const years = Array.from(new Set(dayDates.map((d) => d.getFullYear())));
    const map: Record<string, string> = {};
    for (const y of years) {
      for (const h of victoriaPublicHolidays(y)) {
        map[h.date] = h.label;
      }
    }
    return map;
  }, [dayDates]);

  function closeDrawer() {
    setDrawerOpen(false);
  }

  function openDrawerFromCell(staffId: string, dayIdx: number) {
    setDrawerStaffId(staffId);
    setDrawerDayIdx(dayIdx);

    setDrawerTab("shift");
    setDrawerMode("add");
    setDrawerShiftId(null);
    setDrawerStartTime("17:00");
    setDrawerEndTime("21:00");

    setUnStartTime("17:00");
    setUnEndTime("21:00");
    setUnReason("");
    setLeaveType("ANNUAL_LEAVE");

    setDrawerOpen(true);
    setMsg("");
  }

  function openDrawerForEditShift(r: ShiftCostRow) {
    const dayIdx = dayIndexFromISO(r.shift_start);

    setDrawerStaffId(r.staff_id);
    setDrawerDayIdx(dayIdx);

    setDrawerTab("shift");
    setDrawerMode("edit");
    setDrawerShiftId(r.shift_id);
    setDrawerStartTime(toTimeInputHHMM(r.shift_start));
    setDrawerEndTime(toTimeInputHHMM(r.shift_end));

    setUnStartTime("17:00");
    setUnEndTime("21:00");
    setUnReason("");
    setLeaveType("ANNUAL_LEAVE");

    setDrawerOpen(true);
    setMsg("");
  }

  function openDrawerForUnavailable(staffId: string, dayIdx: number) {
    setDrawerStaffId(staffId);
    setDrawerDayIdx(dayIdx);

    setDrawerTab("unavail");
    setDrawerMode("add");
    setDrawerShiftId(null);

    setUnStartTime("17:00");
    setUnEndTime("21:00");
    setUnReason("");

    setDrawerOpen(true);
    setMsg("");
  }

  function openDrawerForLeave(staffId: string, dayIdx: number) {
    setDrawerStaffId(staffId);
    setDrawerDayIdx(dayIdx);

    setDrawerTab("leave");
    setDrawerMode("add");
    setDrawerShiftId(null);

    setUnStartTime("17:00");
    setUnEndTime("21:00");
    setUnReason("");
    setLeaveType("ANNUAL_LEAVE");

    setDrawerOpen(true);
    setMsg("");
  }

  const drawerDayDate = useMemo(() => dayDates[drawerDayIdx], [dayDates, drawerDayIdx]);

  const drawerDayEvents = useMemo(() => {
    if (!drawerStaffId) return [];
    return (eventGrid[drawerStaffId]?.[drawerDayIdx] ?? []) as UnavailOccurrence[];
  }, [eventGrid, drawerStaffId, drawerDayIdx]);

  const drawerLeavesInCell = useMemo(
    () =>
      drawerDayEvents.filter((x) => {
        const cat = getEventCategory(x.reason, x.kind);
        return cat === "ANNUAL_LEAVE" || cat === "SICK_LEAVE" || cat === "LEAVE";
      }),
    [drawerDayEvents]
  );

  const drawerUnavailInCell = useMemo(
    () =>
      drawerDayEvents.filter((x) => {
        const cat = getEventCategory(x.reason, x.kind);
        return cat === "UNAVAILABLE";
      }),
    [drawerDayEvents]
  );

  const drawerRecRulesInCell = useMemo(
    () => drawerUnavailInCell.filter((x) => x.kind === "recurring"),
    [drawerUnavailInCell]
  );

  const drawerOneOffUnavailInCell = useMemo(
    () => drawerUnavailInCell.filter((x) => x.kind === "oneoff"),
    [drawerUnavailInCell]
  );

  function warnIfUnavailable(staffId: string, startISO: string, endISO: string) {
    const list = allEvents.filter((u) => u.staff_id === staffId && u.store_id === storeId);

    const hit = list.find((u) => {
      const cat = getEventCategory(u.reason, u.kind);
      if (cat !== "UNAVAILABLE") return false;
      if (u.kind === "recurring" && u.isSkippedThisWeek) return false;
      return overlaps(startISO, endISO, u.start_at, u.end_at);
    });

    if (hit) {
      const reason = hit.reason ? ` (${hit.reason})` : "";
      setMsg(`⚠️ Warning: staff unavailable overlaps this time${reason}. (Still allowed)`);
    }
  }

  async function saveShiftFromDrawer() {
    setMsg("");

    if (!drawerStaffId) {
      setMsg("❌ Missing staff.");
      return;
    }
    if (!drawerDayDate) {
      setMsg("❌ Missing day.");
      return;
    }
    if (!drawerStartTime || !drawerEndTime) {
      setMsg("❌ Please fill start and end time.");
      return;
    }

    const startISO = buildISOFromDayAndTime(drawerDayDate, drawerStartTime);
    let endISO = buildISOFromDayAndTime(drawerDayDate, drawerEndTime);

    if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
      const end = new Date(endISO);
      end.setDate(end.getDate() + 1);
      endISO = end.toISOString();
    }

    warnIfUnavailable(drawerStaffId, startISO, endISO);

    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;

    let hourlyRate = 0;
    try {
      hourlyRate = await getHourlyRateForShift(drawerStaffId, startISO);
    } catch (e: any) {
      setMsg("❌ " + (e?.message ?? "Could not determine hourly rate."));
      return;
    }

    if (drawerMode === "add") {
      const ins = await supabase.from("shifts").insert(
        [
          {
            store_id: storeId,
            staff_id: drawerStaffId,
            shift_start: startISO,
            shift_end: endISO,
            break_minutes: 0,
            hourly_rate: hourlyRate,
            created_by: uid,
          },
        ],
        { returning: "minimal" } as any
      );

      if (ins.error) {
        setMsg("❌ Add failed: " + ins.error.message);
        return;
      }

      setMsg((prev) => (prev.startsWith("⚠️") ? prev + " ✅ Shift added." : "✅ Added!"));
      closeDrawer();
      await loadShiftCosts();
      return;
    }

    if (!drawerShiftId) {
      setMsg("❌ Missing shift id.");
      return;
    }

    const up = await supabase
      .from("shifts")
      .update({
        shift_start: startISO,
        shift_end: endISO,
        break_minutes: 0,
        hourly_rate: hourlyRate,
      })
      .eq("id", drawerShiftId);

    if (up.error) {
      setMsg("❌ Update failed: " + up.error.message);
      return;
    }

    setMsg((prev) => (prev.startsWith("⚠️") ? prev + " ✅ Shift updated." : "✅ Updated!"));
    closeDrawer();
    await loadShiftCosts();
  }

  async function deleteShiftFromDrawer() {
    setMsg("");

    if (!drawerShiftId) {
      setMsg("❌ Missing shift id.");
      return;
    }

    const del = await supabase.from("shifts").delete().eq("id", drawerShiftId);

    if (del.error) {
      setMsg("❌ Delete failed: " + del.error.message);
      return;
    }

    setMsg("✅ Shift deleted.");
    closeDrawer();
    await loadShiftCosts();
  }

  async function saveAddUnavailRecurringFromDrawer() {
    setMsg("");

    if (!drawerStaffId) {
      setMsg("❌ Missing staff.");
      return;
    }
    if (drawerDayIdx < 0 || drawerDayIdx > 6) {
      setMsg("❌ Missing day.");
      return;
    }
    if (!unStartTime || !unEndTime) {
      setMsg("❌ Please fill start/end time.");
      return;
    }

    const jsDow = cellDayIdxToJsDow(drawerDayIdx);

    const ins = await supabase.from("staff_unavailability_recurring").insert(
      [
        {
          staff_id: drawerStaffId,
          store_id: storeId,
          day_of_week: jsDow,
          start_time: `${unStartTime}:00`,
          end_time: `${unEndTime}:00`,
          reason: unReason.trim() || null,
        },
      ],
      { returning: "minimal" } as any
    );

    if (ins.error) {
      setMsg("❌ Add weekly unavailable failed: " + ins.error.message);
      return;
    }

    setMsg("✅ Weekly unavailable added.");
    setUnReason("");
    closeDrawer();
    await loadRecurringRules();
    await loadRecurringOverrides();
  }

  async function deleteOneOffEvent(id: number) {
    setMsg("");
    const del = await supabase.from("staff_unavailability").delete().eq("id", id);
    if (del.error) {
      setMsg("❌ Delete failed: " + del.error.message);
      return;
    }
    setMsg("✅ Removed.");
    await loadOneOffUnavailability();
  }

  async function deleteRecurringRule(ruleId: number) {
    setMsg("");
    const del = await supabase.from("staff_unavailability_recurring").delete().eq("id", ruleId);
    if (del.error) {
      setMsg("❌ Delete weekly rule failed: " + del.error.message);
      return;
    }
    setMsg("✅ Weekly unavailable rule removed.");
    await loadRecurringRules();
    await loadRecurringOverrides();
  }

  async function skipRecurringRuleThisWeek(ruleId: number) {
    setMsg("");

    const ins = await supabase.from("staff_unavailability_recurring_overrides").upsert(
      [{ rule_id: ruleId, week_start: weekStart, store_id: storeId }],
      { onConflict: "rule_id,week_start" }
    );

    if (ins.error) {
      setMsg("❌ Skip this week failed: " + ins.error.message);
      return;
    }

    setMsg("✅ Weekly rule skipped for this week.");
    await loadRecurringOverrides();
  }

  async function unskipRecurringRuleThisWeek(ruleId: number) {
    setMsg("");

    const del = await supabase
      .from("staff_unavailability_recurring_overrides")
      .delete()
      .eq("rule_id", ruleId)
      .eq("week_start", weekStart)
      .eq("store_id", storeId);

    if (del.error) {
      setMsg("❌ Unskip failed: " + del.error.message);
      return;
    }

    setMsg("✅ Weekly rule restored for this week.");
    await loadRecurringOverrides();
  }

  async function saveAddLeaveFromDrawer() {
    setMsg("");

    if (!drawerStaffId) {
      setMsg("❌ Missing staff.");
      return;
    }
    if (!drawerDayDate) {
      setMsg("❌ Missing day.");
      return;
    }
    if (!unStartTime || !unEndTime) {
      setMsg("❌ Please fill start/end time.");
      return;
    }

    const startISO = buildISOFromDayAndTime(drawerDayDate, unStartTime);
    let endISO = buildISOFromDayAndTime(drawerDayDate, unEndTime);

    if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
      const end = new Date(endISO);
      end.setDate(end.getDate() + 1);
      endISO = end.toISOString();
    }

    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;

    const label = leaveType === "ANNUAL_LEAVE" ? "Annual Leave" : "Sick Leave";
    const finalReason = unReason.trim() ? `${label} | ${unReason.trim()}` : label;

    const ins = await supabase.from("staff_unavailability").insert(
      [
        {
          staff_id: drawerStaffId,
          store_id: storeId,
          start_at: startISO,
          end_at: endISO,
          reason: finalReason,
          created_by: uid,
        },
      ],
      { returning: "minimal" } as any
    );

    if (ins.error) {
      setMsg("❌ Add leave failed: " + ins.error.message);
      return;
    }

    setMsg(`✅ ${label} added.`);
    setUnReason("");
    setLeaveType("ANNUAL_LEAVE");
    closeDrawer();
    await loadOneOffUnavailability();
  }

  function exportWeekCSV() {
    const header = [
      "staff_name",
      "staff_id",
      "type",
      "date",
      "shift_start",
      "shift_end",
      "hours_worked",
      "applied_rate",
      "estimated_wage",
      "status",
      "covered_by",
      "cover_note",
    ].join(",");

    const shiftLines = countedRows.map((r) => {
      const coveredBy = r.covered_by_staff_id ? staffName(r.covered_by_staff_id) : "";
      const status = r.parent_shift_id ? "COVERING" : normalizeShiftStatus(r.shift_status);
      return [
        `"${staffName(r.staff_id).replace(/"/g, '""')}"`,
        r.staff_id,
        "SHIFT",
        toISODate(new Date(r.shift_start)),
        r.shift_start,
        r.shift_end,
        Number(r.hours_worked ?? 0).toFixed(2),
        Number(r.applied_rate ?? 0).toFixed(2),
        Number(r.estimated_wage ?? 0).toFixed(2),
        `"${status}"`,
        `"${String(coveredBy).replace(/"/g, '""')}"`,
        `"${String(r.cover_note ?? "").replace(/"/g, '""')}"`,
      ].join(",");
    });

    const leaveLines = paidLeaveEvents.map((e) => {
      const dateISO = toISODate(new Date(e.start_at));
      const hrs = hoursBetween(e.start_at, e.end_at);
      const rate = getRateForDate(e.staff_id, dateISO);
      const cat = getEventCategory(e.reason, e.kind);
      return [
        `"${staffName(e.staff_id).replace(/"/g, '""')}"`,
        e.staff_id,
        `"${cat}"`,
        dateISO,
        e.start_at,
        e.end_at,
        hrs.toFixed(2),
        rate.toFixed(2),
        (hrs * rate).toFixed(2),
        `"${cat}"`,
        `""`,
        `"${String(e.reason ?? "").replace(/"/g, '""')}"`,
      ].join(",");
    });

    downloadCSV(`roster_week_${storeId}_${weekStart}.csv`, [header, ...shiftLines, ...leaveLines].join("\n"));
  }

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20, position: "relative" }}>
      {drawerOpen && (
        <div
          onClick={closeDrawer}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.25)",
            zIndex: 999,
          }}
        />
      )}

      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100vh",
          width: 400,
          background: "#fff",
          borderLeft: `1px solid ${BORDER}`,
          boxShadow: "-8px 0 20px rgba(0,0,0,0.08)",
          transform: drawerOpen ? "translateX(0)" : "translateX(105%)",
          transition: "transform 160ms ease",
          zIndex: 1000,
          padding: 16,
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 900, color: TEXT }}>Edit — {dayLabels[drawerDayIdx]}</div>
          <button
            onClick={closeDrawer}
            style={{
              border: `1px solid ${BORDER}`,
              background: "#fff",
              borderRadius: 10,
              padding: "8px 10px",
              cursor: "pointer",
            }}
          >
            ✕
          </button>
        </div>

        <div
          style={{
            fontSize: 13,
            color: MUTED,
            marginBottom: 12,
            padding: 12,
            border: `1px solid ${BORDER}`,
            borderRadius: 12,
            background: "#F9FAFB",
          }}
        >
          <div>
            <b>Staff:</b> {drawerStaffId ? staffName(drawerStaffId) : "—"}
          </div>
          <div>
            <b>Date:</b> {drawerDayDate ? fmtHeaderDate(drawerDayDate) : "—"}
          </div>
          {drawerDayDate && holidayMap[toISODate(drawerDayDate)] ? (
            <div style={{ marginTop: 6, color: HOLIDAY_TEXT, fontWeight: 800 }}>
              Public Holiday — {holidayMap[toISODate(drawerDayDate)]}
            </div>
          ) : null}
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
          <button
            onClick={() => setDrawerTab("shift")}
            style={{
              fontWeight: 800,
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${BORDER}`,
              background: drawerTab === "shift" ? "#F3F4F6" : "#fff",
              cursor: "pointer",
            }}
          >
            Shift
          </button>

          <button
            onClick={() => setDrawerTab("unavail")}
            style={{
              fontWeight: 800,
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${BORDER}`,
              background: drawerTab === "unavail" ? "#F3F4F6" : "#fff",
              cursor: "pointer",
            }}
          >
            Unavailable
          </button>

          <button
            onClick={() => setDrawerTab("leave")}
            style={{
              fontWeight: 800,
              padding: "10px 12px",
              borderRadius: 10,
              border: `1px solid ${BORDER}`,
              background: drawerTab === "leave" ? "#F3F4F6" : "#fff",
              cursor: "pointer",
            }}
          >
            Leave
          </button>
        </div>

        {drawerTab === "shift" ? (
          <div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
              Mode: <b>{drawerMode === "add" ? "ADD" : "EDIT"}</b>
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>Start (24h)</div>
              <input
                type="time"
                value={drawerStartTime}
                onChange={(e) => setDrawerStartTime(e.target.value)}
                style={inputStyle("100%")}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>End (24h)</div>
              <input
                type="time"
                value={drawerEndTime}
                onChange={(e) => setDrawerEndTime(e.target.value)}
                style={inputStyle("100%")}
              />
              <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>
                If end time is earlier than start, it will be treated as overnight.
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <div style={{ flex: 1 }}>
                {actionButton(drawerMode === "add" ? "Save Shift" : "Save Changes", saveShiftFromDrawer, {
                  primary: true,
                })}
              </div>
              {drawerMode === "edit" ? actionButton("Delete", deleteShiftFromDrawer, { danger: true }) : null}
            </div>
          </div>
        ) : null}

        {drawerTab === "unavail" ? (
          <div>
            <div
              style={{
                marginBottom: 14,
                padding: 12,
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                background: "#FAFAFA",
              }}
            >
              <div style={{ fontWeight: 900, marginBottom: 6, color: TEXT }}>This day — Unavailable</div>

              {drawerOneOffUnavailInCell.length > 0 ? (
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
                  <b>One-off</b>
                  {drawerOneOffUnavailInCell.slice(0, 6).map((u) => (
                    <div
                      key={`oneoff-${u.id}`}
                      style={{
                        marginTop: 8,
                        padding: 10,
                        border: `1px solid ${UNAV_BORDER}`,
                        borderRadius: 10,
                        background: UNAV_BG,
                      }}
                    >
                      <div style={{ fontWeight: 800, color: UNAV_TEXT }}>
                        {fmtTime(u.start_at)}–{fmtTime(u.end_at)}
                      </div>
                      <div style={{ color: MUTED, marginTop: 4 }}>
                        {u.reason ? u.reason : "No reason"} (one-off)
                      </div>
                      <div style={{ marginTop: 8 }}>
                        {actionButton("Delete one-off", () => deleteOneOffEvent(u.id), {
                          danger: true,
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#999", marginBottom: 10 }}>No one-off unavailable shown here.</div>
              )}

              {drawerRecRulesInCell.length > 0 ? (
                <div style={{ fontSize: 12, color: MUTED }}>
                  <b>Weekly rules</b>
                  {drawerRecRulesInCell.map((u) => {
                    const skipped = !!u.isSkippedThisWeek;
                    return (
                      <div
                        key={`rule-${u.id}`}
                        style={{
                          marginTop: 8,
                          padding: 10,
                          border: `1px solid ${UNAV_BORDER}`,
                          borderRadius: 10,
                          background: UNAV_BG,
                        }}
                      >
                        <div style={{ fontWeight: 900, color: skipped ? "#999" : UNAV_TEXT }}>
                          {fmtTime(u.start_at)}–{fmtTime(u.end_at)}{" "}
                          <span style={{ fontWeight: 700, fontSize: 12 }}>
                            {skipped ? "(skipped this week)" : ""}
                          </span>
                        </div>

                        <div style={{ marginTop: 4, color: MUTED }}>{u.reason || "No reason"}</div>

                        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                          {!skipped
                            ? actionButton("Skip this week", () => skipRecurringRuleThisWeek(u.id))
                            : actionButton("Restore this week", () => unskipRecurringRuleThisWeek(u.id), {
                                primary: true,
                              })}

                          {actionButton("Delete rule", () => deleteRecurringRule(u.id), { danger: true })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#999", marginBottom: 10 }}>No weekly rule for this day.</div>
              )}
            </div>

            <div
              style={{
                padding: 12,
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                background: "#fff",
              }}
            >
              <div style={{ fontWeight: 900, marginBottom: 8, color: TEXT }}>Add Weekly Unavailable</div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>Start (24h)</div>
                <input
                  type="time"
                  value={unStartTime}
                  onChange={(e) => setUnStartTime(e.target.value)}
                  style={inputStyle("100%")}
                />
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>End (24h)</div>
                <input
                  type="time"
                  value={unEndTime}
                  onChange={(e) => setUnEndTime(e.target.value)}
                  style={inputStyle("100%")}
                />
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>Reason</div>
                <input
                  value={unReason}
                  onChange={(e) => setUnReason(e.target.value)}
                  placeholder="Optional reason"
                  style={inputStyle("100%")}
                />
              </div>

              {actionButton("Save weekly unavailable", saveAddUnavailRecurringFromDrawer, { primary: true })}
            </div>
          </div>
        ) : null}

        {drawerTab === "leave" ? (
          <div>
            <div
              style={{
                marginBottom: 14,
                padding: 12,
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                background: "#FAFAFA",
              }}
            >
              <div style={{ fontWeight: 900, marginBottom: 6, color: TEXT }}>This day — Leave</div>

              {drawerLeavesInCell.length > 0 ? (
                <div style={{ fontSize: 12, color: MUTED }}>
                  {drawerLeavesInCell.map((u) => {
                    const cat = getEventCategory(u.reason, u.kind);
                    const title =
                      cat === "ANNUAL_LEAVE"
                        ? "Annual Leave"
                        : cat === "SICK_LEAVE"
                        ? "Sick Leave"
                        : "Leave";

                    return (
                      <div
                        key={`leave-${u.kind}-${u.id}`}
                        style={{
                          marginTop: 8,
                          padding: 10,
                          border: `1px solid ${LEAVE_BORDER}`,
                          borderRadius: 10,
                          background: LEAVE_BG,
                        }}
                      >
                        <div style={{ fontWeight: 800, color: LEAVE_TEXT }}>
                          {fmtTime(u.start_at)}–{fmtTime(u.end_at)}
                        </div>
                        <div style={{ color: MUTED, marginTop: 4 }}>
                          {title} | {hoursBetween(u.start_at, u.end_at).toFixed(2)}h
                        </div>
                        <div style={{ color: MUTED, marginTop: 4 }}>{u.reason || "No reason"}</div>
                        {u.kind === "oneoff" ? (
                          <div style={{ marginTop: 8 }}>
                            {actionButton("Delete leave", () => deleteOneOffEvent(u.id), {
                              danger: true,
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#999", marginBottom: 10 }}>No leave shown here.</div>
              )}
            </div>

            <div
              style={{
                padding: 12,
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                background: "#fff",
              }}
            >
              <div style={{ fontWeight: 900, marginBottom: 8, color: TEXT }}>Add Leave (One-off)</div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>Leave Type</div>
                <select
                  value={leaveType}
                  onChange={(e) => setLeaveType(e.target.value as "ANNUAL_LEAVE" | "SICK_LEAVE")}
                  style={inputStyle("100%")}
                >
                  <option value="ANNUAL_LEAVE">Annual Leave</option>
                  <option value="SICK_LEAVE">Sick Leave</option>
                </select>
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>Start (24h)</div>
                <input
                  type="time"
                  value={unStartTime}
                  onChange={(e) => setUnStartTime(e.target.value)}
                  style={inputStyle("100%")}
                />
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>End (24h)</div>
                <input
                  type="time"
                  value={unEndTime}
                  onChange={(e) => setUnEndTime(e.target.value)}
                  style={inputStyle("100%")}
                />
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>Note (optional)</div>
                <input
                  value={unReason}
                  onChange={(e) => setUnReason(e.target.value)}
                  placeholder="Optional note"
                  style={inputStyle("100%")}
                />
              </div>

              {actionButton("Save Leave", saveAddLeaveFromDrawer, { primary: true })}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ maxWidth: 1480, margin: "0 auto" }}>
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
              <h1 style={{ margin: 0, color: TEXT }}>Roster (Week)</h1>
              <div style={{ marginTop: 6, color: MUTED }}>
                Weekly roster planning and availability management
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
              gap: 18,
              flexWrap: "wrap",
              marginBottom: 16,
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Week range</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: TEXT }}>{weekRangeText(weekStart)}</div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-end" }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {subtleButton("Prev Week", () => setWeekStart((w) => addDaysISO(w, -7)), {
                  disabled: copyLoading || ratesLoading,
                })}
                {subtleButton("This Week", () => setWeekStart(getThisWeekThuISO()), {
                  active: true,
                  disabled: copyLoading || ratesLoading,
                })}
                {subtleButton("Next Week", handleNextWeek, {
                  disabled: copyLoading || ratesLoading,
                })}
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {subtleButton("Copy Prev", handleCopyFromPreviousWeek, {
                  disabled: copyLoading || ratesLoading || pubLoading,
                })}
                {subtleButton(
                  "Update Rates",
                  async () => {
                    if (!confirm("Apply the latest pay rates to all shifts in this week?")) return;
                    await applyLatestRatesForWeek();
                  },
                  {
                    disabled: copyLoading || ratesLoading || pubLoading,
                  }
                )}
                {subtleButton("Refresh", loadAll, {
                  disabled: copyLoading || ratesLoading || pubLoading,
                })}
                {subtleButton("Export CSV", exportWeekCSV, {
                  disabled: copyLoading || ratesLoading || pubLoading,
                })}
                {!isPublished
                  ? actionButton("Publish", publishWeek, {
                      primary: true,
                      disabled: pubLoading || copyLoading || ratesLoading,
                    })
                  : actionButton("Unpublish", unpublishWeek, {
                      danger: true,
                      disabled: pubLoading || copyLoading || ratesLoading,
                    })}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {statCard("Week start", weekStart)}
            {statCard(
              "Roster status",
              "",
              undefined,
              isPublished ? badge("PUBLISHED", "green") : badge("DRAFT", "yellow")
            )}
            {statCard("Shift hours", `${storeTotalHours.toFixed(2)}h`, WAK_BLUE)}
            {statCard("Shift wage", `$${storeTotalWage.toFixed(2)}`, WAK_RED)}
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
          <div style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Weekly Roster Board</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
              Click empty space to add shift, click a shift card to edit, click leave or unavailable blocks to manage them.
            </div>
          </div>

          <div
            style={{
              overflowX: "auto",
              overflowY: "auto",
              maxHeight: "72vh",
              border: `1px solid ${BORDER}`,
              borderRadius: 14,
            }}
          >
            <table
              style={{
                borderCollapse: "separate",
                borderSpacing: 0,
                minWidth: 900,
                width: "100%",
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      borderBottom: `1px solid ${BORDER}`,
                      borderRight: `1px solid ${BORDER}`,
                      position: "sticky",
                      top: 0,
                      left: 0,
                      zIndex: 4,
                      background: "#FAFAFA",
                      minWidth: 50,
                      width: 80,
                      maxWidth: 80,
                      padding: "14px 10px",
                      textAlign: "left",
                      color: TEXT,
                    }}
                  >
                    NAME
                  </th>

                  {dayLabels.map((d, i) => {
                    const dayISO = toISODate(dayDates[i]);
                    const isToday = dayISO === todayISO;
                    const holidayLabel = holidayMap[dayISO] ?? null;

                    return (
                      <th
                        key={`${d}-${i}`}
                        style={{
                          borderBottom: `1px solid ${BORDER}`,
                          borderRight: `1px solid ${BORDER}`,
                          position: "sticky",
                          top: 0,
                          zIndex: 3,
                          background: holidayLabel ? "#FFF9E8" : "#FAFAFA",
                          minWidth: 120,
                          width: 120,
                          padding: "12px 10px",
                          textAlign: "left",
                          verticalAlign: "top",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <div style={{ fontWeight: 800, color: TEXT }}>{d}</div>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {isToday ? badge("TODAY", "blue") : null}
                            {holidayLabel ? badge("PUBLIC HOLIDAY", "yellow") : null}
                          </div>
                        </div>

                        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{fmtHeaderDate(dayDates[i])}</div>

                        {holidayLabel ? (
                          <div style={{ fontSize: 12, color: HOLIDAY_TEXT, marginTop: 4, fontWeight: 700 }}>
                            {holidayLabel}
                          </div>
                        ) : null}

                        <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                          Day total: <b style={{ color: TEXT }}>{dailyTotals[i].hours.toFixed(2)}h</b> |{" "}
                          <b style={{ color: TEXT }}>${dailyTotals[i].wage.toFixed(2)}</b>
                        </div>
                      </th>
                    );
                  })}

                  <th
                    style={{
                      borderBottom: `1px solid ${BORDER}`,
                      position: "sticky",
                      top: 0,
                      right: 0,
                      zIndex: 4,
                      background: "#FAFAFA",
                      minWidth: 100,
                      width: 100,
                      padding: "12px 10px",
                      textAlign: "left",
                      verticalAlign: "top",
                    }}
                  >
                    <div style={{ fontWeight: 800, color: TEXT }}>WEEKLY SUMMARY</div>
                    <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>Total Hours / Wage</div>
                  </th>
                </tr>
              </thead>

              <tbody>
                {staffIds.map((sid) => (
                  <tr key={sid}>
                    <td
                      style={{
                        position: "sticky",
                        left: 0,
                        zIndex: 2,
                        background: "#fff",
                        borderRight: `1px solid ${BORDER}`,
                        borderBottom: `1px solid ${BORDER}`,
                        padding: "14px 10px",
                        verticalAlign: "top",
                      }}
                    >
                      <div style={{ fontWeight: 900, color: TEXT }}>{staffName(sid)}</div>
                    </td>

                    {Array.from({ length: 7 }, (_, dayIdx) => {
                      const dayRows = grid[sid]?.[dayIdx] ?? [];
                      const dayEvents = eventGrid[sid]?.[dayIdx] ?? [];
                      const holidayLabel = holidayMap[toISODate(dayDates[dayIdx])] ?? null;

                      const dayLeaves = dayEvents.filter((u) => {
                        const cat = getEventCategory(u.reason, u.kind);
                        return cat === "ANNUAL_LEAVE" || cat === "SICK_LEAVE" || cat === "LEAVE";
                      });

                      const dayUnav = dayEvents.filter((u) => {
                        const cat = getEventCategory(u.reason, u.kind);
                        return cat === "UNAVAILABLE";
                      });

                      const hasActiveUnav = dayUnav.some((u) => !(u.kind === "recurring" && u.isSkippedThisWeek));

                      return (
                        <td
                          key={`${sid}-${dayIdx}`}
                          onClick={() => openDrawerFromCell(sid, dayIdx)}
                          style={{
                            borderRight: `1px solid ${BORDER}`,
                            borderBottom: `1px solid ${BORDER}`,
                            padding: 10,
                            verticalAlign: "top",
                            background: hasActiveUnav ? "#FFF8F8" : holidayLabel ? "#FFFDF5" : "#fff",
                            cursor: "pointer",
                          }}
                        >
                          {holidayLabel && (
                            <div
                              style={{
                                fontSize: 12,
                                marginBottom: 8,
                                padding: "8px 10px",
                                border: `1px solid ${HOLIDAY_BORDER}`,
                                borderRadius: 10,
                                background: HOLIDAY_BG,
                                color: HOLIDAY_TEXT,
                                fontWeight: 800,
                              }}
                            >
                              Public Holiday — {holidayLabel}
                            </div>
                          )}

                          {dayLeaves.length > 0 ? (
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                openDrawerForLeave(sid, dayIdx);
                              }}
                              style={{
                                marginBottom: 8,
                                padding: 10,
                                border: `1px solid ${LEAVE_BORDER}`,
                                borderRadius: 12,
                                background: LEAVE_BG,
                              }}
                            >
                              <div style={{ fontWeight: 800, color: LEAVE_TEXT, marginBottom: 4 }}>Leave</div>

                              {dayLeaves.slice(0, 3).map((u, idx) => {
                                const cat = getEventCategory(u.reason, u.kind);
                                const title =
                                  cat === "ANNUAL_LEAVE"
                                    ? "Annual Leave"
                                    : cat === "SICK_LEAVE"
                                    ? "Sick Leave"
                                    : "Leave";

                                return (
                                  <div
                                    key={`${u.kind}-${u.id}-${idx}`}
                                    style={{ fontSize: 12, color: TEXT, marginTop: 4 }}
                                  >
                                    {fmtTime(u.start_at)}–{fmtTime(u.end_at)} | {hoursBetween(u.start_at, u.end_at).toFixed(2)}h
                                    <div style={{ color: MUTED, marginTop: 2 }}>
                                      {title}
                                      {u.kind === "oneoff" ? " (one-off)" : ""}
                                    </div>
                                  </div>
                                );
                              })}

                              {dayLeaves.length > 3 ? (
                                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                                  +{dayLeaves.length - 3} more
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          {dayUnav.length > 0 ? (
                            <div
                              onClick={(e) => {
                                e.stopPropagation();
                                openDrawerForUnavailable(sid, dayIdx);
                              }}
                              style={{
                                marginBottom: 8,
                                padding: 10,
                                border: `1px solid ${UNAV_BORDER}`,
                                borderRadius: 12,
                                background: UNAV_BG,
                              }}
                            >
                              <div style={{ fontWeight: 800, color: UNAV_TEXT, marginBottom: 4 }}>Unavailable</div>

                              {dayUnav.slice(0, 3).map((u, idx) => (
                                <div key={`${u.kind}-${u.id}-${idx}`} style={{ fontSize: 12, color: TEXT, marginTop: 4 }}>
                                  {fmtTime(u.start_at)}–{fmtTime(u.end_at)}
                                  {u.reason ? ` | ${u.reason}` : ""}
                                  {u.kind === "recurring"
                                    ? u.isSkippedThisWeek
                                      ? " (rule skipped)"
                                      : " (weekly)"
                                    : " (one-off)"}
                                </div>
                              ))}

                              {dayUnav.length > 3 ? (
                                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                                  +{dayUnav.length - 3} more
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          <div style={{ display: "grid", gap: 8 }}>
                            {dayRows.map((r) => {
                              const v = getShiftVisual(r);
                              const coveredBy = r.covered_by_staff_id ? staffName(r.covered_by_staff_id) : "";
                              const note = (r.cover_note ?? "").trim();

                              return (
                                <div
                                  key={r.shift_id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openDrawerForEditShift(r);
                                  }}
                                  style={{
                                    padding: 10,
                                    border: `1px solid ${v.border}`,
                                    borderRadius: 12,
                                    background: v.bg,
                                    boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
                                  }}
                                >
                                  <div style={{ fontWeight: 900, color: v.title }}>
                                    {fmtTime(r.shift_start)}–{fmtTime(r.shift_end)}
                                  </div>

                                  {v.label ? (
                                    <div style={{ fontSize: 11, fontWeight: 900, color: v.meta, marginTop: 4 }}>
                                      {v.label}
                                      {coveredBy ? ` · by ${coveredBy}` : ""}
                                    </div>
                                  ) : null}

                                  {note ? <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>Note: {note}</div> : null}

                                  <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                                    {r.hours_worked.toFixed(2)}h | Rate ${Number(r.applied_rate ?? 0).toFixed(2)}
                                  </div>
                                  <div style={{ fontSize: 12, color: TEXT, marginTop: 2 }}>
                                    Wage ${Number(r.estimated_wage ?? 0).toFixed(2)}
                                  </div>
                                </div>
                              );
                            })}
                          </div>

                          {dayRows.length === 0 && dayLeaves.length === 0 && dayUnav.length === 0 ? (
                            <div style={{ fontSize: 12, color: "#9CA3AF" }}>Click to add</div>
                          ) : null}
                        </td>
                      );
                    })}

                    <td
                      style={{
                        position: "sticky",
                        right: 0,
                        zIndex: 2,
                        background: "#fff",
                        borderBottom: `1px solid ${BORDER}`,
                        padding: "12px 10px",
                        verticalAlign: "top",
                        minWidth: 100,
                        width: 100,
                      }}
                    >
                      <div style={{ fontSize: 12, color: MUTED }}>Total Hours</div>
                      <div style={{ fontWeight: 900, color: TEXT, marginBottom: 10 }}>
                        {Number(weeklySummaryByStaff[sid]?.totalHours ?? 0).toFixed(2)}h
                      </div>

                      <div style={{ fontSize: 12, color: MUTED }}>Wage</div>
                      <div style={{ fontWeight: 900, color: WAK_RED }}>
                        ${Number(weeklySummaryByStaff[sid]?.wage ?? 0).toFixed(2)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}