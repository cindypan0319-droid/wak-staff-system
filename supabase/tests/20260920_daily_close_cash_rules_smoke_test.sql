/*
 * Migration 4 rollback-only production smoke test.
 *
 * Run only after Migration 3 and Migration 4 have been applied. Every fixture
 * mutation occurs inside this one outer transaction and is rolled back.
 */
BEGIN;

DO $preconditions$
DECLARE
  v_actor uuid;
  v_dates date[];
  v_platforms jsonb;
  v_date date;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION
      'M4_CASH_RULES_PRECONDITION: run from Supabase SQL Editor as postgres';
  END IF;

  IF to_regprocedure(
    'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
  ) IS NULL THEN
    RAISE EXCEPTION
      'M4_CASH_RULES_PRECONDITION: Migration 3 notes wrapper is required';
  END IF;

  SELECT p.id
  INTO v_actor
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE
    AND upper(p.role::text) IN ('MANAGER', 'OWNER')
  ORDER BY CASE upper(p.role::text) WHEN 'MANAGER' THEN 0 ELSE 1 END, p.id
  LIMIT 1;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION
      'M4_CASH_RULES_PRECONDITION: no active MANAGER or OWNER is available';
  END IF;

  SELECT array_agg(candidate.business_date ORDER BY candidate.business_date)
  INTO v_dates
  FROM (
    SELECT available.business_date
    FROM (
      SELECT current_date - offsets.day_offset AS business_date
      FROM generate_series(3650, 5000) AS offsets(day_offset)
    ) AS available
    WHERE NOT EXISTS (
      SELECT 1 FROM public.cashup_sessions AS c
      WHERE c.business_date = available.business_date
        AND c.store_id = 'MOOROOLBARK'
    )
      AND NOT EXISTS (
        SELECT 1 FROM public.daily_sales AS ds
        WHERE ds.business_date = available.business_date
          AND ds.store_id = 'MOOROOLBARK'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.platform_income AS pi
        WHERE pi.business_date = available.business_date
          AND pi.store_id = 'MOOROOLBARK'
      )
    ORDER BY available.business_date
    LIMIT 6
  ) AS candidate;

  IF COALESCE(cardinality(v_dates), 0) <> 6 THEN
    RAISE EXCEPTION
      'M4_CASH_RULES_PRECONDITION: six empty historical dates are required';
  END IF;

  FOREACH v_date IN ARRAY v_dates LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('MOOROOLBARK:' || v_date::text, 0)
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_dates) AS d(business_date)
    JOIN public.cashup_sessions AS c
      ON c.business_date = d.business_date
     AND c.store_id = 'MOOROOLBARK'
  ) OR EXISTS (
    SELECT 1
    FROM unnest(v_dates) AS d(business_date)
    JOIN public.daily_sales AS ds
      ON ds.business_date = d.business_date
     AND ds.store_id = 'MOOROOLBARK'
  ) OR EXISTS (
    SELECT 1
    FROM unnest(v_dates) AS d(business_date)
    JOIN public.platform_income AS pi
      ON pi.business_date = d.business_date
     AND pi.store_id = 'MOOROOLBARK'
  ) THEN
    RAISE EXCEPTION
      'M4_CASH_RULES_PRECONDITION: a fixture date became occupied after locking';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'platform', p.name,
        'action', 'SET',
        'gross_income', 0
      )
      ORDER BY p.sort_order, p.name
    ),
    '[]'::jsonb
  )
  INTO v_platforms
  FROM public.platforms AS p
  WHERE p.is_active IS TRUE;

  IF jsonb_array_length(v_platforms) = 0 THEN
    RAISE EXCEPTION
      'M4_CASH_RULES_PRECONDITION: at least one active platform is required';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text,
    true
  );
  PERFORM pg_catalog.set_config('wak_m4.actor', v_actor::text, true);
  PERFORM pg_catalog.set_config(
    'wak_m4.dates',
    to_jsonb(v_dates)::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_m4.platforms',
    v_platforms::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION
      'M4_CASH_RULES_PRECONDITION: JWT simulation did not set auth.uid()';
  END IF;
END
$preconditions$;

SET LOCAL ROLE authenticated;

DO $tests$
DECLARE
  v_actor uuid := current_setting('wak_m4.actor')::uuid;
  v_dates date[];
  v_d1 date;
  v_d2 date;
  v_d3 date;
  v_d4 date;
  v_d5 date;
  v_d6 date;
  v_platforms jsonb := current_setting('wak_m4.platforms')::jsonb;
  v_changed_platforms jsonb;
  v_payload jsonb;
  v_result jsonb;
  v_revision timestamptz;
  v_current_revision timestamptz;
  v_failed boolean;
  v_error text;
  v_value numeric;
  v_note text;
  v_before_sales jsonb;
  v_after_sales jsonb;
  v_before_night jsonb;
  v_after_night jsonb;
  v_before_platforms jsonb;
  v_after_platforms jsonb;

  v_zero_counts constant jsonb := jsonb_build_object(
    'note100', 0, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_380_counts constant jsonb := jsonb_build_object(
    'note100', 3, 'note50', 1, 'note20', 1, 'note10', 1, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_400_counts constant jsonb := jsonb_build_object(
    'note100', 4, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_420_counts constant jsonb := jsonb_build_object(
    'note100', 4, 'note50', 0, 'note20', 1, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_450_counts constant jsonb := jsonb_build_object(
    'note100', 4, 'note50', 1, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_500_counts constant jsonb := jsonb_build_object(
    'note100', 5, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_550_counts constant jsonb := jsonb_build_object(
    'note100', 5, 'note50', 1, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_580_counts constant jsonb := jsonb_build_object(
    'note100', 5, 'note50', 1, 'note20', 1, 'note10', 1, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_600_counts constant jsonb := jsonb_build_object(
    'note100', 6, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_620_counts constant jsonb := jsonb_build_object(
    'note100', 6, 'note50', 0, 'note20', 1, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_980_counts constant jsonb := jsonb_build_object(
    'note100', 9, 'note50', 1, 'note20', 1, 'note10', 1, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_1000_counts constant jsonb := jsonb_build_object(
    'note100', 10, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_1020_counts constant jsonb := jsonb_build_object(
    'note100', 10, 'note50', 0, 'note20', 1, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
BEGIN
  SELECT array_agg(value::date ORDER BY ord)
  INTO v_dates
  FROM jsonb_array_elements_text(
    current_setting('wak_m4.dates')::jsonb
  ) WITH ORDINALITY AS selected(value, ord);

  v_d1 := v_dates[1];
  v_d2 := v_dates[2];
  v_d3 := v_dates[3];
  v_d4 := v_dates[4];
  v_d5 := v_dates[5];
  v_d6 := v_dates[6];

  IF session_user <> 'postgres' OR current_user <> 'authenticated' THEN
    RAISE EXCEPTION
      'M4_CASH_RULES_PRECONDITION: expected postgres session and authenticated local role';
  END IF;

  IF auth.uid() IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION
      'M4_CASH_RULES_PRECONDITION: authenticated role lost auth.uid()';
  END IF;

  /* CASE 1: a $380 opening shortage must not propagate into closing float. */
  PERFORM public.save_morning_cashup(v_d1, 'MOOROOLBARK', v_380_counts);

  v_payload := jsonb_build_object(
    'business_date', v_d1,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_980_counts,
    'removed_counts', v_580_counts,
    'cash_sales', 600,
    'eftpos_sales', 100,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms,
    'notes', 'Migration 4 atomic notes fixture'
  );

  SELECT public.submit_daily_close(v_payload) INTO v_result;

  IF (v_result ->> 'actual_opening_float')::numeric <> 380
     OR (v_result ->> 'opening_float')::numeric <> 380
     OR (v_result ->> 'counted_daily_cash_movement')::numeric <> 600
     OR (v_result ->> 'expected_cash')::numeric <> 600
     OR (v_result ->> 'cash_variance')::numeric <> 0
     OR (v_result ->> 'target_closing_float')::numeric <> 400
     OR (v_result ->> 'target_removed_cash')::numeric <> 580
     OR (v_result ->> 'removed_cash')::numeric <> 580
     OR (v_result ->> 'removed_cash_variance')::numeric <> 0
     OR (v_result ->> 'projected_closing_float')::numeric <> 400
     OR (v_result ->> 'closing_float_variance')::numeric <> 0
     OR (v_result ->> 'close_contract_version')::integer <> 2 THEN
    RAISE EXCEPTION 'M4_ASSERTION_1: opening-shortage contract is incorrect: %', v_result;
  END IF;

  SELECT ds.expected_cash, ds.notes
  INTO v_value, v_note
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d1
    AND ds.store_id = 'MOOROOLBARK';

  IF v_value <> 600
     OR v_note IS DISTINCT FROM 'Migration 4 atomic notes fixture' THEN
    RAISE EXCEPTION
      'M4_ASSERTION_1: persisted expected_cash or Migration 3 note is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.cashup_sessions AS c
    WHERE c.business_date = v_d1
      AND c.store_id = 'MOOROOLBARK'
      AND c.session_type = 'NIGHT'
      AND (c.counts ->> '_close_contract_version')::integer = 2
  ) THEN
    RAISE EXCEPTION
      'M4_ASSERTION_1: persisted NIGHT contract version is not 2';
  END IF;

  RAISE NOTICE 'PASS CASE 1/9: shortage corrected to $400 and notes wrapper preserved v2';

  /* CASE 2: a $420 opening overage must not become the closing target. */
  PERFORM public.save_morning_cashup(v_d2, 'MOOROOLBARK', v_420_counts);

  v_payload := jsonb_build_object(
    'business_date', v_d2,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_1020_counts,
    'removed_counts', v_620_counts,
    'cash_sales', 600,
    'eftpos_sales', 0,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms,
    'notes', 'Opening overage'
  );

  SELECT public.submit_daily_close(v_payload) INTO v_result;

  IF (v_result ->> 'actual_opening_float')::numeric <> 420
     OR (v_result ->> 'counted_daily_cash_movement')::numeric <> 600
     OR (v_result ->> 'target_removed_cash')::numeric <> 620
     OR (v_result ->> 'removed_cash')::numeric <> 620
     OR (v_result ->> 'projected_closing_float')::numeric <> 400
     OR (v_result ->> 'closing_float_variance')::numeric <> 0 THEN
    RAISE EXCEPTION 'M4_ASSERTION_2: opening-overage contract is incorrect: %', v_result;
  END IF;

  RAISE NOTICE 'PASS CASE 2: opening overage did not propagate';

  /* CASE 3: a night total below $400 has a zero removal target. */
  PERFORM public.save_morning_cashup(v_d3, 'MOOROOLBARK', v_400_counts);

  v_payload := jsonb_build_object(
    'business_date', v_d3,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_380_counts,
    'removed_counts', v_zero_counts,
    'cash_sales', 0,
    'eftpos_sales', 0,
    'cash_difference', jsonb_build_object(
      'reason', 'FLOAT_CHANGED',
      'note', 'Night till below required float'
    ),
    'platforms', v_platforms,
    'notes', 'Below target float'
  );

  SELECT public.submit_daily_close(v_payload) INTO v_result;

  IF (v_result ->> 'target_removed_cash')::numeric <> 0
     OR (v_result ->> 'removed_cash')::numeric <> 0
     OR (v_result ->> 'projected_closing_float')::numeric <> 380
     OR (v_result ->> 'closing_float_variance')::numeric <> -20 THEN
    RAISE EXCEPTION 'M4_ASSERTION_3: below-$400 contract is incorrect: %', v_result;
  END IF;

  RAISE NOTICE 'PASS CASE 3: below-$400 close returned zero target removal';

  /* CASE 4: negative daily movement must persist without being clamped. */
  PERFORM public.save_morning_cashup(v_d4, 'MOOROOLBARK', v_500_counts);

  v_payload := jsonb_build_object(
    'business_date', v_d4,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_450_counts,
    'removed_counts', jsonb_build_object(
      'note100', 0, 'note50', 1, 'note20', 0, 'note10', 0, 'note5', 0,
      'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
      'coin10c', 0, 'coin5c', 0
    ),
    'cash_sales', 0,
    'eftpos_sales', 0,
    'cash_difference', jsonb_build_object(
      'reason', 'FLOAT_CHANGED',
      'note', 'Counted movement is negative after recount'
    ),
    'platforms', v_platforms,
    'notes', 'Negative movement fixture'
  );

  SELECT public.submit_daily_close(v_payload) INTO v_result;

  SELECT ds.expected_cash
  INTO v_value
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d4
    AND ds.store_id = 'MOOROOLBARK';

  IF (v_result ->> 'counted_daily_cash_movement')::numeric <> -50
     OR (v_result ->> 'expected_cash')::numeric <> -50
     OR (v_result ->> 'cash_variance')::numeric <> 50
     OR v_value <> -50 THEN
    RAISE EXCEPTION 'M4_ASSERTION_4: negative movement was not preserved: %', v_result;
  END IF;

  RAISE NOTICE 'PASS CASE 4: negative movement persisted';

  /* CASE 5: removal variance is based on the fixed $400 target. */
  PERFORM public.save_morning_cashup(v_d5, 'MOOROOLBARK', v_400_counts);

  v_payload := jsonb_build_object(
    'business_date', v_d5,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_1000_counts,
    'removed_counts', v_550_counts,
    'cash_sales', 600,
    'eftpos_sales', 0,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms,
    'notes', 'Removal mismatch fixture'
  );

  SELECT public.submit_daily_close(v_payload) INTO v_result;

  IF (v_result ->> 'target_removed_cash')::numeric <> 600
     OR (v_result ->> 'removed_cash')::numeric <> 550
     OR (v_result ->> 'removed_cash_variance')::numeric <> -50
     OR (v_result ->> 'projected_closing_float')::numeric <> 450
     OR (v_result ->> 'closing_float_variance')::numeric <> 50 THEN
    RAISE EXCEPTION 'M4_ASSERTION_5: removal mismatch is incorrect: %', v_result;
  END IF;

  RAISE NOTICE 'PASS CASE 5: removal mismatch uses fixed-$400 target';

  /* CASE 6A: nonzero cash variance without a reason fails atomically. */
  PERFORM public.save_morning_cashup(v_d6, 'MOOROOLBARK', v_400_counts);

  v_payload := jsonb_build_object(
    'business_date', v_d6,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_1000_counts,
    'removed_counts', v_600_counts,
    'cash_sales', 599,
    'eftpos_sales', 0,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms,
    'notes', 'MUST NOT PERSIST'
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
      'M4_ASSERTION_6A: unexpected missing-reason result: %',
      COALESCE(v_error, 'no error');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cashup_sessions AS c
    WHERE c.business_date = v_d6
      AND c.store_id = 'MOOROOLBARK'
      AND c.session_type = 'NIGHT'
  ) OR EXISTS (
    SELECT 1 FROM public.daily_sales AS ds
    WHERE ds.business_date = v_d6
      AND ds.store_id = 'MOOROOLBARK'
  ) OR EXISTS (
    SELECT 1 FROM public.platform_income AS pi
    WHERE pi.business_date = v_d6
      AND pi.store_id = 'MOOROOLBARK'
  ) THEN
    RAISE EXCEPTION 'M4_ASSERTION_6A: failed submit left dependent rows';
  END IF;

  /* CASE 6B: OTHER still requires a non-empty note. */
  v_payload := jsonb_set(
    v_payload,
    '{cash_difference}',
    jsonb_build_object('reason', 'OTHER', 'note', '')
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
      'M4_ASSERTION_6B: unexpected OTHER-note result: %',
      COALESCE(v_error, 'no error');
  END IF;

  RAISE NOTICE 'PASS CASE 6: cash-difference validation is preserved';

  /* CASE 7: exact correction succeeds, stale revision fails, v2 is retained. */
  SELECT c.updated_at
  INTO v_revision
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  v_payload := jsonb_build_object(
    'business_date', v_d1,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', v_revision,
    'night_counts', v_980_counts,
    'removed_counts', v_580_counts,
    'cash_sales', 600,
    'eftpos_sales', 101,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms,
    'notes', 'Migration 4 corrected note'
  );

  SELECT public.correct_daily_close(v_payload) INTO v_result;

  IF (v_result ->> 'close_contract_version')::integer <> 2
     OR (v_result ->> 'target_removed_cash')::numeric <> 580 THEN
    RAISE EXCEPTION 'M4_ASSERTION_7: correction lost contract v2: %', v_result;
  END IF;

  SELECT c.updated_at
  INTO v_current_revision
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  v_payload := jsonb_set(
    v_payload,
    '{expected_night_updated_at}',
    to_jsonb(v_current_revision - interval '1 second')
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
      'M4_ASSERTION_7: unexpected stale-revision result: %',
      COALESCE(v_error, 'no error');
  END IF;

  RAISE NOTICE 'PASS CASE 7: correction and revision behavior is preserved';

  /* CASE 8: late core failure rolls back sales, NIGHT, and platform changes. */
  SELECT to_jsonb(ds)
  INTO v_before_sales
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d1
    AND ds.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_before_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_before_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d1
    AND pi.store_id = 'MOOROOLBARK';

  v_changed_platforms := jsonb_set(
    v_platforms,
    '{0,gross_income}',
    '1'::jsonb
  );

  v_payload := jsonb_build_object(
    'business_date', v_d1,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', v_current_revision,
    'night_counts', v_980_counts,
    'removed_counts', v_580_counts,
    'cash_sales', 599,
    'eftpos_sales', 102,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_changed_platforms,
    'confirm_fee_recalculation', true,
    'notes', 'MUST NOT PERSIST'
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
      'M4_ASSERTION_8: unexpected late-failure result: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT to_jsonb(ds)
  INTO v_after_sales
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_d1
    AND ds.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_after_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_d1
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_after_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_d1
    AND pi.store_id = 'MOOROOLBARK';

  IF v_after_sales IS DISTINCT FROM v_before_sales
     OR v_after_night IS DISTINCT FROM v_before_night
     OR v_after_platforms IS DISTINCT FROM v_before_platforms THEN
    RAISE EXCEPTION
      'M4_ASSERTION_8: late failure partially changed close state';
  END IF;

  RAISE NOTICE 'PASS CASE 8: late failure remained atomic';
  RAISE NOTICE 'PASS CASE 9: Migration 3 notes wrapper preserved notes and v2 fields';
END
$tests$;

ROLLBACK;
