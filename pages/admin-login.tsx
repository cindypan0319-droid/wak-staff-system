import { useState } from "react";
import { supabase } from "../lib/supabaseClient";

const SINGLE_LOGIN_STORAGE_KEY = "wak_single_login_token";

export default function AdminLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  async function login() {
    setLoading(true);
    setMsg("");
    localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);

    try {
      const res = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (res.error) return setMsg("❌ " + res.error.message);

      const accessToken = res.data.session?.access_token;
      if (!accessToken) {
        await supabase.auth.signOut({ scope: "local" });
        localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);
        return setMsg("❌ Login succeeded but no session token was returned.");
      }

      let sessionResponse: Response;

      try {
        sessionResponse = await fetch("/api/admin/start-session", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
      } catch {
        localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);
        await supabase.auth.signOut({ scope: "local" });
        return setMsg("❌ Could not start admin session. Check your connection and try again.");
      }

      const sessionResult = await sessionResponse.json().catch(() => ({}));
      const singleLoginToken = sessionResult?.single_login_token;

      if (!sessionResponse.ok || !singleLoginToken) {
        localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);
        await supabase.auth.signOut({ scope: "local" });
        return setMsg("❌ " + (sessionResult?.error ?? "Could not start admin session."));
      }

      localStorage.setItem(SINGLE_LOGIN_STORAGE_KEY, singleLoginToken);

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
