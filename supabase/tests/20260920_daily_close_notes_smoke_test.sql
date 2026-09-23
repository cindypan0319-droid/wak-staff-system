/*
 * Migration 3 rollback-only production smoke test. DO NOT run before
 * Migration 3. All fixture writes occur inside one outer transaction.
 */
BEGIN;

DO $preconditions$
DECLARE
  v_actor uuid;
  v_business_date date;
  v_legacy_business_date date;
  v_platforms jsonb;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION
      'M3_NOTES_PRECONDITION: run this file from Supabase SQL Editor as postgres';
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
      'M3_NOTES_PRECONDITION: no active MANAGER or OWNER profile is available';
  END IF;

  SELECT candidate.business_date
  INTO v_business_date
  FROM (
    SELECT current_date - offsets.day_offset AS business_date
    FROM generate_series(3650, 5000) AS offsets(day_offset)
  ) AS candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cashup_sessions AS c
    WHERE c.business_date = candidate.business_date
      AND c.store_id = 'MOOROOLBARK'
  )
    AND NOT EXISTS (
      SELECT 1 FROM public.daily_sales AS ds
      WHERE ds.business_date = candidate.business_date
        AND ds.store_id = 'MOOROOLBARK'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.platform_income AS pi
      WHERE pi.business_date = candidate.business_date
        AND pi.store_id = 'MOOROOLBARK'
    )
  ORDER BY candidate.business_date
  LIMIT 1;

  IF v_business_date IS NULL THEN
    RAISE EXCEPTION
      'M3_NOTES_PRECONDITION: no empty historical fixture date found';
  END IF;

  SELECT candidate.business_date
  INTO v_legacy_business_date
  FROM (
    SELECT current_date - offsets.day_offset AS business_date
    FROM generate_series(3650, 5000) AS offsets(day_offset)
  ) AS candidate
  WHERE candidate.business_date <> v_business_date
    AND NOT EXISTS (
      SELECT 1 FROM public.cashup_sessions AS c
      WHERE c.business_date = candidate.business_date
        AND c.store_id = 'MOOROOLBARK'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.daily_sales AS ds
      WHERE ds.business_date = candidate.business_date
        AND ds.store_id = 'MOOROOLBARK'
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.platform_income AS pi
      WHERE pi.business_date = candidate.business_date
        AND pi.store_id = 'MOOROOLBARK'
    )
  ORDER BY candidate.business_date
  LIMIT 1;

  IF v_legacy_business_date IS NULL THEN
    RAISE EXCEPTION
      'M3_NOTES_PRECONDITION: no second empty historical fixture date found';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'MOOROOLBARK:' || v_business_date::text,
      0
    )
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'MOOROOLBARK:' || v_legacy_business_date::text,
      0
    )
  );

  IF EXISTS (
    SELECT 1 FROM public.cashup_sessions AS c
    WHERE c.business_date = v_business_date AND c.store_id = 'MOOROOLBARK'
  ) OR EXISTS (
    SELECT 1 FROM public.daily_sales AS ds
    WHERE ds.business_date = v_business_date AND ds.store_id = 'MOOROOLBARK'
  ) OR EXISTS (
    SELECT 1 FROM public.platform_income AS pi
    WHERE pi.business_date = v_business_date AND pi.store_id = 'MOOROOLBARK'
  ) THEN
    RAISE EXCEPTION
      'M3_NOTES_PRECONDITION: fixture date became occupied after locking';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.cashup_sessions AS c
    WHERE c.business_date = v_legacy_business_date
      AND c.store_id = 'MOOROOLBARK'
  ) OR EXISTS (
    SELECT 1 FROM public.daily_sales AS ds
    WHERE ds.business_date = v_legacy_business_date
      AND ds.store_id = 'MOOROOLBARK'
  ) OR EXISTS (
    SELECT 1 FROM public.platform_income AS pi
    WHERE pi.business_date = v_legacy_business_date
      AND pi.store_id = 'MOOROOLBARK'
  ) THEN
    RAISE EXCEPTION
      'M3_NOTES_PRECONDITION: legacy fixture date became occupied after locking';
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
      'M3_NOTES_PRECONDITION: at least one active platform is required';
  END IF;

  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor, 'role', 'authenticated')::text,
    true
  );

  IF auth.uid() IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION
      'M3_NOTES_PRECONDITION: JWT simulation did not produce the expected auth.uid()';
  END IF;

  PERFORM pg_catalog.set_config(
    'wak_m3_notes.actor',
    v_actor::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_m3_notes.business_date',
    v_business_date::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_m3_notes.legacy_business_date',
    v_legacy_business_date::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'wak_m3_notes.platforms',
    v_platforms::text,
    true
  );
END
$preconditions$;

SET LOCAL ROLE authenticated;

