/* READ ONLY. Run before Migration 6B. */
DO $verify$
DECLARE
  v_core oid := to_regprocedure(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'
  );
  v_correct oid := to_regprocedure('public.correct_daily_close(jsonb)');
  v_notes oid := to_regprocedure(
    'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
  );
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M7_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  IF v_core IS NULL OR v_correct IS NULL THEN
    RAISE EXCEPTION 'M7_PRE: required Daily Close functions are missing';
  END IF;

  IF v_notes IS NULL
     OR pg_catalog.has_function_privilege('authenticated', v_core, 'EXECUTE')
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
    RAISE EXCEPTION 'M7_PRE: internal helper EXECUTE boundary is unsafe';
  END IF;

  IF md5(pg_catalog.pg_get_functiondef(v_core)) <>
       '434a558aed342b3227c63934884b26e1'
     OR md5(pg_catalog.pg_get_functiondef(v_correct)) <>
       '2cd0d734acf9163932ce22a9ebed503d'
     OR md5(pg_catalog.pg_get_functiondef(
       'public.submit_daily_close(jsonb)'::regprocedure
     )) <> '8325399ad23dd85db125e4627a2b839d'
     OR md5(pg_catalog.pg_get_functiondef(
       'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'::regprocedure
     )) <> '4aa1be4ba7902b8d7a62ad7b956b99d0' THEN
    RAISE EXCEPTION 'M7_PRE: applied Daily Close function baseline changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = v_correct
      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
      AND p.prosecdef
      AND 'search_path=pg_catalog, public' = ANY (p.proconfig)
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_correct, 'EXECUTE'
  ) IS NOT TRUE
    OR pg_catalog.has_function_privilege('anon', v_correct, 'EXECUTE') IS NOT FALSE THEN
    RAISE EXCEPTION 'M7_PRE: correct_daily_close security/ACL baseline changed';
  END IF;
END
$verify$;

SELECT
  md5(pg_catalog.pg_get_functiondef(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
  )) AS core_hash,
  md5(pg_catalog.pg_get_functiondef(
    'public.correct_daily_close(jsonb)'::regprocedure
  )) AS correction_hash,
  md5(pg_catalog.pg_get_functiondef(
    'public.submit_daily_close(jsonb)'::regprocedure
  )) AS submit_hash;
