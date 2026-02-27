import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function ManagerCreateStaffPage() {
  const [meRole, setMeRole] = useState<string | null>(null);

  const [fullName, setFullName] = useState("");
  const [preferredName, setPreferredName] = useState("");
  const [role, setRole] = useState<"STAFF" | "MANAGER">("STAFF");
  const [pin, setPin] = useState("");

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  async function guardOwnerManager() {
    const { data } = await supabase.auth.getUser();
    const uid = data.user?.id;
    if (!uid) {
      window.location.href = "/";
      return;
    }
    const p = await supabase.from("profiles").select("role").eq("id", uid).maybeSingle();
    const r = (p.data as any)?.role ?? null;
    setMeRole(r);

    if (!(r === "OWNER" || r === "MANAGER")) {
      window.location.href = "/";
      return;
    }
  }

  useEffect(() => {
    guardOwnerManager();
  }, []);

  async function create() {
    setLoading(true);
    setMsg("");
    try {
      if (!fullName.trim()) return setMsg("❌ Full name is required.");
      if (!preferredName.trim()) return setMsg("❌ Preferred name is required.");
      if (!/^\d{4}$/.test(pin.trim())) return setMsg("❌ PIN must be 4 digits.");

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return setMsg("❌ No session. Please login again.");

      const resp = await fetch("/api/admin/create-staff", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          full_name: fullName.trim(),
          preferred_name: preferredName.trim(),
          role,
          pin: pin.trim(),
        }),
      });

      const out = await resp.json();
      if (!resp.ok) {
        setMsg("❌ " + (out?.error ?? "Create failed"));
        return;
      }

      setMsg("✅ Created! Staff id: " + out.staff_id);
      setFullName("");
      setPreferredName("");
      setRole("STAFF");
      setPin("");
    } finally {
      setLoading(false);
    }
  }

  if (!(meRole === "OWNER" || meRole === "MANAGER")) {
    return <div style={{ padding: 20 }}>Checking access…</div>;
  }

  return (
    <div style={{ padding: 20, maxWidth: 620 }}>
      <h1>Manager — Create Staff (PIN login)</h1>

      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>{msg}</div>}

      <div style={{ border: "1px solid #ddd", padding: 12 }}>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Full name (for records)</div>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} style={{ width: "100%" }} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Preferred name (for login list)</div>
          <input
            value={preferredName}
            onChange={(e) => setPreferredName(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Role</div>
          <select value={role} onChange={(e) => setRole(e.target.value as any)} style={{ width: "100%" }}>
            <option value="STAFF">STAFF</option>
            <option value="MANAGER">MANAGER</option>
          </select>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>PIN (4 digits)</div>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            inputMode="numeric"
            style={{ width: "100%", fontSize: 18, letterSpacing: 4 }}
          />
        </div>

        <button onClick={create} disabled={loading} style={{ width: "100%", fontWeight: 800 }}>
          {loading ? "Creating…" : "Create staff"}
        </button>
      </div>

      <p style={{ marginTop: 10, color: "#666", fontSize: 12 }}>
        Staff will login using: select preferred name + enter PIN (no email needed).
      </p>
    </div>
  );
}