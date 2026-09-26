/* Run after Migration 014 as postgres. Every fixture is rolled back. */
BEGIN;

DO $fixtures$
DECLARE
  v_manager uuid;
  v_owner uuid;
  v_staff uuid;
  v_other_staff uuid;
  v_week date;
  v_start timestamptz;
  v_period bigint;
  v_shift bigint;
  v_wrong_staff_shift bigint;
  v_wrong_store_shift bigint;
  v_clock bigint;
  v_wp bigint;
  v_version bigint;
BEGIN
  IF session_user<>'postgres' THEN
    RAISE EXCEPTION 'M14_SMOKE_PRE: run as postgres';
  END IF;
  SELECT id INTO v_manager FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='MANAGER' ORDER BY id LIMIT 1;
  SELECT id INTO v_owner FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='OWNER' ORDER BY id LIMIT 1;
  SELECT id INTO v_staff FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='STAFF' ORDER BY id LIMIT 1;
  SELECT id INTO v_other_staff FROM public.profiles
  WHERE is_active IS TRUE AND id<>v_staff ORDER BY id LIMIT 1;
  IF v_manager IS NULL OR v_owner IS NULL OR v_staff IS NULL OR v_other_staff IS NULL THEN
    RAISE EXCEPTION 'M14_SMOKE_PRE: active Manager, Owner, Staff, and second profile required';
  END IF;

  SELECT d INTO v_week
  FROM (SELECT current_date-g AS d FROM generate_series(3000,5000) g) candidates
  WHERE extract(dow FROM d)=4
    AND NOT EXISTS(SELECT 1 FROM public.payroll_periods p
      WHERE p.store_id='MOOROOLBARK' AND p.week_start=d)
    AND NOT EXISTS(SELECT 1 FROM public.time_clock tc
      WHERE tc.clock_in_at>=d::timestamp AT TIME ZONE 'Australia/Melbourne'
        AND tc.clock_in_at<(d+7)::timestamp AT TIME ZONE 'Australia/Melbourne')
    AND NOT EXISTS(SELECT 1 FROM public.shifts s
      WHERE s.store_id IN ('MOOROOLBARK','M14_OTHER_STORE')
        AND s.shift_start>=d::timestamp AT TIME ZONE 'Australia/Melbourne'
        AND s.shift_start<(d+7)::timestamp AT TIME ZONE 'Australia/Melbourne')
  ORDER BY d LIMIT 1;
  IF v_week IS NULL THEN RAISE EXCEPTION 'M14_SMOKE_PRE: no safe historical week'; END IF;
  v_start:=v_week::timestamp AT TIME ZONE 'Australia/Melbourne';
  PERFORM pg_advisory_xact_lock(hashtextextended('MOOROOLBARK|'||v_week::text,0));
  IF EXISTS(SELECT 1 FROM public.payroll_periods p
      WHERE p.store_id='MOOROOLBARK' AND p.week_start=v_week)
     OR EXISTS(SELECT 1 FROM public.time_clock tc
      WHERE tc.clock_in_at>=v_start AND tc.clock_in_at<v_start+interval '7 days')
     OR EXISTS(SELECT 1 FROM public.shifts s
      WHERE s.store_id IN ('MOOROOLBARK','M14_OTHER_STORE')
        AND s.shift_start>=v_start AND s.shift_start<v_start+interval '7 days') THEN
    RAISE EXCEPTION 'M14_SMOKE_PRE: selected week changed after lock';
  END IF;

  INSERT INTO public.payroll_periods(store_id,week_start,week_end,timezone,shadow_status,generation_version)
  VALUES('MOOROOLBARK',v_week,v_week+6,'Australia/Melbourne','READY_FOR_COMPARISON',1)
  RETURNING id INTO v_period;

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '10 hours',v_start+interval '12 hours',0,1,
    'SCHEDULED',v_manager,'M14_SHIFT_MANAGER') RETURNING id INTO v_shift;
  PERFORM set_config('wak_m14.shift',v_shift::text,true);
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,cover_note)
  VALUES('MOOROOLBARK',v_other_staff,v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours',0,1,
    'SCHEDULED',v_manager,'M14_WRONG_STAFF') RETURNING id INTO v_wrong_staff_shift;
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,cover_note)
  VALUES('M14_OTHER_STORE',v_staff,v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours',0,1,
    'SCHEDULED',v_manager,'M14_WRONG_STORE') RETURNING id INTO v_wrong_store_shift;

  /* Manager fixture starts from a SYSTEM interpretation with both anomaly severities. */
  INSERT INTO public.time_clock(staff_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_start+interval '10 hours',v_start+interval '12 hours','M14_MANAGER')
  RETURNING id INTO v_clock;
  INSERT INTO public.work_periods(store_id,staff_id,payroll_period_id,source_type,time_clock_id,status)
  VALUES('MOOROOLBARK',v_staff,v_period,'CLOCK',v_clock,'NEEDS_REVIEW') RETURNING id INTO v_wp;
  INSERT INTO public.work_period_versions(work_period_id,version_number,disposition,matched_shift_id,
    actual_start_at,actual_end_at,payable_start_at,payable_end_at,reason_code,change_source)
  VALUES(v_wp,1,'ACTIVE',NULL,v_start+interval '10 hours',v_start+interval '12 hours',NULL,NULL,
    'SHADOW_GENERATED','SYSTEM') RETURNING id INTO v_version;
  UPDATE public.work_periods SET current_version_id=v_version WHERE id=v_wp;
  INSERT INTO public.work_period_anomalies(work_period_id,anomaly_type,severity,status,details) VALUES
    (v_wp,'EARLY_START','BLOCKING','OPEN','{"fixture":"M14"}'::jsonb),
    (v_wp,'LATE_START','WARNING','OPEN','{"fixture":"M14"}'::jsonb);
  PERFORM set_config('wak_m14.manager_wp',v_wp::text,true);
  PERFORM set_config('wak_m14.manager_old_version',v_version::text,true);

  /* Owner fixture starts from a LEGACY_IMPORT interpretation. */
  INSERT INTO public.time_clock(staff_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_other_staff,v_start+interval '14 hours',v_start+interval '16 hours','M14_OWNER')
  RETURNING id INTO v_clock;
  INSERT INTO public.work_periods(store_id,staff_id,payroll_period_id,source_type,time_clock_id,status)
  VALUES('MOOROOLBARK',v_other_staff,v_period,'CLOCK',v_clock,'READY') RETURNING id INTO v_wp;
  INSERT INTO public.work_period_versions(work_period_id,version_number,disposition,matched_shift_id,
    actual_start_at,actual_end_at,payable_start_at,payable_end_at,reason_code,reason_note,change_source)
  VALUES(v_wp,1,'ACTIVE',NULL,v_start+interval '14 hours',v_start+interval '16 hours',
    v_start+interval '14 hours',v_start+interval '16 hours','LEGACY_ADJUSTMENT',
    'Imported review fixture','LEGACY_IMPORT') RETURNING id INTO v_version;
  UPDATE public.work_periods SET current_version_id=v_version WHERE id=v_wp;
  PERFORM set_config('wak_m14.owner_wp',v_wp::text,true);
  PERFORM set_config('wak_m14.owner_old_version',v_version::text,true);

  /* Validation fixture remains unchanged through all rejected calls. */
  INSERT INTO public.time_clock(staff_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours','M14_VALIDATE')
  RETURNING id INTO v_clock;
  INSERT INTO public.work_periods(store_id,staff_id,payroll_period_id,source_type,time_clock_id,status)
  VALUES('MOOROOLBARK',v_staff,v_period,'CLOCK',v_clock,'NEEDS_REVIEW') RETURNING id INTO v_wp;
  INSERT INTO public.work_period_versions(work_period_id,version_number,disposition,matched_shift_id,
    actual_start_at,actual_end_at,payable_start_at,payable_end_at,reason_code,change_source)
  VALUES(v_wp,1,'ACTIVE',NULL,v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours',
    NULL,NULL,'SHADOW_GENERATED','SYSTEM') RETURNING id INTO v_version;
  UPDATE public.work_periods SET current_version_id=v_version WHERE id=v_wp;
  PERFORM set_config('wak_m14.validate_wp',v_wp::text,true);
  PERFORM set_config('wak_m14.validate_version',v_version::text,true);
  PERFORM set_config('wak_m14.wrong_staff_shift',v_wrong_staff_shift::text,true);
  PERFORM set_config('wak_m14.wrong_store_shift',v_wrong_store_shift::text,true);
  PERFORM set_config('wak_m14.manager',v_manager::text,true);
  PERFORM set_config('wak_m14.owner',v_owner::text,true);
  PERFORM set_config('wak_m14.staff',v_staff::text,true);
  PERFORM set_config('wak_m14.start',v_start::text,true);
  PERFORM set_config('wak_m14.raw_before',(
    SELECT jsonb_agg(to_jsonb(tc) ORDER BY tc.id)::text FROM public.time_clock tc
    WHERE tc.device_tag LIKE 'M14_%'
  ),true);
END
$fixtures$;

/* A: Manager review. */
SET LOCAL ROLE service_role;
SELECT public.wak_review_work_period(
  current_setting('wak_m14.manager_wp')::bigint,
  current_setting('wak_m14.manager_old_version')::bigint,
  current_setting('wak_m14.manager')::uuid,
  current_setting('wak_m14.shift')::bigint,
  current_setting('wak_m14.start')::timestamptz+interval '10 hours',
  current_setting('wak_m14.start')::timestamptz+interval '12 hours',
  current_setting('wak_m14.start')::timestamptz+interval '10 hours',
  current_setting('wak_m14.start')::timestamptz+interval '12 hours',
  'MANUAL_REVIEW','Manager confirmed attendance'
);
RESET ROLE;

DO $manager_assertions$
DECLARE v_current bigint;
BEGIN
  SELECT current_version_id INTO v_current FROM public.work_periods
  WHERE id=current_setting('wak_m14.manager_wp')::bigint;
  IF NOT EXISTS(
    SELECT 1 FROM public.work_period_versions v
    WHERE v.id=v_current AND v.version_number=2 AND v.disposition='ACTIVE'
      AND v.change_source='MANAGER' AND v.created_by=current_setting('wak_m14.manager')::uuid
      AND v.reason_code='MANUAL_REVIEW'
  ) THEN RAISE EXCEPTION 'M14_SMOKE_A: Manager version differs'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.work_period_versions
      WHERE id=current_setting('wak_m14.manager_old_version')::bigint AND change_source='SYSTEM') THEN
    RAISE EXCEPTION 'M14_SMOKE_D: previous SYSTEM version was not preserved';
  END IF;
  IF (SELECT count(*) FROM public.work_period_anomalies
      WHERE work_period_id=current_setting('wak_m14.manager_wp')::bigint
        AND status='RESOLVED' AND resolved_by=current_setting('wak_m14.manager')::uuid
        AND resolution_version_id=v_current
        AND resolution_reason_code='MANUAL_REVIEW_CONFIRMED')<>2 THEN
    RAISE EXCEPTION 'M14_SMOKE_E: open anomalies were not resolved to the review version';
  END IF;
  PERFORM set_config('wak_m14.manager_current',v_current::text,true);
  PERFORM set_config('wak_m14.manager_version_count',(
    SELECT count(*)::text FROM public.work_period_versions
    WHERE work_period_id=current_setting('wak_m14.manager_wp')::bigint
  ),true);
