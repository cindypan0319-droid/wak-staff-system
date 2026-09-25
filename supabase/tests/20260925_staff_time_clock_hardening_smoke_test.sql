/*
 * Run as postgres in Supabase SQL Editor, as one batch, after Migration 009.
 * Fixture rows are contained by one outer transaction and the final ROLLBACK.
 */
BEGIN;

DO $precondition$
DECLARE
  v_staff uuid;
  v_other_actor uuid;
  v_elevated uuid;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M9_SMOKE_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  SELECT p.id INTO v_staff
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE
    AND pg_catalog.upper(p.role::text) = 'STAFF'
    AND NOT EXISTS (
      SELECT 1 FROM public.time_clock AS tc
      WHERE tc.staff_id = p.id AND tc.clock_out_at IS NULL
    )
  ORDER BY p.id LIMIT 1;

  SELECT p.id INTO v_other_actor
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE
    AND pg_catalog.upper(p.role::text) IN ('STAFF', 'MANAGER', 'OWNER')
    AND p.id IS DISTINCT FROM v_staff
    AND NOT EXISTS (
      SELECT 1 FROM public.time_clock AS tc
      WHERE tc.staff_id = p.id AND tc.clock_out_at IS NULL
    )
  ORDER BY p.id LIMIT 1;

  SELECT p.id INTO v_elevated
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE
    AND pg_catalog.upper(p.role::text) IN ('MANAGER', 'OWNER')
  ORDER BY p.id LIMIT 1;

  IF v_staff IS NULL OR v_other_actor IS NULL OR v_elevated IS NULL THEN
    RAISE EXCEPTION
      'M9_SMOKE_PRE: active STAFF, second active actor, and MANAGER/OWNER are required';
  END IF;

  PERFORM pg_catalog.set_config('wak_m9.staff', v_staff::text, true);
  PERFORM pg_catalog.set_config('wak_m9.other_actor', v_other_actor::text, true);
  PERFORM pg_catalog.set_config('wak_m9.elevated', v_elevated::text, true);
END
$precondition$;

/* H. The service-role Phase A path still creates authoritative STAFF rows. */
SET LOCAL ROLE service_role;

DO $service_fixtures$
DECLARE
  v_staff uuid := pg_catalog.current_setting('wak_m9.staff')::uuid;
  v_other_actor uuid := pg_catalog.current_setting('wak_m9.other_actor')::uuid;
  v_staff_clock jsonb;
  v_other_clock jsonb;
BEGIN
  IF current_user <> 'service_role' THEN
    RAISE EXCEPTION 'M9_SMOKE_H: service_role simulation failed';
  END IF;

  v_staff_clock := public.wak_clock_in_for_actor(v_staff, 'M9_SERVICE_STAFF');
  v_other_clock := public.wak_clock_in_for_actor(v_other_actor, 'M9_SERVICE_OTHER');

  IF (v_staff_clock ->> 'staff_id')::uuid IS DISTINCT FROM v_staff
     OR (v_other_clock ->> 'staff_id')::uuid IS DISTINCT FROM v_other_actor THEN
    RAISE EXCEPTION 'M9_SMOKE_H: service function returned the wrong actor';
  END IF;

  PERFORM pg_catalog.set_config('wak_m9.staff_clock_id', v_staff_clock ->> 'id', true);
  PERFORM pg_catalog.set_config('wak_m9.other_clock_id', v_other_clock ->> 'id', true);
END
$service_fixtures$;

RESET ROLE;
SET LOCAL ROLE authenticated;

DO $staff_tests$
DECLARE
  v_staff uuid := pg_catalog.current_setting('wak_m9.staff')::uuid;
  v_staff_clock_id bigint := pg_catalog.current_setting('wak_m9.staff_clock_id')::bigint;
  v_other_clock_id bigint := pg_catalog.current_setting('wak_m9.other_clock_id')::bigint;
  v_count bigint;
  v_rows bigint;
