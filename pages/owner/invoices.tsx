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

  const resp = await fetch(`/api/owner/export.xlsx?type=${encodeURIComponent(type)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

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

    // 1) list rows
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

    // 2) stats bar
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

  if (checkingAuth) return <div style={{ padding: 30 }}>Checking...</div>;

  return (
    <div style={{ padding: 30 }}>
      <h1>Invoices</h1>

      <div style={{ marginBottom: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={label}>Start</div>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>

        <div>
          <div style={label}>End</div>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>

        <button onClick={() => fetchAll(startDate, endDate)} style={{ height: 32, marginTop: 18 }}>
          Apply
        </button>

        <button
          onClick={() => downloadExcel("invoices", startDate, endDate)}
          style={{ height: 32, marginTop: 18 }}
        >
          Export Excel
        </button>

        <button onClick={() => router.push("/owner/dashboard")} style={{ height: 32, marginTop: 18 }}>
          ← Back
        </button>
      </div>

      {/* Stats Bar */}
      {stats ? (
        <div style={statsBox}>
          <div><b>Invoices:</b> {stats.invoice_count}</div>
          <div><b>Total Amount:</b> ${Number(stats.total_amount || 0).toFixed(2)}</div>
          <div><b>Total Tax:</b> ${Number(stats.total_tax || 0).toFixed(2)}</div>
          <div>
            <b>Top Supplier:</b> {stats.top_supplier || "-"} (${Number(stats.top_supplier_amount || 0).toFixed(2)})
          </div>
          <div>
            <b>Top Category:</b> {stats.top_category || "-"} (${Number(stats.top_category_amount || 0).toFixed(2)})
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "#666", marginBottom: 10 }}>
          Stats unavailable (no data or error).
        </div>
      )}

      {loading ? (
        <p>Loading...</p>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
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
                  <td style={td}>{r.supplier_name || ""}</td>
                  <td style={td}>{r.invoice_number || ""}</td>
                  <td style={td}>{r.category || ""}</td>
                  <td style={td}>${Number(r.amount || 0).toFixed(2)}</td>
                  <td style={td}>${Number(r.tax || 0).toFixed(2)}</td>
                  <td style={td}>
                    <button
                      onClick={() =>
                        router.push(
                          `/owner/invoices/${r.id}?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}`
                        )
                      }
                    >
                      Edit
                    </button>
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
      )}

      <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
        Showing up to 500 rows (table). Stats uses full DB aggregate.
      </div>
    </div>
  );
}

const label: React.CSSProperties = { fontSize: 12, color: "#64748b", marginBottom: 4 };

const statsBox: React.CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  padding: 12,
  marginBottom: 12,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 8,
  background: "#fff",
};

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "10px 12px",
  borderBottom: "1px solid #eee",
  fontSize: 13,
  color: "#334155",
};

const td: React.CSSProperties = {
  padding: "10px 12px",
  borderBottom: "1px solid #f1f5f9",
  fontSize: 13,
};