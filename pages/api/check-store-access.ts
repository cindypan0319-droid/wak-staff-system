import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const ALLOWED_STORE_IPS = ["144.139.237.2"];

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function getClientIp(req: NextApiRequest) {
  const xForwardedFor = req.headers["x-forwarded-for"];

  if (typeof xForwardedFor === "string" && xForwardedFor.length > 0) {
    return xForwardedFor.split(",")[0].trim();
  }

  if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    return xForwardedFor[0].split(",")[0].trim();
  }

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.length > 0) {
    return realIp.trim();
  }

  return req.socket.remoteAddress || "";
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const ip = getClientIp(req);

    // 本地开发直接放行
    if (process.env.NODE_ENV !== "production") {
      return res.status(200).json({
        allowed: true,
        ip,
        reason: "local-dev",
      });
    }

    const isStoreIp = ALLOWED_STORE_IPS.includes(ip);

    // 从前端带来的 access token
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

    let isOwner = false;
    let userId: string | null = null;

    if (token) {
      const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);

      if (!userError && userData.user) {
        userId = userData.user.id;

        const { data: profile, error: profileError } = await supabaseAdmin
          .from("profiles")
          .select("role")
          .eq("id", userId)
          .maybeSingle();

        if (!profileError && profile?.role === "OWNER") {
          isOwner = true;
        }
      }
    }

    const allowed = isStoreIp || isOwner;

    return res.status(200).json({
      allowed,
      ip,
      isStoreIp,
      isOwner,
      userId,
    });
  } catch (e: any) {
    return res.status(500).json({
      allowed: false,
      error: e?.message || "Server error",
    });
  }
}