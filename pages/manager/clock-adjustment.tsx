import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Range = { startISO: string; endISO: string };

type Shift = {
  id: number;
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes?: number | null;
  hourly_rate?: number | null; // may exist but we will prefer staff_pay_rates
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
  role?: string | null; // OWNER / MANAGER / STAFF
  is_active?: boolean | null;
};

type StaffPayRate = {
  id?: any;
  staff_id: string;
  weekday_rate?: number | null;
  saturday_rate?: number | null;
  sunday_rate?: number | null;

  // some schemas may have store_id; we ignore it safely by selecting "*"
  store_id?: string | null;
};

type DayType = "WEEKDAY" | "SATURDAY" | "SUNDAY";

function fmtAU(iso: string | null | undefined) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-AU", { timeZone: "Australia/Melbourne" });
}

function money(n: number | null | undefined) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function hoursFromMinutes(min: number | null) {
  if (min === null) return null;
  return round2(min / 60);
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

// From/To are DATE input values (YYYY-MM-DD), To is inclusive.
// Range end is exclusive: (to + 1 day) 00:00
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
  // Browser local is Melbourne for you; shift_start is timestamptz; Date will convert to local.
  const d = new Date(iso);
  const day = d.getDay(); // Sun=0 ... Sat=6
  if (day === 0) return "SUNDAY";
  if (day === 6) return "SATURDAY";
  return "WEEKDAY";
}

