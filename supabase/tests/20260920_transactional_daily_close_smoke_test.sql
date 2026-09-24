/*
 * Production-safe transactional smoke test for Migration 1.
 *
 * Run the complete file as one SQL Editor batch. Disposable dates are the
 * deterministic historical range current_date - 3650 through - 3656. Do not
 * start the script immediately before midnight: the read-only query after
 * ROLLBACK recomputes that same range from current_date. All fixture writes
 * are made inside the transaction and discarded by ROLLBACK.
 */

SELECT pg_catalog.set_config(
  'wak_smoke.verification_dates',
  (
    SELECT jsonb_agg(
      to_jsonb(current_date - offsets.day_offset)
      ORDER BY offsets.day_offset
    )::text
    FROM generate_series(3650, 3656) AS offsets(day_offset)
  ),
  false
) AS smoke_verification_dates;

BEGIN;

/* Resolve authoritative prerequisites before making any fixture writes. */
DO $smoke_preconditions$
DECLARE
  v_staff_a uuid;
  v_staff_b uuid;
  v_manager uuid;
  v_dates date[];
  v_date date;
  v_platform_payload jsonb;
  v_first_platform text;
  v_active_platform_count integer;
  v_existing_count integer;
  v_signature text;
  v_function_oid oid;
  v_authenticated_role oid;
  v_anon_role oid;
  v_public_execute boolean;
  v_expected_authenticated boolean;
  v_all_signatures constant text[] := ARRAY[
    'public._wak_canonical_platform(text)',
    'public._wak_cash_counts_total(jsonb,text)',
    'public.save_morning_cashup(date,text,jsonb)',
    'public._wak_apply_daily_close(jsonb,boolean,boolean)',
    'public.submit_daily_close(jsonb)',
    'public.correct_daily_close(jsonb)'
  ];
  v_authenticated_signatures constant text[] := ARRAY[
    'public.save_morning_cashup(date,text,jsonb)',
    'public.submit_daily_close(jsonb)',
    'public.correct_daily_close(jsonb)'
  ];
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: run this file from Supabase SQL Editor as postgres';
  END IF;

  SELECT p.id
  INTO v_staff_a
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE
    AND upper(p.role::text) = 'STAFF'
  ORDER BY p.id
  LIMIT 1;

  IF v_staff_a IS NULL THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: no active STAFF profile is available';
  END IF;

  SELECT p.id
  INTO v_staff_b
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE
    AND upper(p.role::text) = 'STAFF'
    AND p.id <> v_staff_a
  ORDER BY p.id
  LIMIT 1;

  SELECT p.id
  INTO v_manager
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE
    AND upper(p.role::text) IN ('MANAGER', 'OWNER')
  ORDER BY
    CASE upper(p.role::text) WHEN 'MANAGER' THEN 0 ELSE 1 END,
    p.id
  LIMIT 1;

  IF v_manager IS NULL THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: no active MANAGER or OWNER profile is available';
  END IF;

  SELECT
    count(*)::integer,
    jsonb_agg(
      jsonb_build_object(
        'platform', p.name,
        'action', 'SET',
        'gross_income', 0
      )
      ORDER BY p.name
    ),
    min(p.name)
  INTO
    v_active_platform_count,
    v_platform_payload,
    v_first_platform
  FROM public.platforms AS p
  WHERE p.is_active IS TRUE;

  IF v_active_platform_count < 1 THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: at least one active platform is required';
  END IF;

  /* Exact safe historical dates were selected before BEGIN and survive rollback. */
  SELECT array_agg(value::date ORDER BY ord)
  INTO v_dates
  FROM jsonb_array_elements_text(
    current_setting('wak_smoke.verification_dates')::jsonb
  ) WITH ORDINALITY AS dates(value, ord);

  IF COALESCE(cardinality(v_dates), 0) <> 7 THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: fewer than 7 empty historical dates are available in the candidate window';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_dates) AS selected(business_date)
    WHERE selected.business_date < current_date - 5000
       OR selected.business_date > current_date - 3650
       OR selected.business_date > current_date + 2
  ) THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: selected business dates are outside the approved historical window';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.platform_fee_settings AS fees
    WHERE fees.commission_pct IS NULL
       OR fees.subscription_fee IS NULL
       OR fees.commission_pct < 0
       OR fees.subscription_fee < 0
  ) THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: platform fee settings must be nonnegative for smoke-test inputs';
  END IF;

  SELECT count(*)::integer
  INTO v_existing_count
  FROM (
    SELECT c.business_date
    FROM public.cashup_sessions AS c
    WHERE c.store_id = 'MOOROOLBARK'
      AND c.business_date = ANY (v_dates)

    UNION ALL

    SELECT ds.business_date
    FROM public.daily_sales AS ds
    WHERE ds.store_id = 'MOOROOLBARK'
      AND ds.business_date = ANY (v_dates)

    UNION ALL

    SELECT pi.business_date
    FROM public.platform_income AS pi
    WHERE pi.store_id = 'MOOROOLBARK'
      AND pi.business_date = ANY (v_dates)
  ) AS existing_rows;

  IF v_existing_count <> 0 THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: one or more disposable dates already contain data: %',
      v_dates;
  END IF;

  /* Serialize these test dates with all three Migration 1 RPC paths. */
  FOREACH v_date IN ARRAY v_dates LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'MOOROOLBARK:' || v_date::text,
        0
      )
    );
  END LOOP;

  /* Recheck after obtaining the locks and before the first fixture write. */
  SELECT count(*)::integer
  INTO v_existing_count
  FROM (
    SELECT c.business_date
    FROM public.cashup_sessions AS c
    WHERE c.store_id = 'MOOROOLBARK'
      AND c.business_date = ANY (v_dates)

    UNION ALL

    SELECT ds.business_date
    FROM public.daily_sales AS ds
    WHERE ds.store_id = 'MOOROOLBARK'
      AND ds.business_date = ANY (v_dates)

    UNION ALL

    SELECT pi.business_date
    FROM public.platform_income AS pi
    WHERE pi.store_id = 'MOOROOLBARK'
      AND pi.business_date = ANY (v_dates)
  ) AS existing_rows;

  IF v_existing_count <> 0 THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: disposable dates changed while locks were acquired';
  END IF;

  SELECT r.oid
  INTO v_authenticated_role
  FROM pg_catalog.pg_roles AS r
  WHERE r.rolname = 'authenticated';

  SELECT r.oid
  INTO v_anon_role
  FROM pg_catalog.pg_roles AS r
  WHERE r.rolname = 'anon';

  IF v_authenticated_role IS NULL OR v_anon_role IS NULL THEN
    RAISE EXCEPTION
      'SMOKE_PRECONDITION: Supabase anon/authenticated roles are unavailable';
  END IF;

  FOREACH v_signature IN ARRAY v_all_signatures LOOP
    v_function_oid := to_regprocedure(v_signature);

    IF v_function_oid IS NULL THEN
      RAISE EXCEPTION
        'SMOKE_PRECONDITION: required function is missing: %',
        v_signature;
    END IF;

    v_expected_authenticated :=
      v_signature = ANY (v_authenticated_signatures);

    IF pg_catalog.has_function_privilege(
      v_authenticated_role,
      v_function_oid,
      'EXECUTE'
    ) IS DISTINCT FROM v_expected_authenticated THEN
      RAISE EXCEPTION
        'SMOKE_PRIVILEGE: unexpected authenticated EXECUTE privilege for %',
        v_signature;
    END IF;

    IF pg_catalog.has_function_privilege(
      v_anon_role,
      v_function_oid,
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION
        'SMOKE_PRIVILEGE: anon can execute %',
        v_signature;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS p
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          p.proacl,
          pg_catalog.acldefault('f', p.proowner)
        )
      ) AS privilege
      WHERE p.oid = v_function_oid
        AND privilege.grantee = 0
        AND privilege.privilege_type = 'EXECUTE'
    )
    INTO v_public_execute;

    IF v_public_execute THEN
      RAISE EXCEPTION
        'SMOKE_PRIVILEGE: PUBLIC can execute %',
        v_signature;
    END IF;
  END LOOP;

  PERFORM pg_catalog.set_config(
    'wak_smoke.staff_a',
    v_staff_a::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_smoke.staff_b',
    COALESCE(v_staff_b::text, ''),
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_smoke.manager',
    v_manager::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_smoke.dates',
    to_jsonb(v_dates)::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_smoke.platforms',
    v_platform_payload::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_smoke.first_platform',
    v_first_platform,
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_smoke.active_platform_count',
    v_active_platform_count::text,
    true
  );

  RAISE NOTICE 'PASS PRIVILEGES: authenticated/anon/PUBLIC surface is correct';
  RAISE NOTICE 'Smoke test users: STAFF A %, STAFF B %, MANAGER/OWNER %',
    v_staff_a,
    COALESCE(v_staff_b::text, 'SKIPPED'),
    v_manager;
  RAISE NOTICE 'Disposable dates: %', v_dates;
