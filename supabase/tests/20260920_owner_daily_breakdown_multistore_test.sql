/*
 * Migration 2 multi-store isolation test. DO NOT run before Migration 2.
 * Fixtures use an old, empty business date and disposable store IDs. The one
 * outer transaction is always rolled back.
 */
BEGIN;

DO $test$
DECLARE
  v_business_date date;
  v_actor uuid;
  v_store_a constant text := '__WAK_M2_STORE_A__';
  v_store_b constant text := '__WAK_M2_STORE_B__';
  v_row_a public.v_owner_daily_breakdown%ROWTYPE;
  v_row_b public.v_owner_daily_breakdown%ROWTYPE;
  v_fee_a numeric;
  v_fee_b numeric;
BEGIN
  SELECT p.id
  INTO v_actor
  FROM public.profiles AS p
  ORDER BY p.id
  LIMIT 1;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'M2_MULTISTORE_PRECONDITION: no profile exists for entered_by';
  END IF;

  SELECT candidate.business_date
  INTO v_business_date
  FROM (
    SELECT current_date - offsets.day_offset AS business_date
    FROM generate_series(3650, 5000) AS offsets(day_offset)
  ) AS candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.daily_sales AS ds
    WHERE ds.business_date = candidate.business_date
      AND ds.store_id IN (v_store_a, v_store_b)
  )
    AND NOT EXISTS (
      SELECT 1
      FROM public.platform_income AS pi
      WHERE pi.business_date = candidate.business_date
        AND pi.store_id IN (v_store_a, v_store_b)
    )
  ORDER BY candidate.business_date
  LIMIT 1;

  IF v_business_date IS NULL THEN
    RAISE EXCEPTION
      'M2_MULTISTORE_PRECONDITION: no empty historical fixture date found';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_store_a || '|' || v_business_date::text, 0)
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_store_b || '|' || v_business_date::text, 0)
  );

  IF EXISTS (
    SELECT 1 FROM public.daily_sales AS ds
    WHERE ds.business_date = v_business_date
      AND ds.store_id IN (v_store_a, v_store_b)
  ) OR EXISTS (
    SELECT 1 FROM public.platform_income AS pi
    WHERE pi.business_date = v_business_date
      AND pi.store_id IN (v_store_a, v_store_b)
  ) THEN
    RAISE EXCEPTION
      'M2_MULTISTORE_PRECONDITION: fixture keys became occupied after locking';
  END IF;

  INSERT INTO public.daily_sales (
    business_date,
    store_id,
    cash_sales,
    eftpos_sales,
    expected_cash,
    total_sales,
    entered_by
  )
  VALUES
    (v_business_date, v_store_a, 101, 202, 0, 606, v_actor),
    (v_business_date, v_store_b, 1001, 2002, 0, 6006, v_actor);

  INSERT INTO public.platform_income (
    business_date,
    store_id,
    platform,
    gross_income,
    entered_by
  )
  VALUES
    (v_business_date, v_store_a, 'DOORDASH', 303, v_actor),
    (v_business_date, v_store_b, 'DOORDASH', 3003, v_actor);

  SELECT pi.fees
  INTO v_fee_a
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_business_date
    AND pi.store_id = v_store_a
    AND pi.platform = 'DOORDASH';

  SELECT pi.fees
  INTO v_fee_b
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_business_date
    AND pi.store_id = v_store_b
    AND pi.platform = 'DOORDASH';

  SELECT *
  INTO v_row_a
  FROM public.v_owner_daily_breakdown AS v
  WHERE v.date = v_business_date
    AND v.store_id = v_store_a;

  SELECT *
  INTO v_row_b
  FROM public.v_owner_daily_breakdown AS v
  WHERE v.date = v_business_date
    AND v.store_id = v_store_b;

  IF v_row_a.store_id IS NULL OR v_row_b.store_id IS NULL THEN
    RAISE EXCEPTION 'M2_MULTISTORE_FAILED: expected two store-specific rows';
  END IF;

  IF v_row_a.cash IS DISTINCT FROM 101::numeric
     OR v_row_a.eftpos IS DISTINCT FROM 202::numeric
     OR v_row_a.doordash_net IS DISTINCT FROM round(303 - v_fee_a, 2)
     OR v_row_a.total_revenue IS DISTINCT FROM
        round(101 + 202 + 303 - v_fee_a, 2) THEN
    RAISE EXCEPTION
      'M2_MULTISTORE_FAILED: store A contains incorrect or leaked totals: %',
      to_jsonb(v_row_a);
  END IF;

  IF v_row_b.cash IS DISTINCT FROM 1001::numeric
     OR v_row_b.eftpos IS DISTINCT FROM 2002::numeric
     OR v_row_b.doordash_net IS DISTINCT FROM round(3003 - v_fee_b, 2)
     OR v_row_b.total_revenue IS DISTINCT FROM
        round(1001 + 2002 + 3003 - v_fee_b, 2) THEN
    RAISE EXCEPTION
      'M2_MULTISTORE_FAILED: store B contains incorrect or leaked totals: %',
      to_jsonb(v_row_b);
  END IF;

  IF (
    SELECT count(*)
    FROM public.v_owner_daily_breakdown AS v
    WHERE v.date = v_business_date
      AND v.store_id IN (v_store_a, v_store_b)
  ) <> 2 THEN
    RAISE EXCEPTION
      'M2_MULTISTORE_FAILED: expected exactly two isolated result rows';
  END IF;

  RAISE NOTICE
    'PASS: stores % and % remained isolated on business date %',
    v_store_a,
    v_store_b,
    v_business_date;
END
$test$;

ROLLBACK;

/* Read-only zero-persistence proof for the globally unique fixture store IDs. */
SELECT
  (SELECT count(*)
   FROM public.daily_sales AS ds
   WHERE ds.store_id IN ('__WAK_M2_STORE_A__', '__WAK_M2_STORE_B__'))
  +
  (SELECT count(*)
   FROM public.platform_income AS pi
   WHERE pi.store_id IN ('__WAK_M2_STORE_A__', '__WAK_M2_STORE_B__'))
  AS persisted_fixture_row_count;
