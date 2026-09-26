/* Run after Migration 013 as postgres. All fixtures are rolled back. */
BEGIN;

DO $fixtures$
DECLARE
  v_manager uuid;
  v_owner uuid;
  v_staff uuid;
  v_cover_staff uuid;
  v_week date;
  v_start timestamptz;
  v_parent bigint;
  v_child bigint;
BEGIN
  IF session_user<>'postgres' THEN
    RAISE EXCEPTION 'M13_SMOKE_PRE: run as postgres';
  END IF;
  SELECT id INTO v_manager FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='MANAGER' ORDER BY id LIMIT 1;
  SELECT id INTO v_owner FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='OWNER' ORDER BY id LIMIT 1;
  SELECT id INTO v_staff FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='STAFF' ORDER BY id LIMIT 1;
  SELECT id INTO v_cover_staff FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='STAFF' AND id<>v_staff ORDER BY id LIMIT 1;
  IF v_manager IS NULL OR v_owner IS NULL OR v_staff IS NULL OR v_cover_staff IS NULL THEN
    RAISE EXCEPTION 'M13_SMOKE_PRE: active Manager, Owner, and two Staff profiles required';
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
      WHERE s.store_id='MOOROOLBARK'
        AND s.shift_start>=(d::timestamp AT TIME ZONE 'Australia/Melbourne')-interval '6 hours'
        AND s.shift_start<((d+7)::timestamp AT TIME ZONE 'Australia/Melbourne')+interval '6 hours')
  ORDER BY d LIMIT 1;
  IF v_week IS NULL THEN
    RAISE EXCEPTION 'M13_SMOKE_PRE: no safe historical week';
  END IF;
  v_start:=v_week::timestamp AT TIME ZONE 'Australia/Melbourne';
  PERFORM pg_advisory_xact_lock(hashtextextended('MOOROOLBARK|'||v_week::text,0));
  IF EXISTS(SELECT 1 FROM public.payroll_periods p
      WHERE p.store_id='MOOROOLBARK' AND p.week_start=v_week)
     OR EXISTS(SELECT 1 FROM public.time_clock tc
      WHERE tc.clock_in_at>=v_start AND tc.clock_in_at<v_start+interval '7 days')
     OR EXISTS(SELECT 1 FROM public.shifts s
      WHERE s.store_id='MOOROOLBARK' AND s.shift_start>=v_start-interval '6 hours'
        AND s.shift_start<v_start+interval '7 days 6 hours') THEN
    RAISE EXCEPTION 'M13_SMOKE_PRE: selected week changed after lock';
  END IF;

  PERFORM set_config('wak_m13.manager',v_manager::text,true);
  PERFORM set_config('wak_m13.owner',v_owner::text,true);
  PERFORM set_config('wak_m13.staff',v_staff::text,true);
  PERFORM set_config('wak_m13.week',v_week::text,true);

  /* A/G: full cover; parent is not an original-staff candidate, child remains independent. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,covered_by_staff_id,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '17 hours',v_start+interval '21 hours',0,1,
    'COVERED',v_manager,v_cover_staff,'M13_A_PARENT') RETURNING id INTO v_parent;
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,parent_shift_id,cover_note)
  VALUES('MOOROOLBARK',v_cover_staff,v_start+interval '17 hours',v_start+interval '21 hours',0,1,
    'SCHEDULED',v_manager,v_parent,'M13_A_CHILD') RETURNING id INTO v_child;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag) VALUES
    (v_staff,v_parent,v_start+interval '17 hours',v_start+interval '21 hours','M13_A_PARENT'),
    (v_cover_staff,v_child,v_start+interval '17 hours',v_start+interval '21 hours','M13_A_CHILD');

  /* B: tail cover leaves 10:00-16:00 for the original employee. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,covered_by_staff_id,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '1 day 10 hours',v_start+interval '1 day 20 hours',0,1,
    'COVERED',v_manager,v_cover_staff,'M13_B_PARENT') RETURNING id INTO v_parent;
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,parent_shift_id,cover_note)
  VALUES('MOOROOLBARK',v_cover_staff,v_start+interval '1 day 16 hours',v_start+interval '1 day 20 hours',0,1,
    'WORKED',v_manager,v_parent,'M13_B_CHILD') RETURNING id INTO v_child;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag) VALUES
    (v_staff,v_parent,v_start+interval '1 day 10 hours',v_start+interval '1 day 16 hours','M13_B_PARENT'),
    (v_cover_staff,v_child,v_start+interval '1 day 16 hours',v_start+interval '1 day 20 hours','M13_B_CHILD');

  /* C: middle cover leaves two distinct original-employee segments. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,covered_by_staff_id,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '2 days 10 hours',v_start+interval '2 days 20 hours',0,1,
    'COVERED',v_manager,v_cover_staff,'M13_C_PARENT') RETURNING id INTO v_parent;
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,parent_shift_id,cover_note)
  VALUES('MOOROOLBARK',v_cover_staff,v_start+interval '2 days 13 hours',v_start+interval '2 days 16 hours',0,1,
    'SCHEDULED',v_manager,v_parent,'M13_C_CHILD');
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag) VALUES
    (v_staff,v_parent,v_start+interval '2 days 10 hours',v_start+interval '2 days 13 hours','M13_C_FIRST'),
    (v_staff,v_parent,v_start+interval '2 days 16 hours',v_start+interval '2 days 20 hours','M13_C_SECOND');

  /* D: overlapping children union to [12:00,18:00), leaving two edge segments. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,covered_by_staff_id,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '3 days 10 hours',v_start+interval '3 days 20 hours',0,1,
    'COVERED',v_manager,v_cover_staff,'M13_D_PARENT') RETURNING id INTO v_parent;
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,parent_shift_id,cover_note) VALUES
    ('MOOROOLBARK',v_cover_staff,v_start+interval '3 days 12 hours',v_start+interval '3 days 16 hours',0,1,
      'SCHEDULED',v_manager,v_parent,'M13_D_CHILD_1'),
    ('MOOROOLBARK',v_cover_staff,v_start+interval '3 days 14 hours',v_start+interval '3 days 18 hours',0,1,
      'SCHEDULED',v_manager,v_parent,'M13_D_CHILD_2');
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag) VALUES
    (v_staff,v_parent,v_start+interval '3 days 10 hours',v_start+interval '3 days 12 hours','M13_D_FIRST'),
    (v_staff,v_parent,v_start+interval '3 days 18 hours',v_start+interval '3 days 20 hours','M13_D_SECOND');

  /* E: child begins before parent; clamping leaves 14:00-20:00. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,covered_by_staff_id,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '4 days 10 hours',v_start+interval '4 days 20 hours',0,1,
    'COVERED',v_manager,v_cover_staff,'M13_E_PARENT') RETURNING id INTO v_parent;
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,parent_shift_id,cover_note)
  VALUES('MOOROOLBARK',v_cover_staff,v_start+interval '4 days 8 hours',v_start+interval '4 days 14 hours',0,1,
    'SCHEDULED',v_manager,v_parent,'M13_E_CHILD');
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_parent,v_start+interval '4 days 14 hours',v_start+interval '4 days 20 hours','M13_E_PARENT');

  /* F: COVERED without a valid child is blocking review data. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '5 days 10 hours',v_start+interval '5 days 20 hours',0,1,
    'COVERED',v_manager,'M13_F_PARENT') RETURNING id INTO v_parent;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_parent,v_start+interval '5 days 10 hours',v_start+interval '5 days 20 hours','M13_F_PARENT');

  /* J: four normal periods later receive protected current interpretations. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,
    shift_status,created_by,cover_note) VALUES
    ('MOOROOLBARK',v_staff,v_start+interval '6 days 1 hour',v_start+interval '6 days 2 hours',0,1,'SCHEDULED',v_manager,'M13_KEEP_MANAGER'),
    ('MOOROOLBARK',v_staff,v_start+interval '6 days 3 hours',v_start+interval '6 days 4 hours',0,1,'SCHEDULED',v_manager,'M13_KEEP_OWNER'),
    ('MOOROOLBARK',v_staff,v_start+interval '6 days 5 hours',v_start+interval '6 days 6 hours',0,1,'SCHEDULED',v_manager,'M13_KEEP_LEGACY'),
    ('MOOROOLBARK',v_staff,v_start+interval '6 days 7 hours',v_start+interval '6 days 8 hours',0,1,'SCHEDULED',v_manager,'M13_KEEP_VOID');
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  SELECT v_staff,s.id,s.shift_start,s.shift_end,s.cover_note
  FROM public.shifts s WHERE s.cover_note LIKE 'M13_KEEP_%';
END
$fixtures$;

SET LOCAL ROLE service_role;
SELECT public.wak_refresh_attendance_shadow(
  'MOOROOLBARK',current_setting('wak_m13.week')::date,current_setting('wak_m13.manager')::uuid
);
RESET ROLE;

DO $coverage_assertions$
DECLARE
  v_versions integer;
BEGIN
  /* A: full-covered original is not paid/matched; G: child remains independently payable. */
  IF NOT EXISTS(
    SELECT 1 FROM public.time_clock tc
    JOIN public.work_periods wp ON wp.time_clock_id=tc.id
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    JOIN public.work_period_anomalies a ON a.work_period_id=wp.id
    WHERE tc.device_tag='M13_A_PARENT' AND wp.status='NEEDS_REVIEW'
      AND v.matched_shift_id IS NULL AND v.payable_start_at IS NULL AND v.payable_end_at IS NULL
      AND a.anomaly_type='UNROSTERED_WORK' AND a.status='OPEN' AND a.severity='BLOCKING'
  ) THEN RAISE EXCEPTION 'M13_SMOKE_A: full-cover parent remained matchable'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.time_clock tc
    JOIN public.work_periods wp ON wp.time_clock_id=tc.id
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    JOIN public.shifts s ON s.id=v.matched_shift_id
    WHERE tc.device_tag='M13_A_CHILD' AND s.cover_note='M13_A_CHILD'
      AND wp.status='READY' AND v.payable_start_at=s.shift_start AND v.payable_end_at=s.shift_end
  ) THEN RAISE EXCEPTION 'M13_SMOKE_G: cover child was not independently payable'; END IF;

  /* B/E: partial and clamped remaining boundaries drive payable time. */
  IF NOT EXISTS(
    SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    JOIN public.shifts s ON s.id=v.matched_shift_id
    WHERE tc.device_tag='M13_B_PARENT' AND s.cover_note='M13_B_PARENT' AND wp.status='READY'
      AND v.payable_start_at=tc.clock_in_at AND v.payable_end_at=tc.clock_out_at
      AND extract(epoch FROM (v.payable_end_at-v.payable_start_at))=21600
  ) THEN RAISE EXCEPTION 'M13_SMOKE_B: tail partial cover differs'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    JOIN public.shifts s ON s.id=v.matched_shift_id
    WHERE tc.device_tag='M13_E_PARENT' AND s.cover_note='M13_E_PARENT' AND wp.status='READY'
      AND extract(epoch FROM (v.payable_end_at-v.payable_start_at))=21600
  ) THEN RAISE EXCEPTION 'M13_SMOKE_E: child coverage was not clamped'; END IF;

  /* C/D: subtraction can yield two segments; overlapping child ranges are unioned. */
  IF (SELECT count(*) FROM public.time_clock tc
      JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id
      JOIN public.shifts s ON s.id=v.matched_shift_id
      WHERE tc.device_tag IN ('M13_C_FIRST','M13_C_SECOND')
        AND s.cover_note='M13_C_PARENT' AND wp.status='READY')<>2 THEN
    RAISE EXCEPTION 'M13_SMOKE_C: middle-cover segments did not match independently';
  END IF;
  IF (SELECT count(*) FROM public.time_clock tc
      JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id
      JOIN public.shifts s ON s.id=v.matched_shift_id
      WHERE tc.device_tag IN ('M13_D_FIRST','M13_D_SECOND')
        AND s.cover_note='M13_D_PARENT' AND wp.status='READY'
        AND v.payable_start_at=tc.clock_in_at AND v.payable_end_at=tc.clock_out_at)<>2 THEN
    RAISE EXCEPTION 'M13_SMOKE_D: overlapping child coverage was not unioned';
  END IF;

  /* F: missing child creates the dedicated blocking review anomaly. */
  IF NOT EXISTS(
    SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    JOIN public.work_period_anomalies a ON a.work_period_id=wp.id
    WHERE tc.device_tag='M13_F_PARENT' AND wp.status='NEEDS_REVIEW'
      AND v.payable_start_at IS NULL AND v.payable_end_at IS NULL
      AND a.anomaly_type='COVERED_WITHOUT_COVER_SHIFT'
      AND a.status='OPEN' AND a.severity='BLOCKING'
  ) THEN RAISE EXCEPTION 'M13_SMOKE_F: missing-child coverage was not blocked'; END IF;

  /* H: each raw clock maps to exactly one distinct work period. */
  IF EXISTS(
    SELECT tc.id FROM public.time_clock tc
    JOIN public.work_periods wp ON wp.time_clock_id=tc.id
    WHERE tc.device_tag LIKE 'M13_%' GROUP BY tc.id HAVING count(*)<>1
  ) OR (SELECT count(*) FROM public.time_clock WHERE device_tag LIKE 'M13_%')<>
       (SELECT count(*) FROM public.work_periods wp JOIN public.time_clock tc ON tc.id=wp.time_clock_id
        WHERE tc.device_tag LIKE 'M13_%') THEN
    RAISE EXCEPTION 'M13_SMOKE_H: one-clock/one-work-period invariant failed';
  END IF;

  /* I: an identical refresh appends no SYSTEM versions. */
  SELECT count(*) INTO v_versions FROM public.work_period_versions v
  JOIN public.work_periods wp ON wp.id=v.work_period_id
  JOIN public.time_clock tc ON tc.id=wp.time_clock_id
  WHERE tc.device_tag LIKE 'M13_%';
  PERFORM set_config('wak_m13.version_count',v_versions::text,true);
