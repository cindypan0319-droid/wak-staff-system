import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

const DEFAULT_STORE_ID = "MOOROOLBARK";
const DEFAULT_FLOAT_IF_NO_MORNING = 400;
const EPS = 0.01;

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
  // allow "10", "10.5", "10.50"
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
  // store as numbers (0 if null) so DB has stable format
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
    // If stored is 0, we want blank UI (null). If stored is >0, show number.
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

export default function DailyEntryPage() {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  // Date (both morning & night use this date)
  const [date, setDate] = useState(todayDateInputValue());

  // Platforms
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [platformGrossText, setPlatformGrossText] = useState<Record<string, string>>({});

  // Instore sales (text so it can be blank + decimals)
  const [cashSalesText, setCashSalesText] = useState<string>("");
  const [eftposSalesText, setEftposSalesText] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // Morning cashup counts
  const [morningCounts, setMorningCounts] = useState<CashCounts>({ ...emptyCounts });

  // Night cashup counts
  const [nightCounts, setNightCounts] = useState<CashCounts>({ ...emptyCounts });

  // Removed cash counts (NEW)
  const [removedCounts, setRemovedCounts] = useState<CashCounts>({ ...emptyCounts });

  // Reason (when POS cash sales != should remove)
  const [cashDiffReason, setCashDiffReason] = useState<CashDiffReason>("");
  const [cashDiffNote, setCashDiffNote] = useState<string>("");

  const morningTotal = useMemo(() => calcTotal(morningCounts), [morningCounts]);
  const nightTotal = useMemo(() => calcTotal(nightCounts), [nightCounts]);
  const removedTotal = useMemo(() => calcTotal(removedCounts), [removedCounts]);

  // If no morning saved record, we use default float 400 as baseline
  const [hasMorningRecord, setHasMorningRecord] = useState(false);
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

  function setCountsField(
    setter: (fn: (prev: CashCounts) => CashCounts) => void,
    key: keyof CashCounts,
    raw: string
  ) {
    const n = parseIntOrNull(raw);
    setter((prev) => ({ ...prev, [key]: n }));
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

    try {
      await loadPlatforms();

      // 1) daily_sales
      const ds = await supabase
        .from("daily_sales")
        .select("business_date, cash_sales, eftpos_sales, notes")
        .eq("business_date", date)
        .eq("store_id", DEFAULT_STORE_ID)
        .maybeSingle();

      if (ds.error && ds.error.code !== "PGRST116") setMsg("❌ Cannot load instore sales: " + ds.error.message);

      const row = ds.data as any;
      const cashVal = row?.cash_sales;
      const eftVal = row?.eftpos_sales;

      setCashSalesText(cashVal == null ? "" : String(cashVal));
      setEftposSalesText(eftVal == null ? "" : String(eftVal));
      setNotes(row?.notes ?? "");

      // 2) platform_income (gross only)
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
          map[p] = g == null ? "" : String(g);
        }
        setPlatformGrossText(map);
      }

      // 3) morning cashup
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

      // 4) night cashup
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

      // Removed counts + reason: we store inside night counts record (extra fields)
      // We'll store removed counts & reason inside daily_sales.notes? NO.
      // Instead: store in cashup_sessions as extra JSON keys inside counts.
      // So here, read them from night counts: counts._removed_counts / _cash_diff_reason / _cash_diff_note
      const nightCountsRaw = (n.data as any)?.counts ?? {};
      const removedRaw = nightCountsRaw?._removed_counts ?? null;
      const reasonRaw = nightCountsRaw?._cash_diff_reason ?? "";
      const noteRaw = nightCountsRaw?._cash_diff_note ?? "";

      if (removedRaw) setRemovedCounts(storedJsonToCounts(removedRaw));
      else setRemovedCounts({ ...emptyCounts });

      setCashDiffReason((reasonRaw as CashDiffReason) || "");
      setCashDiffNote(String(noteRaw ?? ""));

      setMsg("✅ Loaded saved data for this date (if any).");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadExisting();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  async function saveMorning() {
    setLoading(true);
    setMsg("");

    try {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id ?? null;
      if (!uid) return setMsg("❌ Not logged in.");

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

      if (res.error) return setMsg("❌ Save morning cashup failed: " + res.error.message);

      setMsg("✅ Morning cashup saved!");
      await loadExisting();
    } finally {
      setLoading(false);
    }
  }

  function useCashToRemoveAsCashSales() {
    // recommended: actual cash sales equals should remove
    setCashSalesText(String(cashToRemove.toFixed(2)));
  }

  function needReason() {
    return Math.abs(actualCashVsShouldDiff) > EPS;
  }

  async function saveClosingAndSales() {
    setLoading(true);
    setMsg("");

    try {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id ?? null;
      if (!uid) return setMsg("❌ Not logged in.");

      // Validate reason if needed
      if (needReason()) {
        if (!cashDiffReason) {
          setMsg("❌ Please select a reason (Actual cash sales ≠ Should remove).");
          return;
        }
        if (cashDiffReason === "OTHER" && !cashDiffNote.trim()) {
          setMsg("❌ Please write a note for 'Other'.");
          return;
        }
      }

      // 1) Save NIGHT cashup
      // Store removed counts & reason inside counts JSON so we don't need new columns right now
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
        removed_cash: removedTotal, // store removed total here for quick query
        entered_by: uid,
      };

      const nres = await supabase.from("cashup_sessions").upsert(nightPayload, {
        onConflict: "business_date,store_id,session_type",
      } as any);

      if (nres.error) return setMsg("❌ Save closing cashup failed: " + nres.error.message);

      // 2) daily_sales (Instore)
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

      if (ds.error) return setMsg("❌ Save instore failed: " + ds.error.message);

      // 3) platform_income (gross only; fees auto-calculated by DB trigger)
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

        if (res.error) return setMsg(`❌ Save platform "${p.name}" failed: ${res.error.message}`);
      }

      setMsg("✅ Closing saved! (cashup + sales + platforms refreshed)");
      await loadExisting();
    } finally {
      setLoading(false);
    }
  }

  const denomGrid = (
    title: string,
    counts: CashCounts,
    setCounts: any,
    extra?: React.ReactNode
  ) => (
    <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 14 }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>

      {extra && <div style={{ marginBottom: 10 }}>{extra}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(160px, 1fr))", gap: 10 }}>
        {[
          ["$100 notes", "note100"],
          ["$50 notes", "note50"],
          ["$20 notes", "note20"],
          ["$10 notes", "note10"],
          ["$5 notes", "note5"],
          ["$2 coins", "coin2"],
          ["$1 coins", "coin1"],
          ["50c coins", "coin50c"],
          ["20c coins", "coin20c"],
          ["10c coins", "coin10c"],
          ["5c coins", "coin5c"],
        ].map(([label, key]) => (
          <label key={String(key)} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{label}</span>
            <input
              style={{ width: 70 }}
              value={(counts as any)[key] ?? ""}
              onChange={(e) => setCountsField(setCounts, key as any, e.target.value)}
              placeholder=""
            />
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{ padding: 20, maxWidth: 1100 }}>
      <h1>Daily Closing Entry (Morning + Closing Cashup)</h1>

      <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: "#666" }}>Business date</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={loading} />
        </div>

        <button onClick={loadExisting} disabled={loading}>
          Refresh
        </button>

        <button onClick={saveMorning} disabled={loading} style={{ fontWeight: 700 }}>
          Save Morning Cashup
        </button>

        <button onClick={saveClosingAndSales} disabled={loading} style={{ fontWeight: 800 }}>
          Save Closing (Cashup + Sales)
        </button>

        <button onClick={() => (window.location.href = "/staff/home")}>
          ← Back to Home
        </button>

        {loading && <span>Loading...</span>}
      </div>

      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>{msg}</div>}

      {/* Morning cashup */}
      {denomGrid(
        "Morning Cashup (open)",
        morningCounts,
        setMorningCounts,
        <div style={{ fontSize: 12, color: "#666" }}>
          Count the cash in till when opening. (If not saved, system uses default {money(DEFAULT_FLOAT_IF_NO_MORNING)}.)
          <div style={{ marginTop: 6 }}>
            Morning total: <b>{money(morningTotal)}</b>{" "}
            {!hasMorningRecord && (
              <span style={{ color: "#999", marginLeft: 8 }}>
                (Not saved yet → baseline will be {money(DEFAULT_FLOAT_IF_NO_MORNING)})
              </span>
            )}
          </div>
        </div>
      )}

      {/* Closing cashup */}
      {denomGrid(
        "Closing Cashup (close)",
        nightCounts,
        setNightCounts,
        <div style={{ fontSize: 12, color: "#666" }}>
          Cash to remove is calculated by: <b>Night total − Morning total</b>. If no morning record, baseline is{" "}
          <b>{money(DEFAULT_FLOAT_IF_NO_MORNING)}</b>.
          <div style={{ marginTop: 6 }}>
            Night total: <b>{money(nightTotal)}</b>
          </div>
          <div style={{ marginTop: 6 }}>
            Baseline morning used: <b>{money(baselineMorningTotal)}</b>
          </div>
          <div style={{ marginTop: 6 }}>
            Cash to remove (Should remove): <b>{money(cashToRemove)}</b>
          </div>
        </div>
      )}

      {/* Removed cash (NEW) */}
      {denomGrid(
        "Cash Removed (count what you actually removed)",
        removedCounts,
        setRemovedCounts,
        <div style={{ fontSize: 12, color: "#666" }}>
          Removed total: <b>{money(removedTotal)}</b>
          <div style={{ marginTop: 6 }}>
            Difference (Removed − Should remove):{" "}
            <b style={{ color: Math.abs(removedVsShouldDiff) < EPS ? "green" : "crimson" }}>
              {money(removedVsShouldDiff)}
            </b>
          </div>
        </div>
      )}

      {/* Instore */}
      <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Instore</h2>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end" }}>
          <label>
            Cash sales (from POS):
            <input
              style={{ width: 180, marginLeft: 8 }}
              value={cashSalesText}
              onChange={(e) => setCashSalesText(e.target.value)}
              placeholder=""
            />
          </label>

          <label>
            EFTPOS sales:
            <input
              style={{ width: 180, marginLeft: 8 }}
              value={eftposSalesText}
              onChange={(e) => setEftposSalesText(e.target.value)}
              placeholder=""
            />
          </label>

          <button onClick={useCashToRemoveAsCashSales} disabled={loading}>
            Set Cash sales = Should remove
          </button>
        </div>

        <div style={{ marginTop: 10, color: "#666" }}>
          Instore subtotal: <b>{instoreSubtotal.toFixed(2)}</b>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Notes (optional)</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} style={{ width: "100%" }} />
        </div>

        <div style={{ marginTop: 12, padding: 10, border: "1px dashed #ccc" }}>
          <div>
            Diff (Actual cash sales − Should remove):{" "}
            <b style={{ color: Math.abs(actualCashVsShouldDiff) < EPS ? "green" : "crimson" }}>
              {money(actualCashVsShouldDiff)}
            </b>
          </div>

          {needReason() && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
                Because this diff is not zero, please select a reason (required to save closing):
              </div>

              <select
                value={cashDiffReason}
                onChange={(e) => setCashDiffReason(e.target.value as CashDiffReason)}
                style={{ width: 360 }}
              >
                <option value="">-- Select reason --</option>
                <option value="FLOAT_CHANGED">Cash left in till / float changed</option>
                <option value="CASH_REFUND_OR_PAYOUT">Cash paid out / refunds</option>
                <option value="CASH_DROP_NOT_COUNTED">Cash drop not counted (safe/other)</option>
                <option value="COUNTING_MISTAKE">Counting mistake</option>
                <option value="POS_CASH_ADJUSTMENT">POS cash incorrect / adjustment</option>
                <option value="OTHER">Other</option>
              </select>

              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, color: "#666" }}>Note (optional, required if Other)</div>
                <input
                  style={{ width: "100%" }}
                  value={cashDiffNote}
                  onChange={(e) => setCashDiffNote(e.target.value)}
                  placeholder=""
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Online Platform */}
      <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 14 }}>
        <h2 style={{ marginTop: 0 }}>Online Platform</h2>

        {platforms.length === 0 ? (
          <div style={{ color: "#999" }}>No platforms configured (Owner can add platforms in Manager → Platforms).</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table cellPadding={8} style={{ borderCollapse: "collapse", minWidth: 720 }}>
              <thead>
                <tr>
                  <th style={{ border: "1px solid #ccc", textAlign: "left" }}>Platform</th>
                  <th style={{ border: "1px solid #ccc", textAlign: "left" }}>Gross income</th>
                </tr>
              </thead>
              <tbody>
                {platforms.map((p) => (
                  <tr key={p.id}>
                    <td style={{ border: "1px solid #ccc", fontWeight: 700 }}>{p.name}</td>
                    <td style={{ border: "1px solid #ccc" }}>
                      <input
                        style={{ width: 180 }}
                        value={platformGrossText[p.name] ?? ""}
                        onChange={(e) => setPlatformGrossText((prev) => ({ ...prev, [p.name]: e.target.value }))}
                        placeholder=""
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: 10, color: "#666" }}>
              Online subtotal: <b>{onlineSubtotal.toFixed(2)}</b>
            </div>
          </div>
        )}
      </div>

      {/* Total */}
      <div style={{ border: "1px solid #ddd", padding: 12 }}>
        <h2 style={{ marginTop: 0 }}>Total</h2>
        <div>
          Total (Instore + Online): <b style={{ fontSize: 22 }}>{total.toFixed(2)}</b>
        </div>
        <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>Total is auto-calculated.</div>
      </div>
    </div>
  );
}