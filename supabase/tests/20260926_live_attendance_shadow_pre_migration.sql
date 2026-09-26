/* Read-only pre-migration verification for Migration 015. */
WITH target AS (
  SELECT to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)') AS function_oid
), contract AS (
  SELECT
    function_oid IS NOT NULL AS generator_present,
    coalesce((SELECT p.prosecdef FROM pg_catalog.pg_proc p WHERE p.oid=function_oid),false)
      AS security_definer,
    coalesce((SELECT r.rolname='postgres' FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_roles r ON r.oid=p.proowner WHERE p.oid=function_oid),false)
      AS owner_postgres,
    coalesce((SELECT p.proconfig @> ARRAY['search_path=pg_catalog, public']
      FROM pg_catalog.pg_proc p WHERE p.oid=function_oid),false) AS hardened_search_path,
    CASE WHEN function_oid IS NULL THEN false ELSE
      pg_catalog.pg_get_functiondef(function_oid) ILIKE '%ATTENDANCE_SHADOW_PERIOD_NOT_COMPLETE%'
      AND pg_catalog.pg_get_functiondef(function_oid) NOT ILIKE '%period_complete%'
    END AS migration_013_contract,
    CASE WHEN function_oid IS NULL THEN false
      ELSE NOT has_function_privilege('anon',function_oid,'EXECUTE') END AS anon_blocked,
    CASE WHEN function_oid IS NULL THEN false
      ELSE NOT has_function_privilege('authenticated',function_oid,'EXECUTE') END AS authenticated_blocked,
    CASE WHEN function_oid IS NULL THEN false
      ELSE has_function_privilege('service_role',function_oid,'EXECUTE') END AS service_role_allowed,
    function_oid
  FROM target
)
SELECT jsonb_build_object(
  'result',CASE WHEN generator_present AND security_definer AND owner_postgres
    AND hardened_search_path AND migration_013_contract AND anon_blocked
    AND authenticated_blocked AND service_role_allowed
    THEN 'M15_PRE_OK' ELSE 'M15_PRE_FAILED' END,
  'generator_present',generator_present,
  'security_definer',security_definer,
  'owner_postgres',owner_postgres,
  'hardened_search_path',hardened_search_path,
  'migration_013_contract',migration_013_contract,
  'anon_blocked',anon_blocked,
  'authenticated_blocked',authenticated_blocked,
  'service_role_allowed',service_role_allowed,
  'function_md5',CASE WHEN function_oid IS NULL THEN NULL
    ELSE md5(pg_catalog.pg_get_functiondef(function_oid)) END
) AS verification
FROM contract;
