import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";

type ProfileRow = {
  id: string;
  full_name: string | null;
  preferred_name: string | null;
  role: "OWNER" | "MANAGER" | "STAFF";
  is_active: boolean;
};

type DetailRow = {
  staff_id: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  tfn: string | null;
  super: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  birth_date: string | null; // YYYY-MM-DD
};

export default function EmployeeDetailsPage() {
  const [staffId, setStaffId] = useState<string>("");

  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [details, setDetails] = useState<DetailRow | null>(null);

  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  async function guard() {
    const { data } = await supabase.auth.getUser();
    const uid = data.user?.id;
    if (!uid) {
      window.location.href = "/";
      return false;
    }
    const pr = await supabase.from("profiles").select("role").eq("id", uid).maybeSingle();
    const r = (pr.data as any)?.role;
    if (!(r === "OWNER" || r === "MANAGER")) {
      window.location.href = "/";
      return false;
    }
    return true;
  }

  async function load(id: string) {
    setLoading(true);
    setMsg("");
    try {
      // 1) load profile
      const p = await supabase
        .from("profiles")
        .select("id, full_name, preferred_name, role, is_active")
        .eq("id", id)
        .maybeSingle();

      if (p.error) {
        setMsg("❌ Cannot load profile: " + p.error.message);
        setProfile(null);
        return;
      }

      if (!p.data) {
        setMsg("❌ Profile not found.");
        setProfile(null);
        return;
      }

      setProfile(p.data as any);

      // 2) load employee_details
      const d = await supabase.from("employee_details").select("*").eq("staff_id", id).maybeSingle();

      if (d.error) {
        setMsg("❌ Cannot load details: " + d.error.message);
        setDetails(null);
        return;
      }

      if (!d.data) {
        const ins = await supabase.from("employee_details").insert([{ staff_id: id }]);
        if (ins.error) {
          setMsg("❌ Cannot init details: " + ins.error.message);
          return;
        }
        const d2 = await supabase.from("employee_details").select("*").eq("staff_id", id).maybeSingle();
        if (d2.error) return setMsg("❌ Cannot load details: " + d2.error.message);
        setDetails(d2.data as any);
        return;
      }

      setDetails(d.data as any);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      const ok = await guard();
      if (!ok) return;

      const parts = window.location.pathname.split("/");
      const id = parts[parts.length - 1] || "";
      setStaffId(id);
      if (id) await load(id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ✅ auto age from birth_date
  const ageText = useMemo(() => {
    const bd = details?.birth_date?.trim();
    if (!bd) return "";
    const dob = new Date(bd + "T00:00:00");
    if (Number.isNaN(dob.getTime())) return "";

    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();

    const m = today.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age -= 1;

    if (age < 0) return "";
    return String(age);
  }, [details?.birth_date]);

  function setProfileField(patch: Partial<ProfileRow>) {
    setProfile((prev) => ({ ...(prev as any), ...patch }));
  }

  function setDetailField(patch: Partial<DetailRow>) {
    setDetails((prev) => ({ ...(prev as any), ...patch }));
  }

  async function saveAll() {
    if (!profile || !details) return;

    setLoading(true);
    setMsg("");
    try {
      // 1) update profiles (name fields)
      const up1 = await supabase
        .from("profiles")
        .update({
          full_name: profile.full_name ?? "",
          preferred_name: profile.preferred_name ?? "",
        })
        .eq("id", profile.id);

      if (up1.error) {
        setMsg("❌ Save profile failed: " + up1.error.message);
        return;
      }

      // 2) upsert employee_details
      const up2 = await supabase.from("employee_details").upsert(details, { onConflict: "staff_id" } as any);
      if (up2.error) {
        setMsg("❌ Save details failed: " + up2.error.message);
        return;
      }

      setMsg("✅ Saved!");
      await load(staffId);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, maxWidth: 720 }}>
      <h1>Manager — Employee Details</h1>
      <p style={{ color: "#666" }}>Staff ID: {staffId}</p>

      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>{msg}</div>}
      {loading && <div style={{ marginBottom: 12 }}>Loading…</div>}

      {!profile || !details ? (
        <div>No data.</div>
      ) : (
        <div style={{ border: "1px solid #ddd", padding: 12 }}>
          <h2 style={{ marginTop: 0 }}>Basic</h2>

          <Field label="Full name" value={profile.full_name ?? ""} onChange={(v) => setProfileField({ full_name: v })} />
          <Field
            label="Preferred name (for login list)"
            value={profile.preferred_name ?? ""}
            onChange={(v) => setProfileField({ preferred_name: v })}
          />

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 260px" }}>
              <div style={{ fontSize: 12, color: "#666" }}>Birth date</div>
              <input
                type="date"
                value={details.birth_date ?? ""}
                onChange={(e) => setDetailField({ birth_date: e.target.value })}
                style={{ width: "100%" }}
              />
            </div>

            <div style={{ flex: "0 0 140px" }}>
              <div style={{ fontSize: 12, color: "#666" }}>Age (auto)</div>
              <input value={ageText} readOnly style={{ width: "100%" }} />
            </div>
          </div>

          <h2 style={{ marginTop: 18 }}>Details</h2>

          <Field label="Phone" value={details.phone ?? ""} onChange={(v) => setDetailField({ phone: v })} />
          <Field label="Email" value={details.email ?? ""} onChange={(v) => setDetailField({ email: v })} />
          <Field label="Address" value={details.address ?? ""} onChange={(v) => setDetailField({ address: v })} />
          <Field label="TFN" value={details.tfn ?? ""} onChange={(v) => setDetailField({ tfn: v })} />
          <Field label="Super (optional)" value={details.super ?? ""} onChange={(v) => setDetailField({ super: v })} />

          <Field
            label="Emergency contact name"
            value={details.emergency_contact_name ?? ""}
            onChange={(v) => setDetailField({ emergency_contact_name: v })}
          />
          <Field
            label="Emergency contact phone"
            value={details.emergency_contact_phone ?? ""}
            onChange={(v) => setDetailField({ emergency_contact_phone: v })}
          />

          <button onClick={saveAll} disabled={loading} style={{ fontWeight: 800 }}>
            Save
          </button>
          <button onClick={() => window.history.back()} disabled={loading} style={{ marginLeft: 8 }}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}

function Field(props: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{props.label}</div>
      <input value={props.value} onChange={(e) => props.onChange(e.target.value)} style={{ width: "100%" }} />
    </div>
  );
}