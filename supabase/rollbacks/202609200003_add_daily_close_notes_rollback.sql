BEGIN;

/* Restore the exact public wrapper definitions applied by Migration 1. */
CREATE OR REPLACE FUNCTION public.submit_daily_close(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN public._wak_apply_daily_close(
    p_payload,
    false,
    false
  );
END
$function$;


CREATE OR REPLACE FUNCTION public.correct_daily_close(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN public._wak_apply_daily_close(
    p_payload,
    true,
    true
  );
END
$function$;

DROP FUNCTION public._wak_apply_daily_close_with_notes(jsonb, boolean, boolean);

COMMIT;
