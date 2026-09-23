BEGIN;

/*
 * Migration 4: separate actual opening cash reconciliation from the fixed
 * $400 closing-float target.
 *
 * daily_sales.expected_cash remains a compatibility field and now stores the
 * unclamped counted daily cash movement (night total minus actual opening
 * float). Pre-v2 historical rows are not rewritten; a historical stored zero
 * may therefore mean either genuine zero movement or a previously clamped
 * negative movement.
 *
 * This migration replaces only public._wak_apply_daily_close(jsonb, boolean,
 * boolean). All signatures, authorization, locking, revision, platform, fee,
 * discrepancy-reason, store, and transaction behavior remain unchanged.
 */
CREATE OR REPLACE FUNCTION public._wak_apply_daily_close(
  p_payload jsonb,
  p_allow_remove boolean,
  p_correction_only boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_actor uuid;
  v_role text;
  v_is_active boolean;

  v_business_date date;
  v_store_id text;
  v_expected_revision_text text;
  v_expected_revision timestamptz;
  v_current_revision timestamptz;
  v_has_existing_night boolean := false;

  v_night_counts jsonb;
  v_removed_counts jsonb;
  v_night_total numeric;
  v_removed_total numeric;
  v_morning_counts jsonb;
  v_opening_float numeric;

  v_cash_sales numeric;
  v_eftpos_sales numeric;
  v_expected_cash numeric;
  v_counted_daily_cash_movement numeric;
  v_target_closing_float constant numeric := 400.00;
  v_target_removed_cash numeric;
  v_projected_closing_float numeric;
  v_closing_float_variance numeric;
  v_total_sales numeric;
  v_platform_gross_total numeric;
  v_cash_variance numeric;
  v_removed_variance numeric;

  v_cash_difference jsonb;
  v_cash_difference_reason text;
  v_cash_difference_note text;

  v_platform_payload jsonb;
  v_instructions jsonb := '[]'::jsonb;
  v_item jsonb;
  v_raw_platform text;
  v_canonical_platform text;
  v_action text;
  v_gross_income numeric;
  v_seen_platforms text[] := ARRAY[]::text[];

  v_existing record;
  v_existing_found boolean;
  v_new_fees numeric;
  v_fee_recalculations jsonb := '[]'::jsonb;
  v_removed_platforms jsonb := '[]'::jsonb;
  v_confirm_fee_recalculation boolean := false;

  v_night_counts_to_store jsonb;
  v_committed_night public.cashup_sessions%ROWTYPE;
  v_platform_result jsonb;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Daily Close payload must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload ?| ARRAY[
    'entered_by',
    'total_cash',
    'removed_cash',
    'expected_cash',
    'total_sales',
    'fees'
  ] THEN
    RAISE EXCEPTION 'Payload must not contain server-derived or identity fields'
      USING ERRCODE = '22023';
  END IF;

  v_actor := auth.uid();

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required'
      USING ERRCODE = '42501';
  END IF;

  SELECT upper(p.role::text), p.is_active
  INTO v_role, v_is_active
  FROM public.profiles AS p
  WHERE p.id = v_actor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authenticated profile does not exist'
      USING ERRCODE = '42501';
  END IF;

  IF v_is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'Employee profile is inactive'
      USING ERRCODE = '42501';
  END IF;

  IF p_correction_only THEN
    IF v_role NOT IN ('MANAGER', 'OWNER') THEN
      RAISE EXCEPTION 'Only an active OWNER or MANAGER may correct a Daily Close'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_role NOT IN ('STAFF', 'MANAGER', 'OWNER') THEN
    RAISE EXCEPTION 'Role is not permitted to submit a Daily Close'
      USING ERRCODE = '42501';
  END IF;

  BEGIN
    v_business_date := (p_payload ->> 'business_date')::date;
  EXCEPTION
    WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'business_date must be a valid ISO date'
        USING ERRCODE = '22023';
  END;

  IF v_business_date IS NULL THEN
    RAISE EXCEPTION 'business_date is required'
      USING ERRCODE = '22023';
  END IF;

  v_store_id := p_payload ->> 'store_id';

  IF v_store_id IS DISTINCT FROM 'MOOROOLBARK' THEN
    RAISE EXCEPTION 'Store is not authorized for this operation'
      USING ERRCODE = '42501';
  END IF;

  v_night_counts := p_payload -> 'night_counts';
  v_removed_counts := p_payload -> 'removed_counts';
  v_night_total := public._wak_cash_counts_total(v_night_counts, 'night_counts');
  v_removed_total := public._wak_cash_counts_total(v_removed_counts, 'removed_counts');

  IF NOT (p_payload ? 'cash_sales')
     OR jsonb_typeof(p_payload -> 'cash_sales') <> 'number' THEN
    RAISE EXCEPTION 'cash_sales must be an explicit nonnegative JSON number'
      USING ERRCODE = '22023';
  END IF;

  IF NOT (p_payload ? 'eftpos_sales')
     OR jsonb_typeof(p_payload -> 'eftpos_sales') <> 'number' THEN
    RAISE EXCEPTION 'eftpos_sales must be an explicit nonnegative JSON number'
      USING ERRCODE = '22023';
  END IF;

  v_cash_sales := round((p_payload ->> 'cash_sales')::numeric, 2);
  v_eftpos_sales := round((p_payload ->> 'eftpos_sales')::numeric, 2);

  IF v_cash_sales < 0 OR v_eftpos_sales < 0 THEN
    RAISE EXCEPTION 'cash_sales and eftpos_sales must be nonnegative'
      USING ERRCODE = '22023';
  END IF;

  v_cash_difference := COALESCE(p_payload -> 'cash_difference', '{}'::jsonb);

  IF jsonb_typeof(v_cash_difference) <> 'object' THEN
    RAISE EXCEPTION 'cash_difference must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  v_cash_difference_reason := upper(btrim(COALESCE(
    v_cash_difference ->> 'reason',
    ''
  )));
  v_cash_difference_note := btrim(COALESCE(
    v_cash_difference ->> 'note',
    ''
  ));

  IF v_cash_difference_reason NOT IN (
    '',
    'FLOAT_CHANGED',
    'CASH_REFUND_OR_PAYOUT',
    'CASH_DROP_NOT_COUNTED',
    'COUNTING_MISTAKE',
    'POS_CASH_ADJUSTMENT',
    'OTHER'
  ) THEN
    RAISE EXCEPTION 'Unsupported cash difference reason'
      USING ERRCODE = '22023';
  END IF;

  IF length(v_cash_difference_note) > 1000 THEN
    RAISE EXCEPTION 'Cash difference note is too long'
      USING ERRCODE = '22023';
  END IF;

  v_platform_payload := p_payload -> 'platforms';

  IF v_platform_payload IS NULL
     OR jsonb_typeof(v_platform_payload) <> 'array' THEN
    RAISE EXCEPTION 'platforms must be a complete JSON array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_payload -> 'confirm_fee_recalculation') = 'boolean' THEN
    v_confirm_fee_recalculation :=
      (p_payload -> 'confirm_fee_recalculation') = 'true'::jsonb;
  END IF;

  FOR v_item IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements(v_platform_payload)
  LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'Every platform instruction must be a JSON object'
        USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_object_keys(v_item) AS supplied(key)
      WHERE supplied.key NOT IN ('platform', 'action', 'gross_income')
    ) THEN
      RAISE EXCEPTION 'Platform instruction contains unsupported fields'
        USING ERRCODE = '22023';
    END IF;

    v_raw_platform := btrim(COALESCE(v_item ->> 'platform', ''));
    v_canonical_platform := public._wak_canonical_platform(v_raw_platform);
    v_action := upper(btrim(COALESCE(v_item ->> 'action', '')));

    IF v_raw_platform = '' OR v_canonical_platform = '' THEN
      RAISE EXCEPTION 'Every platform instruction requires a platform name'
        USING ERRCODE = '22023';
    END IF;

    IF v_canonical_platform = ANY (v_seen_platforms) THEN
      RAISE EXCEPTION
        'Duplicate canonical platform instruction: %', v_canonical_platform
        USING ERRCODE = '22023';
    END IF;

    v_seen_platforms := array_append(v_seen_platforms, v_canonical_platform);

    IF v_action = 'SET' THEN
      IF NOT (v_item ? 'gross_income')
         OR jsonb_typeof(v_item -> 'gross_income') <> 'number' THEN
        RAISE EXCEPTION
          'SET instruction for % requires explicit numeric gross_income',
          v_canonical_platform
          USING ERRCODE = '22023';
      END IF;

      v_gross_income := round((v_item ->> 'gross_income')::numeric, 2);

      IF v_gross_income < 0 THEN
        RAISE EXCEPTION 'gross_income for % must be nonnegative', v_canonical_platform
          USING ERRCODE = '22023';
      END IF;

      v_instructions := v_instructions || jsonb_build_array(
        jsonb_build_object(
          'platform', v_canonical_platform,
          'action', 'SET',
          'gross_income', v_gross_income
        )
      );
    ELSIF v_action = 'REMOVE' THEN
      IF NOT p_allow_remove THEN
        RAISE EXCEPTION 'REMOVE is only allowed through correct_daily_close'
          USING ERRCODE = '42501';
      END IF;

      IF (v_item ? 'gross_income')
         AND v_item -> 'gross_income' <> 'null'::jsonb THEN
        RAISE EXCEPTION 'REMOVE instruction must not include gross_income'
          USING ERRCODE = '22023';
      END IF;

      v_instructions := v_instructions || jsonb_build_array(
        jsonb_build_object(
          'platform', v_canonical_platform,
          'action', 'REMOVE'
        )
      );
    ELSE
      RAISE EXCEPTION 'Platform action must be SET or REMOVE'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF NOT (p_payload ? 'expected_night_updated_at') THEN
    RAISE EXCEPTION
      'expected_night_updated_at must be present and may be null for a new close'
      USING ERRCODE = '22023';
  END IF;

  IF p_payload -> 'expected_night_updated_at' = 'null'::jsonb THEN
    v_expected_revision_text := NULL;
  ELSIF jsonb_typeof(p_payload -> 'expected_night_updated_at') = 'string' THEN
    v_expected_revision_text := btrim(
      p_payload ->> 'expected_night_updated_at'
    );

    IF v_expected_revision_text = '' THEN
      RAISE EXCEPTION
        'expected_night_updated_at must be JSON null or a nonempty timestamp string'
        USING ERRCODE = '22023';
    END IF;
  ELSE
    RAISE EXCEPTION
      'expected_night_updated_at must be JSON null or a timestamp string'
      USING ERRCODE = '22023';
  END IF;

  IF v_expected_revision_text IS NOT NULL THEN
    BEGIN
      v_expected_revision := v_expected_revision_text::timestamptz;
    EXCEPTION
      WHEN invalid_text_representation OR datetime_field_overflow THEN
        RAISE EXCEPTION 'expected_night_updated_at must be a valid timestamp'
          USING ERRCODE = '22023';
    END;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_store_id || ':' || v_business_date::text, 0)
  );

  SELECT c.updated_at
  INTO v_current_revision
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = v_store_id
    AND c.session_type = 'NIGHT'
  FOR UPDATE;

  v_has_existing_night := FOUND;

  IF p_correction_only THEN
    IF NOT v_has_existing_night THEN
      RAISE EXCEPTION
        'DAILY_CLOSE_NOT_FOUND: correction requires an existing NIGHT close'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_expected_revision IS NULL
       OR v_expected_revision IS DISTINCT FROM v_current_revision THEN
      RAISE EXCEPTION
        'DAILY_CLOSE_REVISION_CONFLICT: reload the current close before saving'
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF v_has_existing_night THEN
      RAISE EXCEPTION
        'DAILY_CLOSE_ALREADY_EXISTS_USE_CORRECTION: reload the committed close'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_expected_revision IS NOT NULL THEN
      RAISE EXCEPTION
        'DAILY_CLOSE_REVISION_CONFLICT: first submission requires a null revision'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_role = 'STAFF'
       AND (
         EXISTS (
           SELECT 1
           FROM public.daily_sales AS ds
           WHERE ds.business_date = v_business_date
             AND ds.store_id = v_store_id
         )
         OR EXISTS (
           SELECT 1
           FROM public.platform_income AS pi
           WHERE pi.business_date = v_business_date
             AND pi.store_id = v_store_id
         )
       ) THEN
      RAISE EXCEPTION
        'DAILY_CLOSE_LEGACY_PARTIAL_REQUIRES_MANAGER: existing sales or platform data requires manager review'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT c.counts
  INTO v_morning_counts
  FROM public.cashup_sessions AS c
  WHERE c.business_date = v_business_date
    AND c.store_id = v_store_id
    AND c.session_type = 'MORNING'
  FOR SHARE;

  IF FOUND THEN
    BEGIN
      v_opening_float := public._wak_cash_counts_total(
        v_morning_counts,
        'morning_counts'
      );
    EXCEPTION
      WHEN SQLSTATE '22023' THEN
        RAISE EXCEPTION
          'DAILY_CLOSE_LEGACY_MORNING_COUNTS_CONFLICT: existing MORNING counts are empty or malformed'
          USING ERRCODE = 'P0001';
    END;
  ELSE
    v_opening_float := 400.00;
  END IF;

  /* Stabilize platform configuration and fee settings for this transaction. */
  LOCK TABLE public.platforms IN SHARE MODE;
  LOCK TABLE public.platform_fee_settings IN SHARE MODE;

  PERFORM 1
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_business_date
    AND pi.store_id = v_store_id
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.platforms AS p
    WHERE p.is_active IS TRUE
    GROUP BY public._wak_canonical_platform(p.name)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Active platform configuration contains canonical alias duplicates'
      USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.platform_income AS pi
    WHERE pi.business_date = v_business_date
      AND pi.store_id = v_store_id
    GROUP BY public._wak_canonical_platform(pi.platform)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'CANONICAL_ALIAS_COLLISION: existing platform rows require manager review'
      USING ERRCODE = 'P0001';
  END IF;

  /* Every active configured platform must be explicitly SET. */
  FOR v_existing IN
    SELECT DISTINCT public._wak_canonical_platform(p.name) AS canonical_platform
    FROM public.platforms AS p
    WHERE p.is_active IS TRUE
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_instructions) AS instruction(value)
      WHERE instruction.value ->> 'platform' = v_existing.canonical_platform
        AND instruction.value ->> 'action' = 'SET'
    ) THEN
      RAISE EXCEPTION
        'PLATFORM_PARTIAL: active platform % must be explicitly SET',
        v_existing.canonical_platform
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  /* Every existing row, including inactive historical rows, must be addressed. */
  FOR v_existing IN
    SELECT
      pi.id,
      pi.platform,
      public._wak_canonical_platform(pi.platform) AS canonical_platform
    FROM public.platform_income AS pi
    WHERE pi.business_date = v_business_date
      AND pi.store_id = v_store_id
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_instructions) AS instruction(value)
      WHERE instruction.value ->> 'platform' = v_existing.canonical_platform
    ) THEN
      RAISE EXCEPTION
        'PLATFORM_PARTIAL: existing platform % must be explicitly addressed',
        v_existing.platform
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  /*
   * Reject instructions outside the authoritative universe. An inactive
   * configured platform is included only when a row already exists for this
   * store/date; merely being configured historically is not enough to create
   * a new inactive row.
   */
  FOR v_item IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements(v_instructions)
  LOOP
    v_canonical_platform := v_item ->> 'platform';

    IF NOT EXISTS (
      SELECT 1
      FROM public.platforms AS p
      WHERE public._wak_canonical_platform(p.name) = v_canonical_platform
        AND p.is_active IS TRUE
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.platform_income AS pi
      WHERE pi.business_date = v_business_date
        AND pi.store_id = v_store_id
        AND public._wak_canonical_platform(pi.platform) = v_canonical_platform
    ) THEN
      RAISE EXCEPTION
        'Platform is not active or present for this date: %',
        v_canonical_platform
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  /* Apply explicit SET/REMOVE instructions. Any error rolls back the function call. */
  FOR v_item IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements(v_instructions)
  LOOP
    v_canonical_platform := v_item ->> 'platform';
    v_action := v_item ->> 'action';

    SELECT
      pi.id,
      pi.platform,
      pi.gross_income,
      pi.fees
    INTO v_existing
    FROM public.platform_income AS pi
    WHERE pi.business_date = v_business_date
      AND pi.store_id = v_store_id
      AND public._wak_canonical_platform(pi.platform) = v_canonical_platform
    LIMIT 1;

    v_existing_found := FOUND;

    IF v_action = 'REMOVE' THEN
      IF NOT v_existing_found THEN
        RAISE EXCEPTION 'Cannot remove nonexistent platform %', v_canonical_platform
          USING ERRCODE = '22023';
      END IF;

      DELETE FROM public.platform_income
      WHERE id = v_existing.id;

      v_removed_platforms := v_removed_platforms || jsonb_build_array(
        jsonb_build_object(
          'platform', v_canonical_platform,
          'gross_income', v_existing.gross_income,
          'fees', v_existing.fees
        )
      );
    ELSE
      v_gross_income := (v_item ->> 'gross_income')::numeric;

      IF v_existing_found
         AND v_existing.gross_income IS NOT DISTINCT FROM v_gross_income THEN
        /* Deliberately do not UPDATE: preserve the stored fee snapshot. */
        NULL;
      ELSIF v_existing_found THEN
        IF NOT v_confirm_fee_recalculation THEN
          RAISE EXCEPTION
            'FEE_RECALCULATION_CONFIRMATION_REQUIRED: changing % will use current fee settings',
            v_canonical_platform
            USING ERRCODE = 'P0001';
        END IF;

        UPDATE public.platform_income
        SET
          platform = v_canonical_platform,
          gross_income = v_gross_income,
          entered_by = v_actor
        WHERE id = v_existing.id
        RETURNING fees INTO v_new_fees;

        v_fee_recalculations := v_fee_recalculations || jsonb_build_array(
          jsonb_build_object(
            'platform', v_canonical_platform,
            'old_gross_income', v_existing.gross_income,
            'old_fees', v_existing.fees,
            'new_gross_income', v_gross_income,
            'new_fees', v_new_fees
          )
        );
      ELSE
        INSERT INTO public.platform_income (
          business_date,
          store_id,
          platform,
          gross_income,
          entered_by
        )
        VALUES (
          v_business_date,
          v_store_id,
          v_canonical_platform,
          v_gross_income,
          v_actor
        );
      END IF;
    END IF;
  END LOOP;

  SELECT round(COALESCE(sum(pi.gross_income), 0), 2)
  INTO v_platform_gross_total
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_business_date
    AND pi.store_id = v_store_id;

  v_counted_daily_cash_movement := round(
    v_night_total - v_opening_float,
    2
  );
  v_expected_cash := v_counted_daily_cash_movement;
  v_target_removed_cash := round(
    greatest(0::numeric, v_night_total - v_target_closing_float),
    2
  );
  v_projected_closing_float := round(
    v_night_total - v_removed_total,
    2
  );
  v_closing_float_variance := round(
    v_projected_closing_float - v_target_closing_float,
    2
  );
  v_total_sales := round(
    v_cash_sales + v_eftpos_sales + v_platform_gross_total,
    2
  );
  v_cash_variance := round(
    v_cash_sales - v_counted_daily_cash_movement,
    2
  );
  v_removed_variance := round(
    v_removed_total - v_target_removed_cash,
    2
  );

  IF abs(v_cash_variance) < 0.01 THEN
    v_cash_difference_reason := '';
    v_cash_difference_note := '';
  ELSE
    IF v_cash_difference_reason = '' THEN
      RAISE EXCEPTION
        'cash_difference.reason is required when cash variance is nonzero'
        USING ERRCODE = '22023';
    END IF;

    IF v_cash_difference_reason = 'OTHER'
       AND v_cash_difference_note = '' THEN
      RAISE EXCEPTION
        'cash_difference.note is required when reason is OTHER'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_night_counts_to_store := v_night_counts || jsonb_build_object(
    '_removed_counts', v_removed_counts,
    '_cash_diff_reason', v_cash_difference_reason,
    '_cash_diff_note', v_cash_difference_note,
    '_close_contract_version', 2
  );

  INSERT INTO public.cashup_sessions (
    business_date,
    store_id,
    session_type,
    counts,
    total_cash,
    removed_cash,
    entered_by
  )
  VALUES (
    v_business_date,
    v_store_id,
    'NIGHT',
    v_night_counts_to_store,
    v_night_total,
    v_removed_total,
    v_actor
  )
  ON CONFLICT (business_date, store_id, session_type)
  DO UPDATE SET
    counts = EXCLUDED.counts,
    total_cash = EXCLUDED.total_cash,
    removed_cash = EXCLUDED.removed_cash,
    entered_by = EXCLUDED.entered_by
  RETURNING * INTO v_committed_night;

  INSERT INTO public.daily_sales (
    business_date,
    store_id,
    cash_sales,
    eftpos_sales,
    expected_cash,
    total_sales,
    entered_by
  )
  VALUES (
    v_business_date,
    v_store_id,
    v_cash_sales,
    v_eftpos_sales,
    v_expected_cash,
    v_total_sales,
    v_actor
  )
  ON CONFLICT (business_date, store_id)
  DO UPDATE SET
    cash_sales = EXCLUDED.cash_sales,
    eftpos_sales = EXCLUDED.eftpos_sales,
    expected_cash = EXCLUDED.expected_cash,
    total_sales = EXCLUDED.total_sales,
    entered_by = EXCLUDED.entered_by;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'platform', public._wak_canonical_platform(pi.platform),
        'gross_income', pi.gross_income,
        'fees', pi.fees,
        'net_income', round(pi.gross_income - pi.fees, 2)
      )
      ORDER BY public._wak_canonical_platform(pi.platform)
    ),
    '[]'::jsonb
  )
  INTO v_platform_result
  FROM public.platform_income AS pi
  WHERE pi.business_date = v_business_date
    AND pi.store_id = v_store_id;

  RETURN jsonb_build_object(
    'store_id', v_store_id,
    'business_date', v_business_date,
    'night_updated_at', v_committed_night.updated_at,
    'night_total_cash', v_night_total,
    'removed_cash', v_removed_total,
    'opening_float', v_opening_float,
    'actual_opening_float', v_opening_float,
    'expected_cash', v_expected_cash,
    'counted_daily_cash_movement', v_counted_daily_cash_movement,
    'cash_variance', v_cash_variance,
    'target_closing_float', v_target_closing_float,
    'target_removed_cash', v_target_removed_cash,
    'removed_cash_variance', v_removed_variance,
    'projected_closing_float', v_projected_closing_float,
    'closing_float_variance', v_closing_float_variance,
    'cash_difference_reason', v_cash_difference_reason,
    'cash_difference_note', v_cash_difference_note,
    'cash_sales', v_cash_sales,
    'eftpos_sales', v_eftpos_sales,
    'platform_gross_total', v_platform_gross_total,
    'total_sales', v_total_sales,
    'platforms', v_platform_result,
    'fee_recalculations', v_fee_recalculations,
    'removed_platforms', v_removed_platforms,
    'entered_by', v_actor,
    'close_contract_version', 2
  );
END
$function$;

COMMIT;
