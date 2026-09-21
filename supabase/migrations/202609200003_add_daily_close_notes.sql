BEGIN;

/*
 * Migration 3: atomically persist optional Daily Close notes.
 *
 * Semantics:
 * - omitted notes do not modify the notes column;
 * - on a brand-new submit, notes therefore remain SQL NULL because Migration 1
 *   creates the daily_sales row without a note;
 * - on a legacy-partial submit or correction, omitted notes preserve the
 *   current value;
 * - explicit JSON null clears the current value;
 * - string notes are stored exactly, including whitespace and empty strings.
 *
 * Migration 1's core implementation remains unchanged. This private wrapper
 * validates notes, delegates the close to the existing transactional core,
 * then updates notes before the same function call/transaction can commit.
 */
CREATE OR REPLACE FUNCTION public._wak_apply_daily_close_with_notes(
  p_payload jsonb,
  p_allow_remove boolean,
  p_correction_only boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_notes_supplied boolean := false;
  v_notes text := NULL;
  v_result jsonb;
  v_business_date date;
  v_store_id text;
BEGIN
  v_result := public._wak_apply_daily_close(
    p_payload,
    p_allow_remove,
    p_correction_only
  );

  IF p_payload IS NOT NULL
     AND jsonb_typeof(p_payload) = 'object'
     AND p_payload ? 'notes' THEN
    v_notes_supplied := true;

    IF p_payload -> 'notes' = 'null'::jsonb THEN
      v_notes := NULL;
    ELSIF jsonb_typeof(p_payload -> 'notes') = 'string' THEN
      v_notes := p_payload ->> 'notes';
    ELSE
      RAISE EXCEPTION 'notes must be a string or JSON null'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  /* Omitted notes never modify the value produced or preserved by Migration 1. */
  IF NOT v_notes_supplied THEN
    RETURN v_result;
  END IF;

  v_business_date := (v_result ->> 'business_date')::date;
  v_store_id := v_result ->> 'store_id';

  UPDATE public.daily_sales AS ds
  SET notes = v_notes
  WHERE ds.business_date = v_business_date
    AND ds.store_id = v_store_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'DAILY_CLOSE_NOTES_TARGET_MISSING: committed close has no daily_sales row'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public._wak_apply_daily_close_with_notes(jsonb, boolean, boolean) IS
  'Private Migration 3 wrapper that persists optional Daily Close notes atomically.';

REVOKE ALL ON FUNCTION public._wak_apply_daily_close_with_notes(jsonb, boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._wak_apply_daily_close_with_notes(jsonb, boolean, boolean) FROM anon;
REVOKE ALL ON FUNCTION public._wak_apply_daily_close_with_notes(jsonb, boolean, boolean) FROM authenticated;
REVOKE ALL ON FUNCTION public._wak_apply_daily_close_with_notes(jsonb, boolean, boolean) FROM service_role;


CREATE OR REPLACE FUNCTION public.submit_daily_close(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RETURN public._wak_apply_daily_close_with_notes(
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
  RETURN public._wak_apply_daily_close_with_notes(
    p_payload,
    true,
    true
  );
END
$function$;

COMMIT;
