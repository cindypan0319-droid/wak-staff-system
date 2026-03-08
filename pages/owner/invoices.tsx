import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

function formatDate(date: Date) {
  return date.toISOString().split("T")[0];
}

async function downloadExcel(type: string, start: string, end: string) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) {
    alert("Not logged in");
    return;
  }

  const resp = await fetch(
    `/api/owner/export.xlsx?type=${encodeURIComponent(type)}&start=${encodeURIComponent(
      start
    )}&end=${encodeURIComponent(end)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!resp.ok) {
    const txt = await resp.text();
    alert(`Export failed: ${txt}`);
    return;
  }

  const blob = await resp.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${type}-${start}-${end}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
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
        padding: "12px 16px",
        minHeight: 44,
        borderRadius: 12,
        border: `1px solid ${borderColor}`,
        background: bg,
        color: textColor,
        fontWeight: 800,
        fontSize: 14,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: primary || danger ? "0 8px 18px rgba(0,0,0,0.10)" : "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function inputStyle(width?: number | string) {
  return {
    width: width ?? "100%",
    maxWidth: "100%",
    boxSizing: "border-box" as const,
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #D1D5DB",
    fontSize: 14,
    background: "#fff",
    color: TEXT,
  };
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 12,
        background: "#F9FAFB",
        border: `1px solid ${BORDER}`,
        minWidth: 180,
      }}
    >
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontWeight: 800, fontSize: 18, color: TEXT, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export default function OwnerInvoicesPage() {
  const router = useRouter();

  const today = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(today.getDate() - 29);

  const [startDate, setStartDate] = useState(formatDate(thirtyDaysAgo));
  const [endDate, setEndDate] = useState(formatDate(today));
  const [rows, setRows] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);

  const [loading, setLoading] = useState(true);
  const [checkingAuth, setCheckingAuth] = useState(true);

  const qStart = typeof router.query.start === "string" ? router.query.start : null;
  const qEnd = typeof router.query.end === "string" ? router.query.end : null;

  async function fetchAll(s = startDate, e = endDate) {
    setLoading(true);

    const { data: list, error: listErr } = await supabase.rpc("owner_invoices_list", {
      start_date: s,
      end_date: e,
      row_limit: 500,
    });

    if (listErr) {
      console.error("owner_invoices_list error:", listErr);
      alert(`Invoices query failed: ${listErr.message}`);
      setRows([]);
      setLoading(false);
      return;
    }
    setRows(list || []);

    const { data: st, error: stErr } = await supabase.rpc("owner_invoices_stats", {
      start_date: s,
      end_date: e,
    });

    if (stErr) {
      console.error("owner_invoices_stats error:", stErr);
      setStats(null);
    } else {
      setStats(st?.[0] || null);
    }

    setLoading(false);
  }

  useEffect(() => {
    async function checkOwner() {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData?.user) {
        router.push("/admin-login");
        return;
      }

      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userData.user.id)
        .single();

      if (String(profile?.role).toUpperCase() !== "OWNER") {
        alert("Access denied");
        router.push("/");
        return;
      }

      setCheckingAuth(false);
    }
    checkOwner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!router.isReady) return;
    const s = qStart || startDate;
    const e = qEnd || endDate;
    setStartDate(s);
    setEndDate(e);
    fetchAll(s, e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  if (checkingAuth) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ margin: 0, color: TEXT }}>Invoices</h1>
            <div style={{ marginTop: 10, color: MUTED }}>Checking...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ marginBottom: 12 }}>
          {actionButton("← Back to Dashboard", () => router.push("/owner/dashboard"))}
        </div>

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
          <h1 style={{ margin: 0, color: TEXT }}>Invoices</h1>
        </div>

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
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "end",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Start</div>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                style={inputStyle(170)}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>End</div>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                style={inputStyle(170)}
              />
            </div>

            {actionButton("Apply", () => fetchAll(startDate, endDate), { primary: true })}
            {actionButton("Export Excel", () => downloadExcel("invoices", startDate, endDate))}
            {actionButton("Back", () => router.push("/owner/dashboard"))}
          </div>
        </div>

        {stats ? (
          <div
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              marginBottom: 16,
            }}
          >
            <StatCard label="Invoices" value={String(stats.invoice_count ?? 0)} />
            <StatCard label="Total Amount" value={`$${Number(stats.total_amount || 0).toFixed(2)}`} />
            <StatCard label="Total Tax" value={`$${Number(stats.total_tax || 0).toFixed(2)}`} />
            <StatCard
              label="Top Supplier"
              value={`${stats.top_supplier || "-"} ($${Number(stats.top_supplier_amount || 0).toFixed(2)})`}
            />
            <StatCard
              label="Top Category"
              value={`${stats.top_category || "-"} ($${Number(stats.top_category_amount || 0).toFixed(2)})`}
            />
          </div>
        ) : (
          <div
            style={{
              border: `1px solid ${BORDER}`,
              background: "#fff",
              padding: "12px 14px",
              borderRadius: 12,
              marginBottom: 16,
              color: MUTED,
            }}
          >
            Stats unavailable (no data or error).
          </div>
        )}

        <div
          style={{
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: CARD_BG,
            padding: 18,
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          {loading ? (
            <div style={{ color: MUTED }}>Loading...</div>
          ) : (
            <>
              <div style={{ overflowX: "auto", border: `1px solid ${BORDER}`, borderRadius: 12 }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "separate",
                    borderSpacing: 0,
                    minWidth: 900,
                  }}
                >
                  <thead>
                    <tr style={{ background: "#FAFAFA" }}>
                      <th style={th}>Date</th>
                      <th style={th}>Supplier</th>
                      <th style={th}>Invoice #</th>
                      <th style={th}>Category</th>
                      <th style={th}>Amount</th>
                      <th style={th}>Tax</th>
                      <th style={th}>Action</th>
                    </tr>
                  </thead>

                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td style={td}>{r.invoice_date}</td>
                        <td style={{ ...td, fontWeight: 700 }}>{r.supplier_name || ""}</td>
                        <td style={td}>{r.invoice_number || ""}</td>
                        <td style={td}>{r.category || ""}</td>
                        <td style={td}>${Number(r.amount || 0).toFixed(2)}</td>
                        <td style={td}>${Number(r.tax || 0).toFixed(2)}</td>
                        <td style={td}>
                          {actionButton("Edit", () =>
                            router.push(
                              `/owner/invoices/${r.id}?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`
                            )
                          )}
                        </td>
                      </tr>
                    ))}

                    {rows.length === 0 ? (
                      <tr>
                        <td style={td} colSpan={7}>
                          No invoices in this range.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 12, fontSize: 12, color: MUTED }}>
                Showing up to 500 rows in the table. Stats uses full DB aggregate.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "12px 12px",
  borderBottom: `1px solid ${BORDER}`,
  fontSize: 13,
  color: MUTED,
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "12px 12px",
  borderBottom: `1px solid ${BORDER}`,
  fontSize: 13,
  color: TEXT,
};