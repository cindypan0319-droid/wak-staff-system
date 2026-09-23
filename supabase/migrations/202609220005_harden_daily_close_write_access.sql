BEGIN;

/* Migration 5: client roles retain SELECT, but cannot write Daily Close tables directly. */
DO $precondition$
DECLARE
  v_table text;
  v_role text;
  v_privilege text;
  v_role_oid oid;
  v_acl_count integer;
  v_any_grantable boolean;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['cashup_sessions', 'daily_sales', 'platform_income'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = v_table
        AND c.relkind IN ('r', 'p') AND c.relrowsecurity AND NOT c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'MIGRATION_5_PRECONDITION: unexpected RLS state for %', v_table;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))
      ) AS acl
      WHERE n.nspname = 'public' AND c.relname = v_table
        AND acl.grantee = 0
        AND acl.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    ) THEN
      RAISE EXCEPTION 'MIGRATION_5_PRECONDITION: PUBLIC write grant on %', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      SELECT r.oid INTO v_role_oid
      FROM pg_catalog.pg_roles AS r
      WHERE r.rolname = v_role;
      IF v_role_oid IS NULL THEN
        RAISE EXCEPTION 'MIGRATION_5_PRECONDITION: role % is missing', v_role;
      END IF;
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'
      ] LOOP
        SELECT count(*)::integer, COALESCE(bool_or(acl.is_grantable), false)
        INTO v_acl_count, v_any_grantable
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) AS acl
        WHERE n.nspname = 'public'
          AND c.relname = v_table
          AND acl.grantee = v_role_oid
          AND acl.privilege_type = v_privilege;
        IF v_acl_count <> 1 OR v_any_grantable THEN
          RAISE EXCEPTION
            'MIGRATION_5_PRECONDITION: missing, duplicate, or grantable direct %.% ACL on public.%',
            v_role, v_privilege, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname='public') <> 74
     OR (SELECT md5(string_agg(
       format('%s.%s|%s|%s|%s|%s|%s|%s',
         schemaname,tablename,policyname,permissive,roles::text,cmd,
         COALESCE(qual,''),COALESCE(with_check,'')),
       E'\n' ORDER BY schemaname,tablename,policyname
     )) FROM pg_catalog.pg_policies WHERE schemaname='public')
       <> '96333950f5cb0a0ae9375bb5612773fa' THEN
    RAISE EXCEPTION 'MIGRATION_5_PRECONDITION: public policy baseline changed';
  END IF;
END
$precondition$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
ON TABLE public.cashup_sessions, public.daily_sales, public.platform_income
FROM anon, authenticated;

DROP POLICY cashup_insert_own ON public.cashup_sessions;
DROP POLICY cashup_update_own ON public.cashup_sessions;

DROP POLICY "Owner/Manager can delete - daily_sales" ON public.daily_sales;
DROP POLICY "Owner/Manager can insert - daily_sales" ON public.daily_sales;
DROP POLICY "Owner/Manager can update - daily_sales" ON public.daily_sales;
DROP POLICY "Staff can insert own - daily_sales" ON public.daily_sales;
DROP POLICY daily_sales_insert_own ON public.daily_sales;
DROP POLICY daily_sales_update_own ON public.daily_sales;

DROP POLICY "Owner/Manager can delete - platform_income" ON public.platform_income;
DROP POLICY "Owner/Manager can insert - platform_income" ON public.platform_income;
DROP POLICY "Owner/Manager can update - platform_income" ON public.platform_income;
DROP POLICY platform_income_insert_own ON public.platform_income;
DROP POLICY platform_income_manager_owner_all ON public.platform_income;
DROP POLICY platform_income_staff_insert_own ON public.platform_income;
DROP POLICY platform_income_update_own ON public.platform_income;

DO $postcondition$
DECLARE
  v_table text;
  v_role text;
  v_privilege text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['cashup_sessions', 'daily_sales', 'platform_income'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.' || v_table, 'SELECT') IS NOT TRUE THEN
        RAISE EXCEPTION
          'MIGRATION_5_POSTCONDITION: %.SELECT is missing on public.%',
          v_role, v_table;
      END IF;
      FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
        IF pg_catalog.has_table_privilege(v_role, 'public.' || v_table, v_privilege) IS NOT FALSE THEN
          RAISE EXCEPTION
            'MIGRATION_5_POSTCONDITION: %.% remains available on public.%',
            v_role, v_privilege, v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END
$postcondition$;

COMMIT;
