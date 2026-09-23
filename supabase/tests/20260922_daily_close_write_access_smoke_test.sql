/*
 * Run as postgres in Supabase SQL Editor, as one batch, only AFTER Migration 5.
 * One outer transaction rolls back every fixture. No TRUNCATE is executed.
 * Do not start immediately before midnight: the final proof recomputes the same
 * fixed historical test date from current_date after ROLLBACK.
 */
BEGIN;

DO $precondition$
DECLARE
  v_date date := current_date - 3650;
  v_staff uuid;
  v_manager uuid;
  v_platforms jsonb;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M5_SMOKE_PRE: run as postgres in Supabase SQL Editor';
  END IF;
  SELECT p.id INTO v_staff FROM public.profiles p
  WHERE p.is_active IS TRUE AND upper(p.role::text) = 'STAFF'
  ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_manager FROM public.profiles p
  WHERE p.is_active IS TRUE AND upper(p.role::text) IN ('MANAGER','OWNER')
  ORDER BY CASE upper(p.role::text) WHEN 'MANAGER' THEN 0 ELSE 1 END, p.id LIMIT 1;
  IF v_staff IS NULL OR v_manager IS NULL THEN
    RAISE EXCEPTION 'M5_SMOKE_PRE: active STAFF and MANAGER/OWNER profiles required';
  END IF;
  SELECT jsonb_agg(jsonb_build_object(
    'platform', p.name, 'action', 'SET', 'gross_income', 0) ORDER BY p.name)
  INTO v_platforms FROM public.platforms p WHERE p.is_active IS TRUE;
  IF v_platforms IS NULL THEN
    RAISE EXCEPTION 'M5_SMOKE_PRE: no active platforms';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.platforms p WHERE p.is_active IS TRUE
    GROUP BY public._wak_canonical_platform(p.name) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'M5_SMOKE_PRE: active platform aliases collide';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.platform_fee_settings f
    WHERE f.commission_pct IS NULL OR f.subscription_fee IS NULL
      OR f.commission_pct < 0 OR f.subscription_fee < 0
  ) THEN
    RAISE EXCEPTION 'M5_SMOKE_PRE: invalid configured platform fees';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('MOOROOLBARK:' || v_date::text, 0));
  IF EXISTS (SELECT 1 FROM public.cashup_sessions
             WHERE store_id='MOOROOLBARK' AND business_date=v_date)
     OR EXISTS (SELECT 1 FROM public.daily_sales
                WHERE store_id='MOOROOLBARK' AND business_date=v_date)
     OR EXISTS (SELECT 1 FROM public.platform_income
                WHERE store_id='MOOROOLBARK' AND business_date=v_date) THEN
    RAISE EXCEPTION 'M5_SMOKE_PRE: historical test date % already has records', v_date;
  END IF;
  PERFORM pg_catalog.set_config('wak_m5.date',v_date::text,true);
  PERFORM pg_catalog.set_config('wak_m5.staff',v_staff::text,true);
  PERFORM pg_catalog.set_config('wak_m5.manager',v_manager::text,true);
  PERFORM pg_catalog.set_config('wak_m5.platforms',v_platforms::text,true);
  RAISE NOTICE 'M5_SMOKE_PRE: disposable date %, staff %, manager/owner %',
    v_date,v_staff,v_manager;
END
$precondition$;

SET LOCAL ROLE authenticated;

DO $smoke$
DECLARE
  v_date date := current_setting('wak_m5.date')::date;
  v_staff uuid := current_setting('wak_m5.staff')::uuid;
  v_manager uuid := current_setting('wak_m5.manager')::uuid;
  v_platforms jsonb := current_setting('wak_m5.platforms')::jsonb;
  v_table text;
  v_column text;
  v_counts_400 jsonb := jsonb_build_object(
    'note100',4,'note50',0,'note20',0,'note10',0,'note5',0,
    'coin2',0,'coin1',0,'coin50c',0,'coin20c',0,'coin10c',0,'coin5c',0);
  v_counts_1000 jsonb := jsonb_build_object(
    'note100',10,'note50',0,'note20',0,'note10',0,'note5',0,
    'coin2',0,'coin1',0,'coin50c',0,'coin20c',0,'coin10c',0,'coin5c',0);
  v_counts_600 jsonb := jsonb_build_object(
    'note100',6,'note50',0,'note20',0,'note10',0,'note5',0,
    'coin2',0,'coin1',0,'coin50c',0,'coin20c',0,'coin10c',0,'coin5c',0);
  v_payload jsonb;
  v_result jsonb;
  v_read_count bigint;
