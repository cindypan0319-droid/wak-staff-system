/* READ ONLY. Run before Migration 009. */
DO $verify$
DECLARE
  v_policy text;
  v_clock_in oid := to_regprocedure('public.wak_clock_in_for_actor(uuid,text)');
  v_clock_out oid := to_regprocedure('public.wak_clock_out_for_actor(uuid,bigint)');
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M9_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'time_clock' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'M9_PRE: time_clock RLS is not enabled';
  END IF;

  FOREACH v_policy IN ARRAY ARRAY[
    'STAFF insert time_clock (own)',
    'STAFF update time_clock (own)',
    'time_clock_self_anyrole_insert',
    'time_clock_self_anyrole_update',
    'STAFF select time_clock (own)',
    'time_clock_self_anyrole_select',
    'Owner/Manager can insert - time_clock',
    'Owner/Manager can update - time_clock',
    'Owner/Manager can delete - time_clock',
    'time_clock_manager_owner_all'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies AS p
      WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
        AND p.policyname = v_policy AND p.permissive = 'PERMISSIVE'
    ) THEN
      RAISE EXCEPTION 'M9_PRE: expected policy % is missing', v_policy;
    END IF;
  END LOOP;

  IF (
    SELECT count(*)
    FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'time_clock'
      AND p.policyname IN (
        'STAFF insert time_clock (own)',
        'STAFF update time_clock (own)',
        'time_clock_self_anyrole_insert',
        'time_clock_self_anyrole_update'
      )
      AND p.roles = ARRAY['authenticated']::name[]
  ) <> 4 THEN
    RAISE EXCEPTION 'M9_PRE: target policy role baseline differs from authenticated';
  END IF;

  IF v_clock_in IS NULL OR v_clock_out IS NULL
     OR pg_catalog.has_function_privilege('authenticated', v_clock_in, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_clock_out, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_clock_in, 'EXECUTE') IS NOT TRUE
     OR pg_catalog.has_function_privilege('service_role', v_clock_out, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'M9_PRE: Phase A RPC/ACL contract is not present';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes AS i
    WHERE i.schemaname = 'public' AND i.tablename = 'time_clock'
      AND i.indexname = 'time_clock_one_open'
      AND i.indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND i.indexdef ILIKE '%clock_out_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'M9_PRE: time_clock_one_open changed or is missing';
  END IF;

  IF pg_catalog.has_table_privilege('authenticated', 'public.time_clock', 'SELECT') IS NOT TRUE
     OR pg_catalog.has_table_privilege('authenticated', 'public.time_clock', 'INSERT') IS NOT TRUE
     OR pg_catalog.has_table_privilege('authenticated', 'public.time_clock', 'UPDATE') IS NOT TRUE
     OR pg_catalog.has_table_privilege('authenticated', 'public.time_clock', 'DELETE') IS NOT TRUE THEN
    RAISE EXCEPTION 'M9_PRE: authenticated table privilege baseline changed';
  END IF;
END
$verify$;

SELECT 'policy' AS fingerprint_type, count(*) AS item_count,
       md5(string_agg(
         format('%s|%s|%s|%s|%s|%s', policyname, permissive, roles::text,
                cmd, COALESCE(qual, ''), COALESCE(with_check, '')),
         E'\n' ORDER BY policyname
       )) AS fingerprint
FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND tablename = 'time_clock'
UNION ALL
SELECT 'direct_acl', count(*), md5(string_agg(
         format('%s|%s|%s', acl.grantee, acl.privilege_type, acl.is_grantable),
         E'\n' ORDER BY acl.grantee, acl.privilege_type, acl.is_grantable
       ))
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) AS acl
WHERE n.nspname = 'public' AND c.relname = 'time_clock';
