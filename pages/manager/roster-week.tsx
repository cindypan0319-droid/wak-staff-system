import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Profile = { id: string; full_name: string | null };

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
    d.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  return `${fmt(start)} → ${fmt(end)}`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
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
function hhmm_to_hhmmss(t: string) {
  if (!t) return "00:00:00";
  return t.length === 5 ? `${t}:00` : t;
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

function badge(label: string, kind: "green" | "yellow" | "blue" | "gray" | "red" = "gray") {
  const styles: Record<string, { bg: string; color: string }> = {
    green: { bg: "#DCFCE7", color: "#166534" },
    yellow: { bg: "#FEF3C7", color: "#92400E" },
    blue: { bg: "#EAF3FF", color: WAK_BLUE },
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
  const [msg, setMsg] = useState("");

  const [isPublished, setIsPublished] = useState<boolean>(false);
  const [pubLoading, setPubLoading] = useState<boolean>(false);
  const [copyLoading, setCopyLoading] = useState<boolean>(false);
  const [ratesLoading, setRatesLoading] = useState<boolean>(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"shift" | "unavail">("shift");
  const [drawerMode, setDrawerMode] = useState<"add" | "edit">("add");
  const [drawerStaffId, setDrawerStaffId] = useState<string>("");
  const [drawerDayIdx, setDrawerDayIdx] = useState<number>(0);
  const [drawerShiftId, setDrawerShiftId] = useState<number | null>(null);

  const [drawerStartTime, setDrawerStartTime] = useState<string>("17:00");
  const [drawerEndTime, setDrawerEndTime] = useState<string>("21:00");

  const [unStartTime, setUnStartTime] = useState("17:00");
  const [unEndTime, setUnEndTime] = useState("21:00");
  const [unReason, setUnReason] = useState("");

  function staffName(id: string) {
    const p = profiles.find((x) => x.id === id);
    return p?.full_name?.trim() ? p.full_name : id.slice(0, 8);
  }

  async function getHourlyRateForShift(staffId: string, shiftStartISO: string): Promise<number> {
    const { data, error } = await supabase
      .from("staff_pay_rates")
      .select("weekday_rate, saturday_rate, sunday_rate")
      .eq("staff_id", staffId)
      .single();

    if (error || !data) {
      throw new Error("Could not find pay rate for this staff member.");
    }

    const day = new Date(shiftStartISO).getDay();
    if (day === 6) return Number(data.saturday_rate ?? 0);
    if (day === 0) return Number(data.sunday_rate ?? 0);
    return Number(data.weekday_rate ?? 0);
  }

  async function loadProfiles() {
    const p = await supabase.from("profiles").select("id, full_name");
    if (p.error) {
      console.log(p.error);
      setProfiles([]);
      return;
    }
    setProfiles((p.data ?? []) as any);
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

    const toNum = (v: any) => (v === null || v === undefined ? 0 : Number(v));

    setRows(
      (r.data ?? []).map((x: any) => ({
        shift_id: x.shift_id,
        store_id: x.store_id,
        staff_id: x.staff_id,
        shift_start: x.shift_start,
        shift_end: x.shift_end,
        break_minutes: toNum(x.break_minutes),
        hours_worked: toNum(x.hours_worked),
        applied_rate: x.applied_rate === null ? null : Number(x.applied_rate),
        estimated_wage: x.estimated_wage === null ? null : Number(x.estimated_wage),
      }))
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
        .select("staff_id, weekday_rate, saturday_rate, sunday_rate")
        .in("staff_id", uniqueStaffIds);

      if (rateRes.error) {
        setMsg("❌ Failed to load latest rates: " + rateRes.error.message);
        return;
      }

      const rateByStaff: Record<
        string,
        { weekday_rate: number; saturday_rate: number; sunday_rate: number }
      > = {};

      for (const r of rateRes.data ?? []) {
        rateByStaff[(r as any).staff_id] = {
          weekday_rate: Number((r as any).weekday_rate ?? 0),
          saturday_rate: Number((r as any).saturday_rate ?? 0),
          sunday_rate: Number((r as any).sunday_rate ?? 0),
        };
      }

      const updates: { id: number; hourly_rate: number }[] = [];

      for (const s of sourceShifts as any[]) {
        const rateRow = rateByStaff[s.staff_id];
        if (!rateRow) continue;

        const day = new Date(s.shift_start).getDay();

        let nextRate = rateRow.weekday_rate;
        if (day === 6) nextRate = rateRow.saturday_rate;
        if (day === 0) nextRate = rateRow.sunday_rate;

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
  }, []);

  useEffect(() => {
    loadShiftCosts();
    loadOneOffUnavailability();
    loadRecurringRules();
    loadRecurringOverrides();
    loadPublishedStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

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

  const allUnavail = useMemo(() => {
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

  const unavGrid = useMemo(() => {
    const g: Record<string, UnavailOccurrence[][]> = {};
    staffIds.forEach((sid) => (g[sid] = Array.from({ length: 7 }, () => [])));

    allUnavail.forEach((u) => {
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
  }, [allUnavail, staffIds, range.start]);

  const storeTotalHours = rows.reduce((sum, r) => sum + r.hours_worked, 0);
  const storeTotalWage = rows.reduce((sum, r) => sum + (r.estimated_wage ?? 0), 0);

  const dailyTotals = useMemo(() => {
    const totals = Array.from({ length: 7 }, () => ({ hours: 0, wage: 0 }));
    for (const r of rows) {
      const idx = dayIndexFromISO(r.shift_start);
      totals[idx].hours += r.hours_worked;
      totals[idx].wage += r.estimated_wage ?? 0;
    }
    return totals;
  }, [rows]);

  const todayISO = toISODate(new Date());

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

  const drawerDayDate = useMemo(() => dayDates[drawerDayIdx], [dayDates, drawerDayIdx]);

  const drawerDayUnav = useMemo(() => {
    if (!drawerStaffId) return [];
    return (unavGrid[drawerStaffId]?.[drawerDayIdx] ?? []) as UnavailOccurrence[];
  }, [unavGrid, drawerStaffId, drawerDayIdx]);

  const drawerRecRulesInCell = useMemo(() => drawerDayUnav.filter((x) => x.kind === "recurring"), [drawerDayUnav]);
  const drawerOneOffInCell = useMemo(() => drawerDayUnav.filter((x) => x.kind === "oneoff"), [drawerDayUnav]);

  function warnIfUnavailable(staffId: string, startISO: string, endISO: string) {
    const list = allUnavail.filter((u) => u.staff_id === staffId && u.store_id === storeId);

    const hit = list.find((u) => {
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

    setMsg((prev) => (prev.startsWith("⚠️") ? prev + " ✅ Updated." : "✅ Updated!"));
    closeDrawer();
    await loadShiftCosts();
  }

  async function deleteShiftFromDrawer() {
    if (!drawerShiftId) return;
    if (!confirm("Delete this shift?")) return;

    const d = await supabase.from("shifts").delete().eq("id", drawerShiftId);
    if (d.error) {
      setMsg("❌ Delete failed: " + d.error.message);
      return;
    }

    setMsg("✅ Deleted!");
    closeDrawer();
    await loadShiftCosts();
  }

  async function saveAddUnavailRecurringFromDrawer() {
    setMsg("");

    if (!drawerStaffId) {
      setMsg("❌ Missing staff.");
      return;
    }
    if (!unStartTime || !unEndTime) {
      setMsg("❌ Please fill start/end time.");
      return;
    }

    const jsDow = cellDayIdxToJsDow(drawerDayIdx);

    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;

    const ins = await supabase.from("staff_unavailability_recurring").insert(
      [
        {
          staff_id: drawerStaffId,
          store_id: storeId,
          day_of_week: jsDow,
          start_time: hhmm_to_hhmmss(unStartTime),
          end_time: hhmm_to_hhmmss(unEndTime),
          reason: unReason.trim() === "" ? null : unReason.trim(),
          created_by: uid,
        },
      ],
      { returning: "minimal" } as any
    );

    if (ins.error) {
      setMsg("❌ Add unavailable failed: " + ins.error.message);
      return;
    }

    setMsg("✅ Weekly unavailable rule added (repeats every week).");
    setUnReason("");
    await loadRecurringRules();
    await loadRecurringOverrides();
  }

  async function deleteRecurringRule(ruleId: number) {
    if (!confirm("Delete this weekly unavailable rule?")) return;
    const d = await supabase.from("staff_unavailability_recurring").delete().eq("id", ruleId);
    if (d.error) {
      setMsg("❌ Delete failed: " + d.error.message);
      return;
    }
    setMsg("✅ Deleted weekly rule.");
    await loadRecurringRules();
    await loadRecurringOverrides();
  }

  async function skipRuleThisWeek(ruleId: number) {
    setMsg("");
    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;

    const ins = await supabase.from("staff_unavailability_recurring_overrides").insert(
      [
        {
          rule_id: ruleId,
          week_start: weekStart,
          store_id: storeId,
          created_by: uid,
        },
      ],
      { returning: "minimal" } as any
    );

    if (ins.error) {
      if (ins.error.message.toLowerCase().includes("duplicate") || ins.error.message.toLowerCase().includes("unique")) {
        setMsg("ℹ️ This rule is already skipped for this week.");
        return;
      }
      setMsg("❌ Skip failed: " + ins.error.message);
      return;
    }

    setMsg("✅ Skipped this weekly unavailable rule for this week only.");
    await loadRecurringOverrides();
  }

  async function undoSkipRuleThisWeek(ruleId: number) {
    setMsg("");
    const del = await supabase
      .from("staff_unavailability_recurring_overrides")
      .delete()
      .eq("store_id", storeId)
      .eq("week_start", weekStart)
      .eq("rule_id", ruleId);

    if (del.error) {
      setMsg("❌ Undo skip failed: " + del.error.message);
      return;
    }

    setMsg("✅ Undo skip: weekly rule applies again for this week.");
    await loadRecurringOverrides();
  }

  function downloadCSV(filename: string, csvText: string) {
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportPayrollSummary() {
    const map = new Map<string, { name: string; hours: number; wage: number }>();
    staffIds.forEach((sid) => map.set(sid, { name: staffName(sid), hours: 0, wage: 0 }));

    rows.forEach((r) => {
      const cur = map.get(r.staff_id) ?? { name: staffName(r.staff_id), hours: 0, wage: 0 };
      cur.hours += r.hours_worked;
      cur.wage += r.estimated_wage ?? 0;
      map.set(r.staff_id, cur);
    });

    const lines = [
      ["WeekStart(THU)", weekStart].join(","),
      "",
      "Staff Name,Staff ID,Total Hours,Total Wage",
      ...Array.from(map.entries()).map(([sid, v]) =>
        [`"${v.name.replaceAll('"', '""')}"`, sid, v.hours.toFixed(2), v.wage.toFixed(2)].join(",")
      ),
      "",
      `Store Total Hours,${storeTotalHours.toFixed(2)}`,
      `Store Total Wage,${storeTotalWage.toFixed(2)}`,
    ];

    downloadCSV(`payroll_summary_${storeId}_${weekStart}.csv`, lines.join("\n"));
  }

  function exportPayrollDetail() {
    const header = "Staff Name,Staff ID,Shift Date,Start,End,Hours,Rate,Wage";
    const lines = rows.map((r) => {
      const d = new Date(r.shift_start);
      const shiftDate = d.toLocaleDateString();
      return [
        `"${staffName(r.staff_id).replaceAll('"', '""')}"`,
        r.staff_id,
        `"${shiftDate}"`,
        `"${fmtTime(r.shift_start)}"`,
        `"${fmtTime(r.shift_end)}"`,
        r.hours_worked.toFixed(2),
        (r.applied_rate ?? 0).toFixed(2),
        (r.estimated_wage ?? 0).toFixed(2),
      ].join(",");
    });

    downloadCSV(`payroll_detail_${storeId}_${weekStart}.csv`, [header, ...lines].join("\n"));
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
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
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
        </div>

        {drawerTab === "shift" ? (
          <div>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 8 }}>
              Mode: <b>{drawerMode === "add" ? "ADD" : "EDIT"}</b>
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>Start (24h)</div>
              <input type="time" value={drawerStartTime} onChange={(e) => setDrawerStartTime(e.target.value)} style={inputStyle("100%")} />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>End (24h)</div>
              <input type="time" value={drawerEndTime} onChange={(e) => setDrawerEndTime(e.target.value)} style={inputStyle("100%")} />
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
              <div style={{ fontWeight: 900, marginBottom: 6, color: TEXT }}>This day — Unavailability</div>

              {drawerOneOffInCell.length > 0 ? (
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 10 }}>
                  <b>One-off</b>
                  {drawerOneOffInCell.slice(0, 4).map((u) => (
                    <div key={`oneoff-${u.id}`} style={{ marginTop: 4 }}>
                      {fmtTime(u.start_at)}–{fmtTime(u.end_at)}
                      {u.reason ? ` | ${u.reason}` : ""} (one-off)
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#999", marginBottom: 10 }}>No one-off unavailability shown here.</div>
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
                          border: "1px solid #e6e6e6",
                          borderRadius: 10,
                          background: "#fff",
                        }}
                      >
                        <div style={{ fontWeight: 900, color: skipped ? "#999" : TEXT }}>
                          {fmtTime(u.start_at)}–{fmtTime(u.end_at)}{" "}
                          <span style={{ fontWeight: 700, fontSize: 12 }}>{skipped ? "(skipped this week)" : "(weekly)"}</span>
                        </div>
                        {u.reason ? <div style={{ marginTop: 2, color: MUTED }}>Reason: {u.reason}</div> : null}

                        <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {!skipped
                            ? actionButton("Skip this week", () => skipRuleThisWeek(u.id))
                            : actionButton("Undo skip", () => undoSkipRuleThisWeek(u.id))}
                          {actionButton("Delete rule", () => deleteRecurringRule(u.id), { danger: true })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#999" }}>No weekly rule on this day yet.</div>
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
              <div style={{ fontWeight: 900, marginBottom: 8, color: TEXT }}>Add Unavailable (Weekly repeating)</div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>Start (24h)</div>
                <input type="time" value={unStartTime} onChange={(e) => setUnStartTime(e.target.value)} style={inputStyle("100%")} />
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>End (24h)</div>
                <input type="time" value={unEndTime} onChange={(e) => setUnEndTime(e.target.value)} style={inputStyle("100%")} />
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 4, color: MUTED }}>Reason (optional)</div>
                <input value={unReason} onChange={(e) => setUnReason(e.target.value)} style={inputStyle("100%")} />
              </div>

              {actionButton("Save weekly unavailable", saveAddUnavailRecurringFromDrawer, { primary: true })}
            </div>
          </div>
        ) : null}
      </div>

      <div style={{ maxWidth: 1360, margin: "0 auto" }}>
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
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {actionButton("← Prev Week", () => setWeekStart((w) => addDaysISO(w, -7)), {
                  disabled: copyLoading || ratesLoading,
                })}
                {actionButton("This Week", () => setWeekStart(getThisWeekThuISO()), {
                  primary: true,
                  disabled: copyLoading || ratesLoading,
                })}
                {actionButton("Next Week →", handleNextWeek, {
                  disabled: copyLoading || ratesLoading,
                })}
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {actionButton("Copy from previous week", handleCopyFromPreviousWeek, {
                  disabled: copyLoading || ratesLoading || pubLoading,
                })}
                {actionButton(
                  "Apply Latest Rates",
                  async () => {
                    if (!confirm("Apply the latest pay rates to all shifts in this week?")) return;
                    await applyLatestRatesForWeek();
                  },
                  {
                    disabled: copyLoading || ratesLoading || pubLoading,
                  }
                )}
                {actionButton("Refresh", loadAll, {
                  disabled: copyLoading || ratesLoading || pubLoading,
                })}
                {!isPublished
                  ? actionButton("Publish this week", publishWeek, {
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
            {statCard("Roster status", "", undefined, isPublished ? badge("PUBLISHED", "green") : badge("DRAFT", "yellow"))}
            {statCard("Store total hours", `${storeTotalHours.toFixed(2)}h`, WAK_BLUE)}
            {statCard("Store total wage", `$${storeTotalWage.toFixed(2)}`, WAK_RED)}
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
              Click empty space to add shift, click a shift card to edit, click unavailable block to manage rules.
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
                minWidth: 1000,
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
                      minWidth: 130,
                      width: 130,
                      maxWidth: 130,
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

                    return (
                      <th
                        key={d}
                        style={{
                          borderBottom: `1px solid ${BORDER}`,
                          borderRight: `1px solid ${BORDER}`,
                          position: "sticky",
                          top: 0,
                          zIndex: 3,
                          background: isToday ? "#F7FBFF" : "#FAFAFA",
                          minWidth: 130,
                          padding: "12px 10px",
                          textAlign: "left",
                        }}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <div style={{ fontWeight: 800, color: TEXT }}>{d}</div>
                          {isToday ? badge("TODAY", "blue") : null}
                        </div>
                        <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{fmtHeaderDate(dayDates[i])}</div>
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
                      borderRight: `1px solid ${BORDER}`,
                      position: "sticky",
                      top: 0,
                      zIndex: 3,
                      background: "#FAFAFA",
                      minWidth: 100,
                      padding: "12px 10px",
                      textAlign: "left",
                      color: TEXT,
                    }}
                  >
                    WEEK HOURS
                  </th>

                  <th
                    style={{
                      borderBottom: `1px solid ${BORDER}`,
                      position: "sticky",
                      top: 0,
                      zIndex: 3,
                      background: "#FAFAFA",
                      minWidth: 100,
                      padding: "12px 10px",
                      textAlign: "left",
                      color: TEXT,
                    }}
                  >
                    WEEK WAGE
                  </th>
                </tr>
              </thead>

              <tbody>
                {staffIds.map((sid) => {
                  const cells = grid[sid] ?? Array.from({ length: 7 }, () => []);
                  const uCells = unavGrid[sid] ?? Array.from({ length: 7 }, () => []);

                  const staffHours = cells.flat().reduce((sum, r) => sum + r.hours_worked, 0);
                  const staffWage = cells.flat().reduce((sum, r) => sum + (r.estimated_wage ?? 0), 0);

                  return (
                    <tr key={sid}>
                      <td
                        style={{
                          borderRight: `1px solid ${BORDER}`,
                          borderBottom: `1px solid ${BORDER}`,
                          position: "sticky",
                          left: 0,
                          zIndex: 2,
                          background: "#fff",
                          fontWeight: 800,
                          whiteSpace: "nowrap",
                          minWidth: 50,
                          padding: "14px 12px",
                          color: TEXT,
                          verticalAlign: "top",
                        }}
                      >
                        {staffName(sid)}
                      </td>

                      {cells.map((cell, dayIdx) => {
                        const dayUnav = uCells[dayIdx] ?? [];

                        const hasActiveUnav =
                          dayUnav.some((u) => u.kind === "oneoff") ||
                          dayUnav.some((u) => u.kind === "recurring" && !u.isSkippedThisWeek);

                        const recInCell = dayUnav.filter((x) => x.kind === "recurring");

                        return (
                          <td
                            key={dayIdx}
                            onClick={() => openDrawerFromCell(sid, dayIdx)}
                            style={{
                              borderRight: `1px solid ${BORDER}`,
                              borderBottom: `1px solid ${BORDER}`,
                              verticalAlign: "top",
                              minWidth: 165,
                              background: hasActiveUnav ? "#FFF1F1" : "#fff",
                              cursor: "pointer",
                              padding: 10,
                            }}
                            title="Click to add shift / manage unavailable"
                          >
                            {dayUnav.length > 0 && (
                              <div
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openDrawerForUnavailable(sid, dayIdx);
                                }}
                                style={{
                                  fontSize: 12,
                                  marginBottom: 8,
                                  padding: "8px 10px",
                                  border: "1px solid #F3D3D3",
                                  borderRadius: 10,
                                  background: "#fff",
                                  cursor: "pointer",
                                }}
                                title="Click to manage unavailable"
                              >
                                <div style={{ fontWeight: 800, color: "#991B1B", marginBottom: 4 }}>Unavailable</div>
                                {dayUnav.slice(0, 2).map((u) => (
                                  <div
                                    key={`${u.kind}-${u.id}`}
                                    style={{ color: u.kind === "recurring" && u.isSkippedThisWeek ? "#999" : MUTED }}
                                  >
                                    {fmtTime(u.start_at)}–{fmtTime(u.end_at)}
                                    {u.reason ? ` | ${u.reason}` : ""}
                                    {u.kind === "recurring"
                                      ? u.isSkippedThisWeek
                                        ? " (weekly, skipped)"
                                        : " (weekly)"
                                      : " (one-off)"}
                                  </div>
                                ))}
                                {dayUnav.length > 2 && <div style={{ color: MUTED }}>+{dayUnav.length - 2} more…</div>}
                                {recInCell.length > 0 ? (
                                  <div style={{ color: MUTED, marginTop: 4 }}>Click to Skip/Undo/Delete</div>
                                ) : null}
                              </div>
                            )}

                            {cell.length === 0 ? <div style={{ color: "#999", fontSize: 13 }}>—</div> : null}

                            {cell.map((r) => (
                              <div
                                key={r.shift_id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openDrawerForEditShift(r);
                                }}
                                style={{
                                  cursor: "pointer",
                                  marginBottom: 8,
                                  padding: "10px 12px",
                                  border: "1px solid #E6E6E6",
                                  borderRadius: 12,
                                  background: "#FAFAFA",
                                }}
                                title="Click to edit shift"
                              >
                                <div style={{ fontWeight: 900, color: TEXT }}>
                                  {fmtTime(r.shift_start)}–{fmtTime(r.shift_end)}
                                </div>
                                <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{r.hours_worked.toFixed(2)}h</div>
                                <div style={{ fontSize: 12, color: MUTED }}>
                                  Rate ${(r.applied_rate ?? 0).toFixed(2)} | Wage ${(r.estimated_wage ?? 0).toFixed(2)}
                                </div>
                              </div>
                            ))}
                          </td>
                        );
                      })}

                      <td
                        style={{
                          borderRight: `1px solid ${BORDER}`,
                          borderBottom: `1px solid ${BORDER}`,
                          fontWeight: 800,
                          color: TEXT,
                          padding: "14px 12px",
                          verticalAlign: "top",
                          background: "#fff",
                        }}
                      >
                        {staffHours.toFixed(2)}
                      </td>

                      <td
                        style={{
                          borderBottom: `1px solid ${BORDER}`,
                          fontWeight: 800,
                          color: TEXT,
                          padding: "14px 12px",
                          verticalAlign: "top",
                          background: "#fff",
                        }}
                      >
                        ${staffWage.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
          <h3 style={{ marginTop: 0, color: TEXT }}>Store Summary (Week)</h3>
          <div style={{ color: TEXT, marginBottom: 6 }}>
            Total Hours: <b>{storeTotalHours.toFixed(2)}</b>
          </div>
          <div style={{ color: TEXT }}>
            Total Wage: <b>${storeTotalWage.toFixed(2)}</b>
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
          <h3 style={{ marginTop: 0, color: TEXT }}>Payroll Export</h3>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {actionButton("Export Payroll (Summary CSV)", exportPayrollSummary)}
            {actionButton("Export Payroll (Detail CSV)", exportPayrollDetail)}
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
          <h3 style={{ marginTop: 0, color: TEXT }}>Notes</h3>
          <ul style={{ color: MUTED, margin: 0, paddingLeft: 20, lineHeight: 1.7 }}>
            <li>Click empty cell space to add a shift.</li>
            <li>Click a shift card to edit that shift.</li>
            <li>Click the unavailable block to manage weekly rules and skips.</li>
            <li>Next Week will auto-copy this week only when next week is empty.</li>
            <li>Copy from previous week will only work when this week is empty.</li>
            <li>Apply Latest Rates updates this week’s existing shifts to the latest current pay rates.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}