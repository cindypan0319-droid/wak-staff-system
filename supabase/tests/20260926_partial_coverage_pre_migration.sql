/* Read-only preflight for Migration 013. */
DO $pre$
DECLARE
  v_function oid:=to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)');
  v_constraint text;
BEGIN
  IF session_user<>'postgres' THEN
    RAISE EXCEPTION 'M13_PRE: run as postgres';
  END IF;
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'M13_PRE: Migration 011 generator is missing';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.oid=v_function AND p.prosecdef AND r.rolname='postgres'
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  ) THEN
    RAISE EXCEPTION 'M13_PRE: generator security contract differs';
  END IF;
  IF has_function_privilege('anon',v_function,'EXECUTE')
     OR has_function_privilege('authenticated',v_function,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
    RAISE EXCEPTION 'M13_PRE: generator ACL differs';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(c.oid,true) INTO v_constraint
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='public.work_period_anomalies'::regclass
    AND c.conname='work_period_anomalies_type_check';
  IF v_constraint IS NULL
     OR v_constraint NOT ILIKE '%SHIFT_STAFF_MISMATCH%'
     OR v_constraint ILIKE '%COVERED_WITHOUT_COVER_SHIFT%' THEN
    RAISE EXCEPTION 'M13_PRE: anomaly type constraint differs';
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='shifts'
      AND column_name='parent_shift_id' AND data_type='bigint'
  ) OR NOT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='shifts'
      AND column_name='shift_status'
  ) THEN
    RAISE EXCEPTION 'M13_PRE: coverage columns are missing';
  END IF;
END
$pre$;

SELECT jsonb_build_object(
  'result','M13_PRE_OK',
  'generator_md5',md5(pg_catalog.pg_get_functiondef(
    'public.wak_refresh_attendance_shadow(text,date,uuid)'::regprocedure
  )),
  'anomaly_constraint',(
    SELECT pg_catalog.pg_get_constraintdef(c.oid,true)
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.work_period_anomalies'::regclass
      AND c.conname='work_period_anomalies_type_check'
  ),
  'covered_parent_count',(
    SELECT count(*) FROM public.shifts
    WHERE upper(coalesce(shift_status,'SCHEDULED'))='COVERED'
  ),
  'cover_child_count',(
    SELECT count(*) FROM public.shifts WHERE parent_shift_id IS NOT NULL
  )
) AS verification;
