/* Read-only verification for Migration 012. Returns one consolidated JSON row. */
DO $post$
DECLARE v_function oid := to_regprocedure('public.wak_import_legacy_clock_adjustments(text,date,uuid)');
BEGIN
  IF session_user<>'postgres' THEN
    RAISE EXCEPTION 'M12_POST: run as postgres';
  END IF;
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'M12_POST: importer is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.oid=v_function AND p.prosecdef AND r.rolname='postgres'
      AND pg_catalog.pg_get_function_result(p.oid)='jsonb'
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public']
  ) THEN
    RAISE EXCEPTION 'M12_POST: signature/owner/security/search_path differs';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
       WHERE p.oid=v_function AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
     )
     OR has_function_privilege('anon',v_function,'EXECUTE')
     OR has_function_privilege('authenticated',v_function,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
    RAISE EXCEPTION 'M12_POST: function ACL differs';
  END IF;
END
$post$;

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
), function_contract AS (
  SELECT p.oid,p.prosecdef,r.rolname AS owner_name,
    pg_catalog.pg_get_function_result(p.oid) AS result_type,
    p.proconfig,
    pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) AS definition_hash
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
  WHERE p.oid=to_regprocedure('public.wak_import_legacy_clock_adjustments(text,date,uuid)')
)
SELECT jsonb_build_object(
  'verification','M12_POST_OK',
  'legacy_time_clock_schema',jsonb_build_object(
    'item_count',s.item_count,'fingerprint',s.fingerprint
  ),
  'legacy_time_clock_data',jsonb_build_object(
    'row_count',d.row_count,'fingerprint',d.fingerprint
  ),
  'importer',jsonb_build_object(
    'signature','public.wak_import_legacy_clock_adjustments(text,date,uuid)',
    'security_definer',f.prosecdef,
    'owner',f.owner_name,
    'result_type',f.result_type,
    'search_path',f.proconfig,
    'definition_hash',f.definition_hash,
    'public_execute',EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p,
      LATERAL pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
      WHERE p.oid=f.oid AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
    ),
    'anon_execute',has_function_privilege('anon',f.oid,'EXECUTE'),
    'authenticated_execute',has_function_privilege('authenticated',f.oid,'EXECUTE'),
    'service_role_execute',has_function_privilege('service_role',f.oid,'EXECUTE')
  )
) AS migration_12_post
FROM legacy_schema s CROSS JOIN legacy_data d CROSS JOIN function_contract f;
