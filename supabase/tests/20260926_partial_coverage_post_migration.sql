/* Read-only verification for Migration 013. */
DO $post$
DECLARE
  v_function oid:=to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)');
  v_constraint text;
BEGIN
  IF session_user<>'postgres' THEN
    RAISE EXCEPTION 'M13_POST: run as postgres';
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(c.oid,true) INTO v_constraint
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid='public.work_period_anomalies'::regclass
    AND c.conname='work_period_anomalies_type_check';
  IF v_function IS NULL OR v_constraint NOT ILIKE '%COVERED_WITHOUT_COVER_SHIFT%' THEN
    RAISE EXCEPTION 'M13_POST: function or anomaly contract missing';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.oid=v_function AND p.prosecdef AND r.rolname='postgres'
      AND pg_catalog.pg_get_function_result(p.oid)='jsonb'
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  ) THEN
    RAISE EXCEPTION 'M13_POST: signature/owner/security/search_path differs';
  END IF;
  IF EXISTS(
       SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
       WHERE p.oid=v_function AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     ) OR has_function_privilege('anon',v_function,'EXECUTE')
     OR has_function_privilege('authenticated',v_function,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
    RAISE EXCEPTION 'M13_POST: generator ACL differs';
  END IF;
END
$post$;

SELECT jsonb_build_object(
  'result','M13_POST_OK',
  'generator_md5',md5(pg_catalog.pg_get_functiondef(
    'public.wak_refresh_attendance_shadow(text,date,uuid)'::regprocedure
  )),
  'anomaly_constraint',(
    SELECT pg_catalog.pg_get_constraintdef(c.oid,true)
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid='public.work_period_anomalies'::regclass
      AND c.conname='work_period_anomalies_type_check'
  ),
  'public_table_count',(
    SELECT count(*) FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
  )
) AS verification;
