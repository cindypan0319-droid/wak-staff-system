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

function isoToLocalInput(iso: string) {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function localInputToISO(localVal: string) {
  return new Date(localVal).toISOString();
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
  return (t || "").slice(0, 5); // "17:00:00" -> "17:00"
}
function hhmm_to_hhmmss(t: string) {
  if (!t) return "00:00:00";
  return t.length === 5 ? `${t}:00` : t;
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

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [rows, setRows] = useState<ShiftCostRow[]>([]);
  const [oneOff, setOneOff] = useState<UnavailOneOffRow[]>([]);
  const [recRules, setRecRules] = useState<UnavailRecurringRule[]>([]);
  const [recOverrides, setRecOverrides] = useState<RecurringOverride[]>([]);
  const [msg, setMsg] = useState("");

  // edit shift
  const [editingShiftId, setEditingShiftId] = useState<number | null>(null);
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editBreak, setEditBreak] = useState("0");

  // add shift
  const [addingKey, setAddingKey] = useState<string | null>(null);
  const [addStart, setAddStart] = useState("");
  const [addEnd, setAddEnd] = useState("");
  const [addBreak, setAddBreak] = useState("0");

  // add weekly unavailable rule
  const [addingUnKey, setAddingUnKey] = useState<string | null>(null);
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

  useEffect(() => {
    loadProfiles();
  }, []);

  useEffect(() => {
    loadShiftCosts();
    loadOneOffUnavailability();
    loadRecurringRules();
    loadRecurringOverrides();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart]);

  const staffIds = useMemo(() => {
    const set = new Set<string>();
    profiles.forEach((p) => set.add(p.id));
    rows.forEach((r) => set.add(r.staff_id));
    oneOff.forEach((u) => set.add(u.staff_id));
    recRules.forEach((u) => set.add(u.staff_id));
    return Array.from(set);
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
  const skippedRuleIds = useMemo(() => {
    return new Set<number>(recOverrides.map((x) => x.rule_id));
  }, [recOverrides]);

  // convert our cell dayIdx(Thu..Wed) -> JS getDay(Thu=4..)
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
          id: rule.id, // rule id
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

  // unavailability grid for display (we still show skipped rules, but they should NOT block)
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

  // totals
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

  // ===== shift editing =====
  function startEdit(r: ShiftCostRow) {
    setEditingShiftId(r.shift_id);
    setEditStart(isoToLocalInput(r.shift_start));
    setEditEnd(isoToLocalInput(r.shift_end));
    setEditBreak(String(r.break_minutes ?? 0));
    setMsg("");
  }

  function cancelEdit() {
    setEditingShiftId(null);
    setEditStart("");
    setEditEnd("");
    setEditBreak("0");
  }

  async function saveEdit() {
    if (!editingShiftId) return;
    if (!editStart || !editEnd) {
      setMsg("❌ Please fill start and end.");
      return;
    }

    const payload: any = {
      shift_start: localInputToISO(editStart),
      shift_end: localInputToISO(editEnd),
      break_minutes: Number(editBreak || "0"),
    };

    const u = await supabase.from("shifts").update(payload).eq("id", editingShiftId);
    if (u.error) {
      setMsg("❌ Update failed: " + u.error.message);
      return;
    }

    setMsg("✅ Updated!");
    cancelEdit();
    await loadShiftCosts();
  }

  async function deleteShift(shiftId: number) {
    if (!confirm("Delete this shift?")) return;
    const d = await supabase.from("shifts").delete().eq("id", shiftId);
    if (d.error) {
      setMsg("❌ Delete failed: " + d.error.message);
      return;
    }
    setMsg("✅ Deleted!");
    await loadShiftCosts();
  }

  // ===== add shift =====
  function openAdd(staffId: string, dayIdx: number) {
    setAddingKey(`${staffId}-${dayIdx}`);
    setAddBreak("0");

    const base = new Date(range.start);
    base.setDate(base.getDate() + dayIdx);
    base.setHours(17, 0, 0, 0);
    const end = new Date(base);
    end.setHours(21, 0, 0, 0);

    setAddStart(isoToLocalInput(base.toISOString()));
    setAddEnd(isoToLocalInput(end.toISOString()));
    setMsg("");
  }

  function closeAdd() {
    setAddingKey(null);
    setAddStart("");
    setAddEnd("");
    setAddBreak("0");
  }

  // warning only: show if overlaps active unavailable (skipped weekly rules do NOT count)
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

  async function saveAdd(staffId: string) {
    if (!addStart || !addEnd) {
      setMsg("❌ Please fill start and end.");
      return;
    }

    const startISO = localInputToISO(addStart);
    const endISO = localInputToISO(addEnd);

    if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
      setMsg("❌ End must be after Start.");
      return;
    }

    warnIfUnavailable(staffId, startISO, endISO);

    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;

    const ins = await supabase.from("shifts").insert(
      [
        {
          store_id: storeId,
          staff_id: staffId,
          shift_start: startISO,
          shift_end: endISO,
          break_minutes: Number(addBreak || "0"),
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
    closeAdd();
    await loadShiftCosts();
  }

  // ===== weekly unavailable rules (manager sets for any staff) =====
  function openAddUnavail(staffId: string, dayIdx: number) {
    setAddingUnKey(`${staffId}-${dayIdx}`);
    setUnStartTime("17:00");
    setUnEndTime("21:00");
    setUnReason("");
    setMsg("");
  }

  function closeAddUnavail() {
    setAddingUnKey(null);
    setUnStartTime("17:00");
    setUnEndTime("21:00");
    setUnReason("");
  }

  async function saveAddUnavailRecurring(staffId: string, dayIdx: number) {
    setMsg("");

    if (!unStartTime || !unEndTime) {
      setMsg("❌ Please fill start/end time.");
      return;
    }

    const jsDow = cellDayIdxToJsDow(dayIdx);

    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id ?? null;

    const ins = await supabase.from("staff_unavailability_recurring").insert(
      [
        {
          staff_id: staffId,
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
    closeAddUnavail();
    await loadRecurringRules();
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

  // ===== one-off override: skip a weekly rule for THIS week only =====
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
      // if already exists, show friendly message
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

  // ===== payroll export =====
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
    const header = "Staff Name,Staff ID,Shift Date,Start,End,Break(min),Hours,Rate,Wage";
    const lines = rows.map((r) => {
      const d = new Date(r.shift_start);
      const shiftDate = d.toLocaleDateString();
      return [
        `"${staffName(r.staff_id).replaceAll('"', '""')}"`,
        r.staff_id,
        `"${shiftDate}"`,
        `"${fmtTime(r.shift_start)}"`,
        `"${fmtTime(r.shift_end)}"`,
        String(r.break_minutes ?? 0),
        r.hours_worked.toFixed(2),
        (r.applied_rate ?? 0).toFixed(2),
        (r.estimated_wage ?? 0).toFixed(2),
      ].join(",");
    });

    downloadCSV(`payroll_detail_${storeId}_${weekStart}.csv`, [header, ...lines].join("\n"));
  }

  return (
    <div style={{ padding: 20 }}>
            <div style={{ marginBottom: 12 }}>
        <button onClick={() => (window.location.href = "/staff/home")}>
          ← Back to Home
        </button>
      </div>
      <h1>Roster — Weekly (Thu → Wed)</h1>

      <div style={{ marginBottom: 10 }}>
        Week Start (THU):{" "}
        <input type="date" value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
        <button onClick={loadAll} style={{ marginLeft: 8 }}>
          Refresh
        </button>

        <button onClick={exportPayrollSummary} style={{ marginLeft: 8 }}>
          Export Payroll (Summary CSV)
        </button>

        <button onClick={exportPayrollDetail} style={{ marginLeft: 8 }}>
          Export Payroll (Detail CSV)
        </button>
      </div>

      {msg && <div style={{ marginBottom: 10 }}>{msg}</div>}

      <div style={{ overflowX: "auto" }}>
        <table cellPadding={8} style={{ borderCollapse: "collapse", minWidth: 1750 }}>
          <thead>
            <tr>
              <th style={{ border: "1px solid #ccc", position: "sticky", left: 0, background: "#fff" }}>
                NAME
              </th>
              {dayLabels.map((d, i) => (
                <th key={d} style={{ border: "1px solid #ccc" }}>
                  <div style={{ fontWeight: 800 }}>{d}</div>
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
                    const key = `${sid}-${dayIdx}`;
                    const isAddingHere = addingKey === key;

                    const unKey = `${sid}-${dayIdx}`;
                    const isAddingUnHere = addingUnKey === unKey;

                    const dayUnav = uCells[dayIdx] ?? [];

                    // active unavailable exists if:
                    // - oneoff always active
                    // - recurring active only if NOT skipped
                    const hasActiveUnav =
                      dayUnav.some((u) => u.kind === "oneoff") ||
                      dayUnav.some((u) => u.kind === "recurring" && !u.isSkippedThisWeek);

                    // recurring rules in this cell (for skip / delete)
                    const recInCell = dayUnav.filter((x) => x.kind === "recurring");

                    return (
                      <td
                        key={dayIdx}
                        style={{
                          border: "1px solid #ccc",
                          verticalAlign: "top",
                          minWidth: 210,
                          background: hasActiveUnav ? "#ffeaea" : "#fff",
                        }}
                      >
                        {/* Unavailable info */}
                        {dayUnav.length > 0 && (
                          <div style={{ fontSize: 12, marginBottom: 6 }}>
                            <b>Unavailable</b>
                            {dayUnav.slice(0, 2).map((u) => (
                              <div key={`${u.kind}-${u.id}`} style={{ color: u.kind === "recurring" && u.isSkippedThisWeek ? "#999" : "#666" }}>
                                {fmtTime(u.start_at)}–{fmtTime(u.end_at)}
                                {u.reason ? ` | ${u.reason}` : ""}
                                {u.kind === "recurring" ? (u.isSkippedThisWeek ? " (weekly, skipped this week)" : " (weekly)") : " (one-off)"}
                              </div>
                            ))}
                            {dayUnav.length > 2 && <div style={{ color: "#777" }}>+{dayUnav.length - 2} more…</div>}
                          </div>
                        )}

                        {/* Shifts */}
                        {cell.length === 0 ? <div style={{ color: "#999" }}>—</div> : null}

                        {cell.map((r) => {
                          const isEditing = editingShiftId === r.shift_id;

                          return (
                            <div key={r.shift_id} style={{ marginBottom: 10, paddingBottom: 8, borderBottom: "1px dashed #ddd" }}>
                              {!isEditing ? (
                                <>
                                  <div style={{ fontWeight: 800 }}>
                                    {fmtTime(r.shift_start)}–{fmtTime(r.shift_end)}
                                  </div>
                                  <div style={{ fontSize: 12, color: "#666" }}>
                                    Break {r.break_minutes ?? 0}m | {r.hours_worked.toFixed(2)}h
                                  </div>
                                  <div style={{ fontSize: 12, color: "#666" }}>
                                    Rate ${(r.applied_rate ?? 0).toFixed(2)} | Wage ${(r.estimated_wage ?? 0).toFixed(2)}
                                  </div>
                                  <div style={{ marginTop: 6 }}>
                                    <button onClick={() => startEdit(r)} style={{ marginRight: 6 }}>
                                      Edit
                                    </button>
                                    <button onClick={() => deleteShift(r.shift_id)}>Delete</button>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div style={{ fontSize: 12, marginBottom: 6 }}>Edit shift</div>
                                  <div style={{ marginBottom: 6 }}>
                                    Start:{" "}
                                    <input type="datetime-local" value={editStart} onChange={(e) => setEditStart(e.target.value)} />
                                  </div>
                                  <div style={{ marginBottom: 6 }}>
                                    End:{" "}
                                    <input type="datetime-local" value={editEnd} onChange={(e) => setEditEnd(e.target.value)} />
                                  </div>
                                  <div style={{ marginBottom: 6 }}>
                                    Break(min):{" "}
                                    <input value={editBreak} onChange={(e) => setEditBreak(e.target.value)} style={{ width: 80 }} />
                                  </div>

                                  <button onClick={saveEdit} style={{ marginRight: 6 }}>
                                    Save
                                  </button>
                                  <button onClick={cancelEdit}>Cancel</button>
                                </>
                              )}
                            </div>
                          );
                        })}

                        {/* Add shift */}
                        {!isAddingHere ? (
                          <button onClick={() => openAdd(sid, dayIdx)}>+ Add Shift</button>
                        ) : (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #eee" }}>
                            <div style={{ fontSize: 12, marginBottom: 6 }}>Add shift</div>
                            <div style={{ marginBottom: 6 }}>
                              Start:{" "}
                              <input type="datetime-local" value={addStart} onChange={(e) => setAddStart(e.target.value)} />
                            </div>
                            <div style={{ marginBottom: 6 }}>
                              End:{" "}
                              <input type="datetime-local" value={addEnd} onChange={(e) => setAddEnd(e.target.value)} />
                            </div>
                            <div style={{ marginBottom: 6 }}>
                              Break(min):{" "}
                              <input value={addBreak} onChange={(e) => setAddBreak(e.target.value)} style={{ width: 80 }} />
                            </div>

                            <button onClick={() => saveAdd(sid)} style={{ marginRight: 6 }}>
                              Save
                            </button>
                            <button onClick={closeAdd}>Cancel</button>
                          </div>
                        )}

                        {/* Add weekly unavailable */}
                        <div style={{ marginTop: 10 }}>
                          {!isAddingUnHere ? (
                            <button onClick={() => openAddUnavail(sid, dayIdx)}>+ Add Unavailable (Weekly)</button>
                          ) : (
                            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #eee" }}>
                              <div style={{ fontSize: 12, marginBottom: 6 }}>Add unavailable (weekly repeating)</div>
                              <div style={{ marginBottom: 6 }}>
                                Start time:{" "}
                                <input type="time" value={unStartTime} onChange={(e) => setUnStartTime(e.target.value)} />
                              </div>
                              <div style={{ marginBottom: 6 }}>
                                End time:{" "}
                                <input type="time" value={unEndTime} onChange={(e) => setUnEndTime(e.target.value)} />
                              </div>
                              <div style={{ marginBottom: 6 }}>
                                Reason:{" "}
                                <input value={unReason} onChange={(e) => setUnReason(e.target.value)} style={{ width: 160 }} placeholder="optional" />
                              </div>

                              <button onClick={() => saveAddUnavailRecurring(sid, dayIdx)} style={{ marginRight: 6 }}>
                                Save
                              </button>
                              <button onClick={closeAddUnavail}>Cancel</button>
                            </div>
                          )}
                        </div>

                        {/* Weekly rule controls inside this day */}
                        {recInCell.length > 0 && (
                          <div style={{ marginTop: 10, fontSize: 12 }}>
                            <b>Weekly rules (this day)</b>
                            {recInCell.slice(0, 3).map((u) => {
                              const skipped = !!u.isSkippedThisWeek;
                              return (
                                <div key={`rule-${u.id}`} style={{ marginTop: 6 }}>
                                  {fmtTime(u.start_at)}–{fmtTime(u.end_at)}{" "}
                                  {!skipped ? (
                                    <button onClick={() => skipRuleThisWeek(u.id)} style={{ marginLeft: 6 }}>
                                      Skip this week
                                    </button>
                                  ) : (
                                    <button onClick={() => undoSkipRuleThisWeek(u.id)} style={{ marginLeft: 6 }}>
                                      Undo skip
                                    </button>
                                  )}
                                  <button onClick={() => deleteRecurringRule(u.id)} style={{ marginLeft: 6 }}>
                                    Delete rule
                                  </button>
                                </div>
                              );
                            })}
                            {recInCell.length > 3 && <div style={{ color: "#777" }}>+ more…</div>}
                          </div>
                        )}
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

      <div style={{ marginTop: 12, color: "#666" }}>
        Notes:
        <ul>
          <li>Light red cells mean the staff has an active unavailable time on that day.</li>
          <li>"Skip this week" makes a weekly unavailable rule NOT apply for this week only.</li>
          <li>Day totals are shown under each day header to help balance staffing.</li>
        </ul>
      </div>
    </div>
  );
}