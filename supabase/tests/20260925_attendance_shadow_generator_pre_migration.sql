/* Read-only preflight for Migration 011. */
DO $pre$
DECLARE v_table text;
BEGIN
  IF session_user<>'postgres' THEN RAISE EXCEPTION 'M11_PRE: run as postgres'; END IF;
  IF to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'M11_PRE: generator already exists';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'M11_PRE: service_role missing';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN
      ('payroll_periods','work_periods','work_period_versions','work_period_anomalies'))<>4 THEN
    RAISE EXCEPTION 'M11_PRE: Migration 010 tables missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public'
      AND indexname='work_periods_time_clock_unique' AND indexdef ILIKE 'CREATE UNIQUE INDEX%')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conname='work_periods_current_version_same_period_fk')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conname='work_period_anomalies_resolution_same_period_fk') THEN
    RAISE EXCEPTION 'M11_PRE: critical Migration 010 integrity is missing';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['payroll_periods','work_periods','work_period_versions','work_period_anomalies'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=v_table AND c.relrowsecurity AND NOT c.relforcerowsecurity)
       OR NOT has_table_privilege('authenticated','public.'||v_table,'SELECT')
       OR has_table_privilege('authenticated','public.'||v_table,'INSERT,UPDATE,DELETE')
       OR has_table_privilege('anon','public.'||v_table,'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'M11_PRE: canonical ACL/RLS differs for %',v_table;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_policies p
      WHERE p.schemaname='public'
        AND p.tablename IN ('payroll_periods','work_periods','work_period_versions','work_period_anomalies')
        AND p.cmd='SELECT' AND p.roles=ARRAY['authenticated']::name[]
        AND p.qual ILIKE '%is_active IS TRUE%' AND p.qual ILIKE '%MANAGER%' AND p.qual ILIKE '%OWNER%')<>4 THEN
    RAISE EXCEPTION 'M11_PRE: canonical Manager/Owner SELECT policies differ';
  END IF;

  IF EXISTS (
    SELECT expected.table_name,expected.column_name
    FROM (VALUES
      ('profiles','id','uuid'),('profiles','is_active','boolean'),
      ('time_clock','id','bigint'),('time_clock','staff_id','uuid'),('time_clock','shift_id','bigint'),
      ('time_clock','clock_in_at','timestamp with time zone'),('time_clock','clock_out_at','timestamp with time zone'),
      ('shifts','id','bigint'),('shifts','staff_id','uuid'),('shifts','store_id','text'),
      ('shifts','shift_start','timestamp with time zone'),('shifts','shift_end','timestamp with time zone'),
      ('shifts','parent_shift_id','bigint')
    ) expected(table_name,column_name,data_type)
    LEFT JOIN information_schema.columns c ON c.table_schema='public'
      AND c.table_name=expected.table_name AND c.column_name=expected.column_name
    WHERE c.data_type IS DISTINCT FROM expected.data_type
  ) THEN
    RAISE EXCEPTION 'M11_PRE: required legacy column contract differs';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public'
        AND ((table_name='profiles' AND column_name='role')
          OR (table_name='shifts' AND column_name='shift_status')))<>2 THEN
    RAISE EXCEPTION 'M11_PRE: profiles.role or shifts.shift_status is missing';
  END IF;
END
$pre$;

WITH legacy_items AS (
  SELECT format('REL|%s|%s|%s',c.relname,c.relkind,coalesce(c.relacl::text,'NULL')) item
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
  UNION ALL
  SELECT format('CON|%s|%s|%s',c.relname,k.conname,pg_get_constraintdef(k.oid,true))
  FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
  UNION ALL
  SELECT format('POL|%s|%s|%s|%s|%s|%s',tablename,policyname,roles::text,cmd,
    coalesce(qual,''),coalesce(with_check,'')) FROM pg_catalog.pg_policies
  WHERE schemaname='public' AND tablename IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
)
SELECT count(*) AS legacy_item_count,md5(string_agg(item,E'\n' ORDER BY item)) AS legacy_fingerprint
FROM legacy_items;

SELECT shift_status,count(*) AS rows
FROM public.shifts
GROUP BY shift_status
ORDER BY shift_status;

SELECT count(*) AS parent_cover_rows
FROM public.shifts WHERE parent_shift_id IS NOT NULL;

SELECT count(*) AS public_table_count
FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r';

SELECT 'M11_PRE_OK' AS result;
