import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import type { GetServerSideProps } from "next";
import { supabase } from "../lib/supabaseClient";

type DirRow = {
  id: string;
  full_name: string | null;
  preferred_name: string | null;
  is_active?: boolean;
};

function displayName(r: DirRow) {
  const p = (r.preferred_name ?? "").trim();
  const f = (r.full_name ?? "").trim();
  return p ? p : f ? f : r.id.slice(0, 8);
}

export default function Home() {
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [directory, setDirectory] = useState<DirRow[]>([]);
  const [staffId, setStaffId] = useState<string>("");
  const [pin, setPin] = useState<string>("");

  const loadingDirectoryRef = useRef(false);

  const sortedDirectory = useMemo(() => {
    return [...directory].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [directory]);

  const clearBrokenSession = useCallback(async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const session = sessionData.session;

      if (!session) return;

      const { data: userData, error } = await supabase.auth.getUser();

      if (error || !userData.user) {
        await supabase.auth.signOut();
      }
    } catch {
      try {
        await supabase.auth.signOut();
      } catch {
        // ignore
      }
    }
  }, []);

  const loadDirectory = useCallback(
    async (showLoading = true) => {
      if (loadingDirectoryRef.current) return;

      loadingDirectoryRef.current = true;
      if (showLoading) setListLoading(true);
      setMsg("");

      try {
        await clearBrokenSession();

        const res = await supabase
          .from("profiles")
          .select("id, full_name, preferred_name, is_active")
          .eq("is_active", true);

        if (res.error) {
          setMsg("❌ Cannot load staff list: " + res.error.message);
          setDirectory([]);
          return;
        }

        const rows = ((res.data ?? []) as DirRow[]).sort((a, b) =>
          displayName(a).localeCompare(displayName(b))
        );

        setDirectory(rows);

        setStaffId((prev) => {
          if (prev && rows.some((r) => r.id === prev)) return prev;
          return rows.length > 0 ? rows[0].id : "";
        });
      } finally {
        loadingDirectoryRef.current = false;
        setListLoading(false);
      }
    },
    [clearBrokenSession]
  );

  useEffect(() => {
    loadDirectory(true);

    const onFocus = () => {
      loadDirectory(false);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        loadDirectory(false);
      }
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((reg) => {
          reg.update().catch(() => {
            // ignore
          });
        });
      });
    }

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadDirectory]);

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

      const activeCheck = await supabase
        .from("profiles")
        .select("id, is_active")
        .eq("id", staffId)
        .single();

      if (activeCheck.error) {
        setMsg("❌ Cannot verify selected staff: " + activeCheck.error.message);
        return;
      }

      if (!activeCheck.data?.is_active) {
        setMsg("❌ This account is deactivated. You cannot login.");
        await loadDirectory(false);
        return;
      }

      const resp = await fetch("/api/pin-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
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

      setPin("");
      window.location.href = actionLink;
    } catch (err: any) {
      setMsg("❌ " + (err?.message ?? "Login failed"));
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
        <meta
          httpEquiv="Cache-Control"
          content="no-store, no-cache, must-revalidate, max-age=0"
        />
        <meta httpEquiv="Pragma" content="no-cache" />
        <meta httpEquiv="Expires" content="0" />
      </Head>

      <div
        style={{
          minHeight: "100vh",
          background: "#f5f6f8",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          padding: 20,
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 380,
            background: "white",
            padding: 30,
            borderRadius: 12,
            boxShadow: "0 10px 30px rgba(0,0,0,0.1)",
            border: "1px solid #ececec",
          }}
        >
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <img src="/logo.png" alt="WAK logo" style={{ width: 300, maxWidth: "100%" }} />
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
                borderRadius: 8,
                background: msg.startsWith("❌") ? "#fff7f7" : "#f8fbff",
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
              disabled={loading || listLoading}
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
              {sortedDirectory.length === 0 ? (
                <option value="">No active staff found</option>
              ) : (
                sortedDirectory.map((r) => (
                  <option key={r.id} value={r.id}>
                    {displayName(r)}
                  </option>
                ))
              )}
            </select>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
              PIN
            </div>

            <input
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={loading || listLoading}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  pinLogin();
                }
              }}
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
            disabled={loading || listLoading || sortedDirectory.length === 0}
            style={{
              width: "100%",
              padding: 10,
              fontSize: 16,
              fontWeight: 700,
              background:
                loading || listLoading || sortedDirectory.length === 0
                  ? "#8ea0d1"
                  : "#1e3a8a",
              color: "white",
              border: "none",
              borderRadius: 6,
              cursor:
                loading || listLoading || sortedDirectory.length === 0
                  ? "not-allowed"
                  : "pointer",
            }}
          >
            {loading ? "Logging in..." : listLoading ? "Loading..." : "Login"}
          </button>

          <button
            onClick={() => loadDirectory(true)}
            disabled={loading}
            style={{
              width: "100%",
              padding: 8,
              marginTop: 10,
              border: "1px solid #ddd",
              background: "white",
              borderRadius: 6,
              cursor: loading ? "not-allowed" : "pointer",
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

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  return {
    props: {},
  };
};