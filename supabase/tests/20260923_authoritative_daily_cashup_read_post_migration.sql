/* READ ONLY. Run after Migration 6A. */
DO $verify$
DECLARE
  v_oid oid;
  v_definition text;
  v_table text;
  v_privilege text;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M6A_POST: run as postgres in Supabase SQL Editor';
  END IF;

  v_oid := to_regprocedure('public.get_daily_cashup_snapshot(date,text)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'M6A_POST: read RPC is missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = v_oid
    AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
    AND p.prosecdef
    AND p.provolatile = 's'
    AND p.prorettype = 'jsonb'::regtype
    AND 'search_path=pg_catalog, public' = ANY (p.proconfig);

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'M6A_POST: owner/security/volatility/return/search_path mismatch';
  END IF;

  IF pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') IS NOT TRUE
     OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE') IS NOT FALSE
     OR pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') IS NOT FALSE
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid = v_oid
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'M6A_POST: function EXECUTE ACL mismatch';
  END IF;

  IF v_definition !~ 'v_role NOT IN \(''STAFF'', ''MANAGER'', ''OWNER''\)'
     OR v_definition !~ 'v_is_active IS NOT TRUE'
     OR v_definition !~ 'p_store_id IS DISTINCT FROM ''MOOROOLBARK'''
     OR v_definition ~* '\m(INSERT|UPDATE|DELETE|TRUNCATE)\M[[:space:]]+(INTO|FROM|public\.)' THEN
    RAISE EXCEPTION 'M6A_POST: authorization scope or read-only definition mismatch';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['cashup_sessions', 'daily_sales', 'platform_income'] LOOP
    IF pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') IS NOT TRUE THEN
      RAISE EXCEPTION 'M6A_POST: authenticated SELECT changed on %', v_table;
    END IF;
    FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
      IF pg_catalog.has_table_privilege('authenticated', 'public.' || v_table, v_privilege) IS NOT FALSE
         OR pg_catalog.has_table_privilege('anon', 'public.' || v_table, v_privilege) IS NOT FALSE THEN
        RAISE EXCEPTION 'M6A_POST: base-table write access changed on %', v_table;
      END IF;
    END LOOP;
  END LOOP;

  IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'public') <> 59 THEN
    RAISE EXCEPTION 'M6A_POST: public RLS policy count changed';
  END IF;
END
$verify$;

SELECT
  p.oid::regprocedure::text AS signature,
  pg_catalog.pg_get_userbyid(p.proowner) AS owner,
  p.prosecdef AS security_definer,
  p.provolatile AS volatility,
  p.proconfig AS configuration,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    AS authenticated_can_execute,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    AS anon_can_execute,
  pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
    AS service_role_can_execute
FROM pg_catalog.pg_proc AS p
WHERE p.oid = 'public.get_daily_cashup_snapshot(date,text)'::regprocedure;
