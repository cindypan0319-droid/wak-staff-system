import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function RosterPage() {
  const [shifts, setShifts] = useState<any[]>([]);
  const [storeId, setStoreId] = useState("MOOROOLBARK");
  const [staffId, setStaffId] = useState("");
  const [shiftStart, setShiftStart] = useState("");
  const [shiftEnd, setShiftEnd] = useState("");
  const [breakMinutes, setBreakMinutes] = useState("0");
  const [hourlyRate, setHourlyRate] = useState("");

  async function loadShifts() {
    const { data } = await supabase
      .from("shifts")
      .select("*")
      .eq("store_id", storeId)
      .order("shift_start", { ascending: false });

    if (data) setShifts(data);
  }

  useEffect(() => {
    loadShifts();
  }, []);

  async function createShift() {
    const { error } = await supabase.from("shifts").insert([
      {
        store_id: storeId,
        staff_id: staffId,
        shift_start: shiftStart,
        shift_end: shiftEnd,
        break_minutes: Number(breakMinutes),
        hourly_rate: Number(hourlyRate),
        created_by: (await supabase.auth.getUser()).data.user?.id,
      },
    ]);

    if (error) {
      alert(error.message);
    } else {
      alert("Shift created!");
      loadShifts();
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Roster Management</h1>

      <h3>Create Shift</h3>

      <div>
        <input
          placeholder="Staff UUID"
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
        />
      </div>

      <div>
        <input
          type="datetime-local"
          value={shiftStart}
          onChange={(e) => setShiftStart(e.target.value)}
        />
      </div>

      <div>
        <input
          type="datetime-local"
          value={shiftEnd}
          onChange={(e) => setShiftEnd(e.target.value)}
        />
      </div>

      <div>
        <input
          placeholder="Break Minutes"
          value={breakMinutes}
          onChange={(e) => setBreakMinutes(e.target.value)}
        />
      </div>

      <div>
        <input
          placeholder="Hourly Rate"
          value={hourlyRate}
          onChange={(e) => setHourlyRate(e.target.value)}
        />
      </div>

      <button onClick={createShift}>Create Shift</button>

      <hr />

      <h3>All Shifts</h3>

      {shifts.map((s) => (
        <div key={s.id} style={{ marginBottom: 10 }}>
          {s.staff_id} | {new Date(s.shift_start).toLocaleString()} →{" "}
          {new Date(s.shift_end).toLocaleString()}
        </div>
      ))}
    </div>
  );
}