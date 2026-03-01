import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../../lib/supabaseClient";

export default function OwnerInvoiceEditPage() {
  const router = useRouter();
  const { id } = router.query;

  const start = typeof router.query.start === "string" ? router.query.start : "";
  const end = typeof router.query.end === "string" ? router.query.end : "";

  const [checkingAuth, setCheckingAuth] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    invoice_date: "",
    supplier_name: "",
    invoice_number: "",
    category: "",
    amount: "",
    tax: "",
    uploaded_file_url: "",
    store_id: "",
  });

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
    if (checkingAuth) return;
    if (!router.isReady) return;
    if (!id) return;

    async function load() {
      setLoading(true);

      const invoiceId = Number(id);
      const { data, error } = await supabase.rpc("owner_invoice_get", {
        invoice_id: invoiceId,
      });

      if (error) {
        console.error("owner_invoice_get error:", error);
        alert(`Load failed: ${error.message}`);
        setLoading(false);
        return;
      }

      const row = data?.[0];
      if (!row) {
        alert("Invoice not found.");
        setLoading(false);
        return;
      }

      setForm({
        invoice_date: row.invoice_date || "",
        supplier_name: row.supplier_name || "",
        invoice_number: row.invoice_number || "",
        category: row.category || "",
        amount: row.amount != null ? String(row.amount) : "",
        tax: row.tax != null ? String(row.tax) : "",
        uploaded_file_url: row.uploaded_file_url || "",
        store_id: row.store_id || "",
      });

      setLoading(false);
    }

    load();
  }, [checkingAuth, router.isReady, id]);

  async function save() {
    if (!id) return;
    setSaving(true);

    const invoiceId = Number(id);

    const { error } = await supabase.rpc("owner_invoice_update", {
      invoice_id: invoiceId,
      new_invoice_date: form.invoice_date || null,
      new_supplier_name: form.supplier_name || null,
      new_invoice_number: form.invoice_number || null,
      new_category: form.category || null,
      new_amount: form.amount === "" ? null : Number(form.amount),
      new_tax: form.tax === "" ? null : Number(form.tax),
      new_uploaded_file_url: form.uploaded_file_url || null,
      new_store_id: form.store_id || null,
    });

    if (error) {
      console.error("owner_invoice_update error:", error);
      alert(`Save failed: ${error.message}`);
      setSaving(false);
      return;
    }

    setSaving(false);
    alert("Saved!");
  }

  if (checkingAuth) return <div style={{ padding: 30 }}>Checking...</div>;
  if (loading) return <div style={{ padding: 30 }}>Loading invoice...</div>;

  return (
    <div style={{ padding: 30, maxWidth: 720 }}>
      <h1>Edit Invoice #{id}</h1>

      <div style={grid}>
        <Field label="Invoice Date">
          <input
            type="date"
            value={form.invoice_date}
            onChange={(e) => setForm({ ...form, invoice_date: e.target.value })}
          />
        </Field>

        <Field label="Supplier Name">
          <input
            value={form.supplier_name}
            onChange={(e) => setForm({ ...form, supplier_name: e.target.value })}
          />
        </Field>

        <Field label="Invoice Number">
          <input
            value={form.invoice_number}
            onChange={(e) => setForm({ ...form, invoice_number: e.target.value })}
          />
        </Field>

        <Field label="Category">
          <input
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
        </Field>

        <Field label="Amount">
          <input
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="e.g. 1040.81"
          />
        </Field>

        <Field label="Tax">
          <input
            value={form.tax}
            onChange={(e) => setForm({ ...form, tax: e.target.value })}
            placeholder="e.g. 0"
          />
        </Field>

        <Field label="Uploaded File URL">
          <input
            value={form.uploaded_file_url}
            onChange={(e) => setForm({ ...form, uploaded_file_url: e.target.value })}
            placeholder="(optional)"
          />
        </Field>

        <Field label="Store ID">
          <input
            value={form.store_id}
            onChange={(e) => setForm({ ...form, store_id: e.target.value })}
            placeholder="(optional)"
          />
        </Field>
      </div>

        <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button onClick={save} disabled={saving}>
            {saving ? "Saving..." : "Save"}
        </button>

        <button
            onClick={() =>
            router.push(`/owner/invoices?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
            }
        >
            ← Back to Invoices
        </button>

        <button
            onClick={async () => {
            if (!id) return;
            const ok = confirm("Delete this invoice? This cannot be undone.");
            if (!ok) return;

            const { error } = await supabase.rpc("owner_invoice_delete", {
                invoice_id: Number(id),
            });

            if (error) {
                alert(`Delete failed: ${error.message}`);
                return;
            }

            alert("Deleted.");
            router.push(`/owner/invoices?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
            }}
            style={{ background: "#ef4444", color: "white", border: "none", padding: "8px 12px", borderRadius: 6 }}
        >
            Delete
        </button>
        </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 12, color: "#64748b" }}>{label}</div>
      {children}
    </div>
  );
}

const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 14,
};
