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

type ClockOutReason =
  | StoreAccessDeniedReason
  | "METHOD_NOT_ALLOWED"
  | "EXPECTED_CLOCK_ID_REQUIRED"
  | "OPEN_CLOCK_NOT_FOUND"
  | "CLOCK_STATE_CHANGED"
  | "SERVER_ERROR";

type ClockOutResponse = { ok: true; clock: ClockData } | { ok: false; reason: ClockOutReason };

function rpcReason(message: string | undefined): ClockOutReason | null {
  if (message?.includes("OPEN_CLOCK_NOT_FOUND")) return "OPEN_CLOCK_NOT_FOUND";
  if (message?.includes("CLOCK_STATE_CHANGED")) return "CLOCK_STATE_CHANGED";
  if (message?.includes("PROFILE_NOT_FOUND")) return "PROFILE_NOT_FOUND";
  if (message?.includes("PROFILE_INACTIVE")) return "PROFILE_INACTIVE";
  if (message?.includes("ROLE_NOT_ALLOWED")) return "ROLE_NOT_ALLOWED";
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ClockOutResponse>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, reason: "METHOD_NOT_ALLOWED" });
  }

  const access = await authorizeStoreRequest(req);
  if (!access.allowed) {
    return res.status(access.status).json({ ok: false, reason: access.reason });
  }

  const expectedClockId = req.body?.expected_clock_id;
  if (
    (typeof expectedClockId !== "number" && typeof expectedClockId !== "string") ||
    !/^\d+$/.test(String(expectedClockId))
  ) {
    return res.status(400).json({ ok: false, reason: "EXPECTED_CLOCK_ID_REQUIRED" });
  }

  const { data, error } = await serverSupabaseAdmin.rpc("wak_clock_out_for_actor", {
    p_actor: access.actorId,
    p_expected_clock_id: String(expectedClockId),
  });

  if (error) {
    const reason = rpcReason(error.message);
    if (reason === "OPEN_CLOCK_NOT_FOUND" || reason === "CLOCK_STATE_CHANGED") {
      return res.status(409).json({ ok: false, reason });
    }
    if (reason) return res.status(403).json({ ok: false, reason });
    console.error("TIME_CLOCK_OUT_RPC_ERROR", { code: error.code });
    return res.status(500).json({ ok: false, reason: "SERVER_ERROR" });
  }

  return res.status(200).json({ ok: true, clock: data as ClockData });
}