END
$smoke_preconditions$;

SET LOCAL ROLE authenticated;

/* Successful STAFF paths, validation failures, and legacy STAFF protection. */
DO $smoke_staff_tests$
DECLARE
  v_staff_a uuid := current_setting('wak_smoke.staff_a')::uuid;
  v_staff_b uuid := NULLIF(current_setting('wak_smoke.staff_b'), '')::uuid;
  v_manager uuid := current_setting('wak_smoke.manager')::uuid;
  v_dates date[];
  v_d1 date;
  v_d2 date;
  v_d3 date;
  v_d4 date;
  v_d5 date;
  v_d6 date;
  v_d7 date;
  v_platforms jsonb := current_setting('wak_smoke.platforms')::jsonb;
  v_first_platform text := current_setting('wak_smoke.first_platform');
  v_active_platform_count integer :=
    current_setting('wak_smoke.active_platform_count')::integer;
  v_omitted_platforms jsonb;
  v_morning_counts constant jsonb := jsonb_build_object(
    'note100', 4,
    'note50', 0,
    'note20', 0,
    'note10', 0,
    'note5', 0,
    'coin2', 0,
    'coin1', 0,
    'coin50c', 0,
    'coin20c', 0,
    'coin10c', 0,
    'coin5c', 0
  );
  v_night_counts constant jsonb := jsonb_build_object(
    'note100', 10,
    'note50', 0,
    'note20', 0,
    'note10', 0,
    'note5', 0,
    'coin2', 0,
    'coin1', 0,
    'coin50c', 0,
    'coin20c', 0,
    'coin10c', 0,
    'coin5c', 0
  );
  v_removed_counts constant jsonb := jsonb_build_object(
    'note100', 6,
    'note50', 0,
    'note20', 0,
    'note10', 0,
    'note5', 0,
    'coin2', 0,
    'coin1', 0,
    'coin50c', 0,
    'coin20c', 0,
    'coin10c', 0,
    'coin5c', 0
  );
  v_payload jsonb;
  v_result jsonb;
  v_revision timestamptz;
  v_count integer;
  v_bad_count integer;
  v_failed boolean;
  v_error text;
  v_before_json jsonb;
  v_after_json jsonb;
