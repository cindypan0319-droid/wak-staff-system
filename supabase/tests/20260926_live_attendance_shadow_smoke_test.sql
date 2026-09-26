/* Run after Migration 015 as postgres. Every mutation is inside this rollback-only transaction. */
BEGIN;

DO $fixtures$
DECLARE
  v_manager uuid;
  v_owner uuid;
  v_staff uuid;
  v_now timestamptz:=clock_timestamp();
  v_today date:=(v_now AT TIME ZONE 'Australia/Melbourne')::date;
  v_current_week date;
  v_current_start timestamptz;
  v_historical_week date;
  v_historical_start timestamptz;
BEGIN
  IF session_user<>'postgres' THEN RAISE EXCEPTION 'M15_SMOKE_PRE: run as postgres'; END IF;
  SELECT id INTO v_manager FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='MANAGER' ORDER BY id LIMIT 1;
  SELECT id INTO v_owner FROM public.profiles
  WHERE is_active IS TRUE AND upper(role::text)='OWNER' ORDER BY id LIMIT 1;
  SELECT p.id INTO v_staff FROM public.profiles p
  WHERE p.is_active IS TRUE AND upper(p.role::text)='STAFF'
    AND NOT EXISTS(SELECT 1 FROM public.time_clock tc
      WHERE tc.staff_id=p.id AND tc.clock_out_at IS NULL)
  ORDER BY p.id LIMIT 1;
  IF v_manager IS NULL OR v_owner IS NULL OR v_staff IS NULL THEN
    RAISE EXCEPTION 'M15_SMOKE_PRE: active Manager, Owner, and Staff without an open clock required';
  END IF;

  v_current_week:=v_today-((extract(dow FROM v_today)::integer-4+7)%7);
  v_current_start:=v_current_week::timestamp AT TIME ZONE 'Australia/Melbourne';
  IF v_now<v_current_start+interval '12 hours'
     OR v_now+interval '2 hours'>=(v_current_week+7)::timestamp AT TIME ZONE 'Australia/Melbourne' THEN
    RAISE EXCEPTION 'M15_SMOKE_PRE: current week lacks a safe fixture window; retry later';
  END IF;

  SELECT d INTO v_historical_week
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
  IF v_historical_week IS NULL THEN RAISE EXCEPTION 'M15_SMOKE_PRE: no safe historical week'; END IF;
  v_historical_start:=v_historical_week::timestamp AT TIME ZONE 'Australia/Melbourne';

  PERFORM pg_advisory_xact_lock(hashtextextended('MOOROOLBARK|'||v_current_week::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('MOOROOLBARK|'||v_historical_week::text,0));
  IF EXISTS(SELECT 1 FROM public.payroll_periods p
      WHERE p.store_id='MOOROOLBARK' AND p.week_start=v_historical_week)
     OR EXISTS(SELECT 1 FROM public.time_clock tc
      WHERE tc.clock_in_at>=v_historical_start AND tc.clock_in_at<v_historical_start+interval '7 days')
     OR EXISTS(SELECT 1 FROM public.shifts s
      WHERE s.store_id='MOOROOLBARK'
        AND s.shift_start>=v_historical_start-interval '6 hours'
        AND s.shift_start<v_historical_start+interval '7 days 6 hours') THEN
    RAISE EXCEPTION 'M15_SMOKE_PRE: historical fixture week changed after lock';
  END IF;

  PERFORM set_config('wak_m15.manager',v_manager::text,true);
  PERFORM set_config('wak_m15.owner',v_owner::text,true);
  PERFORM set_config('wak_m15.staff',v_staff::text,true);
  PERFORM set_config('wak_m15.current_week',v_current_week::text,true);
  PERFORM set_config('wak_m15.historical_week',v_historical_week::text,true);
  PERFORM set_config('wak_m15.now',v_now::text,true);

  INSERT INTO public.time_clock(staff_id,clock_in_at,clock_out_at,device_tag) VALUES
    (v_staff,v_now-interval '6 hours',v_now-interval '5 hours','M15_CLOSED'),
    (v_staff,v_now-interval '4 hours',v_now-interval '3 hours','M15_MANAGER'),
    (v_staff,v_now-interval '3 hours',v_now-interval '2 hours','M15_OWNER'),
    (v_staff,v_now-interval '1 hour',NULL,'M15_OPEN'),
    (v_staff,v_now+interval '1 hour',v_now+interval '2 hours','M15_FUTURE'),
    (v_staff,v_historical_start+interval '10 hours',v_historical_start+interval '11 hours','M15_HISTORY');

  PERFORM set_config('wak_m15.raw_before',(
    SELECT jsonb_agg(to_jsonb(tc) ORDER BY tc.id)::text
    FROM public.time_clock tc WHERE tc.device_tag LIKE 'M15_%'
  ),true);
END
$fixtures$;

/* A/B: the active week succeeds and reports its captured as-of boundary. */
SET LOCAL ROLE service_role;
DO $current_refresh$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.wak_refresh_attendance_shadow(
    'MOOROOLBARK',current_setting('wak_m15.current_week')::date,
    current_setting('wak_m15.manager')::uuid
  );
  IF (v_result->>'period_complete')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'M15_SMOKE_B: active week reported complete';
  END IF;
  IF (v_result->>'scan_end')::timestamptz<current_setting('wak_m15.now')::timestamptz
     OR (v_result->>'scan_end')::timestamptz>clock_timestamp() THEN
    RAISE EXCEPTION 'M15_SMOKE_A/B: scan_end is not the refresh as-of time';
  END IF;
  PERFORM set_config('wak_m15.first_scan_end',v_result->>'scan_end',true);
END
$current_refresh$;
RESET ROLE;

DO $current_assertions$
DECLARE
  v_manager_wp bigint;
  v_owner_wp bigint;
  v_new_version bigint;
  v_row record;
  v_source text;
  v_actor uuid;
BEGIN
  /* C: active periods remain BUILDING. */
  IF NOT EXISTS(SELECT 1 FROM public.payroll_periods
      WHERE store_id='MOOROOLBARK' AND week_start=current_setting('wak_m15.current_week')::date
        AND shadow_status='BUILDING' AND last_refreshed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'M15_SMOKE_C: current payroll period is not BUILDING';
  END IF;

  /* D: closed past fixture is represented by a SYSTEM work period. */
  IF NOT EXISTS(SELECT 1 FROM public.time_clock tc
      JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id
      WHERE tc.device_tag='M15_CLOSED' AND v.change_source='SYSTEM'
        AND v.actual_start_at=tc.clock_in_at AND v.actual_end_at=tc.clock_out_at) THEN
    RAISE EXCEPTION 'M15_SMOKE_D: closed current-week clock was not generated';
  END IF;

  /* E/F: open evidence stays open and carries the existing blocking anomaly. */
  IF NOT EXISTS(SELECT 1 FROM public.time_clock tc
      JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      JOIN public.work_period_versions v ON v.id=wp.current_version_id
      JOIN public.work_period_anomalies a ON a.work_period_id=wp.id
      WHERE tc.device_tag='M15_OPEN' AND tc.clock_out_at IS NULL
        AND v.actual_end_at IS NULL AND v.payable_end_at IS NULL
        AND a.anomaly_type='MISSING_CLOCK_OUT' AND a.status='OPEN' AND a.severity='BLOCKING') THEN
    RAISE EXCEPTION 'M15_SMOKE_E/F: open clock interpretation differs';
  END IF;

  /* G: a raw clock after the captured scan boundary has no canonical row. */
  IF EXISTS(SELECT 1 FROM public.time_clock tc
      JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      WHERE tc.device_tag='M15_FUTURE') THEN
    RAISE EXCEPTION 'M15_SMOKE_G: future clock was processed';
  END IF;

  SELECT wp.id INTO v_manager_wp FROM public.time_clock tc
  JOIN public.work_periods wp ON wp.time_clock_id=tc.id WHERE tc.device_tag='M15_MANAGER';
  SELECT wp.id INTO v_owner_wp FROM public.time_clock tc
  JOIN public.work_periods wp ON wp.time_clock_id=tc.id WHERE tc.device_tag='M15_OWNER';
  IF v_manager_wp IS NULL OR v_owner_wp IS NULL THEN
    RAISE EXCEPTION 'M15_SMOKE_I: preservation fixtures were not generated';
  END IF;

  /* Create complete reviewed interpretations that the next shadow refresh must preserve. */
  FOR v_row IN
    SELECT wp.id AS work_period_id,tc.device_tag,tc.clock_in_at,tc.clock_out_at,
      coalesce(max(v.version_number),0)+1 AS next_version
    FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
    JOIN public.work_period_versions v ON v.work_period_id=wp.id
    WHERE tc.device_tag IN ('M15_MANAGER','M15_OWNER')
    GROUP BY wp.id,tc.device_tag,tc.clock_in_at,tc.clock_out_at
    ORDER BY tc.device_tag
  LOOP
    v_source:=CASE WHEN v_row.device_tag='M15_MANAGER' THEN 'MANAGER' ELSE 'OWNER' END;
    v_actor:=CASE WHEN v_source='MANAGER' THEN current_setting('wak_m15.manager')::uuid
      ELSE current_setting('wak_m15.owner')::uuid END;
    INSERT INTO public.work_period_versions(
      work_period_id,version_number,disposition,matched_shift_id,
      actual_start_at,actual_end_at,payable_start_at,payable_end_at,
      reason_code,reason_note,change_source,created_by
    ) VALUES(
      v_row.work_period_id,v_row.next_version,'ACTIVE',NULL,
      v_row.clock_in_at,v_row.clock_out_at,v_row.clock_in_at,v_row.clock_out_at,
      'M15_REVIEW','Live-week preservation fixture',v_source,v_actor
    ) RETURNING id INTO v_new_version;
    UPDATE public.work_periods SET current_version_id=v_new_version,status='READY'
    WHERE id=v_row.work_period_id;
    PERFORM set_config('wak_m15.keep_'||lower(v_source),v_new_version::text,true);
  END LOOP;

  PERFORM set_config('wak_m15.closed_versions',(
    SELECT count(*)::text FROM public.work_period_versions v
    JOIN public.work_periods wp ON wp.id=v.work_period_id
    JOIN public.time_clock tc ON tc.id=wp.time_clock_id WHERE tc.device_tag='M15_CLOSED'
  ),true);
  PERFORM set_config('wak_m15.open_versions',(
    SELECT count(*)::text FROM public.work_period_versions v
    JOIN public.work_periods wp ON wp.id=v.work_period_id
    JOIN public.time_clock tc ON tc.id=wp.time_clock_id WHERE tc.device_tag='M15_OPEN'
  ),true);
END
$current_assertions$;

/* H/I: repeat refresh is idempotent for SYSTEM fixtures and preserves reviewed versions. */
SET LOCAL ROLE service_role;
SELECT public.wak_refresh_attendance_shadow(
  'MOOROOLBARK',current_setting('wak_m15.current_week')::date,
  current_setting('wak_m15.manager')::uuid
);
RESET ROLE;

DO $repeat_assertions$
BEGIN
  IF (SELECT count(*) FROM public.work_period_versions v
      JOIN public.work_periods wp ON wp.id=v.work_period_id
      JOIN public.time_clock tc ON tc.id=wp.time_clock_id WHERE tc.device_tag='M15_CLOSED')<>
      current_setting('wak_m15.closed_versions')::integer
     OR (SELECT count(*) FROM public.work_period_versions v
      JOIN public.work_periods wp ON wp.id=v.work_period_id
      JOIN public.time_clock tc ON tc.id=wp.time_clock_id WHERE tc.device_tag='M15_OPEN')<>
      current_setting('wak_m15.open_versions')::integer THEN
    RAISE EXCEPTION 'M15_SMOKE_H: unchanged SYSTEM fixtures appended versions';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      WHERE tc.device_tag='M15_MANAGER'
        AND wp.current_version_id=current_setting('wak_m15.keep_manager')::bigint)
     OR NOT EXISTS(SELECT 1 FROM public.time_clock tc JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      WHERE tc.device_tag='M15_OWNER'
        AND wp.current_version_id=current_setting('wak_m15.keep_owner')::bigint) THEN
    RAISE EXCEPTION 'M15_SMOKE_I: reviewed interpretation was overwritten';
  END IF;
END
$repeat_assertions$;

/* J: a future Thursday payroll week remains invalid. */
SET LOCAL ROLE service_role;
DO $future_rejection$
BEGIN
  BEGIN
    PERFORM public.wak_refresh_attendance_shadow(
      'MOOROOLBARK',current_setting('wak_m15.current_week')::date+7,
      current_setting('wak_m15.manager')::uuid
    );
    RAISE EXCEPTION 'M15_SMOKE_J';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM='M15_SMOKE_J' OR SQLERRM<>'ATTENDANCE_SHADOW_PERIOD_IN_FUTURE' THEN RAISE; END IF;
  END;
END
$future_rejection$;
RESET ROLE;

/* K: historical completed weeks retain their previous completion behavior. */
SET LOCAL ROLE service_role;
DO $historical_refresh$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.wak_refresh_attendance_shadow(
    'MOOROOLBARK',current_setting('wak_m15.historical_week')::date,
    current_setting('wak_m15.manager')::uuid
  );
  IF (v_result->>'period_complete')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'M15_SMOKE_K: historical week reported incomplete';
  END IF;
  IF (v_result->>'scan_end')::timestamptz<>
     ((current_setting('wak_m15.historical_week')::date+7)::timestamp
       AT TIME ZONE 'Australia/Melbourne') THEN
    RAISE EXCEPTION 'M15_SMOKE_K: historical scan_end differs from period_end';
  END IF;
END
$historical_refresh$;
RESET ROLE;

DO $final_assertions$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.payroll_periods
      WHERE store_id='MOOROOLBARK' AND week_start=current_setting('wak_m15.historical_week')::date
        AND shadow_status='READY_FOR_COMPARISON') THEN
    RAISE EXCEPTION 'M15_SMOKE_K: historical period is not READY_FOR_COMPARISON';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.time_clock tc
      JOIN public.work_periods wp ON wp.time_clock_id=tc.id
      WHERE tc.device_tag='M15_HISTORY') THEN
    RAISE EXCEPTION 'M15_SMOKE_K: historical fixture was not generated';
  END IF;
  /* L: raw clock rows, including the open and future rows, are unchanged. */
  IF (SELECT jsonb_agg(to_jsonb(tc) ORDER BY tc.id) FROM public.time_clock tc
      WHERE tc.device_tag LIKE 'M15_%') IS DISTINCT FROM
      current_setting('wak_m15.raw_before')::jsonb THEN
    RAISE EXCEPTION 'M15_SMOKE_L: raw time_clock evidence changed';
  END IF;
END
$final_assertions$;

ROLLBACK;

/* M: read-only proof that the outer rollback removed every tagged fixture. */
SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM public.time_clock WHERE device_tag LIKE 'M15_%'
) THEN 'M15_SMOKE_OK' ELSE 'M15_SMOKE_PERSISTED_ROWS' END AS result;
