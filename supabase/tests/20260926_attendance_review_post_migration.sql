/* Read-only post-migration verification for Migration 014. */
WITH target AS (
  SELECT to_regprocedure(
    'public.wak_review_work_period(bigint,bigint,uuid,bigint,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)'
  ) AS function_oid
), contract AS (
  SELECT
    function_oid IS NOT NULL AS review_rpc_present,
    coalesce((SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid=function_oid),false)
      AS security_definer,
    coalesce((SELECT r.rolname='postgres' FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.oid=p.proowner WHERE p.oid=function_oid),false)
      AS owner_postgres,
    coalesce((SELECT p.proconfig @> ARRAY['search_path=pg_catalog, public']
      FROM pg_catalog.pg_proc p WHERE p.oid=function_oid),false)
      AS hardened_search_path,
    CASE WHEN function_oid IS NULL THEN false
      ELSE NOT has_function_privilege('anon',function_oid,'EXECUTE') END AS anon_blocked,
    CASE WHEN function_oid IS NULL THEN false
      ELSE NOT has_function_privilege('authenticated',function_oid,'EXECUTE') END AS authenticated_blocked,
    CASE WHEN function_oid IS NULL THEN false
      ELSE has_function_privilege('service_role',function_oid,'EXECUTE') END AS service_role_allowed,
    CASE WHEN function_oid IS NULL THEN false ELSE NOT EXISTS(
      SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid=function_oid AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
    ) END AS public_blocked,
    function_oid
  FROM target
)
SELECT jsonb_build_object(
  'result',CASE WHEN review_rpc_present AND security_definer AND owner_postgres
    AND hardened_search_path AND public_blocked AND anon_blocked
    AND authenticated_blocked AND service_role_allowed
    THEN 'M14_POST_OK' ELSE 'M14_POST_FAILED' END,
  'review_rpc_present',review_rpc_present,
  'security_definer',security_definer,
  'owner_postgres',owner_postgres,
  'hardened_search_path',hardened_search_path,
  'public_blocked',public_blocked,
  'anon_blocked',anon_blocked,
  'authenticated_blocked',authenticated_blocked,
  'service_role_allowed',service_role_allowed,
  'function_md5',CASE WHEN function_oid IS NULL THEN NULL
    ELSE md5(pg_catalog.pg_get_functiondef(function_oid)) END,
  'canonical_table_count',(
    SELECT count(*) FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname IN ('payroll_periods','work_periods','work_period_versions','work_period_anomalies')
  )
) AS verification
FROM contract;
