import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Row = {
  id: string;
  full_name: string | null;
  preferred_name: string | null;
  role: "OWNER" | "MANAGER" | "STAFF";
  is_active: boolean;
  pin_set: boolean;
};

function nameLabel(r: Row) {
  const p = (r.preferred_name ?? "").trim();
  const f = (r.full_name ?? "").trim();
  return p || f || "Unnamed";
}

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

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
        padding: "10px 14px",
        minHeight: 38,
        borderRadius: 12,
        border: `1px solid ${borderColor}`,
        background: bg,
        color: textColor,
        fontWeight: 700,
        fontSize: 13,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: primary || danger ? "0 8px 18px rgba(0,0,0,0.10)" : "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function badge(
  label: string,
  kind: "green" | "yellow" | "blue" | "gray" | "red" = "gray"
) {
  const styles: Record<string, { bg: string; color: string }> = {
    green: { bg: "#DCFCE7", color: "#166534" },
    yellow: { bg: "#FEF3C7", color: "#92400E" },
    blue: { bg: "#EAF3FF", color: WAK_BLUE },
    gray: { bg: "#F3F4F6", color: "#374151" },
    red: { bg: "#FEE2E2", color: "#991B1B" },
  };

  return (
    <span
      style={{
        display: "inline-block",
        padding: "5px 9px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        lineHeight: "16px",
        background: styles[kind].bg,
        color: styles[kind].color,
      }}
    >
      {label}
    </span>
  );
}

function inputStyle(width?: number | string, disabled?: boolean) {
  return {
    width: width ?? "100%",
    maxWidth: "100%",
    boxSizing: "border-box" as const,
    padding: "8px 10px",
    height: 36,
    borderRadius: 10,
    border: "1px solid #D1D5DB",
    fontSize: 13,
    lineHeight: "18px",
    background: disabled ? "#F3F4F6" : "#fff",
    color: TEXT,
  };
}

