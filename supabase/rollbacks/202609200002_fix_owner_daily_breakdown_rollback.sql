BEGIN;

DROP VIEW public.v_owner_daily_breakdown;

/* Exact verified pre-Migration-2 definition. */
CREATE VIEW public.v_owner_daily_breakdown AS
WITH platform_calc AS (
    SELECT
        pi.business_date,
        pi.platform,
        round(
            pi.gross_income *
            (1::numeric - COALESCE(pfs.commission_pct, 0::numeric)),
            2
        ) AS net_income
    FROM platform_income pi
    LEFT JOIN platform_fee_settings pfs
      ON pi.platform = pfs.platform_name
),
platform_pivot AS (
    SELECT
        platform_calc.business_date,

        round(sum(
            CASE
                WHEN platform_calc.platform = 'DELIVEROO'::text
                THEN platform_calc.net_income
                ELSE 0::numeric
            END
        ), 2) AS deliveroo_net,

        round(sum(
            CASE
                WHEN platform_calc.platform = 'DOORDASH'::text
                THEN platform_calc.net_income
                ELSE 0::numeric
            END
        ), 2) AS doordash_net,

        round(sum(
            CASE
                WHEN platform_calc.platform = 'MENULOG'::text
                THEN platform_calc.net_income
                ELSE 0::numeric
            END
        ), 2) AS menulog_net,

        round(sum(
            CASE
                WHEN platform_calc.platform = 'UBER_EATS'::text
                THEN platform_calc.net_income
                ELSE 0::numeric
            END
        ), 2) AS uber_eats_net,

        round(sum(
            CASE
                WHEN platform_calc.platform = 'WAK'::text
                THEN platform_calc.net_income
                ELSE 0::numeric
            END
        ), 2) AS wak_net,

        round(sum(platform_calc.net_income), 2) AS platform_total

    FROM platform_calc
    GROUP BY platform_calc.business_date
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
    ) AS total_revenue

FROM daily_sales_totals d
LEFT JOIN platform_pivot p
  ON d.business_date = p.business_date

ORDER BY d.business_date;

ALTER VIEW public.v_owner_daily_breakdown OWNER TO postgres;

/* Restore the verified effective external ACL with no grant options. */
REVOKE ALL PRIVILEGES
ON TABLE public.v_owner_daily_breakdown
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE public.v_owner_daily_breakdown
TO anon, authenticated, service_role;

COMMIT;
