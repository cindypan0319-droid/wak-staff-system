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
  role?: string | null;
  is_active?: boolean | null;
};

type StaffPayRate = {
  staff_id: string;
  weekday_rate?: number | null;
  saturday_rate?: number | null;
  sunday_rate?: number | null;
};

type DayType = "WEEKDAY" | "SATURDAY" | "SUNDAY";

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

function getDayTypeByISO(iso: string): DayType {
  const d = new Date(iso);
  const day = d.getDay();
  if (day === 0) return "SUNDAY";
  if (day === 6) return "SATURDAY";
  return "WEEKDAY";
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

  const shownStaffCount = perStaffSummary.length;

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
            <h1 style={{ marginTop: 0, color: TEXT }}>Payroll Summary</h1>
            <div
              style={{
                padding: 14,
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                background: "#fff",
                color: TEXT,
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
          <h1 style={{ margin: 0, color: TEXT }}>Payroll Summary</h1>
          <div style={{ marginTop: 6, color: MUTED }}>
            Owner-only payroll hours and pay overview
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
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Overall Summary</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
              Payroll time rule: <b>Adjusted</b> → <b>Raw clock</b> → <b>Roster</b>.
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "#F9FAFB",
                border: `1px solid ${BORDER}`,
                minWidth: 160,
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
                minWidth: 160,
              }}
            >
              <div style={{ fontSize: 12, color: MUTED }}>Total hours</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: WAK_BLUE }}>{overallSummary.totalHours.toFixed(2)}h</div>
            </div>

            <div
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                background: "#F9FAFB",
                border: `1px solid ${BORDER}`,
                minWidth: 160,
              }}
            >
              <div style={{ fontSize: 12, color: MUTED }}>Total pay</div>
              <div style={{ fontWeight: 800, fontSize: 18, color: WAK_RED }}>{money(overallSummary.totalPay)}</div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          {perStaffSummary.length === 0 ? (
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
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {perStaffSummary.map((s) => {
                const weekdayHours = round2(s.weekdayMin / 60);
                const saturdayHours = round2(s.saturdayMin / 60);
                const sundayHours = round2(s.sundayMin / 60);

                const totalHours = round2((s.weekdayMin + s.saturdayMin + s.sundayMin) / 60);
                const totalPay = round2(s.weekdayPay + s.saturdayPay + s.sundayPay);

                return (
                  <div
                    key={s.staff_id}
                    style={{
                      border: `1px solid ${BORDER}`,
                      borderRadius: 18,
                      background: CARD_BG,
                      padding: 18,
                      boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        flexWrap: "wrap",
                        alignItems: "center",
                        marginBottom: 12,
                      }}
                    >
                      <div style={{ fontWeight: 900, fontSize: 20, color: TEXT }}>{s.staff_name}</div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <div
                          style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            background: "#F9FAFB",
                            border: `1px solid ${BORDER}`,
                            fontSize: 13,
                            color: MUTED,
                          }}
                        >
                          Total hours: <b style={{ color: TEXT }}>{totalHours.toFixed(2)}</b>
                        </div>
                        <div
                          style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            background: "#F9FAFB",
                            border: `1px solid ${BORDER}`,
                            fontSize: 13,
                            color: MUTED,
                          }}
                        >
                          Total pay: <b style={{ color: TEXT }}>{money(totalPay)}</b>
                        </div>
                      </div>
                    </div>

                    <div style={{ overflowX: "auto" }}>
                      <table
                        style={{
                          width: "100%",
                          maxWidth: 620,
                          borderCollapse: "separate",
                          borderSpacing: 0,
                        }}
                      >
                        <thead>
                          <tr>
                            {["Type", "Hours", "Payrate", "Pay"].map((head) => (
                              <th
                                key={head}
                                style={{
                                  textAlign: "left",
                                  padding: "10px 10px",
                                  borderBottom: `1px solid ${BORDER}`,
                                  color: MUTED,
                                  fontSize: 13,
                                  background: "#FAFAFA",
                                }}
                              >
                                {head}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              Weekday
                            </td>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              {weekdayHours.toFixed(2)}
                            </td>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              {s.weekdayRate === null ? "-" : money(s.weekdayRate)}
                            </td>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              {money(s.weekdayPay)}
                            </td>
                          </tr>

                          <tr>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              Saturday
                            </td>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              {saturdayHours.toFixed(2)}
                            </td>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              {s.saturdayRate === null ? "-" : money(s.saturdayRate)}
                            </td>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              {money(s.saturdayPay)}
                            </td>
                          </tr>

                          <tr>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              Sunday
                            </td>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              {sundayHours.toFixed(2)}
                            </td>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              {s.sundayRate === null ? "-" : money(s.sundayRate)}
                            </td>
                            <td style={{ padding: "10px 10px", borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                              {money(s.sundayPay)}
                            </td>
                          </tr>

                          <tr>
                            <td style={{ padding: "12px 10px", fontWeight: 800, color: TEXT }}>Total</td>
                            <td style={{ padding: "12px 10px", fontWeight: 800, color: TEXT }}>
                              {totalHours.toFixed(2)}
                            </td>
                            <td style={{ padding: "12px 10px", fontWeight: 800, color: TEXT }}>-</td>
                            <td style={{ padding: "12px 10px", fontWeight: 800, color: TEXT }}>
                              {money(totalPay)}
                            </td>
                          </tr>
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
    </div>
  );
}