END
$manager_assertions$;

/* L: identical reviewed save returns unchanged and appends nothing. */
SET LOCAL ROLE service_role;
DO $idempotent_call$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.wak_review_work_period(
    current_setting('wak_m14.manager_wp')::bigint,current_setting('wak_m14.manager_current')::bigint,
    current_setting('wak_m14.manager')::uuid,current_setting('wak_m14.shift')::bigint,
    current_setting('wak_m14.start')::timestamptz+interval '10 hours',
    current_setting('wak_m14.start')::timestamptz+interval '12 hours',
    current_setting('wak_m14.start')::timestamptz+interval '10 hours',
    current_setting('wak_m14.start')::timestamptz+interval '12 hours',
    'MANUAL_REVIEW','Manager confirmed attendance'
  );
  IF (v_result->>'unchanged')::boolean IS DISTINCT FROM true
     OR (v_result->>'current_version_id')::bigint<>
       current_setting('wak_m14.manager_current')::bigint THEN
    RAISE EXCEPTION 'M14_SMOKE_L: identical save did not return unchanged';
  END IF;
END
$idempotent_call$;
RESET ROLE;

DO $idempotency_assertion$
BEGIN
  IF (SELECT count(*) FROM public.work_period_versions
      WHERE work_period_id=current_setting('wak_m14.manager_wp')::bigint)<>
      current_setting('wak_m14.manager_version_count')::integer THEN
    RAISE EXCEPTION 'M14_SMOKE_L: identical save appended a version';
  END IF;
