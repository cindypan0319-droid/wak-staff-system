BEGIN;

DO $precondition$
DECLARE
  v_function oid:=to_regprocedure('public.wak_review_work_period(bigint,bigint,uuid,bigint,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)');
BEGIN
  IF session_user<>'postgres' THEN
    RAISE EXCEPTION 'MIGRATION_14_PRECONDITION: run as postgres';
  END IF;
  IF v_function IS NOT NULL THEN
    RAISE EXCEPTION 'MIGRATION_14_PRECONDITION: review RPC already exists';
  END IF;
  IF to_regclass('public.work_periods') IS NULL
     OR to_regclass('public.work_period_versions') IS NULL
     OR to_regclass('public.work_period_anomalies') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_14_PRECONDITION: canonical attendance tables are missing';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.work_periods'::regclass
      AND conname='work_periods_current_version_same_period_fk'
  ) OR NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname='public' AND indexname='work_periods_time_clock_unique'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_14_PRECONDITION: canonical integrity contract differs';
  END IF;
END
$precondition$;

CREATE FUNCTION public.wak_review_work_period(
  p_work_period_id bigint,
  p_expected_version_id bigint,
  p_actor uuid,
  p_matched_shift_id bigint,
  p_actual_start_at timestamptz,
  p_actual_end_at timestamptz,
  p_payable_start_at timestamptz,
  p_payable_end_at timestamptz,
  p_reason_code text,
  p_reason_note text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_actor_role text;
  v_work_period public.work_periods%ROWTYPE;
  v_current public.work_period_versions%ROWTYPE;
  v_shift record;
  v_next_version integer;
  v_new_version_id bigint;
  v_resolved integer:=0;
BEGIN
  SELECT upper(p.role::text) INTO v_actor_role
  FROM public.profiles p
  WHERE p.id=p_actor AND p.is_active IS TRUE;
  IF v_actor_role IS NULL THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_ACTOR_INACTIVE_OR_MISSING';
  END IF;
  IF v_actor_role NOT IN ('MANAGER','OWNER') THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_ACTOR_NOT_AUTHORIZED';
  END IF;

  SELECT * INTO v_work_period
  FROM public.work_periods wp
  WHERE wp.id=p_work_period_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_WORK_PERIOD_NOT_FOUND';
  END IF;
  IF v_work_period.store_id IS DISTINCT FROM 'MOOROOLBARK' THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_STORE_NOT_SUPPORTED';
  END IF;
  IF v_work_period.status='VOIDED' THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_VOIDED';
  END IF;
  IF v_work_period.current_version_id IS DISTINCT FROM p_expected_version_id THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_CONFLICT';
  END IF;

  SELECT * INTO v_current
  FROM public.work_period_versions v
  WHERE v.id=v_work_period.current_version_id
    AND v.work_period_id=v_work_period.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_CURRENT_VERSION_MISSING';
  END IF;
  IF v_current.disposition='VOIDED' THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_VOIDED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'attendance-review|'||v_work_period.staff_id::text,0
  ));

  IF p_actual_start_at IS NULL OR p_actual_end_at IS NULL
     OR p_actual_end_at<=p_actual_start_at THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_INVALID_ACTUAL_RANGE';
  END IF;
  IF p_payable_start_at IS NULL OR p_payable_end_at IS NULL
     OR p_payable_end_at<=p_payable_start_at THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_INVALID_PAYABLE_RANGE';
  END IF;
  IF p_payable_start_at<p_actual_start_at OR p_payable_end_at>p_actual_end_at THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_PAYABLE_OUTSIDE_ACTUAL';
  END IF;
  IF (p_actual_start_at AT TIME ZONE 'Australia/Melbourne')::date<>
     (p_actual_end_at AT TIME ZONE 'Australia/Melbourne')::date THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_CROSSES_MELBOURNE_MIDNIGHT';
  END IF;
  IF p_reason_code IS NULL OR btrim(p_reason_code)='' THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_REASON_REQUIRED';
  END IF;
  IF p_reason_code='OTHER' AND (p_reason_note IS NULL OR btrim(p_reason_note)='') THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_OTHER_NOTE_REQUIRED';
  END IF;

  IF p_matched_shift_id IS NOT NULL THEN
    SELECT s.id,s.store_id,s.staff_id INTO v_shift
    FROM public.shifts s WHERE s.id=p_matched_shift_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ATTENDANCE_REVIEW_SHIFT_NOT_FOUND';
    END IF;
    IF v_shift.store_id IS DISTINCT FROM v_work_period.store_id THEN
      RAISE EXCEPTION 'ATTENDANCE_REVIEW_SHIFT_STORE_MISMATCH';
    END IF;
    IF v_shift.staff_id IS DISTINCT FROM v_work_period.staff_id THEN
      RAISE EXCEPTION 'ATTENDANCE_REVIEW_SHIFT_STAFF_MISMATCH';
    END IF;
  END IF;

  IF v_current.disposition='ACTIVE'
     AND v_current.change_source IN ('MANAGER','OWNER')
     AND v_current.matched_shift_id IS NOT DISTINCT FROM p_matched_shift_id
     AND v_current.actual_start_at IS NOT DISTINCT FROM p_actual_start_at
     AND v_current.actual_end_at IS NOT DISTINCT FROM p_actual_end_at
     AND v_current.payable_start_at IS NOT DISTINCT FROM p_payable_start_at
     AND v_current.payable_end_at IS NOT DISTINCT FROM p_payable_end_at
     AND v_current.reason_code IS NOT DISTINCT FROM p_reason_code
     AND v_current.reason_note IS NOT DISTINCT FROM p_reason_note
     AND NOT EXISTS(
       SELECT 1 FROM public.work_period_anomalies a
       WHERE a.work_period_id=v_work_period.id AND a.status='OPEN'
     ) THEN
    RETURN jsonb_build_object(
      'work_period_id',v_work_period.id,
      'previous_version_id',v_current.id,
      'current_version_id',v_current.id,
      'version_number',v_current.version_number,
      'status',v_work_period.status,
      'change_source',v_current.change_source,
      'resolved_anomalies',0,
      'unchanged',true
    );
  END IF;

  IF EXISTS(
    SELECT 1
    FROM public.work_periods other
    JOIN public.work_period_versions current_other
      ON current_other.id=other.current_version_id
      AND current_other.work_period_id=other.id
    WHERE other.id<>v_work_period.id
      AND other.staff_id=v_work_period.staff_id
      AND other.status<>'VOIDED'
      AND current_other.disposition='ACTIVE'
      AND current_other.payable_start_at IS NOT NULL
      AND current_other.payable_end_at IS NOT NULL
      AND current_other.payable_start_at<p_payable_end_at
      AND p_payable_start_at<current_other.payable_end_at
  ) THEN
    RAISE EXCEPTION 'ATTENDANCE_REVIEW_PAYABLE_OVERLAP';
  END IF;

  SELECT coalesce(max(v.version_number),0)+1 INTO v_next_version
  FROM public.work_period_versions v
  WHERE v.work_period_id=v_work_period.id;

  INSERT INTO public.work_period_versions(
    work_period_id,version_number,disposition,matched_shift_id,
    actual_start_at,actual_end_at,payable_start_at,payable_end_at,
    reason_code,reason_note,change_source,created_by
  ) VALUES(
    v_work_period.id,v_next_version,'ACTIVE',p_matched_shift_id,
    p_actual_start_at,p_actual_end_at,p_payable_start_at,p_payable_end_at,
    p_reason_code,p_reason_note,v_actor_role,p_actor
  ) RETURNING id INTO v_new_version_id;

  UPDATE public.work_periods SET
    matched_shift_id=p_matched_shift_id,
    status='READY',
    current_version_id=v_new_version_id,
    updated_at=clock_timestamp()
  WHERE id=v_work_period.id;

  UPDATE public.work_period_anomalies SET
    status='RESOLVED',
    resolved_by=p_actor,
    resolved_at=clock_timestamp(),
    resolution_reason_code='MANUAL_REVIEW_CONFIRMED',
    resolution_note=NULL,
    resolution_version_id=v_new_version_id
  WHERE work_period_id=v_work_period.id AND status='OPEN';
  GET DIAGNOSTICS v_resolved=ROW_COUNT;

  RETURN jsonb_build_object(
    'work_period_id',v_work_period.id,
    'previous_version_id',v_current.id,
    'current_version_id',v_new_version_id,
    'version_number',v_next_version,
    'status','READY',
    'change_source',v_actor_role,
    'resolved_anomalies',v_resolved,
    'unchanged',false
  );
END
$function$;

ALTER FUNCTION public.wak_review_work_period(
  bigint,bigint,uuid,bigint,timestamptz,timestamptz,timestamptz,timestamptz,text,text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.wak_review_work_period(
  bigint,bigint,uuid,bigint,timestamptz,timestamptz,timestamptz,timestamptz,text,text
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.wak_review_work_period(
  bigint,bigint,uuid,bigint,timestamptz,timestamptz,timestamptz,timestamptz,text,text
) TO service_role;

DO $postcondition$
DECLARE
  v_function oid:=to_regprocedure('public.wak_review_work_period(bigint,bigint,uuid,bigint,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)');
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_14_POSTCONDITION: review RPC missing';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.oid=v_function AND p.prosecdef AND r.rolname='postgres'
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  ) THEN
    RAISE EXCEPTION 'MIGRATION_14_POSTCONDITION: review RPC security differs';
  END IF;
  IF EXISTS(
       SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
       WHERE p.oid=v_function AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) OR has_function_privilege('anon',v_function,'EXECUTE')
     OR has_function_privilege('authenticated',v_function,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
    RAISE EXCEPTION 'MIGRATION_14_POSTCONDITION: review RPC ACL differs';
  END IF;
END
$postcondition$;

COMMIT;
