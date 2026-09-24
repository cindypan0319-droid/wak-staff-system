BEGIN;

DO $restore_core_role_gate$
DECLARE
  v_definition text := pg_catalog.pg_get_functiondef(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
  );
  v_new text := $new$  IF p_correction_only THEN
    IF v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN
      RAISE EXCEPTION 'Only an active STAFF, MANAGER, or OWNER may correct a Daily Close'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN$new$;
  v_old text := $old$  IF p_correction_only THEN
    IF v_role NOT IN ('MANAGER', 'OWNER') THEN
      RAISE EXCEPTION 'Only an active OWNER or MANAGER may correct a Daily Close'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN$old$;
BEGIN
  IF pg_catalog.strpos(v_definition, v_new) = 0
     OR pg_catalog.strpos(
       pg_catalog.substr(
         v_definition,
         pg_catalog.strpos(v_definition, v_new) + pg_catalog.length(v_new)
       ),
       v_new
     ) > 0 THEN
    RAISE EXCEPTION 'MIGRATION_7_ROLLBACK: correction role gate is not unique';
  END IF;

  EXECUTE pg_catalog.replace(v_definition, v_new, v_old);
END
$restore_core_role_gate$;

CREATE OR REPLACE FUNCTION public.correct_daily_close(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN public._wak_apply_daily_close_with_notes(
    p_payload,
    true,
    true
  );
END
$function$;

COMMENT ON FUNCTION public.correct_daily_close(jsonb) IS NULL;

DO $postcondition$
BEGIN
  IF md5(pg_catalog.pg_get_functiondef(
       'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
     )) <> '434a558aed342b3227c63934884b26e1'
     OR md5(pg_catalog.pg_get_functiondef(
       'public.correct_daily_close(jsonb)'::regprocedure
     )) <> '2cd0d734acf9163932ce22a9ebed503d' THEN
    RAISE EXCEPTION 'MIGRATION_7_ROLLBACK: prior function definitions were not restored exactly';
  END IF;
END
$postcondition$;

COMMIT;
