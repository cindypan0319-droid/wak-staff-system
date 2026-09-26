/* Run after Migration 011 as postgres. Every fixture is rolled back. */
BEGIN;

DO $fixtures$
DECLARE
  v_manager uuid;
  v_staff uuid;
  v_other_staff uuid;
  v_week date;
  v_start timestamptz;
  v_shift bigint;
  v_other_shift bigint;
BEGIN
  IF session_user<>'postgres' THEN RAISE EXCEPTION 'M11_SMOKE_PRE: run as postgres'; END IF;
  SELECT id INTO v_manager FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text) IN ('MANAGER','OWNER') ORDER BY id LIMIT 1;
  SELECT id INTO v_staff FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='STAFF' ORDER BY id LIMIT 1;
  SELECT p.id INTO v_other_staff FROM public.profiles p
  WHERE p.is_active IS TRUE AND p.id<>v_staff
    AND NOT EXISTS (
      SELECT 1
      FROM public.time_clock tc
      WHERE tc.staff_id=p.id AND tc.clock_out_at IS NULL
    )
  ORDER BY p.id LIMIT 1;
  IF v_manager IS NULL OR v_staff IS NULL OR v_other_staff IS NULL THEN
    RAISE EXCEPTION 'M11_SMOKE_PRE: active Manager/Owner, STAFF, and second actor without an open clock required';
  END IF;

  SELECT d INTO v_week
  FROM (
    SELECT current_date-g AS d FROM generate_series(3000,5000) g
  ) candidates
  WHERE extract(dow FROM d)=4
    AND NOT EXISTS (SELECT 1 FROM public.payroll_periods p
      WHERE p.store_id='MOOROOLBARK' AND p.week_start=d)
    AND NOT EXISTS (SELECT 1 FROM public.time_clock tc
      WHERE tc.clock_in_at >= d::timestamp AT TIME ZONE 'Australia/Melbourne'
        AND tc.clock_in_at < (d+7)::timestamp AT TIME ZONE 'Australia/Melbourne')
    AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.store_id='MOOROOLBARK'
      AND s.shift_start >= d::timestamp AT TIME ZONE 'Australia/Melbourne'
      AND s.shift_start < (d+7)::timestamp AT TIME ZONE 'Australia/Melbourne')
  ORDER BY d LIMIT 1;
  IF v_week IS NULL THEN RAISE EXCEPTION 'M11_SMOKE_PRE: no safe historical week'; END IF;
  v_start := v_week::timestamp AT TIME ZONE 'Australia/Melbourne';

  PERFORM set_config('wak_m11.manager',v_manager::text,true);
  PERFORM set_config('wak_m11.staff',v_staff::text,true);
  PERFORM set_config('wak_m11.week',v_week::text,true);

  /* Exact/near-boundary roster fixtures. Breaks are intentionally non-zero. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '9 hours',v_start+interval '17 hours',30,1,'SCHEDULED',v_manager,'M11_EARLY_3')
  RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_shift,v_start+interval '8 hours 57 minutes',v_start+interval '17 hours','M11_EARLY_3');

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '18 hours',v_start+interval '20 hours',0,1,'SCHEDULED',v_manager,'M11_EARLY_10')
  RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_shift,v_start+interval '17 hours 50 minutes',v_start+interval '20 hours','M11_EARLY_10');

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '1 day 9 hours',v_start+interval '1 day 17 hours',0,1,'WORKED',v_manager,'M11_LATE_START')
  RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_shift,v_start+interval '1 day 9 hours 10 minutes',v_start+interval '1 day 17 hours','M11_LATE_START');

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '1 day 18 hours',v_start+interval '1 day 23 hours',0,1,'SCHEDULED',v_manager,'M11_EARLY_FINISH')
  RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_shift,v_start+interval '1 day 18 hours',v_start+interval '1 day 22 hours 50 minutes','M11_EARLY_FINISH');

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '2 days 9 hours',v_start+interval '2 days 17 hours',0,1,'SCHEDULED',v_manager,'M11_LATE_3')
  RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_shift,v_start+interval '2 days 9 hours',v_start+interval '2 days 17 hours 3 minutes','M11_LATE_3');

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '2 days 18 hours',v_start+interval '2 days 22 hours',0,1,'SCHEDULED',v_manager,'M11_LATE_10')
  RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_shift,v_start+interval '2 days 18 hours',v_start+interval '2 days 22 hours 10 minutes','M11_LATE_10');

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_other_staff,v_start+interval '6 days 22 hours',v_start+interval '6 days 23 hours',0,1,'SCHEDULED',v_manager,'M11_INCOMPLETE')
  RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_other_staff,v_shift,v_start+interval '6 days 22 hours',NULL,'M11_INCOMPLETE');

  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,NULL,v_start+interval '3 days 20 hours',v_start+interval '3 days 21 hours','M11_UNROSTERED');

  /* Two separate, non-overlapping clocks may independently match one explicit shift. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '3 days 9 hours',v_start+interval '3 days 17 hours',0,1,'SCHEDULED',v_manager,'M11_SHARED_SHIFT')
  RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag) VALUES
    (v_staff,v_shift,v_start+interval '3 days 9 hours',v_start+interval '3 days 12 hours','M11_SHARED_SHIFT_A'),
    (v_staff,v_shift,v_start+interval '3 days 13 hours',v_start+interval '3 days 17 hours','M11_SHARED_SHIFT_B');

  /* Two equally discoverable candidates: no arbitrary nearest winner. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES
    ('MOOROOLBARK',v_staff,v_start+interval '4 days 9 hours',v_start+interval '4 days 11 hours',0,1,'SCHEDULED',v_manager,'M11_AMBIG_A'),
    ('MOOROOLBARK',v_staff,v_start+interval '4 days 9 hours 30 minutes',v_start+interval '4 days 11 hours 30 minutes',0,1,'SCHEDULED',v_manager,'M11_AMBIG_B');
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,NULL,v_start+interval '4 days 9 hours 15 minutes',v_start+interval '4 days 10 hours','M11_AMBIG');

  /* Duplicate pair and overlapping pair. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '5 days 7 hours',v_start+interval '5 days 8 hours',0,1,'SCHEDULED',v_manager,'M11_DUP_A') RETURNING id INTO v_shift;
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '5 days 7 hours',v_start+interval '5 days 8 hours',0,1,'SCHEDULED',v_manager,'M11_DUP_B') RETURNING id INTO v_other_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag) VALUES
    (v_staff,v_shift,v_start+interval '5 days 7 hours',v_start+interval '5 days 8 hours','M11_DUP_A'),
    (v_staff,v_other_shift,v_start+interval '5 days 7 hours',v_start+interval '5 days 8 hours','M11_DUP_B');

  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag) VALUES
    (v_staff,NULL,v_start+interval '5 days 12 hours',v_start+interval '5 days 14 hours','M11_OVERLAP_A'),
    (v_staff,NULL,v_start+interval '5 days 13 hours',v_start+interval '5 days 15 hours','M11_OVERLAP_B');

  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,NULL,v_start+interval '5 days 23 hours 30 minutes',v_start+interval '6 days 30 minutes','M11_CROSS_MIDNIGHT');

  /* Explicit staff mismatch must not fuzzy-match around the conflict. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_other_staff,v_start+interval '6 days 9 hours',v_start+interval '6 days 10 hours',0,1,'SCHEDULED',v_manager,'M11_MISMATCH')
  RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_staff,v_shift,v_start+interval '6 days 9 hours',v_start+interval '6 days 10 hours','M11_MISMATCH');

  /* Covered parent is context only; the SCHEDULED child is independently matchable. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,
    created_by,covered_by_staff_id,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '6 days 12 hours',v_start+interval '6 days 14 hours',0,1,
    'COVERED',v_manager,v_other_staff,'M11_COVER_PARENT') RETURNING id INTO v_shift;
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,
    created_by,parent_shift_id,cover_note)
  VALUES ('MOOROOLBARK',v_other_staff,v_start+interval '6 days 12 hours',v_start+interval '6 days 14 hours',0,1,
    'SCHEDULED',v_manager,v_shift,'M11_COVER_CHILD') RETURNING id INTO v_other_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag)
  VALUES(v_other_staff,v_other_shift,v_start+interval '6 days 12 hours',v_start+interval '6 days 14 hours','M11_COVER_CHILD');

  /* Roster-only context must never generate attendance. */
  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,hourly_rate,shift_status,created_by,cover_note)
  VALUES ('MOOROOLBARK',v_staff,v_start+interval '6 days 18 hours',v_start+interval '6 days 19 hours',0,1,'SCHEDULED',v_manager,'M11_ROSTER_ONLY');
