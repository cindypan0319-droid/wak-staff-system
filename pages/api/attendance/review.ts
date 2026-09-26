import type { NextApiRequest, NextApiResponse } from "next";
import {
  authorizeStoreRequest,
  serverSupabaseAdmin,
  type StoreAccessDeniedReason,
} from "../../../lib/server/storeAccess";

type ReviewReason = "CONFIRMED_ACTUAL_WORK" | "CORRECTED_TIME" | "OTHER";
type ErrorReason =
  | StoreAccessDeniedReason
  | "METHOD_NOT_ALLOWED"
  | "ROLE_NOT_ALLOWED"
  | "INVALID_INPUT"
  | "ATTENDANCE_REVIEW_CONFLICT"
  | "ATTENDANCE_REVIEW_PAYABLE_OVERLAP"
  | "SERVER_ERROR";
type ApiResponse = { ok: true; result: Record<string, unknown> } | { ok: false; reason: ErrorReason };

function positiveInteger(value: unknown) {
  return (typeof value === "number" || typeof value === "string") && /^\d+$/.test(String(value))
    ? String(value)
    : null;
}

function timestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function rpcReason(message: string | undefined) {
  const reasons = [
    "ATTENDANCE_REVIEW_CONFLICT",
    "ATTENDANCE_REVIEW_PAYABLE_OVERLAP",
    "ATTENDANCE_REVIEW_INVALID_ACTUAL_RANGE",
    "ATTENDANCE_REVIEW_INVALID_PAYABLE_RANGE",
    "ATTENDANCE_REVIEW_PAYABLE_OUTSIDE_ACTUAL",
    "ATTENDANCE_REVIEW_CROSSES_MELBOURNE_MIDNIGHT",
    "ATTENDANCE_REVIEW_REASON_REQUIRED",
    "ATTENDANCE_REVIEW_OTHER_NOTE_REQUIRED",
    "ATTENDANCE_REVIEW_SHIFT_NOT_FOUND",
    "ATTENDANCE_REVIEW_SHIFT_STORE_MISMATCH",
    "ATTENDANCE_REVIEW_SHIFT_STAFF_MISMATCH",
    "ATTENDANCE_REVIEW_WORK_PERIOD_NOT_FOUND",
    "ATTENDANCE_REVIEW_VOIDED",
    "ATTENDANCE_REVIEW_ACTOR_INACTIVE_OR_MISSING",
    "ATTENDANCE_REVIEW_ACTOR_NOT_AUTHORIZED",
    "ATTENDANCE_REVIEW_STORE_NOT_SUPPORTED",
  ] as const;
  return reasons.find((reason) => message?.includes(reason)) ?? null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResponse>) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, reason: "METHOD_NOT_ALLOWED" });
  }
  const access = await authorizeStoreRequest(req);
  if (!access.allowed) return res.status(access.status).json({ ok: false, reason: access.reason });
  if (access.role !== "MANAGER" && access.role !== "OWNER") {
    return res.status(403).json({ ok: false, reason: "ROLE_NOT_ALLOWED" });
  }

  const body = req.body ?? {};
  const workPeriodId = positiveInteger(body.work_period_id);
  const expectedVersionId = positiveInteger(body.expected_version_id);
  const matchedShiftId = body.matched_shift_id === null ? null : positiveInteger(body.matched_shift_id);
  const actualStart = timestamp(body.actual_start_at);
  const actualEnd = timestamp(body.actual_end_at);
  const payableStart = timestamp(body.payable_start_at);
  const payableEnd = timestamp(body.payable_end_at);
  const reasonCode = body.reason_code as ReviewReason;
  const reasonNote = body.reason_note === null || body.reason_note === undefined ? null : body.reason_note;
  if (!workPeriodId || !expectedVersionId || (body.matched_shift_id !== null && !matchedShiftId)
      || !actualStart || !actualEnd || !payableStart || !payableEnd
      || !["CONFIRMED_ACTUAL_WORK", "CORRECTED_TIME", "OTHER"].includes(reasonCode)
      || (reasonNote !== null && typeof reasonNote !== "string")
      || (reasonCode === "OTHER" && (!reasonNote || !reasonNote.trim()))) {
    return res.status(400).json({ ok: false, reason: "INVALID_INPUT" });
  }

  const { data, error } = await serverSupabaseAdmin.rpc("wak_review_work_period", {
    p_work_period_id: workPeriodId,
    p_expected_version_id: expectedVersionId,
    p_actor: access.actorId,
    p_matched_shift_id: matchedShiftId,
    p_actual_start_at: actualStart,
    p_actual_end_at: actualEnd,
    p_payable_start_at: payableStart,
    p_payable_end_at: payableEnd,
    p_reason_code: reasonCode,
    p_reason_note: reasonNote,
  });
  if (error) {
    const reason = rpcReason(error.message);
    if (reason === "ATTENDANCE_REVIEW_CONFLICT" || reason === "ATTENDANCE_REVIEW_PAYABLE_OVERLAP") {
      return res.status(409).json({ ok: false, reason });
    }
    if (reason?.includes("ACTOR") || reason === "ATTENDANCE_REVIEW_STORE_NOT_SUPPORTED") {
      return res.status(403).json({ ok: false, reason: "ROLE_NOT_ALLOWED" });
    }
    if (reason) return res.status(400).json({ ok: false, reason: "INVALID_INPUT" });
    console.error("ATTENDANCE_REVIEW_RPC_ERROR", { code: error.code });
    return res.status(500).json({ ok: false, reason: "SERVER_ERROR" });
  }
  return res.status(200).json({ ok: true, result: data as Record<string, unknown> });
}
