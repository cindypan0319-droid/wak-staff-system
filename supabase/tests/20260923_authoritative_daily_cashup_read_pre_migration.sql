/* READ ONLY. Run before Migration 6A. */
DO $verify$
DECLARE
  v_column text;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M6A_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  IF to_regprocedure('public.get_daily_cashup_snapshot(date,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'M6A_PRE: get_daily_cashup_snapshot(date,text) already exists';
  END IF;

  FOREACH v_column IN ARRAY ARRAY[
    'business_date', 'store_id', 'session_type', 'counts', 'total_cash',
    'removed_cash', 'entered_by', 'created_at', 'updated_at'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns AS c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'cashup_sessions'
        AND c.column_name = v_column
    ) THEN
      RAISE EXCEPTION 'M6A_PRE: missing cashup_sessions.%', v_column;
    END IF;
  END LOOP;

  FOREACH v_column IN ARRAY ARRAY[
    'business_date', 'store_id', 'cash_sales', 'eftpos_sales',
    'expected_cash', 'total_sales', 'notes', 'entered_by'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns AS c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'daily_sales'
        AND c.column_name = v_column
    ) THEN
      RAISE EXCEPTION 'M6A_PRE: missing daily_sales.%', v_column;
    END IF;
  END LOOP;

  FOREACH v_column IN ARRAY ARRAY[
    'business_date', 'store_id', 'platform', 'gross_income', 'fees', 'entered_by'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns AS c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'platform_income'
        AND c.column_name = v_column
    ) THEN
      RAISE EXCEPTION 'M6A_PRE: missing platform_income.%', v_column;
    END IF;
  END LOOP;

  FOREACH v_column IN ARRAY ARRAY['id', 'name', 'is_active', 'sort_order'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns AS c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'platforms'
        AND c.column_name = v_column
    ) THEN
      RAISE EXCEPTION 'M6A_PRE: missing platforms.%', v_column;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'profiles'
      AND c.column_name = 'role'
  ) OR NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'profiles'
      AND c.column_name = 'is_active'
  ) THEN
    RAISE EXCEPTION 'M6A_PRE: required profile authorization columns are missing';
  END IF;
END
$verify$;

SELECT
  to_regprocedure('public.get_daily_cashup_snapshot(date,text)') IS NULL
    AS read_rpc_absent,
  pg_catalog.has_table_privilege('authenticated', 'public.cashup_sessions', 'SELECT')
    AS authenticated_can_select_cashups,
  pg_catalog.has_table_privilege('authenticated', 'public.daily_sales', 'SELECT')
    AS authenticated_can_select_daily_sales,
  pg_catalog.has_table_privilege('authenticated', 'public.platform_income', 'SELECT')
    AS authenticated_can_select_platform_income;
