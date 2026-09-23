/*
 * Migration 2 pre-migration capture. READ ONLY.
 * Export or retain every result set for comparison with the post-migration
 * verification. This script does not modify database state.
 */

-- Exact definition, owner and options.
SELECT
  pg_get_userbyid(c.relowner) AS owner_name,
  c.reloptions AS view_options,
  obj_description(c.oid, 'pg_class') AS comment,
  pg_get_viewdef(c.oid, true) AS view_definition
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n
  ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'v_owner_daily_breakdown'
  AND c.relkind = 'v';

-- Output contract.
SELECT
  ordinal_position,
  column_name,
  data_type,
  udt_schema,
  udt_name,
  is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'v_owner_daily_breakdown'
ORDER BY ordinal_position;

-- Effective object grants.
SELECT
  grantee,
  privilege_type,
  is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name = 'v_owner_daily_breakdown'
ORDER BY grantee, privilege_type;

-- Current relation dependencies. platform_fee_settings should appear here.
SELECT
  view_schema,
  view_name,
  table_schema AS referenced_schema,
  table_name AS referenced_relation
FROM information_schema.view_table_usage
WHERE view_schema = 'public'
  AND view_name = 'v_owner_daily_breakdown'
ORDER BY referenced_schema, referenced_relation;

-- Representative historical results, including their inferred source stores.
SELECT
  v.*,
  stores.source_store_ids
FROM public.v_owner_daily_breakdown AS v
LEFT JOIN LATERAL (
  SELECT array_agg(DISTINCT d.store_id ORDER BY d.store_id) AS source_store_ids
  FROM public.daily_sales_totals AS d
  WHERE d.business_date = v.date
) AS stores ON true
ORDER BY v.date DESC
LIMIT 30;

/*
 * Unrelated-object fingerprints. Re-run the equivalent section in the post
 * script and compare each count/hash. The target view is excluded.
 */
WITH fingerprints AS (
  SELECT
    'columns'::text AS category,
    format(
      '%s.%s|%s|%s|%s|%s|%s',
      n.nspname,
      c.relname,
      a.attnum,
      a.attname,
      pg_catalog.format_type(a.atttypid, a.atttypmod),
      a.attnotnull,
      COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '')
    ) AS item
  FROM pg_catalog.pg_attribute AS a
  JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef AS ad
    ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND c.relname <> 'v_owner_daily_breakdown'
    AND a.attnum > 0
    AND NOT a.attisdropped

  UNION ALL
  SELECT
    'relations',
    format('%s.%s|%s|%s|%s|%s|%s', n.nspname, c.relname, c.relkind,
      pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity,
      COALESCE(c.reloptions::text, ''))
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND c.relname <> 'v_owner_daily_breakdown'

  UNION ALL
  SELECT
    'constraints',
    format('%s.%s|%s|%s', n.nspname, c.relname, con.conname,
      pg_get_constraintdef(con.oid, true))
  FROM pg_catalog.pg_constraint AS con
  JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'

  UNION ALL
  SELECT
    'indexes',
    format('%s.%s|%s|%s', schemaname, tablename, indexname, indexdef)
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public'

  UNION ALL
  SELECT
    'policies',
    format('%s.%s|%s|%s|%s|%s|%s|%s', schemaname, tablename,
      policyname, permissive, roles::text, cmd, COALESCE(qual, ''),
      COALESCE(with_check, ''))
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'

  UNION ALL
  SELECT
    'triggers',
    format('%s.%s|%s|%s', n.nspname, c.relname, t.tgname,
      pg_get_triggerdef(t.oid, true))
  FROM pg_catalog.pg_trigger AS t
  JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal
)
SELECT
  category,
  count(*) AS item_count,
  md5(string_agg(item, E'\n' ORDER BY item)) AS fingerprint
FROM fingerprints
GROUP BY category
ORDER BY category;
