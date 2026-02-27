import { useEffect } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function AuthCallback() {
  useEffect(() => {
    async function run() {
      // Supabase will parse the URL and store session automatically in many cases,
      // but we still call getSession to ensure it is ready.
      const { data } = await supabase.auth.getSession();
      const session = data.session;

      if (!session) {
        window.location.href = "/";
        return;
      }

      // ✅ after login, always go to staff home dashboard
      window.location.href = "/staff/home";
    }

    run();
  }, []);

  return <div style={{ padding: 20 }}>Signing in…</div>;
}