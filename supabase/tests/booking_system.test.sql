-- =====================================================================
-- MRKLL booking system — database tests
-- Run with scripts/db-test.sh (throw-away local PostgreSQL).
-- Everything runs inside one transaction and is rolled back.
-- Dates are computed relative to "now" so the suite never goes stale.
-- =====================================================================

\set ON_ERROR_STOP on
set client_min_messages = warning;
begin;

-- ---------- helpers ---------------------------------------------------
create function pg_temp.ok(cond boolean, label text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label; end if;
  raise notice 'ok - %', label;
end $$;

-- Runs SQL and asserts it fails with the given message.
create function pg_temp.fails(sql text, expected text, label text) returns void language plpgsql as $$
declare msg text;
begin
  begin
    execute sql;
  exception when others then
    msg := sqlerrm;
  end;
  if msg is null then raise exception 'FAIL: % (no error raised)', label; end if;
  if position(expected in msg) = 0 then
    raise exception 'FAIL: % (expected "%", got "%")', label, expected, msg;
  end if;
  raise notice 'ok - %', label;
end $$;

-- Next local date >= today + p_min_days falling on ISO weekday p_isodow.
create function pg_temp.next_day(p_isodow int, p_min_days int) returns date language sql as $$
  select d from (
    select (now() at time zone 'Europe/Madrid')::date + i as d from generate_series(p_min_days, p_min_days + 6) i
  ) x where extract(isodow from d) = p_isodow limit 1;
$$;

create function pg_temp.tok(n int) returns text language sql as $$
  select repeat(md5(n::text), 2);
$$;

set client_min_messages = notice;

-- ---------- 1. seed ---------------------------------------------------
select pg_temp.ok((select count(*) from packages) = 3, 'three packages seeded');
select pg_temp.ok((select duration_minutes || '/' || price_cents from packages where id = 'starter') = '120/12000', 'starter 2h / 120 EUR');
select pg_temp.ok((select duration_minutes || '/' || price_cents from packages where id = 'pro')     = '240/20000', 'pro 4h / 200 EUR');
select pg_temp.ok((select duration_minutes || '/' || price_cents from packages where id = 'legend')  = '360/28000', 'legend 6h / 280 EUR');
select pg_temp.ok((select count(*) from opening_hours) = 6 and not exists (select 1 from opening_hours where weekday = 7), 'open Mon-Sat, Sunday closed');
select pg_temp.ok((select hold_minutes > checkout_expiry_minutes from studio_settings), 'hold (35) outlives checkout (30)');

-- ---------- 2. fixed grid fits opening hours --------------------------
select pg_temp.ok((select count(*) from package_slots('starter', pg_temp.next_day(1, 7), pg_temp.next_day(1, 7))) = 5, 'starter: 5 slots on a Monday');
select pg_temp.ok((select count(*) from package_slots('pro',     pg_temp.next_day(1, 7), pg_temp.next_day(1, 7))) = 4, 'pro: 4 slots on a Monday');
select pg_temp.ok((select count(*) from package_slots('legend',  pg_temp.next_day(1, 7), pg_temp.next_day(1, 7))) = 3, 'legend: 3 slots on a Monday');
select pg_temp.ok((select max(end_time) from package_slots('starter', pg_temp.next_day(1, 7), pg_temp.next_day(1, 7))) = '22:00', 'last starter ends at 22:00');
select pg_temp.ok((select count(*) from package_slots('pro', pg_temp.next_day(7, 7), pg_temp.next_day(7, 7))) = 0, 'no slots on Sunday');

-- ---------- 3. time zone / DST ---------------------------------------
-- 27 Mar 2027 (Sat) is CET (+01), 29 Mar 2027 (Mon) is CEST (+02).
select pg_temp.ok((select starts_at from package_slots('starter', '2027-03-27', '2027-03-27') where start_time = '10:00') = '2027-03-27 09:00:00+00', 'winter: 10:00 Madrid = 09:00 UTC');
select pg_temp.ok((select starts_at from package_slots('starter', '2027-03-29', '2027-03-29') where start_time = '10:00') = '2027-03-29 08:00:00+00', 'summer: 10:00 Madrid = 08:00 UTC');
select pg_temp.ok((select ends_at - starts_at from package_slots('legend', '2027-10-30', '2027-10-30') where start_time = '15:00') = interval '6 hours', 'legend lasts 6h around DST end');
select pg_temp.ok((select starts_at from package_slots('pro', '2027-11-01', '2027-11-01') where start_time = '17:30') = '2027-11-01 16:30:00+00', 'after DST end: 17:30 Madrid = 16:30 UTC');

-- ---------- 4. availability calendar ---------------------------------
select pg_temp.ok((select status from get_availability('pro', (now() at time zone 'Europe/Madrid')::date - 1, (now() at time zone 'Europe/Madrid')::date - 1)) = 'past', 'yesterday is past');
select pg_temp.ok((select status from get_availability('pro', pg_temp.next_day(7, 3), pg_temp.next_day(7, 3))) = 'closed', 'sunday is closed');
select pg_temp.ok((select status from get_availability('pro', (now() at time zone 'Europe/Madrid')::date + 91, (now() at time zone 'Europe/Madrid')::date + 91)) = 'out_of_range', 'day 91 is out of range');
select pg_temp.ok((select status from get_availability('pro', pg_temp.next_day(2, 7), pg_temp.next_day(2, 7))) = 'available', 'a Tuesday next week is available');
select pg_temp.ok((select jsonb_array_length(slots) from get_availability('starter', pg_temp.next_day(2, 7), pg_temp.next_day(2, 7))) = 5, 'calendar lists 5 starter slots');
select pg_temp.ok(not exists (
  select 1 from get_availability('starter', (now() at time zone 'Europe/Madrid')::date, (now() at time zone 'Europe/Madrid')::date) g,
         jsonb_array_elements(g.slots) e where (e->>'available')::boolean), 'today: nothing bookable (24h notice)');
select pg_temp.ok((select count(*) from get_availability('starter', (now() at time zone 'Europe/Madrid')::date, (now() at time zone 'Europe/Madrid')::date + 41)) = 42, 'one row per day for a 6-week range');
select pg_temp.fails($$select * from get_availability('pro', current_date, current_date + 70)$$, 'INVALID_RANGE', 'range > 62 days rejected');
select pg_temp.fails($$select * from get_availability('vip', current_date, current_date + 1)$$, 'PACKAGE_NOT_FOUND', 'unknown package rejected');

-- ---------- 5. holds and overlap rules -------------------------------
create temp table t_ids (name text primary key, id uuid, ref text);

insert into t_ids select 's1000', booking_id, reference from create_booking_hold('starter', pg_temp.next_day(3, 7), '10:00', 'ipA', pg_temp.tok(1));
select pg_temp.ok((select status from bookings where id = (select id from t_ids where name = 's1000')) = 'pending_payment', 'hold created as pending_payment');
select pg_temp.ok((select ref from t_ids where name = 's1000') ~ '^MRK-[0-9A-F]{8}$', 'reference format MRK-XXXXXXXX');
select pg_temp.ok((select hold_expires_at - now() from bookings where id = (select id from t_ids where name = 's1000')) = interval '35 minutes', 'hold lasts 35 minutes');
select pg_temp.ok((select blocked_until - ends_at from bookings where id = (select id from t_ids where name = 's1000')) = interval '30 minutes', 'buffer of 30 minutes stored');

select pg_temp.fails(format($$select * from create_booking_hold('starter', %L, '10:00', 'ipB', %L)$$, pg_temp.next_day(3, 7), pg_temp.tok(2)), 'SLOT_UNAVAILABLE', 'same slot cannot be held twice');
select pg_temp.fails(format($$select * from create_booking_hold('pro', %L, '10:00', 'ipB', %L)$$, pg_temp.next_day(3, 7), pg_temp.tok(2)), 'SLOT_UNAVAILABLE', 'overlapping pro 10:00 rejected');
select pg_temp.fails(format($$select * from create_booking_hold('legend', %L, '10:00', 'ipB', %L)$$, pg_temp.next_day(3, 7), pg_temp.tok(2)), 'SLOT_UNAVAILABLE', 'overlapping legend 10:00 rejected');

insert into t_ids select 's1230', booking_id, reference from create_booking_hold('starter', pg_temp.next_day(3, 7), '12:30', 'ipB', pg_temp.tok(3));
select pg_temp.ok(exists (select 1 from t_ids where name = 's1230'), 'starter 12:30 fits right after 10:00 + buffer');
select pg_temp.fails(format($$select * from create_booking_hold('pro', %L, '12:30', 'ipC', %L)$$, pg_temp.next_day(3, 7), pg_temp.tok(4)), 'SLOT_UNAVAILABLE', 'pro 12:30 rejected (overlaps starter 12:30)');
insert into t_ids select 'l1500', booking_id, reference from create_booking_hold('legend', pg_temp.next_day(3, 7), '15:00', 'ipC', pg_temp.tok(5));
select pg_temp.ok(exists (select 1 from t_ids where name = 'l1500'), 'legend 15:00 fits after starter 12:30 + buffer');

select pg_temp.ok((select status from get_availability('starter', pg_temp.next_day(3, 7), pg_temp.next_day(3, 7))) = 'unavailable', 'day fully held shows unavailable');
select pg_temp.ok((select count(*) from get_availability('starter', pg_temp.next_day(3, 7), pg_temp.next_day(3, 7)) g, jsonb_array_elements(g.slots) e where not (e->>'available')::boolean) = 5, 'all 5 starter slots marked unavailable');

select pg_temp.fails(format($$select * from create_booking_hold('starter', %L, '11:00', 'ipD', %L)$$, pg_temp.next_day(4, 7), pg_temp.tok(6)), 'SLOT_NOT_BOOKABLE', 'start time outside the fixed list rejected');
select pg_temp.fails(format($$select * from create_booking_hold('starter', %L, '10:00', 'ipD', %L)$$, pg_temp.next_day(7, 7), pg_temp.tok(6)), 'SLOT_NOT_BOOKABLE', 'sunday rejected');
select pg_temp.fails(format($$select * from create_booking_hold('starter', %L, '20:00', 'ipD', %L)$$, (now() at time zone 'Europe/Madrid')::date, pg_temp.tok(6)), 'SLOT_NOT_BOOKABLE', 'less than 24h notice rejected');
select pg_temp.fails(format($$select * from create_booking_hold('starter', %L, '10:00', 'ipD', %L)$$, pg_temp.next_day(1, 92), pg_temp.tok(6)), 'SLOT_NOT_BOOKABLE', 'beyond 90 days rejected');
select pg_temp.fails(format($$select * from create_booking_hold('starter', %L, '10:00', 'ipD', 'short')$$, pg_temp.next_day(4, 7)), 'INVALID_TOKEN', 'weak release token rejected');
select pg_temp.fails(format($$insert into bookings (package_id, starts_at, status, source) values ('pro', %L::timestamptz, 'confirmed', 'admin')$$, (pg_temp.next_day(3, 7) + time '13:00') at time zone 'Europe/Madrid'), 'bookings_no_overlap', 'direct insert cannot bypass the overlap rule');

-- ---------- 6. anti-abuse --------------------------------------------
select create_booking_hold('starter', pg_temp.next_day(5, 7), '10:00', 'ipSpam', pg_temp.tok(10));
select create_booking_hold('starter', pg_temp.next_day(5, 7), '12:30', 'ipSpam', pg_temp.tok(11));
select create_booking_hold('starter', pg_temp.next_day(5, 7), '15:00', 'ipSpam', pg_temp.tok(12));
select pg_temp.fails(format($$select * from create_booking_hold('starter', %L, '17:30', 'ipSpam', %L)$$, pg_temp.next_day(5, 7), pg_temp.tok(13)), 'TOO_MANY_HOLDS', '4th active hold from same IP rejected');

-- ---------- 7. expiry -------------------------------------------------
insert into t_ids select 'exp', booking_id, reference from create_booking_hold('pro', pg_temp.next_day(4, 7), '10:00', 'ipE', pg_temp.tok(20));
update bookings set hold_expires_at = now() - interval '1 second' where id = (select id from t_ids where name = 'exp');
select pg_temp.ok((select (e->>'available')::boolean from get_availability('pro', pg_temp.next_day(4, 7), pg_temp.next_day(4, 7)) g, jsonb_array_elements(g.slots) e where e->>'start' = '10:00'), 'expired hold no longer blocks availability');
insert into t_ids select 'take', booking_id, reference from create_booking_hold('pro', pg_temp.next_day(4, 7), '10:00', 'ipF', pg_temp.tok(21));
select pg_temp.ok((select status from bookings where id = (select id from t_ids where name = 'exp')) = 'expired', 'stale overlapping hold lazily marked expired');

insert into t_ids select 'cron', booking_id, reference from create_booking_hold('legend', pg_temp.next_day(6, 7), '10:00', 'ipG', pg_temp.tok(22));
update bookings set hold_expires_at = now() - interval '1 second' where id = (select id from t_ids where name = 'cron');
select pg_temp.ok(expire_stale_holds() >= 1, 'expire_stale_holds releases stale holds');
select pg_temp.ok((select status from bookings where id = (select id from t_ids where name = 'cron')) = 'expired', 'cron-expired hold is expired');

-- ---------- 8. confirmation ------------------------------------------
select pg_temp.ok(attach_checkout_session((select id from t_ids where name = 's1000'), 'cs_test_s1000'), 'checkout session attached');
select pg_temp.ok(confirm_booking((select id from t_ids where name = 's1000'), 'cs_test_other', 'pi_x', 12000, 'eur', 'A', 'a@x.com', null) = 'session_mismatch', 'wrong session id refused');
select pg_temp.ok(confirm_booking((select id from t_ids where name = 's1000'), 'cs_test_s1000', 'pi_s1000', 12000, 'EUR', 'Ana', 'Ana@Example.com', '+34 600') = 'confirmed', 'paid hold confirmed');
select pg_temp.ok((select status = 'confirmed' and hold_expires_at is null and customer_email = 'ana@example.com' and confirmed_at is not null
                   from bookings where id = (select id from t_ids where name = 's1000')), 'confirmed booking stores customer, clears hold');
select pg_temp.ok(confirm_booking((select id from t_ids where name = 's1000'), 'cs_test_s1000', 'pi_s1000', 12000, 'eur', 'Ana', 'ana@example.com', null) = 'already_confirmed', 'webhook replay is idempotent');

select attach_checkout_session((select id from t_ids where name = 's1230'), 'cs_test_s1230');
select pg_temp.ok(confirm_booking((select id from t_ids where name = 's1230'), 'cs_test_s1230', 'pi_s1230', 9900, 'eur', 'B', 'b@x.com', null) = 'needs_review', 'amount mismatch goes to needs_review');
select pg_temp.ok((select (e->>'available')::boolean from get_availability('starter', pg_temp.next_day(3, 7), pg_temp.next_day(3, 7)) g, jsonb_array_elements(g.slots) e where e->>'start' = '12:30') = false, 'needs_review keeps the slot blocked');

-- late payment, slot still free -> confirmed
select pg_temp.ok(confirm_booking((select id from t_ids where name = 'cron'), 'cs_test_cron', 'pi_cron', 28000, 'eur', 'C', 'c@x.com', null) = 'confirmed', 'late payment on a still-free slot is confirmed');

-- late payment, slot taken by someone else -> conflict
select pg_temp.ok(confirm_booking((select id from t_ids where name = 'exp'), 'cs_test_exp', 'pi_exp', 20000, 'eur', 'D', 'd@x.com', null) = 'conflict', 'late payment on a taken slot is a conflict');
select pg_temp.ok((select status from bookings where id = (select id from t_ids where name = 'exp')) = 'payment_conflict', 'conflict stored as payment_conflict');
select pg_temp.ok(confirm_booking((select id from t_ids where name = 'exp'), 'cs_test_exp', 'pi_exp', 20000, 'eur', 'D', 'd@x.com', null) = 'conflict', 'conflict replay is idempotent');
select pg_temp.ok((select status from bookings where id = (select id from t_ids where name = 'take')) = 'pending_payment', 'the other customer keeps the slot');

-- ---------- 9. release ------------------------------------------------
select pg_temp.ok(not release_hold((select id from t_ids where name = 'take'), 'cancelled', null, pg_temp.tok(999)), 'release with wrong token refused');
select pg_temp.fails(format($$select release_hold(%L, 'cancelled')$$, (select id from t_ids where name = 'take')), 'NOT_AUTHORIZED', 'release without proof refused');
select pg_temp.ok(release_hold((select id from t_ids where name = 'take'), 'cancelled', null, pg_temp.tok(21)), 'release with right token accepted');
select pg_temp.ok(not release_hold((select id from t_ids where name = 'take'), 'cancelled', null, pg_temp.tok(21)), 'second release is a no-op');
select pg_temp.ok(not release_hold((select id from t_ids where name = 's1000'), 'expired', 'cs_test_s1000'), 'confirmed booking cannot be released by expiry');
select pg_temp.ok((select status from bookings where id = (select id from t_ids where name = 's1000')) = 'confirmed', 'confirmed booking untouched');

-- ---------- 10. refunds ----------------------------------------------
select pg_temp.ok(mark_booking_refunded('pi_cron'), 'refund marks booking refunded');
select pg_temp.ok((select (e->>'available')::boolean from get_availability('legend', pg_temp.next_day(6, 7), pg_temp.next_day(6, 7)) g, jsonb_array_elements(g.slots) e where e->>'start' = '10:00'), 'refunded booking frees the slot');

-- ---------- 11. e-mail idempotency -----------------------------------
select pg_temp.ok(mark_booking_email_sent((select id from t_ids where name = 's1000'), 'customer'), 'customer e-mail recorded');
select pg_temp.ok(not mark_booking_email_sent((select id from t_ids where name = 's1000'), 'customer'), 'customer e-mail not recorded twice');

-- ---------- 12. blackout ----------------------------------------------
insert into blackout_periods (period, reason)
values (tstzrange((pg_temp.next_day(2, 14) + time '00:00') at time zone 'Europe/Madrid',
                  (pg_temp.next_day(2, 14) + time '23:59') at time zone 'Europe/Madrid'), 'test closure');
select pg_temp.ok((select status from get_availability('pro', pg_temp.next_day(2, 14), pg_temp.next_day(2, 14))) = 'unavailable', 'blackout day is unavailable');
select pg_temp.fails(format($$select * from create_booking_hold('pro', %L, '10:00', 'ipH', %L)$$, pg_temp.next_day(2, 14), pg_temp.tok(30)), 'SLOT_UNAVAILABLE', 'hold during blackout rejected');

-- ---------- 13. manual (admin) booking -------------------------------
insert into bookings (package_id, starts_at, status, source, customer_name)
values ('legend', (pg_temp.next_day(1, 21) + time '10:00') at time zone 'Europe/Madrid', 'confirmed', 'admin', 'Walk-in');
select pg_temp.ok((select ends_at - starts_at = interval '6 hours' and blocked_until - ends_at = interval '30 minutes'
                          and price_cents = 28000 and reference like 'MRK-%' and confirmed_at is not null
                   from bookings where customer_name = 'Walk-in'), 'admin booking auto-fills end, buffer, price, reference');
select pg_temp.fails(format($$select * from create_booking_hold('starter', %L, '12:30', 'ipI', %L)$$, pg_temp.next_day(1, 21), pg_temp.tok(31)), 'SLOT_UNAVAILABLE', 'admin booking blocks website holds');
update bookings set starts_at = starts_at + interval '5 hours' where customer_name = 'Walk-in';
select pg_temp.ok((select ends_at - starts_at = interval '6 hours' and blocked_until - ends_at = interval '30 minutes'
                   from bookings where customer_name = 'Walk-in'), 'moving an admin booking keeps duration and buffer');

-- ---------- 14. studio view ------------------------------------------
select pg_temp.ok((select start_local from bookings_calendar where reference = (select ref from t_ids where name = 's1000')) = '10:00', 'calendar view shows local time');

-- ---------- 15. GDPR purge -------------------------------------------
update bookings set released_at = now() - interval '31 days' where id = (select id from t_ids where name = 'take');
select pg_temp.ok(purge_stale_hold_data() >= 1, 'old abandoned holds purged');
select pg_temp.ok((select client_ip_hash is null and release_token_hash is null from bookings where id = (select id from t_ids where name = 'take')), 'identifiers removed');

-- ---------- 16. security ---------------------------------------------
select pg_temp.ok((select bool_and(relrowsecurity) from pg_class where oid in (
  'public.studio_settings'::regclass, 'public.opening_hours'::regclass, 'public.packages'::regclass,
  'public.package_start_times'::regclass, 'public.blackout_periods'::regclass, 'public.bookings'::regclass,
  'public.stripe_events'::regclass)), 'RLS enabled on every table');
select pg_temp.ok(not has_table_privilege('anon', 'public.bookings', 'select'), 'anon cannot read bookings');
select pg_temp.ok(not has_table_privilege('authenticated', 'public.bookings', 'select'), 'authenticated cannot read bookings');
select pg_temp.ok(not has_table_privilege('anon', 'public.bookings_calendar', 'select'), 'anon cannot read calendar view');
select pg_temp.ok(not has_table_privilege('anon', 'public.packages', 'select'), 'anon cannot read packages');
select pg_temp.ok(not has_function_privilege('anon', 'public.get_availability(text, date, date)', 'execute'), 'anon cannot call get_availability');
select pg_temp.ok(not has_function_privilege('anon', 'public.create_booking_hold(text, date, time, text, text)', 'execute'), 'anon cannot create holds');
select pg_temp.ok(not has_function_privilege('authenticated', 'public.confirm_booking(uuid, text, text, int, text, text, text, text)', 'execute'), 'authenticated cannot confirm bookings');
select pg_temp.ok(has_function_privilege('service_role', 'public.create_booking_hold(text, date, time, text, text)', 'execute'), 'service_role can create holds');
select pg_temp.ok(has_table_privilege('service_role', 'public.bookings', 'select'), 'service_role can read bookings');

set local role anon;
select pg_temp.fails($$select count(*) from public.bookings$$, 'permission denied', 'anon query on bookings is denied');
reset role;

rollback;
\echo 'ALL DATABASE TESTS PASSED'
