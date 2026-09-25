/* Read-only verification for Migration 010. */
DO $post_migration$
DECLARE
  v_table text;
  v_sequence text;
  v_policy text;
  v_actual integer;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M10_POST: run as postgres in Supabase SQL Editor';
  END IF;

  SELECT count(*) INTO v_actual
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r'
    AND c.relname IN ('payroll_periods','work_periods','work_period_versions','work_period_anomalies');
  IF v_actual <> 4 THEN
    RAISE EXCEPTION 'M10_POST: expected exactly four canonical tables, found %', v_actual;
  END IF;

  /* Exact column count, order, type, and nullability. */
  WITH expected(table_name, ordinal_position, column_name, data_type, is_nullable) AS (VALUES
    ('payroll_periods',1,'id','bigint','NO'),('payroll_periods',2,'store_id','text','NO'),
    ('payroll_periods',3,'week_start','date','NO'),('payroll_periods',4,'week_end','date','NO'),
    ('payroll_periods',5,'timezone','text','NO'),('payroll_periods',6,'shadow_status','text','NO'),
    ('payroll_periods',7,'generation_version','integer','NO'),('payroll_periods',8,'last_refreshed_at','timestamp with time zone','YES'),
    ('payroll_periods',9,'created_at','timestamp with time zone','NO'),
    ('work_periods',1,'id','bigint','NO'),('work_periods',2,'store_id','text','NO'),
    ('work_periods',3,'staff_id','uuid','NO'),('work_periods',4,'payroll_period_id','bigint','NO'),
    ('work_periods',5,'source_type','text','NO'),('work_periods',6,'time_clock_id','bigint','YES'),
    ('work_periods',7,'matched_shift_id','bigint','YES'),('work_periods',8,'status','text','NO'),
    ('work_periods',9,'current_version_id','bigint','YES'),('work_periods',10,'created_by','uuid','YES'),
    ('work_periods',11,'created_at','timestamp with time zone','NO'),('work_periods',12,'updated_at','timestamp with time zone','NO'),
    ('work_period_versions',1,'id','bigint','NO'),('work_period_versions',2,'work_period_id','bigint','NO'),
    ('work_period_versions',3,'version_number','integer','NO'),('work_period_versions',4,'disposition','text','NO'),
    ('work_period_versions',5,'matched_shift_id','bigint','YES'),('work_period_versions',6,'actual_start_at','timestamp with time zone','YES'),
    ('work_period_versions',7,'actual_end_at','timestamp with time zone','YES'),('work_period_versions',8,'payable_start_at','timestamp with time zone','YES'),
    ('work_period_versions',9,'payable_end_at','timestamp with time zone','YES'),('work_period_versions',10,'reason_code','text','NO'),
    ('work_period_versions',11,'reason_note','text','YES'),('work_period_versions',12,'change_source','text','NO'),
    ('work_period_versions',13,'created_by','uuid','YES'),('work_period_versions',14,'created_at','timestamp with time zone','NO'),
    ('work_period_anomalies',1,'id','bigint','NO'),('work_period_anomalies',2,'work_period_id','bigint','NO'),
    ('work_period_anomalies',3,'anomaly_type','text','NO'),('work_period_anomalies',4,'severity','text','NO'),
    ('work_period_anomalies',5,'status','text','NO'),('work_period_anomalies',6,'details','jsonb','NO'),
    ('work_period_anomalies',7,'detected_at','timestamp with time zone','NO'),('work_period_anomalies',8,'resolved_by','uuid','YES'),
    ('work_period_anomalies',9,'resolved_at','timestamp with time zone','YES'),('work_period_anomalies',10,'resolution_reason_code','text','YES'),
    ('work_period_anomalies',11,'resolution_note','text','YES'),('work_period_anomalies',12,'resolution_version_id','bigint','YES')
  ), actual AS (
    SELECT table_name, ordinal_position, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name IN
      ('payroll_periods','work_periods','work_period_versions','work_period_anomalies')
  )
  SELECT count(*) INTO v_actual FROM (
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  ) AS differences;
  IF v_actual <> 0 THEN
    RAISE EXCEPTION 'M10_POST: column contract has % differences', v_actual;
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema='public' AND table_name IN
        ('payroll_periods','work_periods','work_period_versions','work_period_anomalies')
        AND column_name='id' AND is_identity='YES') <> 4 THEN
    RAISE EXCEPTION 'M10_POST: identity contract failed';
  END IF;

  IF EXISTS (
    SELECT expected.table_name, expected.column_name
    FROM (VALUES
      ('payroll_periods','timezone','''Australia/Melbourne''::text'),
      ('payroll_periods','shadow_status','''BUILDING''::text'),
      ('payroll_periods','generation_version','1'),
      ('payroll_periods','created_at','now()'),
      ('work_periods','status','''NEEDS_REVIEW''::text'),
      ('work_periods','created_at','now()'),('work_periods','updated_at','now()'),
      ('work_period_versions','disposition','''ACTIVE''::text'),
      ('work_period_versions','created_at','now()'),
      ('work_period_anomalies','status','''OPEN''::text'),
      ('work_period_anomalies','details','''{}''::jsonb'),
      ('work_period_anomalies','detected_at','now()')
    ) AS expected(table_name,column_name,column_default)
    LEFT JOIN information_schema.columns AS c
      ON c.table_schema='public' AND c.table_name=expected.table_name
      AND c.column_name=expected.column_name
    WHERE c.column_default IS DISTINCT FROM expected.column_default
  ) THEN
    RAISE EXCEPTION 'M10_POST: default-value contract differs';
  END IF;

  /* Named constraints include PKs, source/range checks, and same-parent composite FKs. */
  IF EXISTS (
    SELECT required.name FROM (VALUES
      ('payroll_periods_pkey'),('payroll_periods_store_week_key'),
      ('payroll_periods_week_range_check'),('payroll_periods_thursday_check'),
      ('payroll_periods_timezone_check'),('payroll_periods_shadow_status_check'),
      ('payroll_periods_generation_version_check'),('work_periods_pkey'),
      ('work_periods_staff_fk'),('work_periods_payroll_period_fk'),('work_periods_time_clock_fk'),
      ('work_periods_matched_shift_fk'),('work_periods_created_by_fk'),
      ('work_periods_source_type_check'),('work_periods_status_check'),
      ('work_periods_source_consistency_check'),('work_periods_current_version_same_period_fk'),
      ('work_period_versions_pkey'),('work_period_versions_period_version_key'),
      ('work_period_versions_id_period_key'),('work_period_versions_work_period_fk'),
      ('work_period_versions_matched_shift_fk'),('work_period_versions_created_by_fk'),
      ('work_period_versions_number_check'),('work_period_versions_disposition_check'),
      ('work_period_versions_change_source_check'),('work_period_versions_actual_range_check'),
      ('work_period_versions_payable_range_check'),('work_period_versions_reason_code_check'),
      ('work_period_versions_other_note_check'),('work_period_versions_actor_check'),
      ('work_period_anomalies_pkey'),('work_period_anomalies_work_period_fk'),
      ('work_period_anomalies_resolved_by_fk'),('work_period_anomalies_resolution_same_period_fk'),
      ('work_period_anomalies_type_check'),('work_period_anomalies_severity_check'),
      ('work_period_anomalies_status_check'),('work_period_anomalies_details_check'),
      ('work_period_anomalies_other_note_check')
    ) AS required(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint AS c WHERE c.conname=required.name)
  ) THEN
    RAISE EXCEPTION 'M10_POST: required constraint is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conname IN (
      'work_periods_staff_fk','work_periods_payroll_period_fk','work_periods_time_clock_fk',
      'work_periods_matched_shift_fk','work_periods_created_by_fk',
      'work_period_versions_work_period_fk','work_period_versions_matched_shift_fk',
      'work_period_versions_created_by_fk','work_periods_current_version_same_period_fk',
      'work_period_anomalies_work_period_fk','work_period_anomalies_resolved_by_fk',
      'work_period_anomalies_resolution_same_period_fk'
    ) AND (c.confdeltype <> 'a' OR c.confupdtype <> 'a')
  ) THEN
    RAISE EXCEPTION 'M10_POST: an evidence FK is not NO ACTION';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid='public.work_periods'::regclass
      AND c.conname='work_periods_current_version_same_period_fk'
      AND pg_catalog.pg_get_constraintdef(c.oid,true) =
        'FOREIGN KEY (current_version_id, id) REFERENCES work_period_versions(id, work_period_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS c
    WHERE c.conrelid='public.work_period_anomalies'::regclass
      AND c.conname='work_period_anomalies_resolution_same_period_fk'
      AND pg_catalog.pg_get_constraintdef(c.oid,true) =
        'FOREIGN KEY (resolution_version_id, work_period_id) REFERENCES work_period_versions(id, work_period_id)'
  ) THEN
    RAISE EXCEPTION 'M10_POST: same-work-period composite FK differs';
  END IF;

  IF EXISTS (
    SELECT required.name FROM (VALUES
      ('work_periods_time_clock_unique'),('work_periods_period_status_idx'),
      ('work_periods_staff_period_idx'),('work_periods_matched_shift_idx'),
      ('work_period_anomalies_open_type_unique'),
      ('work_period_anomalies_status_severity_period_idx'),('work_period_anomalies_type_idx')
    ) AS required(name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes AS i
      WHERE i.schemaname='public' AND i.indexname=required.name)
  ) THEN
    RAISE EXCEPTION 'M10_POST: required index is missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public'
      AND indexname='work_periods_time_clock_unique' AND indexdef ILIKE '%WHERE (time_clock_id IS NOT NULL)%')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public'
      AND indexname='work_period_anomalies_open_type_unique' AND indexdef ILIKE '%WHERE (status = ''OPEN''::text)%') THEN
    RAISE EXCEPTION 'M10_POST: partial uniqueness predicates differ';
  END IF;

  FOR v_table, v_policy IN SELECT * FROM (VALUES
    ('payroll_periods','Active Manager/Owner can read payroll periods'),
    ('work_periods','Active Manager/Owner can read work periods'),
    ('work_period_versions','Active Manager/Owner can read work period versions'),
    ('work_period_anomalies','Active Manager/Owner can read work period anomalies')
  ) AS x(table_name, policy_name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=v_table
        AND c.relrowsecurity AND NOT c.relforcerowsecurity) THEN
      RAISE EXCEPTION 'M10_POST: RLS flags differ for %', v_table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies AS p
      WHERE p.schemaname='public' AND p.tablename=v_table AND p.policyname=v_policy
        AND p.cmd='SELECT' AND p.roles=ARRAY['authenticated']::name[]
        AND p.qual ILIKE '%is_active IS TRUE%'
        AND p.qual ILIKE '%MANAGER%' AND p.qual ILIKE '%OWNER%') THEN
      RAISE EXCEPTION 'M10_POST: SELECT policy differs for %', v_table;
    END IF;
    IF NOT pg_catalog.has_table_privilege('authenticated','public.'||v_table,'SELECT')
       OR pg_catalog.has_table_privilege('authenticated','public.'||v_table,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR pg_catalog.has_table_privilege('anon','public.'||v_table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'M10_POST: table ACL differs for %', v_table;
    END IF;
  END LOOP;

  FOREACH v_sequence IN ARRAY ARRAY[
    'payroll_periods_id_seq','work_periods_id_seq',
    'work_period_versions_id_seq','work_period_anomalies_id_seq'
  ] LOOP
    IF pg_catalog.to_regclass('public.'||v_sequence) IS NULL
       OR pg_catalog.has_sequence_privilege('authenticated','public.'||v_sequence,'USAGE,SELECT,UPDATE')
       OR pg_catalog.has_sequence_privilege('anon','public.'||v_sequence,'USAGE,SELECT,UPDATE') THEN
      RAISE EXCEPTION 'M10_POST: sequence ACL differs for %', v_sequence;
    END IF;
  END LOOP;
END
$post_migration$;

/* Must exactly match the read-only pre-migration legacy fingerprint. */
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

SELECT 'M10_POST_OK' AS result;
