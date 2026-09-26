/* Run after Migration 012 as postgres. All fixtures are rolled back. */
BEGIN;

DO $fixtures$
DECLARE
  v_manager uuid;
  v_owner uuid;
  v_staff uuid;
  v_week date;
  v_start timestamptz;
  v_shift bigint;
  v_clock bigint;
BEGIN
  IF session_user<>'postgres' THEN
    RAISE EXCEPTION 'M12_SMOKE_PRE: run as postgres';
  END IF;
  SELECT p.id INTO v_manager FROM public.profiles p
  WHERE p.is_active IS TRUE AND upper(p.role::text)='MANAGER'
  ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_owner FROM public.profiles p
  WHERE p.is_active IS TRUE AND upper(p.role::text)='OWNER'
  ORDER BY p.id LIMIT 1;
  SELECT p.id INTO v_staff FROM public.profiles p
  WHERE p.is_active IS TRUE AND upper(p.role::text)='STAFF'
  ORDER BY p.id LIMIT 1;
  IF v_manager IS NULL OR v_owner IS NULL OR v_staff IS NULL THEN
    RAISE EXCEPTION 'M12_SMOKE_PRE: active MANAGER, OWNER, and STAFF are required';
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
    AND NOT EXISTS (SELECT 1 FROM public.shifts s
      WHERE s.store_id='MOOROOLBARK'
        AND s.shift_start >= d::timestamp AT TIME ZONE 'Australia/Melbourne'
        AND s.shift_start < (d+7)::timestamp AT TIME ZONE 'Australia/Melbourne')
  ORDER BY d LIMIT 1;
  IF v_week IS NULL THEN
    RAISE EXCEPTION 'M12_SMOKE_PRE: no safe historical week';
  END IF;
  v_start:=v_week::timestamp AT TIME ZONE 'Australia/Melbourne';
  PERFORM pg_advisory_xact_lock(hashtextextended('MOOROOLBARK|'||v_week::text,0));

  IF EXISTS (SELECT 1 FROM public.payroll_periods p
      WHERE p.store_id='MOOROOLBARK' AND p.week_start=v_week)
     OR EXISTS (SELECT 1 FROM public.time_clock tc
      WHERE tc.clock_in_at>=v_start AND tc.clock_in_at<v_start+interval '7 days')
     OR EXISTS (SELECT 1 FROM public.shifts s
      WHERE s.store_id='MOOROOLBARK' AND s.shift_start>=v_start
        AND s.shift_start<v_start+interval '7 days') THEN
    RAISE EXCEPTION 'M12_SMOKE_PRE: selected week changed after lock';
  END IF;

  PERFORM set_config('wak_m12.manager',v_manager::text,true);
  PERFORM set_config('wak_m12.owner',v_owner::text,true);
  PERFORM set_config('wak_m12.staff',v_staff::text,true);
  PERFORM set_config('wak_m12.week',v_week::text,true);

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,
    hourly_rate,shift_status,created_by,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '9 hours',v_start+interval '17 hours',
    0,1,'SCHEDULED',v_manager,'M12_VALID') RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag,
    adjusted_clock_in_at,adjusted_clock_out_at,adjusted_reason,adjusted_by,adjusted_at)
  VALUES(v_staff,v_shift,v_start+interval '9 hours',v_start+interval '17 hours','M12_VALID',
    v_start+interval '9 hours 15 minutes',v_start+interval '17 hours 10 minutes',
    'Historical correction',v_manager,v_start+interval '1 day') RETURNING id INTO v_clock;
  PERFORM set_config('wak_m12.valid_clock',v_clock::text,true);

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,
    hourly_rate,shift_status,created_by,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '1 day 9 hours',v_start+interval '1 day 12 hours',
    0,1,'SCHEDULED',v_manager,'M12_EQUAL_RAW') RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag,
    adjusted_clock_in_at,adjusted_clock_out_at,adjusted_reason,adjusted_by,adjusted_at)
  VALUES(v_staff,v_shift,v_start+interval '1 day 9 hours',v_start+interval '1 day 12 hours','M12_EQUAL_RAW',
    v_start+interval '1 day 9 hours',v_start+interval '1 day 12 hours',NULL,
    v_manager,v_start+interval '2 days') RETURNING id INTO v_clock;
  PERFORM set_config('wak_m12.equal_clock',v_clock::text,true);

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,
    hourly_rate,shift_status,created_by,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '2 days 9 hours',v_start+interval '2 days 11 hours',
    0,1,'SCHEDULED',v_manager,'M12_INVALID') RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag,
    adjusted_clock_in_at,adjusted_clock_out_at,adjusted_reason,adjusted_by,adjusted_at)
  VALUES(v_staff,v_shift,v_start+interval '2 days 9 hours',v_start+interval '2 days 11 hours','M12_INVALID',
    v_start+interval '2 days 10 hours',v_start+interval '2 days 10 hours',
    'False clock awaiting disposition',v_manager,v_start+interval '3 days') RETURNING id INTO v_clock;
  PERFORM set_config('wak_m12.invalid_clock',v_clock::text,true);

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,
    hourly_rate,shift_status,created_by,cover_note)
  VALUES('MOOROOLBARK',v_staff,v_start+interval '3 days 9 hours',v_start+interval '3 days 11 hours',
    0,1,'SCHEDULED',v_manager,'M12_METADATA') RETURNING id INTO v_shift;
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag,
    adjusted_clock_in_at,adjusted_clock_out_at,adjusted_reason,adjusted_by,adjusted_at)
  VALUES(v_staff,v_shift,v_start+interval '3 days 9 hours',v_start+interval '3 days 11 hours','M12_METADATA',
    NULL,NULL,'Legacy metadata without submitted times',v_manager,v_start+interval '4 days')
  RETURNING id INTO v_clock;
  PERFORM set_config('wak_m12.metadata_clock',v_clock::text,true);

  INSERT INTO public.shifts(store_id,staff_id,shift_start,shift_end,break_minutes,
    hourly_rate,shift_status,created_by,cover_note)
  VALUES
    ('MOOROOLBARK',v_staff,v_start+interval '4 days 9 hours',v_start+interval '4 days 11 hours',0,1,'SCHEDULED',v_manager,'M12_MANAGER'),
    ('MOOROOLBARK',v_staff,v_start+interval '5 days 9 hours',v_start+interval '5 days 11 hours',0,1,'SCHEDULED',v_manager,'M12_OWNER'),
    ('MOOROOLBARK',v_staff,v_start+interval '6 days 9 hours',v_start+interval '6 days 11 hours',0,1,'SCHEDULED',v_manager,'M12_VOID');

  SELECT s.id INTO v_shift FROM public.shifts s WHERE s.cover_note='M12_MANAGER';
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag,
    adjusted_clock_in_at,adjusted_clock_out_at,adjusted_reason,adjusted_by,adjusted_at)
  VALUES(v_staff,v_shift,v_start+interval '4 days 9 hours',v_start+interval '4 days 11 hours','M12_MANAGER',
    v_start+interval '4 days 9 hours 5 minutes',v_start+interval '4 days 11 hours',
    'Must not replace manager review',v_manager,v_start+interval '5 days') RETURNING id INTO v_clock;
  PERFORM set_config('wak_m12.manager_clock',v_clock::text,true);

  SELECT s.id INTO v_shift FROM public.shifts s WHERE s.cover_note='M12_OWNER';
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag,
    adjusted_clock_in_at,adjusted_clock_out_at,adjusted_reason,adjusted_by,adjusted_at)
  VALUES(v_staff,v_shift,v_start+interval '5 days 9 hours',v_start+interval '5 days 11 hours','M12_OWNER',
    v_start+interval '5 days 9 hours 5 minutes',v_start+interval '5 days 11 hours',
    'Must not replace owner review',v_owner,v_start+interval '6 days') RETURNING id INTO v_clock;
  PERFORM set_config('wak_m12.owner_clock',v_clock::text,true);

  SELECT s.id INTO v_shift FROM public.shifts s WHERE s.cover_note='M12_VOID';
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag,
    adjusted_clock_in_at,adjusted_clock_out_at,adjusted_reason,adjusted_by,adjusted_at)
  VALUES(v_staff,v_shift,v_start+interval '6 days 9 hours',v_start+interval '6 days 11 hours','M12_VOID',
    v_start+interval '6 days 9 hours 5 minutes',v_start+interval '6 days 11 hours',
    'Must not replace void disposition',v_manager,v_start+interval '7 days') RETURNING id INTO v_clock;
  PERFORM set_config('wak_m12.void_clock',v_clock::text,true);

  /* This valid adjusted clock deliberately has no explicit/fuzzy shift, creating an OPEN detector anomaly. */
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag,
    adjusted_clock_in_at,adjusted_clock_out_at,adjusted_reason,adjusted_by,adjusted_at)
  VALUES(v_staff,NULL,v_start+interval '23 hours',v_start+interval '23 hours 30 minutes','M12_ANOMALY',
    v_start+interval '23 hours 5 minutes',v_start+interval '23 hours 35 minutes',
    'Reviewed unrostered work',v_manager,v_start+interval '1 day') RETURNING id INTO v_clock;
  PERFORM set_config('wak_m12.anomaly_clock',v_clock::text,true);
