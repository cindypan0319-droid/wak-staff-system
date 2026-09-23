BEGIN;

/* Restore only the previously verified non-grantable client-role DML grants. */
GRANT INSERT, UPDATE, DELETE, TRUNCATE
ON TABLE public.cashup_sessions, public.daily_sales, public.platform_income
TO anon, authenticated;

CREATE POLICY cashup_insert_own ON public.cashup_sessions
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    (entered_by = auth.uid()) OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role])
    )
  );

CREATE POLICY cashup_update_own ON public.cashup_sessions
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (
    (entered_by = auth.uid()) OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role])
    )
  )
  WITH CHECK (
    (entered_by = auth.uid()) OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role])
    )
  );

CREATE POLICY "Owner/Manager can delete - daily_sales" ON public.daily_sales
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ("current_role"() = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role]));
CREATE POLICY "Owner/Manager can insert - daily_sales" ON public.daily_sales
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ("current_role"() = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role]));
CREATE POLICY "Owner/Manager can update - daily_sales" ON public.daily_sales
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ("current_role"() = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role]))
  WITH CHECK ("current_role"() = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role]));
CREATE POLICY "Staff can insert own - daily_sales" ON public.daily_sales
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    entered_by = auth.uid() AND EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid() AND p.role = 'STAFF'::public.user_role
        AND p.is_active = true
    )
  );
CREATE POLICY daily_sales_insert_own ON public.daily_sales
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    (entered_by = auth.uid()) OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role])
    )
  );
CREATE POLICY daily_sales_update_own ON public.daily_sales
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (
    (entered_by = auth.uid()) OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role])
    )
  )
  WITH CHECK (
    (entered_by = auth.uid()) OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role])
    )
  );

CREATE POLICY "Owner/Manager can delete - platform_income" ON public.platform_income
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ("current_role"() = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role]));
CREATE POLICY "Owner/Manager can insert - platform_income" ON public.platform_income
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ("current_role"() = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role]));
CREATE POLICY "Owner/Manager can update - platform_income" ON public.platform_income
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ("current_role"() = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role]))
  WITH CHECK ("current_role"() = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role]));
CREATE POLICY platform_income_insert_own ON public.platform_income
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    (entered_by = auth.uid()) OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role])
    )
  );
CREATE POLICY platform_income_manager_owner_all ON public.platform_income
  AS PERMISSIVE FOR ALL TO authenticated
  USING (app_role() = ANY (ARRAY['OWNER'::text, 'MANAGER'::text]))
  WITH CHECK (app_role() = ANY (ARRAY['OWNER'::text, 'MANAGER'::text]));
CREATE POLICY platform_income_staff_insert_own ON public.platform_income
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (entered_by = auth.uid());
CREATE POLICY platform_income_update_own ON public.platform_income
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (
    (entered_by = auth.uid()) OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role])
    )
  )
  WITH CHECK (
    (entered_by = auth.uid()) OR EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid()
        AND p.role = ANY (ARRAY['OWNER'::public.user_role, 'MANAGER'::public.user_role])
    )
  );

/* Fail atomically if reconstructed definitions do not match the captured baseline. */
DO $verify$
DECLARE
  v_table text;
  v_role text;
  v_privilege text;
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname='public') <> 74
     OR (SELECT md5(string_agg(
       format('%s.%s|%s|%s|%s|%s|%s|%s',
         schemaname,tablename,policyname,permissive,roles::text,cmd,
         COALESCE(qual,''),COALESCE(with_check,'')),
       E'\n' ORDER BY schemaname,tablename,policyname
     )) FROM pg_catalog.pg_policies WHERE schemaname='public')
       <> '96333950f5cb0a0ae9375bb5612773fa' THEN
    RAISE EXCEPTION 'M5_ROLLBACK: restored policy fingerprint differs from baseline';
  END IF;
  FOREACH v_table IN ARRAY ARRAY['cashup_sessions','daily_sales','platform_income'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role','postgres'] LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
      ] LOOP
        IF pg_catalog.has_table_privilege(v_role,'public.' || v_table,v_privilege) IS NOT TRUE THEN
          RAISE EXCEPTION 'M5_ROLLBACK: %.% not restored on %',v_role,v_privilege,v_table;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END
$verify$;

COMMIT;
