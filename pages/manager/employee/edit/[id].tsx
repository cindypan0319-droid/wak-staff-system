import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../../../lib/supabaseClient";

type ProfileRow = {
  id: string;
  full_name: string | null;
  role: "OWNER" | "MANAGER" | "STAFF";
  is_active: boolean;
};

type DetailRow = {
  staff_id: string;
  birth_date: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  tfn: string | null;
  super: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
};

function calcAge(birthDate: string | null) {
  if (!birthDate) return "";
  const d = new Date(birthDate);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 ? String(age) : "";
}

function safeStr(v: any) {
  const s = String(v ?? "");
  return s === "null" || s === "undefined" ? "" : s;
}

export default function EmployeeEditPage() {
  const router = useRouter();
  const staffId = String(router.query.id ?? "");

  const [meRole, setMeRole] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const [profile, setProfile] = useState<ProfileRow | null>(null);

  const [birthDate, setBirthDate] = useState<string>("");
  const [phone, setPhone] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [address, setAddress] = useState<string>("");
  const [tfn, setTfn] = useState<string>("");
  const [superText, setSuperText] = useState<string>("");
  const [emgName, setEmgName] = useState<string>("");
  const [emgPhone, setEmgPhone] = useState<string>("");

  const age = useMemo(() => calcAge(birthDate || null), [birthDate]);

  async function guardRole() {
    const { data } = await supabase.auth.getUser();
    const uid = data.user?.id;
    if (!uid) {
      window.location.href = "/";
      return;
    }
    const p = await supabase.from("profiles").select("role").eq("id", uid).maybeSingle();
    const role = (p.data as any)?.role ?? null;
    setMeRole(role);

    if (!(role === "OWNER" || role === "MANAGER")) {
      window.location.href = "/";
      return;
    }
  }

  async function load() {
    if (!staffId) return;

    setLoading(true);
    setMsg("");
    try {
      const p = await supabase
        .from("profiles")
        .select("id, full_name, role, is_active")
        .eq("id", staffId)
        .maybeSingle();

      if (p.error) throw new Error(p.error.message);
      if (!p.data) {
        setMsg("❌ Staff not found in profiles.");
        setProfile(null);
        return;
      }
      setProfile(p.data as any);

      const d = await supabase
        .from("employee_details")
        .select(
          "staff_id, birth_date, phone, email, address, tfn, super, emergency_contact_name, emergency_contact_phone"
        )
        .eq("staff_id", staffId)
        .maybeSingle();

      if (d.error && d.error.code !== "PGRST116") throw new Error(d.error.message);

      const row = (d.data ?? null) as any as DetailRow | null;

      setBirthDate(safeStr(row?.birth_date ?? ""));
      setPhone(safeStr(row?.phone ?? ""));
      setEmail(safeStr(row?.email ?? ""));
      setAddress(safeStr(row?.address ?? ""));
      setTfn(safeStr(row?.tfn ?? ""));
      setSuperText(safeStr(row?.super ?? ""));
      setEmgName(safeStr(row?.emergency_contact_name ?? ""));
      setEmgPhone(safeStr(row?.emergency_contact_phone ?? ""));
    } catch (e: any) {
      setMsg("❌ Load failed: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!staffId) return;

    setLoading(true);
    setMsg("");
    try {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id ?? null;

      const payload: any = {
        staff_id: staffId,
        birth_date: birthDate ? birthDate : null,
        phone: phone.trim() ? phone.trim() : null,
        email: email.trim() ? email.trim() : null,
        address: address.trim() ? address.trim() : null,
        tfn: tfn.trim() ? tfn.trim() : null,
        super: superText.trim() ? superText.trim() : null,
        emergency_contact_name: emgName.trim() ? emgName.trim() : null,
        emergency_contact_phone: emgPhone.trim() ? emgPhone.trim() : null,
        updated_by: uid,
      };

      const res = await supabase.from("employee_details").upsert(payload, {
        onConflict: "staff_id",
      } as any);

      if (res.error) throw new Error(res.error.message);

      setMsg("✅ Saved!");
      await load();
    } catch (e: any) {
      setMsg("❌ Save failed: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function removeDetails() {
    if (!staffId) return;
    if (!window.confirm("Delete employee details? (This will NOT delete login account)")) return;

    setLoading(true);
    setMsg("");
    try {
      const res = await supabase.from("employee_details").delete().eq("staff_id", staffId);
      if (res.error) throw new Error(res.error.message);
      setMsg("✅ Deleted details (profile still exists).");
      await load();
    } catch (e: any) {
      setMsg("❌ Delete failed: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      await guardRole();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!router.isReady) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, staffId]);

  if (meRole !== "OWNER" && meRole !== "MANAGER") {
    return <div style={{ padding: 20 }}>Checking access…</div>;
  }

  return (
    <div style={{ padding: 20, maxWidth: 900 }}>
      <h1>Employee Details</h1>

      <div style={{ marginBottom: 10 }}>
        <button onClick={() => router.push("/manager/employees")} disabled={loading}>
          ← Back
        </button>{" "}
        <button onClick={load} disabled={loading} style={{ marginLeft: 8 }}>
          Refresh
        </button>{" "}
        <button onClick={save} disabled={loading} style={{ marginLeft: 8, fontWeight: 800 }}>
          Save
        </button>{" "}
        <button onClick={removeDetails} disabled={loading} style={{ marginLeft: 8 }}>
          Delete details
        </button>
        {loading && <span style={{ marginLeft: 10 }}>Loading…</span>}
      </div>

      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginBottom: 12 }}>{msg}</div>}

      {profile ? (
        <div style={{ border: "1px solid #ddd", padding: 12, marginBottom: 12 }}>
          <div>
            <b>Name:</b> {(profile.full_name ?? "").trim() ? profile.full_name : profile.id.slice(0, 8)}
          </div>
          <div>
            <b>Role:</b> {profile.role} &nbsp; | &nbsp; <b>Active:</b> {profile.is_active ? "YES" : "NO"}
          </div>
          <div style={{ color: "#666", fontSize: 12 }}>
            Staff cannot edit their own details. Only Owner/Manager can edit.
          </div>
        </div>
      ) : (
        <div style={{ color: "#999" }}>No profile loaded.</div>
      )}

      <div style={{ border: "1px solid #ddd", padding: 12 }}>
        <h2 style={{ marginTop: 0 }}>Personal</h2>

        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 10, alignItems: "center" }}>
          <div>Birth date</div>
          <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />

          <div>Age (auto)</div>
          <input value={age} readOnly />

          <div>Phone</div>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="" />

          <div>Email</div>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="" />

          <div>Address</div>
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="" />
        </div>

        <h2>Payroll</h2>
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 10, alignItems: "center" }}>
          <div>TFN</div>
          <input value={tfn} onChange={(e) => setTfn(e.target.value)} placeholder="" />

          <div>Super (optional)</div>
          <input value={superText} onChange={(e) => setSuperText(e.target.value)} placeholder="" />
        </div>

        <h2>Emergency</h2>
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 10, alignItems: "center" }}>
          <div>Emergency contact name</div>
          <input value={emgName} onChange={(e) => setEmgName(e.target.value)} placeholder="" />

          <div>Emergency contact phone</div>
          <input value={emgPhone} onChange={(e) => setEmgPhone(e.target.value)} placeholder="" />
        </div>
      </div>
    </div>
  );
}