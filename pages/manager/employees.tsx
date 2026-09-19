import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { supabase } from "../../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF";
type Filter = "ACTIVE" | "INACTIVE" | "ALL";

type Row = {
  id: string;
  full_name: string | null;
  preferred_name: string | null;
  role: Role;
  is_active: boolean;
  pin_set: boolean;
};

type ApiResult = { error?: string; rows?: Row[]; staff_id?: string };

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

function displayName(row: Pick<Row, "full_name" | "preferred_name">) {
  return row.preferred_name?.trim() || row.full_name?.trim() || "Unnamed employee";
}

function hasDistinctFullName(row: Pick<Row, "full_name" | "preferred_name">) {
  const preferredName = row.preferred_name?.trim();
  const fullName = row.full_name?.trim();
  if (!preferredName || !fullName) return false;

  const normalize = (value: string) => value.replace(/\s+/g, " ").toLocaleLowerCase();
  return normalize(preferredName) !== normalize(fullName);
}

function inputStyle() {
  return {
    width: "100%",
    boxSizing: "border-box" as const,
    minHeight: 42,
    padding: "9px 11px",
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    background: "#fff",
    color: TEXT,
    fontSize: 14,
  };
}

function buttonStyle(kind: "primary" | "secondary" | "danger" = "secondary") {
  const colors = {
    primary: { background: WAK_BLUE, borderColor: WAK_BLUE, color: "#fff" },
    secondary: { background: "#fff", borderColor: BORDER, color: TEXT },
    danger: { background: WAK_RED, borderColor: WAK_RED, color: "#fff" },
  }[kind];

  return {
    ...colors,
    borderWidth: 1,
    borderStyle: "solid",
    borderRadius: 10,
    minHeight: 40,
    padding: "9px 14px",
    fontWeight: 750,
    cursor: "pointer",
  };
}

function Badge({ children, tone }: { children: ReactNode; tone: "green" | "red" | "blue" | "gray" }) {
  const colors = {
    green: { background: "#DCFCE7", color: "#166534" },
    red: { background: "#FEE2E2", color: "#991B1B" },
    blue: { background: "#EAF3FF", color: WAK_BLUE },
    gray: { background: "#F3F4F6", color: "#374151" },
  }[tone];

  return (
    <span
      style={{
        ...colors,
        display: "inline-block",
        padding: "5px 9px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 750,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <span style={{ display: "block", marginBottom: 6, color: TEXT, fontSize: 13, fontWeight: 700 }}>
        {label}
      </span>
      {children}
      {hint && <span style={{ display: "block", marginTop: 5, color: MUTED, fontSize: 12 }}>{hint}</span>}
    </label>
  );
}

function Modal({
  title,
  children,
  onClose,
  width = 580,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 16 }}
    >
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        style={{ position: "absolute", inset: 0, border: 0, background: "rgba(17,24,39,0.48)", cursor: "default" }}
      />
      <div
        style={{
          position: "relative",
          width: `min(${width}px, 100%)`,
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          borderRadius: 18,
          background: "#fff",
          boxShadow: "0 24px 70px rgba(0,0,0,0.24)",
        }}
      >
        <div
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "17px 20px",
            borderBottom: `1px solid ${BORDER}`,
            background: "#fff",
          }}
        >
          <h2 style={{ margin: 0, color: TEXT, fontSize: 21 }}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ border: 0, background: "transparent", color: MUTED, fontSize: 28, lineHeight: 1, cursor: "pointer" }}
          >
            ×
          </button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  );
}

