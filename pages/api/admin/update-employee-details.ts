import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    const who = await admin.auth.getUser(token);
    const actorId = who.data?.user?.id;
    if (!actorId) return res.status(401).json({ error: "Invalid token" });

    const actor = await admin.from("profiles").select("role,is_active").eq("id", actorId).maybeSingle();
    if (actor.error) return res.status(400).json({ error: actor.error.message });

    const actorRole = (actor.data as any)?.role;
    const actorActive = (actor.data as any)?.is_active === true;

    if (!actorActive) return res.status(403).json({ error: "Your account is inactive" });
    if (!(actorRole === "OWNER" || actorRole === "MANAGER")) return res.status(403).json({ error: "Owner/Manager only" });

    const {
      staff_id,
      birth_date,
      phone,
      email,
      address,
      tfn,
      super_text,
      emergency_contact_name,
      emergency_contact_phone,
    } = req.body ?? {};

    if (!staff_id) return res.status(400).json({ error: "Missing staff_id" });

    // Manager cannot edit OWNER details
    if (actorRole === "MANAGER") {
      const target = await admin.from("profiles").select("role").eq("id", staff_id).maybeSingle();
      const targetRole = (target.data as any)?.role;
      if (targetRole === "OWNER") return res.status(403).json({ error: "Manager cannot edit OWNER details" });
    }

    const payload = {
      staff_id: String(staff_id),
      birth_date: birth_date ? String(birth_date) : null,
      phone: phone ? String(phone) : null,
      email: email ? String(email) : null,
      address: address ? String(address) : null,
      tfn: tfn ? String(tfn) : null,
      super_text: super_text ? String(super_text) : null,
      emergency_contact_name: emergency_contact_name ? String(emergency_contact_name) : null,
      emergency_contact_phone: emergency_contact_phone ? String(emergency_contact_phone) : null,
    };

    const up = await admin.from("employee_details").upsert(payload, { onConflict: "staff_id" } as any);
    if (up.error) return res.status(400).json({ error: up.error.message });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Server error" });
  }
}