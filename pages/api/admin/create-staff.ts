import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { createPinCredentials } from "../../../lib/server/authCredentials";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function rollbackCreatedAuthUser(userId: string) {
  try {
    const deleted = await admin.auth.admin.deleteUser(userId);

    if (deleted.error) {
      console.error("Failed to roll back newly created Auth user", {
        userId,
        error: deleted.error.message,
      });
      return false;
    }

    return true;
  } catch (error: unknown) {
    console.error("Failed to roll back newly created Auth user", {
      userId,
      error: error instanceof Error ? error.message : "Unknown cleanup error",
    });
    return false;
  }
}

function safeSlug(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  let createdAuthUserId: string | null = null;
  let profileCreated = false;

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing auth token" });

    const who = await admin.auth.getUser(token);
    const actorId = who.data?.user?.id;
    if (!actorId) return res.status(401).json({ error: "Invalid token" });

    const pr = await admin.from("profiles").select("role,is_active").eq("id", actorId).maybeSingle();
    if (pr.error) return res.status(400).json({ error: pr.error.message });

    const actorRole = pr.data?.role;
    const actorActive = pr.data?.is_active === true;
    if (!actorActive) return res.status(403).json({ error: "Your account is inactive" });
    if (!(actorRole === "OWNER" || actorRole === "MANAGER")) return res.status(403).json({ error: "Owner/Manager only" });

    const { full_name, preferred_name, role, pin } = req.body ?? {};
    if (!full_name || !preferred_name || !role) return res.status(400).json({ error: "Missing fields" });

    const pinWasSupplied = pin !== undefined && pin !== null;
    const pinStr = pinWasSupplied ? String(pin) : "";
    if (pinWasSupplied && !/^\d{4}$/.test(pinStr)) {
      return res.status(400).json({ error: "PIN must be exactly 4 numeric digits" });
    }

    const newRole = String(role).toUpperCase();
    if (!["STAFF", "MANAGER", "OWNER"].includes(newRole)) return res.status(400).json({ error: "Invalid role" });

    // Manager cannot create OWNER
    if (actorRole === "MANAGER" && newRole === "OWNER") {
      return res.status(403).json({ error: "Manager cannot create OWNER" });
    }

    const base = safeSlug(preferred_name || full_name);
    const fakeEmail = `${base}-${Date.now()}@wok.local`;
    const generatedPassword = crypto.randomBytes(32).toString("base64url");

    const created = await admin.auth.admin.createUser({
      email: fakeEmail,
      password: generatedPassword,
      email_confirm: true,
    });

    if (created.error) return res.status(400).json({ error: created.error.message });

    const newId = created.data.user?.id;
    if (!newId) return res.status(400).json({ error: "User id missing" });
    createdAuthUserId = newId;

    const pinCredentials = pinStr ? createPinCredentials(pinStr) : {};

    const up = await admin.from("profiles").upsert(
      {
        id: newId,
        full_name: String(full_name),
        preferred_name: String(preferred_name),
        role: newRole,
        is_active: true,
        ...pinCredentials,
      },
      { onConflict: "id" }
    );

    if (up.error) {
      console.error("Failed to create profile for newly created Auth user", {
        userId: newId,
        error: up.error.message,
      });

      const rolledBack = await rollbackCreatedAuthUser(newId);
      if (!rolledBack) {
        return res.status(500).json({
          error: "Staff creation failed and automatic cleanup was unsuccessful. Manual cleanup is required.",
        });
      }

      return res.status(400).json({ error: "Failed to create staff profile" });
    }

    profileCreated = true;

    try {
      const details = await admin
        .from("employee_details")
        .upsert({ staff_id: newId }, { onConflict: "staff_id" });

      if (details.error) {
        console.error("Optional employee_details initialization failed", {
          userId: newId,
          error: details.error.message,
        });
      }
    } catch (error: unknown) {
      console.error("Optional employee_details initialization failed", {
        userId: newId,
        error: error instanceof Error ? error.message : "Unknown employee details error",
      });
    }

    return res.status(200).json({ ok: true, staff_id: newId });
  } catch (error: unknown) {
    if (createdAuthUserId && !profileCreated) {
      const rolledBack = await rollbackCreatedAuthUser(createdAuthUserId);
      if (!rolledBack) {
        return res.status(500).json({
          error: "Staff creation failed and automatic cleanup was unsuccessful. Manual cleanup is required.",
        });
      }
    }

    const message = error instanceof Error ? error.message : "Server error";
    return res.status(500).json({ error: message });
  }
}
