import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

export default function RevenueReport() {
  const router = useRouter();

  const today = new Date().toISOString().split("T")[0];
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);

  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  async function fetchData() {
    setLoading(true);

    const { data, error } = await supabase
      .from("v_owner_daily_breakdown")
      .select("*")
      .gte("date", startDate)
      .lte("date", endDate)
      .order("date", { ascending: false });

    if (!error) setData(data || []);
    setLoading(false);
  }

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <div style={{ padding: 30 }}>
      <h1>Detailed Revenue Report</h1>

      <button
        onClick={() => router.push("/owner/dashboard")}
        style={{ marginBottom: 20 }}
      >
        ← Back to Dashboard
      </button>

      <div style={{ marginBottom: 20 }}>
        <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <input
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
          style={{ marginLeft: 10 }}
        />
        <button onClick={fetchData} style={{ marginLeft: 10 }}>
          Apply
        </button>
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : (
        <table border={1} cellPadding={8} style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th>Date</th>
              <th>Cash</th>
              <th>EFTPOS</th>
              <th>Deliveroo</th>
              <th>DoorDash</th>
              <th>Menulog</th>
              <th>Uber Eats</th>
              <th>WAK</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.date}>
                <td>{row.date}</td>
                <td>${Number(row.cash).toFixed(2)}</td>
                <td>${Number(row.eftpos).toFixed(2)}</td>
                <td>${Number(row.deliveroo_net).toFixed(2)}</td>
                <td>${Number(row.doordash_net).toFixed(2)}</td>
                <td>${Number(row.menulog_net).toFixed(2)}</td>
                <td>${Number(row.uber_eats_net).toFixed(2)}</td>
                <td>${Number(row.wak_net).toFixed(2)}</td>
                <td><strong>${Number(row.total_revenue).toFixed(2)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}