END
$coverage_assertions$;

SET LOCAL ROLE service_role;
SELECT public.wak_refresh_attendance_shadow(
  'MOOROOLBARK',current_setting('wak_m13.week')::date,current_setting('wak_m13.manager')::uuid
);
RESET ROLE;

DO $idempotency_and_manual_fixtures$
DECLARE
  v_row record;
  v_new_version bigint;
  v_source text;
  v_actor uuid;
  v_disposition text;
  v_next_version integer;
BEGIN
  IF (SELECT count(*) FROM public.work_period_versions v
      JOIN public.work_periods wp ON wp.id=v.work_period_id
      JOIN public.time_clock tc ON tc.id=wp.time_clock_id
      WHERE tc.device_tag LIKE 'M13_%')<>current_setting('wak_m13.version_count')::integer THEN
    RAISE EXCEPTION 'M13_SMOKE_I: identical refresh appended versions';
  END IF;

  FOR v_row IN
    SELECT wp.id AS work_period_id,tc.device_tag,v.matched_shift_id,
      v.actual_start_at,v.actual_end_at,v.payable_start_at,v.payable_end_at
    FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    WHERE tc.device_tag LIKE 'M13_KEEP_%' ORDER BY tc.device_tag
  LOOP
    v_source:=CASE v_row.device_tag
      WHEN 'M13_KEEP_MANAGER' THEN 'MANAGER'
      WHEN 'M13_KEEP_OWNER' THEN 'OWNER'
      WHEN 'M13_KEEP_LEGACY' THEN 'LEGACY_IMPORT'
      ELSE 'MANAGER' END;
    v_actor:=CASE WHEN v_source='OWNER' THEN current_setting('wak_m13.owner')::uuid
      WHEN v_source='LEGACY_IMPORT' THEN NULL ELSE current_setting('wak_m13.manager')::uuid END;
    v_disposition:=CASE WHEN v_row.device_tag='M13_KEEP_VOID' THEN 'VOIDED' ELSE 'ACTIVE' END;
    SELECT max(version_number)+1 INTO v_next_version
    FROM public.work_period_versions WHERE work_period_id=v_row.work_period_id;
    INSERT INTO public.work_period_versions(
      work_period_id,version_number,disposition,matched_shift_id,actual_start_at,actual_end_at,
      payable_start_at,payable_end_at,reason_code,reason_note,change_source,created_by
    ) VALUES(v_row.work_period_id,v_next_version,v_disposition,v_row.matched_shift_id,
      v_row.actual_start_at,v_row.actual_end_at,v_row.payable_start_at,v_row.payable_end_at,
      'M13_PRESERVE',NULL,v_source,v_actor
    ) RETURNING id INTO v_new_version;
    UPDATE public.work_periods SET current_version_id=v_new_version,
      status=CASE WHEN v_disposition='VOIDED' THEN 'VOIDED' ELSE status END
    WHERE id=v_row.work_period_id;
    PERFORM set_config('wak_m13.keep_'||lower(replace(v_row.device_tag,'M13_KEEP_','')),
      v_new_version::text,true);
  END LOOP;