END
$fixtures$;

/* 1-5. Input and actor authorization checks. */
SET LOCAL ROLE service_role;
DO $rejections$
DECLARE
  v_manager uuid:=current_setting('wak_m11.manager')::uuid;
  v_staff uuid:=current_setting('wak_m11.staff')::uuid;
  v_week date:=current_setting('wak_m11.week')::date;
  v_current_thursday date:=(clock_timestamp() AT TIME ZONE 'Australia/Melbourne')::date
    - ((extract(dow FROM (clock_timestamp() AT TIME ZONE 'Australia/Melbourne')::date)::integer-4+7)%7);
BEGIN
  BEGIN PERFORM public.wak_refresh_attendance_shadow('OTHER',v_week,v_manager);
    RAISE EXCEPTION 'M11_SMOKE_1'; EXCEPTION WHEN OTHERS THEN IF SQLERRM='M11_SMOKE_1' THEN RAISE; END IF; END;
  BEGIN PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',v_week+1,v_manager);
    RAISE EXCEPTION 'M11_SMOKE_2'; EXCEPTION WHEN OTHERS THEN IF SQLERRM='M11_SMOKE_2' THEN RAISE; END IF; END;
  BEGIN PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',v_current_thursday,v_manager);
    RAISE EXCEPTION 'M11_SMOKE_3'; EXCEPTION WHEN OTHERS THEN IF SQLERRM='M11_SMOKE_3' THEN RAISE; END IF; END;
  BEGIN PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',v_week,'00000000-0000-0000-0000-000000000000');
    RAISE EXCEPTION 'M11_SMOKE_4'; EXCEPTION WHEN OTHERS THEN IF SQLERRM='M11_SMOKE_4' THEN RAISE; END IF; END;
  BEGIN PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',v_week,v_staff);
    RAISE EXCEPTION 'M11_SMOKE_5'; EXCEPTION WHEN OTHERS THEN IF SQLERRM='M11_SMOKE_5' THEN RAISE; END IF; END;
