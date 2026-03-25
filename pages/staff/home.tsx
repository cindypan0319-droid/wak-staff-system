import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF" | "INACTIVE" | "ANON" | string;

type ProfileRow = {
  role: Role | null;
  is_active: boolean | null;
  full_name: string | null;
  preferred_name?: string | null;
};

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";
const SINGLE_LOGIN_STORAGE_KEY = "wak_single_login_token";

function displayName(profile: ProfileRow | null, email: string | null) {
  const preferred = (profile?.preferred_name ?? "").trim();
  const full = (profile?.full_name ?? "").trim();
  return preferred || full || email || "-";
}

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
          border: `1px solid ${BORDER}`,
          borderRadius: 16,
          padding: 16,
          minHeight: 112,
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#fff",
          cursor: "pointer",
          boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 900, color: TEXT }}>{title}</div>
          {desc ? (
            <div
              style={{
                marginTop: 8,
                fontSize: 13,
                color: MUTED,
                lineHeight: 1.45,
              }}
            >
              {desc}
            </div>
          ) : null}
        </div>

        <div
          style={{
            marginTop: 14,
            fontSize: 13,
            color: WAK_BLUE,
            fontWeight: 800,
          }}
        >
          Open →
        </div>
      </div>
    </Link>
  );
}

function actionButton(
  label: string,
  onClick: () => void,
  options?: { primary?: boolean; danger?: boolean; disabled?: boolean }
) {
  const primary = options?.primary;
  const danger = options?.danger;
  const disabled = options?.disabled;

  let bg = "#fff";
  let borderColor = BORDER;
  let textColor = TEXT;

  if (primary) {
    bg = WAK_BLUE;
    borderColor = WAK_BLUE;
    textColor = "#fff";
  }

  if (danger) {
    bg = WAK_RED;
    borderColor = WAK_RED;
    textColor = "#fff";
  }

  if (disabled) {
    bg = "#D1D5DB";
    borderColor = "#D1D5DB";
    textColor = "#fff";
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "12px 16px",
        minHeight: 46,
        borderRadius: 12,
        border: `1px solid ${borderColor}`,
        background: bg,
        color: textColor,
        fontWeight: 800,
        fontSize: 15,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: primary || danger ? "0 8px 18px rgba(0,0,0,0.10)" : "none",
      }}
    >
      {label}
    </button>
  );
}

