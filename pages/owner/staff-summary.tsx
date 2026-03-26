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
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes?: number | null;
  hourly_rate?: number | null;
  shift_status?: ShiftStatus | null;
};

type TimeClock = {
  id: number;
  shift_id: number | null;
  staff_id: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  adjusted_clock_in_at?: string | null;
  adjusted_clock_out_at?: string | null;
};

type Profile = {
  id: string;
  full_name: string | null;
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

type DayType =
  | "WEEKDAY"
  | "SATURDAY"
  | "SUNDAY"
  | "PUBLIC_HOLIDAY"
  | "SICK_LEAVE"
  | "ANNUAL_LEAVE";

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

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

function getDayTypeByISO(iso: string): "WEEKDAY" | "SATURDAY" | "SUNDAY" {
  const d = new Date(iso);
  const day = d.getDay();
  if (day === 0) return "SUNDAY";
  if (day === 6) return "SATURDAY";
  return "WEEKDAY";
}

function overlaps(aStartISO: string, aEndISO: string, bStartISO: string, bEndISO: string) {
  const aStart = new Date(aStartISO).getTime();
  const aEnd = new Date(aEndISO).getTime();
  const bStart = new Date(bStartISO).getTime();
  const bEnd = new Date(bEndISO).getTime();
  return aStart < bEnd && bStart < aEnd;
}

function getLeaveCategory(reason: string | null): "ANNUAL_LEAVE" | "SICK_LEAVE" | null {
  const text = (reason ?? "").toLowerCase();
  if (text.includes("annual leave")) return "ANNUAL_LEAVE";
  if (text.includes("sick leave")) return "SICK_LEAVE";
  return null;
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

function normalizeShiftStatus(v: any): ShiftStatus {
  const s = String(v ?? "SCHEDULED").toUpperCase();
  if (s === "WORKED" || s === "ABSENT" || s === "SICK" || s === "CANCELLED" || s === "COVERED") {
    return s as ShiftStatus;
  }
  return "SCHEDULED";
}

function isNoHourStatus(status: ShiftStatus | null | undefined) {
  return status === "ABSENT" || status === "COVERED" || status === "SICK" || status === "CANCELLED";
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
        boxShadow: primary || danger ? "0 8px 18px rgba(0,0,0,0.10)" : "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
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

function dayTypeLabel(dayType: DayType) {
  if (dayType === "SATURDAY") return "Saturday";
  if (dayType === "SUNDAY") return "Sunday";
  if (dayType === "PUBLIC_HOLIDAY") return "Public Holiday";
  if (dayType === "SICK_LEAVE") return "Sick Leave";
  if (dayType === "ANNUAL_LEAVE") return "Annual Leave";
  return "Weekday";
}

export default function OwnerStaffSummaryPage() {
  const [authLoading, setAuthLoading] = useState(true);
  const [viewerRole, setViewerRole] = useState<string | null>(null);

  const isOwner = viewerRole === "OWNER";

  async function loadPermission() {
    setAuthLoading(true);

    const { data } = await supabase.auth.getUser();
    const user = data?.user;

    if (!user) {
      window.location.href = "/";
      return;
    }

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
  const [leaveRows, setLeaveRows] = useState<LeaveRecord[]>([]);

  const nameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of profiles) {
      if (p?.id) map[p.id] = p.full_name ?? p.id;
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
    if (!isOwner) return;

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

        supabase.from("staff_pay_rates").select("staff_id, weekday_rate, saturday_rate, sunday_rate, holiday_rate"),

        supabase
          .from("staff_unavailability")
          .select("id, staff_id, start_at, end_at, reason")
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
    if (!authLoading && isOwner) fetchData();
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

  function getPayrollResult(shift: Shift, clock: TimeClock | null, leave: LeaveRecord | null) {
    const status = normalizeShiftStatus((shift as any).shift_status);
    const breakMin = shift.break_minutes ?? 0;

    const rosterMin = minutesBetween(shift.shift_start, shift.shift_end);
    const rawMin = clock ? minutesBetween(clock.clock_in_at, clock.clock_out_at) : null;

    const adjIn = clock?.adjusted_clock_in_at ?? null;
    const adjOut = clock?.adjusted_clock_out_at ?? null;
    const adjMin = adjIn && adjOut ? minutesBetween(adjIn, adjOut) : null;

    const rosterWorkMin = rosterMin !== null ? Math.max(0, rosterMin - breakMin) : 0;
    const rawWorkMin = rawMin !== null ? Math.max(0, rawMin - breakMin) : null;
    const adjWorkMin = adjMin !== null ? Math.max(0, adjMin - breakMin) : null;

    // shift_status first
    if (isNoHourStatus(status)) {
      return {
        dayType: null as DayType | null,
        source: status,
        payrollWorkMin: 0,
        rate: null as number | null,
        payrollHours: 0,
        pay: 0,
      };
    }

    // roster leave
    if (leave) {
      const leaveType = getLeaveCategory(leave.reason);
      const rate = Number(weekdayRateByStaff[shift.staff_id] ?? 0);
      const dayType: DayType = leaveType === "ANNUAL_LEAVE" ? "ANNUAL_LEAVE" : "SICK_LEAVE";
      const payrollHours = round2(rosterWorkMin / 60);
      const pay = round2(payrollHours * rate);

      return {
        dayType,
        source: "LEAVE",
        payrollWorkMin: rosterWorkMin,
        rate,
        payrollHours,
        pay,
      };
    }

    // public holiday
    if (isVictoriaPublicHolidayISO(shift.shift_start)) {
      const payrollWorkMin = adjWorkMin ?? rawWorkMin ?? rosterWorkMin;
      const source =
        adjWorkMin !== null ? "ADJUSTED" : rawWorkMin !== null ? "RAW" : rosterWorkMin !== null ? "ROSTER" : "NONE";

      const rate = shift.hourly_rate ?? null;
      const payrollHours = payrollWorkMin !== null ? round2(payrollWorkMin / 60) : null;
      const pay =
        payrollHours !== null && rate !== null ? round2(payrollHours * Number(rate)) : null;

      return {
        dayType: "PUBLIC_HOLIDAY" as DayType,
        source,
        payrollWorkMin,
        rate,
        payrollHours,
        pay,
      };
    }

    // normal weekday/weekend
    const payrollWorkMin = adjWorkMin ?? rawWorkMin ?? rosterWorkMin;
    const source =
      adjWorkMin !== null ? "ADJUSTED" : rawWorkMin !== null ? "RAW" : rosterWorkMin !== null ? "ROSTER" : "NONE";

    const dayType = getDayTypeByISO(shift.shift_start);
    const rate = shift.hourly_rate ?? null;
    const payrollHours = payrollWorkMin !== null ? round2(payrollWorkMin / 60) : null;
    const pay =
      payrollHours !== null && rate !== null ? round2(payrollHours * Number(rate)) : null;

    return {
      dayType,
      source,
      payrollWorkMin,
      rate,
      payrollHours,
      pay,
    };
  }

  const filteredShifts = useMemo(() => {
    if (selectedStaffId === "ALL") return shifts;
    return shifts.filter((s) => s.staff_id === selectedStaffId);
  }, [shifts, selectedStaffId]);

  const rows = useMemo(() => {
    return filteredShifts.map((shift) => {
      const clock = findClockForShift(shift);
      const leave = findLeaveForShift(shift);
      const payroll = getPayrollResult(shift, clock, leave);

      return {
        shift,
        clock,
        leave,
        payroll,
        dayType: payroll.dayType,
        rate: payroll.rate,
        payrollHours: payroll.payrollHours,
        pay: payroll.pay,
      };
    });
  }, [filteredShifts, clocks, leaveRows, weekdayRateByStaff]);

  const overallSummary = useMemo(() => {
    let totalHours = 0;
    let totalPay = 0;

    for (const r of rows) {
      totalHours += Number(r.payrollHours ?? 0);
      totalPay += Number(r.pay ?? 0);
    }

    return {
      totalHours: round2(totalHours),
      totalPay: round2(totalPay),
    };
  }, [rows]);

  const summaryByStaff = useMemo(() => {
    const map: Record<
      string,
      {
        staffId: string;
        staffName: string;
        groups: {
          dayType: DayType;
          rate: number | null;
          hours: number;
          pay: number;
        }[];
      }
    > = {};

    for (const r of rows) {
      if (!r.dayType) continue;
      if (!r.payrollHours || r.payrollHours <= 0) continue;

      const staffId = r.shift.staff_id;
      const staffName = staffLabel(staffId);

      map[staffId] ??= {
        staffId,
        staffName,
        groups: [],
      };

      const rateKey = r.rate === null || r.rate === undefined ? "NULL" : String(Number(r.rate));
      const existing = map[staffId].groups.find(
        (g) =>
          g.dayType === r.dayType &&
          (g.rate === null || g.rate === undefined ? "NULL" : String(Number(g.rate))) === rateKey
      );

      const h = Number(r.payrollHours ?? 0);
      const p = Number(r.pay ?? 0);

      if (existing) {
        existing.hours = round2(existing.hours + h);
        existing.pay = round2(existing.pay + p);
      } else {
        map[staffId].groups.push({
          dayType: r.dayType,
          rate: r.rate ?? null,
          hours: round2(h),
          pay: round2(p),
        });
      }
    }

    const dayOrder: Record<DayType, number> = {
      WEEKDAY: 1,
      SATURDAY: 2,
      SUNDAY: 3,
      PUBLIC_HOLIDAY: 4,
      SICK_LEAVE: 5,
      ANNUAL_LEAVE: 6,
    };

    return Object.values(map)
      .map((s) => ({
        ...s,
        groups: s.groups
          .filter((g) => g.hours > 0)
          .sort((a, b) => {
            if (dayOrder[a.dayType] !== dayOrder[b.dayType]) {
              return dayOrder[a.dayType] - dayOrder[b.dayType];
            }
            const rateA = a.rate ?? -1;
            const rateB = b.rate ?? -1;
            return rateA - rateB;
          }),
      }))
      .sort((a, b) => a.staffName.localeCompare(b.staffName));
  }, [rows, nameById]);

  const staffOptions = useMemo(() => {
    const list = profiles
      .filter((p) => p?.id && (p.is_active === undefined || p.is_active === null || p.is_active === true))
      .map((p) => ({ id: p.id, name: p.full_name ?? p.id }));

    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [profiles]);

  const shownStaffCount = summaryByStaff.length;

  if (authLoading) {
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
            <h1 style={{ margin: 0, color: TEXT }}>Payroll Summary</h1>
            <div style={{ marginTop: 10, color: MUTED }}>Loading permission...</div>
          </div>
        </div>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
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
                <h1 style={{ marginTop: 0, color: TEXT }}>Payroll Summary</h1>
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
              <b>Access denied.</b> This page is only for <b>Owner</b>.
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
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
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
              <h1 style={{ margin: 0, color: TEXT }}>Payroll Summary</h1>
              <div style={{ marginTop: 6, color: MUTED }}>
                Owner-only payroll hours and pay overview
              </div>
            </div>

            <div>
              {actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}
            </div>
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
                style={inputStyle(160)}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>To (inclusive)</div>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                disabled={loading}
                style={inputStyle(160)}
              />
            </div>

            <div style={{ minWidth: 220 }}>
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
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Overall Summary</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
              Payroll priority: <b>Status</b> → <b>Leave</b> → <b>Public Holiday</b> → <b>Adjusted</b> → <b>Raw clock</b> → <b>Roster</b>.
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "#F9FAFB",
                border: `1px solid ${BORDER}`,
                minWidth: 140,
              }}
            >
              <div style={{ fontSize: 12, color: MUTED }}>Staff shown</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: TEXT }}>{shownStaffCount}</div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "#F9FAFB",
                border: `1px solid ${BORDER}`,
                minWidth: 140,
              }}
            >
              <div style={{ fontSize: 12, color: MUTED }}>Total hours</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: WAK_BLUE }}>
                {overallSummary.totalHours.toFixed(2)}h
              </div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "#F9FAFB",
                border: `1px solid ${BORDER}`,
                minWidth: 140,
              }}
            >
              <div style={{ fontSize: 12, color: MUTED }}>Total pay</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: WAK_RED }}>
                {money(overallSummary.totalPay)}
              </div>
            </div>
          </div>
        </div>

        {summaryByStaff.length === 0 ? (
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 18,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
              color: MUTED,
            }}
          >
            No data.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 14 }}>
            {summaryByStaff.map((staff) => {
              const staffTotalHours = round2(staff.groups.reduce((sum, g) => sum + g.hours, 0));
              const staffTotalPay = round2(staff.groups.reduce((sum, g) => sum + g.pay, 0));

              return (
                <div
                  key={staff.staffId}
                  style={{
                    border: `1px solid ${BORDER}`,
                    borderRadius: 18,
                    background: CARD_BG,
                    padding: 16,
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
                      marginBottom: 12,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 900, fontSize: 18, color: TEXT }}>{staff.staffName}</div>
                      <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
                        {staff.groups.length} payroll line{staff.groups.length === 1 ? "" : "s"}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                      <div style={{ minWidth: 90 }}>
                        <div style={{ fontSize: 12, color: MUTED }}>Hours</div>
                        <div style={{ fontWeight: 800, color: WAK_BLUE }}>{staffTotalHours.toFixed(2)}h</div>
                      </div>
                      <div style={{ minWidth: 100 }}>
                        <div style={{ fontSize: 12, color: MUTED }}>Pay</div>
                        <div style={{ fontWeight: 800, color: WAK_RED }}>{money(staffTotalPay)}</div>
                      </div>
                    </div>
                  </div>

                  <div style={{ overflowX: "auto" }}>
                    <table
                      cellPadding={0}
                      style={{
                        width: "100%",
                        borderCollapse: "separate",
                        borderSpacing: 0,
                        minWidth: 560,
                      }}
                    >
                      <thead>
                        <tr>
                          <th
                            style={{
                              textAlign: "left",
                              padding: "12px 12px",
                              borderBottom: `1px solid ${BORDER}`,
                              color: MUTED,
                              fontSize: 13,
                              background: "#FAFAFA",
                              width: "34%",
                            }}
                          >
                            Type
                          </th>
                          <th
                            style={{
                              textAlign: "left",
                              padding: "12px 12px",
                              borderBottom: `1px solid ${BORDER}`,
                              color: MUTED,
                              fontSize: 13,
                              background: "#FAFAFA",
                              width: "22%",
                            }}
                          >
                            Hours
                          </th>
                          <th
                            style={{
                              textAlign: "left",
                              padding: "12px 12px",
                              borderBottom: `1px solid ${BORDER}`,
                              color: MUTED,
                              fontSize: 13,
                              background: "#FAFAFA",
                              width: "22%",
                            }}
                          >
                            Payrate
                          </th>
                          <th
                            style={{
                              textAlign: "left",
                              padding: "12px 12px",
                              borderBottom: `1px solid ${BORDER}`,
                              color: MUTED,
                              fontSize: 13,
                              background: "#FAFAFA",
                              width: "22%",
                            }}
                          >
                            Pay
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {staff.groups.map((group, idx) => (
                          <tr key={`${staff.staffId}-${group.dayType}-${idx}`}>
                            <td
                              style={{
                                padding: "12px 12px",
                                borderBottom: `1px solid ${BORDER}`,
                                color: TEXT,
                                fontWeight: 700,
                                verticalAlign: "middle",
                              }}
                            >
                              {dayTypeLabel(group.dayType)}
                            </td>
                            <td
                              style={{
                                padding: "12px 12px",
                                borderBottom: `1px solid ${BORDER}`,
                                color: TEXT,
                                verticalAlign: "middle",
                              }}
                            >
                              {group.hours.toFixed(2)}h
                            </td>
                            <td
                              style={{
                                padding: "12px 12px",
                                borderBottom: `1px solid ${BORDER}`,
                                color: TEXT,
                                verticalAlign: "middle",
                              }}
                            >
                              {group.rate === null ? "-" : money(group.rate)}
                            </td>
                            <td
                              style={{
                                padding: "12px 12px",
                                borderBottom: `1px solid ${BORDER}`,
                                color: TEXT,
                                fontWeight: 700,
                                verticalAlign: "middle",
                              }}
                            >
                              {money(group.pay)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}