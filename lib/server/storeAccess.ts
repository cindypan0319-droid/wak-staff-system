import type { NextApiRequest } from "next";
import { createClient } from "@supabase/supabase-js";

const ALLOWED_STORE_IPS = ["144.139.237.2"];

export type StoreAccessRole = "STAFF" | "MANAGER" | "OWNER";
export type StoreAccessMode = "OWNER_REMOTE" | "STORE_NETWORK" | "DENIED";
export type StoreAccessDeniedReason =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_INACTIVE"
  | "PROFILE_READ_ERROR"
  | "ROLE_NOT_ALLOWED"
  | "STORE_NETWORK_REQUIRED"
  | "SERVER_ERROR";

type StoreAccessAllowed = {
  allowed: true;
  status: 200;
  actorId: string;
  role: StoreAccessRole;
  accessMode: Exclude<StoreAccessMode, "DENIED">;
  ip: string;
};

type StoreAccessDenied = {
  allowed: false;
  status: 401 | 403 | 500 | 503;
  role: StoreAccessRole | null;
  accessMode: "DENIED";
  reason: StoreAccessDeniedReason;
  ip: string;
};

export type StoreAccessDecision = StoreAccessAllowed | StoreAccessDenied;

export const serverSupabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

export function getClientIp(req: NextApiRequest) {
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

export function isStoreNetworkIp(ip: string) {
  return ALLOWED_STORE_IPS.includes(ip);
}

export async function authorizeStoreRequest(req: NextApiRequest): Promise<StoreAccessDecision> {
  const ip = getClientIp(req);
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return {
      allowed: false,
      status: 401,
      role: null,
      accessMode: "DENIED",
      reason: "AUTH_REQUIRED",
      ip,
    };
  }

  try {
    const { data: userData, error: userError } = await serverSupabaseAdmin.auth.getUser(token);
    if (userError || !userData.user) {
      return {
        allowed: false,
        status: 401,
        role: null,
        accessMode: "DENIED",
        reason: "AUTH_INVALID",
        ip,
      };
    }

    const { data: profile, error: profileError } = await serverSupabaseAdmin
      .from("profiles")
      .select("role,is_active")
      .eq("id", userData.user.id)
      .maybeSingle();

    if (profileError) {
      return {
        allowed: false,
        status: 503,
        role: null,
        accessMode: "DENIED",
        reason: "PROFILE_READ_ERROR",
        ip,
      };
    }

    if (!profile) {
      return {
        allowed: false,
        status: 403,
        role: null,
        accessMode: "DENIED",
        reason: "PROFILE_NOT_FOUND",
        ip,
      };
    }

    if (profile.is_active !== true) {
      return {
        allowed: false,
        status: 403,
        role: null,
        accessMode: "DENIED",
        reason: "PROFILE_INACTIVE",
        ip,
      };
    }

    const role = profile.role;
    if (role !== "STAFF" && role !== "MANAGER" && role !== "OWNER") {
      return {
        allowed: false,
        status: 403,
        role: null,
        accessMode: "DENIED",
        reason: "ROLE_NOT_ALLOWED",
        ip,
      };
    }

    if (role === "OWNER") {
      return {
        allowed: true,
        status: 200,
        actorId: userData.user.id,
        role,
        accessMode: "OWNER_REMOTE",
        ip,
      };
    }

    if (!isStoreNetworkIp(ip)) {
      return {
        allowed: false,
        status: 403,
        role,
        accessMode: "DENIED",
        reason: "STORE_NETWORK_REQUIRED",
        ip,
      };
    }

    return {
      allowed: true,
      status: 200,
      actorId: userData.user.id,
      role,
      accessMode: "STORE_NETWORK",
      ip,
    };
  } catch {
    return {
      allowed: false,
      status: 500,
      role: null,
      accessMode: "DENIED",
      reason: "SERVER_ERROR",
      ip,
    };
  }
}
