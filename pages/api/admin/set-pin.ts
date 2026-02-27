import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function hashPin(pin: string, salt: string) {
  return crypto.createHash("sha256").update(`${salt}:${pin}`).digest("hex");
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

    const actor = await admin.from("profiles").select("role, is_active").eq("id", actorId).maybeSingle();
    if (actor.error) return res.status(400).json({ error: actor.error.message });

    const actorRole = (actor.data as any)?.role;
    const actorActive = (actor.data as any)?.is_active === true;

    if (!actorActive) return res.status(403).json({ error: "Your account is inactive" });
    if (!(actorRole === "OWNER" || actorRole === "MANAGER")) return res.status(403).json({ error: "Owner/Manager only" });

    const { staff_id, pin } = req.body ?? {};
    if (!staff_id || pin === undefined || pin === null) return res.status(400).json({ error: "Missing staff_id or pin" });

    const pinStr = String(pin);
    if (pinStr.length < 1) return res.status(400).json({ error: "PIN cannot be empty" });

    // Manager cannot change OWNER
    if (actorRole === "MANAGER") {
      const target = await admin.from("profiles").select("role").eq("id", staff_id).maybeSingle();
      const targetRole = (target.data as any)?.role;
      if (targetRole === "OWNER") return res.status(403).json({ error: "Manager cannot change OWNER PIN" });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const pin_hash = hashPin(pinStr, salt);

    const up = await admin.from("profiles").update({ pin_salt: salt, pin_hash }).eq("id", staff_id);
    if (up.error) return res.status(400).json({ error: up.error.message });

    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Server error" });
  }
}