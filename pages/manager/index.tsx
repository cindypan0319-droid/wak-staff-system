import Link from "next/link";

export default function ManagerHome() {
  return (
    <div style={{ padding: 20 }}>
      <h1>Manager Dashboard</h1>

      <div style={{ marginTop: 20 }}>
        <Link href="/manager/roster">
          <button style={{ display: "block", marginBottom: 10 }}>
            Manage Roster
          </button>
        </Link>

        <Link href="/manager/time-clock">
          <button style={{ display: "block", marginBottom: 10 }}>
            View Time Clock
          </button>
        </Link>

        <Link href="/manager/platform-income">
          <button style={{ display: "block", marginBottom: 10 }}>
            View Platform Income
          </button>
        </Link>

        <Link href="/manager/invoices">
          <button style={{ display: "block", marginBottom: 10 }}>
            Supplier Invoices
          </button>
        </Link>
      </div>
    </div>
  );
}
