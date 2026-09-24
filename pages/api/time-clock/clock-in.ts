import type { NextApiRequest, NextApiResponse } from "next";
import {
  authorizeStoreRequest,
  serverSupabaseAdmin,
  type StoreAccessDeniedReason,
} from "../../../lib/server/storeAccess";

type ClockData = {
  id: number;
  staff_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  device_tag: string;
};

type ClockInResponse =
  | { ok: true; clock: ClockData }
  | {
      ok: false;
      reason: StoreAccessDeniedReason | "METHOD_NOT_ALLOWED" | "ALREADY_CLOCKED_IN" | "SERVER_ERROR";
    };

function rpcReason(message: string | undefined) {
  if (message?.includes("ALREADY_CLOCKED_IN")) return "ALREADY_CLOCKED_IN" as const;
  if (message?.includes("PROFILE_NOT_FOUND")) return "PROFILE_NOT_FOUND" as const;
  if (message?.includes("PROFILE_INACTIVE")) return "PROFILE_INACTIVE" as const;
  if (message?.includes("ROLE_NOT_ALLOWED")) return "ROLE_NOT_ALLOWED" as const;
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ClockInResponse>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, reason: "METHOD_NOT_ALLOWED" });
  }

  const access = await authorizeStoreRequest(req);
  if (!access.allowed) {
    return res.status(access.status).json({ ok: false, reason: access.reason });
  }

  const deviceTag = access.accessMode === "OWNER_REMOTE" ? "OWNER_REMOTE" : "STORE_NETWORK";
  const { data, error } = await serverSupabaseAdmin.rpc("wak_clock_in_for_actor", {
    p_actor: access.actorId,
    p_device_tag: deviceTag,
  });

  if (error) {
    const reason = rpcReason(error.message);
    if (reason === "ALREADY_CLOCKED_IN") return res.status(409).json({ ok: false, reason });
    if (reason) return res.status(403).json({ ok: false, reason });
    console.error("TIME_CLOCK_IN_RPC_ERROR", { code: error.code });
    return res.status(500).json({ ok: false, reason: "SERVER_ERROR" });
  }

  return res.status(200).json({ ok: true, clock: data as ClockData });
}
