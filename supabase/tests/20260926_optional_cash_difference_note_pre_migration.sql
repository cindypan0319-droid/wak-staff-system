/* Read-only pre-migration verification for Migration 016. */
WITH target AS (
  SELECT to_regprocedure(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'
  ) AS function_oid
), contract AS (
  SELECT
    function_oid IS NOT NULL AS core_present,
    CASE WHEN function_oid IS NULL THEN false ELSE
      pg_catalog.pg_get_functiondef(function_oid)
        LIKE '%cash_difference.note is required when reason is OTHER%'
    END AS other_note_required,
    CASE WHEN function_oid IS NULL THEN false ELSE
      pg_catalog.pg_get_functiondef(function_oid)
        LIKE '%cash_difference.reason is required when cash variance is nonzero%'
    END AS reason_required,
    CASE WHEN function_oid IS NULL THEN false ELSE
      NOT pg_catalog.has_function_privilege('authenticated', function_oid, 'EXECUTE')
      AND NOT pg_catalog.has_function_privilege('anon', function_oid, 'EXECUTE')
    END AS core_not_client_executable
  FROM target
)
SELECT jsonb_build_object(
  'result', CASE WHEN core_present AND other_note_required
    AND reason_required AND core_not_client_executable
    THEN 'M16_PRE_OK' ELSE 'M16_PRE_FAILED' END,
  'core_present', core_present,
  'other_note_required', other_note_required,
  'reason_required', reason_required,
  'core_not_client_executable', core_not_client_executable
) AS verification
FROM contract;
