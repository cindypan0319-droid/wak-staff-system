BEGIN;

/* Migration 011 / P1B-1: CLOCK-backed canonical attendance generator. */
DO $precondition$
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'MIGRATION_11_PRECONDITION: run as postgres';
  END IF;
  IF to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'MIGRATION_11_PRECONDITION: generator already exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'MIGRATION_11_PRECONDITION: service_role is missing';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN
      ('payroll_periods','work_periods','work_period_versions','work_period_anomalies')) <> 4 THEN
    RAISE EXCEPTION 'MIGRATION_11_PRECONDITION: Migration 010 tables are incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='work_periods_time_clock_unique')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public' AND indexname='work_periods_time_clock_unique') THEN
    RAISE EXCEPTION 'MIGRATION_11_PRECONDITION: one-clock invariant is missing';
  END IF;
END
$precondition$;

CREATE FUNCTION public.wak_refresh_attendance_shadow(
  p_store_id text,
  p_week_start date,
  p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_actor_role text;
  v_period_id bigint;
  v_clock record;
  v_explicit record;
  v_match record;
  v_work_period public.work_periods%ROWTYPE;
  v_current public.work_period_versions%ROWTYPE;
  v_match_id bigint;
  v_candidate_count integer;
  v_actual_end timestamptz;
  v_payable_start timestamptz;
  v_payable_end timestamptz;
  v_status text;
  v_types text[];
  v_severities text[];
  v_details jsonb;
  v_desired_fingerprint text;
  v_open_fingerprint text;
  v_material_change boolean;
  v_version_number integer;
  v_result_version_id bigint;
  v_index integer;
  v_created integer := 0;
  v_versions integer := 0;
  v_unchanged integer := 0;
  v_preserved integer := 0;
  v_anomalies_opened integer := 0;
  v_anomalies_resolved integer := 0;
  v_has_blocking boolean;
BEGIN
  IF p_store_id IS DISTINCT FROM 'MOOROOLBARK' THEN
    RAISE EXCEPTION 'ATTENDANCE_SHADOW_STORE_NOT_SUPPORTED';
  END IF;
  IF p_week_start IS NULL OR extract(dow FROM p_week_start) <> 4 THEN
    RAISE EXCEPTION 'ATTENDANCE_SHADOW_WEEK_START_MUST_BE_THURSDAY';
  END IF;

  v_period_start := p_week_start::timestamp AT TIME ZONE 'Australia/Melbourne';
  v_period_end := (p_week_start + 7)::timestamp AT TIME ZONE 'Australia/Melbourne';
  IF v_period_end > clock_timestamp() THEN
    RAISE EXCEPTION 'ATTENDANCE_SHADOW_PERIOD_NOT_COMPLETE';
  END IF;

  SELECT upper(p.role::text) INTO v_actor_role
  FROM public.profiles p
  WHERE p.id=p_actor AND p.is_active IS TRUE;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'ATTENDANCE_SHADOW_ACTOR_INACTIVE_OR_MISSING';
  END IF;
  IF v_actor_role NOT IN ('MANAGER','OWNER') THEN
    RAISE EXCEPTION 'ATTENDANCE_SHADOW_ACTOR_NOT_AUTHORIZED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_store_id || '|' || p_week_start::text, 0));

  INSERT INTO public.payroll_periods (
    store_id,week_start,week_end,timezone,shadow_status,generation_version,last_refreshed_at
  ) VALUES (
    p_store_id,p_week_start,p_week_start+6,'Australia/Melbourne','BUILDING',1,NULL
  )
  ON CONFLICT (store_id,week_start) DO UPDATE SET
    week_end=excluded.week_end,
    timezone=excluded.timezone,
    shadow_status='BUILDING',
    generation_version=public.payroll_periods.generation_version+1
  RETURNING id INTO v_period_id;

  FOR v_clock IN
    SELECT tc.id,tc.staff_id,tc.shift_id,tc.clock_in_at,tc.clock_out_at
    FROM public.time_clock tc
    WHERE tc.clock_in_at >= v_period_start AND tc.clock_in_at < v_period_end
    ORDER BY tc.id
    FOR SHARE
  LOOP
    v_types := ARRAY[]::text[];
    v_severities := ARRAY[]::text[];
    v_match_id := NULL;
    v_actual_end := CASE
      WHEN v_clock.clock_out_at IS NULL OR v_clock.clock_out_at > v_clock.clock_in_at
        THEN v_clock.clock_out_at
      ELSE NULL
    END;
    v_payable_start := NULL;
    v_payable_end := NULL;
    v_status := 'NEEDS_REVIEW';
    v_current.id := NULL;
    v_current.disposition := NULL;
    v_current.change_source := NULL;
    v_current.matched_shift_id := NULL;
    v_current.actual_start_at := NULL;
    v_current.actual_end_at := NULL;
    v_current.payable_start_at := NULL;
    v_current.payable_end_at := NULL;

    SELECT * INTO v_work_period
    FROM public.work_periods wp
    WHERE wp.time_clock_id=v_clock.id
    FOR UPDATE;

    IF FOUND THEN
      IF v_work_period.current_version_id IS NOT NULL THEN
        SELECT * INTO v_current FROM public.work_period_versions
        WHERE id=v_work_period.current_version_id AND work_period_id=v_work_period.id;
      END IF;

      IF v_work_period.status='VOIDED'
         OR v_current.disposition='VOIDED'
         OR v_current.change_source IN ('MANAGER','OWNER','LEGACY_IMPORT') THEN
        v_preserved := v_preserved+1;
        CONTINUE;
      END IF;
    ELSE
      INSERT INTO public.work_periods (
        store_id,staff_id,payroll_period_id,source_type,time_clock_id,status
      ) VALUES (
        p_store_id,v_clock.staff_id,v_period_id,'CLOCK',v_clock.id,'NEEDS_REVIEW'
      ) RETURNING * INTO v_work_period;
      v_created := v_created+1;
    END IF;

    /* Explicit match wins only when store, employee, and worked-context status agree. */
    IF v_clock.shift_id IS NOT NULL THEN
      SELECT s.id,s.staff_id,s.store_id,s.shift_start,s.shift_end,s.shift_status,s.parent_shift_id
      INTO v_explicit FROM public.shifts s WHERE s.id=v_clock.shift_id FOR SHARE;
      IF FOUND AND v_explicit.staff_id IS DISTINCT FROM v_clock.staff_id THEN
        v_types := array_append(v_types,'SHIFT_STAFF_MISMATCH');
        v_severities := array_append(v_severities,'BLOCKING');
      ELSIF FOUND
        AND v_explicit.store_id=p_store_id
        AND upper(coalesce(v_explicit.shift_status,'SCHEDULED')) IN ('SCHEDULED','WORKED') THEN
        v_match_id := v_explicit.id;
        SELECT s.id,s.staff_id,s.store_id,s.shift_start,s.shift_end,s.shift_status,s.parent_shift_id
        INTO v_match FROM public.shifts s WHERE s.id=v_match_id FOR SHARE;
      END IF;
    END IF;

    /* No arbitrary nearest-shift selection: exactly one eligible +/-6h candidate is required. */
    IF v_match_id IS NULL AND NOT ('SHIFT_STAFF_MISMATCH'=ANY(v_types)) THEN
      SELECT count(*),min(s.id) INTO v_candidate_count,v_match_id
      FROM public.shifts s
      WHERE s.store_id=p_store_id AND s.staff_id=v_clock.staff_id
        AND upper(coalesce(s.shift_status,'SCHEDULED')) IN ('SCHEDULED','WORKED')
        AND abs(extract(epoch FROM (s.shift_start-v_clock.clock_in_at))) <= 21600;
      IF v_candidate_count=1 THEN
        SELECT s.id,s.staff_id,s.store_id,s.shift_start,s.shift_end,s.shift_status,s.parent_shift_id
        INTO v_match FROM public.shifts s
        WHERE s.id=v_match_id AND s.store_id=p_store_id AND s.staff_id=v_clock.staff_id
          AND upper(coalesce(s.shift_status,'SCHEDULED')) IN ('SCHEDULED','WORKED')
        FOR SHARE;
        IF NOT FOUND THEN
          v_match_id := NULL;
          v_types := array_append(v_types,'UNROSTERED_WORK');
          v_severities := array_append(v_severities,'BLOCKING');
        END IF;
      ELSIF v_candidate_count>1 THEN
        v_match_id := NULL;
        v_types := array_append(v_types,'AMBIGUOUS_MATCH');
        v_severities := array_append(v_severities,'BLOCKING');
      ELSE
        v_match_id := NULL;
        v_types := array_append(v_types,'UNROSTERED_WORK');
        v_severities := array_append(v_severities,'BLOCKING');
      END IF;
    END IF;

    IF v_clock.clock_out_at IS NULL THEN
      v_types := array_append(v_types,'MISSING_CLOCK_OUT');
      v_severities := array_append(v_severities,'BLOCKING');
    ELSIF v_clock.clock_out_at <= v_clock.clock_in_at THEN
      v_types := array_append(v_types,'INVALID_CLOCK_RANGE');
      v_severities := array_append(v_severities,'BLOCKING');
    END IF;

    IF v_clock.clock_out_at IS NOT NULL AND
       (v_clock.clock_in_at AT TIME ZONE 'Australia/Melbourne')::date <>
       (v_clock.clock_out_at AT TIME ZONE 'Australia/Melbourne')::date THEN
      v_types := array_append(v_types,'CROSSES_MIDNIGHT');
      v_severities := array_append(v_severities,'BLOCKING');
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.time_clock other
      WHERE other.id<>v_clock.id AND other.staff_id=v_clock.staff_id
        AND other.clock_in_at>=v_period_start AND other.clock_in_at<v_period_end
        AND other.clock_in_at=v_clock.clock_in_at
        AND other.clock_out_at IS NOT DISTINCT FROM v_clock.clock_out_at
    ) THEN
      v_types := array_append(v_types,'DUPLICATE_CLOCK');
      v_severities := array_append(v_severities,'BLOCKING');
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.time_clock other
      WHERE other.id<>v_clock.id AND other.staff_id=v_clock.staff_id
        AND other.clock_in_at>=v_period_start AND other.clock_in_at<v_period_end
        AND other.clock_in_at < coalesce(v_clock.clock_out_at,v_period_end)
        AND v_clock.clock_in_at < coalesce(other.clock_out_at,v_period_end)
    ) THEN
      v_types := array_append(v_types,'OVERLAPPING_CLOCK');
      v_severities := array_append(v_severities,'BLOCKING');
    END IF;

    /* Payable boundaries use raw punches and never subtract paid breaks. */
    IF v_match_id IS NOT NULL AND v_clock.clock_out_at IS NOT NULL
       AND v_clock.clock_out_at>v_clock.clock_in_at THEN
      IF v_clock.clock_in_at < v_match.shift_start THEN
        IF extract(epoch FROM (v_match.shift_start-v_clock.clock_in_at)) <= 300 THEN
          v_payable_start := v_match.shift_start;
        ELSE
          v_types := array_append(v_types,'EARLY_START');
          v_severities := array_append(v_severities,'BLOCKING');
        END IF;
      ELSE
        v_payable_start := v_clock.clock_in_at;
        IF extract(epoch FROM (v_clock.clock_in_at-v_match.shift_start)) > 300 THEN
          v_types := array_append(v_types,'LATE_START');
          v_severities := array_append(v_severities,'WARNING');
        END IF;
      END IF;

      IF v_clock.clock_out_at < v_match.shift_end THEN
        v_payable_end := v_clock.clock_out_at;
        IF extract(epoch FROM (v_match.shift_end-v_clock.clock_out_at)) > 300 THEN
          v_types := array_append(v_types,'EARLY_FINISH');
          v_severities := array_append(v_severities,'WARNING');
        END IF;
      ELSIF v_clock.clock_out_at=v_match.shift_end THEN
        v_payable_end := v_clock.clock_out_at;
      ELSIF extract(epoch FROM (v_clock.clock_out_at-v_match.shift_end)) <= 300 THEN
        v_payable_end := v_match.shift_end;
      ELSE
        v_types := array_append(v_types,'LATE_FINISH');
        v_severities := array_append(v_severities,'BLOCKING');
      END IF;
    END IF;

    IF v_types && ARRAY[
      'UNROSTERED_WORK','AMBIGUOUS_MATCH','OVERLAPPING_CLOCK','DUPLICATE_CLOCK',
      'INVALID_CLOCK_RANGE','CROSSES_MIDNIGHT','SHIFT_STAFF_MISMATCH'
    ]::text[] THEN
      v_payable_start := NULL;
      v_payable_end := NULL;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM unnest(v_severities) AS desired(severity)
      WHERE severity='BLOCKING'
    ) OR EXISTS (
      SELECT 1 FROM public.work_period_anomalies existing
      WHERE existing.work_period_id=v_work_period.id
        AND existing.status='OPEN' AND existing.severity='BLOCKING'
        AND existing.details->>'detector' IS DISTINCT FROM 'ATTENDANCE_SHADOW_V1'
    ) INTO v_has_blocking;
    IF NOT v_has_blocking AND v_match_id IS NOT NULL
       AND v_clock.clock_out_at IS NOT NULL
       AND v_payable_start IS NOT NULL AND v_payable_end IS NOT NULL THEN
      v_status := 'READY';
    END IF;

    SELECT coalesce(string_agg(t||':'||s,',' ORDER BY t),'')
    INTO v_desired_fingerprint FROM unnest(v_types,v_severities) AS desired(t,s);
    SELECT coalesce(string_agg(
      a.anomaly_type||':'||CASE
        WHEN a.details->>'detector' IS DISTINCT FROM 'ATTENDANCE_SHADOW_V1'
          AND a.anomaly_type=ANY(v_types)
        THEN v_severities[array_position(v_types,a.anomaly_type)]
        ELSE a.severity
      END,',' ORDER BY a.anomaly_type
    ),'')
    INTO v_open_fingerprint FROM public.work_period_anomalies a
    WHERE a.work_period_id=v_work_period.id AND a.status='OPEN'
      AND (a.details->>'detector'='ATTENDANCE_SHADOW_V1' OR a.anomaly_type=ANY(v_types));

    v_material_change := v_current.id IS NULL
      OR v_current.disposition IS DISTINCT FROM 'ACTIVE'
      OR v_current.matched_shift_id IS DISTINCT FROM v_match_id
      OR v_current.actual_start_at IS DISTINCT FROM v_clock.clock_in_at
      OR v_current.actual_end_at IS DISTINCT FROM v_actual_end
      OR v_current.payable_start_at IS DISTINCT FROM v_payable_start
      OR v_current.payable_end_at IS DISTINCT FROM v_payable_end
      OR v_work_period.store_id IS DISTINCT FROM p_store_id
      OR v_work_period.staff_id IS DISTINCT FROM v_clock.staff_id
      OR v_work_period.payroll_period_id IS DISTINCT FROM v_period_id
      OR v_work_period.status IS DISTINCT FROM v_status
      OR v_open_fingerprint IS DISTINCT FROM v_desired_fingerprint;

    IF v_material_change THEN
      SELECT coalesce(max(version_number),0)+1 INTO v_version_number
      FROM public.work_period_versions WHERE work_period_id=v_work_period.id;
      INSERT INTO public.work_period_versions (
        work_period_id,version_number,disposition,matched_shift_id,
        actual_start_at,actual_end_at,payable_start_at,payable_end_at,
        reason_code,change_source,created_by
      ) VALUES (
        v_work_period.id,v_version_number,'ACTIVE',v_match_id,
        v_clock.clock_in_at,v_actual_end,v_payable_start,v_payable_end,
        CASE WHEN v_current.id IS NULL THEN 'SHADOW_GENERATED' ELSE 'SHADOW_REFRESHED' END,
        'SYSTEM',NULL
      ) RETURNING id INTO v_result_version_id;
      UPDATE public.work_periods SET
        store_id=p_store_id,staff_id=v_clock.staff_id,payroll_period_id=v_period_id,
        matched_shift_id=v_match_id,status=v_status,current_version_id=v_result_version_id,
        updated_at=clock_timestamp()
      WHERE id=v_work_period.id;
      v_versions := v_versions+1;
    ELSE
      v_result_version_id := v_current.id;
      v_unchanged := v_unchanged+1;
    END IF;

    UPDATE public.work_period_anomalies a SET
      status='RESOLVED',resolved_at=clock_timestamp(),resolved_by=NULL,
      resolution_reason_code='SYSTEM_REFRESH_CLEARED',resolution_note=NULL,
      resolution_version_id=v_result_version_id
    WHERE a.work_period_id=v_work_period.id AND a.status='OPEN'
      AND a.details->>'detector'='ATTENDANCE_SHADOW_V1'
      AND NOT (a.anomaly_type=ANY(v_types));
    GET DIAGNOSTICS v_index=ROW_COUNT;
    v_anomalies_resolved := v_anomalies_resolved+v_index;

    IF coalesce(array_length(v_types,1),0)>0 THEN
      FOR v_index IN 1..array_length(v_types,1) LOOP
        v_details := jsonb_build_object(
          'detector','ATTENDANCE_SHADOW_V1','clock_id',v_clock.id,
          'matched_shift_id',v_match_id
        );
        IF v_types[v_index]='INVALID_CLOCK_RANGE' THEN
          v_details := v_details || jsonb_build_object(
            'raw_clock_in_at',v_clock.clock_in_at,
            'raw_clock_out_at',v_clock.clock_out_at
          );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM public.work_period_anomalies a
          WHERE a.work_period_id=v_work_period.id
            AND a.anomaly_type=v_types[v_index] AND a.status='OPEN'
        ) THEN
          v_anomalies_opened := v_anomalies_opened+1;
          INSERT INTO public.work_period_anomalies (
            work_period_id,anomaly_type,severity,status,details
          ) VALUES (
            v_work_period.id,v_types[v_index],v_severities[v_index],'OPEN',v_details
          );
        ELSE
          UPDATE public.work_period_anomalies a SET
            severity=v_severities[v_index],details=v_details
          WHERE a.work_period_id=v_work_period.id
            AND a.anomaly_type=v_types[v_index] AND a.status='OPEN'
            AND a.details->>'detector'='ATTENDANCE_SHADOW_V1';
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  UPDATE public.payroll_periods SET
    shadow_status='READY_FOR_COMPARISON',last_refreshed_at=clock_timestamp()
  WHERE id=v_period_id;

  RETURN jsonb_build_object(
    'store_id',p_store_id,'week_start',p_week_start,'week_end',p_week_start+6,
    'payroll_period_id',v_period_id,'created_work_periods',v_created,
    'appended_versions',v_versions,'unchanged_system',v_unchanged,
    'preserved_manual',v_preserved,'opened_anomalies',v_anomalies_opened,
    'resolved_anomalies',v_anomalies_resolved,
    'detector','ATTENDANCE_SHADOW_V1'
  );
END
$function$;

ALTER FUNCTION public.wak_refresh_attendance_shadow(text,date,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wak_refresh_attendance_shadow(text,date,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.wak_refresh_attendance_shadow(text,date,uuid)
  TO service_role;

DO $postcondition$
DECLARE v_function oid := to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)');
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_11_POSTCONDITION: generator missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
      WHERE p.oid=v_function AND p.prosecdef AND r.rolname='postgres'
        AND p.proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
    RAISE EXCEPTION 'MIGRATION_11_POSTCONDITION: function security differs';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
       WHERE p.oid=v_function AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     )
     OR has_function_privilege('anon',v_function,'EXECUTE')
     OR has_function_privilege('authenticated',v_function,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
    RAISE EXCEPTION 'MIGRATION_11_POSTCONDITION: function ACL differs';
  END IF;
END
$postcondition$;

COMMIT;
