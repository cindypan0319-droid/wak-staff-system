import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

type Role = "OWNER" | "MANAGER" | "STAFF" | "ANON" | "INACTIVE" | string;

export default function PlatformIncomePage() {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("ANON");
  const [msg, setMsg] = useState("");

  const [businessDate, setBusinessDate] = useState<string>(() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });

  const [storeId, setStoreId] = useState("MOOROOLBARK");
  const [platform, setPlatform] = useState("UBER_EATS");
  const [grossIncome, setGrossIncome] = useState("");
  const [fees, setFees] = useState("");

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      setUserEmail(session?.user?.email ?? null);
      setMsg("");
    });

    supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user?.email ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function loadRole() {
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData.session?.user?.id;
      if (!uid) {
        setRole("ANON");
        return;
      }

      const { data, error } = await supabase
        .from("profiles")
        .select("role, is_active")
        .eq("id", uid)
        .maybeSingle();

      if (error) {
        console.log(error);
        setRole("ANON");
        return;
      }
      if (!data?.is_active) {
        setRole("INACTIVE");
        return;
      }
      setRole((data?.role as Role) ?? "ANON");
    }

    loadRole();
  }, [userEmail]);

  async function submit() {
    setMsg("");

    const { data: sessionData } = await supabase.auth.getSession();
    const uid = sessionData.session?.user?.id;
    if (!uid) {
      setMsg("❌ Not logged in.");
      return;
    }

    const g = grossIncome.trim() === "" ? null : Number(grossIncome);
    const f = fees.trim() === "" ? null : Number(fees);

    const { error } = await supabase.from("platform_income").insert(
      [
        {
          business_date: businessDate,
          store_id: storeId,
          platform,
          gross_income: g,
          fees: f,
          entered_by: uid,
        },
      ],
      { returning: "minimal" } as any
    );

    if (error) {
      setMsg("❌ Insert failed: " + error.message);
      return;
    }

    setMsg("✅ Platform income submitted!");
    setGrossIncome("");
    setFees("");
  }

  if (!userEmail) {
    return (
      <div style={{ padding: 20 }}>
        <h1>Platform Income</h1>
        <p>Please login first (go back to /).</p>
      </div>
    );
  }

  if (role === "INACTIVE") {
    return (
      <div style={{ padding: 20 }}>
        <h1>Platform Income</h1>
        <p>❌ Your account is inactive. Please contact manager.</p>
        <button onClick={() => (window.location.href = "/")}>Back</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Platform Income (Insert Only)</h1>
      <div>
        Logged in as: <b>{userEmail}</b> | Role: <b>{role}</b>
      </div>

      <button onClick={() => (window.location.href = "/")} style={{ marginTop: 8 }}>
        Back to Home
      </button>

      <hr style={{ margin: "16px 0" }} />

      <div style={{ maxWidth: 520 }}>
        <div style={{ marginBottom: 6 }}>
          <label style={{ display: "inline-block", width: 140 }}>Business Date</label>
          <input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
        </div>

        <div style={{ marginBottom: 6 }}>
          <label style={{ display: "inline-block", width: 140 }}>Store ID</label>
          <input value={storeId} onChange={(e) => setStoreId(e.target.value)} />
        </div>

        <div style={{ marginBottom: 6 }}>
          <label style={{ display: "inline-block", width: 140 }}>Platform</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
            <option value="UBER_EATS">UBER_EATS</option>
            <option value="DOORDASH">DOORDASH</option>
            <option value="DELIVEROO">DELIVEROO</option>
            <option value="MENULOG">MENULOG</option>
            <option value="WAK">WAK</option>
            <option value="OTHER">OTHER</option>
          </select>
        </div>

        <div style={{ marginBottom: 6 }}>
          <label style={{ display: "inline-block", width: 140 }}>Gross Income</label>
          <input value={grossIncome} onChange={(e) => setGrossIncome(e.target.value)} />
        </div>

        <div style={{ marginBottom: 6 }}>
          <label style={{ display: "inline-block", width: 140 }}>Fees</label>
          <input value={fees} onChange={(e) => setFees(e.target.value)} />
        </div>

        <button onClick={submit} style={{ width: 480, marginTop: 8 }}>
          Submit
        </button>

        {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
      </div>
    </div>
  );
}