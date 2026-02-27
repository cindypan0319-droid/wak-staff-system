import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function AdminLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  async function login() {
    setLoading(true);
    setMsg("");
    try {
      const res = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (res.error) return setMsg("❌ " + res.error.message);

      window.location.href = "/manager";
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 520 }}>
      <h1>Admin Login</h1>
      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>{msg}</div>}

      <div style={{ border: "1px solid #ddd", padding: 12 }}>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Email</div>
          <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%" }} />
        </div>

        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#666" }}>Password</div>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: "100%" }} />
        </div>

        <button onClick={login} disabled={loading} style={{ width: "100%", fontWeight: 800 }}>
          {loading ? "Logging in…" : "Login"}
        </button>
      </div>
    </div>
  );
}