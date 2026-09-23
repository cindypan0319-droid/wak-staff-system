/*
 * Run as postgres in Supabase SQL Editor, as one batch, after Migration 6A.
 * All fixtures are written inside one outer transaction and discarded by the
 * final ROLLBACK. Do not start immediately before midnight because the safe
 * historical date selection is based on current_date.
 */
BEGIN;

DO $precondition$
DECLARE
  v_dates date[];
  v_staff_a uuid;
  v_staff_b uuid;
  v_owner uuid;
  v_inactive uuid;
  v_platform text;
  v_date date;
  v_counts_400 jsonb := pg_catalog.jsonb_build_object(
    'note100', 4, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0, 'coin10c', 0, 'coin5c', 0
  );
  v_counts_1000 jsonb := pg_catalog.jsonb_build_object(
    'note100', 10, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
    'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0, 'coin10c', 0, 'coin5c', 0,
    '_removed_counts', pg_catalog.jsonb_build_object(
      'note100', 6, 'note50', 0, 'note20', 0, 'note10', 0, 'note5', 0,
      'coin2', 0, 'coin1', 0, 'coin50c', 0, 'coin20c', 0, 'coin10c', 0, 'coin5c', 0
    ),
    '_cash_diff_reason', '',
    '_cash_diff_note', '',
    '_close_contract_version', 2
  );
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M6A_SMOKE_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  IF to_regprocedure('public.get_daily_cashup_snapshot(date,text)') IS NULL THEN
    RAISE EXCEPTION 'M6A_SMOKE_PRE: Migration 6A RPC is missing';
  END IF;

  SELECT pg_catalog.array_agg(candidate ORDER BY candidate)
  INTO v_dates
  FROM (
    SELECT current_date - offset_days AS candidate
    FROM pg_catalog.generate_series(3650, 5000) AS g(offset_days)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.cashup_sessions AS c
      WHERE c.store_id = 'MOOROOLBARK'
        AND c.business_date = current_date - offset_days
    )
      AND NOT EXISTS (
        SELECT 1 FROM public.daily_sales AS ds
        WHERE ds.store_id = 'MOOROOLBARK'
          AND ds.business_date = current_date - offset_days
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.platform_income AS pi
        WHERE pi.store_id = 'MOOROOLBARK'
          AND pi.business_date = current_date - offset_days
      )
    ORDER BY candidate
    LIMIT 3
  ) AS safe_dates;

  IF pg_catalog.coalesce(pg_catalog.array_length(v_dates, 1), 0) <> 3 THEN
    RAISE EXCEPTION 'M6A_SMOKE_PRE: three empty historical dates are required';
  END IF;

  FOREACH v_date IN ARRAY v_dates LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('MOOROOLBARK:' || v_date::text, 0)
    );
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_dates) AS d(business_date)
    WHERE EXISTS (
      SELECT 1 FROM public.cashup_sessions AS c
      WHERE c.store_id = 'MOOROOLBARK' AND c.business_date = d.business_date
    ) OR EXISTS (
      SELECT 1 FROM public.daily_sales AS ds
      WHERE ds.store_id = 'MOOROOLBARK' AND ds.business_date = d.business_date
    ) OR EXISTS (
      SELECT 1 FROM public.platform_income AS pi
      WHERE pi.store_id = 'MOOROOLBARK' AND pi.business_date = d.business_date
    )
  ) THEN
    RAISE EXCEPTION 'M6A_SMOKE_PRE: a selected date changed after locking';
  END IF;

  SELECT p.id INTO v_staff_a
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE AND upper(p.role::text) = 'STAFF'
  ORDER BY p.id LIMIT 1;

  SELECT p.id INTO v_staff_b
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE
    AND upper(p.role::text) = 'STAFF'
    AND p.id IS DISTINCT FROM v_staff_a
  ORDER BY p.id LIMIT 1;

  SELECT p.id INTO v_owner
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE AND upper(p.role::text) = 'OWNER'
  ORDER BY p.id LIMIT 1;

  SELECT p.id INTO v_inactive
  FROM public.profiles AS p
  WHERE p.is_active IS NOT TRUE
  ORDER BY p.id LIMIT 1;

  IF v_staff_a IS NULL OR v_staff_b IS NULL OR v_owner IS NULL OR v_inactive IS NULL THEN
    RAISE EXCEPTION
      'M6A_SMOKE_PRE: two active STAFF, one active OWNER, and one inactive profile are required';
  END IF;

  SELECT p.name INTO v_platform
  FROM public.platforms AS p
  WHERE p.is_active IS TRUE
  ORDER BY p.sort_order, p.name, p.id
  LIMIT 1;

  IF v_platform IS NULL THEN
    RAISE EXCEPTION 'M6A_SMOKE_PRE: one active platform is required';
  END IF;

  INSERT INTO public.cashup_sessions (
    business_date, store_id, session_type, counts, total_cash, removed_cash, entered_by
  ) VALUES
    (v_dates[1], 'MOOROOLBARK', 'MORNING', v_counts_400, 400, 0, v_staff_a),
    (v_dates[1], 'MOOROOLBARK', 'NIGHT', v_counts_1000, 1000, 600, v_staff_a);

  INSERT INTO public.daily_sales (
    business_date, store_id, cash_sales, eftpos_sales, expected_cash,
    total_sales, notes, entered_by
  ) VALUES (
    v_dates[1], 'MOOROOLBARK', 600, 250, 600, 950,
    'Migration 6A authoritative read fixture', v_staff_a
  );

  INSERT INTO public.platform_income (
    business_date, store_id, platform, gross_income, entered_by
  ) VALUES (
    v_dates[1], 'MOOROOLBARK', v_platform, 100, v_staff_a
  );

  /* Distractor rows prove the snapshot does not leak another business date. */
  INSERT INTO public.daily_sales (
    business_date, store_id, cash_sales, eftpos_sales, expected_cash,
    total_sales, notes, entered_by
  ) VALUES (
    v_dates[3], 'MOOROOLBARK', 1, 2, 3, 3,
    'Migration 6A out-of-scope fixture', v_staff_a
  );

  INSERT INTO public.platform_income (
    business_date, store_id, platform, gross_income, entered_by
  ) VALUES (
    v_dates[3], 'MOOROOLBARK', v_platform, 999, v_staff_a
  );

  PERFORM pg_catalog.set_config('wak_m6a.dates', pg_catalog.array_to_string(v_dates, ','), true);
  PERFORM pg_catalog.set_config('wak_m6a.staff_a', v_staff_a::text, true);
  PERFORM pg_catalog.set_config('wak_m6a.staff_b', v_staff_b::text, true);
  PERFORM pg_catalog.set_config('wak_m6a.owner', v_owner::text, true);
  PERFORM pg_catalog.set_config('wak_m6a.inactive', v_inactive::text, true);
  PERFORM pg_catalog.set_config('wak_m6a.platform', v_platform, true);
