import type { AppProps } from "next/app";
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import Head from "next/head";
import AutoLogout from "../components/AutoLogout";

export default function App({ Component, pageProps }: AppProps) {
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;
    let authEpoch = 0;
    let checkRunning = false;
    let checkPending = false;
    let scheduledCheck: ReturnType<typeof setTimeout> | null = null;

    async function checkActive(isCurrent: () => boolean) {
      try {
        const { data, error } = await supabase.auth.getUser();
        if (!isCurrent()) return;
        if (error) {
          console.warn("APP_ACTIVE_CHECK_READ_ERROR");
          setChecking(false);
          return;
        }
        const uid = data.user?.id;

        // Not logged in -> no need to check
        if (!uid) {
          setChecking(false);
          return;
        }

        const p = await supabase
          .from("profiles")
          .select("is_active")
          .eq("id", uid)
          .maybeSingle();

        if (!isCurrent()) return;
        if (p.error) {
          console.warn("APP_ACTIVE_CHECK_READ_ERROR");
          setChecking(false);
          return;
        }

        const isActive = (p.data as { is_active?: boolean | null } | null)?.is_active;

        // If user has no profile row yet, allow (during dev)
        if (isActive === undefined || isActive === null) {
          setChecking(false);
          return;
        }

        // If deactivated -> sign out + redirect
        if (isActive === false) {
          await supabase.auth.signOut({ scope: "global" });
          window.location.href = "/";
          return;
        }

        setChecking(false);
      } catch {
        // if error, do not block the app
        if (isCurrent()) {
          console.warn("APP_ACTIVE_CHECK_READ_ERROR");
          setChecking(false);
        }
      }
    }

    const runChecks = async () => {
      if (checkRunning || !mounted) return;
      checkRunning = true;
      try {
        while (mounted && checkPending) {
          checkPending = false;
          const epoch = authEpoch;
          await checkActive(() => mounted && epoch === authEpoch);
        }
      } finally {
        checkRunning = false;
      }
    };

    const requestCheck = () => {
      checkPending = true;
      if (checkRunning || scheduledCheck !== null) return;
      scheduledCheck = setTimeout(() => {
        scheduledCheck = null;
        void runChecks();
      }, 0);
    };

    requestCheck();

    // Also re-check whenever auth state changes (login/logout)
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      authEpoch++;
      requestCheck();
    });

    return () => {
      mounted = false;
      authEpoch++;
      if (scheduledCheck !== null) clearTimeout(scheduledCheck);
      sub.subscription.unsubscribe();
    };
  }, []);

  // Small loading screen to avoid flicker
  if (checking) {
    return (
      <>
        <Head>
          <title>WAK Staff</title>
          <meta name="theme-color" content="#1E5A9E" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1, viewport-fit=cover"
          />
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-status-bar-style" content="default" />
          <meta name="apple-mobile-web-app-title" content="WAK Staff" />
          <link rel="manifest" href="/manifest.json" />
          <link rel="icon" href="/icon-192.png" />
          <link rel="apple-touch-icon" href="/icon-192.png" />
        </Head>

        <div style={{ padding: 20 }}>Loading…</div>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>WAK Staff</title>
        <meta name="theme-color" content="#1E5A9E" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="WAK Staff" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icon-192.png" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </Head>

      <AutoLogout />
      <Component {...pageProps} />
    </>
  );
}
