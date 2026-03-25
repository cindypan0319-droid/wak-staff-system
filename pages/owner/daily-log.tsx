import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;

type ProfileRow = {
  id: string;
  full_name: string | null;
  preferred_name?: string | null;
  role?: Role | null;
};

type DailySalesRow = {
  business_date: string;
  store_id: string;
  cash_sales: number | null;
  expected_cash: number | null;
  eftpos_sales: number | null;
  total_sales: number | null;
  notes: string | null;
  entered_by?: string | null;
};

type PlatformIncomeRow = {
  business_date: string;
  store_id: string;
  platform: string;
  gross_income: number | null;
  entered_by?: string | null;
};

type CashupSessionRow = {
  business_date: string;
  store_id: string;
  session_type: "MORNING" | "NIGHT" | string;
  total_cash: number | null;
  removed_cash: number | null;
  counts: any;
  entered_by?: string | null;
};

type DailyLogRow = {
  business_date: string;
  day: string;

  actual_cash: number;
  expected_cash: number;
  eftpos: number;
  instore_subtotal: number;

  doordash: number;
  uber: number;
  wak_app: number;
  online_subtotal: number;

  total_sales: number;
  short_over: number;

  morning_cashup: number;

  notes: string;
  entered_by_name: string;
};

type EditDraft = {
  actual_cash: string;
  expected_cash: string;
  eftpos: string;
  doordash: string;
  uber: string;
  wak_app: string;
  morning_cashup: string;
  notes: string;
};

type SaveState = "idle" | "saving" | "saved" | "error";

const DEFAULT_STORE_ID = "MOOROOLBARK";
const DEFAULT_FLOAT_IF_NO_MORNING = 400;
const AUTO_SAVE_DELAY = 2500;

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

const INSTORE_BG = "#F7FBFF";
const ONLINE_BG = "#FFFDF7";
const TOTAL_BG = "#F4FAF6";
const CONTROL_BG = "#FAFAFA";
const FROZEN_BG = "#FFFFFF";
const FROZEN_HEADER_BG = "#F3F4F6";

const DATE_COL_W = 110;
const DAY_COL_W = 64;
const TOP_GROUP_ROW_H = 30;
const SECOND_HEADER_ROW_H = 42;

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function money(n: number | null | undefined) {
  const v = Number(n ?? 0);
  return v.toLocaleString("en-AU", { style: "currency", currency: "AUD" });
}

function dayLabel(isoDate: string) {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString("en-AU", { weekday: "short" }).toUpperCase();
}

function todayDateInputValue() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dateDaysAgo(days: number) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function displayName(profile: ProfileRow | null) {
  const preferred = (profile?.preferred_name ?? "").trim();
  const full = (profile?.full_name ?? "").trim();
  return preferred || full || "-";
}

function parseMoneyText(s: string) {
  const t = String(s ?? "").trim();
  if (!t) return 0;
  const n = Number(t);
  return Number.isFinite(n) ? round2(n) : 0;
}

function normalizePlatformName(name: string) {
  return String(name ?? "").trim().toUpperCase();
}

function isDoorDashName(name: string) {
  return normalizePlatformName(name).includes("DOORDASH");
}

function isUberName(name: string) {
  return normalizePlatformName(name).includes("UBER");
}

function isWakName(name: string) {
  const n = normalizePlatformName(name);
  return n.includes("WAK");
}

function draftEqualsRow(draft: EditDraft | undefined, row: DailyLogRow) {
  const d = draft ?? {
    actual_cash: "",
    expected_cash: "",
    eftpos: "",
    doordash: "",
    uber: "",
    wak_app: "",
    morning_cashup: "",
    notes: "",
  };

  return (
    parseMoneyText(d.actual_cash) === row.actual_cash &&
    parseMoneyText(d.expected_cash) === row.expected_cash &&
    parseMoneyText(d.eftpos) === row.eftpos &&
    parseMoneyText(d.doordash) === row.doordash &&
    parseMoneyText(d.uber) === row.uber &&
    parseMoneyText(d.wak_app) === row.wak_app &&
    parseMoneyText(d.morning_cashup) === row.morning_cashup &&
    (d.notes ?? "").trim() === (row.notes ?? "").trim()
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
        padding: "9px 13px",
        minHeight: 38,
        borderRadius: 10,
        border: `1px solid ${borderColor}`,
        background: bg,
        color: textColor,
        fontWeight: 800,
        fontSize: 14,
        cursor: disabled ? "not-allowed" : "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function statCard(label: string, value: string, color?: string) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 12,
        background: "#F9FAFB",
        border: `1px solid ${BORDER}`,
        minWidth: 145,
      }}
    >
      <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.2 }}>{label}</div>
      <div style={{ fontWeight: 800, fontSize: 18, color: color || TEXT }}>{value}</div>
    </div>
  );
}

