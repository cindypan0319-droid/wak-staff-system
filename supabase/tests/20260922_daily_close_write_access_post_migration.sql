/* READ ONLY. Run after Migration 5; failures must be reviewed before app rollout. */
DO $verify$
DECLARE
  v_table text;
  v_role text;
  v_privilege text;
  v_signature text;
  v_oid oid;
  v_expected_auth boolean;
  v_expected_service boolean;
  v_bad_fingerprint integer;
  v_owner_expr text := '("current_role"() = ANY (ARRAY[''OWNER''::user_role, ''MANAGER''::user_role]))';
  v_own_expr text := '((entered_by = auth.uid()) OR (EXISTS ( SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY[''OWNER''::user_role, ''MANAGER''::user_role]))))))';
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M5_POST: run as postgres in Supabase SQL Editor';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['cashup_sessions','daily_sales','platform_income'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_table
        AND c.relrowsecurity AND NOT c.relforcerowsecurity
    ) THEN RAISE EXCEPTION 'M5_POST: unexpected RLS state on %', v_table; END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_policies p
      WHERE p.schemaname='public' AND p.tablename=v_table
        AND p.cmd <> 'SELECT'
    ) THEN RAISE EXCEPTION 'M5_POST: write-capable policy remains on %', v_table; END IF;

    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_table
        AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
    ) THEN RAISE EXCEPTION 'M5_POST: column grant found on %', v_table; END IF;

    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF pg_catalog.has_table_privilege(v_role,'public.' || v_table,'SELECT') IS NOT TRUE THEN
        RAISE EXCEPTION 'M5_POST: %.SELECT removed from %', v_role,v_table;
      END IF;
      FOREACH v_privilege IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE'] LOOP
        IF pg_catalog.has_table_privilege(v_role,'public.' || v_table,v_privilege) IS NOT FALSE THEN
          RAISE EXCEPTION 'M5_POST: %.% still granted on %', v_role,v_privilege,v_table;
        END IF;
      END LOOP;
      FOREACH v_privilege IN ARRAY ARRAY['REFERENCES','TRIGGER','MAINTAIN'] LOOP
        IF pg_catalog.has_table_privilege(v_role,'public.' || v_table,v_privilege) IS NOT TRUE THEN
          RAISE EXCEPTION 'M5_POST: %.% unexpectedly removed on %', v_role,v_privilege,v_table;
        END IF;
      END LOOP;
    END LOOP;

    FOREACH v_role IN ARRAY ARRAY['service_role','postgres'] LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
      ] LOOP
        IF pg_catalog.has_table_privilege(v_role,'public.' || v_table,v_privilege) IS NOT TRUE THEN
          RAISE EXCEPTION 'M5_POST: %.% unexpectedly removed on %', v_role,v_privilege,v_table;
        END IF;
      END LOOP;
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
      WHERE n.nspname='public' AND c.relname=v_table
        AND (acl.is_grantable OR acl.grantee=0)
    ) OR (
      SELECT count(*) FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
      WHERE n.nspname='public' AND c.relname=v_table
    ) <> 24 THEN
      RAISE EXCEPTION 'M5_POST: unexpected ACL entries on %',v_table;
    END IF;
  END LOOP;

  /* Exactly the five previously captured SELECT policies, with their original expressions. */
  IF (SELECT count(*) FROM pg_catalog.pg_policies p
      WHERE p.schemaname='public' AND p.tablename IN
        ('cashup_sessions','daily_sales','platform_income')) <> 5
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies p
       WHERE p.schemaname='public' AND p.tablename IN
         ('cashup_sessions','daily_sales','platform_income')
         AND (p.cmd <> 'SELECT' OR p.roles IS DISTINCT FROM ARRAY['authenticated']::name[]
              OR p.permissive <> 'PERMISSIVE'
              OR p.with_check IS NOT NULL
              OR regexp_replace(p.qual,'[[:space:]]+',' ','g') IS DISTINCT FROM
                 regexp_replace(CASE p.policyname
                   WHEN 'Owner/Manager can read all - daily_sales' THEN v_owner_expr
                   WHEN 'Owner/Manager can read all - platform_income' THEN v_owner_expr
                   WHEN 'cashup_select_own_or_manager' THEN v_own_expr
                   WHEN 'daily_sales_select_own_or_manager' THEN v_own_expr
                   WHEN 'platform_income_select_own_or_manager' THEN v_own_expr
                   ELSE NULL END,'[[:space:]]+',' ','g'))
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='public'
         AND p.tablename='cashup_sessions' AND p.policyname='cashup_select_own_or_manager'
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='public'
         AND p.tablename='daily_sales' AND p.policyname='daily_sales_select_own_or_manager'
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='public'
         AND p.tablename='daily_sales' AND p.policyname='Owner/Manager can read all - daily_sales'
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='public'
         AND p.tablename='platform_income' AND p.policyname='platform_income_select_own_or_manager'
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname='public'
         AND p.tablename='platform_income' AND p.policyname='Owner/Manager can read all - platform_income'
     ) THEN RAISE EXCEPTION 'M5_POST: preserved SELECT policy changed'; END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname='public') <> 59 THEN
    RAISE EXCEPTION 'M5_POST: unexpected public policy count';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.save_morning_cashup(date,text,jsonb)',
    'public.submit_daily_close(jsonb)',
    'public.correct_daily_close(jsonb)',
    'public._wak_apply_daily_close(jsonb,boolean,boolean)',
    'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'M5_POST: missing RPC %', v_signature; END IF;
    v_expected_auth := v_signature IN (
      'public.save_morning_cashup(date,text,jsonb)',
      'public.submit_daily_close(jsonb)', 'public.correct_daily_close(jsonb)');
    v_expected_service := v_signature <> 'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)';
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid=v_oid AND pg_catalog.pg_get_userbyid(p.proowner)='postgres'
        AND p.prosecdef AND 'search_path=pg_catalog, public' = ANY (p.proconfig)
    ) OR pg_catalog.has_function_privilege('authenticated',v_oid,'EXECUTE') IS DISTINCT FROM v_expected_auth
      OR pg_catalog.has_function_privilege('anon',v_oid,'EXECUTE') IS DISTINCT FROM false
      OR pg_catalog.has_function_privilege('service_role',v_oid,'EXECUTE') IS DISTINCT FROM v_expected_service
      OR pg_catalog.has_function_privilege('postgres',v_oid,'EXECUTE') IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'M5_POST: RPC security/ACL changed for %', v_signature;
    END IF;
  END LOOP;

  IF md5(pg_catalog.pg_get_functiondef(to_regprocedure('public._wak_apply_daily_close(jsonb,boolean,boolean)')))
       <> '434a558aed342b3227c63934884b26e1'
     OR md5(pg_catalog.pg_get_functiondef(to_regprocedure('public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)')))
       <> '4aa1be4ba7902b8d7a62ad7b956b99d0'
     OR md5(pg_catalog.pg_get_functiondef(to_regprocedure('public.submit_daily_close(jsonb)')))
       <> '8325399ad23dd85db125e4627a2b839d'
     OR md5(pg_catalog.pg_get_functiondef(to_regprocedure('public.correct_daily_close(jsonb)')))
       <> '2cd0d734acf9163932ce22a9ebed503d'
     OR md5(pg_catalog.pg_get_functiondef(to_regprocedure('public.set_updated_at()')))
       <> '904ef2c845d2c89c9b37b4b1f2cf98a9'
     OR md5(pg_catalog.pg_get_functiondef(to_regprocedure('public.set_platform_income_fees()')))
       <> 'fab082fe6796c91b22e2a7005357e7c4' THEN
    RAISE EXCEPTION 'M5_POST: RPC or trigger function definition changed';
  END IF;
  /* Unrelated public relations must match the verified post-Migration-4 baseline. */
  WITH actual(category, item_count, fingerprint) AS (

    SELECT
      'relations'::text,
      count(*)::bigint,
      md5(string_agg(
        format(
          '%s|%s|%s|%s',
          c.relname,
          c.relkind,
          c.relrowsecurity,
          c.relforcerowsecurity
        ),
        E'\n' ORDER BY c.relname, c.relkind
      ))
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm')

    UNION ALL

    SELECT
      'columns'::text,
      count(*)::bigint,
      md5(string_agg(
        format(
          '%s|%s|%s|%s|%s|%s',
          table_name,
          ordinal_position,
          column_name,
          data_type,
          is_nullable,
          COALESCE(column_default, '')
        ),
        E'\n' ORDER BY table_name, ordinal_position
      ))
    FROM information_schema.columns
    WHERE table_schema = 'public'

    UNION ALL

    SELECT
      'constraints'::text,
      count(*)::bigint,
      md5(string_agg(
        format(
          '%s|%s|%s|%s',
          rel.relname,
          con.conname,
          con.contype,
          pg_catalog.pg_get_constraintdef(con.oid)
        ),
        E'\n' ORDER BY rel.relname, con.conname
      ))
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS rel
      ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'

    UNION ALL

    SELECT
      'indexes'::text,
      count(*)::bigint,
      md5(string_agg(
        format('%s|%s|%s', tablename, indexname, indexdef),
        E'\n' ORDER BY tablename, indexname
      ))
    FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'

    UNION ALL

    SELECT
      'triggers'::text,
      count(*)::bigint,
      md5(string_agg(
        format(
          '%s|%s|%s',
          rel.relname,
          t.tgname,
          pg_catalog.pg_get_triggerdef(t.oid)
        ),
        E'\n' ORDER BY rel.relname, t.tgname
      ))
    FROM pg_catalog.pg_trigger AS t
    JOIN pg_catalog.pg_class AS rel
      ON rel.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal

    UNION ALL

    SELECT
      'views'::text,
      count(*)::bigint,
      md5(string_agg(
        format('%s|%s', view_name, view_definition),
        E'\n' ORDER BY view_name
      ))
    FROM (
      SELECT
        viewname AS view_name,
        definition AS view_definition
      FROM pg_catalog.pg_views
      WHERE schemaname = 'public'

      UNION ALL

      SELECT
        matviewname AS view_name,
        definition AS view_definition
      FROM pg_catalog.pg_matviews
      WHERE schemaname = 'public'
    ) AS views
  ),
  expected(category, item_count, fingerprint) AS (
    VALUES
      ('relations',   22::bigint,  '149e3ed058a3f980103a40ca236ada11'),
      ('columns',     194::bigint, 'bb2bf6a9996d7860d729de0cf4e72e80'),
      ('constraints', 45::bigint,  'e2179e7fc4525db6ed03a4963a245286'),
      ('indexes',     29::bigint,  'edae8c484ec09b93d399a596d053a4a8'),
      ('triggers',    5::bigint,   'fd520644a47fe9f64ca92a973888e4d3'),
      ('views',       5::bigint,   '6fe157e75599b5a220312e21026ddb75')
  )
  SELECT count(*)
  INTO v_bad_fingerprint
  FROM expected AS e
  LEFT JOIN actual AS a
    USING (category)
  WHERE a.item_count IS DISTINCT FROM e.item_count
     OR a.fingerprint IS DISTINCT FROM e.fingerprint;

  IF v_bad_fingerprint <> 0 THEN
    RAISE EXCEPTION 'M5_VERIFY: unrelated public object fingerprint changed';
  END IF;
  RAISE NOTICE 'M5_POST PASS: direct client DML denied; RPCs and reads preserved';