BEGIN
  SELECT array_agg(value::date ORDER BY ord)
  INTO v_dates
  FROM jsonb_array_elements_text(
    current_setting('wak_smoke.dates')::jsonb
  ) WITH ORDINALITY AS dates(value, ord);

  v_d1 := v_dates[1];
  v_d2 := v_dates[2];
  v_d3 := v_dates[3];
  v_d4 := v_dates[4];
  v_d5 := v_dates[5];
  v_d6 := v_dates[6];
  v_d7 := v_dates[7];

  PERFORM pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_staff_a::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_staff_a,
      'role', 'authenticated'
    )::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM v_staff_a THEN
    RAISE EXCEPTION
      'SMOKE_AUTH: STAFF A claims did not produce the expected auth.uid()';
  END IF;

  /* A. STAFF saves the first MORNING on a clean date. */
  SELECT public.save_morning_cashup(
    v_d1,
    'MOOROOLBARK',
    v_morning_counts
  )
  INTO v_result;

  SELECT count(*)::integer
  INTO v_count
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'MORNING'
    AND c.entered_by = v_staff_a
    AND c.total_cash = 400
    AND c.counts = v_morning_counts;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_ASSERTION A: MORNING row is incorrect';
  END IF;

  RAISE NOTICE 'PASS A: STAFF saved first MORNING with server total 400';

  /* B. STAFF submits the first clean Daily Close. */
  v_payload := jsonb_build_object(
    'business_date', v_d1,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 600,
    'eftpos_sales', 100,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms
  );

  SELECT public.submit_daily_close(v_payload)
  INTO v_result;

  v_revision := (v_result ->> 'night_updated_at')::timestamptz;

  SELECT count(*)::integer
  INTO v_count
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT'
    AND c.entered_by = v_staff_a
    AND c.total_cash = 1000
    AND c.removed_cash = 600
    AND (c.counts ->> '_close_contract_version')::integer = 1
    AND c.counts -> '_removed_counts' = v_removed_counts;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_ASSERTION B: NIGHT row is incorrect';
  END IF;

  SELECT count(*)::integer
  INTO v_count
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d1
    AND ds.store_id = 'MOOROOLBARK'
    AND ds.entered_by = v_staff_a
    AND ds.expected_cash = 600
    AND ds.cash_sales = 600
    AND ds.eftpos_sales = 100
    AND ds.total_sales = 700;

  IF v_count <> 1 THEN
    RAISE EXCEPTION 'SMOKE_ASSERTION B: daily_sales row is incorrect';
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (WHERE pi.gross_income IS DISTINCT FROM 0)::integer
  INTO v_count, v_bad_count
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d1
    AND pi.store_id = 'MOOROOLBARK';

  IF v_count <> v_active_platform_count OR v_bad_count <> 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION B: platform rows do not match active configuration';
  END IF;

  PERFORM pg_catalog.set_config(
    'wak_smoke.d1_revision',
    v_revision::text,
    true
  );

  RAISE NOTICE 'PASS B: clean first close stored server-derived totals';

  /* D. A first-close retry must be rejected. */
  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'DAILY_CLOSE_ALREADY_EXISTS_USE_CORRECTION' IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION D: unexpected retry result: %',
      COALESCE(v_error, 'no error');
  END IF;

  RAISE NOTICE 'PASS D: first-close retry was rejected';

  /* E. STAFF cannot call the correction path. */
  v_payload := jsonb_set(
    v_payload,
    '{expected_night_updated_at}',
    to_jsonb(v_revision)
  );
  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.correct_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'Only an active OWNER or MANAGER may correct a Daily Close'
       IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION E: unexpected STAFF correction result: %',
      COALESCE(v_error, 'no error');
  END IF;

  RAISE NOTICE 'PASS E: STAFF correction was rejected';

  /* J. STAFF cannot change MORNING after NIGHT exists. */
  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.save_morning_cashup(
      v_d1,
      'MOOROOLBARK',
      v_morning_counts
    );
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'MORNING_AFTER_CLOSE_REQUIRES_MANAGER' IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION J: unexpected post-close MORNING result: %',
      COALESCE(v_error, 'no error');
  END IF;

  RAISE NOTICE 'PASS J: STAFF post-close MORNING change was rejected';

  /* Manager/OWNER may save MORNING after close; correction must follow. */
  PERFORM pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_manager::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_manager,
      'role', 'authenticated'
    )::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM v_manager THEN
    RAISE EXCEPTION
      'SMOKE_AUTH: MANAGER/OWNER claims did not produce the expected auth.uid()';
  END IF;
  PERFORM public.save_morning_cashup(
    v_d1,
    'MOOROOLBARK',
    v_morning_counts
  );
  RAISE NOTICE
    'PASS J2: MANAGER/OWNER post-close MORNING save allowed; correction follows later';

  PERFORM pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_staff_a::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_staff_a,
      'role', 'authenticated'
    )::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM v_staff_a THEN
    RAISE EXCEPTION
      'SMOKE_AUTH: restored STAFF A claims did not produce the expected auth.uid()';
  END IF;

  /* G. Nonzero variance without a reason must leave no dependent rows. */
  v_payload := jsonb_build_object(
    'business_date', v_d2,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 601,
    'eftpos_sales', 100,
    'cash_difference', jsonb_build_object(),
    'platforms', v_platforms
  );
  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'cash_difference.reason is required' IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION G: unexpected variance validation result: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT
    (SELECT count(*) FROM public.cashup_sessions AS c
      WHERE c.business_date = v_d2 AND c.store_id = 'MOOROOLBARK')
    + (SELECT count(*) FROM public.daily_sales AS ds
      WHERE ds.business_date = v_d2 AND ds.store_id = 'MOOROOLBARK')
    + (SELECT count(*) FROM public.platform_income AS pi
      WHERE pi.business_date = v_d2 AND pi.store_id = 'MOOROOLBARK')
  INTO v_count;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_ASSERTION G: failed call left rows behind';
  END IF;

  RAISE NOTICE 'PASS G: missing variance reason rejected and rolled back';

  /* H. OTHER requires a nonempty note. */
  v_payload := jsonb_build_object(
    'business_date', v_d3,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 601,
    'eftpos_sales', 100,
    'cash_difference', jsonb_build_object('reason', 'OTHER', 'note', '   '),
    'platforms', v_platforms
  );
  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'cash_difference.note is required when reason is OTHER'
       IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION H: unexpected OTHER-note result: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT
    (SELECT count(*) FROM public.cashup_sessions AS c
      WHERE c.business_date = v_d3 AND c.store_id = 'MOOROOLBARK')
    + (SELECT count(*) FROM public.daily_sales AS ds
      WHERE ds.business_date = v_d3 AND ds.store_id = 'MOOROOLBARK')
    + (SELECT count(*) FROM public.platform_income AS pi
      WHERE pi.business_date = v_d3 AND pi.store_id = 'MOOROOLBARK')
  INTO v_count;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_ASSERTION H: failed call left rows behind';
  END IF;

  RAISE NOTICE 'PASS H: blank OTHER note rejected and rolled back';

  /* I. Omitting one active platform must reject the close. */
  SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ord), '[]'::jsonb)
  INTO v_omitted_platforms
  FROM jsonb_array_elements(v_platforms)
    WITH ORDINALITY AS item(value, ord)
  WHERE item.ord > 1;

  v_payload := jsonb_build_object(
    'business_date', v_d4,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 600,
    'eftpos_sales', 100,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_omitted_platforms
  );
  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position('PLATFORM_PARTIAL' IN COALESCE(v_error, '')) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION I: unexpected platform omission result: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT
    (SELECT count(*) FROM public.cashup_sessions AS c
      WHERE c.business_date = v_d4 AND c.store_id = 'MOOROOLBARK')
    + (SELECT count(*) FROM public.daily_sales AS ds
      WHERE ds.business_date = v_d4 AND ds.store_id = 'MOOROOLBARK')
    + (SELECT count(*) FROM public.platform_income AS pi
      WHERE pi.business_date = v_d4 AND pi.store_id = 'MOOROOLBARK')
  INTO v_count;

  IF v_count <> 0 THEN
    RAISE EXCEPTION 'SMOKE_ASSERTION I: failed call left rows behind';
  END IF;

  RAISE NOTICE 'PASS I: omitted active platform rejected and rolled back';

  /* K. Existing daily_sales without NIGHT requires a manager. */
  INSERT INTO public.daily_sales (
    business_date,
    store_id,
    cash_sales,
    eftpos_sales,
    expected_cash,
    total_sales,
    entered_by
  )
  VALUES (
    v_d5,
    'MOOROOLBARK',
    1,
    2,
    3,
    3,
    v_staff_a
  );

  SELECT to_jsonb(ds)
  INTO v_before_json
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d5
    AND ds.store_id = 'MOOROOLBARK';

  v_payload := jsonb_build_object(
    'business_date', v_d5,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 600,
    'eftpos_sales', 100,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms
  );
  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'DAILY_CLOSE_LEGACY_PARTIAL_REQUIRES_MANAGER'
       IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION K: unexpected daily_sales partial result: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT to_jsonb(ds)
  INTO v_after_json
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d5
    AND ds.store_id = 'MOOROOLBARK';

  IF v_after_json IS DISTINCT FROM v_before_json
     OR EXISTS (
       SELECT 1 FROM public.cashup_sessions AS c
       WHERE c.business_date = v_d5
         AND c.store_id = 'MOOROOLBARK'
         AND c.session_type = 'NIGHT'
     )
     OR EXISTS (
       SELECT 1 FROM public.platform_income AS pi
       WHERE pi.business_date = v_d5
         AND pi.store_id = 'MOOROOLBARK'
     ) THEN
    RAISE EXCEPTION 'SMOKE_ASSERTION K: legacy daily_sales state changed';
  END IF;

  RAISE NOTICE 'PASS K: STAFF daily_sales partial was rejected unchanged';

  /* L. Existing platform data without NIGHT/daily_sales requires a manager. */
  INSERT INTO public.platform_income (
    business_date,
    store_id,
    platform,
    gross_income,
    entered_by
  )
  VALUES (
    v_d6,
    'MOOROOLBARK',
    v_first_platform,
    5,
    v_staff_a
  );

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_before_json
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d6
    AND pi.store_id = 'MOOROOLBARK';

  v_payload := jsonb_build_object(
    'business_date', v_d6,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 600,
    'eftpos_sales', 100,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms
  );
  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'DAILY_CLOSE_LEGACY_PARTIAL_REQUIRES_MANAGER'
       IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION L: unexpected platform partial result: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_after_json
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d6
    AND pi.store_id = 'MOOROOLBARK';

  IF v_after_json IS DISTINCT FROM v_before_json
     OR EXISTS (
       SELECT 1 FROM public.cashup_sessions AS c
       WHERE c.business_date = v_d6
         AND c.store_id = 'MOOROOLBARK'
         AND c.session_type = 'NIGHT'
     )
     OR EXISTS (
       SELECT 1 FROM public.daily_sales AS ds
       WHERE ds.business_date = v_d6
         AND ds.store_id = 'MOOROOLBARK'
     ) THEN
    RAISE EXCEPTION 'SMOKE_ASSERTION L: legacy platform state changed';
  END IF;

  RAISE NOTICE 'PASS L: STAFF platform partial was rejected unchanged';

  /* MORNING ownership before NIGHT exists. */
  PERFORM public.save_morning_cashup(
    v_d7,
    'MOOROOLBARK',
    v_morning_counts
  );

  IF v_staff_b IS NULL THEN
    RAISE NOTICE 'SKIP MORNING OWNERSHIP: second active STAFF unavailable';
  ELSE
    PERFORM pg_catalog.set_config(
      'request.jwt.claim.sub',
      v_staff_b::text,
      true
    );
    PERFORM pg_catalog.set_config(
      'request.jwt.claims',
      jsonb_build_object(
        'sub', v_staff_b,
        'role', 'authenticated'
      )::text,
      true
    );

    IF auth.uid() IS DISTINCT FROM v_staff_b THEN
      RAISE EXCEPTION
        'SMOKE_AUTH: STAFF B claims did not produce the expected auth.uid()';
    END IF;
    v_failed := false;
    v_error := NULL;
    BEGIN
      PERFORM public.save_morning_cashup(
        v_d7,
        'MOOROOLBARK',
        v_morning_counts
      );
    EXCEPTION WHEN OTHERS THEN
      v_failed := true;
      v_error := SQLERRM;
    END;

    IF NOT v_failed
       OR position(
         'STAFF may only update a MORNING cashup they originally entered'
         IN COALESCE(v_error, '')
       ) = 0 THEN
      RAISE EXCEPTION
        'SMOKE_ASSERTION MORNING OWNERSHIP: unexpected result: %',
        COALESCE(v_error, 'no error');
    END IF;

    RAISE NOTICE 'PASS MORNING OWNERSHIP: second STAFF was rejected';
  END IF;

  PERFORM pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_manager::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_manager,
      'role', 'authenticated'
    )::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM v_manager THEN
    RAISE EXCEPTION
      'SMOKE_AUTH: final MANAGER/OWNER claims did not produce the expected auth.uid()';
  END IF;
  PERFORM public.save_morning_cashup(
    v_d7,
    'MOOROOLBARK',
    v_morning_counts
  );

  SELECT count(*)::integer
  INTO v_count
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d7
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'MORNING'
    AND c.entered_by = v_manager;

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION MORNING OWNERSHIP: manager overwrite failed';
  END IF;

  RAISE NOTICE 'PASS MORNING OWNERSHIP: MANAGER/OWNER overwrite succeeded';
