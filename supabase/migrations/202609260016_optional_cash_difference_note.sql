BEGIN;

/*
 * Migration 016: make the Daily Close cash-difference note optional for every
 * reason, including OTHER. A non-zero cash difference still requires a reason.
 *
 * This intentionally changes only the note-required validation inside the
 * existing transactional Daily Close core. All authorization, locking,
 * counting, fee, correction, and attribution behavior remains unchanged.
 */
DO $make_cash_difference_note_optional$
DECLARE
  v_oid oid := to_regprocedure(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'
  );
  v_definition text;
  v_note_rule text := $rule$    IF v_cash_difference_reason = 'OTHER'
       AND v_cash_difference_note = '' THEN
      RAISE EXCEPTION
        'cash_difference.note is required when reason is OTHER'
        USING ERRCODE = '22023';
    END IF;
$rule$;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'MIGRATION_16_PRECONDITION: run as postgres';
  END IF;

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_16_PRECONDITION: Daily Close core is missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_oid)
  INTO v_definition;

  IF pg_catalog.strpos(v_definition, v_note_rule) = 0
     OR pg_catalog.strpos(
       pg_catalog.substr(
         v_definition,
         pg_catalog.strpos(v_definition, v_note_rule) + pg_catalog.length(v_note_rule)
       ),
       v_note_rule
     ) > 0 THEN
    RAISE EXCEPTION
      'MIGRATION_16_PRECONDITION: expected unique OTHER note rule not found';
  END IF;

  IF pg_catalog.strpos(
       v_definition,
       'cash_difference.reason is required when cash variance is nonzero'
     ) = 0 THEN
    RAISE EXCEPTION
      'MIGRATION_16_PRECONDITION: cash-difference reason rule is missing';
  END IF;

  EXECUTE pg_catalog.replace(v_definition, v_note_rule, '');
END
$make_cash_difference_note_optional$;

DO $postcondition$
DECLARE
  v_oid oid := to_regprocedure(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'
  );
  v_definition text;
  v_notes_oid oid := to_regprocedure(
    'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
  );
BEGIN
  SELECT pg_catalog.pg_get_functiondef(v_oid)
  INTO v_definition;

  IF pg_catalog.strpos(
       v_definition,
       'cash_difference.note is required when reason is OTHER'
     ) > 0 THEN
    RAISE EXCEPTION 'MIGRATION_16_POSTCONDITION: note requirement still present';
  END IF;

  IF pg_catalog.strpos(
       v_definition,
       'cash_difference.reason is required when cash variance is nonzero'
     ) = 0 THEN
    RAISE EXCEPTION 'MIGRATION_16_POSTCONDITION: reason requirement was removed';
  END IF;

  IF pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_notes_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_notes_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'MIGRATION_16_POSTCONDITION: internal helper ACL changed';
  END IF;
END
$postcondition$;

COMMIT;