END
$verify$;

/* Output for byte-for-byte manual comparison with the pre-migration capture. */
SELECT p.tablename,p.policyname,p.cmd,p.roles,p.permissive,p.qual,p.with_check
FROM pg_catalog.pg_policies p
WHERE p.schemaname='public' AND p.tablename IN ('cashup_sessions','daily_sales','platform_income')
ORDER BY p.tablename,p.policyname;
SELECT p.oid::regprocedure, md5(pg_catalog.pg_get_functiondef(p.oid)) AS definition_hash,
       p.proacl AS raw_acl
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
  'save_morning_cashup','submit_daily_close','correct_daily_close',
  '_wak_apply_daily_close','_wak_apply_daily_close_with_notes')
ORDER BY 1;
SELECT c.relname AS table_name,
  CASE WHEN acl.grantee=0 THEN 'PUBLIC'
       ELSE pg_catalog.pg_get_userbyid(acl.grantee) END AS grantee,
  acl.privilege_type,acl.is_grantable
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl
WHERE n.nspname='public'
  AND c.relname IN ('cashup_sessions','daily_sales','platform_income')
ORDER BY c.relname,grantee,acl.privilege_type;
SELECT t.tgrelid::regclass AS table_name,t.tgname,
  pg_catalog.pg_get_triggerdef(t.oid) AS trigger_definition,
  t.tgfoid::regprocedure AS trigger_function,
  md5(pg_catalog.pg_get_functiondef(t.tgfoid)) AS function_hash
FROM pg_catalog.pg_trigger t
WHERE t.tgrelid IN ('public.cashup_sessions'::regclass,
                    'public.platform_income'::regclass)
  AND NOT t.tgisinternal
ORDER BY 1,2;
SELECT r.rolname,
  pg_catalog.has_schema_privilege(r.oid,'public','CREATE') AS can_create_in_public,
  pg_catalog.has_function_privilege(
    r.oid,'public.set_updated_at()'::regprocedure,'EXECUTE'
  ) AS can_execute_updated_at_trigger,
  pg_catalog.has_function_privilege(
    r.oid,'public.set_platform_income_fees()'::regprocedure,'EXECUTE'
  ) AS can_execute_fee_trigger
FROM pg_catalog.pg_roles r
WHERE r.rolname IN ('anon','authenticated')
ORDER BY r.rolname;