export default function EmployeesPage() {
  const [meRole, setMeRole] = useState<"OWNER" | "MANAGER" | "STAFF" | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const [cFull, setCFull] = useState("");
  const [cPref, setCPref] = useState("");
  const [cRole, setCRole] = useState<"STAFF" | "MANAGER" | "OWNER">("STAFF");

  const [edit, setEdit] = useState<Record<string, Partial<Row>>>({});

  const [pinTarget, setPinTarget] = useState<Row | null>(null);
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");

  async function guardRole() {
    const { data } = await supabase.auth.getUser();
    const uid = data.user?.id;

    if (!uid) {
      window.location.href = "/";
      return;
    }

    const pr = await supabase.from("profiles").select("role").eq("id", uid).maybeSingle();
    const r = ((pr.data as any)?.role ?? null) as any;
    setMeRole(r);

    if (!(r === "OWNER" || r === "MANAGER")) {
      window.location.href = "/";
      return;
    }
  }

  function canTouch(target: Row) {
    if (meRole === "OWNER") return true;
    if (meRole === "MANAGER") return target.role !== "OWNER";
    return false;
  }

  function setEditField(id: string, patch: Partial<Row>) {
    setEdit((prev) => ({ ...prev, [id]: { ...(prev[id] ?? {}), ...patch } }));
  }

  function mergedRow(r: Row): Row {
    const p = edit[r.id] ?? {};
    return { ...r, ...p } as Row;
  }

  async function load() {
    setLoading(true);
    setMsg("");

    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;

      if (!accessToken) {
        setMsg("❌ No session. Please login again.");
        return;
      }

      const resp = await fetch("/api/admin/list-profiles", {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const out = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        setMsg("❌ Admin API failed: " + (out?.error ?? `Status ${resp.status}`));
        setRows([]);
        return;
      }

      const list = (out.rows ?? []) as Row[];
      list.sort((a, b) => nameLabel(a).localeCompare(nameLabel(b)));
      setRows(list);
      setEdit({});
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    guardRole().then(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createStaff() {
    setLoading(true);
    setMsg("");

    try {
      if (!cFull.trim()) {
        setMsg("❌ Full name is required.");
        return;
      }

      if (!cPref.trim()) {
        setMsg("❌ Preferred name is required.");
        return;
      }

      if (meRole === "MANAGER" && cRole === "OWNER") {
        setMsg("❌ Manager cannot create OWNER.");
        return;
      }

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;

      if (!accessToken) {
        setMsg("❌ No session. Please login again.");
        return;
      }

      const resp = await fetch("/api/admin/create-staff", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          full_name: cFull.trim(),
          preferred_name: cPref.trim(),
          role: cRole,
        }),
      });

      const out = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        setMsg("❌ " + (out?.error ?? "Create failed"));
        return;
      }

      setMsg("✅ Created!");
      setCFull("");
      setCPref("");
      setCRole("STAFF");
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function saveRow(id: string) {
    setLoading(true);
    setMsg("");

    try {
      const base = rows.find((x) => x.id === id);
      if (!base) return;

      if (!canTouch(base)) {
        setMsg("❌ You cannot modify this user.");
        return;
      }

      const m = mergedRow(base);

      if (meRole === "MANAGER" && m.role === "OWNER") {
        setMsg("❌ Manager cannot set OWNER role.");
        return;
      }

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;

      if (!accessToken) {
        setMsg("❌ No session. Please login again.");
        return;
      }

      const resp = await fetch("/api/admin/update-profile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          staff_id: id,
          full_name: base.full_name ?? "",
          preferred_name: base.preferred_name ?? "",
          role: m.role,
          is_active: m.is_active,
        }),
      });

      const out = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        setMsg("❌ " + (out?.error ?? "Save failed"));
        return;
      }

      setMsg("✅ Saved!");
      await load();
    } finally {
      setLoading(false);
    }
  }

  async function setPinNow() {
    setLoading(true);
    setMsg("");

    try {
      if (!pinTarget) return;

      if (!pin1.trim()) {
        setMsg("❌ PIN cannot be empty.");
        return;
      }

      if (pin1 !== pin2) {
        setMsg("❌ PINs do not match.");
        return;
      }

      if (!canTouch(pinTarget)) {
        setMsg("❌ You cannot set PIN for this user.");
        return;
      }

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;

      if (!accessToken) {
        setMsg("❌ No session. Please login again.");
        return;
      }

      const resp = await fetch("/api/admin/set-pin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ staff_id: pinTarget.id, pin: pin1 }),
      });

      const out = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        setMsg("❌ " + (out?.error ?? "Set PIN failed"));
        return;
      }

      setMsg("✅ PIN updated!");
      setPinTarget(null);
      setPin1("");
      setPin2("");
      await load();
    } finally {
      setLoading(false);
    }
  }

  const totalEmployees = rows.length;
  const activeEmployees = rows.filter((r) => r.is_active).length;
  const pinSetCount = rows.filter((r) => r.pin_set).length;

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
      {pinTarget && (
        <>
          <div
            onClick={() => setPinTarget(null)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.25)",
              zIndex: 999,
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(520px, calc(100vw - 32px))",
              background: "#fff",
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              padding: 20,
              zIndex: 1000,
              boxShadow: "0 18px 40px rgba(0,0,0,0.18)",
            }}
          >
            <h2 style={{ marginTop: 0, marginBottom: 14, color: TEXT }}>
              Set PIN — {nameLabel(pinTarget)}
            </h2>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>
                New PIN (any length)
              </div>
              <input
                value={pin1}
                onChange={(e) => setPin1(e.target.value)}
                style={inputStyle("100%")}
              />
            </div>

            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>
                Confirm PIN
              </div>
              <input
                value={pin2}
                onChange={(e) => setPin2(e.target.value)}
                style={inputStyle("100%")}
              />
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {actionButton("Save PIN", setPinNow, {
                primary: true,
                disabled: loading,
              })}
              {actionButton("Cancel", () => setPinTarget(null), {
                disabled: loading,
              })}
            </div>
          </div>
        </>
      )}

      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: CARD_BG,
            padding: 20,
            marginBottom: 16,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1 style={{ margin: 0, color: TEXT }}>Employee Details</h1>
              <div style={{ marginTop: 6, color: MUTED, fontSize: 14 }}>
                Create staff, update roles and manage PIN access
              </div>
            </div>

            <div>
              {actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "#F9FAFB",
              border: `1px solid ${BORDER}`,
              minWidth: 160,
            }}
          >
            <div style={{ fontSize: 12, color: MUTED }}>Total employees</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: TEXT }}>
              {totalEmployees}
            </div>
          </div>

          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "#F9FAFB",
              border: `1px solid ${BORDER}`,
              minWidth: 160,
            }}
          >
            <div style={{ fontSize: 12, color: MUTED }}>Active employees</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: WAK_BLUE }}>
              {activeEmployees}
            </div>
          </div>

          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "#F9FAFB",
              border: `1px solid ${BORDER}`,
              minWidth: 160,
            }}
          >
            <div style={{ fontSize: 12, color: MUTED }}>PIN set</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: WAK_RED }}>
              {pinSetCount}
            </div>
          </div>
        </div>

        {msg && (
          <div
            style={{
              border: `1px solid ${BORDER}`,
              background: "#fff",
              padding: "10px 12px",
              borderRadius: 12,
              marginBottom: 16,
              color: TEXT,
              fontSize: 14,
            }}
          >
            {msg}
          </div>
        )}

        {loading && (
          <div
            style={{
              border: `1px solid ${BORDER}`,
              background: "#fff",
              padding: "12px 14px",
              borderRadius: 12,
              marginBottom: 16,
              color: MUTED,
              fontSize: 14,
            }}
          >
            Loading...
          </div>
        )}

        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: CARD_BG,
            padding: 18,
            marginBottom: 16,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ marginBottom: 14 }}>
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Create employee</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
              Email is auto-generated. After creation, click “Set PIN”.
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
            <div style={{ flex: "1 1 240px", maxWidth: 280 }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Full name</div>
              <input
                value={cFull}
                onChange={(e) => setCFull(e.target.value)}
                style={inputStyle("100%")}
              />
            </div>

            <div style={{ flex: "1 1 220px", maxWidth: 240 }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>
                Preferred name
              </div>
              <input
                value={cPref}
                onChange={(e) => setCPref(e.target.value)}
                style={inputStyle("100%")}
              />
            </div>

            <div style={{ flex: "0 0 160px" }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Role</div>
              <select
                value={cRole}
                onChange={(e) => setCRole(e.target.value as any)}
                style={inputStyle("100%")}
              >
                <option value="STAFF">STAFF</option>
                <option value="MANAGER">MANAGER</option>
                {meRole === "OWNER" && <option value="OWNER">OWNER</option>}
              </select>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {actionButton("Create", createStaff, {
                primary: true,
                disabled: loading,
              })}
              {actionButton("Refresh", load, { disabled: loading })}
            </div>
          </div>
        </div>

        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: CARD_BG,
            padding: 18,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div
            style={{
              marginBottom: 14,
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Employee list</h2>
              <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>
                Managers cannot edit owner accounts.
              </div>
            </div>

            
          </div>

          <div style={{ overflowX: "auto" }}>
            <table
              cellPadding={0}
              style={{
                width: "100%",
                borderCollapse: "separate",
                borderSpacing: 0,
                minWidth: 760,
              }}
            >
              <thead>
                <tr>
                  {["Name", "Role", "Active", "PIN", "Actions"].map((head) => (
                    <th
                      key={head}
                      style={{
                        textAlign: "left",
                        padding: "10px 10px",
                        borderBottom: `1px solid ${BORDER}`,
                        color: MUTED,
                        fontSize: 13,
                        fontWeight: 700,
                        background: "#FAFAFA",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {rows.map((r0) => {
                  const r = mergedRow(r0);
                  const disabled = !canTouch(r0);

                  return (
                    <tr key={r0.id} style={{ opacity: disabled ? 0.62 : 1 }}>
                      <td
                        style={{
                          padding: "12px 10px",
                          borderBottom: `1px solid ${BORDER}`,
                          fontWeight: 700,
                          fontSize: 14,
                          color: TEXT,
                          whiteSpace: "nowrap",
                          verticalAlign: "middle",
                        }}
                      >
                        {nameLabel(r0)}
                      </td>

                      <td
                        style={{
                          padding: "12px 10px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "middle",
                        }}
                      >
                        <select
                          value={r.role}
                          onChange={(e) =>
                            setEditField(r0.id, { role: e.target.value as any })
                          }
                          disabled={disabled}
                          style={inputStyle(110, disabled)}
                        >
                          <option value="STAFF">STAFF</option>
                          <option value="MANAGER">MANAGER</option>
                          {meRole === "OWNER" && <option value="OWNER">OWNER</option>}
                        </select>
                      </td>

                      <td
                        style={{
                          padding: "12px 10px",
                          borderBottom: `1px solid ${BORDER}`,
                          textAlign: "center",
                          verticalAlign: "middle",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={!!r.is_active}
                          onChange={(e) =>
                            setEditField(r0.id, { is_active: e.target.checked })
                          }
                          disabled={disabled}
                        />
                      </td>

                      <td
                        style={{
                          padding: "12px 10px",
                          borderBottom: `1px solid ${BORDER}`,
                          verticalAlign: "middle",
                        }}
                      >
                        {r0.pin_set ? badge("Set", "green") : badge("Not set", "red")}
                      </td>

                      <td
                        style={{
                          padding: "12px 10px",
                          borderBottom: `1px solid ${BORDER}`,
                          whiteSpace: "nowrap",
                          verticalAlign: "middle",
                        }}
                      >
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {actionButton("Save", () => saveRow(r0.id), {
                            primary: true,
                            disabled: disabled || loading,
                          })}

                          {actionButton(
                            "Set PIN",
                            () => {
                              if (disabled) return;
                              setPinTarget(r0);
                              setPin1("");
                              setPin2("");
                            },
                            { disabled: disabled || loading }
                          )}

                          {actionButton("Details", () => {
                            window.location.href = `/manager/employee/${r0.id}`;
                          })}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}