/* READ ONLY. Run before Migration 008. */
DO $verify$
DECLARE
  v_column text;
  v_policy text;
BEGIN
  IF session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M8_PRE: run as postgres in Supabase SQL Editor';
  END IF;

  IF to_regprocedure('public.wak_clock_in_for_actor(uuid,text)') IS NOT NULL
     OR to_regprocedure('public.wak_clock_out_for_actor(uuid,bigint)') IS NOT NULL THEN
    RAISE EXCEPTION 'M8_PRE: Migration 008 function already exists';
  END IF;

  FOREACH v_column IN ARRAY ARRAY[
    'id', 'shift_id', 'staff_id', 'clock_in_at', 'clock_out_at',
    'device_tag', 'created_at', 'adjusted_clock_in_at',
    'adjusted_clock_out_at', 'adjusted_reason', 'adjusted_by', 'adjusted_at'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns AS c
      WHERE c.table_schema = 'public'
        AND c.table_name = 'time_clock'
        AND c.column_name = v_column
    ) THEN
      RAISE EXCEPTION 'M8_PRE: missing time_clock.%', v_column;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'time_clock'
      AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'M8_PRE: time_clock RLS is not enabled';
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
    RAISE EXCEPTION 'M8_PRE: expected time_clock_one_open index is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'time_clock'
      AND con.contype = 'p'
      AND pg_catalog.pg_get_constraintdef(con.oid) = 'PRIMARY KEY (id)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS rel ON rel.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND rel.relname = 'time_clock'
      AND con.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(con.oid) ILIKE
        '%clock_out_at IS NULL%clock_in_at IS NOT NULL%'
  ) THEN
    RAISE EXCEPTION 'M8_PRE: expected time_clock PK/CHECK contract changed';
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
      RAISE EXCEPTION 'M8_PRE: required Phase A policy % is missing', v_policy;
    END IF;
  END LOOP;
END
$verify$;

/* Export these two rows and compare them with the post-migration output. */
SELECT 'time_clock_policy' AS fingerprint_type,
       count(*) AS item_count,
       md5(string_agg(
         format('%s|%s|%s|%s|%s|%s', policyname, permissive, roles::text,
                cmd, COALESCE(qual, ''), COALESCE(with_check, '')),
         E'\n' ORDER BY policyname
       )) AS fingerprint
FROM pg_catalog.pg_policies
WHERE schemaname = 'public' AND tablename = 'time_clock'
UNION ALL
SELECT 'time_clock_direct_acl', count(*), md5(string_agg(
         format('%s|%s|%s', acl.grantee, acl.privilege_type, acl.is_grantable),
         E'\n' ORDER BY acl.grantee, acl.privilege_type, acl.is_grantable
       ))
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, '{}'::aclitem[])) AS acl
WHERE n.nspname = 'public' AND c.relname = 'time_clock';
