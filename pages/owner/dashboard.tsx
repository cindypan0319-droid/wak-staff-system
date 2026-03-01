import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Legend,
  BarChart,
  Bar,
} from "recharts";

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

// Period key by granularity (week starts Monday)
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

function prettyLabel(periodStart: string, g: Granularity) {
  if (g === "day") return periodStart;
  if (g === "week") return `Week of ${periodStart}`;
  return periodStart.slice(0, 7); // YYYY-MM
}

export default function OwnerDashboard() {
  const router = useRouter();

  const today = new Date();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(today.getDate() - 6);

  const [startDate, setStartDate] = useState(formatDate(sevenDaysAgo));
  const [endDate, setEndDate] = useState(formatDate(today));
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [userPickedGranularity, setUserPickedGranularity] = useState(false);

  const [revenueRows, setRevenueRows] = useState<any[]>([]);
  const [invoiceSeries, setInvoiceSeries] = useState<Record<string, number>>({});
  const [invoiceCategoryTotals, setInvoiceCategoryTotals] = useState<any[]>([]);
    const [invoiceSupplierTotals, setInvoiceSupplierTotals] = useState<any[]>([]);
    const [invoiceCategoryTime, setInvoiceCategoryTime] = useState<any[]>([]);

  const [loading, setLoading] = useState(true);
  const [checkingAuth, setCheckingAuth] = useState(true);

  async function fetchData() {
    setLoading(true);

    // Revenue daily rows
    const { data: revenue, error: revenueErr } = await supabase
      .from("v_owner_daily_breakdown")
      .select("*")
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: true });

    if (revenueErr) console.error("revenue error:", revenueErr);
    setRevenueRows(revenue || []);

    // Invoice series by granularity (RPC)
    const { data: invRows, error: invErr } = await supabase.rpc("owner_invoice_series", {
      start_date: startDate,
      end_date: endDate,
      granularity,
    });

    if (invErr) console.error("invoice series error:", invErr);

    const map: Record<string, number> = {};
    (invRows || []).forEach((r: any) => {
      map[String(r.period_start)] = Number(r.total || 0);
    });
    setInvoiceSeries(map);

    // Category totals
    const { data: catRows, error: catErr } = await supabase.rpc("owner_invoice_category_totals", {
    start_date: startDate,
    end_date: endDate,
    });
    if (catErr) console.error("category totals error:", catErr);
    setInvoiceCategoryTotals(catRows || []);

    // Supplier totals
    const { data: supRows, error: supErr } = await supabase.rpc("owner_invoice_supplier_totals", {
    start_date: startDate,
    end_date: endDate,
    });
    if (supErr) console.error("supplier totals error:", supErr);
    setInvoiceSupplierTotals(supRows || []);

    // Category x Time (for heatmap)
    const { data: heatRows, error: heatErr } = await supabase.rpc("owner_invoice_category_time", {
    start_date: startDate,
    end_date: endDate,
    granularity, // 'day' | 'week' | 'month'
    });
    if (heatErr) console.error("category time error:", heatErr);
    setInvoiceCategoryTime(heatRows || []);

    setLoading(false);
  }

  useEffect(() => {
    async function checkOwner() {
      const { data: userData } = await supabase.auth.getUser();

      if (!userData?.user) {
        router.push("/admin-login");
        return;
      }

      const { data: profile, error } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", userData.user.id)
        .single();

      if (error || profile?.role !== "OWNER") {
        alert("Access denied");
        router.push("/");
        return;
      }

      setCheckingAuth(false);

      const autoG = pickDefaultGranularity(startDate, endDate);
      setGranularity(autoG);
      setUserPickedGranularity(false);
      // fetch after granularity set
      setTimeout(fetchData, 0);
    }

    checkOwner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // auto adjust granularity when date range changes, unless user already manually chose
  useEffect(() => {
    if (userPickedGranularity) return;
    const autoG = pickDefaultGranularity(startDate, endDate);
    setGranularity(autoG);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate, endDate]);

  const grouped = useMemo(() => {
    const g = granularity;
    const map: Record<string, any> = {};

    for (const r of revenueRows) {
      const k = periodKey(String(r.date), g);
      if (!map[k]) {
        map[k] = {
          period_start: k,
          label: prettyLabel(k, g),
          revenue: 0,
          cash: 0,
          eftpos: 0,
          deliveroo: 0,
          doordash: 0,
          menulog: 0,
          uber: 0,
          wak: 0,
        };
      }
      map[k].revenue += Number(r.total_revenue || 0);
      map[k].cash += Number(r.cash || 0);
      map[k].eftpos += Number(r.eftpos || 0);
      map[k].deliveroo += Number(r.deliveroo_net || 0);
      map[k].doordash += Number(r.doordash_net || 0);
      map[k].menulog += Number(r.menulog_net || 0);
      map[k].uber += Number(r.uber_eats_net || 0);
      map[k].wak += Number(r.wak_net || 0);
    }

    const arr = Object.values(map).sort((a: any, b: any) =>
      String(a.period_start).localeCompare(String(b.period_start))
    );

    return arr.map((row: any) => {
      const k = String(row.period_start);
      const revenue = Number(row.revenue || 0);
      const actualInvoiceCost = Number(invoiceSeries[k] || 0);
      const estCOGS = revenue * EST_COGS_RATE;

      return {
        ...row,
        actual_invoice_cost: actualInvoiceCost,
        est_cogs: estCOGS,
      };
    });
  }, [revenueRows, invoiceSeries, granularity]);

  const totals = useMemo(() => {
    const totalRevenue = grouped.reduce((s: number, r: any) => s + Number(r.revenue || 0), 0);
    const actualCost = grouped.reduce((s: number, r: any) => s + Number(r.actual_invoice_cost || 0), 0);
    const estCost = totalRevenue * EST_COGS_RATE;

    const actProfit = totalRevenue - actualCost;
    const estProfit = totalRevenue - estCost;

    return {
      totalRevenue,
      actualCost,
      estCost,
      actProfit,
      estProfit,
      actMargin: totalRevenue > 0 ? (actProfit / totalRevenue) * 100 : 0,
      estMargin: totalRevenue > 0 ? (estProfit / totalRevenue) * 100 : 0,
    };
  }, [grouped]);

  // Donut data (based on totals within range, net)
  const donut = useMemo(() => {
    const cash = grouped.reduce((s: number, r: any) => s + Number(r.cash || 0), 0);
    const eftpos = grouped.reduce((s: number, r: any) => s + Number(r.eftpos || 0), 0);
    const deliveroo = grouped.reduce((s: number, r: any) => s + Number(r.deliveroo || 0), 0);
    const doordash = grouped.reduce((s: number, r: any) => s + Number(r.doordash || 0), 0);
    const menulog = grouped.reduce((s: number, r: any) => s + Number(r.menulog || 0), 0);
    const uber = grouped.reduce((s: number, r: any) => s + Number(r.uber || 0), 0);
    const wak = grouped.reduce((s: number, r: any) => s + Number(r.wak || 0), 0);

    const instore = cash + eftpos;
    const platform = deliveroo + doordash + menulog + uber + wak;
    const total = instore + platform;

    const inner = [
      { name: "In-store", value: instore },
      { name: "Platforms", value: platform },
    ].filter((x) => x.value > 0);

    const outer = [
      { name: "Cash", value: cash, group: "In-store" },
      { name: "EFTPOS", value: eftpos, group: "In-store" },
      { name: "Uber Eats", value: uber, group: "Platforms" },
      { name: "DoorDash", value: doordash, group: "Platforms" },
      { name: "Deliveroo", value: deliveroo, group: "Platforms" },
      { name: "Menulog", value: menulog, group: "Platforms" },
      { name: "WAK", value: wak, group: "Platforms" },
    ].filter((x) => x.value > 0);

    // top platform
    const platformItems = outer.filter((x) => x.group === "Platforms");
    const top = platformItems.sort((a, b) => b.value - a.value)[0];

    return {
      instore,
      platform,
      total,
      inner,
      outer,
      topPlatformName: top?.name || "-",
      topPlatformValue: top?.value || 0,
      instorePct: total > 0 ? (instore / total) * 100 : 0,
      platformPct: total > 0 ? (platform / total) * 100 : 0,
    };
  }, [grouped]);

    // ---------- Invoice Analytics ----------

    // Category bar: Top 8 + Others
    const invoiceCategoryBar = useMemo(() => {
    const rows = (invoiceCategoryTotals || []).map((r: any) => ({
        name: String(r.category),
        value: Number(r.total || 0),
    })).filter((x: any) => x.value > 0);

    const top8 = rows.slice(0, 8);
    const others = rows.slice(8);
    const othersSum = others.reduce((s: number, x: any) => s + x.value, 0);

    const data = othersSum > 0 ? [...top8, { name: "Others", value: othersSum }] : top8;

    const total = rows.reduce((s: number, x: any) => s + x.value, 0);
    const top = data[0];

    const top3Share = data.slice(0, 3).reduce((s: number, x: any) => s + x.value, 0);

    return {
        data,
        total,
        categoryCount: rows.length,
        topName: top?.name || "-",
        topValue: top?.value || 0,
        topPct: total > 0 ? (Number(top?.value || 0) / total) * 100 : 0,
        top3Pct: total > 0 ? (top3Share / total) * 100 : 0,
        othersPct: total > 0 ? (othersSum / total) * 100 : 0,
    };
    }, [invoiceCategoryTotals]);

    // Supplier bar: Top 10 suppliers
    const invoiceSupplierBar = useMemo(() => {
    const rows = (invoiceSupplierTotals || []).map((r: any) => ({
        name: String(r.supplier_name),
        value: Number(r.total || 0),
    })).filter((x: any) => x.value > 0);

    const top10 = rows.slice(0, 10);
    const total = rows.reduce((s: number, x: any) => s + x.value, 0);
    const top = top10[0];

    const top3 = top10.slice(0, 3).reduce((s: number, x: any) => s + x.value, 0);

    return {
        data: top10,
        total,
        supplierCount: rows.length,
        topName: top?.name || "-",
        topValue: top?.value || 0,
        topPct: total > 0 ? (Number(top?.value || 0) / total) * 100 : 0,
        top3Pct: total > 0 ? (top3 / total) * 100 : 0,
    };
    }, [invoiceSupplierTotals]);

    // Heatmap matrix: show Top 6 categories across periods (week/month best)
    const invoiceHeatmap = useMemo(() => {
    const rows = (invoiceCategoryTime || []).map((r: any) => ({
        period_start: String(r.period_start),
        category: String(r.category),
        total: Number(r.total || 0),
    })).filter((x: any) => x.total > 0);

    // periods in range (sorted)
    const periods = Array.from(new Set(rows.map((r: any) => r.period_start)))
        .sort((a, b) => a.localeCompare(b));

    // pick top categories overall (Top 6)
    const byCat: Record<string, number> = {};
    rows.forEach((r: any) => {
        byCat[r.category] = (byCat[r.category] || 0) + r.total;
    });

    const topCats = Object.entries(byCat)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([c]) => c);

    // build matrix
    const matrix: Record<string, Record<string, number>> = {};
    topCats.forEach((c) => (matrix[c] = {}));
    rows.forEach((r: any) => {
        if (!topCats.includes(r.category)) return;
        matrix[r.category][r.period_start] = (matrix[r.category][r.period_start] || 0) + r.total;
    });

    // find max for shading
    let max = 0;
    topCats.forEach((c) => {
        periods.forEach((p) => {
        const v = matrix[c]?.[p] || 0;
        if (v > max) max = v;
        });
    });

    // hottest cell
    let hotCat = "-";
    let hotPeriod = "-";
    let hotValue = 0;
    topCats.forEach((c) => {
        periods.forEach((p) => {
        const v = matrix[c]?.[p] || 0;
        if (v > hotValue) {
            hotValue = v;
            hotCat = c;
            hotPeriod = p;
        }
        });
    });

    return { periods, topCats, matrix, max, hotCat, hotPeriod, hotValue };
    }, [invoiceCategoryTime]);

  const costGap = totals.actualCost - totals.estCost;

  if (checkingAuth) return <div style={{ padding: 30 }}>Checking...</div>;

  return (
    <div style={{ padding: 30 }}>
              <div style={{ marginBottom: 12 }}>
        <button onClick={() => (window.location.href = "/staff/home")}>
          ← Back to Home
        </button>
      </div>
      <h1>Owner Dashboard</h1>

      {/* Filters */}
      <div style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end" }}>
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
          <select
            value={granularity}
            onChange={(e) => {
              setGranularity(e.target.value as Granularity);
              setUserPickedGranularity(true);
            }}
          >
            <option value="day">Day</option>
            <option value="week">Week (Mon)</option>
            <option value="month">Month</option>
          </select>
        </div>

        <button onClick={fetchData}>Apply</button>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <>
          {/* Trend chart: Revenue vs Costs */}
          <div style={{ width: "100%", height: 320, marginBottom: 10 }}>
            <ResponsiveContainer>
              <LineChart data={grouped}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="revenue" name="Revenue" stroke="#4f46e5" strokeWidth={3} />
                <Line type="monotone" dataKey="actual_invoice_cost" name="Actual Invoice Cost" stroke="#ef4444" strokeWidth={2} />
                <Line type="monotone" dataKey="est_cogs" name="Estimated COGS (35%)" stroke="#f59e0b" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Trend summary */}
          <SummaryBox title="Trend Summary (Current Range)">
            <SummaryRow k="Total Revenue" v={`$${totals.totalRevenue.toFixed(2)}`} />
            <SummaryRow k="Actual Invoice Cost" v={`$${totals.actualCost.toFixed(2)}`} />
            <SummaryRow k="Estimated COGS (35%)" v={`$${totals.estCost.toFixed(2)}`} />
            <SummaryRow k="Actual Margin (Cash-flow)" v={`${totals.actMargin.toFixed(2)}%`} />
            <SummaryRow k="Estimated Margin" v={`${totals.estMargin.toFixed(2)}%`} />
            <SummaryRow k="Actual - Estimated Gap" v={`$${costGap.toFixed(2)}`} />
          </SummaryBox>

          {/* Buttons: under trend, above donut */}
          <div style={{ marginTop: 14, marginBottom: 18, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button
              onClick={() => router.push(`/owner/invoices?start=${startDate}&end=${endDate}`)}
              style={btn}
            >
              View Invoices Table →
            </button>

            <button
              onClick={() => router.push(`/owner/profit-report?start=${startDate}&end=${endDate}`)}
              style={btn}
            >
              View Profit Table →
            </button>
          </div>

          {/* Donut chart */}
          <div style={{ width: "100%", height: 360, marginBottom: 10 }}>
            <h3 style={{ margin: "0 0 10px 0" }}>In-store vs Platforms (Net) + Breakdown</h3>
            <ResponsiveContainer>
              <PieChart>
                {/* Inner ring */}
                <Pie
                  data={donut.inner}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={60}
                  outerRadius={100}
                  label={({ percent }) => `${(((percent ?? 0) * 100).toFixed(0))}%`}
                >
                  {donut.inner.map((_: any, idx: number) => (
                    <Cell key={`inner-${idx}`} fill={["#4f46e5", "#10b981"][idx % 2]} />
                  ))}
                </Pie>

                {/* Outer ring */}
                <Pie
                  data={donut.outer}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={110}
                  outerRadius={150}
                >
                  {donut.outer.map((d: any, idx: number) => (
                    <Cell
                      key={`outer-${idx}`}
                      fill={
                        d.group === "In-store"
                          ? ["#6366f1", "#a5b4fc"][idx % 2]
                          : ["#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#84cc16"][idx % 5]
                      }
                    />
                  ))}
                </Pie>

                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Donut summary */}
          <SummaryBox title="Distribution Summary (Current Range)">
            <SummaryRow k="In-store (Net)" v={`$${donut.instore.toFixed(2)} (${donut.instorePct.toFixed(2)}%)`} />
            <SummaryRow k="Platforms (Net)" v={`$${donut.platform.toFixed(2)} (${donut.platformPct.toFixed(2)}%)`} />
            <SummaryRow k="Top Platform" v={`${donut.topPlatformName} ($${Number(donut.topPlatformValue).toFixed(2)})`} />
          </SummaryBox>
          {/* ---------- Invoice Analytics (NEW) ---------- */}

        {/* Category Breakdown */}
        <div style={{ width: "100%", height: 340, marginTop: 18, marginBottom: 10 }}>
        <h3 style={{ margin: "0 0 10px 0" }}>Invoice Cost by Category (Top 8 + Others)</h3>
        <ResponsiveContainer>
            <BarChart data={invoiceCategoryBar.data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Bar dataKey="value" name="Invoice Cost" />
            </BarChart>
        </ResponsiveContainer>
        </div>

        <SummaryBox title="Category Summary (Current Range)">
        <SummaryRow k="Total Invoice Cost" v={`$${Number(invoiceCategoryBar.total || 0).toFixed(2)}`} />
        <SummaryRow k="Top Category" v={`${invoiceCategoryBar.topName} ($${Number(invoiceCategoryBar.topValue || 0).toFixed(2)} / ${Number(invoiceCategoryBar.topPct || 0).toFixed(2)}%)`} />
        <SummaryRow k="Top 3 Share" v={`${Number(invoiceCategoryBar.top3Pct || 0).toFixed(2)}%`} />
        <SummaryRow k="Category Count" v={`${invoiceCategoryBar.categoryCount || 0}`} />
        <SummaryRow k="Others Share" v={`${Number(invoiceCategoryBar.othersPct || 0).toFixed(2)}%`} />
        </SummaryBox>

        {/* Supplier Concentration */}
        <div style={{ width: "100%", height: 340, marginTop: 18, marginBottom: 10 }}>
        <h3 style={{ margin: "0 0 10px 0" }}>Top Suppliers (Invoice Cost)</h3>
        <ResponsiveContainer>
            <BarChart data={invoiceSupplierBar.data}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="name" />
            <YAxis />
            <Tooltip />
            <Bar dataKey="value" name="Invoice Cost" />
            </BarChart>
        </ResponsiveContainer>
        </div>

        <SummaryBox title="Supplier Summary (Current Range)">
        <SummaryRow k="Supplier Count" v={`${invoiceSupplierBar.supplierCount || 0}`} />
        <SummaryRow k="Top Supplier" v={`${invoiceSupplierBar.topName} ($${Number(invoiceSupplierBar.topValue || 0).toFixed(2)} / ${Number(invoiceSupplierBar.topPct || 0).toFixed(2)}%)`} />
        <SummaryRow k="Top 3 Share" v={`${Number(invoiceSupplierBar.top3Pct || 0).toFixed(2)}%`} />
        </SummaryBox>

        {/* Heatmap (best for week/month, hide for day) */}
        {granularity !== "day" && (
        <>
            <div style={{ marginTop: 18, marginBottom: 10 }}>
            <h3 style={{ margin: "0 0 10px 0" }}>Category × Time Heatmap (Top 6 Categories)</h3>

            <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 10 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                <thead>
                    <tr style={{ background: "#f8fafc" }}>
                    <th style={{ padding: 10, textAlign: "left", borderBottom: "1px solid #eee" }}>Category</th>
                    {invoiceHeatmap.periods.map((p) => (
                        <th key={p} style={{ padding: 10, textAlign: "left", borderBottom: "1px solid #eee" }}>
                        {prettyLabel(p, granularity)}
                        </th>
                    ))}
                    </tr>
                </thead>

                <tbody>
                    {invoiceHeatmap.topCats.map((cat) => (
                    <tr key={cat}>
                        <td style={{ padding: 10, borderBottom: "1px solid #f1f5f9", fontWeight: 700 }}>{cat}</td>
                        {invoiceHeatmap.periods.map((p) => {
                        const v = invoiceHeatmap.matrix?.[cat]?.[p] || 0;
                        const max = invoiceHeatmap.max || 1;
                        const alpha = v > 0 ? Math.max(0.08, v / max) : 0; // simple intensity
                        return (
                            <td
                            key={p}
                            style={{
                                padding: 10,
                                borderBottom: "1px solid #f1f5f9",
                                background: v > 0 ? `rgba(79, 70, 229, ${alpha})` : "transparent",
                                color: v > 0 && alpha > 0.35 ? "white" : "#0f172a",
                            }}
                            >
                            {v > 0 ? `$${v.toFixed(2)}` : "-"}
                            </td>
                        );
                        })}
                    </tr>
                    ))}

                    {invoiceHeatmap.topCats.length === 0 ? (
                    <tr>
                        <td style={{ padding: 10 }} colSpan={1 + invoiceHeatmap.periods.length}>
                        No invoice data in this range.
                        </td>
                    </tr>
                    ) : null}
                </tbody>
                </table>
            </div>
            </div>

            <SummaryBox title="Heatmap Summary (Current Range)">
            <SummaryRow
                k="Hottest Cell"
                v={`${invoiceHeatmap.hotCat} @ ${prettyLabel(invoiceHeatmap.hotPeriod, granularity)} ($${Number(invoiceHeatmap.hotValue || 0).toFixed(2)})`}
            />
            <SummaryRow k="Note" v="Heatmap shows Top 6 categories only." />
            </SummaryBox>
        </>
        )}
        </>
      )}
    </div>
  );
}

/* ---------- UI helpers ---------- */

function KPI({
  title,
  value,
  highlight = false,
  percent = false,
}: {
  title: string;
  value: number;
  highlight?: boolean;
  percent?: boolean;
}) {
  return (
    <div
      style={{
        minWidth: 220,
        padding: 14,
        border: "1px solid #ddd",
        borderRadius: 10,
        background: highlight ? "#eef2ff" : "white",
      }}
    >
      <div style={{ fontSize: 13, color: "#666" }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: "bold" }}>
        {percent ? `${Number(value || 0).toFixed(2)}%` : `$${Number(value || 0).toFixed(2)}`}
      </div>
    </div>
  );
}

function SummaryBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px solid #eee",
        borderRadius: 10,
        padding: 12,
        marginBottom: 8,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "#334155", marginBottom: 8 }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>{children}</div>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
      <div style={{ fontSize: 12, color: "#64748b" }}>{k}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>{v}</div>
    </div>
  );
}

const label: React.CSSProperties = { fontSize: 12, color: "#64748b", marginBottom: 4 };

const btn: React.CSSProperties = {
  padding: "10px 14px",
  fontSize: 14,
  backgroundColor: "#4f46e5",
  color: "white",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};