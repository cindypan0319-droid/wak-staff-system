import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF";

type Details = {
  staff_id: string;
  birth_date: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  tfn: string | null;
  super_text: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
};

function calcAge(birth_date: string | null) {
  if (!birth_date) return "";
  const d = new Date(birth_date + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  let age = today.getFullYear() - d.getFullYear();
  const m = today.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < d.getDate())) age--;
  return age >= 0 ? String(age) : "";
}

export default function EmployeeDetailsPage() {
  const [meRole, setMeRole] = useState<Role | null>(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const [staffId, setStaffId] = useState<string>("");
  const [targetRole, setTargetRole] = useState<Role | null>(null);

  const [d, setD] = useState<Details>({
    staff_id: "",
    birth_date: null,
    phone: null,
    email: null,
    address: null,
    tfn: null,
    super_text: null,
    emergency_contact_name: null,
    emergency_contact_phone: null,
  });

  function canEdit() {
    if (!meRole) return false;
    if (meRole === "OWNER") return true;
    if (meRole === "MANAGER") return targetRole !== "OWNER";
    return false;
  }

  async function init() {
    setMsg("");
    setLoading(true);
    try {
      const params = new URLSearchParams(window.location.search);
      const sid = params.get("staff_id") || "";
      if (!sid) {
        setMsg("❌ Missing staff_id");
        return;
      }
      setStaffId(sid);

      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        window.location.href = "/";
        return;
      }

      // who am I
      const me = await supabase.auth.getUser();
      const uid = me.data.user?.id;
      if (!uid) {
        window.location.href = "/";
        return;
      }
      const pr = await supabase.from("profiles").select("role").eq("id", uid).maybeSingle();
      setMeRole(((pr.data as any)?.role ?? null) as Role | null);

      // get details from admin api (also returns target_role)
      const resp = await fetch(`/api/admin/get-employee-details?staff_id=${encodeURIComponent(sid)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const out = await resp.json();
      if (!resp.ok) {
        setMsg("❌ " + (out?.error ?? "Failed to load details"));
        return;
      }

      setTargetRole((out.target_role ?? null) as Role | null);

      const got = (out.details ?? {}) as Partial<Details>;
      setD({
        staff_id: sid,
        birth_date: (got.birth_date ?? null) as any,
        phone: (got.phone ?? null) as any,
        email: (got.email ?? null) as any,
        address: (got.address ?? null) as any,
        tfn: (got.tfn ?? null) as any,
        super_text: (got.super_text ?? null) as any,
        emergency_contact_name: (got.emergency_contact_name ?? null) as any,
        emergency_contact_phone: (got.emergency_contact_phone ?? null) as any,
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setMsg("");
    setLoading(true);
    try {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return setMsg("❌ No session. Please login again.");

      const resp = await fetch("/api/admin/update-employee-details", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          staff_id: staffId,
          birth_date: d.birth_date,
          phone: d.phone,
          email: d.email,
          address: d.address,
          tfn: d.tfn,
          super_text: d.super_text,
          emergency_contact_name: d.emergency_contact_name,
          emergency_contact_phone: d.emergency_contact_phone,
        }),
      });

      const out = await resp.json();
      if (!resp.ok) return setMsg("❌ " + (out?.error ?? "Save failed"));

      setMsg("✅ Saved!");
    } finally {
      setLoading(false);
    }
  }

  const disabled = !canEdit();

  return (
    <div style={{ padding: 20, maxWidth: 900 }}>
      <h1>Manager — Employee Details</h1>

      <div style={{ marginBottom: 10 }}>
        <button onClick={() => (window.location.href = "/manager/employees")}>← Back to employees</button>
      </div>

      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>{msg}</div>}
      {loading && <div style={{ marginBottom: 12 }}>Loading…</div>}

      <div style={{ border: "1px solid #ddd", padding: 12 }}>
        <div style={{ marginBottom: 10, color: "#666", fontSize: 12 }}>
          Staff ID: <b>{staffId}</b> {targetRole ? ` | Role: ${targetRole}` : ""}
          {disabled ? " | (Read-only)" : ""}
        </div>

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <div style={{ width: 220 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Birthday</div>
            <input
              type="date"
              value={d.birth_date ?? ""}
              onChange={(e) => setD((p) => ({ ...p, birth_date: e.target.value || null }))}
              style={{ width: "100%" }}
              disabled={disabled}
            />
          </div>

          <div style={{ width: 120 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Age</div>
            <input value={calcAge(d.birth_date)} readOnly style={{ width: "100%" }} />
          </div>

          <div style={{ width: 220 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Phone</div>
            <input
              value={d.phone ?? ""}
              onChange={(e) => setD((p) => ({ ...p, phone: e.target.value || null }))}
              style={{ width: "100%" }}
              disabled={disabled}
            />
          </div>

          <div style={{ width: 260 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Email</div>
            <input
              value={d.email ?? ""}
              onChange={(e) => setD((p) => ({ ...p, email: e.target.value || null }))}
              style={{ width: "100%" }}
              disabled={disabled}
            />
          </div>

          <div style={{ flex: "1 1 520px" }}>
            <div style={{ fontSize: 12, color: "#666" }}>Address</div>
            <input
              value={d.address ?? ""}
              onChange={(e) => setD((p) => ({ ...p, address: e.target.value || null }))}
              style={{ width: "100%" }}
              disabled={disabled}
            />
          </div>

          <div style={{ width: 220 }}>
            <div style={{ fontSize: 12, color: "#666" }}>TFN</div>
            <input
              value={d.tfn ?? ""}
              onChange={(e) => setD((p) => ({ ...p, tfn: e.target.value || null }))}
              style={{ width: "100%" }}
              disabled={disabled}
            />
          </div>

          <div style={{ width: 260 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Super (optional)</div>
            <input
              value={d.super_text ?? ""}
              onChange={(e) => setD((p) => ({ ...p, super_text: e.target.value || null }))}
              style={{ width: "100%" }}
              disabled={disabled}
            />
          </div>

          <div style={{ width: 260 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Emergency contact name</div>
            <input
              value={d.emergency_contact_name ?? ""}
              onChange={(e) => setD((p) => ({ ...p, emergency_contact_name: e.target.value || null }))}
              style={{ width: "100%" }}
              disabled={disabled}
            />
          </div>

          <div style={{ width: 220 }}>
            <div style={{ fontSize: 12, color: "#666" }}>Emergency contact phone</div>
            <input
              value={d.emergency_contact_phone ?? ""}
              onChange={(e) => setD((p) => ({ ...p, emergency_contact_phone: e.target.value || null }))}
              style={{ width: "100%" }}
              disabled={disabled}
            />
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <button onClick={save} disabled={loading || disabled} style={{ fontWeight: 800 }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}