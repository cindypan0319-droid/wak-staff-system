import type { NextApiRequest, NextApiResponse } from "next";
import {
  authorizeStoreRequest,
  serverSupabaseAdmin,
  type StoreAccessDeniedReason,
} from "../../../lib/server/storeAccess";

const STORE_ID = "MOOROOLBARK";
const DAY_MS = 86_400_000;

type ErrorReason =
  | StoreAccessDeniedReason
  | "METHOD_NOT_ALLOWED"
  | "ROLE_NOT_ALLOWED"
  | "INVALID_DATE_RANGE"
  | "DATE_RANGE_TOO_LARGE"
  | "SERVER_ERROR";

type ApiResponse =
  | { ok: true; records: Record<string, unknown>[]; staffOptions: Record<string, unknown>[] }
  | { ok: false; reason: ErrorReason };

function parseDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function dateText(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateText(date);
}

function thursdayFor(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  const distance = (date.getUTCDay() - 4 + 7) % 7;
  date.setUTCDate(date.getUTCDate() - distance);
  return dateText(date);
}

function melbourneDate(iso = new Date().toISOString()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Melbourne",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function chunks<T>(items: T[], size = 500) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function selectInChunks(
  table: string,
  columns: string,
  column: string,
  values: Array<string | number>,
  openOnly = false
) {
  const rows: Record<string, unknown>[] = [];
  for (const batch of chunks(values)) {
    let query = serverSupabaseAdmin.from(table).select(columns).in(column, batch);
    if (openOnly) query = query.eq("status", "OPEN");
    const { data, error } = await query;
    if (error) throw Object.assign(new Error("READ_FAILED"), { code: error.code, table });
    rows.push(...((data ?? []) as unknown as Record<string, unknown>[]));
  }
  return rows;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ApiResponse>) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, reason: "METHOD_NOT_ALLOWED" });
  }

  const access = await authorizeStoreRequest(req);
  if (!access.allowed) return res.status(access.status).json({ ok: false, reason: access.reason });
  if (access.role !== "MANAGER" && access.role !== "OWNER") {
    return res.status(403).json({ ok: false, reason: "ROLE_NOT_ALLOWED" });
  }

  const fromValue = Array.isArray(req.query.from) ? req.query.from[0] : req.query.from;
  const toValue = Array.isArray(req.query.to) ? req.query.to[0] : req.query.to;
  const staffId = Array.isArray(req.query.staff_id) ? req.query.staff_id[0] : req.query.staff_id;
  const fromDate = parseDate(fromValue);
  const toDate = parseDate(toValue);
  if (!fromDate || !toDate || fromDate > toDate) {
    return res.status(400).json({ ok: false, reason: "INVALID_DATE_RANGE" });
  }
  const inclusiveDays = Math.floor((toDate.getTime() - fromDate.getTime()) / DAY_MS) + 1;
  if (inclusiveDays > 62) return res.status(400).json({ ok: false, reason: "DATE_RANGE_TOO_LARGE" });
  if (staffId !== undefined && (typeof staffId !== "string" || !/^[0-9a-f-]{36}$/i.test(staffId))) {
    return res.status(400).json({ ok: false, reason: "INVALID_DATE_RANGE" });
  }

  try {
    const currentWeek = thursdayFor(melbourneDate());
    for (let week = thursdayFor(fromValue!); week <= toValue!; week = addDays(week, 7)) {
      if (week <= currentWeek) {
        const { error } = await serverSupabaseAdmin.rpc("wak_refresh_attendance_shadow", {
          p_store_id: STORE_ID,
          p_week_start: week,
          p_actor: access.actorId,
        });
        if (error) throw Object.assign(new Error("REFRESH_FAILED"), { code: error.code });
      }
    }

    const { data: periods, error: periodError } = await serverSupabaseAdmin
      .from("payroll_periods")
      .select("id")
      .eq("store_id", STORE_ID)
      .lte("week_start", toValue!)
      .gte("week_end", fromValue!);
    if (periodError) throw Object.assign(new Error("READ_FAILED"), { code: periodError.code });

    const periodIds = (periods ?? []).map((row) => row.id as number);
    const workPeriods: Record<string, unknown>[] = [];
    if (periodIds.length > 0) {
      for (const batch of chunks(periodIds)) {
        let query = serverSupabaseAdmin
          .from("work_periods")
          .select("id,status,source_type,current_version_id,matched_shift_id,staff_id,time_clock_id,payroll_period_id")
          .in("payroll_period_id", batch);
        if (staffId) query = query.eq("staff_id", staffId);
        const { data, error } = await query;
        if (error) throw Object.assign(new Error("READ_FAILED"), { code: error.code });
        workPeriods.push(...((data ?? []) as Record<string, unknown>[]));
      }
    }

    const versionIds = workPeriods.map((row) => row.current_version_id).filter(Boolean) as number[];
    const clockIds = workPeriods.map((row) => row.time_clock_id).filter(Boolean) as number[];
    const workPeriodIds = workPeriods.map((row) => row.id) as number[];

    const [versions, clocks, anomalies, profileResult] = await Promise.all([
      versionIds.length
        ? selectInChunks("work_period_versions", "id,version_number,disposition,matched_shift_id,actual_start_at,actual_end_at,payable_start_at,payable_end_at,reason_code,reason_note,change_source,created_by,created_at", "id", versionIds)
        : [],
      clockIds.length
        ? selectInChunks("time_clock", "id,clock_in_at,clock_out_at,device_tag", "id", clockIds)
        : [],
      workPeriodIds.length
        ? selectInChunks("work_period_anomalies", "id,work_period_id,anomaly_type,severity,details", "work_period_id", workPeriodIds, true)
        : [],
      serverSupabaseAdmin
        .from("profiles")
        .select("id,full_name,preferred_name,is_active")
        .order("full_name", { ascending: true }),
    ]);
    if (profileResult.error) {
      throw Object.assign(new Error("READ_FAILED"), { code: profileResult.error.code });
    }
    const shiftIds = Array.from(new Set([
      ...workPeriods.map((row) => row.matched_shift_id),
      ...versions.map((row) => row.matched_shift_id),
    ].filter(Boolean))) as number[];
    const shifts = shiftIds.length
      ? await selectInChunks(
          "shifts",
          "id,shift_start,shift_end,shift_status,parent_shift_id,covered_by_staff_id,cover_note",
          "id",
          shiftIds
        )
      : [];

    const byId = (rows: Record<string, unknown>[]) => new Map(rows.map((row) => [String(row.id), row]));
    const versionById = byId(versions);
    const clockById = byId(clocks);
    const shiftById = byId(shifts);
    const profileRows = (profileResult.data ?? []) as Record<string, unknown>[];
    const profileById = byId(profileRows);
    const anomaliesByPeriod = new Map<string, Record<string, unknown>[]>();
    for (const anomaly of anomalies) {
      const key = String(anomaly.work_period_id);
      anomaliesByPeriod.set(key, [...(anomaliesByPeriod.get(key) ?? []), anomaly]);
    }

    const records = workPeriods
      .map((workPeriod) => {
        const version = versionById.get(String(workPeriod.current_version_id)) ?? null;
        const rawClock = clockById.get(String(workPeriod.time_clock_id)) ?? null;
        const matchedShiftId = version?.matched_shift_id ?? workPeriod.matched_shift_id;
        const basis = (version?.actual_start_at ?? rawClock?.clock_in_at) as string | undefined;
        return {
          workPeriod,
          profile: profileById.get(String(workPeriod.staff_id)) ?? null,
          rawClock,
          currentVersion: version,
          matchedShift: matchedShiftId ? shiftById.get(String(matchedShiftId)) ?? null : null,
          openAnomalies: anomaliesByPeriod.get(String(workPeriod.id)) ?? [],
          localDate: basis ? melbourneDate(basis) : null,
        };
      })
      .filter((record) => record.localDate && record.localDate >= fromValue! && record.localDate <= toValue!)
      .sort((left, right) => {
        const leftTime = String(left.currentVersion?.actual_start_at ?? left.rawClock?.clock_in_at ?? "");
        const rightTime = String(right.currentVersion?.actual_start_at ?? right.rawClock?.clock_in_at ?? "");
        const timeOrder = leftTime.localeCompare(rightTime);
        if (timeOrder !== 0) return timeOrder;
        const leftName = String(left.profile?.preferred_name ?? left.profile?.full_name ?? "");
        const rightName = String(right.profile?.preferred_name ?? right.profile?.full_name ?? "");
        return leftName.localeCompare(rightName);
      });

    const staffOptions = profileRows.map((profile) => ({
      id: profile.id,
      full_name: profile.full_name,
      preferred_name: profile.preferred_name,
      is_active: profile.is_active,
    }));
    return res.status(200).json({ ok: true, records, staffOptions });
  } catch (error) {
    console.error("ATTENDANCE_REVIEW_LIST_ERROR", {
      code: typeof error === "object" && error && "code" in error ? String(error.code) : undefined,
    });
    return res.status(500).json({ ok: false, reason: "SERVER_ERROR" });
  }
}
