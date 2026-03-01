import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Range = { startISO: string; endISO: string };

type Shift = {
  id: number;
  staff_id: string;
  shift_start: string;
  shift_end: string;
  break_minutes?: number | null;
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
  role?: string | null; // OWNER / MANAGER / STAFF
  is_active?: boolean | null;
};

type StaffPayRate = {
  staff_id: string;
  weekday_rate?: number | null;
  saturday_rate?: number | null;
  sunday_rate?: number | null;
};

type DayType = "WEEKDAY" | "SATURDAY" | "SUNDAY";

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
  const day = d.getDay(); // Sun=0 ... Sat=6
  if (day === 0) return "SUNDAY";
  if (day === 6) return "SATURDAY";
  return "WEEKDAY";
}

export default function OwnerStaffSummaryPage() {
  // -------- Permission Gate (OWNER ONLY) --------
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
    if (!isOwner) return;

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
    if (!authLoading && isOwner) fetchData();
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

  // -------- Payroll rule (Adjusted -> Raw -> Roster) --------
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

    return { payrollWorkMin, source };
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

      return { shift, payroll, dayType, rate, payrollHours, pay };
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

  // -------- Per staff summary --------
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

    const list = Object.values(map).map((a) => ({
      ...a,
      weekdayPay: round2(a.weekdayPay),
      saturdayPay: round2(a.saturdayPay),
      sundayPay: round2(a.sundayPay),
    }));

    list.sort((x, y) => x.staff_name.localeCompare(y.staff_name));
    return list;
  }, [rows, nameById, payRateByStaffId]);

  const staffOptions = useMemo(() => {
    const list = profiles
      .filter((p) => p?.id && (p.is_active === undefined || p.is_active === null || p.is_active === true))
      .map((p) => ({ id: p.id, name: p.full_name ?? p.id }));

    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [profiles]);

  // -------- UI --------
  if (authLoading) return <div style={{ padding: 20 }}>Loading permission...</div>;

  if (!isOwner) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Staff Summary (hours & pay)</h1>
        <div style={{ padding: 12, border: "1px solid #ddd", marginTop: 12 }}>
          <b>Access denied.</b> This page is only for <b>Owner</b>.
          <br />
          Your role: <b>{viewerRole ?? "UNKNOWN"}</b>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
              <div style={{ marginBottom: 12 }}>
        <button onClick={() => (window.location.href = "/staff/home")}>
          ← Back to Home
        </button>
      </div>
      <h1>Staff Payroll Summary (hours & pay)</h1>

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

      {/* Overall summary */}
      <div style={{ padding: 10, border: "1px solid #ddd", marginBottom: 14 }}>
        <b>Summary:</b>{" "}
        <span style={{ marginLeft: 8 }}>
          <b>{overallSummary.totalHours.toFixed(2)}</b> hours, <b>{money(overallSummary.totalPay)}</b>
        </span>
        <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
          Payroll time rule: <b>Adjusted</b> (if exists) → <b>Raw clock</b> → <b>Roster</b>.
        </div>
      </div>

      {/* Per staff vertical summary */}
      <div style={{ marginTop: 10 }}>
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