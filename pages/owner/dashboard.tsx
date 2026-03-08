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

function prettyLabel(periodStart: string, g: Granularity) {
  if (g === "day") return periodStart;
  if (g === "week") return `Week of ${periodStart}`;
  return periodStart.slice(0, 7);
}

function shortLabel(periodStart: string, g: Granularity) {
  if (g === "day") {
    const d = new Date(periodStart + "T00:00:00");
    return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  if (g === "week") {
    const d = new Date(periodStart + "T00:00:00");
    return `Wk ${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
  return periodStart.slice(2, 7);
}

function money(n: number | null | undefined) {
  const v = Number(n || 0);
  return `$${v.toFixed(2)}`;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function minutesBetween(aISO: string | null | undefined, bISO: string | null | undefined) {
  if (!aISO || !bISO) return null;
  const a = new Date(aISO).getTime();
  const b = new Date(bISO).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 60000));
}

function getDayTypeByISO(iso: string): "WEEKDAY" | "SATURDAY" | "SUNDAY" {
  const d = new Date(iso);
  const day = d.getDay();
  if (day === 0) return "SUNDAY";
  if (day === 6) return "SATURDAY";
  return "WEEKDAY";
}

function actionButton(
  label: string,
  onClick: () => void,
  options?: { primary?: boolean; disabled?: boolean }
) {
  const primary = options?.primary;
  const disabled = options?.disabled;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "12px 16px",
        minHeight: 44,
        borderRadius: 12,
        border: primary ? `1px solid ${WAK_BLUE}` : `1px solid ${BORDER}`,
        background: disabled ? "#D1D5DB" : primary ? WAK_BLUE : "#fff",
        color: disabled ? "#fff" : primary ? "#fff" : TEXT,
        fontWeight: 800,
        fontSize: 14,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: primary ? "0 8px 18px rgba(0,0,0,0.10)" : "none",
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

function KPI({
  title,
  value,
  highlight = false,
}: {
  title: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        minWidth: 180,
        padding: 14,
        border: `1px solid ${BORDER}`,
        borderRadius: 14,
        background: highlight ? "#EFF6FF" : "#F9FAFB",
      }}
    >
      <div style={{ fontSize: 12, color: MUTED }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: TEXT, marginTop: 6 }}>{value}</div>
    </div>
  );
}

function SummaryBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        border: `1px solid ${BORDER}`,
        borderRadius: 14,
        padding: 14,
        marginTop: 12,
        background: "#fff",
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 800, color: TEXT, marginBottom: 10 }}>{title}</div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 8,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 10,
        border: `1px solid ${BORDER}`,
        borderRadius: 10,
        padding: "10px 12px",
        background: "#F9FAFB",
      }}
    >
      <div style={{ fontSize: 12, color: MUTED }}>{k}</div>
      <div style={{ fontSize: 12, fontWeight: 800, color: TEXT, textAlign: "right" }}>{v}</div>
    </div>
  );
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

  const [payrollRows, setPayrollRows] = useState<any[]>([]);
  const [payrollSeries, setPayrollSeries] = useState<Record<string, number>>({});
  const [payrollStaffTotals, setPayrollStaffTotals] = useState<any[]>([]);

  const [loading, setLoading] = useState(true);
  const [checkingAuth, setCheckingAuth] = useState(true);

  async function fetchPayrollData() {
    const { data: shiftRows, error: shiftErr } = await supabase
      .from("shifts")
      .select("id, staff_id, shift_start, shift_end, break_minutes")
      .gte("shift_start", `${startDate}T00:00:00`)
      .lt("shift_start", `${endDate}T23:59:59`)
      .order("shift_start", { ascending: true })
      .limit(3000);

    if (shiftErr) {
      console.error("payroll shifts error:", shiftErr);
      setPayrollRows([]);
      setPayrollSeries({});
      setPayrollStaffTotals([]);
      return;
    }

    const startISO = new Date(startDate + "T00:00:00").toISOString();
    const endPlus = new Date(endDate + "T00:00:00");
    endPlus.setDate(endPlus.getDate() + 1);
    const endISO = endPlus.toISOString();

    const clockWindowStart = new Date(new Date(startISO).getTime() - 6 * 60 * 60 * 1000).toISOString();
    const clockWindowEnd = new Date(new Date(endISO).getTime() + 6 * 60 * 60 * 1000).toISOString();

    const [clockRes, payRes, profileRes] = await Promise.all([
      supabase
        .from("time_clock")
        .select("id, shift_id, staff_id, clock_in_at, clock_out_at, adjusted_clock_in_at, adjusted_clock_out_at")
        .gte("clock_in_at", clockWindowStart)
        .lt("clock_in_at", clockWindowEnd)
        .order("clock_in_at", { ascending: true })
        .limit(5000),
      supabase
        .from("staff_pay_rates")
        .select("staff_id, weekday_rate, saturday_rate, sunday_rate"),
      supabase
        .from("profiles")
        .select("id, full_name"),
    ]);

    if (clockRes.error) console.error("payroll clock error:", clockRes.error);
    if (payRes.error) console.error("payroll rates error:", payRes.error);
    if (profileRes.error) console.error("payroll profiles error:", profileRes.error);

    const clocks = (clockRes.data || []) as any[];
    const payRates = (payRes.data || []) as any[];
    const profiles = (profileRes.data || []) as any[];

    const payMap: Record<string, any> = {};
    payRates.forEach((r) => {
      payMap[r.staff_id] = r;
    });

    const nameMap: Record<string, string> = {};
    profiles.forEach((p) => {
      nameMap[p.id] = p.full_name || p.id;
    });

    function findClockForShift(shift: any) {
      const byId = clocks.find((c) => c.shift_id === shift.id);
      if (byId) return byId;

      const sStart = new Date(shift.shift_start).getTime();
      const sEnd = new Date(shift.shift_end).getTime();
      const windowStart = sStart - 6 * 60 * 60 * 1000;
      const windowEnd = sEnd + 6 * 60 * 60 * 1000;

      const candidates = clocks
        .filter((c) => c.staff_id === shift.staff_id && c.clock_in_at)
        .filter((c) => {
          const t = new Date(c.clock_in_at).getTime();
          return t >= windowStart && t <= windowEnd;
        });

      if (candidates.length === 0) return null;

      candidates.sort((a, b) => {
        const ta = new Date(a.clock_in_at).getTime();
        const tb = new Date(b.clock_in_at).getTime();
        return Math.abs(ta - sStart) - Math.abs(tb - sStart);
      });

      return candidates[0];
    }

    function rateFor(staffId: string, dayType: "WEEKDAY" | "SATURDAY" | "SUNDAY") {
      const r = payMap[staffId];
      if (!r) return null;
      if (dayType === "SATURDAY") return Number(r.saturday_rate ?? 0);
      if (dayType === "SUNDAY") return Number(r.sunday_rate ?? 0);
      return Number(r.weekday_rate ?? 0);
    }

    function getPayrollMinutes(shift: any, clock: any) {
      const breakMin = Number(shift.break_minutes ?? 0);

      const rosterMin = minutesBetween(shift.shift_start, shift.shift_end);
      const rawMin = clock ? minutesBetween(clock.clock_in_at, clock.clock_out_at) : null;

      const adjIn = clock?.adjusted_clock_in_at ?? null;
      const adjOut = clock?.adjusted_clock_out_at ?? null;
      const adjMin = adjIn && adjOut ? minutesBetween(adjIn, adjOut) : null;

      const rosterWorkMin = rosterMin !== null ? Math.max(0, rosterMin - breakMin) : null;
      const rawWorkMin = rawMin !== null ? Math.max(0, rawMin - breakMin) : null;
      const adjWorkMin = adjMin !== null ? Math.max(0, adjMin - breakMin) : null;

      return adjWorkMin ?? rawWorkMin ?? rosterWorkMin ?? 0;
    }

    const detailed = (shiftRows || []).map((shift: any) => {
      const clock = findClockForShift(shift);
      const mins = getPayrollMinutes(shift, clock);
      const hours = round2(mins / 60);
      const dayType = getDayTypeByISO(shift.shift_start);
      const rate = Number(rateFor(shift.staff_id, dayType) ?? 0);
      const pay = round2(hours * rate);
      const date = String(shift.shift_start).slice(0, 10);

      return {
        staff_id: shift.staff_id,
        staff_name: nameMap[shift.staff_id] || shift.staff_id,
        date,
        shift_start: shift.shift_start,
        pay,
        hours,
      };
    });

    setPayrollRows(detailed);

    const seriesMap: Record<string, number> = {};
    detailed.forEach((r) => {
      const k = periodKey(r.date, granularity);
      seriesMap[k] = round2((seriesMap[k] || 0) + r.pay);
    });
    setPayrollSeries(seriesMap);

    const staffMap: Record<string, { name: string; pay: number; hours: number }> = {};
    detailed.forEach((r) => {
      if (!staffMap[r.staff_id]) {
        staffMap[r.staff_id] = { name: r.staff_name, pay: 0, hours: 0 };
      }
      staffMap[r.staff_id].pay += r.pay;
      staffMap[r.staff_id].hours += r.hours;
    });

    const topStaff = Object.values(staffMap)
      .map((x) => ({ ...x, pay: round2(x.pay), hours: round2(x.hours) }))
      .sort((a, b) => b.pay - a.pay)
      .slice(0, 5);

    setPayrollStaffTotals(topStaff);
  }

  async function fetchData() {
    setLoading(true);

    const { data: revenue, error: revenueErr } = await supabase
      .from("v_owner_daily_breakdown")
      .select("*")
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: true });

    if (revenueErr) console.error("revenue error:", revenueErr);
    setRevenueRows(revenue || []);

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

    const { data: catRows, error: catErr } = await supabase.rpc("owner_invoice_category_totals", {
      start_date: startDate,
      end_date: endDate,
    });
    if (catErr) console.error("category totals error:", catErr);
    setInvoiceCategoryTotals(catRows || []);

    const { data: supRows, error: supErr } = await supabase.rpc("owner_invoice_supplier_totals", {
      start_date: startDate,
      end_date: endDate,
    });
    if (supErr) console.error("supplier totals error:", supErr);
    setInvoiceSupplierTotals(supRows || []);

    const { data: heatRows, error: heatErr } = await supabase.rpc("owner_invoice_category_time", {
      start_date: startDate,
      end_date: endDate,
      granularity,
    });
    if (heatErr) console.error("category time error:", heatErr);
    setInvoiceCategoryTime(heatRows || []);

    await fetchPayrollData();

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
      setTimeout(fetchData, 0);
    }

    checkOwner();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          shortLabel: shortLabel(k, g),
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
      const payrollCost = Number(payrollSeries[k] || 0);

      return {
        ...row,
        actual_invoice_cost: actualInvoiceCost,
        est_cogs: estCOGS,
        payroll_cost: payrollCost,
        profit_after_payroll: revenue - actualInvoiceCost - payrollCost,
      };
    });
  }, [revenueRows, invoiceSeries, payrollSeries, granularity]);

  const totals = useMemo(() => {
    const totalRevenue = grouped.reduce((s: number, r: any) => s + Number(r.revenue || 0), 0);
    const actualCost = grouped.reduce((s: number, r: any) => s + Number(r.actual_invoice_cost || 0), 0);
    const estCost = totalRevenue * EST_COGS_RATE;
    const payrollCost = grouped.reduce((s: number, r: any) => s + Number(r.payroll_cost || 0), 0);

    const actProfit = totalRevenue - actualCost;
    const estProfit = totalRevenue - estCost;
    const profitAfterPayroll = totalRevenue - actualCost - payrollCost;

    const totalPayrollHours = payrollRows.reduce((s: number, r: any) => s + Number(r.hours || 0), 0);

    return {
      totalRevenue,
      actualCost,
      estCost,
      payrollCost,
      totalPayrollHours,
      actProfit,
      estProfit,
      profitAfterPayroll,
      actMargin: totalRevenue > 0 ? (actProfit / totalRevenue) * 100 : 0,
      estMargin: totalRevenue > 0 ? (estProfit / totalRevenue) * 100 : 0,
      payrollPct: totalRevenue > 0 ? (payrollCost / totalRevenue) * 100 : 0,
      afterPayrollMargin: totalRevenue > 0 ? (profitAfterPayroll / totalRevenue) * 100 : 0,
      revenuePayrollRatio: payrollCost > 0 ? totalRevenue / payrollCost : 0,
    };
  }, [grouped, payrollRows]);

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

    const platformItems = outer.filter((x) => x.group === "Platforms");
    const top = [...platformItems].sort((a, b) => b.value - a.value)[0];

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

  const invoiceCategoryBar = useMemo(() => {
    const rows = (invoiceCategoryTotals || [])
      .map((r: any) => ({
        name: String(r.category),
        value: Number(r.total || 0),
      }))
      .filter((x: any) => x.value > 0);

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
      top3Pct: total > 0 ? top3Share / total * 100 : 0,
      othersPct: total > 0 ? othersSum / total * 100 : 0,
    };
  }, [invoiceCategoryTotals]);

  const invoiceSupplierBar = useMemo(() => {
    const rows = (invoiceSupplierTotals || [])
      .map((r: any) => ({
        name: String(r.supplier_name),
        value: Number(r.total || 0),
      }))
      .filter((x: any) => x.value > 0);

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
      top3Pct: total > 0 ? top3 / total * 100 : 0,
    };
  }, [invoiceSupplierTotals]);

  const invoiceHeatmap = useMemo(() => {
    const rows = (invoiceCategoryTime || [])
      .map((r: any) => ({
        period_start: String(r.period_start),
        category: String(r.category),
        total: Number(r.total || 0),
      }))
      .filter((x: any) => x.total > 0);

    const periods = Array.from(new Set(rows.map((r: any) => r.period_start))).sort((a, b) => a.localeCompare(b));

    const byCat: Record<string, number> = {};
    rows.forEach((r: any) => {
      byCat[r.category] = (byCat[r.category] || 0) + r.total;
    });

    const topCats = Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([c]) => c);

    const matrix: Record<string, Record<string, number>> = {};
    topCats.forEach((c) => (matrix[c] = {}));
    rows.forEach((r: any) => {
      if (!topCats.includes(r.category)) return;
      matrix[r.category][r.period_start] = (matrix[r.category][r.period_start] || 0) + r.total;
    });

    let max = 0;
    topCats.forEach((c) => {
      periods.forEach((p) => {
        const v = matrix[c]?.[p] || 0;
        if (v > max) max = v;
      });
    });

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

  const payrollTrend = useMemo(() => {
    return grouped.map((r: any) => ({
      label: r.shortLabel,
      payroll: Number(r.payroll_cost || 0),
      revenue: Number(r.revenue || 0),
      afterPayroll: Number(r.profit_after_payroll || 0),
    }));
  }, [grouped]);

  const topStaffByPayroll = useMemo(() => {
    return payrollStaffTotals || [];
  }, [payrollStaffTotals]);

  const costGap = totals.actualCost - totals.estCost;

  if (checkingAuth) {
    return (
      <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
        <div style={{ maxWidth: 1260, margin: "0 auto" }}>
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
            }}
          >
            <h1 style={{ margin: 0, color: TEXT }}>Owner Dashboard</h1>
            <div style={{ marginTop: 10, color: MUTED }}>Checking...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
      <div style={{ maxWidth: 1260, margin: "0 auto" }}>
        <div style={{ marginBottom: 12 }}>
          {actionButton("← Back to Home", () => (window.location.href = "/staff/home"))}
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
          <h1 style={{ margin: 0, color: TEXT }}>Owner Dashboard</h1>
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
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle(160)} />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>End</div>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle(160)} />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>View by</div>
              <select
                value={granularity}
                onChange={(e) => {
                  setGranularity(e.target.value as Granularity);
                  setUserPickedGranularity(true);
                }}
                style={inputStyle(150)}
              >
                <option value="day">Day</option>
                <option value="week">Week (Mon)</option>
                <option value="month">Month</option>
              </select>
            </div>

            {actionButton("Apply", fetchData, { primary: true })}
          </div>
        </div>

        {loading ? (
          <div
            style={{
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              background: CARD_BG,
              padding: 24,
              boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
              color: MUTED,
            }}
          >
            Loading...
          </div>
        ) : (
          <>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
              <KPI title="Total Revenue" value={money(totals.totalRevenue)} highlight />
              <KPI title="Actual Invoice Cost" value={money(totals.actualCost)} />
              <KPI title="Payroll Cost" value={money(totals.payrollCost)} />
              <KPI title="Payroll Hours" value={`${totals.totalPayrollHours.toFixed(2)}h`} />
              <KPI title="Actual Profit" value={money(totals.actProfit)} />
              <KPI title="Profit After Payroll" value={money(totals.profitAfterPayroll)} />
              <KPI title="Payroll % of Revenue" value={`${totals.payrollPct.toFixed(2)}%`} />
              <KPI title="After Payroll Margin" value={`${totals.afterPayrollMargin.toFixed(2)}%`} />
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
              <h2 style={{ margin: "0 0 10px 0", color: TEXT }}>Revenue & Cost Trend</h2>

              <div style={{ width: "100%", height: 340 }}>
                <ResponsiveContainer>
                  <LineChart
                    data={grouped}
                    margin={{ top: 12, right: 18, left: 0, bottom: 38 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="shortLabel"
                      interval="preserveStartEnd"
                      tick={{ fontSize: 11 }}
                      height={48}
                    />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="revenue" name="Revenue" stroke={WAK_BLUE} strokeWidth={3} dot={false} />
                    <Line type="monotone" dataKey="actual_invoice_cost" name="Actual Invoice Cost" stroke={WAK_RED} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="est_cogs" name="Estimated COGS (35%)" stroke="#F59E0B" strokeWidth={2} dot={false} />
                    <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <SummaryBox title="Trend Summary (Current Range)">
                <SummaryRow k="Total Revenue" v={money(totals.totalRevenue)} />
                <SummaryRow k="Actual Invoice Cost" v={money(totals.actualCost)} />
                <SummaryRow k="Estimated COGS (35%)" v={money(totals.estCost)} />
                <SummaryRow k="Actual Margin (Cash-flow)" v={`${totals.actMargin.toFixed(2)}%`} />
                <SummaryRow k="Estimated Margin" v={`${totals.estMargin.toFixed(2)}%`} />
                <SummaryRow k="Actual - Estimated Gap" v={money(costGap)} />
              </SummaryBox>

              <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
                {actionButton("View Invoices Table →", () =>
                  router.push(`/owner/invoices?start=${startDate}&end=${endDate}`), { primary: true })}
                {actionButton("View Profit Table →", () =>
                  router.push(`/owner/profit-report?start=${startDate}&end=${endDate}`))}
                {actionButton("View Payroll Summary →", () =>
                  router.push(`/owner/staff-summary`))}
              </div>
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
              <h2 style={{ margin: "0 0 10px 0", color: TEXT }}>Revenue Mix</h2>

              <div style={{ width: "100%", height: 380 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie
                      data={donut.inner}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={52}
                      outerRadius={88}
                      label={({ percent }) => `${(((percent ?? 0) * 100).toFixed(0))}%`}
                    >
                      {donut.inner.map((_: any, idx: number) => (
                        <Cell key={`inner-${idx}`} fill={[WAK_BLUE, "#10B981"][idx % 2]} />
                      ))}
                    </Pie>

                    <Pie
                      data={donut.outer}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={98}
                      outerRadius={136}
                    >
                      {donut.outer.map((d: any, idx: number) => (
                        <Cell
                          key={`outer-${idx}`}
                          fill={
                            d.group === "In-store"
                              ? ["#3B82F6", "#93C5FD"][idx % 2]
                              : ["#22C55E", "#F59E0B", "#EF4444", "#06B6D4", "#84CC16"][idx % 5]
                          }
                        />
                      ))}
                    </Pie>

                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <SummaryBox title="Distribution Summary (Current Range)">
                <SummaryRow k="In-store (Net)" v={`${money(donut.instore)} (${donut.instorePct.toFixed(2)}%)`} />
                <SummaryRow k="Platforms (Net)" v={`${money(donut.platform)} (${donut.platformPct.toFixed(2)}%)`} />
                <SummaryRow k="Top Platform" v={`${donut.topPlatformName} (${money(donut.topPlatformValue)})`} />
              </SummaryBox>
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
              <h2 style={{ margin: "0 0 10px 0", color: TEXT }}>Payroll Analytics</h2>

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
                <KPI title="Payroll Cost" value={money(totals.payrollCost)} />
                <KPI title="Payroll Hours" value={`${totals.totalPayrollHours.toFixed(2)}h`} />
                <KPI title="Payroll % of Revenue" value={`${totals.payrollPct.toFixed(2)}%`} />
                <KPI title="Revenue / Payroll Ratio" value={totals.revenuePayrollRatio > 0 ? totals.revenuePayrollRatio.toFixed(2) : "-"} />
              </div>

              <div style={{ width: "100%", height: 340 }}>
                <ResponsiveContainer>
                  <LineChart
                    data={payrollTrend}
                    margin={{ top: 12, right: 18, left: 0, bottom: 38 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis
                      dataKey="label"
                      interval="preserveStartEnd"
                      tick={{ fontSize: 11 }}
                      height={48}
                    />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="revenue" name="Revenue" stroke={WAK_BLUE} strokeWidth={3} dot={false} />
                    <Line type="monotone" dataKey="payroll" name="Payroll Cost" stroke={WAK_RED} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="afterPayroll" name="Profit After Payroll" stroke="#10B981" strokeWidth={2} dot={false} />
                    <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <SummaryBox title="Payroll Summary (Current Range)">
                <SummaryRow k="Total Payroll Cost" v={money(totals.payrollCost)} />
                <SummaryRow k="Total Payroll Hours" v={`${totals.totalPayrollHours.toFixed(2)}h`} />
                <SummaryRow k="Payroll % of Revenue" v={`${totals.payrollPct.toFixed(2)}%`} />
                <SummaryRow k="Profit After Payroll" v={money(totals.profitAfterPayroll)} />
                <SummaryRow k="After Payroll Margin" v={`${totals.afterPayrollMargin.toFixed(2)}%`} />
                <SummaryRow k="Revenue / Payroll Ratio" v={totals.revenuePayrollRatio > 0 ? totals.revenuePayrollRatio.toFixed(2) : "-"} />
              </SummaryBox>

              <div style={{ marginTop: 14 }}>
                <h3 style={{ margin: "0 0 10px 0", color: TEXT, fontSize: 16 }}>Top Staff by Payroll Cost</h3>
                <div style={{ overflowX: "auto", border: `1px solid ${BORDER}`, borderRadius: 12 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 540 }}>
                    <thead>
                      <tr style={{ background: "#FAFAFA", textAlign: "left" }}>
                        <th style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: MUTED }}>Staff</th>
                        <th style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: MUTED }}>Hours</th>
                        <th style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: MUTED }}>Payroll Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topStaffByPayroll.length === 0 ? (
                        <tr>
                          <td colSpan={3} style={{ padding: 12, color: MUTED }}>No payroll data.</td>
                        </tr>
                      ) : (
                        topStaffByPayroll.map((s: any, idx: number) => (
                          <tr key={`${s.name}-${idx}`}>
                            <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: TEXT, fontWeight: 700 }}>{s.name}</td>
                            <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: TEXT }}>{Number(s.hours || 0).toFixed(2)}h</td>
                            <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: TEXT }}>{money(s.pay)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
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
              <h2 style={{ margin: "0 0 10px 0", color: TEXT }}>Invoice Cost by Category</h2>
              <div style={{ width: "100%", height: 340 }}>
                <ResponsiveContainer>
                  <BarChart data={invoiceCategoryBar.data} margin={{ top: 12, right: 18, left: 0, bottom: 38 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" interval={0} tick={{ fontSize: 11 }} angle={-20} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" name="Invoice Cost" fill={WAK_BLUE} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <SummaryBox title="Category Summary (Current Range)">
                <SummaryRow k="Total Invoice Cost" v={money(invoiceCategoryBar.total)} />
                <SummaryRow k="Top Category" v={`${invoiceCategoryBar.topName} (${money(invoiceCategoryBar.topValue)} / ${Number(invoiceCategoryBar.topPct || 0).toFixed(2)}%)`} />
                <SummaryRow k="Top 3 Share" v={`${Number(invoiceCategoryBar.top3Pct || 0).toFixed(2)}%`} />
                <SummaryRow k="Category Count" v={`${invoiceCategoryBar.categoryCount || 0}`} />
                <SummaryRow k="Others Share" v={`${Number(invoiceCategoryBar.othersPct || 0).toFixed(2)}%`} />
              </SummaryBox>
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
              <h2 style={{ margin: "0 0 10px 0", color: TEXT }}>Top Suppliers</h2>
              <div style={{ width: "100%", height: 340 }}>
                <ResponsiveContainer>
                  <BarChart data={invoiceSupplierBar.data} margin={{ top: 12, right: 18, left: 0, bottom: 38 }}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" interval={0} tick={{ fontSize: 11 }} angle={-20} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" name="Invoice Cost" fill={WAK_RED} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <SummaryBox title="Supplier Summary (Current Range)">
                <SummaryRow k="Supplier Count" v={`${invoiceSupplierBar.supplierCount || 0}`} />
                <SummaryRow k="Top Supplier" v={`${invoiceSupplierBar.topName} (${money(invoiceSupplierBar.topValue)} / ${Number(invoiceSupplierBar.topPct || 0).toFixed(2)}%)`} />
                <SummaryRow k="Top 3 Share" v={`${Number(invoiceSupplierBar.top3Pct || 0).toFixed(2)}%`} />
              </SummaryBox>
            </div>

            {granularity !== "day" && (
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
                <h2 style={{ margin: "0 0 10px 0", color: TEXT }}>Category × Time Heatmap</h2>

                <div style={{ overflowX: "auto", border: `1px solid ${BORDER}`, borderRadius: 12 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                    <thead>
                      <tr style={{ background: "#FAFAFA" }}>
                        <th style={{ padding: 10, textAlign: "left", borderBottom: `1px solid ${BORDER}`, color: MUTED }}>Category</th>
                        {invoiceHeatmap.periods.map((p) => (
                          <th key={p} style={{ padding: 10, textAlign: "left", borderBottom: `1px solid ${BORDER}`, color: MUTED }}>
                            {prettyLabel(p, granularity)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {invoiceHeatmap.topCats.map((cat) => (
                        <tr key={cat}>
                          <td style={{ padding: 10, borderBottom: `1px solid ${BORDER}`, fontWeight: 700, color: TEXT }}>{cat}</td>
                          {invoiceHeatmap.periods.map((p) => {
                            const v = invoiceHeatmap.matrix?.[cat]?.[p] || 0;
                            const max = invoiceHeatmap.max || 1;
                            const alpha = v > 0 ? Math.max(0.08, v / max) : 0;
                            return (
                              <td
                                key={p}
                                style={{
                                  padding: 10,
                                  borderBottom: `1px solid ${BORDER}`,
                                  background: v > 0 ? `rgba(30, 90, 158, ${alpha})` : "transparent",
                                  color: v > 0 && alpha > 0.35 ? "white" : TEXT,
                                }}
                              >
                                {v > 0 ? money(v) : "-"}
                              </td>
                            );
                          })}
                        </tr>
                      ))}

                      {invoiceHeatmap.topCats.length === 0 ? (
                        <tr>
                          <td style={{ padding: 10, color: MUTED }} colSpan={1 + invoiceHeatmap.periods.length}>
                            No invoice data in this range.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>

                <SummaryBox title="Heatmap Summary (Current Range)">
                  <SummaryRow
                    k="Hottest Cell"
                    v={`${invoiceHeatmap.hotCat} @ ${prettyLabel(invoiceHeatmap.hotPeriod, granularity)} (${money(invoiceHeatmap.hotValue)})`}
                  />
                  <SummaryRow k="Note" v="Heatmap shows Top 6 categories only." />
                </SummaryBox>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}