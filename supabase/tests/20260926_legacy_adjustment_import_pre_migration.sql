/* Read-only preflight for Migration 012. Returns one consolidated JSON row. */
DO $pre$
BEGIN
  IF session_user<>'postgres' THEN
    RAISE EXCEPTION 'M12_PRE: run as postgres';
  END IF;
  IF to_regprocedure('public.wak_import_legacy_clock_adjustments(text,date,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'M12_PRE: importer already exists';
  END IF;
  IF to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)') IS NULL THEN
    RAISE EXCEPTION 'M12_PRE: Migration 011 generator is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'M12_PRE: service_role is missing';
  END IF;
  IF EXISTS (
    SELECT expected.column_name
    FROM (VALUES
      ('id','bigint'),('staff_id','uuid'),('shift_id','bigint'),
      ('clock_in_at','timestamp with time zone'),('clock_out_at','timestamp with time zone'),
      ('device_tag','text'),('created_at','timestamp with time zone'),
      ('adjusted_clock_in_at','timestamp with time zone'),
      ('adjusted_clock_out_at','timestamp with time zone'),
      ('adjusted_reason','text'),('adjusted_by','uuid'),
      ('adjusted_at','timestamp with time zone')
    ) expected(column_name,data_type)
    LEFT JOIN information_schema.columns c
      ON c.table_schema='public' AND c.table_name='time_clock'
      AND c.column_name=expected.column_name
    WHERE c.data_type IS DISTINCT FROM expected.data_type
  ) THEN
    RAISE EXCEPTION 'M12_PRE: legacy time_clock contract differs';
  END IF;
END
$pre$;

WITH legacy_schema_items AS (
  SELECT format('COL|%s|%s|%s|%s',c.column_name,c.data_type,c.is_nullable,
    coalesce(c.column_default,'<NULL>')) AS item
  FROM information_schema.columns c
  WHERE c.table_schema='public' AND c.table_name='time_clock'
  UNION ALL
  SELECT format('CON|%s|%s',con.conname,pg_catalog.pg_get_constraintdef(con.oid,true))
  FROM pg_catalog.pg_constraint con
  WHERE con.conrelid='public.time_clock'::regclass
  UNION ALL
  SELECT format('IDX|%s|%s',i.indexname,i.indexdef)
  FROM pg_catalog.pg_indexes i
  WHERE i.schemaname='public' AND i.tablename='time_clock'
  UNION ALL
  SELECT format('POL|%s|%s|%s|%s|%s|%s',p.policyname,p.permissive,p.roles::text,
    p.cmd,coalesce(p.qual,''),coalesce(p.with_check,''))
  FROM pg_catalog.pg_policies p
  WHERE p.schemaname='public' AND p.tablename='time_clock'
  UNION ALL
  SELECT format('ACL|%s|%s|%s',acl.grantee,acl.privilege_type,acl.is_grantable)
  FROM pg_catalog.pg_class c
  CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(c.relacl,'{}'::aclitem[])) acl
  WHERE c.oid='public.time_clock'::regclass
), legacy_schema AS (
  SELECT count(*) AS item_count,
    md5(coalesce(string_agg(item,E'\n' ORDER BY item),'')) AS fingerprint
  FROM legacy_schema_items
), legacy_data AS (
  SELECT count(*) AS row_count,
    md5(coalesce(string_agg(format(
      '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
      tc.id,
      coalesce(tc.shift_id::text,'<NULL>'),
      tc.staff_id,
      coalesce(extract(epoch FROM tc.clock_in_at)::text,'<NULL>'),
      coalesce(extract(epoch FROM tc.clock_out_at)::text,'<NULL>'),
      encode(convert_to(coalesce(tc.device_tag,'<NULL>'),'UTF8'),'hex'),
      coalesce(extract(epoch FROM tc.created_at)::text,'<NULL>'),
      coalesce(extract(epoch FROM tc.adjusted_clock_in_at)::text,'<NULL>'),
      coalesce(extract(epoch FROM tc.adjusted_clock_out_at)::text,'<NULL>'),
      encode(convert_to(coalesce(tc.adjusted_reason,'<NULL>'),'UTF8'),'hex'),
      coalesce(tc.adjusted_by::text,'<NULL>'),
      coalesce(extract(epoch FROM tc.adjusted_at)::text,'<NULL>')
    ),E'\n' ORDER BY tc.id),'')) AS fingerprint
  FROM public.time_clock tc
)
SELECT jsonb_build_object(
  'verification','M12_PRE_OK',
  'legacy_time_clock_schema',jsonb_build_object(
    'item_count',s.item_count,'fingerprint',s.fingerprint
  ),
  'legacy_time_clock_data',jsonb_build_object(
    'row_count',d.row_count,'fingerprint',d.fingerprint
  ),
  'm11_generator_oid',to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)')::text,
  'm12_importer_absent',to_regprocedure('public.wak_import_legacy_clock_adjustments(text,date,uuid)') IS NULL
) AS migration_12_pre
FROM legacy_schema s CROSS JOIN legacy_data d;