DO $test$
DECLARE
  v_actor uuid := current_setting('wak_m3_notes.actor')::uuid;
  v_business_date date := current_setting('wak_m3_notes.business_date')::date;
  v_legacy_business_date date :=
    current_setting('wak_m3_notes.legacy_business_date')::date;
  v_payload jsonb;
  v_platforms jsonb := current_setting('wak_m3_notes.platforms')::jsonb;
  v_result jsonb;
  v_revision timestamptz;
  v_note text;
  v_before_note text;
  v_before_night jsonb;
  v_after_night jsonb;
  v_before_sales jsonb;
  v_after_sales jsonb;
  v_before_platforms jsonb;
  v_after_platforms jsonb;
  v_failed boolean;
  v_error text;

  v_morning_counts constant jsonb := jsonb_build_object(
    'note100', 4, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_night_counts constant jsonb := jsonb_build_object(
    'note100', 10, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
  v_removed_counts constant jsonb := jsonb_build_object(
    'note100', 6, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0,
    'coin10c', 0, 'coin5c', 0
  );
BEGIN
  IF session_user <> 'postgres' OR current_user <> 'authenticated' THEN
    RAISE EXCEPTION
      'M3_NOTES_PRECONDITION: expected postgres session with authenticated local role';
  END IF;

  IF auth.uid() IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION
      'M3_NOTES_PRECONDITION: authenticated role lost the simulated auth.uid()';
  END IF;

  PERFORM public.save_morning_cashup(
    v_business_date,
    'MOOROOLBARK',
    v_morning_counts
  );

  /* 1. First submit stores the exact note atomically. */
  v_payload := jsonb_build_object(
    'business_date', v_business_date,
    'store_id', 'MOOROOLBARK',
    'expected_night_updated_at', NULL,
    'night_counts', v_night_counts,
    'removed_counts', v_removed_counts,
    'cash_sales', 600,
    'eftpos_sales', 100,
    'cash_difference', jsonb_build_object('reason', '', 'note', ''),
    'platforms', v_platforms,
    'notes', E'  Staff close note\nSecond line  '
  );

  SELECT public.submit_daily_close(v_payload)
  INTO v_result;

  v_revision := (v_result ->> 'night_updated_at')::timestamptz;

  SELECT ds.notes
  INTO v_note
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_business_date
    AND ds.store_id = 'MOOROOLBARK';

  IF v_note IS DISTINCT FROM E'  Staff close note\nSecond line  ' THEN
    RAISE EXCEPTION
      'M3_NOTES_ASSERTION_1: submit did not preserve the exact note';
  END IF;

  RAISE NOTICE 'PASS 1: submit persisted notes atomically';

  /* 2. Correction explicitly updates notes in the same transaction. */
  v_payload := jsonb_set(
    v_payload,
    '{expected_night_updated_at}',
    to_jsonb(v_revision)
  ) || jsonb_build_object('notes', 'Manager correction note');

  SELECT public.correct_daily_close(v_payload)
  INTO v_result;

  v_revision := (v_result ->> 'night_updated_at')::timestamptz;

  SELECT ds.notes
  INTO v_note
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_business_date
    AND ds.store_id = 'MOOROOLBARK';

  IF v_note IS DISTINCT FROM 'Manager correction note' THEN
    RAISE EXCEPTION
      'M3_NOTES_ASSERTION_2: correction did not update notes';
  END IF;

  RAISE NOTICE 'PASS 2: correction updated notes atomically';

  /* 3. A late close failure must not partially change notes or NIGHT. */
  SELECT ds.notes
  INTO v_before_note
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_business_date
    AND ds.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_before_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  v_payload := jsonb_set(v_payload, '{cash_sales}', '601'::jsonb)
    || jsonb_build_object(
      'expected_night_updated_at', v_revision,
      'cash_difference', jsonb_build_object(),
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
      'M3_NOTES_ASSERTION_3: unexpected failed-close result: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT ds.notes
  INTO v_note
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_business_date
    AND ds.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_after_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  IF v_note IS DISTINCT FROM v_before_note
     OR v_after_night IS DISTINCT FROM v_before_night THEN
    RAISE EXCEPTION
      'M3_NOTES_ASSERTION_3: failed correction partially changed state';
  END IF;

  RAISE NOTICE 'PASS 3: failed close did not partially change notes';

  /*
   * 3B. A valid core correction followed by notes validation failure must
   * roll back the core mutation as well as preserve the existing note.
   */
  SELECT to_jsonb(ds)
  INTO v_before_sales
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_business_date
    AND ds.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_before_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_before_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_business_date
    AND pi.store_id = 'MOOROOLBARK';

  SELECT c.updated_at
  INTO v_revision
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  v_payload := jsonb_set(v_payload, '{cash_sales}', '600'::jsonb);
  v_payload := jsonb_set(v_payload, '{eftpos_sales}', '101'::jsonb);
  v_payload := jsonb_set(
    v_payload,
    '{cash_difference}',
    jsonb_build_object('reason', '', 'note', '')
  );
  v_payload := jsonb_set(
    v_payload,
    '{expected_night_updated_at}',
    to_jsonb(v_revision)
  );
  v_payload := jsonb_set(
    v_payload,
    '{notes}',
    jsonb_build_object('invalid', true)
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
       'notes must be a string or JSON null' IN COALESCE(v_error, '')
     ) = 0 THEN
    RAISE EXCEPTION
      'M3_NOTES_ASSERTION_3B: unexpected post-core notes failure: %',
      COALESCE(v_error, 'no error');
  END IF;

  SELECT to_jsonb(ds)
  INTO v_after_sales
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_business_date
    AND ds.store_id = 'MOOROOLBARK';

  SELECT to_jsonb(c)
  INTO v_after_night
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  SELECT jsonb_agg(to_jsonb(pi) ORDER BY pi.id::text)
  INTO v_after_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_business_date
    AND pi.store_id = 'MOOROOLBARK';

  IF v_after_sales IS DISTINCT FROM v_before_sales
     OR v_after_night IS DISTINCT FROM v_before_night
     OR v_after_platforms IS DISTINCT FROM v_before_platforms THEN
    RAISE EXCEPTION
      'M3_NOTES_ASSERTION_3B: post-core notes failure partially changed state';
  END IF;

  RAISE NOTICE 'PASS 3B: post-core notes validation failure rolled back all state';

  /* 4. Omitted notes on correction preserve the existing note. */
  v_payload := v_payload - 'notes';
  v_payload := jsonb_set(v_payload, '{cash_sales}', '600'::jsonb);
  v_payload := jsonb_set(v_payload, '{eftpos_sales}', '100'::jsonb);
  v_payload := jsonb_set(
    v_payload,
    '{cash_difference}',
    jsonb_build_object('reason', '', 'note', '')
  );
  v_payload := jsonb_set(
    v_payload,
    '{expected_night_updated_at}',
    to_jsonb(v_revision)
  );

  PERFORM public.correct_daily_close(v_payload);

  SELECT ds.notes
  INTO v_note
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_business_date
    AND ds.store_id = 'MOOROOLBARK';

  IF v_note IS DISTINCT FROM v_before_note THEN
    RAISE EXCEPTION
      'M3_NOTES_ASSERTION_4: omitted correction notes did not preserve the current value';
  END IF;

  RAISE NOTICE 'PASS 4: omitted correction notes preserved the current note';

  /* 5. Explicit JSON null on correction clears notes. */
  SELECT c.updated_at
  INTO v_revision
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = 'MOOROOLBARK'
    AND c.session_type = 'NIGHT';

  v_payload := jsonb_set(
    v_payload,
    '{expected_night_updated_at}',
    to_jsonb(v_revision)
  );
  v_payload := jsonb_set(v_payload, '{notes}', 'null'::jsonb);

  PERFORM public.correct_daily_close(v_payload);

  SELECT ds.notes
  INTO v_note
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_business_date
    AND ds.store_id = 'MOOROOLBARK';

  IF v_note IS NOT NULL THEN
    RAISE EXCEPTION
      'M3_NOTES_ASSERTION_5: explicit JSON null did not clear notes';
  END IF;

  RAISE NOTICE 'PASS 5: explicit JSON null cleared notes';

  /* 6. Legacy-partial submit with omitted notes preserves its historical note. */
  INSERT INTO public.daily_sales (
    business_date,
    store_id,
    cash_sales,
    eftpos_sales,
    expected_cash,
    total_sales,
    entered_by,
    notes
  )
  VALUES (
    v_legacy_business_date,
    'MOOROOLBARK',
    1,
    2,
    3,
    3,
    v_actor,
    'Historical legacy-partial note'
  );

  v_payload := jsonb_build_object(
    'business_date', v_legacy_business_date,
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

  IF NOT EXISTS (
    SELECT 1
    FROM public.cashup_sessions AS c
    WHERE c.business_date = v_legacy_business_date
      AND c.store_id = 'MOOROOLBARK'
      AND c.session_type = 'NIGHT'
  ) THEN
    RAISE EXCEPTION
      'M3_NOTES_ASSERTION_6: legacy-partial submit did not create NIGHT';
  END IF;

  SELECT ds.notes
  INTO v_note
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_legacy_business_date
    AND ds.store_id = 'MOOROOLBARK';

  IF v_note IS DISTINCT FROM 'Historical legacy-partial note' THEN
    RAISE EXCEPTION
      'M3_NOTES_ASSERTION_6: omitted submit notes did not preserve the historical note';
  END IF;

  RAISE NOTICE 'PASS 6: legacy-partial submit preserved omitted notes';
END
$test$;

ROLLBACK;