END
$rejections$;

/* 6-25. First generation and deterministic interpretation assertions. */
DO $first_refresh$
DECLARE
  v_manager uuid:=current_setting('wak_m11.manager')::uuid;
  v_week date:=current_setting('wak_m11.week')::date;
  v_result jsonb;
  v_clock_count integer;
  v_version_count integer;
BEGIN
  v_result:=public.wak_refresh_attendance_shadow('MOOROOLBARK',v_week,v_manager);
  IF v_result->>'detector'<>'ATTENDANCE_SHADOW_V1' THEN RAISE EXCEPTION 'M11_SMOKE_6'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payroll_periods p
      WHERE p.store_id='MOOROOLBARK' AND p.week_start=v_week AND p.week_end=v_week+6
        AND p.timezone='Australia/Melbourne' AND p.shadow_status='READY_FOR_COMPARISON') THEN
    RAISE EXCEPTION 'M11_SMOKE_7: payroll period was not completed';
  END IF;
  SELECT count(*) INTO v_clock_count FROM public.time_clock WHERE device_tag LIKE 'M11_%';
  IF (SELECT count(*) FROM public.work_periods wp JOIN public.time_clock tc ON tc.id=wp.time_clock_id
      WHERE tc.device_tag LIKE 'M11_%')<>v_clock_count THEN RAISE EXCEPTION 'M11_SMOKE_7/10'; END IF;

  SELECT count(*) INTO v_version_count FROM public.work_period_versions v
  JOIN public.work_periods wp ON wp.id=v.work_period_id JOIN public.time_clock tc ON tc.id=wp.time_clock_id
  WHERE tc.device_tag LIKE 'M11_%';
  PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',v_week,v_manager);
  IF (SELECT count(*) FROM public.work_period_versions v JOIN public.work_periods wp ON wp.id=v.work_period_id
      JOIN public.time_clock tc ON tc.id=wp.time_clock_id WHERE tc.device_tag LIKE 'M11_%')<>v_version_count THEN
    RAISE EXCEPTION 'M11_SMOKE_8: identical refresh appended versions';
  END IF;

  /* Explicit match, paid break, and 1-5 minute early/late clamps. */
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id
      JOIN public.shifts s ON s.id=v.matched_shift_id
      WHERE tc.device_tag='M11_EARLY_3' AND wp.status='READY'
        AND v.payable_start_at=s.shift_start
        AND extract(epoch FROM (v.payable_end_at-v.payable_start_at))=28800) THEN
    RAISE EXCEPTION 'M11_SMOKE_9/11/24';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id JOIN public.shifts s ON s.id=v.matched_shift_id
      WHERE tc.device_tag='M11_LATE_3' AND wp.status='READY' AND v.payable_end_at=s.shift_end) THEN
    RAISE EXCEPTION 'M11_SMOKE_15';
  END IF;

  /* Blocking/warning outcomes. */
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id
      JOIN public.work_period_anomalies a ON a.work_period_id=wp.id AND a.status='OPEN'
      WHERE tc.device_tag='M11_EARLY_10' AND a.anomaly_type='EARLY_START' AND a.severity='BLOCKING'
        AND v.payable_start_at IS NULL AND wp.status='NEEDS_REVIEW') THEN RAISE EXCEPTION 'M11_SMOKE_12'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id JOIN public.work_period_anomalies a ON a.work_period_id=wp.id
      WHERE tc.device_tag='M11_LATE_START' AND a.anomaly_type='LATE_START' AND a.severity='WARNING'
        AND v.payable_start_at=tc.clock_in_at AND wp.status='READY') THEN RAISE EXCEPTION 'M11_SMOKE_13'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id JOIN public.work_period_anomalies a ON a.work_period_id=wp.id
      WHERE tc.device_tag='M11_EARLY_FINISH' AND a.anomaly_type='EARLY_FINISH' AND a.severity='WARNING'
        AND v.payable_end_at=tc.clock_out_at AND wp.status='READY') THEN RAISE EXCEPTION 'M11_SMOKE_14'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id JOIN public.work_period_anomalies a ON a.work_period_id=wp.id
      WHERE tc.device_tag='M11_LATE_10' AND a.anomaly_type='LATE_FINISH' AND a.severity='BLOCKING'
        AND v.payable_end_at IS NULL AND wp.status='NEEDS_REVIEW') THEN RAISE EXCEPTION 'M11_SMOKE_16'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_anomalies a ON a.work_period_id=wp.id WHERE tc.device_tag='M11_INCOMPLETE'
      AND a.anomaly_type='MISSING_CLOCK_OUT' AND a.severity='BLOCKING' AND wp.status='NEEDS_REVIEW') THEN RAISE EXCEPTION 'M11_SMOKE_17'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_anomalies a ON a.work_period_id=wp.id WHERE tc.device_tag='M11_UNROSTERED'
      AND a.anomaly_type='UNROSTERED_WORK' AND wp.matched_shift_id IS NULL) THEN RAISE EXCEPTION 'M11_SMOKE_18'; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.shifts s
    JOIN public.work_periods wp ON wp.matched_shift_id=s.id
    JOIN public.time_clock tc ON tc.id=wp.time_clock_id
    WHERE s.cover_note='M11_SHARED_SHIFT'
      AND tc.device_tag IN ('M11_SHARED_SHIFT_A','M11_SHARED_SHIFT_B')
      AND NOT EXISTS (
        SELECT 1
        FROM public.work_period_anomalies a
        WHERE a.work_period_id=wp.id AND a.anomaly_type='UNROSTERED_WORK'
      )
    GROUP BY s.id
    HAVING count(*)=2 AND count(DISTINCT tc.id)=2 AND count(DISTINCT wp.id)=2
  ) THEN
    RAISE EXCEPTION 'M11_SMOKE_SHARED_SHIFT: separate clocks did not retain the same roster match';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_anomalies a ON a.work_period_id=wp.id WHERE tc.device_tag='M11_AMBIG'
      AND a.anomaly_type='AMBIGUOUS_MATCH' AND wp.matched_shift_id IS NULL) THEN RAISE EXCEPTION 'M11_SMOKE_19'; END IF;
  IF (SELECT count(*) FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_anomalies a ON a.work_period_id=wp.id WHERE tc.device_tag LIKE 'M11_DUP_%'
      AND a.anomaly_type='DUPLICATE_CLOCK' AND a.status='OPEN')<>2 THEN RAISE EXCEPTION 'M11_SMOKE_20'; END IF;
  IF (SELECT count(*) FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_anomalies a ON a.work_period_id=wp.id WHERE tc.device_tag LIKE 'M11_OVERLAP_%'
      AND a.anomaly_type='OVERLAPPING_CLOCK' AND a.status='OPEN')<>2 THEN RAISE EXCEPTION 'M11_SMOKE_21'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_anomalies a ON a.work_period_id=wp.id WHERE tc.device_tag='M11_CROSS_MIDNIGHT'
      AND a.anomaly_type='CROSSES_MIDNIGHT' AND a.severity='BLOCKING') THEN RAISE EXCEPTION 'M11_SMOKE_22'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_anomalies a ON a.work_period_id=wp.id WHERE tc.device_tag='M11_MISMATCH'
      AND a.anomaly_type='SHIFT_STAFF_MISMATCH' AND wp.matched_shift_id IS NULL) THEN RAISE EXCEPTION 'M11_SMOKE_23'; END IF;
  IF EXISTS (SELECT 1 FROM public.work_periods wp JOIN public.shifts s ON s.id=wp.matched_shift_id
      WHERE s.cover_note='M11_ROSTER_ONLY') THEN RAISE EXCEPTION 'M11_SMOKE_25'; END IF;
  IF EXISTS (SELECT 1 FROM public.work_periods wp JOIN public.payroll_periods p ON p.id=wp.payroll_period_id
      WHERE p.store_id='MOOROOLBARK' AND p.week_start=v_week AND wp.source_type<>'CLOCK') THEN
    RAISE EXCEPTION 'M11_SMOKE_25: generator created non-CLOCK work';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.shifts child ON child.id=wp.matched_shift_id
      WHERE tc.device_tag='M11_COVER_CHILD' AND child.cover_note='M11_COVER_CHILD'
        AND child.parent_shift_id IS NOT NULL AND wp.status='READY') THEN
    RAISE EXCEPTION 'M11_SMOKE_COVERAGE';
  END IF;