BEGIN
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_staff::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_staff, 'role', 'authenticated')::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM v_staff THEN
    RAISE EXCEPTION 'M9_SMOKE_STAFF: JWT simulation failed';
  END IF;

  /* A. STAFF direct INSERT is rejected by RLS. */
  BEGIN
    INSERT INTO public.time_clock (
      staff_id, shift_id, clock_in_at, clock_out_at, device_tag
    ) VALUES (
      v_staff, NULL, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
      'M9_STAFF_DIRECT_INSERT'
    );
    RAISE EXCEPTION 'M9_SMOKE_A: STAFF direct INSERT unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  /* B/C. STAFF can SELECT their own row but cannot UPDATE it. */
  SELECT count(*) INTO v_count
  FROM public.time_clock AS tc
  WHERE tc.id = v_staff_clock_id AND tc.staff_id = v_staff;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'M9_SMOKE_C: STAFF cannot SELECT their own row';
  END IF;

  UPDATE public.time_clock AS tc
  SET device_tag = 'M9_STAFF_DIRECT_UPDATE'
  WHERE tc.id = v_staff_clock_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows <> 0 OR EXISTS (
    SELECT 1 FROM public.time_clock AS tc
    WHERE tc.id = v_staff_clock_id AND tc.device_tag = 'M9_STAFF_DIRECT_UPDATE'
  ) THEN
    RAISE EXCEPTION 'M9_SMOKE_B: STAFF directly updated their own row';
  END IF;

  /* STAFF also cannot directly DELETE their own row. */
  DELETE FROM public.time_clock AS tc WHERE tc.id = v_staff_clock_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'M9_SMOKE_B: STAFF directly deleted their own row';
  END IF;

  /* D. Another employee row is neither visible nor mutable. */
  SELECT count(*) INTO v_count
  FROM public.time_clock AS tc
  WHERE tc.id = v_other_clock_id;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'M9_SMOKE_D: STAFF can see another employee row';
  END IF;

  UPDATE public.time_clock AS tc
  SET device_tag = 'M9_STAFF_OTHER_UPDATE'
  WHERE tc.id = v_other_clock_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'M9_SMOKE_D: STAFF updated another employee row';
  END IF;

  DELETE FROM public.time_clock AS tc WHERE tc.id = v_other_clock_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'M9_SMOKE_D: STAFF deleted another employee row';
  END IF;

  /* I. authenticated cannot bypass the API by calling service functions. */
  BEGIN
    PERFORM public.wak_clock_in_for_actor(v_staff, 'M9_AUTH_BYPASS');
    RAISE EXCEPTION 'M9_SMOKE_I: authenticated executed service-only function';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    PERFORM public.wak_clock_out_for_actor(v_staff, v_staff_clock_id);
    RAISE EXCEPTION 'M9_SMOKE_I: authenticated executed service-only clock-out function';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END
$staff_tests$;

DO $manager_owner_tests$
DECLARE
  v_elevated uuid := pg_catalog.current_setting('wak_m9.elevated')::uuid;
  v_clock_id bigint;
  v_rows bigint;
BEGIN
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_elevated::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_elevated, 'role', 'authenticated')::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM v_elevated THEN
    RAISE EXCEPTION 'M9_SMOKE_MANAGER: JWT simulation failed';
  END IF;

  /* E. MANAGER/OWNER direct INSERT remains available through RLS. */
  INSERT INTO public.time_clock (
    staff_id, shift_id, clock_in_at, clock_out_at, device_tag
  ) VALUES (
    v_elevated, NULL, pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(),
    'M9_MANAGER_INSERT'
  ) RETURNING id INTO v_clock_id;

  /* F. MANAGER/OWNER direct UPDATE remains available through RLS. */
  UPDATE public.time_clock AS tc
  SET device_tag = 'M9_MANAGER_UPDATE'
  WHERE tc.id = v_clock_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.time_clock AS tc
    WHERE tc.id = v_clock_id AND tc.device_tag = 'M9_MANAGER_UPDATE'
  ) THEN
    RAISE EXCEPTION 'M9_SMOKE_F: MANAGER/OWNER direct UPDATE failed';
  END IF;

  /* G. MANAGER/OWNER direct DELETE remains available through RLS. */
  DELETE FROM public.time_clock AS tc WHERE tc.id = v_clock_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'M9_SMOKE_G: MANAGER/OWNER direct DELETE failed';
  END IF;
END
$manager_owner_tests$;

RESET ROLE;

ROLLBACK;

/* J. Exact fixture tags prove the outer rollback left no test rows. */
DO $verify_rollback$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.time_clock AS tc
    WHERE tc.device_tag IN (
      'M9_SERVICE_STAFF', 'M9_SERVICE_OTHER', 'M9_STAFF_DIRECT_INSERT',
      'M9_STAFF_DIRECT_UPDATE', 'M9_STAFF_OTHER_UPDATE', 'M9_AUTH_BYPASS',
      'M9_MANAGER_INSERT', 'M9_MANAGER_UPDATE'
    )
  ) THEN
    RAISE EXCEPTION 'M9_SMOKE_J: fixture row persisted after ROLLBACK';
  END IF;
END
$verify_rollback$;

SELECT count(*) AS persisted_fixture_row_count
FROM public.time_clock AS tc
WHERE tc.device_tag IN (
  'M9_SERVICE_STAFF', 'M9_SERVICE_OTHER', 'M9_STAFF_DIRECT_INSERT',
  'M9_STAFF_DIRECT_UPDATE', 'M9_STAFF_OTHER_UPDATE', 'M9_AUTH_BYPASS',
  'M9_MANAGER_INSERT', 'M9_MANAGER_UPDATE'
);
