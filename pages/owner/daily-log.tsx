import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;
type ProfileRow = { id: string; full_name: string | null; preferred_name?: string | null; role?: Role | null };
type DailySalesRow = {
  business_date: string; store_id: string; cash_sales: number | null; expected_cash: number | null;
  eftpos_sales: number | null; total_sales: number | null; notes: string | null; entered_by: string | null;
};
type PlatformIncomeRow = {
  business_date: string; store_id: string; platform: string; gross_income: number | null;
  fees: number | null; entered_by: string | null;
};
type CashupSessionRow = {
  business_date: string; store_id: string; session_type: "MORNING" | "NIGHT" | string;
  total_cash: number | null; removed_cash: number | null; counts: unknown; entered_by: string | null;
  created_at: string | null; updated_at: string | null;
};
type MorningState =
  | { status: "missing"; total: 400; warning: string }
  | { status: "valid"; total: number; warning: string | null }
  | { status: "malformed" | "unavailable"; total: null; warning: string };
type NightState = {
  denominationTotal: number | null; removedDenominationTotal: number | null;
  nightTotalMatches: boolean; removedTotalMatches: boolean; warnings: string[];
};
type DailyLogRow = {
  businessDate: string; dailySales: DailySalesRow | null; morning: CashupSessionRow | null;
  night: CashupSessionRow | null; morningState: MorningState; nightState: NightState | null;
  platforms: PlatformIncomeRow[];
  countedDailyCashMovement: number | null; cashVariance: number | null;
  targetRemovedCash: number | null; projectedClosingFloat: number | null;
  closingFloatVariance: number | null;
};

const DEFAULT_STORE_ID = "MOOROOLBARK";
const TARGET_CLOSING_FLOAT = 400;
const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

const CASH_DENOMINATIONS = {
  note100: 100, note50: 50, note20: 20, note10: 10, note5: 5,
  coin2: 2, coin1: 1, coin50c: 0.5, coin20c: 0.2, coin10c: 0.1, coin5c: 0.05,
} as const;
const NIGHT_METADATA_KEYS = new Set([
  "_removed_counts", "_cash_diff_reason", "_cash_diff_note", "_close_contract_version",
]);

function round2(value: number) { return Math.round(value * 100) / 100; }
function numberOrNull(value: unknown) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function money(value: number | null | undefined) {
  if (value == null) return "—";
  return value.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}
function todayDateInputValue() {
  const date = new Date();
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function dateDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function firstDayOfMonth() {
  return `${todayDateInputValue().slice(0, 7)}-01`;
}
function dayLabel(isoDate: string) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short" });
}
function displayDate(isoDate: string) {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString("en-AU", {
    day: "2-digit", month: "short", year: "numeric",
  });
}
function displayTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-AU");
}
function displayName(profile: ProfileRow | undefined) {
  const preferred = (profile?.preferred_name ?? "").trim();
  const full = (profile?.full_name ?? "").trim();
  return preferred || full || "—";
}
function listDatesDescending(startDate: string, endDate: string) {
  if (!startDate || !endDate || startDate > endDate) return [];
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const dates: string[] = [];
  const cursor = new Date(end);
  while (cursor >= start) {
    const pad = (number: number) => String(number).padStart(2, "0");
    dates.push(`${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`);
    cursor.setDate(cursor.getDate() - 1);
  }
  return dates;
}

function calculateMorningState(morning: CashupSessionRow | null): MorningState {
  if (!morning) {
    return { status: "missing", total: TARGET_CLOSING_FLOAT,
      warning: "No Morning cashup saved — Daily Close calculation uses the $400 fallback." };
  }
  if (typeof morning.counts !== "object" || morning.counts === null || Array.isArray(morning.counts)) {
    return { status: "malformed", total: null,
      warning: "Morning cashup data is malformed/incomplete. Cash reconciliation cannot be calculated safely." };
  }
  const counts = morning.counts as Record<string, unknown>;
  const expectedKeys = Object.keys(CASH_DENOMINATIONS);
  const actualKeys = Object.keys(counts);
  if (actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key) => !Object.prototype.hasOwnProperty.call(CASH_DENOMINATIONS, key))) {
    return { status: "malformed", total: null,
      warning: "Morning cashup data is malformed/incomplete. Cash reconciliation cannot be calculated safely." };
  }
  let total = 0;
  for (const key of expectedKeys as (keyof typeof CASH_DENOMINATIONS)[]) {
    const quantity = counts[key];
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0) {
      return { status: "malformed", total: null,
        warning: "Morning cashup data is malformed/incomplete. Cash reconciliation cannot be calculated safely." };
    }
    total += quantity * CASH_DENOMINATIONS[key];
  }
  const calculatedTotal = round2(total);
  const storedTotal = numberOrNull(morning.total_cash);
  return { status: "valid", total: calculatedTotal,
    warning: storedTotal != null && Math.abs(storedTotal - calculatedTotal) >= 0.01
      ? `Morning denominations total ${money(calculatedTotal)}, but the stored total is ${money(storedTotal)}.`
      : null };
}

