import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { readCurrentUser } from "../../lib/authGuard";

type AuthStatus = "loading" | "authenticated" | "unauthenticated" | "read_error";

function isoToLocalInput(iso: string) {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function localInputToISO(localVal: string) {
  return new Date(localVal).toISOString();
}

export default function StaffUnavailablePage() {
  const [email, setEmail] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [authStatus, setAuthStatus] = useState<AuthStatus>("loading");
  const [authError, setAuthError] = useState("");
  const [authRetryKey, setAuthRetryKey] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [storeId, setStoreId] = useState("MOOROOLBARK");
  const [startAt, setStartAt] = useState(() => {
    const now = new Date();
    now.setMinutes(0, 0, 0);
    return isoToLocalInput(now.toISOString());
  });
  const [endAt, setEndAt] = useState(() => {
    const later = new Date();
    later.setHours(later.getHours() + 4);
    later.setMinutes(0, 0, 0);
    return isoToLocalInput(later.toISOString());
  });
  const [reason, setReason] = useState("");

  const [myRows, setMyRows] = useState<any[]>([]);

  async function loadMyUnavailable(uid: string) {
    setMsg("");
    const r = await supabase
      .from("staff_unavailability")
      .select("id, store_id, start_at, end_at, reason, created_at")
      .eq("staff_id", uid)
      .order("start_at", { ascending: false })
      .limit(50);

    if (r.error) {
      setMsg("❌ Load failed: " + r.error.message);
      setMyRows([]);
      return;
    }
    setMyRows(r.data ?? []);
  }

  useEffect(() => {
    let active = true;
    let authEpoch = 0;
    let checkRunning = false;
    let checkPending = false;
    let scheduledCheck: ReturnType<typeof setTimeout> | null = null;

    const verifyAuth = async (epoch: number) => {
      const isCurrent = () => active && epoch === authEpoch;
      const userResult = await readCurrentUser();
      if (!isCurrent()) return;

      if (userResult.status === "read_error") {
        setAuthStatus("read_error");
        setAuthError("Could not verify your session. Please retry.");
        return;
      }

      if (userResult.status === "unauthenticated") {
        setEmail(null);
        setCurrentUserId(null);
        setAuthStatus("unauthenticated");
        setAuthError("");
        return;
      }

      setEmail(userResult.user.email ?? null);
      setCurrentUserId(userResult.user.id);
      setAuthStatus("authenticated");
      setAuthError("");
    };

    const runChecks = async () => {
      if (checkRunning || !active) return;
      checkRunning = true;
      try {
        while (active && checkPending) {
          checkPending = false;
          await verifyAuth(authEpoch);
        }
      } finally {
        checkRunning = false;
      }
    };

    const requestCheck = () => {
      checkPending = true;
      if (!active || checkRunning || scheduledCheck !== null) return;
      scheduledCheck = setTimeout(() => {
        scheduledCheck = null;
        void runChecks();
      }, 0);
    };

    requestCheck();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      authEpoch++;
      setAuthError("");

      if (!session?.user) {
        checkPending = false;
        setEmail(null);
        setCurrentUserId(null);
        setAuthStatus("unauthenticated");
        return;
      }

      setEmail(session.user.email ?? null);
      setCurrentUserId(null);
      setAuthStatus("loading");
      requestCheck();
    });

    return () => {
      active = false;
      authEpoch++;
      if (scheduledCheck !== null) clearTimeout(scheduledCheck);
      sub.subscription.unsubscribe();
    };
  }, [authRetryKey]);

  useEffect(() => {
    if (authStatus === "authenticated" && currentUserId) loadMyUnavailable(currentUserId);
  }, [authStatus, currentUserId]);

  async function submit() {
    setMsg("");

    const userResult = await readCurrentUser();
    if (userResult.status === "read_error") {
      setMsg("❌ Could not verify your session. Please retry.");
      return;
    }
    if (userResult.status === "unauthenticated") {
      setMsg("❌ Not logged in.");
      return;
    }
    const uid = userResult.user.id;

    if (!startAt || !endAt) {
      setMsg("❌ Please select start and end.");
      return;
    }

    const startISO = localInputToISO(startAt);
    const endISO = localInputToISO(endAt);

    if (new Date(endISO).getTime() <= new Date(startISO).getTime()) {
      setMsg("❌ End must be after Start.");
      return;
    }

    const profileStatus = await supabase
      .from("profiles")
      .select("is_active")
      .eq("id", uid)
      .maybeSingle();

    if (profileStatus.error) {
      setMsg("❌ Could not confirm your employee status: " + profileStatus.error.message);
      return;
    }

    if (profileStatus.data?.is_active !== true) {
      setMsg("❌ Your employee profile is inactive. New availability cannot be submitted.");
      return;
    }

    const ins = await supabase.from("staff_unavailability").insert(
      [
        {
          staff_id: uid,
          store_id: storeId,
          start_at: startISO,
          end_at: endISO,
          reason: reason.trim() === "" ? null : reason.trim(),
          created_by: uid,
        },
      ],
      { returning: "minimal" } as any
    );

    if (ins.error) {
      setMsg("❌ Submit failed: " + ins.error.message);
      return;
    }

    setMsg("✅ Submitted!");
    setReason("");
    await loadMyUnavailable(uid);
  }

  async function remove(id: number) {
    if (!confirm("Delete this unavailable record?")) return;
    const d = await supabase.from("staff_unavailability").delete().eq("id", id);
    if (d.error) {
      setMsg("❌ Delete failed: " + d.error.message);
      return;
    }
    setMsg("✅ Deleted!");
    if (currentUserId) await loadMyUnavailable(currentUserId);
  }

  if (authStatus === "loading") {
    return (
      <div style={{ padding: 20 }}>
        <h1>Staff — Unavailable</h1>
        <p>Checking your session…</p>
      </div>
    );
  }

  if (authStatus === "read_error") {
    return (
      <div style={{ padding: 20 }}>
        <h1>Staff — Unavailable</h1>
        <p>{authError}</p>
        <button onClick={() => setAuthRetryKey((value) => value + 1)}>Retry</button>
      </div>
    );
  }

  if (authStatus === "unauthenticated" || !email) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Staff — Unavailable</h1>
        <p>Not logged in. Please go back to Home and login.</p>
        <a href="/">Back to Home</a>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Staff — Unavailable (Time Range)</h1>
      <div style={{ marginBottom: 10 }}>
        Logged in as: <b>{email}</b>
      </div>

      <a href="/" style={{ display: "inline-block", marginBottom: 12 }}>
        Back to Home
      </a>

      <div style={{ border: "1px solid #ddd", padding: 12, maxWidth: 700 }}>
        <h3 style={{ marginTop: 0 }}>Add Unavailable</h3>

        <div style={{ marginBottom: 8 }}>
          Store ID:{" "}
          <input value={storeId} onChange={(e) => setStoreId(e.target.value)} />
        </div>

        <div style={{ marginBottom: 8 }}>
          Start:{" "}
          <input
            type="datetime-local"
            value={startAt}
            onChange={(e) => setStartAt(e.target.value)}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          End:{" "}
          <input
            type="datetime-local"
            value={endAt}
            onChange={(e) => setEndAt(e.target.value)}
          />
        </div>

        <div style={{ marginBottom: 8 }}>
          Reason (optional):{" "}
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{ width: 420 }}
            placeholder="e.g. class / sick / family"
          />
        </div>

        <button onClick={submit}>Submit</button>

        {msg && <div style={{ marginTop: 10 }}>{msg}</div>}
      </div>

      <hr style={{ margin: "16px 0" }} />

      <h3>My Unavailable Records</h3>
      {myRows.length === 0 ? (
        <div style={{ color: "#666" }}>No records yet.</div>
      ) : (
        <div style={{ maxWidth: 900 }}>
          {myRows.map((r) => (
            <div
              key={r.id}
              style={{
                border: "1px solid #eee",
                padding: 10,
                marginBottom: 8,
              }}
            >
              <div>
                <b>{r.store_id}</b> |{" "}
                {new Date(r.start_at).toLocaleString()} →{" "}
                {new Date(r.end_at).toLocaleString()}
              </div>
              <div style={{ color: "#666" }}>
                Reason: {r.reason ?? "-"}
              </div>
              <button onClick={() => remove(r.id)} style={{ marginTop: 6 }}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
