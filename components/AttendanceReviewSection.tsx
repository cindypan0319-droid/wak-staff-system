import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";

type ReviewFilter = "ALL" | "NEEDS_REVIEW";
type ReviewReason = "CONFIRMED_ACTUAL_WORK" | "CORRECTED_TIME" | "OTHER";
type Profile = { id: string; full_name: string | null; preferred_name: string | null; is_active: boolean | null };
type WorkPeriod = { id: number; status: string; source_type: string; current_version_id: number; matched_shift_id: number | null; staff_id: string };
type Version = { id: number; version_number: number; disposition: string; matched_shift_id: number | null; actual_start_at: string | null; actual_end_at: string | null; payable_start_at: string | null; payable_end_at: string | null; reason_code: string | null; reason_note: string | null; change_source: string; created_at: string };
type RawClock = { id: number; clock_in_at: string | null; clock_out_at: string | null; device_tag: string | null };
type Shift = { id: number; shift_start: string; shift_end: string; shift_status: string | null; parent_shift_id: number | null; covered_by_staff_id: string | null; cover_note: string | null };
type Anomaly = { id: number; anomaly_type: string; severity: string; details: Record<string, unknown> | null };
type AttendanceRecord = { workPeriod: WorkPeriod; profile: Profile | null; rawClock: RawClock | null; currentVersion: Version | null; matchedShift: Shift | null; openAnomalies: Anomaly[]; localDate: string | null };
type ListResponse = { ok: true; records: AttendanceRecord[]; staffOptions: Profile[] } | { ok: false; reason: string };
type ReviewResponse = { ok: true; result: Record<string, unknown> } | { ok: false; reason: string };
type Draft = { actualStart: string; actualEnd: string; payableStart: string; payableEnd: string; basePayableStart: string; basePayableEnd: string; reason: ReviewReason; note: string; adjustPayable: boolean };
type AttendanceReviewSectionProps = { fromDate: string; toDate: string; staffId: string };

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

function name(profile: Profile | null) {
  return profile?.preferred_name?.trim() || profile?.full_name?.trim() || "Unknown employee";
}

function time(value: string | null | undefined, seconds = false) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE,
    hour: "2-digit",
    minute: "2-digit",
    second: seconds ? "2-digit" : undefined,
    hour12: false,
  }).format(new Date(value));
}

function dateHeading(value: string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function inputDateTime(value: string | null | undefined) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MELBOURNE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

function toIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const desired = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +(match[6] ?? 0));
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: MELBOURNE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const part = (type: string) => +(parts.find((item) => item.type === type)?.value ?? 0);
    guess += desired - Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  }
  return new Date(guess).toISOString();
}

function sameInstant(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return left === right;
  return new Date(left).getTime() === new Date(right).getTime();
}

function suggestedPayable(record: AttendanceRecord, actualStartValue: string, actualEndValue: string, baseStart: string, baseEnd: string) {
  const actualStart = toIso(actualStartValue);
  const actualEnd = toIso(actualEndValue);
  if (!actualStart || !actualEnd) return { payableStart: baseStart, payableEnd: baseEnd };
  if (!record.matchedShift) {
    return { payableStart: inputDateTime(actualStart), payableEnd: inputDateTime(actualEnd) };
  }

  const actualStartMs = new Date(actualStart).getTime();
  const actualEndMs = new Date(actualEnd).getTime();
  const rosterStartMs = new Date(record.matchedShift.shift_start).getTime();
  const rosterEndMs = new Date(record.matchedShift.shift_end).getTime();
  const earlyStartSeconds = (rosterStartMs - actualStartMs) / 1000;
  const lateFinishSeconds = (actualEndMs - rosterEndMs) / 1000;

  const payableStart = actualStartMs >= rosterStartMs
    ? inputDateTime(actualStart)
    : earlyStartSeconds <= 300
      ? inputDateTime(record.matchedShift.shift_start)
      : baseStart;
  const payableEnd = actualEndMs <= rosterEndMs
    ? inputDateTime(actualEnd)
    : lateFinishSeconds <= 300
      ? inputDateTime(record.matchedShift.shift_end)
      : baseEnd;
  return { payableStart, payableEnd };
}

function needsReview(record: AttendanceRecord) {
  return record.workPeriod.status === "NEEDS_REVIEW" || record.openAnomalies.length > 0;
}

function openClock(record: AttendanceRecord) {
  return record.workPeriod.source_type === "CLOCK" && !!record.rawClock && !record.rawClock.clock_out_at;
}

