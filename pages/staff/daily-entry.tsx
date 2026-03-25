import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const DEFAULT_STORE_ID = "MOOROOLBARK";
const DEFAULT_FLOAT_IF_NO_MORNING = 400;
const EPS = 0.01;
const AUTO_SAVE_DELAY = 2500;



const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

type Platform = {
  id: number;
  name: string;
  is_active: boolean;
  sort_order: number;
};

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

function parseMoneyOrZero(raw: string | undefined | null) {
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseIntOrNull(raw: string) {
  const s = raw.trim();
  if (!s) return null;
  const n = Math.floor(Number(s));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function countsToStoredJson(c: CashCounts) {
  const out: any = {};
  for (const k of Object.keys(c) as (keyof CashCounts)[]) {
    out[k] = Number.isFinite(Number(c[k])) ? Number(c[k]) : 0;
  }
  return out;
}

function storedJsonToCounts(obj: any): CashCounts {
  const out: any = { ...emptyCounts };
  for (const k of Object.keys(emptyCounts) as (keyof CashCounts)[]) {
    const v = obj?.[k];
    const n = Number(v);
    out[k] = Number.isFinite(n) && n > 0 ? n : null;
  }
  return out as CashCounts;
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

  const [cashSalesText, setCashSalesText] = useState<string>("");
  const [eftposSalesText, setEftposSalesText] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  const [morningCounts, setMorningCounts] = useState<CashCounts>({ ...emptyCounts });
  const [nightCounts, setNightCounts] = useState<CashCounts>({ ...emptyCounts });
  const [removedCounts, setRemovedCounts] = useState<CashCounts>({ ...emptyCounts });

  const [cashDiffReason, setCashDiffReason] = useState<CashDiffReason>("");
  const [cashDiffNote, setCashDiffNote] = useState<string>("");

  const [hasMorningRecord, setHasMorningRecord] = useState(false);

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
  const lastAutoSaveKeyRef = useRef<string>("");

  const morningTotal = useMemo(() => calcTotal(morningCounts), [morningCounts]);
  const nightTotal = useMemo(() => calcTotal(nightCounts), [nightCounts]);
  const removedTotal = useMemo(() => calcTotal(removedCounts), [removedCounts]);

  const baselineMorningTotal = useMemo(
    () => (hasMorningRecord ? morningTotal : DEFAULT_FLOAT_IF_NO_MORNING),
    [hasMorningRecord, morningTotal]
  );

  const cashToRemove = useMemo(() => round2(Math.max(0, nightTotal - baselineMorningTotal)), [
    nightTotal,
    baselineMorningTotal,
  ]);

  const removedVsShouldDiff = useMemo(() => round2(removedTotal - cashToRemove), [removedTotal, cashToRemove]);

  const actualCashSales = useMemo(() => round2(parseMoneyOrZero(cashSalesText)), [cashSalesText]);
  const eftposSales = useMemo(() => round2(parseMoneyOrZero(eftposSalesText)), [eftposSalesText]);

  const actualCashVsShouldDiff = useMemo(() => round2(actualCashSales - cashToRemove), [actualCashSales, cashToRemove]);

  const instoreSubtotal = useMemo(() => round2(actualCashSales + eftposSales), [actualCashSales, eftposSales]);

  const onlineSubtotal = useMemo(() => {
    let sum = 0;
    for (const k of Object.keys(platformGrossText)) sum += parseMoneyOrZero(platformGrossText[k]);
    return round2(sum);
  }, [platformGrossText]);

  const total = useMemo(() => round2(instoreSubtotal + onlineSubtotal), [instoreSubtotal, onlineSubtotal]);

  useEffect(() => {
    async function checkStoreAccess() {
      try {
        const res = await fetch("/api/check-store-access");
        const data = await res.json();

        if (!data.allowed) {
          window.location.href = "/staff/home";
        }
      } catch (error) {
        console.log("check store access error:", error);
        window.location.href = "/staff/home";
      }
    }

    checkStoreAccess();
  }, []);

  useEffect(() => {
    async function checkStoreAccess() {
      setStoreAccessLoading(true);
      try {
        const res = await fetch("/api/check-store-access");
        const data = await res.json();
        setIsStoreDevice(!!data.allowed);
        setDetectedIp(data.ip || "");
      } catch (error) {
        console.log("check store access error:", error);
        setIsStoreDevice(false);
        setDetectedIp("");
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
    section: "morning" | "closing"
  ) {
    const n = parseIntOrNull(raw);
    setter((prev) => ({ ...prev, [key]: n }));
    if (initialLoadDoneRef.current) {
      if (section === "morning") {
        setMorningDirty(true);
        setMorningSaveState("idle");
        setMorningSaveError("");
      } else {
        setClosingDirty(true);
        setClosingSaveState("idle");
        setClosingSaveError("");
      }
    }
  }

  function markClosingDirty() {
    if (initialLoadDoneRef.current) {
      setClosingDirty(true);
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
      setMsg("❌ Cannot load platforms: " + res.error.message);
      setPlatforms([]);
      return;
    }
    setPlatforms((res.data ?? []) as any);
  }

  async function loadExisting() {
    setLoading(true);
    setMsg("");
    initialLoadDoneRef.current = false;

    try {
      await loadPlatforms();

      const ds = await supabase
        .from("daily_sales")
        .select("business_date, cash_sales, eftpos_sales, notes")
        .eq("business_date", date)
        .eq("store_id", DEFAULT_STORE_ID)
        .maybeSingle();

      if (ds.error && ds.error.code !== "PGRST116") {
        setMsg("❌ Cannot load instore sales: " + ds.error.message);
      }

      const row = ds.data as any;
      const cashVal = row?.cash_sales;
      const eftVal = row?.eftpos_sales;

      setCashSalesText(cashVal == null || Number(cashVal) === 0 ? "" : String(cashVal));
      setEftposSalesText(eftVal == null || Number(eftVal) === 0 ? "" : String(eftVal));
      setNotes(row?.notes ?? "");

      const pi = await supabase
        .from("platform_income")
        .select("business_date, platform, gross_income")
        .eq("business_date", date)
        .eq("store_id", DEFAULT_STORE_ID);

      if (pi.error) {
        setMsg((prev) => prev || "❌ Cannot load online sales: " + pi.error.message);
      } else {
        const map: Record<string, string> = {};
        for (const r of pi.data ?? []) {
          const p = String((r as any).platform);
          const g = (r as any).gross_income;
          map[p] = g == null || Number(g) === 0 ? "" : String(g);
        }
        setPlatformGrossText(map);
      }

      const m = await supabase
        .from("cashup_sessions")
        .select("counts")
        .eq("business_date", date)
        .eq("store_id", DEFAULT_STORE_ID)
        .eq("session_type", "MORNING")
        .maybeSingle();

      if (m.error && m.error.code !== "PGRST116") {
        setMsg((prev) => prev || "❌ Cannot load morning cashup: " + m.error.message);
      }

      if (m.data) {
        setHasMorningRecord(true);
        setMorningCounts(storedJsonToCounts((m.data as any).counts ?? {}));
      } else {
        setHasMorningRecord(false);
        setMorningCounts({ ...emptyCounts });
      }

      const n = await supabase
        .from("cashup_sessions")
        .select("counts")
        .eq("business_date", date)
        .eq("store_id", DEFAULT_STORE_ID)
        .eq("session_type", "NIGHT")
        .maybeSingle();

      if (n.error && n.error.code !== "PGRST116") {
        setMsg((prev) => prev || "❌ Cannot load closing cashup: " + n.error.message);
      }

      if (n.data) setNightCounts(storedJsonToCounts((n.data as any).counts ?? {}));
      else setNightCounts({ ...emptyCounts });

      const nightCountsRaw = (n.data as any)?.counts ?? {};
      const removedRaw = nightCountsRaw?._removed_counts ?? null;
      const reasonRaw = nightCountsRaw?._cash_diff_reason ?? "";
      const noteRaw = nightCountsRaw?._cash_diff_note ?? "";

      if (removedRaw) setRemovedCounts(storedJsonToCounts(removedRaw));
      else setRemovedCounts({ ...emptyCounts });

      setCashDiffReason((reasonRaw as CashDiffReason) || "");
      setCashDiffNote(String(noteRaw ?? ""));

      setMorningDirty(false);
      setClosingDirty(false);
      setMorningSaveState("idle");
      setClosingSaveState("idle");
      setMorningSaveError("");
      setClosingSaveError("");

      setMsg("✅ Loaded saved data for this date.");

      const savedDraft = localStorage.getItem(draftKey);

      if (savedDraft) {
        try {
          const d = JSON.parse(savedDraft);

          setCashSalesText(d.cashSalesText ?? "");
          setEftposSalesText(d.eftposSalesText ?? "");
          setNotes(d.notes ?? "");
          setPlatformGrossText(d.platformGrossText ?? {});
          setMorningCounts(d.morningCounts ?? { ...emptyCounts });
          setNightCounts(d.nightCounts ?? { ...emptyCounts });
          setRemovedCounts(d.removedCounts ?? { ...emptyCounts });
          setCashDiffReason(d.cashDiffReason ?? "");
          setCashDiffNote(d.cashDiffNote ?? "");
          setHasMorningRecord(!!d.hasMorningRecord);

          setMsg("ℹ️ Restored unsaved local draft.");
        } catch (e) {
          console.log("restore draft error:", e);
        }
      }

    } finally {
      setLoading(false);
      initialLoadDoneRef.current = true;
    }
  }

  useEffect(() => {
    loadExisting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  async function saveMorning(options?: { silent?: boolean }) {
    if (morningSavingRef.current) return true;

    morningSavingRef.current = true;
    if (!options?.silent) {
      setLoading(true);
      setMsg("");
    }
    setMorningSaveState("saving");
    setMorningSaveError("");

    try {
      if (!isStoreDevice) {
        const text = "❌ Daily entry can only be saved on the store device / store network.";
        if (!options?.silent) setMsg(text);
        setMorningSaveState("error");
        setMorningSaveError(text);
        return false;
      }

      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id ?? null;
      if (!uid) {
        const text = "❌ Not logged in.";
        if (!options?.silent) setMsg(text);
        setMorningSaveState("error");
        setMorningSaveError(text);
        return false;
      }

      const payload: any = {
        business_date: date,
        store_id: DEFAULT_STORE_ID,
        session_type: "MORNING",
        counts: countsToStoredJson(morningCounts),
        total_cash: morningTotal,
        removed_cash: 0,
        entered_by: uid,
      };

      const res = await supabase.from("cashup_sessions").upsert(payload, {
        onConflict: "business_date,store_id,session_type",
      } as any);

      if (res.error) {
        const text = "❌ Save morning cashup failed: " + res.error.message;
        if (!options?.silent) setMsg(text);
        setMorningSaveState("error");
        setMorningSaveError(text);
        return false;
      }

      setMorningDirty(false);
      setHasMorningRecord(true);
      setMorningSaveState("saved");
      setMorningLastSavedAt(new Date().toISOString());
      
      if (!options?.silent) {
        setMsg("✅ Morning cashup saved!");
      }
      return true;
    } finally {
      morningSavingRef.current = false;
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }

  function useCashToRemoveAsCashSales() {
    setCashSalesText(String(cashToRemove.toFixed(2)));
    markClosingDirty();
  }

  function needReason() {
    return Math.abs(actualCashVsShouldDiff) > EPS;
  }

  async function saveClosingAndSales(options?: { silent?: boolean }) {

    const autoSaveKey = JSON.stringify({
      date,
      nightCounts,
      removedCounts,
      cashSalesText,
      eftposSalesText,
      notes,
      cashDiffReason,
      cashDiffNote,
      platformGrossText,
    });

    if (options?.silent && autoSaveKey === lastAutoSaveKeyRef.current) {
      return true;
    }

    if (closingSavingRef.current) return true;

    closingSavingRef.current = true;
    
  
    setClosingSaveState("saving");
    setClosingSaveError("");

    try {
      if (!isStoreDevice) {
        const text = "❌ Daily entry can only be saved on the store device / store network.";
        if (!options?.silent) setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id ?? null;
      if (!uid) {
        const text = "❌ Not logged in.";
        if (!options?.silent) setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      if (needReason()) {
        if (!cashDiffReason) {
          const text = "❌ Please select a reason (Actual cash sales ≠ Should remove).";
          if (!options?.silent) setMsg(text);
          setClosingSaveState("error");
          setClosingSaveError(text);
          return false;
        }
        if (cashDiffReason === "OTHER" && !cashDiffNote.trim()) {
          const text = "❌ Please write a note for 'Other'.";
          if (!options?.silent) setMsg(text);
          setClosingSaveState("error");
          setClosingSaveError(text);
          return false;
        }
      }

      const nightCountsStore: any = countsToStoredJson(nightCounts);
      nightCountsStore._removed_counts = countsToStoredJson(removedCounts);
      nightCountsStore._cash_diff_reason = cashDiffReason;
      nightCountsStore._cash_diff_note = cashDiffNote;

      const nightPayload: any = {
        business_date: date,
        store_id: DEFAULT_STORE_ID,
        session_type: "NIGHT",
        counts: nightCountsStore,
        total_cash: nightTotal,
        removed_cash: removedTotal,
        entered_by: uid,
      };

      const nres = await supabase.from("cashup_sessions").upsert(nightPayload, {
        onConflict: "business_date,store_id,session_type",
      } as any);

      if (nres.error) {
        const text = "❌ Save closing cashup failed: " + nres.error.message;
        if (!options?.silent) setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      const dailyPayload: any = {
        business_date: date,
        store_id: DEFAULT_STORE_ID,
        cash_sales: round2(actualCashSales),
        eftpos_sales: round2(eftposSales),
        total_sales: round2(actualCashSales + eftposSales + onlineSubtotal),
        notes: notes || null,
        entered_by: uid,
      };

      const ds = await supabase.from("daily_sales").upsert(dailyPayload, {
        onConflict: "business_date,store_id",
      } as any);

      if (ds.error) {
        const text = "❌ Save instore failed: " + ds.error.message;
        if (!options?.silent) setMsg(text);
        setClosingSaveState("error");
        setClosingSaveError(text);
        return false;
      }

      for (const p of platforms) {
        const gross = round2(parseMoneyOrZero(platformGrossText[p.name] ?? ""));
        const payload: any = {
          business_date: date,
          store_id: DEFAULT_STORE_ID,
          platform: p.name,
          gross_income: gross,
          entered_by: uid,
        };

        const res = await supabase.from("platform_income").upsert(payload, {
          onConflict: "business_date,store_id,platform",
        } as any);

        if (res.error) {
          const text = `❌ Save platform "${p.name}" failed: ${res.error.message}`;
          if (!options?.silent) setMsg(text);
          setClosingSaveState("error");
          setClosingSaveError(text);
          return false;
        }
      }

      setClosingDirty(false);
      setClosingSaveState("saved");
      setClosingLastSavedAt(new Date().toISOString());
      localStorage.removeItem(draftKey);
      if (!options?.silent) {
        setMsg("✅ Closing saved! (cashup + sales + platforms refreshed)");
      }
      if (options?.silent) {
        lastAutoSaveKeyRef.current = autoSaveKey;
      }
      return true;
    } finally {
      closingSavingRef.current = false;
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    if (!initialLoadDoneRef.current) return;

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
      hasMorningRecord,
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
    hasMorningRecord,
  ]);

  useEffect(() => {
    if (!initialLoadDoneRef.current) return;
    if (!morningDirty) return;
    if (!isStoreDevice || storeAccessLoading) return;

    const timer = setTimeout(() => {
      saveMorning({ silent: true });
    }, AUTO_SAVE_DELAY);

    return () => clearTimeout(timer);
  }, [morningDirty, morningCounts, date, isStoreDevice, storeAccessLoading]);

  useEffect(() => {
    if (!initialLoadDoneRef.current) return;
    if (!closingDirty) return;
    if (!isStoreDevice || storeAccessLoading) return;
    if (closingSavingRef.current) return;

    if (needReason() && !cashDiffReason) {
      setClosingSaveState("idle");
      return;
    }

    if (cashDiffReason === "OTHER" && !cashDiffNote.trim()) {
      setClosingSaveState("idle");
      return;
    }

    const timer = setTimeout(() => {
      saveClosingAndSales({ silent: true });
    }, AUTO_SAVE_DELAY);

    return () => clearTimeout(timer);
  }, [
    closingDirty,
    nightCounts,
    removedCounts,
    cashSalesText,
    eftposSalesText,
    notes,
    cashDiffReason,
    cashDiffNote,
    platformGrossText,
    date,
    isStoreDevice,
    storeAccessLoading,
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
      setMsg("❌ You have unsaved changes. Please wait for auto-save or save manually before going back home.");
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
    setCounts: any,
    section: "morning" | "closing"
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
              value={(counts as any)[key] ?? ""}
              onChange={(e) => setCountsField(setCounts, key, e.target.value, section)}
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

  const pageReadOnly = !isStoreDevice;

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

            {actionButton("Refresh", loadExisting, { disabled: loading })}
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
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {isStoreDevice ? "Store device access confirmed" : "Read only outside store device/network"}
          </div>
          <div style={{ fontSize: 13, color: MUTED }}>
            Auto-save is enabled. Changes are saved after about 2.5 seconds of no typing.
            {detectedIp ? ` Current IP: ${detectedIp}` : ""}
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

        {sectionCard(
          "Morning Cashup (Open)",
          <>
            <div style={{ color: MUTED, fontSize: 14, marginBottom: 14, lineHeight: 1.6 }}>
              Count the cash in till when opening. If no morning cashup is saved, system uses default baseline{" "}
              <b>{money(DEFAULT_FLOAT_IF_NO_MORNING)}</b>.
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              {moneyBadge("Morning total", money(morningTotal))}
              {moneyBadge(
                hasMorningRecord ? "Saved baseline used" : "Default baseline used",
                money(hasMorningRecord ? morningTotal : DEFAULT_FLOAT_IF_NO_MORNING),
                hasMorningRecord ? WAK_BLUE : WAK_RED
              )}
            </div>

            {renderDenomGrid(morningCounts, setMorningCounts, "morning")}

            <div style={{ marginTop: 18, display: "flex", justifyContent: "flex-end" }}>
              {actionButton("Save Morning Cashup", () => saveMorning(), {
                primary: true,
                disabled: loading || pageReadOnly || storeAccessLoading,
              })}
            </div>
          </>,
          saveBadge(morningSaveState, morningDirty, morningSaveError, morningLastSavedAt)
        )}

        {sectionCard(
          "Closing Cashup (Close)",
          <>
            <div style={{ color: MUTED, fontSize: 14, marginBottom: 14, lineHeight: 1.6 }}>
              Cash to remove is calculated as <b>Night total − Morning total</b>. If no morning record exists, baseline is{" "}
              <b>{money(DEFAULT_FLOAT_IF_NO_MORNING)}</b>.
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              {moneyBadge("Night total", money(nightTotal))}
              {moneyBadge("Baseline morning used", money(baselineMorningTotal))}
              {moneyBadge("Cash to remove", money(cashToRemove), WAK_BLUE)}
            </div>

            {renderDenomGrid(nightCounts, setNightCounts, "closing")}
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
              {moneyBadge(
                "Removed − Should remove",
                money(removedVsShouldDiff),
                Math.abs(removedVsShouldDiff) < EPS ? "#15803D" : WAK_RED
              )}
            </div>

            {renderDenomGrid(removedCounts, setRemovedCounts, "closing")}
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
                onChange={(e) => {
                  setCashSalesText(e.target.value);
                  markClosingDirty();
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
                onChange={(e) => {
                  setEftposSalesText(e.target.value);
                  markClosingDirty();
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

            <div style={{ marginBottom: 16 }}>
              {actionButton("Set Cash Sales = Should Remove", useCashToRemoveAsCashSales, {
                disabled: loading || pageReadOnly || storeAccessLoading,
              })}
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              {moneyBadge("Instore subtotal", money(instoreSubtotal))}
              {moneyBadge(
                "Actual cash sales − Should remove",
                money(actualCashVsShouldDiff),
                Math.abs(actualCashVsShouldDiff) < EPS ? "#15803D" : WAK_RED
              )}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, color: TEXT, fontWeight: 600, marginBottom: 8 }}>
                Notes (optional)
              </div>
              <textarea
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  markClosingDirty();
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
                If this difference is not zero, a reason is required before saving closing.
              </div>

              {needReason() && (
                <>
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, color: TEXT, fontWeight: 600, marginBottom: 8 }}>Reason</div>
                    <select
                      value={cashDiffReason}
                      onChange={(e) => {
                        setCashDiffReason(e.target.value as CashDiffReason);
                        markClosingDirty();
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
                      <option value="">-- Select reason --</option>
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
                      onChange={(e) => {
                        setCashDiffNote(e.target.value);
                        markClosingDirty();
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
          </>
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
                      {p.name}
                    </div>
                    <input
                      value={platformGrossText[p.name] ?? ""}
                      onChange={(e) => {
                        setPlatformGrossText((prev) => ({ ...prev, [p.name]: e.target.value }));
                        markClosingDirty();
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
              {actionButton("Save Closing (Cashup + Sales)", () => saveClosingAndSales(), {
                primary: true,
                disabled: loading || pageReadOnly || storeAccessLoading,
              })}
            </div>
          </>,
          saveBadge(closingSaveState, closingDirty, closingSaveError, closingLastSavedAt)
        )}
      </div>
    </div>
  );
}