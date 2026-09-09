import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { generateSingleLoginToken } from "../../../lib/server/authCredentials";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    const who = await admin.auth.getUser(token);
    const actorId = who.data?.user?.id;
    if (!actorId) return res.status(401).json({ error: "Invalid token" });

    const profileResult = await admin
      .from("profiles")
      .select("role, is_active")
      .eq("id", actorId)
      .maybeSingle();

    if (profileResult.error) {
      return res.status(400).json({ error: profileResult.error.message });
    }

    const actorRole = profileResult.data?.role;
    const actorActive = profileResult.data?.is_active === true;

    if (!actorActive) return res.status(403).json({ error: "Your account is inactive" });
    if (!(actorRole === "OWNER" || actorRole === "MANAGER")) {
      return res.status(403).json({ error: "Owner/Manager only" });
    }

    const singleLoginToken = generateSingleLoginToken();
    const updateResult = await admin
      .from("profiles")
      .update({ single_login_token: singleLoginToken })
      .eq("id", actorId)
      .select("id")
      .single();

    if (updateResult.error) {
      return res.status(400).json({ error: "Could not start admin session" });
    }

    return res.status(200).json({
      ok: true,
      single_login_token: singleLoginToken,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Server error";
    return res.status(500).json({ error: message });
  }
}
