/* READ ONLY. Run after Migration 6B. */
DO $verify$
DECLARE
  v_core oid := to_regprocedure(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'
  );
  v_correct oid := to_regprocedure('public.correct_daily_close(jsonb)');
  v_notes oid := to_regprocedure(
    'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
  );
  v_core_definition text;
  v_correct_definition text;
  v_table text;
  v_privilege text;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M7_POST: run as postgres in Supabase SQL Editor';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_core) INTO v_core_definition;
  SELECT pg_catalog.pg_get_functiondef(v_correct) INTO v_correct_definition;

  IF v_core_definition !~
       'Only an active STAFF, MANAGER, or OWNER may correct a Daily Close'
     OR v_correct_definition !~ 'Australia/Melbourne'
     OR v_correct_definition !~ 'STAFF_DAILY_CLOSE_NOT_ORIGINAL_SUBMITTER'
     OR v_correct_definition !~ 'STAFF_DAILY_CLOSE_PLATFORM_REMOVE_FORBIDDEN'
     OR v_correct_definition !~ 'v_original_night_entered_by'
     OR v_correct_definition !~ 'v_preserved_daily_sales_entered_by'
     OR v_correct_definition !~ 'v_final_revision' THEN
    RAISE EXCEPTION 'M7_POST: STAFF correction contract is incomplete';
  END IF;

  IF pg_catalog.has_function_privilege('authenticated', v_core, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_core, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_notes, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_notes, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid IN (v_core, v_notes)
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'M7_POST: internal helper EXECUTE boundary changed';
  END IF;

  IF md5(pg_catalog.pg_get_functiondef(
       'public.submit_daily_close(jsonb)'::regprocedure
     )) <> '8325399ad23dd85db125e4627a2b839d'
     OR md5(pg_catalog.pg_get_functiondef(
       'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'::regprocedure
     )) <> '4aa1be4ba7902b8d7a62ad7b956b99d0' THEN
    RAISE EXCEPTION 'M7_POST: submit or notes behavior changed';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'cashup_sessions', 'daily_sales', 'platform_income'
  ] LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'
    ] LOOP
      IF pg_catalog.has_table_privilege(
        'authenticated', 'public.' || v_table, v_privilege
      ) IS NOT FALSE OR pg_catalog.has_table_privilege(
        'anon', 'public.' || v_table, v_privilege
      ) IS NOT FALSE THEN
        RAISE EXCEPTION 'M7_POST: direct client %.% was restored', v_table, v_privilege;
      END IF;
    END LOOP;
  END LOOP;

  IF (SELECT count(*)
      FROM pg_catalog.pg_proc AS p
      WHERE p.oid IN (v_core, v_correct)
        AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
        AND p.prosecdef
        AND 'search_path=pg_catalog, public' = ANY (p.proconfig)) <> 2
    OR pg_catalog.has_function_privilege(
    'authenticated', v_correct, 'EXECUTE'
  ) IS NOT TRUE
    OR pg_catalog.has_function_privilege('anon', v_correct, 'EXECUTE') IS NOT FALSE THEN
    RAISE EXCEPTION 'M7_POST: SECURITY DEFINER/search_path/ACL changed';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname = 'public') <> 59 THEN
    RAISE EXCEPTION 'M7_POST: public policy count changed';
  END IF;
END
$verify$;

SELECT
  md5(pg_catalog.pg_get_functiondef(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
  )) AS new_core_hash,
  md5(pg_catalog.pg_get_functiondef(
    'public.correct_daily_close(jsonb)'::regprocedure
  )) AS new_correction_hash,
  md5(pg_catalog.pg_get_functiondef(
    'public.submit_daily_close(jsonb)'::regprocedure
  )) AS unchanged_submit_hash;
