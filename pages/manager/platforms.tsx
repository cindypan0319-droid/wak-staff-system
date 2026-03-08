import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Platform = {
  id: number;
  name: string;
  is_active: boolean;
  sort_order: number;
};

type FeeSetting = {
  platform_name: string;
  commission_pct: number;
  subscription_fee: number;
};

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const BG = "#F5F6F8";
const CARD = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

function toNum(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function inputStyle(width?: number | string) {
  return {
    width: width ?? "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #D1D5DB",
    fontSize: 14,
  };
}

function button(label: string, onClick: () => void, primary?: boolean, disabled?: boolean) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 14px",
        borderRadius: 10,
        border: "none",
        background: primary ? WAK_BLUE : "#E5E7EB",
        color: primary ? "#fff" : TEXT,
        fontWeight: 700,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

export default function PlatformsPage() {
  const [authLoading, setAuthLoading] = useState(true);
  const [viewerRole, setViewerRole] = useState<string | null>(null);

  const isOwner = viewerRole === "OWNER";
  const isManagerOrOwner = viewerRole === "OWNER" || viewerRole === "MANAGER";

  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [feeSettings, setFeeSettings] = useState<FeeSetting[]>([]);
  const [draft, setDraft] = useState<Record<string, { commission_pct: number; subscription_fee: number }>>({});
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const feeByName = useMemo(() => {
    const m: Record<string, FeeSetting> = {};
    for (const f of feeSettings) m[f.platform_name] = f;
    return m;
  }, [feeSettings]);

  async function loadPermission() {
    setAuthLoading(true);
    setMsg("");

    const { data } = await supabase.auth.getUser();
    const user = data?.user;

    if (!user) {
      window.location.href = "/";
      return;
    }

    const { data: profile, error } = await supabase
      .from("profiles")
      .select("id, role")
      .eq("id", user.id)
      .single();

    if (error) {
      setViewerRole(null);
      setMsg("Cannot load role");
      setAuthLoading(false);
      return;
    }

    setViewerRole((profile as any)?.role ?? null);
    setAuthLoading(false);
  }

  async function load() {
    setLoading(true);

    const res = await supabase
      .from("platforms")
      .select("id, name, is_active, sort_order")
      .order("sort_order", { ascending: true });

    if (res.error) {
      setMsg("Cannot load platforms");
      setLoading(false);
      return;
    }

    const plats = (res.data ?? []) as Platform[];
    setPlatforms(plats);

    if (isOwner) {
      const f = await supabase
        .from("platform_fee_settings")
        .select("platform_name, commission_pct, subscription_fee");

      const settings: FeeSetting[] = (f.data ?? []).map((x: any) => ({
        platform_name: x.platform_name,
        commission_pct: toNum(x.commission_pct),
        subscription_fee: toNum(x.subscription_fee),
      }));

      setFeeSettings(settings);

      const nextDraft: Record<string, { commission_pct: number; subscription_fee: number }> = {};

      for (const p of plats) {
        const s = settings.find((z) => z.platform_name === p.name);
        nextDraft[p.name] = {
          commission_pct: toNum(s?.commission_pct ?? 0),
          subscription_fee: toNum(s?.subscription_fee ?? 0),
        };
      }

      setDraft(nextDraft);
    }

    setLoading(false);
  }

  useEffect(() => {
    loadPermission();
  }, []);

  useEffect(() => {
    if (!authLoading && isManagerOrOwner) load();
  }, [authLoading, viewerRole]);

  function setDraftField(name: string, patch: Partial<{ commission_pct: number; subscription_fee: number }>) {
    setDraft((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? { commission_pct: 0, subscription_fee: 0 }), ...patch },
    }));
  }

  async function add() {
    if (!isOwner) return;

    const name = newName.trim();
    if (!name) return;

    setLoading(true);

    await supabase.from("platforms").insert({
      name,
      is_active: true,
      sort_order: 100,
    });

    await supabase.from("platform_fee_settings").insert({
      platform_name: name,
      commission_pct: 0,
      subscription_fee: 0,
    });

    setNewName("");
    await load();
    setLoading(false);
  }

  async function toggleActive(p: Platform) {
    if (!isOwner) return;

    setLoading(true);

    await supabase
      .from("platforms")
      .update({ is_active: !p.is_active })
      .eq("id", p.id);

    await load();
    setLoading(false);
  }

  async function updateSort(p: Platform, sort: number) {
    if (!isOwner) return;

    await supabase
      .from("platforms")
      .update({ sort_order: sort })
      .eq("id", p.id);

    load();
  }

  async function saveFee(platformName: string) {
    if (!isOwner) return;

    const d = draft[platformName] ?? { commission_pct: 0, subscription_fee: 0 };

    await supabase.from("platform_fee_settings").upsert({
      platform_name: platformName,
      commission_pct: d.commission_pct,
      subscription_fee: d.subscription_fee,
    });

    load();
  }

  if (authLoading) return <div style={{ padding: 20 }}>Loading...</div>;

  if (!isManagerOrOwner) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Platforms</h1>
        Access denied.
      </div>
    );
  }

  return (
    <div style={{ background: BG, minHeight: "100vh", padding: 20 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>

        <div style={{ marginBottom: 12 }}>
          {button("← Back to Home", () => (window.location.href = "/staff/home"))}
        </div>

        <div
          style={{
            background: CARD,
            padding: 20,
            borderRadius: 16,
            border: `1px solid ${BORDER}`,
            marginBottom: 16,
          }}
        >
          <h1 style={{ margin: 0 }}>Platform Commission</h1>
        </div>

        <div
          style={{
            background: CARD,
            padding: 20,
            borderRadius: 16,
            border: `1px solid ${BORDER}`,
            marginBottom: 16,
          }}
        >

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
            <div style={{ minWidth: 240 }}>
              <div style={{ fontSize: 12, color: MUTED }}>Add platform</div>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Uber Eats"
                disabled={!isOwner}
                style={inputStyle()}
              />
            </div>

            {button("Add", add, true, !isOwner)}
            {button("Refresh", load)}
          </div>
        </div>

        {msg && (
          <div style={{ padding: 10, background: CARD, border: `1px solid ${BORDER}`, marginBottom: 12 }}>
            {msg}
          </div>
        )}

        <div
          style={{
            background: CARD,
            borderRadius: 16,
            border: `1px solid ${BORDER}`,
            overflow: "hidden",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: "#FAFAFA" }}>
              <tr>
                <th style={{ padding: 10, textAlign: "left" }}>Platform</th>
                <th style={{ padding: 10, textAlign: "left" }}>Active</th>
                <th style={{ padding: 10, textAlign: "left" }}>Sort</th>

                {isOwner && (
                  <>
                    <th style={{ padding: 10 }}>Commission %</th>
                    <th style={{ padding: 10 }}>Subscription</th>
                    <th style={{ padding: 10 }}>Save</th>
                  </>
                )}

                <th style={{ padding: 10 }}>Action</th>
              </tr>
            </thead>

            <tbody>
              {platforms.map((p) => {
                const d = draft[p.name] ?? { commission_pct: 0, subscription_fee: 0 };

                return (
                  <tr key={p.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td style={{ padding: 10, fontWeight: 700 }}>{p.name}</td>
                    <td style={{ padding: 10 }}>{p.is_active ? "YES" : "NO"}</td>

                    <td style={{ padding: 10 }}>
                      <input
                        type="number"
                        value={p.sort_order}
                        onChange={(e) => updateSort(p, Number(e.target.value))}
                        style={inputStyle(80)}
                        disabled={!isOwner}
                      />
                    </td>

                    {isOwner && (
                      <>
                        <td style={{ padding: 10 }}>
                          <input
                            type="number"
                            value={d.commission_pct}
                            onChange={(e) =>
                              setDraftField(p.name, { commission_pct: Number(e.target.value) })
                            }
                            style={inputStyle(120)}
                          />
                        </td>

                        <td style={{ padding: 10 }}>
                          <input
                            type="number"
                            value={d.subscription_fee}
                            onChange={(e) =>
                              setDraftField(p.name, { subscription_fee: Number(e.target.value) })
                            }
                            style={inputStyle(140)}
                          />
                        </td>

                        <td style={{ padding: 10 }}>
                          {button("Save", () => saveFee(p.name), true)}
                        </td>
                      </>
                    )}

                    <td style={{ padding: 10 }}>
                      {button(
                        p.is_active ? "Deactivate" : "Activate",
                        () => toggleActive(p),
                        false,
                        !isOwner
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {isOwner && (
          <div style={{ marginTop: 12, fontSize: 12, color: MUTED }}>
            Fees will be auto-calculated: <b>gross × commission + subscription</b>
          </div>
        )}
      </div>
    </div>
  );
}