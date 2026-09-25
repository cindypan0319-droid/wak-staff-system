/*
 * Run as postgres in Supabase SQL Editor after Migration 010.
 * All fixture writes are contained by this one outer transaction.
 */
BEGIN;

DO $fixtures$
DECLARE
  v_manager uuid;
  v_staff uuid;
  v_clock_id bigint;
  v_clock_staff uuid;
  v_week_start date;
  v_period_id bigint;
  v_clock_period_id bigint;
  v_manual_period_id bigint;
  v_clock_version_id bigint;
  v_manual_version_id bigint;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M10_SMOKE_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  SELECT p.id INTO v_manager
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE AND upper(p.role::text) IN ('MANAGER','OWNER')
  ORDER BY p.id LIMIT 1;

  SELECT p.id INTO v_staff
  FROM public.profiles AS p
  WHERE p.is_active IS TRUE AND upper(p.role::text) = 'STAFF'
  ORDER BY p.id LIMIT 1;

  SELECT tc.id, tc.staff_id INTO v_clock_id, v_clock_staff
  FROM public.time_clock AS tc
  JOIN public.profiles AS p ON p.id=tc.staff_id
  WHERE tc.clock_in_at IS NOT NULL AND tc.clock_out_at IS NOT NULL
    AND p.is_active IS TRUE
  ORDER BY tc.id LIMIT 1;

  IF v_manager IS NULL OR v_staff IS NULL OR v_clock_id IS NULL THEN
    RAISE EXCEPTION 'M10_SMOKE_PRE: active Manager/Owner, active STAFF, and a closed clock are required';
  END IF;

  v_week_start := current_date
    - (((EXTRACT(DOW FROM current_date)::integer - 4 + 7) % 7))
    - 28;

  /* 1. A valid Thursday-Wednesday period and valid source rows are accepted. */
  INSERT INTO public.payroll_periods (store_id, week_start, week_end)
  VALUES ('M10_SMOKE_STORE', v_week_start, v_week_start + 6)
  RETURNING id INTO v_period_id;

  INSERT INTO public.work_periods (
    store_id, staff_id, payroll_period_id, source_type, time_clock_id
  ) VALUES (
    'M10_SMOKE_STORE', v_clock_staff, v_period_id, 'CLOCK', v_clock_id
  ) RETURNING id INTO v_clock_period_id;

  INSERT INTO public.work_periods (
    store_id, staff_id, payroll_period_id, source_type, created_by
  ) VALUES (
    'M10_SMOKE_STORE', v_staff, v_period_id, 'MANUAL_NO_CLOCK', v_manager
  ) RETURNING id INTO v_manual_period_id;

  INSERT INTO public.work_period_versions (
    work_period_id, version_number, reason_code, change_source
  ) VALUES (
    v_clock_period_id, 1, 'AUTOMATIC_IMPORT', 'SYSTEM'
  ) RETURNING id INTO v_clock_version_id;

  INSERT INTO public.work_period_versions (
    work_period_id, version_number, reason_code, change_source, created_by
  ) VALUES (
    v_manual_period_id, 1, 'MANUAL_VERIFICATION', 'MANAGER', v_manager
  ) RETURNING id INTO v_manual_version_id;

  UPDATE public.work_periods SET current_version_id=v_clock_version_id
  WHERE id=v_clock_period_id;
  UPDATE public.work_periods SET current_version_id=v_manual_version_id
  WHERE id=v_manual_period_id;

  INSERT INTO public.work_period_anomalies (
    work_period_id, anomaly_type, severity
  ) VALUES (
    v_clock_period_id, 'LATE_START', 'WARNING'
  );

  PERFORM pg_catalog.set_config('wak_m10.manager',v_manager::text,true);
  PERFORM pg_catalog.set_config('wak_m10.staff',v_staff::text,true);
  PERFORM pg_catalog.set_config('wak_m10.clock_id',v_clock_id::text,true);
  PERFORM pg_catalog.set_config('wak_m10.week_start',v_week_start::text,true);
  PERFORM pg_catalog.set_config('wak_m10.period_id',v_period_id::text,true);
  PERFORM pg_catalog.set_config('wak_m10.clock_period_id',v_clock_period_id::text,true);
  PERFORM pg_catalog.set_config('wak_m10.manual_period_id',v_manual_period_id::text,true);
  PERFORM pg_catalog.set_config('wak_m10.clock_version_id',v_clock_version_id::text,true);
  PERFORM pg_catalog.set_config('wak_m10.manual_version_id',v_manual_version_id::text,true);
END
$fixtures$;

