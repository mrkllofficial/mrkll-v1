-- =====================================================================
-- MRKLL booking system — webhook support tests (migration 3)
-- Stripe events, out-of-order refunds, conflicts and e-mail claims.
-- =====================================================================

\set ON_ERROR_STOP on
set client_min_messages = warning;
begin;

create function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'ok - %', label;
end $$;

create function pg_temp.next_day(p_isodow int, p_min_days int) returns date language sql as $$
  select d from (
    select (now() at time zone 'Europe/Madrid')::date + i as d from generate_series(p_min_days, p_min_days + 6) i
  ) x where extract(isodow from d) = p_isodow limit 1;
$$;

create function pg_temp.hold(p_pkg text, p_day date, p_start time, p_n int) returns uuid language sql as $$
  select booking_id from create_booking_hold(p_pkg, p_day, p_start, 'wh-ip-' || p_n, repeat(md5('wh' || p_n), 2));
$$;

delete from blackout_periods;  -- relative dates must not land on a holiday (rolled back)
set client_min_messages = notice;

-- ---------- Stripe events ---------------------------------------------
select pg_temp.ok(begin_stripe_event('evt_1', 'checkout.session.completed', null) = 'new', 'first delivery is new');
select pg_temp.ok(begin_stripe_event('evt_1', 'checkout.session.completed', null) = 'retry', 'redelivery before finishing is a retry');
select finish_stripe_event('evt_1');
select pg_temp.ok(begin_stripe_event('evt_1', 'checkout.session.completed', null) = 'processed', 'finished event is never processed again');
select finish_stripe_event('evt_1');
select pg_temp.ok((select processed_at is not null from stripe_events where id = 'evt_1'), 'finish is idempotent');
select pg_temp.ok(begin_stripe_event('evt_2', 'charge.refunded', gen_random_uuid()) = 'new', 'unknown booking id does not break the event log');
select pg_temp.ok((select booking_id is null from stripe_events where id = 'evt_2'), 'unknown booking id stored as null');

-- ---------- confirmation + idempotency --------------------------------
create temp table t (name text primary key, id uuid);
insert into t values ('a', pg_temp.hold('pro', pg_temp.next_day(2, 7), '10:00', 1));
select attach_checkout_session((select id from t where name = 'a'), 'cs_a');
select pg_temp.ok(confirm_booking((select id from t where name = 'a'), 'cs_a', 'pi_a', 20000, 'eur', 'Ana', 'ana@example.com', null) = 'confirmed', 'payment confirms the booking');
select pg_temp.ok(confirm_booking((select id from t where name = 'a'), 'cs_a', 'pi_a', 20000, 'eur', 'Ana', 'ana@example.com', null) = 'already_confirmed', 'duplicate confirmation is a no-op');
select pg_temp.ok((select count(*) from bookings where id = (select id from t where name = 'a') and status = 'confirmed') = 1, 'still exactly one confirmed booking');

-- ---------- refunds after confirmation --------------------------------
select pg_temp.ok((select count(*) from record_refund('pi_a', 'ch_a', 20000, 5000)) = 1, 'partial refund recorded');
select pg_temp.ok((select status from bookings where id = (select id from t where name = 'a')) = 'confirmed', 'partial refund keeps the booking');
select pg_temp.ok((select status from record_refund('pi_a', 'ch_a', 20000, 20000)) = 'refunded', 'full refund marks the booking refunded');
select pg_temp.ok((select (e->>'available')::boolean from get_availability('pro', pg_temp.next_day(2, 7), pg_temp.next_day(2, 7)) g,
                   jsonb_array_elements(g.slots) e where e->>'start' = '10:00'), 'refunded booking frees the slot');
select pg_temp.ok((select status from record_refund('pi_a', 'ch_a', 20000, 20000)) = 'refunded', 'duplicate refund event is a no-op');
select pg_temp.ok((select amount_refunded_cents from payment_refunds where payment_intent_id = 'pi_a') = 20000, 'refund amount kept');
select record_refund('pi_a', 'ch_a', 20000, 5000);
select pg_temp.ok((select amount_refunded_cents = 20000 and fully_refunded from payment_refunds where payment_intent_id = 'pi_a'), 'an older (smaller) refund event never lowers the amount');
select pg_temp.ok(confirm_booking((select id from t where name = 'a'), 'cs_a', 'pi_a', 20000, 'eur', 'Ana', 'ana@example.com', null) = 'refunded', 'late completed event after a refund stays refunded');

-- ---------- refund BEFORE confirmation (out of order) -----------------
insert into t values ('b', pg_temp.hold('starter', pg_temp.next_day(3, 7), '10:00', 2));
select attach_checkout_session((select id from t where name = 'b'), 'cs_b');
select pg_temp.ok((select count(*) from record_refund('pi_b', 'ch_b', 12000, 12000)) = 0, 'refund for an unconfirmed payment is only recorded');
select pg_temp.ok(confirm_booking((select id from t where name = 'b'), 'cs_b', 'pi_b', 12000, 'eur', 'Bo', 'bo@example.com', null) = 'refunded', 'confirmation after the refund ends as refunded');
select pg_temp.ok((select status = 'refunded' and hold_expires_at is null and refunded_at is not null
                   from bookings where id = (select id from t where name = 'b')), 'refunded booking stored with payment details');