END
$smoke_staff_tests$;

/* Manager correction, legacy completion, and explicit atomicity tests. */
DO $smoke_manager_tests$
DECLARE
  v_manager uuid := current_setting('wak_smoke.manager')::uuid;
  v_dates date[];
  v_d1 date;
  v_d6 date;
  v_platforms jsonb := current_setting('wak_smoke.platforms')::jsonb;
  v_first_platform text := current_setting('wak_smoke.first_platform');
  v_active_platform_count integer :=
    current_setting('wak_smoke.active_platform_count')::integer;
  v_changed_platforms jsonb;
  v_morning_counts constant jsonb := jsonb_build_object(
    'note100', 4,
    'note50', 0,
    'note20', 0,
    'note10', 0,
    'note5', 0,
    'coin2', 0,
    'coin1', 0,
    'coin50c', 0,
    'coin20c', 0,
    'coin10c', 0,
    'coin5c', 0
  );
  v_night_counts constant jsonb := jsonb_build_object(
    'note100', 10,
    'note50', 0,
    'note20', 0,
    'note10', 0,
    'note5', 0,
    'coin2', 0,
    'coin1', 0,
    'coin50c', 0,
    'coin20c', 0,
    'coin10c', 0,
    'coin5c', 0
  );
  v_removed_counts constant jsonb := jsonb_build_object(
    'note100', 6,
    'note50', 0,
    'note20', 0,
    'note10', 0,
    'note5', 0,
    'coin2', 0,
    'coin1', 0,
    'coin50c', 0,
    'coin20c', 0,
    'coin10c', 0,
    'coin5c', 0
  );
  v_payload jsonb;
  v_result jsonb;
  v_revision_before timestamptz :=
    current_setting('wak_smoke.d1_revision')::timestamptz;
  v_revision_after timestamptz;
  v_failed boolean;
  v_error text;
  v_count integer;
  v_before_platforms jsonb;
  v_after_platforms jsonb;
  v_before_night jsonb;
  v_after_night jsonb;
  v_before_sales jsonb;
  v_after_sales jsonb;
