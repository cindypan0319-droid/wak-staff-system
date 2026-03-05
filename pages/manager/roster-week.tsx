import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Profile = { id: string; full_name: string | null };

type ShiftCostRow = {
  shift_id: number;
  store_id: string;
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes: number; // keep (DB has it), but we do not show/use it
  hours_worked: number;
  applied_rate: number | null;
  estimated_wage: number | null;
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
  day_of_week: number; // 0..6 (Sun..Sat)
  start_time: string; // "HH:MM:SS"
  end_time: string; // "HH:MM:SS"
  reason: string | null;
};

type RecurringOverride = {
  id: number;
  rule_id: number;
  week_start: string; // date
  store_id: string;
};

type UnavailOccurrence = {
  kind: "oneoff" | "recurring";
  id: number; // rule id for recurring; row id for oneoff
  staff_id: string;
  store_id: string;
  start_at: string;
  end_at: string;
  reason: string | null;
  rule?: UnavailRecurringRule;
  isSkippedThisWeek?: boolean;
};

const dayLabels = ["THU", "FRI", "SAT", "SUN", "MON", "TUE", "WED"] as const;

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

function weekRangeText(weekStartISO: string) {
  const start = new Date(weekStartISO + "T00:00:00");
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) =>
    d.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  return `${fmt(start)} → ${fmt(end)}`;
}

