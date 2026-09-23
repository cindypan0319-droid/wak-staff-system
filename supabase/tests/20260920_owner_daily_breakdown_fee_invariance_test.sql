/*
 * Migration 2 historical fee-invariance test. DO NOT run before Migration 2.
 * The only mutation is rolled back by the outer transaction.
 */
BEGIN;

DO $test$
DECLARE
  v_business_date date;
  v_store_id text;
  v_platform_name text;
  v_before jsonb;
  v_after jsonb;
  v_old_commission numeric;
  v_new_commission numeric;
BEGIN
  SELECT
    pi.business_date,
    pi.store_id,
    pfs.platform_name,
    pfs.commission_pct
  INTO
    v_business_date,
    v_store_id,
    v_platform_name,
    v_old_commission
  FROM public.platform_income AS pi
  JOIN public.platform_fee_settings AS pfs
    ON pfs.platform_name = CASE regexp_replace(
      upper(btrim(pi.platform)),
      '[[:space:]]+',
      ' ',
      'g'
    )
      WHEN 'DOORDASH' THEN 'DOORDASH'
      WHEN 'UBER EATS' THEN 'UBER_EATS'
      WHEN 'UBER_EATS' THEN 'UBER_EATS'
      WHEN 'UBER' THEN 'UBER_EATS'
      WHEN 'WAK APP' THEN 'WAK'
      WHEN 'WAK' THEN 'WAK'
      WHEN 'DELIVEROO' THEN 'DELIVEROO'
      WHEN 'MENULOG' THEN 'MENULOG'
      ELSE btrim(pi.platform)
    END
  JOIN public.v_owner_daily_breakdown AS v
    ON v.date = pi.business_date
   AND v.store_id = pi.store_id
  ORDER BY pi.business_date, pi.store_id, pi.platform
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'M2_FEE_INVARIANCE_PRECONDITION: no historical platform row has a matching fee setting and view result';
  END IF;

  SELECT to_jsonb(v)
  INTO v_before
  FROM public.v_owner_daily_breakdown AS v
  WHERE v.date = v_business_date
    AND v.store_id = v_store_id;

  v_new_commission := CASE
    WHEN COALESCE(v_old_commission, 0) <= 0.50
      THEN COALESCE(v_old_commission, 0) + 0.01
    ELSE COALESCE(v_old_commission, 0) - 0.01
  END;

  UPDATE public.platform_fee_settings
  SET commission_pct = v_new_commission
  WHERE platform_name = v_platform_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'M2_FEE_INVARIANCE_PRECONDITION: matching fee setting disappeared';
  END IF;

  SELECT to_jsonb(v)
  INTO v_after
  FROM public.v_owner_daily_breakdown AS v
  WHERE v.date = v_business_date
    AND v.store_id = v_store_id;

  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION
      'M2_FEE_INVARIANCE_FAILED: changing current fee settings changed historical result for date %, store %, platform %',
      v_business_date,
      v_store_id,
      v_platform_name;
  END IF;

  RAISE NOTICE
    'PASS: historical result for date %, store % was invariant when % commission changed from % to %',
    v_business_date,
    v_store_id,
    v_platform_name,
    v_old_commission,
    v_new_commission;
END
$test$;

ROLLBACK;
