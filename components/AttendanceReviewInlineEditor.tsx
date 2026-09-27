import { useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";

type ReviewReason = "CONFIRMED_ACTUAL_WORK" | "CORRECTED_TIME" | "OTHER";

export type CanonicalAttendanceRecord = {
  workPeriod: {
    id: number;
    status: string;
    source_type: string;
    current_version_id: number;
    matched_shift_id: number | null;
    staff_id: string;
    time_clock_id?: number | null;
  };
  rawClock: {
    id: number;
    clock_in_at: string | null;
    clock_out_at: string | null;
    device_tag: string | null;
  } | null;
  currentVersion: {
    id: number;
    version_number: number;
    matched_shift_id: number | null;
    actual_start_at: string | null;
    actual_end_at: string | null;
    payable_start_at: string | null;
    payable_end_at: string | null;
    change_source: string;
  } | null;
  matchedShift: {
    id: number;
    shift_start: string;
    shift_end: string;
  } | null;
  openAnomalies: Array<{
    id: number;
    anomaly_type: string;
    severity: string;
  }>;
};

type Draft = {
  actualStart: string;
  actualEnd: string;
  payableStart: string;
  payableEnd: string;
  basePayableStart: string;
  basePayableEnd: string;
  reason: ReviewReason;
  note: string;
  adjustPayable: boolean;
};

const MELBOURNE = "Australia/Melbourne";
const BLUE = "#1E5A9E";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#667085";

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

function time(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function fieldStyle() {
  return {
    width: "100%",
    boxSizing: "border-box" as const,
    padding: "7px 8px",
    border: "1px solid #D0D5DD",
    borderRadius: 8,
    background: "#fff",
    color: TEXT,
  };
}

function buttonStyle(primary = false) {
  return {
    padding: "7px 10px",
    border: `1px solid ${primary ? BLUE : "#D0D5DD"}`,
    borderRadius: 8,
    background: primary ? BLUE : "#fff",
    color: primary ? "#fff" : TEXT,
    fontWeight: 700,
    cursor: "pointer",
  } as const;
}

function suggestedPayable(record: CanonicalAttendanceRecord, actualStartValue: string, actualEndValue: string, baseStart: string, baseEnd: string) {
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

  const payableStart =
    actualStartMs >= rosterStartMs
      ? inputDateTime(actualStart)
      : earlyStartSeconds <= 300
        ? inputDateTime(record.matchedShift.shift_start)
        : baseStart;

  const payableEnd =
    actualEndMs <= rosterEndMs
      ? inputDateTime(actualEnd)
      : lateFinishSeconds <= 300
        ? inputDateTime(record.matchedShift.shift_end)
        : baseEnd;

  return { payableStart, payableEnd };
}

export default function AttendanceReviewInlineEditor({
  record,
  onSaved,
  onCancel,
}: {
  record: CanonicalAttendanceRecord;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const router = useRouter();
  const version = record.currentVersion;
  const actualStart = version?.actual_start_at ?? record.rawClock?.clock_in_at ?? null;
  const actualEnd = version?.actual_end_at ?? record.rawClock?.clock_out_at ?? null;
  const initialPayableStart = version?.payable_start_at ?? actualStart;
  const initialPayableEnd = version?.payable_end_at ?? actualEnd;

  const [draft, setDraft] = useState<Draft>({
    actualStart: inputDateTime(actualStart),
    actualEnd: inputDateTime(actualEnd),
    payableStart: inputDateTime(initialPayableStart),
    payableEnd: inputDateTime(initialPayableEnd),
    basePayableStart: inputDateTime(initialPayableStart),
    basePayableEnd: inputDateTime(initialPayableEnd),
    reason: "CONFIRMED_ACTUAL_WORK",
    note: "",
    adjustPayable: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!version) return <div style={{ color: MUTED }}>No canonical review version is available.</div>;

  function updateActual(side: "start" | "end", value: string) {
    setDraft((current) => {
      const next = side === "start" ? { ...current, actualStart: value } : { ...current, actualEnd: value };
      if (next.adjustPayable) return next;
      return {
        ...next,
        ...suggestedPayable(record, next.actualStart, next.actualEnd, next.basePayableStart, next.basePayableEnd),
      };
    });
  }

  function cancelPayableAdjustment() {
    setDraft((current) => ({
      ...current,
      ...suggestedPayable(record, current.actualStart, current.actualEnd, current.basePayableStart, current.basePayableEnd),
      adjustPayable: false,
    }));
  }

  async function save() {
    const reviewVersion = record.currentVersion;
    if (!reviewVersion) {
      setError("No canonical review version is available.");
      return;
    }

    const actualStartIso = toIso(draft.actualStart);
    const actualEndIso = toIso(draft.actualEnd);
    const payableStartIso = toIso(draft.payableStart);
    const payableEndIso = toIso(draft.payableEnd);
    if (!actualStartIso || !actualEndIso || !payableStartIso || !payableEndIso) {
      setError("Enter complete actual and payable times.");
      return;
    }
    if (draft.reason === "OTHER" && !draft.note.trim()) {
      setError("Add a note when the reason is Other.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw new Error("Could not verify your session.");
      if (!data.session?.access_token) {
        void router.replace("/");
        return;
      }

      const response = await fetch("/api/attendance/review", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          work_period_id: record.workPeriod.id,
          expected_version_id: reviewVersion.id,
          matched_shift_id: reviewVersion.matched_shift_id,
          actual_start_at: actualStartIso,
          actual_end_at: actualEndIso,
          payable_start_at: payableStartIso,
          payable_end_at: payableEndIso,
          reason_code: draft.reason,
          reason_note: draft.note || null,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        if (payload?.reason === "ATTENDANCE_REVIEW_CONFLICT") {
          throw new Error("This record changed. Refresh and review it again.");
        }
        if (payload?.reason === "ATTENDANCE_REVIEW_PAYABLE_OVERLAP") {
          throw new Error("Payable time overlaps another confirmed work period.");
        }
        throw new Error("Could not save attendance review.");
      }
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save attendance review.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: 12, background: "#F8FAFC", border: `1px solid ${BORDER}`, borderRadius: 10 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <label>
          <span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Actual start</span>
          <input type="datetime-local" step={1} value={draft.actualStart} onChange={(event) => updateActual("start", event.target.value)} style={fieldStyle()} />
        </label>
        <label>
          <span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Actual end</span>
          <input type="datetime-local" step={1} value={draft.actualEnd} onChange={(event) => updateActual("end", event.target.value)} style={fieldStyle()} />
        </label>
      </div>

      <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "#fff" }}>
        <div style={{ fontSize: 12, color: MUTED }}>{draft.adjustPayable ? "Manual payable" : "Pay suggestion"}</div>
        <div style={{ fontWeight: 800, marginTop: 3 }}>{time(toIso(draft.payableStart))} – {time(toIso(draft.payableEnd))}</div>
        <button
          type="button"
          onClick={() => draft.adjustPayable ? cancelPayableAdjustment() : setDraft({ ...draft, adjustPayable: true })}
          style={{ ...buttonStyle(), marginTop: 7 }}
        >
          {draft.adjustPayable ? "Cancel payable adjustment" : "Adjust payable time"}
        </button>
      </div>

      {draft.adjustPayable && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 10 }}>
          <label>
            <span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Payable start</span>
            <input type="datetime-local" step={1} value={draft.payableStart} onChange={(event) => setDraft({ ...draft, payableStart: event.target.value })} style={fieldStyle()} />
          </label>
          <label>
            <span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Payable end</span>
            <input type="datetime-local" step={1} value={draft.payableEnd} onChange={(event) => setDraft({ ...draft, payableEnd: event.target.value })} style={fieldStyle()} />
          </label>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 10 }}>
        <label>
          <span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Reason</span>
          <select value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value as ReviewReason })} style={fieldStyle()}>
            <option value="CONFIRMED_ACTUAL_WORK">Confirmed actual work</option>
            <option value="CORRECTED_TIME">Corrected time</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <label>
          <span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>Note</span>
          <input value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder={draft.reason === "OTHER" ? "Required" : "Optional"} style={fieldStyle()} />
        </label>
      </div>

      {error && <div style={{ marginTop: 8, color: "#B42318", fontSize: 12 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="button" disabled={saving} onClick={() => void save()} style={buttonStyle(true)}>Save review</button>
        <button type="button" disabled={saving} onClick={onCancel} style={buttonStyle()}>Cancel</button>
      </div>
    </div>
  );
}
