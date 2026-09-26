BEGIN;

/* Roll back Migration 016 by restoring the previous OTHER-note requirement. */
DO $restore_cash_difference_note_requirement$
DECLARE
  v_oid oid := to_regprocedure(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'
  );
  v_definition text;
  v_anchor text := $anchor$    IF v_cash_difference_reason = '' THEN
      RAISE EXCEPTION
        'cash_difference.reason is required when cash variance is nonzero'
        USING ERRCODE = '22023';
    END IF;
$anchor$;
  v_restored text := $restored$    IF v_cash_difference_reason = '' THEN
      RAISE EXCEPTION
        'cash_difference.reason is required when cash variance is nonzero'
        USING ERRCODE = '22023';
    END IF;

    IF v_cash_difference_reason = 'OTHER'
       AND v_cash_difference_note = '' THEN
      RAISE EXCEPTION
        'cash_difference.note is required when reason is OTHER'
        USING ERRCODE = '22023';
    END IF;
$restored$;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'MIGRATION_16_ROLLBACK: run as postgres';
  END IF;

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_16_ROLLBACK: Daily Close core is missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_oid)
  INTO v_definition;

  IF pg_catalog.strpos(
       v_definition,
       'cash_difference.note is required when reason is OTHER'
     ) > 0 THEN
    RAISE EXCEPTION 'MIGRATION_16_ROLLBACK: note requirement is already present';
  END IF;

  IF pg_catalog.strpos(v_definition, v_anchor) = 0
     OR pg_catalog.strpos(
       pg_catalog.substr(
         v_definition,
         pg_catalog.strpos(v_definition, v_anchor) + pg_catalog.length(v_anchor)
       ),
       v_anchor
     ) > 0 THEN
    RAISE EXCEPTION 'MIGRATION_16_ROLLBACK: expected unique reason rule not found';
  END IF;

  EXECUTE pg_catalog.replace(v_definition, v_anchor, v_restored);
END
$restore_cash_difference_note_requirement$;

COMMIT;