export default function EmployeesPage() {
  const [meRole, setMeRole] = useState<Role | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [filter, setFilter] = useState<Filter>("ACTIVE");
  const [search, setSearch] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createFullName, setCreateFullName] = useState("");
  const [createPreferredName, setCreatePreferredName] = useState("");
  const [createRole, setCreateRole] = useState<Role>("STAFF");
  const [createPin, setCreatePin] = useState("");
  const [createdEmployee, setCreatedEmployee] = useState<{ id: string; name: string } | null>(null);

  const [editing, setEditing] = useState<Row | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState("");
  const [editFullName, setEditFullName] = useState("");
  const [editPreferredName, setEditPreferredName] = useState("");
  const [editRole, setEditRole] = useState<Role>("STAFF");

  const [pinTarget, setPinTarget] = useState<Row | null>(null);
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [pinError, setPinError] = useState("");
  const [pinLoading, setPinLoading] = useState(false);

  const [lifecycleTarget, setLifecycleTarget] = useState<{ row: Row; nextActive: boolean } | null>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleError, setLifecycleError] = useState("");

  const getAccessToken = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setMsg("❌ No session. Please login again.");
        return;
      }

      const response = await fetch("/api/admin/list-profiles", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const result = (await response.json().catch(() => ({}))) as ApiResult;

      if (!response.ok) {
        setRows([]);
        setMsg("❌ " + (result.error ?? "Could not load employees."));
        return;
      }

      const nextRows = result.rows ?? [];
      nextRows.sort((a, b) => displayName(a).localeCompare(displayName(b)));
      setRows(nextRows);
    } finally {
      setLoading(false);
    }
  }, [getAccessToken]);

  const guardRole = useCallback(async () => {
    const { data } = await supabase.auth.getUser();
    const uid = data.user?.id;
    if (!uid) {
      window.location.href = "/";
      return false;
    }

    const profile = await supabase.from("profiles").select("role").eq("id", uid).maybeSingle();
    const role = profile.data?.role as Role | undefined;
    if (!(role === "OWNER" || role === "MANAGER")) {
      window.location.href = "/";
      return false;
    }

    setMeRole(role);
    return true;
  }, []);

  useEffect(() => {
    guardRole().then((allowed) => {
      if (allowed) void load();
    });
  }, [guardRole, load]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter === "ACTIVE" && !row.is_active) return false;
      if (filter === "INACTIVE" && row.is_active) return false;
      if (!query) return true;

      return [displayName(row), row.full_name ?? "", row.preferred_name ?? "", row.role]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [filter, rows, search]);

  const activeCount = rows.filter((row) => row.is_active).length;
  const inactiveCount = rows.length - activeCount;

  function canEdit(row: Row) {
    return meRole === "OWNER" || (meRole === "MANAGER" && row.role !== "OWNER");
  }

  function resetCreateForm() {
    setCreateFullName("");
    setCreatePreferredName("");
    setCreateRole("STAFF");
    setCreatePin("");
    setCreateError("");
    setCreatedEmployee(null);
  }

  function closeCreate() {
    if (createLoading) return;
    setCreateOpen(false);
    resetCreateForm();
  }

  async function createEmployee() {
    const fullName = createFullName.trim();
    const preferredName = createPreferredName.trim();
    setCreateError("");

    if (!fullName) return setCreateError("Full name is required.");
    if (!/^\d{4}$/.test(createPin)) return setCreateError("PIN must be exactly 4 numeric digits.");
    if (meRole === "MANAGER" && createRole === "OWNER") {
      return setCreateError("Managers cannot create an OWNER account.");
    }

    setCreateLoading(true);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) return setCreateError("Your session has expired. Please login again.");

      const response = await fetch("/api/admin/create-staff", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          full_name: fullName,
          preferred_name: preferredName,
          role: createRole,
          pin: createPin,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as ApiResult;

      if (!response.ok || !result.staff_id) {
        setCreateError(result.error ?? "Employee creation failed.");
        return;
      }

      setCreatedEmployee({ id: result.staff_id, name: preferredName || fullName });
      setMsg(`✅ ${preferredName || fullName} was created successfully.`);
      await load();
    } finally {
      setCreateLoading(false);
    }
  }

  function openEdit(row: Row) {
    if (!canEdit(row)) return;
    setEditing(row);
    setEditFullName(row.full_name ?? "");
    setEditPreferredName(row.preferred_name ?? "");
    setEditRole(row.role);
    setEditError("");
  }

  async function saveChanges() {
    if (!editing) return;
    const fullName = editFullName.trim();
    const preferredName = editPreferredName.trim();
    setEditError("");

    if (!fullName) return setEditError("Full name is required.");
    if (meRole === "MANAGER" && editRole === "OWNER") return setEditError("Managers cannot set the OWNER role.");

    setEditLoading(true);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) return setEditError("Your session has expired. Please login again.");

      const response = await fetch("/api/admin/update-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          staff_id: editing.id,
          full_name: fullName,
          preferred_name: preferredName,
          role: editRole,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as ApiResult;
      if (!response.ok) {
        setEditError(result.error ?? "Could not save employee changes.");
        return;
      }

      setEditing(null);
      setMsg(`✅ Changes to ${preferredName || fullName} were saved.`);
      await load();
    } finally {
      setEditLoading(false);
    }
  }

  function openPinReset(row: Row) {
    setPinTarget(row);
    setPin("");
    setPinConfirm("");
    setPinError("");
  }

  async function resetPin() {
    if (!pinTarget) return;
    setPinError("");
    if (!/^\d{4}$/.test(pin)) return setPinError("PIN must be exactly 4 numeric digits.");
    if (pin !== pinConfirm) return setPinError("PINs do not match.");

    setPinLoading(true);
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) return setPinError("Your session has expired. Please login again.");

      const response = await fetch("/api/admin/set-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ staff_id: pinTarget.id, pin }),
      });
      const result = (await response.json().catch(() => ({}))) as ApiResult;
      if (!response.ok) {
        setPinError(result.error ?? "Could not reset PIN.");
        return;
      }

      setPinTarget(null);
      setMsg(`✅ PIN reset for ${displayName(pinTarget)}.`);
      await load();
    } finally {
      setPinLoading(false);
    }
  }

  function requestLifecycleChange(row: Row) {
    setLifecycleTarget({ row, nextActive: !row.is_active });
    setLifecycleError("");
  }

  async function changeLifecycle() {
    if (!lifecycleTarget) return;
    setLifecycleError("");
    setLifecycleLoading(true);

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) return setLifecycleError("Your session has expired. Please login again.");

      const response = await fetch("/api/admin/update-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ staff_id: lifecycleTarget.row.id, is_active: lifecycleTarget.nextActive }),
      });
      const result = (await response.json().catch(() => ({}))) as ApiResult;
      if (!response.ok) {
        setLifecycleError(result.error ?? "Could not update employee status.");
        return;
      }

      const employeeName = displayName(lifecycleTarget.row);
      const nextActive = lifecycleTarget.nextActive;
      setLifecycleTarget(null);
      setEditing(null);
      setFilter(nextActive ? "ACTIVE" : "INACTIVE");
      setMsg(`✅ ${employeeName} was ${nextActive ? "reactivated" : "deactivated"}.`);
      await load();
    } finally {
      setLifecycleLoading(false);
    }
  }

  if (!meRole) return <div style={{ padding: 20 }}>Checking access…</div>;

  return (
    <div style={{ minHeight: "100vh", background: WAK_BG, padding: 20 }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <section style={{ padding: 20, border: `1px solid ${BORDER}`, borderRadius: 18, background: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div>
              <h1 style={{ margin: 0, color: TEXT }}>Employee Management</h1>
              <p style={{ margin: "7px 0 0", color: MUTED }}>Create employees, manage login access and update employment status.</p>
            </div>
            <div style={{ display: "flex", gap: 9, alignItems: "flex-start", flexWrap: "wrap" }}>
              <button type="button" onClick={() => (window.location.href = "/staff/home")} style={buttonStyle()}>
                Back to Home
              </button>
              <button
                type="button"
                onClick={() => {
                  resetCreateForm();
                  setCreateOpen(true);
                }}
                style={buttonStyle("primary")}
              >
                + Create Employee
              </button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
            <Badge tone="blue">{rows.length} total</Badge>
            <Badge tone="green">{activeCount} active</Badge>
            <Badge tone="gray">{inactiveCount} inactive</Badge>
          </div>
        </section>

        {msg && <div style={{ marginTop: 14, padding: "11px 14px", border: `1px solid ${BORDER}`, borderRadius: 12, background: "#fff", color: TEXT }}>{msg}</div>}

        <section style={{ marginTop: 16, padding: 18, border: `1px solid ${BORDER}`, borderRadius: 18, background: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {(["ACTIVE", "INACTIVE", "ALL"] as Filter[]).map((value) => (
                <button key={value} type="button" onClick={() => setFilter(value)} style={buttonStyle(filter === value ? "primary" : "secondary")}>
                  {value === "ACTIVE" ? "Active" : value === "INACTIVE" ? "Inactive" : "All"}
                </button>
              ))}
            </div>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search employees…" aria-label="Search employees" style={{ ...inputStyle(), width: "min(100%, 320px)" }} />
          </div>

          <div style={{ marginTop: 16, overflowX: "auto" }}>
            <table style={{ width: "100%", minWidth: 680, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Employee", "Role", "Status", "PIN", "Actions"].map((heading) => (
                    <th key={heading} style={{ padding: "11px 10px", borderBottom: `1px solid ${BORDER}`, textAlign: "left", color: MUTED, fontSize: 12 }}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.id}>
                    <td style={{ padding: "13px 10px", borderBottom: `1px solid ${BORDER}` }}>
                      <div style={{ color: TEXT, fontWeight: 750 }}>{displayName(row)}</div>
                      {hasDistinctFullName(row) && <div style={{ marginTop: 3, color: MUTED, fontSize: 12 }}>{row.full_name}</div>}
                    </td>
                    <td style={{ padding: "13px 10px", borderBottom: `1px solid ${BORDER}` }}><Badge tone="blue">{row.role}</Badge></td>
                    <td style={{ padding: "13px 10px", borderBottom: `1px solid ${BORDER}` }}><Badge tone={row.is_active ? "green" : "gray"}>{row.is_active ? "Active" : "Inactive"}</Badge></td>
                    <td style={{ padding: "13px 10px", borderBottom: `1px solid ${BORDER}` }}><Badge tone={row.pin_set ? "blue" : "red"}>{row.pin_set ? "PIN set" : "No PIN"}</Badge></td>
                    <td style={{ padding: "13px 10px", borderBottom: `1px solid ${BORDER}` }}>
                      <button type="button" onClick={() => openEdit(row)} disabled={!canEdit(row)} title={!canEdit(row) ? "Managers cannot edit OWNER accounts" : undefined} style={{ ...buttonStyle(), opacity: canEdit(row) ? 1 : 0.5, cursor: canEdit(row) ? "pointer" : "not-allowed" }}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!loading && filteredRows.length === 0 && <div style={{ padding: "30px 12px", textAlign: "center", color: MUTED }}>No employees match this view.</div>}
            {loading && <div style={{ padding: "30px 12px", textAlign: "center", color: MUTED }}>Loading employees…</div>}
          </div>
        </section>
      </div>

      {createOpen && (
        <Modal title={createdEmployee ? "Employee Created" : "Create Employee"} onClose={closeCreate}>
          {createdEmployee ? (
            <div>
              <div style={{ padding: 14, borderRadius: 12, background: "#ECFDF5", color: "#166534", fontWeight: 700 }}>{createdEmployee.name} was created successfully and is ready to use.</div>
              <div style={{ display: "flex", gap: 9, marginTop: 18, flexWrap: "wrap" }}>
                <button type="button" onClick={() => (window.location.href = `/manager/employee/${createdEmployee.id}`)} style={buttonStyle("primary")}>Add employee details</button>
                <button type="button" onClick={closeCreate} style={buttonStyle()}>Done</button>
              </div>
            </div>
          ) : (
            <>
              <h3 style={{ margin: "0 0 14px", color: TEXT }}>Basic</h3>
              <Field label="Full name *"><input value={createFullName} onChange={(event) => setCreateFullName(event.target.value)} style={inputStyle()} /></Field>
              <Field label="Preferred name" hint="If left empty, the full name will be displayed."><input value={createPreferredName} onChange={(event) => setCreatePreferredName(event.target.value)} style={inputStyle()} /></Field>
              <Field label="Role *">
                <select value={createRole} onChange={(event) => setCreateRole(event.target.value as Role)} style={inputStyle()}>
                  <option value="STAFF">STAFF</option><option value="MANAGER">MANAGER</option>{meRole === "OWNER" && <option value="OWNER">OWNER</option>}
                </select>
              </Field>
              <h3 style={{ margin: "22px 0 14px", color: TEXT }}>Login</h3>
              <Field label="4-digit PIN *"><input type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={createPin} onChange={(event) => setCreatePin(event.target.value)} style={{ ...inputStyle(), letterSpacing: 5 }} /></Field>
              {createError && <div style={{ marginTop: 15, color: "#991B1B" }}>{createError}</div>}
              <div style={{ display: "flex", gap: 9, marginTop: 20, flexWrap: "wrap" }}>
                <button type="button" onClick={createEmployee} disabled={createLoading} style={buttonStyle("primary")}>{createLoading ? "Creating…" : "Create Employee"}</button>
                <button type="button" onClick={closeCreate} disabled={createLoading} style={buttonStyle()}>Cancel</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${displayName(editing)}`} onClose={() => !editLoading && setEditing(null)}>
          <Field label="Full name *"><input value={editFullName} onChange={(event) => setEditFullName(event.target.value)} style={inputStyle()} /></Field>
          <Field label="Preferred name" hint="If left empty, the full name will be displayed."><input value={editPreferredName} onChange={(event) => setEditPreferredName(event.target.value)} style={inputStyle()} /></Field>
          <Field label="Role *">
            <select value={editRole} onChange={(event) => setEditRole(event.target.value as Role)} style={inputStyle()}>
              <option value="STAFF">STAFF</option><option value="MANAGER">MANAGER</option>{meRole === "OWNER" && <option value="OWNER">OWNER</option>}
            </select>
          </Field>
          {editError && <div style={{ marginBottom: 14, color: "#991B1B" }}>{editError}</div>}
          <button type="button" onClick={saveChanges} disabled={editLoading} style={buttonStyle("primary")}>{editLoading ? "Saving…" : "Save Changes"}</button>
          <div style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${BORDER}` }}>
            <h3 style={{ margin: "0 0 12px", color: TEXT }}>Employee actions</h3>
            <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
              <button type="button" onClick={() => openPinReset(editing)} style={buttonStyle()}>Reset PIN</button>
              <button type="button" onClick={() => (window.location.href = `/manager/employee/${editing.id}`)} style={buttonStyle()}>Employee Details</button>
              <button type="button" onClick={() => requestLifecycleChange(editing)} style={buttonStyle(editing.is_active ? "danger" : "secondary")}>{editing.is_active ? "Deactivate Employee" : "Reactivate Employee"}</button>
            </div>
          </div>
        </Modal>
      )}

      {pinTarget && (
        <Modal title={`Reset PIN — ${displayName(pinTarget)}`} onClose={() => !pinLoading && setPinTarget(null)} width={460}>
          <Field label="New 4-digit PIN"><input type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={pin} onChange={(event) => setPin(event.target.value)} style={{ ...inputStyle(), letterSpacing: 5 }} /></Field>
          <Field label="Confirm PIN"><input type="password" inputMode="numeric" autoComplete="new-password" maxLength={4} value={pinConfirm} onChange={(event) => setPinConfirm(event.target.value)} style={{ ...inputStyle(), letterSpacing: 5 }} /></Field>
          {pinError && <div style={{ marginBottom: 14, color: "#991B1B" }}>{pinError}</div>}
          <div style={{ display: "flex", gap: 9 }}>
            <button type="button" onClick={resetPin} disabled={pinLoading} style={buttonStyle("primary")}>{pinLoading ? "Saving…" : "Reset PIN"}</button>
            <button type="button" onClick={() => setPinTarget(null)} disabled={pinLoading} style={buttonStyle()}>Cancel</button>
          </div>
        </Modal>
      )}

      {lifecycleTarget && (
        <Modal title={lifecycleTarget.nextActive ? "Reactivate Employee" : "Deactivate Employee"} onClose={() => !lifecycleLoading && setLifecycleTarget(null)} width={500}>
          {lifecycleTarget.nextActive ? (
            <p style={{ marginTop: 0, color: TEXT, lineHeight: 1.6 }}>Reactivate <b>{displayName(lifecycleTarget.row)}</b>? They will be able to log in again.</p>
          ) : (
            <div style={{ color: TEXT, lineHeight: 1.6 }}>
              <p style={{ marginTop: 0 }}>Deactivate <b>{displayName(lifecycleTarget.row)}</b>?</p>
              <p>This employee will be marked inactive and will no longer be able to log in. Existing shifts and historical records will not be deleted.</p>
            </div>
          )}
          {lifecycleError && <div style={{ marginBottom: 14, color: "#991B1B" }}>{lifecycleError}</div>}
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
            <button type="button" onClick={changeLifecycle} disabled={lifecycleLoading} style={buttonStyle(lifecycleTarget.nextActive ? "primary" : "danger")}>
              {lifecycleLoading ? "Updating…" : lifecycleTarget.nextActive ? "Reactivate Employee" : "Deactivate Employee"}
            </button>
            <button type="button" onClick={() => setLifecycleTarget(null)} disabled={lifecycleLoading} style={buttonStyle()}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
