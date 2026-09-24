BEGIN;

/*
 * Migration 6B: allow active STAFF to correct only their own current
 * Australia/Melbourne Daily Close while preserving original close attribution.
 *
 * The exact post-Migration-4 core is transformed only at its correction-role
 * gate. All validation, cash rules, fees, locking, and first-submit behavior
 * remain in the existing core. The public correction wrapper applies the new
 * ownership/date/action boundary under the same advisory lock.
 */
DO $replace_core_role_gate$
DECLARE
  v_oid oid := to_regprocedure(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'
  );
  v_notes_oid oid := to_regprocedure(
    'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
  );
  v_definition text;
  v_old text := $old$  IF p_correction_only THEN
    IF v_role NOT IN ('MANAGER', 'OWNER') THEN
      RAISE EXCEPTION 'Only an active OWNER or MANAGER may correct a Daily Close'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN$old$;
  v_new text := $new$  IF p_correction_only THEN
    IF v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN
      RAISE EXCEPTION 'Only an active STAFF, MANAGER, or OWNER may correct a Daily Close'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN$new$;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_7_PRECONDITION: Daily Close core is missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(v_oid) INTO v_definition;

  IF md5(v_definition) <> '434a558aed342b3227c63934884b26e1' THEN
    RAISE EXCEPTION 'MIGRATION_7_PRECONDITION: Daily Close core hash changed';
  END IF;

  IF v_notes_oid IS NULL
     OR pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_notes_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_notes_oid, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid IN (v_oid, v_notes_oid)
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'MIGRATION_7_PRECONDITION: internal Daily Close helpers are executable by a client role';
  END IF;

  IF pg_catalog.strpos(v_definition, v_old) = 0
     OR pg_catalog.strpos(
       pg_catalog.substr(
         v_definition,
         pg_catalog.strpos(v_definition, v_old) + pg_catalog.length(v_old)
       ),
       v_old
     ) > 0 THEN
    RAISE EXCEPTION 'MIGRATION_7_PRECONDITION: correction role gate is not unique';
  END IF;

  EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END
$replace_core_role_gate$;

