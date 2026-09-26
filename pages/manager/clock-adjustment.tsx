import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

type RangeMode = "DAY" | "WEEK" | "CUSTOM";
type ReviewFilter = "ALL" | "NEEDS_REVIEW";
type ReviewReason = "CONFIRMED_ACTUAL_WORK" | "CORRECTED_TIME" | "OTHER";
type Profile = { id: string; full_name: string | null; preferred_name: string | null; is_active: boolean | null };
type WorkPeriod = { id: number; status: string; source_type: string; current_version_id: number; matched_shift_id: number | null; staff_id: string; time_clock_id: number | null; payroll_period_id: number };
type Version = { id: number; version_number: number; disposition: string; matched_shift_id: number | null; actual_start_at: string | null; actual_end_at: string | null; payable_start_at: string | null; payable_end_at: string | null; reason_code: string | null; reason_note: string | null; change_source: string; created_by: string | null; created_at: string };
type RawClock = { id: number; clock_in_at: string | null; clock_out_at: string | null; device_tag: string | null };
type Shift = { id: number; shift_start: string; shift_end: string; shift_status: string | null; parent_shift_id: number | null; covered_by_staff_id: string | null; cover_note: string | null };
type Anomaly = { id: number; work_period_id: number; anomaly_type: string; severity: string; details: Record<string, unknown> | null };
type RecordRow = { workPeriod: WorkPeriod; profile: Profile | null; rawClock: RawClock | null; currentVersion: Version | null; matchedShift: Shift | null; openAnomalies: Anomaly[]; localDate: string | null };
type ListResponse = { ok: true; records: RecordRow[]; staffOptions: Profile[] } | { ok: false; reason: string };
type ReviewResponse = { ok: true; result: Record<string, unknown> } | { ok: false; reason: string };
type Draft = { actualStart: string; actualEnd: string; payableStart: string; payableEnd: string; reason: ReviewReason; note: string };

