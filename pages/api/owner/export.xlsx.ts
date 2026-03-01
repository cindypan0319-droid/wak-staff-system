import type { NextApiRequest, NextApiResponse } from "next";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { type, start, end } = req.query;

    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
    if (!type || !start || !end) return res.status(400).json({ error: "Missing type/start/end" });

    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing Authorization Bearer token" });

    // ✅ Create client that uses the user's JWT (so auth.uid() works inside RPC)
    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // ✅ Verify token is valid
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) return res.status(401).json({ error: "Invalid token" });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(String(type));

    if (type === "invoices") {
      // ✅ The RPC itself enforces OWNER access. If not owner, it will error.
      const { data: rows, error } = await supabase.rpc("owner_invoices_list", {
        start_date: String(start),
        end_date: String(end),
        row_limit: 5000,
      });

      if (error) {
        // Typically: "Access denied"
        return res.status(403).json({ error: error.message });
      }

      sheet.columns = [
        { header: "ID", key: "id", width: 10 },
        { header: "Invoice Date", key: "invoice_date", width: 14 },
        { header: "Supplier", key: "supplier_name", width: 22 },
        { header: "Invoice Number", key: "invoice_number", width: 18 },
        { header: "Category", key: "category", width: 16 },
        { header: "Amount", key: "amount", width: 12 },
        { header: "Tax", key: "tax", width: 10 },
        { header: "Created At", key: "created_at", width: 22 },
      ];

      (rows || []).forEach((r: any) => sheet.addRow(r));
    } else {
      return res.status(400).json({ error: "Unsupported export type (only invoices for now)" });
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename=${type}-${start}-${end}.xlsx`);

    const buffer = await workbook.xlsx.writeBuffer();
    return res.status(200).send(Buffer.from(buffer));
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}