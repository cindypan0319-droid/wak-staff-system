import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const DEFAULT_STORE_ID = "MOOROOLBARK";
const DEFAULT_FLOAT_IF_NO_MORNING = 400;
const EPS = 0.01;

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F7FA";
const BORDER = "#E1E5EB";
const TEXT = "#111827";
const MUTED = "#6B7280";
const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

type Platform = {
  id: number | string;
  name: string;
  is_active: boolean;
  sort_order: number;
};

type DailyCloseResult = {
  night_updated_at: string;
  close_contract_version: number;
};

type DailyCashupRole = "STAFF" | "MANAGER" | "OWNER";

type DailyCashupSnapshot = {
  business_date: string;
  store_id: string;
  caller: { role: DailyCashupRole; user_id: string };
  morning: {
    exists: boolean;
    counts: unknown;
    total_cash: number | string | null;
    entered_by: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  night: {
    exists: boolean;
    counts: unknown;
    total_cash: number | string | null;
    removed_cash: number | string | null;
    entered_by: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  daily_sales: {
    exists: boolean;
    cash_sales: number | string | null;
    eftpos_sales: number | string | null;
    expected_cash: number | string | null;
    total_sales: number | string | null;
    notes: string | null;
    entered_by: string | null;
  };
  platforms: Array<{
    platform: string;
    gross_income: number | string;
    fees: number | string;
    entered_by: string | null;
  }>;
  active_platforms: Platform[];
};

type LoadExistingResult = {
  nightExists: boolean;
  fullyLoaded: boolean;
};

type NightReadStatus = "loading" | "loaded" | "error";
type MorningReadStatus = "loading" | "loaded" | "error";

type CashCounts = {
  note100: number | null;
  note50: number | null;
  note20: number | null;
  note10: number | null;
  note5: number | null;
  coin2: number | null;
  coin1: number | null;
  coin50c: number | null;
  coin20c: number | null;
  coin10c: number | null;
  coin5c: number | null;
};

const emptyCounts: CashCounts = {
  note100: null,
  note50: null,
  note20: null,
  note10: null,
  note5: null,
  coin2: null,
  coin1: null,
  coin50c: null,
  coin20c: null,
  coin10c: null,
  coin5c: null,
};

type CashDiffReason =
  | ""
  | "FLOAT_CHANGED"
  | "CASH_REFUND_OR_PAYOUT"
  | "CASH_DROP_NOT_COUNTED"
  | "COUNTING_MISTAKE"
  | "POS_CASH_ADJUSTMENT"
  | "OTHER";

type SaveState = "idle" | "saving" | "saved" | "error";

function melbourneDateInputValue() {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function money(n: number) {
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

function businessDateLabel(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (!year || !month || !day || !monthNames[month - 1]) return value;
  return `${monthNames[month - 1]} ${day}, ${year}`;
}

type MoneyValidation =
  | { value: number; error: null }
  | { value: null; error: "required" | "invalid" | "negative" };

function parseNonnegativeMoney(raw: string | undefined | null): MoneyValidation {
  const s = String(raw ?? "").trim();
  if (!s) return { value: null, error: "required" };

  const n = Number(s);
  if (!Number.isFinite(n)) return { value: null, error: "invalid" };
  if (n < 0) return { value: null, error: "negative" };
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s)) {
    return { value: null, error: "invalid" };
  }

  return { value: n, error: null };
}

function moneyValueForDisplay(raw: string | undefined | null) {
  return parseNonnegativeMoney(raw).value ?? 0;
}

function moneyValidationMessage(label: string, validation: MoneyValidation) {
  if (validation.error === "required") return `${label} is required. Enter 0 if the amount is zero.`;
  if (validation.error === "negative") return `${label} cannot be negative.`;
  return `${label} must be a valid number.`;
}

function parseIntOrNull(raw: string) {
  const s = raw.trim();
  if (!s) return null;
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function countsToStoredJson(c: CashCounts) {
  const out: Record<string, number> = {};
  for (const k of Object.keys(c) as (keyof CashCounts)[]) {
    out[k] = Number.isFinite(Number(c[k])) ? Number(c[k]) : 0;
  }
  return out;
}

function storedJsonToCounts(obj: unknown): CashCounts {
  const record =
    typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>) : {};
  const out: CashCounts = { ...emptyCounts };
  for (const k of Object.keys(emptyCounts) as (keyof CashCounts)[]) {
    const v = record[k];
    const n = Number(v);
    out[k] = Number.isFinite(n) && n > 0 ? n : null;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function calcTotal(c: CashCounts) {
  const v = (x: number | null) => (Number.isFinite(Number(x)) ? Number(x) : 0);

  return round2(
    v(c.note100) * 100 +
      v(c.note50) * 50 +
      v(c.note20) * 20 +
      v(c.note10) * 10 +
      v(c.note5) * 5 +
      v(c.coin2) * 2 +
      v(c.coin1) * 1 +
      v(c.coin50c) * 0.5 +
      v(c.coin20c) * 0.2 +
      v(c.coin10c) * 0.1 +
      v(c.coin5c) * 0.05
  );
}

const denomFields: { label: string; key: keyof CashCounts; value: number }[] = [
  { label: "$100 notes", key: "note100", value: 100 },
  { label: "$50 notes", key: "note50", value: 50 },
  { label: "$20 notes", key: "note20", value: 20 },
  { label: "$10 notes", key: "note10", value: 10 },
  { label: "$5 notes", key: "note5", value: 5 },
  { label: "$2 coins", key: "coin2", value: 2 },
  { label: "$1 coins", key: "coin1", value: 1 },
  { label: "50c coins", key: "coin50c", value: 0.5 },
  { label: "20c coins", key: "coin20c", value: 0.2 },
  { label: "10c coins", key: "coin10c", value: 0.1 },
  { label: "5c coins", key: "coin5c", value: 0.05 },
];

function normalizeCountsForCompare(c: CashCounts) {
  return countsToStoredJson(c);
}

function buildMorningSnapshot(counts: CashCounts) {
  return JSON.stringify({
    counts: normalizeCountsForCompare(counts),
  });
}

function buildClosingSnapshot(args: {
  nightCounts: CashCounts;
  removedCounts: CashCounts;
  cashSalesText: string;
  eftposSalesText: string;
  notes: string;
  cashDiffReason: CashDiffReason;
  cashDiffNote: string;
  platforms: Platform[];
  platformGrossText: Record<string, string>;
}) {
  const normalizedPlatforms = args.platforms
    .slice()
    .sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return a.name.localeCompare(b.name);
    })
    .map((p) => ({
      name: p.name,
      grossText: args.platformGrossText[canonicalPlatformName(p.name)] ?? "",
    }));

  return JSON.stringify({
    nightCounts: normalizeCountsForCompare(args.nightCounts),
    removedCounts: normalizeCountsForCompare(args.removedCounts),
    cashSalesText: args.cashSalesText,
    eftposSalesText: args.eftposSalesText,
    notes: args.notes,
    cashDiffReason: args.cashDiffReason || "",
    cashDiffNote: args.cashDiffNote.trim(),
    platforms: normalizedPlatforms,
  });
}

function canonicalPlatformName(name: string) {
  const trimmed = name.trim();
  const normalized = trimmed.toUpperCase().replace(/\s+/g, " ");

  switch (normalized) {
    case "DOORDASH":
      return "DOORDASH";
    case "UBER EATS":
    case "UBER_EATS":
    case "UBER":
      return "UBER_EATS";
    case "WAK APP":
    case "WAK":
      return "WAK";
    case "DELIVEROO":
      return "DELIVEROO";
    case "MENULOG":
      return "MENULOG";
    default:
      return trimmed;
  }
}

function platformDisplayName(name: string) {
  switch (canonicalPlatformName(name)) {
    case "UBER_EATS":
      return "Uber Eats";
    case "DOORDASH":
      return "DoorDash";
    case "WAK":
      return "WAK";
    case "DELIVEROO":
      return "Deliveroo";
    case "MENULOG":
      return "Menulog";
    default:
      return name;
  }
}

function friendlyRpcError(message: string) {
  if (message.includes("DAILY_CLOSE_ALREADY_EXISTS_USE_CORRECTION")) {
    return "This Daily Close has already been submitted. Reload to view the committed close.";
  }
  if (message.includes("DAILY_CLOSE_LEGACY_PARTIAL_REQUIRES_MANAGER")) {
    return "Existing partial sales data requires a manager to complete this Daily Close.";
  }
  if (message.includes("DAILY_CLOSE_REVISION_CONFLICT")) {
    return "This Daily Close changed while you were working. Reload before trying again.";
  }
  if (message.includes("STAFF_DAILY_CLOSE_CURRENT_DATE_ONLY")) {
    return "Staff can only correct their own Daily Close for today's Melbourne business date.";
  }
  if (message.includes("STAFF_DAILY_CLOSE_NOT_ORIGINAL_SUBMITTER")) {
    return "Only the staff member who originally submitted this Daily Close can correct it.";
  }
  if (message.includes("Employee profile is inactive")) {
    return "Your employee profile is inactive. Daily Entry cannot be saved.";
  }
  if (message.includes("Authentication required")) {
    return "Your login session is no longer valid. Sign in again before saving.";
  }
  if (
    message.includes("DAILY_CLOSE_LEGACY_MORNING_COUNTS_CONFLICT") ||
    message.includes("morning_counts")
  ) {
    return "The saved Morning Cashup is malformed. Ask a manager to review it before closing.";
  }
  if (message.includes("cash_difference.reason is required")) {
    return "Choose a cash difference reason before submitting.";
  }
  if (message.includes("cash_difference.note is required")) {
    return "Enter a note when the cash difference reason is Other.";
  }
  if (message.includes("FEE_RECALCULATION_CONFIRMATION_REQUIRED")) {
    return "Changing an existing platform amount requires confirmation because its fee will be recalculated.";
  }
  if (message.includes("PLATFORM_PARTIAL")) {
    return "Platform data is incomplete. Reload the page and enter an amount for every listed platform.";
  }
  if (
    message.includes("CANONICAL_ALIAS_COLLISION") ||
    message.includes("Active platform configuration contains canonical alias duplicates")
  ) {
    return "Platform configuration has a duplicate or conflicting name. Please reload and contact a manager.";
  }
  if (message.includes("Platform is not active or present for this date")) {
    return "One of the platform entries is no longer valid. Please reload the page and try again. If it continues, contact a manager.";
  }
  if (message.includes("DAILY_CLOSE_NOTES_TARGET_MISSING")) {
    return "The Daily Close record could not be found while saving notes. Please reload and ask a manager to review it.";
  }
  if (message.includes("MORNING_AFTER_CLOSE_REQUIRES_MANAGER")) {
    return "Morning Cashup cannot be changed after the Daily Close has been submitted.";
  }
  if (message.includes("STAFF may only update a MORNING")) {
    return "Only the employee who entered this Morning Cashup, or a manager, may change it.";
  }
  return "The Daily Cashup could not be saved. Please refresh and try again.";
}

export default function DailyEntryPage() {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const [storeAccessLoading, setStoreAccessLoading] = useState(true);
  const [isStoreDevice, setIsStoreDevice] = useState(false);
  const [detectedIp, setDetectedIp] = useState("");

  const [date, setDate] = useState(melbourneDateInputValue());
  const draftKey = `daily-entry-draft-${date}`;
  const [activeTab, setActiveTab] = useState<"morning" | "closing">("morning");
  const selectedDateRef = useRef(date);
  const manualTabDateRef = useRef<string | null>(null);
  const defaultTabPendingDateRef = useRef<string | null>(date);
  selectedDateRef.current = date;
  const [callerRole, setCallerRole] = useState<DailyCashupRole | null>(null);
  const [callerUserId, setCallerUserId] = useState<string | null>(null);
  const [nightEnteredBy, setNightEnteredBy] = useState<string | null>(null);

  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [platformGrossText, setPlatformGrossText] = useState<Record<string, string>>({});
  const [existingPlatformGross, setExistingPlatformGross] = useState<Record<string, number>>({});

  const [cashSalesText, setCashSalesText] = useState<string>("");
  const [eftposSalesText, setEftposSalesText] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [morningCounts, setMorningCounts] = useState<CashCounts>({ ...emptyCounts });
  const [nightCounts, setNightCounts] = useState<CashCounts>({ ...emptyCounts });
  const [removedCounts, setRemovedCounts] = useState<CashCounts>({ ...emptyCounts });

  const [cashDiffReason, setCashDiffReason] = useState<CashDiffReason>("");
  const [cashDiffNote, setCashDiffNote] = useState<string>("");

  const [hasMorningRecord, setHasMorningRecord] = useState(false);
  const [morningRead, setMorningRead] = useState<{ date: string; status: MorningReadStatus }>(
    { date, status: "loading" }
  );
  const morningReadStatus = morningRead.date === date ? morningRead.status : "loading";
  const [savedMorningTotal, setSavedMorningTotal] = useState(DEFAULT_FLOAT_IF_NO_MORNING);
  const [hasNightRecord, setHasNightRecord] = useState(false);
  const [nightRead, setNightRead] = useState<{ date: string; status: NightReadStatus }>(
    { date, status: "loading" }
  );
  const nightReadStatus = nightRead.date === date ? nightRead.status : "loading";
  const [nightRevision, setNightRevision] = useState<string | null>(null);
  const [morningRecountAcknowledged, setMorningRecountAcknowledged] = useState(false);
  const [nightRecountAcknowledged, setNightRecountAcknowledged] = useState(false);
  const [removedRecountAcknowledged, setRemovedRecountAcknowledged] = useState(false);

  const [morningDirty, setMorningDirty] = useState(false);
  const [closingDirty, setClosingDirty] = useState(false);

  const [morningSaveState, setMorningSaveState] = useState<SaveState>("idle");
  const [closingSaveState, setClosingSaveState] = useState<SaveState>("idle");
  const [morningSaveError, setMorningSaveError] = useState("");
  const [closingSaveError, setClosingSaveError] = useState("");
  const [morningLastSavedAt, setMorningLastSavedAt] = useState<string | null>(null);
  const [closingLastSavedAt, setClosingLastSavedAt] = useState<string | null>(null);

  const initialLoadDoneRef = useRef(false);
  const morningSavingRef = useRef(false);
  const closingSavingRef = useRef(false);

  const morningServerSnapshotRef = useRef<string>("");
  const closingServerSnapshotRef = useRef<string>("");

  const morningTotal = useMemo(() => calcTotal(morningCounts), [morningCounts]);
  const nightTotal = useMemo(() => calcTotal(nightCounts), [nightCounts]);
  const removedTotal = useMemo(() => calcTotal(removedCounts), [removedCounts]);

  const baselineMorningTotal = useMemo(
    () => (hasMorningRecord ? savedMorningTotal : DEFAULT_FLOAT_IF_NO_MORNING),
    [hasMorningRecord, savedMorningTotal]
  );

  const countedDailyCashMovement = useMemo(
    () => round2(nightTotal - baselineMorningTotal),
    [nightTotal, baselineMorningTotal]
  );

  const targetRemovedCash = useMemo(
    () => round2(Math.max(0, nightTotal - DEFAULT_FLOAT_IF_NO_MORNING)),
    [nightTotal]
  );

  const removedVsShouldDiff = useMemo(
    () => round2(removedTotal - targetRemovedCash),
    [removedTotal, targetRemovedCash]
  );

  const projectedClosingFloat = useMemo(
    () => round2(nightTotal - removedTotal),
    [nightTotal, removedTotal]
  );

  const closingFloatVariance = useMemo(
    () => round2(projectedClosingFloat - DEFAULT_FLOAT_IF_NO_MORNING),
    [projectedClosingFloat]
  );

  const actualCashSales = useMemo(
    () => round2(moneyValueForDisplay(cashSalesText)),
    [cashSalesText]
  );
  const eftposSales = useMemo(
    () => round2(moneyValueForDisplay(eftposSalesText)),
    [eftposSalesText]
  );

  const cashVariance = useMemo(
    () => round2(actualCashSales - countedDailyCashMovement),
    [actualCashSales, countedDailyCashMovement]
  );

  const instoreSubtotal = useMemo(() => round2(actualCashSales + eftposSales), [actualCashSales, eftposSales]);

  const onlineSubtotal = useMemo(() => {
    let sum = 0;
    for (const platform of platforms) {
      sum += moneyValueForDisplay(platformGrossText[canonicalPlatformName(platform.name)]);
    }
    return round2(sum);
  }, [platformGrossText, platforms]);

  const total = useMemo(() => round2(instoreSubtotal + onlineSubtotal), [instoreSubtotal, onlineSubtotal]);
  const isCurrentMelbourneDate = date === melbourneDateInputValue();
  const canCorrectClose = hasNightRecord && (
    callerRole === "OWNER" ||
    callerRole === "MANAGER" ||
    (callerRole === "STAFF" && isCurrentMelbourneDate && nightEnteredBy === callerUserId)
  );

  const currentMorningSnapshot = useMemo(() => {
    return buildMorningSnapshot(morningCounts);
  }, [morningCounts]);

  const currentClosingSnapshot = useMemo(() => {
    return buildClosingSnapshot({
      nightCounts,
      removedCounts,
      cashSalesText,
      eftposSalesText,
      notes,
      cashDiffReason,
      cashDiffNote,
      platforms,
      platformGrossText,
    });
  }, [
    nightCounts,
    removedCounts,
    cashSalesText,
    eftposSalesText,
    notes,
    cashDiffReason,
    cashDiffNote,
    platforms,
    platformGrossText,
  ]);

  useEffect(() => {
    if (!initialLoadDoneRef.current) return;
    setMorningDirty(currentMorningSnapshot !== morningServerSnapshotRef.current);
  }, [currentMorningSnapshot]);

  useEffect(() => {
    if (!initialLoadDoneRef.current) return;
    setClosingDirty(currentClosingSnapshot !== closingServerSnapshotRef.current);
  }, [currentClosingSnapshot]);

  useEffect(() => {
    async function checkStoreAccess() {
      setStoreAccessLoading(true);
      try {
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) {
          console.log("DAILY_ENTRY_SESSION_CHECK_READ_ERROR");
          setIsStoreDevice(false);
          setDetectedIp("");
          setMsg("❌ Could not verify your session or store access. Please refresh and try again.");
          return;
        }

        const token = sessionData.session?.access_token;

        if (!token) {
          window.location.href = "/staff/home";
          return;
        }

        const res = await fetch("/api/check-store-access", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
        const data = await res.json();

        setIsStoreDevice(!!data.allowed);
        setDetectedIp(data.ip || "");

        if (!data.allowed) {
          window.location.href = "/staff/home";
        }
      } catch (error) {
        console.log("check store access error:", error);
        setIsStoreDevice(false);
        setDetectedIp("");
        setMsg("❌ Could not verify your session or store access. Please refresh and try again.");
      } finally {
        setStoreAccessLoading(false);
      }
    }

    checkStoreAccess();
  }, []);

  function setCountsField(
    setter: (fn: (prev: CashCounts) => CashCounts) => void,
    key: keyof CashCounts,
    raw: string,
    section: "morning" | "night" | "removed"
  ) {
    const n = parseIntOrNull(raw);
    setter((prev) => ({ ...prev, [key]: n }));

    if (initialLoadDoneRef.current) {
      if (section === "morning") {
        setMorningRecountAcknowledged(false);
        setMorningSaveState("idle");
        setMorningSaveError("");
      } else {
        if (section === "night") {
          setNightRecountAcknowledged(false);
          setRemovedRecountAcknowledged(false);
        } else {
          setRemovedRecountAcknowledged(false);
        }
        setClosingSaveState("idle");
        setClosingSaveError("");
      }
    }
  }

  function markClosingDirtyStyleOnly() {
    if (initialLoadDoneRef.current) {
      setClosingSaveState("idle");
      setClosingSaveError("");
    }
  }

  async function loadExisting(options?: {
    restoreDraft?: boolean;
    selectDefaultTab?: boolean;
  }): Promise<LoadExistingResult> {
    const restoreDraft = options?.restoreDraft ?? true;

    setLoading(true);
    setMsg("");
    setMorningRead({ date, status: "loading" });
    setNightRead({ date, status: "loading" });
    initialLoadDoneRef.current = false;

    try {
      const snapshotResult = await supabase.rpc("get_daily_cashup_snapshot", {
        p_business_date: date,
        p_store_id: DEFAULT_STORE_ID,
      });

      if (snapshotResult.error || !snapshotResult.data) {
        console.log("DAILY_CASHUP_SNAPSHOT_READ_ERROR");
        setMorningRead({ date, status: "error" });
        setNightRead({ date, status: "error" });
        setMsg("❌ Daily Cashup data could not be loaded. Please use Refresh and try again.");
        return { nightExists: false, fullyLoaded: false };
      }

      const snapshot = snapshotResult.data as DailyCashupSnapshot;
      let loadedPlatforms = (snapshot.active_platforms ?? []).map((platform) => ({
        ...platform,
        is_active: platform.is_active === true,
      }));
      const activeCanonicalNames = new Set(
        loadedPlatforms.map((platform) => canonicalPlatformName(platform.name))
      );
      const serverPlatformGrossText: Record<string, string> = {};
      const serverExistingPlatformGross: Record<string, number> = {};
      const historicalPlatforms: Platform[] = [];

      for (const row of snapshot.platforms ?? []) {
        const canonicalName = canonicalPlatformName(String(row.platform));
        const gross = Number(row.gross_income);
        serverPlatformGrossText[canonicalName] = Number.isFinite(gross) ? String(row.gross_income) : "0";
        serverExistingPlatformGross[canonicalName] = Number.isFinite(gross) ? round2(gross) : 0;
        if (!activeCanonicalNames.has(canonicalName)) {
          activeCanonicalNames.add(canonicalName);
          historicalPlatforms.push({
            id: `historical-${canonicalName}`,
            name: canonicalName,
            is_active: false,
            sort_order: Number.MAX_SAFE_INTEGER,
          });
        }
      }
      loadedPlatforms = [...loadedPlatforms, ...historicalPlatforms];
      for (const platform of loadedPlatforms) {
        const canonicalName = canonicalPlatformName(platform.name);
        if (!(canonicalName in serverPlatformGrossText)) {
          serverPlatformGrossText[canonicalName] = "";
        }
      }

      const serverCashSalesText = snapshot.daily_sales.cash_sales == null
        ? ""
        : String(snapshot.daily_sales.cash_sales);
      const serverEftposSalesText = snapshot.daily_sales.eftpos_sales == null
        ? ""
        : String(snapshot.daily_sales.eftpos_sales);
      const serverNotes = snapshot.daily_sales.notes ?? "";
      const serverHasMorningRecord = snapshot.morning.exists === true;
      const serverMorningCounts = serverHasMorningRecord
        ? storedJsonToCounts(snapshot.morning.counts)
        : { ...emptyCounts };
      const serverHasNightRecord = snapshot.night.exists === true;
      const serverNightCounts = serverHasNightRecord
        ? storedJsonToCounts(snapshot.night.counts)
        : { ...emptyCounts };

      const nightCountsRaw = asRecord(snapshot.night.counts);
      const removedRaw = nightCountsRaw._removed_counts ?? null;
      const reasonRaw = nightCountsRaw._cash_diff_reason ?? "";
      const noteRaw = nightCountsRaw._cash_diff_note ?? "";

      const serverRemovedCounts = removedRaw
        ? storedJsonToCounts(removedRaw)
        : { ...emptyCounts };

      const serverCashDiffReason = ((reasonRaw as CashDiffReason) || "") as CashDiffReason;
      const serverCashDiffNote = String(noteRaw ?? "");

      if (
        options?.selectDefaultTab === true &&
        selectedDateRef.current === date &&
        defaultTabPendingDateRef.current === date &&
        manualTabDateRef.current !== date
      ) {
        setActiveTab(serverHasNightRecord || serverHasMorningRecord ? "closing" : "morning");
        defaultTabPendingDateRef.current = null;
      }

      morningServerSnapshotRef.current = buildMorningSnapshot(serverMorningCounts);
      closingServerSnapshotRef.current = buildClosingSnapshot({
        nightCounts: serverNightCounts,
        removedCounts: serverRemovedCounts,
        cashSalesText: serverCashSalesText,
        eftposSalesText: serverEftposSalesText,
        notes: serverNotes,
        cashDiffReason: serverCashDiffReason,
        cashDiffNote: serverCashDiffNote,
        platforms: loadedPlatforms,
        platformGrossText: serverPlatformGrossText,
      });

      setHasMorningRecord(serverHasMorningRecord);
      setSavedMorningTotal(
        serverHasMorningRecord
          ? Number(snapshot.morning.total_cash ?? calcTotal(serverMorningCounts))
          : DEFAULT_FLOAT_IF_NO_MORNING
      );
      setHasNightRecord(serverHasNightRecord);
      setNightRevision(snapshot.night.updated_at ?? null);
      setNightEnteredBy(snapshot.night.entered_by ?? null);
      setCallerRole(snapshot.caller.role);
      setCallerUserId(snapshot.caller.user_id);
      setMorningRead({ date, status: "loaded" });
      setNightRead({ date, status: "loaded" });
      setPlatforms(loadedPlatforms);
      setMorningCounts(serverMorningCounts);
      setNightCounts(serverNightCounts);
      setRemovedCounts(serverRemovedCounts);

      setCashSalesText(serverCashSalesText);
      setEftposSalesText(serverEftposSalesText);
      setNotes(serverNotes);
      setPlatformGrossText(serverPlatformGrossText);
      setExistingPlatformGross(serverExistingPlatformGross);
      setCashDiffReason(serverCashDiffReason);
      setCashDiffNote(serverCashDiffNote);
      setMorningRecountAcknowledged(false);
      setNightRecountAcknowledged(false);
      setRemovedRecountAcknowledged(false);

      setMorningSaveState("idle");
      setClosingSaveState("idle");
      setMorningSaveError("");
      setClosingSaveError("");
      setMorningDirty(false);
      setClosingDirty(false);

      setMsg(serverHasNightRecord ? "" : "✅ Daily Cashup loaded.");

      if (serverHasNightRecord) {
        localStorage.removeItem(draftKey);
      } else if (restoreDraft) {
        const savedDraft = localStorage.getItem(draftKey);

        if (savedDraft) {
          try {
            const d = JSON.parse(savedDraft);

            setCashSalesText(d.cashSalesText ?? "");
            setEftposSalesText(d.eftposSalesText ?? "");
            setNotes(d.notes ?? "");
            const restoredPlatformGross: Record<string, string> = {};
            for (const [platformName, gross] of Object.entries(
              (d.platformGrossText ?? {}) as Record<string, string>
            )) {
              restoredPlatformGross[canonicalPlatformName(platformName)] = gross;
            }
            setPlatformGrossText({
              ...serverPlatformGrossText,
              ...restoredPlatformGross,
            });
            setMorningCounts(d.morningCounts ?? { ...emptyCounts });
            setNightCounts(d.nightCounts ?? { ...emptyCounts });
            setRemovedCounts(d.removedCounts ?? { ...emptyCounts });
            setCashDiffReason(d.cashDiffReason ?? "");
            setCashDiffNote(d.cashDiffNote ?? "");
            setMsg("ℹ️ Restored unsaved local draft.");
          } catch (e) {
            console.log("restore draft error:", e);
          }
        }
      }

      return {
        nightExists: serverHasNightRecord,
        fullyLoaded: true,
      };
    } catch {
      console.log("DAILY_CASHUP_SNAPSHOT_READ_ERROR");
      setMorningRead({ date, status: "error" });
      setNightRead({ date, status: "error" });
      setMsg("❌ Daily Cashup data could not be loaded. Please use Refresh and try again.");
      return { nightExists: false, fullyLoaded: false };
    } finally {
      setLoading(false);
      initialLoadDoneRef.current = true;
    }
  }

  useEffect(() => {
    loadExisting({ restoreDraft: true, selectDefaultTab: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  async function saveMorning() {
    if (morningSavingRef.current) return true;

    morningSavingRef.current = true;
    setLoading(true);
    setMsg("");

    setMorningSaveState("saving");
    setMorningSaveError("");

    try {
      if (nightReadStatus !== "loaded") {
        const text = "❌ We couldn't verify whether this day has already been closed. Please try again before making changes.";
        setMsg(text);
        setMorningSaveState("error");
        setMorningSaveError(text);
        return false;
      }

      if (!isStoreDevice) {
        const text = "❌ Daily entry can only be saved on the store device / store network.";
        setMsg(text);
        setMorningSaveState("error");
        setMorningSaveError(text);
        return false;
      }

      if (hasNightRecord) {
        const text = "❌ Morning Cashup cannot be changed after this Daily Close was submitted.";
        setMsg(text);
        setMorningSaveState("error");
        setMorningSaveError(text);
        return false;
      }

      if (
        Math.abs(morningTotal - DEFAULT_FLOAT_IF_NO_MORNING) >= EPS &&
        !morningRecountAcknowledged
      ) {
        setMorningRecountAcknowledged(true);
        setMorningSaveState("idle");
        setMsg(
          `⚠️ Morning cash is ${money(
            Math.abs(morningTotal - DEFAULT_FLOAT_IF_NO_MORNING)
          )} ${morningTotal > DEFAULT_FLOAT_IF_NO_MORNING ? "over" : "short"}. Recount the till, then save again if ${money(
            morningTotal
          )} is the actual physical amount.`
        );
        return false;
      }

      const res = await supabase.rpc("save_morning_cashup", {
        p_business_date: date,
        p_store_id: DEFAULT_STORE_ID,
        p_counts: countsToStoredJson(morningCounts),
      });

      if (res.error) {
        const text = "❌ Save morning cashup failed: " + friendlyRpcError(res.error.message);
        setMsg(text);
        setMorningSaveState("error");
        setMorningSaveError(text);
        return false;
      }

      const reloadResult = await loadExisting({ restoreDraft: false });
      if (!reloadResult.fullyLoaded) {
        const text = "⚠️ Morning Cashup was saved, but the authoritative snapshot could not be reloaded. Please refresh before continuing.";
        setMsg(text);
        setMorningSaveState("error");
        setMorningSaveError(text);
        return true;
      }

      setMorningSaveState("saved");
      setMorningLastSavedAt(new Date().toISOString());
      setMsg(`✅ Morning cashup saved at the actual counted amount of ${money(morningTotal)}.`);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Morning Cashup error";
      const text = "❌ Save morning cashup failed: " + friendlyRpcError(message);
      setMsg(text);
      setMorningSaveState("error");
      setMorningSaveError(text);
      return false;
    } finally {
      morningSavingRef.current = false;
      setLoading(false);
    }
  }

  function needReason() {
    return Math.abs(cashVariance) >= EPS;
  }

  async function saveClosingAndSales() {
    if (closingSavingRef.current) return true;

    closingSavingRef.current = true;
    setLoading(true);
    setMsg("");

    setClosingSaveState("saving");
    setClosingSaveError("");

    try {
      if (nightReadStatus !== "loaded") {
        const text = "❌ We couldn't verify whether this day has already been closed. Please try again before making changes.";
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      if (morningReadStatus !== "loaded") {
        const text = "❌ We couldn't verify the Morning Cashup for this day. Please refresh and try again before closing the day.";
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      if (!isStoreDevice) {
        const text = "❌ Daily entry can only be saved on the store device / store network.";
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      if (hasNightRecord && !canCorrectClose) {
        const text = "❌ You can view this submitted Daily Close, but you cannot correct it for this date or submitter.";
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      if (hasNightRecord && !nightRevision) {
        const text = "❌ The saved Daily Close revision could not be verified. Refresh before saving a correction.";
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      if (morningDirty) {
        const text = "❌ Save or discard the pending Morning Cashup changes before submitting Daily Close.";
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      const cashSalesValidation = parseNonnegativeMoney(cashSalesText);
      if (cashSalesValidation.error) {
        const text = "❌ " + moneyValidationMessage("CASH Sales", cashSalesValidation);
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      const eftposSalesValidation = parseNonnegativeMoney(eftposSalesText);
      if (eftposSalesValidation.error) {
        const text = "❌ " + moneyValidationMessage("EFTPOS Sales", eftposSalesValidation);
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      const seenCanonicalPlatforms = new Set<string>();
      const platformInstructions: {
        platform: string;
        action: "SET";
        gross_income: number;
      }[] = [];

      for (const platform of platforms) {
        const canonicalName = canonicalPlatformName(platform.name);
        if (seenCanonicalPlatforms.has(canonicalName)) {
          throw new Error(`Duplicate canonical platform: ${canonicalName}`);
        }
        seenCanonicalPlatforms.add(canonicalName);

        const validation = parseNonnegativeMoney(platformGrossText[canonicalName]);
        if (validation.error) {
          const text = "❌ " + moneyValidationMessage(`${platform.name} platform income`, validation);
          setMsg(text);
          setClosingSaveState("error");
          setClosingSaveError(text);
          return false;
        }

        platformInstructions.push({
          platform: canonicalName,
          action: "SET",
          gross_income: round2(validation.value),
        });
      }

      if (needReason() && !nightRecountAcknowledged) {
        setNightRecountAcknowledged(true);
        setClosingSaveState("idle");
        setMsg(
          `⚠️ POS cash differs from counted daily cash movement by ${money(
            cashVariance
          )}. Recount the Night till, then submit again if the count is correct.`
        );
        return false;
      }

      if (Math.abs(removedVsShouldDiff) >= EPS && !removedRecountAcknowledged) {
        setRemovedRecountAcknowledged(true);
        setClosingSaveState("idle");
        setMsg(
          `⚠️ Removed cash differs from the ${money(
            targetRemovedCash
          )} target by ${money(removedVsShouldDiff)}. Recount the removed cash, then submit again if the physical count is correct.`
        );
        return false;
      }

      if (needReason() && !cashDiffReason) {
        const text = "❌ Choose a cash difference reason after completing the Night recount.";
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      if (needReason() && cashDiffReason === "OTHER" && !cashDiffNote.trim()) {
        const text = "❌ Enter a note when the cash difference reason is Other.";
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      const changedExistingPlatforms = platformInstructions.filter((instruction) =>
        Object.prototype.hasOwnProperty.call(existingPlatformGross, instruction.platform) &&
        existingPlatformGross[instruction.platform] !== instruction.gross_income
      );

      let confirmFeeRecalculation = false;
      if (changedExistingPlatforms.length > 0) {
        confirmFeeRecalculation = window.confirm(
          `Changing ${changedExistingPlatforms
            .map((instruction) => instruction.platform)
            .join(", ")} will recalculate fees using current fee settings. Continue?`
        );
        if (!confirmFeeRecalculation) {
          setClosingSaveState("idle");
          setMsg("ℹ️ Daily Close was not submitted. Platform fee recalculation was not confirmed.");
          return false;
        }
      }

      const payload = {
        business_date: date,
        store_id: DEFAULT_STORE_ID,
        night_counts: countsToStoredJson(nightCounts),
        removed_counts: countsToStoredJson(removedCounts),
        cash_sales: round2(cashSalesValidation.value),
        eftpos_sales: round2(eftposSalesValidation.value),
        cash_difference: {
          reason: needReason() ? cashDiffReason : "",
          note: needReason() ? cashDiffNote.trim() : "",
        },
        platforms: platformInstructions,
        expected_night_updated_at: hasNightRecord ? nightRevision : null,
        confirm_fee_recalculation: confirmFeeRecalculation,
        notes,
      };

      const rpcName = hasNightRecord ? "correct_daily_close" : "submit_daily_close";
      const result = await supabase.rpc(rpcName, {
        p_payload: payload,
      });

      if (result.error) {
        if (result.error.message.includes("DAILY_CLOSE_REVISION_CONFLICT")) {
          const conflictReload = await loadExisting({ restoreDraft: false });
          setActiveTab("closing");
          const conflictText = conflictReload.fullyLoaded
            ? "⚠️ This cashup changed since you opened it. Latest values have been reloaded."
            : "⚠️ This cashup changed since you opened it, but the latest values could not be reloaded. Please refresh before editing.";
          setMsg(conflictText);
          setClosingSaveState("error");
          setClosingSaveError(conflictText);
          return false;
        }
        const text = "❌ Daily Close failed: " + friendlyRpcError(result.error.message);
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      const committed = result.data as DailyCloseResult;
      localStorage.removeItem(draftKey);
      setActiveTab("closing");
      if (!hasNightRecord) {
        setHasNightRecord(true);
        setNightRevision(committed?.night_updated_at ?? null);
      }

      let reloadResult: LoadExistingResult = {
        nightExists: false,
        fullyLoaded: false,
      };
      try {
        reloadResult = await loadExisting({ restoreDraft: false });
      } catch (reloadError) {
        console.log("reload committed Daily Close error:", reloadError);
      }

      if (!reloadResult.fullyLoaded || !reloadResult.nightExists) {
        setHasNightRecord(true);
        setNightRevision(committed?.night_updated_at ?? null);
        setClosingSaveState("saved");
        setClosingLastSavedAt(new Date().toISOString());
        setMsg(
          `⚠️ Daily Close was ${hasNightRecord ? "corrected" : "submitted"} successfully, but the saved snapshot could not be reloaded. Please refresh before making another change.`
        );
        return true;
      }

      setClosingDirty(false);
      setClosingSaveState("saved");
      setClosingLastSavedAt(new Date().toISOString());
      setMsg(`✅ Daily Close ${hasNightRecord ? "correction saved" : "submitted"}.`);

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Daily Close error";
      const text = "❌ Daily Close failed: " + friendlyRpcError(message);
      setMsg(text);
      setClosingSaveState("error");
      setClosingSaveError(text);
      return false;
    } finally {
      closingSavingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!initialLoadDoneRef.current) return;
    if (nightReadStatus !== "loaded") return;
    if (hasNightRecord) return;

    const draft = {
      cashSalesText,
      eftposSalesText,
      notes,
      platformGrossText,
      morningCounts,
      nightCounts,
      removedCounts,
      cashDiffReason,
      cashDiffNote,
    };

    localStorage.setItem(draftKey, JSON.stringify(draft));
  }, [
    draftKey,
    cashSalesText,
    eftposSalesText,
    notes,
    platformGrossText,
    morningCounts,
    nightCounts,
    removedCounts,
    cashDiffReason,
    cashDiffNote,
    hasNightRecord,
    nightReadStatus,
  ]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!(morningDirty || closingDirty || morningSavingRef.current || closingSavingRef.current)) return;
      e.preventDefault();
      e.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [morningDirty, closingDirty]);

  function handleBackHome() {
    if (morningDirty || closingDirty || morningSavingRef.current || closingSavingRef.current) {
      setMsg("❌ You have unsaved changes. Save them or refresh to discard them before going back home.");
      return;
    }
    window.location.href = "/staff/home";
  }

  function saveBadge(state: SaveState, dirty: boolean, errorText: string, lastSavedAt: string | null) {
    if (state === "saving") {
      return (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            background: "#DBEAFE",
            color: "#1D4ED8",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          Saving...
        </div>
      );
    }

    if (state === "error") {
      return (
        <div
          title={errorText || "Save failed"}
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            background: "#FEE2E2",
            color: "#991B1B",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          Save failed
        </div>
      );
    }

    if (dirty) {
      return (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            background: "#FEF3C7",
            color: "#92400E",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          Unsaved changes
        </div>
      );
    }

    if (state === "saved" || lastSavedAt) {
      return (
        <div
          style={{
            padding: "8px 12px",
            borderRadius: 999,
            background: "#DCFCE7",
            color: "#166534",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          Saved
        </div>
      );
    }

    return undefined;
  }

  function sectionCard(
    title: string,
    children: React.ReactNode,
    rightBadge?: React.ReactNode,
    variant: "inner" | "main" = "inner"
  ) {
    return (
      <div
        style={{
          border: `1px solid ${variant === "main" ? "#E0E5EC" : "#E5E9EF"}`,
          borderRadius: variant === "main" ? 16 : 12,
          background: variant === "main" ? "#FFFFFF" : "#F8FAFC",
          padding: variant === "main" ? "clamp(16px, 3vw, 24px)" : 16,
          marginBottom: 16,
          boxShadow: variant === "main" ? "0 8px 28px rgba(24, 39, 75, 0.06)" : "none",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 10,
          }}
        >
          <h2 style={{ margin: 0, color: TEXT, fontSize: 18 }}>{title}</h2>
          {rightBadge}
        </div>
        {children}
      </div>
    );
  }

  function moneyBadge(label: string, value: string, color?: string) {
    return (
      <div
        style={{
          padding: "9px 11px",
          minWidth: 108,
          flex: "1 1 108px",
          borderRadius: 10,
          background: "#F0F4F8",
          border: "1px solid #E3E8EF",
        }}
      >
        <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
        <div style={{ fontWeight: 800, fontSize: 16, color: color || TEXT, marginTop: 2 }}>{value}</div>
      </div>
    );
  }

  function warningCallout(children: React.ReactNode) {
    return (
      <div
        style={{
          border: "1px solid #FECACA",
          background: "#FFF5F5",
          color: "#991B1B",
          borderRadius: 10,
          padding: "9px 11px",
          fontSize: 13,
          fontWeight: 700,
          lineHeight: 1.4,
          marginBottom: 12,
        }}
      >
        ⚠ {children}
      </div>
    );
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
          minHeight: 46,
          borderRadius: 12,
          border: `1px solid ${borderColor}`,
          background: bg,
          color: textColor,
          fontWeight: 800,
          fontSize: 15,
          fontFamily: FONT_STACK,
          cursor: disabled ? "not-allowed" : "pointer",
          boxShadow: primary || danger ? "0 8px 18px rgba(0,0,0,0.10)" : "none",
        }}
      >
        {label}
      </button>
    );
  }

  function renderDenomGrid(
    counts: CashCounts,
    setCounts: React.Dispatch<React.SetStateAction<CashCounts>>,
    section: "morning" | "night" | "removed"
  ) {
    const readOnly = section === "morning" ? morningReadOnly : closingReadOnly;
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(158px, 1fr))",
          gap: "10px 12px",
        }}
      >
        {denomFields.map(({ label, key, value }) => (
          <div
            key={key}
            style={{
              padding: 10,
              border: "1px solid #E2E7EE",
              borderRadius: 10,
              background: "#FFFFFF",
            }}
          >
            <div
              style={{
                fontSize: 13,
                color: TEXT,
                fontWeight: 600,
                marginBottom: 5,
                lineHeight: 1.3,
              }}
            >
              {label.replace(" notes", "").replace(" coins", "")}
            </div>

            <input
              className="cashup-input"
              value={counts[key] ?? ""}
              onChange={(e) => setCountsField(setCounts, key, e.target.value, section)}
              disabled={readOnly}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "9px 10px",
                borderRadius: 8,
                border: "1px solid #D6DAE1",
                fontSize: 16,
                background: "#fff",
                fontFamily: FONT_STACK,
              }}
              inputMode="numeric"
            />
            <div style={{ marginTop: 4, fontSize: 12, color: MUTED, fontWeight: 700 }}>
              = {money(round2((counts[key] ?? 0) * value))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const snapshotLoaded = morningReadStatus === "loaded" && nightReadStatus === "loaded";
  const morningReadOnly = !isStoreDevice || !snapshotLoaded || hasNightRecord;
  const closingReadOnly = !isStoreDevice || !snapshotLoaded || (hasNightRecord && !canCorrectClose);
  const closingStatus = nightReadStatus !== "loaded"
    ? "Checking"
    : hasNightRecord
    ? canCorrectClose
      ? "Submitted · Editing correction"
      : "Submitted · View only"
    : "Not submitted";

  return (
    <div
      style={{
        background: WAK_BG,
        minHeight: "100vh",
        padding: "16px clamp(12px, 3vw, 28px) 32px",
        fontFamily: FONT_STACK,
        color: TEXT,
      }}
    >
      <div style={{ maxWidth: 1160, margin: "0 auto" }}>
        <div
          className="cashup-header"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 20,
            flexWrap: "wrap",
            marginBottom: 14,
            padding: "16px 18px",
            background: "#FFFFFF",
            border: "1px solid #E0E5EC",
            borderRadius: 14,
            boxShadow: "0 6px 22px rgba(24, 39, 75, 0.06)",
          }}
        >
          <div>
            <h1 style={{ margin: 0, color: TEXT, fontSize: 28 }}>Daily Cashup</h1>
            <div style={{ marginTop: 3, color: MUTED, fontSize: 13 }}>{businessDateLabel(date)} · {activeTab === "morning"
              ? hasMorningRecord ? "Morning saved" : "Morning not saved"
              : closingStatus}</div>
            <div style={{ marginTop: 7 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "4px 9px",
                  borderRadius: 999,
                  background: storeAccessLoading ? "#F3F4F6" : isStoreDevice ? "#DCFCE7" : "#FEF3C7",
                  color: storeAccessLoading ? MUTED : isStoreDevice ? "#166534" : "#92400E",
                  fontSize: 12,
                  fontWeight: 800,
                }}
              >
                {storeAccessLoading
                  ? "Checking access"
                  : isStoreDevice
                  ? callerRole === "OWNER" ? "Owner access" : "Store network"
                  : `Access not verified${detectedIp ? ` · ${detectedIp}` : ""}`}
              </span>
            </div>
          </div>

          <div className="cashup-header-actions" style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Business date</div>
              <input
                className="cashup-input"
                type="date"
                value={date}
                onChange={(e) => {
                  const nextDate = e.target.value;
                  selectedDateRef.current = nextDate;
                  manualTabDateRef.current = null;
                  defaultTabPendingDateRef.current = nextDate;
                  setDate(nextDate);
                }}
                disabled={loading}
                style={{
                  padding: "9px 11px",
                  borderRadius: 9,
                  border: `1px solid ${BORDER}`,
                  fontSize: 15,
                  background: "#fff",
                  fontFamily: FONT_STACK,
                }}
              />
            </div>

            {actionButton("Refresh", () => loadExisting({ restoreDraft: false, selectDefaultTab: true }), { disabled: loading })}
            {actionButton("← Back to Home", handleBackHome, { disabled: loading })}
            {loading && <span style={{ color: MUTED, fontWeight: 600 }}>Loading...</span>}
          </div>
        </div>

        {nightReadStatus === "loading" && (
          <div style={{ border: "1px solid #BFDBFE", background: "#EFF6FF", padding: "12px 14px",
            borderRadius: 12, marginBottom: 16, color: TEXT }}>
            Checking whether this day has already been closed. Editing and saving are disabled until the check completes.
          </div>
        )}

        {nightReadStatus === "error" && (
          <div style={{ border: "1px solid #FECACA", background: "#FEF2F2", padding: "12px 14px",
            borderRadius: 12, marginBottom: 16, color: WAK_RED }}>
            We could not verify whether this day has already been closed. Please use Refresh and try again before making changes.
          </div>
        )}

        {msg && msg !== "✅ Daily Cashup loaded." && (
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

        <div style={{ display: "inline-flex", gap: 4, marginBottom: 14, padding: 4, borderRadius: 11, background: "#E9EDF3", border: "1px solid #E0E5EC" }}>
          {(["morning", "closing"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                manualTabDateRef.current = date;
                defaultTabPendingDateRef.current = null;
                setActiveTab(tab);
              }}
              style={{
                border: activeTab === tab ? "1px solid #D7E2F0" : "1px solid transparent",
                borderRadius: 8,
                background: activeTab === tab ? "#FFFFFF" : "transparent",
                color: activeTab === tab ? WAK_BLUE : MUTED,
                padding: "9px 18px",
                fontSize: 15,
                fontWeight: 800,
                fontFamily: FONT_STACK,
                cursor: "pointer",
                boxShadow: activeTab === tab ? "0 2px 6px rgba(24, 39, 75, 0.08)" : "none",
              }}
            >
              {tab === "morning" ? "Morning" : "Closing"}
            </button>
          ))}
        </div>

        {activeTab === "morning" && sectionCard(
          "Morning Cashup",
          <>
            <div style={{ color: MUTED, fontSize: 13, marginBottom: 10 }}>
              Count the actual cash in the till. Target float: {money(DEFAULT_FLOAT_IF_NO_MORNING)}.
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
              {moneyBadge("Counted", money(morningTotal))}
              {moneyBadge("Target", money(DEFAULT_FLOAT_IF_NO_MORNING))}
              {moneyBadge(
                "Difference",
                money(round2(morningTotal - DEFAULT_FLOAT_IF_NO_MORNING)),
                Math.abs(morningTotal - DEFAULT_FLOAT_IF_NO_MORNING) < EPS ? "#15803D" : WAK_RED
              )}
            </div>
            {morningReadStatus !== "loaded" && (
              warningCallout(morningReadStatus === "error" ? "Saved Morning Cashup could not be loaded." : "Checking saved Morning Cashup...")
            )}
            {morningRecountAcknowledged && Math.abs(morningTotal - DEFAULT_FLOAT_IF_NO_MORNING) >= EPS && (
              warningCallout(<>Recount acknowledged. Save again to keep the actual {money(morningTotal)} count.</>)
            )}
            {renderDenomGrid(morningCounts, setMorningCounts, "morning")}
            <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              {saveBadge(morningSaveState, morningDirty, morningSaveError, morningLastSavedAt)}
              {actionButton("Save Morning", () => saveMorning(), {
                primary: true,
                disabled: loading || morningReadOnly || storeAccessLoading || morningSavingRef.current,
              })}
            </div>
          </>,
          undefined,
          "main"
        )}

        {activeTab === "closing" && (
          <>
            <div
              style={{
                background: "#FFFFFF",
                border: "1px solid #E0E5EC",
                borderRadius: 16,
                boxShadow: "0 8px 28px rgba(24, 39, 75, 0.06)",
                padding: "clamp(14px, 2.5vw, 22px)",
              }}
            >
            <div
              className="closing-grid"
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 7fr) minmax(0, 3fr)",
                gap: "0 clamp(16px, 3vw, 28px)",
                alignItems: "start",
              }}
            >
              <div>
                {sectionCard(
                  "Till Count",
                  <>
                    {morningReadStatus === "loaded" && !hasMorningRecord && (
                      warningCallout("No Morning Cashup. Closing uses the default $400 opening float, so variance may not reflect today accurately.")
                    )}
                    {morningReadStatus === "error" && (
                      warningCallout("Morning Cashup could not be loaded. Refresh before closing.")
                    )}
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                      {moneyBadge("Night total", money(nightTotal))}
                      {morningReadStatus === "loaded" && moneyBadge("Opening float", money(baselineMorningTotal))}
                      {morningReadStatus === "loaded" && moneyBadge("Cash movement", money(countedDailyCashMovement), WAK_BLUE)}
                      {moneyBadge("Target removal", money(targetRemovedCash), WAK_BLUE)}
                    </div>
                    {nightTotal < DEFAULT_FLOAT_IF_NO_MORNING && (
                      warningCallout(<>Till is {money(DEFAULT_FLOAT_IF_NO_MORNING - nightTotal)} below the next-day float. Remove {money(0)}.</>)
                    )}
                    {nightRecountAcknowledged && needReason() && (
                      warningCallout("Recount acknowledged. Add a difference reason before saving.")
                    )}
                    {renderDenomGrid(nightCounts, setNightCounts, "night")}
                  </>,
                  saveBadge(closingSaveState, closingDirty, closingSaveError, closingLastSavedAt)
                )}

                {sectionCard(
                  "Cash Removed",
                  <>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                      {moneyBadge("Removed", money(removedTotal))}
                      {moneyBadge("Target", money(targetRemovedCash))}
                      {moneyBadge("Difference", money(removedVsShouldDiff), Math.abs(removedVsShouldDiff) < EPS ? "#15803D" : WAK_RED)}
                      {moneyBadge("Closing float", money(projectedClosingFloat), Math.abs(closingFloatVariance) < EPS ? TEXT : WAK_RED)}
                    </div>
                    {removedRecountAcknowledged && Math.abs(removedVsShouldDiff) >= EPS && (
                      warningCallout("Recount acknowledged. The actual removed count and closing-float difference will be saved.")
                    )}
                    {renderDenomGrid(removedCounts, setRemovedCounts, "removed")}
                  </>
                )}
              </div>

              <div>
                {sectionCard(
                  "Sales",
                  <>
                    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 10 }}>
                      <label style={{ fontSize: 13, color: TEXT, fontWeight: 700 }}>
                        CASH Sales
                        <input
                          className="cashup-input"
                          value={cashSalesText}
                          disabled={closingReadOnly}
                          onChange={(e) => {
                            setCashSalesText(e.target.value);
                            markClosingDirtyStyleOnly();
                          }}
                          style={{ width: "100%", boxSizing: "border-box", marginTop: 5, padding: "10px 11px", borderRadius: 9, border: "1px solid #D6DAE1", fontSize: 16, background: "#fff", fontFamily: FONT_STACK }}
                        />
                      </label>
                      <label style={{ fontSize: 13, color: TEXT, fontWeight: 700 }}>
                        EFTPOS Sales
                        <input
                          className="cashup-input"
                          value={eftposSalesText}
                          disabled={closingReadOnly}
                          onChange={(e) => {
                            setEftposSalesText(e.target.value);
                            markClosingDirtyStyleOnly();
                          }}
                          style={{ width: "100%", boxSizing: "border-box", marginTop: 5, padding: "10px 11px", borderRadius: 9, border: "1px solid #D6DAE1", fontSize: 16, background: "#fff", fontFamily: FONT_STACK }}
                        />
                      </label>
                    </div>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
                      {moneyBadge("Instore", money(instoreSubtotal))}
                      {morningReadStatus === "loaded" && moneyBadge("POS cash difference", money(cashVariance), Math.abs(cashVariance) < EPS ? "#15803D" : WAK_RED)}
                    </div>
                    <label style={{ display: "block", fontSize: 13, color: TEXT, fontWeight: 700 }}>
                      Notes <span style={{ color: MUTED, fontWeight: 500 }}>(optional)</span>
                      <textarea
                        className="cashup-input"
                        value={notes}
                        disabled={closingReadOnly}
                        onChange={(e) => {
                          setNotes(e.target.value);
                          markClosingDirtyStyleOnly();
                        }}
                        rows={2}
                        style={{ width: "100%", boxSizing: "border-box", marginTop: 5, padding: "9px 11px", borderRadius: 9, border: "1px solid #D6DAE1", fontSize: 15, background: "#fff", resize: "vertical", fontFamily: FONT_STACK }}
                      />
                    </label>
                  </>
                )}

                {sectionCard(
                  "Online Platforms",
                  platforms.length === 0 ? (
                    <div style={{ color: MUTED, fontSize: 13 }}>No platforms configured.</div>
                  ) : (
                    <>
                      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                        {platforms.map((p) => (
                          <label key={p.id} style={{ fontSize: 13, color: TEXT, fontWeight: 700 }}>
                            {platformDisplayName(p.name)} {!p.is_active && <span style={{ color: MUTED, fontWeight: 500 }}>(inactive)</span>}
                            <input
                              className="cashup-input"
                              value={platformGrossText[canonicalPlatformName(p.name)] ?? ""}
                              disabled={closingReadOnly}
                              onChange={(e) => {
                                const canonicalName = canonicalPlatformName(p.name);
                                setPlatformGrossText((prev) => ({ ...prev, [canonicalName]: e.target.value }));
                                markClosingDirtyStyleOnly();
                              }}
                              style={{ width: "100%", boxSizing: "border-box", marginTop: 5, padding: "10px 11px", borderRadius: 9, border: "1px solid #D6DAE1", fontSize: 15, background: "#fff", fontFamily: FONT_STACK }}
                            />
                          </label>
                        ))}
                      </div>
                      <div style={{ marginTop: 10 }}>{moneyBadge("Online subtotal", money(onlineSubtotal))}</div>
                    </>
                  )
                )}

                {needReason() && sectionCard(
                  "Cash Difference",
                  <div style={{ border: "1px solid #FECACA", borderLeft: `4px solid ${WAK_RED}`, borderRadius: 10, background: "#FFF5F5", padding: 12 }}>
                    <div style={{ color: WAK_RED, fontWeight: 800, fontSize: 13, marginBottom: 10 }}>
                      Difference: {money(cashVariance)}. Recount the till before choosing a reason.
                    </div>
                    {(nightRecountAcknowledged || hasNightRecord) && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <label style={{ fontSize: 13, color: TEXT, fontWeight: 700 }}>
                          Reason
                          <select
                            className="cashup-input"
                            value={cashDiffReason}
                            disabled={closingReadOnly}
                            onChange={(e) => {
                              setCashDiffReason(e.target.value as CashDiffReason);
                              markClosingDirtyStyleOnly();
                            }}
                            style={{ width: "100%", boxSizing: "border-box", marginTop: 5, padding: "10px 11px", borderRadius: 9, border: "1px solid #D6DAE1", fontSize: 14, background: "#fff", fontFamily: FONT_STACK }}
                          >
                            <option value="">-- Select a reason --</option>
                            <option value="FLOAT_CHANGED">Cash left in till / float changed</option>
                            <option value="CASH_REFUND_OR_PAYOUT">Cash paid out / refunds</option>
                            <option value="CASH_DROP_NOT_COUNTED">Cash drop not counted (safe/other)</option>
                            <option value="COUNTING_MISTAKE">Counting mistake</option>
                            <option value="POS_CASH_ADJUSTMENT">POS cash incorrect / adjustment</option>
                            <option value="OTHER">Other</option>
                          </select>
                        </label>
                        <label style={{ fontSize: 13, color: TEXT, fontWeight: 700 }}>
                          Note {cashDiffReason === "OTHER" ? "(required)" : "(optional)"}
                          <input
                            className="cashup-input"
                            value={cashDiffNote}
                            disabled={closingReadOnly}
                            onChange={(e) => {
                              setCashDiffNote(e.target.value);
                              markClosingDirtyStyleOnly();
                            }}
                            style={{ width: "100%", boxSizing: "border-box", marginTop: 5, padding: "10px 11px", borderRadius: 9, border: "1px solid #D6DAE1", fontSize: 14, background: "#fff", fontFamily: FONT_STACK }}
                          />
                        </label>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 16,
                flexWrap: "wrap",
                marginTop: 14,
                padding: "14px 16px",
                background: "#EEF4FB",
                border: "1px solid #D9E5F3",
                borderRadius: 12,
              }}
            >
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {moneyBadge("Instore", money(instoreSubtotal))}
                {moneyBadge("Online", money(onlineSubtotal))}
                {moneyBadge("Grand total", money(total), WAK_BLUE)}
              </div>
              {(!hasNightRecord || canCorrectClose) && actionButton(
                hasNightRecord ? "Save Correction" : "Submit Daily Close",
                () => saveClosingAndSales(),
                {
                  primary: true,
                  disabled: loading || closingReadOnly || (hasNightRecord && !nightRevision) || morningReadStatus !== "loaded" || storeAccessLoading || closingSavingRef.current,
                }
              )}
            </div>
            </div>
          </>
        )}
        <style jsx>{`
          .cashup-input {
            transition: border-color 140ms ease, box-shadow 140ms ease;
          }
          .cashup-input:focus {
            outline: none;
            border-color: ${WAK_BLUE} !important;
            box-shadow: 0 0 0 3px rgba(30, 90, 158, 0.13);
          }
          @media (max-width: 800px) {
            .closing-grid {
              grid-template-columns: minmax(0, 1fr) !important;
            }
          }
          @media (max-width: 620px) {
            .cashup-header-actions {
              width: 100%;
            }
          }
        `}</style>
      </div>
    </div>
  );
}
