BEGIN;

/*
 * Migration 6A: authoritative, store/date-scoped Daily Cashup read contract.
 *
 * SECURITY DEFINER intentionally bypasses ownership-based SELECT RLS only
 * after authenticating an active STAFF, MANAGER, or OWNER profile. The
 * function is read-only and exposes no profile data beyond the caller's id
 * and role.
 */
CREATE FUNCTION public.get_daily_cashup_snapshot(
  p_business_date date,
  p_store_id text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_actor uuid;
  v_role text;
  v_is_active boolean;
  v_morning jsonb;
  v_night jsonb;
  v_daily_sales jsonb;
  v_platforms jsonb;
  v_active_platforms jsonb;
BEGIN
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
    RAISE EXCEPTION 'Role is not permitted to read Daily Cashup'
      USING ERRCODE = '42501';
  END IF;

  IF p_business_date IS NULL THEN
    RAISE EXCEPTION 'business_date is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_store_id IS DISTINCT FROM 'MOOROOLBARK' THEN
    RAISE EXCEPTION 'Store is not authorized for this operation'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    (
      SELECT pg_catalog.jsonb_build_object(
        'exists', true,
        'counts', c.counts,
        'total_cash', c.total_cash,
        'entered_by', c.entered_by,
        'created_at', c.created_at,
        'updated_at', c.updated_at
      )
      FROM public.cashup_sessions AS c
      WHERE c.business_date = p_business_date
        AND c.store_id = p_store_id
        AND c.session_type = 'MORNING'
    ),
    pg_catalog.jsonb_build_object(
      'exists', false,
      'counts', NULL,
      'total_cash', NULL,
      'entered_by', NULL,
      'created_at', NULL,
      'updated_at', NULL
    )
  )
  INTO v_morning;

  SELECT COALESCE(
    (
      SELECT pg_catalog.jsonb_build_object(
        'exists', true,
        'counts', c.counts,
        'total_cash', c.total_cash,
        'removed_cash', c.removed_cash,
        'entered_by', c.entered_by,
        'created_at', c.created_at,
        'updated_at', c.updated_at
      )
      FROM public.cashup_sessions AS c
      WHERE c.business_date = p_business_date
        AND c.store_id = p_store_id
        AND c.session_type = 'NIGHT'
    ),
    pg_catalog.jsonb_build_object(
      'exists', false,
      'counts', NULL,
      'total_cash', NULL,
      'removed_cash', NULL,
      'entered_by', NULL,
      'created_at', NULL,
      'updated_at', NULL
    )
  )
  INTO v_night;

  SELECT COALESCE(
    (
      SELECT pg_catalog.jsonb_build_object(
        'exists', true,
        'cash_sales', ds.cash_sales,
        'eftpos_sales', ds.eftpos_sales,
        'expected_cash', ds.expected_cash,
        'total_sales', ds.total_sales,
        'notes', ds.notes,
        'entered_by', ds.entered_by
      )
      FROM public.daily_sales AS ds
      WHERE ds.business_date = p_business_date
        AND ds.store_id = p_store_id
    ),
    pg_catalog.jsonb_build_object(
      'exists', false,
      'cash_sales', NULL,
      'eftpos_sales', NULL,
      'expected_cash', NULL,
      'total_sales', NULL,
      'notes', NULL,
      'entered_by', NULL
    )
  )
  INTO v_daily_sales;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'platform', pi.platform,
        'gross_income', pi.gross_income,
        'fees', pi.fees,
        'entered_by', pi.entered_by
      )
      ORDER BY pi.platform
    ),
    '[]'::jsonb
  )
  INTO v_platforms
  FROM public.platform_income AS pi
  WHERE pi.business_date = p_business_date
    AND pi.store_id = p_store_id;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'is_active', p.is_active,
        'sort_order', p.sort_order
      )
      ORDER BY p.sort_order, p.name, p.id
    ),
    '[]'::jsonb
  )
  INTO v_active_platforms
  FROM public.platforms AS p
  WHERE p.is_active IS TRUE;

  RETURN pg_catalog.jsonb_build_object(
    'business_date', p_business_date,
    'store_id', p_store_id,
    'caller', pg_catalog.jsonb_build_object(
      'role', v_role,
      'user_id', v_actor
    ),
    'morning', v_morning,
    'night', v_night,
    'daily_sales', v_daily_sales,
    'platforms', v_platforms,
    'active_platforms', v_active_platforms
  );
END
$function$;

ALTER FUNCTION public.get_daily_cashup_snapshot(date, text) OWNER TO postgres;

COMMENT ON FUNCTION public.get_daily_cashup_snapshot(date, text) IS
  'Authoritative read-only Daily Cashup snapshot for one authorized store/date.';

REVOKE ALL ON FUNCTION public.get_daily_cashup_snapshot(date, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_daily_cashup_snapshot(date, text) FROM anon;
REVOKE ALL ON FUNCTION public.get_daily_cashup_snapshot(date, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.get_daily_cashup_snapshot(date, text) TO authenticated;

COMMIT;