DO $constraint_tests$
DECLARE
  v_manager uuid := current_setting('wak_m10.manager')::uuid;
  v_staff uuid := current_setting('wak_m10.staff')::uuid;
  v_clock_id bigint := current_setting('wak_m10.clock_id')::bigint;
  v_week_start date := current_setting('wak_m10.week_start')::date;
  v_period_id bigint := current_setting('wak_m10.period_id')::bigint;
  v_clock_period_id bigint := current_setting('wak_m10.clock_period_id')::bigint;
  v_manual_period_id bigint := current_setting('wak_m10.manual_period_id')::bigint;
  v_clock_version_id bigint := current_setting('wak_m10.clock_version_id')::bigint;
  v_manual_version_id bigint := current_setting('wak_m10.manual_version_id')::bigint;
BEGIN
  /* 2. A non-Thursday start is rejected. */
  BEGIN
    INSERT INTO public.payroll_periods (store_id,week_start,week_end)
    VALUES ('M10_BAD_DAY',v_week_start+1,v_week_start+7);
    RAISE EXCEPTION 'M10_SMOKE_2: non-Thursday start was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  /* 3. A week_end other than start + 6 is rejected. */
  BEGIN
    INSERT INTO public.payroll_periods (store_id,week_start,week_end)
    VALUES ('M10_BAD_END',v_week_start,v_week_start+5);
    RAISE EXCEPTION 'M10_SMOKE_3: invalid week_end was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  /* 4. CLOCK requires a raw clock. */
  BEGIN
    INSERT INTO public.work_periods (store_id,staff_id,payroll_period_id,source_type)
    VALUES ('M10_SMOKE_STORE',v_staff,v_period_id,'CLOCK');
    RAISE EXCEPTION 'M10_SMOKE_4: CLOCK without time_clock_id was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  /* 5. MANUAL_NO_CLOCK rejects a raw clock. */
  BEGIN
    INSERT INTO public.work_periods (
      store_id,staff_id,payroll_period_id,source_type,time_clock_id,created_by
    ) VALUES ('M10_SMOKE_STORE',v_staff,v_period_id,'MANUAL_NO_CLOCK',v_clock_id,v_manager);
    RAISE EXCEPTION 'M10_SMOKE_5: manual row with time_clock_id was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  /* 6. MANUAL_NO_CLOCK requires an actor. */
  BEGIN
    INSERT INTO public.work_periods (store_id,staff_id,payroll_period_id,source_type)
    VALUES ('M10_SMOKE_STORE',v_staff,v_period_id,'MANUAL_NO_CLOCK');
    RAISE EXCEPTION 'M10_SMOKE_6: manual row without created_by was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  /* 7. One raw clock cannot feed two work periods. */
  BEGIN
    INSERT INTO public.work_periods (
      store_id,staff_id,payroll_period_id,source_type,time_clock_id
    ) SELECT 'M10_SMOKE_STORE',tc.staff_id,v_period_id,'CLOCK',tc.id
      FROM public.time_clock AS tc WHERE tc.id=v_clock_id;
    RAISE EXCEPTION 'M10_SMOKE_7: duplicate time_clock_id was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  /* 8. Version numbers are unique within a work period. */
  BEGIN
    INSERT INTO public.work_period_versions (
      work_period_id,version_number,reason_code,change_source
    ) VALUES (v_clock_period_id,1,'DUPLICATE','SYSTEM');
    RAISE EXCEPTION 'M10_SMOKE_8: duplicate version number was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  /* 9. Invalid actual and payable ranges are independently rejected. */
  BEGIN
    INSERT INTO public.work_period_versions (
      work_period_id,version_number,actual_start_at,actual_end_at,reason_code,change_source
    ) VALUES (v_clock_period_id,2,now(),now()-interval '1 minute','BAD_RANGE','SYSTEM');
    RAISE EXCEPTION 'M10_SMOKE_9: invalid actual range was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.work_period_versions (
      work_period_id,version_number,payable_start_at,payable_end_at,reason_code,change_source
    ) VALUES (v_clock_period_id,2,now(),now(),'BAD_RANGE','SYSTEM');
    RAISE EXCEPTION 'M10_SMOKE_9: invalid payable range was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  /* 10. OTHER requires a non-blank note. */
  BEGIN
    INSERT INTO public.work_period_versions (
      work_period_id,version_number,reason_code,change_source
    ) VALUES (v_clock_period_id,2,'OTHER','SYSTEM');
    RAISE EXCEPTION 'M10_SMOKE_10: OTHER without note was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  /* 11. A current pointer cannot target another period's version. */
  BEGIN
    UPDATE public.work_periods SET current_version_id=v_manual_version_id
    WHERE id=v_clock_period_id;
    RAISE EXCEPTION 'M10_SMOKE_11: cross-period current version was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  /* 12. Only one OPEN anomaly of each type may exist per period. */
  BEGIN
    INSERT INTO public.work_period_anomalies (work_period_id,anomaly_type,severity)
    VALUES (v_clock_period_id,'LATE_START','WARNING');
    RAISE EXCEPTION 'M10_SMOKE_12: duplicate open anomaly was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  /* 13. Resolution version must belong to the anomaly's period. */
  BEGIN
    INSERT INTO public.work_period_anomalies (
      work_period_id,anomaly_type,severity,status,resolution_version_id
    ) VALUES (
      v_clock_period_id,'EARLY_FINISH','WARNING','RESOLVED',v_manual_version_id
    );
    RAISE EXCEPTION 'M10_SMOKE_13: cross-period resolution version was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  IF NOT EXISTS (SELECT 1 FROM public.work_period_versions
      WHERE id=v_clock_version_id AND work_period_id=v_clock_period_id) THEN
    RAISE EXCEPTION 'M10_SMOKE: valid fixtures were unexpectedly changed';
  END IF;