BEGIN
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'M5_SMOKE: authenticated role simulation failed';
  END IF;
  PERFORM pg_catalog.set_config('request.jwt.claim.sub',v_staff::text,true);
  PERFORM pg_catalog.set_config('request.jwt.claims',
    jsonb_build_object('sub',v_staff,'role','authenticated')::text,true);
  IF auth.uid() IS DISTINCT FROM v_staff THEN
    RAISE EXCEPTION 'M5_SMOKE: STAFF JWT simulation failed';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['daily_sales','platform_income','cashup_sessions'] LOOP
    v_column := CASE v_table
      WHEN 'daily_sales' THEN 'notes'
      WHEN 'platform_income' THEN 'gross_income'
      ELSE 'total_cash' END;
    BEGIN
      EXECUTE format('INSERT INTO public.%I DEFAULT VALUES',v_table);
      RAISE EXCEPTION 'M5_SMOKE: direct INSERT succeeded on %',v_table;
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    BEGIN
      EXECUTE format('UPDATE public.%I SET %I=%I WHERE false',
        v_table,v_column,v_column);
      RAISE EXCEPTION 'M5_SMOKE: direct UPDATE succeeded on %',v_table;
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE false',v_table);
      RAISE EXCEPTION 'M5_SMOKE: direct DELETE succeeded on %',v_table;
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    IF pg_catalog.has_table_privilege(current_user,'public.' || v_table,'TRUNCATE') THEN
      RAISE EXCEPTION 'M5_SMOKE: direct TRUNCATE grant remains on %',v_table;
    END IF;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE false',v_table)
      INTO v_read_count;
    IF v_read_count <> 0 THEN
      RAISE EXCEPTION 'M5_SMOKE: unexpected SELECT result on %',v_table;
    END IF;
    RAISE NOTICE 'PASS direct DML denied, SELECT retained: %',v_table;
  END LOOP;

  PERFORM public.save_morning_cashup(v_date,'MOOROOLBARK',v_counts_400);
  IF NOT EXISTS (
    SELECT 1 FROM public.cashup_sessions c WHERE c.store_id='MOOROOLBARK'
      AND c.business_date=v_date AND c.session_type='MORNING'
      AND c.entered_by=v_staff AND c.total_cash=400
  ) THEN RAISE EXCEPTION 'M5_SMOKE: Morning RPC failed'; END IF;

  v_payload := jsonb_build_object(
    'business_date',v_date,'store_id','MOOROOLBARK',
    'expected_night_updated_at',NULL,'night_counts',v_counts_1000,
    'removed_counts',v_counts_600,'cash_sales',600,'eftpos_sales',100,
    'cash_difference',jsonb_build_object('reason','','note',''),
    'platforms',v_platforms);
  v_result := public.submit_daily_close(v_payload);
  IF (v_result ->> 'night_updated_at') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.daily_sales d WHERE d.store_id='MOOROOLBARK'
         AND d.business_date=v_date AND d.cash_sales=600 AND d.eftpos_sales=100
     ) OR NOT EXISTS (
       SELECT 1 FROM public.cashup_sessions c WHERE c.store_id='MOOROOLBARK'
         AND c.business_date=v_date AND c.session_type='NIGHT' AND c.total_cash=1000
     ) THEN RAISE EXCEPTION 'M5_SMOKE: submit RPC failed'; END IF;
  RAISE NOTICE 'PASS STAFF Morning and first Daily Close RPCs';

  v_payload := jsonb_set(v_payload,'{expected_night_updated_at}',
    to_jsonb(v_result ->> 'night_updated_at'));
  v_payload := jsonb_set(v_payload,'{eftpos_sales}','101'::jsonb);
  BEGIN
    PERFORM public.correct_daily_close(v_payload);
    RAISE EXCEPTION 'M5_SMOKE: STAFF correction unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  PERFORM pg_catalog.set_config('request.jwt.claim.sub',v_manager::text,true);
  PERFORM pg_catalog.set_config('request.jwt.claims',
    jsonb_build_object('sub',v_manager,'role','authenticated')::text,true);
  IF auth.uid() IS DISTINCT FROM v_manager THEN
    RAISE EXCEPTION 'M5_SMOKE: MANAGER/OWNER JWT simulation failed';
  END IF;
  PERFORM public.correct_daily_close(v_payload);
  IF NOT EXISTS (
    SELECT 1 FROM public.daily_sales d WHERE d.store_id='MOOROOLBARK'
      AND d.business_date=v_date AND d.cash_sales=600 AND d.eftpos_sales=101
  ) THEN RAISE EXCEPTION 'M5_SMOKE: authorized correction failed'; END IF;
  RAISE NOTICE 'PASS correction authorization and RPC owner writes';
END
$smoke$;

ROLLBACK;

/* Read-only exact-date proof. Do not run this test immediately before midnight. */
DO $verify$
BEGIN
  IF (SELECT count(*) FROM public.cashup_sessions
      WHERE store_id='MOOROOLBARK' AND business_date=current_date - 3650)
     + (SELECT count(*) FROM public.daily_sales
        WHERE store_id='MOOROOLBARK' AND business_date=current_date - 3650)
     + (SELECT count(*) FROM public.platform_income
        WHERE store_id='MOOROOLBARK' AND business_date=current_date - 3650) <> 0 THEN
    RAISE EXCEPTION 'M5_SMOKE: fixture rows persisted after ROLLBACK';
  END IF;
END
$verify$;

SELECT current_date - 3650 AS tested_business_date,
  (SELECT count(*) FROM public.cashup_sessions
   WHERE store_id='MOOROOLBARK' AND business_date=current_date - 3650)
  + (SELECT count(*) FROM public.daily_sales
     WHERE store_id='MOOROOLBARK' AND business_date=current_date - 3650)
  + (SELECT count(*) FROM public.platform_income
     WHERE store_id='MOOROOLBARK' AND business_date=current_date - 3650)
  AS persisted_fixture_row_count;
