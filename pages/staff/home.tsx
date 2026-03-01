import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;

function CardButton({
  title,
  desc,
  href,
}: {
  title: string;
  desc?: string;
  href: string;
}) {
  return (
    <Link href={href} style={{ textDecoration: "none", color: "inherit" }}>
      <div
        style={{
          border: "1px solid #ddd",
          borderRadius: 14,
          padding: 14,
          minHeight: 92,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#fff",
          cursor: "pointer",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 900 }}>{title}</div>
        {desc ? (
          <div style={{ marginTop: 6, fontSize: 12, color: "#666", lineHeight: 1.4 }}>
            {desc}
          </div>
        ) : (
          <div />
        )}
        <div style={{ marginTop: 10, fontSize: 12, color: "#333", fontWeight: 800 }}>
          Open →
        </div>
      </div>
    </Link>
  );
}

export default function StaffHomePage() {
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role>("ANON");
  const [email, setEmail] = useState<string | null>(null);
  const [fullName, setFullName] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  const isOwner = useMemo(() => role === "OWNER", [role]);
  const isManager = useMemo(() => role === "MANAGER", [role]);
  const isManagerOrOwner = useMemo(() => role === "OWNER" || role === "MANAGER", [role]);

  const canUseStaffPages = useMemo(
    () => role === "OWNER" || role === "MANAGER" || role === "STAFF",
    [role]
  );

  async function loadMe() {
    setLoading(true);
    setMsg("");

    try {
      const { data: s } = await supabase.auth.getSession();
      const session = s.session;

      if (!session?.user?.id) {
        window.location.href = "/";
        return;
      }

      setEmail(session.user.email ?? null);

      const { data, error } = await supabase
        .from("profiles")
        .select("role, is_active, full_name")
        .eq("id", session.user.id)
        .maybeSingle();

      if (error) {
        setRole("ANON");
        setMsg("Cannot load profile: " + error.message);
        return;
      }

      if (!data?.is_active) {
        setRole("INACTIVE");
        setMsg("Your account is inactive.");
        return;
      }

      setRole((data?.role as Role) ?? "ANON");
      setFullName(data?.full_name ?? null);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    setLoading(true);
    setMsg("");
    try {
      await supabase.auth.signOut();
      window.location.href = "/";
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div style={{ padding: 20 }}>Loading…</div>;

  if (!canUseStaffPages) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Home</h1>
        <div style={{ border: "1px solid #ddd", padding: 12, marginTop: 12 }}>
          Access denied. Role: <b>{role}</b>
        </div>
        <div style={{ marginTop: 12 }}>
          <button onClick={logout}>Logout</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ margin: 0 }}>Home</h1>
            <div style={{ marginTop: 6, color: "#333" }}>
              Welcome, <b>{fullName ?? email ?? "-"}</b> | Role: <b>{role}</b>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={loadMe}>Refresh</button>
            <button onClick={logout} style={{ fontWeight: 900 }}>
              Logout
            </button>
          </div>
        </div>

        {msg && (
          <div style={{ marginTop: 12, border: "1px solid #ddd", borderRadius: 14, padding: 10 }}>
            {msg}
          </div>
        )}

        {/* My Tools */}
        <div style={{ marginTop: 16 }}>
          <h2>My Tools</h2>
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            }}
          >
            <CardButton title="Time Clock" desc="Clock in / clock out" href="/staff/clock" />
            <CardButton title="My Clock History" desc="Check my own records" href="/staff/clock-history" />
            <CardButton title="Daily Entry" desc="Enter daily numbers" href="/staff/daily-entry" />
            <CardButton title="My Details" desc="Update my personal details" href="/staff/my-details" />
          </div>
        </div>

        {/* Manager Tools (Manager OR Owner can see) */}
        {isManagerOrOwner && (
          <div style={{ marginTop: 24 }}>
            <h2>Manager Tools</h2>

            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              }}
            >
              <CardButton
                title="Roster & Time Clock Adjustment"
                desc="Adjust and calculate pay"
                href="/manager/clock-adjustment"
              />

              <CardButton
                title="Roster (Week)"
                desc="Weekly roster view"
                href="/manager/roster-week"
              />

              <CardButton
                title="Employees"
                desc="Create staff, edit role, set PIN"
                href="/manager/employees"
              />

              <CardButton
                title="Invoices"
                desc="Manage and input invoices"
                href="/manager/invoices"
              />
            </div>

          </div>
        )}

        {/* Owner Tools (OWNER ONLY) */}
        {isOwner && (
          <div style={{ marginTop: 24 }}>
            <h2>Owner Tools</h2>

            <div
              style={{
                display: "grid",
                gap: 12,
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              }}
            >
              <CardButton
                title="Platform"
                desc="Manage platforms / commission settings"
                href="/manager/platforms"
              />

              <CardButton
                title="Pay Rates"
                desc="Edit weekday/sat/sun rates"
                href="/manager/pay-rates"
              />

              <CardButton
                title="Staff Summary"
                desc="Hours & pay summary (Owner only)"
                href="/owner/staff-summary"
              />

              {/* ✅ Dashboard: keep your existing page path here */}
              <CardButton
                title="Dashboard"
                desc="Business overview (Owner only)"
                href="/owner/dashboard"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}