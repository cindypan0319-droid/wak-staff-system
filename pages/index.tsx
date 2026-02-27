import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

type DirRow = {
  id: string;
  full_name: string | null;
  preferred_name: string | null;
};

function displayName(r: DirRow) {
  const p = (r.preferred_name ?? "").trim();
  const f = (r.full_name ?? "").trim();
  return p ? p : f ? f : r.id.slice(0, 8);
}

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const [directory, setDirectory] = useState<DirRow[]>([]);
  const [staffId, setStaffId] = useState<string>("");
  const [pin, setPin] = useState<string>("");

  async function loadDirectory() {
    setMsg("");
    const res = await supabase
      .from("profiles")
      .select("id, full_name, preferred_name")
      .eq("is_active", true);

    if (res.error) {
      setMsg("❌ Cannot load staff list: " + res.error.message);
      setDirectory([]);
      return;
    }

    const rows = (res.data ?? []) as any as DirRow[];
    rows.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    setDirectory(rows);

    if (!staffId && rows.length > 0) setStaffId(rows[0].id);
  }

  useEffect(() => {
    loadDirectory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pinLogin() {
    setLoading(true);
    setMsg("");
    try {
      if (!staffId) return setMsg("❌ Please select your name.");
      if (pin.trim().length < 1) return setMsg("❌ Please enter your PIN.");

      const resp = await fetch("/api/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staff_id: staffId, pin: pin }),
      });

      const data = await resp.json();
      if (!resp.ok) return setMsg("❌ " + (data?.error ?? "Login failed"));

      // ✅ New flow: backend returns action_link, we redirect (flash) to create session
      const actionLink = data.action_link;
      if (!actionLink) return setMsg("❌ No login link returned from server.");

      window.location.href = actionLink;
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 520 }}>
      <h1>WOK Staff Login</h1>

      {msg && (
        <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>
          {msg}
        </div>
      )}

      <div style={{ border: "1px solid #ddd", padding: 12 }}>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Select your name</div>
          <select
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            style={{ width: "100%" }}
          >
            {directory.map((r) => (
              <option key={r.id} value={r.id}>
                {displayName(r)}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>PIN (any length)</div>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            style={{ width: "100%", fontSize: 18 }}
          />
        </div>

        <button
          onClick={pinLogin}
          disabled={loading}
          style={{ width: "100%", fontWeight: 800 }}
        >
          {loading ? "Logging in…" : "Login"}
        </button>

        <button
          onClick={loadDirectory}
          disabled={loading}
          style={{ width: "100%", marginTop: 8 }}
        >
          Refresh staff list
        </button>
      </div>

      <p style={{ marginTop: 10, color: "#666", fontSize: 12 }}>
        If your account is deactivated, you cannot login.
      </p>

      <p style={{ marginTop: 8, fontSize: 12 }}>
        <a href="/admin-login">Emergency admin login</a>
      </p>
    </div>
  );
}