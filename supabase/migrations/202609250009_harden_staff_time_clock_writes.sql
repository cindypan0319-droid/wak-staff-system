BEGIN;

/*
 * Migration 009 / P1A Phase B: remove legacy direct STAFF time_clock writes.
 *
 * authenticated table privileges intentionally remain unchanged because
 * MANAGER and OWNER continue to use direct table DML under RLS.
 */
DO $precondition$
DECLARE
  v_policy record;
  v_preserved_policy_fingerprint text;
  v_table_acl_fingerprint text;
  v_function_acl_fingerprint text;
  v_clock_in oid := to_regprocedure('public.wak_clock_in_for_actor(uuid,text)');
  v_clock_out oid := to_regprocedure('public.wak_clock_out_for_actor(uuid,bigint)');
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'MIGRATION_9_PRECONDITION: run as postgres';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'time_clock'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'MIGRATION_9_PRECONDITION: time_clock RLS is not enabled';
  END IF;

  FOR v_policy IN
    SELECT *
    FROM (VALUES
      ('STAFF insert time_clock (own)', 'INSERT', NULL::text,
       $$((app_role() = 'STAFF'::text) AND (staff_id = auth.uid()))$$),
      ('STAFF update time_clock (own)', 'UPDATE',
       $$((app_role() = 'STAFF'::text) AND (staff_id = auth.uid()))$$,
       $$((app_role() = 'STAFF'::text) AND (staff_id = auth.uid()))$$),
      ('time_clock_self_anyrole_insert', 'INSERT', NULL::text,
       $$(staff_id = auth.uid())$$),
      ('time_clock_self_anyrole_update', 'UPDATE',
       $$(staff_id = auth.uid())$$, $$(staff_id = auth.uid())$$)
    ) AS expected(policyname, cmd, qual, with_check)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policies AS p
      WHERE p.schemaname = 'public'
        AND p.tablename = 'time_clock'
        AND p.policyname = v_policy.policyname
        AND p.permissive = 'PERMISSIVE'
        AND p.roles = ARRAY['authenticated']::name[]
        AND p.cmd = v_policy.cmd
        AND p.qual IS NOT DISTINCT FROM v_policy.qual
        AND p.with_check IS NOT DISTINCT FROM v_policy.with_check
    ) THEN
      RAISE EXCEPTION
        'MIGRATION_9_PRECONDITION: target policy % differs from the verified baseline',
        v_policy.policyname;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
      AND p.policyname = 'STAFF select time_clock (own)' AND p.cmd = 'SELECT'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
      AND p.policyname = 'time_clock_self_anyrole_select' AND p.cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_9_PRECONDITION: required self SELECT policy is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
      AND p.policyname IN ('Owner/Manager can insert - time_clock', 'time_clock_manager_owner_all')
      AND p.cmd IN ('INSERT', 'ALL')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
      AND p.policyname IN ('Owner/Manager can update - time_clock', 'time_clock_manager_owner_all')
      AND p.cmd IN ('UPDATE', 'ALL')
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
      AND p.policyname IN ('Owner/Manager can delete - time_clock', 'time_clock_manager_owner_all')
      AND p.cmd IN ('DELETE', 'ALL')
  ) THEN
    RAISE EXCEPTION 'MIGRATION_9_PRECONDITION: Manager/Owner write path is incomplete';
  END IF;

  IF v_clock_in IS NULL OR v_clock_out IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_9_PRECONDITION: Phase A function is missing';
  END IF;

  IF pg_catalog.has_function_privilege('authenticated', v_clock_in, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_clock_out, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_clock_in, 'EXECUTE') IS NOT TRUE
     OR pg_catalog.has_function_privilege('service_role', v_clock_out, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'MIGRATION_9_PRECONDITION: Phase A function ACL differs from baseline';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes AS i
    WHERE i.schemaname = 'public' AND i.tablename = 'time_clock'
      AND i.indexname = 'time_clock_one_open'
      AND i.indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND i.indexdef ILIKE '%(staff_id)%'
      AND i.indexdef ILIKE '%clock_out_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_9_PRECONDITION: time_clock_one_open changed or is missing';
  END IF;

  SELECT COALESCE(md5(string_agg(
    format('%s|%s|%s|%s|%s|%s', p.policyname, p.permissive, p.roles::text,
           p.cmd, COALESCE(p.qual, ''), COALESCE(p.with_check, '')),
    E'\n' ORDER BY p.policyname
  )), 'NULL')
  INTO v_preserved_policy_fingerprint
  FROM pg_catalog.pg_policies AS p
  WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
    AND p.policyname NOT IN (
      'STAFF insert time_clock (own)',
      'STAFF update time_clock (own)',
      'time_clock_self_anyrole_insert',
      'time_clock_self_anyrole_update'
    );

  SELECT md5(COALESCE(c.relacl::text, 'NULL'))
  INTO v_table_acl_fingerprint
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'time_clock';

  SELECT md5(string_agg(
    format('%s|%s', p.oid::regprocedure::text, COALESCE(p.proacl::text, 'NULL')),
    E'\n' ORDER BY p.oid::regprocedure::text
  ))
  INTO v_function_acl_fingerprint
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid IN (v_clock_in, v_clock_out);

  PERFORM pg_catalog.set_config(
    'wak_m9.preserved_policy_fingerprint', v_preserved_policy_fingerprint, true
  );
  PERFORM pg_catalog.set_config(
    'wak_m9.table_acl_fingerprint', v_table_acl_fingerprint, true
  );
  PERFORM pg_catalog.set_config(
    'wak_m9.function_acl_fingerprint', v_function_acl_fingerprint, true
  );
END
$precondition$;

DROP POLICY "STAFF insert time_clock (own)" ON public.time_clock;
DROP POLICY "STAFF update time_clock (own)" ON public.time_clock;
DROP POLICY "time_clock_self_anyrole_insert" ON public.time_clock;
DROP POLICY "time_clock_self_anyrole_update" ON public.time_clock;

DO $postcondition$
DECLARE
  v_policy text;
  v_preserved_policy_fingerprint text;
  v_table_acl_fingerprint text;
  v_function_acl_fingerprint text;
  v_clock_in oid := to_regprocedure('public.wak_clock_in_for_actor(uuid,text)');
  v_clock_out oid := to_regprocedure('public.wak_clock_out_for_actor(uuid,bigint)');
BEGIN
  FOREACH v_policy IN ARRAY ARRAY[
    'STAFF insert time_clock (own)',
    'STAFF update time_clock (own)',
    'time_clock_self_anyrole_insert',
    'time_clock_self_anyrole_update'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies AS p
      WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
        AND p.policyname = v_policy
    ) THEN
      RAISE EXCEPTION 'MIGRATION_9_POSTCONDITION: target policy % still exists', v_policy;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'time_clock' AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
      AND p.policyname = 'STAFF select time_clock (own)' AND p.cmd = 'SELECT'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies AS p
    WHERE p.schemaname = 'public' AND p.tablename = 'time_clock'
      AND p.policyname = 'time_clock_self_anyrole_select' AND p.cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_9_POSTCONDITION: RLS or self SELECT path changed';
  END IF;

  SELECT COALESCE(md5(string_agg(
    format('%s|%s|%s|%s|%s|%s', p.policyname, p.permissive, p.roles::text,
           p.cmd, COALESCE(p.qual, ''), COALESCE(p.with_check, '')),
    E'\n' ORDER BY p.policyname
  )), 'NULL')
  INTO v_preserved_policy_fingerprint
  FROM pg_catalog.pg_policies AS p
  WHERE p.schemaname = 'public' AND p.tablename = 'time_clock';

  IF v_preserved_policy_fingerprint IS DISTINCT FROM
       pg_catalog.current_setting('wak_m9.preserved_policy_fingerprint') THEN
    RAISE EXCEPTION 'MIGRATION_9_POSTCONDITION: a preserved time_clock policy changed';
  END IF;

  SELECT md5(COALESCE(c.relacl::text, 'NULL'))
  INTO v_table_acl_fingerprint
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'time_clock';

  IF v_table_acl_fingerprint IS DISTINCT FROM
       pg_catalog.current_setting('wak_m9.table_acl_fingerprint') THEN
    RAISE EXCEPTION 'MIGRATION_9_POSTCONDITION: time_clock table ACL changed';
  END IF;

  SELECT md5(string_agg(
    format('%s|%s', p.oid::regprocedure::text, COALESCE(p.proacl::text, 'NULL')),
    E'\n' ORDER BY p.oid::regprocedure::text
  ))
  INTO v_function_acl_fingerprint
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid IN (v_clock_in, v_clock_out);

  IF v_function_acl_fingerprint IS DISTINCT FROM
       pg_catalog.current_setting('wak_m9.function_acl_fingerprint') THEN
    RAISE EXCEPTION 'MIGRATION_9_POSTCONDITION: Phase A function ACL changed';
  END IF;

  IF pg_catalog.has_function_privilege('authenticated', v_clock_in, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_clock_out, 'EXECUTE')
     OR pg_catalog.has_function_privilege('service_role', v_clock_in, 'EXECUTE') IS NOT TRUE
     OR pg_catalog.has_function_privilege('service_role', v_clock_out, 'EXECUTE') IS NOT TRUE THEN
    RAISE EXCEPTION 'MIGRATION_9_POSTCONDITION: Phase A function ACL changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes AS i
    WHERE i.schemaname = 'public' AND i.tablename = 'time_clock'
      AND i.indexname = 'time_clock_one_open'
      AND i.indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND i.indexdef ILIKE '%(staff_id)%'
      AND i.indexdef ILIKE '%clock_out_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_9_POSTCONDITION: time_clock_one_open changed or is missing';
  END IF;
END
$postcondition$;

COMMIT;
