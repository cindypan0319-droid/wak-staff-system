import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

function normalize(s: string) {
  return (s ?? "").trim();
}

export default function InvoicesPage() {
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [storeId] = useState("MOOROOLBARK");

  // Supplier list + mapping
  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [supplierToCategory, setSupplierToCategory] = useState<Record<string, string>>({});

  // Invoice list
  const [invoices, setInvoices] = useState<any[]>([]);

  // Invoice form
  const [supplier, setSupplier] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState(""); // empty => default 0

  // Add new supplier + category (top row)
  const [newSupplier, setNewSupplier] = useState("");
  const [newSupplierCategory, setNewSupplierCategory] = useState("");

  // Assign category to existing supplier
  const [assignSupplier, setAssignSupplier] = useState("");
  const [assignCategory, setAssignCategory] = useState("");

  const currentCategory = useMemo(() => {
    const key = normalize(supplier);
    return key ? supplierToCategory[key] ?? "" : "";
  }, [supplier, supplierToCategory]);

  async function loadSuppliersAndMap() {
    const { data, error } = await supabase
      .from("supplier_invoices")
      .select("supplier_name, category")
      .order("supplier_name", { ascending: true });

    if (error) throw error;

    const rows = (data ?? []) as any[];

    const set = new Set<string>();
    const map: Record<string, string> = {};

    for (const r of rows) {
      const name = normalize(r.supplier_name);
      if (!name) continue;

      set.add(name);

      const cat = normalize(r.category ?? "");
      if (!map[name] && cat) map[name] = cat;
    }

    const list = Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );

    setSuppliers(list);
    setSupplierToCategory(map);
  }

  async function loadInvoices() {
    setLoading(true);
    const { data, error } = await supabase
      .from("supplier_invoices")
      .select("*")
      .order("invoice_date", { ascending: false })  // 降序排列：最近的日期在前
      .limit(30);  // 只显示最近 30 条记录

    if (error) {
      console.error(error);
      setLoading(false);
      return;
    }

    setInvoices(data ?? []);
    setLoading(false);
  }

  async function init() {
    setLoading(true);
    setMsg("");
    try {
      await loadSuppliersAndMap();
      await loadInvoices();
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addNewSupplierAndCategory() {
    setMsg("");
    const name = normalize(newSupplier);
    const cat = normalize(newSupplierCategory);

    if (!name) return alert("Please enter New Supplier name.");
    if (!cat) return alert("Please enter Category for the new supplier.");

    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id ?? null;

    const { error } = await supabase.from("supplier_invoices").insert([
      {
        invoice_date: "2000-01-01",
        supplier_name: name,
        invoice_number: "__SETUP_SUPPLIER_CATEGORY__",
        amount: 0,
        tax: 0,
        category: cat,
        store_id: storeId,
        entered_by: uid,
      },
    ]);

    if (error) return alert(error.message);

    alert("Supplier + Category saved.");
    setNewSupplier("");
    setNewSupplierCategory("");
    await loadSuppliersAndMap();
    await loadInvoices();
  }

  async function assignCategoryToSupplier() {
    setMsg("");
    const name = normalize(assignSupplier);
    const cat = normalize(assignCategory);

    if (!name) {
      alert("Please choose a supplier to assign category.");
      return;
    }
    if (!cat) {
      alert("Please enter the category you want to assign.");
      return;
    }

    const supplierExists = suppliers.includes(name);

    if (!supplierExists) {
      alert("The selected supplier doesn't exist or isn't available.");
      return;
    }

    const { error } = await supabase
      .from("supplier_invoices")
      .update({ category: cat })
      .eq("supplier_name", name);

    if (error) {
      alert(error.message);
      return;
    }

    alert(`Category successfully updated for ${name}`);
    setAssignSupplier("");
    setAssignCategory("");
    await loadSuppliersAndMap();
    await loadInvoices();
  }

  async function deleteInvoice(invoiceId: string) {
    const { error } = await supabase
      .from("supplier_invoices")
      .delete()
      .eq("id", invoiceId);

    if (error) {
      alert("Error deleting invoice: " + error.message);
    } else {
      alert("Invoice deleted successfully.");
      await loadInvoices(); // Reload invoices after deletion
    }
  }

  async function editInvoice(invoice: any) {
    const { error } = await supabase
      .from("supplier_invoices")
      .update({
        invoice_date: invoice.invoice_date,
        supplier_name: invoice.supplier_name,
        invoice_number: invoice.invoice_number,
        amount: invoice.amount,
        tax: invoice.tax,
        category: invoice.category,
      })
      .eq("id", invoice.id);

    if (error) {
      alert("Error saving invoice: " + error.message);
    } else {
      alert("Invoice updated successfully.");
      await loadInvoices(); // Reload invoices after update
    }
  }

  async function createInvoice() {
    setMsg("");
    const name = normalize(supplier);

    if (!name) return alert("Please select a supplier.");
    if (!invoiceDate) return alert("Please choose invoice date.");

    const invNo = normalize(invoiceNumber);
    if (!invNo) return alert("Please enter invoice number.");

    const amt = Number(String(amount).replace(/,/g, ""));
    if (!Number.isFinite(amt) || amt <= 0) return alert("Total Amount must be a valid number (> 0).");

    const t = tax.trim() === "" ? 0 : Number(String(tax).replace(/,/g, ""));
    if (!Number.isFinite(t) || t < 0) return alert("Tax/GST must be a valid number (>= 0).");

    const cat = supplierToCategory[name] ?? "";
    if (!cat) {
      return alert("This supplier has no category.\nPlease assign category first.");
    }

    const { data: userRes } = await supabase.auth.getUser();
    const uid = userRes.user?.id ?? null;

    const { error } = await supabase.from("supplier_invoices").insert([
      {
        invoice_date: invoiceDate,
        supplier_name: name,
        invoice_number: invNo,
        amount: amt,
        tax: t,
        category: cat,
        store_id: storeId,
        entered_by: uid,
      },
    ]);

    if (error) return alert(error.message);

    alert("Invoice added!");
    setInvoiceDate("");
    setInvoiceNumber("");
    setAmount("");
    setTax("");
    await loadInvoices();
  }

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #ddd",
    fontSize: 14,
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: "#444",
    marginBottom: 6,
    fontWeight: 800,
  };

  const buttonStyle: React.CSSProperties = {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #222",
    background: "#222",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  };

  const subtleBtn: React.CSSProperties = {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: "#fff",
    color: "#111",
    fontWeight: 900,
    cursor: "pointer",
  };

  if (loading) return <div style={{ padding: 20 }}>Loading…</div>;

  return (
    <div style={{ padding: 20 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        {/* Top bar */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0 }}>Supplier Invoices</h1>
            <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
              Store: <b>{storeId}</b>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Link href="/staff/home" style={{ textDecoration: "none" }}>
              <button style={subtleBtn}>← Back to Home</button>
            </Link>
            <button style={subtleBtn} onClick={init}>
              Refresh
            </button>
          </div>
        </div>

        {msg && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              border: "1px solid #f2c2c2",
              borderRadius: 12,
              background: "#fff5f5",
            }}
          >
            {msg}
          </div>
        )}

        {/* Row A: New Supplier + New Category (横排) */}
        <div
          style={{
            marginTop: 16,
            padding: 14,
            border: "1px solid #eee",
            borderRadius: 14,
            background: "#fff",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Add New Supplier</div>

          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "1.2fr 1fr auto",
              alignItems: "end",
            }}
          >
            <div>
              <div style={labelStyle}>New Supplier</div>
              <input
                style={inputStyle}
                placeholder="e.g. Tek Foods"
                value={newSupplier}
                onChange={(e) => setNewSupplier(e.target.value)}
              />
            </div>

            <div>
              <div style={labelStyle}>New Category</div>
              <input
                style={inputStyle}
                placeholder="e.g. Meat"
                value={newSupplierCategory}
                onChange={(e) => setNewSupplierCategory(e.target.value)}
              />
            </div>

            <button style={buttonStyle} onClick={addNewSupplierAndCategory}>
              Save
            </button>
          </div>
        </div>

        {/* Row B: Assign category to existing supplier */}
        <div
          style={{
            marginTop: 12,
            padding: 14,
            border: "1px solid #eee",
            borderRadius: 14,
            background: "#fff",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Assign Category to Existing Supplier</div>

          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "1.2fr 1fr auto",
              alignItems: "end",
            }}
          >
            <div>
              <div style={labelStyle}>Supplier</div>
              <select style={inputStyle} value={assignSupplier} onChange={(e) => setAssignSupplier(e.target.value)}>
                <option value="">Select supplier…</option>
                {suppliers.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div style={labelStyle}>Category</div>
              <input
                style={inputStyle}
                placeholder="e.g. Packaging"
                value={assignCategory}
                onChange={(e) => setAssignCategory(e.target.value)}
              />
            </div>

            <button style={buttonStyle} onClick={assignCategoryToSupplier}>
              Update
            </button>
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
            This updates category for ALL invoices of that supplier (store: {storeId}).
          </div>
        </div>

        {/* Row C: Add Invoice (竖排) */}
        <div
          style={{
            marginTop: 12,
            padding: 14,
            border: "1px solid #eee",
            borderRadius: 14,
            background: "#fff",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Add Invoice</div>

          {/* ✅ supplier：可输入筛选 + 下拉（datalist），且没有额外搜索框 */}
          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>Select Supplier (type to search)</div>
            <input
              style={inputStyle}
              list="supplier_list"
              placeholder="Type a few letters…"
              value={supplier}
              onChange={(e) => setSupplier(e.target.value)}
            />
            <datalist id="supplier_list">
              {suppliers.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>

            <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
              Category: <b>{currentCategory || "-"}</b>
            </div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>Invoice Date</div>
            <input style={inputStyle} type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>Invoice Number</div>
            <input
              style={inputStyle}
              placeholder="e.g. VSIN-218061"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>Total Amount</div>
            <input
              style={inputStyle}
              placeholder="e.g. 3066.80"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <div style={labelStyle}>Tax / GST (default 0)</div>
            <input style={inputStyle} placeholder="e.g. 6.80" value={tax} onChange={(e) => setTax(e.target.value)} />
          </div>

          <button style={buttonStyle} onClick={createInvoice}>
            Add Invoice
          </button>
        </div>

        {/* List */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Invoices (latest first)</div>

          <div style={{ border: "1px solid #eee", borderRadius: 14, overflow: "hidden", background: "#fff" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f7f7f7", textAlign: "left" }}>
                    <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Date</th>
                    <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Supplier</th>
                    <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Category</th>
                    <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Invoice #</th>
                    <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Amount</th>
                    <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Tax</th>
                    <th style={{ padding: 10, borderBottom: "1px solid #eee" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((i) => (
                    <tr key={i.id}>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f1f1" }}>{i.invoice_date}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f1f1" }}>{i.supplier_name}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f1f1" }}>{i.category ?? ""}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f1f1" }}>{i.invoice_number ?? ""}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f1f1" }}>${Number(i.amount ?? 0).toFixed(2)}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f1f1" }}>${Number(i.tax ?? 0).toFixed(2)}</td>
                      <td style={{ padding: 10, borderBottom: "1px solid #f1f1f1" }}>
                        <button onClick={() => deleteInvoice(i.id)}>Delete</button>
                        <button onClick={() => editInvoice(i)}>Edit</button>
                      </td>
                    </tr>
                  ))}

                  {invoices.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ padding: 14, color: "#666" }}>
                        No invoices yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
            Setup records have invoice_number = <b>__SETUP_SUPPLIER_CATEGORY__</b> and amount=0.
          </div>
        </div>
      </div>
    </div>
  );
}