BEGIN
  SELECT array_agg(value::date ORDER BY ord)
  INTO v_dates
  FROM jsonb_array_elements_text(
    current_setting('wak_smoke.dates')::jsonb
  ) WITH ORDINALITY AS dates(value, ord);

  v_d1 := v_dates[1];
  v_d6 := v_dates[6];

  PERFORM pg_catalog.set_config(
    'request.jwt.claim.sub',
    v_manager::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_manager,
      'role', 'authenticated'
    )::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM v_manager THEN
    RAISE EXCEPTION
      'SMOKE_AUTH: manager-test claims did not produce the expected auth.uid()';
  END IF;

  /* C. Valid correction with the exact current NIGHT revision. */
  v_payload := jsonb_build_object(
    'business_date', v_d1,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', v_revision_before,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 600,
    'eftpos_sales', 101,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms
  );

  SELECT public.correct_daily_close(v_payload)
  INTO v_result;

  v_revision_after := (v_result ->> 'night_updated_at')::timestamptz;

  IF NOT EXISTS (
    SELECT 1
    FROM public.daily_sales AS ds
    WHERE ds.business_date = v_d1
      AND ds.store_id = 'MOOROOLBARK'
      AND ds.eftpos_sales = 101
      AND ds.total_sales = 701
      AND ds.entered_by = v_manager
  ) THEN
    RAISE EXCEPTION 'SMOKE_ASSERTION C: correction was not stored';
  END IF;

  SELECT c.updated_at
  INTO v_revision_after
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  IF v_revision_after IS DISTINCT FROM
     (v_result ->> 'night_updated_at')::timestamptz THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION C: returned revision does not match stored NIGHT revision';
  END IF;

  RAISE NOTICE
    'PASS C: exact-revision MANAGER/OWNER correction stored the business change';
  RAISE NOTICE
    'LIMITATION: Because the complete production smoke suite runs inside one PostgreSQL transaction so it can be rolled back, transaction-stable now() may produce the same cashup_sessions.updated_at across multiple successful updates. Revision advancement across separate transactions will be verified later during application integration testing.';

  /* F. An intentionally incorrect revision must be rejected unchanged. */
  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_before_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d1
    AND pi.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_before_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  SELECT to_jsonb(ds)
  INTO v_before_sales
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d1
    AND ds.store_id = 'MOOROOLBARK';

  v_payload := jsonb_set(
    v_payload,
    '{expected_night_updated_at}',
    to_jsonb(v_revision_after - interval '1 second')
  );
  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.correct_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'DAILY_CLOSE_REVISION_CONFLICT' IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION F: unexpected stale-revision result: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_after_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d1
    AND pi.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_after_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  SELECT to_jsonb(ds)
  INTO v_after_sales
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d1
    AND ds.store_id = 'MOOROOLBARK';

  IF v_after_platforms IS DISTINCT FROM v_before_platforms
     OR v_after_night IS DISTINCT FROM v_before_night
     OR v_after_sales IS DISTINCT FROM v_before_sales THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION F: stale-revision rejection changed stored values';
  END IF;

  RAISE NOTICE 'PASS F: stale manager revision was rejected';

  /* M. Build a changed payload for the existing legacy platform on D6. */
  SELECT jsonb_agg(
    CASE
      WHEN item.value ->> 'platform' = v_first_platform THEN
        jsonb_set(item.value, '{gross_income}', '10'::jsonb)
      ELSE item.value
    END
    ORDER BY item.ord
  )
  INTO v_changed_platforms
  FROM jsonb_array_elements(v_platforms)
    WITH ORDINALITY AS item(value, ord);

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_before_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d6
    AND pi.store_id = 'MOOROOLBARK';

  v_payload := jsonb_build_object(
    'business_date', v_d6,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 600,
    'eftpos_sales', 100,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_changed_platforms
  );

  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.submit_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'FEE_RECALCULATION_CONFIRMATION_REQUIRED' IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION M: unexpected fee confirmation result: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_after_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d6
    AND pi.store_id = 'MOOROOLBARK';

  IF v_after_platforms IS DISTINCT FROM v_before_platforms
     OR EXISTS (
       SELECT 1 FROM public.cashup_sessions AS c
       WHERE c.business_date = v_d6
         AND c.store_id = 'MOOROOLBARK'
         AND c.session_type = 'NIGHT'
     )
     OR EXISTS (
       SELECT 1 FROM public.daily_sales AS ds
       WHERE ds.business_date = v_d6
         AND ds.store_id = 'MOOROOLBARK'
     ) THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION M: unconfirmed fee change mutated state';
  END IF;

  RAISE NOTICE 'PASS M1: changed legacy platform required confirmation';

  v_payload := v_payload || jsonb_build_object(
    'confirm_fee_recalculation', true
  );

  SELECT public.submit_daily_close(v_payload)
  INTO v_result;

  SELECT count(*)::integer
  INTO v_count
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d6
    AND pi.store_id = 'MOOROOLBARK';

  IF v_count <> v_active_platform_count
     OR NOT EXISTS (
       SELECT 1
       FROM public.platform_income AS pi
       WHERE pi.business_date = v_d6
         AND pi.store_id = 'MOOROOLBARK'
         AND pi.gross_income = 10
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.cashup_sessions AS c
       WHERE c.business_date = v_d6
         AND c.store_id = 'MOOROOLBARK'
         AND c.session_type = 'NIGHT'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.daily_sales AS ds
       WHERE ds.business_date = v_d6
         AND ds.store_id = 'MOOROOLBARK'
     ) THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION M: confirmed manager legacy completion is incorrect';
  END IF;

  RAISE NOTICE 'PASS M2: confirmed MANAGER/OWNER legacy completion succeeded';

  /* Explicit atomicity test: platform UPDATE precedes a later validation error. */
  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_before_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d1
    AND pi.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_before_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  SELECT to_jsonb(ds)
  INTO v_before_sales
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d1
    AND ds.store_id = 'MOOROOLBARK';

  SELECT jsonb_agg(
    CASE
      WHEN item.value ->> 'platform' = v_first_platform THEN
        jsonb_set(item.value, '{gross_income}', '1'::jsonb)
      ELSE item.value
    END
    ORDER BY item.ord
  )
  INTO v_changed_platforms
  FROM jsonb_array_elements(v_platforms)
    WITH ORDINALITY AS item(value, ord);

  v_payload := jsonb_build_object(
    'business_date', v_d1,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', v_revision_after,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 601,
    'eftpos_sales', 101,
    'cash_difference', jsonb_build_object(),
    'platforms', v_changed_platforms,
    'confirm_fee_recalculation', true
  );

  v_failed := false;
  v_error := NULL;
  BEGIN
    PERFORM public.correct_daily_close(v_payload);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
    v_error := SQLERRM;
  END;

  IF NOT v_failed
     OR position(
       'cash_difference.reason is required' IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION ATOMICITY: unexpected late failure: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_after_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d1
    AND pi.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_after_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  SELECT to_jsonb(ds)
  INTO v_after_sales
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d1
    AND ds.store_id = 'MOOROOLBARK';

  IF v_after_platforms IS DISTINCT FROM v_before_platforms
     OR v_after_night IS DISTINCT FROM v_before_night
     OR v_after_sales IS DISTINCT FROM v_before_sales THEN
    RAISE EXCEPTION
      'SMOKE_ASSERTION ATOMICITY: late error left partial changes';
  END IF;

  RAISE NOTICE
    'PASS ATOMICITY: platform update and all dependent writes rolled back';
END
$smoke_manager_tests$;

DO $smoke_summary$
DECLARE
  v_dates date[];
BEGIN
  SELECT array_agg(value::date ORDER BY ord)
  INTO v_dates
  FROM jsonb_array_elements_text(
    current_setting('wak_smoke.dates')::jsonb
  ) WITH ORDINALITY AS dates(value, ord);

  RAISE NOTICE 'PASS: all non-skipped Migration 1 smoke tests completed';
  RAISE NOTICE 'Temporary business dates (about to be rolled back): %', v_dates;
END
$smoke_summary$;

ROLLBACK;

/*
 * Final read-only rollback proof. Expected persisted_test_rows = 0.
 * Do not start the script immediately before midnight because this query
 * deliberately recomputes the deterministic dates from current_date.
 */
WITH disposable_dates AS (
  SELECT current_date - offsets.day_offset AS business_date
  FROM generate_series(3650, 3656) AS offsets(day_offset)
), persisted AS (
  SELECT
    'cashup_sessions'::text AS source_table,
    c.business_date,
    c.store_id
  FROM public.cashup_sessions AS c
  JOIN disposable_dates AS d USING (business_date)
  WHERE c.store_id = 'MOOROOLBARK'

  UNION ALL

  SELECT
    'daily_sales',
    ds.business_date,
    ds.store_id
  FROM public.daily_sales AS ds
  JOIN disposable_dates AS d USING (business_date)
  WHERE ds.store_id = 'MOOROOLBARK'

  UNION ALL

  SELECT
    'platform_income',
    pi.business_date,
    pi.store_id
  FROM public.platform_income AS pi
  JOIN disposable_dates AS d USING (business_date)
  WHERE pi.store_id = 'MOOROOLBARK'
)
SELECT
  count(*) AS persisted_test_rows,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'table', source_table,
        'business_date', business_date,
        'store_id', store_id
      )
      ORDER BY source_table, business_date
    ),
    '[]'::jsonb
  ) AS unexpected_rows
FROM persisted;
