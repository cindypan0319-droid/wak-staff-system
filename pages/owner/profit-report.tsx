import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

const EST_COGS_RATE = 0.35;
type Granularity = "day" | "week" | "month";

function formatDate(date: Date) {
  return date.toISOString().split("T")[0];
}

function daysBetween(a: string, b: string) {
  const d1 = new Date(a + "T00:00:00");
  const d2 = new Date(b + "T00:00:00");
  return Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

function pickDefaultGranularity(start: string, end: string): Granularity {
  const span = daysBetween(start, end);
  if (span <= 14) return "day";
  if (span <= 120) return "week";
  return "month";
}

function periodKey(dateStr: string, g: Granularity) {
  const d = new Date(dateStr + "T00:00:00");
  if (g === "day") return dateStr;

  if (g === "week") {
    const day = d.getDay(); // 0 Sun..6 Sat
    const diff = (day + 6) % 7; // Monday=0
    d.setDate(d.getDate() - diff);
    return formatDate(d);
  }

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

const label: React.CSSProperties = { fontSize: 12, color: "#64748b", marginBottom: 4 };

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

export default function OwnerProfitReportPage() {
  const router = useRouter();

  const today = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(today.getDate() - 29);

  const qStart = typeof router.query.start === "string" ? router.query.start : null;
  const qEnd = typeof router.query.end === "string" ? router.query.end : null;

  const [startDate, setStartDate] = useState(formatDate(thirtyDaysAgo));
  const [endDate, setEndDate] = useState(formatDate(today));
  const [granularity, setGranularity] = useState<Granularity>("day");

  const [dailyRows, setDailyRows] = useState<any[]>([]);
  const [invoiceSeries, setInvoiceSeries] = useState<Record<string, number>>({});

  const [loading, setLoading] = useState(true);
  const [checkingAuth, setCheckingAuth] = useState(true);

  // read query params once router is ready
  useEffect(() => {
    if (!router.isReady) return;

    const s = qStart || startDate;
    const e = qEnd || endDate;

    setStartDate(s);
    setEndDate(e);
    setGranularity(pickDefaultGranularity(s, e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady]);

  async function fetchAll() {
    setLoading(true);

    const { data: revenue, error: revenueErr } = await supabase
      .from("v_owner_daily_breakdown")
      .select("*")
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: true });

    if (revenueErr) console.error("profit revenue error:", revenueErr);
    setDailyRows(revenue || []);

    const { data: invRows, error: invErr } = await supabase.rpc("owner_invoice_series", {
      start_date: startDate,
      end_date: endDate,
      granularity,
    });

    if (invErr) console.error("profit invoice series error:", invErr);

    const map: Record<string, number> = {};
    (invRows || []).forEach((r: any) => {
      map[String(r.period_start)] = Number(r.total || 0);
    });
    setInvoiceSeries(map);

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

      if (profile?.role !== "OWNER") {
        alert("Access denied");
        router.push("/");
        return;
      }

      setCheckingAuth(false);
    }

    checkOwner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // whenever date range or granularity changes, refetch
  useEffect(() => {
    if (checkingAuth) return;
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkingAuth, startDate, endDate, granularity]);

  const grouped = useMemo(() => {
    const g = granularity;
    const map: Record<string, any> = {};

    for (const r of dailyRows) {
      const k = periodKey(String(r.date), g);
      if (!map[k]) map[k] = { period_start: k, revenue: 0 };
      map[k].revenue += Number(r.total_revenue || 0);
    }

    const arr = Object.values(map).sort((a: any, b: any) =>
      String(a.period_start).localeCompare(String(b.period_start))
    );

    return arr.map((row: any) => {
      const k = String(row.period_start);
      const revenue = Number(row.revenue || 0);
      const actualCost = Number(invoiceSeries[k] || 0);
      const estCost = revenue * EST_COGS_RATE;

      const actProfit = revenue - actualCost;
      const estProfit = revenue - estCost;

      return {
        period_start: k,
        revenue,
        actualCost,
        estCost,
        actProfit,
        estProfit,
        actMargin: revenue > 0 ? (actProfit / revenue) * 100 : 0,
        estMargin: revenue > 0 ? (estProfit / revenue) * 100 : 0,
      };
    });
  }, [dailyRows, invoiceSeries, granularity]);

  if (checkingAuth) return <div style={{ padding: 30 }}>Checking...</div>;

  return (
    <div style={{ padding: 30 }}>
      <h1>Profit Report</h1>

      <div style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={label}>Start</div>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>

        <div>
          <div style={label}>End</div>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>

        <div>
          <div style={label}>View by</div>
          <select value={granularity} onChange={(e) => setGranularity(e.target.value as Granularity)}>
            <option value="day">Day</option>
            <option value="week">Week (Mon)</option>
            <option value="month">Month</option>
          </select>
        </div>

        <div style={{ alignSelf: "end" }}>
          <button onClick={fetchAll}>Refresh</button>
          <button onClick={() => router.push("/owner/dashboard")} style={{ marginLeft: 10 }}>
            ← Back
          </button>
        </div>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#f8fafc" }}>
                <th style={th}>Period</th>
                <th style={th}>Revenue</th>
                <th style={th}>Actual Invoice Cost</th>
                <th style={th}>Est COGS (35%)</th>
                <th style={th}>Actual Profit</th>
                <th style={th}>Est Profit</th>
                <th style={th}>Actual Margin</th>
                <th style={th}>Est Margin</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((r: any) => (
                <tr key={r.period_start}>
                  <td style={td}>{r.period_start}</td>
                  <td style={td}>${r.revenue.toFixed(2)}</td>
                  <td style={td}>${r.actualCost.toFixed(2)}</td>
                  <td style={td}>${r.estCost.toFixed(2)}</td>
                  <td style={td}>${r.actProfit.toFixed(2)}</td>
                  <td style={td}>${r.estProfit.toFixed(2)}</td>
                  <td style={td}>{r.actMargin.toFixed(2)}%</td>
                  <td style={td}>{r.estMargin.toFixed(2)}%</td>
                </tr>
              ))}
              {grouped.length === 0 ? (
                <tr>
                  <td style={td} colSpan={8}>
                    No data in this range.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}