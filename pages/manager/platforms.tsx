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

function toNum(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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
      setMsg("❌ Cannot load role: " + error.message);
      setAuthLoading(false);
      return;
    }

    setViewerRole((profile as any)?.role ?? null);
    setAuthLoading(false);
  }

  async function load() {
    setLoading(true);
    setMsg("");

    const res = await supabase
      .from("platforms")
      .select("id, name, is_active, sort_order")
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true });

    if (res.error) {
      setMsg("❌ Cannot load platforms: " + res.error.message);
      setPlatforms([]);
      setFeeSettings([]);
      setDraft({});
      setLoading(false);
      return;
    }

    const plats = (res.data ?? []) as any as Platform[];
    setPlatforms(plats);

    if (isOwner) {
      const f = await supabase
        .from("platform_fee_settings")
        .select("platform_name, commission_pct, subscription_fee");

      if (f.error) {
        setMsg("❌ Cannot load fee settings: " + f.error.message);
        setFeeSettings([]);
        setDraft({});
      } else {
        const settings: FeeSetting[] = (f.data ?? []).map((x: any) => ({
          platform_name: x.platform_name,
          commission_pct: toNum(x.commission_pct),
          subscription_fee: toNum(x.subscription_fee),
        }));
        setFeeSettings(settings);

        // build draft based on loaded settings + platforms
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
    } else {
      setFeeSettings([]);
      setDraft({});
    }

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

  function setDraftField(name: string, patch: Partial<{ commission_pct: number; subscription_fee: number }>) {
    setDraft((prev) => ({
      ...prev,
      [name]: { ...(prev[name] ?? { commission_pct: 0, subscription_fee: 0 }), ...patch },
    }));
  }

  async function add() {
    if (!isOwner) return;
    const name = newName.trim();
    if (!name) return setMsg("❌ Platform name is required.");

    setLoading(true);
    setMsg("");

    const res = await supabase.from("platforms").insert({
      name,
      is_active: true,
      sort_order: 100,
    });

    if (res.error) {
      setMsg("❌ Add failed: " + res.error.message);
      setLoading(false);
      return;
    }

    const f = await supabase.from("platform_fee_settings").insert({
      platform_name: name,
      commission_pct: 0,
      subscription_fee: 0,
    });

    if (f.error) {
      setMsg("⚠️ Platform added, but fee settings create failed: " + f.error.message);
    } else {
      setMsg("✅ Added!");
    }

    setNewName("");
    await load();
    setLoading(false);
  }

  async function toggleActive(p: Platform) {
    if (!isOwner) return;

    setLoading(true);
    setMsg("");

    const res = await supabase
      .from("platforms")
      .update({ is_active: !p.is_active })
      .eq("id", p.id);

    if (res.error) setMsg("❌ Update failed: " + res.error.message);
    else {
      setMsg("✅ Updated!");
      await load();
    }

    setLoading(false);
  }

  async function updateSort(p: Platform, sort: number) {
    if (!isOwner) return;

    setLoading(true);
    setMsg("");

    const res = await supabase.from("platforms").update({ sort_order: sort }).eq("id", p.id);

    if (res.error) setMsg("❌ Update failed: " + res.error.message);
    else {
      setMsg("✅ Updated!");
      await load();
    }

    setLoading(false);
  }

  async function saveFee(platformName: string) {
    if (!isOwner) return;

    setLoading(true);
    setMsg("");

    const d = draft[platformName] ?? { commission_pct: 0, subscription_fee: 0 };

    const payload = {
      platform_name: platformName,
      commission_pct: Number(d.commission_pct ?? 0),
      subscription_fee: Number(d.subscription_fee ?? 0),
    };

    const res = await supabase.from("platform_fee_settings").upsert(payload, {
      onConflict: "platform_name",
    } as any);

    if (res.error) setMsg("❌ Save fee failed: " + res.error.message);
    else setMsg("✅ Fee saved!");

    await load();
    setLoading(false);
  }

  if (authLoading) return <div style={{ padding: 20 }}>Loading permission...</div>;

  if (!isManagerOrOwner) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Manager — Platforms</h1>
        <div style={{ padding: 12, border: "1px solid #ddd", marginTop: 12 }}>
          <b>Access denied.</b> This page is only for <b>Owner / Manager</b>.
          <br />
          Your role: <b>{viewerRole ?? "UNKNOWN"}</b>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20, maxWidth: 1050 }}>
      <h1>Manager — Platforms</h1>

      {!isOwner && (
        <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>
          Manager can <b>view</b> platforms. Only <b>Owner</b> can add/remove/edit (including fee settings).
        </div>
      )}

      <div style={{ display: "flex", gap: 10, alignItems: "end", marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ minWidth: 260 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Add platform (Owner only)</div>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Uber Eats"
            disabled={!isOwner || loading}
            style={{ width: "100%" }}
          />
        </div>
        <button onClick={add} disabled={!isOwner || loading}>
          Add
        </button>
        <button onClick={load} disabled={loading}>
          Refresh
        </button>
        {loading && <span>Loading...</span>}
      </div>

      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>{msg}</div>}

      <div style={{ overflowX: "auto" }}>
        <table cellPadding={8} style={{ borderCollapse: "collapse", minWidth: 950 }}>
          <thead>
            <tr>
              <th style={{ border: "1px solid #ccc", textAlign: "left" }}>Name</th>
              <th style={{ border: "1px solid #ccc", textAlign: "left" }}>Active</th>
              <th style={{ border: "1px solid #ccc", textAlign: "left" }}>Sort</th>

              {isOwner && (
                <>
                  <th style={{ border: "1px solid #ccc", textAlign: "left" }}>Commission %</th>
                  <th style={{ border: "1px solid #ccc", textAlign: "left" }}>Subscription fee (daily)</th>
                  <th style={{ border: "1px solid #ccc", textAlign: "left" }}>Save fee</th>
                </>
              )}

              <th style={{ border: "1px solid #ccc", textAlign: "left" }}>Action</th>
            </tr>
          </thead>

          <tbody>
            {platforms.map((p) => {
              const d = draft[p.name] ?? { commission_pct: 0, subscription_fee: 0 };

              return (
                <tr key={p.id}>
                  <td style={{ border: "1px solid #ccc", fontWeight: 700 }}>{p.name}</td>
                  <td style={{ border: "1px solid #ccc" }}>{p.is_active ? "YES" : "NO"}</td>
                  <td style={{ border: "1px solid #ccc" }}>
                    <input
                      type="number"
                      value={p.sort_order}
                      disabled={!isOwner || loading}
                      onChange={(e) => updateSort(p, Number(e.target.value))}
                      style={{ width: 100 }}
                    />
                  </td>

                  {isOwner && (
                    <>
                      <td style={{ border: "1px solid #ccc" }}>
                        <input
                          type="number"
                          value={d.commission_pct}
                          disabled={loading}
                          onChange={(e) => setDraftField(p.name, { commission_pct: Number(e.target.value) })}
                          style={{ width: 140 }}
                        />
                      </td>

                      <td style={{ border: "1px solid #ccc" }}>
                        <input
                          type="number"
                          value={d.subscription_fee}
                          disabled={loading}
                          onChange={(e) => setDraftField(p.name, { subscription_fee: Number(e.target.value) })}
                          style={{ width: 160 }}
                        />
                      </td>

                      <td style={{ border: "1px solid #ccc" }}>
                        <button disabled={loading} onClick={() => saveFee(p.name)}>
                          Save fee
                        </button>
                      </td>
                    </>
                  )}

                  <td style={{ border: "1px solid #ccc" }}>
                    <button onClick={() => toggleActive(p)} disabled={!isOwner || loading}>
                      {p.is_active ? "Deactivate" : "Activate"}
                    </button>
                  </td>
                </tr>
              );
            })}

            {platforms.length === 0 && (
              <tr>
                <td colSpan={isOwner ? 7 : 4} style={{ padding: 12, color: "#999" }}>
                  No platforms yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* small note for owner */}
      {isOwner && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
          Fees in <b>platform_income</b> will be auto-calculated by DB trigger:{" "}
          <b>fees = gross_income × commission% + subscription fee</b>.
        </div>
      )}
    </div>
  );
}