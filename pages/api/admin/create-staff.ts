import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function safeSlug(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    const who = await admin.auth.getUser(token);
    const actorId = who.data?.user?.id;
    if (!actorId) return res.status(401).json({ error: "Invalid token" });

    const pr = await admin.from("profiles").select("role,is_active").eq("id", actorId).maybeSingle();
    if (pr.error) return res.status(400).json({ error: pr.error.message });

    const actorRole = (pr.data as any)?.role;
    const actorActive = (pr.data as any)?.is_active === true;
    if (!actorActive) return res.status(403).json({ error: "Your account is inactive" });
    if (!(actorRole === "OWNER" || actorRole === "MANAGER")) return res.status(403).json({ error: "Owner/Manager only" });

    const { full_name, preferred_name, role } = req.body ?? {};
    if (!full_name || !preferred_name || !role) return res.status(400).json({ error: "Missing fields" });

    const newRole = String(role).toUpperCase();
    if (!["STAFF", "MANAGER", "OWNER"].includes(newRole)) return res.status(400).json({ error: "Invalid role" });

    // Manager cannot create OWNER
    if (actorRole === "MANAGER" && newRole === "OWNER") {
      return res.status(403).json({ error: "Manager cannot create OWNER" });
    }

    const base = safeSlug(preferred_name || full_name);
    const fakeEmail = `${base}-${Date.now()}@wok.local`;

    // Create auth user (password can be anything, we don't use it for PIN anymore)
    const created = await admin.auth.admin.createUser({
      email: fakeEmail,
      password: "TempPass123!", // never shown to staff
      email_confirm: true,
    });

    if (created.error) return res.status(400).json({ error: created.error.message });

    const newId = created.data.user?.id;
    if (!newId) return res.status(400).json({ error: "User id missing" });

    const up = await admin.from("profiles").upsert(
      {
        id: newId,
        full_name: String(full_name),
        preferred_name: String(preferred_name),
        role: newRole,
        is_active: true,
      },
      { onConflict: "id" } as any
    );

    if (up.error) return res.status(400).json({ error: up.error.message });

    // optional: create employee_details empty row if you use it
    await admin.from("employee_details").upsert({ staff_id: newId }, { onConflict: "staff_id" } as any);

    return res.status(200).json({ ok: true, staff_id: newId });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Server error" });
  }
}