function fmtTime(iso: string) {
  // ✅ 24-hour display
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function dayIndexFromISO(iso: string) {
  const d = new Date(iso);
  const dow = d.getDay(); // 0 Sun ... 4 Thu
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

export default function RosterWeek() {
  const [storeId] = useState("MOOROOLBARK");

  const [weekStart, setWeekStart] = useState(() => {
    const now = new Date();
    const dow = now.getDay();
    const diffToThu = (dow - 4 + 7) % 7;
    const thu = new Date(now);
    thu.setDate(now.getDate() - diffToThu);
    return toISODate(thu);
  });

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

  // ===== Drawer (Deputy style) =====
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"shift" | "unavail">("shift"); // ✅ Shift / Unavailable
  const [drawerMode, setDrawerMode] = useState<"add" | "edit">("add");
  const [drawerStaffId, setDrawerStaffId] = useState<string>("");
  const [drawerDayIdx, setDrawerDayIdx] = useState<number>(0); // 0..6 Thu..Wed
  const [drawerShiftId, setDrawerShiftId] = useState<number | null>(null);

  // Shift inputs (24h)
  const [drawerStartTime, setDrawerStartTime] = useState<string>("17:00");
  const [drawerEndTime, setDrawerEndTime] = useState<string>("21:00");

  // Unavailable inputs (weekly rule)
  const [unStartTime, setUnStartTime] = useState("17:00");
  const [unEndTime, setUnEndTime] = useState("21:00");
  const [unReason, setUnReason] = useState("");

  function staffName(id: string) {
    const p = profiles.find((x) => x.id === id);
    return p?.full_name?.trim() ? p.full_name : id.slice(0, 8);
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

  async function loadAll() {
    await loadProfiles();
    await loadShiftCosts();
    await loadOneOffUnavailability();
    await loadRecurringRules();
    await loadRecurringOverrides();
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

  // shifts grid
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

  // overrides set for fast lookup
  const skippedRuleIds = useMemo(() => new Set<number>(recOverrides.map((x) => x.rule_id)), [recOverrides]);

  function cellDayIdxToJsDow(dayIdx: number) {
    return [4, 5, 6, 0, 1, 2, 3][dayIdx];
  }

  // recurring occurrences for THIS week (auto repeat) with SKIP support
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

  // unavailability grid for display
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

  // ===== Drawer open/close =====
  function closeDrawer() {
    setDrawerOpen(false);
  }

  // ✅ click empty cell => open drawer default add shift
  function openDrawerFromCell(staffId: string, dayIdx: number) {
    setDrawerStaffId(staffId);
    setDrawerDayIdx(dayIdx);

    setDrawerTab("shift");
    setDrawerMode("add");
    setDrawerShiftId(null);
    setDrawerStartTime("17:00");
    setDrawerEndTime("21:00");

    // default unavailable form values
    setUnStartTime("17:00");
    setUnEndTime("21:00");
    setUnReason("");

    setDrawerOpen(true);
    setMsg("");
  }

  // click shift card => edit shift
  function openDrawerForEditShift(r: ShiftCostRow) {
    const dayIdx = dayIndexFromISO(r.shift_start);

    setDrawerStaffId(r.staff_id);
    setDrawerDayIdx(dayIdx);

    setDrawerTab("shift");
    setDrawerMode("edit");
    setDrawerShiftId(r.shift_id);
    setDrawerStartTime(toTimeInputHHMM(r.shift_start));
    setDrawerEndTime(toTimeInputHHMM(r.shift_end));

    // keep unavailable form values
    setUnStartTime("17:00");
    setUnEndTime("21:00");
    setUnReason("");

    setDrawerOpen(true);
    setMsg("");
  }

  // click unavailable summary => open drawer on unavailable tab
  function openDrawerForUnavailable(staffId: string, dayIdx: number) {
    setDrawerStaffId(staffId);
    setDrawerDayIdx(dayIdx);

    setDrawerTab("unavail");
    setDrawerMode("add"); // irrelevant in unavail tab
    setDrawerShiftId(null);

    setUnStartTime("17:00");
    setUnEndTime("21:00");
    setUnReason("");

    setDrawerOpen(true);
    setMsg("");
  }

  // ===== Drawer data for selected staff/day =====
  const drawerDayDate = useMemo(() => dayDates[drawerDayIdx], [dayDates, drawerDayIdx]);

  const drawerDayUnav = useMemo(() => {
    if (!drawerStaffId) return [];
    return (unavGrid[drawerStaffId]?.[drawerDayIdx] ?? []) as UnavailOccurrence[];
  }, [unavGrid, drawerStaffId, drawerDayIdx]);

  const drawerRecRulesInCell = useMemo(() => drawerDayUnav.filter((x) => x.kind === "recurring"), [drawerDayUnav]);
  const drawerOneOffInCell = useMemo(() => drawerDayUnav.filter((x) => x.kind === "oneoff"), [drawerDayUnav]);

  // ===== shift save/delete =====
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

    if (drawerMode === "add") {
      const ins = await supabase.from("shifts").insert(
        [
          {
            store_id: storeId,
            staff_id: drawerStaffId,
            shift_start: startISO,
            shift_end: endISO,
            break_minutes: 0, // ✅ paid break
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
        break_minutes: 0, // ✅ paid break
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

  // ===== unavailable: add weekly rule + manage skip/delete =====
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

  // ===== payroll export (buttons moved to bottom) =====
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
    <div style={{ padding: 20, position: "relative" }}>
      {/* Drawer overlay */}
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

      {/* Drawer */}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          height: "100vh",
          width: 380,
          background: "#fff",
          borderLeft: "1px solid #ddd",
          boxShadow: "-8px 0 20px rgba(0,0,0,0.08)",
          transform: drawerOpen ? "translateX(0)" : "translateX(105%)",
          transition: "transform 160ms ease",
          zIndex: 1000,
          padding: 16,
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 900 }}>Edit — {dayLabels[drawerDayIdx]}</div>
          <button onClick={closeDrawer}>✕</button>
        </div>

        <div style={{ fontSize: 13, color: "#666", marginBottom: 10 }}>
          <div>
            <b>Staff:</b> {drawerStaffId ? staffName(drawerStaffId) : "—"}
          </div>
          <div>
            <b>Date:</b> {drawerDayDate ? fmtHeaderDate(drawerDayDate) : "—"}
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => setDrawerTab("shift")}
            style={{
              fontWeight: 800,
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: drawerTab === "shift" ? "#f2f2f2" : "#fff",
            }}
          >
            Shift
          </button>
          <button
            onClick={() => setDrawerTab("unavail")}
            style={{
              fontWeight: 800,
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid #ddd",
              background: drawerTab === "unavail" ? "#f2f2f2" : "#fff",
            }}
          >
            Unavailable
          </button>
        </div>

        {/* SHIFT TAB */}
        {drawerTab === "shift" ? (
          <div>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
              Mode: <b>{drawerMode === "add" ? "ADD" : "EDIT"}</b>
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>Start (24h)</div>
              <input
                type="time"
                value={drawerStartTime}
                onChange={(e) => setDrawerStartTime(e.target.value)}
                style={{ width: "100%" }}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, marginBottom: 4 }}>End (24h)</div>
              <input
                type="time"
                value={drawerEndTime}
                onChange={(e) => setDrawerEndTime(e.target.value)}
                style={{ width: "100%" }}
              />
              <div style={{ fontSize: 12, color: "#777", marginTop: 6 }}>
                Tip: If end time is earlier than start, it will be treated as overnight (next day).
              </div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={saveShiftFromDrawer} style={{ flex: 1, fontWeight: 800 }}>
                Save
              </button>

              {drawerMode === "edit" ? (
                <button onClick={deleteShiftFromDrawer} style={{ fontWeight: 800 }}>
                  Delete
                </button>
              ) : null}
            </div>

            
          </div>
        ) : null}

        {/* UNAVAILABLE TAB */}
        {drawerTab === "unavail" ? (
          <div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>This day — Unavailability</div>

              {drawerOneOffInCell.length > 0 ? (
                <div style={{ fontSize: 12, color: "#666", marginBottom: 10 }}>
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
                <div style={{ fontSize: 12, color: "#666" }}>
                  <b>Weekly rules</b>
                  {drawerRecRulesInCell.map((u) => {
                    const skipped = !!u.isSkippedThisWeek;
                    return (
                      <div
                        key={`rule-${u.id}`}
                        style={{
                          marginTop: 8,
                          padding: 8,
                          border: "1px solid #e6e6e6",
                          borderRadius: 10,
                          background: "#fafafa",
                        }}
                      >
                        <div style={{ fontWeight: 900, color: skipped ? "#999" : "#333" }}>
                          {fmtTime(u.start_at)}–{fmtTime(u.end_at)}{" "}
                          <span style={{ fontWeight: 700, fontSize: 12 }}>{skipped ? "(skipped this week)" : "(weekly)"}</span>
                        </div>
                        {u.reason ? <div style={{ marginTop: 2, color: "#666" }}>Reason: {u.reason}</div> : null}

                        <div style={{ marginTop: 8 }}>
                          {!skipped ? (
                            <button onClick={() => skipRuleThisWeek(u.id)} style={{ marginRight: 8 }}>
                              Skip this week
                            </button>
                          ) : (
                            <button onClick={() => undoSkipRuleThisWeek(u.id)} style={{ marginRight: 8 }}>
                              Undo skip
                            </button>
                          )}
                          <button onClick={() => deleteRecurringRule(u.id)}>Delete rule</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#999" }}>No weekly rule on this day yet.</div>
              )}
            </div>

            <hr />

            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>Add Unavailable (Weekly repeating)</div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>Start (24h)</div>
                <input type="time" value={unStartTime} onChange={(e) => setUnStartTime(e.target.value)} style={{ width: "100%" }} />
              </div>

              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>End (24h)</div>
                <input type="time" value={unEndTime} onChange={(e) => setUnEndTime(e.target.value)} style={{ width: "100%" }} />
              </div>

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, marginBottom: 4 }}>Reason (optional)</div>
                <input value={unReason} onChange={(e) => setUnReason(e.target.value)} style={{ width: "100%" }} />
              </div>

              <button onClick={saveAddUnavailRecurringFromDrawer} style={{ fontWeight: 800 }}>
                Save weekly unavailable
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Page header */}
      <div style={{ marginBottom: 12 }}>
        <button onClick={() => (window.location.href = "/staff/home")}>← Back to Home</button>
      </div>
      <h1>Roster — Weekly (Thu → Wed)</h1>

      <div style={{ marginBottom: 10 }}>
        Week (Thu→Wed):{" "}
        <button onClick={() => setWeekStart((w) => addDaysISO(w, -7))}>← Prev Week</button>
        <button onClick={() => setWeekStart(getThisWeekThuISO())} style={{ marginLeft: 8 }}>
          This Week
        </button>
        <button onClick={() => setWeekStart((w) => addDaysISO(w, 7))} style={{ marginLeft: 8 }}>
          Next Week →
        </button>

        <input type="date" value={weekStart} readOnly style={{ marginLeft: 8 }} />

        <span style={{ marginLeft: 12, color: "#666", fontWeight: 700 }}>{weekRangeText(weekStart)}</span>

        <button onClick={loadAll} style={{ marginLeft: 8 }}>
          Refresh
        </button>

        <span style={{ marginLeft: 12, fontWeight: 800 }}>Status: {isPublished ? "PUBLISHED" : "DRAFT"}</span>

        {!isPublished ? (
          <button onClick={publishWeek} style={{ marginLeft: 8 }} disabled={pubLoading}>
            Publish this week
          </button>
        ) : (
          <button onClick={unpublishWeek} style={{ marginLeft: 8 }} disabled={pubLoading}>
            Unpublish
          </button>
        )}
      </div>

      {msg && <div style={{ marginBottom: 10 }}>{msg}</div>}

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ border: "1px solid #ccc", position: "sticky", left: 0, background: "#fff" }}>NAME</th>
              {dayLabels.map((d, i) => (
                <th key={d} style={{ border: "1px solid #ccc" }}>
                  <div style={{ fontWeight: 800 }}>{d}</div>
                  <div style={{ fontSize: 12, color: "#444", marginTop: 2 }}>{fmtHeaderDate(dayDates[i])}</div>
                  <div style={{ fontSize: 12, color: "#666" }}>
                    Day total: {dailyTotals[i].hours.toFixed(2)}h | ${dailyTotals[i].wage.toFixed(2)}
                  </div>
                </th>
              ))}
              <th style={{ border: "1px solid #ccc" }}>WEEK HOURS</th>
              <th style={{ border: "1px solid #ccc" }}>WEEK WAGE</th>
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
                      border: "1px solid #ccc",
                      position: "sticky",
                      left: 0,
                      background: "#fff",
                      fontWeight: 800,
                      whiteSpace: "nowrap",
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
                        onClick={() => openDrawerFromCell(sid, dayIdx)} // ✅ click empty space opens drawer (default Add Shift)
                        style={{
                          border: "1px solid #ccc",
                          verticalAlign: "top",
                          minWidth: 170, // narrower columns
                          background: hasActiveUnav ? "#ffeaea" : "#fff",
                          cursor: "pointer",
                        }}
                        title="Click to add shift / manage unavailable"
                      >
                        {/* Unavailable info (click => open drawer on unavailable tab) */}
                        {dayUnav.length > 0 && (
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              openDrawerForUnavailable(sid, dayIdx);
                            }}
                            style={{
                              fontSize: 12,
                              marginBottom: 6,
                              padding: "6px 8px",
                              border: "1px solid #eee",
                              borderRadius: 10,
                              background: "#fff",
                              cursor: "pointer",
                            }}
                            title="Click to manage unavailable"
                          >
                            <b>Unavailable</b>
                            {dayUnav.slice(0, 2).map((u) => (
                              <div
                                key={`${u.kind}-${u.id}`}
                                style={{ color: u.kind === "recurring" && u.isSkippedThisWeek ? "#999" : "#666" }}
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
                            {dayUnav.length > 2 && <div style={{ color: "#777" }}>+{dayUnav.length - 2} more…</div>}
                            {recInCell.length > 0 ? <div style={{ color: "#777", marginTop: 4 }}>Click to Skip/Undo/Delete</div> : null}
                          </div>
                        )}

                        {/* Shifts (Card style) */}
                        {cell.length === 0 ? <div style={{ color: "#999" }}>—</div> : null}

                        {cell.map((r) => (
                          <div
                            key={r.shift_id}
                            onClick={(e) => {
                              e.stopPropagation(); // ✅ prevent cell click (add) from firing
                              openDrawerForEditShift(r);
                            }}
                            style={{
                              cursor: "pointer",
                              marginBottom: 8,
                              padding: "8px 10px",
                              border: "1px solid #e6e6e6",
                              borderRadius: 10,
                              background: "#fafafa",
                            }}
                            title="Click to edit shift"
                          >
                            <div style={{ fontWeight: 900 }}>
                              {fmtTime(r.shift_start)}–{fmtTime(r.shift_end)}
                            </div>
                            <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{r.hours_worked.toFixed(2)}h</div>
                            <div style={{ fontSize: 12, color: "#666" }}>
                              Rate ${(r.applied_rate ?? 0).toFixed(2)} | Wage ${(r.estimated_wage ?? 0).toFixed(2)}
                            </div>
                          </div>
                        ))}
                      </td>
                    );
                  })}

                  <td style={{ border: "1px solid #ccc", fontWeight: 800 }}>{staffHours.toFixed(2)}</td>
                  <td style={{ border: "1px solid #ccc", fontWeight: 800 }}>${staffWage.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <hr style={{ marginTop: 20 }} />
      <h3>Store Summary (Week)</h3>
      <div>Total Hours: {storeTotalHours.toFixed(2)}</div>
      <div>Total Wage: ${storeTotalWage.toFixed(2)}</div>

      {/* Export buttons at bottom */}
      <div style={{ marginTop: 14 }}>
        <b>Payroll Export</b>
        <div style={{ marginTop: 8 }}>
          <button onClick={exportPayrollSummary} style={{ marginRight: 8 }}>
            Export Payroll (Summary CSV)
          </button>
          <button onClick={exportPayrollDetail}>Export Payroll (Detail CSV)</button>
        </div>
      </div>

      <div style={{ marginTop: 12, color: "#666" }}>
        Notes:
        <ul>
          <li>Click empty cell space → opens Drawer (default Add Shift).</li>
          <li>Click a shift card → opens Drawer to edit that shift.</li>
          <li>Click the Unavailable box → opens Drawer (Unavailable tab) to add/skip/undo/delete weekly rules.</li>
          <li>Break is paid → not used (always 0).</li>
        </ul>
      </div>
    </div>
  );
}