function denominationTotal(value: unknown, allowNightMetadata = false): number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const counts = value as Record<string, unknown>;
  const denominationKeys = Object.keys(CASH_DENOMINATIONS);
  const suppliedKeys = Object.keys(counts);
  if (suppliedKeys.filter((key) => Object.prototype.hasOwnProperty.call(CASH_DENOMINATIONS, key)).length
      !== denominationKeys.length || suppliedKeys.some((key) =>
      !Object.prototype.hasOwnProperty.call(CASH_DENOMINATIONS, key)
      && !(allowNightMetadata && NIGHT_METADATA_KEYS.has(key)))) return null;
  let total = 0;
  for (const key of denominationKeys as (keyof typeof CASH_DENOMINATIONS)[]) {
    const quantity = counts[key];
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 0) return null;
    total += quantity * CASH_DENOMINATIONS[key];
  }
  return round2(total);
}

function calculateNightState(night: CashupSessionRow | null): NightState | null {
  if (!night) return null;
  const counts = night.counts;
  const denominationTotalValue = denominationTotal(counts, true);
  const removedCounts = typeof counts === "object" && counts !== null && !Array.isArray(counts)
    ? (counts as Record<string, unknown>)._removed_counts : null;
  const removedDenominationTotal = denominationTotal(removedCounts);
  const storedNightTotal = numberOrNull(night.total_cash);
  const storedRemovedTotal = numberOrNull(night.removed_cash);
  const nightTotalMatches = denominationTotalValue != null && storedNightTotal != null
    && round2(denominationTotalValue) === round2(storedNightTotal);
  const removedTotalMatches = removedDenominationTotal != null && storedRemovedTotal != null
    && round2(removedDenominationTotal) === round2(storedRemovedTotal);
  const warnings: string[] = [];
  if (denominationTotalValue == null) {
    warnings.push("NIGHT denomination counts are missing or malformed (legacy/incomplete cashup data).");
  } else if (!nightTotalMatches) {
    warnings.push(`NIGHT denominations total ${money(denominationTotalValue)}, but stored total is ${money(storedNightTotal)}.`);
  }
  if (removedDenominationTotal == null) {
    warnings.push("Removed-cash denomination counts are missing or malformed (legacy/incomplete cashup data).");
  } else if (!removedTotalMatches) {
    warnings.push(`Removed denominations total ${money(removedDenominationTotal)}, but stored removed cash is ${money(storedRemovedTotal)}.`);
  }
  return { denominationTotal: denominationTotalValue, removedDenominationTotal,
    nightTotalMatches, removedTotalMatches, warnings };
}

function sumStoredMoney<T>(rows: T[], field: (row: T) => unknown): number | null {
  let total = 0;
  for (const row of rows) {
    const amount = numberOrNull(field(row));
    if (amount == null) return null;
    total += amount;
  }
  return round2(total);
}