END
$idempotency_and_manual_fixtures$;

SET LOCAL ROLE service_role;
SELECT public.wak_refresh_attendance_shadow(
  'MOOROOLBARK',current_setting('wak_m13.week')::date,current_setting('wak_m13.manager')::uuid
);
RESET ROLE;

DO $preservation_assertions$
BEGIN
  IF EXISTS(
    SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
    WHERE (tc.device_tag='M13_KEEP_MANAGER' AND wp.current_version_id<>current_setting('wak_m13.keep_manager')::bigint)
       OR (tc.device_tag='M13_KEEP_OWNER' AND wp.current_version_id<>current_setting('wak_m13.keep_owner')::bigint)
       OR (tc.device_tag='M13_KEEP_LEGACY' AND wp.current_version_id<>current_setting('wak_m13.keep_legacy')::bigint)
       OR (tc.device_tag='M13_KEEP_VOID' AND
         (wp.current_version_id<>current_setting('wak_m13.keep_void')::bigint OR wp.status<>'VOIDED'))
  ) THEN
    RAISE EXCEPTION 'M13_SMOKE_J: protected current interpretation was overwritten';
  END IF;
END
$preservation_assertions$;

ROLLBACK;

/* K: exact rollback proof for all tagged fixtures. */
SELECT CASE WHEN
  NOT EXISTS(SELECT 1 FROM public.time_clock WHERE device_tag LIKE 'M13_%')
  AND NOT EXISTS(SELECT 1 FROM public.shifts WHERE cover_note LIKE 'M13_%')
THEN 'M13_SMOKE_OK' ELSE 'M13_SMOKE_PERSISTED_ROWS' END AS result;
