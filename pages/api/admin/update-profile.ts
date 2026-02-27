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

    const pr = await admin.from("profiles").select("role,is_active").eq("id", actorId).maybeSingle();
    if (pr.error) return res.status(400).json({ error: pr.error.message });

    const actorRole = (pr.data as any)?.role;
    const actorActive = (pr.data as any)?.is_active === true;
    if (!actorActive) return res.status(403).json({ error: "Your account is inactive" });
    if (!(actorRole === "OWNER" || actorRole === "MANAGER")) return res.status(403).json({ error: "Owner/Manager only" });

    const { staff_id, full_name, preferred_name, role, is_active } = req.body ?? {};
    if (!staff_id) return res.status(400).json({ error: "Missing staff_id" });

    const target = await admin.from("profiles").select("role").eq("id", staff_id).maybeSingle();
    const targetRole = (target.data as any)?.role;

    // Manager cannot modify OWNER
    if (actorRole === "MANAGER" && targetRole === "OWNER") {
      return res.status(403).json({ error: "Manager cannot modify OWNER" });
    }

    // Role change validation
    let newRole: string | undefined = undefined;
    if (role !== undefined && role !== null && role !== "") {
      newRole = String(role).toUpperCase();
      if (!["STAFF", "MANAGER", "OWNER"].includes(newRole)) return res.status(400).json({ error: "Invalid role" });

      // Manager cannot set someone to OWNER
      if (actorRole === "MANAGER" && newRole === "OWNER") {
        return res.status(403).json({ error: "Manager cannot set OWNER role" });
      }
    }

    const patch: any = {};
    if (full_name !== undefined) patch.full_name = full_name === "" ? null : String(full_name);
    if (preferred_name !== undefined) patch.preferred_name = preferred_name === "" ? null : String(preferred_name);
    if (newRole) patch.role = newRole;
    if (is_active !== undefined) patch.is_active = !!is_active;

    const up = await admin.from("profiles").update(patch).eq("id", staff_id);
    if (up.error) return res.status(400).json({ error: up.error.message });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Server error" });
  }
}