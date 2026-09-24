/* READ ONLY. Run after Migration 008. */
DO $verify$
DECLARE
  v_clock_in oid := to_regprocedure('public.wak_clock_in_for_actor(uuid,text)');
  v_clock_out oid := to_regprocedure('public.wak_clock_out_for_actor(uuid,bigint)');
  v_policy text;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M8_POST: run as postgres in Supabase SQL Editor';
  END IF;

  IF v_clock_in IS NULL OR v_clock_out IS NULL THEN
    RAISE EXCEPTION 'M8_POST: expected function is missing';
  END IF;

  IF (SELECT count(*)
      FROM pg_catalog.pg_proc AS p
      WHERE p.oid IN (v_clock_in, v_clock_out)
        AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
        AND p.prosecdef
        AND 'search_path=pg_catalog, public' = ANY (p.proconfig)) <> 2 THEN
    RAISE EXCEPTION 'M8_POST: SECURITY DEFINER owner/search_path is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege('service_role', v_clock_in, 'EXECUTE') IS NOT TRUE
     OR pg_catalog.has_function_privilege('service_role', v_clock_out, 'EXECUTE') IS NOT TRUE
     OR pg_catalog.has_function_privilege('authenticated', v_clock_in, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_clock_out, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_clock_in, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_clock_out, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid IN (v_clock_in, v_clock_out)
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'M8_POST: EXECUTE ACL is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes AS i
    WHERE i.schemaname = 'public'
      AND i.tablename = 'time_clock'
      AND i.indexname = 'time_clock_one_open'
      AND i.indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND i.indexdef ILIKE '%(staff_id)%'
      AND i.indexdef ILIKE '%clock_out_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'M8_POST: time_clock_one_open changed or is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'time_clock'
      AND con.contype = 'p'
      AND pg_catalog.pg_get_constraintdef(con.oid) = 'PRIMARY KEY (id)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'time_clock'
      AND con.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE
        '%clock_out_at IS NULL%clock_in_at IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'M8_POST: expected time_clock PK/CHECK contract changed';
  END IF;

  FOREACH v_policy IN ARRAY ARRAY[
    'STAFF insert time_clock (own)',
    'STAFF update time_clock (own)',
    'time_clock_self_anyrole_insert',
    'time_clock_self_anyrole_update'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies AS p
      WHERE p.schemaname = 'public'
        AND p.tablename = 'time_clock'
        AND p.policyname = v_policy
    ) THEN
      RAISE EXCEPTION 'M8_POST: required Phase A policy % is missing', v_policy;
    END IF;
  END LOOP;
END
$verify$;

/* These rows must exactly match the pre-migration output. */
SELECT 'time_clock_policy' AS fingerprint_type,
       count(*) AS item_count,
       md5(string_agg(
         format('%s|%s|%s|%s|%s|%s', policyname, permissive, roles::text,
                cmd, COALESCE(qual, ''), COALESCE(with_check, '')),
         E'\n' ORDER BY policyname
       )) AS fingerprint
FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND tablename = 'time_clock'
UNION ALL
SELECT 'time_clock_direct_acl', count(*), md5(string_agg(
         format('%s|%s|%s', acl.grantee, acl.privilege_type, acl.is_grantable),
         E'\n' ORDER BY acl.grantee, acl.privilege_type, acl.is_grantable
       ))
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) AS acl
WHERE n.nspname = 'public' AND c.relname = 'time_clock';

SELECT
  pg_catalog.pg_get_functiondef(
    'public.wak_clock_in_for_actor(uuid,text)'::regprocedure
  ) AS clock_in_definition,
  pg_catalog.pg_get_functiondef(
    'public.wak_clock_out_for_actor(uuid,bigint)'::regprocedure
  ) AS clock_out_definition;
