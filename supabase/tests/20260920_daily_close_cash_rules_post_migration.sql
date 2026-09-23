/* Migration 4 post-migration verification. READ ONLY. */

-- Signature and security metadata must match pre-migration output.
SELECT
  p.oid::regprocedure::text AS function_signature,
  pg_get_userbyid(p.proowner) AS owner_name,
  p.prosecdef AS security_definer,
  p.proconfig AS function_config,
  p.proacl AS raw_acl,
  md5(pg_get_functiondef(p.oid)) AS definition_hash,
  pg_get_functiondef(p.oid) AS function_definition
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.oid =
    'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure;

-- Execution privileges must match pre-migration output exactly.
SELECT
  role_name,
  has_function_privilege(
    role_name,
    'public._wak_apply_daily_close(jsonb,boolean,boolean)',
    'EXECUTE'
  ) AS can_execute
FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS roles(role_name)
ORDER BY role_name;

SELECT
  CASE acl.grantee
    WHEN 0 THEN 'PUBLIC'
    ELSE pg_get_userbyid(acl.grantee)
  END AS grantee,
  acl.privilege_type,
  acl.is_grantable
FROM pg_catalog.pg_proc AS p
CROSS JOIN LATERAL pg_catalog.aclexplode(
  COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
) AS acl
WHERE p.oid =
  'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
ORDER BY grantee, acl.privilege_type;

-- The expected_cash column and CHECK constraints must be unchanged.
SELECT
  c.ordinal_position,
  c.column_name,
  c.data_type,
  c.udt_schema,
  c.udt_name,
  c.is_nullable,
  c.column_default
FROM information_schema.columns AS c
WHERE c.table_schema = 'public'
  AND c.table_name = 'daily_sales'
  AND c.column_name = 'expected_cash';

SELECT
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid, true) AS constraint_definition
FROM pg_catalog.pg_constraint AS con
WHERE con.conrelid = 'public.daily_sales'::regclass
  AND con.contype = 'c'
ORDER BY con.conname;

-- Prove that the installed definition exposes contract v2 and all new fields.
SELECT
  position(
    '''close_contract_version'', 2' IN pg_get_functiondef(
      'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
    )
  ) > 0 AS returns_contract_version_2,
  position(
    '''counted_daily_cash_movement''' IN pg_get_functiondef(
      'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
    )
  ) > 0 AS returns_counted_daily_cash_movement,
  position(
    '''target_closing_float''' IN pg_get_functiondef(
      'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
    )
  ) > 0 AS returns_target_closing_float,
  position(
    '''target_removed_cash''' IN pg_get_functiondef(
      'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
    )
  ) > 0 AS returns_target_removed_cash,
  position(
    '''projected_closing_float''' IN pg_get_functiondef(
      'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
    )
  ) > 0 AS returns_projected_closing_float,
  position(
    '''closing_float_variance''' IN pg_get_functiondef(
      'public._wak_apply_daily_close(jsonb,boolean,boolean)'::regprocedure
    )
  ) > 0 AS returns_closing_float_variance;

-- Migration 3 may be absent or present. If present, it must still delegate.
SELECT
  to_regprocedure(
    'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
  ) AS notes_wrapper_signature,
  CASE
    WHEN to_regprocedure(
      'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
    ) IS NULL THEN NULL
    ELSE md5(pg_get_functiondef(to_regprocedure(
      'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
    )))
  END AS notes_wrapper_definition_hash,
  CASE
    WHEN to_regprocedure(
      'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
    ) IS NULL THEN NULL
    ELSE position(
      'public._wak_apply_daily_close(' IN
      pg_get_functiondef(to_regprocedure(
        'public._wak_apply_daily_close_with_notes(jsonb,boolean,boolean)'
      ))
    ) > 0
  END AS notes_wrapper_delegates_to_core_by_name;

-- Every fingerprint must match the pre-migration output exactly.
WITH fingerprints AS (
  SELECT
    'columns'::text AS category,
    format('%s.%s|%s|%s|%s|%s|%s', n.nspname, c.relname, a.attnum,
      a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod),
      a.attnotnull, COALESCE(pg_get_expr(ad.adbin, ad.adrelid), '')) AS item
  FROM pg_catalog.pg_attribute AS a
  JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_attrdef AS ad
    ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm')
    AND a.attnum > 0
    AND NOT a.attisdropped

  UNION ALL
  SELECT 'relations',
    format('%s.%s|%s|%s|%s|%s|%s', n.nspname, c.relname, c.relkind,
      pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity,
      COALESCE(c.reloptions::text, ''))
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm')

  UNION ALL
  SELECT 'constraints',
    format('%s.%s|%s|%s', n.nspname, c.relname, con.conname,
      pg_get_constraintdef(con.oid, true))
  FROM pg_catalog.pg_constraint AS con
  JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'

  UNION ALL
  SELECT 'indexes',
    format('%s.%s|%s|%s', schemaname, tablename, indexname, indexdef)
  FROM pg_catalog.pg_indexes
  WHERE schemaname = 'public'

  UNION ALL
  SELECT 'policies',
    format('%s.%s|%s|%s|%s|%s|%s|%s', schemaname, tablename,
      policyname, permissive, roles::text, cmd, COALESCE(qual, ''),
      COALESCE(with_check, ''))
  FROM pg_catalog.pg_policies
  WHERE schemaname = 'public'

  UNION ALL
  SELECT 'triggers',
    format('%s.%s|%s|%s', n.nspname, c.relname, t.tgname,
      pg_get_triggerdef(t.oid, true))
  FROM pg_catalog.pg_trigger AS t
  JOIN pg_catalog.pg_class AS c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal

  UNION ALL
  SELECT 'views',
    format('%s.%s|%s', schemaname, viewname, definition)
  FROM pg_catalog.pg_views
  WHERE schemaname = 'public'
)
SELECT
  category,
  count(*) AS item_count,
  md5(string_agg(item, E'\n' ORDER BY item)) AS fingerprint
FROM fingerprints
GROUP BY category
ORDER BY category;
