import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const DEFAULT_STORE_ID = "MOOROOLBARK";
const DEFAULT_FLOAT_IF_NO_MORNING = 400;
const EPS = 0.01;

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

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

function todayDateInputValue() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function money(n: number) {
  return n.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
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

const denomFields: { label: string; key: keyof CashCounts }[] = [
  { label: "$100 notes", key: "note100" },
  { label: "$50 notes", key: "note50" },
  { label: "$20 notes", key: "note20" },
  { label: "$10 notes", key: "note10" },
  { label: "$5 notes", key: "note5" },
  { label: "$2 coins", key: "coin2" },
  { label: "$1 coins", key: "coin1" },
  { label: "50c coins", key: "coin50c" },
  { label: "20c coins", key: "coin20c" },
  { label: "10c coins", key: "coin10c" },
  { label: "5c coins", key: "coin5c" },
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
  return message;
}

export default function DailyEntryPage() {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const [storeAccessLoading, setStoreAccessLoading] = useState(true);
  const [isStoreDevice, setIsStoreDevice] = useState(false);
  const [detectedIp, setDetectedIp] = useState("");

  const [date, setDate] = useState(todayDateInputValue());
  const draftKey = `daily-entry-draft-${date}`;

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
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;

        const res = await fetch("/api/check-store-access", {
          headers: token
            ? {
                Authorization: `Bearer ${token}`,
              }
            : {},
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
        window.location.href = "/staff/home";
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

  async function loadPlatforms() {
    const res = await supabase
      .from("platforms")
      .select("id, name, is_active, sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (res.error) {
      setPlatforms([]);
      return {
        list: [] as Platform[],
        errorMessage: "Cannot load platforms: " + res.error.message,
      };
    }

    const list = (res.data ?? []) as Platform[];
    setPlatforms(list);
    return { list, errorMessage: null };
  }

  async function loadExisting(options?: { restoreDraft?: boolean }): Promise<LoadExistingResult> {
    const restoreDraft = options?.restoreDraft ?? true;
    const loadErrors: string[] = [];

    setLoading(true);
    setMsg("");
    setMorningRead({ date, status: "loading" });
    setNightRead({ date, status: "loading" });
    initialLoadDoneRef.current = false;

    try {
      const platformLoad = await loadPlatforms();
      let loadedPlatforms = platformLoad.list;
      if (platformLoad.errorMessage) {
        loadErrors.push(platformLoad.errorMessage);
      }

      const ds = await supabase
        .from("daily_sales")
        .select("business_date, cash_sales, eftpos_sales, notes")
        .eq("business_date", date)
        .eq("store_id", DEFAULT_STORE_ID)
        .maybeSingle();

      const dailySalesLoaded = !ds.error || ds.error.code === "PGRST116";
      if (!dailySalesLoaded) {
        loadErrors.push("Cannot load instore sales: " + ds.error.message);
      }

      const row = ds.data;
      const cashVal = row?.cash_sales;
      const eftVal = row?.eftpos_sales;

      const serverCashSalesText = cashVal == null ? "" : String(cashVal);
      const serverEftposSalesText = eftVal == null ? "" : String(eftVal);
      const serverNotes = row?.notes ?? "";

      const pi = await supabase
        .from("platform_income")
        .select("business_date, platform, gross_income")
        .eq("business_date", date)
        .eq("store_id", DEFAULT_STORE_ID);

      let serverPlatformGrossText: Record<string, string> = {};
      let serverExistingPlatformGross: Record<string, number> = {};
      const platformIncomeLoaded = !pi.error;
      if (!platformIncomeLoaded) {
        loadErrors.push("Cannot load online sales: " + pi.error.message);
      } else {
        const map: Record<string, string> = {};
        const existingMap: Record<string, number> = {};
        const activeCanonicalNames = new Set(
          loadedPlatforms.map((platform) => canonicalPlatformName(platform.name))
        );
        const historicalPlatforms: Platform[] = [];

        for (const r of pi.data ?? []) {
          const rawPlatform = String(r.platform);
          const p = canonicalPlatformName(rawPlatform);
          const g = r.gross_income;
          const gross = Number(g);
          map[p] = Number.isFinite(gross) ? String(gross) : "0";
          existingMap[p] = Number.isFinite(gross) ? round2(gross) : 0;

          if (!activeCanonicalNames.has(p)) {
            activeCanonicalNames.add(p);
            historicalPlatforms.push({
              id: `historical-${p}`,
              name: p,
              is_active: false,
              sort_order: Number.MAX_SAFE_INTEGER,
            });
          }
        }
        loadedPlatforms = [...loadedPlatforms, ...historicalPlatforms];
        setPlatforms(loadedPlatforms);
        serverPlatformGrossText = map;
        serverExistingPlatformGross = existingMap;
      }

      const m = await supabase
        .from("cashup_sessions")
        .select("counts")
        .eq("business_date", date)
        .eq("store_id", DEFAULT_STORE_ID)
        .eq("session_type", "MORNING")
        .maybeSingle();

      const morningLoaded = !m.error;
      setMorningRead({ date, status: morningLoaded ? "loaded" : "error" });
      if (!morningLoaded) {
        loadErrors.push("Cannot load morning cashup: " + m.error.message);
      }

      const serverHasMorningRecord = !!m.data;
      const serverMorningCounts = m.data
        ? storedJsonToCounts(m.data.counts ?? {})
        : { ...emptyCounts };

      const n = await supabase
        .from("cashup_sessions")
        .select("counts, updated_at")
        .eq("business_date", date)
        .eq("store_id", DEFAULT_STORE_ID)
        .eq("session_type", "NIGHT")
        .maybeSingle();

      const nightLoaded = !n.error;
      setNightRead({ date, status: nightLoaded ? "loaded" : "error" });
      if (!nightLoaded) {
        loadErrors.push(
          "We couldn't verify whether this day has already been closed. Please try again before making changes. "
          + n.error.message
        );
      }

      const serverNightCounts = n.data
        ? storedJsonToCounts(n.data.counts ?? {})
        : { ...emptyCounts };

      const nightCountsRaw = asRecord(n.data?.counts);
      const removedRaw = nightCountsRaw._removed_counts ?? null;
      const reasonRaw = nightCountsRaw._cash_diff_reason ?? "";
      const noteRaw = nightCountsRaw._cash_diff_note ?? "";

      const serverRemovedCounts = removedRaw
        ? storedJsonToCounts(removedRaw)
        : { ...emptyCounts };

      const serverCashDiffReason = ((reasonRaw as CashDiffReason) || "") as CashDiffReason;
      const serverCashDiffNote = String(noteRaw ?? "");

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
          ? calcTotal(serverMorningCounts)
          : DEFAULT_FLOAT_IF_NO_MORNING
      );
      if (nightLoaded) {
        setHasNightRecord(!!n.data);
        setNightRevision(n.data?.updated_at ?? null);
      }
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

      const fullyLoaded =
        platformLoad.errorMessage === null &&
        dailySalesLoaded &&
        platformIncomeLoaded &&
        morningLoaded &&
        nightLoaded;

      if (loadErrors.length > 0) {
        setMsg("❌ " + loadErrors.join(" "));
      } else {
        setMsg(
          n.data
            ? "ℹ️ This Daily Close has already been submitted and is read-only."
            : "✅ Loaded saved data for this date."
        );
      }

      if (restoreDraft && fullyLoaded && !n.data) {
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
        nightExists: nightLoaded && !!n.data,
        fullyLoaded,
      };
    } catch (error) {
      setMorningRead((current) => current.date === date && current.status === "loaded"
        ? current : { date, status: "error" });
      setNightRead({ date, status: "error" });
      setMsg(
        "❌ We couldn't verify whether this day has already been closed. Please try again before making changes. "
        + (error instanceof Error ? error.message : "Unexpected load failure")
      );
      return { nightExists: false, fullyLoaded: false };
    } finally {
      setLoading(false);
      initialLoadDoneRef.current = true;
    }
  }

  useEffect(() => {
    loadExisting({ restoreDraft: true });
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

      morningServerSnapshotRef.current = buildMorningSnapshot(morningCounts);
      setMorningDirty(false);
      setHasMorningRecord(true);
      setMorningRead({ date, status: "loaded" });
      setSavedMorningTotal(morningTotal);
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

      if (hasNightRecord) {
        const text = "❌ This Daily Close has already been submitted and cannot be changed here.";
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
        expected_night_updated_at: null,
        confirm_fee_recalculation: confirmFeeRecalculation,
        notes,
      };

      const result = await supabase.rpc("submit_daily_close", {
        p_payload: payload,
      });

      if (result.error) {
        const text = "❌ Daily Close failed: " + friendlyRpcError(result.error.message);
        setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      const committed = result.data as DailyCloseResult;
      localStorage.removeItem(draftKey);
      setHasNightRecord(true);
      setNightRevision(committed?.night_updated_at ?? null);

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
          "⚠️ Daily Close was submitted successfully, but some saved data could not be reloaded. Do not submit again. Please refresh the page."
        );
        return true;
      }

      setClosingDirty(false);
      setClosingSaveState("saved");
      setClosingLastSavedAt(new Date().toISOString());
      setMsg("✅ Daily Close submitted successfully. Authoritative server data has been reloaded.");

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

  function sectionCard(title: string, children: React.ReactNode, rightBadge?: React.ReactNode) {
    return (
      <div
        style={{
          border: `1px solid ${BORDER}`,
          borderRadius: 16,
          background: CARD_BG,
          padding: 18,
          marginBottom: 16,
          boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 14,
          }}
        >
          <h2 style={{ margin: 0, color: TEXT, fontSize: 22 }}>{title}</h2>
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
          padding: "10px 12px",
          borderRadius: 12,
          background: "#F9FAFB",
          border: `1px solid ${BORDER}`,
          minWidth: 150,
        }}
      >
        <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
        <div style={{ fontWeight: 800, fontSize: 18, color: color || TEXT }}>{value}</div>
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
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 120px))",
          gap: 10,
          justifyContent: "start",
        }}
      >
        {denomFields.map(({ label, key }) => (
          <div
            key={key}
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 12,
              padding: 10,
              background: "#FAFAFA",
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: TEXT,
                fontWeight: 600,
                marginBottom: 8,
                lineHeight: 1.3,
                minHeight: 32,
              }}
            >
              {label}
            </div>

            <input
              value={counts[key] ?? ""}
              onChange={(e) => setCountsField(setCounts, key, e.target.value, section)}
              disabled={pageReadOnly}
              style={{
                width: 68,
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid #D1D5DB",
                fontSize: 15,
                background: "#fff",
              }}
              inputMode="numeric"
            />
          </div>
        ))}
      </div>
    );
  }

  const pageReadOnly = !isStoreDevice || hasNightRecord || nightReadStatus !== "loaded";

  return (
    <div
      style={{
        background: WAK_BG,
        minHeight: "100vh",
        padding: 20,
      }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 18,
          }}
        >
          <div>
            <h1 style={{ margin: 0, color: TEXT }}>Daily Closing Entry</h1>
            <div style={{ marginTop: 6, color: MUTED }}>
              Morning cashup, closing cashup, instore sales and online platforms
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Business date</div>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                disabled={loading}
                style={{
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: `1px solid ${BORDER}`,
                  fontSize: 15,
                  background: "#fff",
                }}
              />
            </div>

            {actionButton("Refresh", () => loadExisting({ restoreDraft: false }), { disabled: loading })}
            {actionButton("← Back to Home", handleBackHome, { disabled: loading })}
            {loading && <span style={{ color: MUTED, fontWeight: 600 }}>Loading...</span>}
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${isStoreDevice ? "#bbf7d0" : "#fed7aa"}`,
            background: isStoreDevice ? "#ecfdf5" : "#fff7ed",
            padding: "12px 14px",
            borderRadius: 12,
            marginBottom: 16,
            color: TEXT,
          }}
        >
          {storeAccessLoading
            ? "Checking store device access..."
            : isStoreDevice
            ? "✅ Store device/network verified. Draft changes stay in this browser until you explicitly submit."
            : `⚠️ Not on approved store device/network${detectedIp ? ` (IP: ${detectedIp})` : ""}. Saving is disabled.`}
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

        {nightReadStatus === "loaded" && hasNightRecord && (
          <div
            style={{
              border: "1px solid #BFDBFE",
              background: "#EFF6FF",
              padding: "12px 14px",
              borderRadius: 12,
              marginBottom: 16,
              color: TEXT,
            }}
          >
            <b>Daily Close submitted.</b> This page is read-only for the selected date.
            {nightRevision ? ` Revision: ${nightRevision}` : ""}
          </div>
        )}

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

        {sectionCard(
          "Morning Cashup (Open)",
          <>
            <div style={{ color: MUTED, fontSize: 14, marginBottom: 14, lineHeight: 1.6 }}>
              Count the actual cash physically in the till when opening. The target float is{" "}
              <b>{money(DEFAULT_FLOAT_IF_NO_MORNING)}</b>, but an over/short count is saved as counted after you recount it.
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              {moneyBadge("Morning total", money(morningTotal))}
              {moneyBadge(
                "Difference from $400 target",
                money(round2(morningTotal - DEFAULT_FLOAT_IF_NO_MORNING)),
                Math.abs(morningTotal - DEFAULT_FLOAT_IF_NO_MORNING) < EPS ? "#15803D" : WAK_RED
              )}
              {morningReadStatus === "loaded" ? moneyBadge(
                hasMorningRecord ? "Saved opening float" : "Close fallback if not saved",
                money(baselineMorningTotal),
                hasMorningRecord ? WAK_BLUE : WAK_RED
              ) : <div style={{ color: WAK_RED, fontWeight: 700 }}>
                {morningReadStatus === "error"
                  ? "Saved Morning Cashup could not be loaded; opening float is unverified."
                  : "Checking the saved Morning Cashup..."}
              </div>}
            </div>

            {morningRecountAcknowledged &&
              Math.abs(morningTotal - DEFAULT_FLOAT_IF_NO_MORNING) >= EPS && (
                <div style={{ color: WAK_RED, fontWeight: 700, marginBottom: 14 }}>
                  Recount acknowledged. Save again to preserve the actual {money(morningTotal)} opening count.
                </div>
              )}

            {renderDenomGrid(morningCounts, setMorningCounts, "morning")}

            <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
              {actionButton("Save Morning Cashup", () => saveMorning(), {
                primary: true,
                disabled: loading || pageReadOnly || storeAccessLoading || morningSavingRef.current,
              })}
            </div>
          </>,
          saveBadge(morningSaveState, morningDirty, morningSaveError, morningLastSavedAt)
        )}

        {sectionCard(
          "Closing Cashup (Close)",
          <>
            <div style={{ color: MUTED, fontSize: 14, marginBottom: 14, lineHeight: 1.6 }}>
              Daily cash movement uses <b>Night total − actual saved Morning float</b>. Cash removal separately targets a fixed closing float of{" "}
              <b>{money(DEFAULT_FLOAT_IF_NO_MORNING)}</b>.
            </div>

            {morningReadStatus === "loaded" && !hasMorningRecord && (
              <div style={{ color: WAK_RED, fontWeight: 700, marginBottom: 14, lineHeight: 1.5 }}>
                No Morning Cashup was recorded for this day. Daily Close will use the default $400 opening float.
                If the actual opening cash was different, the cash variance may not represent today&apos;s trading accurately.
              </div>
            )}

            {morningReadStatus === "error" && (
              <div style={{ color: WAK_RED, fontWeight: 700, marginBottom: 14 }}>
                Morning Cashup could not be loaded. The opening float and cash variance are unverified. Please use Refresh to try again.
              </div>
            )}

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              {moneyBadge("Night total", money(nightTotal))}
              {morningReadStatus === "loaded" && moneyBadge("Actual opening float", money(baselineMorningTotal))}
              {morningReadStatus === "loaded" && moneyBadge("Counted daily cash movement", money(countedDailyCashMovement), WAK_BLUE)}
              {moneyBadge("Target cash to remove", money(targetRemovedCash), WAK_BLUE)}
            </div>

            {nightTotal < DEFAULT_FLOAT_IF_NO_MORNING && (
              <div style={{ color: WAK_RED, fontWeight: 700, marginBottom: 14 }}>
                The Night till is {money(DEFAULT_FLOAT_IF_NO_MORNING - nightTotal)} below the required next-day float. Target removed cash is {money(0)}.
              </div>
            )}

            {nightRecountAcknowledged && needReason() && (
              <div style={{ color: WAK_RED, fontWeight: 700, marginBottom: 14 }}>
                Night recount acknowledged. Record a cash difference reason below before submitting.
              </div>
            )}

            {renderDenomGrid(nightCounts, setNightCounts, "night")}
          </>,
          saveBadge(closingSaveState, closingDirty, closingSaveError, closingLastSavedAt)
        )}

        {sectionCard(
          "Cash Removed",
          <>
            <div style={{ color: MUTED, fontSize: 14, marginBottom: 14, lineHeight: 1.6 }}>
              Count the cash you actually removed from the till.
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              {moneyBadge("Removed total", money(removedTotal))}
              {moneyBadge("Target removed cash", money(targetRemovedCash))}
              {moneyBadge(
                "Removed − target",
                money(removedVsShouldDiff),
                Math.abs(removedVsShouldDiff) < EPS ? "#15803D" : WAK_RED
              )}
              {moneyBadge("Projected closing float", money(projectedClosingFloat))}
              {moneyBadge(
                "Closing float difference",
                money(closingFloatVariance),
                Math.abs(closingFloatVariance) < EPS ? "#15803D" : WAK_RED
              )}
            </div>

            {removedRecountAcknowledged && Math.abs(removedVsShouldDiff) >= EPS && (
              <div style={{ color: WAK_RED, fontWeight: 700, marginBottom: 14 }}>
                Removed-cash recount acknowledged. Submission will preserve the actual physical count and its closing-float difference.
              </div>
            )}

            {renderDenomGrid(removedCounts, setRemovedCounts, "removed")}
          </>
        )}

        {sectionCard(
          "Instore",
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 16, color: TEXT, fontWeight: 600, marginBottom: 8 }}>
                CASH Sales (from POS)
              </div>
              <input
                value={cashSalesText}
                disabled={pageReadOnly}
                onChange={(e) => {
                  setCashSalesText(e.target.value);
                  markClosingDirtyStyleOnly();
                }}
                style={{
                  width: 260,
                  maxWidth: "100%",
                  boxSizing: "border-box",
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1px solid #D1D5DB",
                  fontSize: 16,
                  background: "#fff",
                }}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 16, color: TEXT, fontWeight: 600, marginBottom: 8 }}>
                EFTPOS Sales
              </div>
              <input
                value={eftposSalesText}
                disabled={pageReadOnly}
                onChange={(e) => {
                  setEftposSalesText(e.target.value);
                  markClosingDirtyStyleOnly();
                }}
                style={{
                  width: 260,
                  maxWidth: "100%",
                  boxSizing: "border-box",
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1px solid #D1D5DB",
                  fontSize: 16,
                  background: "#fff",
                }}
              />
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              {moneyBadge("Instore subtotal", money(instoreSubtotal))}
              {morningReadStatus === "loaded" && moneyBadge(
                "POS cash − counted movement",
                money(cashVariance),
                Math.abs(cashVariance) < EPS ? "#15803D" : WAK_RED
              )}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: TEXT, fontWeight: 600, marginBottom: 8 }}>
                Notes (optional)
              </div>
              <textarea
                value={notes}
                disabled={pageReadOnly}
                onChange={(e) => {
                  setNotes(e.target.value);
                  markClosingDirtyStyleOnly();
                }}
                rows={4}
                style={{
                  width: "100%",
                  maxWidth: 560,
                  boxSizing: "border-box",
                  padding: "12px 14px",
                  borderRadius: 12,
                  border: "1px solid #D1D5DB",
                  fontSize: 15,
                  background: "#fff",
                  resize: "vertical",
                }}
              />
            </div>

            <div
              style={{
                border: "1px dashed #D1D5DB",
                borderRadius: 14,
                padding: 14,
                background: "#FCFCFC",
              }}
            >
              <div style={{ fontWeight: 700, color: TEXT, marginBottom: 8 }}>Cash Difference Check</div>
              <div style={{ color: MUTED, marginBottom: needReason() ? 12 : 0 }}>
                If the difference is not zero, recount the Night till first. After confirming the recount, choose the actual reason; no reason is generated automatically.
              </div>

              {needReason() && (nightRecountAcknowledged || hasNightRecord) && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, color: TEXT, fontWeight: 600, marginBottom: 8 }}>Reason</div>
                    <select
                      value={cashDiffReason}
                      disabled={pageReadOnly}
                      onChange={(e) => {
                        setCashDiffReason(e.target.value as CashDiffReason);
                        markClosingDirtyStyleOnly();
                      }}
                      style={{
                        width: 320,
                        maxWidth: "100%",
                        padding: "12px 14px",
                        borderRadius: 12,
                        border: "1px solid #D1D5DB",
                        fontSize: 15,
                        background: "#fff",
                      }}
                    >
                      <option value="">-- Select a reason --</option>
                      <option value="FLOAT_CHANGED">Cash left in till / float changed</option>
                      <option value="CASH_REFUND_OR_PAYOUT">Cash paid out / refunds</option>
                      <option value="CASH_DROP_NOT_COUNTED">Cash drop not counted (safe/other)</option>
                      <option value="COUNTING_MISTAKE">Counting mistake</option>
                      <option value="POS_CASH_ADJUSTMENT">POS cash incorrect / adjustment</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>

                  <div>
                    <div style={{ fontSize: 13, color: TEXT, fontWeight: 600, marginBottom: 8 }}>
                      Note {cashDiffReason === "OTHER" ? "(required)" : "(optional)"}
                    </div>
                    <input
                      value={cashDiffNote}
                      disabled={pageReadOnly}
                      onChange={(e) => {
                        setCashDiffNote(e.target.value);
                        markClosingDirtyStyleOnly();
                      }}
                      style={{
                        width: 420,
                        maxWidth: "100%",
                        boxSizing: "border-box",
                        padding: "12px 14px",
                        borderRadius: 12,
                        border: "1px solid #D1D5DB",
                        fontSize: 15,
                        background: "#fff",
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          </>,
          saveBadge(closingSaveState, closingDirty, closingSaveError, closingLastSavedAt)
        )}

        {sectionCard(
          "Online Platform",
          platforms.length === 0 ? (
            <div style={{ color: MUTED }}>
              No platforms configured (Owner can add platforms in Manager → Platforms).
            </div>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {platforms.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      border: `1px solid ${BORDER}`,
                      borderRadius: 12,
                      padding: 12,
                      background: "#FAFAFA",
                      maxWidth: 360,
                    }}
                  >
                    <div style={{ fontSize: 13, color: TEXT, fontWeight: 700, marginBottom: 8 }}>
                      {p.name} {!p.is_active ? "(historical/inactive)" : ""}
                    </div>
                    <input
                      value={platformGrossText[canonicalPlatformName(p.name)] ?? ""}
                      disabled={pageReadOnly}
                      onChange={(e) => {
                        const canonicalName = canonicalPlatformName(p.name);
                        setPlatformGrossText((prev) => ({ ...prev, [canonicalName]: e.target.value }));
                        markClosingDirtyStyleOnly();
                      }}
                      style={{
                        width: 220,
                        maxWidth: "100%",
                        boxSizing: "border-box",
                        padding: "12px 14px",
                        borderRadius: 12,
                        border: "1px solid #D1D5DB",
                        fontSize: 15,
                        background: "#fff",
                      }}
                    />
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 16 }}>
                {moneyBadge("Online subtotal", money(onlineSubtotal))}
              </div>
            </>
          )
        )}

        {sectionCard(
          "Total Summary",
          <>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
              {moneyBadge("Instore subtotal", money(instoreSubtotal))}
              {moneyBadge("Online subtotal", money(onlineSubtotal))}
              {moneyBadge("Grand total", money(total), WAK_BLUE)}
            </div>

            <div style={{ fontSize: 13, color: MUTED, marginBottom: 18 }}>
              Total is auto-calculated from instore + online.
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              {actionButton("Submit Daily Close", () => saveClosingAndSales(), {
                primary: true,
                disabled: loading || pageReadOnly || morningReadStatus !== "loaded" || storeAccessLoading || closingSavingRef.current,
              })}
            </div>
          </>,
          saveBadge(closingSaveState, closingDirty, closingSaveError, closingLastSavedAt)
        )}
      </div>
    </div>
  );
}
