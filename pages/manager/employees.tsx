import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Row = {
  id: string;
  full_name: string | null;
  preferred_name: string | null;
  role: "OWNER" | "MANAGER" | "STAFF";
  is_active: boolean;
  pin_set: boolean;
};

function nameLabel(r: Row) {
  const p = (r.preferred_name ?? "").trim();
  const f = (r.full_name ?? "").trim();
  return p ? p : f ? f : r.id.slice(0, 8);
}

export default function EmployeesPage() {
  const [meRole, setMeRole] = useState<"OWNER" | "MANAGER" | "STAFF" | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  // create form
  const [cFull, setCFull] = useState("");
  const [cPref, setCPref] = useState("");
  const [cRole, setCRole] = useState<"STAFF" | "MANAGER" | "OWNER">("STAFF");

  // edit buffer
  const [edit, setEdit] = useState<Record<string, Partial<Row>>>({});

  // set pin UI
  const [pinTarget, setPinTarget] = useState<Row | null>(null);
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");

  async function guardRole() {
    const { data } = await supabase.auth.getUser();
    const uid = data.user?.id;
    if (!uid) {
      window.location.href = "/";
      return;
    }
    const pr = await supabase.from("profiles").select("role").eq("id", uid).maybeSingle();
    const r = ((pr.data as any)?.role ?? null) as any;
    setMeRole(r);

    if (!(r === "OWNER" || r === "MANAGER")) {
      window.location.href = "/";
      return;
    }
  }

  function canTouch(target: Row) {
    if (meRole === "OWNER") return true;
    if (meRole === "MANAGER") return target.role !== "OWNER";
    return false;
  }

  function setEditField(id: string, patch: Partial<Row>) {
    setEdit((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  }

  function mergedRow(r: Row): Row {
    const p = edit[r.id] ?? {};
    return { ...r, ...p } as Row;
  }

  async function load() {
    setLoading(true);
    setMsg("");
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        setMsg("❌ No session. Please login again.");
        return;
      }

      // ✅ IMPORTANT: must match the file name: pages/api/admin/list-profiles.ts
      const resp = await fetch("/api/admin/list-profiles", {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const out = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setMsg("❌ Admin API failed: " + (out?.error ?? `Status ${resp.status}`));
        setRows([]);
        return;
      }

      const list = (out.rows ?? []) as Row[];
      list.sort((a, b) => nameLabel(a).localeCompare(nameLabel(b)));
      setRows(list);
      setEdit({});
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    guardRole().then(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createStaff() {
    setLoading(true);
    setMsg("");
    try {
      if (!cFull.trim()) return setMsg("❌ Full name is required.");
      if (!cPref.trim()) return setMsg("❌ Preferred name is required.");

      if (meRole === "MANAGER" && cRole === "OWNER") {
        return setMsg("❌ Manager cannot create OWNER.");
      }

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return setMsg("❌ No session. Please login again.");

      // ✅ use your real API path (you said you keep create-staff.ts)
      const resp = await fetch("/api/admin/create-staff", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          full_name: cFull.trim(),
          preferred_name: cPref.trim(),
          role: cRole,
        }),
      });

      const out = await resp.json().catch(() => ({}));
      if (!resp.ok) return setMsg("❌ " + (out?.error ?? "Create failed"));

      setMsg("✅ Created!");
      setCFull("");
      setCPref("");
      setCRole("STAFF");
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function saveRow(id: string) {
    setLoading(true);
    setMsg("");
    try {
      const base = rows.find((x) => x.id === id);
      if (!base) return;

      if (!canTouch(base)) return setMsg("❌ You cannot modify this user.");

      const m = mergedRow(base);

      // Manager can only set STAFF/MANAGER
      if (meRole === "MANAGER" && m.role === "OWNER") return setMsg("❌ Manager cannot set OWNER role.");

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return setMsg("❌ No session. Please login again.");

      const resp = await fetch("/api/admin/update-profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          staff_id: id,
          full_name: m.full_name ?? "",
          preferred_name: m.preferred_name ?? "",
          role: m.role,
          is_active: m.is_active,
        }),
      });

      const out = await resp.json().catch(() => ({}));
      if (!resp.ok) return setMsg("❌ " + (out?.error ?? "Save failed"));

      setMsg("✅ Saved!");
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function setPinNow() {
    setLoading(true);
    setMsg("");
    try {
      if (!pinTarget) return;
      if (!pin1.trim()) return setMsg("❌ PIN cannot be empty.");
      if (pin1 !== pin2) return setMsg("❌ PINs do not match.");

      if (!canTouch(pinTarget)) return setMsg("❌ You cannot set PIN for this user.");

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return setMsg("❌ No session. Please login again.");

      // ✅ use your real API path (you said you keep set-pin.ts)
      const resp = await fetch("/api/admin/set-pin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ staff_id: pinTarget.id, pin: pin1 }),
      });

      const out = await resp.json().catch(() => ({}));
      if (!resp.ok) return setMsg("❌ " + (out?.error ?? "Set PIN failed"));

      setMsg("✅ PIN updated!");
      setPinTarget(null);
      setPin1("");
      setPin2("");
      await load();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20 }}>
            <div style={{ marginBottom: 12 }}>
        <button onClick={() => (window.location.href = "/staff/home")}>
          ← Back to Home
        </button>
      </div>
      <h1>Employees Infomation</h1>

      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>{msg}</div>}
      {loading && <div style={{ marginBottom: 12 }}>Loading…</div>}

      {/* Create */}
      <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 16, maxWidth: 900 }}>
        <h2 style={{ marginTop: 0 }}>Create employee</h2>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 260px" }}>
            <div style={{ fontSize: 12, color: "#666" }}>Full name</div>
            <input value={cFull} onChange={(e) => setCFull(e.target.value)} style={{ width: "100%" }} />
          </div>

          <div style={{ flex: "1 1 220px" }}>
            <div style={{ fontSize: 12, color: "#666" }}>Preferred name</div>
            <input value={cPref} onChange={(e) => setCPref(e.target.value)} style={{ width: "100%" }} />
          </div>

          <div style={{ flex: "0 0 200px" }}>
            <div style={{ fontSize: 12, color: "#666" }}>Role</div>
            <select value={cRole} onChange={(e) => setCRole(e.target.value as any)} style={{ width: "100%" }}>
              <option value="STAFF">STAFF</option>
              <option value="MANAGER">MANAGER</option>
              {meRole === "OWNER" && <option value="OWNER">OWNER</option>}
            </select>
          </div>

          <div style={{ alignSelf: "end" }}>
            <button onClick={createStaff} disabled={loading} style={{ fontWeight: 800 }}>
              Create
            </button>
            <button onClick={load} disabled={loading} style={{ marginLeft: 8 }}>
              Refresh
            </button>
          </div>
        </div>

        <p style={{ marginTop: 10, color: "#666", fontSize: 12 }}>
          Email is auto-generated. After creation, click “Set PIN”.
        </p>
      </div>

      {/* List */}
      <div style={{ overflowX: "auto" }}>
        <table cellPadding={8} style={{ borderCollapse: "collapse", minWidth: 1100 }}>
          <thead>
            <tr>
              <th style={{ border: "1px solid #ccc" }}>Name</th>
              <th style={{ border: "1px solid #ccc" }}>Full name</th>
              <th style={{ border: "1px solid #ccc" }}>Preferred name</th>
              <th style={{ border: "1px solid #ccc" }}>Role</th>
              <th style={{ border: "1px solid #ccc" }}>Active</th>
              <th style={{ border: "1px solid #ccc" }}>PIN</th>
              <th style={{ border: "1px solid #ccc" }}>Actions</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((r0) => {
              const r = mergedRow(r0);
              const disabled = !canTouch(r0);

              return (
                <tr key={r0.id} style={{ opacity: disabled ? 0.6 : 1 }}>
                  <td style={{ border: "1px solid #ccc", fontWeight: 800 }}>{nameLabel(r0)}</td>

                  <td style={{ border: "1px solid #ccc" }}>
                    <input
                      value={r.full_name ?? ""}
                      onChange={(e) => setEditField(r0.id, { full_name: e.target.value })}
                      style={{ width: 220 }}
                      disabled={disabled}
                    />
                  </td>

                  <td style={{ border: "1px solid #ccc" }}>
                    <input
                      value={r.preferred_name ?? ""}
                      onChange={(e) => setEditField(r0.id, { preferred_name: e.target.value })}
                      style={{ width: 180 }}
                      disabled={disabled}
                    />
                  </td>

                  <td style={{ border: "1px solid #ccc" }}>
                    <select
                      value={r.role}
                      onChange={(e) => setEditField(r0.id, { role: e.target.value as any })}
                      disabled={disabled}
                    >
                      <option value="STAFF">STAFF</option>
                      <option value="MANAGER">MANAGER</option>
                      {meRole === "OWNER" && <option value="OWNER">OWNER</option>}
                    </select>
                  </td>

                  <td style={{ border: "1px solid #ccc", textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={!!r.is_active}
                      onChange={(e) => setEditField(r0.id, { is_active: e.target.checked })}
                      disabled={disabled}
                    />
                  </td>

                  <td style={{ border: "1px solid #ccc" }}>{r0.pin_set ? "✅ Set" : "❌ Not set"}</td>

                  <td style={{ border: "1px solid #ccc", whiteSpace: "nowrap" }}>
                    <button onClick={() => saveRow(r0.id)} disabled={disabled || loading}>
                      Save
                    </button>

                    <button
                      onClick={() => {
                        if (disabled) return;
                        setPinTarget(r0);
                        setPin1("");
                        setPin2("");
                      }}
                      disabled={disabled || loading}
                      style={{ marginLeft: 8 }}
                    >
                      Set PIN
                    </button>

                    <button
                      onClick={() => (window.location.href = `/manager/employee/${r0.id}`)}
                      style={{ marginLeft: 8 }}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* PIN modal */}
      {pinTarget && (
        <div style={{ marginTop: 16, border: "2px solid #333", padding: 12, maxWidth: 520 }}>
          <h2 style={{ marginTop: 0 }}>Set PIN — {nameLabel(pinTarget as any)}</h2>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#666" }}>New PIN (any length)</div>
            <input value={pin1} onChange={(e) => setPin1(e.target.value)} style={{ width: "100%", fontSize: 18 }} />
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Confirm PIN</div>
            <input value={pin2} onChange={(e) => setPin2(e.target.value)} style={{ width: "100%", fontSize: 18 }} />
          </div>

          <button onClick={setPinNow} disabled={loading} style={{ fontWeight: 800 }}>
            Save PIN
          </button>
          <button onClick={() => setPinTarget(null)} disabled={loading} style={{ marginLeft: 8 }}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}