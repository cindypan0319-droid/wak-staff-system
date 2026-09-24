BEGIN;

DROP FUNCTION public.wak_clock_out_for_actor(uuid, bigint);
DROP FUNCTION public.wak_clock_in_for_actor(uuid, text);

COMMIT;
