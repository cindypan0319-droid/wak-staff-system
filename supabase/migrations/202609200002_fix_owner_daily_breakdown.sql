BEGIN;

/*
 * Keep the existing nine-column contract unchanged and append store_id as
 * column 10. CREATE OR REPLACE VIEW therefore preserves the existing view
 * owner and ACLs.
 *
 * Platform net income is based only on the fee snapshot stored on each
 * platform_income row. Current platform_fee_settings are intentionally not a
 * dependency of this reporting view.
 */
CREATE OR REPLACE VIEW public.v_owner_daily_breakdown AS
WITH platform_calc AS (
  SELECT
    pi.business_date,
    pi.store_id,
    CASE regexp_replace(
      upper(btrim(pi.platform)),
      '[[:space:]]+',
      ' ',
      'g'
    )
      WHEN 'DOORDASH' THEN 'DOORDASH'
      WHEN 'UBER EATS' THEN 'UBER_EATS'
      WHEN 'UBER_EATS' THEN 'UBER_EATS'
      WHEN 'UBER' THEN 'UBER_EATS'
      WHEN 'WAK APP' THEN 'WAK'
      WHEN 'WAK' THEN 'WAK'
      WHEN 'DELIVEROO' THEN 'DELIVEROO'
      WHEN 'MENULOG' THEN 'MENULOG'
      ELSE btrim(pi.platform)
    END AS canonical_platform,
    round(
      COALESCE(pi.gross_income, 0::numeric)
      - COALESCE(pi.fees, 0::numeric),
      2
    ) AS net_income
  FROM public.platform_income AS pi
),
platform_pivot AS (
  SELECT
    platform_calc.business_date,
    platform_calc.store_id,
    round(sum(
      CASE
        WHEN platform_calc.canonical_platform = 'DELIVEROO'::text
        THEN platform_calc.net_income
        ELSE 0::numeric
      END
    ), 2) AS deliveroo_net,
    round(sum(
      CASE
        WHEN platform_calc.canonical_platform = 'DOORDASH'::text
        THEN platform_calc.net_income
        ELSE 0::numeric
      END
    ), 2) AS doordash_net,
    round(sum(
      CASE
        WHEN platform_calc.canonical_platform = 'MENULOG'::text
        THEN platform_calc.net_income
        ELSE 0::numeric
      END
    ), 2) AS menulog_net,
    round(sum(
      CASE
        WHEN platform_calc.canonical_platform = 'UBER_EATS'::text
        THEN platform_calc.net_income
        ELSE 0::numeric
      END
    ), 2) AS uber_eats_net,
    round(sum(
      CASE
        WHEN platform_calc.canonical_platform = 'WAK'::text
        THEN platform_calc.net_income
        ELSE 0::numeric
      END
    ), 2) AS wak_net,
    round(sum(platform_calc.net_income), 2) AS platform_total
  FROM platform_calc
  GROUP BY
    platform_calc.business_date,
    platform_calc.store_id
)
SELECT
  d.business_date AS date,
  round(COALESCE(d.cash_sales_total, 0::numeric), 2) AS cash,
  round(COALESCE(d.eftpos_sales_total, 0::numeric), 2) AS eftpos,
  COALESCE(p.deliveroo_net, 0::numeric) AS deliveroo_net,
  COALESCE(p.doordash_net, 0::numeric) AS doordash_net,
  COALESCE(p.menulog_net, 0::numeric) AS menulog_net,
  COALESCE(p.uber_eats_net, 0::numeric) AS uber_eats_net,
  COALESCE(p.wak_net, 0::numeric) AS wak_net,
  round(
    COALESCE(d.cash_sales_total, 0::numeric)
    + COALESCE(d.eftpos_sales_total, 0::numeric)
    + COALESCE(p.platform_total, 0::numeric),
    2
  ) AS total_revenue,
  d.store_id
FROM public.daily_sales_totals AS d
LEFT JOIN platform_pivot AS p
  ON p.business_date = d.business_date
 AND p.store_id = d.store_id
ORDER BY
  d.business_date,
  d.store_id;

/*
 * PostgreSQL CREATE OR REPLACE VIEW preserves ownership and grants when the
 * existing columns retain their names, order and types and new columns are
 * appended. Post-migration verification must confirm that contract.
 */

COMMIT;
