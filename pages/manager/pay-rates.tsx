import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Profile = { id: string; full_name: string | null; role?: string | null; is_active?: boolean | null };

type RateRow = {
  staff_id: string;
  store_id?: string | null;
  weekday_rate: number;
  saturday_rate: number;
  sunday_rate: number;
};

const DEFAULT_STORE_ID = "MOOROOLBARK";

export default function PayRatesPage() {
  // permission
  const [authLoading, setAuthLoading] = useState(true);
  const [viewerRole, setViewerRole] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);

  const isManagerOrOwner = viewerRole === "OWNER" || viewerRole === "MANAGER";

  // data
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

    // 1) profiles
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

    // 只显示在职员工（你如果想显示离职员工我们再加开关）
    const activeProfiles = (p.data ?? []).filter(
      (x: any) => x?.is_active === undefined || x?.is_active === null || x?.is_active === true
    );

    setProfiles(activeProfiles as any);

    // 2) pay rates（单店：固定用 DEFAULT_STORE_ID）
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
      store_id: DEFAULT_STORE_ID, // 单店固定
      weekday_rate: Number(row.weekday_rate),
      saturday_rate: Number(row.saturday_rate),
      sunday_rate: Number(row.sunday_rate),
      updated_by: viewerId,
      updated_at: new Date().toISOString(),
    };

    // 你的表目前看起来是 staff_id 唯一（你原来就这样写），我们保持一致
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

  // -------- UI --------
  if (authLoading) return <div style={{ padding: 20 }}>Loading permission...</div>;

  if (!isManagerOrOwner) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Manager — Staff Pay Rates</h1>
        <div style={{ padding: 12, border: "1px solid #ddd", marginTop: 12 }}>
          <b>Access denied.</b> This page is only for <b>Owner / Manager</b>.
          <br />
          Your role: <b>{viewerRole ?? "UNKNOWN"}</b>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Manager — Staff Pay Rates</h1>

      <div style={{ marginBottom: 12 }}>
        <button onClick={load} disabled={loading}>
          Refresh
        </button>
        {loading && <span style={{ marginLeft: 10 }}>Loading...</span>}
      </div>

      {msg && <p>{msg}</p>}

      <div style={{ overflowX: "auto" }}>
        <table cellPadding={8} style={{ borderCollapse: "collapse", minWidth: 800 }}>
          <thead>
            <tr>
              <th style={{ border: "1px solid #ccc" }}>Staff</th>
              <th style={{ border: "1px solid #ccc" }}>Weekday rate</th>
              <th style={{ border: "1px solid #ccc" }}>Saturday rate</th>
              <th style={{ border: "1px solid #ccc" }}>Sunday rate</th>
              <th style={{ border: "1px solid #ccc" }}>Action</th>
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
                  <td style={{ border: "1px solid #ccc", fontWeight: 700 }}>{nameOf(p.id)}</td>

                  <td style={{ border: "1px solid #ccc" }}>
                    <input
                      value={r.weekday_rate}
                      onChange={(e) => setLocalRate(p.id, { weekday_rate: Number(e.target.value) })}
                      style={{ width: 120 }}
                    />
                  </td>

                  <td style={{ border: "1px solid #ccc" }}>
                    <input
                      value={r.saturday_rate}
                      onChange={(e) => setLocalRate(p.id, { saturday_rate: Number(e.target.value) })}
                      style={{ width: 120 }}
                    />
                  </td>

                  <td style={{ border: "1px solid #ccc" }}>
                    <input
                      value={r.sunday_rate}
                      onChange={(e) => setLocalRate(p.id, { sunday_rate: Number(e.target.value) })}
                      style={{ width: 120 }}
                    />
                  </td>

                  <td style={{ border: "1px solid #ccc" }}>
                    <button onClick={() => save(p.id)} disabled={loading}>
                      Save
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}