export default function ClockAdjustmentPage() {
  // -------- Permission Gate --------
  const [authLoading, setAuthLoading] = useState(true);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const isManagerOrOwner = viewerRole === "OWNER" || viewerRole === "MANAGER";

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

  // -------- Filters --------
  const [fromDate, setFromDate] = useState<string>(todayDateInputValue());
  const [toDate, setToDate] = useState<string>(todayDateInputValue());
  const [selectedStaffId, setSelectedStaffId] = useState<string>("ALL");

  // -------- Data --------
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const [shifts, setShifts] = useState<Shift[]>([]);
  const [clocks, setClocks] = useState<TimeClock[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [payRates, setPayRates] = useState<StaffPayRate[]>([]);

  // edit state
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

      // clock window with buffer for matching
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

        supabase
          .from("staff_pay_rates")
          .select("*"),
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

  // -------- Matching clock for each shift --------
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

  // -------- Actions --------
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
      if (error) return setMsg("Create clock failed: " + error.message);

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

      if (!adjustedInISO || !adjustedOutISO) return setMsg("Please select both adjusted Clock In and Clock Out.");
      if (!reason) return setMsg("Please enter a reason (required).");

      const payload: any = {
        adjusted_clock_in_at: adjustedInISO,
        adjusted_clock_out_at: adjustedOutISO,
        adjusted_reason: reason,
        adjusted_by: viewerId,
        adjusted_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("time_clock").update(payload).eq("id", clockId);
      if (error) return setMsg("Save failed: " + error.message);

      setMsg("Adjustment saved.");
      await fetchData();
    } finally {
      setLoading(false);
    }
  }

  function setToRoster(clockId: number, shift: Shift) {
    const inVal = new Date(shift.shift_start);
    const outVal = new Date(shift.shift_end);

    // input datetime-local expects local time string "YYYY-MM-DDTHH:mm"
    const toLocal = (d: Date) => {
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
        d.getMinutes()
      )}`;
    };

    setEditIn((p) => ({ ...p, [clockId]: toLocal(inVal) }));
    setEditOut((p) => ({ ...p, [clockId]: toLocal(outVal) }));
  }

  // -------- Payroll logic --------
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

    // Your rule:
    // Adjusted exists -> use it
    // else use raw clock
    // else use roster (for missing record)
    const payrollWorkMin = adjWorkMin ?? rawWorkMin ?? rosterWorkMin;

    const source = adjWorkMin !== null ? "ADJUSTED" : rawWorkMin !== null ? "RAW" : rosterWorkMin !== null ? "ROSTER" : "NONE";

    return { breakMin, rosterWorkMin, rawWorkMin, adjWorkMin, payrollWorkMin, source };
  }

  const filteredShifts = useMemo(() => {
    if (selectedStaffId === "ALL") return shifts;
    return shifts.filter((s) => s.staff_id === selectedStaffId);
  }, [shifts, selectedStaffId]);

  const rows = useMemo(() => {
    return filteredShifts.map((shift) => {
      const clock = findClockForShift(shift);
      const payroll = getPayrollMinutes(shift, clock);

      const dayType = getDayTypeByISO(shift.shift_start);
      const rate = rateFor(shift.staff_id, dayType);

      const payrollHours = payroll.payrollWorkMin !== null ? round2(payroll.payrollWorkMin / 60) : null;
      const pay = payrollHours !== null && rate !== null ? round2(payrollHours * rate) : null;

      return { shift, clock, payroll, dayType, rate, payrollHours, pay };
    });
  }, [filteredShifts, clocks, payRateByStaffId]);

  // -------- Summary (overall) --------
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

  // -------- Summary (per staff vertical layout like your sheet) --------
  type StaffAgg = {
    staff_id: string;
    staff_name: string;
    weekdayMin: number;
    saturdayMin: number;
    sundayMin: number;
    weekdayPay: number;
    saturdayPay: number;
    sundayPay: number;
    weekdayRate: number | null;
    saturdayRate: number | null;
    sundayRate: number | null;
  };

  const perStaffSummary = useMemo(() => {
    const map: Record<string, StaffAgg> = {};

    const ensure = (staffId: string): StaffAgg => {
      if (map[staffId]) return map[staffId];

      const weekdayRate = rateFor(staffId, "WEEKDAY");
      const saturdayRate = rateFor(staffId, "SATURDAY");
      const sundayRate = rateFor(staffId, "SUNDAY");

      map[staffId] = {
        staff_id: staffId,
        staff_name: staffLabel(staffId),

        weekdayMin: 0,
        saturdayMin: 0,
        sundayMin: 0,

        weekdayPay: 0,
        saturdayPay: 0,
        sundayPay: 0,

        weekdayRate,
        saturdayRate,
        sundayRate,
      };
      return map[staffId];
    };

    for (const r of rows) {
      const staffId = r.shift.staff_id;
      const agg = ensure(staffId);

      const min = r.payroll.payrollWorkMin ?? 0;
      const hrs = min / 60;

      if (r.dayType === "WEEKDAY") {
        agg.weekdayMin += min;
        if (agg.weekdayRate !== null) agg.weekdayPay += hrs * agg.weekdayRate;
      } else if (r.dayType === "SATURDAY") {
        agg.saturdayMin += min;
        if (agg.saturdayRate !== null) agg.saturdayPay += hrs * agg.saturdayRate;
      } else {
        agg.sundayMin += min;
        if (agg.sundayRate !== null) agg.sundayPay += hrs * agg.sundayRate;
      }
    }

    // finalize rounding
    const list = Object.values(map).map((a) => ({
      ...a,
      weekdayPay: round2(a.weekdayPay),
      saturdayPay: round2(a.saturdayPay),
      sundayPay: round2(a.sundayPay),
    }));

    // sort by name
    list.sort((x, y) => x.staff_name.localeCompare(y.staff_name));
    return list;
  }, [rows, nameById, payRateByStaffId]);

  // dropdown staff list
  const staffOptions = useMemo(() => {
    // Show all active profiles (as you chose 2A)
    const list = profiles
      .filter((p) => p?.id && (p.is_active === undefined || p.is_active === null || p.is_active === true))
      .map((p) => ({ id: p.id, name: p.full_name ?? p.id }));

    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [profiles]);

  // -------- UI: permission --------
  if (authLoading) return <div style={{ padding: 20 }}>Loading permission...</div>;

  if (!isManagerOrOwner) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Roster and Time Clock Adjustment</h1>
        <div style={{ padding: 12, border: "1px solid #ddd", marginTop: 12 }}>
          <b>Access denied.</b> This page is only for <b>Owner / Manager</b>.<br />
          Your role: <b>{viewerRole ?? "UNKNOWN"}</b>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Roster and Time Clock Adjustment</h1>

      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "end",
          flexWrap: "wrap",
          padding: 10,
          border: "1px solid #ddd",
          marginBottom: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: "#666" }}>From</div>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} disabled={loading} />
        </div>

        <div>
          <div style={{ fontSize: 12, color: "#666" }}>To (inclusive)</div>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} disabled={loading} />
        </div>

        <div style={{ minWidth: 220 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Staff</div>
          <select
            value={selectedStaffId}
            onChange={(e) => setSelectedStaffId(e.target.value)}
            disabled={loading}
            style={{ width: "100%" }}
          >
            <option value="ALL">All staff</option>
            {staffOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>

        <button onClick={fetchData} disabled={loading}>
          Apply
        </button>

        <button
          onClick={() => {
            const t = todayDateInputValue();
            setFromDate(t);
            setToDate(t);
            setSelectedStaffId("ALL");
          }}
          disabled={loading}
        >
          Reset
        </button>

        {loading && <span style={{ marginLeft: 8 }}>Loading...</span>}
      </div>

      {msg && <div style={{ padding: 10, border: "1px solid #ddd", marginBottom: 10 }}>{msg}</div>}

      {/* Overall Summary (hours) */}
      <div style={{ padding: 10, border: "1px solid #ddd", marginBottom: 10 }}>
        <b>Summary:</b>{" "}
        <span style={{ marginLeft: 8 }}>
          <b>{overallSummary.totalHours.toFixed(2)}</b> hours, <b>{money(overallSummary.totalPay)}</b>
        </span>
        <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
          Payroll time rule: <b>Adjusted</b> (if exists) → <b>Raw clock</b> → <b>Roster</b>.
        </div>
      </div>

      {/* Main Table */}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Staff</th>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Shift Start</th>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Shift End</th>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Day</th>

            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Raw In</th>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Raw Out</th>

            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Adjusted In</th>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Adjusted Out</th>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Reason</th>

            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Payroll source</th>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Hours</th>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Payrate</th>
            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Pay</th>

            <th style={{ borderBottom: "1px solid #ddd", textAlign: "left" }}>Actions</th>
          </tr>
        </thead>

        <tbody>
          {rows.map((r) => {
            const shift = r.shift;
            const clock = r.clock;
            const hasClock = !!clock;
            const clockId = clock?.id ?? -1;

            const adjustedInValue =
              clockId !== -1 && editIn[clockId] !== undefined ? editIn[clockId] : "";

            const adjustedOutValue =
              clockId !== -1 && editOut[clockId] !== undefined ? editOut[clockId] : "";

            const reasonValue =
              clockId !== -1 && editReason[clockId] !== undefined ? editReason[clockId] : clock?.adjusted_reason ?? "";

            const hoursText =
              r.payrollHours === null ? "-" : `${r.payrollHours.toFixed(2)}`;

            return (
              <tr key={shift.id}>
                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{staffLabel(shift.staff_id)}</td>
                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{fmtAU(shift.shift_start)}</td>
                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{fmtAU(shift.shift_end)}</td>
                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                  {r.dayType === "WEEKDAY" ? "Weekday" : r.dayType === "SATURDAY" ? "Saturday" : "Sunday"}
                </td>

                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{fmtAU(clock?.clock_in_at ?? null)}</td>
                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{fmtAU(clock?.clock_out_at ?? null)}</td>

                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                  {!hasClock ? (
                    <span style={{ color: "#999" }}>No clock record</span>
                  ) : (
                    <input
                      type="datetime-local"
                      value={adjustedInValue || (clock?.adjusted_clock_in_at ? new Date(clock.adjusted_clock_in_at).toISOString().slice(0,16) : "")}
                      onChange={(e) => setEditIn((p) => ({ ...p, [clockId]: e.target.value }))}
                    />
                  )}
                </td>

                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                  {!hasClock ? (
                    <span style={{ color: "#999" }}>No clock record</span>
                  ) : (
                    <input
                      type="datetime-local"
                      value={adjustedOutValue || (clock?.adjusted_clock_out_at ? new Date(clock.adjusted_clock_out_at).toISOString().slice(0,16) : "")}
                      onChange={(e) => setEditOut((p) => ({ ...p, [clockId]: e.target.value }))}
                    />
                  )}
                </td>

                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                  {!hasClock ? (
                    <span style={{ color: "#999" }}>-</span>
                  ) : (
                    <input
                      placeholder="Reason (required)"
                      style={{ width: 200 }}
                      value={reasonValue}
                      onChange={(e) => setEditReason((p) => ({ ...p, [clockId]: e.target.value }))}
                    />
                  )}
                </td>

                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>{r.payroll.source}</td>
                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                  <b>{hoursText}</b>
                </td>
                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                  {r.rate === null ? "-" : money(r.rate)}
                </td>
                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                  <b>{money(r.pay)}</b>
                </td>

                <td style={{ padding: 8, borderBottom: "1px solid #eee" }}>
                  {!hasClock ? (
                    <button onClick={() => createClockForShift(shift)} disabled={loading}>
                      Create clock
                    </button>
                  ) : (
                    <>
                      <button onClick={() => setToRoster(clockId, shift)} disabled={loading} style={{ marginRight: 8 }}>
                        Set to roster
                      </button>
                      <button onClick={() => saveAdjustment(clockId)} disabled={loading} style={{ marginRight: 8 }}>
                        Save
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}

          {rows.length === 0 && (
            <tr>
              <td colSpan={14} style={{ padding: 12, color: "#999" }}>
                No shifts found in this date range.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Per staff vertical summary */}
      <div style={{ marginTop: 20 }}>
        <h2>Staff Summary (hours & pay)</h2>

        {perStaffSummary.length === 0 ? (
          <div style={{ color: "#999" }}>No data.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {perStaffSummary.map((s) => {
              const weekdayHours = round2(s.weekdayMin / 60);
              const saturdayHours = round2(s.saturdayMin / 60);
              const sundayHours = round2(s.sundayMin / 60);

              const totalHours = round2((s.weekdayMin + s.saturdayMin + s.sundayMin) / 60);
              const totalPay = round2(s.weekdayPay + s.saturdayPay + s.sundayPay);

              return (
                <div key={s.staff_id} style={{ border: "1px solid #ddd", padding: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>{s.staff_name}</div>

                  <table style={{ width: 520, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>Type</th>
                        <th style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>Hours</th>
                        <th style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>Payrate</th>
                        <th style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>Pay</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={{ padding: "6px 0" }}>Weekday</td>
                        <td>{weekdayHours.toFixed(2)}</td>
                        <td>{s.weekdayRate === null ? "-" : money(s.weekdayRate)}</td>
                        <td>{money(s.weekdayPay)}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: "6px 0" }}>Saturday</td>
                        <td>{saturdayHours.toFixed(2)}</td>
                        <td>{s.saturdayRate === null ? "-" : money(s.saturdayRate)}</td>
                        <td>{money(s.saturdayPay)}</td>
                      </tr>
                      <tr>
                        <td style={{ padding: "6px 0" }}>Sunday</td>
                        <td>{sundayHours.toFixed(2)}</td>
                        <td>{s.sundayRate === null ? "-" : money(s.sundayRate)}</td>
                        <td>{money(s.sundayPay)}</td>
                      </tr>
                      <tr>
                        <td style={{ paddingTop: 8, fontWeight: 700 }}>Total</td>
                        <td style={{ paddingTop: 8, fontWeight: 700 }}>{totalHours.toFixed(2)}</td>
                        <td style={{ paddingTop: 8, fontWeight: 700 }}>-</td>
                        <td style={{ paddingTop: 8, fontWeight: 700 }}>{money(totalPay)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}