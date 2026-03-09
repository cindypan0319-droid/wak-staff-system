import type { NextApiRequest, NextApiResponse } from "next";

const ALLOWED_STORE_IPS = ["144.139.237.2"];

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

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const ip = getClientIp(req);
  const allowed = ALLOWED_STORE_IPS.includes(ip);

  res.status(200).json({
    allowed,
    ip,
  });
}