function title(value: string) {
  return value.toLowerCase().split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function fieldStyle() {
  return { width: "100%", boxSizing: "border-box" as const, padding: "8px 9px", border: "1px solid #D0D5DD", borderRadius: 8, background: "#fff", color: TEXT };
}

function buttonStyle(primary = false) {
  return { padding: "8px 11px", border: `1px solid ${primary ? BLUE : "#D0D5DD"}`, borderRadius: 8, background: primary ? BLUE : "#fff", color: primary ? "#fff" : TEXT, fontWeight: 700, cursor: "pointer" } as const;
}

export default function AttendanceReviewSection({ fromDate, toDate, staffId }: AttendanceReviewSectionProps) {
  const router = useRouter();
  const [filter, setFilter] = useState<ReviewFilter>("NEEDS_REVIEW");
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const requestEpoch = useRef(0);

  const accessToken = useCallback(async () => {
    const { data, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw new Error("Could not verify your session. Please try again.");
    if (!data.session?.access_token) {
      void router.replace("/");
      return null;
    }
    return data.session.access_token;
  }, [router]);

  const load = useCallback(async () => {
    if (!router.isReady || !validDate(fromDate) || !validDate(toDate) || fromDate > toDate) return null;
    const requestId = ++requestEpoch.current;
    setLoading(true);
    setError("");
    try {
      const token = await accessToken();
      if (!token) return null;
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      if (staffId !== "ALL") params.set("staff_id", staffId);
      const response = await fetch(`/api/attendance/review-list?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const payload = (await response.json()) as ListResponse;
      if (response.status === 401) {
        void router.replace("/");
        return null;
      }
      if (!response.ok || !payload.ok) throw new Error(payload.ok ? "Could not load attendance." : payload.reason);
      if (requestId !== requestEpoch.current) return null;
      setRecords(payload.records);
      return payload.records;
    } catch (caught) {
      if (requestId === requestEpoch.current) setError(caught instanceof Error ? caught.message : "Could not load attendance.");
      return null;
    } finally {
      if (requestId === requestEpoch.current) setLoading(false);
    }
  }, [accessToken, fromDate, toDate, router, staffId]);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => records.filter((record) => filter === "ALL" || needsReview(record)), [filter, records]);
  const groups = useMemo(() => {
    const grouped = new Map<string, AttendanceRecord[]>();
    for (const record of shown) {
      const key = record.localDate ?? "Unknown date";
      grouped.set(key, [...(grouped.get(key) ?? []), record]);
    }
    return Array.from(grouped.entries());
  }, [shown]);

  function beginReview(record: AttendanceRecord) {
    if (!record.currentVersion || openClock(record)) return;
    const actualStart = record.currentVersion.actual_start_at ?? record.rawClock?.clock_in_at;
    const actualEnd = record.currentVersion.actual_end_at ?? record.rawClock?.clock_out_at;
    setEditingId(record.workPeriod.id);
    const payableStart = inputDateTime(record.currentVersion.payable_start_at ?? actualStart);
    const payableEnd = inputDateTime(record.currentVersion.payable_end_at ?? actualEnd);
    setDraft({
      actualStart: inputDateTime(actualStart),
      actualEnd: inputDateTime(actualEnd),
      payableStart,
      payableEnd,
      basePayableStart: payableStart,
      basePayableEnd: payableEnd,
      reason: "CONFIRMED_ACTUAL_WORK",
      note: "",
      adjustPayable: false,
    });
    setError("");
  }

  function updateActual(record: AttendanceRecord, side: "start" | "end", value: string) {
    setDraft((current) => {
      if (!current) return current;
      const next = side === "start" ? { ...current, actualStart: value } : { ...current, actualEnd: value };
      if (next.adjustPayable) return next;
      return {
        ...next,
        ...suggestedPayable(record, next.actualStart, next.actualEnd, next.basePayableStart, next.basePayableEnd),
      };
    });
  }

  function cancelPayableAdjustment(record: AttendanceRecord) {
    setDraft((current) => current ? {
      ...current,
      ...suggestedPayable(record, current.actualStart, current.actualEnd, current.basePayableStart, current.basePayableEnd),
      adjustPayable: false,
    } : current);
  }

  async function save(record: AttendanceRecord, saveAndNext: boolean) {
    if (!draft || !record.currentVersion || openClock(record)) return;
    const actualStart = toIso(draft.actualStart);
    const actualEnd = toIso(draft.actualEnd);
    const payableStart = toIso(draft.payableStart);
    const payableEnd = toIso(draft.payableEnd);
    if (!actualStart || !actualEnd || !payableStart || !payableEnd) return setError("Enter complete actual and payable times.");
    if (draft.reason === "OTHER" && !draft.note.trim()) return setError("Add a note when the reason is Other.");
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const token = await accessToken();
      if (!token) return;
      const response = await fetch("/api/attendance/review", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          work_period_id: record.workPeriod.id,
          expected_version_id: record.currentVersion.id,
          matched_shift_id: record.currentVersion.matched_shift_id,
          actual_start_at: actualStart,
          actual_end_at: actualEnd,
          payable_start_at: payableStart,
          payable_end_at: payableEnd,
          reason_code: draft.reason,
          reason_note: draft.note || null,
        }),
      });
      const payload = (await response.json()) as ReviewResponse;
      if (response.status === 401) {
        void router.replace("/");
        return;
      }
      if (!response.ok || !payload.ok) {
        const reason = payload.ok ? "SERVER_ERROR" : payload.reason;
        if (reason === "ATTENDANCE_REVIEW_CONFLICT") {
          setError("This record changed since you opened it. It has been refreshed.");
          setEditingId(null);
          setDraft(null);
          await load();
          return;
        }
        if (reason === "ATTENDANCE_REVIEW_PAYABLE_OVERLAP") return setError("Payable time overlaps another confirmed work period.");
        throw new Error("The attendance review could not be saved. Check the values and try again.");
      }
      const oldIndex = shown.findIndex((item) => item.workPeriod.id === record.workPeriod.id);
      setEditingId(null);
      setDraft(null);
      const refreshed = await load();
      setMessage("Attendance review saved.");
      if (saveAndNext && refreshed) {
        const queue = refreshed.filter(needsReview);
        const next = queue.find((item) => shown.findIndex((old) => old.workPeriod.id === item.workPeriod.id) > oldIndex) ?? queue[0];
        if (next) beginReview(next);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save attendance review.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ border: `1px solid ${BORDER}`, borderRadius: 18, background: "#fff", padding: 18, marginBottom: 16, boxShadow: "0 8px 24px rgba(0,0,0,0.05)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div><h2 style={{ margin: 0, fontSize: 22 }}>Attendance Review <span style={{ fontSize: 11, color: BLUE, verticalAlign: "middle" }}>TEST</span></h2><div style={{ marginTop: 6, color: MUTED, fontSize: 13 }}>Review canonical clock records and confirm payable time. Raw clocks are never edited.</div></div>
        <button type="button" onClick={() => void load()} disabled={loading} style={buttonStyle()}>{loading ? "Refreshing…" : "Refresh review"}</button>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "end", marginTop: 14 }}>
        <div style={{ color: MUTED, fontSize: 13 }}>
          Showing <b style={{ color: TEXT }}>{fromDate}</b> to <b style={{ color: TEXT }}>{toDate}</b>
        </div>
        <label style={{ minWidth: 210 }}><span style={{ display: "block", fontSize: 12, color: MUTED }}>Review filter</span><select value={filter} onChange={(event) => setFilter(event.target.value as ReviewFilter)} style={fieldStyle()}><option value="NEEDS_REVIEW">Needs Review</option><option value="ALL">All</option></select></label>
      </div>

      {error && <div role="alert" style={{ marginTop: 12, color: RED }}>{error}</div>}
      {message && <div role="status" style={{ marginTop: 12, color: "#027A48" }}>{message}</div>}
      {loading && <div style={{ padding: "18px 0", color: MUTED }}>Loading attendance review…</div>}
      {!loading && !error && groups.length === 0 && <div style={{ padding: "18px 0", color: MUTED }}>No canonical attendance records match this view.</div>}

      {!loading && groups.map(([date, dateRecords]) => <div key={date} style={{ marginTop: 18 }}><h3 style={{ margin: "0 0 9px" }}>{validDate(date) ? dateHeading(date) : date}</h3><div style={{ display: "grid", gap: 10 }}>{dateRecords.map((record) => {
        const version = record.currentVersion;
        const isOpen = openClock(record);
        const editing = editingId === record.workPeriod.id && draft;
        const actualDiffers = !sameInstant(version?.actual_start_at, record.rawClock?.clock_in_at) || !sameInstant(version?.actual_end_at, record.rawClock?.clock_out_at);
        const duration = version?.payable_start_at && version.payable_end_at ? (new Date(version.payable_end_at).getTime() - new Date(version.payable_start_at).getTime()) / 3_600_000 : null;
        const signal = record.openAnomalies.some((item) => item.severity === "BLOCKING") ? RED : record.openAnomalies.length ? "#D97706" : "#12B76A";
        return <article key={record.workPeriod.id} style={{ border: `1px solid ${BORDER}`, borderLeft: `4px solid ${signal}`, borderRadius: 11, padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><div><div style={{ fontWeight: 850, fontSize: 17 }}>{name(record.profile)}</div><div style={{ display: "grid", gridTemplateColumns: "58px auto", gap: "4px 9px", marginTop: 9, color: TEXT }}><span style={{ color: MUTED }}>Roster</span><span>{record.matchedShift ? `${time(record.matchedShift.shift_start)} – ${time(record.matchedShift.shift_end)}` : "Unrostered"}</span><span style={{ color: MUTED }}>Clock</span><span>{isOpen ? `${time(record.rawClock?.clock_in_at)} – Clocked in` : `${time(record.rawClock?.clock_in_at)} – ${time(record.rawClock?.clock_out_at)}`}</span><span style={{ color: MUTED }}>Pay</span><span>{time(version?.payable_start_at)} – {time(version?.payable_end_at)}</span>{(actualDiffers || editing) && <><span style={{ color: MUTED }}>Actual</span><span>{time(version?.actual_start_at, true)} – {time(version?.actual_end_at, true)}</span></>}</div></div><div style={{ textAlign: "right" }}><div style={{ fontSize: 18, fontWeight: 850 }}>{duration === null || duration < 0 ? "—" : `${duration.toFixed(2)}h`}</div><button type="button" onClick={() => beginReview(record)} disabled={isOpen || !version} style={{ ...buttonStyle(true), marginTop: 9, opacity: isOpen || !version ? 0.45 : 1 }}>Review</button></div></div>
          {!!record.openAnomalies.length && <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 10 }}>{record.openAnomalies.map((anomaly) => <span key={anomaly.id} style={{ color: anomaly.severity === "BLOCKING" ? RED : "#8A4B08", fontSize: 12, fontWeight: 750 }}>{title(anomaly.anomaly_type)} · {title(anomaly.severity)}</span>)}</div>}
          {isOpen && <div style={{ marginTop: 9, color: MUTED, fontSize: 13 }}>Wait for clock out, or use a later manual-work workflow.</div>}
          <details style={{ marginTop: 9, color: MUTED, fontSize: 12 }}><summary>Details</summary><div style={{ marginTop: 5 }}>Status {record.workPeriod.status} · Version {version?.version_number ?? "—"} · Source {version ? title(version.change_source) : "—"} · Work period {record.workPeriod.id}</div></details>
          {editing && <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${BORDER}` }}><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}><label>Actual start<input type="datetime-local" step={1} value={draft.actualStart} onChange={(event) => updateActual(record, "start", event.target.value)} style={fieldStyle()} /></label><label>Actual end<input type="datetime-local" step={1} value={draft.actualEnd} onChange={(event) => updateActual(record, "end", event.target.value)} style={fieldStyle()} /></label></div><div style={{ marginTop: 11, padding: 11, borderRadius: 9, background: "#F8FAFC" }}><div style={{ color: MUTED, fontSize: 12 }}>{draft.adjustPayable ? "Manual payable" : "Pay suggestion"}</div><strong>{time(toIso(draft.payableStart), true)} – {time(toIso(draft.payableEnd), true)}</strong><div><button type="button" onClick={() => draft.adjustPayable ? cancelPayableAdjustment(record) : setDraft({ ...draft, adjustPayable: true })} style={{ ...buttonStyle(), marginTop: 8 }}>{draft.adjustPayable ? "Cancel payable adjustment" : "Adjust payable time"}</button></div></div>{draft.adjustPayable && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 10 }}><label>Payable start<input type="datetime-local" step={1} value={draft.payableStart} onChange={(event) => setDraft({ ...draft, payableStart: event.target.value })} style={fieldStyle()} /></label><label>Payable end<input type="datetime-local" step={1} value={draft.payableEnd} onChange={(event) => setDraft({ ...draft, payableEnd: event.target.value })} style={fieldStyle()} /></label></div>}<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 10 }}><label>Reason<select value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value as ReviewReason })} style={fieldStyle()}><option value="CONFIRMED_ACTUAL_WORK">Confirmed actual work</option><option value="CORRECTED_TIME">Corrected time</option><option value="OTHER">Other</option></select></label><label>Note<input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder={draft.reason === "OTHER" ? "Required" : "Optional"} style={fieldStyle()} /></label></div><div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}><button type="button" disabled={saving} onClick={() => void save(record, false)} style={buttonStyle(true)}>Save</button><button type="button" disabled={saving} onClick={() => void save(record, true)} style={buttonStyle()}>Save &amp; Next</button><button type="button" disabled={saving} onClick={() => { setEditingId(null); setDraft(null); }} style={buttonStyle()}>Cancel</button></div></div>}
        </article>;
      })}</div></div>)}
    </section>
  );
}
