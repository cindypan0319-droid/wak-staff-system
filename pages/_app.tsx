import type { AppProps } from "next/app";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

export default function App({ Component, pageProps }: AppProps) {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function checkActive() {
      try {
        const { data } = await supabase.auth.getUser();
        const uid = data.user?.id;

        // Not logged in -> no need to check
        if (!uid) {
          if (mounted) setChecking(false);
          return;
        }

        const p = await supabase.from("profiles").select("is_active").eq("id", uid).maybeSingle();
        const isActive = (p.data as any)?.is_active;

        // If user has no profile row yet, allow (during dev)
        if (isActive === undefined || isActive === null) {
          if (mounted) setChecking(false);
          return;
        }

        // If deactivated -> sign out + redirect
        if (isActive === false) {
          await supabase.auth.signOut();
          window.location.href = "/";
          return;
        }

        if (mounted) setChecking(false);
      } catch {
        // if error, do not block the app
        if (mounted) setChecking(false);
      }
    }

    checkActive();

    // Also re-check whenever auth state changes (login/logout)
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      checkActive();
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Small loading screen to avoid flicker
  if (checking) {
    return <div style={{ padding: 20 }}>Loading…</div>;
  }

  return <Component {...pageProps} />;
}