END
$precondition$;

/* Internal unauthenticated guard: postgres can execute, but auth.uid() is NULL. */
DO $unauthenticated$
DECLARE
  v_date date := (pg_catalog.string_to_array(
    current_setting('wak_m6a.dates'), ','
  ))[1]::date;
BEGIN
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', '', true);
  PERFORM pg_catalog.set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  BEGIN
    PERFORM public.get_daily_cashup_snapshot(v_date, 'MOOROOLBARK');
    RAISE EXCEPTION 'M6A_SMOKE: unauthenticated call unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END
$unauthenticated$;

/* anon is also denied at the function ACL boundary. */
SET LOCAL ROLE anon;
DO $anon_acl$
DECLARE
  v_date date := (pg_catalog.string_to_array(
    current_setting('wak_m6a.dates'), ','
  ))[1]::date;
BEGIN
  BEGIN
    PERFORM public.get_daily_cashup_snapshot(v_date, 'MOOROOLBARK');
    RAISE EXCEPTION 'M6A_SMOKE: anon call unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END
$anon_acl$;

RESET ROLE;
SET LOCAL ROLE authenticated;

DO $smoke$
DECLARE
  v_dates text[] := pg_catalog.string_to_array(current_setting('wak_m6a.dates'), ',');
  v_fixture_date date := v_dates[1]::date;
  v_empty_date date := v_dates[2]::date;
  v_staff_a uuid := current_setting('wak_m6a.staff_a')::uuid;
  v_staff_b uuid := current_setting('wak_m6a.staff_b')::uuid;
  v_owner uuid := current_setting('wak_m6a.owner')::uuid;
  v_inactive uuid := current_setting('wak_m6a.inactive')::uuid;
  v_platform text := current_setting('wak_m6a.platform');
  v_snapshot jsonb;
  v_staff_snapshot jsonb;
  v_owner_snapshot jsonb;
  v_before_cashups jsonb;
  v_after_cashups jsonb;
  v_before_sales jsonb;
  v_after_sales jsonb;
  v_before_platforms jsonb;
  v_after_platforms jsonb;
