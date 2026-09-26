/* Lightweight contract smoke test for Migration 016. */
BEGIN;

DO $smoke$
DECLARE
  v_oid oid := to_regprocedure(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'
  );
  v_definition text;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M16_SMOKE_PRE: run as postgres';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_oid)
  INTO v_definition;

  IF pg_catalog.strpos(
       v_definition,
       'cash_difference.note is required when reason is OTHER'
     ) > 0 THEN
    RAISE EXCEPTION 'M16_SMOKE: OTHER still requires a note';
  END IF;

  IF pg_catalog.strpos(
       v_definition,
       'cash_difference.reason is required when cash variance is nonzero'
     ) = 0 THEN
    RAISE EXCEPTION 'M16_SMOKE: non-zero variance no longer requires a reason';
  END IF;
END
$smoke$;

ROLLBACK;

SELECT 'M16_SMOKE_OK' AS result;
