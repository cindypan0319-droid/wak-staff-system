import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function AuthCallback() {
  const [msg, setMsg] = useState("Signing you in...");

  useEffect(() => {
    async function waitForSession() {
      try {
        let session = null;

        // 最多等 3 秒（10 次，每次 300ms）
        for (let i = 0; i < 10; i++) {
          const { data } = await supabase.auth.getSession();
          session = data.session;

          if (session) break;

          await new Promise((r) => setTimeout(r, 300));
        }

        if (!session) {
          setMsg("Session failed. Redirecting...");
          setTimeout(() => {
            window.location.href = "/";
          }, 800);
          return;
        }

        // ✅ 成功 → 进入系统
        window.location.href = "/staff/home";
      } catch (err) {
        console.error("Callback error:", err);

        setMsg("Login error. Redirecting...");
        setTimeout(() => {
          window.location.href = "/";
        }, 800);
      }
    }

    waitForSession();
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        fontSize: 16,
        color: "#444",
      }}
    >
      {msg}
    </div>
  );
}