BEGIN
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'M6A_SMOKE: authenticated role simulation failed';
  END IF;

  /* Use OWNER visibility for the before-image used by the no-side-effect proof. */
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  SELECT pg_catalog.jsonb_agg(to_jsonb(c) ORDER BY c.session_type)
  INTO v_before_cashups
  FROM public.cashup_sessions AS c
  WHERE c.store_id = 'MOOROOLBARK' AND c.business_date = v_fixture_date;

  SELECT to_jsonb(ds)
  INTO v_before_sales
  FROM public.daily_sales AS ds
  WHERE ds.store_id = 'MOOROOLBARK' AND ds.business_date = v_fixture_date;

  SELECT pg_catalog.jsonb_agg(to_jsonb(pi) ORDER BY pi.platform)
  INTO v_before_platforms
  FROM public.platform_income AS pi
  WHERE pi.store_id = 'MOOROOLBARK' AND pi.business_date = v_fixture_date;

  /* Inactive profile is rejected. */
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_inactive::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_inactive, 'role', 'authenticated')::text,
    true
  );
  BEGIN
    PERFORM public.get_daily_cashup_snapshot(v_fixture_date, 'MOOROOLBARK');
    RAISE EXCEPTION 'M6A_SMOKE: inactive profile unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  /* STAFF B must see cashups entered by STAFF A despite ownership RLS. */
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_staff_b::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_staff_b, 'role', 'authenticated')::text,
    true
  );
  v_snapshot := public.get_daily_cashup_snapshot(v_fixture_date, 'MOOROOLBARK');
  v_staff_snapshot := v_snapshot;

  IF (v_snapshot #>> '{caller,user_id}')::uuid IS DISTINCT FROM v_staff_b
     OR v_snapshot #>> '{caller,role}' IS DISTINCT FROM 'STAFF'
     OR (v_snapshot ->> 'business_date')::date IS DISTINCT FROM v_fixture_date
     OR v_snapshot ->> 'store_id' IS DISTINCT FROM 'MOOROOLBARK'
     OR (v_snapshot #>> '{morning,exists}')::boolean IS NOT TRUE
     OR (v_snapshot #>> '{night,exists}')::boolean IS NOT TRUE
     OR (v_snapshot #>> '{morning,entered_by}')::uuid IS DISTINCT FROM v_staff_a
     OR (v_snapshot #>> '{night,entered_by}')::uuid IS DISTINCT FROM v_staff_a
     OR (v_snapshot #>> '{morning,total_cash}')::numeric IS DISTINCT FROM 400::numeric
     OR (v_snapshot #>> '{night,total_cash}')::numeric IS DISTINCT FROM 1000::numeric
     OR (v_snapshot #>> '{night,removed_cash}')::numeric IS DISTINCT FROM 600::numeric
     OR v_snapshot #>> '{night,updated_at}' IS NULL THEN
    RAISE EXCEPTION 'M6A_SMOKE: cross-staff cashup snapshot mismatch: %', v_snapshot;
  END IF;

  IF (v_snapshot #>> '{daily_sales,exists}')::boolean IS NOT TRUE
     OR (v_snapshot #>> '{daily_sales,cash_sales}')::numeric IS DISTINCT FROM 600::numeric
     OR (v_snapshot #>> '{daily_sales,eftpos_sales}')::numeric IS DISTINCT FROM 250::numeric
     OR v_snapshot #>> '{daily_sales,notes}' IS DISTINCT FROM
        'Migration 6A authoritative read fixture'
     OR pg_catalog.jsonb_array_length(v_snapshot -> 'platforms') <> 1
     OR v_snapshot #>> '{platforms,0,platform}' IS DISTINCT FROM v_platform
     OR (v_snapshot #>> '{platforms,0,gross_income}')::numeric IS DISTINCT FROM 100::numeric
     OR v_snapshot #>> '{platforms,0,fees}' IS NULL
     OR (v_snapshot #>> '{platforms,0,entered_by}')::uuid IS DISTINCT FROM v_staff_a
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_snapshot -> 'platforms') AS item
       WHERE (item ->> 'gross_income')::numeric = 999
     ) THEN
    RAISE EXCEPTION 'M6A_SMOKE: scoped sales/platform snapshot mismatch: %', v_snapshot;
  END IF;

  IF pg_catalog.jsonb_typeof(v_snapshot -> 'active_platforms') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'M6A_SMOKE: active platform configuration is not an array';
  END IF;

  /* Missing optional rows are represented explicitly, not as an error. */
  v_snapshot := public.get_daily_cashup_snapshot(v_empty_date, 'MOOROOLBARK');
  IF (v_snapshot #>> '{morning,exists}')::boolean IS NOT FALSE
     OR (v_snapshot #>> '{night,exists}')::boolean IS NOT FALSE
     OR (v_snapshot #>> '{daily_sales,exists}')::boolean IS NOT FALSE
     OR pg_catalog.jsonb_array_length(v_snapshot -> 'platforms') <> 0 THEN
    RAISE EXCEPTION 'M6A_SMOKE: empty-date representation mismatch: %', v_snapshot;
  END IF;

  /* Store scope cannot be widened by the caller. */
  BEGIN
    PERFORM public.get_daily_cashup_snapshot(v_fixture_date, 'OTHER_STORE');
    RAISE EXCEPTION 'M6A_SMOKE: wrong-store call unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  /* OWNER receives the same store/date data, with caller metadata changed. */
  PERFORM pg_catalog.set_config('request.jwt.claim.sub', v_owner::text, true);
  PERFORM pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  v_owner_snapshot := public.get_daily_cashup_snapshot(v_fixture_date, 'MOOROOLBARK');
  IF v_owner_snapshot #>> '{caller,role}' IS DISTINCT FROM 'OWNER'
     OR (v_owner_snapshot - 'caller') IS DISTINCT FROM
        (v_staff_snapshot - 'caller') THEN
    RAISE EXCEPTION 'M6A_SMOKE: OWNER snapshot mismatch';
  END IF;

  /* Every read above must leave all source rows byte-for-byte unchanged. */
  SELECT pg_catalog.jsonb_agg(to_jsonb(c) ORDER BY c.session_type)
  INTO v_after_cashups
  FROM public.cashup_sessions AS c
  WHERE c.store_id = 'MOOROOLBARK' AND c.business_date = v_fixture_date;

  SELECT to_jsonb(ds)
  INTO v_after_sales
  FROM public.daily_sales AS ds
  WHERE ds.store_id = 'MOOROOLBARK' AND ds.business_date = v_fixture_date;

  SELECT pg_catalog.jsonb_agg(to_jsonb(pi) ORDER BY pi.platform)
  INTO v_after_platforms
  FROM public.platform_income AS pi
  WHERE pi.store_id = 'MOOROOLBARK' AND pi.business_date = v_fixture_date;

  IF v_after_cashups IS DISTINCT FROM v_before_cashups
     OR v_after_sales IS DISTINCT FROM v_before_sales
     OR v_after_platforms IS DISTINCT FROM v_before_platforms THEN
    RAISE EXCEPTION 'M6A_SMOKE: read RPC changed persisted state';
  END IF;

  RAISE NOTICE 'PASS M6A: authorization, cross-staff reads, scoping, missing rows, and no side effects';
  RAISE NOTICE 'M6A unsupported-role runtime case is structurally unreachable when user_role contains only STAFF/MANAGER/OWNER; the post-migration verification asserts the explicit function guard.';
END
$smoke$;

ROLLBACK;
