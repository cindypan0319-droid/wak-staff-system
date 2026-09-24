import type { NextApiRequest, NextApiResponse } from "next";
import {
  authorizeStoreRequest,
  isStoreNetworkIp,
  type StoreAccessDeniedReason,
  type StoreAccessMode,
  type StoreAccessRole,
} from "../../lib/server/storeAccess";

type StoreAccessResponse = {
  allowed: boolean;
  role: StoreAccessRole | null;
  accessMode: StoreAccessMode;
  reason?: StoreAccessDeniedReason;
  // Temporary compatibility fields for existing callers.
  isStoreDevice: boolean;
  isStoreIp: boolean;
  isOwner: boolean;
  ip: string;
};

function responseBody(
  ip: string,
  allowed: boolean,
  role: StoreAccessRole | null,
  accessMode: StoreAccessMode,
  reason?: StoreAccessDeniedReason
): StoreAccessResponse {
  const isStoreIp = isStoreNetworkIp(ip);
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
  const decision = await authorizeStoreRequest(req);
  return res.status(decision.status).json(
    responseBody(
      decision.ip,
      decision.allowed,
      decision.role,
      decision.accessMode,
      decision.allowed ? undefined : decision.reason
    )
  );
}