const MELBOURNE = "Australia/Melbourne";
const BORDER = "#E5E7EB";
const BLUE = "#1E5A9E";
const RED = "#B42318";
const TEXT = "#111827";
const MUTED = "#667085";

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function localDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", { timeZone: MELBOURNE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function thursdayFor(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - 4 + 7) % 7));
  return date.toISOString().slice(0, 10);
}
function displayName(profile: Profile | null) {
  return profile?.preferred_name?.trim() || profile?.full_name?.trim() || "Unknown employee";
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", weekday: "long", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T00:00:00Z`));
}
function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-AU", { timeZone: MELBOURNE, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
function dateTimeInput(value: string | null | undefined) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: MELBOURNE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
function toIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const desired = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: MELBOURNE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(guess));
    const part = (type: string) => +(parts.find((item) => item.type === type)?.value ?? 0);
    guess += desired - Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  }
  return new Date(guess).toISOString();
}
function hours(start: string | null | undefined, end: string | null | undefined) {
  if (!start || !end) return null;
  const value = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
  return value >= 0 ? value : null;
}
function needsReview(row: RecordRow) { return row.workPeriod.status === "NEEDS_REVIEW" || row.openAnomalies.length > 0; }
function openClock(row: RecordRow) { return row.workPeriod.source_type === "CLOCK" && !!row.rawClock && !row.rawClock.clock_out_at; }
function title(value: string) { return value.toLowerCase().split("_").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "); }
function button(primary = false) { return { border: `1px solid ${primary ? BLUE : "#D0D5DD"}`, borderRadius: 9, padding: "9px 13px", background: primary ? BLUE : "#fff", color: primary ? "#fff" : TEXT, fontWeight: 700, cursor: "pointer" } as const; }
function field() { return { width: "100%", boxSizing: "border-box" as const, border: "1px solid #D0D5DD", borderRadius: 8, padding: "9px 10px", background: "#fff", color: TEXT }; }

export default function ClockAdjustmentPage() {
  const router = useRouter();
  const today = localDate();
  const [rangeMode, setRangeMode] = useState<RangeMode>("DAY");
  const [day, setDay] = useState(today);
  const [weekStart, setWeekStart] = useState(thursdayFor(today));
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [staffId, setStaffId] = useState("ALL");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("NEEDS_REVIEW");
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [staffOptions, setStaffOptions] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const loadEpoch = useRef(0);

  useEffect(() => {
    if (!router.isReady) return;
    const value = Array.isArray(router.query.date) ? router.query.date[0] : router.query.date;
    if (validDate(value)) { setRangeMode("DAY"); setDay(value); }
  }, [router.isReady, router.query.date]);

  const range = useMemo(() => rangeMode === "DAY" ? { from: day, to: day } : rangeMode === "WEEK" ? { from: weekStart, to: addDays(weekStart, 6) } : { from: customFrom, to: customTo }, [customFrom, customTo, day, rangeMode, weekStart]);

  const token = useCallback(async () => {
    const { data, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw new Error("Could not verify your session. Please try again.");
    if (!data.session?.access_token) { void router.replace("/"); return null; }
    return data.session.access_token;
  }, [router]);

  const load = useCallback(async () => {
    if (!router.isReady || !validDate(range.from) || !validDate(range.to) || range.from > range.to) return null;
    const requestId = ++loadEpoch.current;
    setLoading(true); setError("");
    try {
      const accessToken = await token();
      if (!accessToken) return null;
      const params = new URLSearchParams({ from: range.from, to: range.to });
      if (staffId !== "ALL") params.set("staff_id", staffId);
      const response = await fetch(`/api/attendance/review-list?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const payload = (await response.json()) as ListResponse;
      if (response.status === 401) { void router.replace("/"); return null; }
      if (!response.ok || !payload.ok) throw new Error(payload.ok ? "Could not load attendance." : payload.reason);
      if (requestId !== loadEpoch.current) return null;
      setRecords(payload.records); setStaffOptions(payload.staffOptions);
      return payload.records;
    } catch (caught) {
      if (requestId === loadEpoch.current) setError(caught instanceof Error ? caught.message : "Could not load attendance. Please retry.");
      return null;
    } finally { if (requestId === loadEpoch.current) setLoading(false); }
  }, [range.from, range.to, router, staffId, token]);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => records.filter((row) => reviewFilter === "ALL" || needsReview(row)), [records, reviewFilter]);
  const grouped = useMemo(() => {
    const result = new Map<string, RecordRow[]>();
    for (const row of shown) result.set(row.localDate ?? "Unknown date", [...(result.get(row.localDate ?? "Unknown date") ?? []), row]);
    return Array.from(result.entries());
  }, [shown]);
  const reviewCount = records.filter(needsReview).length;
  const blockingCount = records.filter((row) => row.openAnomalies.some((item) => item.severity === "BLOCKING")).length;
  const warningCount = records.filter((row) => row.openAnomalies.some((item) => item.severity === "WARNING")).length;

  function edit(row: RecordRow) {
    if (!row.currentVersion || openClock(row)) return;
    const actualStart = row.currentVersion.actual_start_at ?? row.rawClock?.clock_in_at;
    const actualEnd = row.currentVersion.actual_end_at ?? row.rawClock?.clock_out_at;
    setEditingId(row.workPeriod.id);
    setDraft({ actualStart: dateTimeInput(actualStart), actualEnd: dateTimeInput(actualEnd), payableStart: dateTimeInput(row.currentVersion.payable_start_at ?? actualStart), payableEnd: dateTimeInput(row.currentVersion.payable_end_at ?? actualEnd), reason: "CONFIRMED_ACTUAL_WORK", note: "" });
    setError("");
  }

  async function save(row: RecordRow, next: boolean) {
    if (!draft || !row.currentVersion || openClock(row)) return;
    const actualStart = toIso(draft.actualStart); const actualEnd = toIso(draft.actualEnd);
    const payableStart = toIso(draft.payableStart); const payableEnd = toIso(draft.payableEnd);
    if (!actualStart || !actualEnd || !payableStart || !payableEnd) return setError("Enter all actual and payable times before saving.");
    if (draft.reason === "OTHER" && !draft.note.trim()) return setError("Add a note when the reason is Other.");
    setSaving(true); setError(""); setMessage("");
    try {
      const accessToken = await token(); if (!accessToken) return;
      const response = await fetch("/api/attendance/review", { method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ work_period_id: row.workPeriod.id, expected_version_id: row.currentVersion.id, matched_shift_id: row.currentVersion.matched_shift_id, actual_start_at: actualStart, actual_end_at: actualEnd, payable_start_at: payableStart, payable_end_at: payableEnd, reason_code: draft.reason, reason_note: draft.note || null }) });
      const payload = (await response.json()) as ReviewResponse;
      if (response.status === 401) { void router.replace("/"); return; }
      if (!response.ok || !payload.ok) {
        const reason = payload.ok ? "SERVER_ERROR" : payload.reason;
        if (reason === "ATTENDANCE_REVIEW_CONFLICT") { setError("This attendance record changed while you were reviewing it. The latest version has been reloaded."); setEditingId(null); setDraft(null); await load(); return; }
        if (reason === "ATTENDANCE_REVIEW_PAYABLE_OVERLAP") return setError("These payable times overlap another work period for this employee. Adjust the times and try again.");
        throw new Error("The attendance review could not be saved. Check the values and try again.");
      }
      const index = shown.findIndex((item) => item.workPeriod.id === row.workPeriod.id);
      setEditingId(null); setDraft(null);
      const fresh = await load(); setMessage("Attendance review saved.");
      if (next && fresh) {
        const queue = fresh.filter(needsReview);
        const following = queue.find((item) => shown.findIndex((old) => old.workPeriod.id === item.workPeriod.id) > index) ?? queue[0];
        if (following) edit(following);
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save attendance review."); }
    finally { setSaving(false); }
  }

  return <main style={{ minHeight: "100vh", background: "#F5F7FA", color: TEXT, padding: "24px 16px 56px" }}><div style={{ maxWidth: 1180, margin: "0 auto" }}>
    <header style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 20 }}><div><div style={{ color: BLUE, fontWeight: 800, fontSize: 13 }}>WORKFORCE</div><h1 style={{ margin: "4px 0", fontSize: 30 }}>Attendance Review</h1><div style={{ color: MUTED }}>Review clock records and confirm payable time.</div></div><button type="button" onClick={() => void load()} disabled={loading} style={button()}>{loading ? "Refreshing…" : "Refresh"}</button></header>

    <section style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 14, padding: 16, marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>{(["DAY", "WEEK", "CUSTOM"] as RangeMode[]).map((mode) => <button key={mode} type="button" onClick={() => setRangeMode(mode)} style={button(rangeMode === mode)}>{mode === "DAY" ? "Day" : mode === "WEEK" ? "Week" : "Custom"}</button>)}</div>
      {rangeMode === "DAY" && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><button type="button" onClick={() => setDay(addDays(day, -1))} style={button()}>Previous</button><input type="date" value={day} onChange={(event) => setDay(event.target.value)} style={{ ...field(), width: 180 }} /><button type="button" onClick={() => setDay(today)} style={button()}>Today</button><button type="button" onClick={() => setDay(addDays(day, 1))} style={button()}>Next</button></div>}
      {rangeMode === "WEEK" && <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}><button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))} style={button()}>Previous week</button><strong>{formatDate(weekStart)} – {formatDate(addDays(weekStart, 6))}</strong><button type="button" onClick={() => setWeekStart(thursdayFor(today))} style={button()}>This week</button>{addDays(weekStart, 7) <= thursdayFor(today) && <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))} style={button()}>Next week</button>}</div>}
      {rangeMode === "CUSTOM" && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}><label>From<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} style={field()} /></label><label>To<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} style={field()} /></label></div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginTop: 14 }}><label><span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 5 }}>Employee</span><select value={staffId} onChange={(event) => setStaffId(event.target.value)} style={field()}><option value="ALL">All employees</option>{staffOptions.map((person) => <option key={person.id} value={person.id}>{displayName(person)}{person.is_active === true ? "" : " (INACTIVE)"}</option>)}</select></label><label><span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 5 }}>View</span><select value={reviewFilter} onChange={(event) => setReviewFilter(event.target.value as ReviewFilter)} style={field()}><option value="NEEDS_REVIEW">Needs review</option><option value="ALL">All attendance</option></select></label></div>
    </section>

    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}><div style={{ background: "#EEF4FF", color: BLUE, borderRadius: 10, padding: "10px 14px", fontWeight: 800 }}>Total: {records.length}</div><div style={{ background: "#FFF4E5", color: "#8A4B08", borderRadius: 10, padding: "10px 14px", fontWeight: 800 }}>Needs review: {reviewCount}</div><div style={{ background: "#FEF3F2", color: RED, borderRadius: 10, padding: "10px 14px", fontWeight: 800 }}>Blocking: {blockingCount}</div><div style={{ background: "#FFFAEB", color: "#8A6B22", borderRadius: 10, padding: "10px 14px", fontWeight: 800 }}>Warnings: {warningCount}</div></div>
    {error && <div role="alert" style={{ background: "#FEF3F2", color: RED, border: "1px solid #FECDCA", borderRadius: 10, padding: 12, marginBottom: 14 }}>{error}</div>}
    {message && <div role="status" style={{ background: "#ECFDF3", color: "#027A48", border: "1px solid #ABEFC6", borderRadius: 10, padding: 12, marginBottom: 14 }}>{message}</div>}
    {loading && <div style={{ padding: 24, color: MUTED }}>Loading canonical attendance…</div>}
    {!loading && !error && grouped.length === 0 && <div style={{ background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 14, padding: 24, color: MUTED }}>No attendance records match this view.</div>}

    {!loading && grouped.map(([date, rows]) => <section key={date} style={{ marginBottom: 22 }}><h2 style={{ margin: "0 0 10px", fontSize: 20 }}>{validDate(date) ? formatDate(date) : date}</h2><div style={{ display: "grid", gap: 12 }}>{rows.map((row) => {
      const version = row.currentVersion; const isEditing = editingId === row.workPeriod.id && draft; const payableHours = hours(version?.payable_start_at, version?.payable_end_at); const isOpen = openClock(row);
      return <article key={row.workPeriod.id} style={{ background: "#fff", border: `1px solid ${needsReview(row) ? "#F5C26B" : BORDER}`, borderRadius: 14, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}><div><div style={{ fontWeight: 850, fontSize: 18 }}>{displayName(row.profile)}</div><div style={{ color: MUTED, marginTop: 4 }}>Roster: {row.matchedShift ? `${formatTime(row.matchedShift.shift_start)} – ${formatTime(row.matchedShift.shift_end)}` : "Unrostered"}</div><div style={{ color: MUTED, marginTop: 4 }}>Raw clock — never edited: {isOpen ? `${formatTime(row.rawClock?.clock_in_at)} – Clocked in — no clock out yet` : `${formatTime(row.rawClock?.clock_in_at)} – ${formatTime(row.rawClock?.clock_out_at)}`}</div><div style={{ color: MUTED, marginTop: 4 }}>Current actual: {formatTime(version?.actual_start_at)} – {formatTime(version?.actual_end_at)} · Payable: {formatTime(version?.payable_start_at)} – {formatTime(version?.payable_end_at)}</div><div style={{ color: MUTED, marginTop: 4, fontSize: 13 }}>{payableHours === null ? "No payable duration" : `${payableHours.toFixed(2)} hours`} · {version ? `Version ${version.version_number} · ${title(version.change_source)}` : "No canonical version"}</div></div><div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}><span style={{ padding: "5px 9px", borderRadius: 999, fontSize: 12, fontWeight: 800, background: needsReview(row) ? "#FFF4E5" : "#ECFDF3", color: needsReview(row) ? "#8A4B08" : "#027A48" }}>{needsReview(row) ? "NEEDS REVIEW" : "READY"}</span><button type="button" disabled={isOpen || !version} onClick={() => edit(row)} style={{ ...button(true), opacity: isOpen || !version ? 0.5 : 1 }}>Review</button></div></div>
        {isOpen && <div style={{ color: RED, marginTop: 10, fontWeight: 700 }}>Wait for clock out, or use a later manual correction workflow.</div>}
        {!!row.openAnomalies.length && <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 12 }}>{row.openAnomalies.map((anomaly) => <span key={anomaly.id} title={JSON.stringify(anomaly.details ?? {})} style={{ background: anomaly.severity === "BLOCKING" ? "#FEF3F2" : "#FFF4E5", color: anomaly.severity === "BLOCKING" ? RED : "#8A4B08", borderRadius: 999, padding: "5px 9px", fontSize: 12, fontWeight: 750 }}>{title(anomaly.anomaly_type)} · {title(anomaly.severity)}</span>)}</div>}
        {isEditing && <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 16, paddingTop: 16 }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}><label>Actual start<input type="datetime-local" value={draft.actualStart} onChange={(event) => setDraft({ ...draft, actualStart: event.target.value })} style={field()} /></label><label>Actual end<input type="datetime-local" value={draft.actualEnd} onChange={(event) => setDraft({ ...draft, actualEnd: event.target.value })} style={field()} /></label><label>Payable start<input type="datetime-local" value={draft.payableStart} onChange={(event) => setDraft({ ...draft, payableStart: event.target.value })} style={field()} /></label><label>Payable end<input type="datetime-local" value={draft.payableEnd} onChange={(event) => setDraft({ ...draft, payableEnd: event.target.value })} style={field()} /></label><label>Reason<select value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value as ReviewReason })} style={field()}><option value="CONFIRMED_ACTUAL_WORK">Confirmed actual work</option><option value="CORRECTED_TIME">Corrected time</option><option value="OTHER">Other</option></select></label><label>Note<input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder={draft.reason === "OTHER" ? "Required" : "Optional"} style={field()} /></label></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}><button type="button" disabled={saving} onClick={() => void save(row, false)} style={button(true)}>Save</button><button type="button" disabled={saving} onClick={() => void save(row, true)} style={button()}>Save &amp; next</button><button type="button" disabled={saving} onClick={() => { setEditingId(null); setDraft(null); }} style={button()}>Cancel</button></div></div>}
      </article>;
    })}</div></section>)}
  </div></main>;
}
