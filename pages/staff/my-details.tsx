import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

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

function show(v: any) {
  const s = String(v ?? "").trim();
  return s ? s : "—";
}

export default function MyDetailsPage() {
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [detail, setDetail] = useState<DetailRow | null>(null);
  const [myName, setMyName] = useState<string>("");

  const age = useMemo(() => calcAge(detail?.birth_date ?? null), [detail?.birth_date]);

  async function load() {
    setLoading(true);
    setMsg("");
    try {
      const { data } = await supabase.auth.getUser();
      const uid = data.user?.id;
      if (!uid) {
        window.location.href = "/";
        return;
      }

      const p = await supabase.from("profiles").select("full_name").eq("id", uid).maybeSingle();
      setMyName((p.data as any)?.full_name ?? "");

      const d = await supabase
        .from("employee_details")
        .select(
          "staff_id, birth_date, phone, email, address, tfn, super, emergency_contact_name, emergency_contact_phone"
        )
        .eq("staff_id", uid)
        .maybeSingle();

      if (d.error && d.error.code !== "PGRST116") throw new Error(d.error.message);

      if (!d.data) {
        setDetail(null);
        setMsg("No details yet. Ask Manager/Owner to fill your details.");
      } else {
        setDetail(d.data as any);
      }
    } catch (e: any) {
      setMsg("❌ Load failed: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div style={{ padding: 20, maxWidth: 800 }}>
      <h1>My Details (Read-only)</h1>
      <button onClick={load} disabled={loading}>
        Refresh
      </button>
      {loading && <span style={{ marginLeft: 10 }}>Loading…</span>}

      {msg && <div style={{ border: "1px solid #ddd", padding: 10, marginTop: 12 }}>{msg}</div>}

      <div style={{ border: "1px solid #ddd", padding: 12, marginTop: 12 }}>
        <div>
          <b>Name:</b> {show(myName)}
        </div>
        <div style={{ marginTop: 8 }}>
          <b>Birth date:</b> {show(detail?.birth_date)} &nbsp; | &nbsp; <b>Age:</b> {show(age)}
        </div>
        <div style={{ marginTop: 8 }}>
          <b>Phone:</b> {show(detail?.phone)}
        </div>
        <div style={{ marginTop: 8 }}>
          <b>Email:</b> {show(detail?.email)}
        </div>
        <div style={{ marginTop: 8 }}>
          <b>Address:</b> {show(detail?.address)}
        </div>

        <hr />

        <div>
          <b>TFN:</b> {show(detail?.tfn)}
        </div>
        <div style={{ marginTop: 8 }}>
          <b>Super:</b> {show(detail?.super)}
        </div>

        <hr />

        <div>
          <b>Emergency contact:</b> {show(detail?.emergency_contact_name)}
        </div>
        <div style={{ marginTop: 8 }}>
          <b>Emergency phone:</b> {show(detail?.emergency_contact_phone)}
        </div>
      </div>
    </div>
  );
}