import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [supplier, setSupplier] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [storeId] = useState("MOOROOLBARK");

  async function loadInvoices() {
    const { data } = await supabase
      .from("supplier_invoices")
      .select("*")
      .order("invoice_date", { ascending: false });

    if (data) setInvoices(data);
  }

  useEffect(() => {
    loadInvoices();
  }, []);

  async function createInvoice() {
    const { error } = await supabase.from("supplier_invoices").insert([
      {
        invoice_date: invoiceDate,
        supplier_name: supplier,
        invoice_number: invoiceNumber,
        amount: Number(amount),
        category,
        store_id: storeId,
        entered_by: (await supabase.auth.getUser()).data.user?.id,
      },
    ]);

    if (error) alert(error.message);
    else {
      alert("Invoice added!");
      loadInvoices();
    }
  }

  return (
    <div style={{ padding: 20 }}>
      <h1>Supplier Invoices</h1>

      <input
        placeholder="Supplier"
        value={supplier}
        onChange={(e) => setSupplier(e.target.value)}
      />
      <input
        type="date"
        value={invoiceDate}
        onChange={(e) => setInvoiceDate(e.target.value)}
      />
      <input
        placeholder="Invoice Number"
        value={invoiceNumber}
        onChange={(e) => setInvoiceNumber(e.target.value)}
      />
      <input
        placeholder="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <input
        placeholder="Category"
        value={category}
        onChange={(e) => setCategory(e.target.value)}
      />

      <button onClick={createInvoice}>Add Invoice</button>

      <hr />

      {invoices.map((i) => (
        <div key={i.id}>
          {i.invoice_date} | {i.supplier_name} | ${i.amount}
        </div>
      ))}
    </div>
  );
}