END
$fixtures$;

SET LOCAL ROLE service_role;
DO $generate$
BEGIN
  PERFORM public.wak_refresh_attendance_shadow(
    'MOOROOLBARK',current_setting('wak_m12.week')::date,
    current_setting('wak_m12.manager')::uuid
  );
END
$generate$;
RESET ROLE;

DO $reviewed_fixtures$
DECLARE
  v_clock bigint;
  v_wp bigint;
  v_current bigint;
  v_next integer;
  v_new bigint;
  v_manager uuid:=current_setting('wak_m12.manager')::uuid;
  v_owner uuid:=current_setting('wak_m12.owner')::uuid;
  v_staff uuid:=current_setting('wak_m12.staff')::uuid;
  v_start timestamptz:=current_setting('wak_m12.week')::date::timestamp AT TIME ZONE 'Australia/Melbourne';
BEGIN
  FOREACH v_clock IN ARRAY ARRAY[
    current_setting('wak_m12.manager_clock')::bigint,
    current_setting('wak_m12.owner_clock')::bigint,
    current_setting('wak_m12.void_clock')::bigint
  ] LOOP
    SELECT wp.id,wp.current_version_id INTO STRICT v_wp,v_current
    FROM public.work_periods wp WHERE wp.time_clock_id=v_clock FOR UPDATE;
    SELECT coalesce(max(v.version_number),0)+1 INTO v_next
    FROM public.work_period_versions v WHERE v.work_period_id=v_wp;
    INSERT INTO public.work_period_versions(
      work_period_id,version_number,disposition,matched_shift_id,
      actual_start_at,actual_end_at,payable_start_at,payable_end_at,
      reason_code,reason_note,change_source,created_by
    )
    SELECT v_wp,v_next,
      CASE WHEN v_clock=current_setting('wak_m12.void_clock')::bigint THEN 'VOIDED' ELSE 'ACTIVE' END,
      old.matched_shift_id,old.actual_start_at,old.actual_end_at,
      old.payable_start_at,old.payable_end_at,
      CASE
        WHEN v_clock=current_setting('wak_m12.manager_clock')::bigint THEN 'M12_MANAGER_REVIEW'
        WHEN v_clock=current_setting('wak_m12.owner_clock')::bigint THEN 'M12_OWNER_REVIEW'
        ELSE 'M12_VOID_REVIEW'
      END,
      NULL,
      CASE WHEN v_clock=current_setting('wak_m12.owner_clock')::bigint THEN 'OWNER' ELSE 'MANAGER' END,
      CASE WHEN v_clock=current_setting('wak_m12.owner_clock')::bigint THEN v_owner ELSE v_manager END
    FROM public.work_period_versions old WHERE old.id=v_current
    RETURNING id INTO v_new;
    UPDATE public.work_periods SET current_version_id=v_new,
      status=CASE WHEN v_clock=current_setting('wak_m12.void_clock')::bigint THEN 'VOIDED' ELSE 'READY' END
    WHERE id=v_wp;
    IF v_clock=current_setting('wak_m12.manager_clock')::bigint THEN
      PERFORM set_config('wak_m12.manager_version',v_new::text,true);
    ELSIF v_clock=current_setting('wak_m12.owner_clock')::bigint THEN
      PERFORM set_config('wak_m12.owner_version',v_new::text,true);
    ELSE
      PERFORM set_config('wak_m12.void_version',v_new::text,true);
    END IF;
  END LOOP;

  SELECT wp.current_version_id INTO v_current FROM public.work_periods wp
  WHERE wp.time_clock_id=current_setting('wak_m12.invalid_clock')::bigint;
  PERFORM set_config('wak_m12.invalid_version',v_current::text,true);
  SELECT wp.current_version_id INTO v_current FROM public.work_periods wp
  WHERE wp.time_clock_id=current_setting('wak_m12.metadata_clock')::bigint;
  PERFORM set_config('wak_m12.metadata_version',v_current::text,true);

  /* Inserted after shadow generation: the importer must not manufacture its missing work period. */
  INSERT INTO public.time_clock(staff_id,shift_id,clock_in_at,clock_out_at,device_tag,
    adjusted_clock_in_at,adjusted_clock_out_at,adjusted_reason,adjusted_by,adjusted_at)
  VALUES(v_staff,NULL,v_start+interval '2 days 18 hours',v_start+interval '2 days 19 hours','M12_NO_WORK_PERIOD',
    v_start+interval '2 days 18 hours 5 minutes',v_start+interval '2 days 19 hours',
    'No generated canonical row',v_manager,v_start+interval '3 days');
