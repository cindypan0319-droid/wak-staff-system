import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

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
    if (!(actorRole === "OWNER" || actorRole === "MANAGER")) {
      return res.status(403).json({ error: "Owner/Manager only" });
    }

    const r = await admin
      .from("profiles")
      .select("id, full_name, preferred_name, role, is_active, pin_hash, created_at")
      .order("created_at", { ascending: true });

    if (r.error) return res.status(400).json({ error: r.error.message });

    const rows = (r.data ?? []).map((x: any) => ({
      id: x.id,
      full_name: x.full_name,
      preferred_name: x.preferred_name,
      role: x.role,
      is_active: x.is_active,
      created_at: x.created_at,
      pin_set: !!x.pin_hash,
    }));

    return res.status(200).json({ rows });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Server error" });
  }
}