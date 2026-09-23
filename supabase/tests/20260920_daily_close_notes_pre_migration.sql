/* Migration 3 pre-migration verification. READ ONLY. */

-- The notes wrapper must not exist before Migration 3.
SELECT to_regprocedure(
  'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
) IS NULL AS notes_wrapper_absent;

-- Capture the exact current definitions of the functions Migration 3 affects.
SELECT
  p.oid::regprocedure::text AS function_signature,
  pg_get_userbyid(p.proowner) AS owner_name,
  p.prosecdef AS security_definer,
  p.proconfig AS function_config,
  md5(pg_get_functiondef(p.oid)) AS definition_hash,
  pg_get_functiondef(p.oid) AS function_definition
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n
  ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.oid IN (
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure,
    'public.submit_daily_close(jsonb)'::regprocedure,
    'public.correct_daily_close(jsonb)'::regprocedure
  )
ORDER BY function_signature;

-- Capture current execution grants for the two public RPCs.
SELECT
  p.oid::regprocedure::text AS function_signature,
  grantee.rolname AS grantee,
  has_function_privilege(grantee.oid, p.oid, 'EXECUTE') AS can_execute
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n
  ON n.oid = p.pronamespace
CROSS JOIN pg_catalog.pg_roles AS grantee
WHERE n.nspname = 'public'
  AND p.oid IN (
    'public.submit_daily_close(jsonb)'::regprocedure,
    'public.correct_daily_close(jsonb)'::regprocedure
  )
  AND grantee.rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY function_signature, grantee;

-- Capture the exact ACL entries, including the PUBLIC pseudo-role.
SELECT
  p.oid::regprocedure::text AS function_signature,
  CASE acl.grantee
    WHEN 0 THEN 'PUBLIC'
    ELSE pg_get_userbyid(acl.grantee)
  END AS grantee,
  acl.privilege_type,
  acl.is_grantable
FROM pg_catalog.pg_proc AS p
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
) AS acl
WHERE p.oid IN (
  'public.submit_daily_close(jsonb)'::regprocedure,
  'public.correct_daily_close(jsonb)'::regprocedure
)
ORDER BY function_signature, grantee, acl.privilege_type;

-- Capture the daily_sales notes column contract and unrelated relation state.
SELECT
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_schema,
  c.udt_name,
  c.is_nullable,
  c.column_default
FROM information_schema.columns AS c
WHERE c.table_schema = 'public'
  AND c.table_name = 'daily_sales'
  AND c.column_name = 'notes';

SELECT
  count(*) AS public_policy_count,
  md5(string_agg(
    format('%s.%s|%s|%s|%s|%s|%s|%s', schemaname, tablename,
      policyname, permissive, roles::text, cmd, COALESCE(qual, ''),
      COALESCE(with_check, '')),
    E'\n' ORDER BY schemaname, tablename, policyname
  )) AS public_policy_fingerprint
FROM pg_catalog.pg_policies
WHERE schemaname = 'public';