function SectionBlock({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 18,
        background: CARD_BG,
        padding: 18,
        marginTop: 18,
        boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
      }}
    >
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>{title}</h2>
        {desc ? (
          <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>{desc}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export default function StaffHomePage() {
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<Role>("ANON");
  const [email, setEmail] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [msg, setMsg] = useState("");
  const [isStoreDevice, setIsStoreDevice] = useState(false);

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
        .select("role, is_active, full_name, preferred_name")
        .eq("id", session.user.id)
        .maybeSingle();

      if (error) {
        setRole("ANON");
        setProfile(null);
        setMsg("Cannot load profile: " + error.message);
        return;
      }

      const p = (data as ProfileRow | null) ?? null;
      setProfile(p);

      if (!p?.is_active) {
        setRole("INACTIVE");
        setMsg("Your account is inactive.");
        return;
      }

      setRole((p?.role as Role) ?? "ANON");
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    setLoading(true);
    setMsg("");

    try {
      localStorage.removeItem(SINGLE_LOGIN_STORAGE_KEY);
      await supabase.auth.signOut();
      window.location.href = "/";
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    async function checkStoreAccess() {
      try {
        const res = await fetch("/api/check-store-access");
        const data = await res.json();
        setIsStoreDevice(!!data.allowed);
      } catch (error) {
        console.log("check store access error:", error);
        setIsStoreDevice(false);
      }
    }

    checkStoreAccess();
  }, []);

  useEffect(() => {
    loadMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ margin: 0, color: TEXT }}>WAK Staff System</h1>
            <div style={{ marginTop: 10, color: MUTED }}>Loading...</div>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseStaffPages) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 980, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ marginTop: 0, color: TEXT }}>WAK Staff System</h1>
            <div
              style={{
                border: `1px solid ${BORDER}`,
                borderRadius: 12,
                padding: 14,
                marginTop: 14,
                background: "#fff",
                color: TEXT,
              }}
            >
              Access denied. Role: <b>{role}</b>
            </div>

            {msg && (
              <div
                style={{
                  marginTop: 12,
                  border: `1px solid ${BORDER}`,
                  borderRadius: 12,
                  padding: 12,
                  background: "#fff",
                  color: TEXT,
                }}
              >
                {msg}
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              {actionButton("Logout", logout, { danger: true })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const shownName = displayName(profile, email);

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: CARD_BG,
            padding: 20,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              flexWrap: "wrap",
              gap: 14,
            }}
          >
            <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
              <img
                src="/favicon.png"
                alt="WAK Logo"
                style={{ width: 90, height: "auto", display: "block" }}
              />

              <div>
                <h1 style={{ margin: 0, color: TEXT }}>WAK Staff System</h1>
                <div style={{ marginTop: 6, color: MUTED, fontSize: 14 }}>
                  Staff portal for daily tools and management access
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {actionButton("Refresh", loadMe, { disabled: loading })}
              {actionButton("Logout", logout, { danger: true, disabled: loading })}
            </div>
          </div>

          <div
            style={{
              marginTop: 18,
              border: `1px solid ${BORDER}`,
              borderRadius: 14,
              background: "#F9FAFB",
              padding: 14,
              color: TEXT,
            }}
          >
            Logged in as: <b>{shownName}</b> | Role: <b>{role}</b>
          </div>

          {msg && (
            <div
              style={{
                marginTop: 14,
                border: `1px solid ${BORDER}`,
                borderRadius: 14,
                padding: 12,
                background: "#fff",
                color: TEXT,
              }}
            >
              {msg}
            </div>
          )}
        </div>

        <SectionBlock title="My Tools" desc="Daily staff tools and personal records">
          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            }}
          >
            {isStoreDevice && (
              <CardButton title="Time Clock" desc="Clock in / clock out" href="/staff/clock" />
            )}

            {isStoreDevice && (
              <CardButton title="Daily Entry" desc="Enter daily numbers" href="/staff/daily-entry" />
            )}

            <CardButton title="My Roster" desc="Check my shifts" href="/staff/my-roster" />
            <CardButton
              title="My Clock History"
              desc="Check my own records"
              href="/staff/clock-history"
            />
          </div>
        </SectionBlock>

        {isManagerOrOwner && (
          <SectionBlock
            title="Manager Tools"
            desc="Roster, staff management and store operations"
          >
            <div
              style={{
                display: "grid",
                gap: 14,
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
                desc="Weekly roster view and edit"
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
          </SectionBlock>
        )}

        {isOwner && (
          <SectionBlock
            title="Owner Tools"
            desc="Business overview, settings and owner-level controls"
          >
            <div
              style={{
                display: "grid",
                gap: 14,
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              }}
            >
              <CardButton
                title="Daily Entry Log"
                desc="Sheet-style daily entry table"
                href="/owner/daily-log"
              />

              <CardButton
                title="Dashboard"
                desc="Business overview"
                href="/owner/dashboard"
              />

              <CardButton
                title="Payroll"
                desc="Hours & pay summary"
                href="/owner/staff-summary"
              />

              <CardButton
                title="Platform"
                desc="Manage platforms / commission settings"
                href="/manager/platforms"
              />

              <CardButton
                title="Pay Rates"
                desc="Edit weekday / sat / sun rates"
                href="/manager/pay-rates"
              />
            </div>
          </SectionBlock>
        )}
      </div>
    </div>
  );
}