END
$reviewed_fixtures$;

SET LOCAL ROLE service_role;
DO $import_assertions$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_third jsonb;
  v_raw_before jsonb;
  v_raw_after jsonb;
  v_changed_raw jsonb;
  v_versions_before integer;
  v_versions_after integer;
  v_anomaly_id bigint;
  v_old_import_version bigint;
BEGIN
  SELECT jsonb_agg(to_jsonb(tc) ORDER BY tc.id) INTO v_raw_before
  FROM public.time_clock tc WHERE tc.device_tag LIKE 'M12_%';
  SELECT a.id INTO STRICT v_anomaly_id
  FROM public.work_period_anomalies a
  JOIN public.work_periods wp ON wp.id=a.work_period_id
  WHERE wp.time_clock_id=current_setting('wak_m12.anomaly_clock')::bigint
    AND a.status='OPEN' AND a.details->>'detector'='ATTENDANCE_SHADOW_V1';

  v_first:=public.wak_import_legacy_clock_adjustments(
    'MOOROOLBARK',current_setting('wak_m12.week')::date,
    current_setting('wak_m12.manager')::uuid
  );
  IF (v_first->>'imported_versions')::integer<>3
     OR (v_first->>'skipped_no_work_period')::integer<>1
     OR (v_first->>'skipped_metadata_only')::integer<>1
     OR (v_first->>'skipped_invalid_adjustment')::integer<>1
     OR (v_first->>'preserved_manual')::integer<>3
     OR (v_first->>'resolved_anomalies')::integer<1 THEN
    RAISE EXCEPTION 'M12_SMOKE: unexpected first import summary %',v_first;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.work_periods wp
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    JOIN public.time_clock tc ON tc.id=wp.time_clock_id
    WHERE tc.id=current_setting('wak_m12.valid_clock')::bigint
      AND wp.status='READY' AND v.change_source='LEGACY_IMPORT'
      AND v.matched_shift_id=wp.matched_shift_id AND v.matched_shift_id IS NOT NULL
      AND v.reason_code='LEGACY_ADJUSTMENT'
      AND v.actual_start_at=tc.adjusted_clock_in_at
      AND v.actual_end_at=tc.adjusted_clock_out_at
      AND v.payable_start_at=tc.adjusted_clock_in_at
      AND v.payable_end_at=tc.adjusted_clock_out_at
      AND v.created_by=tc.adjusted_by AND v.created_at=tc.adjusted_at
      AND v.reason_note IS NOT DISTINCT FROM tc.adjusted_reason
  ) THEN
    RAISE EXCEPTION 'M12_SMOKE: valid legacy adjustment was not imported exactly';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.work_periods wp
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    JOIN public.time_clock tc ON tc.id=wp.time_clock_id
    WHERE tc.id=current_setting('wak_m12.equal_clock')::bigint
      AND v.change_source='LEGACY_IMPORT'
      AND v.actual_start_at=tc.clock_in_at AND v.actual_end_at=tc.clock_out_at
  ) THEN
    RAISE EXCEPTION 'M12_SMOKE: adjustment identical to raw was not imported';
  END IF;
  IF (SELECT wp.current_version_id FROM public.work_periods wp
      WHERE wp.time_clock_id=current_setting('wak_m12.invalid_clock')::bigint)
       <>current_setting('wak_m12.invalid_version')::bigint
     OR (SELECT wp.status FROM public.work_periods wp
      WHERE wp.time_clock_id=current_setting('wak_m12.invalid_clock')::bigint)='VOIDED' THEN
    RAISE EXCEPTION 'M12_SMOKE: invalid/equal adjustment changed or voided canonical work';
  END IF;
  IF (SELECT wp.current_version_id FROM public.work_periods wp
      WHERE wp.time_clock_id=current_setting('wak_m12.metadata_clock')::bigint)
       <>current_setting('wak_m12.metadata_version')::bigint THEN
    RAISE EXCEPTION 'M12_SMOKE: metadata-only adjustment changed canonical work';
  END IF;
  IF EXISTS (SELECT 1 FROM public.work_periods wp JOIN public.time_clock tc ON tc.id=wp.time_clock_id
      WHERE tc.device_tag='M12_NO_WORK_PERIOD') THEN
    RAISE EXCEPTION 'M12_SMOKE: importer created a missing work period';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.work_period_anomalies a
    JOIN public.work_periods wp ON wp.id=a.work_period_id
    JOIN public.work_period_versions v ON v.id=wp.current_version_id
    WHERE a.id=v_anomaly_id AND a.status='RESOLVED'
      AND a.resolution_reason_code='LEGACY_IMPORT_REVIEWED'
      AND a.resolution_version_id IS NOT NULL
      AND wp.status='READY' AND v.change_source='LEGACY_IMPORT'
  ) THEN
    RAISE EXCEPTION 'M12_SMOKE: detector anomaly was not retained and resolved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.work_period_anomalies WHERE id=v_anomaly_id) THEN
    RAISE EXCEPTION 'M12_SMOKE: detector anomaly was deleted';
  END IF;

  IF (SELECT wp.current_version_id FROM public.work_periods wp
      WHERE wp.time_clock_id=current_setting('wak_m12.manager_clock')::bigint)
       <>current_setting('wak_m12.manager_version')::bigint
     OR (SELECT wp.current_version_id FROM public.work_periods wp
      WHERE wp.time_clock_id=current_setting('wak_m12.owner_clock')::bigint)
       <>current_setting('wak_m12.owner_version')::bigint
     OR (SELECT wp.current_version_id FROM public.work_periods wp
      WHERE wp.time_clock_id=current_setting('wak_m12.void_clock')::bigint)
       <>current_setting('wak_m12.void_version')::bigint
     OR (SELECT wp.status FROM public.work_periods wp
      WHERE wp.time_clock_id=current_setting('wak_m12.void_clock')::bigint)<>'VOIDED' THEN
    RAISE EXCEPTION 'M12_SMOKE: reviewed or voided canonical work was overwritten';
  END IF;

  SELECT count(*) INTO v_versions_before
  FROM public.work_period_versions v
  JOIN public.work_periods wp ON wp.id=v.work_period_id
  JOIN public.time_clock tc ON tc.id=wp.time_clock_id
  WHERE tc.device_tag LIKE 'M12_%';
  v_second:=public.wak_import_legacy_clock_adjustments(
    'MOOROOLBARK',current_setting('wak_m12.week')::date,
    current_setting('wak_m12.manager')::uuid
  );
  SELECT count(*) INTO v_versions_after
  FROM public.work_period_versions v
  JOIN public.work_periods wp ON wp.id=v.work_period_id
  JOIN public.time_clock tc ON tc.id=wp.time_clock_id
  WHERE tc.device_tag LIKE 'M12_%';
  IF (v_second->>'imported_versions')::integer<>0
     OR (v_second->>'unchanged_legacy')::integer<>3
     OR v_versions_after<>v_versions_before THEN
    RAISE EXCEPTION 'M12_SMOKE: identical second import was not idempotent %',v_second;
  END IF;

  SELECT jsonb_agg(to_jsonb(tc) ORDER BY tc.id) INTO v_raw_after
  FROM public.time_clock tc WHERE tc.device_tag LIKE 'M12_%';
  IF v_raw_after IS DISTINCT FROM v_raw_before THEN
    RAISE EXCEPTION 'M12_SMOKE: importer modified raw time_clock evidence';
  END IF;

  /* A genuine legacy-source change appends history instead of mutating the prior import. */
  SELECT wp.current_version_id INTO STRICT v_old_import_version
  FROM public.work_periods wp
  WHERE wp.time_clock_id=current_setting('wak_m12.valid_clock')::bigint;
  UPDATE public.time_clock SET
    adjusted_clock_out_at=adjusted_clock_out_at+interval '1 minute',
    adjusted_reason='Historical correction revised',
    adjusted_at=adjusted_at+interval '1 minute'
  WHERE id=current_setting('wak_m12.valid_clock')::bigint;
  SELECT jsonb_agg(to_jsonb(tc) ORDER BY tc.id) INTO v_changed_raw
  FROM public.time_clock tc WHERE tc.device_tag LIKE 'M12_%';
  v_third:=public.wak_import_legacy_clock_adjustments(
    'MOOROOLBARK',current_setting('wak_m12.week')::date,
    current_setting('wak_m12.manager')::uuid
  );
  IF (v_third->>'imported_versions')::integer<>1
     OR (v_third->>'unchanged_legacy')::integer<>2
     OR NOT EXISTS (
       SELECT 1 FROM public.work_periods wp
       JOIN public.work_period_versions current_version ON current_version.id=wp.current_version_id
       JOIN public.time_clock tc ON tc.id=wp.time_clock_id
       WHERE tc.id=current_setting('wak_m12.valid_clock')::bigint
         AND wp.current_version_id<>v_old_import_version
         AND current_version.change_source='LEGACY_IMPORT'
         AND current_version.actual_end_at=tc.adjusted_clock_out_at
         AND EXISTS (SELECT 1 FROM public.work_period_versions old
           WHERE old.id=v_old_import_version AND old.work_period_id=wp.id)
     ) THEN
    RAISE EXCEPTION 'M12_SMOKE: changed legacy source did not append immutable history %',v_third;
  END IF;
  SELECT jsonb_agg(to_jsonb(tc) ORDER BY tc.id) INTO v_raw_after
  FROM public.time_clock tc WHERE tc.device_tag LIKE 'M12_%';
  IF v_raw_after IS DISTINCT FROM v_changed_raw THEN
    RAISE EXCEPTION 'M12_SMOKE: changed-source import modified raw time_clock evidence';
  END IF;
