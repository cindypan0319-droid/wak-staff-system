/* Read-only preflight for Migration 010. */
DO $pre_migration$
DECLARE
  v_name text;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M10_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'public')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'M10_PRE: required schema or roles are missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = 'Australia/Melbourne') THEN
    RAISE EXCEPTION 'M10_PRE: Australia/Melbourne timezone is unavailable';
  END IF;

  IF pg_catalog.format_type((SELECT atttypid FROM pg_catalog.pg_attribute
      WHERE attrelid='public.profiles'::regclass AND attname='id' AND NOT attisdropped), NULL) IS DISTINCT FROM 'uuid'
     OR pg_catalog.format_type((SELECT atttypid FROM pg_catalog.pg_attribute
      WHERE attrelid='public.shifts'::regclass AND attname='id' AND NOT attisdropped), NULL) IS DISTINCT FROM 'bigint'
     OR pg_catalog.format_type((SELECT atttypid FROM pg_catalog.pg_attribute
      WHERE attrelid='public.time_clock'::regclass AND attname='id' AND NOT attisdropped), NULL) IS DISTINCT FROM 'bigint'
     OR pg_catalog.format_type((SELECT atttypid FROM pg_catalog.pg_attribute
      WHERE attrelid='public.time_clock'::regclass AND attname='staff_id' AND NOT attisdropped), NULL) IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 'M10_PRE: legacy type contract has drifted';
  END IF;

  FOREACH v_name IN ARRAY ARRAY[
    'payroll_periods','work_periods','work_period_versions','work_period_anomalies',
    'payroll_periods_id_seq','work_periods_id_seq',
    'work_period_versions_id_seq','work_period_anomalies_id_seq'
  ] LOOP
    IF pg_catalog.to_regclass('public.' || v_name) IS NOT NULL
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_type AS t
         JOIN pg_catalog.pg_namespace AS n ON n.oid=t.typnamespace
         WHERE n.nspname='public' AND t.typname=v_name
       ) THEN
      RAISE EXCEPTION 'M10_PRE: conflicting object public.% exists', v_name;
    END IF;
  END LOOP;
END
$pre_migration$;

/* Capture a deterministic read-only legacy structure/ACL fingerprint. */
WITH legacy_items AS (
  SELECT format('REL|%s|%s|%s',c.relname,c.relkind,COALESCE(c.relacl::text,'NULL')) AS item
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
  UNION ALL
  SELECT format('COL|%s|%s|%s|%s|%s',c.relname,a.attnum,a.attname,
                pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull)
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute AS a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  WHERE n.nspname='public'
    AND c.relname IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
  UNION ALL
  SELECT format('CON|%s|%s|%s',c.relname,k.conname,pg_catalog.pg_get_constraintdef(k.oid,true))
  FROM pg_catalog.pg_constraint AS k
  JOIN pg_catalog.pg_class AS c ON c.oid=k.conrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
  UNION ALL
  SELECT format('IDX|%s|%s|%s',tablename,indexname,indexdef)
  FROM pg_catalog.pg_indexes
  WHERE schemaname='public'
    AND tablename IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
  UNION ALL
  SELECT format('POL|%s|%s|%s|%s|%s|%s',tablename,policyname,roles::text,cmd,
                COALESCE(qual,''),COALESCE(with_check,''))
  FROM pg_catalog.pg_policies
  WHERE schemaname='public'
    AND tablename IN ('profiles','shifts','time_clock','staff_pay_rates','shift_costs')
)
SELECT count(*) AS legacy_item_count,
       md5(string_agg(item,E'\n' ORDER BY item)) AS legacy_fingerprint
FROM legacy_items;

SELECT 'M10_PRE_OK' AS result;
