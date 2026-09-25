BEGIN;

/* Remove only Migration 010 objects, in dependency-safe order. */
DROP TABLE IF EXISTS public.work_period_anomalies;
ALTER TABLE IF EXISTS public.work_periods
  DROP CONSTRAINT IF EXISTS work_periods_current_version_same_period_fk;
DROP TABLE IF EXISTS public.work_period_versions;
DROP TABLE IF EXISTS public.work_periods;
DROP TABLE IF EXISTS public.payroll_periods;

COMMIT;
