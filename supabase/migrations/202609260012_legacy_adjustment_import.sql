BEGIN;

/* Migration 012 / P1B: import legacy time-clock adjustments into canonical history. */
DO $precondition$
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'MIGRATION_12_PRECONDITION: run as postgres';
  END IF;
  IF to_regprocedure('public.wak_import_legacy_clock_adjustments(text,date,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'MIGRATION_12_PRECONDITION: importer already exists';
  END IF;
  IF to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_12_PRECONDITION: Migration 011 generator is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'MIGRATION_12_PRECONDITION: service_role is missing';
  END IF;
  IF EXISTS (
    SELECT expected.table_name,expected.column_name
    FROM (VALUES
      ('time_clock','id','bigint'),
      ('time_clock','clock_in_at','timestamp with time zone'),
      ('time_clock','clock_out_at','timestamp with time zone'),
      ('time_clock','adjusted_clock_in_at','timestamp with time zone'),
      ('time_clock','adjusted_clock_out_at','timestamp with time zone'),
      ('time_clock','adjusted_reason','text'),
      ('time_clock','adjusted_by','uuid'),
      ('time_clock','adjusted_at','timestamp with time zone'),
      ('work_periods','id','bigint'),
      ('work_periods','time_clock_id','bigint'),
      ('work_periods','current_version_id','bigint'),
      ('work_period_versions','id','bigint'),
      ('work_period_versions','change_source','text'),
      ('work_period_anomalies','id','bigint')
    ) expected(table_name,column_name,data_type)
    LEFT JOIN information_schema.columns c
      ON c.table_schema='public' AND c.table_name=expected.table_name
      AND c.column_name=expected.column_name
    WHERE c.data_type IS DISTINCT FROM expected.data_type
  ) THEN
    RAISE EXCEPTION 'MIGRATION_12_PRECONDITION: required legacy/canonical column contract differs';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname='public' AND indexname='work_periods_time_clock_unique'
      AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname='work_periods_current_version_same_period_fk'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname='work_period_anomalies_resolution_same_period_fk'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_12_PRECONDITION: canonical integrity contract differs';
  END IF;
END
$precondition$;

CREATE FUNCTION public.wak_import_legacy_clock_adjustments(
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
  v_clock record;
  v_work_period public.work_periods%ROWTYPE;
  v_current public.work_period_versions%ROWTYPE;
  v_version_number integer;
  v_version_id bigint;
  v_resolved_this integer;
  v_imported integer := 0;
  v_unchanged integer := 0;
  v_skipped_no_work_period integer := 0;
  v_skipped_metadata_only integer := 0;
  v_skipped_invalid integer := 0;
  v_preserved_manual integer := 0;
  v_resolved integer := 0;
BEGIN
  IF p_store_id IS DISTINCT FROM 'MOOROOLBARK' THEN
    RAISE EXCEPTION 'LEGACY_ADJUSTMENT_IMPORT_STORE_NOT_SUPPORTED';
  END IF;
  IF p_week_start IS NULL OR extract(dow FROM p_week_start) <> 4 THEN
    RAISE EXCEPTION 'LEGACY_ADJUSTMENT_IMPORT_WEEK_START_MUST_BE_THURSDAY';
  END IF;

  v_period_start := p_week_start::timestamp AT TIME ZONE 'Australia/Melbourne';
  v_period_end := (p_week_start + 7)::timestamp AT TIME ZONE 'Australia/Melbourne';
  IF v_period_end > clock_timestamp() THEN
    RAISE EXCEPTION 'LEGACY_ADJUSTMENT_IMPORT_PERIOD_NOT_COMPLETE';
  END IF;

  SELECT upper(p.role::text) INTO v_actor_role
  FROM public.profiles p
  WHERE p.id=p_actor AND p.is_active IS TRUE;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'LEGACY_ADJUSTMENT_IMPORT_ACTOR_INACTIVE_OR_MISSING';
  END IF;
  IF v_actor_role NOT IN ('MANAGER','OWNER') THEN
    RAISE EXCEPTION 'LEGACY_ADJUSTMENT_IMPORT_ACTOR_NOT_AUTHORIZED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_store_id || '|' || p_week_start::text, 0));

  FOR v_clock IN
    SELECT tc.id,tc.clock_in_at,tc.clock_out_at,
      tc.adjusted_clock_in_at,tc.adjusted_clock_out_at,tc.adjusted_reason,
      tc.adjusted_by,tc.adjusted_at
    FROM public.time_clock tc
    WHERE tc.clock_in_at >= v_period_start AND tc.clock_in_at < v_period_end
      AND (tc.adjusted_clock_in_at IS NOT NULL
        OR tc.adjusted_clock_out_at IS NOT NULL
        OR tc.adjusted_reason IS NOT NULL
        OR tc.adjusted_by IS NOT NULL
        OR tc.adjusted_at IS NOT NULL)
    ORDER BY tc.id
    FOR SHARE
  LOOP
    IF v_clock.adjusted_clock_in_at IS NULL
       AND v_clock.adjusted_clock_out_at IS NULL THEN
      v_skipped_metadata_only := v_skipped_metadata_only+1;
      CONTINUE;
    END IF;

    IF v_clock.adjusted_clock_in_at IS NULL
       OR v_clock.adjusted_clock_out_at IS NULL
       OR v_clock.adjusted_clock_out_at <= v_clock.adjusted_clock_in_at THEN
      v_skipped_invalid := v_skipped_invalid+1;
      CONTINUE;
    END IF;

    v_work_period.id := NULL;
    SELECT wp.* INTO v_work_period
    FROM public.work_periods wp
    JOIN public.payroll_periods pp ON pp.id=wp.payroll_period_id
    WHERE wp.time_clock_id=v_clock.id AND wp.source_type='CLOCK'
      AND wp.store_id=p_store_id AND pp.store_id=p_store_id
      AND pp.week_start=p_week_start AND pp.week_end=p_week_start+6
    FOR UPDATE;
    IF NOT FOUND THEN
      v_skipped_no_work_period := v_skipped_no_work_period+1;
      CONTINUE;
    END IF;

    IF v_work_period.current_version_id IS NULL THEN
      RAISE EXCEPTION 'LEGACY_ADJUSTMENT_IMPORT_CANONICAL_VERSION_MISSING: work_period %',
        v_work_period.id;
    END IF;
    SELECT * INTO STRICT v_current
    FROM public.work_period_versions v
    WHERE v.id=v_work_period.current_version_id AND v.work_period_id=v_work_period.id;

    IF v_work_period.status='VOIDED'
       OR v_current.disposition='VOIDED'
       OR v_current.change_source IN ('MANAGER','OWNER') THEN
      v_preserved_manual := v_preserved_manual+1;
      CONTINUE;
    END IF;

    IF v_current.change_source='LEGACY_IMPORT'
       AND v_current.disposition='ACTIVE'
       AND v_current.matched_shift_id IS NOT DISTINCT FROM v_work_period.matched_shift_id
       AND v_current.actual_start_at IS NOT DISTINCT FROM v_clock.adjusted_clock_in_at
       AND v_current.actual_end_at IS NOT DISTINCT FROM v_clock.adjusted_clock_out_at
       AND v_current.payable_start_at IS NOT DISTINCT FROM v_clock.adjusted_clock_in_at
       AND v_current.payable_end_at IS NOT DISTINCT FROM v_clock.adjusted_clock_out_at
       AND (
         (
           v_clock.adjusted_at IS NULL
           AND v_current.reason_code='LEGACY_ADJUSTMENT_WITHOUT_TIMESTAMP'
         )
         OR
         (
           v_clock.adjusted_at IS NOT NULL
           AND v_current.reason_code='LEGACY_ADJUSTMENT'
         )
       )
       AND v_current.reason_note IS NOT DISTINCT FROM v_clock.adjusted_reason
       AND v_current.created_by IS NOT DISTINCT FROM v_clock.adjusted_by
       AND (v_clock.adjusted_at IS NULL OR v_current.created_at=v_clock.adjusted_at) THEN
      v_unchanged := v_unchanged+1;
      CONTINUE;
    END IF;

    SELECT coalesce(max(v.version_number),0)+1 INTO v_version_number
    FROM public.work_period_versions v
    WHERE v.work_period_id=v_work_period.id;

    INSERT INTO public.work_period_versions (
      work_period_id,version_number,disposition,matched_shift_id,
      actual_start_at,actual_end_at,payable_start_at,payable_end_at,
      reason_code,reason_note,change_source,created_by,created_at
    ) VALUES (
      v_work_period.id,v_version_number,'ACTIVE',v_work_period.matched_shift_id,
      v_clock.adjusted_clock_in_at,v_clock.adjusted_clock_out_at,
      v_clock.adjusted_clock_in_at,v_clock.adjusted_clock_out_at,
      CASE
        WHEN v_clock.adjusted_at IS NULL THEN 'LEGACY_ADJUSTMENT_WITHOUT_TIMESTAMP'
        ELSE 'LEGACY_ADJUSTMENT'
      END,
      v_clock.adjusted_reason,'LEGACY_IMPORT',v_clock.adjusted_by,
      coalesce(v_clock.adjusted_at,clock_timestamp())
    ) RETURNING id INTO v_version_id;

    UPDATE public.work_periods SET
      current_version_id=v_version_id,status='READY',updated_at=clock_timestamp()
    WHERE id=v_work_period.id;

    UPDATE public.work_period_anomalies a SET
      status='RESOLVED',resolved_by=p_actor,
      resolved_at=clock_timestamp(),
      resolution_reason_code='LEGACY_IMPORT_REVIEWED',resolution_note=NULL,
      resolution_version_id=v_version_id
    WHERE a.work_period_id=v_work_period.id AND a.status='OPEN'
      AND a.details->>'detector'='ATTENDANCE_SHADOW_V1';
    GET DIAGNOSTICS v_resolved_this=ROW_COUNT;
    v_resolved := v_resolved+v_resolved_this;
    v_imported := v_imported+1;
  END LOOP;

  RETURN jsonb_build_object(
    'store_id',p_store_id,
    'week_start',p_week_start,
    'week_end',p_week_start+6,
    'imported_versions',v_imported,
    'unchanged_legacy',v_unchanged,
    'skipped_no_work_period',v_skipped_no_work_period,
    'skipped_metadata_only',v_skipped_metadata_only,
    'skipped_invalid_adjustment',v_skipped_invalid,
    'preserved_manual',v_preserved_manual,
    'resolved_anomalies',v_resolved,
    'importer','LEGACY_ADJUSTMENT_IMPORT_V1'
  );
END
$function$;

ALTER FUNCTION public.wak_import_legacy_clock_adjustments(text,date,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wak_import_legacy_clock_adjustments(text,date,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.wak_import_legacy_clock_adjustments(text,date,uuid)
  TO service_role;

DO $postcondition$
DECLARE v_function oid := to_regprocedure('public.wak_import_legacy_clock_adjustments(text,date,uuid)');
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_12_POSTCONDITION: importer missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.oid=v_function AND p.prosecdef AND r.rolname='postgres'
      AND pg_catalog.pg_get_function_result(p.oid)='jsonb'
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  ) THEN
    RAISE EXCEPTION 'MIGRATION_12_POSTCONDITION: function security contract differs';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
       WHERE p.oid=v_function AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     )
     OR has_function_privilege('anon',v_function,'EXECUTE')
     OR has_function_privilege('authenticated',v_function,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
    RAISE EXCEPTION 'MIGRATION_12_POSTCONDITION: function ACL differs';
  END IF;
END
$postcondition$;

COMMIT;
