import { useState } from "react";
import { supabase } from "../../../lib/supabaseClient";

export default function EmployeeCreatePage() {
  const [fullName, setFullName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [tfn, setTfn] = useState("");
  const [superText, setSuperText] = useState("");
  const [emergencyContactName, setEmergencyContactName] = useState("");
  const [emergencyContactPhone, setEmergencyContactPhone] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    setMsg("");
    try {
      const res = await supabase.from("employees").insert([
        {
          full_name: fullName,
          birth_date: birthDate,
          phone: phone,
          email: email,
          address: address,
          tfn: tfn,
          super: superText,
          emergency_contact_name: emergencyContactName,
          emergency_contact_phone: emergencyContactPhone,
        },
      ]);
      if (res.error) throw new Error(res.error.message);
      setMsg("✅ Employee added.");
      setFullName("");
      setBirthDate("");
      setPhone("");
      setEmail("");
      setAddress("");
      setTfn("");
      setSuperText("");
      setEmergencyContactName("");
      setEmergencyContactPhone("");
    } catch (error: any) {
      setMsg("❌ Error adding employee: " + error.message);
    }
    setLoading(false);
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Add New Employee</h1>
      {msg && <p>{msg}</p>}
      <div>
        <div>
          <label>Full Name</label>
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            type="text"
            placeholder="Enter full name"
          />
        </div>
        <div>
          <label>Birth Date</label>
          <input
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            type="date"
            placeholder="Enter birth date"
          />
        </div>
        <div>
          <label>Phone</label>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            type="text"
            placeholder="Enter phone number"
          />
        </div>
        <div>
          <label>Email</label>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="Enter email"
          />
        </div>
        <div>
          <label>Address</label>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            type="text"
            placeholder="Enter address"
          />
        </div>
        <div>
          <label>TFN</label>
          <input
            value={tfn}
            onChange={(e) => setTfn(e.target.value)}
            type="text"
            placeholder="Enter TFN"
          />
        </div>
        <div>
          <label>Super (Optional)</label>
          <input
            value={superText}
            onChange={(e) => setSuperText(e.target.value)}
            type="text"
            placeholder="Enter Super info"
          />
        </div>
        <div>
          <label>Emergency Contact Name</label>
          <input
            value={emergencyContactName}
            onChange={(e) => setEmergencyContactName(e.target.value)}
            type="text"
            placeholder="Enter emergency contact name"
          />
        </div>
        <div>
          <label>Emergency Contact Phone</label>
          <input
            value={emergencyContactPhone}
            onChange={(e) => setEmergencyContactPhone(e.target.value)}
            type="text"
            placeholder="Enter emergency contact phone"
          />
        </div>
        <button onClick={handleSubmit} disabled={loading}>
          {loading ? "Saving..." : "Save Employee"}
        </button>
      </div>
    </div>
  );
}