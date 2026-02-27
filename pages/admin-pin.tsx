import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

type Profile = {
  id: string;
  full_name: string | null;
  preferred_name: string | null;
  role: string | null;
  is_active: boolean | null;
};

function label(p: Profile) {
  const pn = (p.preferred_name ?? "").trim();
  const fn = (p.full_name ?? "").trim();
  const base = pn || fn || p.id.slice(0, 8);
  const role = (p.role ?? "").toUpperCase();
  return `${base} (${role})`;
}

export default function AdminPinPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [staffId, setStaffId] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  async function loadProfiles() {
    setMsg("");
    const r = await supabase
      .from("profiles")
      .select("id, full_name, preferred_name, role, is_active")
      .order("created_at", { ascending: true });

    if (r.error) {
      setMsg("❌ Cannot load profiles: " + r.error.message);
      setProfiles([]);
      return;
    }

    const rows = (r.data ?? []) as any as Profile[];
    setProfiles(rows);
    if (!staffId && rows.length) setStaffId(rows[0].id);
  }

  useEffect(() => {
    loadProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function setPinNow() {
    setLoading(true);
    setMsg("");
    try {
      if (!staffId) return setMsg("❌ Please select a user.");
      if (!/^\d{4}$/.test(pin.trim())) return setMsg("❌ PIN must be 4 digits.");
      if (pin.trim() !== pin2.trim()) return setMsg("❌ PINs do not match.");

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return setMsg("❌ No session. Please login via /admin-login first.");

      const resp = await fetch("/api/admin/set-pin2", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ staff_id: staffId, pin: pin.trim() }),
      });

      const out = await resp.json();
      if (!resp.ok) return setMsg("❌ " + (out?.error ?? "Failed"));

      setMsg("✅ PIN updated!");
      setPin("");
      setPin2("");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 560 }}>
      <h1>Admin — Set PIN</h1>

      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>{msg}</div>}

      <div style={{ border: "1px solid #ddd", padding: 12 }}>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Select user</div>
          <select value={staffId} onChange={(e) => setStaffId(e.target.value)} style={{ width: "100%" }}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {label(p)} {p.is_active ? "" : "[INACTIVE]"}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>New PIN (4 digits)</div>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            inputMode="numeric"
            style={{ width: "100%", fontSize: 18, letterSpacing: 4 }}
          />
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Confirm PIN</div>
          <input
            value={pin2}
            onChange={(e) => setPin2(e.target.value)}
            inputMode="numeric"
            style={{ width: "100%", fontSize: 18, letterSpacing: 4 }}
          />
        </div>

        <button onClick={setPinNow} disabled={loading} style={{ width: "100%", fontWeight: 800 }}>
          {loading ? "Saving…" : "Set PIN"}
        </button>
      </div>

      <p style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
        If you see “No session”, please login first: <a href="/admin-login">/admin-login</a>
      </p>
    </div>
  );
}