END
$first_refresh$;
RESET ROLE;

/* 26-29. Refresh appends SYSTEM history, preserves reviewed/void rows, and resolves stale anomalies. */
DO $refresh_behaviour$
DECLARE
  v_manager uuid:=current_setting('wak_m11.manager')::uuid;
  v_week date:=current_setting('wak_m11.week')::date;
  v_wp bigint;
  v_old_version bigint;
  v_review_version bigint;
  v_count integer;
BEGIN
  SELECT wp.id,wp.current_version_id INTO v_wp,v_old_version FROM public.work_periods wp
  JOIN public.time_clock tc ON tc.id=wp.time_clock_id WHERE tc.device_tag='M11_EARLY_10';
  UPDATE public.time_clock SET clock_in_at=clock_in_at+interval '7 minutes' WHERE device_tag='M11_EARLY_10';
  SET LOCAL ROLE service_role;
  PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',v_week,v_manager);
  RESET ROLE;
  IF (SELECT current_version_id FROM public.work_periods WHERE id=v_wp)=v_old_version
     OR NOT EXISTS (SELECT 1 FROM public.work_period_anomalies WHERE work_period_id=v_wp
       AND anomaly_type='EARLY_START' AND status='RESOLVED'
       AND resolution_reason_code='SYSTEM_REFRESH_CLEARED' AND resolution_version_id IS NOT NULL) THEN
    RAISE EXCEPTION 'M11_SMOKE_26/29';
  END IF;

  SELECT wp.id INTO v_wp FROM public.work_periods wp JOIN public.time_clock tc ON tc.id=wp.time_clock_id
  WHERE tc.device_tag='M11_LATE_START';
  SELECT coalesce(max(version_number),0)+1 INTO v_count FROM public.work_period_versions WHERE work_period_id=v_wp;
  INSERT INTO public.work_period_versions(work_period_id,version_number,disposition,actual_start_at,actual_end_at,
    payable_start_at,payable_end_at,reason_code,change_source,created_by)
  SELECT v_wp,v_count,'ACTIVE',clock_in_at,clock_out_at,clock_in_at,clock_out_at,'MANAGER_REVIEW','MANAGER',v_manager
  FROM public.time_clock WHERE device_tag='M11_LATE_START' RETURNING id INTO v_review_version;
  UPDATE public.work_periods SET current_version_id=v_review_version,status='READY' WHERE id=v_wp;
  UPDATE public.time_clock SET clock_out_at=clock_out_at+interval '1 minute' WHERE device_tag='M11_LATE_START';

  SELECT wp.id INTO v_wp FROM public.work_periods wp JOIN public.time_clock tc ON tc.id=wp.time_clock_id
  WHERE tc.device_tag='M11_EARLY_FINISH';
  UPDATE public.work_periods SET status='VOIDED' WHERE id=v_wp;
  SET LOCAL ROLE service_role;
  PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',v_week,v_manager);
  RESET ROLE;
  IF (SELECT current_version_id FROM public.work_periods wp JOIN public.time_clock tc ON tc.id=wp.time_clock_id
      WHERE tc.device_tag='M11_LATE_START')<>v_review_version THEN RAISE EXCEPTION 'M11_SMOKE_27'; END IF;
  IF (SELECT status FROM public.work_periods WHERE id=v_wp)<>'VOIDED' THEN RAISE EXCEPTION 'M11_SMOKE_28'; END IF;
