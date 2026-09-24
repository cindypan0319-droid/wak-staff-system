/*
 * Run as postgres in Supabase SQL Editor after Migration 6B.
 * The current Melbourne date must have no Daily Close data. Run in a quiet
 * test window and not near Melbourne midnight. Exact selected dates survive
 * the one outer transaction so zero persistence can be proved after ROLLBACK.
 */
DO $select_fixtures$
DECLARE
  v_current_date date := (
    pg_catalog.timezone('Australia/Melbourne', pg_catalog.now())
  )::date;
  v_historical date[];
  v_dates date[];
  v_staff_a uuid;
  v_staff_b uuid;
  v_manager uuid;
  v_owner uuid;
  v_inactive uuid;
  v_platforms jsonb;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M7_SMOKE_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  SELECT pg_catalog.array_agg(candidate ORDER BY candidate)
  INTO v_historical
  FROM (
    SELECT current_date - offset_days AS candidate
    FROM pg_catalog.generate_series(3650, 5000) AS g(offset_days)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.cashup_sessions AS c
      WHERE c.store_id = 'MOOROOLBARK'
        AND c.business_date = current_date - offset_days
    ) AND NOT EXISTS (
      SELECT 1 FROM public.daily_sales AS ds
      WHERE ds.store_id = 'MOOROOLBARK'
        AND ds.business_date = current_date - offset_days
    ) AND NOT EXISTS (
      SELECT 1 FROM public.platform_income AS pi
      WHERE pi.store_id = 'MOOROOLBARK'
        AND pi.business_date = current_date - offset_days
    )
    ORDER BY candidate
    LIMIT 2
  ) AS safe_dates;

  IF pg_catalog.coalesce(pg_catalog.array_length(v_historical, 1), 0) <> 2 THEN
    RAISE EXCEPTION 'M7_SMOKE_PRE: two empty historical dates are required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cashup_sessions AS c
    WHERE c.store_id = 'MOOROOLBARK' AND c.business_date = v_current_date
  ) OR EXISTS (
    SELECT 1 FROM public.daily_sales AS ds
    WHERE ds.store_id = 'MOOROOLBARK' AND ds.business_date = v_current_date
  ) OR EXISTS (
    SELECT 1 FROM public.platform_income AS pi
    WHERE pi.store_id = 'MOOROOLBARK' AND pi.business_date = v_current_date
  ) THEN
    RAISE EXCEPTION
      'M7_SMOKE_PRE: current Melbourne date % is not disposable; run before daily entry begins',
      v_current_date;
  END IF;

  SELECT p.id INTO v_staff_a FROM public.profiles AS p
  WHERE p.is_active IS TRUE AND upper(p.role::text) = 'STAFF'
  ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_staff_b FROM public.profiles AS p
  WHERE p.is_active IS TRUE AND upper(p.role::text) = 'STAFF'
    AND p.id IS DISTINCT FROM v_staff_a
  ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_manager FROM public.profiles AS p
  WHERE p.is_active IS TRUE AND upper(p.role::text) = 'MANAGER'
  ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_owner FROM public.profiles AS p
  WHERE p.is_active IS TRUE AND upper(p.role::text) = 'OWNER'
  ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_inactive FROM public.profiles AS p
  WHERE p.is_active IS NOT TRUE AND upper(p.role::text) = 'STAFF'
  ORDER BY p.id LIMIT 1;

  IF v_staff_a IS NULL OR v_staff_b IS NULL OR v_manager IS NULL
     OR v_owner IS NULL OR v_inactive IS NULL THEN
    RAISE EXCEPTION
      'M7_SMOKE_PRE: two active STAFF, active MANAGER/OWNER, and inactive STAFF required';
  END IF;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'platform', p.name, 'action', 'SET', 'gross_income', 0
    ) ORDER BY p.sort_order, p.name, p.id
  ) INTO v_platforms
  FROM public.platforms AS p
  WHERE p.is_active IS TRUE;

  IF v_platforms IS NULL THEN
    RAISE EXCEPTION 'M7_SMOKE_PRE: at least one active platform is required';
  END IF;

  v_dates := ARRAY[v_current_date, v_historical[1], v_historical[2]];
  PERFORM pg_catalog.set_config('wak_m7.dates', pg_catalog.to_jsonb(v_dates)::text, false);
  PERFORM pg_catalog.set_config('wak_m7.staff_a', v_staff_a::text, false);
  PERFORM pg_catalog.set_config('wak_m7.staff_b', v_staff_b::text, false);
  PERFORM pg_catalog.set_config('wak_m7.manager', v_manager::text, false);
  PERFORM pg_catalog.set_config('wak_m7.owner', v_owner::text, false);
  PERFORM pg_catalog.set_config('wak_m7.inactive', v_inactive::text, false);
  PERFORM pg_catalog.set_config('wak_m7.platforms', v_platforms::text, false);
