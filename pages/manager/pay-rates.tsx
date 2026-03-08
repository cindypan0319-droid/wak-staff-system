import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Profile = {
  id: string;
  full_name: string | null;
  role?: string | null;
  is_active?: boolean | null;
};

type RateRow = {
  staff_id: string;
  store_id?: string | null;
  weekday_rate: number;
  saturday_rate: number;
  sunday_rate: number;
};

const DEFAULT_STORE_ID = "MOOROOLBARK";

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

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
        minHeight: 44,
        borderRadius: 12,
        border: `1px solid ${borderColor}`,
        background: bg,
        color: textColor,
        fontWeight: 800,
        fontSize: 14,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: primary || danger ? "0 8px 18px rgba(0,0,0,0.10)" : "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function inputStyle(width?: number | string, disabled?: boolean) {
  return {
    width: width ?? "100%",
    maxWidth: "100%",
    boxSizing: "border-box" as const,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #D1D5DB",
    fontSize: 14,
    background: disabled ? "#F3F4F6" : "#fff",
    color: TEXT,
  };
}

export default function PayRatesPage() {
  const [authLoading, setAuthLoading] = useState(true);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const isManagerOrOwner = viewerRole === "OWNER" || viewerRole === "MANAGER";

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [rates, setRates] = useState<RateRow[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadPermission() {
    setAuthLoading(true);
    setMsg("");

    const { data } = await supabase.auth.getUser();
    const user = data?.user;

    if (!user) {
      window.location.href = "/";
      return;
    }

    setViewerId(user.id);

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, full_name, role, is_active")
      .eq("id", user.id)
      .single();

    if (error) {
      setViewerRole(null);
      setMsg("❌ Cannot load your role: " + error.message);
      setAuthLoading(false);
      return;
    }

    setViewerRole((profile as any)?.role ?? null);
    setAuthLoading(false);
  }

  async function load() {
    setLoading(true);
    setMsg("");

    const p = await supabase
      .from("profiles")
      .select("id, full_name, role, is_active")
      .order("full_name", { ascending: true });

    if (p.error) {
      setMsg("❌ Cannot load profiles: " + p.error.message);
      setProfiles([]);
      setRates([]);
      setLoading(false);
      return;
    }

    const activeProfiles = (p.data ?? []).filter(
      (x: any) => x?.is_active === undefined || x?.is_active === null || x?.is_active === true
    );

    setProfiles(activeProfiles as any);

    const r = await supabase
      .from("staff_pay_rates")
      .select("staff_id, store_id, weekday_rate, saturday_rate, sunday_rate")
      .eq("store_id", DEFAULT_STORE_ID);

    if (r.error) {
      setMsg("❌ Cannot load rates: " + r.error.message);
      setRates([]);
      setLoading(false);
      return;
    }

    const toNum = (v: any) => Number(v ?? 0);

    setRates(
      (r.data ?? []).map((x: any) => ({
        staff_id: x.staff_id,
        store_id: x.store_id,
        weekday_rate: toNum(x.weekday_rate),
        saturday_rate: toNum(x.saturday_rate),
        sunday_rate: toNum(x.sunday_rate),
      }))
    );

    setLoading(false);
  }

  useEffect(() => {
    loadPermission();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!authLoading && isManagerOrOwner) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, viewerRole]);

  const profileById = useMemo(() => {
    const map: Record<string, Profile> = {};
    for (const p of profiles) map[p.id] = p;
    return map;
  }, [profiles]);

  function nameOf(id: string) {
    const p = profileById[id];
    return p?.full_name?.trim() ? p.full_name : id.slice(0, 8);
  }

  function getRate(staffId: string): RateRow | null {
    return rates.find((x) => x.staff_id === staffId) ?? null;
  }

  function setLocalRate(staffId: string, patch: Partial<RateRow>) {
    setRates((prev) => {
      const existing = prev.find((x) => x.staff_id === staffId);
      if (!existing) {
        return [
          ...prev,
          {
            staff_id: staffId,
            store_id: DEFAULT_STORE_ID,
            weekday_rate: 0,
            saturday_rate: 0,
            sunday_rate: 0,
            ...patch,
          } as RateRow,
        ];
      }
      return prev.map((x) => (x.staff_id === staffId ? { ...x, ...patch } : x));
    });
  }

  async function save(staffId: string) {
    setMsg("");

    const row = getRate(staffId);
    if (!row) {
      setMsg("❌ No local row to save.");
      return;
    }

    const payload: any = {
      staff_id: staffId,
      store_id: DEFAULT_STORE_ID,
      weekday_rate: Number(row.weekday_rate),
      saturday_rate: Number(row.saturday_rate),
      sunday_rate: Number(row.sunday_rate),
      updated_by: viewerId,
      updated_at: new Date().toISOString(),
    };

    const res = await supabase.from("staff_pay_rates").upsert(payload, {
      onConflict: "staff_id",
    } as any);

    if (res.error) {
      setMsg("❌ Save failed: " + res.error.message);
      return;
    }

    setMsg("✅ Saved!");
    await load();
  }

  const activeStaffCount = profiles.length;
  const configuredCount = profiles.filter((p) => !!getRate(p.id)).length;

  if (authLoading) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ margin: 0, color: TEXT }}>Pay Rates</h1>
            <div style={{ marginTop: 10, color: MUTED }}>Loading permission...</div>
          </div>
        </div>
      </div>
    );
  }

  if (!isManagerOrOwner) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <div style={{ marginBottom: 12 }}>
            {actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}
          </div>

          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ marginTop: 0, color: TEXT }}>Pay Rates</h1>
            <div
              style={{
                padding: 14,
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                background: "#fff",
                color: TEXT,
              }}
            >
              <b>Access denied.</b> This page is only for <b>Owner / Manager</b>.
              <br />
              Your role: <b>{viewerRole ?? "UNKNOWN"}</b>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        <div style={{ marginBottom: 12 }}>
          {actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}
        </div>

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
          <h1 style={{ margin: 0, color: TEXT }}>Pay Rates</h1>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "#F9FAFB",
              border: `1px solid ${BORDER}`,
              minWidth: 160,
            }}
          >
            <div style={{ fontSize: 12, color: MUTED }}>Store</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: TEXT }}>{DEFAULT_STORE_ID}</div>
          </div>

          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "#F9FAFB",
              border: `1px solid ${BORDER}`,
              minWidth: 160,
            }}
          >
            <div style={{ fontSize: 12, color: MUTED }}>Active staff</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: WAK_BLUE }}>{activeStaffCount}</div>
          </div>

          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "#F9FAFB",
              border: `1px solid ${BORDER}`,
              minWidth: 160,
            }}
          >
            <div style={{ fontSize: 12, color: MUTED }}>Rates loaded</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: WAK_RED }}>{configuredCount}</div>
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
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {actionButton("Refresh", load, { primary: true, disabled: loading })}
            {loading && <span style={{ color: MUTED, fontWeight: 700 }}>Loading...</span>}
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
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Staff Rates</h2>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table
              cellPadding={0}
              style={{
                width: "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
                minWidth: 860,
              }}
            >
              <thead>
                <tr>
                  {["Staff", "Weekday rate", "Saturday rate", "Sunday rate", "Action"].map((head) => (
                    <th
                      key={head}
                      style={{
                        textAlign: "left",
                        padding: "14px 12px",
                        borderBottom: `1px solid ${BORDER}`,
                        color: MUTED,
                        fontSize: 13,
                        background: "#FAFAFA",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {profiles.map((p) => {
                  const r = getRate(p.id) ?? {
                    staff_id: p.id,
                    store_id: DEFAULT_STORE_ID,
                    weekday_rate: 0,
                    saturday_rate: 0,
                    sunday_rate: 0,
                  };

                  return (
                    <tr key={p.id}>
                      <td
                        style={{
                          padding: "14px 12px",
                          borderBottom: `1px solid ${BORDER}`,
                          fontWeight: 700,
                          color: TEXT,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {nameOf(p.id)}
                      </td>

                      <td style={{ padding: "14px 12px", borderBottom: `1px solid ${BORDER}` }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={r.weekday_rate}
                          onChange={(e) => setLocalRate(p.id, { weekday_rate: Number(e.target.value) })}
                          style={inputStyle(140)}
                        />
                      </td>

                      <td style={{ padding: "14px 12px", borderBottom: `1px solid ${BORDER}` }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={r.saturday_rate}
                          onChange={(e) => setLocalRate(p.id, { saturday_rate: Number(e.target.value) })}
                          style={inputStyle(140)}
                        />
                      </td>

                      <td style={{ padding: "14px 12px", borderBottom: `1px solid ${BORDER}` }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={r.sunday_rate}
                          onChange={(e) => setLocalRate(p.id, { sunday_rate: Number(e.target.value) })}
                          style={inputStyle(140)}
                        />
                      </td>

                      <td
                        style={{
                          padding: "14px 12px",
                          borderBottom: `1px solid ${BORDER}`,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {actionButton("Save", () => save(p.id), {
                          primary: true,
                          disabled: loading,
                        })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 12, fontSize: 12, color: MUTED }}>
            Rates support decimal values up to 2 decimal places.
          </div>
        </div>
      </div>
    </div>
  );
}