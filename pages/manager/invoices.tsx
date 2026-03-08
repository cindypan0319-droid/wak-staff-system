import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "../../lib/supabaseClient";

function normalize(s: string) {
  return (s ?? "").trim();
}

type InvoiceRow = {
  id: string;
  invoice_date: string;
  supplier_name: string;
  invoice_number: string | null;
  amount: number | null;
  tax: number | null;
  category: string | null;
  store_id: string | null;
};

const WAK_BLUE = "#1E5A9E";
const WAK_RED = "#ED1C24";
const WAK_BG = "#F5F6F8";
const CARD_BG = "#FFFFFF";
const BORDER = "#E5E7EB";
const TEXT = "#111827";
const MUTED = "#6B7280";

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

function badge(label: string, kind: "green" | "yellow" | "blue" | "gray" | "red" = "gray") {
  const styles: Record<string, { bg: string; color: string }> = {
    green: { bg: "#DCFCE7", color: "#166534" },
    yellow: { bg: "#FEF3C7", color: "#92400E" },
    blue: { bg: "#EAF3FF", color: WAK_BLUE },
    gray: { bg: "#F3F4F6", color: "#374151" },
    red: { bg: "#FEE2E2", color: "#991B1B" },
  };

  return (
    <span
      style={{
        display: "inline-block",
        padding: "6px 10px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 800,
        background: styles[kind].bg,
        color: styles[kind].color,
      }}
    >
      {label}
    </span>
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

export default function InvoicesPage() {
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [storeId] = useState("MOOROOLBARK");

  const [suppliers, setSuppliers] = useState<string[]>([]);
  const [supplierToCategory, setSupplierToCategory] = useState<Record<string, string>>({});

  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);

  const [supplier, setSupplier] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [tax, setTax] = useState("");

  const [newSupplier, setNewSupplier] = useState("");
  const [newSupplierCategory, setNewSupplierCategory] = useState("");

  const [assignSupplier, setAssignSupplier] = useState("");
  const [assignCategory, setAssignCategory] = useState("");

  const [editTarget, setEditTarget] = useState<InvoiceRow | null>(null);
  const [eDate, setEDate] = useState("");
  const [eSupplier, setESupplier] = useState("");
  const [eCategory, setECategory] = useState("");
  const [eInvoiceNumber, setEInvoiceNumber] = useState("");
  const [eAmount, setEAmount] = useState("");
  const [eTax, setETax] = useState("");

  const currentCategory = useMemo(() => {
    const key = normalize(supplier);
    return key ? supplierToCategory[key] ?? "" : "";
  }, [supplier, supplierToCategory]);

  const totalSuppliers = suppliers.length;
  const suppliersWithCategory = Object.keys(supplierToCategory).filter((k) => normalize(supplierToCategory[k])).length;
  const latestInvoiceCount = invoices.length;

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
    const { data, error } = await supabase
      .from("supplier_invoices")
      .select("*")
      .order("invoice_date", { ascending: false })
      .limit(30);

    if (error) throw error;

    setInvoices((data ?? []) as InvoiceRow[]);
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

    if (!name) {
      setMsg("❌ Please enter new supplier name.");
      return;
    }
    if (!cat) {
      setMsg("❌ Please enter category for the new supplier.");
      return;
    }

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

    if (error) {
      setMsg("❌ " + error.message);
      return;
    }

    setMsg("✅ Supplier + category saved.");
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
      setMsg("❌ Please choose a supplier to assign category.");
      return;
    }
    if (!cat) {
      setMsg("❌ Please enter the category you want to assign.");
      return;
    }

    const supplierExists = suppliers.includes(name);

    if (!supplierExists) {
      setMsg("❌ The selected supplier doesn't exist or isn't available.");
      return;
    }

    const { error } = await supabase
      .from("supplier_invoices")
      .update({ category: cat })
      .eq("supplier_name", name);

    if (error) {
      setMsg("❌ " + error.message);
      return;
    }

    setMsg(`✅ Category updated for ${name}.`);
    setAssignSupplier("");
    setAssignCategory("");
    await loadSuppliersAndMap();
    await loadInvoices();
  }

  async function deleteInvoice(invoiceId: string) {
    const ok = confirm("Delete this invoice?");
    if (!ok) return;

    const { error } = await supabase
      .from("supplier_invoices")
      .delete()
      .eq("id", invoiceId);

    if (error) {
      setMsg("❌ Error deleting invoice: " + error.message);
      return;
    }

    setMsg("✅ Invoice deleted.");
    await loadInvoices();
  }

  function openEditModal(invoice: InvoiceRow) {
    setEditTarget(invoice);
    setEDate(invoice.invoice_date ?? "");
    setESupplier(invoice.supplier_name ?? "");
    setECategory(invoice.category ?? "");
    setEInvoiceNumber(invoice.invoice_number ?? "");
    setEAmount(String(invoice.amount ?? ""));
    setETax(String(invoice.tax ?? ""));
  }

  async function saveEditInvoice() {
    if (!editTarget) return;

    const name = normalize(eSupplier);
    const invNo = normalize(eInvoiceNumber);
    const cat = normalize(eCategory);

    if (!name) {
      setMsg("❌ Supplier is required.");
      return;
    }
    if (!eDate) {
      setMsg("❌ Invoice date is required.");
      return;
    }
    if (!invNo) {
      setMsg("❌ Invoice number is required.");
      return;
    }

    const amt = Number(String(eAmount).replace(/,/g, ""));
    if (!Number.isFinite(amt) || amt < 0) {
      setMsg("❌ Amount must be a valid number (>= 0).");
      return;
    }

    const t = eTax.trim() === "" ? 0 : Number(String(eTax).replace(/,/g, ""));
    if (!Number.isFinite(t) || t < 0) {
      setMsg("❌ Tax must be a valid number (>= 0).");
      return;
    }

    const { error } = await supabase
      .from("supplier_invoices")
      .update({
        invoice_date: eDate,
        supplier_name: name,
        invoice_number: invNo,
        amount: amt,
        tax: t,
        category: cat || null,
      })
      .eq("id", editTarget.id);

    if (error) {
      setMsg("❌ Error saving invoice: " + error.message);
      return;
    }

    setMsg("✅ Invoice updated.");
    setEditTarget(null);
    await loadSuppliersAndMap();
    await loadInvoices();
  }

  async function createInvoice() {
    setMsg("");
    const name = normalize(supplier);

    if (!name) {
      setMsg("❌ Please select a supplier.");
      return;
    }
    if (!invoiceDate) {
      setMsg("❌ Please choose invoice date.");
      return;
    }

    const invNo = normalize(invoiceNumber);
    if (!invNo) {
      setMsg("❌ Please enter invoice number.");
      return;
    }

    const amt = Number(String(amount).replace(/,/g, ""));
    if (!Number.isFinite(amt) || amt <= 0) {
      setMsg("❌ Total amount must be a valid number (> 0).");
      return;
    }

    const t = tax.trim() === "" ? 0 : Number(String(tax).replace(/,/g, ""));
    if (!Number.isFinite(t) || t < 0) {
      setMsg("❌ Tax / GST must be a valid number (>= 0).");
      return;
    }

    const cat = supplierToCategory[name] ?? "";
    if (!cat) {
      setMsg("❌ This supplier has no category. Please assign category first.");
      return;
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

    if (error) {
      setMsg("❌ " + error.message);
      return;
    }

    setMsg("✅ Invoice added.");
    setInvoiceDate("");
    setInvoiceNumber("");
    setAmount("");
    setTax("");
    await loadInvoices();
  }

  if (loading) {
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
            <h1 style={{ margin: 0, color: TEXT }}>Invoices</h1>
            <div style={{ marginTop: 10, color: MUTED }}>Loading...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: WAK_BG, minHeight: "100vh", padding: 20 }}>
      {editTarget && (
        <>
          <div
            onClick={() => setEditTarget(null)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.25)",
              zIndex: 999,
            }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(620px, calc(100vw - 32px))",
              background: "#fff",
              border: `1px solid ${BORDER}`,
              borderRadius: 18,
              padding: 20,
              zIndex: 1000,
              boxShadow: "0 18px 40px rgba(0,0,0,0.18)",
            }}
          >
            <h2 style={{ marginTop: 0, color: TEXT }}>Edit Invoice</h2>

            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Invoice date</div>
                <input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} style={inputStyle("100%")} />
              </div>

              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Supplier</div>
                <input value={eSupplier} onChange={(e) => setESupplier(e.target.value)} style={inputStyle("100%")} />
              </div>

              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Category</div>
                <input value={eCategory} onChange={(e) => setECategory(e.target.value)} style={inputStyle("100%")} />
              </div>

              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Invoice number</div>
                <input value={eInvoiceNumber} onChange={(e) => setEInvoiceNumber(e.target.value)} style={inputStyle("100%")} />
              </div>

              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Amount</div>
                <input value={eAmount} onChange={(e) => setEAmount(e.target.value)} style={inputStyle("100%")} />
              </div>

              <div>
                <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Tax / GST</div>
                <input value={eTax} onChange={(e) => setETax(e.target.value)} style={inputStyle("100%")} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
              {actionButton("Save Changes", saveEditInvoice, { primary: true })}
              {actionButton("Cancel", () => setEditTarget(null))}
            </div>
          </div>
        </>
      )}

      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ marginBottom: 12 }}>
          <Link href="/staff/home" style={{ textDecoration: "none" }}>
            {actionButton("← Back to Home", () => {})}
          </Link>
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
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "flex-start",
            }}
          >
            <div>
              <h1 style={{ margin: 0, color: TEXT }}>Invoices</h1>
              <div style={{ marginTop: 6, color: MUTED }}>
                Manage suppliers, categories and invoice records
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: MUTED }}>
                Store: <b>{storeId}</b>
              </div>
            </div>

            <div>{actionButton("Refresh", init)}</div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "#F9FAFB",
              border: `1px solid ${BORDER}`,
              minWidth: 160,
            }}
          >
            <div style={{ fontSize: 12, color: MUTED }}>Total suppliers</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: TEXT }}>{totalSuppliers}</div>
          </div>

          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "#F9FAFB",
              border: `1px solid ${BORDER}`,
              minWidth: 160,
            }}
          >
            <div style={{ fontSize: 12, color: MUTED }}>Suppliers with category</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: WAK_BLUE }}>{suppliersWithCategory}</div>
          </div>

          <div
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              background: "#F9FAFB",
              border: `1px solid ${BORDER}`,
              minWidth: 160,
            }}
          >
            <div style={{ fontSize: 12, color: MUTED }}>Latest invoices loaded</div>
            <div style={{ fontWeight: 800, fontSize: 18, color: WAK_RED }}>{latestInvoiceCount}</div>
          </div>
        </div>

        {msg && (
          <div
            style={{
              marginBottom: 16,
              padding: 12,
              border: `1px solid ${BORDER}`,
              borderRadius: 12,
              background: "#fff",
              color: TEXT,
            }}
          >
            {msg}
          </div>
        )}

        <div
          style={{
            marginBottom: 16,
            padding: 18,
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: "#fff",
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 12, color: TEXT }}>Add New Supplier</div>

          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "1.2fr 1fr auto",
              alignItems: "end",
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, fontWeight: 800 }}>New Supplier</div>
              <input
                style={inputStyle("100%")}
                placeholder="e.g. Tek Foods"
                value={newSupplier}
                onChange={(e) => setNewSupplier(e.target.value)}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, fontWeight: 800 }}>New Category</div>
              <input
                style={inputStyle("100%")}
                placeholder="e.g. Meat"
                value={newSupplierCategory}
                onChange={(e) => setNewSupplierCategory(e.target.value)}
              />
            </div>

            {actionButton("Save", addNewSupplierAndCategory, { primary: true })}
          </div>
        </div>

        <div
          style={{
            marginBottom: 16,
            padding: 18,
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: "#fff",
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 12, color: TEXT }}>
            Assign Category to Existing Supplier
          </div>

          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "1.2fr 1fr auto",
              alignItems: "end",
            }}
          >
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, fontWeight: 800 }}>Supplier</div>
              <select style={inputStyle("100%")} value={assignSupplier} onChange={(e) => setAssignSupplier(e.target.value)}>
                <option value="">Select supplier…</option>
                {suppliers.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, fontWeight: 800 }}>Category</div>
              <input
                style={inputStyle("100%")}
                placeholder="e.g. Packaging"
                value={assignCategory}
                onChange={(e) => setAssignCategory(e.target.value)}
              />
            </div>

            {actionButton("Update", assignCategoryToSupplier, { primary: true })}
          </div>

          <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
            This updates category for all invoices of that supplier in store {storeId}.
          </div>
        </div>

        <div
          style={{
            marginBottom: 16,
            padding: 18,
            border: `1px solid ${BORDER}`,
            borderRadius: 18,
            background: "#fff",
            boxShadow: "0 8px 24px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ fontWeight: 900, marginBottom: 12, color: TEXT }}>Add Invoice</div>

          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, fontWeight: 800 }}>
              Select Supplier (type to search)
            </div>
            <input
              style={inputStyle("100%")}
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

            <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
              Category: <b style={{ color: TEXT }}>{currentCategory || "-"}</b>
            </div>
          </div>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, fontWeight: 800 }}>Invoice Date</div>
              <input style={inputStyle("100%")} type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, fontWeight: 800 }}>Invoice Number</div>
              <input
                style={inputStyle("100%")}
                placeholder="e.g. VSIN-218061"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, fontWeight: 800 }}>Total Amount</div>
              <input
                style={inputStyle("100%")}
                placeholder="e.g. 3066.80"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 6, fontWeight: 800 }}>Tax / GST (default 0)</div>
              <input
                style={inputStyle("100%")}
                placeholder="e.g. 6.80"
                value={tax}
                onChange={(e) => setTax(e.target.value)}
              />
            </div>
          </div>

          <div style={{ marginTop: 14 }}>{actionButton("Add Invoice", createInvoice, { primary: true })}</div>
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
          <div style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 22, color: TEXT }}>Invoice List</h2>
            <div style={{ marginTop: 6, fontSize: 13, color: MUTED }}>Latest first</div>
          </div>

          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 14, overflow: "hidden", background: "#fff" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13, minWidth: 920 }}>
                <thead>
                  <tr style={{ background: "#FAFAFA", textAlign: "left" }}>
                    {["Date", "Supplier", "Category", "Invoice #", "Amount", "Tax", "Action"].map((head) => (
                      <th
                        key={head}
                        style={{
                          padding: 12,
                          borderBottom: `1px solid ${BORDER}`,
                          color: MUTED,
                          fontSize: 13,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((i) => {
                    const isSetup = i.invoice_number === "__SETUP_SUPPLIER_CATEGORY__" && Number(i.amount ?? 0) === 0;

                    return (
                      <tr key={i.id} style={{ opacity: isSetup ? 0.78 : 1 }}>
                        <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: TEXT }}>{i.invoice_date}</td>
                        <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: TEXT, fontWeight: 700 }}>
                          {i.supplier_name}
                        </td>
                        <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <span>{i.category ?? ""}</span>
                            {isSetup ? badge("SETUP", "blue") : null}
                          </div>
                        </td>
                        <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: TEXT }}>{i.invoice_number ?? ""}</td>
                        <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                          ${Number(i.amount ?? 0).toFixed(2)}
                        </td>
                        <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, color: TEXT }}>
                          ${Number(i.tax ?? 0).toFixed(2)}
                        </td>
                        <td style={{ padding: 12, borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap" }}>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {actionButton("Edit", () => openEditModal(i))}
                            {actionButton("Delete", () => deleteInvoice(i.id), { danger: true })}
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {invoices.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ padding: 14, color: MUTED }}>
                        No invoices yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
            Setup records use invoice number <b>__SETUP_SUPPLIER_CATEGORY__</b> and amount = 0.
          </div>
        </div>
      </div>
    </div>
  );
}