BEGIN;

/*
 * Migration 8 / P1A Phase A: atomic server-side staff clock mutations.
 *
 * This migration is deliberately additive. Existing time_clock grants and RLS
 * policies remain unchanged until the deployed frontend has been verified.
 */
CREATE FUNCTION public.wak_clock_in_for_actor(
  p_actor uuid,
  p_device_tag text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_role text;
  v_is_active boolean;
  v_now timestamptz;
  v_clock public.time_clock%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF p_device_tag IS NULL OR pg_catalog.btrim(p_device_tag) = '' THEN
    RAISE EXCEPTION 'DEVICE_TAG_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.upper(p.role::text), p.is_active
  INTO v_role, v_is_active
  FROM public.profiles AS p
  WHERE p.id = p_actor
  FOR SHARE OF p;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'PROFILE_INACTIVE' USING ERRCODE = '42501';
  END IF;

  IF v_role IS NULL OR v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN
    RAISE EXCEPTION 'ROLE_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wak:time-clock:' || p_actor::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.time_clock AS tc
    WHERE tc.staff_id = p_actor
      AND tc.clock_out_at IS NULL
  ) THEN
    RAISE EXCEPTION 'ALREADY_CLOCKED_IN' USING ERRCODE = 'P0001';
  END IF;

  v_now := pg_catalog.clock_timestamp();

  BEGIN
    INSERT INTO public.time_clock (
      staff_id,
      shift_id,
      clock_in_at,
      clock_out_at,
      device_tag
    ) VALUES (
      p_actor,
      NULL,
      v_now,
      NULL,
      pg_catalog.btrim(p_device_tag)
    )
    RETURNING * INTO v_clock;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'ALREADY_CLOCKED_IN' USING ERRCODE = 'P0001';
  END;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_clock.id,
    'staff_id', v_clock.staff_id,
    'clock_in_at', v_clock.clock_in_at,
    'clock_out_at', v_clock.clock_out_at,
    'device_tag', v_clock.device_tag
  );
END
$function$;

CREATE FUNCTION public.wak_clock_out_for_actor(
  p_actor uuid,
  p_expected_clock_id bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_role text;
  v_is_active boolean;
  v_now timestamptz;
  v_clock public.time_clock%ROWTYPE;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF p_expected_clock_id IS NULL THEN
    RAISE EXCEPTION 'EXPECTED_CLOCK_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.upper(p.role::text), p.is_active
  INTO v_role, v_is_active
  FROM public.profiles AS p
  WHERE p.id = p_actor
  FOR SHARE OF p;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROFILE_NOT_FOUND' USING ERRCODE = '42501';
  END IF;

  IF v_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'PROFILE_INACTIVE' USING ERRCODE = '42501';
  END IF;

  IF v_role IS NULL OR v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN
    RAISE EXCEPTION 'ROLE_NOT_ALLOWED' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wak:time-clock:' || p_actor::text, 0)
  );

  SELECT tc.*
  INTO v_clock
  FROM public.time_clock AS tc
  WHERE tc.id = p_expected_clock_id
    AND tc.staff_id = p_actor
    AND tc.clock_out_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.time_clock AS tc
      WHERE tc.id = p_expected_clock_id
        AND tc.staff_id = p_actor
    ) THEN
      RAISE EXCEPTION 'CLOCK_STATE_CHANGED' USING ERRCODE = 'P0001';
    END IF;

    RAISE EXCEPTION 'OPEN_CLOCK_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_now := pg_catalog.clock_timestamp();

  UPDATE public.time_clock AS tc
  SET clock_out_at = v_now
  WHERE tc.id = v_clock.id
    AND tc.staff_id = p_actor
    AND tc.clock_out_at IS NULL
  RETURNING * INTO v_clock;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLOCK_STATE_CHANGED' USING ERRCODE = 'P0001';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_clock.id,
    'staff_id', v_clock.staff_id,
    'clock_in_at', v_clock.clock_in_at,
    'clock_out_at', v_clock.clock_out_at,
    'device_tag', v_clock.device_tag
  );
END
$function$;

ALTER FUNCTION public.wak_clock_in_for_actor(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.wak_clock_out_for_actor(uuid, bigint) OWNER TO postgres;

COMMENT ON FUNCTION public.wak_clock_in_for_actor(uuid, text) IS
  'Service-only atomic clock-in for a server-authenticated actor.';
COMMENT ON FUNCTION public.wak_clock_out_for_actor(uuid, bigint) IS
  'Service-only atomic clock-out for an expected open clock owned by the actor.';

REVOKE ALL ON FUNCTION public.wak_clock_in_for_actor(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.wak_clock_out_for_actor(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wak_clock_in_for_actor(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.wak_clock_out_for_actor(uuid, bigint) TO service_role;

DO $postcondition$
DECLARE
  v_clock_in oid := to_regprocedure('public.wak_clock_in_for_actor(uuid,text)');
  v_clock_out oid := to_regprocedure('public.wak_clock_out_for_actor(uuid,bigint)');
  v_policy text;
BEGIN
  IF v_clock_in IS NULL OR v_clock_out IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_8_POSTCONDITION: time-clock function is missing';
  END IF;

  IF (SELECT count(*)
      FROM pg_catalog.pg_proc AS p
      WHERE p.oid IN (v_clock_in, v_clock_out)
        AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
        AND p.prosecdef
        AND 'search_path=pg_catalog, public' = ANY (p.proconfig)) <> 2 THEN
    RAISE EXCEPTION 'MIGRATION_8_POSTCONDITION: function security metadata is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege('service_role', v_clock_in, 'EXECUTE') IS NOT TRUE
     OR pg_catalog.has_function_privilege('service_role', v_clock_out, 'EXECUTE') IS NOT TRUE
     OR pg_catalog.has_function_privilege('authenticated', v_clock_in, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_clock_out, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_clock_in, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_clock_out, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) AS acl
       WHERE p.oid IN (v_clock_in, v_clock_out)
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'MIGRATION_8_POSTCONDITION: function EXECUTE ACL is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_indexes AS i
    WHERE i.schemaname = 'public'
      AND i.tablename = 'time_clock'
      AND i.indexname = 'time_clock_one_open'
      AND i.indexdef ILIKE 'CREATE UNIQUE INDEX%'
      AND i.indexdef ILIKE '%(staff_id)%'
      AND i.indexdef ILIKE '%clock_out_at IS NULL%'
  ) THEN
    RAISE EXCEPTION 'MIGRATION_8_POSTCONDITION: time_clock_one_open changed or is missing';
  END IF;

  FOREACH v_policy IN ARRAY ARRAY[
    'STAFF insert time_clock (own)',
    'STAFF update time_clock (own)',
    'time_clock_self_anyrole_insert',
    'time_clock_self_anyrole_update'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policies AS p
      WHERE p.schemaname = 'public'
        AND p.tablename = 'time_clock'
        AND p.policyname = v_policy
    ) THEN
      RAISE EXCEPTION 'MIGRATION_8_POSTCONDITION: required Phase A policy % is missing', v_policy;
    END IF;
  END LOOP;
END
$postcondition$;

COMMIT;