END
$select_fixtures$;

BEGIN;

DO $lock_and_recheck$
DECLARE
  v_dates date[];
  v_date date;
BEGIN
  SELECT pg_catalog.array_agg(value::date ORDER BY ord)
  INTO v_dates
  FROM pg_catalog.jsonb_array_elements_text(
    current_setting('wak_m7.dates')::jsonb
  ) WITH ORDINALITY AS selected(value, ord);

  FOREACH v_date IN ARRAY v_dates LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('MOOROOLBARK:' || v_date::text, 0)
    );
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.cashup_sessions WHERE store_id = 'MOOROOLBARK'
      AND business_date = ANY (v_dates)
  ) OR EXISTS (
    SELECT 1 FROM public.daily_sales WHERE store_id = 'MOOROOLBARK'
      AND business_date = ANY (v_dates)
  ) OR EXISTS (
    SELECT 1 FROM public.platform_income WHERE store_id = 'MOOROOLBARK'
      AND business_date = ANY (v_dates)
  ) THEN
    RAISE EXCEPTION 'M7_SMOKE_PRE: selected dates changed before fixture writes';
  END IF;
END
$lock_and_recheck$;

SET LOCAL ROLE authenticated;

DO $smoke$
DECLARE
  v_dates date[];
  v_today date;
  v_historical_manager date;
  v_historical_owner date;
  v_staff_a uuid := current_setting('wak_m7.staff_a')::uuid;
  v_staff_b uuid := current_setting('wak_m7.staff_b')::uuid;
  v_manager uuid := current_setting('wak_m7.manager')::uuid;
  v_owner uuid := current_setting('wak_m7.owner')::uuid;
  v_inactive uuid := current_setting('wak_m7.inactive')::uuid;
  v_platforms jsonb := current_setting('wak_m7.platforms')::jsonb;
  v_counts_1000 jsonb := pg_catalog.jsonb_build_object(
    'note100', 10, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0, 'coin10c', 0, 'coin5c', 0
  );
  v_counts_600 jsonb := pg_catalog.jsonb_build_object(
    'note100', 6, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0, 'coin10c', 0, 'coin5c', 0
  );
  v_payload jsonb;
  v_result jsonb;
  v_revision timestamptz;
  v_remove_platforms jsonb;
