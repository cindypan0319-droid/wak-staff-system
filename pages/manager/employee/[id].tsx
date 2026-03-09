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
  birth_date: string | null;
  manager_note: string | null;
};

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

function SectionCard({
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
        {desc ? <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>{desc}</div> : null}
      </div>
      {children}
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 6, fontWeight: 600 }}>
        {props.label}
      </div>
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: "12px 14px",
          borderRadius: 12,
          border: "1px solid #D1D5DB",
          fontSize: 15,
          background: "#fff",
          color: TEXT,
        }}
      />
    </div>
  );
}

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

      setProfile(p.data as ProfileRow);

      const d = await supabase
        .from("employee_details")
        .select("*")
        .eq("staff_id", id)
        .maybeSingle();

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

        const d2 = await supabase
          .from("employee_details")
          .select("*")
          .eq("staff_id", id)
          .maybeSingle();

        if (d2.error) {
          setMsg("❌ Cannot load details: " + d2.error.message);
          return;
        }

        setDetails(d2.data as DetailRow);
        return;
      }

      setDetails(d.data as DetailRow);
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

      if (id) {
        await load(id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setProfile((prev) => ({ ...(prev as ProfileRow), ...patch }));
  }

  function setDetailField(patch: Partial<DetailRow>) {
    setDetails((prev) => ({ ...(prev as DetailRow), ...patch }));
  }

  async function saveAll() {
    if (!profile || !details) return;

    setLoading(true);
    setMsg("");

    try {
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

      const up2 = await supabase
        .from("employee_details")
        .upsert(details, { onConflict: "staff_id" } as any);

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
    <div
      style={{
        background: WAK_BG,
        minHeight: "100vh",
        padding: 20,
      }}
    >
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
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
            <div>
              <h1 style={{ margin: 0, color: TEXT }}>Employee Details</h1>
              <div style={{ marginTop: 6, color: MUTED, fontSize: 14 }}>
                View and edit employee personal details and internal notes
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {actionButton("Save", saveAll, { primary: true, disabled: loading || !profile || !details })}
              {actionButton("Back", () => window.history.back(), { disabled: loading })}
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
            Staff ID: <b>{staffId || "-"}</b>
            {profile?.role ? (
              <>
                {" "}
                | Role: <b>{profile.role}</b>
              </>
            ) : null}
            {profile?.is_active != null ? (
              <>
                {" "}
                | Status: <b>{profile.is_active ? "ACTIVE" : "INACTIVE"}</b>
              </>
            ) : null}
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

          {loading && (
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
              Loading...
            </div>
          )}
        </div>

        {!profile || !details ? (
          <SectionCard title="No data">
            <div style={{ color: MUTED }}>No employee data found.</div>
          </SectionCard>
        ) : (
          <>
            <SectionCard
              title="Basic Information"
              desc="Core identity and basic personal information"
            >
              <div
                style={{
                  display: "grid",
                  gap: 14,
                  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                }}
              >
                <Field
                  label="Full name"
                  value={profile.full_name ?? ""}
                  onChange={(v) => setProfileField({ full_name: v })}
                  placeholder="Enter full name"
                />

                <Field
                  label="Preferred name"
                  value={profile.preferred_name ?? ""}
                  onChange={(v) => setProfileField({ preferred_name: v })}
                  placeholder="Name shown in login list"
                />

                <div>
                  <div style={{ fontSize: 13, color: MUTED, marginBottom: 6, fontWeight: 600 }}>
                    Birth date
                  </div>
                  <input
                    type="date"
                    value={details.birth_date ?? ""}
                    onChange={(e) =>
                      setDetailField({ birth_date: e.target.value || null })
                    }
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "12px 14px",
                      borderRadius: 12,
                      border: "1px solid #D1D5DB",
                      fontSize: 15,
                      background: "#fff",
                      color: TEXT,
                    }}
                  />
                </div>

                <div>
                  <div style={{ fontSize: 13, color: MUTED, marginBottom: 6, fontWeight: 600 }}>
                    Age
                  </div>
                  <input
                    value={ageText}
                    readOnly
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "12px 14px",
                      borderRadius: 12,
                      border: "1px solid #D1D5DB",
                      fontSize: 15,
                      background: "#F9FAFB",
                      color: TEXT,
                    }}
                  />
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Contact & Employment Details"
              desc="Phone, contact, address and employee record information"
            >
              <div
                style={{
                  display: "grid",
                  gap: 14,
                  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                }}
              >
                <Field
                  label="Phone"
                  value={details.phone ?? ""}
                  onChange={(v) => setDetailField({ phone: v })}
                  placeholder="Enter phone number"
                />

                <Field
                  label="Email"
                  value={details.email ?? ""}
                  onChange={(v) => setDetailField({ email: v })}
                  placeholder="Enter email"
                />

                <div style={{ gridColumn: "1 / -1" }}>
                  <Field
                    label="Address"
                    value={details.address ?? ""}
                    onChange={(v) => setDetailField({ address: v })}
                    placeholder="Enter home address"
                  />
                </div>

                <Field
                  label="TFN"
                  value={details.tfn ?? ""}
                  onChange={(v) => setDetailField({ tfn: v })}
                  placeholder="Enter TFN"
                />

                <Field
                  label="Super"
                  value={details.super ?? ""}
                  onChange={(v) => setDetailField({ super: v })}
                  placeholder="Fund / member number / note"
                />

                <Field
                  label="Emergency contact name"
                  value={details.emergency_contact_name ?? ""}
                  onChange={(v) =>
                    setDetailField({ emergency_contact_name: v })
                  }
                  placeholder="Enter contact name"
                />

                <Field
                  label="Emergency contact phone"
                  value={details.emergency_contact_phone ?? ""}
                  onChange={(v) =>
                    setDetailField({ emergency_contact_phone: v })
                  }
                  placeholder="Enter contact phone"
                />
              </div>
            </SectionCard>

            <SectionCard
              title="Manager Note"
              desc="Internal note for manager / owner use only"
            >
              <div>
                <div style={{ fontSize: 13, color: MUTED, marginBottom: 6, fontWeight: 600 }}>
                  Note
                </div>
                <textarea
                  value={details.manager_note ?? ""}
                  onChange={(e) =>
                    setDetailField({ manager_note: e.target.value })
                  }
                  rows={8}
                  placeholder="Write internal comments about this employee, such as performance, strengths, reminders, shift suitability, training needs, or other management notes."
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "12px 14px",
                    borderRadius: 12,
                    border: "1px solid #D1D5DB",
                    fontSize: 15,
                    background: "#fff",
                    color: TEXT,
                    resize: "vertical",
                    lineHeight: 1.5,
                  }}
                />
              </div>
            </SectionCard>

            <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
              {actionButton("Save", saveAll, { primary: true, disabled: loading })}
              {actionButton("Back", () => window.history.back(), { disabled: loading })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}