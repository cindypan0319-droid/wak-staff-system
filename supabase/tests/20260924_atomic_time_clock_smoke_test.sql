/*
 * Run as postgres in Supabase SQL Editor, as one batch, after Migration 008.
 * All time_clock mutations occur inside this outer transaction and are
 * discarded by the final ROLLBACK.
 */
BEGIN;

DO $precondition$
DECLARE
  v_actor uuid;
  v_inactive uuid;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M8_SMOKE_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  IF to_regprocedure('public.wak_clock_in_for_actor(uuid,text)') IS NULL
     OR to_regprocedure('public.wak_clock_out_for_actor(uuid,bigint)') IS NULL THEN
    RAISE EXCEPTION 'M8_SMOKE_PRE: Migration 008 functions are missing';
  END IF;

  IF pg_catalog.has_function_privilege(
       'authenticated', 'public.wak_clock_in_for_actor(uuid,text)', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', 'public.wak_clock_out_for_actor(uuid,bigint)', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'anon', 'public.wak_clock_in_for_actor(uuid,text)', 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'anon', 'public.wak_clock_out_for_actor(uuid,bigint)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'M8_SMOKE_PRE: client role can execute a service-only function';
  END IF;

  IF pg_catalog.has_function_privilege(
       'service_role', 'public.wak_clock_in_for_actor(uuid,text)', 'EXECUTE'
     ) IS NOT TRUE OR pg_catalog.has_function_privilege(
       'service_role', 'public.wak_clock_out_for_actor(uuid,bigint)', 'EXECUTE'
     ) IS NOT TRUE THEN
    RAISE EXCEPTION 'M8_SMOKE_PRE: service_role EXECUTE is missing';
  END IF;

  SELECT p.id
  INTO v_actor
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE
    AND pg_catalog.upper(p.role::text) IN ('STAFF', 'MANAGER', 'OWNER')
    AND NOT EXISTS (
      SELECT 1
      FROM public.time_clock AS tc
      WHERE tc.staff_id = p.id
        AND tc.clock_out_at IS NULL
    )
  ORDER BY p.id
  LIMIT 1;

  SELECT p.id
  INTO v_inactive
  FROM public.profiles AS p
  WHERE p.is_active IS NOT TRUE
  ORDER BY p.id
  LIMIT 1;

  IF v_actor IS NULL OR v_inactive IS NULL THEN
    RAISE EXCEPTION 'M8_SMOKE_PRE: one eligible actor and one inactive profile are required';
  END IF;

  PERFORM pg_catalog.set_config('wak_smoke.clock_actor', v_actor::text, true);
  PERFORM pg_catalog.set_config('wak_smoke.inactive_actor', v_inactive::text, true);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wak:time-clock:' || v_actor::text, 0)
  );

  IF EXISTS (
    SELECT 1 FROM public.time_clock AS tc
    WHERE tc.staff_id = v_actor AND tc.clock_out_at IS NULL
  ) THEN
    RAISE EXCEPTION 'M8_SMOKE_PRE: actor gained an open clock after selection';
  END IF;
END
$precondition$;

SET LOCAL ROLE service_role;

DO $tests$
DECLARE
  v_actor uuid := pg_catalog.current_setting('wak_smoke.clock_actor')::uuid;
  v_inactive uuid := pg_catalog.current_setting('wak_smoke.inactive_actor')::uuid;
  v_missing uuid := '00000000-0000-0000-0000-000000000008'::uuid;
  v_before timestamptz;
  v_after timestamptz;
  v_clock_in jsonb;
  v_clock_out jsonb;
  v_clock_id bigint;
  v_original_clock_out timestamptz;
  v_error text;
  v_definition text;