BEGIN
  SELECT pg_catalog.array_agg(value::date ORDER BY ord)
  INTO v_dates
  FROM pg_catalog.jsonb_array_elements_text(
    current_setting('wak_m7.dates')::jsonb
  ) WITH ORDINALITY AS selected(value, ord);
  v_today := v_dates[1];
  v_historical_manager := v_dates[2];
  v_historical_owner := v_dates[3];

  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_staff_a::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_staff_a, 'role', 'authenticated')::text,
    true
  );

  /* Existing submit behavior creates all three first closes for STAFF A. */
  FOREACH v_today IN ARRAY v_dates LOOP
    v_payload := pg_catalog.jsonb_build_object(
      'business_date', v_today,
      'store_id', 'MOOROOLBARK',
      'expected_night_updated_at', NULL,
      'night_counts', v_counts_1000,
      'removed_counts', v_counts_600,
      'cash_sales', 600,
      'eftpos_sales', 100,
      'cash_difference', pg_catalog.jsonb_build_object('reason', '', 'note', ''),
      'platforms', v_platforms,
      'notes', 'Migration 7 fixture'
    );
    PERFORM public.submit_daily_close(v_payload);
  END LOOP;
  v_today := v_dates[1];

  BEGIN
    PERFORM public.submit_daily_close(v_payload);
    RAISE EXCEPTION 'M7_SMOKE: duplicate first submit unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;

  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_today AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  v_payload := pg_catalog.jsonb_build_object(
    'business_date', v_today, 'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', v_revision::text,
    'night_counts', v_counts_1000, 'removed_counts', v_counts_600,
    'cash_sales', 600, 'eftpos_sales', 101,
    'cash_difference', pg_catalog.jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms, 'notes', 'STAFF own correction'
  );
  v_result := public.correct_daily_close(v_payload);
  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_today AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  IF (v_result ->> 'entered_by')::uuid IS DISTINCT FROM v_staff_a
     OR (v_result ->> 'night_updated_at')::timestamptz IS DISTINCT FROM v_revision
     OR NOT EXISTS (
       SELECT 1 FROM public.daily_sales AS ds
       WHERE ds.business_date = v_today AND ds.store_id = 'MOOROOLBARK'
         AND ds.eftpos_sales = 101 AND ds.entered_by = v_staff_a
         AND ds.notes = 'STAFF own correction'
     ) OR NOT EXISTS (
       SELECT 1 FROM public.cashup_sessions AS c
       WHERE c.business_date = v_today AND c.store_id = 'MOOROOLBARK'
         AND c.session_type = 'NIGHT' AND c.entered_by = v_staff_a
     ) THEN
    RAISE EXCEPTION 'M7_SMOKE: own-current STAFF correction or attribution failed';
  END IF;

  /* Exact stale revisions remain rejected. */
  v_payload := pg_catalog.jsonb_set(
    v_payload, '{expected_night_updated_at}',
    pg_catalog.to_jsonb((v_revision - interval '1 second')::text)
  );
  BEGIN
    PERFORM public.correct_daily_close(v_payload);
    RAISE EXCEPTION 'M7_SMOKE: stale revision unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL;
  END;

  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_today AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  v_payload := pg_catalog.jsonb_set(
    v_payload, '{expected_night_updated_at}', pg_catalog.to_jsonb(v_revision::text)
  );

  /* A different active STAFF member cannot correct STAFF A's close. */
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_staff_b::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_staff_b, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.correct_daily_close(v_payload);
    RAISE EXCEPTION 'M7_SMOKE: another STAFF member corrected the close';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  /* Inactive callers are rejected before ownership can grant access. */
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_inactive::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_inactive, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.correct_daily_close(v_payload);
    RAISE EXCEPTION 'M7_SMOKE: inactive profile corrected the close';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_staff_a::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_staff_a, 'role', 'authenticated')::text,
    true
  );

  /* STAFF cannot correct their own historical close. */
  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_historical_manager AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  v_payload := pg_catalog.jsonb_set(v_payload, '{business_date}',
    pg_catalog.to_jsonb(v_historical_manager));
  v_payload := pg_catalog.jsonb_set(v_payload, '{expected_night_updated_at}',
    pg_catalog.to_jsonb(v_revision::text));
  BEGIN
    PERFORM public.correct_daily_close(v_payload);
    RAISE EXCEPTION 'M7_SMOKE: STAFF historical correction unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  /* STAFF cannot use REMOVE, even on their own current close. */
  SELECT pg_catalog.jsonb_agg(
    CASE WHEN ord = 1
      THEN (item - 'gross_income') || '{"action":"REMOVE"}'::jsonb
      ELSE item END ORDER BY ord
  ) INTO v_remove_platforms
  FROM pg_catalog.jsonb_array_elements(v_platforms) WITH ORDINALITY AS p(item, ord);
  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_today AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  v_payload := pg_catalog.jsonb_set(v_payload, '{business_date}', pg_catalog.to_jsonb(v_today));
  v_payload := pg_catalog.jsonb_set(v_payload, '{expected_night_updated_at}',
    pg_catalog.to_jsonb(v_revision::text));
  v_payload := pg_catalog.jsonb_set(v_payload, '{platforms}', v_remove_platforms);
  BEGIN
    PERFORM public.correct_daily_close(v_payload);
    RAISE EXCEPTION 'M7_SMOKE: STAFF REMOVE unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  /* MANAGER may correct another submitter's historical close. */
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_manager::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_manager, 'role', 'authenticated')::text,
    true
  );
  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_historical_manager AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  v_payload := pg_catalog.jsonb_build_object(
    'business_date', v_historical_manager, 'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', v_revision::text,
    'night_counts', v_counts_1000, 'removed_counts', v_counts_600,
    'cash_sales', 600, 'eftpos_sales', 102,
    'cash_difference', pg_catalog.jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms, 'notes', 'MANAGER historical correction'
  );
  v_result := public.correct_daily_close(v_payload);

  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_historical_manager AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  IF (v_result ->> 'night_updated_at')::timestamptz IS DISTINCT FROM v_revision THEN
    RAISE EXCEPTION 'M7_SMOKE: MANAGER response returned a stale NIGHT revision';
  END IF;

  /* The returned final revision must be immediately reusable. */
  v_payload := pg_catalog.jsonb_set(
    v_payload, '{expected_night_updated_at}',
    pg_catalog.to_jsonb(v_result ->> 'night_updated_at')
  );
  v_payload := pg_catalog.jsonb_set(v_payload, '{eftpos_sales}', '104'::jsonb);
  v_payload := pg_catalog.jsonb_set(
    v_payload, '{notes}', pg_catalog.to_jsonb('MANAGER second correction'::text)
  );
  v_result := public.correct_daily_close(v_payload);
  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_historical_manager AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  IF (v_result ->> 'night_updated_at')::timestamptz IS DISTINCT FROM v_revision THEN
    RAISE EXCEPTION 'M7_SMOKE: second MANAGER response returned a stale NIGHT revision';
  END IF;

  /* OWNER retains the same historical cross-submitter capability. */
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_historical_owner AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  v_payload := pg_catalog.jsonb_set(v_payload, '{business_date}',
    pg_catalog.to_jsonb(v_historical_owner));
  v_payload := pg_catalog.jsonb_set(v_payload, '{expected_night_updated_at}',
    pg_catalog.to_jsonb(v_revision::text));
  v_payload := pg_catalog.jsonb_set(v_payload, '{eftpos_sales}', '103'::jsonb);
  v_payload := pg_catalog.jsonb_set(v_payload, '{notes}',
    pg_catalog.to_jsonb('OWNER historical correction'::text));
  v_result := public.correct_daily_close(v_payload);
  SELECT c.updated_at INTO v_revision FROM public.cashup_sessions AS c
  WHERE c.business_date = v_historical_owner AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';
  IF (v_result ->> 'night_updated_at')::timestamptz IS DISTINCT FROM v_revision THEN
    RAISE EXCEPTION 'M7_SMOKE: OWNER response returned a stale NIGHT revision';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cashup_sessions AS c
    WHERE c.business_date IN (v_historical_manager, v_historical_owner)
      AND c.store_id = 'MOOROOLBARK' AND c.session_type = 'NIGHT'
      AND c.entered_by IS DISTINCT FROM v_staff_a
  ) OR EXISTS (
    SELECT 1 FROM public.daily_sales AS ds
    WHERE ds.business_date IN (v_historical_manager, v_historical_owner)
      AND ds.store_id = 'MOOROOLBARK'
      AND ds.entered_by IS DISTINCT FROM v_staff_a
  ) OR NOT EXISTS (
    SELECT 1 FROM public.daily_sales AS ds
    WHERE ds.business_date = v_historical_manager AND ds.eftpos_sales = 104
      AND ds.notes = 'MANAGER second correction'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.daily_sales AS ds
    WHERE ds.business_date = v_historical_owner AND ds.eftpos_sales = 103
      AND ds.notes = 'OWNER historical correction'
  ) THEN
    RAISE EXCEPTION 'M7_SMOKE: manager/owner correction or attribution preservation failed';
  END IF;

  RAISE NOTICE 'PASS M7: STAFF boundary, revision, attribution, and manager/owner behavior';
END
$smoke$;

ROLLBACK;

DO $verify_rollback$
DECLARE
  v_dates date[];
BEGIN
  SELECT pg_catalog.array_agg(value::date ORDER BY ord)
  INTO v_dates
  FROM pg_catalog.jsonb_array_elements_text(
    current_setting('wak_m7.dates')::jsonb
  ) WITH ORDINALITY AS selected(value, ord);

  IF (SELECT count(*) FROM public.cashup_sessions
      WHERE store_id = 'MOOROOLBARK' AND business_date = ANY (v_dates))
     + (SELECT count(*) FROM public.daily_sales
        WHERE store_id = 'MOOROOLBARK' AND business_date = ANY (v_dates))
     + (SELECT count(*) FROM public.platform_income
        WHERE store_id = 'MOOROOLBARK' AND business_date = ANY (v_dates)) <> 0 THEN
    RAISE EXCEPTION 'M7_SMOKE: fixture rows persisted after ROLLBACK';
  END IF;
END
$verify_rollback$;