END
$import_assertions$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $authenticated_acl$
BEGIN
  BEGIN
    PERFORM public.wak_import_legacy_clock_adjustments(
      'MOOROOLBARK',current_setting('wak_m12.week')::date,
      current_setting('wak_m12.manager')::uuid
    );
    RAISE EXCEPTION 'M12_SMOKE_AUTHENTICATED_EXECUTE_ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$authenticated_acl$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $anon_acl$
BEGIN
  BEGIN
    PERFORM public.wak_import_legacy_clock_adjustments(
      'MOOROOLBARK',current_setting('wak_m12.week')::date,
      current_setting('wak_m12.manager')::uuid
    );
    RAISE EXCEPTION 'M12_SMOKE_ANON_EXECUTE_ALLOWED';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$anon_acl$;
RESET ROLE;

ROLLBACK;

SELECT jsonb_build_object(
  'result',CASE WHEN
    NOT EXISTS (SELECT 1 FROM public.time_clock tc WHERE tc.device_tag LIKE 'M12_%')
    AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.cover_note LIKE 'M12_%')
    THEN 'M12_SMOKE_OK' ELSE 'M12_SMOKE_PERSISTED_FIXTURES' END,
  'persisted_time_clock_rows',(SELECT count(*) FROM public.time_clock tc WHERE tc.device_tag LIKE 'M12_%'),
  'persisted_shift_rows',(SELECT count(*) FROM public.shifts s WHERE s.cover_note LIKE 'M12_%')
) AS migration_12_smoke;
