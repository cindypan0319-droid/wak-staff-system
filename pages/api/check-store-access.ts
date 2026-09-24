import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";

const ALLOWED_STORE_IPS = ["144.139.237.2"];

type AllowedRole = "STAFF" | "MANAGER" | "OWNER";
type AccessMode = "OWNER_REMOTE" | "STORE_NETWORK" | "DENIED";
type DeniedReason =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_INACTIVE"
  | "PROFILE_READ_ERROR"
  | "ROLE_NOT_ALLOWED"
  | "STORE_NETWORK_REQUIRED"
  | "SERVER_ERROR";

type StoreAccessResponse = {
  allowed: boolean;
  role: AllowedRole | null;
  accessMode: AccessMode;
  reason?: DeniedReason;
  // Temporary compatibility fields for existing callers.
  isStoreDevice: boolean;
  isStoreIp: boolean;
  isOwner: boolean;
  ip: string;
};

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
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

function responseBody(
  ip: string,
  allowed: boolean,
  role: AllowedRole | null,
  accessMode: AccessMode,
  reason?: DeniedReason
): StoreAccessResponse {
  const isStoreIp = ALLOWED_STORE_IPS.includes(ip);
  return {
    allowed,
    role,
    accessMode,
    ...(reason ? { reason } : {}),
    isStoreDevice: allowed,
    isStoreIp,
    isOwner: role === "OWNER",
    ip,
  };
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<StoreAccessResponse>
) {
  const ip = getClientIp(req);
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";

  if (!token) {
    return res
      .status(401)
      .json(responseBody(ip, false, null, "DENIED", "AUTH_REQUIRED"));
  }

  try {
    const { data: userData, error: userError } =
      await supabaseAdmin.auth.getUser(token);

    if (userError || !userData.user) {
      return res
        .status(401)
        .json(responseBody(ip, false, null, "DENIED", "AUTH_INVALID"));
    }

    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("role,is_active")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (profileError) {
      return res
        .status(503)
        .json(responseBody(ip, false, null, "DENIED", "PROFILE_READ_ERROR"));
    }

    if (!profile) {
      return res
        .status(403)
        .json(responseBody(ip, false, null, "DENIED", "PROFILE_NOT_FOUND"));
    }

    if (profile.is_active !== true) {
      return res
        .status(403)
        .json(responseBody(ip, false, null, "DENIED", "PROFILE_INACTIVE"));
    }

    const role = profile.role;
    if (role !== "STAFF" && role !== "MANAGER" && role !== "OWNER") {
      return res
        .status(403)
        .json(responseBody(ip, false, null, "DENIED", "ROLE_NOT_ALLOWED"));
    }

    if (role === "OWNER") {
      return res
        .status(200)
        .json(responseBody(ip, true, role, "OWNER_REMOTE"));
    }

    if (!ALLOWED_STORE_IPS.includes(ip)) {
      return res
        .status(403)
        .json(
          responseBody(
            ip,
            false,
            role,
            "DENIED",
            "STORE_NETWORK_REQUIRED"
          )
        );
    }

    return res
      .status(200)
      .json(responseBody(ip, true, role, "STORE_NETWORK"));
  } catch {
    return res
      .status(500)
      .json(responseBody(ip, false, null, "DENIED", "SERVER_ERROR"));
  }
}
