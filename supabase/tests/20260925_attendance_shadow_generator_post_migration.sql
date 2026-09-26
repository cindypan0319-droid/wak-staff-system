/* Read-only verification for Migration 011. */
DO $post$
DECLARE
  v_function oid := to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)');
  v_table text;
BEGIN
  IF session_user<>'postgres' THEN RAISE EXCEPTION 'M11_POST: run as postgres'; END IF;
  IF v_function IS NULL THEN RAISE EXCEPTION 'M11_POST: generator missing'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.oid=v_function AND p.prosecdef AND r.rolname='postgres'
      AND pg_catalog.pg_get_function_result(p.oid)='jsonb'
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  ) THEN
    RAISE EXCEPTION 'M11_POST: signature/owner/security/search_path differs';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
       WHERE p.oid=v_function AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     )
     OR has_function_privilege('anon',v_function,'EXECUTE')
     OR has_function_privilege('authenticated',v_function,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
    RAISE EXCEPTION 'M11_POST: function ACL differs';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN
      ('payroll_periods','work_periods','work_period_versions','work_period_anomalies'))<>4 THEN
    RAISE EXCEPTION 'M11_POST: canonical table count differs';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['payroll_periods','work_periods','work_period_versions','work_period_anomalies'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=v_table AND c.relrowsecurity AND NOT c.relforcerowsecurity)
       OR NOT has_table_privilege('authenticated','public.'||v_table,'SELECT')
       OR has_table_privilege('authenticated','public.'||v_table,'INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_table_privilege('anon','public.'||v_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
      RAISE EXCEPTION 'M11_POST: canonical ACL/RLS differs for %',v_table;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_policies p
      WHERE p.schemaname='public'
        AND p.tablename IN ('payroll_periods','work_periods','work_period_versions','work_period_anomalies')
        AND p.cmd='SELECT' AND p.roles=ARRAY['authenticated']::name[]
        AND p.qual ILIKE '%is_active IS TRUE%' AND p.qual ILIKE '%MANAGER%' AND p.qual ILIKE '%OWNER%')<>4 THEN
    RAISE EXCEPTION 'M11_POST: canonical Manager/Owner SELECT policies differ';
  END IF;
END
$post$;

/* These read-only fingerprints must match the captured pre-migration output. */
WITH legacy_items AS (
  SELECT format('REL|%s|%s|%s',c.relname,c.relkind,coalesce(c.relacl::text,'NULL')) item
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
  UNION ALL
  SELECT format('CON|%s|%s|%s',c.relname,k.conname,pg_get_constraintdef(k.oid,true))
  FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
  UNION ALL
  SELECT format('POL|%s|%s|%s|%s|%s|%s',tablename,policyname,roles::text,cmd,
    coalesce(qual,''),coalesce(with_check,'')) FROM pg_catalog.pg_policies
  WHERE schemaname='public' AND tablename IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
)
SELECT count(*) AS legacy_item_count,md5(string_agg(item,E'\n' ORDER BY item)) AS legacy_fingerprint
FROM legacy_items;

SELECT count(*) AS public_table_count
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r';

SELECT 'M11_POST_OK' AS result;
