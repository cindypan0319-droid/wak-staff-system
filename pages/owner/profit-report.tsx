import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

const EST_COGS_RATE = 0.35;
type Granularity = "day" | "week" | "month";

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

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
    const day = d.getDay();
    const diff = (day + 6) % 7;
    d.setDate(d.getDate() - diff);
    return formatDate(d);
  }

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

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
        padding: "12px 14px",
        borderRadius: 14,
        background: "#F9FAFB",
        border: `1px solid ${BORDER}`,
        minWidth: 180,
        flex: "1 1 180px",
      }}
    >
      <div style={{ fontSize: 12, color: MUTED }}>{label}</div>
      <div style={{ fontWeight: 800, fontSize: 18, color: TEXT, marginTop: 6 }}>{value}</div>
    </div>
  );
}

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

  const totals = useMemo(() => {
    const revenue = grouped.reduce((s: number, r: any) => s + Number(r.revenue || 0), 0);
    const actualCost = grouped.reduce((s: number, r: any) => s + Number(r.actualCost || 0), 0);
    const estCost = grouped.reduce((s: number, r: any) => s + Number(r.estCost || 0), 0);
    const actProfit = grouped.reduce((s: number, r: any) => s + Number(r.actProfit || 0), 0);
    const estProfit = grouped.reduce((s: number, r: any) => s + Number(r.estProfit || 0), 0);

    return {
      revenue,
      actualCost,
      estCost,
      actProfit,
      estProfit,
      actMargin: revenue > 0 ? (actProfit / revenue) * 100 : 0,
      estMargin: revenue > 0 ? (estProfit / revenue) * 100 : 0,
    };
  }, [grouped]);

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
            <h1 style={{ margin: 0, color: TEXT }}>Profit Report</h1>
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
          <h1 style={{ margin: 0, color: TEXT }}>Profit Report</h1>
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
              flexWrap: "wrap",
              gap: 12,
              alignItems: "end",
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

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>View by</div>
              <select
                value={granularity}
                onChange={(e) => setGranularity(e.target.value as Granularity)}
                style={inputStyle(150)}
              >
                <option value="day">Day</option>
                <option value="week">Week (Mon)</option>
                <option value="month">Month</option>
              </select>
            </div>

            {actionButton("Refresh", fetchAll, { primary: true })}
            {actionButton("Back", () => router.push("/owner/dashboard"))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            marginBottom: 16,
          }}
        >
          <StatCard label="Revenue" value={`$${totals.revenue.toFixed(2)}`} />
          <StatCard label="Actual Invoice Cost" value={`$${totals.actualCost.toFixed(2)}`} />
          <StatCard label="Est COGS (35%)" value={`$${totals.estCost.toFixed(2)}`} />
          <StatCard label="Actual Profit" value={`$${totals.actProfit.toFixed(2)}`} />
          <StatCard label="Est Profit" value={`$${totals.estProfit.toFixed(2)}`} />
          <StatCard label="Actual Margin" value={`${totals.actMargin.toFixed(2)}%`} />
          <StatCard label="Est Margin" value={`${totals.estMargin.toFixed(2)}%`} />
        </div>

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
                    minWidth: 980,
                  }}
                >
                  <thead>
                    <tr style={{ background: "#FAFAFA" }}>
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