END
$idempotency_assertion$;

/* B: Owner review over an existing LEGACY_IMPORT version. */
SET LOCAL ROLE service_role;
SELECT public.wak_review_work_period(
  current_setting('wak_m14.owner_wp')::bigint,current_setting('wak_m14.owner_old_version')::bigint,
  current_setting('wak_m14.owner')::uuid,NULL,
  current_setting('wak_m14.start')::timestamptz+interval '14 hours',
  current_setting('wak_m14.start')::timestamptz+interval '16 hours',
  current_setting('wak_m14.start')::timestamptz+interval '14 hours',
  current_setting('wak_m14.start')::timestamptz+interval '16 hours',
  'OWNER_REVIEW',NULL
);
RESET ROLE;

DO $owner_assertions$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM public.work_periods wp
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    WHERE wp.id=current_setting('wak_m14.owner_wp')::bigint
      AND v.version_number=2 AND v.change_source='OWNER'
      AND v.created_by=current_setting('wak_m14.owner')::uuid
  ) THEN RAISE EXCEPTION 'M14_SMOKE_B: Owner version differs'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.work_period_versions
      WHERE id=current_setting('wak_m14.owner_old_version')::bigint
        AND change_source='LEGACY_IMPORT') THEN
    RAISE EXCEPTION 'M14_SMOKE_D: previous LEGACY_IMPORT version was not preserved';
  END IF;