select pg_temp.ok((select (e->>'available')::boolean from get_availability('starter', pg_temp.next_day(3, 7), pg_temp.next_day(3, 7)) g,
                   jsonb_array_elements(g.slots) e where e->>'start' = '10:00'), 'slot free after out-of-order refund');

-- ---------- conflict ---------------------------------------------------
insert into t values ('c1', pg_temp.hold('legend', pg_temp.next_day(4, 7), '10:00', 3));
select attach_checkout_session((select id from t where name = 'c1'), 'cs_c1');
update bookings set hold_expires_at = now() - interval '1 second' where id = (select id from t where name = 'c1');
insert into t values ('c2', pg_temp.hold('pro', pg_temp.next_day(4, 7), '12:30', 4));  -- takes the slot, c1 lazily expired
select pg_temp.ok(confirm_booking((select id from t where name = 'c1'), 'cs_c1', 'pi_c1', 28000, 'eur', 'Cy', 'cy@example.com', null) = 'conflict', 'late payment on a taken slot is a conflict');
select pg_temp.ok((select conflict_at is not null from bookings where id = (select id from t where name = 'c1')), 'conflict time stored');
select pg_temp.ok((select status = 'refunded' and conflict from record_refund('pi_c1', 'ch_c1', 28000, 28000)), 'automatic refund closes the conflict, flagged as conflict');
select pg_temp.ok((select status from bookings where id = (select id from t where name = 'c2')) = 'pending_payment', 'the other customer keeps the slot');

-- ---------- expired / failed sessions ---------------------------------
insert into t values ('d', pg_temp.hold('starter', pg_temp.next_day(5, 7), '12:30', 5));
select attach_checkout_session((select id from t where name = 'd'), 'cs_d');
select pg_temp.ok(not release_hold((select id from t where name = 'd'), 'expired', 'cs_other'), 'expiry for another session is ignored');
select pg_temp.ok(release_hold((select id from t where name = 'd'), 'expired', 'cs_d'), 'session expired releases the hold');
select pg_temp.ok(not release_hold((select id from t where name = 'd'), 'expired', 'cs_d'), 'duplicate expiry event is a no-op');
select pg_temp.ok(not release_hold((select id from t where name = 'a'), 'cancelled', 'cs_a'), 'a paid booking is never released by session events');

-- ---------- e-mail claims ---------------------------------------------
select pg_temp.ok(claim_notification('key-1', (select id from t where name = 'a'), 'customer_confirmation'), 'first claim wins');
select pg_temp.ok(not claim_notification('key-1', (select id from t where name = 'a'), 'customer_confirmation'), 'concurrent second claim refused');
select pg_temp.ok(complete_notification('key-1', 'failed', null, 'Brevo 503'), 'failure recorded');
select pg_temp.ok(claim_notification('key-1', (select id from t where name = 'a'), 'customer_confirmation'), 'failed e-mail can be claimed again');
select pg_temp.ok((select attempts from email_notifications where key = 'key-1') = 2, 'attempts counted');
select pg_temp.ok(complete_notification('key-1', 'sent', 'msg-1'), 'sent recorded');
select pg_temp.ok(not claim_notification('key-1', (select id from t where name = 'a'), 'customer_confirmation'), 'a sent e-mail is never sent again');
select pg_temp.ok(not complete_notification('key-1', 'sent', 'msg-2'), 'completion without a claim is refused');
select pg_temp.ok((select customer_email_sent_at is not null from bookings where id = (select id from t where name = 'a')), 'booking e-mail column kept in sync');

select pg_temp.ok(claim_notification('key-2', null, 'studio_alert'), 'claim without booking');
update email_notifications set claimed_at = now() - interval '5 minutes' where key = 'key-2';
select pg_temp.ok(claim_notification('key-2', null, 'studio_alert'), 'stale claim (crashed worker) can be taken over');
select pg_temp.ok(complete_notification('key-2', 'abandoned', null, 'invalid email'), 'permanent error recorded');
select pg_temp.ok(not claim_notification('key-2', null, 'studio_alert'), 'abandoned e-mail is not retried');
select pg_temp.ok(claim_notification('key-3', gen_random_uuid(), 'x'), 'unknown booking id does not break claims');

-- ---------- details for e-mails ----------------------------------------
select pg_temp.ok((select package_name = 'Recording Pro' and timezone = 'Europe/Madrid' and customer_email = 'ana@example.com'
                   from get_booking_details((select id from t where name = 'a'))), 'booking details for e-mails');

-- ---------- security ----------------------------------------------------
select pg_temp.ok(not has_table_privilege('anon', 'public.email_notifications', 'select'), 'anon cannot read e-mail log');
select pg_temp.ok(not has_table_privilege('anon', 'public.payment_refunds', 'select'), 'anon cannot read refunds');
select pg_temp.ok(not has_function_privilege('anon', 'public.record_refund(text, text, int, int)', 'execute'), 'anon cannot record refunds');
select pg_temp.ok(not has_function_privilege('authenticated', 'public.claim_notification(text, uuid, text, int)', 'execute'), 'authenticated cannot claim e-mails');
select pg_temp.ok(not has_function_privilege('anon', 'public.confirm_booking(uuid, text, text, int, text, text, text, text)', 'execute'), 'anon still cannot confirm bookings');
select pg_temp.ok(has_function_privilege('service_role', 'public.begin_stripe_event(text, text, uuid)', 'execute'), 'service_role can log events');
select pg_temp.ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.payment_refunds'::regclass, 'public.email_notifications'::regclass)), 'RLS on new tables');

rollback;
