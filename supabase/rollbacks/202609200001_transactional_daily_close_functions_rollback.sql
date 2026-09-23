BEGIN;

/*
 * Rollback for Migration 1 only.
 *
 * This removes only the newly added RPC/functions and their grants. It does
 * not alter or delete application data, tables, triggers, views, or policies.
 */

DROP FUNCTION IF EXISTS public.correct_daily_close(jsonb);

DROP FUNCTION IF EXISTS public.submit_daily_close(jsonb);

DROP FUNCTION IF EXISTS public.save_morning_cashup(date, text, jsonb);

DROP FUNCTION IF EXISTS public._wak_apply_daily_close(jsonb, boolean, boolean);

DROP FUNCTION IF EXISTS public._wak_cash_counts_total(jsonb, text);

DROP FUNCTION IF EXISTS public._wak_canonical_platform(text);

COMMIT;
