import { useEffect, useState } from "react";
import Head from "next/head";
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
    const res = await supabase
      .from("profiles")
      .select("id, full_name, preferred_name")
      .eq("is_active", true);

    if (res.error) {
      setMsg("❌ Cannot load staff list: " + res.error.message);
      setDirectory([]);
      return;
    }

    const rows = (res.data ?? []) as DirRow[];
    rows.sort((a, b) => displayName(a).localeCompare(displayName(b)));
    setDirectory(rows);

    if (!staffId && rows.length > 0) setStaffId(rows[0].id);
  }

  useEffect(() => {
    loadDirectory();
  }, []);

  async function pinLogin() {
    setLoading(true);
    setMsg("");

    try {
      if (!staffId) {
        setMsg("❌ Please select your name.");
        return;
      }

      if (pin.trim().length < 1) {
        setMsg("❌ Please enter your PIN.");
        return;
      }

      const resp = await fetch("/api/pin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staff_id: staffId, pin }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        setMsg("❌ " + (data?.error ?? "Login failed"));
        return;
      }

      const actionLink = data.action_link;

      if (!actionLink) {
        setMsg("❌ No login link returned from server.");
        return;
      }

      window.location.href = actionLink;
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Head>
        <title>WAK Staff System</title>
        <meta name="application-name" content="WAK Staff System" />
        <meta name="apple-mobile-web-app-title" content="WAK Staff System" />
      </Head>

      <div
        style={{
          minHeight: "100vh",
          background: "#f5f6f8",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div
          style={{
            width: 360,
            background: "white",
            padding: 30,
            borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,0.1)",
          }}
        >
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <img src="/logo.png" style={{ width: 300 }} />
          </div>

          <h2 style={{ textAlign: "center", marginBottom: 20 }}>
            WAK Staff Login
          </h2>

          {msg && (
            <div
              style={{
                border: "1px solid #ddd",
                padding: 10,
                marginBottom: 12,
                fontSize: 14,
              }}
            >
              {msg}
            </div>
          )}

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
              Staff name
            </div>

            <select
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              style={{
                    width: "100%",
                    padding: "10px 12px",
                    fontSize: 16,
                    boxSizing: "border-box",
                    border: "1px solid #ccc",
                    borderRadius: 6,
                    background: "#fff",
              }}
            >
              {directory.map((r) => (
                <option key={r.id} value={r.id}>
                  {displayName(r)}
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
              PIN
            </div>

            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              style={{
                    width: "100%",
                    padding: "10px 12px",
                    fontSize: 16,
                    boxSizing: "border-box",
                    border: "1px solid #ccc",
                    borderRadius: 6,
                    background: "#fff",
              }}
            />
          </div>

          <button
            onClick={pinLogin}
            disabled={loading}
            style={{
              width: "100%",
              padding: 10,
              fontSize: 16,
              fontWeight: 700,
              background: "#1e3a8a",
              color: "white",
              border: "none",
              borderRadius: 6,
            }}
          >
            {loading ? "Logging in..." : "Login"}
          </button>

          <button
            onClick={loadDirectory}
            style={{
              width: "100%",
              padding: 8,
              marginTop: 10,
              border: "1px solid #ddd",
              background: "white",
            }}
          >
            Refresh staff list
          </button>

          <p
            style={{
              marginTop: 14,
              fontSize: 12,
              color: "#777",
              textAlign: "center",
            }}
          >
            If your account is deactivated, you cannot login.
          </p>

          <p style={{ textAlign: "center", marginTop: 6 }}>
            <a href="/admin-login" style={{ fontSize: 12 }}>
              Emergency admin login
            </a>
          </p>
        </div>
      </div>
    </>
  );
}