END
$owner_assertions$;

/* F-M: every rejected call must roll back its own statement completely. */
SET LOCAL ROLE service_role;
DO $rejections$
DECLARE
  v_wp bigint:=current_setting('wak_m14.validate_wp')::bigint;
  v_version bigint:=current_setting('wak_m14.validate_version')::bigint;
  v_manager uuid:=current_setting('wak_m14.manager')::uuid;
  v_staff uuid:=current_setting('wak_m14.staff')::uuid;
  v_start timestamptz:=current_setting('wak_m14.start')::timestamptz;
BEGIN
  BEGIN
    PERFORM public.wak_review_work_period(v_wp,v_version+999,v_manager,NULL,
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours',
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours','REVIEW',NULL);
    RAISE EXCEPTION 'M14_SMOKE_F';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='M14_SMOKE_F' OR SQLERRM<>'ATTENDANCE_REVIEW_CONFLICT' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.wak_review_work_period(v_wp,v_version,v_manager,NULL,
      v_start+interval '1 day 23 hours',v_start+interval '2 days 1 hour',
      v_start+interval '1 day 23 hours',v_start+interval '2 days 1 hour','REVIEW',NULL);
    RAISE EXCEPTION 'M14_SMOKE_G';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='M14_SMOKE_G' OR SQLERRM<>'ATTENDANCE_REVIEW_CROSSES_MELBOURNE_MIDNIGHT' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.wak_review_work_period(v_wp,v_version,v_manager,NULL,
      v_start+interval '1 day 12 hours',v_start+interval '1 day 10 hours',
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours','REVIEW',NULL);
    RAISE EXCEPTION 'M14_SMOKE_H';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='M14_SMOKE_H' OR SQLERRM<>'ATTENDANCE_REVIEW_INVALID_ACTUAL_RANGE' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.wak_review_work_period(v_wp,v_version,v_manager,NULL,
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours',
      v_start+interval '1 day 9 hours',v_start+interval '1 day 12 hours','REVIEW',NULL);
    RAISE EXCEPTION 'M14_SMOKE_I';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='M14_SMOKE_I' OR SQLERRM<>'ATTENDANCE_REVIEW_PAYABLE_OUTSIDE_ACTUAL' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.wak_review_work_period(v_wp,v_version,v_manager,
      current_setting('wak_m14.wrong_staff_shift')::bigint,
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours',
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours','REVIEW',NULL);
    RAISE EXCEPTION 'M14_SMOKE_J_STAFF';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='M14_SMOKE_J_STAFF' OR SQLERRM<>'ATTENDANCE_REVIEW_SHIFT_STAFF_MISMATCH' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.wak_review_work_period(v_wp,v_version,v_manager,
      current_setting('wak_m14.wrong_store_shift')::bigint,
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours',
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours','REVIEW',NULL);
    RAISE EXCEPTION 'M14_SMOKE_J_STORE';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='M14_SMOKE_J_STORE' OR SQLERRM<>'ATTENDANCE_REVIEW_SHIFT_STORE_MISMATCH' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.wak_review_work_period(v_wp,v_version,v_manager,NULL,
      v_start+interval '11 hours',v_start+interval '13 hours',
      v_start+interval '11 hours',v_start+interval '13 hours','REVIEW',NULL);
    RAISE EXCEPTION 'M14_SMOKE_K';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='M14_SMOKE_K' OR SQLERRM<>'ATTENDANCE_REVIEW_PAYABLE_OVERLAP' THEN RAISE; END IF; END;
  BEGIN
    PERFORM public.wak_review_work_period(v_wp,v_version,v_staff,NULL,
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours',
      v_start+interval '1 day 10 hours',v_start+interval '1 day 12 hours','REVIEW',NULL);
    RAISE EXCEPTION 'M14_SMOKE_M';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM='M14_SMOKE_M' OR SQLERRM<>'ATTENDANCE_REVIEW_ACTOR_NOT_AUTHORIZED' THEN RAISE; END IF; END;
END
$rejections$;
RESET ROLE;

DO $final_assertions$
BEGIN
  /* C: no review call changed any raw evidence. */
  IF (SELECT jsonb_agg(to_jsonb(tc) ORDER BY tc.id) FROM public.time_clock tc
      WHERE tc.device_tag LIKE 'M14_%') IS DISTINCT FROM
      current_setting('wak_m14.raw_before')::jsonb THEN
    RAISE EXCEPTION 'M14_SMOKE_C: raw time_clock evidence changed';
  END IF;
  IF (SELECT current_version_id FROM public.work_periods
      WHERE id=current_setting('wak_m14.validate_wp')::bigint)<>
      current_setting('wak_m14.validate_version')::bigint
     OR (SELECT count(*) FROM public.work_period_versions
      WHERE work_period_id=current_setting('wak_m14.validate_wp')::bigint)<>1 THEN
    RAISE EXCEPTION 'M14_SMOKE_F-M: rejected call changed canonical state';
  END IF;
END
$final_assertions$;

ROLLBACK;

/* N: read-only proof that the outer rollback removed every fixture. */
SELECT CASE WHEN
  NOT EXISTS(SELECT 1 FROM public.time_clock WHERE device_tag LIKE 'M14_%')
  AND NOT EXISTS(SELECT 1 FROM public.shifts WHERE cover_note LIKE 'M14_%')
THEN 'M14_SMOKE_OK' ELSE 'M14_SMOKE_PERSISTED_ROWS' END AS result;