function downloadCSV(filename: string, rows: string[][]) {
  const csv = rows
    .map((r) => r.map((cell) => `"${String(cell ?? "").replaceAll(`"`, `""`)}"`).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function inputStyle(width?: number | string): React.CSSProperties {
  return {
    width: width ?? "100%",
    maxWidth: "100%",
    boxSizing: "border-box",
    padding: "2px 6px",
    borderRadius: 6,
    border: "1px solid #D1D5DB",
    fontSize: 13,
    fontWeight: 600,
    background: "#fff",
    color: TEXT,
    height: 26,
    lineHeight: "22px",
  };
}

function groupHeaderStyle(bg: string, z = 3): React.CSSProperties {
  return {
    borderBottom: `1px solid ${BORDER}`,
    borderRight: `1px solid ${BORDER}`,
    position: "sticky",
    top: 0,
    zIndex: z,
    background: bg,
    padding: "6px 6px",
    textAlign: "center",
    color: TEXT,
    fontWeight: 800,
    fontSize: 12,
    lineHeight: 1.1,
    whiteSpace: "normal",
    height: TOP_GROUP_ROW_H,
  };
}

function columnHeaderStyle(bg: string, z = 4): React.CSSProperties {
  return {
    borderBottom: `1px solid ${BORDER}`,
    borderRight: `1px solid ${BORDER}`,
    position: "sticky",
    top: TOP_GROUP_ROW_H,
    zIndex: z,
    background: bg,
    padding: "6px 6px",
    textAlign: "center",
    color: TEXT,
    fontWeight: 800,
    fontSize: 12,
    lineHeight: 1.1,
    whiteSpace: "normal",
    height: SECOND_HEADER_ROW_H,
  };
}

function bodyCellStyle(
  align: "left" | "right" | "center" = "left",
  bg = "#fff",
  extra?: React.CSSProperties
): React.CSSProperties {
  return {
    borderBottom: `1px solid ${BORDER}`,
    borderRight: `1px solid ${BORDER}`,
    padding: "4px 6px",
    color: TEXT,
    textAlign: align,
    background: bg,
    verticalAlign: "middle",
    fontSize: 14,
    ...extra,
  };
}

export default function OwnerDailyLogPage() {
  const [loading, setLoading] = useState(true);
  const [roleLoading, setRoleLoading] = useState(true);
  const [role, setRole] = useState<Role>("ANON");
  const [msg, setMsg] = useState("");

  const [startDate, setStartDate] = useState(dateDaysAgo(30));
  const [endDate, setEndDate] = useState(todayDateInputValue());

  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [dailySales, setDailySales] = useState<DailySalesRow[]>([]);
  const [platformIncome, setPlatformIncome] = useState<PlatformIncomeRow[]>([]);
  const [cashups, setCashups] = useState<CashupSessionRow[]>([]);

  const [drafts, setDrafts] = useState<Record<string, EditDraft>>({});
  const [extraDates, setExtraDates] = useState<string[]>([]);
  const [newDate, setNewDate] = useState(todayDateInputValue());

  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isOwner = role === "OWNER";

  async function loadRole() {
    setRoleLoading(true);

    try {
      const { data: s } = await supabase.auth.getSession();
      const session = s.session;

      if (!session?.user?.id) {
        window.location.href = "/";
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, preferred_name, role")
        .eq("id", session.user.id)
        .maybeSingle();

      if (error) {
        setRole("ANON");
        setMsg("Cannot load profile: " + error.message);
        return;
      }

      const p = (data as ProfileRow | null) ?? null;
      setRole((p?.role as Role) ?? "ANON");
    } finally {
      setRoleLoading(false);
    }
  }

  async function loadAll() {
    setLoading(true);
    setMsg("");

    try {
      const [profilesRes, dailyRes, platformRes, cashupRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, preferred_name, role")
          .order("full_name", { ascending: true }),

        supabase
          .from("daily_sales")
          .select("business_date, store_id, cash_sales, expected_cash, eftpos_sales, total_sales, notes, entered_by")
          .eq("store_id", DEFAULT_STORE_ID)
          .gte("business_date", startDate)
          .lte("business_date", endDate)
          .order("business_date", { ascending: false }),

        supabase
          .from("platform_income")
          .select("business_date, store_id, platform, gross_income, entered_by")
          .eq("store_id", DEFAULT_STORE_ID)
          .gte("business_date", startDate)
          .lte("business_date", endDate)
          .order("business_date", { ascending: false }),

        supabase
          .from("cashup_sessions")
          .select("business_date, store_id, session_type, total_cash, removed_cash, counts, entered_by")
          .eq("store_id", DEFAULT_STORE_ID)
          .gte("business_date", startDate)
          .lte("business_date", endDate)
          .order("business_date", { ascending: false }),
      ]);

      if (profilesRes.error) {
        setMsg("❌ Cannot load profiles: " + profilesRes.error.message);
        setProfiles([]);
      } else {
        setProfiles((profilesRes.data ?? []) as any);
      }

      if (dailyRes.error) {
        setMsg((prev) => prev || "❌ Cannot load daily sales: " + dailyRes.error.message);
        setDailySales([]);
      } else {
        setDailySales((dailyRes.data ?? []) as any);
      }

      if (platformRes.error) {
        setMsg((prev) => prev || "❌ Cannot load platform income: " + platformRes.error.message);
        setPlatformIncome([]);
      } else {
        setPlatformIncome((platformRes.data ?? []) as any);
      }

      if (cashupRes.error) {
        setMsg((prev) => prev || "❌ Cannot load cashup sessions: " + cashupRes.error.message);
        setCashups([]);
      } else {
        setCashups((cashupRes.data ?? []) as any);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRole();
  }, []);

  useEffect(() => {
    if (!roleLoading && isOwner) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roleLoading, role, startDate, endDate]);

  const profileMap = useMemo(() => {
    const m = new Map<string, ProfileRow>();
    for (const p of profiles) m.set(p.id, p);
    return m;
  }, [profiles]);

  const rows = useMemo(() => {
    const map = new Map<string, DailyLogRow>();

    for (const ds of dailySales) {
      const key = ds.business_date;
      const enteredProfile = ds.entered_by ? profileMap.get(ds.entered_by) ?? null : null;

      map.set(key, {
        business_date: ds.business_date,
        day: dayLabel(ds.business_date),

        actual_cash: Number(ds.cash_sales ?? 0),
        expected_cash: Number(ds.expected_cash ?? 0),
        eftpos: Number(ds.eftpos_sales ?? 0),
        instore_subtotal: round2(Number(ds.cash_sales ?? 0) + Number(ds.eftpos_sales ?? 0)),

        doordash: 0,
        uber: 0,
        wak_app: 0,
        online_subtotal: 0,

        total_sales: Number(ds.total_sales ?? 0),
        short_over: 0,

        morning_cashup: 0,

        notes: ds.notes ?? "",
        entered_by_name: displayName(enteredProfile),
      });
    }

    for (const p of platformIncome) {
      const key = p.business_date;

      const row =
        map.get(key) ??
        {
          business_date: p.business_date,
          day: dayLabel(p.business_date),

          actual_cash: 0,
          expected_cash: 0,
          eftpos: 0,
          instore_subtotal: 0,

          doordash: 0,
          uber: 0,
          wak_app: 0,
          online_subtotal: 0,

          total_sales: 0,
          short_over: 0,

          morning_cashup: 0,

          notes: "",
          entered_by_name: "",
        };

      const gross = Number(p.gross_income ?? 0);

      if (isDoorDashName(p.platform)) {
        row.doordash += gross;
      } else if (isUberName(p.platform)) {
        row.uber += gross;
      } else if (isWakName(p.platform)) {
        row.wak_app += gross;
      }

      row.online_subtotal = round2(row.doordash + row.uber + row.wak_app);

      if (!row.total_sales || row.total_sales === 0) {
        row.total_sales = round2(row.instore_subtotal + row.online_subtotal);
      }

      map.set(key, row);
    }

    const morningMap = new Map<string, CashupSessionRow>();
    const nightMap = new Map<string, CashupSessionRow>();

    for (const c of cashups) {
      if (String(c.session_type).toUpperCase() === "MORNING") morningMap.set(c.business_date, c);
      if (String(c.session_type).toUpperCase() === "NIGHT") nightMap.set(c.business_date, c);
    }

    const allKeys = new Set<string>([
      ...Array.from(map.keys()),
      ...Array.from(morningMap.keys()),
      ...Array.from(nightMap.keys()),
      ...extraDates,
    ]);

    for (const key of allKeys) {
      const row =
        map.get(key) ??
        {
          business_date: key,
          day: dayLabel(key),

          actual_cash: 0,
          expected_cash: 0,
          eftpos: 0,
          instore_subtotal: 0,

          doordash: 0,
          uber: 0,
          wak_app: 0,
          online_subtotal: 0,

          total_sales: 0,
          short_over: 0,

          morning_cashup: 0,

          notes: "",
          entered_by_name: "",
        };

      const morning = morningMap.get(key);
      const night = nightMap.get(key);

      const morningCash = morning?.total_cash != null ? Number(morning.total_cash) : 0;
      const baselineMorning =
        morning?.total_cash != null ? Number(morning.total_cash) : DEFAULT_FLOAT_IF_NO_MORNING;
      const nightTotal = night?.total_cash != null ? Number(night.total_cash) : 0;

      row.morning_cashup = morningCash;

      if (!row.expected_cash || row.expected_cash === 0) {
        row.expected_cash = round2(Math.max(0, nightTotal - baselineMorning));
      }

      row.instore_subtotal = round2(row.actual_cash + row.eftpos);
      row.online_subtotal = round2(row.doordash + row.uber + row.wak_app);
      row.total_sales = round2(row.instore_subtotal + row.online_subtotal);
      row.short_over = round2(row.actual_cash - row.expected_cash);

      map.set(key, row);
    }

    return Array.from(map.values()).sort((a, b) => b.business_date.localeCompare(a.business_date));
  }, [dailySales, platformIncome, cashups, profileMap, extraDates]);

  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };

      for (const r of rows) {
        const current = next[r.business_date];

        if (!current) {
          next[r.business_date] = {
            actual_cash: r.actual_cash ? String(r.actual_cash) : "",
            expected_cash: r.expected_cash ? String(r.expected_cash) : "",
            eftpos: r.eftpos ? String(r.eftpos) : "",
            doordash: r.doordash ? String(r.doordash) : "",
            uber: r.uber ? String(r.uber) : "",
            wak_app: r.wak_app ? String(r.wak_app) : "",
            morning_cashup: r.morning_cashup ? String(r.morning_cashup) : "",
            notes: r.notes ?? "",
          };
        }
      }

      return next;
    });
  }, [rows]);

  const dirtyDates = useMemo(() => {
    return rows
      .filter((r) => !draftEqualsRow(drafts[r.business_date], r))
      .map((r) => r.business_date);
  }, [rows, drafts]);

  const hasUnsavedChanges = dirtyDates.length > 0;

  useEffect(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    if (!hasUnsavedChanges) return;
    if (saveState === "saving") return;

    autoSaveTimerRef.current = setTimeout(() => {
      saveAll();
    }, AUTO_SAVE_DELAY);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, hasUnsavedChanges, saveState]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges || saveState === "saved") return;
      e.preventDefault();
      e.returnValue = "";
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges, saveState]);

  function patchLocalRowAfterSave(
    businessDate: string,
    values: {
      actualCash: number;
      expectedCash: number;
      eftpos: number;
      doordash: number;
      uber: number;
      wakApp: number;
      morningCashup: number;
      notes: string;
      uid: string | null;
    }
  ) {
    const {
      actualCash,
      expectedCash,
      eftpos,
      doordash,
      uber,
      wakApp,
      morningCashup,
      notes,
      uid,
    } = values;

    setDailySales((prev) => {
      const next = [...prev];
      const idx = next.findIndex(
        (x) => x.store_id === DEFAULT_STORE_ID && x.business_date === businessDate
      );

      const row: DailySalesRow = {
        business_date: businessDate,
        store_id: DEFAULT_STORE_ID,
        cash_sales: actualCash,
        expected_cash: expectedCash,
        eftpos_sales: eftpos,
        total_sales: round2(actualCash + eftpos + doordash + uber + wakApp),
        notes: notes || null,
        entered_by: uid ?? null,
      };

      if (idx >= 0) next[idx] = row;
      else next.push(row);

      return next;
    });

    setPlatformIncome((prev) => {
      const filtered = prev.filter((x) => {
        if (!(x.store_id === DEFAULT_STORE_ID && x.business_date === businessDate)) return true;
        const n = normalizePlatformName(x.platform);
        return !(n.includes("DOORDASH") || n.includes("UBER") || n.includes("WAK"));
      });

      return [
        ...filtered,
        {
          business_date: businessDate,
          store_id: DEFAULT_STORE_ID,
          platform: "DoorDash",
          gross_income: doordash,
          entered_by: uid ?? null,
        },
        {
          business_date: businessDate,
          store_id: DEFAULT_STORE_ID,
          platform: "Uber Eats",
          gross_income: uber,
          entered_by: uid ?? null,
        },
        {
          business_date: businessDate,
          store_id: DEFAULT_STORE_ID,
          platform: "WAK App",
          gross_income: wakApp,
          entered_by: uid ?? null,
        },
      ];
    });

    setCashups((prev) => {
      const next = [...prev];
      const idx = next.findIndex(
        (x) =>
          x.store_id === DEFAULT_STORE_ID &&
          x.business_date === businessDate &&
          String(x.session_type).toUpperCase() === "MORNING"
      );

      const row: CashupSessionRow = {
        business_date: businessDate,
        store_id: DEFAULT_STORE_ID,
        session_type: "MORNING",
        total_cash: morningCashup,
        removed_cash: 0,
        counts: {},
        entered_by: uid ?? null,
      };

      if (idx >= 0) next[idx] = row;
      else next.push(row);

      return next;
    });

    setDrafts((prev) => ({
      ...prev,
      [businessDate]: {
        actual_cash: actualCash ? String(actualCash) : "",
        expected_cash: expectedCash ? String(expectedCash) : "",
        eftpos: eftpos ? String(eftpos) : "",
        doordash: doordash ? String(doordash) : "",
        uber: uber ? String(uber) : "",
        wak_app: wakApp ? String(wakApp) : "",
        morning_cashup: morningCashup ? String(morningCashup) : "",
        notes: notes ?? "",
      },
    }));
  }

  function removeLocalRowAfterDelete(businessDate: string) {
    setDailySales((prev) =>
      prev.filter(
        (x) => !(x.store_id === DEFAULT_STORE_ID && x.business_date === businessDate)
      )
    );

    setPlatformIncome((prev) =>
      prev.filter(
        (x) => !(x.store_id === DEFAULT_STORE_ID && x.business_date === businessDate)
      )
    );

    setCashups((prev) =>
      prev.filter(
        (x) => !(x.store_id === DEFAULT_STORE_ID && x.business_date === businessDate)
      )
    );

    setExtraDates((prev) => prev.filter((d) => d !== businessDate));

    setDrafts((prev) => {
      const next = { ...prev };
      delete next[businessDate];
      return next;
    });
  }

  async function saveOneDate(businessDate: string) {
    const { data: s } = await supabase.auth.getSession();
    const uid = s.session?.user?.id ?? null;

    if (!uid) throw new Error("Not logged in.");

    const d = drafts[businessDate];
    if (!d) return null;

    const actualCash = parseMoneyText(d.actual_cash);
    const expectedCash = parseMoneyText(d.expected_cash);
    const eftpos = parseMoneyText(d.eftpos);
    const doordash = parseMoneyText(d.doordash);
    const uber = parseMoneyText(d.uber);
    const wakApp = parseMoneyText(d.wak_app);
    const morningCashup = parseMoneyText(d.morning_cashup);
    const notes = (d.notes ?? "").trim();

    const instoreSubtotal = round2(actualCash + eftpos);
    const onlineSubtotal = round2(doordash + uber + wakApp);
    const totalSales = round2(instoreSubtotal + onlineSubtotal);

    const ds = await supabase.from("daily_sales").upsert(
      {
        business_date: businessDate,
        store_id: DEFAULT_STORE_ID,
        cash_sales: actualCash,
        expected_cash: expectedCash,
        eftpos_sales: eftpos,
        total_sales: totalSales,
        notes: notes || null,
        entered_by: uid,
      },
      { onConflict: "business_date,store_id" } as any
    );

    if (ds.error) throw new Error("Save daily sales failed: " + ds.error.message);

    const platformRows = [
      { platform: "DoorDash", value: doordash },
      { platform: "Uber Eats", value: uber },
      { platform: "WAK App", value: wakApp },
    ];

    for (const p of platformRows) {
      const res = await supabase.from("platform_income").upsert(
        {
          business_date: businessDate,
          store_id: DEFAULT_STORE_ID,
          platform: p.platform,
          gross_income: p.value,
          entered_by: uid,
        },
        { onConflict: "business_date,store_id,platform" } as any
      );

      if (res.error) throw new Error(`Save ${p.platform} failed: ${res.error.message}`);
    }

    const morning = await supabase.from("cashup_sessions").upsert(
      {
        business_date: businessDate,
        store_id: DEFAULT_STORE_ID,
        session_type: "MORNING",
        counts: {},
        total_cash: morningCashup,
        removed_cash: 0,
        entered_by: uid,
      },
      { onConflict: "business_date,store_id,session_type" } as any
    );

    if (morning.error) throw new Error("Save morning cashup failed: " + morning.error.message);

    return {
      businessDate,
      actualCash,
      expectedCash,
      eftpos,
      doordash,
      uber,
      wakApp,
      morningCashup,
      notes,
      uid,
    };
  }

  async function saveAll() {
    if (!hasUnsavedChanges) {
      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      return;
    }

    try {
      setSaveState("saving");
      setSaveError("");
      setMsg("");

      const changedDates = [...dirtyDates];

      for (const businessDate of changedDates) {
        const saved = await saveOneDate(businessDate);
        if (saved) {
          patchLocalRowAfterSave(businessDate, {
            actualCash: saved.actualCash,
            expectedCash: saved.expectedCash,
            eftpos: saved.eftpos,
            doordash: saved.doordash,
            uber: saved.uber,
            wakApp: saved.wakApp,
            morningCashup: saved.morningCashup,
            notes: saved.notes,
            uid: saved.uid,
          });

          if (!extraDates.includes(businessDate)) {
            setExtraDates((prev) => [...prev, businessDate]);
          }
        }
      }

      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      setMsg(`✅ Saved ${changedDates.length} changed row(s).`);
    } catch (e: any) {
      setSaveState("error");
      setSaveError(e?.message ?? "Save failed");
      setMsg("❌ " + (e?.message ?? "Save failed"));
    }
  }

  async function deleteDate(businessDate: string) {
    const ok = confirm(`Delete all data for ${businessDate}?`);
    if (!ok) return;

    try {
      setMsg("");
      setSaveState("saving");

      const [a, b, c] = await Promise.all([
        supabase
          .from("daily_sales")
          .delete()
          .eq("store_id", DEFAULT_STORE_ID)
          .eq("business_date", businessDate),

        supabase
          .from("platform_income")
          .delete()
          .eq("store_id", DEFAULT_STORE_ID)
          .eq("business_date", businessDate),

        supabase
          .from("cashup_sessions")
          .delete()
          .eq("store_id", DEFAULT_STORE_ID)
          .eq("business_date", businessDate),
      ]);

      if (a.error) throw new Error("Delete daily sales failed: " + a.error.message);
      if (b.error) throw new Error("Delete platform income failed: " + b.error.message);
      if (c.error) throw new Error("Delete cashup sessions failed: " + c.error.message);

      removeLocalRowAfterDelete(businessDate);

      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      setMsg(`✅ Deleted ${businessDate}.`);
    } catch (e: any) {
      setSaveState("error");
      setSaveError(e?.message ?? "Delete failed");
      setMsg("❌ " + (e?.message ?? "Delete failed"));
    }
  }

  function addNewEmptyDate() {
    const d = newDate.trim();
    if (!d) return;

    if (!extraDates.includes(d)) {
      setExtraDates((prev) => [...prev, d]);
    }

    setDrafts((prev) => ({
      ...prev,
      [d]: prev[d] ?? {
        actual_cash: "",
        expected_cash: "",
        eftpos: "",
        doordash: "",
        uber: "",
        wak_app: "",
        morning_cashup: "",
        notes: "",
      },
    }));

    setMsg(`✅ Added empty row for ${d}`);
  }

  function setDraftValue(date: string, key: keyof EditDraft, value: string) {
    setDrafts((prev) => ({
      ...prev,
      [date]: {
        ...(prev[date] ?? {
          actual_cash: "",
          expected_cash: "",
          eftpos: "",
          doordash: "",
          uber: "",
          wak_app: "",
          morning_cashup: "",
          notes: "",
        }),
        [key]: value,
      },
    }));
    if (saveState !== "saving") setSaveState("idle");
  }

  function exportCSV() {
    const csvRows: string[][] = [
      [
        "Date",
        "Day",
        "Actual Cash",
        "Expected Cash",
        "EFTPOS",
        "Sub-TI",
        "DOORDASH",
        "UBER",
        "WAK App",
        "Online Sub-TI",
        "TI Sales",
        "Morning Cashup",
        "Short/Over",
        "Notes",
        "Entered By",
      ],
      ...rows.map((r) => [
        r.business_date,
        r.day,
        r.actual_cash.toFixed(2),
        r.expected_cash.toFixed(2),
        r.eftpos.toFixed(2),
        r.instore_subtotal.toFixed(2),
        r.doordash.toFixed(2),
        r.uber.toFixed(2),
        r.wak_app.toFixed(2),
        r.online_subtotal.toFixed(2),
        r.total_sales.toFixed(2),
        r.morning_cashup.toFixed(2),
        r.short_over.toFixed(2),
        r.notes,
        r.entered_by_name,
      ]),
    ];

    downloadCSV(`daily_entry_log_${DEFAULT_STORE_ID}_${startDate}_to_${endDate}.csv`, csvRows);
  }

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.actual_cash += r.actual_cash;
        acc.eftpos += r.eftpos;
        acc.doordash += r.doordash;
        acc.uber += r.uber;
        acc.wak += r.wak_app;
        acc.total_instore += r.instore_subtotal;
        acc.total_online += r.online_subtotal;
        acc.total_sales += r.total_sales;
        return acc;
      },
      {
        actual_cash: 0,
        eftpos: 0,
        doordash: 0,
        uber: 0,
        wak: 0,
        total_instore: 0,
        total_online: 0,
        total_sales: 0,
      }
    );
  }, [rows]);

  function saveBadge() {
    if (saveState === "saving") {
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

    if (hasUnsavedChanges) {
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
          {dirtyDates.length} row(s) changed
        </div>
      );
    }

    if (saveState === "error") {
      return (
        <div
          title={saveError || "Save failed"}
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

    if (saveState === "saved" || lastSavedAt) {
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

    return null;
  }

  if (roleLoading || loading) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 1750, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ margin: 0, color: TEXT }}>Daily Entry Log</h1>
            <div style={{ marginTop: 10, color: MUTED }}>Loading...</div>
          </div>
        </div>
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ marginTop: 0, color: TEXT }}>Daily Entry Log</h1>
            <div
              style={{
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                padding: 14,
                marginTop: 14,
                background: "#fff",
                color: TEXT,
              }}
            >
              Access denied. This page is only for <b>OWNER</b>.
            </div>

            <div style={{ marginTop: 16 }}>
              {actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
      <div style={{ maxWidth: 1750, margin: "0 auto" }}>
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
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 14,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1 style={{ margin: 0, color: TEXT }}>Daily Entry Log</h1>
              <div style={{ marginTop: 6, color: MUTED }}>
                Owner-only daily table for staff daily-entry records
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {saveBadge()}
              {actionButton("Save All", saveAll, {
                primary: true,
                disabled: saveState === "saving" || !hasUnsavedChanges,
              })}
              {actionButton("Export CSV", exportCSV)}
              {actionButton("Refresh", loadAll)}
              {actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}
            </div>
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
          <div
            style={{
              display: "flex",
              gap: 14,
              alignItems: "end",
              flexWrap: "wrap",
              marginBottom: 16,
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Start date</div>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={inputStyle(170)}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>End date</div>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={inputStyle(170)}
              />
            </div>

            {actionButton("Last 7 days", () => {
              setStartDate(dateDaysAgo(7));
              setEndDate(todayDateInputValue());
            })}

            {actionButton("Last 30 days", () => {
              setStartDate(dateDaysAgo(30));
              setEndDate(todayDateInputValue());
            })}

            {actionButton("This Month", () => {
              const now = new Date();
              const pad = (n: number) => String(n).padStart(2, "0");
              setStartDate(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`);
              setEndDate(todayDateInputValue());
            })}

            <div style={{ marginLeft: 16 }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Add empty row date</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  style={inputStyle(170)}
                />
                {actionButton("Add Empty Row", addNewEmptyDate, { primary: true })}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            {statCard("Actual Cash", money(totals.actual_cash), WAK_BLUE)}
            {statCard("EFTPOS", money(totals.eftpos))}
            {statCard("DOORDASH", money(totals.doordash))}
            {statCard("UBER", money(totals.uber))}
            {statCard("WAK", money(totals.wak))}
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {statCard("Total Instore", money(totals.total_instore), WAK_BLUE)}
            {statCard("Total Online", money(totals.total_online))}
            {statCard("Total Sales", money(totals.total_sales), WAK_RED)}
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
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Table View</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
              Short / Over = Actual Cash − Expected Cash
            </div>
          </div>

          <div
            style={{
              overflowX: "auto",
              overflowY: "auto",
              maxHeight: "72vh",
              border: `1px solid ${BORDER}`,
              borderRadius: 14,
            }}
          >
            <table
              style={{
                borderCollapse: "separate",
                borderSpacing: 0,
                minWidth: 1540,
                width: "max-content",
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      ...groupHeaderStyle(FROZEN_HEADER_BG, 6),
                      position: "sticky",
                      left: 0,
                      minWidth: DATE_COL_W + DAY_COL_W,
                      maxWidth: DATE_COL_W + DAY_COL_W,
                    }}
                    colSpan={2}
                  >
                    Date
                  </th>

                  <th style={{ ...groupHeaderStyle(INSTORE_BG, 3) }} colSpan={4}>
                    Instore
                  </th>

                  <th style={{ ...groupHeaderStyle(ONLINE_BG, 3) }} colSpan={4}>
                    Online
                  </th>

                  <th style={{ ...groupHeaderStyle(TOTAL_BG, 3) }} colSpan={1}>
                    Total
                  </th>

                  <th style={{ ...groupHeaderStyle(CONTROL_BG, 3) }} colSpan={4}>
                    Other
                  </th>

                  <th style={{ ...groupHeaderStyle(FROZEN_HEADER_BG, 3) }} colSpan={1}>
                    Action
                  </th>
                </tr>

                <tr>
                  <th
                    style={{
                      ...columnHeaderStyle(FROZEN_HEADER_BG, 7),
                      position: "sticky",
                      left: 0,
                      minWidth: DATE_COL_W,
                      maxWidth: DATE_COL_W,
                    }}
                  >
                    Date
                  </th>

                  <th
                    style={{
                      ...columnHeaderStyle(FROZEN_HEADER_BG, 7),
                      position: "sticky",
                      left: DATE_COL_W,
                      minWidth: DAY_COL_W,
                      maxWidth: DAY_COL_W,
                    }}
                  >
                    Day
                  </th>

                  <th style={{ ...columnHeaderStyle(INSTORE_BG), minWidth: 82 }}>Actual<br />Cash</th>
                  <th style={{ ...columnHeaderStyle(INSTORE_BG), minWidth: 82 }}>Expected<br />Cash</th>
                  <th style={{ ...columnHeaderStyle(INSTORE_BG), minWidth: 74 }}>EFTPOS</th>
                  <th style={{ ...columnHeaderStyle(INSTORE_BG), minWidth: 78, fontWeight: 900 }}>Sub-TI</th>

                  <th style={{ ...columnHeaderStyle(ONLINE_BG), minWidth: 82 }}>DOORDASH</th>
                  <th style={{ ...columnHeaderStyle(ONLINE_BG), minWidth: 70 }}>UBER</th>
                  <th style={{ ...columnHeaderStyle(ONLINE_BG), minWidth: 76 }}>WAK App</th>
                  <th style={{ ...columnHeaderStyle(ONLINE_BG), minWidth: 90, fontWeight: 900 }}>Online<br />Sub-TI</th>

                  <th style={{ ...columnHeaderStyle(TOTAL_BG), minWidth: 82, fontWeight: 900 }}>TI Sales</th>

                  <th style={{ ...columnHeaderStyle(CONTROL_BG), minWidth: 88 }}>Morning<br />Cashup</th>
                  <th style={{ ...columnHeaderStyle(CONTROL_BG), minWidth: 86 }}>Short /<br />Over</th>
                  <th style={{ ...columnHeaderStyle(CONTROL_BG), minWidth: 150 }}>Notes</th>
                  <th style={{ ...columnHeaderStyle(CONTROL_BG), minWidth: 96 }}>Entered By</th>

                  <th style={{ ...columnHeaderStyle(FROZEN_HEADER_BG), minWidth: 82 }}>Delete</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((r) => {
                  const d = drafts[r.business_date] ?? {
                    actual_cash: "",
                    expected_cash: "",
                    eftpos: "",
                    doordash: "",
                    uber: "",
                    wak_app: "",
                    morning_cashup: "",
                    notes: "",
                  };

                  const actualCash = parseMoneyText(d.actual_cash);
                  const expectedCash = parseMoneyText(d.expected_cash);
                  const eftpos = parseMoneyText(d.eftpos);
                  const doordash = parseMoneyText(d.doordash);
                  const uber = parseMoneyText(d.uber);
                  const wakApp = parseMoneyText(d.wak_app);

                  const instoreSubtotal = round2(actualCash + eftpos);
                  const onlineSubtotal = round2(doordash + uber + wakApp);
                  const totalSales = round2(instoreSubtotal + onlineSubtotal);
                  const shortOver = round2(actualCash - expectedCash);
                  const shortOverIsZero = Math.abs(shortOver) < 0.01;

                  return (
                    <tr key={r.business_date}>
                      <td
                        style={{
                          ...bodyCellStyle("left", FROZEN_BG, {
                            position: "sticky",
                            left: 0,
                            zIndex: 2,
                            minWidth: DATE_COL_W,
                            maxWidth: DATE_COL_W,
                            fontWeight: 700,
                          }),
                        }}
                      >
                        {r.business_date}
                      </td>

                      <td
                        style={{
                          ...bodyCellStyle("center", FROZEN_BG, {
                            position: "sticky",
                            left: DATE_COL_W,
                            zIndex: 2,
                            minWidth: DAY_COL_W,
                            maxWidth: DAY_COL_W,
                            fontWeight: 700,
                          }),
                        }}
                      >
                        {r.day}
                      </td>

                      <td style={bodyCellStyle("center", INSTORE_BG)}>
                        <input
                          value={d.actual_cash}
                          onChange={(e) => setDraftValue(r.business_date, "actual_cash", e.target.value)}
                          style={inputStyle(74)}
                        />
                      </td>

                      <td style={bodyCellStyle("center", INSTORE_BG)}>
                        <input
                          value={d.expected_cash}
                          onChange={(e) => setDraftValue(r.business_date, "expected_cash", e.target.value)}
                          style={inputStyle(74)}
                        />
                      </td>

                      <td style={bodyCellStyle("center", INSTORE_BG)}>
                        <input
                          value={d.eftpos}
                          onChange={(e) => setDraftValue(r.business_date, "eftpos", e.target.value)}
                          style={inputStyle(70)}
                        />
                      </td>

                      <td style={bodyCellStyle("right", INSTORE_BG, { fontWeight: 900 })}>
                        {money(instoreSubtotal)}
                      </td>

                      <td style={bodyCellStyle("center", ONLINE_BG)}>
                        <input
                          value={d.doordash}
                          onChange={(e) => setDraftValue(r.business_date, "doordash", e.target.value)}
                          style={inputStyle(74)}
                        />
                      </td>

                      <td style={bodyCellStyle("center", ONLINE_BG)}>
                        <input
                          value={d.uber}
                          onChange={(e) => setDraftValue(r.business_date, "uber", e.target.value)}
                          style={inputStyle(66)}
                        />
                      </td>

                      <td style={bodyCellStyle("center", ONLINE_BG)}>
                        <input
                          value={d.wak_app}
                          onChange={(e) => setDraftValue(r.business_date, "wak_app", e.target.value)}
                          style={inputStyle(70)}
                        />
                      </td>

                      <td style={bodyCellStyle("right", ONLINE_BG, { fontWeight: 900 })}>
                        {money(onlineSubtotal)}
                      </td>

                      <td style={bodyCellStyle("right", TOTAL_BG, { fontWeight: 900, fontSize: 15 })}>
                        {money(totalSales)}
                      </td>

                      <td style={bodyCellStyle("center", CONTROL_BG)}>
                        <input
                          value={d.morning_cashup}
                          onChange={(e) => setDraftValue(r.business_date, "morning_cashup", e.target.value)}
                          style={inputStyle(80)}
                        />
                      </td>

                      <td
                        style={bodyCellStyle(
                          "right",
                          shortOverIsZero ? "#F0FDF4" : "#FEF2F2",
                          {
                            color: shortOverIsZero ? "#15803D" : WAK_RED,
                            fontWeight: 800,
                          }
                        )}
                      >
                        {money(shortOver)}
                      </td>

                      <td style={bodyCellStyle("center", CONTROL_BG)}>
                        <input
                          value={d.notes}
                          onChange={(e) => setDraftValue(r.business_date, "notes", e.target.value)}
                          style={inputStyle(146)}
                        />
                      </td>

                      <td style={bodyCellStyle("left", CONTROL_BG)}>{r.entered_by_name || "-"}</td>

                      <td style={bodyCellStyle("center", "#fff")}>
                        {actionButton("Delete", () => deleteDate(r.business_date), {
                          danger: true,
                          disabled: saveState === "saving",
                        })}
                      </td>
                    </tr>
                  );
                })}

                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={16}
                      style={{
                        padding: 16,
                        color: "#9CA3AF",
                        borderBottom: `1px solid ${BORDER}`,
                      }}
                    >
                      No data found in this date range.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}