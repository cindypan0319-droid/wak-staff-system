import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// ✅ set in .env.local
// NEXT_PUBLIC_SITE_URL=http://localhost:3000
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function hashPin(pin: string, salt: string) {
  return crypto.createHash("sha256").update(`${salt}:${pin}`).digest("hex");
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { staff_id, pin } = req.body ?? {};
    if (!staff_id || pin === undefined || pin === null) {
      return res.status(400).json({ error: "Missing staff_id or pin" });
    }

    const pinStr = String(pin);

    const p = await admin
      .from("profiles")
      .select("is_active, pin_hash, pin_salt")
      .eq("id", staff_id)
      .maybeSingle();

    if (p.error) return res.status(400).json({ error: p.error.message });
    if (!p.data) return res.status(404).json({ error: "Profile not found" });
    if (p.data.is_active !== true) return res.status(403).json({ error: "Account is inactive" });

    if (!p.data.pin_hash || !p.data.pin_salt) {
      return res.status(401).json({ error: "PIN not set. Please ask manager to set your PIN." });
    }

    const expected = hashPin(pinStr, p.data.pin_salt);
    if (expected !== p.data.pin_hash) {
      return res.status(401).json({ error: "Wrong PIN" });
    }

    // ✅ PIN OK: generate a magiclink WITHOUT sending email
    const u = await admin.auth.admin.getUserById(staff_id);
    const email = u.data?.user?.email;
    if (!email) return res.status(400).json({ error: "User email not found" });

    const link = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: {
        redirectTo: `${SITE_URL}/auth/callback`,
      },
    });

    if (link.error) return res.status(400).json({ error: link.error.message });

    const action_link = link.data.properties?.action_link;
    if (!action_link) return res.status(400).json({ error: "No action_link returned" });

    return res.status(200).json({ ok: true, action_link });
  } catch (e: any) {
    return res.status(500).json({ error: e.message ?? "Server error" });
  }
}