function csvCell(value: string | number | null | undefined, textValue = false) {
  const raw = value == null ? "" : String(value);
  const safe = textValue && /^[\s]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

function actionButton(label: string, onClick: () => void, primary = false, disabled = false) {
  return <button type="button" onClick={onClick} disabled={disabled} style={{
    padding: "10px 14px", minHeight: 42, borderRadius: 10,
    border: `1px solid ${primary ? WAK_BLUE : BORDER}`,
    background: disabled ? "#D1D5DB" : primary ? WAK_BLUE : "#fff",
    color: disabled || primary ? "#fff" : TEXT, fontWeight: 800, fontSize: 14,
    cursor: disabled ? "not-allowed" : "pointer",
  }}>{label}</button>;
}
function statCard(label: string, value: string, color?: string) {
  return <div style={{ padding: "10px 12px", borderRadius: 12, background: "#F9FAFB",
    border: `1px solid ${BORDER}`, minWidth: 150 }}>
    <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
    <div style={{ fontWeight: 800, fontSize: 18, color: color ?? TEXT }}>{value}</div>
  </div>;
}
function valueCell(value: number | null, highlightVariance = false) {
  const nearZero = value != null && Math.abs(value) < 0.01;
  return <span style={{ fontWeight: 700,
    color: highlightVariance ? (nearZero ? "#15803D" : WAK_RED) : TEXT }}>{money(value)}</span>;
}
function derivedCell(value: number | null, invalidCashData: boolean, highlightVariance = false) {
  return invalidCashData
    ? <span style={{ color: WAK_RED }}>Unavailable due to incomplete/inconsistent legacy cashup data</span>
    : valueCell(value, highlightVariance);
}
function summaryMoney(value: number | null, readFailed: boolean) {
  return readFailed ? "Read unavailable" : value == null ? "Incomplete stored data" : money(value);
}

export default function OwnerDailyLogPage() {
  const [loading, setLoading] = useState(true);
  const [roleLoading, setRoleLoading] = useState(true);
  const [role, setRole] = useState<Role>("ANON");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [startDate, setStartDate] = useState(dateDaysAgo(30));
  const [endDate, setEndDate] = useState(todayDateInputValue());
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [dailySales, setDailySales] = useState<DailySalesRow[]>([]);
  const [platformIncome, setPlatformIncome] = useState<PlatformIncomeRow[]>([]);
  const [cashups, setCashups] = useState<CashupSessionRow[]>([]);
  const [readFailures, setReadFailures] = useState({ profiles: false, dailySales: false,
    platformIncome: false, cashups: false });
  const isOwner = role === "OWNER";

  async function loadRole() {
    setRoleLoading(true);
    setRoleError(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) { window.location.href = "/"; return; }
      const { data, error } = await supabase.from("profiles")
        .select("id, full_name, preferred_name, role").eq("id", userId).maybeSingle();
      if (error) { setRole("ANON"); setRoleError(error.message); return; }
      setRole(((data as ProfileRow | null)?.role as Role) ?? "ANON");
    } catch (error) {
      setRole("ANON");
      setRoleError(error instanceof Error ? error.message : "Unexpected profile read failure");
    } finally { setRoleLoading(false); }
  }

  async function loadAll() {
    setLoading(true);
    setMsg("");
    try {
      const [profilesResult, dailyResult, platformResult, cashupResult] = await Promise.all([
        supabase.from("profiles").select("id, full_name, preferred_name, role")
          .order("full_name", { ascending: true }),
        supabase.from("daily_sales")
          .select("business_date, store_id, cash_sales, expected_cash, eftpos_sales, total_sales, notes, entered_by")
          .eq("store_id", DEFAULT_STORE_ID).gte("business_date", startDate).lte("business_date", endDate)
          .order("business_date", { ascending: false }),
        supabase.from("platform_income")
          .select("business_date, store_id, platform, gross_income, fees, entered_by")
          .eq("store_id", DEFAULT_STORE_ID).gte("business_date", startDate).lte("business_date", endDate)
          .order("business_date", { ascending: false }),
        supabase.from("cashup_sessions")
          .select("business_date, store_id, session_type, total_cash, removed_cash, counts, entered_by, created_at, updated_at")
          .eq("store_id", DEFAULT_STORE_ID).gte("business_date", startDate).lte("business_date", endDate)
          .order("business_date", { ascending: false }),
      ]);
      const errors: string[] = [];
      setReadFailures({ profiles: Boolean(profilesResult.error), dailySales: Boolean(dailyResult.error),
        platformIncome: Boolean(platformResult.error), cashups: Boolean(cashupResult.error) });
      if (profilesResult.error) { errors.push("profiles: " + profilesResult.error.message); setProfiles([]); }
      else setProfiles((profilesResult.data ?? []) as ProfileRow[]);
      if (dailyResult.error) { errors.push("daily sales: " + dailyResult.error.message); setDailySales([]); }
      else setDailySales((dailyResult.data ?? []) as DailySalesRow[]);
      if (platformResult.error) { errors.push("platform income: " + platformResult.error.message); setPlatformIncome([]); }
      else setPlatformIncome((platformResult.data ?? []) as PlatformIncomeRow[]);
      if (cashupResult.error) { errors.push("cashup sessions: " + cashupResult.error.message); setCashups([]); }
      else setCashups((cashupResult.data ?? []) as CashupSessionRow[]);
      setMsg(errors.length > 0
        ? `❌ Some Daily Log data could not be loaded: ${errors.join(" ")}`
        : "✅ Daily Close records loaded. This page is read-only.");
    } catch (error) {
      setReadFailures({ profiles: true, dailySales: true, platformIncome: true, cashups: true });
      setProfiles([]);
      setDailySales([]);
      setPlatformIncome([]);
      setCashups([]);
      setMsg(`❌ Daily Log data could not be loaded: ${error instanceof Error ? error.message : "Unexpected read failure"}`);
    } finally { setLoading(false); }
  }

  useEffect(() => { loadRole(); }, []);
  useEffect(() => {
    if (!roleLoading && isOwner) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleLoading, role, startDate, endDate]);

  const profileMap = useMemo(() => {
    const map = new Map<string, ProfileRow>();
    for (const profile of profiles) map.set(profile.id, profile);
    return map;
  }, [profiles]);

  const rows = useMemo<DailyLogRow[]>(() => {
    const dailyMap = new Map(dailySales.map((row) => [row.business_date, row]));
    const morningMap = new Map<string, CashupSessionRow>();
    const nightMap = new Map<string, CashupSessionRow>();
    const platformsMap = new Map<string, PlatformIncomeRow[]>();
    for (const cashup of cashups) {
      const type = cashup.session_type.toUpperCase();
      if (type === "MORNING") morningMap.set(cashup.business_date, cashup);
      if (type === "NIGHT") nightMap.set(cashup.business_date, cashup);
    }
    for (const platform of platformIncome) {
      const existing = platformsMap.get(platform.business_date) ?? [];
      existing.push(platform);
      platformsMap.set(platform.business_date, existing);
    }
    return listDatesDescending(startDate, endDate).map((businessDate) => {
      const dailySalesRow = dailyMap.get(businessDate) ?? null;
      const morning = morningMap.get(businessDate) ?? null;
      const night = nightMap.get(businessDate) ?? null;
      const morningState: MorningState = readFailures.cashups
        ? { status: "unavailable", total: null, warning: "Morning cashup could not be loaded; opening float is unknown." }
        : calculateMorningState(morning);
      const nightState = readFailures.cashups ? null : calculateNightState(night);
      const nightTotal = nightState?.nightTotalMatches ? numberOrNull(night?.total_cash) : null;
      const removedCash = nightState?.removedTotalMatches ? numberOrNull(night?.removed_cash) : null;
      const posCash = readFailures.dailySales ? null : numberOrNull(dailySalesRow?.cash_sales);
      const countedDailyCashMovement = nightTotal != null && morningState.total != null
        ? round2(nightTotal - morningState.total) : null;
      const cashVariance = posCash != null && countedDailyCashMovement != null
        ? round2(posCash - countedDailyCashMovement) : null;
      const targetRemovedCash = nightTotal != null
        ? round2(Math.max(0, nightTotal - TARGET_CLOSING_FLOAT)) : null;
      const projectedClosingFloat = nightTotal != null && removedCash != null
        ? round2(nightTotal - removedCash) : null;
      const closingFloatVariance = projectedClosingFloat != null
        ? round2(projectedClosingFloat - TARGET_CLOSING_FLOAT) : null;
      return { businessDate, dailySales: dailySalesRow, morning, night, morningState, nightState,
        platforms: (platformsMap.get(businessDate) ?? []).sort((a, b) => a.platform.localeCompare(b.platform)),
        countedDailyCashMovement, cashVariance, targetRemovedCash, projectedClosingFloat,
        closingFloatVariance };
    });
  }, [cashups, dailySales, endDate, platformIncome, readFailures.cashups, readFailures.dailySales, startDate]);

  const closedCount = rows.filter((row) => row.night).length;
  const salesSummary = useMemo(() => ({
    total: sumStoredMoney(dailySales, (row) => row.total_sales),
    cash: sumStoredMoney(dailySales, (row) => row.cash_sales),
    eftpos: sumStoredMoney(dailySales, (row) => row.eftpos_sales),
  }), [dailySales]);
  const platformSummary = useMemo(() => ({
    gross: sumStoredMoney(platformIncome, (row) => row.gross_income),
    fees: sumStoredMoney(platformIncome, (row) => row.fees),
    net: sumStoredMoney(platformIncome, (row) => {
      const gross = numberOrNull(row.gross_income);
      const fees = numberOrNull(row.fees);
      return gross != null && fees != null ? round2(gross - fees) : null;
    }),
  }), [platformIncome]);

  function exportCsv() {
    if (loading || Object.values(readFailures).some(Boolean)) return;
    const headers = ["business_date", "store_id", "close_status", "morning_counted_float", "morning_warning",
      "night_total_cash_stored", "night_denominations_total", "removed_cash_stored",
      "removed_denominations_total", "counted_daily_cash_movement", "cash_variance",
      "target_removed_cash", "projected_closing_float", "closing_float_variance",
      "cash_sales_stored", "eftpos_sales_stored", "expected_cash_stored", "total_sales_stored",
      "notes", "platform_rows_json", "night_updated_at", "night_validation_warnings"];
    const csvRows = rows.filter((row) => row.dailySales || row.morning || row.night || row.platforms.length > 0)
      .map((row) => {
      const values: Array<[string | number | null | undefined, boolean?]> = [
        [row.businessDate, true], [DEFAULT_STORE_ID, true], [row.night ? "SUBMITTED" : "NOT CLOSED", true],
        [row.morningState.total], [row.morningState.warning, true],
        [row.night?.total_cash], [row.nightState?.denominationTotal],
        [row.night?.removed_cash], [row.nightState?.removedDenominationTotal],
        [row.countedDailyCashMovement], [row.cashVariance], [row.targetRemovedCash],
        [row.projectedClosingFloat], [row.closingFloatVariance], [row.dailySales?.cash_sales],
        [row.dailySales?.eftpos_sales], [row.dailySales?.expected_cash], [row.dailySales?.total_sales],
        [row.dailySales?.notes, true], [JSON.stringify(row.platforms.map((platform) => ({
          platform: platform.platform, gross_income: platform.gross_income,
          fees: platform.fees, entered_by: platform.entered_by,
        }))), true], [row.night?.updated_at, true], [row.nightState?.warnings.join(" | "), true],
      ];
      return values.map(([value, textValue]) => csvCell(value, textValue));
      });
    const content = [headers.map((header) => csvCell(header)), ...csvRows].map((row) => row.join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `daily_close_log_${DEFAULT_STORE_ID}_${startDate}_to_${endDate}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  if (roleLoading) return <div style={{ padding: 24 }}>Checking access…</div>;
  if (!isOwner) return <div style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
    <h1>Owner Daily Log</h1>
    <p style={{ color: WAK_RED, fontWeight: 700 }}>{roleError
      ? "Could not verify owner access because the profile could not be loaded. Please refresh and try again."
      : "Owner access is required."}</p>
    {roleError && <p style={{ color: MUTED }}>{roleError}</p>}
    {actionButton("Back to Home", () => { window.location.href = "/staff/home"; })}
  </div>;

  const cellStyle: React.CSSProperties = {
    padding: "10px 8px", borderBottom: `1px solid ${BORDER}`, borderRight: `1px solid ${BORDER}`,
    verticalAlign: "top", fontSize: 13, color: TEXT,
  };

  return <div style={{ minHeight: "100vh", background: WAK_BG, padding: 20 }}>
    <div style={{ maxWidth: 1600, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end",
        gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
        <div><h1 style={{ margin: 0, color: TEXT }}>Owner Daily Log</h1>
          <div style={{ color: MUTED, marginTop: 6 }}>Read-only Daily Close history for {DEFAULT_STORE_ID}</div></div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {actionButton("Open Staff Daily Entry", () => { window.location.href = "/staff/daily-entry"; }, true)}
          {actionButton("Back to Owner", () => { window.location.href = "/owner"; })}
        </div>
      </div>

      <div style={{ border: "1px solid #BFDBFE", background: "#EFF6FF", color: TEXT,
        borderRadius: 12, padding: "12px 14px", marginBottom: 16, lineHeight: 1.5 }}>
        This page does not edit Daily Close records. New closes are created through Staff Daily Entry.
        Corrections are handled through the controlled Daily Close correction flow.
      </div>

      <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14,
        padding: 14, marginBottom: 16, display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
        <label style={{ color: TEXT, fontWeight: 700 }}><div style={{ fontSize: 12, color: MUTED, marginBottom: 5 }}>From</div>
          <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)}
            disabled={loading} style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${BORDER}` }} /></label>
        <label style={{ color: TEXT, fontWeight: 700 }}><div style={{ fontSize: 12, color: MUTED, marginBottom: 5 }}>To</div>
          <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)}
            disabled={loading} style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${BORDER}` }} /></label>
        {actionButton("Last 7 days", () => { setStartDate(dateDaysAgo(6)); setEndDate(todayDateInputValue()); }, false, loading)}
        {actionButton("Last 30 days", () => { setStartDate(dateDaysAgo(29)); setEndDate(todayDateInputValue()); }, false, loading)}
        {actionButton("This Month", () => { setStartDate(firstDayOfMonth()); setEndDate(todayDateInputValue()); }, false, loading)}
        {actionButton("Refresh", loadAll, false, loading)}
        {actionButton("Export CSV", exportCsv, false, loading || Object.values(readFailures).some(Boolean))}
        {loading && <span style={{ color: MUTED, paddingBottom: 10 }}>Loading…</span>}
      </div>

      {msg && <div style={{ padding: "12px 14px", borderRadius: 12, border: `1px solid ${BORDER}`,
        background: "#fff", color: TEXT, marginBottom: 16 }}>{msg}</div>}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        {statCard("Dates shown", String(rows.length))}
        {statCard("Submitted closes", readFailures.cashups ? "Unavailable" : String(closedCount), WAK_BLUE)}
        {statCard("Stored total sales", summaryMoney(salesSummary.total, readFailures.dailySales))}
        {statCard("Stored cash sales", summaryMoney(salesSummary.cash, readFailures.dailySales))}
        {statCard("Stored EFTPOS sales", summaryMoney(salesSummary.eftpos, readFailures.dailySales))}
        {statCard("Platform gross", summaryMoney(platformSummary.gross, readFailures.platformIncome))}
        {statCard("Stored platform fees", summaryMoney(platformSummary.fees, readFailures.platformIncome))}
        {statCard("Platform net", summaryMoney(platformSummary.net, readFailures.platformIncome))}
        {statCard("Target closing float", money(TARGET_CLOSING_FLOAT))}
      </div>

      <div style={{ background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 14, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1900 }}>
          <thead><tr style={{ background: "#F3F4F6" }}>
            {["Date / Status", "Actual Opening Float", "Night Till Total", "Counted Daily Cash Movement",
              "POS Cash", "Cash Variance", "Target Removed Cash", "Actual Removed Cash",
              "Projected Closing Float", "Closing Float Variance", "EFTPOS",
              "Counted Daily Cash Movement (stored)", "Stored Total Sales", "Platforms (stored fees)",
              "Daily Close Notes", "Entered By", "NIGHT Revision"].map((heading) =>
              <th key={heading} style={{ padding: "10px 8px", borderBottom: `1px solid ${BORDER}`,
                borderRight: `1px solid ${BORDER}`, color: TEXT, fontSize: 12, textAlign: "left",
                verticalAlign: "bottom" }}>{heading}</th>)}</tr></thead>
          <tbody>{rows.map((row) => {
            const ds = row.dailySales;
            const nightTotal = numberOrNull(row.night?.total_cash);
            const actualRemoved = numberOrNull(row.night?.removed_cash);
            const nightDataInvalid = Boolean(row.night && !row.nightState?.nightTotalMatches);
            const removedDataInvalid = Boolean(row.night && !row.nightState?.removedTotalMatches);
            const enteredBy = [
              ds?.entered_by ? `Sales: ${displayName(profileMap.get(ds.entered_by))}` : null,
              row.morning?.entered_by ? `Morning: ${displayName(profileMap.get(row.morning.entered_by))}` : null,
              row.night?.entered_by ? `Night: ${displayName(profileMap.get(row.night.entered_by))}` : null,
            ].filter((value): value is string => Boolean(value));
            return <tr key={row.businessDate}>
              <td style={{ ...cellStyle, minWidth: 180 }}><div style={{ fontWeight: 800 }}>{displayDate(row.businessDate)}</div>
                <div style={{ color: MUTED, marginTop: 3 }}>{dayLabel(row.businessDate)}</div>
                <div style={{ marginTop: 7, fontWeight: 800, color: row.night ? "#15803D" : WAK_RED }}>
                  {readFailures.cashups ? "CLOSE STATUS UNAVAILABLE" : row.night ? "SUBMITTED — READ ONLY" : "NOT CLOSED"}</div>
                {!readFailures.cashups && !row.night && <div style={{ color: MUTED, marginTop: 4 }}>No NIGHT Daily Close exists for this date.</div>}
                {row.nightState?.warnings.map((warning) => <div key={warning} style={{ color: WAK_RED,
                  marginTop: 6, lineHeight: 1.35 }}>{warning}</div>)}</td>
              <td style={{ ...cellStyle, minWidth: 190 }}>{valueCell(row.morningState.total)}
                <div style={{ marginTop: 6, color: row.morningState.status === "malformed" || row.morningState.status === "unavailable" ? WAK_RED : MUTED,
                  lineHeight: 1.35 }}>{row.morningState.warning ?? "Calculated from saved Morning denominations."}</div></td>
              <td style={cellStyle}>{valueCell(nightTotal)}
                {row.nightState?.denominationTotal != null && <div style={{ color: MUTED, marginTop: 5 }}>
                  Denominations: {money(row.nightState.denominationTotal)}</div>}</td>
              <td style={cellStyle}>{derivedCell(row.countedDailyCashMovement,
                nightDataInvalid || row.morningState.status === "malformed")}</td>
              <td style={cellStyle}>{readFailures.dailySales ? "Sales read unavailable" : valueCell(numberOrNull(ds?.cash_sales))}</td>
              <td style={cellStyle}>{derivedCell(row.cashVariance,
                nightDataInvalid || row.morningState.status === "malformed", true)}</td>
              <td style={cellStyle}>{derivedCell(row.targetRemovedCash, nightDataInvalid)}</td>
              <td style={cellStyle}>{valueCell(actualRemoved)}
                {row.nightState?.removedDenominationTotal != null && <div style={{ color: MUTED, marginTop: 5 }}>
                  Denominations: {money(row.nightState.removedDenominationTotal)}</div>}</td>
              <td style={cellStyle}>{derivedCell(row.projectedClosingFloat,
                nightDataInvalid || removedDataInvalid)}</td>
              <td style={cellStyle}>{derivedCell(row.closingFloatVariance,
                nightDataInvalid || removedDataInvalid, true)}</td>
              <td style={cellStyle}>{readFailures.dailySales ? "Sales read unavailable" : valueCell(numberOrNull(ds?.eftpos_sales))}</td>
              <td style={cellStyle}>{readFailures.dailySales ? "Sales read unavailable" : valueCell(numberOrNull(ds?.expected_cash))}
                <div style={{ color: MUTED, marginTop: 5, lineHeight: 1.3 }}>
                  Compatibility field; pre-v2 rows may use legacy semantics.</div></td>
              <td style={cellStyle}>{readFailures.dailySales ? "Sales read unavailable" : valueCell(numberOrNull(ds?.total_sales))}</td>
              <td style={{ ...cellStyle, minWidth: 230 }}>{readFailures.platformIncome
                ? <span style={{ color: WAK_RED }}>Platform read unavailable.</span>
                : row.platforms.length === 0
                ? <span style={{ color: MUTED }}>No saved platform rows.</span>
                : <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{row.platforms.map((platform, index) => {
                  const gross = numberOrNull(platform.gross_income);
                  const fees = numberOrNull(platform.fees);
                  const net = gross != null && fees != null ? round2(gross - fees) : null;
                  return <div key={`${platform.platform}-${index}`}><div style={{ fontWeight: 800 }}>{platform.platform}</div>
                    <div>Gross: {money(gross)}</div><div>Stored fees: {money(fees)}</div><div>Net: {money(net)}</div></div>;
                })}</div>}</td>
              <td style={{ ...cellStyle, minWidth: 220, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {readFailures.dailySales ? "Sales read unavailable" : ds?.notes ?? "—"}</td>
              <td style={{ ...cellStyle, minWidth: 160, whiteSpace: "pre-line" }}>
                {enteredBy.length > 0 ? enteredBy.join("\n") : "—"}</td>
              <td style={{ ...cellStyle, minWidth: 185 }}>{displayTimestamp(row.night?.updated_at)}
                {row.night && <div style={{ color: MUTED, marginTop: 5 }}>Created: {displayTimestamp(row.night.created_at)}</div>}</td>
            </tr>;
          })}</tbody>
        </table></div>
      </div>
    </div>
  </div>;
}