END
$refresh_behaviour$;

/* Invalid ranges may be impossible under Production constraints; test when insertable. */
DO $invalid_range_contract$
BEGIN
  BEGIN
    INSERT INTO public.time_clock(staff_id,clock_in_at,clock_out_at,device_tag)
    VALUES(current_setting('wak_m11.staff')::uuid,
      (current_setting('wak_m11.week')::date::timestamp AT TIME ZONE 'Australia/Melbourne')+interval '6 days 21 hours',
      (current_setting('wak_m11.week')::date::timestamp AT TIME ZONE 'Australia/Melbourne')+interval '6 days 20 hours',
      'M11_INVALID_RANGE');
    PERFORM set_config('wak_m11.invalid_inserted','true',true);
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'M11_SMOKE_22: Production time_clock constraint rejects invalid range fixtures';
  END;
END
$invalid_range_contract$;

SET LOCAL ROLE service_role;
DO $invalid_range_detection$
BEGIN
  IF current_setting('wak_m11.invalid_inserted',true)='true' THEN
    PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',current_setting('wak_m11.week')::date,
      current_setting('wak_m11.manager')::uuid);
    IF NOT EXISTS (SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
        JOIN public.work_period_anomalies a ON a.work_period_id=wp.id
        WHERE tc.device_tag='M11_INVALID_RANGE' AND a.anomaly_type='INVALID_CLOCK_RANGE'
          AND a.severity='BLOCKING') THEN
      RAISE EXCEPTION 'M11_SMOKE_22: insertable invalid range was not detected';
    END IF;
  END IF;