END
$constraint_tests$;

/* 14/16. Active Manager/Owner can read, but direct DML is unavailable. */
SET LOCAL ROLE authenticated;
DO $manager_acl_tests$
DECLARE
  v_manager uuid := current_setting('wak_m10.manager')::uuid;
  v_period_id bigint := current_setting('wak_m10.period_id')::bigint;
  v_rows bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',v_manager::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object(
    'sub',v_manager,'role','authenticated')::text,true);

  SELECT count(*) INTO v_rows FROM public.payroll_periods WHERE id=v_period_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'M10_SMOKE_14: active Manager/Owner cannot read canonical data';
  END IF;

  BEGIN
    INSERT INTO public.payroll_periods (store_id,week_start,week_end)
    VALUES ('M10_AUTH_INSERT',date '2026-09-24',date '2026-09-30');
    RAISE EXCEPTION 'M10_SMOKE_16: authenticated INSERT unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.work_periods SET status='READY'
    WHERE id=current_setting('wak_m10.clock_period_id')::bigint;
    RAISE EXCEPTION 'M10_SMOKE_16: authenticated UPDATE unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.work_period_anomalies
    WHERE work_period_id=current_setting('wak_m10.clock_period_id')::bigint;
    RAISE EXCEPTION 'M10_SMOKE_16: authenticated DELETE unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$manager_acl_tests$;

/* 15. STAFF receives zero rows through RLS. */
DO $staff_rls_test$
DECLARE
  v_staff uuid := current_setting('wak_m10.staff')::uuid;
  v_rows bigint;
BEGIN
  PERFORM set_config('request.jwt.claim.sub',v_staff::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object(
    'sub',v_staff,'role','authenticated')::text,true);
  SELECT
    (SELECT count(*) FROM public.payroll_periods)
    + (SELECT count(*) FROM public.work_periods)
    + (SELECT count(*) FROM public.work_period_versions)
    + (SELECT count(*) FROM public.work_period_anomalies)
  INTO v_rows;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'M10_SMOKE_15: STAFF can read canonical rows';
  END IF;
END
$staff_rls_test$;

RESET ROLE;

/* 17. anon has no direct read privilege. */
SET LOCAL ROLE anon;
DO $anon_test$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.payroll_periods;
    RAISE EXCEPTION 'M10_SMOKE_17: anon read unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$anon_test$;
RESET ROLE;

ROLLBACK;

/* 18. Read-only proof that the outer rollback removed every fixture row. */
SELECT CASE WHEN
  (SELECT count(*) FROM public.payroll_periods WHERE store_id='M10_SMOKE_STORE') = 0
  AND (SELECT count(*) FROM public.work_periods WHERE store_id='M10_SMOKE_STORE') = 0
  AND (SELECT count(*) FROM public.work_period_versions AS v
       JOIN public.work_periods AS w ON w.id=v.work_period_id
       WHERE w.store_id='M10_SMOKE_STORE') = 0
  AND (SELECT count(*) FROM public.work_period_anomalies AS a
       JOIN public.work_periods AS w ON w.id=a.work_period_id
       WHERE w.store_id='M10_SMOKE_STORE') = 0
THEN 'M10_SMOKE_OK' ELSE 'M10_SMOKE_PERSISTED_ROWS' END AS result;