BEGIN
  /* A. Service role clocks in an active actor using a database timestamp. */
  v_before := pg_catalog.clock_timestamp();
  v_clock_in := public.wak_clock_in_for_actor(v_actor, 'STORE_NETWORK');
  v_after := pg_catalog.clock_timestamp();
  v_clock_id := (v_clock_in ->> 'id')::bigint;

  IF (v_clock_in ->> 'staff_id')::uuid IS DISTINCT FROM v_actor
     OR v_clock_in ->> 'device_tag' IS DISTINCT FROM 'STORE_NETWORK'
     OR (v_clock_in ->> 'clock_out_at') IS NOT NULL
     OR (v_clock_in ->> 'clock_in_at')::timestamptz NOT BETWEEN v_before AND v_after THEN
    RAISE EXCEPTION 'M8_SMOKE_A: clock-in response is not authoritative';
  END IF;

  IF (SELECT count(*) FROM public.time_clock AS tc
      WHERE tc.staff_id = v_actor AND tc.clock_out_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'M8_SMOKE_A: exactly one open clock was expected';
  END IF;

  /* B. A second clock-in is translated to ALREADY_CLOCKED_IN. */
  BEGIN
    PERFORM public.wak_clock_in_for_actor(v_actor, 'STORE_NETWORK');
    RAISE EXCEPTION 'M8_SMOKE_B: duplicate clock-in unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error NOT LIKE 'ALREADY_CLOCKED_IN%' THEN
      RAISE EXCEPTION 'M8_SMOKE_B: unexpected error: %', v_error;
    END IF;
  END;

  /* C. A wrong expected id cannot close the actor's actual open clock. */
  BEGIN
    PERFORM public.wak_clock_out_for_actor(v_actor, v_clock_id + 1000000);
    RAISE EXCEPTION 'M8_SMOKE_C: wrong-id clock-out unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error NOT LIKE 'OPEN_CLOCK_NOT_FOUND%' THEN
      RAISE EXCEPTION 'M8_SMOKE_C: unexpected error: %', v_error;
    END IF;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.time_clock AS tc
    WHERE tc.id = v_clock_id AND tc.staff_id = v_actor AND tc.clock_out_at IS NULL
  ) THEN
    RAISE EXCEPTION 'M8_SMOKE_C: wrong id changed the real open clock';
  END IF;

  /* D. The expected own row is closed with a database timestamp. */
  v_before := pg_catalog.clock_timestamp();
  v_clock_out := public.wak_clock_out_for_actor(v_actor, v_clock_id);
  v_after := pg_catalog.clock_timestamp();
  v_original_clock_out := (v_clock_out ->> 'clock_out_at')::timestamptz;

  IF (v_clock_out ->> 'id')::bigint IS DISTINCT FROM v_clock_id
     OR v_original_clock_out NOT BETWEEN v_before AND v_after THEN
    RAISE EXCEPTION 'M8_SMOKE_D: clock-out response is not authoritative';
  END IF;

  /* E. Repeated/stale clock-out cannot overwrite the first timestamp. */
  BEGIN
    PERFORM public.wak_clock_out_for_actor(v_actor, v_clock_id);
    RAISE EXCEPTION 'M8_SMOKE_E: repeated clock-out unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error NOT LIKE 'CLOCK_STATE_CHANGED%' THEN
      RAISE EXCEPTION 'M8_SMOKE_E: unexpected error: %', v_error;
    END IF;
  END;

  IF (SELECT tc.clock_out_at FROM public.time_clock AS tc WHERE tc.id = v_clock_id)
       IS DISTINCT FROM v_original_clock_out THEN
    RAISE EXCEPTION 'M8_SMOKE_E: repeated call overwrote clock_out_at';
  END IF;

  /* F. Inactive and missing actors are rejected before mutation. */
  BEGIN
    PERFORM public.wak_clock_in_for_actor(v_inactive, 'STORE_NETWORK');
    RAISE EXCEPTION 'M8_SMOKE_F: inactive actor unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error NOT LIKE 'PROFILE_INACTIVE%' THEN
      RAISE EXCEPTION 'M8_SMOKE_F: unexpected inactive error: %', v_error;
    END IF;
  END;

  BEGIN
    PERFORM public.wak_clock_in_for_actor(v_missing, 'STORE_NETWORK');
    RAISE EXCEPTION 'M8_SMOKE_F: missing actor unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
    IF v_error NOT LIKE 'PROFILE_NOT_FOUND%' THEN
      RAISE EXCEPTION 'M8_SMOKE_F: unexpected missing-profile error: %', v_error;
    END IF;
  END;

  /* G. Static contract confirms null/unsupported roles are rejected. */
  v_definition := pg_catalog.pg_get_functiondef(
    'public.wak_clock_in_for_actor(uuid,text)'::regprocedure
  );
  IF v_definition !~ $$v_role IS NULL OR v_role NOT IN \('STAFF', 'MANAGER', 'OWNER'\)$$ THEN
    RAISE EXCEPTION 'M8_SMOKE_G: unsupported-role guard is missing';
  END IF;
END
$tests$;

RESET ROLE;

DO $final_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes AS i
    WHERE i.schemaname = 'public'
      AND i.tablename = 'time_clock'
      AND i.indexname = 'time_clock_one_open'
      AND i.indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND i.indexdef ILIKE '%clock_out_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'M8_SMOKE_FINAL: time_clock_one_open changed or is missing';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies AS p
      WHERE p.schemaname = 'public'
        AND p.tablename = 'time_clock'
        AND p.policyname IN (
          'STAFF insert time_clock (own)',
          'STAFF update time_clock (own)',
          'time_clock_self_anyrole_insert',
          'time_clock_self_anyrole_update'
        )) <> 4 THEN
    RAISE EXCEPTION 'M8_SMOKE_FINAL: Phase A time_clock policies changed';
  END IF;
END
$final_checks$;

ROLLBACK;
