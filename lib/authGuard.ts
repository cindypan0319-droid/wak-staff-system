import type { User } from "@supabase/supabase-js";
import { supabase } from "./supabaseClient";

export type CurrentUserRead =
  | { status: "authenticated"; user: User }
  | { status: "unauthenticated" }
  | { status: "read_error" };

export type AuthGuardProfile = {
  role: string | null;
  is_active: boolean | null;
};

export type CurrentProfileRead =
  | { status: "loaded"; profile: AuthGuardProfile }
  | { status: "missing" }
  | { status: "read_error" };

export async function readCurrentUser(): Promise<CurrentUserRead> {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) return { status: "read_error" };
    if (!data.user) return { status: "unauthenticated" };
    return { status: "authenticated", user: data.user };
  } catch {
    return { status: "read_error" };
  }
}

export async function readCurrentProfile(userId: string): Promise<CurrentProfileRead> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("role, is_active")
      .eq("id", userId)
      .maybeSingle();

    if (error) return { status: "read_error" };
    if (!data) return { status: "missing" };
    return { status: "loaded", profile: data as AuthGuardProfile };
  } catch {
    return { status: "read_error" };
  }
}
