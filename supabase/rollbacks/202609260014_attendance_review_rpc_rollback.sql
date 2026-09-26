BEGIN;

DROP FUNCTION public.wak_review_work_period(
  bigint,bigint,uuid,bigint,timestamptz,timestamptz,timestamptz,timestamptz,text,text
);

COMMIT;