END
$invalid_range_detection$;
RESET ROLE;

/* 30-32. Only service_role can execute. */
SET LOCAL ROLE authenticated;
DO $authenticated_acl$
BEGIN
  BEGIN
    PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',current_setting('wak_m11.week')::date,
      current_setting('wak_m11.manager')::uuid);
    RAISE EXCEPTION 'M11_SMOKE_30';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$authenticated_acl$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $anon_acl$
BEGIN
  BEGIN
    PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',current_setting('wak_m11.week')::date,
      current_setting('wak_m11.manager')::uuid);
    RAISE EXCEPTION 'M11_SMOKE_31';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$anon_acl$;
RESET ROLE;
SET LOCAL ROLE service_role;
DO $service_acl$
BEGIN
  PERFORM public.wak_refresh_attendance_shadow('MOOROOLBARK',current_setting('wak_m11.week')::date,
    current_setting('wak_m11.manager')::uuid);
END
$service_acl$;
RESET ROLE;

ROLLBACK;

/* 33. Read-only persisted-fixture proof. */
SELECT CASE WHEN
  NOT EXISTS (SELECT 1 FROM public.time_clock WHERE left(device_tag,4)='M11_')
  AND NOT EXISTS (SELECT 1 FROM public.shifts WHERE left(cover_note,4)='M11_')
THEN 'M11_SMOKE_OK' ELSE 'M11_SMOKE_PERSISTED_ROWS' END AS result;