CREATE OR REPLACE FUNCTION public.correct_daily_close(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_actor uuid;
  v_role text;
  v_is_active boolean;
  v_business_date date;
  v_store_id text;
  v_expected_revision_text text;
  v_expected_revision timestamptz;
  v_current_revision timestamptz;
  v_original_night_entered_by uuid;
  v_original_daily_sales_entered_by uuid;
  v_had_daily_sales boolean := false;
  v_preserved_daily_sales_entered_by uuid;
  v_result jsonb;
  v_final_revision timestamptz;
BEGIN
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Daily Close payload must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  v_actor := auth.uid();

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT upper(p.role::text), p.is_active
  INTO v_role, v_is_active
  FROM public.profiles AS p
  WHERE p.id = v_actor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authenticated profile does not exist'
      USING ERRCODE = '42501';
  END IF;

  IF v_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Employee profile is inactive'
      USING ERRCODE = '42501';
  END IF;

  IF v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN
    RAISE EXCEPTION 'Role is not permitted to correct a Daily Close'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_business_date := (p_payload ->> 'business_date')::date;
  EXCEPTION
    WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'business_date must be a valid ISO date'
        USING ERRCODE = '22023';
  END;

  IF v_business_date IS NULL THEN
    RAISE EXCEPTION 'business_date is required'
      USING ERRCODE = '22023';
  END IF;

  v_store_id := p_payload ->> 'store_id';

  IF v_store_id IS DISTINCT FROM 'MOOROOLBARK' THEN
    RAISE EXCEPTION 'Store is not authorized for this operation'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (p_payload ? 'expected_night_updated_at') THEN
    RAISE EXCEPTION 'expected_night_updated_at must be present for correction'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload -> 'expected_night_updated_at' = 'null'::jsonb THEN
    v_expected_revision_text := NULL;
  ELSIF pg_catalog.jsonb_typeof(
    p_payload -> 'expected_night_updated_at'
  ) = 'string' THEN
    v_expected_revision_text := btrim(
      p_payload ->> 'expected_night_updated_at'
    );
  ELSE
    RAISE EXCEPTION 'expected_night_updated_at must be a timestamp string'
      USING ERRCODE = '22023';
  END IF;

  IF v_expected_revision_text IS NULL OR v_expected_revision_text = '' THEN
    RAISE EXCEPTION 'expected_night_updated_at must be non-null for correction'
      USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_expected_revision := v_expected_revision_text::timestamptz;
  EXCEPTION
    WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'expected_night_updated_at must be a valid timestamp'
        USING ERRCODE = '22023';
  END;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_store_id || ':' || v_business_date::text, 0)
  );

  SELECT c.updated_at, c.entered_by
  INTO v_current_revision, v_original_night_entered_by
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = v_store_id
    AND c.session_type = 'NIGHT'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'DAILY_CLOSE_NOT_FOUND: correction requires an existing NIGHT close'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_expected_revision IS DISTINCT FROM v_current_revision THEN
    RAISE EXCEPTION
      'DAILY_CLOSE_REVISION_CONFLICT: reload the current close before saving'
      USING ERRCODE = 'P0001';
  END IF;

  IF v_role = 'STAFF' THEN
    IF v_business_date IS DISTINCT FROM
       (pg_catalog.timezone('Australia/Melbourne', pg_catalog.now()))::date THEN
      RAISE EXCEPTION
        'STAFF_DAILY_CLOSE_CURRENT_DATE_ONLY: STAFF may correct only the current Melbourne business date'
        USING ERRCODE = '42501';
    END IF;

    IF v_original_night_entered_by IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION
        'STAFF_DAILY_CLOSE_NOT_ORIGINAL_SUBMITTER: STAFF may correct only their own Daily Close'
        USING ERRCODE = '42501';
    END IF;

    IF pg_catalog.jsonb_typeof(p_payload -> 'platforms') = 'array'
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements(
           p_payload -> 'platforms'
         ) AS item(value)
         WHERE upper(btrim(COALESCE(item.value ->> 'action', ''))) = 'REMOVE'
       ) THEN
      RAISE EXCEPTION
        'STAFF_DAILY_CLOSE_PLATFORM_REMOVE_FORBIDDEN: STAFF cannot remove platform rows'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT ds.entered_by
  INTO v_original_daily_sales_entered_by
  FROM public.daily_sales AS ds
  WHERE ds.business_date = v_business_date
    AND ds.store_id = v_store_id
  FOR UPDATE;

  v_had_daily_sales := FOUND;
  v_preserved_daily_sales_entered_by := CASE
    WHEN v_had_daily_sales THEN v_original_daily_sales_entered_by
    ELSE v_original_night_entered_by
  END;

  v_result := public._wak_apply_daily_close_with_notes(
    p_payload,
    v_role IN ('MANAGER', 'OWNER'),
    true
  );

  UPDATE public.cashup_sessions AS c
  SET entered_by = v_original_night_entered_by
  WHERE c.business_date = v_business_date
    AND c.store_id = v_store_id
    AND c.session_type = 'NIGHT'
    AND c.entered_by IS DISTINCT FROM v_original_night_entered_by;

  UPDATE public.daily_sales AS ds
  SET entered_by = v_preserved_daily_sales_entered_by
  WHERE ds.business_date = v_business_date
    AND ds.store_id = v_store_id
    AND ds.entered_by IS DISTINCT FROM v_preserved_daily_sales_entered_by;

  SELECT c.updated_at
  INTO v_final_revision
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = v_store_id
    AND c.session_type = 'NIGHT'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'DAILY_CLOSE_NOT_FOUND: corrected NIGHT row disappeared before response'
      USING ERRCODE = 'P0001';
  END IF;

  v_result := pg_catalog.jsonb_set(
    v_result,
    '{entered_by}',
    COALESCE(pg_catalog.to_jsonb(v_original_night_entered_by), 'null'::jsonb),
    true
  );

  RETURN pg_catalog.jsonb_set(
    v_result,
    '{night_updated_at}',
    pg_catalog.to_jsonb(v_final_revision),
    true
  );
END
$function$;

COMMENT ON FUNCTION public.correct_daily_close(jsonb) IS
  'Atomically corrects an existing Daily Close; STAFF is limited to their own current Melbourne close.';

DO $postcondition$
DECLARE
  v_core text := pg_catalog.pg_get_functiondef(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
  );
  v_correction text := pg_catalog.pg_get_functiondef(
    'public.correct_daily_close(jsonb)'::regprocedure
  );
  v_core_oid oid := to_regprocedure(
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'
  );
  v_notes_oid oid := to_regprocedure(
    'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
  );
BEGIN
  IF v_core !~ 'Only an active STAFF, MANAGER, or OWNER may correct a Daily Close'
     OR v_correction !~ 'Australia/Melbourne'
     OR v_correction !~ 'STAFF_DAILY_CLOSE_NOT_ORIGINAL_SUBMITTER'
     OR v_correction !~ 'STAFF_DAILY_CLOSE_PLATFORM_REMOVE_FORBIDDEN'
     OR v_correction !~ 'v_final_revision' THEN
    RAISE EXCEPTION 'MIGRATION_7_POSTCONDITION: correction authorization was not installed';
  END IF;

  IF pg_catalog.has_function_privilege('authenticated', v_core_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_core_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_notes_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_notes_oid, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid IN (v_core_oid, v_notes_oid)
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION
      'MIGRATION_7_POSTCONDITION: internal Daily Close helper became client-executable';
  END IF;
END
$postcondition$;

COMMIT;
