BEGIN;

DROP POLICY IF EXISTS "STAFF insert time_clock (own)" ON public.time_clock;
DROP POLICY IF EXISTS "STAFF update time_clock (own)" ON public.time_clock;
DROP POLICY IF EXISTS "time_clock_self_anyrole_insert" ON public.time_clock;
DROP POLICY IF EXISTS "time_clock_self_anyrole_update" ON public.time_clock;

CREATE POLICY "STAFF insert time_clock (own)"
ON public.time_clock
FOR INSERT
TO authenticated
WITH CHECK (
  (app_role() = 'STAFF'::text) AND (staff_id = auth.uid())
);

CREATE POLICY "STAFF update time_clock (own)"
ON public.time_clock
FOR UPDATE
TO authenticated
USING (
  (app_role() = 'STAFF'::text) AND (staff_id = auth.uid())
)
WITH CHECK (
  (app_role() = 'STAFF'::text) AND (staff_id = auth.uid())
);

CREATE POLICY "time_clock_self_anyrole_insert"
ON public.time_clock
FOR INSERT
TO authenticated
WITH CHECK (staff_id = auth.uid());

CREATE POLICY "time_clock_self_anyrole_update"
ON public.time_clock
FOR UPDATE
TO authenticated
USING (staff_id = auth.uid())
WITH CHECK (staff_id = auth.uid());

COMMIT;
