/* Read-only pre-migration verification for Migration 014. */
WITH contract AS (
  SELECT
    to_regprocedure('public.wak_review_work_period(bigint,bigint,uuid,bigint,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text)') IS NULL
      AS review_rpc_absent,
    to_regprocedure('public.wak_refresh_attendance_shadow(text,date,uuid)') IS NOT NULL
      AS shadow_generator_present,
    to_regclass('public.work_periods') IS NOT NULL AS work_periods_present,
    to_regclass('public.work_period_versions') IS NOT NULL AS versions_present,
    to_regclass('public.work_period_anomalies') IS NOT NULL AS anomalies_present,
    EXISTS(
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid='public.work_periods'::regclass
        AND conname='work_periods_current_version_same_period_fk'
    ) AS current_version_fk_present,
    EXISTS(
      SELECT 1 FROM pg_catalog.pg_indexes
      WHERE schemaname='public' AND indexname='work_periods_time_clock_unique'
        AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
    ) AS one_clock_unique_present
)
SELECT jsonb_build_object(
  'result',CASE WHEN review_rpc_absent AND shadow_generator_present
    AND work_periods_present AND versions_present AND anomalies_present
    AND current_version_fk_present AND one_clock_unique_present
    THEN 'M14_PRE_OK' ELSE 'M14_PRE_FAILED' END,
  'review_rpc_absent',review_rpc_absent,
  'shadow_generator_present',shadow_generator_present,
  'work_periods_present',work_periods_present,
  'versions_present',versions_present,
  'anomalies_present',anomalies_present,
  'current_version_fk_present',current_version_fk_present,
  'one_clock_unique_present',one_clock_unique_present,
  'canonical_table_count',(
    SELECT count(*) FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r'
      AND c.relname IN ('payroll_periods','work_periods','work_period_versions','work_period_anomalies')
  )
) AS verification
FROM contract;
