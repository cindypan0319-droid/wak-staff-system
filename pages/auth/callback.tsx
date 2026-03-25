import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

const SINGLE_LOGIN_STORAGE_KEY = "wak_single_login_token";

export default function AuthCallback() {
  const [msg, setMsg] = useState("Signing you in...");
  const router = useRouter();

  useEffect(() => {
    async function waitForSession() {
      try {
        let session = null;

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

        const tokenFromUrl = new URL(window.location.href).searchParams.get("single_login_token");

        if (tokenFromUrl) {
          localStorage.setItem(SINGLE_LOGIN_STORAGE_KEY, tokenFromUrl);
        } else {
          localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);
        }

        window.location.href = "/staff/home";
      } catch (err) {
        console.error("Callback error:", err);

        setMsg("Login error. Redirecting...");
        setTimeout(() => {
          window.location.href = "/";
        }, 800);
      }
    }

    if (router.isReady) {
      waitForSession();
    }
  }, [router.isReady]);

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