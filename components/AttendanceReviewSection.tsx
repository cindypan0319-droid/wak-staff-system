import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../lib/supabaseClient";
import type { CanonicalAttendanceRecord } from "./AttendanceReviewInlineEditor";

type RangeMode = "DAY" | "WEEK" | "CUSTOM";
export type ReviewFilter = "ALL" | "NEEDS_REVIEW";
type Profile = { id: string; full_name: string | null; preferred_name: string | null; is_active: boolean | null };
type ListResponse =
  | { ok: true; records: CanonicalAttendanceRecord[]; staffOptions: Profile[] }
  | { ok: false; reason: string };

type Props = {
  onRangeChange: (from: string, to: string, staffId: string) => void;
  onRecordsChange: (records: CanonicalAttendanceRecord[], filter: ReviewFilter) => void;
  onCreateShift: () => void;
  refreshKey: number;
};

const MELBOURNE = "Australia/Melbourne";
const BLUE = "#1E5A9E";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#667085";

function melbourneDate() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: MELBOURNE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
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

function validDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateHeading(value: string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function name(profile: Profile) {
  return profile.preferred_name?.trim() || profile.full_name?.trim() || "Unknown employee";
}

function fieldStyle(width?: number | string) {
  return {
    width: width ?? "100%",
    maxWidth: "100%",
    boxSizing: "border-box" as const,
    padding: "7px 9px",
    border: "1px solid #D0D5DD",
    borderRadius: 8,
    background: "#fff",
    color: TEXT,
  };
}

function buttonStyle(primary = false) {
  return {
    padding: "7px 11px",
    border: `1px solid ${primary ? BLUE : "#D0D5DD"}`,
    borderRadius: 8,
    background: primary ? BLUE : "#fff",
    color: primary ? "#fff" : TEXT,
    fontWeight: 700,
    cursor: "pointer",
  } as const;
}

export default function AttendanceReviewSection({
  onRangeChange,
  onRecordsChange,
  onCreateShift,
  refreshKey,
}: Props) {
  const router = useRouter();
  const today = melbourneDate();
  const [rangeMode, setRangeMode] = useState<RangeMode>("DAY");
  const [day, setDay] = useState(today);
  const [weekStart, setWeekStart] = useState(thursdayFor(today));
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);
  const [staffId, setStaffId] = useState("ALL");
  const [filter, setFilter] = useState<ReviewFilter>("NEEDS_REVIEW");
  const [staffOptions, setStaffOptions] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestEpoch = useRef(0);
  const currentRecordsRef = useRef<CanonicalAttendanceRecord[]>([]);

  const range = useMemo(() => {
    if (rangeMode === "DAY") return { from: day, to: day };
    if (rangeMode === "WEEK") return { from: weekStart, to: addDays(weekStart, 6) };
    return { from: customFrom, to: customTo };
  }, [customFrom, customTo, day, rangeMode, weekStart]);

  const publish = useCallback((records: CanonicalAttendanceRecord[], nextFilter: ReviewFilter) => {
    currentRecordsRef.current = records;
    onRecordsChange(records, nextFilter);
  }, [onRecordsChange]);

  const load = useCallback(async () => {
    if (!router.isReady || !validDate(range.from) || !validDate(range.to) || range.from > range.to) return;
    const requestId = ++requestEpoch.current;
    setLoading(true);
    setError("");
    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw new Error("Could not verify your session.");
      if (!data.session?.access_token) {
        void router.replace("/");
        return;
      }
      const params = new URLSearchParams({ from: range.from, to: range.to });
      if (staffId !== "ALL") params.set("staff_id", staffId);
      const response = await fetch(`/api/attendance/review-list?${params}`, {
        headers: { Authorization: `Bearer ${data.session.access_token}` },
      });
      const payload = (await response.json()) as ListResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.ok ? "Could not load attendance." : payload.reason);
      }
      if (requestId !== requestEpoch.current) return;
      setStaffOptions(payload.staffOptions);
      publish(payload.records, filter);
    } catch (caught) {
      if (requestId === requestEpoch.current) {
        setError(caught instanceof Error ? caught.message : "Could not load attendance.");
        publish([], filter);
      }
    } finally {
      if (requestId === requestEpoch.current) setLoading(false);
    }
  }, [filter, publish, range.from, range.to, router, staffId]);

  useEffect(() => {
    onRangeChange(range.from, range.to, staffId);
  }, [onRangeChange, range.from, range.to, staffId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 18,
        background: "#fff",
        padding: 18,
        marginBottom: 16,
        boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
          {(["DAY", "WEEK", "CUSTOM"] as RangeMode[]).map((mode) => (
            <button key={mode} type="button" onClick={() => setRangeMode(mode)} style={buttonStyle(rangeMode === mode)}>
              {mode === "DAY" ? "Day" : mode === "WEEK" ? "Week" : "Custom"}
            </button>
          ))}
        </div>
        <button type="button" onClick={onCreateShift} style={buttonStyle(true)}>＋ Create Shift</button>
      </div>

      <div style={{ marginTop: 10 }}>
        {rangeMode === "DAY" && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" onClick={() => setDay(addDays(day, -1))} style={buttonStyle()}>Previous</button>
            <input type="date" value={day} onChange={(event) => setDay(event.target.value)} style={fieldStyle(175)} />
            <button type="button" onClick={() => setDay(today)} style={buttonStyle()}>Today</button>
            <button type="button" onClick={() => setDay(addDays(day, 1))} style={buttonStyle()}>Next</button>
          </div>
        )}

        {rangeMode === "WEEK" && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))} style={buttonStyle()}>Previous week</button>
            <strong>{dateHeading(weekStart)} – {dateHeading(addDays(weekStart, 6))}</strong>
            <button type="button" onClick={() => setWeekStart(thursdayFor(today))} style={buttonStyle()}>This week</button>
            <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))} style={buttonStyle()}>Next week</button>
          </div>
        )}

        {rangeMode === "CUSTOM" && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label>
              <span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>From</span>
              <input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} style={fieldStyle(175)} />
            </label>
            <label>
              <span style={{ display: "block", fontSize: 12, color: MUTED, marginBottom: 4 }}>To</span>
              <input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} style={fieldStyle(175)} />
            </label>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10, marginTop: 12 }}>
        <label>
          <span style={{ display: "block", fontSize: 12, color: MUTED }}>Employee</span>
          <select value={staffId} onChange={(event) => setStaffId(event.target.value)} style={fieldStyle()}>
            <option value="ALL">All Staff</option>
            {staffOptions.map((person) => (
              <option key={person.id} value={person.id}>
                {name(person)}{person.is_active === true ? "" : " (INACTIVE)"}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span style={{ display: "block", fontSize: 12, color: MUTED }}>View</span>
          <select
            value={filter}
            onChange={(event) => {
              const next = event.target.value as ReviewFilter;
              setFilter(next);
              onRecordsChange(currentRecordsRef.current, next);
            }}
            style={fieldStyle()}
          >
            <option value="NEEDS_REVIEW">Needs Review</option>
            <option value="ALL">All Attendance</option>
          </select>
        </label>
      </div>

      {loading && <div style={{ marginTop: 9, color: MUTED, fontSize: 12 }}>Refreshing…</div>}
      {error && <div style={{ marginTop: 9, color: "#B42318", fontSize: 12 }}>{error}</div>}
    </div>
  );
}
